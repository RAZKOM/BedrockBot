// Navigation chat commands (PLAN.md task 7.10, docs/waypoints.md), owner-only like every command:
//   !wp [list]                 list the waypoints of this server (auto ones marked *)
//   !wp set <name> [x y z]     set a waypoint (default: the bot's feet block); `home` also sets the home point
//   !wp del <name>             delete one (`home` also clears the home point)
//   !wp <name>                 show one
//   !goto <waypoint> | x y z [now]  walk to a waypoint (names first) or to a feet block; `now` (Track AK):
//                              urgent like `!come now`, the night process yields to the walk
//   !top                       walk up to the surface (the `surface` goal; pillars with throwaway blocks)
// and `blacklist <n>` / `waypoints <n>` in !status. Registered by the afk task (tasks/registry.ts).
//
// index.ts registers the coordinate-only !goto of chat/commands.ts after the task is created (and
// would replace this one), so this !goto puts itself back before every `!goto` line is dispatched.
import type { Vec3 } from '../connection/types.ts';
import { silentLogger, type Logger } from '../log.ts';
import type { NavGoal } from '../skills/nav/goals.ts';
import type { NavGotoOptions } from '../skills/nav/navigator.ts';
import type { Goal, SkillResult } from '../skills/types.ts';
import type { TaskContext } from '../tasks/base.ts';
import type { Mobility } from '../tasks/mobility.ts';
import type { PveController } from '../tasks/pve.ts';
import type { WalkingTask } from '../tasks/registry.ts';
import type { RespawnController } from '../tasks/respawn.ts';
import { attachAutoWaypoints, blockOf } from '../waypoints/auto.ts';
import { WaypointStore, waypointName, waypointsLocation, type Waypoint } from '../waypoints/store.ts';
import { parseCommand, type Chat, type CommandDef } from './chat.ts';
import { dimensionName, dimWaypointName, surfaceRefusal, waypointDimension } from '../world/dimension.ts'; // Track AT

export const NAV_COMMANDS = ['wp', 'goto', 'top'] as const;
const NEEDS_WALK = 'needs a task that can walk (start with --walk, --home or --target realm)';
const GOTO_TICKS = 6000;
const TOP_TICKS = 2400;

export interface NavChatDeps {
  store: WaypointStore;
  /** Feet position, when known. */
  position(): Vec3 | undefined;
  /** Walk to a goal (through the PvE layer when there is one); undefined when the task cannot walk. `urgent`: `!goto ... now`. */
  walk?: (goal: NavGoal, opts: NavGotoOptions, label: string, o?: { urgent?: boolean }) => Promise<SkillResult>;
  /** The home point: `!wp set home` / `!wp del home` change it too. */
  home?: { set(p: Vec3 | undefined): void };
  /** Track AT: the current dimension (`!top` refuses in the Nether). */
  dimension?: () => number | undefined;
}

const fmtW = (w: Pick<Waypoint, 'x' | 'y' | 'z'>): string => `${w.x} ${w.y ?? '?'} ${w.z}`;

/** The goal for a waypoint: its feet block, or its column when the height is unknown. */
export function waypointGoal(w: Pick<Waypoint, 'x' | 'y' | 'z'>): NavGoal {
  return w.y === null ? { type: 'xz', x: w.x, z: w.z } : { type: 'block', p: { x: w.x, y: w.y, z: w.z } };
}

function numbers(args: readonly string[]): Vec3 | undefined {
  if (args.length !== 3) return undefined;
  const n = args.map(Number);
  if (!n.every((v) => Number.isFinite(v))) return undefined;
  return { x: Math.floor(n[0]!), y: Math.floor(n[1]!), z: Math.floor(n[2]!) };
}

