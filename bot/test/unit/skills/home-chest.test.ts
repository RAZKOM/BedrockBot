// Wave 9 Track AG: the per-window slot type of world/containers.ts and the chest skill's additions
// (skills/container/chest.ts): the slot type by block kind (barrel `barrel`, shulker box `shulker`,
// chest `container`), snapshot (double chest, shulker boxes by NBT), depositSlots and take, against a
// fake packet source that answers like BDS 1.26.60.6.
import { describe, expect, it } from 'vitest';
import { ChestSkill, CONTAINER_BLOCKS, isShulkerBox, shulkerContents, shulkerSlotsUsed, slotTypeForBlock, snapshotOf } from '../../../src/skills/container/chest.ts';
import { Containers, type StackResponse } from '../../../src/world/containers.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const NAMES: Record<number, string> = { 17: 'oak_log', 3: 'dirt', 263: 'coal', 900: 'undyed_shulker_box' };
const toItem = (i: ItemV4): ItemStack | null =>
  i.network_id === 0 ? null : { name: NAMES[i.network_id] ?? `unknown:${i.network_id}`, networkId: i.network_id, count: i.count, metadata: i.metadata, ...(i.stack_id !== undefined ? { stackId: i.stack_id } : {}) };
const v4 = (id: number, count: number, stackId?: number, nbtItems?: unknown[]): ItemV4 => {
  const base: ItemV4 = { network_id: id, count, metadata: 0, has_stack_id: stackId !== undefined, ...(stackId !== undefined ? { stack_id: stackId } : {}), block_runtime_id: 0 };
  return nbtItems ? Object.assign(base, { extra: { has_nbt: 1, nbt: { nbt: { value: { Items: { value: { value: nbtItems } } } } } } }) : base;
};
const EMPTY = v4(0, 0);
const POS: Vec3 = { x: 5, y: -60, z: 7 };

