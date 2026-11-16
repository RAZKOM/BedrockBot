// Wave 9 Track AG: the unloading decision (skills/home/unloader.ts), the categories behind chest
// labels (categories.ts) and the memory lines of !stock / !chests (memory.ts). Pure, no fakes needed.
import { describe, expect, it } from 'vitest';
import { categoryOf, labelCategory, labelMatches } from '../../../src/skills/home/categories.ts';
import { chestsLine, itemMatches, itemQuery, kindsLine, kindWord, planChests, recordFrom, stockLine, unreachableLines, unreadRecord } from '../../../src/skills/home/memory.ts';
import { gearKept, planUnload, reserveByKind, spareChestState, unloadableStacks, type PlanChest, type UnloadSlot } from '../../../src/skills/home/unloader.ts';
import { snapshotOf } from '../../../src/skills/container/chest.ts';
import { ChestMemory } from '../../../src/world/cache/chests.ts';

let n = 0;
const chest = (o: Partial<PlanChest> & { key?: string }): PlanChest => {
  const i = n++;
  return { key: o.key ?? `c${i}`, pos: o.pos ?? { x: i * 3, y: 0, z: 0 }, kind: o.kind ?? 'chest', label: o.label, free: o.free ?? 27, contents: o.contents ?? {}, room: o.room ?? {}, boxes: o.boxes ?? { empty: 0, full: 0 } };
};
const s = (slot: number, name: string, count = 64, boxUsed?: number): UnloadSlot => ({ slot, name, count, ...(boxUsed !== undefined ? { boxUsed } : {}) });

