// Track B9 (ADR 0134, docs/build.md "What a fetch round gathers"): a fetch round sized to the running section (what is
// had costs no slot), the park step (what the bill does not use into the home chests when short of room), and the
// home logistics' park job that does it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import { BOX_OFF_MORE, boxFreeSpot, kitItem, toolRoundGoesOn } from '../../../src/chat/commands-build.ts';
import { SCAFFOLD_PICK } from '../../../src/skills/build/runner.ts';
import { billKinds, getHow, nextFetchStep, parkKinds, STOW_FREE, type Bill, type FetchNow } from '../../../src/skills/build/bill.ts';
import { BuildJob, type JobDeps } from '../../../src/skills/build/job.ts';
import { planBuild, type PlanOptions } from '../../../src/skills/build/plan.ts';
import { BuildRunner } from '../../../src/skills/build/runner.ts';
import { BuildProgress } from '../../../src/skills/build/progress.ts';
import { canCross, canStand, halfTop, reachableStands, wayOut } from '../../../src/skills/build/sim.ts';
import { parseSpec } from '../../../src/skills/build/spec.ts';
import type { BuildSpec, Cell } from '../../../src/skills/build/types.ts';
import { BOX_DIG_KEEP, boxDigSlot } from '../../../src/skills/supply/boxes.ts';
import { THROWAWAY_BLOCKS } from '../../../src/skills/survival/keeper.ts';
import type { ItemStack } from '../../../src/world/types.ts';
import { FakeBot, FakeInventory, FlatWorld } from './build-fakes.ts';
import { fakeHome, item } from './home-fakes.ts';

const F = -60;
const START: Cell = { x: 0, y: F, z: 0 };
const never = () => false;
const st = (name: string, count = 64): ItemStack => ({ name, count, networkId: 0, metadata: 0 });

/** A bill of planks and stairs made from logs in the boxes. */
const bill = (): Bill => ({
  items: [
    { item: 'oak_stairs', need: 8, loose: 0, boxed: 0, home: 0, make: 8, how: 'craft', from: '12 oak_planks', short: 0 },
    { item: 'stone', need: 64, loose: 0, boxed: 64, home: 0, make: 0, short: 0 },
  ],
  bring: [],
  unbox: [{ item: 'oak_log', n: 3 }],
  crafts: [
    { item: 'oak_planks', n: 12, table: false },
    { item: 'oak_stairs', n: 8, table: true },
  ],
  smelts: [],
  furnace: false,
  fuel: [],
  get: [],
  cannot: [],
  ok: false,
});

