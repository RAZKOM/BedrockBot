/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Wave 10 Track AS (docs/home.md "Bring"): the pure part of `!bring` (skills/home/bring.ts: the word ->
// item names, the arguments, the plan, the reply words) and the withdrawal job of the home logistics
// (logistics.ts `withdraw`) on a fake home: nearest chest first, what is carried counts first, the
// memory counts down at once, a stale memory sends the bot on, whole shulker boxes only as the last
// source, cancellation.
import { describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { isShulkerBox, snapshotOf } from '../../../src/skills/container/chest.ts';
import { defaultCount, itemsText, parseBringArgs, planBring, resolveBringItem, stockOf } from '../../../src/skills/home/bring.ts';
import { HomeLogistics, type HomeSkills } from '../../../src/skills/home/logistics.ts';
import { stockLine } from '../../../src/skills/home/memory.ts';
import { ChestMemory, chestKey, type ChestRecord } from '../../../src/world/cache/chests.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const item = (name: string, count = 64): ItemStack => ({ name, count, networkId: 1, metadata: 0 });
const block = (name: string, solid = true): BlockInfo => ({ name, stateId: 1, states: {}, hardness: 1, solid, boxes: solid ? [[0, 0, 0, 1, 1, 1]] : [] });
const nbt = (items: { name: string; count: number }[]) => ({ extra: { nbt: { nbt: { value: { Items: { value: { value: items.map((i) => ({ Name: { value: `minecraft:${i.name}` }, Count: { value: i.count } })) } } } } } } });

const rec = (x: number, contents: Record<string, number>, extra: Partial<ChestRecord> = {}): ChestRecord => ({ x, y: 0, z: 0, kind: 'chest', size: 27, free: 20, stacks: 7, contents, room: {}, boxes: { empty: 0, full: 0 }, double: false, readAt: 1, ...extra });

describe('bring: the word, the arguments, the reply words', () => {
  it('resolves through the memory names first, then the catalog', () => {
    expect(resolveBringItem('torches', ['torch', 'coal'])).toEqual({ word: 'torches', names: ['torch'], boxes: false });
    expect(resolveBringItem('torch', ['torch'])).toMatchObject({ names: ['torch'] });
    expect(resolveBringItem('shulker')).toEqual({ word: 'shulker_box', names: ['shulker_box'], boxes: true });
    expect(resolveBringItem('iron', ['iron_ingot']).names).toEqual(['iron_ingot', 'raw_iron']);
    expect(resolveBringItem('diamonds', ['diamond']).names).toEqual(['diamond']);
    expect(resolveBringItem('coal').names).toEqual(['coal']);
    expect(resolveBringItem('wood', ['oak_log', 'birch_log', 'coal']).names).toEqual(['oak_log', 'birch_log', 'logs']);
    expect(resolveBringItem('minecraft:Ender_Pearl', ['ender_pearl']).names).toEqual(['ender_pearl']);
    expect(resolveBringItem('unobtainium').names).toEqual(['unobtainium']);
    expect(defaultCount(resolveBringItem('torch', ['torch']))).toBe(64);
    expect(defaultCount(resolveBringItem('shulker'))).toBe(1);
    expect(defaultCount(resolveBringItem('ender_pearl', ['ender_pearl']))).toBe(16);
  });

  it('parses <item> [n] [to <player>|home], [n] <item>, me', () => {
    expect(parseBringArgs(['torch', '64'])).toEqual({ name: 'torch', count: 64, to: undefined });
    expect(parseBringArgs(['64', 'torches'])).toEqual({ name: 'torches', count: 64, to: undefined });
    expect(parseBringArgs(['coal', 'home'])).toEqual({ name: 'coal', count: undefined, to: 'home' });
    expect(parseBringArgs(['iron', '20', 'to', 'Steve'])).toEqual({ name: 'iron', count: 20, to: 'Steve' });
    expect(parseBringArgs(['iron', 'to', 'home'])).toEqual({ name: 'iron', count: undefined, to: 'home' });
    expect(parseBringArgs(['me', '64', 'torches'])).toEqual({ name: 'torches', count: 64, to: undefined });
    expect(parseBringArgs(['torches', 'to', 'me'])).toEqual({ name: 'torches', count: undefined, to: undefined });
    expect(parseBringArgs(['ender', 'pearl', '4'])).toEqual({ name: 'ender_pearl', count: 4, to: undefined });
    expect(parseBringArgs(['home'])).toEqual({ name: 'home', count: undefined, to: undefined }); // one word: an item called home
    expect(parseBringArgs(['torch', 'to'])).toEqual({ error: 'to <player> or to home' });
    expect(parseBringArgs(['4', 'coal', '5'])).toEqual({ error: 'one count only' });
    expect(parseBringArgs(['coal', '0'])).toEqual({ error: 'count must be 1 to 2304' });
  });

  it('item words: plural where it reads well', () => {
    expect(itemsText(64, 'torch')).toBe('64 torches');
    expect(itemsText(1, 'torch')).toBe('1 torch');
    expect(itemsText(20, 'coal')).toBe('20 coal');
    expect(itemsText(2, 'diamond')).toBe('2 diamonds');
    expect(itemsText(8, 'iron_ingot')).toBe('8 iron_ingots');
    expect(itemsText(1, 'undyed_shulker_box')).toBe('1 shulker box');
    expect(itemsText(3, 'red_shulker_box')).toBe('3 shulker boxes');
  });
});

describe('bring: the plan', () => {
  const torch = resolveBringItem('torch', ['torch']);

  it('nearest chest first by the memory, carried items first, the rest short', () => {
    const records = [rec(10, { torch: 30 }), rec(3, { torch: 40 }), rec(5, { coal: 64 })];
    const p = planBring(records, torch, 64, 0, { x: 0, y: 0, z: 0 });
    expect(p.sources.map((s) => [s.key, s.take, s.box])).toEqual([
      ['3,0,0', 40, false],
      ['10,0,0', 24, false],
    ]);
    expect(p).toMatchObject({ need: 64, loose: 70, boxed: 0, short: 0 });
    expect(planBring(records, torch, 64, 50, { x: 0, y: 0, z: 0 }).sources).toEqual([{ key: '3,0,0', pos: { x: 3, y: 0, z: 0 }, kind: 'chest', take: 14, box: false }]);
    expect(planBring(records, torch, 64, 64).sources).toEqual([]);
    expect(planBring(records, torch, 100, 0)).toMatchObject({ short: 30 });
  });

  it('skips unread, unreachable and partner records; boxes only when the loose stacks are short', () => {
    const dia = resolveBringItem('diamond', ['diamond']);
    const records = [
      rec(2, { diamond: 1 }),
      rec(4, { undyed_shulker_box: 1 }, { boxes: { empty: 0, full: 1 }, inBoxes: { diamond: 2 } }),
      rec(6, { diamond: 50 }, { unreachable: 'no path', unreachableAt: 1 }),
      rec(8, { diamond: 50 }, { readAt: 0 }),
    ];
    expect(stockOf(records, dia)).toEqual({ loose: 1, boxed: 2, chests: 2 });
    const p = planBring(records, dia, 1, 0, { x: 0, y: 0, z: 0 });
    expect(p.sources).toHaveLength(1);
    expect(p.sources[0]!.box).toBe(false);
    const q = planBring(records, dia, 3, 0, { x: 0, y: 0, z: 0 });
    expect(q.sources.map((s) => [s.key, s.take, s.box])).toEqual([
      ['2,0,0', 1, false],
      ['4,0,0', 2, true],
    ]);
    // the other half of a double chest is never a source
    const dbl = [rec(2, { diamond: 5 }, { partner: { x: 3, y: 0, z: 0 } }), rec(3, { diamond: 5 })];
    expect(stockOf(dbl, dia).loose).toBe(5);
  });
});

/** A fake home of chests (memory read by a scan first) for the withdrawal. */
function fakeHome(containers: Record<string, { items: (ItemStack | null)[]; raws?: unknown[] }>, inv0: (ItemStack | null)[] = []) {
  const boxes = new Map<string, { slots: (ItemStack | null)[]; raws: unknown[] }>();
  for (const [k, c] of Object.entries(containers)) boxes.set(k, { slots: [...c.items, ...Array.from({ length: 27 - c.items.length }, () => null)], raws: [...(c.raws ?? [])] });
  const inv: (ItemStack | null)[] = [...inv0, ...Array.from({ length: 36 - inv0.length }, () => null)];
  const invRaws: unknown[] = [];
  let pos: Vec3 = { x: 0.5, y: 0, z: 0.5 };
  let open: { slots: (ItemStack | null)[]; raws: unknown[] } | undefined;
  const calls: string[] = [];
  let onGoto: (() => void) | undefined;
  const parse = (k: string): Vec3 => {
    const [x, y, z] = k.split(',').map(Number);
    return { x: x!, y: y!, z: z! };
  };
  const blockAt = (p: Vec3): BlockInfo => (boxes.has(chestKey(p)) ? block('chest') : p.y < 0 ? block('stone') : block('air', false));
  const skills: HomeSkills = {
    goto: async (g) => {
      const p = (g as { p: Vec3 }).p;
      calls.push(`goto ${chestKey(p)}`);
      onGoto?.();
      pos = { x: p.x + 1, y: 0, z: p.z };
      return { ok: true };
    },
    open: async (p) => {
      calls.push(`open ${chestKey(p)}`);
      const b = boxes.get(chestKey(p));
      if (!b) return { ok: false, reason: 'not_a_container' };
      open = b;
      return { ok: true, view: { id: 5, slots: b.slots }, open: { id: 5, type: 'container', pos: p, openedAt: 0 }, block: 'chest' };
    },
    closeContainer: async () => {
      calls.push('close');
      open = undefined;
      return true;
    },
    snapshot: (v) => snapshotOf(v.slots, (i) => open?.raws[i]),
    depositSlots: async () => ({ ok: false, reason: 'no', moved: {}, total: 0, requests: 0, errors: 0 }),
    take: async (_v, slot, count) => {
      const b = open!;
      const it = b.slots[slot];
      if (!it) return { ok: false, reason: 'empty_source', moved: 0 };
      let to = isShulkerBox(it.name) ? -1 : inv.findIndex((s) => s?.name === it.name && s.count < 64);
      if (to < 0) to = inv.findIndex((s) => !s);
      if (to < 0) return { ok: false, reason: 'inventory_full', moved: 0 };
      const n = Math.min(count ?? it.count, it.count, 64 - (inv[to]?.count ?? 0));
      inv[to] = { ...it, count: (inv[to]?.count ?? 0) + n };
      invRaws[to] = b.raws[slot];
      b.slots[slot] = it.count - n > 0 ? { ...it, count: it.count - n } : null;
      if (!b.slots[slot]) b.raws[slot] = undefined;
      calls.push(`take ${slot} ${n}`);
      return { ok: true, moved: n, to };
    },
    place: async () => ({ ok: false, reason: 'no' }),
    dig: async () => ({ ok: false, reason: 'no' }),
    collect: async () => ({ ok: true, gained: {}, pickedUp: 0, skipped: 0, ticks: 1, corrections: 0 }),
    cancel: () => calls.push('cancel'),
  };
  const memory = new ChestMemory();
  const logistics = new HomeLogistics({
    skills,
    inventory: { slots: inv, rawItem: (w, s) => (w === 0 ? invRaws[s] : open?.raws[s]) },
    world: {
      find: (pred, opts) =>
        [...boxes.keys()]
          .map(parse)
          .filter((p) => Math.hypot(p.x + 0.5 - opts.origin.x, p.z + 0.5 - opts.origin.z) <= opts.radius && pred(blockAt(p), p))
          .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)),
      blockAt,
    },
    position: () => pos,
    home: () => ({ x: 0, y: 0, z: 0 }),
    memory: () => memory,
    settings: new RuntimeSettings(),
    now: () => 1_000_000,
  });
  return {
    logistics,
    boxes,
    inv,
    calls,
    memory,
    onGoto: (fn: (() => void) | undefined) => {
      onGoto = fn;
    },
  };
}

