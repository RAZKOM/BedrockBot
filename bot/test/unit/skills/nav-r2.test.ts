// Track R2 (docs/pathfinding.md "Reachability (Track R1)", its R2 part; decisions/0072-reachability.md "R2"): the guards
// of the live-settings fixes. A passable cell under water is wet (a waterlogged block); a plan from under water ends
// with the head out of it, never "no progress" at the bottom; a partial plan never ends on its own pillar's top; a
// pillar is tried only with something to climb to (or the goal) over it; a corridor never aims at a waypoint in the
// air; a placed block is a rule only beyond what a goto that places carries; a jump up into a node beside lava lands
// without sliding into it; a `falls` cause names the fall.
import { describe, expect, it } from 'vitest';
import { findPath, PILLAR_REACH, type PathNode } from '../../../src/skills/nav/astar.ts';
import { BestSoFar, MIN_DIST_PATH } from '../../../src/skills/nav/baritone/bestSoFar.ts';
import type { Corridor, CorridorLeg, Portal } from '../../../src/skills/coarse/index.ts';
import { corridorState, fineTarget, floorless } from '../../../src/skills/nav/corridor.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { causeWords, fallOnPath, fallWords, rulesOnPath } from '../../../src/skills/nav/reach.ts';
import { benchWorld } from '../../../src/skills/nav/bench/worlds.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { flatGen, GenWorld } from './genworld.ts';
import { runPair } from './reach-sim.ts';

/** Stone up to y -51 (feet -50 on top), a pool 5 x 5 at x, z 0..4 holding water from -56 to -51, in a 64-wide box. */
function poolWorld(): GenWorld {
  const w = new GenWorld({ x: -32, y: -64, z: -32 }, { x: 64, y: 40, z: 64 });
  w.fill({ x: -32, y: -64, z: -32 }, { x: 31, y: -51, z: 31 }, 'stone');
  w.fill({ x: 0, y: -56, z: 0 }, { x: 4, y: -51, z: 4 }, 'water');
  return w;
}

describe('Track R2: water', () => {
  it('a passable cell without liquid under water is wet (a waterlogged block: the world model reads no water layer)', () => {
    const w = poolWorld();
    w.set(2, -54, 2, 'air'); // the "air" cell in the lake (cache class air: a waterlogged plant, a sea pickle ...)
    const g = new NavGrid(w);
    expect(g.submerged(2, -55, 2)).toBe(true); // the head in that cell, water over it
    expect(g.submerged(2, -56, 2)).toBe(true); // the head in plain water
    expect(g.submerged(2, -50, 2)).toBe(false); // over the surface
    expect(g.submerged(8, -50, 8)).toBe(false); // dry land
  });

  it('BestSoFar from a wet start: the start is no best and any node counts however near', () => {
    const b = new BestSoFar();
    b.reset(0, 0, 0, 0, 10, true);
    expect(b.best()).toBe(-1);
    expect(b.failing).toBe(true);
    b.consider(1, 1, 1, 0, 30, 5, 0); // 1.4 blocks out, worse than the start's h: still the best there is
    expect(b.best()).toBe(1);
    expect(b.failing).toBe(false);
    const dry = new BestSoFar();
    dry.reset(0, 0, 0, 0, 10);
    dry.consider(1, 1, 1, 0, 30, 5, 0);
    expect(dry.best()).toBe(-1); // a dry start: Baritone's rule (farther than MIN_DIST_PATH and better than the start)
    expect(MIN_DIST_PATH).toBe(5);
  });

  it('a plan from a lake floor towards a goal under it ends with the head out of the water, not "no progress"', () => {
    const w = poolWorld();
    w.set(2, -62, 2, 'air'); // a sealed pocket under the pool: unreachable without digging
    const g = new NavGrid(w);
    const r = findPath(g, { x: 2, y: -56, z: 2 }, { type: 'block', p: { x: 2, y: -62, z: 2 } }, { maxNodes: 3000, maxMs: 60_000 });
    expect(r.status).toBe('partial');
    expect(r.reason).toBeUndefined();
    const end = r.path.at(-1)!;
    expect(r.path.length).toBeGreaterThan(1);
    expect(g.submerged(end.x, end.y, end.z)).toBe(false);
  });
});

