// find() with the per-section class index (PLAN.md task 2.6). The perf budget (scanning a synthetic 100k-block world
// under 5 ms) is in the perf project: test/perf/find.perf.test.ts (Track REL3).
import { describe, expect, it } from 'vitest';
import { classify } from '../../../src/world/index.ts';
import { AIR, forestWorld } from './forest-world.ts';

describe('World.find', () => {
  it('classifies logs, leaves and chests', () => {
    expect(classify('oak_log')).toBe('log');
    expect(classify('pale_oak_log')).toBe('log');
    expect(classify('stripped_oak_log')).toBeUndefined();
    expect(classify('azalea_leaves')).toBe('leaves');
    expect(classify('trapped_chest')).toBe('chest');
    expect(classify('ender_chest')).toBeUndefined();
    expect(classify('stone')).toBeUndefined();
  });

  it('finds the closest logs through the class index and agrees with a full scan', () => {
    const { world } = forestWorld();
    expect(world.chunks.loadedCount).toBe(25);
    const origin = { x: 0.5, y: -47, z: 0.5 };
    const isLog = (b: { name: string }) => b.name === 'oak_log';
    const viaIndex = world.find(isLog, { origin, radius: 10, max: 5, class: 'log' });
    const viaScan = world.find(isLog, { origin, radius: 10, max: 5 });
    expect(viaIndex).toEqual(viaScan);
    expect(viaIndex[0]).toEqual({ x: 1, y: -48, z: 1 });
    for (const p of viaIndex) expect(world.blockAt(p)?.name).toBe('oak_log');
    // Distances are non-decreasing.
    const d = viaIndex.map((p) => Math.hypot(p.x + 0.5 - origin.x, p.y + 0.5 - origin.y, p.z + 0.5 - origin.z));
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect(world.finder.count('chest')).toBe(25);
    expect(world.finder.count('log')).toBe(25 * 16 * 6);
  });

  it('keeps the index current through block updates and unloads', () => {
    const { src, world, log, chest } = forestWorld();
    const chests = () => world.find(() => true, { origin: { x: 8, y: -48, z: 8 }, radius: 3, max: 10, class: 'chest' });
    expect(chests()).toEqual([{ x: 8, y: -48, z: 8 }]);
    src.emit('update_block', { position: { x: 8, y: -48, z: 8 }, block_runtime_id: AIR, flags: {}, layer: 0 });
    expect(chests()).toEqual([]);
    src.emit('update_block', { position: { x: 9, y: -47, z: 9 }, block_runtime_id: chest, flags: {}, layer: 0 });
    expect(chests()).toEqual([{ x: 9, y: -47, z: 9 }]);
    src.emit('update_block', { position: { x: 0, y: -30, z: 0 }, block_runtime_id: log, flags: {}, layer: 0 });
    expect(world.find(() => true, { origin: { x: 0, y: -30, z: 0 }, radius: 1, max: 1, class: 'log' })).toEqual([{ x: 0, y: -30, z: 0 }]);
    world.chunks.setCenter({ x: 10_000, y: 0, z: 0 });
    expect(world.finder.count('log')).toBe(0);
    expect(world.find(() => true, { origin: { x: 0, y: -48, z: 0 }, radius: 20, max: 10 })).toEqual([]);
  });

  it('respects radius, max and the predicate position', () => {
    const { world } = forestWorld();
    const origin = { x: 0.5, y: -60, z: 0.5 };
    const found = world.find((b, p) => b.name === 'stone' && p.y === -64, { origin, radius: 4, max: 1000 });
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) {
      expect(p.y).toBe(-64);
      expect(Math.hypot(p.x + 0.5 - origin.x, p.y + 0.5 - origin.y, p.z + 0.5 - origin.z)).toBeLessThanOrEqual(4);
    }
    expect(world.find(() => true, { origin, radius: 4, max: 3 })).toHaveLength(3);
    expect(world.find(() => true, { origin, radius: 4, max: 0 })).toEqual([]);
  });

  // Track REL3: the times (a full scan under 5 ms, the index too) are in the perf project (test/perf/find.perf.test.ts);
  // here the work: the class index visits only the sections that hold logs, and both find the same 10
  it('a full scan over 100k blocks and the class index find the same logs; the index tests far fewer blocks', () => {
    const { world } = forestWorld(false);
    const origin = { x: 0.5, y: -48, z: 0.5 };
    // Radius 60 covers all 25 columns: the forest section of each, 25 x 4096 = 102 400 blocks
    // (the section below is all air and skipped).
    let scanned = 0;
    const scan = world.find((b) => (scanned++, b.name === 'oak_log'), { origin, radius: 60, max: 10 });
    let indexed = 0;
    const viaIndex = world.find((b) => (indexed++, b.name === 'oak_log'), { origin, radius: 60, max: 10, class: 'log' });
    expect(scan).toHaveLength(10);
    expect(viaIndex).toEqual(scan);
    expect(scanned).toBeGreaterThan(0);
    expect(indexed).toBeLessThanOrEqual(25 * 16 * 6); // only the logs the index lists
    expect(indexed * 4).toBeLessThan(scanned); // far less work (measured 2 382 against 20 239 predicate calls)
  });
});
