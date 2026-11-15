// Track T2 follow-up (docs/pve.md "Weapon pull"): the hotbar puller with a full inventory. With no free main-inventory slot
// the wanted item and the hotbar item the pull would have parked exchange places by one `swap` (the survival kit's
// `exchange`, under the screen the pull holds), for a weapon, a dig tool and a breeding item; the item given up is chosen as
// for parking (never a candidate of the job, never `keep`, the held slot last); a refused exchange leaves the slots as they
// were; a failed pull is said in the log once a minute a job and reason. The hotbar-moves tests of Track V are unchanged.
import { describe, expect, it } from 'vitest';
import { bladeScore } from '../../../src/skills/combat/combat.ts';
import { ensureInHotbar, HotbarPuller, PULL_LOG_MS, type HotbarMoveContainers } from '../../../src/skills/container/hotbar-moves.ts';
import { silentLogger } from '../../../src/log.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const item = (name: string, count = 1): ItemStack => ({ name, networkId: name.length, count, metadata: 0, stackId: 100 + name.length });

/** Containers on a fake inventory: the screen opens on `interact open_inventory`; `move` needs an empty destination. */
class FakeContainers implements HotbarMoveContainers {
  open: { id: number; type: string } | undefined;
  readonly log: string[] = [];
  private readonly opens = new Set<(c: { id: number; type: string }) => void>();
  private readonly closes = new Set<(id: number, byServer: boolean) => void>();
  readonly slots: (ItemStack | null)[];
  constructor(slots: (ItemStack | null)[]) {
    this.slots = slots;
  }
  move(src: { window: number; slot: number }, dst: { window: number; slot: number }): Promise<{ ok: boolean; reason?: string }> {
    this.log.push(`move ${src.slot}->${dst.slot}`);
    if (!this.open || this.slots[dst.slot]) return Promise.resolve({ ok: false, reason: 'bad_destination' });
    this.slots[dst.slot] = this.slots[src.slot]!;
    this.slots[src.slot] = null;
    return Promise.resolve({ ok: true });
  }
  onOpen(fn: (c: { id: number; type: string }) => void): () => void {
    this.opens.add(fn);
    return () => this.opens.delete(fn);
  }
  onClose(fn: (id: number, byServer: boolean) => void): () => void {
    this.closes.add(fn);
    return () => this.closes.delete(fn);
  }
  close(id: number): void {
    this.log.push(`close ${id}`);
    this.open = undefined;
    for (const f of [...this.closes]) f(id, false);
  }
  serverOpens(): void {
    this.open = { id: 2, type: 'inventory' };
    this.log.push('open 2');
    for (const f of [...this.opens]) f(this.open);
  }
}

/** 36 slots, every one filled: the hotbar as given, the rest cobblestone, `main` on top. */
function fullInventory(bar: ItemStack[], main: Record<number, ItemStack>, selected = 0) {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, (_, i) => (i < 9 ? (bar[i] ?? item('dirt', 64)) : item('cobblestone', 64)));
  for (const [k, v] of Object.entries(main)) slots[Number(k)] = v;
  const inv = { slots, selected };
  const c = new FakeContainers(slots);
  let refuse = false;
  const swap = (a: number, b: number): Promise<{ ok: boolean; reason?: string }> => {
    c.log.push(`swap ${a}<->${b}${c.open ? '' : ' (no screen)'}`);
    if (refuse || !c.open) return Promise.resolve({ ok: false, reason: 'the swap was refused (error)' });
    const t = slots[a];
    slots[a] = slots[b]!;
    slots[b] = t!;
    return Promise.resolve({ ok: true });
  };
  const hotbar = {
    select: (s: number) => {
      inv.selected = s;
      return true;
    },
  };
  const base = {
    hotbar,
    containers: c,
    inventory: inv,
    queue: (name: string, p: Record<string, unknown>) => {
      if (name === 'interact' && p.action_id === 'open_inventory') c.serverOpens();
    },
    runtimeId: () => 1n,
    waitTicks: () => Promise.resolve(),
  };
  return { slots, inv, c, swap, base, refuse: (v: boolean) => (refuse = v) };
}

