// Track K3 (ADR 0096 decision 12, docs/home.md "Room for a take"): a take from the home chests with a full inventory makes
// room first. The pure rule (unloader.ts roomChoice: which stacks go, which stay; slotsForTake: the slots a take needs)
// and the withdrawal on the fake home (home-fakes.ts): the room made, its log and reply words, the spare slots a job asks
// for, nothing kept unloaded, and the cases that make none (a `!test inv` save, out of reach of home).
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/log.ts';
import { resolveBringItem } from '../../../src/skills/home/bring.ts';
import { roomLine } from '../../../src/skills/home/logistics.ts';
import { planUnload, roomChoice, slotsForTake, type PlanChest, type UnloadSlot } from '../../../src/skills/home/unloader.ts';
import { BoxOps } from '../../../src/skills/supply/boxes.ts';
import { Supply } from '../../../src/skills/supply/supply.ts';
import { fakeHome, item, nbt } from './home-fakes.ts';

const never = () => false;
const slot = (s: number, name: string, count: number, extra: Partial<UnloadSlot> = {}): UnloadSlot => ({ slot: s, name, count, ...extra });
const chest = (key: string, x: number, o: Partial<PlanChest> = {}): PlanChest => ({ key, pos: { x, y: 0, z: 0 }, kind: 'chest', free: 27, contents: {}, room: {}, boxes: { empty: 0, full: 0 }, ...o });

function logger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (m: string): void => {
    lines.push(m);
  };
  return { log: { debug: () => undefined, info: push, warn: push, error: push }, lines };
}

describe('the room rule (roomChoice)', () => {
  // the kit and the reserves stay; loot goes, whole stacks only, never a carried box, never the take's item
  const slots: UnloadSlot[] = [
    slot(0, 'diamond_sword', 1), // gear: kept
    slot(1, 'bread', 10), // food: kept
    slot(2, 'cobblestone', 64), // the throwaway reserve keeps 16: 48 go, the slot stays
    slot(3, 'milk_bucket', 1), // milk_reserve
    slot(4, 'milk_bucket', 1), // milk_reserve
    slot(5, 'paper', 22), // rocket_reserve (ceil(64 / 3))
    slot(6, 'undyed_shulker_box', 1, { boxUsed: 2, boxItems: { andesite: 128 } }), // a carried box of loot: stays
    slot(8, 'sand', 64), // hotbar loot
    slot(9, 'andesite', 64),
    slot(10, 'granite', 64),
    slot(20, 'bucket', 3), // milkKeep 2 is met by the milk: the buckets are loot, but the take's own item
    slot(35, 'diorite', 64),
  ];
  const chests = [chest('a', 3), chest('b', 6, { contents: { granite: 10 }, free: 20 })];
  const plan = planUnload(slots, chests, { boxing: false, milkKeep: 2, fireworksKeep: 64 });

  it('the fewest chests first; the main inventory before the hotbar, the last slot first', () => {
    expect(roomChoice(slots, plan, 3, { protect: ['bucket'] })).toMatchObject({ slots: [35, 9, 8], short: 0 });
    const four = roomChoice(slots, plan, 4, { protect: ['bucket'] });
    expect(four.slots).toEqual([35, 9, 8, 10]);
    expect(four.moves.map((m) => [m.slot, m.to])).toEqual([[35, 'a'], [9, 'a'], [8, 'a'], [10, 'b']]);
  });

  it('never the kit, the reserves, a partial stack, a carried box or the take\'s item: short when that is all', () => {
    const all = roomChoice(slots, plan, 10, { protect: ['bucket'] });
    expect(all.slots.sort((a, b) => a - b)).toEqual([8, 9, 10, 35]);
    expect(all.short).toBe(6);
    // the buckets go when another item is taken
    expect(roomChoice(slots, plan, 10, { protect: ['paper'] }).slots).toContain(20);
    // no chest has room: nothing goes
    const none = planUnload(slots, [chest('full', 3, { free: 0 })], { boxing: false });
    expect(roomChoice(slots, none, 2)).toEqual({ slots: [], moves: [], short: 2 });
    expect(roomChoice(slots, plan, 0)).toEqual({ slots: [], moves: [], short: 0 });
  });
});

