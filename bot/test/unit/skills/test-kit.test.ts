// Track T1 (ADR 0075): the test kit (skills/test/kit.ts) and the testKit setting.
import { describe, expect, it } from 'vitest';
import { parseSettingValue, SettingError } from '../../../src/config/settings.ts';
import { formatKit, KitError, kitView, parseKitText, planKit, snapshotKit, type KitView } from '../../../src/skills/test/kit.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const it_ = (name: string, count = 1, damage?: number): ItemStack => ({ name, networkId: 1, count, metadata: 0, ...(damage !== undefined ? { damage } : {}) });
const view = (slots: (ItemStack | null)[], worn: Partial<KitView['worn']> = {}): KitView => {
  const s = [...slots];
  while (s.length < 36) s.push(null);
  return { slots: s, worn: { head: null, chest: null, legs: null, feet: null, offhand: null, ...worn } };
};

describe('kit text', () => {
  it('parses items, counts and worn slots', () => {
    expect(parseKitText('elytra, firework_rocket 64, diamond_chestplate @chest, minecraft:cooked_beef 32; shield @offhand')).toEqual([
      { item: 'elytra', count: 1 },
      { item: 'firework_rocket', count: 64 },
      { item: 'diamond_chestplate', count: 1, slot: 'chest' },
      { item: 'cooked_beef', count: 32 },
      { item: 'shield', count: 1, slot: 'offhand' },
    ]);
    expect(formatKit(parseKitText('Elytra,firework_rocket 64 , iron_boots @feet'))).toBe('elytra, firework_rocket 64, iron_boots @feet');
  });
  it('refuses what could break a command', () => {
    expect(() => parseKitText('elytra; give @a diamond 64')).toThrow(KitError);
    expect(() => parseKitText('stone 0')).toThrow(KitError);
    expect(() => parseKitText('stone @back')).toThrow(/unknown slot/);
    expect(() => parseKitText('"stone"')).toThrow(KitError);
  });
  it('testKit: start, file or a list (normalised); bad lists are a SettingError', () => {
    expect(parseSettingValue('testKit', 'START')).toBe('start');
    expect(parseSettingValue('testKit', 'file')).toBe('file');
    expect(parseSettingValue('testKit', 'Elytra, firework_rocket 64')).toBe('elytra, firework_rocket 64');
    expect(() => parseSettingValue('testKit', 'elytra x y')).toThrow(SettingError);
  });
});

describe('snapshotKit', () => {
  it('worn pieces with their slot, inventory summed by name, shulker boxes left out', () => {
    const v = view([it_('firework_rocket', 40), it_('cooked_beef', 10), it_('purple_shulker_box'), it_('firework_rocket', 24), it_('elytra', 1, 12)], { chest: it_('diamond_chestplate'), offhand: it_('shield') });
    expect(snapshotKit(v)).toEqual([
      { item: 'diamond_chestplate', count: 1, slot: 'chest' },
      { item: 'shield', count: 1, slot: 'offhand' },
      { item: 'firework_rocket', count: 64 },
      { item: 'cooked_beef', count: 10 },
      { item: 'elytra', count: 1 },
    ]);
  });
  it('kitView reads the armour window 120 and the offhand window 119', () => {
    const inv = { slots: [it_('stone', 3)], window: (id: number) => (id === 120 ? { slots: [it_('iron_helmet'), null, null, it_('iron_boots')] } : id === 119 ? { slots: [it_('totem_of_undying')] } : undefined) };
    const v = kitView(inv);
    expect(v.worn).toMatchObject({ head: { name: 'iron_helmet' }, chest: null, feet: { name: 'iron_boots' }, offhand: { name: 'totem_of_undying' } });
    expect(v.slots).toHaveLength(1);
  });
});

describe('planKit', () => {
  const kit = parseKitText('diamond_chestplate @chest, elytra, firework_rocket 64, cooked_beef 16');

  it('nothing to do when everything is carried', () => {
    const v = view([it_('elytra', 1, 0), it_('firework_rocket', 64), it_('cooked_beef', 20)], { chest: it_('diamond_chestplate') });
    expect(planKit(kit, v, { elytraMin: 100 }).commands).toEqual([]);
  });

  it('after a death without keepInventory: the chestplate worn by /replaceitem, the rest given', () => {
    expect(planKit(kit, view([]), { elytraMin: 100 }).commands).toEqual([
      '/replaceitem entity @s slot.armor.chest 0 diamond_chestplate',
      '/give @s elytra 1',
      '/give @s firework_rocket 64',
      '/give @s cooked_beef 16',
    ]);
  });

  it('tops up counts; the elytra on the back stands in for the loose one, the chestplate carried for the worn one', () => {
    const v = view([it_('diamond_chestplate'), it_('firework_rocket', 20)], { chest: it_('elytra', 1, 0) });
    expect(planKit(kit, v).commands).toEqual(['/give @s firework_rocket 44', '/give @s cooked_beef 16']);
  });

  it('never overwrites a worn piece: a missing chestplate with the elytra on is given', () => {
    const v = view([it_('firework_rocket', 64), it_('cooked_beef', 16)], { chest: it_('elytra', 1, 0) });
    const p = planKit(kit, v);
    expect(p.commands).toEqual(['/give @s diamond_chestplate 1']);
    expect(p.notes[0]).toContain('holds elytra');
  });

  it('a worn-out elytra is replaced in its slot (back, hotbar or inventory)', () => {
    expect(planKit([], view([], { chest: it_('elytra', 1, 400) }), { elytraMin: 100 }).commands).toEqual(['/replaceitem entity @s slot.armor.chest 0 elytra']);
    expect(planKit([], view([null, null, it_('elytra', 1, 340)]), { elytraMin: 100 }).commands).toEqual(['/replaceitem entity @s slot.hotbar 2 elytra']);
    const slots: (ItemStack | null)[] = Array.from({ length: 12 }, () => null);
    slots[11] = it_('elytra', 1, 432);
    expect(planKit([], view(slots), { elytraMin: 100 }).commands).toEqual(['/replaceitem entity @s slot.inventory 2 elytra']);
    expect(planKit([], view([], { chest: it_('elytra', 1, 400) }), { elytraMin: 0 }).commands).toEqual([]); // 0 = never
    expect(planKit([], view([], { chest: it_('elytra', 1, 300) }), { elytraMin: 100 }).commands).toEqual([]); // 132 left
  });
});
