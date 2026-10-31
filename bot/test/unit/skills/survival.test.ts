// Survival kit units (PLAN.md task 7.11, Track S, docs/survival.md): tool wear and the Digger /
// CombatController hooks, food choice and the eat controller (packets serialised with the real
// 1.26.60 serializer), armour ranking and equip requests, the inventory keeper (stocking, junk, drop
// requests), the chat commands without walking, and avoidance (cost numbers, sources, the planner
// bending around a spawner and a mob while a goal inside the zone stays reachable).
import { describe, expect, it } from 'vitest';
import { Chat, parseOwners } from '../../../src/chat/chat.ts';
import { parseEquipArgs, registerSurvivalCommands, SURVIVAL_COMMANDS, wearReply } from '../../../src/chat/commands-survival.ts';
import { createDeserializer, createSerializer } from '../../../src/connection/protocol.ts';
import { bestWeaponSlot } from '../../../src/skills/combat/combat.ts';
import { Digger, type DigLoop, type DigWorld } from '../../../src/skills/dig/index.ts';
import { BotSkills } from '../../../src/skills/index.ts';
import type { TickExtrasProvider } from '../../../src/skills/input/inputLoop.ts';
import { Avoidance, costFunction, DEFAULT_AVOIDANCE_COSTS, penalty, SpawnerIndex } from '../../../src/skills/nav/avoidance.ts';
import { findPath, NavGrid, PathFollower, type PathNode } from '../../../src/skills/nav/index.ts';
import {
  ArmourController,
  armourScore,
  armourSlotOf,
  chooseFood,
  durabilityLeft,
  EatController,
  hotbarThrowaway,
  InventoryKeeper,
  makeToolOk,
  maxDurability,
  neverDrop,
  planArmour,
  planKeeper,
  releaseItemTransaction,
  StackRequests,
  THROWAWAY_BLOCKS,
  DEFAULT_JUNK,
  useItemTransaction,
  wantsToEat,
  wearMove,
} from '../../../src/skills/survival/index.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import type { BlockInfo, EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { harness, fakeWorld } from './fakes.ts';
import { flatGen } from './genworld.ts';
import { FakeSource, mob } from './pve-fakes.ts';

let nextId = 1;
const item = (name: string, count = 1, extra: Partial<ItemStack> = {}): ItemStack => ({ name, networkId: 100 + name.length, count, metadata: 0, stackId: nextId++, ...extra });
const slots36 = (fill: Record<number, ItemStack>): (ItemStack | null)[] => Array.from({ length: 36 }, (_, i) => fill[i] ?? null);

/** A loop whose waitTicks advances a tick counter and runs a per-tick hook (the fake server). */
class TickLoop {
  state = { pos: { x: 0.5, y: -60, z: 0.5 }, ready: true };
  tick = 0;
  onTick: ((t: number) => void) | undefined;
  private readonly fns = new Set<(t: bigint, s: { pos: Vec3; ready: boolean }) => void>();
  async waitTicks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.tick++;
      for (const fn of [...this.fns]) fn(BigInt(this.tick), this.state);
      this.onTick?.(this.tick);
      await Promise.resolve();
    }
  }
  onBeforeStep(fn: (t: bigint, s: { pos: Vec3; ready: boolean }) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
}

/** A player inventory that behaves like world/inventory.ts for the parts the kit uses. */
class FakeInv {
  slots: (ItemStack | null)[];
  selected = 0;
  windows = new Map<number, (ItemStack | null)[]>([[120, [null, null, null, null, null]]]);
  constructor(slots: (ItemStack | null)[]) {
    this.slots = slots;
  }
  window(id: number) {
    const s = this.windows.get(id);
    return s ? { slots: s } : undefined;
  }
  rawItem(): ItemV4 | undefined {
    return undefined;
  }
  setItem(window: number, slot: number, it: ItemStack | null): void {
    if (window === 0) this.slots[slot] = it;
    else this.windows.get(window)![slot] = it;
  }
  freeSlots(): number[] {
    return this.slots.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0);
  }
}

/** Containers stand-in: the inventory screen opens on `interact`, closes on close(). */
function fakeScreen(src: FakeSource) {
  const opens = new Set<(c: { id: number; type: string }) => void>();
  const closes = new Set<(id: number, by: boolean) => void>();
  const log: string[] = [];
  const containers = {
    open: undefined as { id: number; type: string } | undefined,
    onOpen: (fn: (c: { id: number; type: string }) => void) => (opens.add(fn), () => opens.delete(fn)),
    onClose: (fn: (id: number, by: boolean) => void) => (closes.add(fn), () => closes.delete(fn)),
    close: (id: number) => {
      log.push(`close ${id}`);
      containers.open = undefined;
      for (const fn of [...closes]) fn(id, false);
    },
  };
  const origQueue = src.queue.bind(src);
  src.queue = (name, params) => {
    origQueue(name, params);
    if (name === 'interact') {
      log.push('open');
      containers.open = { id: 2, type: 'inventory' };
      for (const fn of [...opens]) fn(containers.open);
    }
  };
  return { containers, log };
}

/** Answer every item_stack_request with `status` (after one tick). */
function answerRequests(src: FakeSource, loop: TickLoop, status: (req: Record<string, unknown>) => string | number = () => 'ok') {
  let seen = 0;
  loop.onTick = () => {
    const reqs = src.sent.filter((p) => p.name === 'item_stack_request');
    for (; seen < reqs.length; seen++) {
      const r = (reqs[seen]!.params as { requests: Record<string, unknown>[] }).requests[0]!;
      src.emit('item_stack_response', { responses: [{ status: status(r), request_id: r.request_id }] });
    }
  };
}