class FakeSource {
  readonly sent: { name: string; params: Record<string, unknown> }[] = [];
  private readonly fns = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  onQueue: ((name: string, params: Record<string, unknown>) => void) | undefined;
  on(name: string, fn: (p: Record<string, unknown>) => void): () => void {
    let s = this.fns.get(name);
    if (!s) this.fns.set(name, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }
  queue(name: string, params: Record<string, unknown>): void {
    this.sent.push({ name, params });
    this.onQueue?.(name, params);
  }
  receive(name: string, p: object): void {
    for (const fn of this.fns.get(name) ?? []) fn(p as Record<string, unknown>);
  }
}

/** A container block `block` at POS with `items` (27 or 54 slots); the fake server refuses requests whose container_id is not `accept`. */
function setup(block: string, items: ItemV4[] = [], size = 27, accept = slotTypeForBlock(block)) {
  const src = new FakeSource();
  const inv = new Inventory(toItem, () => 1n);
  const ctr = new Containers(src, inv);
  inv.handleInventoryContent({ window_id: 'inventory', input: [v4(263, 64, 1), v4(263, 10, 2), v4(17, 30, 3), ...Array.from({ length: 33 }, () => EMPTY)] });
  const info = { name: block, stateId: 1, states: {}, hardness: 2.5, solid: true, boxes: [] } as BlockInfo;
  const loop = { state: { pos: { x: 5.5, y: -60, z: 9.5 }, ready: true }, setCommand: () => undefined, waitTicks: () => new Promise<void>((r) => setTimeout(r, 1)) };
  const world = { blockAt: (p: Vec3) => (p.x === POS.x && p.y === POS.y && p.z === POS.z ? info : { ...info, name: 'air' }), chunks: { runtimeIdAt: () => 1 }, inventory: inv };
  const skill = new ChestSkill({ source: src, loop, world, containers: ctr });
  const types: string[] = [];
  let stack = 100;
  src.onQueue = (name, params) => {
    if (name === 'inventory_transaction')
      queueMicrotask(() => {
        src.receive('container_open', { window_id: 3, window_type: 'container', coordinates: POS, runtime_entity_id: -1n });
        inv.handleInventoryContent({ window_id: 3, input: [...items, ...Array.from({ length: size - items.length }, () => EMPTY)] });
      });
    if (name === 'container_close') queueMicrotask(() => src.receive('container_close', { window_id: params.window_id, window_type: 'none', server: false }));
    if (name === 'item_stack_request') {
      const r = (params.requests as { request_id: number; actions: { source: { slot_type: { container_id: string }; slot: number }; destination: { slot_type: { container_id: string }; slot: number } }[] }[])[0]!;
      const a = r.actions[0]!;
      const toWindow = a.destination.slot_type.container_id !== 'hotbar' && a.destination.slot_type.container_id !== 'inventory';
      const windowSide = toWindow ? a.destination : a.source;
      types.push(windowSide.slot_type.container_id);
      queueMicrotask(() => {
        if (windowSide.slot_type.container_id !== accept) {
          src.receive('item_stack_response', { responses: [{ status: 50, request_id: r.request_id }] });
          return;
        }
        const invSlot = toWindow ? a.source.slot : a.destination.slot;
        const winSlot = toWindow ? a.destination.slot : a.source.slot;
        const resp: StackResponse = {
          status: 'ok',
          request_id: r.request_id,
          containers: [
            { slot_type: { container_id: invSlot < 9 ? 'hotbar' : 'inventory' }, slots: [{ slot: invSlot, hotbar_slot: invSlot, count: inv.slots[invSlot]?.count ?? 0, item_stack_id: ++stack }] },
            { slot_type: { container_id: accept }, slots: [{ slot: winSlot, hotbar_slot: winSlot, count: inv.window(3)?.slots[winSlot]?.count ?? 0, item_stack_id: ++stack }] },
          ],
        };
        src.receive('item_stack_response', { responses: [resp] });
      });
    }
  };
  return { src, inv, ctr, skill, types };
}

describe('slot types by block kind (Track AG)', () => {
  it('chest container, barrel barrel, shulker boxes shulker; every one is a container block', () => {
    expect(slotTypeForBlock('chest')).toBe('container');
    expect(slotTypeForBlock('trapped_chest')).toBe('container');
    expect(slotTypeForBlock('barrel')).toBe('barrel');
    expect(slotTypeForBlock('minecraft:barrel')).toBe('barrel');
    expect(slotTypeForBlock('undyed_shulker_box')).toBe('shulker');
    expect(slotTypeForBlock('red_shulker_box')).toBe('shulker');
    for (const n of ['chest', 'trapped_chest', 'barrel', 'undyed_shulker_box', 'black_shulker_box']) expect(CONTAINER_BLOCKS.has(n)).toBe(true);
    expect(isShulkerBox('minecraft:lime_shulker_box')).toBe(true);
    expect(isShulkerBox('chest')).toBe(false);
  });

  it('Containers: the per-window slot type wins over chestSlotType and is dropped when the window closes', () => {
    const s = setup('chest');
    expect(s.ctr.slotTypeOf(3)).toBe('container');
    s.ctr.setSlotType(3, 'barrel');
    expect(s.ctr.slotInfo({ window: 3, slot: 4 }, 9)).toEqual({ slot_type: { container_id: 'barrel' }, slot: 4, stack_id: 9 });
    expect(s.ctr.slotInfo({ window: 0, slot: 4 }, 9)).toEqual({ slot_type: { container_id: 'hotbar' }, slot: 4, stack_id: 9 });
    s.src.receive('container_close', { window_id: 3, window_type: 'none', server: true });
    expect(s.ctr.slotTypeOf(3)).toBe('container');
  });

  it('a refused request does not undo what the server wrote into a slot meanwhile (an item picked up there)', async () => {
    const src = new FakeSource();
    const inv = new Inventory(toItem, () => 1n);
    const ctr = new Containers(src, inv);
    inv.handleInventoryContent({ window_id: 'inventory', input: [v4(263, 64, 1), ...Array.from({ length: 35 }, () => EMPTY)] });
    const p = ctr.move({ window: 0, slot: 0 }, { window: 0, slot: 1 }, 16);
    expect(inv.slots[1]?.count).toBe(16);
    // the server puts a picked-up box into slot 1 before it answers the request with an error
    inv.handleInventorySlot({ window_id: 0, slot: 1, item: v4(900, 1, 50, [{ Name: { value: 'minecraft:coal' }, Count: { value: 3 } }]) });
    src.receive('item_stack_response', { responses: [{ status: 50, request_id: -1 }] });
    expect(await p).toMatchObject({ ok: false, reason: 'error' });
    expect(inv.slots[0]?.count).toBe(64); // the source is restored
    expect(inv.slots[1]?.name).toBe('undyed_shulker_box'); // the server's write stays
    expect(shulkerSlotsUsed(inv.rawItem(0, 1))).toBe(1);
  });

  it('an ok response refills a slot another request emptied meanwhile (the item kind from the prediction)', async () => {
    const src = new FakeSource();
    const inv = new Inventory(toItem, () => 1n);
    const ctr = new Containers(src, inv);
    inv.handleInventoryContent({ window_id: 'inventory', input: [...Array.from({ length: 31 }, () => EMPTY), v4(4, 16, 7), ...Array.from({ length: 4 }, () => EMPTY)] });
    const p = ctr.move({ window: 0, slot: 31 }, { window: 0, slot: 1 }, 16);
    inv.setItem(0, 1, null); // e.g. a refused request's rollback that had aimed at slot 1 too
    src.receive('item_stack_response', {
      responses: [
        {
          status: 'ok',
          request_id: -1,
          containers: [
            { slot_type: { container_id: 'inventory' }, slots: [{ slot: 31, hotbar_slot: 31, count: 0 }] },
            { slot_type: { container_id: 'hotbar' }, slots: [{ slot: 1, hotbar_slot: 1, count: 16, item_stack_id: 9 }] },
          ],
        },
      ],
    });
    expect((await p).ok).toBe(true);
    expect(inv.slots[1]).toMatchObject({ name: 'unknown:4', count: 16, stackId: 9 });
    expect(inv.slots[31]).toBeNull();
  });

  it('opening a barrel addresses its slots as `barrel` (the server refuses `container`)', async () => {
    const s = setup('barrel', [v4(3, 5, 7)]);
    const o = await s.skill.open(POS);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.block).toBe('barrel');
    const r = await s.skill.depositSlots(o.view, [{ slot: 1, count: 10, name: 'coal' }]);
    expect(r).toMatchObject({ ok: true, total: 10, moved: { coal: 10 }, requests: 1, errors: 0 });
    expect(s.types).toEqual(['barrel']);
    await s.skill.close(o.view.id);
  });

  it('opening a shulker box addresses its slots as `shulker`', async () => {
    const s = setup('undyed_shulker_box');
    const o = await s.skill.open(POS);
    if (!o.ok) throw new Error(o.reason);
    await s.skill.depositSlots(o.view, [{ slot: 2, count: 30 }]);
    expect(s.types).toEqual(['shulker']);
  });
});

