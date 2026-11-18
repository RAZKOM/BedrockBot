// Track E3 (docs/pve.md "The blade strike", ADR 0100): a reflex strike made with the hotbar's blade while the hand holds
// a pillar's block, a digging tool between digs or nothing, the hand back in the same tick. On a fresh world a zombie came
// down a one-wide shaft onto a bot pillaring up: 14 strikes with the cobblestone (0.9 each on the server) and the bot died.
import { describe, expect, it } from 'vitest';
import { bladeStrikeSlot, CombatController, swapHandOk } from '../../../src/skills/combat/combat.ts';
import { MobTracker } from '../../../src/skills/combat/hostiles.ts';
import { Reflex } from '../../../src/skills/combat/reflex.ts';
import { foodInfo } from '../../../src/skills/survival/eat.ts';
import type { EntityInfo, ItemStack } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const F = -60;
const item = (name: string, extra: Partial<ItemStack> = {}): ItemStack => ({ name, networkId: 1, count: 1, metadata: 0, ...extra });
const block = (name: string, count = 32): ItemStack => item(name, { count, blockRuntimeId: 1234 });
const isFood = (n: string): boolean => foodInfo(n) !== undefined;

describe('swapHandOk: what the hand may leave for one strike', () => {
  it('an empty hand, a block, a digging tool between digs', () => {
    expect(swapHandOk(null, false)).toBe(true);
    expect(swapHandOk(block('cobblestone'), false)).toBe(true);
    expect(swapHandOk(block('dirt'), true)).toBe(true); // a block while a dig runs is not the dig's hand
    expect(swapHandOk(item('stone_pickaxe'), false)).toBe(true);
    expect(swapHandOk(item('iron_shovel'), false)).toBe(true);
    expect(swapHandOk(item('shears'), false)).toBe(true);
  });

  it('never a blade (nothing to gain), a digging tool while a dig runs, food, or an item used by holding it', () => {
    expect(swapHandOk(item('stone_sword'), false)).toBe(false);
    expect(swapHandOk(item('iron_axe'), false)).toBe(false);
    expect(swapHandOk(item('stone_pickaxe'), true)).toBe(false);
    expect(swapHandOk(item('bread'), false, isFood)).toBe(false);
    expect(swapHandOk(item('sweet_berries', { blockRuntimeId: 99 }), false, isFood)).toBe(false); // food that is also a block
    for (const n of ['bow', 'crossbow', 'shield', 'firework_rocket', 'water_bucket', 'milk_bucket', 'potion', 'ender_pearl', 'totem_of_undying', 'trident']) {
      expect(swapHandOk(item(n), false, isFood)).toBe(false);
    }
  });
});

describe('bladeStrikeSlot: the blade a strike is made with', () => {
  it('the best sword or axe in the hotbar, not the held slot', () => {
    const slots: (ItemStack | null)[] = [item('stone_pickaxe'), item('stone_sword'), block('cobblestone'), item('stone_axe'), item('bread', { count: 8 })];
    expect(bladeStrikeSlot(slots, 2, false)).toBe(1); // the pillar's cobblestone held: the sword
    expect(bladeStrikeSlot(slots, 0, false)).toBe(1); // the pickaxe between digs
    expect(bladeStrikeSlot(slots, 0, true)).toBeUndefined(); // the pickaxe while it digs
    expect(bladeStrikeSlot(slots, 1, false)).toBeUndefined(); // the sword held: nothing to do
    expect(bladeStrikeSlot(slots, 4, false, () => true, isFood)).toBeUndefined(); // eating
  });

  it('no blade in the hotbar (a pickaxe is no blade): none', () => {
    expect(bladeStrikeSlot([item('stone_pickaxe'), block('cobblestone')], 1, false)).toBeUndefined();
    expect(bladeStrikeSlot([block('cobblestone')], 0, false)).toBeUndefined();
  });

  it('a worn blade when nothing else (the fight takes it too)', () => {
    const worn = item('stone_sword', { damage: 130 });
    expect(bladeStrikeSlot([block('cobblestone'), worn], 0, false, (it) => it.name !== 'stone_sword')).toBe(1);
  });
});

