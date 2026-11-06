// Track F5a: the cave build's boxes (cave-layout.ts): greedy boxes cover exactly the cells of their class, the
// encoding round-trips, and the messages split at box boundaries.
import { describe, expect, it } from 'vitest';
import { CAVE_AIR, CAVE_STONE, CAVE_WATER, boxMessages, boxesVolume, decodeBoxes, encodeBoxes, greedyBoxes, type CaveBox } from '../../src/cave-layout.js';

/** A random-ish cave: stone, a winding tube of air, a pool of water in it. */
function world(sx: number, sy: number, sz: number): (x: number, y: number, z: number) => number {
  return (x, y, z) => {
    const cz = Math.round(sz / 2 + Math.sin(x / 5) * 4);
    const cy = Math.round(sy / 2 + Math.cos(x / 7) * 2);
    if (Math.abs(z - cz) <= 1 && y >= cy && y <= cy + 2) return y === cy && x % 9 < 3 ? CAVE_WATER : CAVE_AIR;
    if (y >= sy - 3) return CAVE_AIR; // the sky over it
    return CAVE_STONE;
  };
}

describe('cave boxes (cave-layout.ts)', () => {
  const size = { x: 40, y: 16, z: 24 };
  const code = world(size.x, size.y, size.z);

  it('covers every cell of a class exactly once and nothing else', () => {
    for (const want of [CAVE_AIR, CAVE_WATER]) {
      const boxes = greedyBoxes(size, code, want);
      const seen = new Uint8Array(size.x * size.y * size.z);
      for (const q of boxes) {
        for (let y = q.y0; y <= q.y1; y++) {
          for (let z = q.z0; z <= q.z1; z++) {
            for (let x = q.x0; x <= q.x1; x++) {
              expect(code(x, y, z)).toBe(want);
              seen[(y * size.z + z) * size.x + x]!++;
            }
          }
        }
      }
      let n = 0;
      for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) if (code(x, y, z) === want) n++;
      expect(boxesVolume(boxes)).toBe(n);
      expect([...seen].every((v) => v <= 1)).toBe(true);
    }
  });

  it('merges a solid slab into one box', () => {
    expect(greedyBoxes({ x: 30, y: 4, z: 20 }, () => CAVE_AIR, CAVE_AIR)).toEqual([{ b: CAVE_AIR, x0: 0, y0: 0, z0: 0, x1: 29, y1: 3, z1: 19 }]);
  });

  it('encodes and decodes boxes (large numbers too), and splits messages at boxes', () => {
    const boxes: CaveBox[] = [
      { b: 0, x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 },
      { b: 2, x0: 31, y0: 32, z0: 1023, x1: 287, y1: 149, z1: 70_000 },
      ...greedyBoxes(size, code, CAVE_AIR),
    ];
    const s = encodeBoxes(boxes);
    expect(/^[A-Za-z0-9_-]+$/.test(s)).toBe(true);
    expect(decodeBoxes(s)).toEqual(boxes);
    const parts = boxMessages(boxes, 60);
    expect(parts.every((p) => p.length <= 60)).toBe(true);
    expect(parts.flatMap((p) => decodeBoxes(p))).toEqual(boxes);
    expect(() => decodeBoxes(s.slice(0, -1))).toThrow();
  });
});
