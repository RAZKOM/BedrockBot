// Track V1 (ADR 0090, docs/inventory.md): the room plan (skills/inventory/room.ts planRoom), a pure function over the
// slots like planUnload. The cases: a late-game inventory like the Realm bot's (36 of 36: a netherite kit, seven stacks of
// loose rockets beside the fireworks box, five empty boxes, seven kinds of food, mob drops; made-up counts), an early-game
// one (stone tools after an hour of mining), and every rule on its own.
import { describe, expect, it } from 'vitest';
import { boxPrint, planRoom, ROCKETS_LOOSE, ROOM_FLOOR, ROOM_TARGET, roomAskLine, roomSlotsOf, stackKey, stepLine, type RoomOptions, type RoomSlot, type RoomStep } from '../../../src/skills/inventory/room.ts';
import { unloadableStacks } from '../../../src/skills/home/unloader.ts';
import { unloadWanted } from '../../../src/tasks/process/unload.ts';

type Spec = [name: string, count: number, extra?: Partial<RoomSlot>];

/** Slots from a list in order (slot 0 first); every stack gets the key of its name unless it says otherwise. */
function inv(list: readonly Spec[]): RoomSlot[] {
  return list.map(([name, count, extra], slot) => ({ slot, name, count, key: `${name}|0|-`, ...(extra ?? {}) }));
}

const free = (slots: readonly RoomSlot[]): number => 36 - slots.length;
const kinds = (p: { steps: RoomStep[] }): string[] => p.steps.map((s) => s.kind);

/** The late-game inventory: 36 of 36 (three stacks split, as a sweep after a fight leaves them). */
function lateGame(): RoomSlot[] {
  return inv([
    ['netherite_sword', 1, { key: 'netherite_sword|0|{"ench":1}' }],
    ['netherite_pickaxe', 1],
    ['netherite_shovel', 1],
    ['netherite_axe', 1],
    ['firework_rocket', 64],
    ['cooked_beef', 24],
    ['bow', 1],
    ['cobblestone', 16],
    ['golden_carrot', 20],
    // main inventory (9..35)
    ['arrow', 15],
    ['elytra', 1],
    ['firework_rocket', 64],
    ['firework_rocket', 64],
    ['firework_rocket', 64],
    ['firework_rocket', 64],
    ['firework_rocket', 64],
    ['firework_rocket', 38],
    ['red_shulker_box', 1, { boxUsed: 3, boxItems: { firework_rocket: 165 }, flightKit: true }],
    ['green_shulker_box', 1, { boxUsed: 0 }],
    ['green_shulker_box', 1, { boxUsed: 0 }],
    ['green_shulker_box', 1, { boxUsed: 0 }],
    ['green_shulker_box', 1, { boxUsed: 0 }],
    ['green_shulker_box', 1, { boxUsed: 0 }],
    ['bread', 12],
    ['cooked_chicken', 10],
    ['carrot', 32],
    ['potato', 8],
    ['apple', 5],
    ['cooked_beef', 7],
    ['bone', 12],
    ['bone', 7],
    ['redstone', 17],
    ['stick', 2],
    ['wheat_seeds', 4],
    ['grass_block', 1],
    ['bread', 3],
  ]);
}
const LATE: RoomOptions = { kitBox: 17, stoneKeep: 64 };

/** Stone tools after an hour of mining: 36 of 36, no box, no home. */
function earlyGame(): RoomSlot[] {
  return inv([
    ['stone_pickaxe', 1],
    ['stone_axe', 1],
    ['stone_shovel', 1],
    ['stone_sword', 1],
    ['torch', 23],
    ['cobblestone', 64],
    ['bread', 6],
    ['crafting_table', 1],
    ['coal', 41],
    ['cobblestone', 64],
    ['cobblestone', 64],
    ['cobblestone', 64],
    ['cobblestone', 64],
    ['cobblestone', 64],
    ['cobblestone', 64],
    ['cobblestone', 30],
    ['cobblestone', 20],
    ['cobbled_deepslate', 64],
    ['cobbled_deepslate', 64],
    ['cobbled_deepslate', 12],
    ['dirt', 64],
    ['dirt', 9],
    ['gravel', 14],
    ['andesite', 64],
    ['andesite', 22],
    ['diorite', 31],
    ['granite', 18],
    ['tuff', 40],
    ['raw_iron', 23],
    ['raw_copper', 37],
    ['flint', 3],
    ['rotten_flesh', 5],
    ['bone', 3],
    ['string', 2],
    ['oak_log', 10],
    ['lapis_lazuli', 11],
  ]);
}

