// Track V (wave 7, docs/pve.md "Weapon pull") on fakes: ensureInHotbar moves the best item from the
// main inventory into the hotbar inside one inventory screen (open_inventory -> moves -> close), parks
// the least useful hotbar item when the hotbar is full, respects the wear predicate, fails cleanly
// without room; the HotbarPuller remembers failures; the Digger's pullTool hook runs before the tool
// choice and the dig continues with the pulled pickaxe.
import { describe, expect, it } from 'vitest';
import { bestSlot, digToolScore, ensureInHotbar, HotbarPuller, hotbarTarget, type HotbarMoveContainers } from '../../../src/skills/container/hotbar-moves.ts';
import { bladeScore } from '../../../src/skills/combat/combat.ts';
import { Digger } from '../../../src/skills/dig/digger.ts';
import { makeToolOk } from '../../../src/skills/survival/tools.ts';
import type { BlockInfo, ItemStack } from '../../../src/world/types.ts';

const item = (name: string, count = 1, damage?: number): ItemStack => ({ name, networkId: name.length, count, metadata: 0, stackId: 100 + name.length, ...(damage !== undefined ? { damage } : {}) });

class FakeContainers implements HotbarMoveContainers {
  open: { id: number; type: string } | undefined;
  readonly log: string[] = [];
  private readonly opens = new Set<(c: { id: number; type: string }) => void>();
  private readonly closes = new Set<(id: number, byServer: boolean) => void>();
  fail = false;
  readonly slots: (ItemStack | null)[];
  constructor(slots: (ItemStack | null)[]) {
    this.slots = slots;
  }
  move(src: { window: number; slot: number }, dst: { window: number; slot: number }, count: number): Promise<{ ok: boolean; reason?: string }> {
    this.log.push(`move ${src.slot}->${dst.slot} x${count}${this.open ? '' : ' (no screen)'}`);
    if (this.fail || !this.open) return Promise.resolve({ ok: false, reason: 'error' });
    if (this.slots[dst.slot]) return Promise.resolve({ ok: false, reason: 'bad_destination' });
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
  /** The server answering `interact open_inventory`. */
  serverOpens(): void {
    this.open = { id: 2, type: 'inventory' };
    this.log.push('open 2');
    for (const f of [...this.opens]) f(this.open);
  }
}

function setup(slots: (ItemStack | null)[], selected = 0) {
  const all: (ItemStack | null)[] = Array.from({ length: 36 }, (_, i) => slots[i] ?? null);
  const inv = { slots: all, selected };
  const c = new FakeContainers(all);
  const selects: number[] = [];
  const hotbar = {
    select: (s: number) => {
      selects.push(s);
      inv.selected = s;
      return true;
    },
    noteRaw: () => undefined,
  };
  const queue = (name: string, p: Record<string, unknown>) => {
    if (name === 'interact' && p.action_id === 'open_inventory') c.serverOpens();
  };
  const base = { hotbar, containers: c, inventory: inv, queue, runtimeId: () => 1n, waitTicks: () => Promise.resolve() };
  return { inv, c, selects, base };
}

describe('ensureInHotbar', () => {
  it('moves the sword from the main inventory into an empty hotbar slot inside one screen and selects it', async () => {
    const s = setup([item('cooked_beef', 5), null, item('dirt', 10)]);
    s.inv.slots[20] = item('iron_sword');
    const r = await ensureInHotbar({ ...s.base, score: bladeScore });
    expect(r).toEqual({ ok: true, slot: 1, item: 'iron_sword', moved: true, from: 20 });
    expect(s.c.log).toEqual(['open 2', 'move 20->1 x1', 'close 2']);
    expect(s.inv.slots[1]?.name).toBe('iron_sword');
    expect(s.selects).toEqual([1]);
  });

  it('keeps a hotbar sword that is as good, and only selects it', async () => {
    const s = setup([item('cooked_beef'), item('iron_sword')]);
    s.inv.slots[20] = item('iron_sword');
    expect(await ensureInHotbar({ ...s.base, score: bladeScore })).toEqual({ ok: true, slot: 1, item: 'iron_sword', moved: false });
    expect(s.c.log).toEqual([]);
    // a better one in the main inventory is moved
    s.inv.slots[21] = item('diamond_sword');
    const r = await ensureInHotbar({ ...s.base, score: bladeScore });
    expect(r).toMatchObject({ ok: true, item: 'diamond_sword', moved: true, from: 21 });
  });

  it('a full hotbar: parks the least useful item (blocks before food before tools) in a free main slot first', async () => {
    const s = setup([item('iron_pickaxe'), item('bread'), item('cooked_beef'), item('stone_axe'), item('torch', 8), item('apple'), item('shears'), item('carrot'), item('cobblestone', 30)], 0);
    s.inv.slots[30] = item('diamond_sword');
    expect(hotbarTarget(s.inv, bladeScore)).toEqual({ slot: 8, empty: false }); // cobblestone (no durability, not food), highest slot
    const r = await ensureInHotbar({ ...s.base, score: bladeScore, keep: (it) => it.name === 'cobblestone' });
    // stone_axe scores as a blade (never parked); cobblestone is kept: the torch goes
    expect(r).toMatchObject({ ok: true, slot: 4, item: 'diamond_sword', moved: true, from: 30, parked: 9 });
    expect(s.c.log).toEqual(['open 2', 'move 4->9 x8', 'move 30->4 x1', 'close 2']);
    expect(s.inv.slots[9]?.name).toBe('torch');
  });

  it('skips worn items (toolOk) and fails cleanly without room or a screen', async () => {
    const s = setup([item('dirt')]);
    s.inv.slots[20] = item('iron_sword', 1, 245); // 5 uses left
    expect(await ensureInHotbar({ ...s.base, score: bladeScore, toolOk: makeToolOk(() => 10) })).toEqual({ ok: false, reason: 'none' });
    const full = setup(Array.from({ length: 36 }, () => item('cobblestone', 64)));
    full.inv.slots[20] = item('iron_sword');
    expect(await ensureInHotbar({ ...full.base, score: bladeScore })).toEqual({ ok: false, reason: 'no_space' });
    const noScreen = setup([null]);
    noScreen.inv.slots[20] = item('iron_sword');
    const r = await ensureInHotbar({ ...noScreen.base, queue: () => undefined, score: bladeScore });
    expect(r).toEqual({ ok: false, reason: 'no_inventory_window' });
    expect(await ensureInHotbar({ ...noScreen.base, containers: undefined, score: bladeScore })).toEqual({ ok: false, reason: 'no_containers' });
  });

  it('bestSlot and digToolScore: pickaxes for stone, nothing for dirt with a pickaxe only', () => {
    const stone = digToolScore('stone');
    expect(stone(item('iron_pickaxe'))).toBeGreaterThan(stone(item('wooden_pickaxe')));
    expect(stone(item('iron_sword'))).toBe(0);
    expect(digToolScore('dirt')(item('iron_pickaxe'))).toBe(0);
    expect(digToolScore('dirt')(item('iron_shovel'))).toBeGreaterThan(0);
    expect(bestSlot([item('dirt'), item('iron_pickaxe'), item('wooden_pickaxe')], 0, 9, stone)).toMatchObject({ slot: 1 });
  });
});

describe('HotbarPuller and the Digger hook', () => {
  it('pull() is undefined when nothing is better, remembers a failure for 10 s', async () => {
    const s = setup([item('dirt')]);
    let now = 0;
    const p = new HotbarPuller({ containers: () => s.c, hotbar: () => s.base.hotbar, inventory: () => s.inv, toolOk: () => () => true, queue: s.base.queue, runtimeId: () => 1n, waitTicks: () => Promise.resolve(), now: () => now });
    expect(p.pull('weapon', bladeScore)).toBeUndefined();
    s.inv.slots[20] = item('iron_sword');
    s.c.fail = true;
    expect(await p.pull('weapon', bladeScore)).toEqual({ ok: false, reason: 'move_failed' });
    expect(p.pull('weapon', bladeScore)).toBeUndefined();
    now = 10_001;
    s.c.fail = false;
    expect(await p.pull('weapon', bladeScore)).toMatchObject({ ok: true, moved: true });
    expect(p.stats).toEqual({ pulls: 2, moved: 1, failed: 1 });
  });

  it('the Digger pulls a pickaxe from the main inventory before choosing the tool, then digs with it', async () => {
    const s = setup([item('dirt', 5)]);
    s.inv.slots[25] = item('iron_pickaxe');
    const p = new HotbarPuller({ containers: () => s.c, hotbar: () => s.base.hotbar, inventory: () => s.inv, toolOk: () => () => true, queue: s.base.queue, runtimeId: () => 1n, waitTicks: () => Promise.resolve() });
    const extras: unknown[] = [];
    const stone: BlockInfo = { name: 'stone', states: {} } as unknown as BlockInfo;
    const dg = new Digger({
      loop: { state: { pos: { x: 0.5, y: -60, z: 0.5 }, tick: 100n, ready: true }, setCommand: () => undefined, setTickExtras: (fn) => extras.push(fn) },
      world: { blockAt: () => stone, onBlockUpdate: () => () => undefined, inventory: s.inv },
      hotbar: s.base.hotbar,
    });
    dg.pullTool = p.digHook;
    const job = dg.dig({ x: 1, y: -60, z: 0 });
    await new Promise((r) => setImmediate(r));
    expect(s.c.log).toEqual(['open 2', 'move 25->1 x1', 'close 2']);
    expect(dg.busy).toBe(true);
    expect(s.selects).toEqual([1]); // the dig selected the pickaxe it now found in the hotbar
    dg.cancel();
    expect(await job).toMatchObject({ ok: false, reason: 'interrupted', slot: 1, item: 'iron_pickaxe' });
  });
});
