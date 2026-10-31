// Track BJ (decision 0052, review of 01b9b9d): the supply layer never loses a box. `!bring`'s extract box goes back into
// its chest also when the extract fails or is interrupted (at once, else as a debt the next withdrawal or unload settles;
// a box that cannot be placed comes whole); a box whose break was interrupted stays `standing` until `recover` breaks
// it; a cancel never leaves a box on the ground; ensure needs free slots, stops on any failure of a round and runs
// under the logistics' serial lock; the unload's box and fill steps hold the crop and seed reserve back.
import { describe, expect, it } from 'vitest';
import { isShulkerBox, shulkerContents } from '../../../src/skills/container/chest.ts';
import { resolveBringItem } from '../../../src/skills/home/bring.ts';
import { heldBack } from '../../../src/skills/home/unloader.ts';
import { BoxOps } from '../../../src/skills/supply/boxes.ts';
import { Supply } from '../../../src/skills/supply/supply.ts';
import { fakeHome, item, nbt } from './home-fakes.ts';

const never = () => false;
const stacks = (name: string, n: number, count = 64) => Array.from({ length: n }, () => ({ name, count }));
const dirt = resolveBringItem('dirt', ['dirt']);

/** Chest 3 0 0 with one box of 27 stacks of dirt (and `fill` more stacks of stone). */
function dirtHome(fill = 0) {
  const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('undyed_shulker_box', 1), ...Array.from({ length: fill }, () => item('stone'))], raws: [nbt(stacks('dirt', 27))] } }, inv: [] });
  h.settings.set('throwawayMin', '0');
  return h;
}
const chestBoxes = (h: ReturnType<typeof dirtHome>) => {
  const c = h.boxes.get('3,0,0')!;
  return c.slots.flatMap((x, i) => (x && isShulkerBox(x.name) ? [shulkerContents(c.raws[i])] : []));
};
const carriedBoxes = (h: ReturnType<typeof dirtHome>) => h.inv.filter((x) => x && isShulkerBox(x.name)).length;
const onGround = (h: ReturnType<typeof dirtHome>) => [...h.boxes.keys()].filter((k) => k !== '3,0,0');

function supplyOn(h: ReturnType<typeof fakeHome>, serial?: <T>(fn: () => Promise<T>) => Promise<T>): { s: Supply; ops: BoxOps } {
  const ops = new BoxOps({ state: h.logistics.boxes.state, skills: h.logistics.skillsForBoxes(), inventory: h.inventory, blockAt: h.blockAt, position: h.position, keepName: () => 'bot_loot', selectHotbar: h.select, label: 'supply' });
  return { s: new Supply({ ops, inventory: h.inventory, keepName: () => 'bot_loot', ...(serial ? { serial } : {}) }), ops };
}

describe("!bring's extract never loses the box", () => {
  it('the box cannot be placed: it comes whole (as before the extract)', async () => {
    const h = dirtHome();
    await h.logistics.scan(never);
    h.fail.place = true;
    const r = await h.logistics.withdraw(never, { item: dirt, want: 10 });
    expect(r).toMatchObject({ ok: true, boxes: [{ items: 1728, from: 'chest 3 0 0' }] });
    expect(carriedBoxes(h)).toBe(1);
    expect(onGround(h)).toEqual([]);
  });

  it('interrupted right after the place: the box is picked up, and the next unload puts it back into its chest first', async () => {
    const h = dirtHome();
    await h.logistics.scan(never);
    let stop = false;
    h.fail.onPlaced = () => {
      stop = true;
    };
    const r = await h.logistics.withdraw(() => stop, { item: dirt, want: 10 });
    expect(r.reason).toBe('interrupted');
    expect(onGround(h)).toEqual([]);
    expect(carriedBoxes(h)).toBe(1);
    h.fail.onPlaced = undefined;
    await h.logistics.unload(never);
    expect(carriedBoxes(h)).toBe(0);
    expect(chestBoxes(h)).toEqual([{ dirt: 1728 }]);
  });

  it('the chest is full when the box should go back: a debt; the next withdrawal puts it back first', async () => {
    const h = dirtHome(26);
    await h.logistics.scan(never);
    // someone fills the freed slot while the bot takes the dirt out
    h.fail.onDig = () => {
      const c = h.boxes.get('3,0,0')!;
      const i = c.slots.findIndex((x) => !x);
      if (i >= 0) c.slots[i] = item('stone');
    };
    const r = await h.logistics.withdraw(never, { item: dirt, want: 10 });
    expect(r.taken).toEqual({ dirt: 10 });
    expect(r.extracted).toEqual([{ items: 10, from: 'chest 3 0 0', back: false }]);
    expect(carriedBoxes(h)).toBe(1);
    h.fail.onDig = undefined;
    const c = h.boxes.get('3,0,0')!;
    c.slots[c.slots.findIndex((x) => x?.name === 'stone')] = null;
    await h.logistics.withdraw(never, { item: dirt, want: 10 }); // carried already: nothing to take, the debt first
    expect(carriedBoxes(h)).toBe(0);
    expect(chestBoxes(h)).toEqual([{ dirt: 1718 }]);
  });

  it('the break is interrupted: the box stays standing (the chore ignores it) until the next job breaks it and puts it back', async () => {
    const h = dirtHome();
    await h.logistics.scan(never);
    h.fail.digInterrupt = true;
    const r = await h.logistics.withdraw(never, { item: dirt, want: 10 });
    expect(r.reason).toBe('interrupted');
    const standing = onGround(h);
    expect(standing).toHaveLength(1);
    expect(h.logistics.boxes.standing.has(standing[0]!)).toBe(true);
    await h.logistics.unload(never);
    expect(onGround(h)).toEqual([]);
    expect(h.logistics.boxes.standing.size).toBe(0);
    expect(chestBoxes(h)).toEqual([{ dirt: 1718 }]);
  });

  it('a mixed box with a few of the item is taken out of, never brought whole for a big need', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('undyed_shulker_box', 1)], raws: [nbt([{ name: 'dirt', count: 5 }, ...stacks('stone', 20)])] } }, inv: [] });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: dirt, want: 1000 });
    expect(r.boxes).toEqual([]);
    expect(r.taken).toEqual({ dirt: 5 });
    expect(r.extracted).toEqual([{ items: 5, from: 'chest 3 0 0', back: true }]);
    expect(h.memory.get({ x: 3, y: 0, z: 0 })!.boxList).toEqual([{ stone: 1280 }]);
  });
});