describe('planRoom: the floor', () => {
  it('plans nothing with the floor free', () => {
    const s = lateGame().slice(0, 36 - ROOM_FLOOR);
    const p = planRoom(s, LATE);
    expect(p.free).toBe(ROOM_FLOOR);
    expect(p.steps).toEqual([]);
    expect(p.short).toBeUndefined();
  });

  it('the numbers are 4 and 6, the loose rockets two stacks', () => {
    expect([ROOM_FLOOR, ROOM_TARGET, ROCKETS_LOOSE]).toEqual([4, 6, 128]);
  });
});

describe('planRoom: the late-game inventory', () => {
  it('merges the three split stacks, then puts the rockets beyond two stacks into the fireworks box: 0 -> 8 free, nothing dropped or boxed', () => {
    const s = lateGame();
    expect(free(s)).toBe(0);
    const p = planRoom(s, LATE);
    expect(kinds(p)).toEqual(['merge', 'merge', 'merge', 'rockets']);
    const merges = p.steps.filter((x) => x.kind === 'merge');
    // the main inventory's stack onto the hotbar's (cooked_beef 7 from 28 onto 5)
    expect(merges).toContainEqual({ kind: 'merge', from: 28, to: 5, name: 'cooked_beef', count: 7 });
    expect(merges).toContainEqual({ kind: 'merge', from: 30, to: 29, name: 'bone', count: 7 });
    expect(merges).toContainEqual({ kind: 'merge', from: 35, to: 23, name: 'bread', count: 3 });
    const r = p.steps.find((x) => x.kind === 'rockets')!;
    expect(r).toMatchObject({ kind: 'rockets', box: 17, count: 64 * 4 + 38 });
    // the hotbar's stack and one full main stack stay loose (128), the 38 and three full main stacks move
    if (r.kind === 'rockets') {
      expect(r.moves.map((m) => m.slot).sort((a, b) => a - b)).toEqual([12, 13, 14, 15, 16]);
      expect(r.moves.some((m) => m.slot < 9)).toBe(false);
    }
    expect(p.after).toBe(8);
    expect(p.short).toBeUndefined();
  });

  it('the stacks no slot plan may touch stay: gear, elytra, food, seeds, the throwaway reserve, every box', () => {
    const s = lateGame();
    const p = planRoom(s, LATE);
    const touched = new Set(p.steps.flatMap((x) => (x.kind === 'merge' ? [x.from] : x.kind === 'rockets' || x.kind === 'box' ? x.moves.map((m) => m.slot) : [])));
    for (const sl of s) {
      if (['netherite_sword', 'netherite_pickaxe', 'netherite_shovel', 'netherite_axe', 'elytra', 'golden_carrot', 'carrot', 'potato', 'wheat_seeds', 'cobblestone', 'apple', 'cooked_chicken'].includes(sl.name) || sl.name.endsWith('shulker_box')) expect(touched.has(sl.slot)).toBe(false);
    }
    expect(p.steps.some((x) => x.kind === 'junk' || x.kind === 'stone' || x.kind === 'compact' || x.kind === 'box')).toBe(false);
  });

  it('the exact inventory (no split stacks, 33 slots: 3 free): the rockets alone free 5 more', () => {
    const s = lateGame().filter((x) => ![28, 30, 35].includes(x.slot));
    expect(free(s)).toBe(3);
    const p = planRoom(s, LATE);
    expect(kinds(p)).toEqual(['rockets']);
    expect(p.after).toBe(8);
  });

  it('with no fireworks box: the loose rockets are kept, a box is filled with the loot instead', () => {
    const s = lateGame().filter((x) => x.slot !== 17 && ![28, 30, 35].includes(x.slot));
    s.push({ slot: 17, name: 'diamond', count: 3, key: 'diamond|0|-' });
    const p = planRoom(s, { stoneKeep: 64 });
    expect(p.steps.some((x) => x.kind === 'rockets')).toBe(false);
    const b = p.steps.find((x) => x.kind === 'box');
    expect(b).toBeDefined();
    if (b?.kind === 'box') {
      expect(b.box).toBe(18); // the first empty box
      const names = b.moves.map((m) => m.name).sort();
      // what the unload would put away: bone, redstone, stick, the bow, the arrows, the diamond, the grass block;
      // never the gear, food, the seeds or the throwaway reserve
      expect(names).toEqual(['arrow', 'bone', 'bow', 'diamond', 'grass_block', 'redstone', 'stick']);
    }
  });

  it('with the fireworks box full of rockets: said, and the box step frees the rest', () => {
    const s = lateGame().map((x) => (x.slot === 17 ? { ...x, boxUsed: 27, boxItems: { firework_rocket: 1728 } } : x));
    const p = planRoom(s, LATE);
    expect(p.steps.some((x) => x.kind === 'rockets')).toBe(false);
    expect(kinds(p)).toEqual(['merge', 'merge', 'merge', 'box']);
    expect(p.after).toBeGreaterThanOrEqual(ROOM_FLOOR);
  });
});

