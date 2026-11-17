// Track BJ (wave 12, decision 0052, docs/home.md "Supply"): the supply layer on the fake home of the logistics
// tests (home-fakes.ts): what is available (loose, carried boxes, home chests), ensure (a carried box placed off
// the cells to avoid, just what is missing taken out, the box picked up; the home route through `!bring`'s
// withdrawal), stow (the surplus back into a carried box), the throwaway top-up; and `!bring`'s extract (a few
// items out of a box in a chest: the box goes back).
import { readFileSync } from 'node:fs';
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

  it('Track K2: empty buckets from home: `bucket` is the empty bucket only (no milk or water bucket); fewer there than remembered says so', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [item('milk_bucket', 1), item('water_bucket', 1), item('bucket', 5)] } }, inv: [] });
    await h.logistics.scan(never);
    const s = supplyOn(h, true);
    expect(s.available('bucket')).toMatchObject({ loose: 0, carried: 0, home: 5 });
    expect(await s.ensure('bucket', 2, { home: true })).toMatchObject({ ok: true, loose: 2, fromHome: 2 });
    expect(h.inv.filter((x) => x && x.name !== 'bucket')).toEqual([]);
    // the chest emptied behind the memory: the withdrawal ends "done" with none, the reason says it
    h.boxes.get('3,0,0')!.slots[2] = null;
    const r = await s.ensure('bucket', 4, { home: true });
    expect(r).toMatchObject({ ok: false, loose: 2, fromHome: 0 });
    expect(r.reason).toBe('the chests at home gave none (fewer there than remembered)');
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

