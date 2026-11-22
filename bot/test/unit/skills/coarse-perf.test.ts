// Track CB (ADR 0066, docs/coarse.md "Budget"): a corridor across a 64 x 64-chunk cached area (1024 blocks of hilly
// ground with ponds), cold (every chunk graph built on the way) and warm. Track REL3: the unit run checks the work (the
// corridor found, its length, the warm plan building no chunk graph again and expanding no more than the cold one); the
// wall-clock bounds (cold under 500 ms, warm faster) are in the opt-in perf project (test/perf/coarse.perf.test.ts,
// `pnpm test:perf`): under load they measured the machine (cold 710 ms beside a CPU load, 816 ms for the case).
import { describe, expect, it } from 'vitest';
import { CoarseLayerImpl } from '../../../src/skills/coarse/index.ts';
import { hillySource } from './coarse-world.ts';

/** No wall-clock limit binds in the unit run: the node limit is the bound (a loaded machine must not end a plan early). */
const NO_TIME_LIMIT = 600_000;

describe('coarse layer: budget (Track CB)', () => {
  it('plans across a 64 x 64-chunk area; warm builds no chunk graph again and expands no more', async () => {
    const src = hillySource(7);
    const layer = new CoarseLayerImpl(src, { maxChunks: 8192 });
    const start = { x: 8.5, y: -49, z: 8.5 };
    const goal = { x: 1015.5, y: -49, z: 1015.5 };
    const cold = await layer.plan({ start, goal, modes: ['walk'], maxMs: NO_TIME_LIMIT, maxNodes: 2_000_000 });
    expect(cold.status, cold.reason).toBe('found');
    const builds = layer.info().graph.builds;
    expect(builds).toBeGreaterThan(0);
    const warm = await layer.plan({ start, goal, modes: ['walk'], maxMs: NO_TIME_LIMIT, maxNodes: 2_000_000 });
    expect(warm.status, warm.reason).toBe('found');
    console.log(`coarse work: cold ${cold.expanded} expanded, ${builds} chunk builds, ${Math.round(cold.blocks)} blocks; warm ${warm.expanded} expanded`);
    expect(layer.info().graph.builds).toBe(builds); // warm: every graph from the cache
    expect(warm.expanded).toBeLessThanOrEqual(cold.expanded);
    expect(warm.blocks).toBeCloseTo(cold.blocks, 6);
    expect(cold.blocks).toBeGreaterThan(1400);
    expect(cold.blocks).toBeLessThan(2200);
    // across the same area with the mine mode as well (dig portals in every expansion)
    const mine = await layer.plan({ start, goal, modes: ['walk', 'mine'], maxMs: NO_TIME_LIMIT, maxNodes: 2_000_000 });
    expect(mine.status, mine.reason).toBe('found');
  });

  it('keeps memory bounded: the LRU evicts chunk graphs past maxChunks', async () => {
    const src = hillySource(3, 16);
    const layer = new CoarseLayerImpl(src, { maxChunks: 32 });
    const c = await layer.plan({ start: { x: 8.5, y: -49, z: 8.5 }, goal: { x: 250.5, y: -49, z: 250.5 }, modes: ['walk'], maxMs: NO_TIME_LIMIT });
    expect(c.status, c.reason).toBe('found');
    expect(layer.info().chunks).toBeLessThanOrEqual(32);
    expect(layer.info().graph.evicted).toBeGreaterThan(0);
  });
});
