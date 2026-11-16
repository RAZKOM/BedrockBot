// Track V1 (ADR 0090, docs/inventory.md "A full inventory and the hotbar"): the two silent full-inventory faults. The farm's
// click (and the place skill's selectItem, in place-skill.test.ts) brings an item from the main inventory into a full
// hotbar by parking a hotbar item in a free main slot; with 36 of 36 there is none, and the fetch failed with
// `move_failed` and said nothing. Now the wanted item and the hotbar item that would have been parked exchange places by
// the survival kit's exchange (registered under the inventory model: container/exchange.ts); with no exchange the
// failure is said in the log, once a minute an item and reason.
import { describe, expect, it } from 'vitest';
import { exchangeFor, RateLimit, setExchange } from '../../../src/skills/container/exchange.ts';
import { ItemClicker } from '../../../src/skills/farm/click.ts';
import { hotbarRoom, noRoomText } from '../../../src/skills/place/place.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const ITEMS: Record<number, string> = { 4: 'cobblestone', 280: 'stick', 351: 'bone_meal', 257: 'iron_pickaxe' };
const toItem = (i: ItemV4): ItemStack | null => (i.network_id === 0 ? null : { name: ITEMS[i.network_id] ?? `unknown:${i.network_id}`, networkId: i.network_id, count: i.count, metadata: i.metadata, ...(i.stack_id !== undefined ? { stackId: i.stack_id } : {}) });
const v4 = (id: number, count: number, stackId: number): ItemV4 => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: stackId, block_runtime_id: 0 });
const EMPTY: ItemV4 = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 };

/** A clicker on a full inventory (sticks in the hotbar, cobblestone in the main inventory, bone meal in slot 20). */
function setup(slots: (ItemV4 | undefined)[]) {
  const inv = new Inventory(toItem, () => 1n);
  inv.handleInventoryContent({ window_id: 'inventory', input: Array.from({ length: 36 }, (_, i) => slots[i] ?? EMPTY) });
  const p: Vec3 = { x: 1, y: 0, z: 0 };
  let block: BlockInfo = blockInfoOf('grass_block');
  const fns = new Set<(q: Vec3, b: BlockInfo | undefined, a: BlockInfo) => void>();
  const pending: (() => void)[] = [];
  const loop = {
    state: { pos: { x: 0.5, y: 0, z: 0.5 }, tick: 0n, ready: true },
    setCommand: () => undefined,
    waitTicks: async (n: number) => {
      for (let i = 0; i < n; i++) {
        loop.state.tick++;
        for (const f of pending.splice(0)) f();
        await Promise.resolve();
      }
    },
  };
  const sent: string[] = [];
  const moves: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const clicker = new ItemClicker({
    source: {
      queue: (name: string, params: object) => {
        sent.push(name);
        if (name !== 'inventory_transaction') return;
        const slot = (params as { transaction: { transaction_data: { hotbar_slot: number } } }).transaction.transaction_data.hotbar_slot;
        sent.push(`held ${inv.slots[slot]?.name} in ${slot}`);
        pending.push(() => {
          const before = block;
          block = blockInfoOf('dirt');
          for (const f of [...fns]) f(p, before, block);
        });
      },
    },
    loop,
    world: { blockAt: () => block, onBlockUpdate: (fn) => (fns.add(fn), () => fns.delete(fn)), chunks: { runtimeIdAt: () => 1 }, inventory: inv },
    hotbar: { select: (s) => (inv.select(s), true), rawItem: (s) => inv.rawItem(0, s) },
    containers: {
      move: (src, dst) => {
        moves.push(`move ${src.slot}->${dst.slot}`);
        if (inv.slots[dst.slot]) return Promise.resolve({ ok: false, reason: 'bad_destination' });
        inv.setItem(0, dst.slot, inv.slots[src.slot]!);
        inv.setItem(0, src.slot, null);
        return Promise.resolve({ ok: true });
      },
    },
    logger: { debug() {}, info: (m: string) => infos.push(m), warn: (m: string) => warns.push(m), error() {} },
  });
  const swap = (a: number, b: number): Promise<{ ok: boolean; reason?: string }> => {
    moves.push(`swap ${a}<->${b}`);
    const x = inv.slots[a] ?? null;
    inv.setItem(0, a, inv.slots[b] ?? null);
    inv.setItem(0, b, x);
    return Promise.resolve({ ok: true });
  };
  return { inv, clicker, p, sent, moves, warns, infos, swap };
}