describe('snapshot, depositSlots, take (Track AG)', () => {
  it('snapshotOf: counts, free slots, partial room, double chest, empty and full shulker boxes', () => {
    const slots: (ItemStack | null)[] = Array.from({ length: 54 }, () => null);
    slots[0] = { name: 'coal', count: 20, networkId: 263, metadata: 0 };
    slots[1] = { name: 'coal', count: 64, networkId: 263, metadata: 0 };
    slots[2] = { name: 'undyed_shulker_box', count: 1, networkId: 900, metadata: 0 };
    slots[3] = { name: 'undyed_shulker_box', count: 1, networkId: 900, metadata: 0 };
    const raw = (i: number) => (i === 3 ? v4(900, 1, 1, [{ Name: { value: 'minecraft:cobblestone' }, Count: { value: 64 } }, { Name: { value: 'minecraft:cobblestone' }, Count: { value: 10 } }]) : undefined);
    const s = snapshotOf(slots, raw);
    expect(s).toEqual({ size: 54, counts: { coal: 84, undyed_shulker_box: 2 }, stacks: 4, free: 50, double: true, room: { coal: 44 }, boxes: { empty: 1, full: 1 } });
    expect(shulkerSlotsUsed(raw(3))).toBe(2);
    expect(shulkerContents(raw(3))).toEqual({ cobblestone: 74 });
    expect(shulkerContents(undefined)).toEqual({});
  });

  it('depositSlots moves exactly the counts asked, onto the partial stack first; skips a slot that changed', async () => {
    const s = setup('chest', [v4(263, 60, 7)]);
    const o = await s.skill.open(POS);
    if (!o.ok) throw new Error(o.reason);
    const r = await s.skill.depositSlots(o.view, [
      { slot: 0, count: 40, name: 'coal' },
      { slot: 2, count: 5, name: 'dirt' }, // slot 2 holds oak_log: skipped
    ]);
    expect(r).toMatchObject({ ok: true, total: 40, moved: { coal: 40 }, requests: 2 });
    expect(s.inv.window(3)!.slots[0]?.count).toBe(64);
    expect(s.inv.window(3)!.slots[1]?.count).toBe(36);
    expect(s.inv.slots[0]?.count).toBe(24);
    expect(s.skill.snapshot(o.view)).toMatchObject({ counts: { coal: 100 }, free: 25 });
  });

  it('a whole stack moved into an empty slot keeps its wire item (a full box stays full in the snapshot)', async () => {
    const s = setup('chest');
    s.inv.handleInventorySlot({ window_id: 0, slot: 4, item: v4(900, 1, 9, [{ Name: { value: 'minecraft:coal' }, Count: { value: 64 } }]) });
    const o = await s.skill.open(POS);
    if (!o.ok) throw new Error(o.reason);
    await s.skill.depositSlots(o.view, [{ slot: 4, count: 1 }]);
    expect(s.skill.snapshot(o.view)?.boxes).toEqual({ empty: 0, full: 1 });
    expect(shulkerContents(s.inv.rawItem(3, 0))).toEqual({ coal: 64 });
  });

  it('take moves a window slot into the preferred empty inventory slot', async () => {
    const s = setup('chest', [EMPTY, v4(900, 1, 8)]);
    const o = await s.skill.open(POS);
    if (!o.ok) throw new Error(o.reason);
    const t = await s.skill.take(o.view, 1, 1, [5, 6]);
    expect(t).toEqual({ ok: true, moved: 1, to: 5 });
    expect(s.inv.slots[5]?.name).toBe('undyed_shulker_box');
    expect(s.inv.window(3)!.slots[1]).toBeNull();
    expect(await s.skill.take(o.view, 1)).toMatchObject({ ok: false, reason: 'empty_source' });
  });
});
