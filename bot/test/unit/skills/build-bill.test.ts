// Track B2 (docs/build.md "Bill of materials", "Fetch", ADR 0125): the bill of materials on the server's own building
// recipes (a subset of the recorded 1.26.60 crafting_data): what is had where, what is crafted and smelted from what,
// the furnace and its fuel, the reserve, what cannot be got; the order fetch takes the commands in; the chat lines.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BILL_LINE_MAX, billLines, billNeeds, billOf, billSteps, canCraftNow, getHow, itemsOfBlock, nextFetchStep, planksOf, type BillInput } from '../../../src/skills/build/bill.ts';
import { RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const fx = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-build-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fx.items[String(id)]);
recipes.handle(fx);
const map = (o: Record<string, number>) => new Map(Object.entries(o));
const HOUSE = { oak_planks: 12, oak_stairs: 8, oak_slab: 6, glass: 4, smooth_stone: 2, brick_block: 1, stone_bricks: 1, oak_log: 4 };
const HOME = { oak_log: 20, sand: 8, cobblestone: 40, clay_ball: 8 };
const bill = (o: Omit<Partial<BillInput>, 'need'> & { need: Record<string, number> }) => billOf({ loose: new Map(), recipes, furnaceNear: false, ...o, need: map(o.need) });
const slots = (o: Record<string, number>): ItemStack[] => Object.entries(o).map(([name, count]) => ({ name, count, networkId: 0, metadata: 0 }));

