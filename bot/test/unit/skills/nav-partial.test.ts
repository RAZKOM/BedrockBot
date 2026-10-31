// Track BA (docs/pathfinding.md "Segments, re-planning and stuck handling"): partial-path selection
// ported from Baritone's AbstractNodeCostSearch (nav/baritone/bestSoFar.ts). The module's bookkeeping;
// where a node-limited search ends next to a U wall, in a dead-end corridor and on open ground; the
// `no_progress` answer; and closed loops that walk out of a U wall and a cup with tiny node budgets.
// The numbers of main's scoring (the lowest h + trap) quoted in comments were measured on the same
// layouts with main's astar.ts (Track BA report).
import { describe, expect, it } from 'vitest';
import { BotSkills } from '../../../src/skills/index.ts';
import { findPath, type PathResult } from '../../../src/skills/nav/astar.ts';
import { BestSoFar, COEFFICIENTS, FAILURE_NODES_FACTOR, MIN_DIST_PATH, MIN_IMPROVEMENT } from '../../../src/skills/nav/baritone/bestSoFar.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const FEET = -60;
const end = (r: PathResult) => r.path.at(-1)!;
const d2 = (r: PathResult) => {
  const a = r.path[0]!;
  const b = end(r);
  return (b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2;
};
const plan = (w: GenWorld, from: [number, number], to: [number, number], maxNodes: number) =>
  findPath(new NavGrid(w), { x: from[0], y: FEET, z: from[1] }, { type: 'block', p: { x: to[0], y: FEET, z: to[1] } }, { maxNodes, maxMs: 60_000 });

/** A 3-high stone U: its base across x = `bx` (z -10 .. 9, 20 wide), arms 10 long towards +x (open away from a start at smaller x). */
function uWall(bx: number): GenWorld {
  const w = flatGen();
  w.fill({ x: bx, y: -60, z: -10 }, { x: bx, y: -58, z: 9 }, 'stone');
  w.fill({ x: bx, y: -60, z: -10 }, { x: bx + 9, y: -58, z: -10 }, 'stone');
  w.fill({ x: bx, y: -60, z: 9 }, { x: bx + 9, y: -58, z: 9 }, 'stone');
  return w;
}

/** The same U turned round: open towards the start (a cup), its base across x = 21. */
function cup(): GenWorld {
  const w = flatGen();
  w.fill({ x: 21, y: -60, z: -10 }, { x: 21, y: -58, z: 9 }, 'stone');
  w.fill({ x: 12, y: -60, z: -10 }, { x: 21, y: -58, z: -10 }, 'stone');
  w.fill({ x: 12, y: -60, z: 9 }, { x: 21, y: -58, z: 9 }, 'stone');
  return w;
}

/** A 1-wide dead-end corridor along +x: cells x 0 .. len at z 0, 3-high walls, closed at x = len + 1, open at x = -1. */
function corridor(len: number): GenWorld {
  const w = flatGen();
  w.fill({ x: -1, y: -60, z: -1 }, { x: len, y: -58, z: -1 }, 'stone');
  w.fill({ x: -1, y: -60, z: 1 }, { x: len, y: -58, z: 1 }, 'stone');
  w.fill({ x: len + 1, y: -60, z: -1 }, { x: len + 1, y: -58, z: 1 }, 'stone');
  return w;
}

describe('BestSoFar (Baritone AbstractNodeCostSearch)', () => {
  it("keeps Baritone's constants", () => {
    expect(COEFFICIENTS).toEqual([1.5, 2, 2.5, 3, 4, 5, 10]);
    expect(MIN_DIST_PATH).toBe(5);
    expect(MIN_IMPROVEMENT).toBe(0.01);
    expect(FAILURE_NODES_FACTOR).toBe(4); // failureTimeoutMS 2000 / primaryTimeoutMS 500
  });

  it('scores h + g / k + trap, needs more than MIN_IMPROVEMENT, returns the lowest coefficient best farther than 5 blocks', () => {
    const b = new BestSoFar();
    b.reset(0, 0, 0, 0, 100);
    expect(b.best()).toBe(-1); // only the start
    expect(b.failing).toBe(true);
    // 3 blocks out: improves every best, but too close to the start
    b.consider(1, 3, 0, 0, 90, 3, 0);
    expect(b.best()).toBe(-1);
    expect(b.failing).toBe(true);
    // 6 blocks out, but expensive: h 80, g 40 -> k 1.5 .. 3: 106.7 / 100 / 96 / 93.3 lose to node 1's 92 / 91.5 / 91.2 / 91;
    // k 4: 90 beats 90.75 (and k 5, k 10)
    b.consider(2, 6, 0, 0, 80, 40, 0);
    expect(b.best()).toBe(2);
    expect(b.coefficient()).toBe(4);
    expect(b.failing).toBe(false);
    // 6 blocks out the other way, cheap: wins the low coefficients
    b.consider(3, 0, 0, 6, 85, 6, 0);
    expect(b.best()).toBe(3);
    expect(b.coefficient()).toBe(1.5);
    // a trap (irreversible drop) adds to every score
    b.consider(4, 0, 0, 7, 80, 7, 30);
    expect(b.best()).toBe(3);
    // an improvement of MIN_IMPROVEMENT or less does not replace a best
    b.consider(5, 0, 0, 8, 85 - 0.005, 6, 0);
    expect(b.best()).toBe(3);
    b.consider(6, 0, 0, 8, 85 - 0.02, 6, 0);
    expect(b.best()).toBe(6);
  });
});

describe('partial paths (node budget hit)', () => {
  it('a U wall 3 blocks ahead: ends round its corner (5+ blocks out), not against it; or none', () => {
    // main's scoring ended at (2, 0), against the wall, with 50 and 100 nodes
    for (const n of [30, 50, 100]) {
      const r = plan(uWall(3), [0, 0], [30, 0], n);
      const line = `${n} nodes: ${r.status} ${r.reason ?? ''} end ${end(r).x},${end(r).z}, ${r.expanded} expanded`;
      expect(r.status, line).toBe('partial');
      if (r.reason === 'no_progress') {
        expect(r.path, line).toHaveLength(1);
        continue;
      }
      expect(d2(r), line).toBeGreaterThan(MIN_DIST_PATH ** 2);
      expect(Math.abs(end(r).z) >= 10 || end(r).x > 3, line).toBe(true); // past the wall's end, or beside an arm
    }
  });

  it('a U wall 12 blocks ahead: ends at its base (as before; 11 blocks closer), never short of 5 blocks', () => {
    for (const n of [50, 100, 200]) {
      const r = plan(uWall(12), [0, 0], [30, 0], n);
      expect(r.status).toBe('partial');
      expect(end(r)).toMatchObject({ x: 11, z: 0 });
    }
  });

  it('a dead-end corridor pointing at the goal, 4 long: none, or an end outside it', () => {
    // main's scoring ended in the corridor ((3, 0) or its dead end (4, 0)) with 4 to 16 nodes
    for (const n of [4, 8, 16, 32, 64]) {
      const r = plan(corridor(4), [0, 0], [30, 0], n);
      const line = `${n} nodes: ${r.status} ${r.reason ?? ''} end ${end(r).x},${end(r).z}, ${r.expanded} expanded`;
      if (r.status === 'found') continue;
      expect(r.status, line).toBe('partial');
      if (r.reason === 'no_progress') {
        expect(r.path, line).toHaveLength(1);
        continue;
      }
      const e = end(r);
      expect(e.z !== 0 || e.x < -1 || e.x > 5, line).toBe(true); // not in the corridor (x -1 .. 4, z 0)
      expect(d2(r), line).toBeGreaterThan(MIN_DIST_PATH ** 2);
    }
  });

  it('open ground: the end is 5+ blocks out and closer to the goal', () => {
    const w = flatGen();
    for (const n of [8, 20, 40]) {
      const r = plan(w, [0, 0], [60, 50], n);
      expect(r.status).toBe('partial');
      expect(r.reason).toBeUndefined();
      expect(d2(r)).toBeGreaterThan(25);
      const e = end(r);
      expect(Math.hypot(60 - e.x, 50 - e.z)).toBeLessThan(Math.hypot(60, 50) - 5);
      expect(r.limited).toBe(true);
    }
  });

  it('no progress: a 3 x 3 pen with a gap too far round (budget 2) gives the start alone, reason no_progress', () => {
    const w = flatGen();
    // a closed 3-high ring of radius 3 round the start, but for a gap on the far side from the goal
    w.fill({ x: -3, y: -60, z: -3 }, { x: 3, y: -58, z: 3 }, 'stone');
    w.fill({ x: -2, y: -60, z: -2 }, { x: 2, y: -58, z: 2 }, 'air');
    w.fill({ x: -3, y: -60, z: 0 }, { x: -3, y: -59, z: 0 }, 'air');
    const r = plan(w, [0, 0], [40, 0], 2);
    expect(r.status).toBe('partial');
    expect(r.reason).toBe('no_progress');
    expect(r.path).toHaveLength(1);
    expect(r.path[0]).toMatchObject({ x: 0, z: 0, move: 'start', cost: 0 });
    expect(r.expanded).toBe(2 * FAILURE_NODES_FACTOR); // failing: on up to 4 x the budget
    // with room, the search gets out through the gap
    const r2 = plan(w, [0, 0], [40, 0], 400);
    expect(r2.reason).toBeUndefined();
    expect(r2.path.some((p) => p.x === -3 && p.z === 0)).toBe(true);
  });

  it('an exhaustive search is still none (no way down from a 4-high pillar, everything known)', () => {
    const w = flatGen({ x: -8, y: -64, z: -8 }, { x: 16, y: 24, z: 16 });
    w.fill({ x: 0, y: -60, z: 0 }, { x: 0, y: -57, z: 0 }, 'stone');
    const r = findPath(new NavGrid(w), { x: 0, y: -56, z: 0 }, { type: 'block', p: { x: 0, y: FEET, z: 3 } }, { maxNodes: 1, maxMs: 60_000 });
    expect(r.status).toBe('none');
    expect(r.reason).toBeUndefined();
    expect(r.path).toHaveLength(1);
  });
});

async function walk(gen: GenWorld, goal: [number, number], maxNodes: number) {
  const { conn, loop } = harness({ x: 0.5, y: FEET, z: 0.5 });
  const skills = new BotSkills({ loop, world: fakeWorld(gen), path: { maxNodes } });
  conn.tick(5);
  let result: unknown;
  const p = skills.goto({ type: 'block', p: { x: goal[0], y: FEET, z: goal[1] } }).then((r) => (result = r));
  for (let t = 0; t < 4000 && skills.nav.busy; t++) conn.tick();
  skills.cancel();
  await p;
  const rep = skills.status().lastGoto!;
  return { result, rep, line: `${JSON.stringify(result)} ${rep.ticks} ticks, failures ${rep.failures}, plans ${rep.plans.map((q) => `${q.reason}:${q.status}/${q.nodes}`).join(' ')}` };
}

describe('closed loop with tiny node budgets (main\'s scoring: unreachable after 3 "no progress" failures, or one nothing changes after)', () => {
  it.each([
    ['U wall 12 ahead, goal 30 past it', () => uWall(12), [30, 0], 100],
    ['U wall 12 ahead, goal in its pocket', () => uWall(12), [17, 0], 200],
    ['cup, goal 30 past it', cup, [30, 0], 200],
    ['U wall 3 ahead', () => uWall(3), [30, 0], 100],
  ] as const)('%s: reaches the goal', async (_name, mk, goal, n) => {
    const r = await walk(mk(), [goal[0], goal[1]], n);
    expect(r.result, r.line).toEqual({ ok: true });
    expect(r.rep.failures, r.line).toBe(0);
    expect(r.rep.stuck, r.line).toBe(0);
  });

  it('a plan with no progress counts as a failure, not as a path to walk; the same search from the same node with nothing changed is not run again (unreachable at once)', async () => {
    const w = flatGen();
    w.fill({ x: -3, y: -60, z: -3 }, { x: 3, y: -58, z: 3 }, 'stone');
    w.fill({ x: -2, y: -60, z: -2 }, { x: 2, y: -58, z: 2 }, 'air');
    const r = await walk(w, [40, 0], 50); // sealed: every plan is exhaustive -> none at once
    expect(r.result, r.line).toEqual({ ok: false, reason: 'unreachable' });
    const w2 = flatGen();
    w2.fill({ x: -3, y: -60, z: -3 }, { x: 3, y: -58, z: 3 }, 'stone');
    w2.fill({ x: -2, y: -60, z: -2 }, { x: 2, y: -58, z: 2 }, 'air');
    w2.fill({ x: -3, y: -60, z: 0 }, { x: -3, y: -59, z: 0 }, 'air');
    const r2 = await walk(w2, [40, 0], 2);
    expect(r2.result, r2.line).toEqual({ ok: false, reason: 'unreachable' });
    expect(r2.rep.failures, r2.line).toBe(1); // Realm 2026-10-31: was 3 identical searches
    expect(r2.rep.plans, r2.line).toHaveLength(1);
    expect(r2.rep.distance, r2.line).toBeLessThan(0.5);
    expect(r2.rep.plans.every((p) => p.nodes === 1), r2.line).toBe(true);
    // a block the planner reads changed after the failure: searched again (and only once more, nothing changing after it)
    const w3 = flatGen();
    w3.fill({ x: -3, y: -60, z: -3 }, { x: 3, y: -58, z: 3 }, 'stone');
    w3.fill({ x: -2, y: -60, z: -2 }, { x: 2, y: -58, z: 2 }, 'air');
    w3.fill({ x: -3, y: -60, z: 0 }, { x: -3, y: -59, z: 0 }, 'air');
    const { conn, loop } = harness({ x: 0.5, y: FEET, z: 0.5 });
    const skills = new BotSkills({ loop, world: fakeWorld(w3), path: { maxNodes: 2 } });
    conn.tick(5);
    const p = skills.goto({ type: 'block', p: { x: 40, y: FEET, z: 0 } });
    conn.tick(5);
    w3.set(20, -60, 20, 'stone');
    for (let t = 0; t < 4000 && skills.nav.busy; t++) conn.tick();
    expect(await p).toEqual({ ok: false, reason: 'unreachable' });
    const rep3 = skills.status().lastGoto!;
    expect(rep3.failures).toBe(2);
    expect(rep3.plans).toHaveLength(2);
  });
});