describe('BoxOps and Supply: no box left behind', () => {
  it('the place marks the cell standing before the box is there; a cancel picks the box up again', async () => {
    const h = fakeHome({ containers: {}, inv: [item('undyed_shulker_box', 1)], invRaws: [nbt(stacks('cobblestone', 3))] });
    const { s, ops } = supplyOn(h);
    let stop = false;
    let markedFirst = false;
    h.fail.onPlaced = (key) => {
      markedFirst = ops.standing.has(key);
      stop = true;
    };
    const r = await s.ensure('cobblestone', 50, { cancelled: () => stop });
    expect(markedFirst).toBe(true);
    expect(r.reason).toBe('interrupted');
    expect(h.boxes.size).toBe(0);
    expect(ops.standing.size).toBe(0);
    expect(ops.leftBoxes).toEqual([]);
    expect(carriedBoxes(h)).toBe(1);
  });

  it('ensure with a full inventory: no box placed, the reason said', async () => {
    const h = fakeHome({ containers: {}, inv: [item('undyed_shulker_box', 1), ...Array.from({ length: 35 }, () => item('stone'))], invRaws: [nbt(stacks('cobblestone', 3))] });
    const { s } = supplyOn(h);
    const r = await s.ensure('cobblestone', 10);
    expect(r).toMatchObject({ ok: false, loose: 0, fromBoxes: 0, reason: 'my inventory is full' });
    expect(h.calls.some((c) => c.startsWith('place'))).toBe(false);
  });

  it('a round that does not end emptied (the box not picked up) ends ensure; the box is fetched by the next one', async () => {
    const h = fakeHome({ containers: {}, inv: [item('undyed_shulker_box', 1), item('undyed_shulker_box', 1)], invRaws: [nbt(stacks('cobblestone', 1)), nbt(stacks('cobblestone', 2))] });
    const { s, ops } = supplyOn(h);
    h.fail.pickup = true;
    const r = await s.ensure('cobblestone', 150);
    expect(h.calls.filter((c) => c.startsWith('place'))).toHaveLength(1);
    expect(r.reason).toMatch(/^the box was not picked up again/);
    expect(ops.leftBoxes).toHaveLength(1);
    h.fail.pickup = false;
    await s.ensure('cobblestone', 150);
    expect(ops.leftBoxes).toHaveLength(0);
    expect(carriedBoxes(h)).toBe(2);
  });

  it('ensure and stow run under the serial lock; room keeps a margin', async () => {
    const h = fakeHome({ containers: {}, inv: [item('undyed_shulker_box', 1), item('cobblestone', 60)], invRaws: [nbt(stacks('cobblestone', 3))] });
    const locked: string[] = [];
    const { s } = supplyOn(h, async (fn) => {
      locked.push('in');
      const r = await fn();
      locked.push('out');
      return r;
    });
    await s.ensure('cobblestone', 100);
    await s.stow('cobblestone', 10);
    expect(locked).toEqual(['in', 'out', 'in', 'out']);
    // 34 free slots, 4 kept free: 30 stacks, plus the room in the partial stack
    expect(s.room('cobblestone')).toBe(30 * 64 + 54);
  });
});

describe('the unload holds the crop and seed reserve back in box and fill steps', () => {
  it('heldBack: the throwaway reserve and the crop / seed reserve, summed', () => {
    const slots = [
      { slot: 0, name: 'carrot', count: 64 },
      { slot: 1, name: 'carrot', count: 64 },
      { slot: 2, name: 'wheat_seeds', count: 64 },
      { slot: 3, name: 'cobblestone', count: 64 },
    ];
    const h = heldBack(slots, { reserve: 16, foodReserve: 64, seedReserve: 32 });
    expect(Object.fromEntries(h.all)).toEqual({ cobblestone: 16, carrot: 64, wheat_seeds: 32 });
  });

  it('a box step of carrots (their chest full) tops the box up with the surplus only: the food reserve stays loose', async () => {
    const h = fakeHome({
      containers: { '3,0,0': { kind: 'chest', items: [...Array.from({ length: 20 }, () => item('carrot')), ...Array.from({ length: 7 }, () => item('stone'))] }, '-3,0,0': { kind: 'chest', items: [item('undyed_shulker_box', 1), item('undyed_shulker_box', 1)] } },
      inv: [item('carrot'), item('carrot'), item('wheat_seeds')],
    });
    h.settings.set('throwawayMin', '0');
    await h.logistics.scan(never);
    const r = await h.logistics.unload(never);
    expect(r.boxed?.length).toBe(1);
    const loose = (n: string) => h.inv.reduce((a, x) => a + (x?.name === n ? x.count : 0), 0);
    expect(loose('carrot')).toBe(64); // the food reserve: never packed
    expect(loose('wheat_seeds')).toBe(32); // the seed reserve
    expect(r.kept).toContainEqual({ name: 'carrot', count: 64, why: 'food_reserve' });
  });
});
