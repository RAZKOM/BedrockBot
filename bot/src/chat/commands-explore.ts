// Explore and branch-mining wiring (wave 9, Track AI; docs/explore.md, docs/mining.md "Branch
// mining"), owner-only like every command:
//   !explore [radius] [now]   walk the frontier within radius (default `exploreRadius`, 16..1024) of
//                             home (else of where the bot stands) until the world cache knows every
//                             column the walk can show; a user process (trip readiness first; `now`
//                             goes at night without a chestplate)
//   !explore stop | status
// It also attaches branch mining (skills/mine/branch.ts) to the bot's skills, so `!mine <ore> n` with
// no known target digs a staircase to the ore's best Y and branch-mines there (settings mineBranchY,
// mineTunnelLen, allowPlace for torches), then walks back to the surface and home.
// Registered by the afk task (tasks/registry.ts, one line). Without walking: `explore needs a task that can walk`.
import type { Vec3 } from '../connection/types.ts';
import { Explorer, type ExploreState } from '../skills/explore/explorer.ts';
import type { ExploreCache } from '../skills/explore/frontier.ts';
import { attachBranch } from '../skills/mine/branch.ts';
import { breakBlocker } from '../skills/nav/actions.ts';
import { blockGoal } from '../tasks/mobility.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { ExploreProcess } from '../tasks/process/explore.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { splitNow } from '../tasks/process/readiness.ts';

export const MIN_EXPLORE_RADIUS = 16;
export const MAX_EXPLORE_RADIUS = 1024;

/** Every explorer by task (tests and status). */
const explorers = new WeakMap<object, Explorer>();

export function explorerOf(task: object): Explorer | undefined {
  return explorers.get(task);
}

/** The world cache as the explorer reads it, when it has the calls (WorldCache does). */
export function exploreCacheOf(cache: unknown): ExploreCache | undefined {
  const c = cache as Partial<ExploreCache> | undefined;
  return c && typeof c.known === 'function' && typeof c.summary === 'function' ? (c as ExploreCache) : undefined;
}

/** The end line of an explore run. */
export function exploreEndLine(e: Explorer, state: ExploreState): string {
  if (state === 'failed') return `${e.summary()}; stopped: ${e.lastError ?? 'failed'}`;
  return e.summary();
}