describe('unloader: the decision table', () => {
  it('gear: the best of each class stays (the worn armour counts), worse pieces and bows go; spares of the best rank stay', () => {
    const worn = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'];
    const slots = [
      s(0, 'netherite_pickaxe', 1),
      s(1, 'netherite_sword', 1),
      s(2, 'iron_sword', 1),
      s(3, 'leather_chestplate', 1),
      s(4, 'golden_boots', 1),
      s(5, 'bow', 1),
      s(6, 'crossbow', 1),
      s(7, 'netherite_pickaxe', 1),
      s(8, 'stone_pickaxe', 1),
      s(9, 'shield', 1),
      s(10, 'cooked_beef', 16),
      s(11, 'golden_helmet', 1),
    ];
    expect([...gearKept(slots, worn)].sort((a, b) => a - b)).toEqual([0, 1, 7, 9]);
    // nothing worn: the best carried piece of each armour slot stays
    expect([...gearKept([s(0, 'leather_chestplate', 1), s(1, 'iron_chestplate', 1), s(2, 'golden_boots', 1)])].sort()).toEqual([1, 2]);
    const p = planUnload(slots, [chest({ key: 'c' })], { worn });
    expect(p.moves.map((m) => m.name).sort()).toEqual(['bow', 'crossbow', 'golden_boots', 'golden_helmet', 'iron_sword', 'leather_chestplate', 'stone_pickaxe']);
    expect(p.kept.map((k) => `${k.count} ${k.name}`).sort()).toEqual(['1 netherite_sword', '1 shield', '16 cooked_beef', '2 netherite_pickaxe']);
  });

  it('rule 1: a chest that already holds the item, the one holding most first', () => {
    const a = chest({ key: 'a', contents: { coal: 10 }, room: { coal: 54 }, free: 26 });
    const b = chest({ key: 'b', contents: { coal: 100 }, room: { coal: 28 }, free: 20 });
    const e = chest({ key: 'e' });
    const p = planUnload([s(0, 'coal')], [a, b, e]);
    expect(p.moves).toEqual([{ slot: 0, name: 'coal', count: 64, to: 'b', rule: 'same' }]);
    expect(p.overflow).toEqual([]);
  });

  it('rule 2: a chest labelled for the category; rule 3: the emptiest unlabelled chest', () => {
    const wood = chest({ key: 'wood', label: 'wood', free: 5 });
    const ores = chest({ key: 'ores', label: 'ores and metals', free: 3 });
    const full = chest({ key: 'full', free: 26 });
    const emptier = chest({ key: 'emptier', free: 27 });
    const p = planUnload([s(0, 'oak_log'), s(1, 'raw_iron', 10), s(2, 'andesite', 30)], [wood, ores, full, emptier]);
    expect(p.moves).toEqual([
      { slot: 0, name: 'oak_log', count: 64, to: 'wood', rule: 'label' },
      { slot: 1, name: 'raw_iron', count: 10, to: 'ores', rule: 'label' },
      { slot: 2, name: 'andesite', count: 30, to: 'emptier', rule: 'emptiest' },
    ]);
  });

  it('a labelled chest that does not match is not a target; a chest with no free slot and no partial stack is skipped', () => {
    const food = chest({ key: 'food', label: 'food', free: 27 });
    const full = chest({ key: 'full', free: 0, contents: { coal: 64 * 27 } });
    const partial = chest({ key: 'partial', free: 0, contents: { dirt: 20 }, room: { dirt: 44 } });
    const p = planUnload([s(0, 'coal'), s(1, 'dirt', 50)], [food, full, partial], { reserve: 0 });
    expect(p.moves).toEqual([{ slot: 1, name: 'dirt', count: 44, to: 'partial', rule: 'same' }]);
    expect(p.overflow).toEqual([
      { slot: 0, name: 'coal', count: 64 },
      { slot: 1, name: 'dirt', count: 6 },
    ]);
  });

  it('a stack is split over chests as they fill (simulated free slots and partial room)', () => {
    const a = chest({ key: 'a', contents: { cobblestone: 60 }, room: { cobblestone: 4 }, free: 1 });
    const b = chest({ key: 'b', free: 27 });
    const p = planUnload([s(0, 'cobblestone'), s(1, 'cobblestone'), s(2, 'cobblestone', 16)], [a, b], { reserve: 0 });
    expect(p.moves).toEqual([
      { slot: 0, name: 'cobblestone', count: 64, to: 'a', rule: 'same' },
      { slot: 1, name: 'cobblestone', count: 4, to: 'a', rule: 'same' },
      { slot: 1, name: 'cobblestone', count: 60, to: 'b', rule: 'emptiest' },
      { slot: 2, name: 'cobblestone', count: 16, to: 'b', rule: 'same' },
    ]);
  });

  it('never unloads food, tools, armour, totems; keeps the throwaway reserve (cobblestone first) from the last slots', () => {
    const e = chest({ key: 'e' });
    const slots = [s(0, 'iron_pickaxe', 1), s(1, 'bread', 5), s(2, 'iron_chestplate', 1), s(3, 'totem_of_undying', 1), s(4, 'cobblestone', 64), s(5, 'cobblestone', 10), s(6, 'dirt', 30), s(7, 'rotten_flesh', 3)];
    const p = planUnload(slots, [e]);
    expect(p.kept).toEqual([
      { name: 'cobblestone', count: 16, why: 'reserve' },
      { name: 'iron_pickaxe', count: 1, why: 'kept' },
      { name: 'bread', count: 5, why: 'kept' },
      { name: 'iron_chestplate', count: 1, why: 'kept' },
      { name: 'totem_of_undying', count: 1, why: 'kept' },
    ]);
    expect(p.moves).toEqual([
      { slot: 4, name: 'cobblestone', count: 58, to: 'e', rule: 'emptiest' },
      { slot: 6, name: 'dirt', count: 30, to: 'e', rule: 'emptiest' },
      { slot: 7, name: 'rotten_flesh', count: 3, to: 'e', rule: 'emptiest' },
    ]);
    expect(reserveByKind([s(0, 'dirt', 10), s(1, 'cobblestone', 5)])).toEqual(new Map([['cobblestone', 5], ['dirt', 10]]));
  });

  it('shulker boxes: one empty box kept; further empty ones and full ones go to the box chest; `all` lists full boxes for emptying', () => {
    const boxes = chest({ key: 'boxes', boxes: { empty: 2, full: 0 }, contents: { undyed_shulker_box: 2 }, free: 25 });
    const other = chest({ key: 'other', free: 27 });
    const placed = chest({ key: 'placed', kind: 'red_shulker_box', free: 27 });
    const slots = [s(0, 'undyed_shulker_box', 1, 0), s(1, 'undyed_shulker_box', 1, 0), s(2, 'red_shulker_box', 1, 5)];
    const p = planUnload(slots, [placed, other, boxes]);
    expect(p.boxChest).toBe('boxes');
    expect(p.kept).toEqual([{ name: 'undyed_shulker_box', count: 1, why: 'stash_box' }]);
    expect(p.moves).toEqual([
      { slot: 1, name: 'undyed_shulker_box', count: 1, to: 'boxes', rule: 'boxes' },
      { slot: 2, name: 'red_shulker_box', count: 1, to: 'boxes', rule: 'boxes' },
    ]);
    const all = planUnload(slots, [placed, other, boxes], { all: true });
    expect(all.fullBoxes).toEqual([2]);
    expect(all.moves.map((m) => m.slot)).toEqual([1]);
    // a box never goes into a placed shulker box
    const onlyPlaced = planUnload([s(0, 'undyed_shulker_box', 1, 3)], [placed]);
    expect(onlyPlaced.moves).toEqual([]);
    expect(onlyPlaced.overflow).toEqual([{ slot: 0, name: 'undyed_shulker_box', count: 1 }]);
  });

  it('ties are broken by distance from the origin', () => {
    const far = chest({ key: 'far', pos: { x: 20, y: 0, z: 0 } });
    const near = chest({ key: 'near', pos: { x: 2, y: 0, z: 0 } });
    expect(planUnload([s(0, 'gravel')], [far, near], { origin: { x: 0, y: 0, z: 0 } }).moves[0]!.to).toBe('near');
  });

  it('unloadableStacks counts the stacks the chore looks at (reserve and kept items left out) and full boxes', () => {
    expect(unloadableStacks([s(0, 'cobblestone', 16), s(1, 'coal'), s(2, 'bread'), s(3, 'undyed_shulker_box', 1, 4)])).toEqual({ stacks: 1, fullBoxes: 1, spares: 0, free: 32 }); // Track V1: spares, free
  });
});