describe('Track R2: pillars', () => {
  it('climbs a pillar beside something to step onto, never in open air', () => {
    const w = flatGen();
    w.fill({ x: 0, y: -56, z: 6 }, { x: 2, y: -56, z: 8 }, 'stone'); // a floating platform 4 over the ground, feet -55 on it
    const g = new NavGrid(w);
    const r = findPath(g, { x: 0, y: -60, z: -6 }, { type: 'block', p: { x: 1, y: -55, z: 7 } }, { allowPlace: true, throwaway: 64, maxNodes: 200_000, maxMs: 60_000 });
    expect(r.status).toBe('found');
    const pillars = r.path.filter((n) => n.move === 'pillar');
    expect(pillars.length).toBeGreaterThan(0);
    // every pillar stands in a column next to the platform (its 3 x 3 holds platform cells)
    for (const p of pillars) expect(p.x >= -1 && p.x <= 3 && p.z >= 5 && p.z <= 9, `pillar at ${p.x} ${p.z}`).toBe(true);
    expect(PILLAR_REACH).toBe(8);
  });

  it('no more blocks placed on a path than the goto carries', () => {
    const w = flatGen();
    w.fill({ x: 0, y: -56, z: 6 }, { x: 2, y: -56, z: 8 }, 'stone'); // feet -55 on it: 5 blocks of pillar from the ground
    const g = new NavGrid(w);
    const plan = (throwaway: number) => findPath(g, { x: 0, y: -60, z: -6 }, { type: 'block', p: { x: 1, y: -55, z: 7 } }, { allowPlace: true, throwaway, maxNodes: 200_000, maxMs: 60_000 });
    expect(plan(64).status).toBe('found');
    const short = plan(3);
    expect(short.status).not.toBe('found');
    expect(short.path.filter((n) => n.move === 'pillar').length).toBeLessThanOrEqual(3);
    expect(plan(5).status).toBe('found');
  });

  it('a goal in the air is pillared to; open ground far from it is not pillared on', () => {
    const w = flatGen();
    const g = new NavGrid(w);
    const r = findPath(g, { x: 0, y: -60, z: 0 }, { type: 'block', p: { x: 6, y: -56, z: 0 } }, { allowPlace: true, throwaway: 64, maxNodes: 200_000, maxMs: 60_000 });
    expect(r.status).toBe('found');
    for (const p of r.path.filter((n) => n.move === 'pillar')) expect(Math.abs(p.x - 6) <= 2 && Math.abs(p.z) <= 2).toBe(true);
  });

  it('a partial plan never ends on its own pillar', () => {
    const w = flatGen();
    w.fill({ x: 0, y: -56, z: 6 }, { x: 2, y: -56, z: 8 }, 'stone');
    const g = new NavGrid(w);
    for (const maxNodes of [200, 400, 800, 1600]) {
      const r = findPath(g, { x: 1, y: -60, z: 5 }, { type: 'block', p: { x: 40, y: -55, z: 40 } }, { allowPlace: true, throwaway: 64, maxNodes, maxMs: 60_000 });
      if (r.status === 'partial' && r.path.length > 1) expect(r.path.at(-1)!.move, `maxNodes ${maxNodes}`).not.toBe('pillar');
    }
  });
});

describe('Track R2: the corridor never aims at a waypoint in the air', () => {
  const F = -60;
  const portal = (id: string, x: number, axis: 'x' | 'y', floorY?: number): Portal => ({ id, a: 'a', b: 'b', axis, min: { x, y: F, z: 0 }, max: { x, y: F + 1, z: 0 }, center: { x, y: F + 5, z: 0 }, clearance: { height: 2, width: 1 }, ...(floorY === undefined ? {} : { floorY }), known: 'known' });

  it('a vertical opening without a floor is passed over to the first waypoint on a floor', () => {
    const portals = [portal('p1', 10, 'x', F), portal('p2', 20, 'y'), portal('p3', 40, 'x', F + 6), portal('p4', 60, 'x', F + 6)];
    const waypoints: Vec3[] = [{ x: 0.5, y: F, z: 0.5 }, { x: 10, y: F + 1, z: 0 }, { x: 20, y: F + 5, z: 0 }, { x: 40, y: F + 7, z: 0 }, { x: 60, y: F + 7, z: 0 }];
    const leg: CorridorLeg = { mode: 'mine', from: waypoints[0]!, to: waypoints.at(-1)!, portals, volumes: [], waypoints, blocks: 60, cost: 0, unknownFraction: 0, minClearance: { height: 1, width: 1 } };
    const c: Corridor = { status: 'partial', start: waypoints[0]!, goal: { x: 200.5, y: F, z: 0.5 }, dim: 0, legs: [leg], blocks: 60, cost: 0, unknownFraction: 0, expanded: 0, ms: 0, revision: 0 };
    const st = corridorState(c)!;
    expect(floorless(st, 1)).toBe(true);
    expect(st.wps[1]!.y).toBe(F + 5); // in the air
    const t = fineTarget(st, { x: 10.5, y: F, z: 0.5 })!; // the window ends at the opening (20) ...
    expect(t.index).toBe(2); // ... the target is the waypoint past it, on its floor
    expect(t.p.x).toBe(40);
  });
});

