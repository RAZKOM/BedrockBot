// Track P1 (world/resync.ts, docs/versions.md "Packets the bot cannot read"): the inventory model after a packet the
// bot could not read. A lost inventory packet marks the model unsure and asks the server for the whole inventory (an
// inventory_mismatch transaction); the next full inventory_content makes it sure; stack requests wait for that, and a
// request that got no response after a loss is answered `lost`, and the server's inventory is asked for again after the
// caller's rollback. On the Realm (2026-11-16) a lost item_stack_response left the model with a box swap rolled back
// that the server had done.
import { describe, expect, it } from 'vitest';
import { swapSlots } from '../../../src/chat/commands-fly.ts';
import { sameStack } from '../../../src/skills/survival/index.ts';
import { StackRequests, inventorySlot } from '../../../src/skills/survival/screen.ts';
import { Containers } from '../../../src/world/containers.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import { INVENTORY_PACKETS, InventoryResync, mismatchTransaction, RESYNC_TRIES, RESYNC_WAIT_MS, touchesInventory } from '../../../src/world/resync.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const BOX = 205;
const DIRT = 3;
const NAMES: Record<number, string> = { [BOX]: 'green_shulker_box', [DIRT]: 'dirt' };
const wire = (id: number, count: number, stackId: number): ItemV4 => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: stackId, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } }) as ItemV4;
const AIR = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } } as ItemV4;
const toItem = (i: ItemV4): ItemStack | null => (i.network_id === 0 ? null : { name: NAMES[i.network_id] ?? '?', networkId: i.network_id, count: i.count, metadata: 0, ...(i.stack_id !== undefined ? { stackId: i.stack_id } : {}) });

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
  named(name: string) {
    return this.sent.filter((s) => s.name === name);
  }
  receive(name: string, p: object): void {
    for (const fn of [...(this.fns.get(name) ?? [])]) fn(p as Record<string, unknown>);
  }
}

/** A tick loop on a fake clock (50 ms a tick) with a per-tick hook (the fake server). */
class Clock {
  t = 0;
  tick = 0;
  onTick: ((n: number) => void) | undefined;
  readonly now = () => this.t;
  async waitTicks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.tick++;
      this.t += 50;
      this.onTick?.(this.tick);
      await Promise.resolve();
    }
  }
}

function setup(slots: Record<number, ItemV4> = { 3: wire(BOX, 1, 11), 17: wire(BOX, 1, 22) }) {
  const src = new FakeSource();
  const clock = new Clock();
  const inv = new Inventory(toItem, () => 1n);
  const content = (s: Record<number, ItemV4>) => inv.handleInventoryContent({ window_id: 'inventory', input: Array.from({ length: 36 }, (_, i) => s[i] ?? AIR) });
  content(slots);
  const infos: string[] = [];
  const warns: string[] = [];
  const resync = new InventoryResync({ source: src, inventory: inv, now: clock.now, logger: { debug() {}, info: (m: string) => infos.push(m), warn: (m: string) => warns.push(m), error() {} } });
  const containers = { open: undefined, onOpen: () => () => undefined, onClose: () => () => undefined, close: () => undefined };
  const requests = new StackRequests({ source: src, containers, loop: clock, runtimeId: () => 1n, inventory: inv });
  return { src, clock, inv, content, resync, requests, infos, warns };
}

