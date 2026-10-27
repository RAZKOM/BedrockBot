// Task registry for the CLI (`bot --task <name>`). Each task is a `TaskDefinition` (tasks/base.ts).
// To add one: write `tasks/<name>.ts` exporting a TaskDefinition (or a factory) and register it, either
// here with `registerTask(...)` at the bottom, or from bot/src/index.ts's "task registrations" block.
//
// The afk task (with walking) runs every behaviour as a process of one ProcessManager (PLAN.md 7.8,
// tasks/process/manager.ts, docs/processes.md): flee, guard, night shelter, the owner's commands
// (goto, follow, come, kill, gather) and the home return. The keepalive nudge stays outside it and
// waits while a process moves the bot. Runtime settings (`!set`, config/settings.ts) come from the CLI
// through `values.$settings`, or are created in memory.
import type { Chat } from '../chat/chat.ts';
import { isOwner } from '../chat/chat.ts';
import { registerGatherCommands, registerProcessCommands, registerSettingsCommands } from '../chat/commands.ts';
import { registerPveCommandsFor } from '../chat/commands-pve.ts';
import { registerSurvivalCommands } from '../chat/commands-survival.ts'; // Track S
import { registerNavCommands } from '../chat/commands-nav.ts'; // Track R
import { registerFarmCommands } from '../chat/commands-farm.ts'; // Track U
import { registerNlCommands } from '../chat/commands-nl.ts'; // Track Y
import { registerFoodCommands } from '../chat/commands-food.ts'; // Track X
import { registerGetCommands } from '../chat/commands-get.ts'; // Track AD
import { formatChatLine } from '../chat/text.ts';
import type { RuntimeSettings } from '../config/settings.ts';
import { settingsFromValues } from '../config/settings.ts';
import type { Vec3 } from '../connection/types.ts';
import type { SkillResult } from '../skills/types.ts';
import { Containers } from '../world/containers.ts';
import { AfkTask } from './afk.ts';
import type { RunningTask, TaskContext, TaskDefinition } from './base.ts';
import { EchoTask } from './echo.ts';
import { parseBlockPos } from './gatherWood.ts';
import { blockGoal } from './mobility.ts';
import { NightSafety } from './night.ts';
import { fmtBlockPos, NEEDS_WALKING, parseBlockArgs, type CommandDeps } from './process/deps.ts';
import { AfkGather } from './process/gather.ts';
import { settingsMover } from './process/goto.ts';
import { formatStack, ProcessManager } from './process/manager.ts';
import { NightProcess } from './process/night.ts';
import { PveController, pveOptionsFrom } from './pve.ts';

const TASKS = new Map<string, TaskDefinition>();

export function registerTask(def: TaskDefinition): void {
  if (TASKS.has(def.name)) throw new Error(`task "${def.name}" is registered twice`);
  TASKS.set(def.name, def);
}

export function getTask(name: string): TaskDefinition | undefined {
  return TASKS.get(name);
}

export function taskNames(): string[] {
  return [...TASKS.keys()];
}

export function allTasks(): TaskDefinition[] {
  return [...TASKS.values()];
}

/** Home/shelter access for the !home and !shelter chat commands (tasks that walk). */
export interface PointAccess {
  get(): Vec3 | undefined;
  set(p: Vec3 | undefined): void;
  /** Walk there now (!home go). */
  go?(): Promise<SkillResult>;
}

export interface WalkingTask extends RunningTask {
  home?: PointAccess;
  shelter?: PointAccess & { state(): string };
  /** Walk to a feet block now (!goto x y z). */
  goto?(p: Vec3): Promise<SkillResult>;
  /** PvE behaviours: guard, flee, follow, come, kill (tasks/pve.ts); with the movement stack only. */
  pve?: PveController;
  /** The process manager (Track Q); with the movement stack only. */
  processes?: ProcessManager;
  /** Live runtime settings (Track Q). */
  settings?: RuntimeSettings;
  /** `!gather` on the afk task (Track Q). */
  gather?: AfkGather;
  /** Extra !status lines: the process stack with ETAs (Track Q). */
  processLines?(): string[];
}

// ---- built-in tasks ---------------------------------------------------------------------------

