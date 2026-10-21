// Containers (world/containers.ts) and the chest skill (skills/container/chest.ts), PLAN.md task 4.5,
// against a fake packet source: window tracking, item_stack_request prediction / reconciliation /
// rollback, the exact packet shapes (serialised with the real 1.26.60 serializer), open / deposit /
// close.
import { describe, expect, it } from 'vitest';
import { createDeserializer, createSerializer } from '../../../src/connection/protocol.ts';
import { ChestSkill, clickBlockTransaction, clickPoint, maxStackOf } from '../../../src/skills/container/chest.ts';
import { FACE } from '../../../src/skills/dig/look.ts';
import { Containers, type StackResponse } from '../../../src/world/containers.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const NAMES: Record<number, string> = { 17: 'oak_log', 3: 'dirt', 54: 'chest', 300: 'stone_axe' };
const toItem = (i: ItemV4): ItemStack | null =>
  i.network_id === 0 ? null : { name: NAMES[i.network_id] ?? `unknown:${i.network_id}`, networkId: i.network_id, count: i.count, metadata: i.metadata, ...(i.stack_id !== undefined ? { stackId: i.stack_id } : {}) };
const v4 = (id: number, count: number, stackId?: number): ItemV4 => ({ network_id: id, count, metadata: 0, has_stack_id: stackId !== undefined, ...(stackId !== undefined ? { stack_id: stackId } : {}), block_runtime_id: 0 });
const EMPTY = v4(0, 0);

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

function setup() {
  const src = new FakeSource();
  const inv = new Inventory(toItem, () => 1n);
  const ctr = new Containers(src, inv);
  // the player inventory and an open chest (window 2)
  inv.handleInventoryContent({ window_id: 'inventory', input: [v4(17, 10, 1), v4(3, 5, 2), ...Array.from({ length: 34 }, () => EMPTY)] });
  return { src, inv, ctr };
}

function openChest(s: ReturnType<typeof setup>, items: ItemV4[] = []): void {
  s.src.receive('container_open', { window_id: 2, window_type: 'container', coordinates: { x: 5, y: -60, z: 7 }, runtime_entity_id: -1n });
  // (the World feeds inventory_content to the Inventory; here the test does)
  s.inv.handleInventoryContent({ window_id: 2, input: [...items, ...Array.from({ length: 27 - items.length }, () => EMPTY)] });
}

const okResponse = (requestId: number, srcSlot: number, srcCount: number, dstSlot: number, dstCount: number, dstStack: number): StackResponse => ({
  status: 'ok',
  request_id: requestId,
  containers: [
    { slot_type: { container_id: 'hotbar' }, slots: [{ slot: srcSlot, hotbar_slot: srcSlot, count: srcCount, ...(srcCount ? { item_stack_id: 40 } : {}) }] },
    { slot_type: { container_id: 'container' }, slots: [{ slot: dstSlot, hotbar_slot: dstSlot, count: dstCount, item_stack_id: dstStack }] },
  ],
});

