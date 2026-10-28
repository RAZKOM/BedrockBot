// Track AW (wave 11, docs/crafting.md): the recipe index on a crafting_data fixture recorded on
// bds-craft (BDS 1.26.60.6), the grid rules, tags, planning, the keep rules and the reserve; the
// compaction table and plans, and the unload hook (planUnload's `compact` step).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compactable, compactAll, compactForUnload, compactPlan, COMPACT, compactLine, fullAfter, installCompactPlanner } from '../../../src/skills/craft/compact.ts';
import { canCraft, gridSlots, matches, needsTable, parseItemName, planCraft, RecipeIndex, usablePool, usedText, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import { planUnload, setCompactPlanner, type PlanChest, type UnloadSlot } from '../../../src/skills/home/unloader.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const itemName = (id: number) => fixture.items[String(id)];
function index(): RecipeIndex {
  const idx = new RecipeIndex(itemName);
  idx.handle(fixture);
  return idx;
}
const item = (name: string, count = 1, slot?: number): ItemStack => ({ name, count, networkId: name.length, metadata: 0, ...(slot !== undefined ? {} : {}) });
const inv = (...items: ItemStack[]): (ItemStack | null)[] => [...items, ...Array.from({ length: 36 - items.length }, () => null)];

describe('recipe index (crafting_data from bds-craft)', () => {
  it('keeps the grid recipes with their network ids, shapes and ingredients', () => {
    const idx = index();
    expect(idx.size).toBeGreaterThan(10);
    const iron = idx.byOutput('iron_block');
    expect(iron).toHaveLength(1);
    expect(iron[0]).toMatchObject({ id: 'minecraft:iron_block', networkId: 4250, shaped: true, width: 3, height: 3, block: 'crafting_table' });
    expect(iron[0]!.input).toHaveLength(9);
    expect(iron[0]!.input.every((i) => i?.name === 'iron_ingot' && i.metadata === 32767)).toBe(true);
    expect(iron[0]!.output[0]).toMatchObject({ name: 'iron_block', count: 1, networkId: 42 });
    expect(idx.byOutput('minecraft:raw_iron_block')[0]).toMatchObject({ networkId: 4403, width: 3, height: 3 });
    // planks: 4 recipes (log, stripped log, stripped wood, wood), 1 x 1, 4 planks each
    const planks = idx.byOutput('oak_planks');
    expect(planks.map((r) => r.input[0]?.name).sort()).toEqual(['oak_log', 'oak_wood', 'stripped_oak_log', 'stripped_oak_wood']);
    expect(planks.every((r) => r.width === 1 && r.height === 1 && r.output[0]!.count === 4)).toBe(true);
    // sticks: the tag recipe (1 x 2, minecraft:planks) and the per-wood ones; coal:0 style names are split
    const stick = idx.byOutput('stick').find((r) => r.id === 'minecraft:stick')!;
    expect(stick).toMatchObject({ networkId: 4453, width: 1, height: 2, priority: -1 });
    expect(stick.input[0]).toEqual({ tag: 'minecraft:planks', metadata: 32767, count: 1 });
    expect(idx.byOutput('coal_block')[0]!.input[0]).toEqual({ name: 'coal', metadata: 0, count: 1 });
    expect(parseItemName('minecraft:bamboo:0')).toEqual({ name: 'bamboo', metadata: 0 });
    expect(parseItemName('minecraft:iron_ingot')).toEqual({ name: 'iron_ingot' });
  });

  it('a packet with clear_recipes replaces the index; furnace recipes are never kept', () => {
    const idx = index();
    idx.handle({ clear_recipes: true, shaped_recipes: [], shapeless_recipes: [] });
    expect(idx.size).toBe(0);
    idx.handle({ clear_recipes: false, shaped_recipes: [], shapeless_recipes: [{ recipe_id: 'furnace_x', input: [{ type: 'valid', descriptor_type: 'name', name: 'minecraft:raw_iron', metadata: 32767, count: 1 }], output: [{ network_id: 42, count: 1, metadata: 0, block_runtime_id: 0 }], block: 'furnace', priority: 0, network_id: 9 }] });
    expect(idx.size).toBe(0);
  });

  it('grid rules: 2 x 2 fits the inventory, 3 x 3 and 5+ shapeless inputs need a table; slots are row-major from 28 / 32', () => {
    const idx = index();
    const iron = idx.byOutput('iron_block')[0]!;
    const planks = idx.byOutput('oak_planks')[0]!;
    const stick = idx.byOutput('stick').find((r) => r.id === 'minecraft:stick')!;
    const table = idx.byOutput('crafting_table').find((r) => r.id === 'minecraft:WorkBench_recipeId')!;
    expect(needsTable(iron)).toBe(true);
    expect(needsTable(planks)).toBe(false);
    expect(needsTable(stick)).toBe(false);
    expect(needsTable(table)).toBe(false);
    expect(gridSlots(planks, false)).toEqual([28]);
    expect(gridSlots(stick, false)).toEqual([28, 30]); // 1 wide, 2 high: top-left and below it
    expect(gridSlots(table, false)).toEqual([28, 29, 30, 31]);
    expect(gridSlots(iron, true)).toEqual([32, 33, 34, 35, 36, 37, 38, 39, 40]);
    expect(gridSlots(stick, true)).toEqual([32, 35]); // in a workbench the pattern sits top-left of the 3 x 3
    expect(needsTable({ ...planks, shaped: false, input: [{ name: 'a', metadata: 0, count: 5 }] })).toBe(true);
  });

  it('tags resolve against item names', () => {
    expect(matches({ tag: 'minecraft:planks', metadata: 0, count: 1 }, 'oak_planks')).toBe(true);
    expect(matches({ tag: 'minecraft:planks', metadata: 0, count: 1 }, 'minecraft:crimson_planks')).toBe(true);
    expect(matches({ tag: 'minecraft:planks', metadata: 0, count: 1 }, 'oak_log')).toBe(false);
    expect(matches({ tag: 'minecraft:coals', metadata: 0, count: 1 }, 'charcoal')).toBe(true);
    expect(matches({ tag: 'minecraft:nope', metadata: 0, count: 1 }, 'coal')).toBe(false);
    expect(matches({ name: 'iron_ingot', metadata: 32767, count: 1 }, 'minecraft:iron_ingot')).toBe(true);
  });
});

describe('planning', () => {
  it('36 iron ingots -> 4 iron blocks in a table; 100 wanted with 9 ingots -> 1 and the shortfall', () => {
    const idx = index();
    const p = planCraft(idx, 'iron_block', 4, inv(item('iron_ingot', 36)))!;
    expect(p).toMatchObject({ item: 'iron_block', outputPer: 1, wantedCrafts: 4, crafts: 4, table: true, batchMax: 64 });
    expect(p.cells).toHaveLength(9);
    expect(p.perCraft).toEqual({ iron_ingot: 9 });
    expect(p.shortfall).toBeUndefined();
    const q = planCraft(idx, 'iron_block', 100, inv(item('iron_ingot', 9)))!;
    expect(q.crafts).toBe(1);
    expect(q.shortfall).toEqual({ name: 'iron_ingot', have: 9, need: 900 });
    expect(usedText(q.perCraft, q.crafts)).toBe('9 iron_ingot');
    expect(canCraft(idx, 'iron_block', 1, inv(item('iron_ingot', 8)))).toMatchObject({ ok: false, reason: 'missing', table: true, shortfall: { name: 'iron_ingot', have: 8, need: 9 } });
    expect(canCraft(idx, 'elytra', 1, inv())).toEqual({ ok: false, table: false, reason: 'no_recipe' });
  });

  it('8 logs -> 32 planks (the log recipe wins over the stripped ones); 16 sticks from planks by the tag; the batch max follows the stack', () => {
    const idx = index();
    const p = planCraft(idx, 'oak_planks', 32, inv(item('oak_log', 8)))!;
    expect(p.recipe.id).toBe('minecraft:oak_planks');
    expect(p).toMatchObject({ outputPer: 4, wantedCrafts: 8, crafts: 8, table: false, batchMax: 16 });
    const s = planCraft(idx, 'stick', 16, inv(item('oak_planks', 32)))!;
    expect(s.recipe.id).toBe('minecraft:stick');
    expect(s.cells.map((c) => c.item)).toEqual(['oak_planks', 'oak_planks']);
    expect(s).toMatchObject({ outputPer: 4, wantedCrafts: 4, crafts: 4, perCraft: { oak_planks: 2 } });
    // a tag with nothing matching: the shortfall names the tag's default item
    expect(planCraft(idx, 'stick', 4, inv(item('oak_log', 8)))).toMatchObject({ crafts: 0, shortfall: { name: 'oak_planks', have: 0 } });
    // a 2 x 2 recipe is preferred over a table recipe of the same output when both are possible
    const t = planCraft(idx, 'crafting_table', 1, inv(item('oak_planks', 4)))!;
    expect(['minecraft:WorkBench_recipeId', 'minecraft:WorkBench_recipeId_from_oak']).toContain(t.recipe.id); // the tag recipe (priority 0) or the oak one: both 2 x 2
    expect(t.table).toBe(false);
  });

  it('the keep rules and the reserve shrink the pool: a diamond pickaxe is never an ingredient, reserved ingots stay', () => {
    const idx = index();
    const keep = (n: string) => n.endsWith('_pickaxe');
    expect(usablePool(inv(item('diamond_pickaxe', 1), item('iron_ingot', 20)), { keep, reserve: (n) => (n === 'iron_ingot' ? 9 : 0) })).toEqual(new Map([['iron_ingot', 11]]));
    expect(canCraft(idx, 'diamond_block', 1, inv(item('diamond_pickaxe', 1)), { keep })).toMatchObject({ ok: false, reason: 'missing', shortfall: { name: 'diamond', have: 0, need: 9 } });
    const p = planCraft(idx, 'iron_block', 2, inv(item('iron_ingot', 18)), { reserve: (n) => (n === 'iron_ingot' ? 9 : 0) })!;
    expect(p.crafts).toBe(1);
    expect(p.shortfall).toEqual({ name: 'iron_ingot', have: 9, need: 18 });
  });
});

describe('compaction', () => {
  it('the 9 -> 1 table: raw metals, ingots, gems, coal, redstone, lapis, netherite; never sand or cobblestone', () => {
    expect(compactable('raw_iron')).toBe('raw_iron_block');
    expect(compactable('minecraft:iron_ingot')).toBe('iron_block');
    expect(compactable('lapis_lazuli')).toBe('lapis_block');
    expect(compactable('netherite_ingot')).toBe('netherite_block');
    expect(compactable('sand')).toBeUndefined();
    expect(compactable('cobblestone')).toBeUndefined();
    expect(compactable('wheat')).toBeUndefined();
    expect(Object.keys(COMPACT)).toHaveLength(12);
  });

  it('compactPlan / compactAll: whole nines only, the reserve and the keep rules applied, one kind on request', () => {
    const slots = inv(item('raw_iron', 45), item('iron_ingot', 17), item('diamond', 8), item('coal', 64), item('coal', 10));
    expect(compactPlan('raw_iron', slots)).toEqual({ kind: 'raw_iron', block: 'raw_iron_block', blocks: 5, uses: 45 });
    expect(compactPlan('diamond', slots)).toBeUndefined();
    expect(compactAll(slots).map((s) => `${s.uses} ${s.kind} -> ${s.blocks} ${s.block}`)).toEqual(['45 raw_iron -> 5 raw_iron_block', '9 iron_ingot -> 1 iron_block', '72 coal -> 8 coal_block']);
    expect(compactAll(slots, {}, 'iron').map((s) => s.kind)).toEqual(['raw_iron', 'iron_ingot']);
    expect(compactAll(slots, {}, 'coal_block').map((s) => s.kind)).toEqual(['coal']);
    expect(compactAll(slots, { reserve: (n) => (n === 'coal' ? 10 : 0) }).find((s) => s.kind === 'coal')!.blocks).toBe(7);
    expect(compactLine([{ kind: 'raw_iron', block: 'raw_iron_block', blocks: 6, uses: 54 }])).toBe('compacted 54 raw_iron into 6 raw_iron_block');
  });

  it("the unload hook: the owner's case (a chest of raw iron with one free slot, 27 raw iron carried) compacts; a chest with room does not", () => {
    const u = (slot: number, name: string, count: number): UnloadSlot => ({ slot, name, count });
    const chest = (free: number, key = 'ores'): PlanChest => ({ key, pos: { x: 0, y: 0, z: 0 }, kind: 'chest', free, contents: { raw_iron: 26 * 64, raw_iron_block: 3 }, room: {}, boxes: { empty: 0, full: 0 } });
    const slots = [u(0, 'raw_iron', 27), u(1, 'cobblestone', 64)];
    setCompactPlanner(undefined);
    const plain = planUnload(slots, [chest(1)]);
    expect(plain.compact).toBeUndefined();
    expect(fullAfter(plain, [chest(1)])).toEqual(new Set(['ores']));
    expect(compactForUnload(slots, plain, [chest(1)])).toEqual([{ kind: 'raw_iron', count: 27 }]);
    // room left: nothing to compact; fewer than 9: nothing
    expect(compactForUnload(slots, planUnload(slots, [chest(5)]), [chest(5)])).toEqual([]);
    expect(compactForUnload([u(0, 'raw_iron', 8)], planUnload([u(0, 'raw_iron', 8)], [chest(1)]), [chest(1)])).toEqual([]);
    // overflow (no chest has room) compacts too
    expect(compactForUnload(slots, planUnload(slots, [chest(0)]), [chest(0)])).toEqual([{ kind: 'raw_iron', count: 27 }]);
    // installed: planUnload carries the step itself
    installCompactPlanner(() => ({}));
    expect(planUnload(slots, [chest(1)]).compact).toEqual([{ kind: 'raw_iron', count: 27 }]);
    expect(planUnload(slots, [chest(5)]).compact).toBeUndefined();
    setCompactPlanner(undefined);
  });
});
