// Track F12 (docs/flight.md "The first rocket after the kit moved rockets"): after an item stack request of the
// bot's own, the wire item it keeps for each slot it touched is what the server holds: the same NBT, the
// response's count and stack id. On the test server a hotbar stack of rockets topped up from a box, or swapped in
// from a main slot, was used with a wire item rebuilt from the model, without the rockets' `Fireworks` NBT: the
// server refused the use (a full inventory_content back, no rocket entity) and the first rocket fired nothing.
import { describe, expect, it } from 'vitest';
import { swapSlots } from '../../../src/chat/commands-fly.ts';
import { RocketHand } from '../../../src/skills/fly/rocket.ts';
import { wireItemOf } from '../../../src/skills/place/place.ts';
import { StackRequests } from '../../../src/skills/survival/screen.ts';
import { Containers, type StackResponse } from '../../../src/world/containers.ts';
import { Hotbar } from '../../../src/world/hotbar.ts';
import { Inventory, rawLike, WINDOW_ARMOR } from '../../../src/world/inventory.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const ROCKET = 529;
const DIRT = 3;
const BOX = 205;
const ELYTRA = 574;
const CHEST = 347;
const NAMES: Record<number, string> = { [ROCKET]: 'firework_rocket', [DIRT]: 'dirt', [BOX]: 'undyed_shulker_box', [ELYTRA]: 'elytra', [CHEST]: 'iron_chestplate' };
const FIREWORKS = { version: 1, nbt: { type: 'compound', name: '', value: { Fireworks: { type: 'compound', value: { Flight: { type: 'byte', value: 1 } } } } } };
type Wire = ItemV4 & { extra: { has_nbt: number | boolean; nbt?: unknown; can_place_on: unknown[]; can_destroy: unknown[] } };
const wire = (id: number, count: number, stackId: number, nbt?: unknown): Wire => ({
  network_id: id,
  count,
  metadata: 0,
  has_stack_id: true,
  stack_id: stackId,
  block_runtime_id: 0,
  extra: nbt ? { has_nbt: true, nbt, can_place_on: [], can_destroy: [] } : { has_nbt: 0, can_place_on: [], can_destroy: [] },
});
const AIR: Wire = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } };
const toItem = (i: ItemV4): ItemStack | null =>
  i.network_id === 0 ? null : { name: NAMES[i.network_id] ?? `unknown:${i.network_id}`, networkId: i.network_id, count: i.count, metadata: i.metadata, ...(i.stack_id !== undefined ? { stackId: i.stack_id } : {}) };