describe('Containers', () => {
  it('tracks container_open / container_close', () => {
    const s = setup();
    const seen: number[] = [];
    s.ctr.onOpen((c) => seen.push(c.id));
    openChest(s);
    expect(s.ctr.open).toMatchObject({ id: 2, type: 'container', pos: { x: 5, y: -60, z: 7 } });
    expect(seen).toEqual([2]);
    expect(s.inv.window(2)?.slots.length).toBe(27);
    s.src.receive('container_close', { window_id: 2, window_type: 'none', server: false });
    expect(s.ctr.open).toBeUndefined();
    expect(s.inv.window(2)).toBeUndefined();
    expect(s.inv.window(0)).toBeDefined();
  });

  it('move: one place action with the server stack ids, predicted at once, reconciled from the response', async () => {
    const s = setup();
    openChest(s);
    const p = s.ctr.move({ window: 0, slot: 0 }, { window: 2, slot: 0 }, 10);
    // prediction
    expect(s.inv.slots[0]).toBeNull();
    expect(s.inv.window(2)?.slots[0]).toMatchObject({ name: 'oak_log', count: 10 });
    const req = s.src.sent.at(-1)!;
    expect(req.name).toBe('item_stack_request');
    expect(req.params).toEqual({
      requests: [
        {
          request_id: -1,
          actions: [
            {
              type_id: 'place',
              legacy_type_id: 1,
              count: 10,
              source: { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 1 },
              destination: { slot_type: { container_id: 'container' }, slot: 0, stack_id: 0 },
            },
          ],
          custom_names: [],
          cause: 'chat_public',
        },
      ],
    });
    s.src.receive('item_stack_response', { responses: [okResponse(-1, 0, 0, 0, 10, 6)] });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(s.inv.window(2)?.slots[0]).toMatchObject({ name: 'oak_log', count: 10, stackId: 6 });
    // next request id
    void s.ctr.move({ window: 0, slot: 1 }, { window: 2, slot: 1 }, 1, 5).catch(() => undefined);
    expect((s.src.sent.at(-1)!.params.requests as { request_id: number }[])[0]!.request_id).toBe(-3);
  });

  it('slots 9..35 are addressed as "inventory"; an error response rolls the prediction back', async () => {
    const s = setup();
    s.inv.handleInventorySlot({ window_id: 0, slot: 12, item: v4(17, 4, 9) });
    openChest(s, [v4(17, 60, 5)]);
    const p = s.ctr.move({ window: 0, slot: 12 }, { window: 2, slot: 0 }, 4);
    const action = (s.src.sent.at(-1)!.params.requests as { actions: Record<string, unknown>[] }[])[0]!.actions[0]!;
    expect(action.source).toEqual({ slot_type: { container_id: 'inventory' }, slot: 12, stack_id: 9 });
    expect(action.destination).toEqual({ slot_type: { container_id: 'container' }, slot: 0, stack_id: 5 });
    expect(s.inv.window(2)?.slots[0]?.count).toBe(64);
    s.src.receive('item_stack_response', { responses: [{ status: 'error', request_id: -1 }] });
    const r = await p;
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(s.inv.slots[12]).toMatchObject({ name: 'oak_log', count: 4 });
    expect(s.inv.window(2)?.slots[0]).toMatchObject({ count: 60, stackId: 5 });
  });

  it('times out without a response (rolled back) and refuses impossible moves', async () => {
    const s = setup();
    openChest(s, [v4(3, 1, 7)]);
    expect(await s.ctr.move({ window: 0, slot: 0 }, { window: 2, slot: 0 }, 1)).toMatchObject({ ok: false, reason: 'bad_destination' });
    expect(await s.ctr.move({ window: 0, slot: 5 }, { window: 2, slot: 1 }, 1)).toMatchObject({ ok: false, reason: 'empty_source' });
    expect(await s.ctr.move({ window: 0, slot: 0 }, { window: 9, slot: 1 }, 1)).toMatchObject({ ok: false, reason: 'no_window' });
    const r = await s.ctr.move({ window: 0, slot: 0 }, { window: 2, slot: 1 }, 3, 20);
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(s.inv.slots[0]).toMatchObject({ count: 10 });
    expect(s.inv.window(2)?.slots[1]).toBeNull();
  });

  it('the request and the click transaction serialise with the 1.26.60 protocol and read back unchanged', () => {
    const ser = createSerializer('1.26.60');
    const de = createDeserializer('1.26.60');
    const s = setup();
    openChest(s);
    void s.ctr.move({ window: 0, slot: 0 }, { window: 2, slot: 3 }, 7, 10).catch(() => undefined);
    const req = s.src.sent.at(-1)!;
    const back = de.parsePacketBuffer(ser.createPacketBuffer({ name: req.name, params: req.params })) as { data: { name: string; params: unknown } };
    expect(back.data.name).toBe('item_stack_request');
    expect(back.data.params).toMatchObject(req.params);
    const tx = clickBlockTransaction({ pos: { x: 5, y: -60, z: 7 }, face: FACE.south, hotbarSlot: 0, held: undefined, eye: { x: 5.5, y: -58.38, z: 9.5 }, blockRuntimeId: 1234 });
    const txBack = de.parsePacketBuffer(ser.createPacketBuffer({ name: 'inventory_transaction', params: tx })) as unknown as { data: { params: { transaction: Record<string, unknown> } } };
    expect(txBack.data.params.transaction).toMatchObject({
      transaction_type: 'item_use',
      transaction_data: { action_type: 'click_block', block_position: { x: 5, y: -60, z: 7 }, face: 3, click_pos: { x: 0.5, y: 0.5, z: 1 }, block_runtime_id: 1234, held_item: { network_id: 0 } },
    });
  });
});