describe('Track V1c: the box in the main inventory with the hotbar full (the room chore\'s box and rocket steps)', () => {
  /** Nine hotbar stacks, the box in slot 12, cobblestone in 13 and 14. */
  const layout = () => {
    const inv: ({ name: string; count: number } | null)[] = Array.from({ length: 36 }, () => null);
    for (let i = 0; i < 9; i++) inv[i] = item(['bread', 'torch', 'stick', 'bone', 'arrow', 'feather', 'paper', 'leather', 'flint'][i]!, 5);
    inv[12] = item('undyed_shulker_box', 1);
    inv[13] = item('cobblestone', 64);
    inv[14] = item('cobblestone', 64);
    return inv;
  };
  const opsOn = (h: ReturnType<typeof fakeHome>, toHotbar?: (slot: number) => Promise<number | string>) =>
    new Supply({ ops: new BoxOps({ skills: h.logistics.skillsForBoxes(), inventory: h.inventory, blockAt: h.blockAt, position: h.position, keepName: () => 'bot_loot', selectHotbar: h.select, label: 'supply', ...(toHotbar ? { toHotbar } : {}) }), inventory: h.inventory, keepName: () => 'bot_loot' });

  it('the box is brought into the hotbar by the kit\'s exchange, then placed and filled', async () => {
    const h = fakeHome({ containers: {}, inv: layout() as never });
    const asked: number[] = [];
    const s = opsOn(h, (slot) => {
      asked.push(slot);
      // the kit's exchange: the box into hotbar slot 8, the flint into its slot
      const box = h.inv[slot]!;
      h.inv[slot] = h.inv[8]!;
      h.inv[8] = box;
      h.invRaws[8] = h.invRaws[slot];
      h.invRaws[slot] = undefined;
      return Promise.resolve(8);
    });
    const r = await s.putInto(12, () => [13, 14].filter((i) => h.inv[i]?.name === 'cobblestone').map((i) => ({ slot: i, count: 64, name: 'cobblestone' })));
    expect(asked).toEqual([12]);
    expect(r).toMatchObject({ moved: 128 });
    expect(r.reason).toBeUndefined();
    expect(h.calls.some((c) => c.startsWith('place'))).toBe(true);
  });

  it('the kit\'s reason when the box does not come in (the Realm said only `the box is not in the hotbar`)', async () => {
    const h = fakeHome({ containers: {}, inv: layout() as never });
    const s = opsOn(h, () => Promise.resolve('the box is not in the hotbar: the survival kit stayed busy (a keeper pass, a meal or the armour)'));
    const r = await s.putInto(12, () => [{ slot: 13, count: 64, name: 'cobblestone' }]);
    expect(r.moved).toBe(0);
    expect(r.reason).toBe('the box is not in the hotbar: the survival kit stayed busy (a keeper pass, a meal or the armour)');
    expect(h.calls.some((c) => c.startsWith('place'))).toBe(false);
  });

  it('a box that gets no container_open on the first click is clicked once more (the Realm fullbar case)', async () => {
    const h = fakeHome({ containers: {}, inv: [item('undyed_shulker_box', 1), item('cobblestone', 64)] });
    const base = h.logistics.skillsForBoxes();
    let opens = 0;
    const skills = { ...base, open: (p: { x: number; y: number; z: number }) => (++opens === 1 ? Promise.resolve({ ok: false as const, reason: 'timeout' }) : base.open(p)) };
    const s = new Supply({ ops: new BoxOps({ skills, inventory: h.inventory, blockAt: h.blockAt, position: h.position, keepName: () => 'bot_loot', selectHotbar: h.select, label: 'supply' }), inventory: h.inventory, keepName: () => 'bot_loot' });
    const r = await s.putInto(0, () => (h.inv[1]?.name === 'cobblestone' ? [{ slot: 1, count: 64, name: 'cobblestone' }] : []));
    expect(opens).toBe(2);
    expect(r).toMatchObject({ moved: 64 });
    expect(h.boxes.size).toBe(0);
  });

  describe('Track V1 follow-up 3: the box followed through the exchange (the Realm 2026-11-16: the fireworks box exchanged into the box\'s old slot)', () => {
    /** The Realm's layout: a full hotbar whose only slot to give is the fireworks box (red, hotbar 2), the empty box in 18, loot in 20 and 21. */
    const realm = () => {
      const inv: ({ name: string; count: number } | null)[] = Array.from({ length: 36 }, () => null);
      for (let i = 0; i < 9; i++) inv[i] = item(['netherite_sword', 'netherite_pickaxe', 'red_shulker_box', 'firework_rocket', 'elytra', 'netherite_axe', 'netherite_shovel', 'bow', 'firework_rocket'][i]!, 1);
      inv[18] = item('green_shulker_box', 1);
      inv[20] = item('bone', 64);
      inv[21] = item('bone', 30);
      for (let i = 9; i < 36; i++) if (!inv[i] && i !== 30) inv[i] = item('stick', 1);
      return inv;
    };
    const rocketsBox = nbt([{ name: 'firework_rocket', count: 64 }]);
    /** The kit's exchange: the box into hotbar 2, the fireworks box into the box's old slot. */
    const exchange = (h: ReturnType<typeof fakeHome>) => (slot: number) => {
      const [a, ra] = [h.inv[slot], h.invRaws[slot]];
      h.inv[slot] = h.inv[2]!;
      h.invRaws[slot] = h.invRaws[2];
      h.inv[2] = a!;
      h.invRaws[2] = ra;
      return Promise.resolve(2);
    };
    const bones = (h: ReturnType<typeof fakeHome>) => () => [20, 21].filter((i) => h.inv[i]?.name === 'bone').map((i) => ({ slot: i, count: h.inv[i]!.count, name: 'bone' }));
    const setUp = () => {
      const h = fakeHome({ containers: {}, inv: realm() as never, invRaws: Object.assign([], { 2: rocketsBox }) });
      return { h, s: opsOn(h, exchange(h)) };
    };

    it('another box moved while the box was placed (a resync, a keeper move): still the right box, the loot boxed', async () => {
      const { h, s } = setUp();
      // the server's inventory renumbered after the place: the fireworks box now in slot 30 (its raw a fresh object)
      h.fail.onPlaced = () => {
        h.inv[30] = h.inv[18]!;
        h.invRaws[30] = JSON.parse(JSON.stringify(h.invRaws[18])) as unknown;
        h.inv[18] = null;
        h.invRaws[18] = undefined;
      };
      const r = await s.putInto(18, bones(h));
      expect(r.reason).toBeUndefined();
      expect(r.moved).toBe(94);
      expect(shulkerContents(h.invRaws[h.inv.findIndex((x) => x?.name === 'green_shulker_box')])).toEqual({ bone: 94 });
      expect(shulkerContents(h.invRaws[h.inv.findIndex((x) => x?.name === 'red_shulker_box')])).toEqual({ firework_rocket: 64 });
    });

    it('the exchange alone: the box placed from hotbar 2, the fireworks box untouched in 18', async () => {
      const { h, s } = setUp();
      const r = await s.putInto(18, bones(h));
      expect(r).toEqual({ moved: 94 });
      expect(h.inv[18]?.name).toBe('red_shulker_box');
    });

    it('the fireworks box placed instead (the server took another slot): judged the wrong box and picked up again', async () => {
      const { h, s } = setUp();
      h.fail.onPlaced = (key) => {
        // what was placed is the red box: green back where it was, red gone from 18
        const b = h.boxes.get(key)!;
        b.kind = 'red_shulker_box';
        h.inv[2] = item('green_shulker_box', 1);
        h.invRaws[2] = nbt([]);
        h.inv[18] = null;
        h.invRaws[18] = undefined;
      };
      const r = await s.putInto(18, bones(h));
      expect(r.moved).toBe(0);
      expect(r.reason).toMatch(/^placed another box than the one wanted \(picked it up again\)/);
      expect(r.reason).toContain('red_shulker_box');
    });
  });

  it('the wiring asks the kit for its reason (commands-home.ts: hotbarWhy, not the bare fallback)', () => {
    const src = readFileSync(new URL('../../../src/chat/commands-home.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/toHotbar: async \(slot\) => \{[\s\S]{0,300}hotbarWhy\(slot\)/);
    expect(src).not.toMatch(/hotbar\(slot\)\) \?\? 'the box is not in the hotbar'/);
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
