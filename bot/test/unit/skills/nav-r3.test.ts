// Track R3 (docs/pathfinding.md "Long dig ways (Track R3)"; decisions/0072-reachability.md decisions 24+): the guards of
// the long dig ways. A ravine too deep to fall into and too wide to jump is crossed by a stair dug down one wall and up
// the other: the plain search at the owner's price goes nowhere in the live budget, the long dig search (digs at their
// time, the heuristic weighted) finds the stair in a fraction of it, with no fall that hurts; the closed loop walks a
// long trip whose only way is such a stair.
import { describe, expect, it } from 'vitest';
import { fallPolicy } from '../../../src/skills/fall/policy.ts';
import { findPath, type PathOptions } from '../../../src/skills/nav/astar.ts';
import { breakTicksWith } from '../../../src/skills/nav/baritone/helper.ts';
import { benchWorld } from '../../../src/skills/nav/bench/worlds.ts';
import { TICKS } from '../../../src/skills/nav/costs.ts';
import { LONG_DIG_PRICE, LONG_DIG_WEIGHT, harmlessFalls, longDigOptions } from '../../../src/skills/nav/digway.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { GenWorld } from './genworld.ts';
import { runPair } from './reach-sim.ts';

const TOOLS = ['iron_pickaxe', 'iron_shovel'];
const INV = { slots: TOOLS.map((name) => ({ name, count: 1 })), selected: 0 };
const POLICY = fallPolicy({ enabled: true, health: 20, healthKnown: true, absorption: 0, margin: 8, epf: 0, burning: false, hostileDistance: Infinity, bucket: false, clutchOn: true, waterWorks: true, clutchMax: 40 })!;

/**
 * Stone to y -37 under grass at -36 (feet -35), a trench x 0..4 across the box, open from -55 up (a 20-block drop); the
 * far side 4 lower (grass at -40, feet -39), as the bench's long ravine crossings that dig.
 */
function ravineWorld(): GenWorld {
  const w = new GenWorld({ x: -64, y: -64, z: -64 }, { x: 128, y: 48, z: 128 });
  w.fill({ x: -64, y: -64, z: -64 }, { x: 63, y: -64, z: 63 }, 'bedrock');
  w.fill({ x: -64, y: -63, z: -64 }, { x: 63, y: -37, z: 63 }, 'stone');
  w.fill({ x: -64, y: -36, z: -64 }, { x: 63, y: -36, z: 63 }, 'grass_block');
  w.fill({ x: 0, y: -55, z: -64 }, { x: 4, y: -36, z: 63 }, 'air');
  w.fill({ x: 5, y: -39, z: -64 }, { x: 63, y: -36, z: 63 }, 'air');
  w.fill({ x: 5, y: -40, z: -64 }, { x: 63, y: -40, z: 63 }, 'grass_block');
  return w;
}

/** The live settings' level 0: allowBreak at the owner's digPenalty 500, no fall that hurts. */
const LIVE: PathOptions = { allowBreak: true, allowOpen: true, breakTicks: (c) => breakTicksWith(c, INV), costs: { walk: TICKS.sprint, dig: 500 }, falls: harmlessFalls(POLICY), maxMs: 60_000 };

describe('Track R3: the long dig search', () => {
  it('crosses a ravine 20 deep by a dug stair in a fraction of the nodes the plain search needs', () => {
    const start = { x: -6, y: -35, z: 0 };
    const goal = { type: 'block' as const, p: { x: 10, y: -39, z: 0 } };
    // the owner's price: found only past what the live 2 s buy in the worker (about 130 000 nodes; measured 287 000)
    const plain = findPath(new NavGrid(ravineWorld()), start, goal, { ...LIVE, maxNodes: 2_000_000 });
    expect(plain.status).toBe('found');
    expect(plain.expanded).toBeGreaterThan(130_000);
    const long = findPath(new NavGrid(ravineWorld()), start, goal, { ...longDigOptions(LIVE), maxNodes: 130_000 });
    expect(long.status).toBe('found');
    expect(long.expanded).toBeLessThan(100_000); // measured 63 000
    expect(long.expanded * 3).toBeLessThan(plain.expanded);
    let digs = 0;
    for (let i = 1; i < long.path.length; i++) {
      const n = long.path[i]!;
      digs += n.act?.dig?.length ?? 0;
      expect(long.path[i - 1]!.feet - n.feet, `a drop at ${n.x} ${n.feet} ${n.z}`).toBeLessThanOrEqual(3 + 1e-6); // no fall that hurts
    }
    expect(digs).toBeGreaterThan(20); // a stair down and up, not a jump
  });

  it('keeps the level and the rules: only the dig price and the weight change', () => {
    const o = longDigOptions({ ...LIVE, relax: { built: true } });
    expect(o.relax).toEqual({ built: true, weight: LONG_DIG_WEIGHT });
    expect(o.costs?.dig).toBe(LONG_DIG_PRICE);
    expect(o.costs?.walk).toBe(TICKS.sprint);
    expect(o.falls).toBe(LIVE.falls);
    expect(longDigOptions({ costs: { dig: 5 } }).costs?.dig).toBe(5); // never dearer than the goto's own price
  });
});

describe('Track R3: a long trip whose only way digs (allowBreak on, allowPlace off, digPenalty 500)', () => {
  it('long:1:2: the trip crosses the ravine by a dug stair and arrives unhurt, nothing placed', async () => {
    const bw = benchWorld('long', 1);
    const run = await runPair(bw, bw.pairs[2]!, new Map(), { tools: TOOLS, speed: 1.25, allowBreak: true, allowPlace: false, digPenalty: 500 });
    expect(run.died, run.reply).toBe(false);
    expect(run.reply, run.log.slice(-12).join('\n')).toBe('arrived');
    expect(run.damage).toBe(0);
    expect(run.placed).toBe(0);
  }, 300_000);
});