describe('ensureInHotbar with a full inventory: the exchange', () => {
  it('a weapon: the sword exchanges with the least useful hotbar item (a block, the highest slot) in one screen', async () => {
    const f = fullInventory([item('iron_pickaxe'), item('bread', 8), item('torch', 16)], { 20: item('netherite_sword') });
    const r = await ensureInHotbar({ ...f.base, score: bladeScore, swap: f.swap });
    expect(r).toEqual({ ok: true, slot: 8, item: 'netherite_sword', moved: true, from: 20, parked: 20, exchanged: true });
    expect(f.c.log).toEqual(['open 2', 'swap 20<->8', 'close 2']);
    expect(f.slots[8]?.name).toBe('netherite_sword');
    expect(f.slots[20]).toMatchObject({ name: 'dirt', count: 64 }); // nothing dropped
    expect(f.inv.selected).toBe(8);
    // without the exchange: as before
    const g = fullInventory([item('iron_pickaxe')], { 20: item('netherite_sword') });
    expect(await ensureInHotbar({ ...g.base, score: bladeScore })).toEqual({ ok: false, reason: 'no_space' });
    expect(g.c.log).toEqual([]);
  });

  it('a free main slot: parked as today, no exchange', async () => {
    const f = fullInventory([], { 20: item('netherite_sword') });
    f.slots[30] = null;
    const r = await ensureInHotbar({ ...f.base, score: bladeScore, swap: f.swap });
    expect(r).toMatchObject({ ok: true, slot: 8, parked: 30 });
    expect(r).not.toHaveProperty('exchanged');
    expect(f.c.log).toEqual(['open 2', 'move 8->30', 'move 20->8', 'close 2']);
  });

  it('a dig tool and a breeding item: the same exchange (the Digger hook does not select)', async () => {
    const f = fullInventory([item('iron_sword'), item('bread', 8)], { 25: item('iron_pickaxe') });
    const puller = new HotbarPuller({ containers: () => f.c, hotbar: () => f.base.hotbar, inventory: () => f.inv, toolOk: () => () => true, queue: f.base.queue, runtimeId: () => 1n, waitTicks: () => Promise.resolve() });
    puller.swap = f.swap;
    expect(await puller.digHook('stone')).toMatchObject({ ok: true, item: 'iron_pickaxe', exchanged: true, slot: 8 });
    expect(f.inv.selected).toBe(0);
    expect(f.slots[0]?.name).toBe('iron_sword'); // a tool with durability is given up after blocks
    f.slots[30] = item('wheat', 32);
    expect(await puller.pull('breed cow', (it) => (it.name === 'wheat' ? 1 : 0), { select: true })).toMatchObject({ ok: true, item: 'wheat', exchanged: true, slot: 7 });
  });

  it('the item given up: never a candidate of the job, never `keep`, the held slot last', async () => {
    // every hotbar slot a blade but one pickaxe: the pickaxe goes (a worse weapon for this pull), the blades stay
    const blades = [item('stone_sword'), item('stone_axe'), item('iron_axe'), item('golden_sword'), item('iron_pickaxe'), item('wooden_sword'), item('wooden_axe'), item('golden_axe'), item('stone_sword')];
    const f = fullInventory(blades, { 20: item('netherite_sword') });
    expect(await ensureInHotbar({ ...f.base, score: bladeScore, swap: f.swap })).toMatchObject({ ok: true, slot: 4, exchanged: true });
    // all blades: nothing may be given up, even with the exchange
    const g = fullInventory(blades.map((b, i) => (i === 4 ? item('iron_sword') : b)), { 20: item('netherite_sword') });
    expect(await ensureInHotbar({ ...g.base, score: bladeScore, swap: g.swap })).toEqual({ ok: false, reason: 'no_space' });
    // blocks everywhere, the held slot 8: slot 7 goes; with every block `keep` but the held one, the held one goes
    const h = fullInventory([], { 20: item('netherite_sword') }, 8);
    expect(await ensureInHotbar({ ...h.base, score: bladeScore, swap: h.swap })).toMatchObject({ slot: 7 });
    const k = fullInventory([], { 20: item('netherite_sword') }, 8);
    k.slots[8] = item('torch', 4);
    expect(await ensureInHotbar({ ...k.base, score: bladeScore, swap: k.swap, keep: (it) => it.name === 'dirt' })).toMatchObject({ slot: 8 });
  });

  it('a refused exchange leaves every slot as it was and fails move_failed', async () => {
    const f = fullInventory([item('iron_pickaxe')], { 20: item('netherite_sword') });
    const before = [...f.slots];
    f.refuse(true);
    expect(await ensureInHotbar({ ...f.base, score: bladeScore, swap: f.swap })).toEqual({ ok: false, reason: 'move_failed' });
    expect(f.slots).toEqual(before);
    expect(f.c.log).toEqual(['open 2', 'swap 20<->8', 'close 2']);
  });
});

describe('HotbarPuller: a failed pull is said in the log', () => {
  it('once a minute a job and reason, not at every try', async () => {
    const f = fullInventory([item('iron_pickaxe')], { 20: item('netherite_sword') });
    const lines: string[] = [];
    let now = 0;
    const puller = new HotbarPuller({ containers: () => f.c, hotbar: () => f.base.hotbar, inventory: () => f.inv, toolOk: () => () => true, queue: f.base.queue, runtimeId: () => 1n, waitTicks: () => Promise.resolve(), logger: { ...silentLogger, warn: (m: string) => lines.push(m) }, now: () => now });
    expect(await puller.pull('weapon', bladeScore, { select: true })).toEqual({ ok: false, reason: 'no_space' });
    expect(lines).toEqual(['hotbar: the pull for weapon failed: no_space (no hotbar slot it may give up, and no exchange); it goes on with what the hotbar holds']);
    now = 10_001; // the retry after PULL_RETRY_MS: the same failure, no second line
    expect(await puller.pull('weapon', bladeScore)).toMatchObject({ ok: false });
    expect(lines).toHaveLength(1);
    now = PULL_LOG_MS + 1;
    await puller.pull('weapon', bladeScore);
    expect(lines).toHaveLength(2);
    // with the exchange the pull goes through (and says nothing more)
    now += 10_001;
    puller.swap = f.swap;
    expect(await puller.pull('weapon', bladeScore)).toMatchObject({ ok: true, exchanged: true });
    expect(lines).toHaveLength(2);
  });
});