describe('bill of materials', () => {
  it('a house from raw materials at home: bring, craft, a furnace, smelt (stone twice deep), fuel as planks', () => {
    const b = bill({ need: HOUSE, home: map(HOME) });
    expect(b.ok).toBe(false);
    expect(b.cannot).toEqual([]);
    expect(b.get).toEqual([]);
    // logs: 4 placed, 8 crafted into 32 planks (12 placed, 12 into stairs, 3 into slabs, 4 into the table, 1 burned), 3 for the fuel's 12 planks
    expect(b.bring).toEqual([
      { item: 'oak_log', n: 15 },
      { item: 'sand', n: 4 },
      { item: 'cobblestone', n: 14 }, // 6 smelted to stone (4 stone bricks, 2 smooth stone), 8 the furnace
      { item: 'clay_ball', n: 4 },
    ]);
    expect(b.furnace).toBe(true);
    expect(b.smelts).toEqual([
      { input: 'cobblestone', output: 'stone', n: 6, depth: 1 },
      { input: 'sand', output: 'glass', n: 4, depth: 0 },
      { input: 'stone', output: 'smooth_stone', n: 2, depth: 0 },
      { input: 'clay_ball', output: 'brick', n: 4, depth: 0 },
    ]);
    // 16 smelts: the one plank left over (1.5) and 12 planks from 3 logs (18)
    expect(b.fuel).toEqual([
      { item: 'oak_planks', n: 1 },
      { item: 'oak_planks', n: 12, from: { item: 'oak_log', n: 3 } },
    ]);
    const it = Object.fromEntries(b.items.map((i) => [i.item, i]));
    expect(it.oak_stairs).toMatchObject({ need: 8, make: 8, how: 'craft', from: '12 oak_planks' });
    expect(it.oak_slab).toMatchObject({ make: 6, how: 'craft', from: '3 oak_planks' });
    expect(it.glass).toMatchObject({ make: 4, how: 'smelt', from: '4 sand' });
    expect(it.smooth_stone).toMatchObject({ make: 2, how: 'smelt', from: '2 stone' });
    expect(it.brick_block).toMatchObject({ make: 1, how: 'craft', from: '4 brick' });
    expect(it.stone_bricks).toMatchObject({ make: 1, how: 'craft', from: '4 stone' });
    expect(it.oak_log).toMatchObject({ need: 4, home: 4, make: 0 });
  });

  it('what is carried and in the boxes comes first; a furnace standing needs none', () => {
    const b = bill({ need: { glass: 4, oak_planks: 4 }, loose: map({ glass: 1, oak_planks: 4, coal: 2 }), boxed: map({ glass: 1 }), home: map({ glass: 1, sand: 5 }), furnaceNear: true });
    const g = b.items.find((i) => i.item === 'glass')!;
    expect(g).toMatchObject({ loose: 1, boxed: 1, home: 1, make: 1, how: 'smelt' });
    expect(b.furnace).toBe(false);
    expect(b.fuel).toEqual([{ item: 'coal', n: 1 }]);
    expect(b.bring).toEqual([
      { item: 'glass', n: 1 },
      { item: 'sand', n: 1 },
    ]);
    expect(bill({ need: { glass: 2 }, loose: map({ glass: 1 }), boxed: map({ glass: 1 }) }).ok).toBe(true);
  });

  it('raw materials missing everywhere are got with !get (clay balls as clay blocks), the rest cannot be got', () => {
    const b = bill({ need: { brick_block: 2, end_stone: 3 }, loose: map({ coal: 1 }), furnaceNear: true });
    expect(b.get).toEqual([{ item: 'clay_ball', n: 8, command: 'clay', count: 2 }]);
    expect(b.cannot).toEqual([{ item: 'end_stone', n: 3, why: 'no recipe and !get does not know it' }]);
    expect(b.items.find((i) => i.item === 'end_stone')).toMatchObject({ short: 3, make: 0 });
    expect(nextFetchStep(b, { slots: [] })).toEqual({ kind: 'stuck', why: 'cannot get 3 end_stone (no recipe and !get does not know it)' });
    expect(getHow('oak_log')).toEqual({ item: 'oak_log', per: 1 });
    expect(getHow('glass')).toBeUndefined();
    // no recipes yet: nothing can be crafted
    expect(billOf({ need: map({ oak_stairs: 4 }), loose: new Map() }).cannot).toEqual([{ item: 'oak_stairs', n: 4, why: 'no recipes yet' }]);
  });

  it('the throwaway reserve: a throwaway kind brought or got brings or gets its shortfall too', () => {
    const r = { kinds: ['cobblestone', 'dirt'], short: 16 };
    expect(bill({ need: { cobblestone: 10 }, home: map({ cobblestone: 64 }), reserve: r }).bring).toEqual([{ item: 'cobblestone', n: 26 }]);
    expect(bill({ need: { cobblestone: 10 }, home: map({ cobblestone: 20 }), reserve: r }).get).toEqual([{ item: 'cobblestone', n: 6, command: 'cobblestone', count: 6 }]);
    expect(bill({ need: { cobblestone: 40 }, reserve: r }).get).toEqual([{ item: 'cobblestone', n: 56, command: 'cobblestone', count: 56 }]);
  });

  it('double slabs are two slabs; logs make planks', () => {
    expect(itemsOfBlock('oak_double_slab')).toEqual({ item: 'oak_slab', n: 2 });
    expect(itemsOfBlock('normal_stone_double_slab')).toEqual({ item: 'normal_stone_slab', n: 2 });
    expect(itemsOfBlock('double_cut_copper_slab')).toEqual({ item: 'cut_copper_slab', n: 2 });
    expect(itemsOfBlock('waxed_exposed_double_cut_copper_slab')).toEqual({ item: 'waxed_exposed_cut_copper_slab', n: 2 });
    expect(itemsOfBlock('oak_slab')).toEqual({ item: 'oak_slab', n: 1 });
    expect(billNeeds({ oak_double_slab: 3, oak_slab: 1 })).toEqual(map({ oak_slab: 7 }));
    expect(planksOf('stripped_spruce_log')).toBe('spruce_planks');
    expect(planksOf('stone')).toBeUndefined();
  });

  it('spruce logs carried make spruce planks for the fuel', () => {
    const b = bill({ need: { glass: 6 }, loose: map({ sand: 6, spruce_log: 5 }), furnaceNear: true });
    expect(b.fuel).toEqual([{ item: 'spruce_planks', n: 4, from: { item: 'spruce_log', n: 1 } }]);
  });

  it('Track B3: the scaffold tool (stone pickaxes) is made of cobblestone and a log at home', () => {
    const early = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-early-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
    const idx = new RecipeIndex((id) => early.items[String(id)]);
    idx.handle(early);
    const b = billOf({ loose: new Map(), recipes: idx, furnaceNear: false, need: map({ stone_pickaxe: 2 }), home: map({ cobblestone: 64, oak_log: 4 }) });
    expect(b.cannot).toEqual([]);
    expect(b.get).toEqual([]);
    expect(b.bring).toEqual([
      { item: 'cobblestone', n: 6 },
      { item: 'oak_log', n: 2 },
    ]);
    expect(b.crafts.map((c) => c.item)).toContain('stick');
    expect(b.crafts.at(-1)).toMatchObject({ item: 'stone_pickaxe' });
    // nothing to make it of: `!get` gathers the raw materials; with nothing `!get` knows either, cannot (the build then
    // digs by hand)
    expect(billOf({ loose: new Map(), recipes: idx, furnaceNear: false, need: map({ stone_pickaxe: 1 }) }).get.map((g) => g.item).sort()).toEqual(['cobblestone', 'oak_log']);
    expect(billOf({ loose: new Map(), recipes: idx, furnaceNear: false, need: map({ stone_pickaxe: 1 }), get: () => undefined }).cannot).not.toEqual([]);
  });
});