describe('planRoom: merges', () => {
  it('only stacks with the same key merge (an enchanted book, a crafted rocket of another flight stay apart)', () => {
    const s = inv([
      ['firework_rocket', 30, { key: 'firework_rocket|0|{"flight":1}' }],
      ['firework_rocket', 20, { key: 'firework_rocket|0|{"flight":3}' }],
      ['torch', 10],
      ['torch', 20],
      ...Array.from({ length: 32 }, (_, i): Spec => [`dummy_${i}`, 1]),
    ]);
    const p = planRoom(s, { maxStack: (n) => (n.startsWith('dummy') ? 1 : 64) });
    expect(p.steps).toEqual([{ kind: 'merge', from: 2, to: 3, name: 'torch', count: 10 }]);
  });

  it('no merge without a key, of a box, of an unstackable item, nor one that frees no slot', () => {
    const s = inv([
      ['ender_pearl', 10, { key: undefined }],
      ['ender_pearl', 2, { key: undefined }],
      ['cobblestone', 60],
      ['cobblestone', 60],
      ['white_shulker_box', 1, { boxUsed: 0 }],
      ['white_shulker_box', 1, { boxUsed: 0 }],
      ...Array.from({ length: 30 }, (_, i): Spec => [`dummy_${i}`, 1]),
    ]);
    const p = planRoom(s, { maxStack: (n) => (n.startsWith('dummy') ? 1 : n === 'ender_pearl' ? 16 : 64), boxing: false });
    expect(p.steps.filter((x) => x.kind === 'merge')).toEqual([]);
  });

  it('three partial stacks: two merges into the third (the fullest in the hotbar first)', () => {
    const s = inv([
      ['oak_planks', 40],
      ...Array.from({ length: 31 }, (_, i): Spec => [`dummy_${i}`, 1]),
      ['oak_planks', 10],
      ['oak_planks', 14],
    ]);
    const p = planRoom(s, { maxStack: (n) => (n.startsWith('dummy') ? 1 : 64) });
    expect(p.steps).toEqual([
      { kind: 'merge', from: 32, to: 0, name: 'oak_planks', count: 10 },
      { kind: 'merge', from: 33, to: 0, name: 'oak_planks', count: 14 },
    ]);
    expect(p.after).toBe(4);
  });
});