describe('the resync rule (Track P1)', () => {
  it('which lost packets touch the inventory: the inventory packets and an id without a name, not chat', () => {
    expect(touchesInventory({ name: 'item_stack_response' })).toBe(true);
    expect(touchesInventory({ id: 999 })).toBe(true);
    expect(touchesInventory({ name: 'text' })).toBe(false);
    expect(touchesInventory({ name: 'level_chunk' })).toBe(false);
    for (const n of ['inventory_content', 'inventory_slot', 'inventory_transaction', 'container_open']) expect(INVENTORY_PACKETS.has(n)).toBe(true);
    expect(mismatchTransaction()).toEqual({ transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'inventory_mismatch', actions: [] } });
  });

  it('a lost item_stack_response: unsure, the whole inventory asked for at once; sure again with the next inventory_content', () => {
    const s = setup();
    s.resync.lost({ id: 148, name: 'item_stack_response' });
    expect(s.inv.unsure).toBe('unreadable item_stack_response');
    expect(s.inv.lostPackets).toBe(1);
    expect(s.src.named('inventory_transaction').map((x) => x.params)).toEqual([mismatchTransaction()]);
    s.clock.t += 90;
    s.content({ 3: wire(BOX, 1, 22), 17: wire(BOX, 1, 11) });
    expect(s.inv.unsure).toBeUndefined();
    expect(s.resync.stats).toMatchObject({ lost: 1, asked: 1, resynced: 1, lastMs: 90 });
    expect(s.infos).toEqual(['inventory: unreadable item_stack_response; asked the server for the whole inventory (try 1 of 3)', 'inventory: resynced 90 ms after asking (unreadable item_stack_response)']);
    // a chat packet lost: nothing
    s.resync.lost({ id: 9, name: 'text' });
    expect(s.inv.unsure).toBeUndefined();
    expect(s.src.named('inventory_transaction')).toHaveLength(1);
  });

  it('two losses in one wait: one request; no answer: asked again every 3 s, then the model is used as it is', () => {
    const s = setup();
    s.resync.lost({ name: 'inventory_slot' });
    s.resync.lost({ name: 'item_stack_response' });
    expect(s.src.named('inventory_transaction')).toHaveLength(1);
    for (let k = 0; k < RESYNC_TRIES; k++) {
      s.clock.t += RESYNC_WAIT_MS;
      s.resync.tick();
    }
    expect(s.src.named('inventory_transaction')).toHaveLength(RESYNC_TRIES);
    expect(s.inv.unsure).toBeUndefined();
    expect(s.resync.stats.gaveUp).toBe(1);
    expect(s.warns).toEqual(['inventory: the server sent no inventory after 3 requests (unreadable inventory_slot); the model is used as it is']);
  });

  it('off (the before case): a lost packet changes nothing', () => {
    const s = setup();
    s.resync.enabled = false;
    s.resync.lost({ name: 'item_stack_response' });
    expect(s.inv.unsure).toBeUndefined();
    expect(s.src.sent).toEqual([]);
  });

  it('a request waits for an unsure model to be resynced before it goes out', async () => {
    const s = setup();
    s.resync.lost({ name: 'inventory_slot' });
    s.clock.onTick = (n) => {
      if (n === 3) s.content({ 3: wire(BOX, 1, 11), 17: wire(BOX, 1, 22) });
      for (const r of s.src.named('item_stack_request')) {
        const id = (r.params.requests as { request_id: number }[])[0]!.request_id;
        s.src.receive('item_stack_response', { responses: [{ status: 'ok', request_id: id }] });
      }
    };
    const r = await s.requests.send([{ type_id: 'swap' }]);
    expect(r.status).toBe('ok');
    expect(s.clock.tick).toBeGreaterThanOrEqual(3);
    expect(s.clock.tick).toBeLessThan(10);
  });

  it('the swap\'s response lost: `lost` as soon as the server\'s inventory is back, the rollback undone by asking again (the flight kit\'s swap)', async () => {
    const s = setup();
    // the server: the swap done; its response unreadable (the Connection tells the resync); the inventory 2 ticks later
    s.clock.onTick = (n) => {
      if (n === 2) s.resync.lost({ id: 148, name: 'item_stack_response' });
      if (n === 4 || s.src.named('inventory_transaction').length === 2) s.content({ 3: wire(BOX, 1, 22), 17: wire(BOX, 1, 11) });
    };
    const before = s.inv.slots[3];
    const r = await swapSlots(s.requests, s.inv, 17, 3);
    // the flight kit's swap rolls back on anything but ok: the model is wrong for a moment...
    expect(r).toEqual({ ok: false, reason: 'the swap was refused (timeout)' });
    expect(s.clock.tick).toBeLessThan(10); // not the 40-tick timeout
    expect(s.inv.slots[3]).toBe(before);
    // ...until the next tick asks for the inventory again and the server's comes back
    await s.clock.waitTicks(2);
    expect(s.src.named('inventory_transaction')).toHaveLength(2);
    expect(s.inv.slots[3]?.stackId).toBe(22);
    expect(s.inv.slots[17]?.stackId).toBe(11);
    expect(s.inv.unsure).toBeUndefined();
  });

  it('no loss: a request without a response times out as before (no lost flag, nothing asked)', async () => {
    const s = setup();
    const r = await s.requests.send([{ type_id: 'swap', source: inventorySlot(17, 22), destination: inventorySlot(3, 11) }], 5);
    expect(r).toEqual({ status: 'timeout', request_id: -100001 });
    await s.clock.waitTicks(2);
    expect(s.src.named('inventory_transaction')).toEqual([]);
  });

  it('Containers.move waits for the resync, and asks again after a timeout that followed a loss', async () => {
    const s = setup({ 9: wire(DIRT, 10, 5) });
    const ctr = new Containers(s.src, s.inv);
    s.resync.lost({ name: 'inventory_slot' });
    const p = ctr.move({ window: 0, slot: 9 }, { window: 0, slot: 0 }, 10, 50);
    expect(s.src.named('item_stack_request')).toHaveLength(0); // not built on the unsure model
    s.content({ 9: wire(DIRT, 10, 5) });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.src.named('item_stack_request')).toHaveLength(1);
    s.resync.lost({ name: 'item_stack_response' });
    const r = await p;
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(s.src.named('inventory_transaction').length).toBeGreaterThanOrEqual(2);
  });

  it('sameStack: name, count, and the stack id when both have one', () => {
    const a = { name: 'green_shulker_box', networkId: BOX, count: 1, metadata: 0, stackId: 11 };
    expect(sameStack(a, { ...a })).toBe(true);
    expect(sameStack(a, { ...a, stackId: 12 })).toBe(false);
    const { stackId: _s, ...noId } = a;
    expect(sameStack(a, noId)).toBe(true);
    expect(sameStack(a, { ...a, count: 2 })).toBe(false);
    expect(sameStack(null, null)).toBe(true);
    expect(sameStack(a, null)).toBe(false);
  });
});
