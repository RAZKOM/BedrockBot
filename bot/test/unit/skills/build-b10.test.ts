// Track B10 (ADR 0135, docs/build.md "Never stranded"): a build never strands itself: the dig-out of a pocket (sim.ts
// digWayOut, the runner's getOut with the build's cells dug placed again), box stands with a way out, a box cell on the
// build as the last resort, a column top that would shut its own foot in, and no false `out of` for what the boxes hold.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { kitItem } from '../../../src/chat/commands-build.ts';
import { billOf, nextFetchStep, type Bill, type FetchNow } from '../../../src/skills/build/bill.ts';
import { RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import { THROWAWAY_BLOCKS } from '../../../src/skills/survival/keeper.ts';
import type { ItemStack } from '../../../src/world/types.ts';
import { BuildJob, type JobDeps } from '../../../src/skills/build/job.ts';
import { planBuild, type Plan, type PlanOptions } from '../../../src/skills/build/plan.ts';
import { BuildRunner, type RunnerDeps, type RunnerSupply } from '../../../src/skills/build/runner.ts';
import { DIG_MAX, digWayOut, wayOut, type BlockLike, type Footprint } from '../../../src/skills/build/sim.ts';
import { BuildProgress } from '../../../src/skills/build/progress.ts';
import { sameBlock } from '../../../src/skills/build/states.ts';
import { add, key, type BuildSpec, type Cell } from '../../../src/skills/build/types.ts';
import { FakeBot, FakeInventory, FlatWorld } from './build-fakes.ts';

const F = -60;
const START: Cell = { x: 0, y: F, z: 0 };
const cellOfFeet = (bot: FakeBot): Cell => ({ x: Math.floor(bot.feet.x), y: Math.floor(bot.feet.y + 1e-3), z: Math.floor(bot.feet.z) });

/** Walls `h` high on the ring at distance `r` round x, z = 0 (feet level F up). */
function ring(w: FlatWorld, r: number, h: number, name: (p: Cell) => string = () => 'stone'): Cell[] {
  const cells: Cell[] = [];
  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      if (Math.max(Math.abs(x), Math.abs(z)) !== r) continue;
      for (let y = F; y < F + h; y++) {
        const p = { x, y, z };
        w.set(p, name(p));
        cells.push(p);
      }
    }
  }
  return cells;
}

const footOf = (cells: readonly Cell[]): Footprint => ({
  minX: Math.min(...cells.map((c) => c.x)),
  maxX: Math.max(...cells.map((c) => c.x)),
  minZ: Math.min(...cells.map((c) => c.z)),
  maxZ: Math.max(...cells.map((c) => c.z)),
});