describe('fetch order', () => {
  it('bring, get, the crafts possible now (planks last), the fuel planks, the furnace, smelts deepest first, done', () => {
    const now = (o: Record<string, number>) => ({ slots: slots(o), recipes });
    // start: everything at home
    let b = bill({ need: HOUSE, home: map(HOME) });
    expect(nextFetchStep(b, now({}))).toEqual({ kind: 'run', command: 'bring oak_log 15 home' });
    // carried now: the raw materials
    const carried: Record<string, number> = { oak_log: 15, sand: 4, cobblestone: 14, clay_ball: 4 };
    b = bill({ need: HOUSE, loose: map(carried) });
    expect(b.bring).toEqual([]);
    // the stairs and the slabs (made from planks) before the planks themselves
    expect(nextFetchStep(b, now(carried))).toEqual({ kind: 'run', command: 'craft oak_stairs 8' });
    const afterWood = { oak_log: 15 - 6, sand: 4, cobblestone: 14, clay_ball: 4, oak_stairs: 8, oak_slab: 6, oak_planks: 12 + 1, crafting_table: 1 };
    b = bill({ need: HOUSE, loose: map(afterWood) });
    expect(nextFetchStep(b, now(afterWood))).toEqual({ kind: 'run', command: 'craft oak_planks 12' }); // fuel planks from logs
    const fuelled = { ...afterWood, oak_log: afterWood.oak_log - 3, oak_planks: afterWood.oak_planks + 12 };
    b = bill({ need: HOUSE, loose: map(fuelled) });
    expect(nextFetchStep(b, now(fuelled))).toEqual({ kind: 'run', command: 'furnace' });
    b = bill({ need: HOUSE, loose: map({ ...fuelled, cobblestone: 6 }), furnaceNear: true });
    expect(nextFetchStep(b, now({ ...fuelled, cobblestone: 6 }))).toEqual({ kind: 'run', command: 'smelt cobblestone 6' });
    const smelted = { ...fuelled, cobblestone: 0, stone: 6, sand: 0, glass: 4, clay_ball: 0, brick: 4, oak_planks: 12 + 1 + 1 };
    b = bill({ need: HOUSE, loose: map(smelted), furnaceNear: true });
    expect(b.smelts).toEqual([{ input: 'stone', output: 'smooth_stone', n: 2, depth: 0 }]);
    // the crafts that waited on smelted items come before the last smelt (they use 4 of the 6 stone)
    expect(nextFetchStep(b, now(smelted))).toEqual({ kind: 'run', command: 'craft brick_block 1' });
    const done = { oak_log: 4, oak_planks: 12, oak_stairs: 8, oak_slab: 6, glass: 4, smooth_stone: 2, brick_block: 1, stone_bricks: 4 };
    b = bill({ need: HOUSE, loose: map(done), furnaceNear: true });
    expect(b.ok).toBe(true);
    expect(nextFetchStep(b, now(done))).toEqual({ kind: 'done' });
  });

  it('canCraftNow: the chain from what is carried', () => {
    // 4 stairs: 6 planks, and 4 for the table: 3 logs
    expect(canCraftNow({ slots: slots({ oak_log: 3 }), recipes }, 'oak_stairs', 4)).toBe(true);
    expect(canCraftNow({ slots: slots({ oak_log: 2 }), recipes }, 'oak_stairs', 4)).toBe(false);
    expect(canCraftNow({ slots: slots({ oak_log: 2, crafting_table: 1 }), recipes }, 'oak_stairs', 4)).toBe(true);
    expect(canCraftNow({ slots: slots({ glass: 9 }) }, 'glass_pane', 16)).toBe(false); // no recipes
  });
});

