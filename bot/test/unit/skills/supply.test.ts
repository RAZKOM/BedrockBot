// Track BJ (wave 12, decision 0052, docs/home.md "Supply"): the supply layer on the fake home of the logistics
// tests (home-fakes.ts): what is available (loose, carried boxes, home chests), ensure (a carried box placed off
// the cells to avoid, just what is missing taken out, the box picked up; the home route through `!bring`'s
// withdrawal), stow (the surplus back into a carried box), the throwaway top-up; and `!bring`'s extract (a few
// items out of a box in a chest: the box goes back).
import { describe, expect, it } from 'vitest';
import { resolveBringItem } from '../../../src/skills/home/bring.ts';
import { BoxOps } from '../../../src/skills/supply/boxes.ts';
import { Supply } from '../../../src/skills/supply/supply.ts';
import { shulkerContents } from '../../../src/skills/container/chest.ts';
import { fakeHome, item, nbt } from './home-fakes.ts';

const never = () => false;
const stacks = (name: string, n: number, count = 64) => Array.from({ length: n }, () => ({ name, count }));

function supplyOn(h: ReturnType<typeof fakeHome>, home = false): Supply {
  const ops = new BoxOps({ skills: h.logistics.skillsForBoxes(), inventory: h.inventory, blockAt: h.blockAt, position: h.position, keepName: () => 'bot_loot', selectHotbar: h.select, label: 'supply' });
  return new Supply({ ops, inventory: h.inventory, keepName: () => 'bot_loot', ...(home ? { records: () => h.logistics.records(), withdraw: (c, req) => h.logistics.withdraw(c, req) } : {}) });
}

describe('supply: carried boxes', () => {
  it('available counts loose, carried boxes and the chests at home', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('cobblestone', 64), item('undyed_shulker_box', 1)], raws: [undefined, nbt(stacks('cobblestone', 2))] } }, inv: [item('cobblestone', 10), item('red_shulker_box', 1)], invRaws: [undefined, nbt(stacks('cobblestone', 3))] });
    await h.logistics.scan(never);
    expect(supplyOn(h, true).available('cobblestone')).toEqual({ loose: 10, carried: 192, home: 192, total: 394 });
    expect(supplyOn(h).available('cobblestone').home).toBe(0); // no home route given
  });

  it('ensure: the box placed next to the bot, never on a cell to avoid; just what is missing comes out, the box comes back', async () => {
    const h = fakeHome({ containers: {}, inv: [item('undyed_shulker_box', 1)], invRaws: [nbt([...stacks('cobblestone', 3), { name: 'stone', count: 10 }])] });
    const s = supplyOn(h);
    const r = await s.ensure('cobblestone', 50, { avoid: (p) => p.x === 1 && p.z === 0 });
    expect(r).toMatchObject({ ok: true, loose: 50, fromBoxes: 50, fromHome: 0 });
    expect(h.calls.filter((c) => c.startsWith('place'))).toEqual(['place -1,0,0']);
    expect(s.carried('cobblestone')).toBe(142);
    expect(s.carried('stone')).toBe(10);
    expect(h.inv.filter((x) => x?.name === 'undyed_shulker_box')).toHaveLength(1);
    expect(h.boxes.size).toBe(0); // nothing left standing
  });

  it('ensure: short when the boxes hold too little; the throwaway top-up takes any throwaway kind', async () => {
    const h = fakeHome({ containers: {}, inv: [item('undyed_shulker_box', 1)], invRaws: [nbt([{ name: 'dirt', count: 30 }])] });
    const s = supplyOn(h);
    const r = await s.topUpThrowaway(40);
    expect(r).toMatchObject({ ok: false, loose: 30, fromBoxes: 30 });
    expect(r.reason).toBe('no more in the carried boxes');
  });

  it('ensure: nothing carried, the home route brings it (bring withdrawal)', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('torch', 64)] } }, inv: [] });
    await h.logistics.scan(never);
    const s = supplyOn(h, true);
    expect(await s.ensure('torch', 20)).toMatchObject({ ok: false, loose: 0 }); // home off by default
    expect(await s.ensure('torch', 20, { home: true })).toMatchObject({ ok: true, loose: 20, fromHome: 20 });
  });

  it('stow: the surplus beyond keep into the carried box with room, the box picked up again', async () => {
    const h = fakeHome({ containers: {}, inv: [item('undyed_shulker_box', 1), item('cobblestone', 64), item('cobblestone', 64)] });
    const s = supplyOn(h);
    const r = await s.stow('cobblestone', 16);
    expect(r).toEqual({ stowed: 112 });
    expect(s.loose('cobblestone')).toBe(16);
    expect(s.carried('cobblestone')).toBe(112);
    const box = h.inv.findIndex((x) => x?.name === 'undyed_shulker_box');
    expect(shulkerContents(h.invRaws[box])).toEqual({ cobblestone: 112 });
  });
});

describe('!bring: a few out of a box in a chest (Track BJ extract)', () => {
  it('!bring dirt 10 from a chest of full dirt boxes: 10 dirt, the box goes back with the rest', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('undyed_shulker_box', 1)], raws: [nbt(stacks('dirt', 27))] } }, inv: [] });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('dirt', ['dirt']), want: 10 });
    expect(r).toMatchObject({ ok: true, taken: { dirt: 10 }, boxes: [], extracted: [{ items: 10, from: 'chest 3 0 0', back: true }], carried: 10 });
    expect(h.memory.get({ x: 3, y: 0, z: 0 })!.boxList).toEqual([{ dirt: 1718 }]);
    expect(h.inv.filter((x) => !!x).map((x) => `${x.count} ${x.name}`)).toEqual(['10 dirt']);
    expect(h.calls.some((c) => c.startsWith('place'))).toBe(true);
  });

  it('loose dirt in the chest: no box is touched for a small need', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('dirt', 64), item('undyed_shulker_box', 1)], raws: [undefined, nbt(stacks('dirt', 27))] } }, inv: [] });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: resolveBringItem('dirt', ['dirt']), want: 10 });
    expect(r).toMatchObject({ ok: true, taken: { dirt: 10 }, boxes: [] });
    expect(r.extracted).toBeUndefined();
    expect(h.calls.some((c) => c.startsWith('place'))).toBe(false);
  });
});
