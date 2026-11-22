// The opt-in perf project (`pnpm test:perf`, Track REL3, docs/testing.md "The perf project"): find.test.ts's former
// time bounds, as they were (PLAN.md task 2.6: scanning a synthetic 100k-block world under 5 ms, the class index too).
// The unit case keeps the work: the same logs found, far fewer blocks tested through the index.
import { describe, expect, it } from 'vitest';
import { forestWorld } from '../unit/world/forest-world.ts';

function median(fn: () => void, runs = 9): number {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(runs / 2)]!;
}

describe('World.find, wall clock', () => {
  it('scans 100k blocks in under 5 ms (full scan) and indexed lookups are far faster', () => {
    const { world } = forestWorld(false);
    const origin = { x: 0.5, y: -48, z: 0.5 };
    let n = 0;
    const scan = median(() => {
      n = world.find((b) => b.name === 'oak_log', { origin, radius: 60, max: 10 }).length;
    });
    const indexed = median(() => {
      world.find((b) => b.name === 'oak_log', { origin, radius: 60, max: 10, class: 'log' });
    });
    console.log(`[find] full scan of 102 400 blocks: median ${scan.toFixed(2)} ms; class index: median ${indexed.toFixed(3)} ms`);
    expect(n).toBe(10);
    expect(scan).toBeLessThan(5);
    expect(indexed).toBeLessThan(5);
  });
});