describe('ChestSkill', () => {
  const CHEST: Vec3 = { x: 5, y: -60, z: 7 };
  const chestInfo = { name: 'chest', stateId: 1, states: {}, hardness: 2.5, solid: true, boxes: [] } as BlockInfo;

  function chestSetup(feet: Vec3 = { x: 5.5, y: -60, z: 9.5 }) {
    const s = setup();
    const loop = { state: { pos: feet, ready: true }, setCommand: () => undefined, waitTicks: () => new Promise<void>((r) => setTimeout(r, 1)) };
    const world = {
      blockAt: (p: Vec3) => (p.x === CHEST.x && p.y === CHEST.y && p.z === CHEST.z ? chestInfo : ({ ...chestInfo, name: 'air' })),
      chunks: { runtimeIdAt: () => 4242 },
      inventory: s.inv,
    };
    const skill = new ChestSkill({ source: s.src, loop, world, containers: s.ctr });
    // the "server": open on the click, answer requests ok, close on close
    let stack = 100;
    s.src.onQueue = (name, params) => {
      if (name === 'inventory_transaction') queueMicrotask(() => openChest(s));
      if (name === 'container_close') queueMicrotask(() => s.src.receive('container_close', { window_id: params.window_id, window_type: 'none', server: false }));
      if (name === 'item_stack_request') {
        const r = (params.requests as { request_id: number; actions: { count: number; source: { slot: number }; destination: { slot: number } }[] }[])[0]!;
        const a = r.actions[0]!;
        queueMicrotask(() => {
          const src = s.inv.slots[a.source.slot]?.count ?? 0;
          const dst = s.inv.window(2)?.slots[a.destination.slot]?.count ?? 0;
          s.src.receive('item_stack_response', { responses: [okResponse(r.request_id, a.source.slot, src, a.destination.slot, dst, ++stack)] });
        });
      }
    };
    return { ...s, skill };
  }

  it('open sends click_block on the face the bot sees, waits for the window; deposit + close', async () => {
    const s = chestSetup();
    const o = await s.skill.open(CHEST);
    expect(o.ok).toBe(true);
    const tx = s.src.sent.find((x) => x.name === 'inventory_transaction')!.params as { transaction: { transaction_data: Record<string, unknown> } };
    expect(tx.transaction.transaction_data).toMatchObject({ action_type: 'click_block', block_position: CHEST, face: FACE.south, block_runtime_id: 4242, hotbar_slot: 0 });
    if (!o.ok) return;
    const d = await s.skill.deposit(o.view, (i) => i.name === 'oak_log');
    expect(d).toMatchObject({ ok: true, total: 10, moved: { oak_log: 10 }, errors: 0 });
    expect(s.inv.count('oak_log')).toBe(0);
    expect(s.inv.count('dirt')).toBe(5);
    expect(await s.skill.close(o.view.id)).toBe(true);
    expect(s.ctr.open).toBeUndefined();
  });

  it('deposit fills partial stacks first and reports container_full', async () => {
    const s = chestSetup();
    s.inv.handleInventorySlot({ window_id: 0, slot: 0, item: v4(17, 64, 1) });
    s.inv.handleInventorySlot({ window_id: 0, slot: 2, item: v4(17, 30, 3) });
    const o = await s.skill.open(CHEST);
    if (!o.ok) throw new Error(o.reason);
    // replace the chest contents: one partial log stack, the rest full of dirt
    s.inv.handleInventoryContent({ window_id: 2, input: [v4(17, 50, 70), ...Array.from({ length: 25 }, () => v4(3, 64, 71)), EMPTY] });
    const d = await s.skill.deposit(s.inv.window(2)!, (i) => i.name === 'oak_log');
    // 14 onto the partial stack, 50 + 30 into the one empty slot would need 2 slots: 64 fit, 30 do not
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('container_full');
    expect(d.total).toBe(14 + 64);
    expect(s.inv.count('oak_log')).toBe(94 - 78);
  });

  it('refuses non-containers and far chests', async () => {
    const s = chestSetup({ x: 5.5, y: -60, z: 15.5 });
    expect(await s.skill.open(CHEST)).toEqual({ ok: false, reason: 'unreachable' });
    expect((await s.skill.open({ x: 0, y: -60, z: 0 })).ok).toBe(false);
  });

  it('click points and stack sizes', () => {
    expect(clickPoint(FACE.up)).toEqual({ x: 0.5, y: 1, z: 0.5 });
    expect(clickPoint(FACE.west)).toEqual({ x: 0, y: 0.5, z: 0.5 });
    expect(maxStackOf('oak_log')).toBe(64);
    expect(maxStackOf('minecraft:stone_axe')).toBe(1);
    expect(maxStackOf('no_such_item')).toBe(64);
  });
});
