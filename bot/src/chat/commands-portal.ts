// Nether wiring (wave 10, Track AT; docs/nether.md), owner-only like every command:
//   !nether            through the nearest known nether portal into the Nether (a user process,
//                      tasks/process/portal.ts); replies what is missing when no portal is known
//   !overworld         back through the paired portal (`nether_portal` waypoint, else the nearest)
//   !portal [status]   dimension, the portal waypoints of both sides, the last change (time to the
//                      server's ack, columns dropped), fire escapes
// and the per-dimension rules of the afk task, in one place (registered once from tasks/registry.ts):
//   - a dimension change ('start'): the planner grid is cleared (it caches cells by coordinates), every
//     user process but the portal trip and the home return are stopped ("dimension change"), the walk
//     in progress is cancelled
//   - outside the overworld: no night shelter and no sleeping (no day cycle; beds explode), home and
//     the shelter do not exist for flee, guard and the home return (they are overworld points)
//   - the End: the planner takes no drop it cannot climb back (`maxDrop` 1): never off an edge
//   - the fire / lava escape (FireProcess) above flee, eating with the survival kit afterwards
import type { Vec3 } from '../connection/types.ts';
import { survivalKitOf } from './commands-survival.ts';
import { waypointStoreOf } from './commands-nav.ts';
import { BurnWatch } from '../skills/survival/fire.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { FireProcess, PortalProcess, type PortalOutcome } from '../tasks/process/portal.ts';
import { SurfaceProcess } from '../tasks/process/surface.ts'; // Track BF
import { bedsWork, dimensionName, dimWaypointName, hasDayCycle, NETHER, OVERWORLD, THE_END, voidBelow } from '../world/dimension.ts';

export const PORTAL_COMMANDS = ['nether', 'overworld', 'portal'] as const;

const fmt = (p: Vec3 | undefined): string => (p ? `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}` : '?');

/** The reply line for a finished trip. */
export function portalEndLine(r: PortalOutcome, target: number): string {
  if (!r.ok) return `${dimensionName(target)}: ${r.reason}`;
  return `in the ${dimensionName(target)}${r.arrival ? ` at the portal ${fmt(r.arrival)}` : ''}${r.departure ? ` (left through ${fmt(r.departure)})` : ''}${r.ms !== undefined ? `, ${(r.ms / 1000).toFixed(1)} s in the portal` : ''}`;
}

/** Fire processes by task (tests, status). */
const fires = new WeakMap<object, FireProcess>();
export function fireProcessOf(task: object): FireProcess | undefined {
  return fires.get(task);
}

