// collect() (PLAN.md task 4.4) against fakes: nearest item first, pickup on arrival, inventory-full
// detection, unreachable items, filter, cancel and timeout.
import { describe, expect, it } from 'vitest';
import { collectItems, type CollectDeps } from '../../../src/skills/collect/collect.ts';
import type { Goal } from '../../../src/skills/nav/goals.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const NAMES: Record<number, string> = { 17: 'oak_log', 6: 'oak_sapling', 3: 'dirt', 300: 'stone_axe' };
const toItem = (i: ItemV4): ItemStack | null => (i.network_id === 0 ? null : { name: NAMES[i.network_id] ?? `unknown:${i.network_id}`, networkId: i.network_id, count: i.count, metadata: 0 });
const v4 = (id: number, count: number): ItemV4 => ({ network_id: id, count, metadata: 0, has_stack_id: false, block_runtime_id: 0 });

function item(id: bigint, name: string, count: number, pos: Vec3): EntityInfo {
  return { runtimeId: id, uniqueId: id, type: 'minecraft:item', item: { name, networkId: 0, count, metadata: 0 }, pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0 };
}

function fake(opts: { unreachable?: Set<bigint>; pickup?: boolean } = {}) {
  const entities = new Map<bigint, EntityInfo>();
  const inv = new Inventory(toItem, () => 1n);
  const state = { pos: { x: 0.5, y: -60, z: 0.5 }, corrections: 0, tick: 0n };
  const gotos: Goal[] = [];
  let cancelled = false;
  const deps: CollectDeps = {
    entities: () => entities,
    state: () => state,
    waitTicks: (n) => {
      state.tick += BigInt(n);
      return Promise.resolve();
    },
    goto: (g) => {
      gotos.push(g);
      state.tick += 20n;
      if (g.type !== 'near') return Promise.resolve({ ok: false, reason: 'bad' });
      const e = [...entities.values()].find((x) => Math.hypot(x.pos.x - g.p.x, x.pos.z - g.p.z) < 0.01);
      if (e && opts.unreachable?.has(e.runtimeId)) return Promise.resolve({ ok: false, reason: 'unreachable' });
      state.pos = { x: g.p.x, y: -60, z: g.p.z };
      // the server hands over everything within 1.3 blocks that fits
      if (opts.pickup !== false) {
        for (const x of [...entities.values()]) {
          if (Math.hypot(x.pos.x - state.pos.x, x.pos.z - state.pos.z) > 1.3) continue;
          if (inv.room(x.item!.name) <= 0) continue;
          entities.delete(x.runtimeId);
          const id = Number(Object.entries(NAMES).find(([, n]) => n === x.item!.name)![0]);
          const slot = inv.slots.findIndex((s) => s?.name === x.item!.name && s.count + x.item!.count <= 64);
          const free = slot >= 0 ? slot : inv.slots.findIndex((s) => !s);
          inv.handleInventorySlot({ window_id: 0, slot: free, item: v4(id, (inv.slots[free]?.count ?? 0) + x.item!.count) });
        }
      }
      return Promise.resolve(cancelled ? { ok: false, reason: 'interrupted' } : { ok: true });
    },
    inventory: inv,
    cancelled: () => cancelled,
  };
  return { entities, inv, state, gotos, deps, cancel: () => (cancelled = true) };
}