const never = () => false;

describe('bring: the withdrawal (logistics.withdraw)', () => {
  it('64 torches from 40 + 30: nearest chest first, then the next; the memory counts down at once', async () => {
    const h = fakeHome({ '3,0,0': { items: [item('torch', 40)] }, '-8,0,0': { items: [item('torch', 30), item('coal', 64)] } });
    await h.logistics.scan(never);
    const torch = resolveBringItem('torch', ['torch']);
    const r = await h.logistics.withdraw(never, { item: torch, want: 64 });
    expect(r).toMatchObject({ ok: true, taken: { torch: 64 }, carried: 64, chests: 2, requests: 2, boxes: [] });
    // the scan ended at the chest at -8: it is the nearest now
    expect(r.from).toEqual(['chest -8 0 0', 'chest 3 0 0']);
    expect(h.calls.filter((c) => c.startsWith('open')).slice(-2)).toEqual(['open -8,0,0', 'open 3,0,0']);
    expect(h.memory.get({ x: -8, y: 0, z: 0 })!.contents).toEqual({ coal: 64 });
    expect(h.memory.get({ x: 3, y: 0, z: 0 })!.contents).toEqual({ torch: 6 });
    expect(stockLine(h.memory, 'torch')).toBe('torch: 6 in chest 3 0 0');
    // carried counts first: nothing more to take
    const again = await h.logistics.withdraw(never, { item: torch, want: 64 });
    expect(again).toMatchObject({ ok: true, taken: {}, chests: 0, carried: 64 });
  });

  it('a stale memory: the chest holds less than remembered, the bot goes on to the next one', async () => {
    const h = fakeHome({ '3,0,0': { items: [item('torch', 40)] }, '-8,0,0': { items: [item('torch', 30)] } });
    await h.logistics.scan(never);
    h.boxes.get('-8,0,0')!.slots[0] = item('torch', 10); // someone took 20 since the scan (the bot stands next to it)
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('torch', ['torch']), want: 32 });
    expect(r).toMatchObject({ ok: true, taken: { torch: 32 }, chests: 2 });
    expect(h.memory.get({ x: -8, y: 0, z: 0 })!.contents).toEqual({});
    expect(h.memory.get({ x: 3, y: 0, z: 0 })!.contents).toEqual({ torch: 18 });
  });

  it('short: takes all there is', async () => {
    const h = fakeHome({ '3,0,0': { items: [item('iron_ingot', 8)] } });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('iron', ['iron_ingot']), want: 20 });
    expect(r).toMatchObject({ ok: true, taken: { iron_ingot: 8 }, carried: 8, chests: 1 });
  });

  it('a shulker box holding the item, the only source: the whole box is taken; its memory leaves the box counts', async () => {
    const h = fakeHome({ '3,0,0': { items: [item('dirt', 5), item('undyed_shulker_box', 1)], raws: [undefined, nbt([{ name: 'diamond', count: 2 }, { name: 'stone', count: 64 }])] } });
    await h.logistics.scan(never);
    const before = h.memory.get({ x: 3, y: 0, z: 0 })!;
    expect(before.boxes).toEqual({ empty: 0, full: 1 });
    expect(before.inBoxes).toEqual({ diamond: 2, stone: 64 });
    const dia = resolveBringItem('diamond', ['diamond']);
    const r = await h.logistics.withdraw(never, { item: dia, want: 2 });
    expect(r).toMatchObject({ ok: true, taken: { undyed_shulker_box: 1 }, boxes: [{ name: 'undyed_shulker_box', items: 2, from: 'chest 3 0 0' }], carried: 0 });
    const after = h.memory.get({ x: 3, y: 0, z: 0 })!;
    expect(after.boxes).toEqual({ empty: 0, full: 0 });
    expect(after.inBoxes).toBeUndefined();
    expect(after.contents).toEqual({ dirt: 5 });
    expect(h.inv.some((s) => s?.name === 'undyed_shulker_box')).toBe(true);
  });

  it('!bring shulker: empty boxes before full ones', async () => {
    const h = fakeHome({ '3,0,0': { items: [item('undyed_shulker_box', 1), item('red_shulker_box', 1)], raws: [nbt([{ name: 'stone', count: 1 }])] } });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('shulker'), want: 1 });
    expect(r.taken).toEqual({ red_shulker_box: 1 });
  });

  it('cancelled during the walk: interrupted, nothing taken', async () => {
    const h = fakeHome({ '3,0,0': { items: [item('torch', 40)] } });
    await h.logistics.scan(never);
    let stop = false;
    h.onGoto(() => {
      stop = true;
    });
    const r = await h.logistics.withdraw(() => stop, { item: resolveBringItem('torch', ['torch']), want: 10 });
    expect(r).toMatchObject({ ok: false, reason: 'interrupted', taken: {} });
  });
});