describe('digWayOut (Track B10)', () => {
  const cost = (_p: Cell, b: BlockLike): number | undefined => (b.name === 'bedrock' ? undefined : b.name === 'stone' ? 6 : 2);

  it('a ring of walls 3 high: two cells of one wall dug (the feet and the head), then a walk out of the footprint', () => {
    const w = new FlatWorld();
    const walls = ring(w, 2, 3);
    const foot = footOf(walls);
    expect(wayOut(w, START, undefined, foot)).toBe(false);
    const way = digWayOut(w, START, foot, cost)!;
    expect(way).toBeDefined();
    expect(way.digs).toHaveLength(2);
    const [a, b] = way.digs;
    expect(a!.x === b!.x && a!.z === b!.z).toBe(true);
    expect(new Set(way.digs.map((d) => d.y))).toEqual(new Set([F, F + 1]));
    expect(way.digs.every((d) => Math.max(Math.abs(d.x), Math.abs(d.z)) === 2)).toBe(true);
    // the steps carry the digs in order, the last step out of the footprint grown by 3
    expect(way.steps.flatMap((s) => s.digs)).toEqual(way.digs);
    const last = way.steps.at(-1)!.to;
    expect(last.x < foot.minX - 3 || last.x > foot.maxX + 3 || last.z < foot.minZ - 3 || last.z > foot.maxZ + 3).toBe(true);
  });

  it('the cheapest wall: the side of natural blocks before the build own', () => {
    const w = new FlatWorld();
    const walls = ring(w, 2, 3, (p) => (p.x === -2 && p.z === 0 ? 'dirt' : 'stone'));
    const way = digWayOut(w, START, footOf(walls), cost)!;
    expect(way.digs.map((d) => w.name(d))).toEqual(['dirt', 'dirt']);
  });

  it('open ground: no digs; blocks never dug or more than `max` to dig: undefined; a ring never dug: under it', () => {
    expect(digWayOut(new FlatWorld(), START, { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }, cost)).toMatchObject({ digs: [] });
    const w = new FlatWorld();
    const walls = ring(w, 2, 3, () => 'bedrock');
    expect(digWayOut(w, START, footOf(walls), () => undefined)).toBeUndefined();
    // the ground under a ring of bedrock is dug instead (a way under the wall), never the bedrock
    const under = digWayOut(w, START, footOf(walls), cost)!;
    expect(under.digs.length).toBeGreaterThan(0);
    expect(under.digs.every((d) => w.name(d) !== 'bedrock' && d.y < F)).toBe(true);
    const w2 = new FlatWorld();
    const walls2 = ring(w2, 2, 3);
    expect(digWayOut(w2, START, footOf(walls2), cost, { max: 1 })).toBeUndefined();
  });

  it('a wall two thick: dug through within DIG_MAX', () => {
    const w = new FlatWorld();
    const walls = [...ring(w, 2, 3), ...ring(w, 3, 3)];
    const way = digWayOut(w, START, footOf(walls), cost)!;
    expect(way.digs.length).toBeGreaterThanOrEqual(3);
    expect(way.digs.length).toBeLessThanOrEqual(DIG_MAX);
    expect(way.digs.every((d) => w.name(d) !== 'air')).toBe(true);
  });
});

/** The runner's goto over the fake: no walk out of a pocket (wayOut false at the feet: the goto finds nothing). */
function shutGoto(bot: FakeBot, foot: Footprint | undefined): RunnerDeps['goto'] {
  const d = bot.deps();
  return (g, o) => (wayOut(bot.world, cellOfFeet(bot), undefined, foot) ? d.goto(g, o) : Promise.resolve({ ok: false, reason: 'no progress possible (no partial end 5+ blocks from the start)' }));
}

