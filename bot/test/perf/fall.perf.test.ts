// The opt-in perf project (`pnpm test:perf`, Track REL3, docs/testing.md "The perf project"): fall.test.ts's former
// wall-clock bound of the long-drop scan (Track BI: with falls on, 300 random paths' p99 under max(80 ms, 2.5 x the p99
// with falls off)), and of the note on a refused fall (its plan on a big world cut off under 8 x EXPLAIN_MS), as they were.
// The unit cases keep the work side (nodes expanded; the plan's work-clock time).
import { describe, expect, it } from 'vitest';
import { EXPLAIN_MS, explainFallRefusal } from '../../src/skills/fall/explain.ts';
import { fallDamage } from '../../src/skills/fall/damage.ts';
import { fallPolicy } from '../../src/skills/fall/policy.ts';
import type { FallPolicy } from '../../src/skills/fall/policy.ts';
import { NavGrid, findPath, type PathResult } from '../../src/skills/nav/index.ts';
import { hillyGen, rng, surfaceFeet } from '../unit/skills/genworld.ts';

const policy = (): FallPolicy => fallPolicy({ enabled: true, health: 20, healthKnown: true, absorption: 0, margin: 8, epf: 0, burning: false, hostileDistance: Infinity, bucket: true, clutchOn: true, waterWorks: true, clutchMax: 40 })!;
const longDrop = (r: PathResult) => r.path.find((n, i) => i > 0 && n.move === 'drop' && r.path[i - 1]!.feet - n.feet > 3);

describe('planner cost of the long-drop scan, wall clock', () => {
  it('300 random paths on the hilly world: with falls on the searches stay in budget', () => {
    const w = hillyGen(42);
    const run = (falls: FallPolicy | undefined) => {
      const r = rng(4321);
      const grid = new NavGrid(w);
      const times: number[] = [];
      let drops = 0;
      while (times.length < 300) {
        const sx = Math.floor(r() * 124) - 62;
        const sz = Math.floor(r() * 124) - 62;
        const gx = Math.floor(r() * 124) - 62;
        const gz = Math.floor(r() * 124) - 62;
        const sf = surfaceFeet(w, sx, sz);
        const gf = surfaceFeet(w, gx, gz);
        if (sf === undefined || gf === undefined) continue;
        const res = findPath(grid, { x: sx, y: Math.floor(sf), z: sz }, { type: 'block', p: { x: gx, y: Math.floor(gf), z: gz } }, falls ? { falls } : {});
        if (res.path.length === 0) continue;
        times.push(res.ms);
        if (longDrop(res)) drops++;
      }
      times.sort((a, b) => a - b);
      return { p50: times[150]!, p99: times[297]!, drops };
    };
    run(undefined); // warm-up
    const off = run(undefined);
    const on = run(policy());
    console.log(`[fall perf] 300 paths: falls off p50 ${off.p50.toFixed(2)} p99 ${off.p99.toFixed(2)} ms; on p50 ${on.p50.toFixed(2)} p99 ${on.p99.toFixed(2)} ms, ${on.drops} paths with a long drop`);
    expect(on.p99).toBeLessThan(Math.max(80, off.p99 * 2.5));
  });
});

describe('the note on a refused fall, wall clock', () => {
  it('the budget: a big world is cut off, never a long block of the tick', () => {
    const big = new NavGrid(hillyGen(7));
    const p = fallPolicy({ enabled: true, health: 20, healthKnown: true, absorption: 0, margin: 8, epf: 0, burning: false, hostileDistance: Infinity, bucket: false, clutchOn: true, waterWorks: true, clutchMax: 40 })!; // fall.test.ts's policy()
    const guard = { policy: () => p, settings: () => ({ longFalls: true, fallMargin: 8, clutch: true, clutchMaxDrop: 40 }), damageOf: (h: number, l?: string) => fallDamage(h, l) };
    const t0 = performance.now();
    explainFallRefusal({ grid: big, planOptions: () => ({}) }, guard, { x: -60, y: -40, z: -60 }, { type: 'block', p: { x: 60, y: -40, z: 60 } });
    expect(performance.now() - t0).toBeLessThan(EXPLAIN_MS * 8);
  });
});
