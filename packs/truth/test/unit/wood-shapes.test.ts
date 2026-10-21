import { describe, expect, it } from 'vitest';
import { TREE_KINDS, treeShape } from '../../src/woodShapes.js';

describe('treeShape', () => {
  it('a log column of `height` and a canopy from top - 1 to top + 2', () => {
    const s = treeShape(10, -60, -4, 5);
    expect(s.logs).toEqual([-60, -59, -58, -57, -56].map((y) => ({ x: 10, y, z: -4 })));
    const ys = [...new Set(s.leaves.map((p) => p.y))].sort((a, b) => a - b);
    expect(ys).toEqual([-57, -56, -55, -54]);
    // radius 2 without corners around the trunk at top - 1 and top: 20 + 20 leaves, then 5 + 5
    expect(s.leaves.length).toBe(20 + 20 + 5 + 5);
    expect(s.leaves.every((p) => Math.max(Math.abs(p.x - 10), Math.abs(p.z + 4)) <= 2)).toBe(true);
  });

  it('never puts a leaf on a log and has no duplicates; rejects bad heights', () => {
    for (const h of [1, 4, 6, 9]) {
      const s = treeShape(0, 0, 0, h);
      const logs = new Set(s.logs.map((p) => `${p.x},${p.y},${p.z}`));
      const leaves = s.leaves.map((p) => `${p.x},${p.y},${p.z}`);
      expect(leaves.some((k) => logs.has(k))).toBe(false);
      expect(new Set(leaves).size).toBe(leaves.length);
    }
    expect(() => treeShape(0, 0, 0, 0)).toThrow();
    expect(() => treeShape(0, 0, 0, 2.5)).toThrow();
    expect(TREE_KINDS).toContain('birch');
  });
});