describe('collectItems', () => {
  it('walks to the nearest drop first and picks everything up', async () => {
    const f = fake();
    f.entities.set(1n, item(1n, 'oak_log', 1, { x: 6.2, y: -59.875, z: 0.4 }));
    f.entities.set(2n, item(2n, 'oak_log', 2, { x: 2.1, y: -59.875, z: 1.0 }));
    f.entities.set(3n, item(3n, 'oak_sapling', 1, { x: 3.0, y: -59.875, z: 5.0 }));
    f.entities.set(9n, item(9n, 'oak_log', 5, { x: 40, y: -59.875, z: 0 })); // outside the radius
    const r = await collectItems(8, 400, f.deps);
    expect(r.ok).toBe(true);
    expect(r.gained).toEqual({ oak_log: 3, oak_sapling: 1 });
    expect(r.pickedUp).toBe(3);
    const first = f.gotos[0]!;
    expect(first.type === 'near' && first.p.x).toBe(2.1);
    expect(f.entities.has(9n)).toBe(true);
  });

  it('reports inventory_full when only items that do not fit are left', async () => {
    const f = fake();
    for (let s = 0; s < 36; s++) f.inv.handleInventorySlot({ window_id: 0, slot: s, item: v4(300, 1) });
    f.entities.set(1n, item(1n, 'oak_log', 1, { x: 2, y: -59.875, z: 0 }));
    const r = await collectItems(8, 400, f.deps);
    expect(r).toMatchObject({ ok: false, reason: 'inventory_full' });
    expect(f.gotos).toEqual([]);
  });

  it('an item that fits a partial stack is still collected with a full inventory', async () => {
    const f = fake();
    for (let s = 0; s < 35; s++) f.inv.handleInventorySlot({ window_id: 0, slot: s, item: v4(300, 1) });
    f.inv.handleInventorySlot({ window_id: 0, slot: 35, item: v4(17, 10) });
    f.entities.set(1n, item(1n, 'oak_log', 1, { x: 2, y: -59.875, z: 0 }));
    f.entities.set(2n, item(2n, 'dirt', 1, { x: 3, y: -59.875, z: 3 }));
    const r = await collectItems(8, 400, f.deps);
    expect(r).toMatchObject({ ok: false, reason: 'inventory_full', gained: { oak_log: 1 } });
  });

  it('skips unreachable items and items that are never picked up', async () => {
    const f = fake({ unreachable: new Set([1n]) });
    f.entities.set(1n, item(1n, 'oak_log', 1, { x: 2, y: -59.875, z: 0 }));
    expect((await collectItems(8, 400, f.deps)).skipped).toBe(1);
    const g = fake({ pickup: false });
    g.entities.set(1n, item(1n, 'oak_log', 1, { x: 2, y: -59.875, z: 0 }));
    const r = await collectItems(8, 400, g.deps, { attemptsPerItem: 2 });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(1);
    expect(g.gotos.length).toBe(2);
  });

  it('honours the filter, cancel and the timeout', async () => {
    const f = fake();
    f.entities.set(1n, item(1n, 'dirt', 1, { x: 2, y: -59.875, z: 0 }));
    const r = await collectItems(8, 400, f.deps, { filter: (i) => i.name.endsWith('_log') });
    expect(r).toMatchObject({ ok: true, pickedUp: 0 });
    const c = fake();
    c.entities.set(1n, item(1n, 'oak_log', 1, { x: 2, y: -59.875, z: 0 }));
    c.cancel();
    expect(await collectItems(8, 400, c.deps)).toMatchObject({ ok: false, reason: 'interrupted' });
    const t = fake({ pickup: false });
    for (let i = 1n; i < 30n; i++) t.entities.set(i, item(i, 'oak_log', 1, { x: Number(i) * 0.2, y: -59.875, z: 0 }));
    expect(await collectItems(8, 100, t.deps, { attemptsPerItem: 99 })).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('collectItems: falling drops', () => {
  it('waits for a drop that is still moving before planning a path to it', async () => {
    const f = fake();
    const e = item(1n, 'oak_log', 1, { x: 2, y: -59.875, z: 0 });
    e.updatedAt = 1000; // moved just now
    f.entities.set(1n, e);
    let waits = 0;
    const wait = f.deps.waitTicks;
    f.deps.waitTicks = (n) => {
      waits++;
      if (waits === 3) e.updatedAt = 0; // landed
      return wait(n);
    };
    f.deps.now = () => 1100;
    const r = await collectItems(8, 400, f.deps);
    expect(r).toMatchObject({ ok: true, pickedUp: 1 });
    expect(waits).toBeGreaterThanOrEqual(3);
    expect(f.gotos.length).toBe(1);
  });
});

describe('collectItems: late drops', () => {
  it('waits a few ticks for a drop that is announced after the dig finished', async () => {
    const f = fake();
    const wait = f.deps.waitTicks;
    f.deps.waitTicks = (n) => {
      if (f.state.tick >= 4n && !f.entities.has(1n)) f.entities.set(1n, item(1n, 'oak_log', 1, { x: 2, y: -59.875, z: 0 }));
      return wait(n);
    };
    const r = await collectItems(8, 400, f.deps);
    expect(r).toMatchObject({ ok: true, pickedUp: 1, gained: { oak_log: 1 } });
    const none = fake();
    const r2 = await collectItems(8, 400, none.deps, { graceTicks: 6 });
    expect(r2).toMatchObject({ ok: true, pickedUp: 0 });
    expect(r2.ticks).toBeGreaterThanOrEqual(6);
  });
});