describe('planRoom: the early-game inventory', () => {
  it('drops the junk (rotten flesh, string) before 36, then the stone beyond 64 a kind; nothing of worth goes', () => {
    const s = earlyGame();
    expect(free(s)).toBe(0);
    const p = planRoom(s, { stoneKeep: 64 });
    expect(p.steps[0]).toEqual({ kind: 'merge', from: 16, to: 15, name: 'cobblestone', count: 20 }); // 30 + 20: one slot
    expect(p.steps.filter((x) => x.kind === 'junk').map((x) => (x.kind === 'junk' ? x.name : ''))).toEqual(['rotten_flesh', 'string']);
    const stone = p.steps.filter((x) => x.kind === 'stone');
    expect(stone.length).toBeGreaterThan(0);
    for (const st of stone) if (st.kind === 'stone') expect(['cobblestone', 'cobbled_deepslate', 'andesite', 'dirt']).toContain(st.name);
    // the ores, the coal, the tools, food, torches, flint, bones, logs, lapis are never dropped
    const dropped = new Set(p.steps.flatMap((x) => (x.kind === 'junk' || x.kind === 'stone' ? [x.name] : [])));
    for (const keep of ['raw_iron', 'raw_copper', 'coal', 'bread', 'torch', 'flint', 'bone', 'oak_log', 'lapis_lazuli', 'stone_pickaxe', 'crafting_table']) expect(dropped.has(keep)).toBe(false);
    expect(p.after).toBeGreaterThanOrEqual(ROOM_TARGET);
  });

  it('the cobblestone beyond 64: the main inventory\'s smallest stacks go, 64 stay', () => {
    const s = earlyGame();
    const p = planRoom(s, { stoneKeep: 64 });
    const c = p.steps.find((x) => x.kind === 'stone' && x.name === 'cobblestone');
    expect(c).toMatchObject({ kind: 'stone', name: 'cobblestone', keep: 64, count: 64 * 7 + 50 - 64 });
  });

  it('with dropStone 0 the stone stays: short, and the reason names it; once no step is left, one line asks', () => {
    const p = planRoom(earlyGame(), { stoneKeep: 0 });
    expect(p.steps.some((x) => x.kind === 'stone')).toBe(false);
    expect(kinds(p)).toEqual(['merge', 'junk', 'junk']);
    expect(p.after).toBeLessThan(ROOM_FLOOR);
    expect(p.short).toContain('stone-like blocks kept (dropStone 0)');
    expect(roomAskLine(p, { home: false, chests: false, radius: 16 })).toBeUndefined(); // steps first
    // the inventory once the merge and the junk drops ran: 3 free, no step left
    const after = earlyGame()
      .filter((x) => ![16, 31, 33].includes(x.slot))
      .map((x) => (x.slot === 15 ? { ...x, count: 50 } : x));
    const q = planRoom(after, { stoneKeep: 0 });
    expect(q.steps).toEqual([]);
    const ask = roomAskLine(q, { home: false, chests: false, radius: 16 });
    expect(ask).toMatch(/^inventory: 3 slots free and nothing I may drop or box; a home with a chest/);
    expect(ask).toContain('!set dropStone 64');
    expect(Buffer.byteLength(ask!)).toBeLessThan(480);
  });

  it('what a !get of the last hour got is never dropped as stone', () => {
    const p = planRoom(earlyGame(), { stoneKeep: 64, protect: new Set(['cobblestone']) });
    expect(p.steps.some((x) => x.kind === 'stone' && x.name === 'cobblestone')).toBe(false);
  });

  it('with an empty box: the loot goes into it below the floor (value before filler), no stone dropped then', () => {
    const s = earlyGame();
    s[35] = { slot: 35, name: 'brown_shulker_box', count: 1, boxUsed: 0 };
    const p = planRoom(s, { stoneKeep: 64 });
    const b = p.steps.find((x) => x.kind === 'box');
    expect(b).toBeDefined();
    if (b?.kind === 'box') {
      expect(b.box).toBe(35);
      // the ores and coal first; the torches and the crafting table stay loose (a skill takes them)
      const names = b.moves.map((m) => m.name);
      expect(names.indexOf('raw_iron')).toBeLessThan(names.includes('cobblestone') ? names.indexOf('cobblestone') : Infinity);
      expect(names).not.toContain('torch');
      expect(names).not.toContain('crafting_table');
      expect(names).not.toContain('rotten_flesh');
    }
    expect(p.steps.some((x) => x.kind === 'stone')).toBe(false);
  });

  it('compacts the lapis only with a crafting table near and only when that frees a slot', () => {
    const s = inv([['lapis_lazuli', 64], ['lapis_lazuli', 26], ...Array.from({ length: 34 }, (_, i): Spec => [`dummy_${i}`, 1])]);
    const o = { maxStack: (n: string) => (n.startsWith('dummy') ? 1 : 64) };
    expect(planRoom(s, o).steps.some((x) => x.kind === 'compact')).toBe(false);
    const p = planRoom(s, { ...o, table: true });
    expect(p.steps.find((x) => x.kind === 'compact')).toEqual({ kind: 'compact', item: 'lapis_lazuli', block: 'lapis_block', count: 90, frees: 1 });
    // 11 lapis: 1 block and 2 lapis, still two slots: nothing
    const t = inv([['lapis_lazuli', 11], ...Array.from({ length: 35 }, (_, i): Spec => [`dummy_${i}`, 1])]);
    expect(planRoom(t, { ...o, table: true }).steps.some((x) => x.kind === 'compact')).toBe(false);
  });
});