describe('the park step (Track B9)', () => {
  // the Realm's kit: tools, rockets, food, the carried boxes (room), the build's own boxes, raw materials handed over
  const kit = [st('iron_pickaxe', 1), st('iron_axe', 1), st('firework_rocket'), st('bread', 32), st('cobblestone', 16)];
  const boxes = [...Array.from({ length: 12 }, () => st('white_shulker_box', 1)), ...Array.from({ length: 6 }, () => st('red_shulker_box', 1))];
  const handed = ['copper_ore', 'clay_ball', 'quartz', 'tuff', 'pale_oak_log', 'sand', 'gravel', 'snow_layer', 'candle', 'turtle_egg', 'oak_planks'].map((n) => st(n, 16));
  const full = [...kit, ...boxes, ...handed, st('coal', 32), st('cobbled_deepslate', 32)].slice(0, 36);
  const now = (slots: ItemStack[], o: Partial<FetchNow> = {}): FetchNow => ({ slots, boxed: new Map([['oak_log', 92]]), boxRoom: 96, never: THROWAWAY_BLOCKS, park: true, kit: kitItem, ownBox: (n) => n === 'red_shulker_box', ...o });

  it('the kit: tools, armour, food and rockets; never a shulker box', () => {
    for (const n of ['iron_pickaxe', 'diamond_axe', 'elytra', 'iron_chestplate', 'bread', 'cooked_beef', 'firework_rocket']) expect(kitItem(n)).toBe(true);
    for (const n of ['white_shulker_box', 'red_shulker_box', 'tuff', 'oak_log', 'candle']) expect(kitItem(n)).toBe(false);
  });

  it('a full inventory parks what the bill does not use: not the kit, the scaffold, the carried boxes; the build\'s own boxes yes', () => {
    expect(full).toHaveLength(36);
    const k = parkKinds(bill(), now(full));
    expect(k).toEqual(expect.arrayContaining(['red_shulker_box', 'copper_ore', 'clay_ball', 'quartz', 'tuff', 'snow_layer', 'candle', 'turtle_egg', 'coal']));
    for (const n of ['iron_pickaxe', 'firework_rocket', 'bread', 'cobblestone', 'cobbled_deepslate', 'white_shulker_box', 'oak_planks']) expect(k).not.toContain(n); // oak_planks: the stairs are made of them
    expect(nextFetchStep(bill(), now(full))).toEqual({ kind: 'park', items: k });
    // before: with nothing of the bill's loose and no room, the crafts were stuck (`my inventory is full`)
    const stuck = nextFetchStep(bill(), now(full, { park: false, noStow: true }));
    expect(stuck.kind === 'stuck' && stuck.why).toMatch(/my inventory is full/);
  });

  it('room enough, a park that moved nothing, no home chests: no park (the steps as before)', () => {
    const roomy = [...kit, st('tuff', 16)];
    expect(36 - roomy.length).toBeGreaterThanOrEqual(STOW_FREE);
    expect(nextFetchStep(bill(), now(roomy))).toEqual({ kind: 'unbox', want: { oak_log: 3 } });
    expect(nextFetchStep(bill(), now(full, { noPark: true })).kind).not.toBe('park');
    expect(nextFetchStep(bill(), now(full, { park: false })).kind).not.toBe('park');
    // what is the bill's (an input, a smelt, a fuel, a get, the furnace's cobblestone) is never parked
    const b: Bill = { ...bill(), smelts: [{ input: 'sand', output: 'glass', n: 16, depth: 0 }], fuel: [{ item: 'coal', n: 2 }], get: [{ item: 'clay_ball', n: 4, command: 'clay', count: 1 }] };
    const k = parkKinds(b, now(full));
    for (const n of ['sand', 'coal', 'clay_ball']) expect(k).not.toContain(n);
    expect([...billKinds(b)]).toEqual(expect.arrayContaining(['oak_stairs', 'oak_planks', 'oak_log', 'sand', 'glass', 'coal', 'stone']));
  });

  it("what the bill's crafts use of what is carried is never parked (the logs for its planks: parked, the next bill brought them back)", () => {
    const fx = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-build-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
    const recipes = new RecipeIndex((id) => fx.items[String(id)]);
    recipes.handle(fx);
    // logs carried (no unbox, no bring): the bill names only the planks it crafts
    const b: Bill = { ...bill(), unbox: [], crafts: [{ item: 'oak_planks', n: 12, table: false }], items: [{ item: 'oak_planks', need: 12, loose: 0, boxed: 0, home: 0, make: 12, how: 'craft', short: 0 }] };
    const slots = [...full.slice(0, 33), st('oak_log', 3), st('spruce_log', 3)];
    expect(billKinds(b).has('oak_log')).toBe(false);
    const k = parkKinds(b, now(slots, { recipes }));
    expect(k).not.toContain('oak_log');
    expect(k).toContain('spruce_log');
    // without the recipes (no crafter), as before
    expect(parkKinds(b, now(slots))).toContain('oak_log');
    // the table a craft needs and the furnace a smelt needs stay (e2e build-far: the table parked, the stairs stuck)
    const tools = [...full.slice(0, 34), st('crafting_table', 1), st('furnace', 1)];
    expect(parkKinds(bill(), now(tools))).not.toContain('crafting_table');
    expect(parkKinds(bill(), now(tools))).toContain('furnace');
    expect(parkKinds({ ...bill(), smelts: [{ input: 'sand', output: 'glass', n: 4, depth: 0 }] }, now(tools))).not.toContain('furnace');
    expect(parkKinds({ ...bill(), crafts: [{ item: 'oak_planks', n: 12, table: false }] }, now(tools))).toContain('crafting_table');
    // a furnace still to make is crafted on the table (e2e build-far: the table parked, `!furnace changed nothing`)
    expect(parkKinds({ ...bill(), crafts: [], furnace: true }, now(tools))).not.toContain('crafting_table');
  });
});

