// Track E5 (docs/early-game.md "Other ground"): the obtain job's `!gather` asks for the logs carried plus the ones it
// needs (`!gather N` with no chest ends once N logs are carried).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import { gatherCommand, nextAction } from '../../../src/skills/items/obtain.ts';
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

describe('the obtain job gathers on top of the logs carried (Track E5)', () => {
  it('gatherCommand adds every log kind carried in the 36 slots; nothing carried: n', () => {
    expect(gatherCommand(inv(), 4)).toBe('gather 4');
    expect(gatherCommand(inv(item('oak_log', 2)), 1)).toBe('gather 3');
    expect(gatherCommand(inv(item('spruce_log', 6), item('birch_log', 1), item('oak_planks', 9)), 2)).toBe('gather 9');
  });

  it('measured case: 2 oak logs carried and more needed: the step asks for carried + needed, its n is what it gets', () => {
    // 2 chests (16 planks = 4 logs) from 2 logs: 2 more logs
    const a = nextAction(index(), [{ item: 'chest', n: 2 }], inv(item('oak_log', 2), item('crafting_table')), { keep: keepOnDropItems });
    expect(a).toMatchObject({ kind: 'gather', n: 2, command: 'gather 4' });
  });
});
