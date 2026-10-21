// Tree model (PLAN.md task 4.3): detection from any log, felling order, touching trees, refusals.
import { describe, expect, it } from 'vitest';
import { treeShape } from '../../../../packs/truth/src/woodShapes.ts';
import { detectTree, isLeaves, isLog, logKind, remainingLogs, treesFrom } from '../../../src/skills/tree/tree.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { flatGen, type GenWorld } from './genworld.ts';

function plant(w: GenWorld, x: number, z: number, h: number, kind = 'oak'): Vec3[] {
  const s = treeShape(x, -60, z, h);
  for (const p of s.logs) w.put(p.x, p.y, p.z, `${kind}_log`);
  for (const p of s.leaves) if (w.blockAt(p.x, p.y, p.z)?.name === 'air') w.put(p.x, p.y, p.z, `${kind}_leaves`);
  return s.logs;
}

const at = (w: GenWorld) => (p: Vec3) => w.blockAt(p.x, p.y, p.z);

describe('logKind / isLog / isLeaves', () => {
  it('names', () => {
    expect(logKind('oak_log')).toBe('oak');
    expect(logKind('birch_log')).toBe('birch');
    expect(logKind('stripped_oak_log')).toBeUndefined();
    expect(logKind('oak_planks')).toBeUndefined();
    expect(logKind('crimson_stem')).toBe('crimson');
    expect(isLog('dark_oak_log')).toBe(true);
    expect(isLeaves('oak_leaves')).toBe(true);
    expect(isLeaves('azalea_leaves_flowered')).toBe(true);
    expect(isLeaves('oak_log')).toBe(false);
  });
});

describe('treeShape (truth pack)', () => {
  it('log column of h with the lowest leaves at y + h - 2, never on a log', () => {
    for (const h of [4, 5, 6]) {
      const s = treeShape(0, -60, 0, h);
      expect(s.logs.map((p) => p.y)).toEqual(Array.from({ length: h }, (_, i) => -60 + i));
      expect(Math.min(...s.leaves.map((p) => p.y))).toBe(-60 + h - 2);
      const logKeys = new Set(s.logs.map((p) => `${p.x},${p.y},${p.z}`));
      expect(s.leaves.some((p) => logKeys.has(`${p.x},${p.y},${p.z}`))).toBe(false);
      expect(new Set(s.leaves.map((p) => `${p.x},${p.y},${p.z}`)).size).toBe(s.leaves.length);
    }
  });
});

describe('detectTree', () => {
  it('finds the whole tree from any of its logs, ordered bottom up', () => {
    const w = flatGen();
    const logs = plant(w, 3, 4, 5);
    for (const start of logs) {
      const t = detectTree(at(w), start)!;
      expect(t).toBeDefined();
      expect(t.kind).toBe('oak');
      expect(t.logs).toEqual(logs);
      expect(t.base).toEqual({ x: 3, y: -60, z: 4 });
      expect(t.top).toBe(-56);
      expect(t.grounded).toBe(true);
      expect(t.leaves).toBeGreaterThan(20);
    }
  });

  it('includes diagonal branches (26-connected) and orders the trunk before branches in a layer', () => {
    const w = flatGen();
    plant(w, 0, 0, 6);
    w.put(1, -57, 1, 'oak_log'); // branch touching the trunk by an edge
    w.put(2, -56, 2, 'oak_log'); // and the next one by a corner
    const t = detectTree(at(w), { x: 2, y: -56, z: 2 })!;
    expect(t.logs.length).toBe(8);
    const layer = t.logs.filter((p) => p.y === -57);
    expect(layer[0]).toEqual({ x: 0, y: -57, z: 0 });
    expect(t.base).toEqual({ x: 0, y: -60, z: 0 });
  });

  it('keeps touching trees apart (canopies touch, trunks 4 apart) and other kinds out', () => {
    const w = flatGen();
    const a = plant(w, 0, 0, 5);
    const b = plant(w, 4, 0, 6);
    const c = plant(w, 0, 4, 4, 'birch');
    expect(detectTree(at(w), a[2]!)!.logs).toEqual(a);
    expect(detectTree(at(w), b[0]!)!.logs).toEqual(b);
    const birch = detectTree(at(w), c[1]!)!;
    expect(birch.kind).toBe('birch');
    expect(birch.logs).toEqual(c);
  });

  it('two trunks side by side are one tree (felled together)', () => {
    const w = flatGen();
    plant(w, 0, 0, 5);
    plant(w, 1, 0, 4);
    expect(detectTree(at(w), { x: 1, y: -60, z: 0 })!.logs.length).toBe(9);
  });

  it('refuses a bare log column, logs not on soil, too many logs, and non-logs', () => {
    const w = flatGen();
    for (let y = -60; y < -55; y++) w.put(0, y, 0, 'oak_log');
    expect(detectTree(at(w), { x: 0, y: -58, z: 0 })).toBeUndefined();
    expect(detectTree(at(w), { x: 0, y: -58, z: 0 }, { minLeaves: 0 })).toBeDefined();
    // on planks: a building, not a tree
    plant(w, 10, 10, 5);
    w.put(10, -61, 10, 'oak_planks');
    expect(detectTree(at(w), { x: 10, y: -59, z: 10 })).toBeUndefined();
    expect(detectTree(at(w), { x: 10, y: -59, z: 10 }, { requireSoil: false })).toBeDefined();
    // a log wall
    w.fill({ x: -20, y: -60, z: -20 }, { x: -10, y: -52, z: -20 }, 'oak_log');
    w.fill({ x: -20, y: -51, z: -21 }, { x: -10, y: -51, z: -19 }, 'oak_leaves');
    expect(detectTree(at(w), { x: -15, y: -55, z: -20 })).toBeUndefined();
    expect(detectTree(at(w), { x: 5, y: -61, z: 5 })).toBeUndefined();
  });

  it('remainingLogs follows the world', () => {
    const w = flatGen();
    const logs = plant(w, 0, 0, 4);
    const t = detectTree(at(w), logs[0]!)!;
    w.put(0, -60, 0, 'air');
    w.put(0, -59, 0, 'air');
    expect(remainingLogs(at(w), t)).toEqual(logs.slice(2));
  });
});

describe('treesFrom', () => {
  it('reports every tree once, closest base first', () => {
    const w = flatGen();
    const far = plant(w, 20, 0, 5);
    const near = plant(w, 5, 0, 4);
    const mid = plant(w, 10, 6, 6);
    const candidates = [...far, ...near, ...mid];
    const trees = treesFrom(at(w), candidates, { x: 0.5, y: -60, z: 0.5 });
    expect(trees.map((t) => t.base.x)).toEqual([5, 10, 20]);
    expect(trees.map((t) => t.logs.length)).toEqual([4, 6, 5]);
  });
});