describe('the round: the running section only (Track B9)', () => {
  function jobDeps(bot: FakeBot, extra: Partial<JobDeps> = {}): JobDeps {
    return {
      world: bot.world,
      position: () => bot.feet,
      plan: (s: BuildSpec, o: PlanOptions) => Promise.resolve(planBuild(bot.world, s, o)),
      runner: (plan, hooks) => new BuildRunner(plan, { ...bot.deps(), ...hooks }),
      options: { scaffold: true, maxColumn: 6, safeEdge: 3 },
      have: (it) => bot.inv.count(it),
      canFetch: () => true,
      log: undefined,
      ...extra,
    };
  }

  it('a round gathers what the running section has left, not the sections after it; what is had costs no slot', async () => {
    // two floors of 64: stone on the bottom, oak planks on the top, in sections of 64
    const places = [];
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) places.push({ pos: { x: x + 2, y: F, z: z + 2 }, name: 'stone' }, { pos: { x: x + 2, y: F + 1, z: z + 2 }, name: 'oak_planks' });
    const s: BuildSpec = { kind: 'file', label: 'two floors', places };
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const job = new BuildJob(s, START, jobDeps(bot), { max: 64 });
    expect(job.sections.map((x) => x.cells)).toEqual([64, 64]);
    const end = await job.run();
    expect(end).toMatchObject({ state: 'restock' });
    // 10 slots: the first section's stone, not the planks of the second (before Track B9: both)
    expect(job.roundNeed(10, () => 64).materials).toEqual({ stone: 64 });
    // what is had costs no slot: with 64 stone carried a 1-slot budget still covers the section
    bot.inv.add('stone', 64);
    expect(job.roundNeed(1, () => 64).materials).toEqual({ stone: 64 });
    // the budget caps what is not had: 1 slot of 16-stacks
    bot.inv.add('stone', -64);
    expect(job.roundNeed(1, () => 16).materials).toEqual({ stone: 16 });
  });
});

describe('home logistics: park (Track B9)', () => {
  it('the slots given, whole, into the nearest chest with room, then the next; the memory read again; the free slots known', async () => {
    const h = fakeHome({
      containers: {
        '3,0,0': { kind: 'chest', items: Array.from({ length: 25 }, () => item('stone')) }, // 2 free, nearest
        '-5,0,0': { kind: 'chest' },
        '0,0,4': { kind: 'white_shulker_box' }, // a box block: never parked into
      },
      inv: [item('iron_pickaxe', 1), item('tuff', 16), item('quartz', 16), item('red_shulker_box', 1), item('copper_ore', 9)],
    });
    await h.logistics.scan(never);
    expect(h.logistics.parkRoom()).toBe(29);
    h.setPos({ x: 0.5, y: 0, z: 0.5 }); // (the scan left the bot by the last chest it read)
    const r = await h.logistics.park(never, [1, 2, 3, 4]);
    expect(r.reason).toBeUndefined();
    expect(r.left).toBe(0);
    expect(r.chests).toBe(2);
    expect(r.moved.map((m) => `${m.count} ${m.name} -> ${m.to}`)).toEqual(['16 tuff -> chest 3 0 0', '16 quartz -> chest 3 0 0', '1 red_shulker_box -> chest -5 0 0', '9 copper_ore -> chest -5 0 0']);
    expect(h.inv[0]?.name).toBe('iron_pickaxe');
    expect(h.inv.slice(1, 5).every((x) => !x)).toBe(true);
    expect(h.memory.get({ x: -5, y: 0, z: 0 })).toMatchObject({ contents: { red_shulker_box: 1, copper_ore: 9 }, free: 25 });
    expect(h.boxes.get('0,0,4')!.slots.every((x) => !x)).toBe(true);
    expect(h.logistics.parkRoom()).toBe(25);
  });

  it('no chest with room: nothing moves and it says why; a held save parks nothing', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: Array.from({ length: 27 }, () => item('stone')) } }, inv: [item('tuff', 16)] });
    await h.logistics.scan(never);
    expect(h.logistics.parkRoom()).toBe(0);
    const r = await h.logistics.park(never, [0]);
    expect(r).toMatchObject({ moved: [], left: 1, reason: 'no chest at home has a free slot' });
    const held = fakeHome({ containers: { '3,0,0': { kind: 'chest' } }, inv: [item('tuff', 16)], held: () => 'a !test inv save waits' });
    await held.logistics.scan(never);
    expect(await held.logistics.park(never, [0])).toMatchObject({ moved: [], left: 1, reason: 'held: a !test inv save waits' });
  });
});