// ---- tool wear --------------------------------------------------------------------------------

describe('tool wear', () => {
  it('knows the Bedrock maximum durability of tools, weapons and armour', () => {
    expect(maxDurability('iron_pickaxe')).toBe(250);
    expect(maxDurability('minecraft:diamond_sword')).toBe(1561);
    expect(maxDurability('wooden_axe')).toBe(59);
    expect(maxDurability('netherite_hoe')).toBe(2031);
    expect(maxDurability('iron_chestplate')).toBe(240);
    expect(maxDurability('shears')).toBe(238);
    expect(maxDurability('cobblestone')).toBeUndefined();
    expect(maxDurability('stone_slab')).toBeUndefined();
    expect(durabilityLeft({ name: 'iron_pickaxe', damage: 245 })).toBe(5);
    expect(durabilityLeft({ name: 'iron_pickaxe' })).toBe(250);
    expect(durabilityLeft({ name: 'bread' })).toBeUndefined();
  });

  it('toolOk is false at or below the wear limit (default 10) and true for items without durability', () => {
    let limit = 10;
    const ok = makeToolOk(() => limit);
    expect(ok({ name: 'iron_pickaxe', damage: 240 })).toBe(false); // 10 left
    expect(ok({ name: 'iron_pickaxe', damage: 239 })).toBe(true); // 11 left
    expect(ok({ name: 'iron_pickaxe', damage: 245 })).toBe(false);
    expect(ok({ name: 'dirt' })).toBe(true);
    limit = 4;
    expect(ok({ name: 'iron_pickaxe', damage: 245 })).toBe(true);
  });

  it('the Digger skips a worn pickaxe while a fresh one exists (toolOk hook)', () => {
    const extras: (TickExtrasProvider | undefined)[] = [];
    const loop: DigLoop = { state: { pos: { x: 0.5, y: -60, z: 0.5 }, tick: 0n, ready: true }, setCommand: () => undefined, setTickExtras: (fn) => extras.push(fn) };
    const inv = { slots: slots36({ 0: item('iron_pickaxe', 1, { damage: 245 }), 4: item('iron_pickaxe') }), selected: 0 };
    const stone: BlockInfo = { name: 'stone', stateId: 1, states: {}, hardness: 1.5, solid: true, boxes: [] };
    const world: DigWorld = { blockAt: () => stone, onBlockUpdate: () => () => undefined, inventory: inv };
    const picks: number[] = [];
    const ok = makeToolOk(() => 10);
    const dig = new Digger({ loop, world, hotbar: { select: (s) => (picks.push(s), true) }, toolOk: ok });
    void dig.dig({ x: 1, y: -60, z: 0 });
    expect(picks).toEqual([4]);
    dig.cancel();
    // without the hook the selected worn one (equal speed, no switch) wins
    const plain = new Digger({ loop, world, hotbar: { select: (s) => (picks.push(s), true) } });
    void plain.dig({ x: 1, y: -60, z: 0 });
    expect(picks).toEqual([4]);
    plain.cancel();
    // the hook can be set after construction (BotSkills creates the Digger)
    plain.toolOk = ok;
    void plain.dig({ x: 1, y: -60, z: 0 });
    expect(picks).toEqual([4, 4]);
    plain.cancel();
  });

  it('the weapon choice skips a worn sword (toolOk hook)', () => {
    const slots = slots36({ 1: item('diamond_sword', 1, { damage: 1555 }), 2: item('iron_sword'), 3: item('stone_axe') });
    expect(bestWeaponSlot(slots, 0)).toBe(1);
    expect(bestWeaponSlot(slots, 0, makeToolOk())).toBe(2);
  });
});

// ---- eating -----------------------------------------------------------------------------------

describe('food choice', () => {
  it('eats below 18 food, or below 10 health with food below 20', () => {
    expect(wantsToEat({ food: 17, health: 20 })).toBe(true);
    expect(wantsToEat({ food: 18, health: 20 })).toBe(false);
    expect(wantsToEat({ food: 19, health: 9 })).toBe(true);
    expect(wantsToEat({ food: 20, health: 2 })).toBe(false);
  });

  it('picks the best food, avoids bad food unless starving, keeps golden apples for emergencies', () => {
    const s = slots36({ 0: item('rotten_flesh', 10), 3: item('bread', 5), 12: item('cooked_beef', 2), 20: item('golden_apple', 1) });
    expect(chooseFood(s, { food: 10, health: 20 })?.name).toBe('cooked_beef');
    expect(chooseFood(slots36({ 0: item('rotten_flesh', 10) }), { food: 10, health: 20 })).toBeUndefined();
    expect(chooseFood(slots36({ 0: item('rotten_flesh', 10), 1: item('spider_eye') }), { food: 5, health: 20 })?.name).toBe('rotten_flesh');
    expect(chooseFood(slots36({ 0: item('golden_apple') }), { food: 10, health: 12 })).toBeUndefined();
    expect(chooseFood(slots36({ 0: item('golden_apple') }), { food: 10, health: 4 })?.name).toBe('golden_apple');
    expect(chooseFood(slots36({ 0: item('chorus_fruit'), 1: item('suspicious_stew') }), { food: 2, health: 20 })).toBeUndefined();
    // raw chicken ranked down, hotbar wins a tie
    expect(chooseFood(slots36({ 0: item('chicken'), 1: item('mutton') }), { food: 10, health: 20 })?.name).toBe('mutton');
    expect(chooseFood(slots36({ 2: item('bread'), 30: item('bread') }), { food: 10, health: 20 })?.slot).toBe(2);
  });

  it('the click_air and release transactions serialise with the 1.26.60 protocol', () => {
    const held = { network_id: 261, count: 5, metadata: 0, has_stack_id: true, stack_id: 7, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } } as unknown as ItemV4;
    const ser = createSerializer('1.26.60');
    const de = createDeserializer('1.26.60');
    for (const params of [useItemTransaction({ hotbarSlot: 2, held, eye: { x: 1, y: 2, z: 3 } }), releaseItemTransaction({ hotbarSlot: 2, held, eye: { x: 1, y: 2, z: 3 } })]) {
      const buf = ser.createPacketBuffer({ name: 'inventory_transaction', params });
      const back = de.parsePacketBuffer(buf).data.params as { transaction: { transaction_type: string; transaction_data: Record<string, unknown> } };
      const want = (params as { transaction: { transaction_type: string; transaction_data: Record<string, unknown> } }).transaction;
      expect(back.transaction.transaction_type).toBe(want.transaction_type);
      expect(back.transaction.transaction_data.action_type).toBe(want.transaction_data.action_type);
      expect(back.transaction.transaction_data.hotbar_slot).toBe(2);
    }
  });
});