describe('Track B4 (decision 0129): the carried boxes in the bill and the fetch', () => {
  const R = { kinds: ['cobblestone', 'dirt'], short: 16 };
  /** 31 slots of something the build does not use, then `o`. */
  const full = (o: Record<string, number>, used = 31): ItemStack[] => [...slots(Object.fromEntries(Array.from({ length: used }, (_, i) => [`junk_${i}`, 64]))), ...slots(o)];
  const now = (s: ItemStack[], boxed: Record<string, number>, boxRoom = 27) => ({ slots: s, recipes, boxed: map(boxed), boxRoom, never: R.kinds });

  it('logs in a carried box are in the pool: planks and stairs are made from them, the making takes them out (unbox)', () => {
    const b = bill({ need: { oak_planks: 12, oak_stairs: 8 }, boxed: map({ oak_log: 64 }) });
    expect(b.cannot).toEqual([]);
    expect(b.get).toEqual([]);
    expect(b.bring).toEqual([]);
    // 12 placed, 12 into the stairs, 4 into the table: 28 planks from 7 logs
    expect(b.unbox).toEqual([{ item: 'oak_log', n: 7 }]);
    expect(b.items.find((i) => i.item === 'oak_stairs')).toMatchObject({ make: 8, how: 'craft' });
    expect(b.ok).toBe(false);
    expect(billSteps(b)[0]).toBe('from my boxes: 7 oak_log');
    // the boxes come before the home chests: what they lack comes from home
    const h = bill({ need: { oak_planks: 40 }, boxed: map({ oak_log: 4 }), home: map({ oak_log: 20 }) });
    expect(h.unbox).toEqual([{ item: 'oak_log', n: 4 }]);
    expect(h.bring).toEqual([{ item: 'oak_log', n: 6 }]);
  });

  it('a box in a home chest (an item the crafter keeps) is not brought: only what the making uses (the e2e: `!bring orange_shulker_box 1 home`)', () => {
    const keep = (n: string) => n.endsWith('shulker_box') || n.endsWith('_pickaxe');
    const b = bill({
      need: { oak_planks: 12, glass: 4 },
      loose: map({ iron_pickaxe: 1, red_shulker_box: 2 }),
      boxed: map({ oak_log: 64, cobblestone: 32 }),
      home: map({ orange_shulker_box: 1, sand: 64, diamond_pickaxe: 1 }),
      chain: { keep },
    });
    expect(b.cannot).toEqual([]);
    expect(b.bring).toEqual([{ item: 'sand', n: 4 }]);
    expect(b.unbox.map((u) => u.item).sort()).toEqual(['cobblestone', 'oak_log']);
    expect(b.fuel.length).toBeGreaterThan(0);
  });

  it('a throwaway kind taken out of a box (the furnace\'s cobblestone) takes the reserve\'s shortfall out with it', () => {
    const b = bill({ need: { glass: 4 }, boxed: map({ sand: 10, cobblestone: 64, oak_log: 10 }), reserve: R });
    expect(b.furnace).toBe(true);
    expect(b.unbox).toContainEqual({ item: 'sand', n: 4 });
    expect(b.unbox).toContainEqual({ item: 'cobblestone', n: 8 + 16 });
    expect(b.bring).toEqual([]);
    expect(b.get).toEqual([]);
  });

  it('a craft\'s materials come out of the boxes first (a chunk that fits), then the craft runs', () => {
    let b = bill({ need: { oak_planks: 12, oak_stairs: 8 }, boxed: map({ oak_log: 64 }) });
    // the stairs first (the planks are made from the same logs last): 3 logs for their planks, 1 for the table
    expect(nextFetchStep(b, now([], { oak_log: 64 }))).toEqual({ kind: 'unbox', want: { oak_log: 4 } });
    b = bill({ need: { oak_planks: 12, oak_stairs: 8 }, loose: map({ oak_log: 4 }), boxed: map({ oak_log: 60 }) });
    expect(nextFetchStep(b, now(slots({ oak_log: 4 }), { oak_log: 60 }))).toEqual({ kind: 'run', command: 'craft oak_stairs 8' });
    // without the box counts the fetch works from the inventory alone (as before)
    expect(nextFetchStep(b, { slots: slots({ oak_log: 4 }), recipes })).toEqual({ kind: 'run', command: 'craft oak_stairs 8' });
  });

  it('a craft is cut to what the inventory holds: one stairs craft needs 4 slots, 2 are spare: the planks come first', () => {
    const b = bill({ need: { oak_planks: 12, oak_stairs: 8 }, boxed: map({ oak_log: 64 }) });
    // 36 - 31 = 5 free, 3 kept free: 2 slots for the logs and what is made of them
    expect(nextFetchStep(b, now(full({}), { oak_log: 64 }, 0))).toEqual({ kind: 'unbox', want: { oak_log: 3 } });
    // a fuller inventory still: nothing fits, said in the stuck line
    const s = nextFetchStep(b, now(full({}, 33), { oak_log: 64 }, 0));
    expect(s.kind).toBe('stuck');
    expect(s.kind === 'stuck' && s.why).toContain('my inventory is full');
  });

  it('the inventory filling up: the build items the fetch finished go into the boxes first (never the throwaway kinds or an input)', () => {
    const b = bill({ need: { oak_stairs: 8, oak_planks: 12, cobblestone: 10 }, loose: map({ oak_stairs: 8, cobblestone: 10 }), boxed: map({ oak_log: 64 }) });
    const s = full({ oak_stairs: 8, cobblestone: 10 }, 29);
    expect(nextFetchStep(b, now(s, { oak_log: 64 }))).toEqual({ kind: 'stow', keep: { oak_stairs: 0 } });
    // no room in the boxes: on with the making
    expect(nextFetchStep(b, now(s, { oak_log: 64 }, 0)).kind).toBe('unbox');
  });

  it('a shulker box the build places is never stowed into a box (the game refuses it)', () => {
    const b = bill({ need: { oak_stairs: 8, oak_planks: 12, red_shulker_box: 2 }, loose: map({ oak_stairs: 8, red_shulker_box: 2 }), boxed: map({ oak_log: 64 }) });
    const s = full({ oak_stairs: 8, red_shulker_box: 2 }, 29);
    expect(nextFetchStep(b, now(s, { oak_log: 64 }))).toEqual({ kind: 'stow', keep: { oak_stairs: 0 } });
    const only = bill({ need: { oak_planks: 12, red_shulker_box: 2 }, loose: map({ red_shulker_box: 2 }), boxed: map({ oak_log: 64 }) });
    expect(nextFetchStep(only, now(full({ red_shulker_box: 2 }, 29), { oak_log: 64 })).kind).not.toBe('stow');
  });

  it('a smelt\'s input and the furnace\'s cobblestone come out of the boxes before the smelt and the furnace', () => {
    let b = bill({ need: { glass: 4 }, loose: map({ coal: 1 }), boxed: map({ sand: 10 }), furnaceNear: true });
    expect(nextFetchStep(b, now(slots({ coal: 1 }), { sand: 10 }))).toEqual({ kind: 'unbox', want: { sand: 4 } });
    b = bill({ need: { glass: 4 }, loose: map({ coal: 1, sand: 4 }), boxed: map({ sand: 6 }), furnaceNear: true });
    expect(nextFetchStep(b, now(slots({ coal: 1, sand: 4 }), { sand: 6 }))).toEqual({ kind: 'run', command: 'smelt sand 4' });
    b = bill({ need: { glass: 4 }, loose: map({ coal: 1, sand: 4, crafting_table: 1 }), boxed: map({ cobblestone: 40 }), reserve: R });
    expect(b.furnace).toBe(true);
    expect(nextFetchStep(b, now(slots({ coal: 1, sand: 4, crafting_table: 1 }), { cobblestone: 40 }))).toEqual({ kind: 'unbox', want: { cobblestone: 24 } });
    // the fuel too: coal in a box
    b = bill({ need: { glass: 4 }, loose: map({ sand: 4 }), boxed: map({ coal: 3 }), furnaceNear: true });
    expect(nextFetchStep(b, now(slots({ sand: 4 }), { coal: 3 }))).toEqual({ kind: 'unbox', want: { coal: 1 } });
  });
});