function combatSetup(slots: (ItemStack | null)[], selected: number, digging = false) {
  const z = mob(7n, 'minecraft:zombie', { x: 0.5, y: F + 2.2, z: 0.5 });
  const entities = new Map<bigint, EntityInfo>([[z.runtimeId, z]]);
  const src = new FakeSource();
  const loop = new FakeLoop();
  loop.pos = { x: 0.5, y: F, z: 0.5 };
  const mover = new FakeMover() as FakeMover & { digger?: { busy: boolean } };
  mover.digger = { busy: digging };
  const inv = { slots, selected };
  const mobs = new MobTracker(src, { entities: () => entities, selfRuntimeId: () => 1n, selfPos: () => loop.state.pos });
  const combat = new CombatController({
    loop,
    mover,
    entities: () => entities,
    mobs,
    inventory: inv,
    hotbar: {
      select: (s) => {
        src.queue('mob_equipment', { slot: s, selected_slot: s });
        inv.selected = s;
        return true;
      },
      rawItem: () => undefined,
    },
    source: src,
    selfRuntimeId: () => 1n,
  });
  return { src, loop, combat, inv, z, mover };
}

describe('CombatController.attack with `blade`', () => {
  const kit = (): (ItemStack | null)[] => [item('stone_pickaxe'), item('stone_sword'), block('cobblestone')];

  it('the blade for the strike and the hand back, all queued in order', () => {
    const { src, combat, inv, z } = combatSetup(kit(), 2);
    expect(combat.attack(z.runtimeId, { reach: 3.95, blade: true })).toBe(true);
    expect(src.sent.map((p) => p.name)).toEqual(['mob_equipment', 'animate', 'inventory_transaction', 'mob_equipment']);
    expect(src.sent[0]!.params.slot).toBe(1);
    const tx = src.sent[2]!.params.transaction as { transaction_data: { hotbar_slot: number } };
    expect(tx.transaction_data.hotbar_slot).toBe(1);
    expect(src.sent[3]!.params.slot).toBe(2);
    expect(inv.selected).toBe(2);
    expect(combat.totals.bladeStrikes).toBe(1);
  });

  it('without `blade`, while the pickaxe digs, or with a blade held: the held item strikes, nothing selected', () => {
    for (const c of [
      { slots: kit(), sel: 2, digging: false, blade: false },
      { slots: kit(), sel: 0, digging: true, blade: true },
      { slots: kit(), sel: 1, digging: false, blade: true },
      { slots: [item('bread', { count: 8 }), item('stone_sword')], sel: 0, digging: false, blade: true },
    ]) {
      const { src, combat, inv, z } = combatSetup(c.slots, c.sel, c.digging);
      expect(combat.attack(z.runtimeId, { reach: 3.95, blade: c.blade })).toBe(true);
      expect(src.sent.map((p) => p.name)).toEqual(['animate', 'inventory_transaction']);
      expect(inv.selected).toBe(c.sel);
      expect(combat.totals.bladeStrikes).toBe(0);
    }
  });

  it('out of reach: refused, nothing selected', () => {
    const { src, combat, z } = combatSetup(kit(), 2);
    z.pos = { x: 0.5, y: F + 6, z: 0.5 };
    expect(combat.attack(z.runtimeId, { reach: 3.95, blade: true })).toBe(false);
    expect(src.sent).toEqual([]);
  });
});

describe('Reflex: asks for the blade strike only when the rule is on', () => {
  for (const on of [true, false]) {
    it(`rule ${on ? 'on' : 'off'}`, () => {
      const z = mob(9n, 'minecraft:zombie', { x: 0.5, y: F + 2.2, z: 0.5 });
      const ents = new Map<bigint, EntityInfo>([[z.runtimeId, z]]);
      const src = new FakeSource();
      const mobs = new MobTracker(src, { entities: () => ents, selfRuntimeId: () => 1n, selfPos: () => ({ x: 0.5, y: F, z: 0.5 }) });
      src.emit('add_entity', { runtime_id: z.runtimeId, attributes: [], metadata: [] });
      const loop = new FakeLoop();
      loop.pos = { x: 0.5, y: F, z: 0.5 };
      const asked: (boolean | undefined)[] = [];
      const r = new Reflex({
        loop,
        entities: () => ents,
        mobs,
        attack: (_rid, o) => {
          asked.push(o.blade);
          return true;
        },
        blade: () => on,
        enabled: () => true,
      });
      loop.step(1);
      expect(asked).toEqual([on ? true : undefined]);
      r.dispose();
    });
  }
});