function eatSetup(slots: (ItemStack | null)[], food = 10) {
  const src = new FakeSource();
  const loop = new TickLoop();
  const inv = new FakeInv(slots);
  const self = { food, health: 20 };
  const selects: number[] = [];
  const hotbar = {
    select: (s: number) => {
      selects.push(s);
      inv.selected = s;
      return true;
    },
    rawItem: () => undefined,
  };
  const fetched: number[] = [];
  const eater = new EatController({
    loop,
    inventory: inv,
    self,
    hotbar,
    source: src,
    toHotbar: (slot) => {
      fetched.push(slot);
      inv.slots[7] = inv.slots[slot]!;
      inv.slots[slot] = null;
      return Promise.resolve(7);
    },
  });
  const clicks = () => src.sent.filter((p) => p.name === 'inventory_transaction').map((p) => (p.params as { transaction: { transaction_type: string; transaction_data: { action_type: string } } }).transaction);
  return { src, loop, inv, self, selects, eater, clicks, fetched };
}

describe('EatController', () => {
  it('selects the food, clicks once, and waits for the server to finish (31 ticks)', async () => {
    const t = eatSetup(slots36({ 0: item('iron_sword'), 3: item('bread', 5) }));
    let started = -1;
    t.loop.onTick = (tick) => {
      if (started < 0 && t.clicks().length) started = tick;
      if (started >= 0 && tick - started === 31) {
        t.inv.slots[3] = { ...t.inv.slots[3]!, count: 4 };
        t.self.food = 15;
      }
    };
    const r = await t.eater.eat();
    expect(r).toMatchObject({ ok: true, item: 'bread', slot: 3, foodBefore: 10, foodAfter: 15 });
    expect(t.clicks()).toHaveLength(1);
    expect(t.clicks()[0]).toMatchObject({ transaction_type: 'item_use', transaction_data: { action_type: 'click_air' } });
    expect(t.selects).toEqual([3, 0]); // back to the sword afterwards
  });

  it('fetches food from the main inventory first', async () => {
    const t = eatSetup(slots36({ 20: item('cooked_beef', 3) }));
    t.loop.onTick = () => {
      if (t.clicks().length) t.self.food = 18;
    };
    const r = await t.eater.eat();
    expect(r).toMatchObject({ ok: true, item: 'cooked_beef', slot: 7, fetched: true });
    expect(t.fetched).toEqual([20]);
  });

  it('does nothing when not hungry or without food; force eats above 18 but not at 20', async () => {
    expect((await eatSetup(slots36({ 0: item('bread') }), 19).eater.eat()).reason).toBe('not_hungry');
    expect((await eatSetup(slots36({ 0: item('dirt') }), 10).eater.eat()).reason).toBe('no_food');
    expect((await eatSetup(slots36({ 0: item('bread') }), 20).eater.eat({ force: true })).reason).toBe('not_hungry');
    const t = eatSetup(slots36({ 0: item('bread') }), 19);
    t.loop.onTick = () => {
      if (t.clicks().length) t.self.food = 20;
    };
    expect((await t.eater.eat({ force: true })).ok).toBe(true);
  });

  it('stops with item_release when hit hard, and notices a slot switch', async () => {
    const t = eatSetup(slots36({ 0: item('bread', 5) }));
    t.loop.onTick = (tick) => {
      if (tick === 8) t.self.health = 15;
    };
    const r = await t.eater.eat();
    expect(r.reason).toBe('hit');
    expect(t.clicks().map((c) => c.transaction_type)).toEqual(['item_use', 'item_release']);
    expect(t.clicks()[1]!.transaction_data.action_type).toBe('release');

    const u = eatSetup(slots36({ 0: item('bread', 5) }));
    u.loop.onTick = (tick) => {
      if (tick === 5) u.inv.selected = 2; // the combat skill picked its sword
    };
    expect((await u.eater.eat()).reason).toBe('interrupted');
  });

  it('keeps eating when hit below 6 health', async () => {
    const t = eatSetup(slots36({ 0: item('bread', 5) }));
    t.self.health = 9;
    t.loop.onTick = (tick) => {
      if (tick === 5) t.self.health = 4;
      if (tick === 32) t.self.food = 15;
    };
    expect((await t.eater.eat()).ok).toBe(true);
  });
});