describe('the slots a take needs (slotsForTake)', () => {
  it('stacks of the item beyond what the carried partial stacks hold, the spare after, boxes, a take out of a box', () => {
    expect(slotsForTake([], ['bucket'], 2)).toBe(1);
    expect(slotsForTake([], ['milk_bucket'], 2)).toBe(2); // a milk bucket does not stack
    expect(slotsForTake([item('bucket', 15)], ['bucket'], 1)).toBe(0); // the partial stack takes it
    expect(slotsForTake([item('bucket', 15)], ['bucket'], 2)).toBe(1);
    expect(slotsForTake([], ['paper'], 22, { spare: 1 })).toBe(2);
    expect(slotsForTake([], ['dirt'], 1000, { mode: 'box', boxes: 2 })).toBe(2);
    expect(slotsForTake([], ['dirt'], 10, { mode: 'extract' })).toBe(3);
    expect(slotsForTake([], ['dirt'], 200, { mode: 'extract' })).toBe(6);
  });
});

/** 36 full slots: a sword, then loot (granite, andesite ...). */
function fullInventory(): ReturnType<typeof item>[] {
  const loot = ['andesite', 'granite', 'diorite', 'tuff', 'calcite'];
  return [item('diamond_sword', 1), ...Array.from({ length: 35 }, (_, i) => item(loot[i % loot.length]!, 64))];
}

describe('the withdrawal makes room at home (Track K3)', () => {
  it('a full inventory at home: one stack unloaded first by the unloader\'s rules, then the take; the log and the reply say so', async () => {
    const { log, lines } = logger();
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('bucket', 16)] } }, inv: fullInventory(), log });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('bucket', ['bucket']), want: 2 });
    expect(r).toMatchObject({ ok: true, taken: { bucket: 2 }, carried: 2 });
    expect(r.room).toMatchObject({ need: 1, unloaded: 1 });
    // the chest has 26 free slots: the plan moves slots 1..26 (the rest fits nowhere); the last of those goes
    expect(r.room!.moved).toEqual([{ name: 'andesite', count: 64, to: 'chest 3 0 0' }]);
    expect(h.inv[26]?.name).toBe('bucket');
    expect(h.inv.filter((s) => s?.name === 'diamond_sword')).toHaveLength(1);
    expect(lines).toContain('withdraw: no room for 1 stack: unloading 1 first');
    expect(lines.some((l) => l.startsWith('withdraw: made room: unloaded 1 stack (64 andesite) into 1 container in '))).toBe(true);
    expect(roomLine(r)).toBe('made room: unloaded 1 stack (64 andesite)');
    // the estimate says the partial stack takes 2 more, but this take never merges (the fake's): it runs full, and the
    // room step after the take makes one more slot, then the take goes on
    lines.length = 0;
    const again = await h.logistics.withdraw(never, { item: resolveBringItem('bucket', ['bucket']), want: 4 });
    expect(again).toMatchObject({ ok: true, carried: 4, room: { need: 1, unloaded: 1 } });
    expect(lines.filter((l) => l.startsWith('withdraw: no room'))).toEqual(['withdraw: no room for 1 stack: unloading 1 first']);
  });

  it('the job\'s spare slots count: 2 buckets with 1 spare (the milk of the stack) unload 2 stacks', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('bucket', 16)] } }, inv: fullInventory() });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('bucket', ['bucket']), want: 2, spare: 1 });
    expect(r).toMatchObject({ ok: true, carried: 2, room: { need: 2, unloaded: 2 } });
    expect(h.inv.filter((s) => !s)).toHaveLength(1);
  });

  it('nothing to unload (the kit and food only): no room made, inventory_full, and why', async () => {
    const inv = [item('diamond_sword', 1), ...Array.from({ length: 35 }, () => item('bread', 64))];
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('bucket', 16)] } }, inv });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('bucket', ['bucket']), want: 2 });
    expect(r).toMatchObject({ ok: false, reason: 'inventory_full', taken: {} });
    expect(r.room).toMatchObject({ unloaded: 0, why: 'nothing to unload (what I carry is kept, or no chest has room for it)' });
    expect(roomLine(r)).toBe('no room made: nothing to unload (what I carry is kept, or no chest has room for it)');
    expect(h.inv.filter((s) => s?.name === 'bread')).toHaveLength(35);
  });

  it('a `!test inv` save holds the chests: nothing unloaded', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('bucket', 16)] } }, inv: fullInventory(), held: () => 'a !test inv save waits for its restore' });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('bucket', ['bucket']), want: 2 });
    expect(r).toMatchObject({ ok: false, reason: 'inventory_full', room: { unloaded: 0, why: 'held: a !test inv save waits for its restore' } });
  });

  it('Track B6: what a running build needs is never unloaded for the room (the step before brought it)', async () => {
    // 35 stacks: what the build's fetch brought (andesite, granite, diorite, tuff, calcite): none of it goes
    const keep = ['andesite', 'granite', 'diorite', 'tuff', 'calcite'];
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('bucket', 16)] } }, inv: fullInventory(), keep: () => keep });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('bucket', ['bucket']), want: 2 });
    expect(r).toMatchObject({ ok: false, reason: 'inventory_full', room: { unloaded: 0 } });
    expect(h.inv.filter((s) => s && keep.includes(s.name))).toHaveLength(35);
    // one kind not pinned: that one goes
    const h2 = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('bucket', 16)] } }, inv: fullInventory(), keep: () => keep.slice(1) });
    await h2.logistics.scan(never);
    const r2 = await h2.logistics.withdraw(never, { item: resolveBringItem('bucket', ['bucket']), want: 2 });
    expect(r2.room!.moved.map((m) => m.name)).toEqual(['andesite']);
  });

  it('not at home (out of reach of the home chests): as before, with the reason', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('bucket', 16)] } }, inv: fullInventory(), stay: true });
    await h.logistics.scan(never);
    h.setPos({ x: 60.5, y: 0, z: 0.5 });
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('bucket', ['bucket']), want: 2 });
    expect(r).toMatchObject({ ok: false, reason: 'inventory_full', taken: {} });
    expect(r.room?.why).toBe('not at home: I am 60 blocks from home (they count within 24)');
    expect(h.inv.every((s) => !!s)).toBe(true);
  });
});

