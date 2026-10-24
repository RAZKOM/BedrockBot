// MineTask wired onto the bot's movement stack with the Track Z additions (docs/mining.md): a cheap
// bounded probe plan per candidate (PROBE_NODES / PROBE_MS), Track R's navigator blacklist for
// unreachable ores, and the ore memory persisted through the world cache (`World.cache`, read at call
// time). chat/commands-farm.ts uses it; skills/farm/index.ts `createMiner` stays the plain version.
import type { FarmParts } from '../farm/index.ts';
import { breakBlocker } from '../nav/actions.ts';
import { findPath, locateNode } from '../nav/astar.ts';
import type { Vec3 } from '../../world/types.ts';
import { MineTask } from './miner.ts';
import { OreMemory } from './seen.ts';

/** Node / time budget of a probe plan (the navigator's own main plan allows 40 000 nodes / 250 ms). */
export const PROBE_NODES = 6000;
export const PROBE_MS = 40;

export function createMinerFor(p: FarmParts, settings: { tunnelLen?: () => number; seenOnly?: () => boolean } = {}): { mine: MineTask; memory: OreMemory } {
  const { skills, world, loop } = p;
  const memory = new OreMemory(world);
  const feetFloor = (): Vec3[] => {
    const s = loop.state.pos;
    return [{ x: Math.floor(s.x), y: Math.floor(s.y + 1e-6) - 1, z: Math.floor(s.z) }];
  };
  const nav = skills.nav;
  const mine = new MineTask({
    skills,
    memory,
    plan: (goal, opts) => nav.plan(goal, undefined, opts),
    probe: (goal, opts) => {
      const start = locateNode(nav.grid, loop.state.pos);
      return start ? findPath(nav.grid, start, goal, { ...nav.planOptions(opts), maxNodes: PROBE_NODES, maxMs: PROBE_MS }) : undefined;
    },
    blacklist: nav.blacklist,
    breakRule: (q) => breakBlocker(nav.grid, q.x, q.y, q.z, {}, feetFloor()),
    stand: (x, y, z) => nav.grid.stand(x, y, z),
    blockAt: (q) => world.blockAt(q),
    inventory: world.inventory,
    position: () => (loop.state.ready ? loop.state.pos : undefined),
    health: () => world.self.health,
    ready: p.ready ?? (() => loop.state.ready && world.self.health > 0),
    waitTicks: (n) => loop.waitTicks(n),
    ...(settings.tunnelLen ? { tunnelLen: settings.tunnelLen } : {}),
    ...(settings.seenOnly ? { seenOnly: settings.seenOnly } : {}),
    ...(p.log ? { log: p.log } : {}),
  });
  return { mine, memory };
}