// ---- armour -----------------------------------------------------------------------------------

describe('armour', () => {
  it('maps pieces to slots and ranks materials', () => {
    expect(armourSlotOf('iron_helmet')).toBe(0);
    expect(armourSlotOf('minecraft:diamond_chestplate')).toBe(1);
    expect(armourSlotOf('leather_leggings')).toBe(2);
    expect(armourSlotOf('netherite_boots')).toBe(3);
    expect(armourSlotOf('turtle_helmet')).toBe(0);
    expect(armourSlotOf('elytra')).toBeUndefined();
    expect(armourSlotOf('iron_sword')).toBeUndefined();
    const chest = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'].map((m) => armourScore(`${m}_chestplate`));
    expect([...chest].sort((a, b) => a - b)).toEqual(chest);
    expect(armourScore('golden_chestplate')).toBe(armourScore('chainmail_chestplate'));
  });

  it('plans the best piece per slot over what is worn; a nearly broken piece ranks last', () => {
    const s = slots36({ 2: item('iron_chestplate'), 5: item('leather_chestplate'), 9: item('diamond_helmet'), 11: item('golden_boots') });
    const worn = [null, item('chainmail_chestplate'), null, item('iron_boots')];
    expect(planArmour(s, worn).map((m) => [m.slot, m.item, m.from, m.replaces])).toEqual([
      [0, 'diamond_helmet', 9, null],
      [1, 'iron_chestplate', 2, 'chainmail_chestplate'],
    ]);
    const worn2 = [null, null, null, null];
    const s2 = slots36({ 0: item('diamond_chestplate', 1, { damage: 525 }), 1: item('leather_chestplate') });
    expect(planArmour(s2, worn2, makeToolOk()).map((m) => m.item)).toEqual(['leather_chestplate']);
  });

  it('equips through the inventory screen: place into an empty armour slot, swap with a worn one', async () => {
    const src = new FakeSource();
    const loop = new TickLoop();
    const { containers, log } = fakeScreen(src);
    const inv = new FakeInv(slots36({ 1: item('iron_chestplate'), 12: item('iron_boots') }));
    inv.windows.get(120)![3] = item('leather_boots');
    const requests = new StackRequests({ source: src, containers, loop, runtimeId: () => 1n });
    answerRequests(src, loop);
    const ctl = new ArmourController({ inventory: inv, requests });
    const r = await ctl.equip();
    expect(r).toMatchObject({ ok: true, equipped: ['chest iron_chestplate', 'feet iron_boots'] });
    const reqs = src.sent.filter((p) => p.name === 'item_stack_request').map((p) => (p.params as { requests: { request_id: number; actions: Record<string, unknown>[] }[] }).requests[0]!);
    expect(reqs[0]!.actions[0]).toMatchObject({ type_id: 'place', count: 1, source: { slot_type: { container_id: 'hotbar' }, slot: 1 }, destination: { slot_type: { container_id: 'armor' }, slot: 1, stack_id: 0 } });
    expect(reqs[1]!.actions[0]).toMatchObject({ type_id: 'swap', source: { slot_type: { container_id: 'inventory' }, slot: 12 }, destination: { slot_type: { container_id: 'armor' }, slot: 3 } });
    expect(reqs[0]!.request_id).toBeLessThan(-100000);
    expect(log[0]).toBe('open');
    expect(log.at(-1)).toBe('close 2');
    expect(ctl.worn().map((w) => w?.name ?? null)).toEqual([null, 'iron_chestplate', null, 'iron_boots']);
    expect(inv.slots[12]?.name).toBe('leather_boots');
    expect(ctl.plan()).toEqual([]);
  });

  it('rolls the model back when the server refuses a swap', async () => {
    const src = new FakeSource();
    const loop = new TickLoop();
    const { containers } = fakeScreen(src);
    const inv = new FakeInv(slots36({ 12: item('iron_boots') }));
    inv.windows.get(120)![3] = item('leather_boots');
    const requests = new StackRequests({ source: src, containers, loop, runtimeId: () => 1n });
    answerRequests(src, loop, () => 50);
    const r = await new ArmourController({ inventory: inv, requests }).equip();
    expect(r.ok).toBe(false);
    expect(inv.slots[12]?.name).toBe('iron_boots');
    expect(inv.windows.get(120)![3]?.name).toBe('leather_boots');
  });
});