export function registerExploreCommands(d: CommandDeps): Explorer | undefined {
  const { pve, world, mobility, processes, skills } = d;
  if (!pve || !world || !mobility || !processes || !skills) {
    d.chat.register({
      name: 'explore',
      help: '(needs walking)',
      run: ({ reply }) => {
        reply(d.needsWalking('explore'));
      },
    });
    return undefined;
  }
  const log = d.log;
  const loop = mobility.loop;
  const mover = settingsMover(skills, d.settings);
  const position = (): Vec3 | undefined => (loop.state.ready ? loop.state.pos : undefined);
  const viewRadius = (): number => Math.max(2, Math.min(32, Math.floor(Math.sqrt(world.chunks.loadedCount / Math.PI))));
  const explorer = new Explorer({
    goto: (g, o) => mover.goto(g, o),
    cancel: () => {
      if (skills.nav.busy) skills.cancel();
    },
    position,
    ready: () => d.conn.state === 'spawned' && loop.state.ready && world.self.health > 0,
    waitTicks: (n) => loop.waitTicks(n),
    cache: () => exploreCacheOf(world.cache),
    viewRadius,
    waitChunks: (r, centre, timeoutMs) => world.waitForChunks(r, { center: centre, timeoutMs }),
    log,
  });
  explorers.set(d.task, explorer);

  // branch mining for `!mine` (skills/mine/branch.ts): the miner of commands-farm.ts uses these skills
  const nav = skills.nav;
  const feetFloor = (): Vec3[] => {
    const s = loop.state.pos;
    return [{ x: Math.floor(s.x), y: Math.floor(s.y + 1e-6) - 1, z: Math.floor(s.z) }];
  };
  const detach = attachBranch(skills, {
    dig: (p, o) => skills.dig(p, o),
    goto: (g, o) => mover.goto(g, o),
    place: (p, o) => skills.place(p, o),
    breakRule: (q) => breakBlocker(nav.grid, q.x, q.y, q.z, {}, feetFloor()),
    floor: (q) => {
      const c = nav.grid.cls(q.x, q.y, q.z);
      return c ? c.floor && !c.liquid && !c.danger : undefined;
    },
    free: (q) => nav.grid.free(q.x, q.y, q.z),
    blockAt: (q) => world.blockAt(q),
    position,
    health: () => world.self.health,
    slots: () => world.inventory.slots,
    branchY: () => d.settings.get('mineBranchY'),
    tunnelLen: () => d.settings.get('mineTunnelLen'),
    allowPlace: () => d.settings.get('allowPlace'),
    waitTicks: (n) => loop.waitTicks(n),
    yaw: () => world.self.yaw,
    say: (m) => {
      d.chat.say(m);
    },
    itemsNear: (p, r) => {
      let n = 0;
      for (const e of world.entities.values()) if (e.type === 'minecraft:item' && Math.hypot(e.pos.x - (p.x + 0.5), e.pos.y - (p.y + 0.5), e.pos.z - (p.z + 0.5)) <= r) n++;
      return n;
    },
    returnUp: (start, why, pickups) => {
      log.info(`branch: back to the surface at ${start.x} ${start.y} ${start.z} (${why})${pickups.length ? `, through ${pickups.length} holes with drops` : ''}`);
      void (async () => {
        // drops the miner's collect left in their holes first (the planner digs the head room)
        for (const p of pickups) {
          const r = await pve.walk(blockGoal(p), { allowBreak: true, timeoutTicks: 1200 }, 'picking up a drop');
          if (r.ok) await loop.waitTicks(10);
          else if (r.reason === 'interrupted') return;
        }
        const r = await pve.walk(blockGoal(start), { allowBreak: true, timeoutTicks: 6000 }, 'walking back to the surface'); // digging allowed: the miner's own tunnels may have dropped it into a pocket
        if (!r.ok) log.warn(`branch: back to the surface: ${r.reason}`);
        if (r.ok && d.task.home?.get()) void pve.returnHome(`branch mining ${why}`, { ifIdle: true, timeoutTicks: 6000 });
      })();
    },
    log,
  });
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    detach();
    explorer.stop();
    stop();
  };

  let current: ExploreProcess | undefined;
  const live = (): ExploreProcess | undefined => (current && !current.done ? current : undefined);
  d.chat.register({
    name: 'explore',
    tier: 'front', group: 'work', example: '!explore 128', auto: 'branch mining: !mine with no known ore digs a staircase to the ore level and branch-mines', // Track AM tiers (merge)
    help: `[radius] [now] | stop | status (map the land around home)`,
    run: ({ reply, args: raw }) => {
      const { args, now } = splitNow(raw);
      const a = (args[0] ?? '').toLowerCase();
      if (a === 'stop') {
        const p = live();
        if (!p) return reply('not exploring');
        processes.stop(p, 'stopped');
        return reply(`stopped; ${explorer.summary()}`);
      }
      if (a === 'status') return reply(live() ? `${live()!.status().line}; ${explorer.summary()}` : `not exploring${explorer.stats.startedAt ? ` (last: ${explorer.summary()})` : ''}`);
      const radius = a === '' ? d.settings.get('exploreRadius') : Number(a);
      if (!Number.isInteger(radius) || radius < MIN_EXPLORE_RADIUS || radius > MAX_EXPLORE_RADIUS || args.length > 1) return reply(`usage: !explore [radius ${MIN_EXPLORE_RADIUS}..${MAX_EXPLORE_RADIUS}] [now] | stop | status`);
      const here = position();
      if (!here) return reply('explore: not ready yet');
      if (!exploreCacheOf(world.cache)) return reply('explore: needs the world cache (it is off: BEDROCKBOT_CACHE=0)');
      const trip = pve.tripCheck('explore', undefined, now);
      if (trip.refuse) return reply(trip.refuse);
      const home = d.task.home?.get();
      const centre = home ? { x: home.x + 0.5, y: home.y, z: home.z + 0.5 } : { ...here };
      const old = live();
      if (old) processes.stop(old, 'replaced');
      const p = new ExploreProcess(explorer, { centre, radius }, { needed: () => pve.prepNeeded(undefined), prepare: (alive, phase) => pve.prepare(alive, phase) });
      current = processes.add(p);
      void p.result.then((s) => {
        if (s !== 'stopped') reply(exploreEndLine(explorer, s));
      });
      const c = `${Math.floor(centre.x)} ${Math.floor(centre.y)} ${Math.floor(centre.z)}`;
      return reply(`exploring r=${radius} around ${home ? 'home' : 'here'} (${c})${trip.prep ? ', eating first' : ''}${processes.paused ? ' (held: !resume)' : ''}`);
    },
  });
  return explorer;
}