describe('planRoom: boxes', () => {
  const filler = (n: number, from = 0): Spec[] => Array.from({ length: n }, (_, i): Spec => [`dummy_${i + from}`, 1]);
  const o: RoomOptions = { maxStack: (n) => (n.startsWith('dummy') ? 1 : n.endsWith('shulker_box') ? 1 : 64) };

  it('never a box holding other things, one the bot cannot read, one owed to a chest, nor the fireworks box', () => {
    const s = inv([
      ['diamond', 5],
      ['yellow_shulker_box', 1, { boxUsed: 4, boxItems: { sand: 256 } }],
      ['blue_shulker_box', 1, { unknown: true }],
      ['lime_shulker_box', 1, { boxUsed: 0, owed: true }],
      ['red_shulker_box', 1, { boxUsed: 1, boxItems: { firework_rocket: 64 }, flightKit: true }],
      ...filler(31),
    ]);
    const p = planRoom(s, { ...o, kitBox: 4 });
    expect(p.steps.some((x) => x.kind === 'box')).toBe(false);
    expect(p.short?.some((x) => x.startsWith('no carried box'))).toBe(true);
    expect(roomAskLine(p, { home: true, chests: false, radius: 16 })).toContain('I know no chest at home: a chest within 16 blocks');
    expect(roomAskLine(p, { home: true, chests: false, radius: 16 })).toContain('give me an empty shulker box');
    expect(roomAskLine(p, { home: true, chests: true, radius: 16 })).toContain('I unload when I am home (!unload there)');
    expect(roomAskLine(p, { home: true, chests: true, radius: 16, atHome: true })).toContain('the chests at home take none of what is left');
  });

  it('a bot_loot box first, then a box this chore filled, then an empty one', () => {
    const base: Spec[] = [['diamond', 5], ['white_shulker_box', 1, { boxUsed: 0 }], ['orange_shulker_box', 1, { boxUsed: 2, boxItems: { bone: 30, redstone: 9 } }], ['purple_shulker_box', 1, { boxUsed: 3, boxItems: { coal: 100 }, named: true }], ...filler(32)];
    const p = planRoom(inv(base), o);
    expect(p.steps.find((x) => x.kind === 'box')).toMatchObject({ box: 3 });
    const noNamed = inv(base.filter((x) => x[0] !== 'purple_shulker_box'));
    expect(planRoom(noNamed, o).steps.find((x) => x.kind === 'box')).toMatchObject({ box: 1 }); // the orange one holds other things
    expect(planRoom(noNamed, { ...o, ownBoxes: new Set([boxPrint({ redstone: 9, bone: 30 })]) }).steps.find((x) => x.kind === 'box')).toMatchObject({ box: 2 });
  });

  it('not with stashShulker off, not at home with chests, and only below the floor', () => {
    const s = inv([['diamond', 5], ['white_shulker_box', 1, { boxUsed: 0 }], ...filler(34)]);
    expect(planRoom(s, { ...o, boxing: false }).short).toContain('stashShulker is off (no box placed for loot)');
    expect(planRoom(s, { ...o, home: true }).steps).toEqual([]);
    // 5 free (over the floor, under the target): no box is set down for that
    const t = inv([['diamond', 5], ['white_shulker_box', 1, { boxUsed: 0 }], ['torch', 3], ['torch', 4], ...filler(28)]);
    expect(free(t)).toBe(4);
    const p = planRoom(inv([['diamond', 5], ['white_shulker_box', 1, { boxUsed: 0 }], ['torch', 3], ['torch', 4], ...filler(29)]), o);
    expect(kinds(p)).toEqual(['merge']); // 3 -> 4 free: at the floor, the box waits
  });

  it('Track V1c: never an empty box with someone\'s name on it (the owner\'s owner_stuff); an empty unnamed one still', () => {
    const s = inv([['diamond', 5], ['white_shulker_box', 1, { boxUsed: 0, labelled: true }], ...filler(34)]);
    const p = planRoom(s, o);
    expect(p.steps.some((x) => x.kind === 'box')).toBe(false);
    expect(p.short?.some((x) => x.startsWith('no carried box'))).toBe(true);
    const t = inv([['diamond', 5], ['white_shulker_box', 1, { boxUsed: 0, labelled: true }], ['black_shulker_box', 1, { boxUsed: 0 }], ...filler(33)]);
    expect(planRoom(t, o).steps.find((x) => x.kind === 'box')).toMatchObject({ box: 2 });
  });

  it('the box takes no more stacks than it has room for', () => {
    const s = inv([['white_shulker_box', 1, { boxUsed: 25, boxItems: { coal: 1600 }, named: true }], ...Array.from({ length: 35 }, (_, i): Spec => [['diamond', 'emerald', 'gold_ingot', 'iron_ingot', 'copper_ingot'][i % 5]!, 1 + i, { key: `k${i}` }])]);
    const b = planRoom(s, o).steps.find((x) => x.kind === 'box');
    expect(b?.kind === 'box' && b.moves.length).toBe(2);
  });
});

