// PvE / follow chat commands (PLAN.md tasks 7.4 to 7.6, docs/pve.md), owner-only like every command:
//   !follow [name] [now]    follow a player (default: whoever sent the command)
//   !come [name] [now]      walk to within 2 blocks of the player (default: the sender)
//   !stop                   cancel every command (follow / come / kill / goto / gather) and a pending home
//                           return (Track Q: guard, flee and night keep running)
//   !guard [status] | on | off | <radius>
//   !kill <type> [n] [now]  kill up to n (default 1) mobs of that type within 32 blocks; players: refused
//   !sleep [on | off | status]  go to bed now (night only), or switch auto-sleep (wave 7, Track W)
// Trip readiness (wave 7, Track W; tasks/process/readiness.ts, docs/pve.md "Trip readiness"): a
// come / follow / kill trip of more than 16 blocks eats first when food or health is below 14 (the
// reply says `eating first`); at night without a chestplate it is refused unless the command ends
// with `now` (then the night process also yields to it).
// Registered by the afk task (tasks/registry.ts). Without the movement stack every command answers
// "<cmd> needs a task that can walk (...)", like !goto.
import type { Chat, Sender } from './chat.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { refusedKillType } from '../tasks/pve.ts';
import { survivalKitOf } from './commands-survival.ts';
import { entityFeet, reachDistance } from '../skills/combat/hostiles.ts';
import { EYE_HEIGHT } from '../skills/combat/combat.ts';
import { SleepController, SLEEP_FROM, SLEEP_UNTIL } from '../skills/survival/sleep.ts';
import { NightProcess, type NightBedEvent } from '../tasks/process/night.ts';
import { splitNow, type TripCheck } from '../tasks/process/readiness.ts';
import type { Vec3 } from '../connection/types.ts';

export interface PveCommandDeps {
  follow(name: string, o?: { urgent?: boolean }): string;
  come(name: string, o?: { urgent?: boolean }): Promise<{ ok: boolean; reason?: string; note?: string }>; // Track BH: note
  stop(): string;
  guard(): { on: boolean; radius: number };
  setGuard(g: { on?: boolean; radius?: number }): { on: boolean; radius: number };
  kill(type: string, n: number, o?: { urgent?: boolean }): Promise<{ ok: boolean; killed: number; want: number; reason: string; type: string }>;
  /** True when `type` must be refused (player, selectors, a player's name). */
  refused(type: string): boolean;
  behaviour(): string;
  /** The bot's own name (it does not follow itself). */
  selfName(): string;
  /** Trip readiness (Track W): refuse at night without a chestplate, and whether it eats first. `target`: a player name, or `kill:<type>`. */
  trip?(cmd: string, target: string, now: boolean): TripCheck;
  /** `!sleep` (Track W); undefined without the night process. */
  sleep?: SleepCommandDeps;
}

export interface SleepCommandDeps {
  /** Go to bed tonight: the bed, or why not. */
  request(): { ok: boolean; reason?: string; bed?: Vec3; timeOfDay?: number };
  setAuto(on: boolean): void;
  status(): string;
  /** Replies for the request until the morning or giving up. */
  onEvent(fn: (e: NightBedEvent) => void): () => void;
}

export const PVE_COMMANDS = ['follow', 'come', 'stop', 'guard', 'kill', 'sleep'] as const;

const NEEDS_WALK = 'needs a task that can walk (start with --walk, --home or --target realm)';
export const KILL_REFUSED = 'refused: I never attack players (PvE only)';
const MAX_KILL = 64;
const MAX_RADIUS = 64;

function who(sender: Sender, args: string[]): string | undefined {
  if (args[0]) return args[0];
  return sender.kind === 'player' ? sender.name.replace(/§./g, '') : undefined;
}

