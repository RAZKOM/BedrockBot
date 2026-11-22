// The coarse layer's generated test world (Track CB): value-noise hills with ponds over a square of cached chunks, for
// coarse-perf.test.ts (the work side) and test/perf/coarse.perf.test.ts (the wall clock).
import { ClassGrid, type CoarseSource } from '../../../src/skills/coarse/index.ts';
import { CLS_SOLID, CLS_WATER } from '../../../src/world/cache/types.ts';
import { rng } from './genworld.ts';

/** A `chunks` x `chunks`-chunk world: value-noise hills (grass between -61 and -50), water in the low spots, 32 rows from -64. */
export function hillySource(seed: number, chunks = 64): CoarseSource & { built: () => number } {
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