describe('planRoom: junk and stone rules', () => {
  const filler = (n: number): Spec[] => Array.from({ length: n }, (_, i): Spec => [`dummy_${i}`, 1]);
  const o: RoomOptions = { maxStack: (n) => (n.startsWith('dummy') ? 1 : 64), stoneKeep: 64 };

  it('no junk or stone drop at home with chests (the unload stores them), the merge still runs', () => {
    const s = inv([['rotten_flesh', 30], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 10], ['cobblestone', 5], ...filler(31)]);
    const p = planRoom(s, { ...o, home: true });
    expect(kinds(p)).toEqual(['merge']);
  });

  it('the junk list is the keeper\'s: a named junk kind goes, never a kind the keeper never drops', () => {
    const s = inv([['rotten_flesh', 30], ['netherite_sword', 1], ['bone', 4], ...filler(33)]);
    const p = planRoom(s, { ...o, junk: ['rotten_flesh', 'netherite_sword', 'bone'] });
    // neverDrop: durability items and bones are never junk even when listed
    expect(p.steps.filter((x) => x.kind === 'junk').map((x) => (x.kind === 'junk' ? x.name : ''))).toEqual(['rotten_flesh']);
  });

  it('only the stone-like kinds; flint and clay are no stone', () => {
    const s = inv([['flint', 64], ['flint', 64], ['clay_ball', 64], ['clay_ball', 64], ['gravel', 64], ['gravel', 64], ...filler(30)]);
    const p = planRoom(s, o);
    expect(p.steps.filter((x) => x.kind === 'stone').map((x) => (x.kind === 'stone' ? x.name : ''))).toEqual(['gravel']);
  });
});

describe('the plan lines', () => {
  it('one line a step', () => {
    expect(stepLine({ kind: 'merge', from: 30, to: 2, name: 'cooked_beef', count: 7 })).toBe('merged 7 cooked_beef (slot 30 -> 2)');
    expect(stepLine({ kind: 'rockets', box: 17, moves: [{ slot: 12, count: 64 }, { slot: 16, count: 38 }], count: 102 })).toBe('102 firework_rocket into the fireworks box (2 stacks)');
    expect(stepLine({ kind: 'box', box: 18, moves: [{ slot: 29, count: 19, name: 'bone' }, { slot: 31, count: 17, name: 'redstone' }] })).toBe('boxed 19 bone, 17 redstone into the shulker box in slot 18');
    expect(stepLine({ kind: 'stone', name: 'cobblestone', count: 450, keep: 64, slots: 7 })).toBe('dropped 450 cobblestone (dropStone 64)');
  });
});