describe('off the build for a box (Track B9)', () => {
  const box = { min: { x: 0, y: F, z: 0 }, max: { x: 45, y: F + 17, z: 50 } };
  it('past the planned stands round the walls: the first stand out from the landOff point with a free cell beside it', () => {
    // the running section's stands: a band 1 to 5 outside the east wall, at the feet and the head
    const stands = (c: Cell) => c.x >= 46 && c.x <= 50 && c.y >= F && c.y <= F + 1;
    const inBox = (c: Cell) => c.x >= 0 && c.x <= 45 && c.z >= 0 && c.z <= 50;
    expect(boxFreeSpot({ x: 49, y: F, z: 30 }, box, (c) => inBox(c) || stands(c))).toEqual({ x: 51, y: F, z: 30 });
    // nothing avoided, or nothing free within BOX_OFF_MORE: the point itself
    expect(boxFreeSpot({ x: 49, y: F, z: 30 }, box)).toEqual({ x: 49, y: F, z: 30 });
    expect(boxFreeSpot({ x: 49, y: F, z: 30 }, box, (c) => c.x <= 49 + BOX_OFF_MORE + 1)).toEqual({ x: 49, y: F, z: 30 });
  });
});

describe('a walk across a line of slabs (Track B9)', () => {
  it('a bottom slab is crossed, never a stand', () => {
    const w = new FlatWorld();
    const slab = { name: 'smooth_stone_slab', boxes: [[0, 0, 0, 1, 0.5, 1]] as const };
    for (let z = -3; z <= 3; z++) w.cells.set(`3,${F},${z}`, slab);
    const area = { min: { x: -2, y: F - 2, z: -3 }, max: { x: 8, y: F + 3, z: 3 } };
    const set = reachableStands(w, area, START);
    expect(set.has(`3,${F + 1},0`)).toBe(true);
    expect(set.has(`6,${F},0`)).toBe(true);
    expect(canStand(w, { x: 3, y: F + 1, z: 0 })).toBe(false);
    expect(canCross(w, { x: 3, y: F + 1, z: 0 })).toBe(true);
    expect(halfTop(w.blockAt({ x: 3, y: F, z: 0 }))).toBe(true);
    expect(halfTop(w.blockAt({ x: 2, y: F - 1, z: 0 }))).toBe(false);
  });
});