describe('bill lines', () => {
  it('entries a build item, then the steps; each within one chat reply (250); none when the bill is ok', () => {
    const lines = billLines('file house at 1 2 3', bill({ need: HOUSE, home: map(HOME) }));
    expect(lines[0]).toMatch(/^bill for file house at 1 2 3: oak_planks 12: have none; craft 12 from 3 oak_log \| oak_stairs 8: have none; craft 8 from 12 oak_planks \| /);
    expect(lines.some((l) => l.includes('oak_log 4: have 4 at home'))).toBe(true);
    // the steps split at a comma where a line is full
    expect(lines.slice(-2)).toEqual([
      'bill: from home: 15 oak_log, 4 sand, 14 cobblestone, 4 clay_ball; craft first 1 crafting_table; a furnace (8 cobblestone); smelt 6 cobblestone -> stone, 4 sand -> glass, 2 stone -> smooth_stone, 4 clay_ball -> brick; fuel 1 oak_planks,',
      '12 oak_planks (from 3 oak_log)',
    ]);
    for (const l of lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(BILL_LINE_MAX);
    expect(billLines('x', bill({ need: { glass: 1 }, loose: map({ glass: 1 }) }))).toEqual([]);
    // many kinds: several lines
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`block_${i}_with_a_long_name`, i + 1]));
    const ls = billLines('big', bill({ need: many }));
    expect(ls.length).toBeGreaterThan(2);
    for (const l of ls) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(BILL_LINE_MAX);
  });
});