describe('armour worn by hand (!equip slot, the panel\'s Wear this)', () => {
  const setup = (fill: Record<number, ItemStack>, worn: (ItemStack | null)[]) => {
    const src = new FakeSource();
    const loop = new TickLoop();
    const { containers } = fakeScreen(src);
    const inv = new FakeInv(slots36(fill));
    worn.forEach((w, i) => (inv.windows.get(120)![i] = w));
    const requests = new StackRequests({ source: src, containers, loop, runtimeId: () => 1n });
    answerRequests(src, loop);
    const reqs = () => src.sent.filter((p) => p.name === 'item_stack_request').map((p) => (p.params as { requests: { actions: Record<string, unknown>[] }[] }).requests[0]!.actions[0]!);
    return { inv, ctl: new ArmourController({ inventory: inv, requests }), reqs };
  };

  it('wearMove: the slot an item goes into (the elytra: chest), or why not', () => {
    const s = slots36({ 3: item('elytra'), 4: item('iron_boots'), 5: item('bread', 3) });
    expect(wearMove(s, [null, item('netherite_chestplate'), null, null], 3)).toEqual({ slot: 1, from: 3, item: 'elytra', replaces: 'netherite_chestplate' });
    expect(wearMove(s, [null, null, null, null], 4)).toEqual({ slot: 3, from: 4, item: 'iron_boots', replaces: null });
    expect(wearMove(s, [], 5)).toBe('bread is not armour or an elytra');
    expect(wearMove(s, [], 6)).toBe('slot 6 is empty');
    expect(wearMove(s, [], 36)).toBe('slot must be 0..35');
  });

  it('the elytra replaces the netherite chestplate (which goes into the elytra\'s slot) and the automatic pass leaves it on', async () => {
    const { inv, ctl, reqs } = setup({ 14: item('elytra') }, [null, item('netherite_chestplate'), null, null]);
    const r = await ctl.wearSlot(14);
    expect(r).toEqual({ ok: true, item: 'elytra', slot: 1, replaces: 'netherite_chestplate' });
    expect(reqs()[0]).toMatchObject({ type_id: 'swap', source: { slot_type: { container_id: 'inventory' }, slot: 14 }, destination: { slot_type: { container_id: 'armor' }, slot: 1 } });
    expect(ctl.worn()[1]?.name).toBe('elytra');
    expect(inv.slots[14]?.name).toBe('netherite_chestplate');
    expect(ctl.pinned()).toEqual(new Map([[1, 'elytra']]));
    expect(ctl.plan()).toEqual([]);
    expect((await ctl.equip()).equipped).toEqual([]); // the auto pass: nothing to do
    expect(ctl.worn()[1]?.name).toBe('elytra');
  });

  it('a worse piece is worn on request and stays; !equip (clearPins) or another wear of the slot ends that', async () => {
    const { inv, ctl } = setup({ 2: item('leather_chestplate') }, [null, item('diamond_chestplate'), null, null]);
    expect((await ctl.wearSlot(2)).ok).toBe(true);
    expect(ctl.worn()[1]?.name).toBe('leather_chestplate');
    expect(inv.slots[2]?.name).toBe('diamond_chestplate');
    expect(ctl.plan()).toEqual([]); // the better one in the inventory is not put back while walking
    ctl.clearPins(); // !equip
    expect(ctl.plan().map((m) => m.item)).toEqual(['diamond_chestplate']);
    // pinned again, then a feature's own wear of the slot (the flight kit) ends the pin
    expect((await ctl.wearSlot(2)).ok).toBe(true); // diamond back on by hand
    expect((await ctl.wearSlot(2)).ok).toBe(true); // leather again by hand
    expect(ctl.pinned().get(1)).toBe('leather_chestplate');
    expect(await ctl.wear({ slot: 1, from: 2, item: 'diamond_chestplate', replaces: 'leather_chestplate' })).toBe(true);
    expect(ctl.pinned().size).toBe(0);
  });

  it('a pin ends by itself when the slot holds something else (dropped, broken, swapped elsewhere)', async () => {
    const { inv, ctl } = setup({ 2: item('leather_chestplate'), 3: item('iron_chestplate') }, [null, null, null, null]);
    expect((await ctl.wearSlot(2)).ok).toBe(true);
    expect(ctl.plan()).toEqual([]);
    inv.windows.get(120)![1] = null; // gone (dropped by !drop all, broken)
    expect(ctl.plan().map((m) => m.item)).toEqual(['iron_chestplate']);
    expect(ctl.pinned().size).toBe(0);
  });

  it('a reconnect (the armour window cleared until the server sends it again) keeps the pin', async () => {
    const { inv, ctl } = setup({ 2: item('leather_chestplate'), 3: item('iron_chestplate') }, [null, null, null, null]);
    expect((await ctl.wearSlot(2)).ok).toBe(true);
    const w = inv.windows.get(120)!;
    inv.windows.delete(120); // start_game: inventory cleared
    expect(ctl.pinned().size).toBe(1);
    inv.windows.set(120, w); // the armour window again, the same piece worn
    expect(ctl.plan()).toEqual([]);
  });
});

describe('!equip arguments', () => {
  const s = slots36({ 0: item('iron_sword'), 7: item('elytra'), 20: item('leather_boots'), 21: item('leather_boots') });
  it('none = the best armour; slot <n>; an item name = its first slot', () => {
    expect(parseEquipArgs([], s)).toEqual({ kind: 'best' });
    expect(parseEquipArgs(['slot', '7'], s)).toEqual({ kind: 'slot', slot: 7 });
    expect(parseEquipArgs(['slot', '35'], s)).toEqual({ kind: 'slot', slot: 35 });
    expect(parseEquipArgs(['elytra'], s)).toEqual({ kind: 'slot', slot: 7 });
    expect(parseEquipArgs(['minecraft:leather_boots'], s)).toEqual({ kind: 'slot', slot: 20 });
  });
  it('usage and errors', () => {
    for (const a of [['slot'], ['slot', '36'], ['slot', '-1'], ['slot', 'x']]) expect(parseEquipArgs(a, s)).toMatchObject({ kind: 'error', reason: expect.stringMatching(/^usage: !equip/) as string });
    expect(parseEquipArgs(['iron_sword'], s)).toMatchObject({ kind: 'error', reason: expect.stringMatching(/^equip: iron_sword is not armour or an elytra/) as string });
    expect(parseEquipArgs(['iron_helmet'], s)).toEqual({ kind: 'error', reason: 'equip: no iron_helmet in the inventory' });
  });
  it('the reply', () => {
    expect(wearReply({ ok: true, item: 'elytra', slot: 1, replaces: 'netherite_chestplate' }, 14)).toBe('equip: wearing elytra (chest), netherite_chestplate into slot 14; kept on until !equip');
    expect(wearReply({ ok: true, item: 'iron_boots', slot: 3, replaces: null }, 4)).toBe('equip: wearing iron_boots (feet); kept on until !equip');
    expect(wearReply({ ok: false, reason: 'slot 6 is empty' }, 6)).toBe('equip: slot 6 is empty');
  });
});

