import { describe, expect, it } from 'vitest';
import { blockClass, buildGrid, buildObservation, inventoryCounts, logCount, nearestLog, normYaw } from '../../../src/bridge/observation.ts';
import { GRID_CLASSES, GRID_SIZE } from '../../../src/bridge/schema.ts';
import { FakeWorld, block } from './fakes.ts';

const C = Object.fromEntries(GRID_CLASSES.map((c, i) => [c, i])) as Record<(typeof GRID_CLASSES)[number], number>;
const idx = (dx: number, dy: number, dz: number) => ((dx + 4) * 9 + (dz + 4)) * 5 + (dy + 1);

describe('observation builder on a fake world', () => {
  it('classifies blocks', () => {
    expect(blockClass(undefined)).toBe('unknown');
    expect(blockClass(block('unknown'))).toBe('unknown');
    expect(blockClass(block('air'))).toBe('air');
    expect(blockClass(block('oak_log'))).toBe('log');
    expect(blockClass(block('stripped_oak_log'))).toBe('solid');
    expect(blockClass(block('birch_leaves'))).toBe('leaves');
    expect(blockClass(block('water', false))).toBe('water');
    expect(blockClass(block('flowing_lava', false))).toBe('lava');
    expect(blockClass(block('stone'))).toBe('solid');
    expect(blockClass(block('short_grass', false))).toBe('other');
  });

  it('grid: 405 cells, x-major, y from feet - 1, item drops marked', () => {
    const w = new FakeWorld();
    w.set(2, -60, -1, 'oak_log'); // dx 2, dy 0, dz -1 from feet (0, -60, 0)
    w.set(-4, -57, 4, 'oak_leaves'); // dy 3 corner
    w.addItem(1n, { x: 1.3, y: -60, z: 0.7 });
    const g = buildGrid(w, { x: 0.5, y: -60, z: 0.5 });
    expect(g).toHaveLength(GRID_SIZE);
    expect(g[idx(0, -1, 0)]).toBe(C.solid); // grass under the feet
    expect(g[idx(0, 0, 0)]).toBe(C.air);
    expect(g[idx(2, 0, -1)]).toBe(C.log);
    expect(g[idx(-4, 3, 4)]).toBe(C.leaves);
    expect(g[idx(1, 0, 0)]).toBe(C.item_drop);
    // unloaded columns (|x| > 64) are unknown
    const far = buildGrid(w, { x: 63.5, y: -60, z: 0.5 });
    expect(far[idx(4, 0, 0)]).toBe(C.unknown);
    expect(far[idx(1, 0, 0)]).toBe(C.air);
  });

  it('nearest log: relative to the feet, reach from the eye', () => {
    const w = new FakeWorld();
    expect(nearestLog(w, { x: 0.5, y: -60, z: 0.5 })).toBeUndefined();
    w.set(3, -60, 0, 'oak_log');
    w.set(10, -60, 0, 'birch_log');
    const n = nearestLog(w, { x: 0.5, y: -60, z: 0.5 })!;
    expect(n.p).toEqual({ x: 3, y: -60, z: 0 });
    expect(n.dx).toBeCloseTo(3);
    expect(n.dy).toBeCloseTo(0.5);
    expect(n.inReach).toBe(true);
    expect(nearestLog(w, { x: 0.5, y: -60, z: 0.5 }, 'birch_log')!.p.x).toBe(10);
    expect(nearestLog(w, { x: -6.5, y: -60, z: 0.5 })!.inReach).toBe(false);
  });

  it('inventory counts and natural logs only', () => {
    const w = new FakeWorld();
    w.give(0, 'stone_axe', 1);
    w.give(1, 'oak_log', 5);
    w.give(5, 'oak_log', 3);
    w.give(6, 'stripped_oak_log', 2);
    w.give(7, 'birch_log', 1);
    expect(inventoryCounts(w.inventory.slots)).toEqual({ stone_axe: 1, oak_log: 8, stripped_oak_log: 2, birch_log: 1 });
    expect(logCount(w.inventory.slots)).toBe(9);
  });

  it('full observation', () => {
    const w = new FakeWorld();
    w.set(0, -60, 3, 'oak_log');
    w.give(0, 'stone_axe', 1);
    const { obs } = buildObservation(w, { pos: { x: 0.5, y: -60.00001, z: 0.5 }, yaw: 270, pitch: 10, onGround: true }, { ok: false, reason: 'no_block', action: 'dig_facing_block', ticks: 1 });
    expect(obs.self).toEqual({ pos: [0.5, -60, 0.5], yaw: -90, pitch: 10, health: 20, food: 20, on_ground: true });
    expect(obs.inventory).toEqual({ stone_axe: 1 });
    expect(obs.nearest_log).toMatchObject({ dx: 0, dy: 0.5, dz: 3, in_reach: true });
    expect(obs.last_skill).toEqual({ ok: false, reason: 'no_block', action: 'dig_facing_block', ticks: 1 });
  });

  it('normYaw', () => {
    expect(normYaw(0)).toBe(0);
    expect(normYaw(180)).toBe(-180);
    expect(normYaw(-180)).toBe(-180);
    expect(normYaw(315)).toBe(-45);
    expect(normYaw(-405)).toBe(-45);
  });
});