const full = (): (ItemV4 | undefined)[] => {
  const s = Array.from({ length: 36 }, (_, i) => (i < 9 ? v4(280, 1, i + 1) : v4(4, 64, 100 + i)));
  s[0] = v4(257, 1, 1); // a tool in the selected slot
  s[20] = v4(351, 12, 50);
  return s;
};

describe('the farm click with a full inventory', () => {
  it('before (no exchange): move_failed, said once a minute, nothing moved', async () => {
    const e = setup(full());
    expect(exchangeFor(e.inv)).toBeUndefined();
    expect(await e.clicker.useOn(e.p, 'bone_meal')).toMatchObject({ ok: false, reason: 'move_failed' });
    expect(await e.clicker.useOn(e.p, 'bone_meal')).toMatchObject({ ok: false, reason: 'move_failed' });
    expect(e.warns).toEqual(['click: no hotbar slot for bone_meal (slot 20): the inventory is full (36 of 36) and no exchange is wired']);
    expect(e.moves).toEqual([]);
    expect(e.sent).toEqual([]);
  });

  it('after: the bone meal and the hotbar\'s least useful item exchange places, then the click', async () => {
    const e = setup(full());
    setExchange(e.inv, e.swap);
    try {
      const r = await e.clicker.useOn(e.p, 'bone_meal');
      expect(r).toMatchObject({ ok: true, slot: 8 });
      expect(e.moves).toEqual(['swap 20<->8']); // the highest stick, never the selected pickaxe
      expect(e.inv.slots[8]?.name).toBe('bone_meal');
      expect(e.inv.slots[20]?.name).toBe('stick');
      expect(e.sent).toContain('held bone_meal in 8');
      expect(e.infos.some((m) => m === 'click: bone_meal moved from slot 20 to 8 (stick exchanged into 20: the inventory is full)')).toBe(true);
      // every item is still there
      const count = (n: string) => e.inv.slots.reduce((a, s) => a + (s?.name === n ? s.count : 0), 0);
      expect([count('bone_meal'), count('stick'), count('cobblestone'), count('iron_pickaxe')]).toEqual([12, 8, 26 * 64, 1]);
    } finally {
      setExchange(e.inv, undefined);
    }
  });

  it('with a free main slot the park is as before (no exchange asked)', async () => {
    const s = full();
    s[30] = undefined;
    const e = setup(s);
    setExchange(e.inv, e.swap);
    try {
      expect(await e.clicker.useOn(e.p, 'bone_meal')).toMatchObject({ ok: true, slot: 8 });
      expect(e.moves).toEqual(['move 8->30', 'move 20->8']);
    } finally {
      setExchange(e.inv, undefined);
    }
  });
});

describe('hotbarRoom and the rate limit', () => {
  const it8 = (name: string): ItemStack => ({ name, networkId: 1, count: 1, metadata: 0 });
  it('exchange only when asked and no main slot is free; never a wanted item', () => {
    const slots: (ItemStack | null)[] = Array.from({ length: 36 }, (_, i) => it8(i < 9 ? 'stick' : 'cobblestone'));
    expect(hotbarRoom(slots, 0, 20, () => false)).toBeUndefined();
    expect(hotbarRoom(slots, 0, 20, () => false, true)).toEqual({ dst: 8, exchange: true });
    expect(hotbarRoom(slots, 8, 20, () => false, true)).toEqual({ dst: 7, exchange: true }); // the selected slot last
    expect(hotbarRoom(slots, 0, 20, (i) => i.name === 'stick', true)).toBeUndefined(); // every hotbar item is wanted
    slots[25] = null;
    expect(hotbarRoom(slots, 0, 20, () => false, true)).toEqual({ dst: 8, park: 25 });
    expect(noRoomText(Array.from({ length: 36 }, () => it8('stick')), false)).toBe('the inventory is full (36 of 36) and no exchange is wired');
  });

  it('once a minute a key', () => {
    let t = 0;
    const r = new RateLimit(60_000, () => t);
    expect(r.ok('a')).toBe(true);
    expect(r.ok('a')).toBe(false);
    expect(r.ok('b')).toBe(true);
    t = 59_999;
    expect(r.ok('a')).toBe(false);
    t = 60_000;
    expect(r.ok('a')).toBe(true);
  });
});