/** Registers !wp, !goto and !top on `chat`. */
export function registerNavChat(chat: Chat, d: NavChatDeps): void {
  const { store } = d;
  chat.register({
    name: 'wp',
    help: '[list] | set <name> [x y z] | del <name> | <name> (waypoints)',
    group: 'go', example: '!wp set base', auto: 'the death, home and spawn waypoints keep themselves up to date', // Track AM
    run: ({ reply, args }) => {
      const [sub, name, ...rest] = args;
      const s = sub?.toLowerCase();
      if (s === undefined || s === 'list') {
        const all = store.list();
        reply(all.length ? `waypoints (${all.length}): ${all.map((w) => `${w.name}${w.auto ? '*' : ''} ${fmtW(w)}`).join(', ')}` : 'no waypoints yet (!wp set <name>)');
        return;
      }
      if (s === 'set') {
        const n = waypointName(name);
        if (!n) {
          reply('usage: !wp set <name> [x y z] (name: 1..32 of a-z 0-9 _ -)');
          return;
        }
        let p: Vec3 | undefined;
        if (rest.length) {
          p = numbers(rest);
          if (!p) {
            reply('usage: !wp set <name> [x y z]');
            return;
          }
        } else {
          const here = d.position();
          if (!here) {
            reply('position unknown; give x y z');
            return;
          }
          p = blockOf(here);
        }
        let w: Waypoint;
        const dim = d.dimension?.() ?? 0; // Track AT: outside the overworld the name gets its dimension's prefix (home stays the overworld's)
        if (dim !== 0 && waypointDimension(n) !== dim) {
          if (n === 'home') {
            reply('home is an overworld point; set it there (!wp set home)');
            return;
          }
          w = store.set(dimWaypointName(dim, n), p);
        } else if (n === 'home' && d.home) {
          d.home.set(p); // the home point follows (and sets the waypoint)
          w = store.get('home') ?? store.set('home', p, { auto: true });
        } else {
          w = store.set(n, p);
        }
        reply(`waypoint ${w.name} set to ${fmtW(w)}${n === 'home' && d.home ? ' (home point too)' : ''}`);
        return;
      }
      if (s === 'del' || s === 'delete' || s === 'rm') {
        const n = waypointName(name);
        if (!n || !store.get(n)) {
          reply(`no waypoint "${name ?? ''}"`);
          return;
        }
        if (n === 'home' && d.home) d.home.set(undefined);
        store.delete(n);
        reply(`waypoint ${n} deleted${n === 'home' && d.home ? ' (home point cleared)' : ''}`);
        return;
      }
      const w = store.get(sub!);
      reply(w ? `waypoint ${w.name}${w.auto ? ' (auto)' : ''}: ${fmtW(w)}, set ${w.at}` : `no waypoint "${sub}"; usage: !wp [list] | set <name> [x y z] | del <name>`);
    },
  });

  const walk = d.walk;
  const gotoDef: CommandDef = {
    name: 'goto',
    help: '<waypoint> | x y z [now] (walk to a waypoint or a feet block; now: before the night shelter)',
    group: 'go', example: '!goto base',
    run: ({ reply, args: raw }) => {
      if (!walk) {
        reply(`goto ${NEEDS_WALK}`);
        return;
      }
      // Track AK: a trailing `now` (not a lone `!goto now`: that is a waypoint name) marks the walk urgent
      const now = raw.length > 1 && raw[raw.length - 1]!.toLowerCase() === 'now';
      const args = now ? raw.slice(0, -1) : raw;
      let goal: NavGoal;
      let what: string;
      if (args.length === 1) {
        // Track AT: in the Nether / End `portal` means `nether_portal` / `end_portal`; the overworld's waypoints are not walkable there
        const dim = d.dimension?.() ?? 0;
        const w = (dim !== 0 ? store.get(dimWaypointName(dim, args[0]!)) : undefined) ?? store.get(args[0]!);
        if (!w) {
          reply(`no waypoint "${args[0]}" (!wp list)`);
          return;
        }
        if (waypointDimension(w.name) !== dim) {
          reply(`waypoint ${w.name} is in the ${dimensionName(waypointDimension(w.name))}, not in the ${dimensionName(dim)} (${dim === 0 ? '!overworld' : '!overworld first'})`);
          return;
        }
        goal = waypointGoal(w);
        what = `${w.name} (${fmtW(w)})`;
      } else {
        const p = numbers(args);
        if (!p) {
          reply('usage: !goto <waypoint> | x y z');
          return;
        }
        goal = { type: 'block', p };
        what = `${p.x} ${p.y} ${p.z}`;
      }
      reply(`walking to ${what}${now ? ' now' : ''}`);
      void walk(goal, { timeoutTicks: GOTO_TICKS }, `walking to ${what}`, now ? { urgent: true } : {}).then((r) => {
        if (r.ok) reply(`arrived at ${what}`);
        else if (r.reason !== 'interrupted') reply(`goto: ${r.reason}${r.note ? ` (${r.note})` : ''}`); // Track BI: note
      });
    },
  };
  chat.register(gotoDef);
  // index.ts registers chat/commands.ts's !goto (coordinates only) after the task: take the name back
  chat.onLine((line) => {
    if (parseCommand(line.body, chat.prefix)?.name === 'goto') chat.register(gotoDef);
  });

  chat.register({
    name: 'top',
    help: '(walk up to the surface: out of a cave or a pit)',
    group: 'go', example: '!top',
    run: ({ reply }) => {
      if (!walk) {
        reply(`top ${NEEDS_WALK}`);
        return;
      }
      const refusal = surfaceRefusal(d.dimension?.()); // Track AT
      if (refusal) {
        reply(`top: ${refusal}`);
        return;
      }
      reply('going up to the surface');
      void walk({ type: 'surface' }, { timeoutTicks: TOP_TICKS, allowPlace: true }, 'going up to the surface').then((r) => {
        const p = d.position();
        if (r.ok) reply(`on the surface${p ? ` at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` : ''}`);
        else if (r.reason !== 'interrupted') reply(`top: ${r.reason}`);
      });
    },
  });
}

