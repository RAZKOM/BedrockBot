import { describe, expect, it } from 'vitest';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';

describe('!drop items keeps the essentials', () => {
  it('keeps food, armour, elytra, tools, weapons, totems, shulker boxes', () => {
    for (const n of ['bread', 'cooked_beef', 'iron_helmet', 'minecraft:diamond_chestplate', 'elytra', 'iron_pickaxe', 'diamond_sword', 'bow', 'shield', 'totem_of_undying', 'shulker_box', 'red_shulker_box', 'ender_chest']) {
      expect(keepOnDropItems(n), n).toBe(true);
    }
  });
  it('drops the rest', () => {
    for (const n of ['cobblestone', 'dirt', 'rotten_flesh', 'string', 'oak_log', 'coal', 'iron_ore', 'gunpowder', 'torch']) {
      expect(keepOnDropItems(n), n).toBe(false);
    }
  });
});