describe('a way out of the stand (Track B9)', () => {
  const slab = { name: 'smooth_stone_slab', boxes: [[0, 0, 0, 1, 0.5, 1]] as const };
  /** A cell left open (a refused one) with moss round it, three sides topped with bottom slabs (a rise of 1.5). */
  const pit = (): FlatWorld => {
    const w = new FlatWorld();
    for (const [x, z] of [[1, 0], [-1, 0], [0, -1], [0, 1]] as const) w.set({ x, y: F, z }, 'moss_block');
    for (const [x, z] of [[1, 0], [-1, 0], [0, -1]] as const) w.cells.set(`${x},${F + 1},${z}`, slab);
    return w;
  };
  const f: Cell = { x: 0, y: F, z: 0 };
  const t: Cell = { x: 0, y: F + 1, z: 1 };

  it('the last open side shut by the block: no way out; open ground and a block far off: a way out', () => {
    const w = pit();
    expect(wayOut(w, f)).toBe(true);
    expect(wayOut(w, f, t)).toBe(false);
    expect(wayOut(w, f, { x: 0, y: F + 1, z: 5 })).toBe(true);
    expect(wayOut(new FlatWorld(), f, { x: 1, y: F, z: 0 })).toBe(true);
  });

  it("a room wider than 3 with the bot inside: its doorway's block shuts it in (the build's footprint, grown by 3, is the way out)", () => {
    const w = new FlatWorld();
    // walls 3 high round x -4..4, z -4..4, a doorway 2 high at 4 0 (a block in its lower half is a step with no head room)
    for (let i = -4; i <= 4; i++) {
      for (const [x, z] of [[i, -4], [i, 4], [-4, i], [4, i]] as const) {
        for (let y = F; y <= F + 2; y++) if (!(x === 4 && z === 0 && y < F + 2)) w.set({ x, y, z }, 'stone');
      }
    }
    const foot = { minX: -4, maxX: 4, minZ: -4, maxZ: 4 };
    const door = { x: 4, y: F, z: 0 };
    expect(wayOut(w, f, door)).toBe(true); // the local rule: 3 sideways inside the room
    expect(wayOut(w, f, door, foot)).toBe(false);
    expect(wayOut(w, f, undefined, foot)).toBe(true);
    expect(wayOut(w, f, { x: 4, y: F + 1, z: 0 }, foot)).toBe(false); // the doorway's upper half: one block of head room left
    expect(wayOut(w, f, { x: 0, y: F + 4, z: 0 }, foot)).toBe(true); // a block high over the walk
  });

  it("an open trapdoor's panel is no floor: a room whose only way on is over it is shut (the goto's floor rule)", () => {
    const open = { name: 'pale_oak_trapdoor', boxes: [[0.8175, 0, 0, 1, 1, 1]] as const };
    const closedTop = { name: 'pale_oak_trapdoor', boxes: [[0, 0.8125, 0, 1, 1, 1]] as const };
    const w = new FlatWorld();
    // walls 3 high round x -4..4, z -4..4; the doorway at 4 0 is filled to the feet with an open trapdoor
    for (let i = -4; i <= 4; i++) {
      for (const [x, z] of [[i, -4], [i, 4], [-4, i], [4, i]] as const) {
        for (let y = F; y <= F + 2; y++) if (!(x === 4 && z === 0 && y > F)) w.set({ x, y, z }, 'stone');
      }
    }
    w.cells.set(`4,${F},0`, open);
    const foot = { minX: -4, maxX: 4, minZ: -4, maxZ: 4 };
    expect(wayOut(w, f, undefined, foot)).toBe(false);
    expect(canStand(w, { x: 4, y: F + 1, z: 0 })).toBe(false);
    w.cells.set(`4,${F},0`, closedTop);
    expect(canStand(w, { x: 4, y: F + 1, z: 0 })).toBe(true);
    expect(wayOut(w, f, undefined, foot)).toBe(true);
  });

  it('a walk never climbs from a half top onto a full top one up (a rise of 1.5)', () => {
    const w = new FlatWorld();
    w.cells.set(`1,${F},0`, slab);
    for (let y = F; y <= F + 1; y++) w.set({ x: 2, y, z: 0 }, 'stone');
    // the slab is walled in by stone two high on the other sides: from it the only way on is the 1.5 rise
    for (const [x, z] of [[1, 1], [1, -1]] as const) for (let y = F; y <= F + 2; y++) w.set({ x, y, z }, 'stone');
    const area = { min: { x: 1, y: F - 1, z: -1 }, max: { x: 3, y: F + 3, z: 1 } };
    const set = reachableStands(w, area, { x: 1, y: F + 1, z: 0 });
    expect(set.has(`2,${F + 2},0`)).toBe(false);
  });

  it('the runner does not place the block from the open cell: it walks out and places it from outside', async () => {
    const w = pit();
    const r = parseSpec(['fill', String(t.x), String(t.y), String(t.z), String(t.x), String(t.y), String(t.z), 'stone'], { feet: f });
    if (!r.ok) throw new Error(r.error);
    const p = planBuild(w, r.spec, { start: f });
    const bot = new FakeBot(w, new FakeInventory({ stone: 4 }), { x: 0.5, y: F, z: 0.5 });
    const run = new BuildRunner(p, bot.deps());
    expect(await run.run()).toEqual({ state: 'done' });
    expect(w.name(t)).toBe('stone');
    const at = bot.deps().position()!;
    expect(Math.floor(at.x) === f.x && Math.floor(at.z) === f.z && Math.floor(at.y) === f.y).toBe(false);
  });
});

describe('a round for the scaffold tool that stopped (Track B9)', () => {
  it('goes on by hand once a job; any other round that stopped stops the build', () => {
    const why = 'nothing to do from what I carry (cannot craft 1 stone_pickaxe yet); left: craft first 4 stick';
    expect(toolRoundGoesOn([SCAFFOLD_PICK], why, undefined)).toBe(true);
    expect(toolRoundGoesOn(['stone', SCAFFOLD_PICK], why, false)).toBe(true);
    expect(toolRoundGoesOn([SCAFFOLD_PICK], why, true)).toBe(false);
    expect(toolRoundGoesOn(['stone'], why, undefined)).toBe(false);
    expect(toolRoundGoesOn([SCAFFOLD_PICK], undefined, undefined)).toBe(false);
    expect(toolRoundGoesOn([SCAFFOLD_PICK], 'cancelled', undefined)).toBe(false);
  });
});