export function registerPortalCommands(d: CommandDeps): void {
  const { world, mobility, processes, skills, pve, task } = d;
  if (!world || !mobility || !processes || !skills) {
    for (const name of PORTAL_COMMANDS) {
      d.chat.register({
        name,
        help: '(needs walking)',
        run: ({ reply }) => {
          reply(d.needsWalking(name));
        },
      });
    }
    return;
  }
  const log = d.log;
  const loop = mobility.loop;
  const mover = settingsMover(skills, d.settings);
  const position = (): Vec3 | undefined => (loop.state.ready ? loop.state.pos : undefined);
  const dim = (): number => world.self.dimension;

  // ---- dimension rules ---------------------------------------------------------------------------
  const offChange = world.dimensions.onChange((e) => {
    if (e.phase === 'start') {
      skills.nav.grid.clear(); // cells are cached by coordinates: the old dimension's would stay
      const trip = processes.find('portal')[0];
      const stopped: string[] = [];
      for (const p of [...processes.userProcesses(), ...processes.find('home')]) {
        if (p === trip) continue;
        processes.stop(p, 'dropped');
        stopped.push(p.name);
      }
      if (!trip) skills.cancel();
      log.info(`dimension change ${dimensionName(e.from)} -> ${dimensionName(e.to)}${stopped.length ? `: stopped ${stopped.join(', ')}` : ''}`);
    } else {
      log.info(`in the ${dimensionName(e.to)} (server ack after ${Math.round(e.ms)} ms)`);
    }
  });
  // night shelter and sleeping only where the sun moves and beds work
  const night = processes.find('night')[0];
  if (night) {
    const wants = night.wants.bind(night);
    night.wants = () => hasDayCycle(dim()) && wants();
    const sleeper = night as unknown as { requestSleep?: () => { ok: boolean; reason?: string } };
    const req = sleeper.requestSleep?.bind(night);
    if (req) sleeper.requestSleep = () => (bedsWork(dim()) ? req() : { ok: false, reason: `beds explode in the ${dimensionName(dim())}` });
  }
  // home and the shelter are overworld points: not for flee, guard and the home return elsewhere
  if (pve) {
    const home = pve.d.home.bind(pve.d);
    const shelter = pve.d.shelter.bind(pve.d);
    pve.d.home = () => (dim() === OVERWORLD ? home() : undefined);
    pve.d.shelter = () => (dim() === OVERWORLD ? shelter() : undefined);
  }
  const homeAccess = task.home;
  if (homeAccess?.go) {
    const go = homeAccess.go.bind(homeAccess);
    homeAccess.go = () => (dim() === OVERWORLD ? go() : Promise.resolve({ ok: false, reason: `home is in the overworld, the bot is in the ${dimensionName(dim())} (!overworld first)` }));
  }
  // the End: no irreversible drops (an edge over the void is never taken)
  skills.nav.costsOverride = () => (voidBelow(dim()) ? { maxDrop: 1 } : undefined);

  // ---- fire / lava escape ------------------------------------------------------------------------
  const watch = new BurnWatch(d.conn, { selfRuntimeId: () => world.self.runtimeId, health: () => world.self.health, inLava: () => loop.state.inLava });
  const fire = processes.add(
    new FireProcess({
      watch,
      grid: skills.nav.grid,
      mover,
      position,
      eat: () => survivalKitOf(task)?.eat() ?? Promise.resolve(undefined),
      log,
    }),
  );
  fires.set(task, fire);
  // ---- underwater escape (Track BF): head under water too long -> swim up, walk to the nearest dry ground
  processes.add(
    new SurfaceProcess({
      loop,
      blockAt: (p) => world.blockAt(p),
      grid: skills.nav.grid,
      mover,
      air: () => pve?.mobs.selfAir,
      log,
    }),
  );
  const stop = task.stop.bind(task);
  task.stop = () => {
    offChange();
    watch.dispose();
    stop();
  };

  // ---- commands ----------------------------------------------------------------------------------
  const trip = (target: number, reply: (m: string) => void): void => {
    const here = dim();
    if (here === target) {
      reply(`already in the ${dimensionName(target)}`);
      return;
    }
    if (here === THE_END) {
      reply('in the End: the way out is the exit portal on the main island (not handled by this bot yet)');
      return;
    }
    if (target === OVERWORLD && here !== NETHER) {
      reply(`overworld: in the ${dimensionName(here)}, not the Nether`);
      return;
    }
    const p = new PortalProcess(target, {
      world,
      loop,
      mover,
      grid: skills.nav.grid,
      waypoints: waypointStoreOf(task),
      position,
      radius: () => d.settings.get('portalRadius'),
      log,
    });
    processes.add(p);
    reply(`going to the ${dimensionName(target)} (portal ${fmt(portalHint(target))})`);
    void p.result.then((r) => {
      if (r.ok || (r.reason !== 'interrupted' && r.reason !== 'replaced')) reply(portalEndLine(r, target));
    });
  };
  /** The portal the trip will likely use (waypoint), for the first reply. */
  const portalHint = (target: number): Vec3 | undefined => {
    const w = waypointStoreOf(task)?.get(dimWaypointName(target === NETHER ? OVERWORLD : NETHER, 'portal'));
    return w && w.y !== null ? { x: w.x, y: w.y, z: w.z } : undefined;
  };

  d.chat.register({
    name: 'nether',
    help: '(go through the nearest known nether portal into the Nether)',
    group: 'go',
    example: '!nether',
    run: ({ reply }) => {
      trip(NETHER, reply);
    },
  });
  d.chat.register({
    name: 'overworld',
    help: '(back to the overworld through the paired portal)',
    group: 'go',
    example: '!overworld',
    run: ({ reply }) => {
      trip(OVERWORLD, reply);
    },
  });
  d.chat.register({
    name: 'portal',
    help: '[status] (dimension, portal waypoints, last dimension change)',
    group: 'info',
    example: '!portal status',
    auto: 'every trip through a portal records both ends as the portal / nether_portal waypoints',
    run: ({ reply }) => {
      const store = waypointStoreOf(task);
      const wp = (n: string): string => {
        const w = store?.get(n);
        return w ? `${w.x} ${w.y ?? '?'} ${w.z}` : 'none';
      };
      const s = world.dimensions.stats;
      const last = s.last ? `${dimensionName(s.last.from)} -> ${dimensionName(s.last.to)}, ack after ${s.lastAckMs ?? '?'} ms, ${s.lastColumnsDropped ?? '?'} columns dropped` : 'none';
      reply(`in the ${dimensionName(dim())}${world.dimensions.changing ? ' (changing)' : ''}; portal ${wp('portal')}, nether_portal ${wp('nether_portal')}; changes ${s.changes}, last ${last}; fire escapes ${fire.stats.escapes}`);
    },
  });
}
