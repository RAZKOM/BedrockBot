// Mending (docs/survival.md "Mending"): a tool, weapon, armour piece or elytra with Mending is set aside at `mendAt`
// percent of its durability instead of being worn down to breaking: the tool rule, the weapon choice in a fight for
// the bot's life, the miner (no_pickaxe with the reason, not one ore after another), the elytra.
import { describe, expect, it } from 'vitest';
import { bestWeaponSlot } from '../../../src/skills/combat/combat.ts';
import { elytraWornLimit, kitReady, readKit } from '../../../src/skills/fly/kit.ts';
import { hasPickaxe } from '../../../src/skills/mine/miner.ts';
import { DEFAULT_MEND_AT, ENCH_MENDING, hasMending, makeToolOk, maxDurability, mendReserve, setAsideForMending } from '../../../src/skills/survival/tools.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const MENDING = [{ id: ENCH_MENDING, lvl: 1 }];
const item = (name: string, left: number, mending: boolean): ItemStack => ({ name, count: 1, networkId: 1, metadata: 0, damage: (maxDurability(name) ?? 0) - left, ...(mending ? { enchants: MENDING } : {}) });

describe('Mending: set aside, not worn down to breaking', () => {
  it('the reserve is mendAt percent of the maximum; only items with Mending', () => {
    expect(hasMending(item('diamond_pickaxe', 100, true))).toBe(true);
    expect(hasMending(item('diamond_pickaxe', 100, false))).toBe(false);
    expect(mendReserve('diamond_pickaxe', 10)).toBe(Math.ceil(1561 * 0.1));
    expect(mendReserve('elytra', DEFAULT_MEND_AT)).toBe(44);
    expect(mendReserve('dirt', 10)).toBe(0);
    expect(setAsideForMending(item('diamond_pickaxe', 150, true), 10, 10)).toEqual({ left: 150, reserve: 157 });
    expect(setAsideForMending(item('diamond_pickaxe', 150, false), 10, 10)).toBeUndefined();
    expect(setAsideForMending(item('diamond_pickaxe', 900, true), 10, 10)).toBeUndefined();
  });

  it('the tool rule: a Mending pickaxe at 150 of 1561 is not used; the same pickaxe without Mending is (down to toolWearLimit); mendAt 0 turns it off', () => {
    const ok = makeToolOk(() => 10, () => 10);
    expect(ok(item('diamond_pickaxe', 150, true))).toBe(false);
    expect(ok(item('diamond_pickaxe', 158, true))).toBe(true);
    expect(ok(item('diamond_pickaxe', 150, false))).toBe(true);
    expect(ok(item('diamond_pickaxe', 10, false))).toBe(false);
    expect(makeToolOk(() => 10, () => 0)(item('diamond_pickaxe', 150, true))).toBe(true);
    expect(makeToolOk(() => 10)(item('diamond_pickaxe', 150, true))).toBe(true); // no mendAt: the old rule
  });

  it('a fight for its life: a worn blade without Mending before the Mending one set aside; that one only when nothing else', () => {
    const ok = makeToolOk(() => 10, () => 10);
    const slots: (ItemStack | null)[] = [item('diamond_sword', 50, true), item('iron_sword', 5, false), ...Array.from({ length: 7 }, () => null)];
    expect(bestWeaponSlot(slots, 0, ok)).toBe(1);
    expect(bestWeaponSlot([item('diamond_sword', 50, true), null, null, null, null, null, null, null, null], 0, ok)).toBe(0);
  });

  it('the miner: a pickaxe set aside does not count (the job ends no_pickaxe with the reason instead of failing ore after ore)', () => {
    const ok = makeToolOk(() => 10, () => 10);
    expect(hasPickaxe([item('diamond_pickaxe', 150, true)], ok)).toBe(false);
    expect(hasPickaxe([item('diamond_pickaxe', 150, true), item('stone_pickaxe', 100, false)], ok)).toBe(true);
    expect(hasPickaxe([item('diamond_pickaxe', 150, true)])).toBe(true); // without the rule: the old count
  });

  it('a Mending elytra is set aside at 44 uses (no takeoff, the line says to mend it); without Mending at toolWearLimit + 20', () => {
    const kitOf = (left: number, mending: boolean) => readKit({ slots: [item('elytra', left, mending), { name: 'firework_rocket', count: 32, networkId: 2, metadata: 0 }] });
    const m = kitOf(40, true);
    expect(m.elytraMending).toBe(true);
    expect(elytraWornLimit(10, m)).toBe(44);
    expect(kitReady(m, 10)).toMatchObject({ ok: false, reason: 'elytra_worn' });
    expect((kitReady(m, 10) as { line: string }).line).toMatch(/set aside to be mended: 40 uses left/);
    expect(kitReady(kitOf(40, false), 10)).toMatchObject({ ok: true });
    expect(elytraWornLimit(10, kitOf(40, false))).toBe(30);
  });
});
