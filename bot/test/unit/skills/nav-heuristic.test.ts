// Track BE, step 5: heuristic weighting, measured only (docs/pathfinding.md "Measured", "Heuristic
// weight"). Baritone's `costHeuristic` (Settings.java, 3.563) is its heuristic's ticks per block
// (GoalXZ: octile distance x costHeuristic), just under SPRINT_ONE_BLOCK_COST (3.564): our heuristic is
// already octile x costs.walk (3.564 sprinting), so Baritone's default is our weight 1.0. This
// benchmark multiplies our heuristic by 1.0 / 1.5 / 3.563 (the brief's weights, 3.563 taken as a
// multiplier) on 20 fixed dig-heavy queries (allowBreak, the owner's digPenalty 60): a stone block
// 9 x 9 x 6 set on the generated hilly world round a 1 x 2 pocket, the goal in the pocket, the start
// 12 to 20 blocks out. The weight is applied by wrapping the search's goal test (test-only); the
// planner itself is unchanged.
import { describe, expect, it } from 'vitest';
import { NavGrid, PathSearch, TICKS } from '../../../src/skills/nav/index.ts';
import type { GoalTest, NavGoal } from '../../../src/skills/nav/goals.ts';
import type { PathResult } from '../../../src/skills/nav/astar.ts';
import { hillyGen, rng, surfaceFeet } from './genworld.ts';

const WEIGHTS = [1, 1.5, 3.563];

function weighted(grid: NavGrid, start: { x: number; y: number; z: number }, goal: NavGoal, w: number): PathResult {
  const s = new PathSearch(grid, start, goal, { allowBreak: true, costs: { walk: TICKS.sprint, dig: 60 }, maxNodes: 500_000, maxMs: 20_000 });
  const inner = s as unknown as { test: GoalTest };
  const t = inner.test;
  inner.test = { ...t, done: t.done.bind(t), h: (x, y, z) => w * t.h(x, y, z) };
  return s.step()!;
}

// About 40 s (85 searches of 40 000 to 70 000 nodes): run with NAV_HEURISTIC_BENCH=1.
describe.skipIf(process.env.NAV_HEURISTIC_BENCH !== '1')('heuristic weight (Baritone costHeuristic), measured', () => {
  it('20 dig-heavy queries on the hilly world: nodes, time and cost vs weight 1', () => {
    const w = hillyGen(42);
    const r = rng(77);
    const queries: { start: { x: number; y: number; z: number }; goal: NavGoal }[] = [];
    // 25 stone blocks on a 20-block grid (none overlap), then a start between them (a diagonal 10, 10 out)
    const centres: { cx: number; cz: number; base: number }[] = [];
    for (let gx = -40; gx <= 40; gx += 20) {
      for (let gz = -40; gz <= 40; gz += 20) {
        const top = surfaceFeet(w, gx, gz);
        if (top === undefined) continue;
        const base = Math.floor(top);
        // a 9 x 9 x 6 stone block round a 1 x 2 pocket at the ground level
        w.fill({ x: gx - 4, y: base, z: gz - 4 }, { x: gx + 4, y: base + 5, z: gz + 4 }, 'stone');
        w.fill({ x: gx, y: base, z: gz }, { x: gx, y: base + 1, z: gz }, 'air');
        centres.push({ cx: gx, cz: gz, base });
      }
    }
    for (const c of centres) {
      if (queries.length >= 20) break;
      // the four diagonals, from a random one on; the first start from which the pocket is found
      const k0 = Math.floor(r() * 4);
      for (let k = 0; k < 4; k++) {
        const d = (k0 + k) % 4;
        const sx = c.cx + (d & 1 ? 10 : -10);
        const sz = c.cz + (d & 2 ? 10 : -10);
        const sf = surfaceFeet(w, sx, sz);
        if (sf === undefined) continue;
        const q = { start: { x: sx, y: Math.floor(sf), z: sz }, goal: { type: 'block', p: { x: c.cx, y: c.base, z: c.cz } } as NavGoal };
        if (weighted(new NavGrid(w), q.start, q.goal, 1).status !== 'found') continue;
        queries.push(q);
        break;
      }
    }
    const rows: string[] = [];
    const sum: Record<number, { nodes: number; ms: number; ratio: number; found: number }> = {};
    for (const wt of WEIGHTS) sum[wt] = { nodes: 0, ms: 0, ratio: 0, found: 0 };
    // warm-up (JIT)
    for (const q of queries.slice(0, 3)) weighted(new NavGrid(w), q.start, q.goal, 1);
    for (const q of queries) {
      const base = weighted(new NavGrid(w), q.start, q.goal, 1);
      const cells: string[] = [];
      for (const wt of WEIGHTS) {
        const res = wt === 1 ? base : weighted(new NavGrid(w), q.start, q.goal, wt);
        const ratio = base.status === 'found' && res.status === 'found' ? res.cost / base.cost : NaN;
        const digs = res.path.filter((n) => n.act?.dig).length;
        cells.push(`${res.status} ${res.expanded}n ${res.ms.toFixed(1)}ms cost ${res.cost.toFixed(0)} digs ${digs}`);
        const s = sum[wt]!;
        s.nodes += res.expanded;
        s.ms += res.ms;
        if (Number.isFinite(ratio)) {
          s.ratio += ratio;
          s.found++;
        }
      }
      rows.push(`${JSON.stringify(q.start)} -> ${JSON.stringify((q.goal as { p: unknown }).p)}: ${cells.join(' | ')}`);
    }
    const table = WEIGHTS.map((wt) => {
      const s = sum[wt]!;
      return `weight ${wt}: ${s.nodes} nodes (${((s.nodes / sum[1]!.nodes) * 100).toFixed(1)} %), ${s.ms.toFixed(0)} ms, mean cost ratio ${(s.ratio / s.found).toFixed(3)} over ${s.found} found`;
    });
    console.log(`[nav-heuristic]\n  ${rows.join('\n  ')}\n  ${table.join('\n  ')}`);
    expect(queries).toHaveLength(20);
    expect(sum[1]!.found).toBe(20);
    // a weight >= 1 never makes a cheaper path than the admissible search
    for (const wt of WEIGHTS) expect(sum[wt]!.ratio / sum[wt]!.found).toBeGreaterThanOrEqual(1 - 1e-9);
  }, 300_000);
});