describe('roomSlotsOf and the merge key', () => {
  it('the wire NBT is part of the key (BigInt safe); no wire item, no key', () => {
    const a = stackKey('firework_rocket', 0, { network_id: 1, extra: { has_nbt: true, nbt: { nbt: { value: { Fireworks: { value: { Flight: { value: 1 } } } } } } } });
    const b = stackKey('firework_rocket', 0, { network_id: 1, extra: { has_nbt: true, nbt: { nbt: { value: { Fireworks: { value: { Flight: { value: 2 } } } } } } } });
    expect(a).not.toBe(b);
    expect(stackKey('cobblestone', 0, { extra: { has_nbt: false } })).toBe('cobblestone|0|-');
    expect(stackKey('cobblestone', 0, undefined)).toBeUndefined();
    expect(stackKey('stick', 0, { extra: { has_nbt: true, nbt: { x: 5n } } })).toBe('stick|0|{"x":"5n"}');
  });

  it('reads the inventory model: keys, box marks, owed', () => {
    const slots = [{ name: 'cobblestone', count: 10 }, null, { name: 'white_shulker_box', count: 1 }, { name: 'black_shulker_box', count: 1 }];
    const raws: Record<number, unknown> = { 0: { extra: { has_nbt: false } }, 2: { extra: { has_nbt: false } } };
    const r = roomSlotsOf({ slots, rawItem: (_w, s) => raws[s] }, { owed: new Set([2]) });
    expect(r).toEqual([
      { slot: 0, name: 'cobblestone', count: 10, key: 'cobblestone|0|-' },
      { slot: 2, name: 'white_shulker_box', count: 1, boxUsed: 0, owed: true },
      { slot: 3, name: 'black_shulker_box', count: 1, boxUsed: 0, unknown: true },
    ]);
  });

  it('Track V1c: a box with a custom name other than keepBoxName is labelled, a bot_loot box named, an unnamed one neither', () => {
    const named = (n: string) => ({ extra: { has_nbt: 1, nbt: { nbt: { value: { display: { value: { Name: { value: n } } } } } } } });
    const slots = [{ name: 'white_shulker_box', count: 1 }, { name: 'red_shulker_box', count: 1 }, { name: 'blue_shulker_box', count: 1 }, { name: 'stick', count: 3 }];
    const raws: Record<number, unknown> = { 0: named('owner_stuff'), 1: named('§6Bot_Loot'), 2: { extra: { has_nbt: 0 } }, 3: named('wand') };
    const r = roomSlotsOf({ slots, rawItem: (_w, s) => raws[s] });
    expect(r[0]).toMatchObject({ labelled: true });
    expect(r[0]!.named).toBeUndefined();
    expect(r[1]).toMatchObject({ named: true });
    expect(r[1]!.labelled).toBeUndefined();
    expect(r[2]!.named ?? r[2]!.labelled).toBeUndefined();
    expect(r[3]!.labelled).toBeUndefined(); // only boxes
    // with another keepBoxName, a bot_loot box is someone's box
    expect(roomSlotsOf({ slots, rawItem: (_w, s) => raws[s] }, { keepName: 'owner_stuff' })[1]).toMatchObject({ labelled: true });
  });
});

describe('Track V1c: the rocket step\'s room with rockets of other NBT in the box', () => {
  it('a fireworks box with 3 stacks of Flight 1 and 24 free slots takes 24 stacks of Flight 2 (none counted onto the Flight 1 stacks)', () => {
    const f2 = 'firework_rocket|0|{"Flight":2}';
    const s = inv([
      ['undyed_shulker_box', 1, { boxUsed: 3, boxItems: { firework_rocket: 192 }, flightKit: true }],
      ...Array.from({ length: 28 }, (): Spec => ['firework_rocket', 64, { key: f2 }]),
      ...Array.from({ length: 7 }, (_, i): Spec => [`dummy_${i}`, 1]),
    ]);
    const p = planRoom(s, { kitBox: 0, maxStack: (n) => (n.startsWith('dummy') || n.endsWith('shulker_box') ? 1 : 64) });
    const r = p.steps.find((x) => x.kind === 'rockets');
    expect(r?.kind === 'rockets' && r.moves.length).toBe(24);
    expect(r?.kind === 'rockets' && r.count).toBe(24 * 64);
  });
});

describe('the home chore\'s slot trigger (tasks/process/unload.ts unloadWanted)', () => {
  it('the late-game inventory at home: 36 of 36 with few stacks and 4 spare boxes, under both old bars, unloaded now', () => {
    const s = lateGame();
    const l = unloadableStacks(s);
    expect(l.free).toBe(0);
    expect(l.fullBoxes).toBe(0);
    expect(l.stacks).toBeLessThanOrEqual(8);
    expect(l.spares).toBe(4); // five empty boxes, the stash step keeps one
    expect(unloadWanted({ stacks: l.stacks, fullBoxes: 0 })).toBe(false); // the old trigger
    expect(unloadWanted(l)).toBe(true);
  });

  it('with the floor free, or nothing to unload, the old trigger alone', () => {
    expect(unloadWanted({ stacks: 3, fullBoxes: 0, spares: 2, free: 4 })).toBe(false);
    expect(unloadWanted({ stacks: 0, fullBoxes: 0, spares: 0, free: 0 })).toBe(false);
    expect(unloadWanted({ stacks: 0, fullBoxes: 0, spares: 1, free: 3 })).toBe(true);
    expect(unloadWanted({ stacks: 9, fullBoxes: 0, spares: 0, free: 20 })).toBe(true);
    expect(unloadWanted({ stacks: 0, fullBoxes: 1 })).toBe(true);
  });
});
