// Track CB (ADR 0066, docs/coarse.md "Budget"): a corridor across a 64 x 64-chunk cached area (1024
// blocks of hilly ground with ponds) in well under the 500 ms default, cold (every chunk graph built on
// the way) and warm. Timing: under load the numbers move; the asserted bound is loose (the owner's
// budget), the measured ones are printed for the report.
import { describe, expect, it } from 'vitest';
import { CoarseLayerImpl, ClassGrid, type CoarseSource } from '../../../src/skills/coarse/index.ts';
import { CLS_SOLID, CLS_WATER } from '../../../src/world/cache/types.ts';
import { rng } from './genworld.ts';

/** A 64 x 64-chunk world: value-noise hills (grass between -61 and -50), water in the low spots, 32 rows from -64. */
function hillySource(seed: number, chunks = 64): CoarseSource & { built: () => number } {
  const r = rng(seed);
  const cell = 24;
  const n = Math.ceil((chunks * 16) / cell) + 2;
  const grid: number[] = [];
  for (let i = 0; i < n * n; i++) grid.push(r());
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, z: number): number => {
    const gx = x / cell;
    const gz = z / cell;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = smooth(gx - ix);
    const fz = smooth(gz - iz);
    const v = (a: number, b: number) => grid[(iz + b) * n + (ix + a)]!;
    return (v(0, 0) * (1 - fx) + v(1, 0) * fx) * (1 - fz) + (v(0, 1) * (1 - fx) + v(1, 1) * fx) * fz;
  };
  const height = (x: number, z: number): number => -61 + Math.round(noise(x, z) * 11);
  const built = new Map<number, ClassGrid>();
  const WATER = -58;
  return {
    minY: -64,
    maxY: -33,
    built: () => built.size,
    chunk(cx, cz, dim) {
      if (dim !== 0 || cx < 0 || cz < 0 || cx >= chunks || cz >= chunks) return undefined;
      const k = cx * 4096 + cz;
      let g = built.get(k);
      if (!g) {
        g = new ClassGrid(-64, 32);
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const h = height(cx * 16 + x, cz * 16 + z);
            const i = (z << 4) | x;
            for (let y = -64; y <= h; y++) g.cells[(y + 64) * 256 + i] = CLS_SOLID;
            for (let y = h + 1; y <= WATER; y++) g.cells[(y + 64) * 256 + i] = CLS_WATER;
          }
        }
        built.set(k, g);
      }
      return g;
    },
  };
}

describe('coarse layer: budget (Track CB)', () => {
  it('plans across a 64 x 64-chunk area cold in well under 500 ms, warm faster', async () => {
    const src = hillySource(7);
    const layer = new CoarseLayerImpl(src, { maxChunks: 8192 });
    const start = { x: 8.5, y: -49, z: 8.5 };
    const goal = { x: 1015.5, y: -49, z: 1015.5 };
    const cold = await layer.plan({ start, goal, modes: ['walk'], maxMs: 5000, maxNodes: 2_000_000 });
    expect(cold.status, cold.reason).toBe('found');
    const warm = await layer.plan({ start, goal, modes: ['walk'], maxMs: 5000, maxNodes: 2_000_000 });
    expect(warm.status, warm.reason).toBe('found');
    const info = layer.info();
    console.log(
      `coarse perf: cold ${cold.ms.toFixed(1)} ms (${cold.expanded} expanded, ${Math.round(cold.blocks)} blocks, ${cold.legs[0]!.waypoints.length} waypoints), warm ${warm.ms.toFixed(1)} ms; ` +
        `${info.graph.builds} chunk builds ${info.graph.buildMs.toFixed(1)} ms, ${info.graph.borders} borders ${info.graph.borderMs.toFixed(1)} ms, ${info.chunks} graphs in memory`,
    );
    expect(cold.ms).toBeLessThan(500);
    expect(warm.ms).toBeLessThan(cold.ms);
    expect(cold.blocks).toBeGreaterThan(1400);
    expect(cold.blocks).toBeLessThan(2200);
    // across the same area with the mine mode as well (dig portals in every expansion)
    const mine = await layer.plan({ start, goal, modes: ['walk', 'mine'], maxMs: 5000, maxNodes: 2_000_000 });
    expect(mine.status, mine.reason).toBe('found');
    console.log(`coarse perf: walk + mine warm ${mine.ms.toFixed(1)} ms (${mine.expanded} expanded)`);
    expect(mine.ms).toBeLessThan(500);
  });

  it('keeps memory bounded: the LRU evicts chunk graphs past maxChunks', async () => {
    const src = hillySource(3, 16);
    const layer = new CoarseLayerImpl(src, { maxChunks: 32 });
    const c = await layer.plan({ start: { x: 8.5, y: -49, z: 8.5 }, goal: { x: 250.5, y: -49, z: 250.5 }, modes: ['walk'], maxMs: 5000 });
    expect(c.status, c.reason).toBe('found');
    expect(layer.info().chunks).toBeLessThanOrEqual(32);
    expect(layer.info().graph.evicted).toBeGreaterThan(0);
  });
});