describe('a bot shut in by the build digs itself out (Track B10)', () => {
  /** A ring of oak planks 3 high round the bot (the build's, placed already) and stone to place 8 blocks east. */
  const shutIn = (): { w: FlatWorld; spec: BuildSpec; walls: Cell[]; far: Cell[] } => {
    const w = new FlatWorld();
    const walls = ring(w, 2, 3, () => 'oak_planks');
    const far = [{ x: 10, y: F, z: 0 }, { x: 10, y: F, z: 1 }];
    const spec: BuildSpec = { kind: 'file', label: 'ring', places: [...walls.map((pos) => ({ pos, name: 'oak_planks' })), ...far.map((pos) => ({ pos, name: 'stone' }))] };
    return { w, spec, walls, far };
  };

  it('the runner: its walk fails, it digs two of the ring (the build last, the cells said undone) and places the stone', async () => {
    const { w, spec, walls, far } = shutIn();
    const plan = planBuild(w, spec, { start: START });
    expect(plan.work).toBe(2);
    const bot = new FakeBot(w, new FakeInventory({ stone: 4, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const undone: Cell[] = [];
    const run = new BuildRunner(plan, { ...bot.deps(), goto: shutGoto(bot, footOf(spec.places.map((b) => b.pos))), cellUndone: (c) => undone.push(c) });
    expect(await run.run()).toEqual({ state: 'done' });
    for (const c of far) expect(w.name(c)).toBe('stone');
    expect(run.stats.escapes).toBe(1);
    expect(run.stats.undone).toBe(2);
    expect(undone).toHaveLength(2);
    expect(undone.every((c) => walls.some((p) => key(p) === key(c)))).toBe(true);
    expect(bot.log.filter((l) => l.startsWith('dig '))).toHaveLength(2);
  });

  it('a runner of its own (no job): the plain blocks it dug, found there already, go back before it ends', async () => {
    const { w, spec, walls, far } = shutIn();
    const plan = planBuild(w, spec, { start: START });
    const bot = new FakeBot(w, new FakeInventory({ stone: 4, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const run = new BuildRunner(plan, { ...bot.deps(), goto: shutGoto(bot, footOf(spec.places.map((b) => b.pos))) });
    expect(await run.run()).toEqual({ state: 'done' });
    for (const c of [...walls]) expect(w.name(c)).toBe('oak_planks');
    for (const c of far) expect(w.name(c)).toBe('stone');
    expect(run.stats.placed).toBe(2);
    expect(run.stats.skipped).toEqual([]);
    // out of the ring by then (it was placed again from outside)
    const f = cellOfFeet(bot);
    expect(Math.max(Math.abs(f.x), Math.abs(f.z))).toBeGreaterThan(2);
  });

  it('the job: the cells dug go back in an [again] section; the build ends whole', async () => {
    const { w, spec, walls, far } = shutIn();
    const bot = new FakeBot(w, new FakeInventory({ stone: 4, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const foot = footOf(spec.places.map((b) => b.pos));
    const deps: JobDeps = {
      world: w,
      position: () => bot.feet,
      plan: (s: BuildSpec, o: PlanOptions) => Promise.resolve(planBuild(w, s, o)),
      runner: (plan, hooks) => new BuildRunner(plan, { ...bot.deps(), goto: shutGoto(bot, foot), ...hooks }),
      options: { scaffold: true, maxColumn: 6, safeEdge: 3 },
      have: (it) => bot.inv.count(it),
      log: undefined,
    };
    const job = new BuildJob(spec, START, deps);
    expect(await job.run()).toEqual({ state: 'done' });
    for (const c of walls) expect(w.name(c)).toBe('oak_planks');
    for (const c of far) expect(w.name(c)).toBe('stone');
    expect(job.stats.escapes).toBe(1);
    expect(job.stats.undone).toBe(2);
    expect(job.sections.some((s) => s.again)).toBe(true);
  });

  it('a pocket with no way out at all (bedrock round it): no dig, the walk fails as before', async () => {
    const w = new FlatWorld();
    ring(w, 2, 3, () => 'bedrock');
    const spec: BuildSpec = { kind: 'file', label: 'far', places: [{ pos: { x: 10, y: F, z: 0 }, name: 'stone' }] };
    const plan = planBuild(w, spec, { start: START });
    const bot = new FakeBot(w, new FakeInventory({ stone: 4, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const run = new BuildRunner(plan, { ...bot.deps(), goto: shutGoto(bot, { minX: -2, maxX: 10, minZ: -2, maxZ: 2 }) });
    await run.run();
    expect(bot.digs).toBe(0);
    expect(w.name({ x: 10, y: F, z: 0 })).toBe('air');
  });
});

/** A Supply over the fake bot whose box needs a free cell beside the feet (not avoided, two of air, a full floor). */
class CellSupply implements RunnerSupply {
  readonly boxed = new Map<string, number>();
  readonly cells: Cell[] = [];
  never = false;
  private readonly bot: FakeBot;
  constructor(bot: FakeBot, init: Record<string, number>) {
    this.bot = bot;
    for (const [k, v] of Object.entries(init)) this.boxed.set(k, v);
  }
  private names(n: string | readonly string[]): string[] {
    return typeof n === 'string' ? [n] : [...n];
  }
  carried(n: string | readonly string[]): number {
    return this.names(n).reduce((a, k) => a + (this.boxed.get(k) ?? 0), 0);
  }
  private spot(avoid: ((p: Cell) => boolean) | undefined): Cell | undefined {
    if (this.never) return undefined;
    const f = cellOfFeet(this.bot);
    const w = this.bot.world;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      const p = add(f, dx, 0, dz);
      if (avoid?.(p) || avoid?.(add(p, 0, 1, 0))) continue;
      if (w.blockAt(p)!.boxes.length || w.blockAt(add(p, 0, 1, 0))!.boxes.length || !w.blockAt(add(p, 0, -1, 0))!.boxes.length) continue;
      return p;
    }
    return undefined;
  }
  ensure(n: string | readonly string[], target: number, opts: { avoid?: (p: Cell) => boolean }) {
    const ns = this.names(n);
    let loose = ns.reduce((a, k) => a + this.bot.inv.count(k), 0);
    const at = this.spot(opts.avoid);
    if (!at) return Promise.resolve({ ok: false, loose, fromBoxes: 0, reason: 'no free cell for the box next to the bot' });
    this.cells.push(at);
    let from = 0;
    for (const k of ns) {
      const take = Math.min(Math.max(0, target - loose), this.boxed.get(k) ?? 0);
      this.boxed.set(k, (this.boxed.get(k) ?? 0) - take);
      this.bot.inv.add(k, take);
      loose += take;
      from += take;
    }
    return Promise.resolve({ ok: loose >= target, loose, fromBoxes: from });
  }
  stow(_n: string | readonly string[], _keep: number) {
    return Promise.resolve({ stowed: 0 });
  }
}

describe('a cell for a shulker box (Track B10)', () => {
  const spec: BuildSpec = { kind: 'file', label: 'two', places: [{ pos: { x: 3, y: F, z: 0 }, name: 'stone' }, { pos: { x: 3, y: F + 1, z: 0 }, name: 'stone' }] };
  const inPit = (p: Cell) => p.x >= 4 && p.x <= 6 && p.z >= -1 && p.z <= 1;

  it('a box stand the walk could not leave (a pit 2 deep) is passed over; the box goes on a cell of the build not placed yet', async () => {
    const w = new FlatWorld();
    // a pit 3 x 3, 2 deep, beside the build: the only cells round here the build leaves free for a box
    for (let x = 4; x <= 6; x++) for (let z = -1; z <= 1; z++) for (const y of [F - 1, F - 2]) w.set({ x, y, z }, 'air');
    const plan = planBuild(w, spec, { start: START });
    const bot = new FakeBot(w, new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new CellSupply(bot, { stone: 8 });
    const run = new BuildRunner(plan, { ...bot.deps(), supply: sup, avoid: (p) => !inPit(p) || p.y >= F });
    expect(await run.run()).toEqual({ state: 'done' });
    expect(w.name({ x: 3, y: F + 1, z: 0 })).toBe('stone');
    // never down in the pit
    expect(bot.log.filter((l) => l.startsWith('goto ') && Number(l.split(' ')[1]!.split(',')[1]) < F)).toEqual([]);
    expect(sup.cells.length).toBeGreaterThan(0);
  });

  it('no cell anywhere: the stop says so and what the boxes hold, never `out of`', async () => {
    const w = new FlatWorld();
    const plan = planBuild(w, spec, { start: START });
    const bot = new FakeBot(w, new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new CellSupply(bot, { stone: 8 });
    sup.never = true;
    const end = await new BuildRunner(plan, { ...bot.deps(), supply: sup }).run();
    expect(end.state).toBe('stopped');
    const why = end.state === 'stopped' ? end.reason : '';
    expect(why).toMatch(/^no cell to set a shulker box down near -?\d+ -?\d+ -?\d+ \(my shulker boxes hold 8 stone\)$/);
    expect(why).not.toMatch(/out of/);
  });
});

describe('a round that fits what the kit leaves free (Track B10)', () => {
  const fx = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-build-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
  const recipes = new RecipeIndex((id) => fx.items[String(id)]);
  recipes.handle(fx);
  const st = (name: string, count = 64): ItemStack => ({ name, count, networkId: 0, metadata: 0 });
  // the Realm kit: 4 tools, a bow and arrows, an elytra, food, rockets, a throwaway stack, 11 white and 6 red boxes
  const kit = [st('netherite_pickaxe', 1), st('netherite_axe', 1), st('netherite_shovel', 1), st('netherite_sword', 1), st('bow', 1), st('arrow'), st('elytra', 1), st('cooked_beef', 32), st('firework_rocket'), st('cobblestone', 26)];
  const boxes = [...Array.from({ length: 11 }, () => st('white_shulker_box', 1)), ...Array.from({ length: 6 }, () => st('red_shulker_box', 1))];
  const item = (i: string, need: number, o: Partial<Bill['items'][number]> = {}): Bill['items'][number] => ({ item: i, need, loose: 0, boxed: 0, home: need, make: 0, short: 0, ...o });
  const bill = (o: Partial<Bill> = {}): Bill => ({
    items: [item('azalea_leaves', 337), item('moss_block', 310), item('oak_planks', 64, { home: 0, make: 64, how: 'craft', from: '16 oak_log' })],
    bring: [{ item: 'azalea_leaves', n: 337 }, { item: 'moss_block', n: 310 }, { item: 'oak_log', n: 16 }],
    unbox: [],
    crafts: [{ item: 'oak_planks', n: 64, table: false }],
    smelts: [],
    furnace: false,
    fuel: [],
    get: [],
    cannot: [],
    ok: false,
    ...o,
  });
  const now = (slots: ItemStack[], o: Partial<FetchNow> = {}): FetchNow => ({ slots, recipes, boxed: new Map(), boxRoom: 0, never: THROWAWAY_BLOCKS, kit: kitItem, ownBox: (n) => n === 'red_shulker_box', ...o });

  it('what the crafts use comes first, then the craft, before the finished blocks fill the inventory', () => {
    const slots = [...kit, ...boxes];
    expect(36 - slots.length).toBe(9);
    // before: `bring azalea_leaves 337 home` first, then moss, then no room to craft the planks
    expect(nextFetchStep(bill(), now(slots))).toEqual({ kind: 'run', command: 'bring oak_log 16 home' });
    const withLogs = [...slots, st('oak_log', 16)];
    const b2 = bill({ bring: [{ item: 'azalea_leaves', n: 337 }, { item: 'moss_block', n: 310 }] });
    expect(nextFetchStep(b2, now(withLogs))).toEqual({ kind: 'run', command: 'craft oak_planks 64' });
  });

  it('a finished block leaves the slots of what the crafts still make and FETCH_FREE_MIN: a part of it', () => {
    // the logs are here but the craft waits for its table (none carried, none can be made): the bring is cut
    const slots = [...kit, ...boxes, st('stone', 1)];
    const b = bill({ bring: [{ item: 'azalea_leaves', n: 337 }], crafts: [{ item: 'oak_planks', n: 64, table: false }] });
    const step = nextFetchStep(b, now(slots, { recipes: undefined }));
    // 8 free less 3 less the planks' slot: 4 stacks of the 6
    expect(step).toEqual({ kind: 'run', command: 'bring azalea_leaves 256 home' });
  });

  it('three free slots: a stow or a park first, never a bring the withdrawal has no room for', () => {
    const slots = [...kit, ...boxes, st('moss_block', 64), st('moss_block', 64), st('tuff', 16), st('quartz', 16), st('candle', 4), st('gunpowder', 16)];
    expect(36 - slots.length).toBe(3);
    const b = bill({ items: [item('azalea_leaves', 128), item('moss_block', 128, { loose: 128, home: 0 })], bring: [{ item: 'azalea_leaves', n: 128 }], crafts: [] });
    // before: `bring azalea_leaves 128 home` (2 stacks fit 3 free slots by the old rule) changed nothing, twice
    expect(nextFetchStep(b, now(slots, { boxRoom: 20, boxed: new Map([['stone', 64]]) }))).toEqual({ kind: 'stow', keep: { moss_block: 0 } });
    const park = nextFetchStep(b, now(slots, { park: true }));
    expect(park.kind).toBe('park');
    expect(park.kind === 'park' && park.items).toEqual(expect.arrayContaining(['tuff', 'quartz', 'candle', 'gunpowder']));
    // the bow's arrows are the kit (a Realm round parked them), like the rockets and the throwaway stack
    expect(kitItem('arrow')).toBe(true);
    for (const k of ['arrow', 'firework_rocket', 'cobblestone', 'elytra', 'netherite_pickaxe', 'white_shulker_box']) expect(park.kind === 'park' && park.items).not.toContain(k);
    // no room to make in a round: done with what came (the moss), the next round brings the rest
    expect(nextFetchStep(b, now(slots, { round: true }))).toEqual({ kind: 'done' });
    // the home chests full, the boxes full, nothing of the bill carried: said as it is, never `changed nothing`
    const none = { ...b, items: [item('azalea_leaves', 128)] };
    const stuck = nextFetchStep(none, now(slots, { round: true, homeFull: true }));
    expect(stuck).toEqual({ kind: 'stuck', why: 'my inventory is full (3 free slots, my shulker boxes are full) and the home chests are full: !bring azalea_leaves 128 home needs 4 (give me an empty shulker box, or room in a chest at home)' });
  });

  it('nothing to craft from with the home chests full: the stuck line says so', () => {
    const slots = [...kit, ...boxes, ...Array.from({ length: 9 }, () => st('tuff', 64))];
    const b = bill({ items: [item('oak_planks', 64, { home: 0, make: 64, how: 'craft', from: '16 oak_log' })], bring: [], crafts: [{ item: 'oak_planks', n: 64, table: false }] });
    const s = nextFetchStep(b, now(slots, { homeFull: true, boxed: new Map([['oak_log', 16]]) }));
    expect(s.kind === 'stuck' && s.why).toMatch(/my inventory is full, my shulker boxes too and the home chests are full/);
  });
});

describe('placed dirt that grass spread onto (Track B10)', () => {
  it('counts as the dirt: the same block (a resume, the checks); not the other way round', () => {
    expect(sameBlock('dirt', 'grass_block')).toBe(true);
    expect(sameBlock('grass_block', 'dirt')).toBe(false);
    expect(sameBlock('coarse_dirt', 'grass_block')).toBe(false);
  });

  it('a resume keeps a done dirt cell that is grass now done (it was left as `another block`)', () => {
    const w = new FlatWorld();
    const spec: BuildSpec = { kind: 'file', label: 'dirt', places: [{ pos: { x: 2, y: F, z: 0 }, name: 'dirt' }, { pos: { x: 3, y: F, z: 0 }, name: 'dirt' }] };
    w.set({ x: 2, y: F, z: 0 }, 'grass_block');
    w.set({ x: 3, y: F, z: 0 }, 'dirt');
    const p = new BuildProgress(undefined, { args: [], feet: START, label: spec.label, kind: spec.kind, box: { min: { x: 2, y: F, z: 0 }, max: { x: 3, y: F, z: 0 } }, total: 2, fetch: false });
    for (const b of spec.places) p.mark(b.pos);
    const s = BuildJob.survey(spec, w, p);
    expect(s.survey).toMatchObject({ done: 2, other: 0, air: 0 });
    expect(s.left).toEqual([]);
  });
});

describe('a column top never shuts its own foot in (Track B10)', () => {
  it('the block that closes the last way out of the foot is not placed from the top; the bot comes down and walks out', async () => {
    const w = new FlatWorld();
    // walls 3 high round the column's foot, a doorway 2 high to the east at x 1 (a block in its lower half is a step
    // with no head room)
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        if (x === 0 && z === 0) continue;
        for (let y = F; y < F + 3; y++) if (!(x === 1 && z === 0 && y < F + 2)) w.set({ x, y, z }, 'stone');
      }
    }
    const t: Cell = { x: 1, y: F, z: 0 };
    const top: Cell = { x: 0, y: F + 2, z: 0 };
    const spec: BuildSpec = { kind: 'file', label: 'door', places: [{ pos: t, name: 'stone' }] };
    const plan: Plan = {
      spec,
      steps: [
        { op: 'pillar', base: START, height: 2 },
        { op: 'place', pos: t, name: 'stone', item: 'stone', top },
        { op: 'descend', base: START, height: 2 },
      ],
      work: 1,
      already: 0,
      occupied: 0,
      skipped: [],
      scaffolds: 2,
      scaffoldPeak: 2,
      materials: { stone: 1 },
      ms: 0,
    };
    const bot = new FakeBot(w, new FakeInventory({ stone: 4, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const d = bot.deps();
    const placedFrom: Cell[] = [];
    const place: RunnerDeps['place'] = (p, o) => {
      if (key(p) === key(t)) placedFrom.push(cellOfFeet(bot));
      return d.place(p, o);
    };
    const run = new BuildRunner(plan, { ...d, place });
    await run.run();
    // never clicked from the column top (feet over the foot); the column came down
    expect(placedFrom.filter((f) => f.y > F)).toEqual([]);
    expect(w.name({ x: 0, y: F, z: 0 })).toBe('air');
    expect(w.name({ x: 0, y: F + 1, z: 0 })).toBe('air');
    // placed from the ground it is, from outside the pocket (the B9 rule for stands)
    if (w.name(t) === 'stone') expect(placedFrom.at(-1)!.x).toBeGreaterThan(1);
  });
});

describe('the table the furnace needs (Track B10)', () => {
  const fx = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-build-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
  const recipes = new RecipeIndex((id) => fx.items[String(id)]);
  recipes.handle(fx);
  const map = (o: Record<string, number>) => new Map(Object.entries(o));
  const st = (name: string, count = 64): ItemStack => ({ name, count, networkId: 0, metadata: 0 });

  it('a table at home or in a box (none carried) is brought or taken out for the furnace; carried, nothing more', () => {
    // smooth stone is smelted: a furnace to craft (8 cobblestone carried) on a table the chain counted as had
    const atHome = billOf({ need: map({ smooth_stone: 4 }), loose: map({ cobblestone: 8, stone: 4, coal: 1 }), home: map({ crafting_table: 1 }), recipes, furnaceNear: false });
    expect(atHome.furnace).toBe(true);
    expect(atHome.bring).toContainEqual({ item: 'crafting_table', n: 1 });
    const now = (slots: ItemStack[], boxed = new Map<string, number>()): FetchNow => ({ slots, recipes, boxed, boxRoom: 10, never: THROWAWAY_BLOCKS });
    const loose = [st('cobblestone', 8), st('stone', 4), st('coal', 1)];
    expect(nextFetchStep(atHome, now(loose))).toEqual({ kind: 'run', command: 'bring crafting_table 1 home' });
    const inBox = billOf({ need: map({ smooth_stone: 4 }), loose: map({ cobblestone: 8, stone: 4, coal: 1 }), boxed: map({ crafting_table: 1 }), recipes, furnaceNear: false });
    expect(inBox.unbox).toContainEqual({ item: 'crafting_table', n: 1 });
    expect(nextFetchStep(inBox, now(loose, map({ crafting_table: 1 })))).toEqual({ kind: 'unbox', want: { crafting_table: 1 } });
    // carried: no take, the furnace next
    const carried = billOf({ need: map({ smooth_stone: 4 }), loose: map({ cobblestone: 8, stone: 4, coal: 1, crafting_table: 1 }), home: map({ crafting_table: 1 }), recipes, furnaceNear: false });
    expect(carried.bring.some((x) => x.item === 'crafting_table')).toBe(false);
    expect(nextFetchStep(carried, now([...loose, st('crafting_table', 1)]))).toEqual({ kind: 'run', command: 'furnace' });
  });
});
