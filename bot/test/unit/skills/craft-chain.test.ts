// Track E1 (docs/early-game.md "Craft chains"): the chain planner on the early-game recipes recorded from BDS
// 1.26.60.6: what is crafted first (planks, sticks, the table) and which raw materials are missing.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chainText, planChain } from '../../../src/skills/craft/chain.ts';
import { RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-early-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
function index(): RecipeIndex {
  const idx = new RecipeIndex((id) => fixture.items[String(id)]);
  idx.handle(fixture);
  return idx;
}
const item = (name: string, count = 1): ItemStack => ({ name, count, networkId: name.length, metadata: 0 });
const inv = (...items: ItemStack[]): (ItemStack | null)[] => [...items, ...Array.from({ length: 36 - items.length }, () => null)];
const keep = { keep: keepOnDropItems };

describe('craft chains (Track E1)', () => {
  it('a wooden pickaxe from logs: planks, then a table and sticks, then the pickaxe', () => {
    const p = planChain(index(), [{ item: 'wooden_pickaxe', n: 1 }], inv(item('oak_log', 6)), keep);
    expect(p.missing).toEqual([]);
    expect(p.steps.at(-1)).toMatchObject({ item: 'wooden_pickaxe', n: 1, table: true });
    const names = p.steps.map((s) => s.item);
    expect(names.indexOf('oak_planks')).toBeLessThan(names.indexOf('crafting_table'));
    expect(names.indexOf('oak_planks')).toBeLessThan(names.indexOf('stick'));
    expect(names).toContain('crafting_table');
    // 4 planks for the table, 3 for the head, 2 for the sticks: 9 -> 12 planks from 3 logs
    expect(p.steps.find((s) => s.item === 'oak_planks')!.n).toBe(12);
    expect(chainText(p.steps)).toMatch(/oak_planks.*stick|stick.*oak_planks/);
  });

  it('a carried table is used as it is; birch logs make birch planks', () => {
    const p = planChain(index(), [{ item: 'wooden_pickaxe', n: 1 }], inv(item('birch_log', 2), item('crafting_table')), keep);
    expect(p.missing).toEqual([]);
    expect(p.steps.map((s) => s.item)).not.toContain('crafting_table');
    expect(p.steps[0]).toMatchObject({ item: 'birch_planks', n: 8 });
  });

  // Track E5: measured on a fresh snowy taiga: the server knows twelve planks kinds; with 6 spruce logs carried the
  // table's planks tried oak and five other kinds (the first six), never spruce, and the kit asked for logs again
  it('with every planks kind the server has, the carried logs pick their own planks (spruce logs: spruce planks)', () => {
    const woods = ['acacia', 'bamboo', 'cherry', 'crimson', 'dark_oak', 'jungle', 'mangrove', 'pale_oak', 'warped'];
    const spruce = fixture.shaped_recipes!.find((r) => r.recipe_id === 'minecraft:spruce_planks')!;
    const items: Record<string, string> = { ...fixture.items };
    const extra = woods.map((w, i) => {
      items[String(90_001 + i)] = `${w}_planks`;
      return { ...spruce, recipe_id: `minecraft:${w}_planks`, input: [{ ...spruce.input[0]!, name: `minecraft:${w}_log` }], output: [{ ...spruce.output[0]!, network_id: 90_001 + i }], network_id: 95_001 + i };
    });
    const idx = new RecipeIndex((id) => items[String(id)]);
    idx.handle({ ...fixture, shaped_recipes: [...extra, ...fixture.shaped_recipes!] });
    const p = planChain(idx, [{ item: 'crafting_table', n: 1 }], inv(item('spruce_log', 6)), keep);
    expect(p.missing).toEqual([]);
    expect(p.steps[0]).toMatchObject({ item: 'spruce_planks' });
    // nothing carried that makes planks: oak stays the default
    expect(planChain(idx, [{ item: 'crafting_table', n: 1 }], inv(), keep).missing).toEqual([{ item: 'oak_log', n: 1 }]);
  });

  it('no logs: the missing raw material is named, nothing else', () => {
    const p = planChain(index(), [{ item: 'crafting_table', n: 1 }], inv(), keep);
    expect(p.missing).toEqual([{ item: 'oak_log', n: 1 }]);
  });

  it('a stone pickaxe with planks only: cobblestone missing (the tag stands for cobblestone)', () => {
    const p = planChain(index(), [{ item: 'stone_pickaxe', n: 1 }], inv(item('oak_planks', 8)), keep);
    expect(p.missing).toEqual([{ item: 'cobblestone', n: 3 }]);
  });

  it('the early kit at once: sticks and planks summed, one table, the cobblestone counted for all three', () => {
    const targets = [
      { item: 'stone_pickaxe', n: 1 },
      { item: 'stone_sword', n: 1 },
      { item: 'stone_axe', n: 1 },
    ];
    const p = planChain(index(), targets, inv(item('oak_log', 3), item('cobblestone', 8), item('crafting_table')), keep);
    expect(p.missing).toEqual([]);
    expect(p.steps.filter((s) => s.item === 'stick')).toHaveLength(1);
    expect(p.steps.find((s) => s.item === 'stick')!.n).toBeGreaterThanOrEqual(5);
    expect(p.steps.slice(-3).map((s) => s.item)).toEqual(['stone_pickaxe', 'stone_sword', 'stone_axe']);
    const short = planChain(index(), targets, inv(item('oak_log', 3), item('cobblestone', 5)), keep);
    expect(short.missing).toEqual([{ item: 'cobblestone', n: 3 }]);
  });

  it('a bed (a 3 x 2 recipe: a table first): three wool of one colour and planks; white is preferred when nothing is carried', () => {
    const none = planChain(index(), [{ item: 'bed', n: 1 }], inv(item('oak_log', 2)), keep);
    expect(none.missing).toEqual([{ item: 'white_wool', n: 3 }]);
    const red = planChain(index(), [{ item: 'bed', n: 1 }], inv(item('oak_log', 2), item('red_wool', 3)), keep);
    expect(red.missing).toEqual([]);
    const mixed = planChain(index(), [{ item: 'bed', n: 1 }], inv(item('oak_log', 2), item('white_wool', 2), item('black_wool', 1)), keep);
    expect(mixed.missing).toEqual([{ item: 'white_wool', n: 1 }]);
  });

  it('carried targets count; kept tools are never ingredients', () => {
    const have = planChain(index(), [{ item: 'wooden_pickaxe', n: 1 }], inv(item('wooden_pickaxe')), keep);
    expect(have).toMatchObject({ steps: [], missing: [] });
    // sticks carried are used, the pickaxe in hand is not an ingredient of anything
    const p = planChain(index(), [{ item: 'stone_sword', n: 1 }], inv(item('stick', 1), item('cobblestone', 2), item('wooden_pickaxe'), item('crafting_table')), keep);
    expect(p.missing).toEqual([]);
    expect(p.steps.map((s) => s.item)).toEqual(['stone_sword']);
  });
});