/**
 * Track AK: `!goto ... now` marks the goto process urgent, the flag the night process yields to
 * (commands-pve.ts `yieldWhile`: a user process with `urgent` true), like `!come now`.
 */
export function markUrgent(p: object | undefined): boolean {
  if (!p) return false;
  (p as { urgent?: boolean }).urgent = true;
  return true;
}

/** Track AT: the waypoint store registerNavCommands loaded for a task (the portal commands share it). */
const navStores = new WeakMap<object, WaypointStore>();
export function waypointStoreOf(task: object): WaypointStore | undefined {
  return navStores.get(task);
}

export interface NavCommandDeps {
  ctx: Pick<TaskContext, 'chat' | 'conn' | 'values' | 'logger'>;
  task: WalkingTask;
  mob?: Mobility;
  pve?: PveController;
  respawn?: RespawnController;
  /** Tests: a store instead of the config directory's file. */
  store?: WaypointStore;
}

/**
 * The afk task's navigation commands: loads this server's waypoints, keeps the automatic ones
 * (death, spawn, home) current, registers !wp / !goto / !top, and adds the blacklist size and the
 * waypoint count to !status (and the blacklist entries to the task status).
 */
export function registerNavCommands(d: NavCommandDeps): WaypointStore {
  const { ctx, task, mob, pve } = d;
  let log: Logger = silentLogger;
  try {
    log = ctx.logger('nav');
  } catch {
    // tests without a logger
  }
  let store = d.store;
  if (!store) {
    const loc = waypointsLocation(ctx.values);
    store = new WaypointStore({ file: loc.file, server: loc.server, log });
    store.load();
    log.info(loc.file ? `waypoints: ${loc.file} (${store.size})` : 'waypoints: in memory only (--no-config)');
  }
  const st = store;
  navStores.set(task, st); // Track AT: the portal commands read and write the `portal` waypoints here
  const offAuto = attachAutoWaypoints({ store: st, conn: ctx.conn, respawn: d.respawn, log });
  // the navigator's place / use actions (pillar-up for !top, doors) need the packet source and a hotbar
  if (mob) mob.skills.attach({ source: ctx.conn, ...(pve ? { hotbar: pve.hotbar } : {}) });

  // the home waypoint follows the task's home point (!home set / clear, --home)
  const home = task.home;
  if (home) {
    const set = home.set.bind(home);
    home.set = (p) => {
      set(p);
      if (p) st.set('home', p, { auto: true, chosen: true });
      else st.delete('home');
    };
    // A home chosen with !home set outlives restarts: it wins over the config's `home` (which used to be written
    // over the saved waypoint at every start), --home on the command line wins over both, !home clear forgets it.
    const saved = st.get('home');
    const cur = home.get();
    if (saved?.chosen && saved.y !== null && ctx.values.home === undefined) {
      if (cur?.x !== saved.x || cur.y !== saved.y || cur.z !== saved.z) log.info(`home: ${fmtW(saved)}, saved by the last !home set (the start gave ${cur ? fmtW(cur) : 'none'})`);
      set({ x: saved.x, y: saved.y, z: saved.z });
    } else if (cur) st.set('home', cur, { auto: true });
  }

  const walk = mob
    ? (goal: NavGoal, opts: NavGotoOptions, label: string, o: { urgent?: boolean } = {}): Promise<SkillResult> => {
        // through the PvE layer so a guard fight interrupts and then resumes the walk (pve.walk is typed
        // for the basic goals; it hands the goal to skills.goto unchanged)
        if (!pve) return mob.skills.goto(goal, opts);
        const r = pve.walk(goal as Goal, opts, label);
        if (o.urgent) markUrgent(pve.processes.userProcesses().find((p) => p.name === 'goto' && !p.done));
        return r;
      }
    : undefined;
  registerNavChat(ctx.chat, {
    store: st,
    position: () => task.position(),
    ...(walk ? { walk } : {}),
    ...(home ? { home } : {}),
    ...(mob ? { dimension: () => mob.world.self.dimension } : {}), // Track AT
  });

  const baseLine = task.statusLine?.bind(task);
  task.statusLine = () => ({ ...(baseLine?.() ?? { task: task.name }), ...(mob ? { blacklist: mob.skills.nav.blacklist.size } : {}), waypoints: st.size });
  const baseStatus = task.status.bind(task);
  task.status = () => ({ ...baseStatus(), nav: { blacklist: mob?.skills.nav.blacklist.list() ?? [], waypoints: st.list() } });
  const baseStop = task.stop.bind(task);
  task.stop = () => {
    offAuto();
    baseStop();
  };
  return st;
}
