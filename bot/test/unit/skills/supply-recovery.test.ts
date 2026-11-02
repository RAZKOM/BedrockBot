// Track BJ (decision 0052, review of 32eb6a2): the supply layer never loses a box. `!bring`'s extract box goes back into
// its chest also when the extract fails or is interrupted (at once, else as a debt the next withdrawal or unload settles;
// a box that cannot be placed comes whole); a box whose break was interrupted stays `standing` until `recover` breaks
// it; a cancel never leaves a box on the ground; ensure needs free slots, stops on any failure of a round and runs
// under the logistics' serial lock; the unload's box and fill steps hold the crop and seed reserve back.
import { describe, expect, it } from 'vitest';
import { isShulkerBox, shulkerContents } from '../../../src/skills/container/chest.ts';
import { resolveBringItem } from '../../../src/skills/home/bring.ts';
import { unloadLine } from '../../../src/skills/home/logistics.ts';
import { heldBack } from '../../../src/skills/home/unloader.ts';
import { BoxOps, MAX_FETCH_TRIES } from '../../../src/skills/supply/boxes.ts';
import { Supply } from '../../../src/skills/supply/supply.ts';
import { fakeHome, item, namedBox, nbt } from './home-fakes.ts';

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

describe('second review (dc333dd): owed boxes, retries, far boxes, short clean-up', () => {
  /** A withdrawal whose box could not go back (the chest filled meanwhile): the box is owed to chest 3 0 0. */
  async function owedHome() {
    const h = dirtHome(26);
    await h.logistics.scan(never);
    h.fail.onDig = () => {
      const c = h.boxes.get('3,0,0')!;
      const i = c.slots.findIndex((x) => !x);
      if (i >= 0) c.slots[i] = item('stone');
    };
    await h.logistics.withdraw(never, { item: dirt, want: 10 });
    h.fail.onDig = undefined;
    return h;
  }

  it('S1/S2: an owed box (found by its NBT) is no Supply source and no unload item', async () => {
    const h = await owedHome();
    const slot = h.inv.findIndex((x) => x && isShulkerBox(x.name));
    expect(h.logistics.owedSlots()).toEqual(new Set([slot]));
    const ops = new BoxOps({ state: h.logistics.boxes.state, skills: h.logistics.skillsForBoxes(), inventory: h.inventory, blockAt: h.blockAt, position: h.position, keepName: () => 'bot_loot' });
    const s = new Supply({ ops, inventory: h.inventory, keepName: () => 'bot_loot', owed: () => h.logistics.owedSlots() });
    expect(s.boxes()).toEqual([]);
    expect(s.carried('dirt')).toBe(0);
    expect(h.logistics.slots().some((x) => x.slot === slot)).toBe(false);
  });

  it('S3: the chest still full: the debt is kept and said, given up after MAX_DEBT_TRIES; no box filed elsewhere', async () => {
    const h = await owedHome();
    const r1 = await h.logistics.unload(never);
    expect(r1.notes?.[0]).toMatch(/^the shulker box from chest 3 0 0 could not go back yet/);
    expect(carriedBoxes(h)).toBe(1);
    await h.logistics.unload(never);
    const r3 = await h.logistics.unload(never);
    expect(r3.notes?.[0]).toMatch(/^gave up putting the shulker box back into chest 3 0 0/);
    expect(unloadLine(r3)).toContain('gave up putting the shulker box back');
    const r4 = await h.logistics.unload(never);
    expect(r4.notes).toBeUndefined();
  });

  it('S1: an owed box whose contents changed is not silently dropped: the debt stays and is said', async () => {
    const h = await owedHome();
    const c = h.boxes.get('3,0,0')!;
    c.slots[c.slots.findIndex((x) => x?.name === 'stone')] = null;
    const slot = h.inv.findIndex((x) => x && isShulkerBox(x.name));
    h.invRaws[slot] = nbt(stacks('dirt', 5)); // changed meanwhile
    const r = await h.logistics.unload(never);
    expect(r.notes?.[0]).toMatch(/could not go back yet \(the box is not with me/);
  });

  it('S4: a bot_loot box in a chest is never taken out of', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('undyed_shulker_box', 1)], raws: [namedBox('bot_loot', stacks('dirt', 27))] } }, inv: [] });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: dirt, want: 10 });
    expect(r.extracted).toBeUndefined();
    expect(h.calls.some((x) => x.startsWith('place'))).toBe(false);
  });

  it('S5: a box of nothing but the item, no more than needed: it comes whole (no empty box goes back)', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('undyed_shulker_box', 1)], raws: [nbt([{ name: 'dirt', count: 300 }])] } }, inv: [] });
    await h.logistics.scan(never);
    const r = await h.logistics.withdraw(never, { item: dirt, want: 500 });
    expect(r.boxes).toEqual([{ name: 'undyed_shulker_box', items: 300, from: 'chest 3 0 0' }]);
    expect(r.extracted).toBeUndefined();
    expect(chestBoxes(h)).toEqual([]);
  });

  it('M2: a box left far away is not walked to (kept); an unfindable one is given up after MAX_FETCH_TRIES (said)', async () => {
    const h = fakeHome({ containers: {}, inv: [item('undyed_shulker_box', 1)], invRaws: [nbt(stacks('cobblestone', 3))] });
    const said: string[] = [];
    const ops = new BoxOps({ state: h.logistics.boxes.state, skills: h.logistics.skillsForBoxes(), inventory: h.inventory, blockAt: h.blockAt, position: h.position, keepName: () => 'bot_loot', notify: (l) => said.push(l) });
    ops.leftBoxes.push({ x: 100, y: 0, z: 0 });
    await ops.recover(never);
    expect(h.calls.filter((x) => x.startsWith('goto'))).toEqual([]);
    expect(ops.leftBoxes).toEqual([{ x: 100, y: 0, z: 0 }]);
    ops.leftBoxes.length = 0;
    ops.leftBoxes.push({ x: 2, y: 0, z: 0 }); // near, but nothing lies there
    for (let i = 0; i < MAX_FETCH_TRIES + 1; i++) await ops.fetchLeft(never, true);
    expect(h.calls.filter((x) => x.startsWith('goto'))).toHaveLength(MAX_FETCH_TRIES);
    expect(ops.leftBoxes).toEqual([]);
    expect(ops.pending).toBe(false);
    expect(said).toEqual(['gave up on the shulker box left at 2 0 0 (not found)']);
  });

  it('S6: cancelled at the box: one break and one pickup close by, no walk; the rest is left to recover (said)', async () => {
    const h = fakeHome({ containers: {}, inv: [item('undyed_shulker_box', 1)], invRaws: [nbt(stacks('cobblestone', 3))] });
    const said: string[] = [];
    const ops = new BoxOps({ state: h.logistics.boxes.state, skills: h.logistics.skillsForBoxes(), inventory: h.inventory, blockAt: h.blockAt, position: h.position, keepName: () => 'bot_loot', selectHotbar: h.select, notify: (l) => said.push(l) });
    let stop = false;
    let opened = false;
    h.fail.onPlaced = () => {
      opened = true;
    };
    const r = await ops.takeOut(0, { requests: 0 }, () => {
      // cancelled once the box stands and is being worked on
      if (opened && !stop && h.calls.includes('close')) {
        stop = true;
        h.fail.pickup = true; // the pickup misses
      }
      return stop;
    });
    expect(r).toBe('interrupted');
    const after = h.calls.slice(h.calls.indexOf('close') + 1);
    expect(after.filter((x) => x.startsWith('dig'))).toHaveLength(1);
    expect(after.filter((x) => x === 'collect')).toHaveLength(1);
    expect(after.filter((x) => x.startsWith('goto'))).toEqual([]);
    expect(ops.leftBoxes).toHaveLength(1);
    expect(said[0]).toMatch(/^left a shulker box on the ground at /);
  });
});
