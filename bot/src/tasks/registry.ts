// Task registry for the CLI (`bot --task <name>`). Each task is a `TaskDefinition` (tasks/base.ts).
// To add one: write `tasks/<name>.ts` exporting a TaskDefinition (or a factory) and register it, either
// here with `registerTask(...)` at the bottom, or from bot/src/index.ts's "task registrations" block.
import type { Chat } from '../chat/chat.ts';
import { formatChatLine } from '../chat/text.ts';
import { AfkTask } from './afk.ts';
import type { RunningTask, TaskContext, TaskDefinition } from './base.ts';
import { EchoTask } from './echo.ts';
import { blockGoal, homeHook } from './mobility.ts';
import type { SkillResult } from '../skills/types.ts';
import { NightSafety } from './night.ts';
import type { Vec3 } from '../connection/types.ts';
import { registerPveCommands } from '../chat/commands-pve.ts';
import { registerSurvivalCommands } from '../chat/commands-survival.ts'; // Track S
import { PveController, pveOptionsFrom, refusedKillType } from './pve.ts';

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
  summary: 'stay online: keepalive nudges, auto-respawn, optional home point and night shelter',
  defaultUsername: 'AfkBot',
  cliOptions: { guard: { type: 'string' }, 'flee-health': { type: 'string' } },
  usage: '  --guard <radius>         start with guard mode on (PvE: fight hostiles within radius of home; docs/pve.md)\n  --flee-health <h>        run to the shelter/home below this health (default 8)',
  create(ctx: TaskContext): WalkingTask {
    const o = ctx.options;
    const log = ctx.log;
    const respawn = ctx.respawn();
    const clock = ctx.clock();
    const walking = o.walk || o.home !== undefined || o.shelter !== undefined;
    const mob = walking ? ctx.mobility() : undefined;
    let home = o.home;
    let pve: PveController | undefined; // PvE behaviours (tasks/pve.ts), built with the movement stack
    const afk = new AfkTask(ctx.conn, {
      nudgeIntervalMs: o.nudgeIntervalS * 1000,
      heartbeat: o.heartbeat,
      metrics: ctx.metrics,
      log,
      respawn,
      loop: mob?.loop,
      busy: () => (mob?.skills.nav.busy ?? false) || (pve?.ownsMovement() ?? false),
    });
    let night: NightSafety | undefined;
    if (mob) {
      const n = new NightSafety({
        clock,
        mover: mob.skills,
        position: () => mob.position(),
        inactive: () => respawn.dead || ctx.conn.state !== 'spawned' || (pve?.ownsMovement() ?? false),
        shelter: o.shelter,
        home: () => home,
        log: ctx.logger('night'),
        metrics: ctx.metrics,
      });
      night = n;
      pve = new PveController({
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
        options: pveOptionsFrom(ctx.values, ctx.taskConfig),
      });
      respawn.onEvent((e) => {
        if (e.kind === 'death') {
          pve?.onDeath();
          mob.skills.cancel();
        }
      });
      respawn.afterRespawn(
        homeHook({
          skills: mob.skills,
          home: () => home,
          skip: () => n.wantsShelter(),
          settle: async () => {
            await mob.world.waitForChunks(2, { timeoutMs: 10_000 }).catch(() => undefined);
            await mob.loop.waitTicks(10);
          },
          log,
          onResult: (r) => {
            ctx.metrics.inc(r.ok ? 'home.returns' : 'home.failed');
          },
        }),
      );
    }
    log.info(
      `afk: nudge every ${o.nudgeIntervalS > 0 ? `${o.nudgeIntervalS} s` : 'never'}${o.heartbeat ? ', heartbeat every tick' : ''}` +
        (mob ? `, walking (home ${fmt(home)}, shelter ${fmt(o.shelter)})` : ''),
    );
    const task: WalkingTask = {
      name: 'afk',
      start: () => {
        afk.start();
        night?.start();
      },
      stop: () => {
        night?.stop();
        pve?.dispose();
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
      }),
      position: () => mob?.position() ?? afk.feet,
      statusLine: () => ({ task: 'afk', ...(pve ? { behaviour: pve.behaviour() } : {}), nudges: afk.nudges, corrections: afk.corrections, deaths: respawn.deaths }),
      alive: () => !respawn.dead,
    };
    if (mob && night) {
      const n = night;
      task.home = {
        get: () => home,
        set: (p) => {
          home = p;
          log.info(p ? `home set to ${fmt(p)}` : 'home cleared');
        },
        go: () => (home && pve ? pve.walk(blockGoal(home), { timeoutTicks: 6000 }, 'walking home') : Promise.resolve({ ok: false, reason: 'no_home' })),
      };
      // through the PvE layer so a guard fight interrupts and then resumes the walk
      task.goto = (p) => (pve ? pve.walk(blockGoal(p), { timeoutTicks: 6000 }) : mob.skills.goto(blockGoal(p), { timeoutTicks: 6000 }));
      task.shelter = {
        get: () => n.shelter,
        set: (p) => {
          n.setShelter(p);
        },
        state: () => String(n.status().state),
      };
    }
    const p = pve;
    if (p) task.pve = p;
    registerPveCommands(
      ctx.chat,
      p && mob
        ? {
            follow: (name) => p.follow({ playerName: name }),
            come: (name) => p.come(name),
            stop: () => p.stop(),
            guard: () => p.guard,
            setGuard: (g) => p.setGuard(g),
            kill: (type, k) => p.kill(type, k),
            refused: (type) => refusedKillType(type, mob.world.entities),
            behaviour: () => p.behaviour(),
            selfName: () => ctx.conn.username,
          }
        : undefined,
    );
    registerSurvivalCommands({ chat: ctx.chat, source: ctx.conn, mob, pve: p, task, inactive: () => respawn.dead || ctx.conn.state !== 'spawned', logger: ctx.logger('survival') }); // Track S
    return task;
  },
};

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