describe('Track R2: the "why" answer with the live settings', () => {
  it('a placed block breaks the place rule only beyond what a goto that places carries', () => {
    const g = new NavGrid(flatGen());
    const path: PathNode[] = [
      { x: 0, y: -60, z: 0, feet: -60, move: 'start', cost: 0 },
      { x: 0, y: -59, z: 0, feet: -59, move: 'pillar', cost: 10 },
      { x: 0, y: -58, z: 0, feet: -58, move: 'pillar', cost: 10 },
    ];
    expect(rulesOnPath(g, path, {})).toEqual(['place']);
    expect(rulesOnPath(g, path, { allowPlace: true, throwaway: 64 })).toEqual([]);
    expect(rulesOnPath(g, path, { allowPlace: true, throwaway: 1 })).toEqual(['place']);
  });
});

describe('Track R2: a jump up beside lava (allowBreak on, allowPlace off, digPenalty 500)', () => {
  it('lava:1:6: the tunnel under the lava climbs out by a lava cell; the landing does not slide into it', async () => {
    const bw = benchWorld('lava', 1);
    const run = await runPair(bw, bw.pairs[6]!, new Map(), { tools: ['iron_pickaxe', 'iron_shovel'], speed: 1.25, allowBreak: true, allowPlace: false, digPenalty: 500 });
    expect(run.died, run.reply).toBe(false);
    expect(run.damage).toBe(0);
    expect(run.reply).toBe('arrived');
  }, 120_000);
});

describe('Track R2: a stair dug out of a ravine (allowBreak on, allowPlace off, digPenalty 500)', () => {
  it('ravine:11:12: the cut searches plan on weighted before `rule place` is the answer, and the stair is dug', async () => {
    const bw = benchWorld('ravine', 11);
    const run = await runPair(bw, bw.pairs[12]!, new Map(), { tools: ['iron_pickaxe', 'iron_shovel'], speed: 1.25, allowBreak: true, allowPlace: false, digPenalty: 500 });
    expect(run.died, run.reply).toBe(false);
    expect(run.reply).toBe('arrived');
    expect(run.placed).toBe(0);
  }, 300_000);
});

describe('Track R2: a `falls` cause names the fall', () => {
  it('the height, the damage, the budget or why no fall that hurts is taken', () => {
    const w = flatGen();
    const g = new NavGrid(w);
    const path: PathNode[] = [
      { x: 0, y: -50, z: 0, feet: -50, move: 'start', cost: 0 },
      { x: 1, y: -60, z: 0, feet: -60, move: 'drop', cost: 10 },
    ];
    const f = fallOnPath(g, path, { falls: { hpBudget: 2, factor: 1, hpCost: 40, clutchMax: 0, clutchCost: 40 } as never })!;
    expect(f.blocks).toBe(10);
    expect(f.damage).toBe(7);
    expect(fallWords(f)).toBe('a 10-block fall (7 HP) over the fall budget of 2 HP');
    const blocked = fallOnPath(g, path, { falls: { hpBudget: 6, factor: 1, blocked: 'a hostile within 16 blocks' } as never })!;
    expect(fallWords(blocked)).toBe('a 10-block fall (7 HP), no fall that hurts now: a hostile within 16 blocks');
    expect(causeWords({ cls: 'rule', rules: ['falls'], fall: f })).toBe('rule falls: a 10-block fall (7 HP) over the fall budget of 2 HP');
    expect(causeWords({ cls: 'rule', rules: ['falls'] })).toBe('rule falls: no fall below fallMargin');
    expect(fallOnPath(g, path.slice(0, 1), {})).toBeUndefined();
  });
});