// Track V1 follow-up (ADR 0090 decision 11): the spares job's plan and the chest of spares
describe('unloader: the spares job (planUnload spares)', () => {
  /** The live inventory at home after the room chore's pass: the kit, two stacks of rockets, the fireworks box, 5 empty boxes, loot. */
  const live = (): UnloadSlot[] => [
    s(0, 'netherite_sword', 1),
    s(1, 'netherite_pickaxe', 1),
    s(2, 'firework_rocket', 64),
    s(3, 'cooked_beef', 31),
    s(4, 'bow', 1),
    s(5, 'cobblestone', 16),
    s(6, 'arrow', 15),
    s(7, 'firework_rocket', 64),
    { slot: 17, name: 'undyed_shulker_box', count: 1, boxUsed: 17, flightKit: true, boxItems: { firework_rocket: 459 } },
    s(18, 'green_shulker_box', 1),
    s(19, 'green_shulker_box', 1),
    s(20, 'green_shulker_box', 1),
    s(21, 'green_shulker_box', 1),
    s(22, 'green_shulker_box', 1),
    { slot: 23, name: 'blue_shulker_box', count: 1, boxUsed: 27, boxItems: { sand: 1728 } },
    { slot: 24, name: 'red_shulker_box', count: 1, named: true },
    { slot: 25, name: 'white_shulker_box', count: 1, unknown: true },
    s(29, 'bone', 19),
    s(30, 'redstone', 17),
  ];

  it('only the empty unnamed boxes move, into the chest holding empty boxes; with a named box carried none is held back for the stash', () => {
    const spares = chest({ key: 'spares', boxes: { empty: 3, full: 0 }, free: 24 });
    const coal = chest({ key: 'coal', contents: { bone: 10, redstone: 5 }, free: 20 });
    const p = planUnload(live(), [coal, spares], { spares: true });
    // the named box (slot 24) serves the stash step: all five green boxes go
    expect(p.moves).toEqual([18, 19, 20, 21, 22].map((slot) => ({ slot, name: 'green_shulker_box', count: 1, to: 'spares', rule: 'boxes' })));
    expect(p.overflow).toEqual([]);
    expect(p.steps).toEqual([]);
    expect(p.kept.some((k) => k.name === 'bone' && k.why === 'kept')).toBe(true); // the loot stays: not this job's
    expect(p.kept.some((k) => k.name === 'blue_shulker_box')).toBe(true); // a box holding sand stays
    expect(p.kept.some((k) => k.name === 'undyed_shulker_box')).toBe(true); // the fireworks box stays
    expect(p.kept.some((k) => k.name === 'white_shulker_box')).toBe(true); // an unread box stays
    // without the named box: the first spare is the stash step's, four go
    const noNamed = live().filter((x) => x.slot !== 24);
    const q = planUnload(noNamed, [coal, spares], { spares: true });
    expect(q.moves.map((m) => m.slot)).toEqual([19, 20, 21, 22]);
    expect(q.kept.filter((k) => k.why === 'stash_box')).toEqual([{ name: 'green_shulker_box', count: 1, why: 'stash_box' }]);
    // the count the chore looks at is the same four
    expect(unloadableStacks(noNamed).spares).toBe(4);
  });

  it('no chest of spares: the spares are overflow (kept), never put into another chest; a full one takes what fits', () => {
    const coal = chest({ key: 'coal', contents: { coal: 10 }, free: 20 });
    const slots = live().filter((x) => x.slot !== 24);
    const p = planUnload(slots, [coal], { spares: true });
    expect(p.moves).toEqual([]);
    expect(p.overflow.map((o) => o.slot)).toEqual([19, 20, 21, 22]);
    const two = chest({ key: 'spares', boxes: { empty: 25, full: 0 }, free: 2 });
    const q = planUnload(slots, [coal, two], { spares: true });
    expect(q.moves.map((m) => `${m.slot}->${m.to}`)).toEqual(['19->spares', '20->spares']);
    expect(q.overflow.map((o) => o.slot)).toEqual([21, 22]);
    // a chest labelled for boxes is a chest of spares too, before it holds one
    const labelled = chest({ key: 'shulkers', label: 'shulkers' });
    expect(planUnload(slots, [coal, labelled], { spares: true }).moves.map((m) => m.to)).toEqual(['shulkers', 'shulkers', 'shulkers', 'shulkers']);
  });

  it('spareChestState: room (the one with the most empty boxes), full, none; a box block or a plain chest is none', () => {
    const plain = chest({ key: 'plain', contents: { coal: 64 } });
    const block = chest({ key: 'block', kind: 'green_shulker_box', boxes: { empty: 1, full: 0 } });
    expect(spareChestState([plain, block])).toEqual({ state: 'none' });
    const full = chest({ key: 'full', boxes: { empty: 27, full: 0 }, free: 0 });
    expect(spareChestState([plain, full])).toEqual({ state: 'full' });
    const few = chest({ key: 'few', boxes: { empty: 1, full: 0 }, free: 20 });
    const many = chest({ key: 'many', boxes: { empty: 5, full: 0 }, free: 10 });
    expect(spareChestState([plain, full, few, many])).toEqual({ state: 'room', key: 'many' });
    expect(spareChestState([chest({ key: 'lab', label: 'spare boxes' })])).toEqual({ state: 'room', key: 'lab' });
  });
});