describe('the supply layer passes it on (Supply.ensure)', () => {
  function supplyOn(h: ReturnType<typeof fakeHome>): Supply {
    const ops = new BoxOps({ skills: h.logistics.skillsForBoxes(), inventory: h.inventory, blockAt: h.blockAt, position: h.position, keepName: () => 'bot_loot', selectHotbar: h.select, label: 'supply' });
    return new Supply({ ops, inventory: h.inventory, keepName: () => 'bot_loot', records: () => h.logistics.records(), withdraw: (c, req) => h.logistics.withdraw(c, req) });
  }

  it('the home route with a full inventory: the room note in the result; no room: the reason in words', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('paper', 30), item('gunpowder', 30)] } }, inv: fullInventory() });
    await h.logistics.scan(never);
    const s = supplyOn(h);
    const r = await s.ensure('paper', 22, { home: true, spare: 1 });
    // 25 free slots in the chest: slots 25 and 24 go (one for the paper, one spare for the crafted rockets)
    expect(r).toMatchObject({ ok: true, loose: 22, fromHome: 22, room: 'made room: unloaded 2 stacks (64 tuff, 64 calcite)' });
    expect(h.inv.filter((s) => !s)).toHaveLength(1);
    const k = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('paper', 30)] } }, inv: [item('diamond_sword', 1), ...Array.from({ length: 35 }, () => item('bread', 64))] });
    await k.logistics.scan(never);
    const no = await supplyOn(k).ensure('paper', 22, { home: true });
    expect(no.ok).toBe(false);
    expect(no.reason).toBe('my inventory is full (no room made: nothing to unload (what I carry is kept, or no chest has room for it))');
  });

  it('a carried box of loot stays carried (an unload of loot, never of the boxes)', async () => {
    const inv = fullInventory();
    inv[34] = item('red_shulker_box', 1);
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('bucket', 16)] } }, inv, invRaws: Object.assign([], { 34: nbt([{ name: 'stone', count: 64 }]) }) });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('bucket', ['bucket']), want: 2 });
    expect(r.ok).toBe(true);
    expect(h.inv[34]?.name).toBe('red_shulker_box');
  });
});
