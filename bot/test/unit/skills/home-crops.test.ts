// Track BJ (decision 0052, docs/home.md "Decision table"): harvested crops are no longer kept whole as food.
// The food reserve (`foodReserve`) is filled by the other food first, then the crops by food value; their
// surplus is unloaded; `seedReserve` of each item `!farm` replants stays; cooked food is never unloaded.
import { describe, expect, it } from 'vitest';
import { CROP_FOODS, cropReserve, keptItem, planUnload, unloadableStacks, type PlanChest, type UnloadSlot } from '../../../src/skills/home/unloader.ts';

const chest: PlanChest = { key: 'c', pos: { x: 3, y: 0, z: 0 }, kind: 'chest', free: 27, contents: {}, room: {}, boxes: { empty: 0, full: 0 } };
const slots = (list: [string, number][]): UnloadSlot[] => list.map(([name, count], slot) => ({ slot, name, count }));
const moved = (p: ReturnType<typeof planUnload>): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const x of p.moves) m[x.name] = (m[x.name] ?? 0) + x.count;
  return m;
};

describe('unload: crops and the food reserve', () => {
  it('crops that are food are no longer kept whole; cooked food still is', () => {
    expect([...CROP_FOODS]).toEqual(['carrot', 'potato', 'beetroot', 'melon_slice', 'sweet_berries', 'glow_berries']);
    expect(keptItem('carrot')).toBe(false);
    expect(keptItem('minecraft:melon_slice')).toBe(false);
    expect(keptItem('bread')).toBe(true);
    expect(keptItem('cooked_beef')).toBe(true);
  });

  it('the reserve: other food first, then the best crop; the seeds the farm replants', () => {
    const s = slots([['cooked_beef', 20], ['carrot', 64], ['carrot', 64], ['potato', 10], ['wheat_seeds', 64], ['wheat_seeds', 64], ['beetroot', 30]]);
    const r = cropReserve(s, 64, 32);
    expect(Object.fromEntries(r)).toEqual({ carrot: 44, potato: 10, wheat_seeds: 32 }); // 64 - 20 beef = 44 carrots; potato and seeds as seeds
    expect(Object.fromEntries(cropReserve(s, 0, 0))).toEqual({});
    expect(Object.fromEntries(cropReserve(slots([['bread', 64], ['carrot', 64]]), 64, 0))).toEqual({}); // the bread fills it
  });

  it('a farm haul unloads: the crop surplus and the seed surplus go, the reserve and the cooked food stay', () => {
    const s = slots([['cooked_beef', 20], ['carrot', 64], ['carrot', 64], ['carrot', 64], ['wheat', 64], ['wheat_seeds', 64], ['beetroot', 40], ['beetroot_seeds', 20]]);
    const p = planUnload(s, [chest], { foodReserve: 64, seedReserve: 32 });
    expect(moved(p)).toEqual({ carrot: 148, wheat: 64, wheat_seeds: 32, beetroot: 40 });
    const kept = Object.fromEntries(p.kept.map((k) => [`${k.name} ${k.why}`, k.count]));
    expect(kept).toMatchObject({ 'cooked_beef kept': 20, 'carrot food_reserve': 44, 'wheat_seeds food_reserve': 32, 'beetroot_seeds food_reserve': 20 });
    // the autoUnload trigger sees the crop stacks now
    expect(unloadableStacks(s, { foodReserve: 64, seedReserve: 32 }).stacks).toBeGreaterThanOrEqual(5);
  });

  it('settings at 0: every crop and seed is unloaded; cooked food never', () => {
    const p = planUnload(slots([['bread', 10], ['potato', 64], ['melon_slice', 12]]), [chest], { foodReserve: 0, seedReserve: 0 });
    expect(moved(p)).toEqual({ potato: 64, melon_slice: 12 });
    expect(p.kept).toEqual([{ name: 'bread', count: 10, why: 'kept' }]);
  });
});