describe('categories and labels', () => {
  it('maps items to categories', () => {
    expect(categoryOf('coal')).toBe('ores');
    expect(categoryOf('minecraft:raw_gold')).toBe('ores');
    expect(categoryOf('deepslate_diamond_ore')).toBe('ores');
    expect(categoryOf('spruce_log')).toBe('wood');
    expect(categoryOf('oak_planks')).toBe('wood');
    expect(categoryOf('cooked_beef')).toBe('food');
    expect(categoryOf('wheat')).toBe('food');
    expect(categoryOf('cobblestone')).toBe('blocks');
    expect(categoryOf('rotten_flesh')).toBe('junk');
    expect(categoryOf('diamond_sword')).toBe('tools');
    expect(categoryOf('redstone_torch')).toBe('misc');
  });

  it('matches labels by category word or item name', () => {
    expect(labelCategory('Ores')).toBe('ores');
    expect(labelCategory('my logs')).toBe('wood');
    expect(labelCategory('stuff')).toBeUndefined();
    expect(labelMatches('metals', 'iron_ingot')).toBe(true);
    expect(labelMatches('wood', 'coal')).toBe(false);
    expect(labelMatches('string', 'string')).toBe(true);
    expect(labelMatches(undefined, 'coal')).toBe(false);
  });
});