const fmtP = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`;

/**
 * The afk task's registration (Track Q, tasks/registry.ts list): the PvE commands on its controller.
 * `!stop` stops every command and what it pre-empted (and a pending home return); guard, flee and
 * night keep running. Track W also wires here: the survival kit into the controller (flee eating,
 * trip readiness), the sleep controller into the night process, and the night process's yield to
 * urgent (`now`) commands.
 */
export function registerPveCommandsFor(d: CommandDeps): void {
  const p = d.pve;
  const world = d.world;
  const mob = d.mobility;
  let sleep: SleepCommandDeps | undefined;
  if (p && world) {
    const task = d.task as typeof d.task | undefined;
    // the kit is built by registerSurvivalCommands after this registration: look it up when needed
    if (task) p.kit = () => survivalKitOf(task);
    const night = d.processes?.find('night').find((x): x is NightProcess => x instanceof NightProcess);
    if (night && d.processes) {
      const pm = d.processes;
      night.yieldWhile = () => pm.userProcesses().some((u) => (u as { urgent?: boolean }).urgent === true && !u.done);
    }
    if (night && mob && d.conn && task) {
      const sleeper = new SleepController({
        source: d.conn,
        loop: mob.loop,
        world: mob.world,
        selfRuntimeId: () => mob.world.self.runtimeId,
        rawHotbarItem: (slot) => p.hotbar.rawItem(slot),
        logger: d.log,
      });
      night.attachBed({
        sleeper,
        world: mob.world,
        mover: p.mover,
        position: () => mob.position(),
        centres: () => [task.shelter?.get(), task.home?.get()].filter((v): v is Vec3 => v !== undefined),
        waypoint: () => bedWaypoint(task),
        defend: () => defendOnce(p),
        stopDefend: () => {
          if (p.combat.busy) p.combat.cancel();
        },
        log: d.log,
      });
      // the saved setting: `!sleep on / off` and `!set autoSleep` both persist it
      night.autoSleep = d.settings.get('autoSleep');
      const offSetting = d.settings.onChange((k, v) => {
        if (k === 'autoSleep') night.autoSleep = v === true;
      });
      const stop = task.stop.bind(task);
      task.stop = () => {
        offSetting();
        sleeper.dispose();
        stop();
      };
      sleep = {
        request: () => night.requestSleep(),
        setAuto: (on) => {
          d.settings.set('autoSleep', on);
        },
        status: () => {
          const s = night.sleepStatus();
          const bed = night.beds()[0];
          return `sleep: auto ${night.autoSleep ? 'on' : 'off'}, ${s.sleeping ? 'sleeping' : `phase ${String(s.phase)}`}, bed ${bed ? fmtP(bed) : 'none known'}; slept ${String(s.slept)}, refused ${String(s.refusals)}`;
        },
        onEvent: (fn) => night.onBedEvent(fn),
      };
    }
  }
  registerPveCommands(
    d.chat,
    p && world
      ? {
          follow: (name, o) => p.follow({ playerName: name }, o),
          come: (name, o) => p.come(name, o),
          stop: () => p.stopCommands(),
          guard: () => p.guard,
          setGuard: (g) => p.setGuard(g),
          kill: (type, k, o) => p.kill(type, k, o),
          refused: (type) => refusedKillType(type, world.entities),
          behaviour: () => p.behaviour(),
          selfName: () => d.selfName(),
          trip: (cmd, target, now) => {
            if (target.startsWith('kill:')) {
              const e = p.nearestOfType(target.slice(5));
              return p.tripCheck(cmd, e ? entityFeet(e) : p.position(), now);
            }
            return p.tripCheck(cmd, p.playerFeet(target), now);
          },
          ...(sleep ? { sleep } : {}),
        }
      : undefined,
  );
}

/** The `bed` waypoint (Track R's store, read through the task status it extends). */
function bedWaypoint(task: { status(): Record<string, unknown> }): Vec3 | undefined {
  try {
    const nav = task.status().nav as { waypoints?: { name: string; x: number; y: number | null; z: number }[] } | undefined;
    const w = nav?.waypoints?.find((x) => x.name === 'bed');
    return w && w.y !== null ? { x: w.x, y: w.y, z: w.z } : undefined;
  } catch {
    return undefined;
  }
}

/** Guard in place at the bed: fight one threat within reach without walking. */
async function defendOnce(p: NonNullable<CommandDeps['pve']>): Promise<boolean> {
  const me = p.position();
  const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
  let best: { rid: bigint; d: number } | undefined;
  for (const e of p.d.world.entities.values()) {
    if (!p.isThreat(e)) continue;
    const d = reachDistance(eye, e);
    if (d <= 3.2 && (!best || d < best.d)) best = { rid: e.runtimeId, d };
  }
  if (!best || p.combat.busy) return false;
  const r = await p.combat.fight(best.rid, { approach: false, maxRange: 5, outOfRangeTicks: 20, timeoutTicks: 400 });
  p.countFight(r);
  return true;
}

export function registerPveCommands(chat: Chat, deps: PveCommandDeps | undefined): void {
  if (!deps) {
    for (const name of PVE_COMMANDS) {
      chat.register({
        name,
        help: '(needs walking)',
        run: ({ reply }) => {
          reply(`${name} ${NEEDS_WALK}`);
        },
      });
    }
    return;
  }
  const eating = (t: TripCheck | undefined) => (t?.prep ? ' (eating first)' : '');
  chat.register({
    name: 'follow',
    help: '[name] [now] (follow a player; default you)',
    tier: 'front', group: 'go', example: '!follow', // Track AM
    run: ({ reply, sender, args: raw }) => {
      const { args, now } = splitNow(raw);
      const name = who(sender, args);
      if (!name) {
        reply('usage: !follow <name> (the console has no position)');
        return;
      }
      if (name.toLowerCase() === deps.selfName().toLowerCase()) {
        reply('I cannot follow myself');
        return;
      }
      const t = deps.trip?.('follow', name, now);
      if (t?.refuse) {
        reply(t.refuse);
        return;
      }
      reply(`following ${deps.follow(name, now ? { urgent: true } : {})}${eating(t)}`);
    },
  });
  chat.register({
    name: 'come',
    help: '[name] [now] (walk to you, or to the named player)',
    tier: 'front', group: 'go', example: '!come',
    run: ({ reply, sender, args: raw }) => {
      const { args, now } = splitNow(raw);
      const name = who(sender, args);
      if (!name) {
        reply('usage: !come <name> (the console has no position)');
        return;
      }
      const t = deps.trip?.('come', name, now);
      if (t?.refuse) {
        reply(t.refuse);
        return;
      }
      reply(`coming to ${name}${eating(t)}`);
      void deps.come(name, now ? { urgent: true } : {}).then((r) => {
        if (r.ok) reply(`here (${name})`);
        else if (r.reason === 'not_found') reply(`come: I cannot see ${name}`);
        else if (r.reason !== 'interrupted') reply(`come: ${r.reason ?? 'failed'}${r.note ? ` (${r.note})` : ''}`); // Track BH: note
      });
    },
  });
  chat.register({
    name: 'stop',
    help: '(stop every command; guard and night keep running)',
    tier: 'front', group: 'control', example: '!stop',
    run: ({ reply }) => {
      const was = deps.stop();
      reply(`stopped (was ${was}); ${deps.behaviour()}`);
    },
  });
  chat.register({
    name: 'guard',
    help: '[status] | on | off | <radius> (fight hostiles near home)',
    tier: 'front', group: 'fight', example: '!guard on',
    run: ({ reply, args }) => {
      const a = (args[0] ?? 'status').toLowerCase();
      if (a === 'status') {
        const g = deps.guard();
        reply(`guard ${g.on ? 'on' : 'off'}, radius ${g.radius}; ${deps.behaviour()}`);
        return;
      }
      if (a === 'on' || a === 'off') {
        const g = deps.setGuard({ on: a === 'on' });
        reply(`guard ${g.on ? 'on' : 'off'}, radius ${g.radius}`);
        return;
      }
      const r = Number(a);
      if (!Number.isFinite(r) || r < 2 || r > MAX_RADIUS) {
        reply(`usage: !guard [status] | on | off | <radius 2..${MAX_RADIUS}>`);
        return;
      }
      const g = deps.setGuard({ on: true, radius: Math.round(r) });
      reply(`guard on, radius ${g.radius}`);
    },
  });
  chat.register({
    name: 'kill',
    help: '<type> [n] [now] (kill mobs of that type within 32 blocks; never players)',
    group: 'fight', example: '!kill zombie 3',
    run: ({ reply, args: raw }) => {
      const { args, now } = splitNow(raw);
      const [type, count] = args;
      if (!type) {
        reply('usage: !kill <mob type> [n]');
        return;
      }
      if (deps.refused(type)) {
        reply(KILL_REFUSED);
        return;
      }
      const n = count === undefined ? 1 : Number(count);
      if (!Number.isInteger(n) || n < 1 || n > MAX_KILL) {
        reply(`usage: !kill <mob type> [n 1..${MAX_KILL}]`);
        return;
      }
      const t = deps.trip?.('kill', `kill:${type}`, now);
      if (t?.refuse) {
        reply(t.refuse);
        return;
      }
      reply(`killing ${n} ${type}${eating(t)}`);
      void deps.kill(type, n, now ? { urgent: true } : {}).then((r) => {
        if (r.reason === 'refused_player') reply(KILL_REFUSED);
        else if (r.reason === 'interrupted') reply(`kill ${r.type}: stopped after ${r.killed}/${r.want}`);
        else if (r.reason === 'none_left') reply(`kill ${r.type}: ${r.killed}/${r.want}, no more within 32 blocks`);
        else reply(`kill ${r.type}: ${r.killed}/${r.want} done`);
      });
    },
  });
  const sl = deps.sleep;
  let offEvents: (() => void) | undefined;
  chat.register({
    name: 'sleep',
    help: '[on | off | status] (go to bed now, at night; on/off: sleep by itself at night)',
    group: 'home', example: '!sleep', auto: 'at night when a bed is known within 8 blocks of the shelter or home, or at the bed waypoint (!sleep off stops that)',
    run: ({ reply, args }) => {
      if (!sl) {
        reply(`sleep ${NEEDS_WALK}`);
        return;
      }
      const a = (args[0] ?? '').toLowerCase();
      if (a === 'on' || a === 'off') {
        sl.setAuto(a === 'on');
        reply(`sleep: auto ${a} (${a === 'on' ? 'to bed at night when a bed is near the shelter or home, or at the bed waypoint' : 'only on !sleep'}; saved as the setting autoSleep)`);
        return;
      }
      if (a === 'status') {
        reply(sl.status());
        return;
      }
      if (a !== '') {
        reply('usage: !sleep [on | off | status]');
        return;
      }
      const r = sl.request();
      if (!r.ok) {
        if (r.reason === 'not_night') reply(`sleep: not night (time of day ${r.timeOfDay ?? '?'}; beds work from ${SLEEP_FROM} to ${SLEEP_UNTIL})`);
        else if (r.reason === 'no_bed') reply('sleep: no bed within 8 blocks of the shelter, home or me (or set the bed waypoint: !wp set bed)');
        else reply(`sleep: ${r.reason ?? 'failed'}`);
        return;
      }
      reply(r.bed ? `going to bed at ${fmtP(r.bed)}` : 'going to bed');
      offEvents?.();
      const off = sl.onEvent((e) => {
        if (e.kind === 'asleep') reply(`sleeping (bed ${fmtP(e.bed)})`);
        else if (e.kind === 'refused') reply(`sleep: refused (${e.reason === 'monsters' ? 'monsters near; guarding in place, again in 20 s' : e.reason === 'not_night' ? 'not night yet; again in 20 s' : e.reason})`);
        else if (e.kind === 'gave_up') reply(`sleep: giving up for tonight (${e.reason})`);
        else if (e.kind === 'awake') reply(e.morning ? `good morning (slept ${Math.round(e.ms / 1000)} s)` : 'woke up; back to bed');
        if (e.kind === 'gave_up' || (e.kind === 'awake' && e.morning)) {
          off();
          if (offEvents === off) offEvents = undefined;
        }
      });
      offEvents = off;
    },
  });
}
