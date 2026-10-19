// find() with the per-section class index (PLAN.md task 2.6), including the perf budget:
// scanning a synthetic 100k-block world must take under 5 ms.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import { classify, World } from '../../../src/world/index.ts';
import { encodeSubChunk, fillSection, readyRegistry, recordedLogin, ReplaySource } from './helpers.ts';

const AIR = -604749536;
const STONE = -2144268767;

/**
 * A 5 x 5 column world around the origin: a stone floor section (y -64..-49), and in the next
 * section a forest of oak logs and leaves plus a few chests. 25 columns x 4096 blocks = 102 400
 * non-air-section blocks in the scanned range.
 */
function forestWorld(withFloor = true) {
  const reg = readyRegistry();
  const log = reg.runtimeIdOf(reg.stateIdOf('oak_log', { pillar_axis: 'y' })!);
  const leaves = reg.runtimeIdOf(reg.stateIdOf('oak_leaves')!);
  const chest = reg.runtimeIdOf(reg.stateIdOf('chest')!);
  const src = new ReplaySource();
  const world = new World(src, { logger: silentLogger, defer: (fn) => fn() });
  const { startGame, itemRegistry } = recordedLogin();
  src.emit('start_game', startGame);
  src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
  const floor = encodeSubChunk([fillSection(() => STONE)], { y: -4 });
  // Trees every 4 blocks (trunk y 0..5 of the section, leaves y 6..8), a chest at local (8, 0, 8).
  const forest = encodeSubChunk(
    [
      fillSection((x, y, z) => {
        if (x === 8 && z === 8 && y === 0) return chest;
        const trunk = x % 4 === 1 && z % 4 === 1;
        if (trunk && y <= 5) return log;
        if (y >= 6 && y <= 8 && (x % 4 !== 3 || z % 4 !== 3)) return leaves;
        return AIR;
      }),
    ],
    { y: -3 },
  );
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) {
      src.emit('level_chunk', { x: cx, z: cz, dimension: 0, sub_chunk_count: 0, highest_subchunk_count: 2, cache_enabled: false, blobs: [], payload: Buffer.alloc(0) });
      src.emit('subchunk', {
        cache_enabled: false,
        dimension: 0,
        origin: { x: cx, y: -4, z: cz },
        entries: [
          withFloor ? { dx: 0, dy: 0, dz: 0, result: 'success', payload: floor } : { dx: 0, dy: 0, dz: 0, result: 'success_all_air' },
          { dx: 0, dy: 1, dz: 0, result: 'success', payload: forest },
        ],
      });
    }
  }
  return { src, world, log, chest };
}

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

  it('scans 100k blocks in under 5 ms (full scan) and indexed lookups are far faster', () => {
    const { world } = forestWorld(false);
    const origin = { x: 0.5, y: -48, z: 0.5 };
    // Radius 60 covers all 25 columns: the forest section of each, 25 x 4096 = 102 400 blocks
    // (the section below is all air and skipped).
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