describe("a box dug by hand once the pickaxe is low (Track B9)", () => {
  it('the best tool while it has more than BOX_DIG_KEEP uses; then a hand slot (empty or no durability); none: the best', () => {
    const pick = (damage: number) => ({ name: 'iron_pickaxe', damage });
    expect(boxDigSlot('white_shulker_box', [pick(0), { name: 'dirt' }])).toBeUndefined();
    expect(boxDigSlot('white_shulker_box', [pick(250 - BOX_DIG_KEEP - 1), { name: 'dirt' }])).toBeUndefined();
    expect(boxDigSlot('white_shulker_box', [pick(250 - BOX_DIG_KEEP), { name: 'dirt' }])).toBe(1);
    expect(boxDigSlot('white_shulker_box', [pick(240), null, { name: 'dirt' }])).toBe(1);
    expect(boxDigSlot('white_shulker_box', [{ name: 'dirt' }, pick(240)])).toBe(0);
    const tools = Array.from({ length: 9 }, () => pick(240));
    expect(boxDigSlot('white_shulker_box', tools)).toBeUndefined();
    // no tool at all: the hand anyway (the best)
    expect(boxDigSlot('white_shulker_box', [{ name: 'dirt' }])).toBeUndefined();
  });
});

describe('the step up onto a raised floor (Track B9)', () => {
  /** A floor two blocks thick over the flat ground, 20 x 20: its second layer's middle is out of reach from the ground. */
  const floor = (): BuildSpec => {
    const r = parseSpec(['fill', '2', String(F), '2', '21', String(F + 1), '21', 'stone'], { feet: START });
    if (!r.ok) throw new Error(r.error);
    return r.spec;
  };

  it("one scaffold block beside the floor is the step: every cell placed, the step dug at the layer's end", () => {
    const w = new FlatWorld();
    const p = planBuild(w, floor(), { start: START });
    expect(p.skipped).toEqual([]);
    expect(p.work).toBe(800);
    const steps = p.steps.filter((s) => s.op === 'scaffold');
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      // on the ground beside the floor, never a cell of it
      expect(s.pos.y).toBe(F);
      expect(s.pos.x < 2 || s.pos.x > 21 || s.pos.z < 2 || s.pos.z > 21).toBe(true);
    }
    const dug = new Set(p.steps.filter((s) => s.op === 'unscaffold').map((s) => `${s.pos.x},${s.pos.y},${s.pos.z}`));
    for (const s of steps) expect(dug.has(`${s.pos.x},${s.pos.y},${s.pos.z}`)).toBe(true);
  });

  it('the fake bot builds it all and no scaffold is left', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, floor(), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ stone: 800, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const r = new BuildRunner(p, bot.deps());
    expect(await r.run()).toEqual({ state: 'done' });
    expect(r.stats.placed).toBe(800);
    for (let x = 2; x <= 21; x++) for (let z = 2; z <= 21; z++) expect(w.name({ x, y: F + 1, z })).toBe('stone');
    expect(r.stats.scaffoldsPlaced).toBe(r.stats.scaffoldsRemoved);
    expect(bot.inv.count('dirt')).toBe(16);
  });
});

describe('a get for what a gather does not bring (Track B9)', () => {
  it('a stripped log is no `!get` (a gather chops natural logs); a natural log and a mined block are', () => {
    expect(getHow('stripped_pale_oak_log')).toBeUndefined();
    expect(getHow('stripped_oak_log')).toBeUndefined();
    expect(getHow('pale_oak_log')).toEqual({ item: 'pale_oak_log', per: 1 });
    expect(getHow('oak_log')).toEqual({ item: 'oak_log', per: 1 });
    expect(getHow('cobblestone')).toBeDefined();
  });
});

describe('a placement the stop interrupted (Track B9)', () => {
  it('a cell not marked done that holds its block is found done on the resume (the bill does not count it again)', () => {
    const w = new FlatWorld();
    const r = parseSpec(['fill', '2', String(F), '2', '6', String(F), '6', 'green_wool'], { feet: START });
    if (!r.ok) throw new Error(r.error);
    const progress = new BuildProgress(undefined, { args: [], feet: START, label: r.spec.label, kind: r.spec.kind, box: { min: { x: 2, y: F, z: 2 }, max: { x: 6, y: F, z: 6 } }, total: 25, fetch: false });
    for (let x = 2; x <= 6; x++) {
      w.set({ x, y: F, z: 2 }, 'green_wool');
      progress.mark({ x, y: F, z: 2 });
    }
    w.set({ x: 4, y: F, z: 3 }, 'green_wool'); // placed as the stop came: never marked
    w.set({ x: 5, y: F, z: 3 }, 'white_wool'); // another block: not done
    const { survey } = BuildJob.survey(r.spec, w, progress);
    expect(survey).toMatchObject({ done: 6, found: 1, air: 0, other: 0 });
    expect(progress.has({ x: 4, y: F, z: 3 })).toBe(true);
    expect(progress.has({ x: 5, y: F, z: 3 })).toBe(false);
  });
});