// ---- keeper -----------------------------------------------------------------------------------

const keepSettings = { throwawayMin: 16, throwaway: THROWAWAY_BLOCKS, junk: DEFAULT_JUNK };

describe('inventory keeper', () => {
  it('never drops tools, food, armour, logs, planks, chests, torches, bones or gunpowder', () => {
    for (const n of ['iron_pickaxe', 'bread', 'iron_helmet', 'oak_log', 'crimson_stem', 'spruce_planks', 'chest', 'torch', 'soul_torch', 'bone', 'gunpowder', 'shield']) expect(neverDrop(n)).toBe(true);
    for (const n of ['rotten_flesh', 'string', 'poisonous_potato', 'spider_eye', 'dirt']) expect(neverDrop(n)).toBe(false);
  });

  it('stocks throwaway blocks from the main inventory into an empty hotbar slot, merging when it can', () => {
    const s = slots36({ 0: item('iron_pickaxe'), 1: item('dirt', 5), 14: item('cobblestone', 40), 20: item('dirt', 64) });
    expect(hotbarThrowaway(s, THROWAWAY_BLOCKS)).toBe(5);
    expect(planKeeper(s, keepSettings)).toEqual([{ kind: 'stock', from: 20, to: 1, item: 'dirt', count: 59, mode: 'place' }]);
    const s2 = slots36({ 0: item('iron_pickaxe'), 14: item('cobblestone', 40) });
    expect(planKeeper(s2, keepSettings)).toEqual([{ kind: 'stock', from: 14, to: 1, item: 'cobblestone', count: 40, mode: 'place' }]);
    expect(planKeeper(slots36({ 0: item('cobblestone', 16) }), keepSettings)).toEqual([]);
    expect(planKeeper(s2, { ...keepSettings, throwawayMin: 0 })).toEqual([]);
  });

  it('swaps with junk in a full hotbar, drops junk when the inventory is full', () => {
    const full: Record<number, ItemStack> = {};
    for (let i = 0; i < 36; i++) full[i] = item('iron_ingot', 64);
    full[8] = item('rotten_flesh', 7);
    full[22] = item('cobblestone', 64);
    full[30] = item('string', 3);
    full[31] = item('rotten_flesh', 30);
    full[32] = item('oak_log', 3);
    const plan = planKeeper(slots36(full), keepSettings);
    expect(plan[0]).toEqual({ kind: 'stock', from: 22, to: 8, item: 'cobblestone', count: 64, mode: 'swap' });
    // the swapped-out rotten flesh (slot 8) is not dropped in the same pass; the biggest rotten flesh stack and string go
    expect(plan.slice(1)).toEqual([
      { kind: 'drop', from: 31, item: 'rotten_flesh', count: 30 },
    ]);
    const noJunk = { ...full, 8: item('iron_ingot'), 30: item('iron_ingot'), 31: item('iron_ingot') };
    expect(planKeeper(slots36(noJunk), keepSettings).filter((p) => p.kind === 'drop')).toEqual([]);
  });

  it('drop(name, n) sends drop requests (main inventory first) inside the inventory screen', async () => {
    const src = new FakeSource();
    const loop = new TickLoop();
    const { containers, log } = fakeScreen(src);
    const inv = new FakeInv(slots36({ 2: item('rotten_flesh', 10), 15: item('rotten_flesh', 4) }));
    const requests = new StackRequests({ source: src, containers, loop, runtimeId: () => 1n });
    answerRequests(src, loop);
    const keeper = new InventoryKeeper({ inventory: inv, requests, mover: { move: () => Promise.resolve({ ok: true }) }, settings: () => keepSettings });
    const r = await keeper.drop('rotten_flesh', 6);
    expect(r).toEqual({ ok: true, item: 'rotten_flesh', dropped: 6 });
    const acts = src.sent.filter((p) => p.name === 'item_stack_request').map((p) => (p.params as { requests: { actions: Record<string, unknown>[] }[] }).requests[0]!.actions[0]);
    expect(acts).toMatchObject([
      { type_id: 'drop', count: 4, source: { slot_type: { container_id: 'inventory' }, slot: 15 }, randomly: false },
      { type_id: 'drop', count: 2, source: { slot_type: { container_id: 'hotbar' }, slot: 2 }, randomly: false },
    ]);
    expect(inv.slots[15]).toBeNull();
    expect(inv.slots[2]?.count).toBe(8);
    expect(log).toEqual(['open', 'close 2']);
    expect((await keeper.drop('diamond')).reason).toBe('none');
  });
  it('Track AV: drop(name, n, skip) never drops from the skipped slots (a bot_loot box among boxes of the same name)', async () => {
    const src = new FakeSource();
    const loop = new TickLoop();
    const { containers } = fakeScreen(src);
    const inv = new FakeInv(slots36({ 1: item('undyed_shulker_box', 1), 12: item('undyed_shulker_box', 1), 20: item('undyed_shulker_box', 1) }));
    const requests = new StackRequests({ source: src, containers, loop, runtimeId: () => 1n });
    answerRequests(src, loop);
    const keeper = new InventoryKeeper({ inventory: inv, requests, mover: { move: () => Promise.resolve({ ok: true }) }, settings: () => keepSettings });
    const r = await keeper.drop('undyed_shulker_box', undefined, new Set([12]));
    expect(r).toEqual({ ok: true, item: 'undyed_shulker_box', dropped: 2 });
    expect(inv.slots[12]?.name).toBe('undyed_shulker_box');
    expect(inv.slots[1]).toBeNull();
    expect(inv.slots[20]).toBeNull();
    expect((await keeper.drop('undyed_shulker_box', undefined, new Set([12]))).reason).toBe('none');
  });
  it('dropWorn drops the worn armour (armor slots) and the offhand (offhand slot 1) inside the inventory screen', async () => {
    const src = new FakeSource();
    const loop = new TickLoop();
    const { containers, log } = fakeScreen(src);
    const inv = new FakeInv(slots36({}));
    inv.windows.get(120)![0] = item('iron_helmet');
    inv.windows.get(120)![3] = item('leather_boots');
    inv.windows.set(119, [item('shield')]);
    const requests = new StackRequests({ source: src, containers, loop, runtimeId: () => 1n });
    answerRequests(src, loop);
    const keeper = new InventoryKeeper({ inventory: inv, requests, mover: { move: () => Promise.resolve({ ok: true }) }, settings: () => keepSettings });
    const r = await keeper.dropWorn();
    expect(r).toEqual({ dropped: ['iron_helmet', 'leather_boots', 'shield'], refused: [] });
    const acts = src.sent.filter((p) => p.name === 'item_stack_request').map((p) => (p.params as { requests: { actions: Record<string, unknown>[] }[] }).requests[0]!.actions[0]);
    expect(acts).toMatchObject([
      { type_id: 'drop', count: 1, source: { slot_type: { container_id: 'armor' }, slot: 0 } },
      { type_id: 'drop', count: 1, source: { slot_type: { container_id: 'armor' }, slot: 3 } },
      { type_id: 'drop', count: 1, source: { slot_type: { container_id: 'offhand' }, slot: 1 } },
    ]);
    expect(inv.windows.get(120)![0]).toBeNull();
    expect(inv.windows.get(119)![0]).toBeNull();
    expect(log[0]).toBe('open');
    expect(log.at(-1)).toMatch(/^close /);
  });
});