class FakeSource {
  readonly sent: { name: string; params: Record<string, unknown> }[] = [];
  private readonly fns = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  on(name: string, fn: (p: Record<string, unknown>) => void): () => void {
    let s = this.fns.get(name);
    if (!s) this.fns.set(name, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }
  queue(name: string, params: Record<string, unknown>): void {
    this.sent.push({ name, params });
  }
  receive(name: string, p: object): void {
    for (const fn of this.fns.get(name) ?? []) fn(p as Record<string, unknown>);
  }
}

function setup(hotbar: Wire[], main: Record<number, Wire> = {}, warns?: string[]) {
  const src = new FakeSource();
  const inv = new Inventory(toItem, () => 1n);
  const ctr = new Containers(src, inv, warns ? { logger: { debug: () => undefined, info: () => undefined, warn: (m: string) => void warns.push(m), error: () => undefined } } : {});
  const bar = new Hotbar(src, { inventory: inv, runtimeId: () => 1n });
  const input: Wire[] = Array.from({ length: 36 }, (_, i) => (i < 9 ? (hotbar[i] ?? AIR) : (main[i] ?? AIR)));
  const content = { window_id: 'inventory', input };
  inv.handleInventoryContent(content);
  src.receive('inventory_content', content);
  return { src, inv, ctr, bar };
}

/** The wire item a rocket use sends from `slot` (RocketHand.fire's own expression). */
function heldAtUse(s: ReturnType<typeof setup>, slot: number): Wire {
  const hand = new RocketHand({
    loop: { state: { pos: { x: 0, y: 0, z: 0 } }, boost: () => undefined, endBoost: () => undefined },
    queue: (n, p) => s.src.queue(n, p),
    inventory: s.inv,
    hotbar: s.bar,
    entities: { onAdd: () => () => undefined, onRemove: () => () => undefined },
  });
  hand.fire(slot, { x: 0, y: 0, z: 0 }, 0);
  const tx = s.src.sent.filter((x) => x.name === 'inventory_transaction').at(-1)!;
  return (tx.params.transaction as { transaction_data: { held_item: Wire } }).transaction_data.held_item;
}

const ok = (id: number, containers: StackResponse['containers']): StackResponse => ({ status: 'ok', request_id: id, ...(containers ? { containers } : {}) });

describe('Track F12: wire items follow the bot’s own stack requests', () => {
  it('a hotbar stack topped up from a box: the use carries the NBT, the count and the stack id the server holds (the refill)', async () => {
    const s = setup([wire(ROCKET, 8, 2554, FIREWORKS)]);
    s.src.receive('container_open', { window_id: 2, window_type: 'container', coordinates: { x: 0, y: 0, z: 0 }, runtime_entity_id: -1n });
    s.ctr.setSlotType(2, 'shulker');
    s.inv.handleInventoryContent({ window_id: 2, input: [wire(ROCKET, 64, 2556, FIREWORKS), ...Array.from({ length: 26 }, () => AIR)] });
    const p = s.ctr.move({ window: 2, slot: 0 }, { window: 0, slot: 0 }, 56);
    // the prediction already carries the NBT
    expect((s.inv.rawItem(0, 0) as Wire).extra.nbt).toEqual(FIREWORKS);
    expect(s.inv.rawItem(0, 0)?.count).toBe(64);
    s.src.receive('item_stack_response', {
      responses: [ok(-1, [
        { slot_type: { container_id: 'shulker' }, slots: [{ slot: 0, hotbar_slot: 0, count: 8, item_stack_id: 2556 }] },
        { slot_type: { container_id: 'hotbar' }, slots: [{ slot: 0, hotbar_slot: 0, count: 64, item_stack_id: 2554 }] },
      ])],
    });
    expect((await p).ok).toBe(true);
    const held = heldAtUse(s, 0);
    expect(held).toMatchObject({ network_id: ROCKET, count: 64, stack_id: 2554, has_stack_id: true });
    expect(held.extra.nbt).toEqual(FIREWORKS);
    // the box's rest keeps its own
    expect(s.inv.rawItem(2, 0)).toMatchObject({ count: 8, stack_id: 2556 });
    // the selection echoes the same item (it carried the 8 from before the request)
    expect(s.bar.rawItem(0)).toMatchObject({ count: 64, stack_id: 2554 });
  });

  it('a split into an empty hotbar slot: the source’s NBT with the new stack id from the response', async () => {
    const s = setup([], { 14: wire(ROCKET, 64, 70, FIREWORKS) });
    const p = s.ctr.move({ window: 0, slot: 14 }, { window: 0, slot: 3 }, 20);
    expect(s.inv.rawItem(0, 3)).toMatchObject({ count: 20, has_stack_id: false });
    expect(s.inv.rawItem(0, 14)).toMatchObject({ count: 44, stack_id: 70 });
    s.src.receive('item_stack_response', {
      responses: [ok(-1, [
        { slot_type: { container_id: 'inventory' }, slots: [{ slot: 14, hotbar_slot: 14, count: 44, item_stack_id: 70 }] },
        { slot_type: { container_id: 'hotbar' }, slots: [{ slot: 3, hotbar_slot: 3, count: 20, item_stack_id: 71 }] },
      ])],
    });
    await p;
    const held = heldAtUse(s, 3);
    expect(held).toMatchObject({ count: 20, stack_id: 71 });
    expect(held.extra.nbt).toEqual(FIREWORKS);
  });

  it('a refused request rolls the wire items back with the stacks', async () => {
    const s = setup([wire(ROCKET, 8, 10, FIREWORKS)], { 14: wire(ROCKET, 64, 11, FIREWORKS) });
    const before0 = s.inv.rawItem(0, 0);
    const before14 = s.inv.rawItem(0, 14);
    const p = s.ctr.move({ window: 0, slot: 14 }, { window: 0, slot: 0 }, 56);
    s.src.receive('item_stack_response', { responses: [{ status: 'error', request_id: -1 }] });
    expect((await p).ok).toBe(false);
    expect(s.inv.rawItem(0, 0)).toBe(before0);
    expect(s.inv.rawItem(0, 14)).toBe(before14);
  });

  it('a swap (the kit’s, with a full inventory): each wire item goes with its stack, before and after the response', async () => {
    const s = setup([AIR, AIR, wire(DIRT, 16, 30)], { 14: wire(ROCKET, 64, 31, FIREWORKS) });
    const requests = new StackRequests({ source: s.src, containers: s.ctr, loop: { waitTicks: () => Promise.resolve() }, runtimeId: () => 1n });
    const p = swapSlots(requests, s.inv, 14, 2);
    expect((s.inv.rawItem(0, 2) as Wire).extra.nbt).toEqual(FIREWORKS);
    expect(s.inv.rawItem(0, 14)).toMatchObject({ network_id: DIRT, stack_id: 30 });
    s.src.receive('item_stack_response', {
      responses: [ok(-100001, [
        { slot_type: { container_id: 'inventory' }, slots: [{ slot: 14, hotbar_slot: 14, count: 16, item_stack_id: 30 }] },
        { slot_type: { container_id: 'hotbar' }, slots: [{ slot: 2, hotbar_slot: 2, count: 64, item_stack_id: 31 }] },
      ])],
    });
    expect((await p).ok).toBe(true);
    const held = heldAtUse(s, 2);
    expect(held).toMatchObject({ network_id: ROCKET, count: 64, stack_id: 31 });
    expect(held.extra.nbt).toEqual(FIREWORKS);
    // the selection's mob_equipment echoes the rockets, not the dirt that was there
    const eq = s.src.sent.filter((x) => x.name === 'mob_equipment').at(-1)!;
    expect((eq.params.item as Wire).network_id).toBe(ROCKET);
  });

  it('a count and a new stack id written into a slot that holds the same item keep its NBT (the crafter’s own response)', () => {
    const s = setup([wire(ROCKET, 10, 80, FIREWORKS)]);
    const cur = s.inv.slots[0]!;
    s.inv.setItem(0, 0, { ...cur, count: 13, stackId: 81 });
    expect(s.inv.rawItem(0, 0)).toMatchObject({ count: 13, stack_id: 81 });
    expect((heldAtUse(s, 0)).extra.nbt).toEqual(FIREWORKS);
    // another item into the slot takes nothing from what was there
    s.inv.setItem(0, 0, { name: 'dirt', networkId: DIRT, count: 1, metadata: 0, stackId: 82 });
    expect(s.inv.rawItem(0, 0)).toBeUndefined();
  });

  it('a slot only the server wrote is used as the server sent it (no request: the same wire item, the same object)', () => {
    const r = wire(ROCKET, 64, 40, FIREWORKS);
    const s = setup([r]);
    expect(s.inv.rawItem(0, 0)).toBe(r);
    expect(s.bar.rawItem(0)).toBe(r);
    expect(heldAtUse(s, 0)).toBe(r);
  });

  it('before Track F12 the same slots were used with the NBT rebuilt away (wireItemOf from the model with a stale raw)', () => {
    // the hotbar's own copy after the refill: the 8 from before the request; the model: 64
    const stale = wire(ROCKET, 8, 2554, FIREWORKS);
    const model: ItemStack = { name: 'firework_rocket', networkId: ROCKET, count: 64, metadata: 0, stackId: 2554 };
    const rebuilt = wireItemOf(model, stale) as Wire;
    expect(rebuilt.extra.has_nbt).toBe(0);
    // what the fix keeps instead
    expect(rawLike<Wire>(stale, model).extra.nbt).toEqual(FIREWORKS);
    expect(wireItemOf(model, rawLike(stale, model))).toMatchObject({ count: 64, stack_id: 2554 });
  });

  it('the armour container of a response is the armour window, never the open one ("unknown slot W:1" on every flight)', () => {
    const warns: string[] = [];
    const s = setup([], { 9: wire(ELYTRA, 1, 50) }, warns);
    s.inv.handleInventoryContent({ window_id: 'armor', input: [AIR, wire(CHEST, 1, 51), AIR, AIR] });
    // a chest open while the armour moves (withScreen uses an open container as the screen)
    s.src.receive('container_open', { window_id: 7, window_type: 'container', coordinates: { x: 0, y: 0, z: 0 }, runtime_entity_id: -1n });
    s.inv.handleInventoryContent({ window_id: 7, input: [AIR, wire(DIRT, 5, 60), ...Array.from({ length: 25 }, () => AIR)] });
    // the armour swap's prediction (armour.ts), then the response
    s.inv.setItem(0, 9, toItem(wire(CHEST, 1, 51)));
    s.inv.setItem(WINDOW_ARMOR, 1, toItem(wire(ELYTRA, 1, 50)));
    s.src.receive('item_stack_response', {
      responses: [ok(-100001, [
        { slot_type: { container_id: 'inventory' }, slots: [{ slot: 9, hotbar_slot: 9, count: 1, item_stack_id: 51 }] },
        { slot_type: { container_id: 'armor' }, slots: [{ slot: 1, hotbar_slot: 1, count: 1, item_stack_id: 50 }] },
      ])],
    });
    expect(warns).toEqual([]);
    expect(s.inv.window(7)?.slots[1]).toMatchObject({ name: 'dirt', count: 5 });
    expect(s.inv.window(WINDOW_ARMOR)?.slots[1]).toMatchObject({ name: 'elytra', stackId: 50 });
  });

  it('the elytra going on under the inventory screen logs no "unknown slot"', () => {
    const warns: string[] = [];
    const s = setup([], { 9: wire(ELYTRA, 1, 50) }, warns);
    s.inv.handleInventoryContent({ window_id: 'armor', input: [AIR, wire(CHEST, 1, 51), AIR, AIR] });
    s.src.receive('container_open', { window_id: 3, window_type: 'inventory', coordinates: { x: 0, y: 0, z: 0 }, runtime_entity_id: -1n });
    s.inv.setItem(0, 9, toItem(wire(CHEST, 1, 51)));
    s.inv.setItem(WINDOW_ARMOR, 1, toItem(wire(ELYTRA, 1, 50)));
    s.src.receive('item_stack_response', {
      responses: [ok(-100001, [
        { slot_type: { container_id: 'inventory' }, slots: [{ slot: 9, hotbar_slot: 9, count: 1, item_stack_id: 51 }] },
        { slot_type: { container_id: 'armor' }, slots: [{ slot: 1, hotbar_slot: 1, count: 1, item_stack_id: 50 }] },
      ])],
    });
    expect(warns).toEqual([]);
    // the worn piece keeps its wire item (the elytra's durability NBT) with the stack
    expect(s.inv.rawItem(WINDOW_ARMOR, 1)).toMatchObject({ network_id: ELYTRA, stack_id: 50 });
  });
});