describe('chest memory lines', () => {
  const now = 1_000_000;
  function memory() {
    const m = new ChestMemory();
    const slots = Array.from({ length: 27 }, () => null) as ({ name: string; count: number; networkId: number; metadata: number } | null)[];
    slots[0] = { name: 'iron_ingot', count: 64, networkId: 1, metadata: 0 };
    slots[1] = { name: 'iron_ingot', count: 64, networkId: 1, metadata: 0 };
    slots[2] = { name: 'coal', count: 30, networkId: 2, metadata: 0 };
    m.set({ ...recordFrom({ x: 100, y: 63, z: -48 }, 'chest', snapshotOf(slots), undefined, now - 120_000), label: 'ores' });
    const b = Array.from({ length: 27 }, () => null) as typeof slots;
    b[0] = { name: 'iron_ingot', count: 64, networkId: 1, metadata: 0 };
    b[1] = { name: 'undyed_shulker_box', count: 1, networkId: 3, metadata: 0 };
    m.set(recordFrom({ x: 90, y: 63, z: -48 }, 'barrel', snapshotOf(b), undefined, now));
    m.set(unreadRecord({ x: 95, y: 63, z: -44 }, 'trapped_chest'));
    return m;
  }

  it('!stock item: per container, most first, with the total', () => {
    const m = memory();
    expect(stockLine(m, 'iron_ingot')).toBe('iron_ingot: 128 in chest 100 63 -48 (ores), 64 in barrel 90 63 -48 (192 in all)');
    expect(stockLine(m, 'coal')).toBe('coal: 30 in chest 100 63 -48 (ores)');
    expect(stockLine(m, 'shulker')).toBe('shulker_box: 1 in barrel 90 63 -48 (1 empty)');
    expect(stockLine(m, 'diamond')).toBe('stock: no diamond in the 2 containers I know');
    expect(stockLine(m, undefined)).toBe('stock: 2 containers: 192 iron_ingot, 30 coal, 1 undyed_shulker_box');
    expect(stockLine(new ChestMemory(), 'coal')).toBe('stock: no chest read yet (try !chests scan near home)');
  });

  it('!chests: counts by kind with the labels, then every container with free slots, top contents and the age', () => {
    const line = chestsLine(memory().all(), now, { x: 100, y: 63, z: -48 });
    expect(line).toBe(
      'chests: 3 remembered (3 reachable): 1 barrel, 1 chest (ores), 1 trapped chest | chest 100 63 -48 (ores): 24/27 free, 128 iron_ingot, 30 coal (2 min ago) | trapped chest 95 63 -44: not read yet | barrel 90 63 -48: 25/27 free, 64 iron_ingot, 1 undyed_shulker_box, 1 empty shulker box (0 min ago)',
    );
  });

  it('Track AN: unreachable containers: counted apart, listed by !chests unreachable, never unload targets', () => {
    const m = memory();
    m.set({ ...unreadRecord({ x: 110, y: 63, z: -48 }, 'chest'), unreachable: 'no path', unreachableAt: now - 3 * 60_000 });
    m.set({ ...m.get({ x: 90, y: 63, z: -48 })!, unreachable: 'path 40 blocks', unreachableAt: now });
    m.set({ ...unreadRecord({ x: 111, y: 63, z: -48 }, 'chest'), label: 'wood' });
    const line = chestsLine(m.all(), now, { x: 100, y: 63, z: -48 });
    expect(line).toBe(
      'chests: 5 remembered (3 reachable, 2 unreachable: !chests unreachable): 3 chests (ores, wood), 1 barrel, 1 trapped chest | chest 100 63 -48 (ores): 24/27 free, 128 iron_ingot, 30 coal (2 min ago) | trapped chest 95 63 -44: not read yet | chest 111 63 -48 (wood): not read yet',
    );
    expect(unreachableLines(m.all(), now, { x: 100, y: 63, z: -48 })).toEqual(['chests: 2 unreachable: chest 110 63 -48: no path (3 min ago) | barrel 90 63 -48: path 40 blocks (0 min ago)']);
    expect(unreachableLines(new ChestMemory().all(), now)).toEqual(['chests: none unreachable']);
    expect(planChests(m.all()).map((c) => c.key)).toEqual(['100,63,-48']); // the barrel was read but is unreachable now
    // many: at most 3 lines of at most 256 characters, the last says how many more
    const many = Array.from({ length: 40 }, (_, i) => ({ ...unreadRecord({ x: i, y: 70, z: 0 }, 'barrel'), unreachable: 'no path within 4000 nodes', unreachableAt: now }));
    const lines = unreachableLines(many, now);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(256);
    expect(lines[0]).toMatch(/^chests: 40 unreachable: barrel 0 70 0: no path within 4000 nodes \(0 min ago\) \| /);
    expect(lines[2]).toMatch(/ \.\.\. and \d+ more \(!chests clear forgets them, !chests scan tries again\)$/);
    const listed = lines.join(' | ').split(' | ').filter((s) => s.includes(': no path')).length;
    expect(Number(/and (\d+) more/.exec(lines[2]!)![1]) + listed).toBe(40);
    // kinds
    expect(kindsLine([{ ...unreadRecord({ x: 0, y: 0, z: 0 }, 'undyed_shulker_box') }, { ...unreadRecord({ x: 1, y: 0, z: 0 }, 'blue_shulker_box'), label: 'boxes' }])).toBe('2 shulker boxes (boxes)');
  });

  it('a re-read keeps the label; partners and unread records are no unload targets', () => {
    const m = memory();
    const old = m.get({ x: 100, y: 63, z: -48 });
    const again = recordFrom({ x: 100, y: 63, z: -48 }, 'chest', snapshotOf(Array.from({ length: 54 }, () => null)), old, now, { x: 101, y: 63, z: -48 });
    expect(again).toMatchObject({ label: 'ores', size: 54, double: true, free: 54, partner: { x: 101, y: 63, z: -48 } });
    m.set(again);
    m.set(recordFrom({ x: 101, y: 63, z: -48 }, 'chest', snapshotOf(Array.from({ length: 54 }, () => null)), undefined, now));
    expect(planChests(m.all()).map((c) => c.key)).toEqual(['90,63,-48', '100,63,-48']);
    expect(kindWord(again)).toBe('double chest');
  });

  it('item queries', () => {
    expect(itemQuery('minecraft:Coal')).toBe('coal');
    expect(itemQuery('shulkers')).toBe('shulker_box');
    expect(itemMatches('shulker_box', 'blue_shulker_box')).toBe(true);
    expect(itemMatches('oak_logs', 'oak_log')).toBe(true);
    expect(itemMatches('iron', 'raw_iron')).toBe(true);
    expect(itemMatches('coal', 'charcoal')).toBe(false);
  });
});