export const echoTask: TaskDefinition = {
  name: 'echo',
  summary: 'print chat and position',
  defaultUsername: 'EchoBot',
  create(ctx) {
    const echo = new EchoTask(ctx.conn);
    return {
      name: 'echo',
      start: () => {
        echo.start();
      },
      stop: () => {
        echo.stop();
      },
      status: () => echo.status(),
      position: () => echo.feet,
    };
  },
};

export const afkTask: TaskDefinition = {
  name: 'afk',
  summary: 'stay online: keepalive nudges, auto-respawn, home point, night shelter, PvE, !gather (process manager)',
  defaultUsername: 'AfkBot',
  cliOptions: { guard: { type: 'string' }, 'flee-health': { type: 'string' }, chest: { type: 'string' } },
  usage:
    '  --guard <radius>         start with guard mode on (PvE: fight hostiles within radius of home; docs/pve.md)\n' +
    '  --flee-health <h>        run to the shelter/home below this health (default 8)\n' +
    '  --chest <x,y,z>          default chest for !gather N (walking only)',
  create(ctx: TaskContext): WalkingTask {
    const o = ctx.options;
    const log = ctx.log;
    // Settings first: a bad --guard / --flee-health throws here (index.ts prints one line, exit 2).
    const { settings, own } = settingsFromValues(ctx.values);
    if (own) settings.applyStartup('nudgeInterval', o.nudgeIntervalS);
    const pveOptions = pveOptionsFrom(ctx.values, ctx.taskConfig);
    if (pveOptions.guard?.radius !== undefined) settings.applyStartup('guardRadius', pveOptions.guard.radius);
    if (pveOptions.fleeHealth !== undefined) settings.applyStartup('fleeHealth', pveOptions.fleeHealth);
    const chestArg = ctx.values.chest ?? ctx.taskConfig.chest;
    const chest = typeof chestArg === 'string' ? parseBlockPos(chestArg) : Array.isArray(chestArg) ? parseBlockPos(chestArg.join(',')) : undefined;
    if (chestArg !== undefined && !chest) throw new Error(`--chest must be x,y,z, got ${JSON.stringify(chestArg)}`);

    const respawn = ctx.respawn();
    const clock = ctx.clock();
    const walking = o.walk || o.home !== undefined || o.shelter !== undefined;
    const mob = walking ? ctx.mobility() : undefined;
    let home = o.home;
    /** After a respawn, until the chunks around the spawn point are in (no process runs meanwhile). */
    let settling = false;
    const processes = mob
      ? new ProcessManager({
          inactive: () => respawn.dead || ctx.conn.state !== 'spawned' || !mob.loop.state.ready || settling,
          onTick: (fn) => mob.loop.onBeforeStep(() => fn()),
          log: ctx.logger('process'),
          metrics: ctx.metrics,
        })
      : undefined;
    const afk = new AfkTask(ctx.conn, {
      nudgeIntervalMs: settings.get('nudgeInterval') * 1000,
      heartbeat: o.heartbeat,
      metrics: ctx.metrics,
      log,
      respawn,
      loop: mob?.loop,
      busy: () => (mob?.skills.nav.busy ?? false) || (processes?.busy() ?? false),
    });
    const offNudge = settings.onChange((key, v) => {
      if (key !== 'nudgeInterval') return;
      // afk.ts reads nudgeIntervalMs at every reschedule; one nudge now starts the new cadence
      (afk as unknown as { nudgeIntervalMs: number }).nudgeIntervalMs = Number(v) * 1000;
      if (Number(v) > 0) afk.nudgeNow();
      log.info(`nudge interval ${Number(v) > 0 ? `${String(v)} s` : 'off'}`);
    });
    let night: NightSafety | undefined;
    let pve: PveController | undefined;
    let gather: AfkGather | undefined;
    let containers: Containers | undefined;
    if (mob && processes) {
      const nightRef: { p?: NightProcess } = {};
      const n = new NightSafety({
        clock,
        mover: settingsMover(mob.skills, settings),
        position: () => mob.position(),
        inactive: () => respawn.dead || ctx.conn.state !== 'spawned',
        canMove: () => nightRef.p?.hasControl ?? false,
        walkHome: (h) => (pve ? pve.returnHome('dawn', { timeoutTicks: 6000 }) : mob.skills.goto(blockGoal(h), { timeoutTicks: 6000 })),
        shelter: o.shelter,
        home: () => home,
        log: ctx.logger('night'),
        metrics: ctx.metrics,
      });
      night = n;
      nightRef.p = processes.add(new NightProcess(n, { mover: mob.skills, position: () => mob.position() }));
      const p = new PveController({
        source: ctx.conn,
        world: mob.world,
        loop: mob.loop,
        skills: mob.skills,
        home: () => home,
        shelter: () => n.shelter,
        night: n,
        inactive: () => respawn.dead || ctx.conn.state !== 'spawned',
        log: ctx.logger('pve'),
        metrics: ctx.metrics,
        options: { ...(pveOptions.guard?.on !== undefined ? { guard: { on: pveOptions.guard.on } } : {}) },
        processes,
        settings,
      });
      pve = p;
      // dig / place / doors / chests for every walk and for !gather (the settings decide what the planner may use)
      containers = new Containers(ctx.conn, mob.world.inventory, { logger: ctx.logger('gather') });
      mob.skills.attach({ hotbar: p.hotbar, containers, source: ctx.conn });
      gather = new AfkGather({
        deps: {
          skills: settingsMover(mob.skills, settings),
          inventory: mob.world.inventory,
          position: () => mob.position(),
          ready: () => ctx.conn.state === 'spawned' && mob.loop.state.ready && !respawn.dead,
          waitTicks: (k) => (ctx.conn.state === 'spawned' ? mob.loop.waitTicks(k) : new Promise((r) => setTimeout(r, k * 50))),
          corrections: () => mob.loop.state.corrections,
        },
        processes,
        ...(chest ? { chest } : {}),
        ...(ctx.taskConfig.searchRadius !== undefined ? { searchRadius: Number(ctx.taskConfig.searchRadius) } : {}),
        log: ctx.logger('gather'),
        say: (m) => ctx.chat.say(m),
      });
      const g = gather;
      respawn.onEvent((e) => {
        if (e.kind === 'death') {
          g.onDeath();
          p.onDeath();
          mob.skills.cancel();
        }
      });
      respawn.afterRespawn(async (_feet, death, signal) => {
        settling = true;
        try {
          await mob.world.waitForChunks(2, { timeoutMs: 10_000 }).catch(() => undefined);
          await mob.loop.waitTicks(10);
        } finally {
          settling = false;
        }
        if (signal.aborted || !home || n.wantsShelter()) return;
        log.info(`returning home to ${home.x} ${home.y} ${home.z} after death ${death?.n ?? '?'}`);
        const r = await p.returnHome('respawn', { timeoutTicks: 6000 });
        log[r.ok ? 'info' : 'warn'](`return home: ${r.ok ? 'arrived' : r.reason}`);
        ctx.metrics.inc(r.ok ? 'home.returns' : 'home.failed');
      });
    }
    log.info(
      `afk: nudge every ${settings.get('nudgeInterval') > 0 ? `${settings.get('nudgeInterval')} s` : 'never'}${o.heartbeat ? ', heartbeat every tick' : ''}` +
        (mob ? `, walking (home ${fmt(home)}, shelter ${fmt(o.shelter)})` : '') +
        (settings.file ? `, settings ${settings.file}` : ''),
    );
    const task: WalkingTask = {
      name: 'afk',
      start: () => {
        afk.start();
        night?.start();
      },
      stop: () => {
        night?.stop();
        gather?.stop();
        pve?.dispose();
        processes?.dispose();
        containers?.dispose();
        offNudge();
        afk.stop();
        mob?.dispose();
      },
      status: () => ({
        ...afk.status(),
        respawn: respawn.status(),
        clock: clock.status(),
        night: night?.status() ?? null,
        home: home ?? null,
        lastGoto: mob?.skills.nav.lastReport?.result ?? null,
        pve: pve?.status() ?? null,
        processes: processes?.stack() ?? null,
        settings: settings.snapshot(),
      }),
      position: () => mob?.position() ?? afk.feet,
      statusLine: () => ({ task: 'afk', ...(pve ? { behaviour: pve.behaviour() } : {}), nudges: afk.nudges, corrections: afk.corrections, deaths: respawn.deaths }),
      alive: () => !respawn.dead,
      settings,
    };
    if (mob && night && pve && processes) {
      const n = night;
      const p = pve;
      task.home = {
        get: () => home,
        set: (q) => {
          home = q;
          log.info(q ? `home set to ${fmt(q)}` : 'home cleared');
        },
        go: () => (home ? p.walk(blockGoal(home), { timeoutTicks: 6000 }, 'walking home') : Promise.resolve({ ok: false, reason: 'no_home' })),
      };
      // a user process: a guard fight pre-empts and resumes it, !pause holds it, !stop ends it
      task.goto = (q) => p.walk(blockGoal(q), { timeoutTicks: 6000 });
      task.shelter = {
        get: () => n.shelter,
        set: (q) => {
          n.setShelter(q);
        },
        state: () => String(n.status().state),
      };
      task.pve = p;
      task.processes = processes;
      task.processLines = () => [`processes: ${processes.paused ? '(!pause holds the commands) ' : ''}${formatStack(processes.stack())}`];
      if (gather) task.gather = gather;
    }

    // ---- command registrations (Track Q: the stable point for other tracks) ----------------------
    // Every registration gets the same CommandDeps (tasks/process/deps.ts). To add commands: one
    // import and one entry in this list, e.g. registerNavCommands (Track R), registerSurvivalCommands
    // (Track S), registerFarmCommands (Track U).
    const deps: CommandDeps = {
      chat: ctx.chat,
      task,
      conn: ctx.conn,
      metrics: ctx.metrics,
      mobility: mob,
      skills: mob?.skills,
      world: mob?.world,
      processes,
      settings,
      pve,
      log,
      isOwner: (sender) => isOwner(sender, ctx.chat.owners),
      selfName: () => ctx.conn.username,
      position: () => task.position(),
      parseBlock: parseBlockArgs,
      fmtBlock: fmtBlockPos,
      needsWalking: (cmd) => `${cmd} ${NEEDS_WALKING}`,
    };
    const registrations: ((d: CommandDeps) => void)[] = [
      registerPveCommandsFor,
      registerProcessCommands,
      registerSettingsCommands,
      registerAfkGather,
      // other tracks: one entry each below this line
      (d) => registerFarmCommands({ chat: d.chat, conn: d.conn, mob, processes: d.processes, hotbar: pve?.hotbar, containers, gather: d.task.gather?.task, alive: () => !respawn.dead, logger: (s) => ctx.logger(s), useBoneMeal: () => d.settings.get('useBoneMeal'), mineTunnelLen: () => d.settings.get('mineTunnelLen'), mineSeenOnly: () => d.settings.get('mineSeenOnly') }), // Track Z (was Track U): processes, shared Hotbar/Containers, settings, cached forests for !gather
      () => registerNavCommands({ ctx, task, mob, pve, respawn }), // Track R
      (d) => registerSurvivalCommands({ chat: d.chat, source: d.conn, mob, pve, task, containers, inactive: () => respawn.dead || ctx.conn.state !== 'spawned', logger: ctx.logger('survival') }), // Track S
      (d) => void registerNlCommands(d, ctx.values), // Track Y
      (d) => void registerFoodCommands(d, { containers, clock }), // Track X: !food, !cook, the food chore
      (d) => void registerGetCommands(d, { containers, logger: ctx.logger('stash') }), // Track AD: !get, the stash step (after gather / farm / survival / food)
    ];
    for (const register of registrations) register(deps);
    return task;
  },
};

/** `!gather N [x y z]` on the afk task (a user process; needs walking). */
function registerAfkGather(d: CommandDeps): void {
  const g = d.task.gather;
  if (!g) {
    d.chat.register({
      name: 'gather',
      help: '(needs walking)',
      run: ({ reply }) => {
        reply(d.needsWalking('gather'));
      },
    });
    return;
  }
  registerGatherCommands(d.chat, { start: (n, at) => g.start(n, at), stop: () => g.stop(), status: () => g.status() });
}

function fmt(p: Vec3 | undefined): string {
  return p ? `${p.x} ${p.y} ${p.z}` : 'none';
}

/** `--exit-on-chat <s>`: call `fn` once a chat line (as printed by echo) contains `s`. */
export function onChatContaining(chat: Chat, s: string, fn: () => void): () => void {
  return chat.onLine((line) => {
    if (formatChatLine(line).includes(s) || line.message.includes(s)) fn();
  });
}

registerTask(echoTask);
registerTask(afkTask);