// ---- chat -------------------------------------------------------------------------------------

describe('survival commands', () => {
  it('without the movement stack every command says it needs walking', () => {
    const src = new FakeSource();
    const chat = new Chat(src as never, { owners: parseOwners([]) });
    const names: string[] = [];
    const orig = chat.register.bind(chat);
    chat.register = (def) => {
      names.push(def.name);
      orig(def);
    };
    expect(registerSurvivalCommands({ chat, source: src })).toBeUndefined();
    expect(names).toEqual([...SURVIVAL_COMMANDS]);
  });
});

// ---- avoidance --------------------------------------------------------------------------------

describe('avoidance', () => {
  it('cost numbers: base 8 + 12 per block inside radius + 1, capped at 80', () => {
    expect(penalty(10, 8)).toBe(0);
    expect(penalty(9, 8)).toBe(0);
    expect(penalty(8.5, 8)).toBeCloseTo(14);
    expect(penalty(8, 8)).toBe(20);
    expect(penalty(4, 8)).toBe(68);
    expect(penalty(0, 8)).toBe(80);
    expect(penalty(0, 0)).toBe(0);
    expect(DEFAULT_AVOIDANCE_COSTS).toMatchObject({ base: 8, slope: 12, margin: 1, max: 80 });
  });

  it('sources: hostile mobs (not players, not passive, not the excluded target) and spawners', () => {
    const ents = new Map<bigint, EntityInfo>([
      [2n, mob(2n, 'minecraft:zombie', { x: 10.5, y: -60, z: 0.5 })],
      [3n, mob(3n, 'minecraft:pig', { x: 0.5, y: -60, z: 10.5 })],
      [4n, mob(4n, 'minecraft:skeleton', { x: -10.5, y: -60, z: 0.5 })],
      [5n, { ...mob(5n, 'minecraft:player', { x: 3, y: -58.38, z: 3 }), username: 'Steve' }],
    ]);
    let exclude: bigint[] = [];
    const a = new Avoidance({ entities: () => ents, spawners: () => [{ x: 0, y: -60, z: 20 }], exclude: () => exclude });
    expect(a.sources()).toHaveLength(3);
    expect(a.last).toEqual({ mobs: 2, spawners: 1 });
    exclude = [2n];
    expect(a.sources()).toHaveLength(2);
    const off = new Avoidance({ entities: () => ents, spawners: () => [{ x: 0, y: -60, z: 20 }], mobRadius: () => 0, spawnerRadius: () => 0 });
    expect(off.costFn()).toBeUndefined();
    const f = a.costFn()!;
    expect(f(0, -60, 20)).toBe(80); // the spawner's own column
    expect(f(-11, -60, 0)).toBe(Math.min(80, 8 + 12 * 5)); // on the skeleton
    expect(f(-11, -50, 0)).toBe(0); // 10 blocks above it
    expect(f(30, -60, 30)).toBe(0);
  });

  it('the planner bends around a spawner (min distance >= the radius) and still reaches a goal inside the zone', () => {
    const w = flatGen();
    const spawner = { x: 0, y: -60, z: 0 };
    w.put(spawner.x, spawner.y, spawner.z, 'mob_spawner');
    const grid = new NavGrid(w);
    const cellCost = costFunction(new Avoidance({ entities: () => new Map(), spawners: () => [spawner] }).sources());
    const r = findPath(grid, { x: -20, y: -60, z: 0 }, { type: 'block', p: { x: 20, y: -60, z: 0 } }, { cellCost });
    expect(r.status).toBe('found');
    const minD = Math.min(...r.path.map((n) => Math.hypot(n.x + 0.5 - (spawner.x + 0.5), n.feet - spawner.y, n.z + 0.5 - (spawner.z + 0.5))));
    expect(minD).toBeGreaterThanOrEqual(8);
    const straight = findPath(grid, { x: -20, y: -60, z: 0 }, { type: 'block', p: { x: 20, y: -60, z: 0 } });
    expect(Math.min(...straight.path.map((n) => Math.hypot(n.x, n.z)))).toBeLessThan(2);
    const inside = findPath(grid, { x: -20, y: -60, z: 0 }, { type: 'block', p: { x: 2, y: -60, z: 0 } }, { cellCost });
    expect(inside.status).toBe('found');
  });

  it('the navigator reads the cost afresh for every plan (a mob that appears bends the next plan)', () => {
    const gen = flatGen();
    const { loop } = harness({ x: -15.5, y: -60, z: 0.5 });
    const skills = new BotSkills({ loop, world: fakeWorld(gen) });
    const ents = new Map<bigint, EntityInfo>();
    const avoid = new Avoidance({ entities: () => ents, mobRadius: () => 4 });
    skills.nav.cellCost = () => avoid.costFn();
    const goal = { type: 'block' as const, p: { x: 15, y: -60, z: 0 } };
    const d = (path: { x: number; z: number }[]) => Math.min(...path.map((n) => Math.hypot(n.x + 0.5 - 0.5, n.z + 0.5 - 0.5)));
    const before = skills.nav.plan(goal, { x: -15.5, y: -60, z: 0.5 })!;
    expect(d(before.path)).toBeLessThan(1);
    ents.set(9n, mob(9n, 'minecraft:zombie', { x: 0.5, y: -60, z: 0.5 }));
    const after = skills.nav.plan(goal, { x: -15.5, y: -60, z: 0.5 })!;
    expect(after.status).toBe('found');
    expect(d(after.path)).toBeGreaterThanOrEqual(4);
    skills.dispose();
  });

  it('SpawnerIndex finds spawners by scan and follows block updates', () => {
    const listeners = new Set<(p: Vec3, b: { name: string } | undefined, a: { name: string }) => void>();
    let scans = 0;
    const world = {
      find: () => {
        scans++;
        return [{ x: 5, y: -60, z: 5 }];
      },
      onBlockUpdate: (fn: (p: Vec3, b: { name: string } | undefined, a: { name: string }) => void) => (listeners.add(fn), () => listeners.delete(fn)),
    };
    let pos: Vec3 = { x: 0, y: -60, z: 0 };
    const idx = new SpawnerIndex(world, () => pos, { rescanMs: 0 });
    expect(idx.spawners()).toEqual([{ x: 5, y: -60, z: 5 }]);
    expect(idx.spawners()).toHaveLength(1);
    expect(scans).toBe(1); // not moved: no rescan
    for (const fn of listeners) fn({ x: 9, y: -60, z: 9 }, { name: 'air' }, { name: 'mob_spawner' });
    expect(idx.spawners()).toHaveLength(2);
    for (const fn of listeners) fn({ x: 5, y: -60, z: 5 }, { name: 'mob_spawner' }, { name: 'air' });
    expect(idx.spawners()).toEqual([{ x: 9, y: -60, z: 9 }]);
    pos = { x: 20, y: -60, z: 0 };
    idx.spawners();
    expect(scans).toBe(2);
    idx.dispose();
  });

  it('pure pursuit never shortcuts through cells the plan penalised more than the nodes it skips', () => {
    const grid = new NavGrid(flatGen());
    // a detour around a costly disc at (4, 0): out to z = 3 and back
    const pts: [number, number][] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 3],
      [5, 3],
      [6, 2],
      [7, 1],
      [8, 0],
    ];
    const path: PathNode[] = pts.map(([x, z], i) => ({ x, y: -60, z, feet: -60, move: i === 0 ? 'start' : x === 4 || x === 5 ? 'walk' : 'diag', cost: 5 }));
    const cellCost = (x: number, _y: number, z: number) => (Math.hypot(x + 0.5 - 4.5, z + 0.5 - 0.5) < 2.5 ? 30 : 0);
    const s = { pos: { x: 0.5, y: -60, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: true, collidedHorizontally: false };
    const plain = new PathFollower(path, grid);
    plain.step(s, 0);
    const careful = new PathFollower(path, grid, { cellCost });
    careful.step(s, 0);
    expect(plain.index).toBeGreaterThanOrEqual(6); // up to 6 ahead, straight across the disc
    expect(careful.index).toBeLessThanOrEqual(3);
  });
});
