// MineTask wired onto the bot's movement stack with the Track Z additions (docs/mining.md): a cheap
// bounded probe plan per candidate (PROBE_NODES / PROBE_MS), Track R's navigator blacklist for
// unreachable ores, and the ore memory persisted through the world cache (`World.cache`, read at call
// time). chat/commands-farm.ts uses it; skills/farm/index.ts `createMiner` stays the plain version.
// Track AQ (decision 0038): the walk probe (home/reach.ts probePath: 4 000 nodes / 300 ms, no digging,
// sliced), the tunnel planner's world view (the navigator's grid and break rules without the under-feet
// rule: tunnel.ts checks the floor itself), throwaway blocks for a pillar back up, the entities for the
// floor sweep, and the `mineDirect` setting.
import type { FarmParts } from '../farm/index.ts';
import { breakBlocker, DEFAULT_THROWAWAY } from '../nav/actions.ts';
import { findPath, locateNode } from '../nav/astar.ts';
import { probePath } from '../home/reach.ts';
import type { Vec3 } from '../../world/types.ts';
import { MineTask } from './miner.ts';
import { OreMemory } from './seen.ts';
import { tunnelCell, type TunnelWorld } from './tunnel.ts'; // Track BB: tunnelCell

/** Node / time budget of a probe plan (the navigator's own main plan allows 40 000 nodes / 250 ms). */
export const PROBE_NODES = 6000;
export const PROBE_MS = 40;

export interface MinerSettings {
  tunnelLen?: () => number;
  seenOnly?: () => boolean;
  /** Track AQ: setting `mineDirect` (default true). */
  direct?: () => boolean;
}

export function createMinerFor(p: FarmParts, settings: MinerSettings = {}): { mine: MineTask; memory: OreMemory } {
  const { skills, world, loop } = p;
  const memory = new OreMemory(world);
  const feetFloor = (): Vec3[] => {
    const s = loop.state.pos;
    return [{ x: Math.floor(s.x), y: Math.floor(s.y + 1e-6) - 1, z: Math.floor(s.z) }];
  };
  const nav = skills.nav;
  const tunnelWorld: TunnelWorld = {
    breakRule: (q) => breakBlocker(nav.grid, q.x, q.y, q.z, nav.breakRules(), []),
    cell: (q) => {
      const c = nav.grid.cls(q.x, q.y, q.z);
      return c && tunnelCell(c); // Track BB: the shared rule set (helper canWalkThrough / canWalkOn)
    },
    blockAt: (q) => world.blockAt(q),
  };
  const throwaway = new Set<string>(DEFAULT_THROWAWAY);
  const mine = new MineTask({
    skills,
    memory,
    plan: (goal, opts) => nav.plan(goal, undefined, opts),
    probe: (goal, opts) => {
      const start = locateNode(nav.grid, loop.state.pos);
      return start ? findPath(nav.grid, start, goal, { ...nav.planOptions(opts), maxNodes: PROBE_NODES, maxMs: PROBE_MS }) : undefined;
    },
    walkProbe: (goal) => probePath(nav, goal, loop.state.pos), // Track AQ
    tunnelWorld, // Track AQ
    throwaways: () => world.inventory.slots.slice(0, 36).reduce((a, s) => a + (s && throwaway.has(s.name) ? s.count : 0), 0), // Track AQ
    entities: () => world.entities, // Track AQ
    blacklist: nav.blacklist,
    breakRule: (q) => breakBlocker(nav.grid, q.x, q.y, q.z, nav.breakRules(), feetFloor()),
    stand: (x, y, z) => nav.grid.stand(x, y, z),
    blockAt: (q) => world.blockAt(q),
    inventory: world.inventory,
    position: () => (loop.state.ready ? loop.state.pos : undefined),
    health: () => world.self.health,
    ready: p.ready ?? (() => loop.state.ready && world.self.health > 0),
    waitTicks: (n) => loop.waitTicks(n),
    ...(settings.tunnelLen ? { tunnelLen: settings.tunnelLen } : {}),
    ...(settings.seenOnly ? { seenOnly: settings.seenOnly } : {}),
    ...(settings.direct ? { direct: settings.direct } : {}),
    ...(p.log ? { log: p.log } : {}),
  });
  return { mine, memory };
}
