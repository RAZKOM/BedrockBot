// Track B3 (ADR 0128, docs/build.md "Size", "Height", "Resume", "Speed"): the builder at full size on the flat fake
// world: safe stands, one stand placing all it reaches, columns kept and grown, digs from a column top, bursts of
// clicks, the restock end, sections, the job with its rounds and its resume, the progress file, the planner worker.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MessageChannel, type Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { BuildJob, boxSections, placeSections, type JobDeps } from '../../../src/skills/build/job.ts';
import { planBuild, type Plan, type PlanOptions } from '../../../src/skills/build/plan.ts';
import { BuildProgress, buildProgressFile, loadProgress } from '../../../src/skills/build/progress.ts';
import { BuildRunner, type RunnerEnd } from '../../../src/skills/build/runner.ts';
import { edgeDrop } from '../../../src/skills/build/sim.ts';
import { parseSpec } from '../../../src/skills/build/spec.ts';
import { BuildPlannerClient, readerOf, runBuildPlanWorker, snapshotBox, snapshotWorld } from '../../../src/skills/build/worker.ts';
import { key, type BuildSpec, type Cell } from '../../../src/skills/build/types.ts';
import { FakeBot, FakeInventory, FLOOR_Y, FlatWorld } from './build-fakes.ts';

const F = -60;
const START: Cell = { x: 0, y: F, z: 0 };

function spec(args: string, feet: Cell = START): BuildSpec {
  const r = parseSpec(args.split(' '), { feet });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

const stands = (p: Plan) => p.steps.flatMap((s) => ('stand' in s && s.stand ? [s.stand] : []));

/** Run a runner to its end. */
const runAll = (r: BuildRunner) => r.run();

/** No scaffold block (cobblestone) left above the ground. */
function noScaffold(w: FlatWorld): boolean {
  for (const [k, b] of w.cells) if (b.name === 'cobblestone' && Number(k.split(',')[1]) > FLOOR_Y) return false;
  return true;
}

describe('safe stands (Track B3)', () => {
  it('edgeDrop: the deepest fall one step off a stand', () => {
    const w = new FlatWorld();
    for (let y = F - 6; y <= FLOOR_Y; y++) w.set({ x: 1, y, z: 0 }, 'air');
    expect(edgeDrop(w, START)).toBe(6);
    expect(edgeDrop(w, START, 4)).toBe(4);
    expect(edgeDrop(w, { x: -3, y: F, z: 0 })).toBe(0);
  });

  it('with safeEdge 3 no stand of the plan is beside a deeper drop; the wall is built from the far stands', () => {
    const w = new FlatWorld();
    // a wall along z = 0 with a 6-deep trench on both sides (z = -1 and z = 1)
    for (let x = -2; x <= 6; x++) for (const z of [-1, 1]) for (let y = F - 6; y <= FLOOR_Y; y++) w.set({ x, y, z }, 'air');
    const s = spec(`wall 0 ${F} 0 4 0 2 stone`);
    const p = planBuild(w, s, { start: { x: 2, y: F, z: 4 }, safeEdge: 3 });
    expect(p.skipped).toEqual([]);
    expect(p.safeEdge).toBe(3);
    for (const f of stands(p)) expect(edgeDrop(w, f, 4)).toBeLessThanOrEqual(3);
    // the runner keeps to the same rule
    const bot = new FakeBot(w, new FakeInventory({ stone: 10, dirt: 16 }), { x: 2.5, y: F, z: 4.5 });
    const r = new BuildRunner(p, bot.deps());
    for (const f of r.stands({ x: 2, y: F, z: 0 }, () => true)) expect(edgeDrop(w, f, 4)).toBeLessThanOrEqual(3);
  });
});

describe('one stand places what it reaches (Track B3)', () => {
  it('a 9x9 floor: fewer stands than one a cell, fewer than without clustering', async () => {
    const s = spec(`floor -4 ${F} 6 4 14 stone`);
    const on = planBuild(new FlatWorld(), s, { start: START });
    const off = planBuild(new FlatWorld(), s, { start: START, cluster: false });
    const distinct = (p: Plan) => new Set(stands(p).map(key)).size;
    const moves = (p: Plan) => stands(p).filter((f, i, a) => i === 0 || key(f) !== key(a[i - 1]!)).length;
    expect(on.work).toBe(81);
    expect(moves(on)).toBeLessThan(moves(off));
    expect(distinct(on)).toBeLessThanOrEqual(distinct(off));
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 81, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const end = await runAll(new BuildRunner(on, bot.deps()));
    expect(end).toEqual({ state: 'done' });
    for (let x = -4; x <= 4; x++) for (let z = 6; z <= 14; z++) expect(bot.world.name({ x, y: F, z })).toBe('stone');
  });

  it('a wall 4 high: a ground stand places the layers above it reaches too, each block on the one under it', async () => {
    const moves = (p: Plan) => stands(p).filter((f, i, a) => i === 0 || key(f) !== key(a[i - 1]!)).length;
    const one = planBuild(new FlatWorld(), spec(`wall 0 ${F} 6 19 6 1 stone`), { start: START });
    const four = planBuild(new FlatWorld(), spec(`wall 0 ${F} 6 19 6 4 stone`), { start: START });
    expect(four.skipped).toEqual([]);
    expect(four.work).toBe(80);
    expect(moves(four)).toBeLessThan(2 * moves(one)); // not four times the stands of one layer
    const seen = new Set<string>();
    for (const s of four.steps) {
      if (s.op !== 'place') continue;
      if (s.pos.y > F) expect(seen.has(key({ ...s.pos, y: s.pos.y - 1 }))).toBe(true);
      seen.add(key(s.pos));
    }
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 80, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    expect(await new BuildRunner(four, bot.deps()).run()).toEqual({ state: 'done' });
    for (let y = F; y < F + 4; y++) for (let x = 0; x <= 19; x++) expect(bot.world.name({ x, y, z: 6 })).toBe('stone');
  });

  it('a walled room and a ring wall round it: nothing out of reach, the next cell the nearest, a third of the walk', async () => {
    // a room 24 x 16 (a floor, walls 4 high, a doorway) inside a ring wall 3 thick and 5 high (a gate), the bot in
    // between: the floor's middle was out of reach when its turn came (its stands are floor blocks still to place) and
    // the ring's cells were taken by their distance from the start, opposite sides in turn
    const blocks: { pos: Cell; name: string }[] = [];
    const W = 24;
    const D = 16;
    const O = 8; // the ring's outside from the structure's corner
    const put = (x: number, y: number, z: number, name: string) => blocks.push({ pos: { x: x + O, y, z: z + O }, name });
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < D; z++) {
        put(x, 0, z, 'stone_bricks');
        const ring = x === 0 || x === W - 1 || z === 0 || z === D - 1;
        if (!ring) continue;
        for (let y = 1; y <= 4; y++) if (!(z === D - 1 && x === 12 && y <= 2)) put(x, y, z, 'oak_planks');
      }
    }
    for (let x = -O; x < W + O; x++) {
      for (let z = -O; z < D + O; z++) {
        if (!(x < -5 || x >= W + 5 || z < -5 || z >= D + 5)) continue;
        for (let y = 0; y < 5; y++) if (!(z >= D + 5 && x >= 11 && x <= 13 && y <= 2)) put(x, y, z, 'stone_bricks');
      }
    }
    const feet = { x: 12 + O, y: F, z: D + 2 + O };
    const r = parseSpec(['file', 'room', '0', String(F), '0'], { feet, load: () => ({ name: 'room', size: { x: W + 2 * O, y: 5, z: D + 2 * O }, blocks }) });
    if (!r.ok) throw new Error(r.error);
    const walked = (p: Plan) => {
      let d = 0;
      const s = stands(p);
      for (let i = 1; i < s.length; i++) d += Math.hypot(s[i]!.x - s[i - 1]!.x, s[i]!.z - s[i - 1]!.z);
      return d;
    };
    const p = planBuild(new FlatWorld(), r.spec, { start: feet });
    expect(p.skipped).toEqual([]);
    expect(p.work).toBe(r.spec.places.length);
    const off = planBuild(new FlatWorld(), r.spec, { start: feet, cluster: false });
    expect(walked(p)).toBeLessThan(walked(off) / 2);
    const items: Record<string, number> = { dirt: 16 };
    for (const b of r.spec.places) items[b.name] = (items[b.name] ?? 0) + 1;
    const bot = new FakeBot(new FlatWorld(), new FakeInventory(items), { x: feet.x + 0.5, y: F, z: feet.z + 0.5 });
    expect(await new BuildRunner(p, bot.deps()).run()).toEqual({ state: 'done' });
    for (const b of r.spec.places) expect(bot.world.name(b.pos)).toBe(b.name);
  });

  it('bursts: the plain blocks a stand reaches go in one placeMany call (buildBurst)', async () => {
    const s = spec(`floor 2 ${F} 2 6 6 stone`);
    const p = planBuild(new FlatWorld(), s, { start: START });
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 25, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    bot.burst = 4;
    const r = new BuildRunner(p, bot.deps());
    expect(await r.run()).toEqual({ state: 'done' });
    expect(bot.bursts.length).toBeGreaterThan(0);
    expect(Math.max(...bot.bursts)).toBeGreaterThan(1);
    expect(r.stats.placed).toBe(25);
    for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) expect(bot.world.name({ x, y: F, z })).toBe('stone');
  });
});

describe('columns for tall builds (Track B3)', () => {
  it('a 12-high wall: the column is kept for the layers above and grown, every cell placed, nothing left', async () => {
    const s = spec(`wall 0 ${F} 6 2 6 12 stone`);
    const p = planBuild(new FlatWorld(), s, { start: START, maxColumn: 12 });
    expect(p.skipped).toEqual([]);
    expect(p.work).toBe(36);
    const pillars = p.steps.filter((x) => x.op === 'pillar');
    const descends = p.steps.filter((x) => x.op === 'descend');
    expect(descends.length).toBeLessThan(pillars.length); // grown on the same base at least once
    const bases = new Set(pillars.map((x) => (x.op === 'pillar' ? key(x.base) : '')));
    expect(bases.size).toBeLessThanOrEqual(descends.length);
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 36, cobblestone: 32, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const r = new BuildRunner(p, bot.deps());
    let perched = 0;
    let high = 0;
    bot.onStep = () => {
      if (r.perched()) perched++;
      else if (bot.feet.y > F + 1) high++; // above the ground and not on its own column: never
    };
    expect(await r.run()).toEqual({ state: 'done' });
    expect(perched).toBeGreaterThan(0);
    expect(high).toBe(0);
    expect(r.perched()).toBe(false);
    expect(r.stats.placed).toBe(36);
    for (let y = F; y < F + 12; y++) for (let x = 0; x <= 2; x++) expect(bot.world.name({ x, y, z: 6 })).toBe('stone');
    expect(noScaffold(bot.world)).toBe(true);
    expect(bot.feet.y).toBe(F);
    expect(r.stats.scaffoldsPlaced).toBe(r.stats.scaffoldsRemoved);
  });

  it('a new column takes the height whose top reaches the most cells still to place (fewer columns than the least height)', async () => {
    const s = spec(`wall 0 ${F} 6 11 6 12 stone`);
    const cover = planBuild(new FlatWorld(), s, { start: START, maxColumn: 12 });
    const least = planBuild(new FlatWorld(), s, { start: START, maxColumn: 12, cluster: false });
    const columns = (p: Plan) => p.steps.filter((x) => x.op === 'descend').length;
    expect(cover.skipped).toEqual([]);
    expect(least.skipped).toEqual([]);
    expect(columns(cover)).toBeLessThan(columns(least));
    expect(cover.scaffolds).toBeLessThan(least.scaffolds);
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 144, cobblestone: 32, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    expect(await new BuildRunner(cover, bot.deps()).run()).toEqual({ state: 'done' });
    for (let y = F; y < F + 12; y++) for (let x = 0; x <= 11; x++) expect(bot.world.name({ x, y, z: 6 })).toBe('stone');
    expect(noScaffold(bot.world)).toBe(true);
  });

  it('the scaffold is a kind a carried tool harvests: dirt without a pickaxe, cobblestone with one', async () => {
    const kinds = async (extra: Record<string, number>) => {
      const p = planBuild(new FlatWorld(), spec(`pillar 0 ${F} 6 9 stone`), { start: START, maxColumn: 8 });
      const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 9, cobblestone: 16, dirt: 16, ...extra }), { x: 0.5, y: F, z: 0.5 });
      expect(await new BuildRunner(p, bot.deps()).run()).toEqual({ state: 'done' });
      return new Set(bot.log.filter((l) => l.endsWith('(pillar)')).map((l) => l.split(' ')[2]));
    };
    expect([...(await kinds({}))]).toEqual(['dirt']);
    expect([...(await kinds({ stone_pickaxe: 1 }))]).toEqual(['cobblestone']);
  });

  it('out of scaffold blocks on a column: that column fails (its cells skipped for the sweep), the build goes on and ends on the ground', async () => {
    const p = planBuild(new FlatWorld(), spec(`wall 0 ${F} 6 2 6 12 stone`), { start: START, maxColumn: 12 });
    const short = p.scaffoldPeak - 2;
    expect(short).toBeGreaterThan(3);
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 36, dirt: short }), { x: 0.5, y: F, z: 0.5 });
    const r = new BuildRunner(p, bot.deps());
    const end = await r.run();
    // before: `stopped: out of throwaway blocks for scaffolding` part-way up, the rest of the build lost
    expect(end).toEqual({ state: 'done' });
    expect(r.stats.skipped.length).toBeGreaterThan(0);
    expect(r.stats.skipped.some((s) => /throwaway blocks on the column|column top|scaffold column failed/.test(s.reason))).toBe(true);
    expect(r.stats.placed + r.stats.skipped.filter((s) => s.reason.startsWith('place')).length).toBe(36);
    for (let y = F; y < F + 6; y++) for (let x = 0; x <= 2; x++) expect(bot.world.name({ x, y, z: 6 })).toBe('stone');
    expect(noScaffold(bot.world)).toBe(true);
    expect([...bot.world.cells].filter(([k, b]) => b.name === 'dirt' && Number(k.split(',')[1]) > FLOOR_Y)).toEqual([]);
    expect(r.scaffoldsOut()).toBe(0);
    expect(bot.feet.y).toBe(F);
  });

  it('with the default column (6) the top of a 14-high pillar is out of reach', () => {
    const p = planBuild(new FlatWorld(), spec(`pillar 0 ${F} 6 14 stone`), { start: START });
    expect(p.skipped.length).toBeGreaterThan(0);
    expect(p.skipped.some((x) => x.reason === 'out of reach')).toBe(true);
    expect(planBuild(new FlatWorld(), spec(`pillar 0 ${F} 6 14 stone`), { start: START, maxColumn: 12 }).skipped).toEqual([]);
  });

  it('clear: cells out of reach from the ground are dug from a column top, which comes down after', async () => {
    const w = new FlatWorld();
    for (let y = F; y < F + 10; y++) for (let x = 0; x <= 2; x++) w.set({ x, y, z: 6 }, 'stone');
    const p = planBuild(w, spec(`clear 0 ${F} 6 2 ${F + 9} 6`), { start: START, maxColumn: 8 });
    expect(p.skipped).toEqual([]);
    expect(p.steps.some((x) => x.op === 'dig' && x.top)).toBe(true);
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 32, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const r = new BuildRunner(p, bot.deps());
    expect(await r.run()).toEqual({ state: 'done' });
    for (let y = F; y < F + 10; y++) for (let x = 0; x <= 2; x++) expect(w.name({ x, y, z: 6 })).toBe('air');
    expect(noScaffold(w)).toBe(true);
    expect(bot.feet.y).toBe(F);
  });
});

describe('restock (Track B3)', () => {
  it('out of a block on the ground with fetchMore: ends restock at that step, goes on after more come; a second shortage there stops', async () => {
    const s = spec(`floor 2 ${F} 2 5 6 stone`);
    const p = planBuild(new FlatWorld(), s, { start: START });
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 8, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const done: string[] = [];
    const r = new BuildRunner(p, { ...bot.deps(), fetchMore: () => true, cellDone: (c) => done.push(key(c)) });
    expect(await r.run()).toEqual({ state: 'restock', items: ['stone'] });
    expect(r.stats.placed).toBe(8);
    expect(r.remainingNeed().items.get('stone')).toBe(12);
    bot.inv.add('stone', 6);
    const end = await r.run();
    expect(end.state).toBe('restock'); // the next step short asks again
    expect(r.stats.placed).toBe(14);
    const again = await r.run(); // nothing came: the same step stops as before
    expect(again).toEqual({ state: 'stopped', reason: 'out of stone' });
    expect(done).toHaveLength(14);
  });

  it('the scaffold tool broke: a round for a stone pickaxe before the next column, once; none asked while one digs the kind', async () => {
    const run = async (inv: Record<string, number>, fetch: boolean, harvests?: (block: string) => boolean) => {
      const p = planBuild(new FlatWorld(), spec(`pillar 0 ${F} 6 9 stone`), { start: START, maxColumn: 8 });
      const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 9, ...inv }), { x: 0.5, y: F, z: 0.5 });
      const asked: string[][] = [];
      const r = new BuildRunner(p, { ...bot.deps(), ...(harvests ? { harvests } : {}), ...(fetch ? { fetchMore: (items: readonly string[]) => (asked.push([...items]), true) } : {}) });
      return { r, bot, asked, end: await r.run() };
    };
    // cobblestone only and no pickaxe: the round is asked at the column's foot, with the tool in the need
    const a = await run({ cobblestone: 16 }, true);
    expect(a.end).toEqual({ state: 'restock', items: ['stone_pickaxe'] });
    expect(a.asked).toEqual([['stone_pickaxe']]);
    expect(a.r.remainingNeed().tool).toEqual({ item: 'stone_pickaxe', n: 1 });
    // the round brought one: it goes on and digs the column with it; no tool wanted any more
    a.bot.inv.add('stone_pickaxe', 1);
    expect(await a.r.run()).toEqual({ state: 'done' });
    expect(a.asked).toHaveLength(1);
    expect(a.r.remainingNeed().tool).toBeUndefined();
    // the round brought none: it goes on by hand (asked once)
    const b = await run({ cobblestone: 16 }, true);
    expect(await b.r.run()).toEqual({ state: 'done' });
    expect(b.asked).toHaveLength(1);
    // a pickaxe carried, or dirt (by hand), or no fetch: no round
    expect((await run({ cobblestone: 16, iron_pickaxe: 1 }, true)).asked).toEqual([]);
    // a pickaxe the wear rule keeps (a few uses left: the deps' harvests says no) counts as none
    expect((await run({ cobblestone: 16, iron_pickaxe: 1 }, true, (b) => b !== 'cobblestone')).asked).toEqual([['stone_pickaxe']]);
    // dirt first, but fewer than the column's blocks: the column goes on in cobblestone, so the round is asked
    expect((await run({ cobblestone: 16, dirt: 2 }, true)).asked).toEqual([['stone_pickaxe']]);
    // worn stone pickaxes carried: the bill would count them as had, so the need is that many more
    const worn = await run({ cobblestone: 16, stone_pickaxe: 2 }, true, (b) => b !== 'cobblestone');
    expect(worn.asked).toEqual([['stone_pickaxe']]);
    expect(worn.r.remainingNeed().tool).toEqual({ item: 'stone_pickaxe', n: 3 });
    expect((await run({ cobblestone: 16, dirt: 16 }, true)).asked).toEqual([]);
    expect((await run({ cobblestone: 16 }, false)).end).toEqual({ state: 'done' });
  });

  it("the job's round brings the scaffold tool first when it can be got, and not when it cannot", async () => {
    const need = async (can: boolean) => {
      const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 9, cobblestone: 16 }), { x: 0.5, y: F, z: 0.5 });
      const job = new BuildJob(spec(`pillar 0 ${F} 6 9 stone`), START, jobDeps(bot, { options: { scaffold: true, maxColumn: 8 }, canFetch: (items) => can || !items.includes('stone_pickaxe') }));
      const end = await job.run();
      return { end, need: job.roundNeed(30, () => 64) };
    };
    const yes = await need(true);
    expect(yes.end).toEqual({ state: 'restock', items: ['stone_pickaxe'] });
    expect(yes.need.materials).toMatchObject({ stone_pickaxe: 1 });
    const no = await need(false);
    expect(no.end).toEqual({ state: 'done' });
  });
});

describe('sections (Track B3)', () => {
  it('place builds: bands of whole layers bottom up, a large layer in parts, the last blocks at the end', () => {
    const box = placeSections(spec(`fill 0 ${F} 0 19 ${F + 2} 19 stone`), START, 500);
    expect(box.sections.map((s) => s.cells)).toEqual([400, 400, 400]);
    expect(box.sections.map((s) => s.spec.places[0]!.pos.y)).toEqual([F, F + 1, F + 2]);
    expect(box.cells).toBe(1200);
    expect(box.materials).toEqual({ stone: 1200 });
    const floor = placeSections(spec(`floor 0 ${F} 0 39 39 stone`), START, 500);
    expect(floor.sections.map((s) => s.cells)).toEqual([400, 400, 400, 400]); // four strips 10 wide, the farthest first
    expect(floor.sections.map((s) => s.spec.places[0]!.pos.x)).toEqual([30, 20, 10, 0])
    const two = placeSections(spec(`fill 0 ${F} 0 9 ${F + 9} 9 stone`), START, 500);
    expect(two.sections.map((s) => s.cells)).toEqual([500, 500]);
    // a door and a lever go last, in a section of their own
    const blocks = [
      ...Array.from({ length: 4 }, (_, i) => ({ pos: { x: i, y: F, z: 0 }, name: 'stone' })),
      { pos: { x: 0, y: F + 1, z: 0 }, name: 'oak_door', states: { 'minecraft:cardinal_direction': 'south', door_hinge_bit: false, open_bit: false, upper_block_bit: false } },
      { pos: { x: 0, y: F + 2, z: 0 }, name: 'oak_door', states: { 'minecraft:cardinal_direction': 'south', door_hinge_bit: false, open_bit: false, upper_block_bit: true } },
      { pos: { x: 2, y: F + 1, z: 0 }, name: 'lever', states: { lever_direction: 'up_north_south', open_bit: true } },
    ];
    const late = placeSections({ kind: 'file', label: 'hut', places: blocks }, START, 500);
    expect(late.refused).toEqual([]);
    expect(late.sections.map((s) => [s.cells, !!s.late])).toEqual([
      [4, false],
      [2, true],
    ]);
    expect(late.sections[1]!.spec.places).toHaveLength(3); // the door's upper half goes with it
  });

  it('builds of 51 200 and 51 076 cells: sections of at most 4096, every cell in one, a section planned alone', () => {
    const s = spec(`fill 0 ${F} 0 39 ${F + 31} 39 stone`);
    expect(s.places).toHaveLength(51_200);
    const cut = placeSections(s, START);
    expect(cut.cells).toBe(51_200);
    expect(cut.sections.every((x) => x.cells <= 4096 && x.cells > 0)).toBe(true);
    expect(cut.sections.reduce((a, x) => a + x.cells, 0)).toBe(51_200);
    expect(new Set(cut.sections.flatMap((x) => x.spec.places.map((p) => key(p.pos)))).size).toBe(51_200);
    // bottom up: no section below the one before it
    const lows = cut.sections.map((x) => Math.min(...x.spec.places.map((p) => p.pos.y)));
    expect(lows).toEqual([...lows].sort((a, b) => a - b));
    // a floor of 226 x 226 in 13 strips 18 wide, the farthest first; the job holds the sections, not a plan of the
    // whole, and the first strip's plan alone places all of it
    const floor = spec(`floor 0 ${F} 0 225 225 stone`);
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 64, dirt: 16 }), { x: -2.5, y: F, z: -2.5 });
    const job = new BuildJob(floor, { x: -3, y: F, z: -3 }, jobDeps(bot));
    expect(job.total).toBe(51_076);
    expect(job.sections).toHaveLength(13);
    expect(job.sections.every((x) => x.cells <= 4096)).toBe(true);
    expect(job.plan.steps).toHaveLength(0);
    const first = job.sections[0]!;
    const plan = planBuild(bot.world, first.spec, { start: { x: -3, y: F, z: -3 }, area: first.area, scaffold: true, maxColumn: 6, safeEdge: 3 });
    expect(plan.skipped).toEqual([]);
    expect(plan.work).toBe(first.cells);
  });

  it('clear and replace: slabs of whole layers from the top', () => {
    const c = boxSections(spec(`clear 0 ${F} 0 19 ${F + 9} 19`), 1000);
    expect(c.sections).toHaveLength(5);
    expect(c.sections[0]!.spec.box).toEqual({ min: { x: 0, y: F + 8, z: 0 }, max: { x: 19, y: F + 9, z: 19 } });
    expect(c.sections[4]!.spec.box!.min.y).toBe(F);
    const wide = boxSections(spec(`clear 0 ${F} 0 39 ${F} 39`), 500);
    expect(wide.sections.every((s) => s.cells <= 500)).toBe(true);
    expect(wide.sections.reduce((a, s) => a + s.cells, 0)).toBe(1600);
  });
});

function jobDeps(bot: FakeBot, extra: Partial<JobDeps> = {}): JobDeps {
  return {
    world: bot.world,
    position: () => bot.feet,
    plan: (s: BuildSpec, o: PlanOptions) => Promise.resolve(planBuild(bot.world, s, o)),
    runner: (plan, hooks) => new BuildRunner(plan, { ...bot.deps(), ...hooks }),
    options: { scaffold: true, maxColumn: 6, safeEdge: 3 },
    have: (it) => bot.inv.count(it),
    log: undefined,
    ...extra,
  };
}

describe('the job (Track B3)', () => {
  it('a build in sections, each planned when the one before is done, every cell placed and marked', async () => {
    // the walls of a 12 x 12 room, 6 high: 264 blocks in sections of at most 100
    const ring = (x: number, z: number) => x === 2 || x === 13 || z === 2 || z === 13;
    const places = [];
    for (let y = F; y < F + 6; y++) for (let x = 2; x <= 13; x++) for (let z = 2; z <= 13; z++) if (ring(x, z)) places.push({ pos: { x, y, z }, name: 'stone' });
    const s: BuildSpec = { kind: 'file', label: 'room', places };
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 264, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const progress = new BuildProgress(undefined, { args: [], feet: START, label: s.label, kind: s.kind, box: { min: { x: 2, y: F, z: 2 }, max: { x: 13, y: F + 5, z: 13 } }, total: 264, fetch: false });
    const job = new BuildJob(s, START, jobDeps(bot, { progress }), { max: 100 });
    expect(job.sections.map((x) => x.cells)).toEqual([88, 88, 88]);
    expect(job.total).toBe(264);
    expect(await job.run()).toEqual({ state: 'done' });
    expect(job.stats.placed).toBe(264);
    expect(job.stats.skipped).toEqual([]);
    expect(progress.count).toBe(264);
    for (const p of places) expect(bot.world.name(p.pos)).toBe('stone');
    expect(job.detail()).toBe('section 3 of 3');
  });

  it('Track B7: a resumed job leaves what was placed before out of its bill', () => {
    const places = [];
    for (let x = 0; x < 10; x++) places.push({ pos: { x, y: F, z: 5 }, name: x < 5 ? 'stone' : 'oak_planks' });
    const s: BuildSpec = { kind: 'file', label: 'row', places };
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({}), { x: 0.5, y: F, z: 0.5 });
    const progress = new BuildProgress(undefined, { args: [], feet: START, label: s.label, kind: s.kind, box: { min: { x: 0, y: F, z: 5 }, max: { x: 9, y: F, z: 5 } }, total: 10, fetch: true });
    for (let x = 0; x < 6; x++) progress.mark({ x, y: F, z: 5 });
    const job = new BuildJob(s, START, jobDeps(bot, { progress }), { max: 100 });
    expect(job.plan.materials).toEqual({ oak_planks: 4 });
  });

  it('rounds: ends restock when out (or short at a section start), goes on at the same step after more come', async () => {
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const s = spec(`fill 2 ${F} 2 9 ${F + 1} 9 stone`);
    const job = new BuildJob(s, START, jobDeps(bot, { canFetch: () => true }), { max: 64 });
    let end: RunnerEnd = await job.run();
    const asks: string[][] = [];
    while (end.state === 'restock') {
      asks.push(end.items);
      const need = job.roundNeed(1, () => 64).materials.stone ?? 0;
      expect(need).toBeGreaterThan(0);
      expect(need).toBeLessThanOrEqual(64);
      bot.inv.add('stone', Math.min(need, 50)); // a round brings less than a stack
      job.roundDone();
      end = await job.run();
      if (asks.length > 10) break;
    }
    expect(end).toEqual({ state: 'done' });
    expect(asks.length).toBeGreaterThanOrEqual(3);
    expect(job.rounds).toBe(asks.length);
    expect(job.stats.placed).toBe(128);
  });

  it('a cell a section skipped as it ran gets one more try (Track B9: right after the section, before the next)', async () => {
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 64, dirt: 16 }), { x: 0.5, y: F, z: 0.5 }, { unreachable: new Set() });
    const s = spec(`floor 2 ${F} 2 9 9 stone`);
    let fails = 0;
    const deps = jobDeps(bot, {
      runner: (plan, hooks) => {
        const d = { ...bot.deps(), ...hooks };
        // the first section's first two walks fail three times each: skipped there
        const goto0 = d.goto.bind(d);
        d.goto = (g, o) => (fails++ < 6 ? Promise.resolve({ ok: false as const, reason: 'unreachable' }) : goto0(g, o));
        return new BuildRunner(plan, d);
      },
    });
    const job = new BuildJob(s, START, deps, { max: 32 });
    expect(await job.run()).toEqual({ state: 'done' });
    const again = job.sections.findIndex((x) => x.again);
    expect(again).toBe(1); // the first section's skips, before the second section
    expect(job.sections.some((x) => x.sweep)).toBe(false);
    expect(job.stats.skipped).toEqual([]);
    for (let x = 2; x <= 9; x++) for (let z = 2; z <= 9; z++) expect(bot.world.name({ x, y: F, z })).toBe('stone');
  });

  it('resume: the done cells checked against the world: air placed again, another block left and reported', async () => {
    const bot = new FakeBot(new FlatWorld(), new FakeInventory({ stone: 100, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const s = spec(`floor 2 ${F} 2 6 6 stone`);
    const progress = new BuildProgress(undefined, { args: [], feet: START, label: s.label, kind: s.kind, box: { min: { x: 2, y: F, z: 2 }, max: { x: 6, y: F, z: 6 } }, total: 25, fetch: false });
    // the first row was done, then a block was taken away and one changed
    for (let x = 2; x <= 6; x++) {
      bot.world.set({ x, y: F, z: 2 }, 'stone');
      progress.mark({ x, y: F, z: 2 });
    }
    bot.world.set({ x: 3, y: F, z: 2 }, 'air');
    bot.world.set({ x: 5, y: F, z: 2 }, 'oak_planks');
    const { survey, left } = BuildJob.survey(s, bot.world, progress);
    expect(survey).toMatchObject({ done: 3, air: 1, other: 1 });
    expect(left).toEqual([{ x: 5, y: F, z: 2 }]);
    expect(progress.has({ x: 3, y: F, z: 2 })).toBe(false);
    const job = new BuildJob(s, START, jobDeps(bot, { progress }), { survey, left });
    expect(job.total).toBe(3 + 21);
    expect(await job.run()).toEqual({ state: 'done' });
    expect(bot.world.name({ x: 3, y: F, z: 2 })).toBe('stone');
    expect(bot.world.name({ x: 5, y: F, z: 2 })).toBe('oak_planks');
    expect(job.stats.placed).toBe(24);
    // a clear: a dug cell with a block in it again is left (not dug)
    const w = new FlatWorld();
    const c = spec(`clear 2 ${F} 2 3 ${F} 3`);
    const pc = new BuildProgress(undefined, { args: [], feet: START, label: c.label, kind: c.kind, box: c.box!, total: 4, fetch: false });
    pc.mark({ x: 2, y: F, z: 2 });
    w.set({ x: 2, y: F, z: 2 }, 'dirt');
    w.set({ x: 3, y: F, z: 3 }, 'stone');
    const sc = BuildJob.survey(c, w, pc);
    expect(sc.survey).toMatchObject({ done: 0, other: 1 });
    const cbot = new FakeBot(w, new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const cj = new BuildJob(c, START, jobDeps(cbot, { progress: pc }), { survey: sc.survey, left: sc.left });
    expect(await cj.run()).toEqual({ state: 'done' });
    expect(w.name({ x: 2, y: F, z: 2 })).toBe('dirt');
    expect(w.name({ x: 3, y: F, z: 3 })).toBe('air');
  });
});

describe('scaffold left by a restart (Track B3)', () => {
  it('a resume digs the columns the run before left: the one under the feet first, then the others; then builds', async () => {
    const w = new FlatWorld();
    const s = spec(`wall 0 ${F} 8 4 8 2 stone`);
    const progress = new BuildProgress(undefined, { args: [], feet: START, label: s.label, kind: s.kind, box: { min: { x: 0, y: F, z: 8 }, max: { x: 4, y: F + 1, z: 8 } }, total: 10, fetch: false });
    // the run before: a 4-high dirt column the bot stood on when it went away, a 2-high one beside the wall, a block someone dug since
    for (let y = F; y < F + 4; y++) {
      w.set({ x: 0, y, z: 0 }, 'dirt');
      progress.scaffold({ x: 0, y, z: 0 }, true);
    }
    for (let y = F; y < F + 2; y++) {
      w.set({ x: 6, y, z: 6 }, 'cobblestone');
      progress.scaffold({ x: 6, y, z: 6 }, true);
    }
    progress.scaffold({ x: 9, y: F, z: 9 }, true);
    const sv = BuildJob.survey(s, w, progress);
    expect(sv.survey.leftovers).toBe(6);
    expect(progress.scaffoldCells()).toHaveLength(6); // the dug one forgotten
    const bot = new FakeBot(w, new FakeInventory({ stone: 10, dirt: 16 }), { x: 0.5, y: F + 4, z: 0.5 });
    const job = new BuildJob(s, START, jobDeps(bot, { progress }), { survey: sv.survey, left: sv.left, leftovers: sv.leftovers });
    expect(job.total).toBe(10);
    expect(await job.run()).toEqual({ state: 'done' });
    for (let y = F; y < F + 4; y++) expect(w.name({ x: 0, y, z: 0 })).toBe('air');
    for (let y = F; y < F + 2; y++) expect(w.name({ x: 6, y, z: 6 })).toBe('air');
    expect(bot.log.slice(0, 4)).toEqual([`dig 0,${F + 3},0 dirt`, `dig 0,${F + 2},0 dirt`, `dig 0,${F + 1},0 dirt`, `dig 0,${F},0 dirt`]);
    expect(progress.scaffoldCells()).toEqual([]);
    expect(job.stats.placed).toBe(10);
    expect(job.stats.dug).toBe(0); // the scaffold dug is not the build's work
    for (let x = 0; x <= 4; x++) expect(w.name({ x, y: F + 1, z: 8 })).toBe('stone');
  });
});

describe('the progress file (Track B3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-progress-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('marks, saves atomically, loads back; where the file is', () => {
    const file = join(dir, 'p.json');
    let now = 0;
    const p = new BuildProgress(file, { args: ['fill', '0', '0', '0', '3', '3', '3', 'stone'], feet: START, label: 'fill 4x4x4 stone', kind: 'fill', box: { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 3, z: 3 } }, total: 64, fetch: true, owner: { type: 'chat', source: 'Owner', xuid: '' } }, { now: () => now });
    p.mark({ x: 1, y: 2, z: 3 });
    p.mark({ x: 1, y: 2, z: 3 });
    p.mark({ x: 9, y: 9, z: 9 }); // outside the box: nothing
    expect(p.count).toBe(1);
    expect(loadProgress(file)?.count).toBe(1); // the first mark saves (nothing saved for SAVE_MS before)
    now += 1000;
    p.mark({ x: 0, y: 0, z: 0 });
    expect(loadProgress(file)?.count).toBe(1); // within SAVE_MS: not yet
    p.scaffold({ x: 5, y: 6, z: 7 }, true);
    p.scaffold({ x: 5, y: 7, z: 7 }, true);
    p.scaffold({ x: 5, y: 7, z: 7 }, false);
    p.setState('stopped');
    const d = loadProgress(file)!;
    expect(d.scaffolds).toEqual(['5,6,7']);
    expect(new BuildProgress(file, d).scaffoldCells()).toEqual([{ x: 5, y: 6, z: 7 }]);
    expect(d).toMatchObject({ v: 1, count: 2, state: 'stopped', fetch: true, label: 'fill 4x4x4 stone' });
    const back = new BuildProgress(file, d);
    expect(back.has({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(back.has({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(back.has({ x: 2, y: 2, z: 2 })).toBe(false);
    expect([...back.cells()]).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 2, z: 3 },
    ]);
    expect(buildProgressFile({ buildProgress: file })).toBe(file);
    const inDir = buildProgressFile({ 'no-config': true }, { BEDROCKBOT_BUILD_DIR: dir })!;
    expect(dirname(inDir)).toBe(dir);
    expect(inDir).toMatch(/\.json$/);
    expect(buildProgressFile({ 'no-config': true }, {})).toBeUndefined();
    expect(buildProgressFile(undefined)).toBeUndefined();
  });
});

describe('the planner worker (Track B3)', () => {
  it('a snapshot reads back the same blocks; the worker plans what planBuild plans', async () => {
    const w = new FlatWorld();
    w.set({ x: 3, y: F, z: 3 }, 'stone');
    w.set({ x: 4, y: F + 1, z: 3 }, 'oak_planks');
    const s = spec(`fill 2 ${F} 2 5 ${F + 3} 5 stone`);
    const area = { min: { x: -6, y: F - 4, z: -6 }, max: { x: 11, y: F + 7, z: 11 } };
    const snap = snapshotWorld(w, snapshotBox(area));
    const r = readerOf(snap);
    for (const c of [{ x: 3, y: F, z: 3 }, { x: 4, y: F + 1, z: 3 }, { x: 0, y: FLOOR_Y, z: 0 }, { x: 0, y: F + 2, z: 0 }]) expect(r.blockAt(c)?.name).toBe(w.blockAt(c)?.name);
    expect(r.blockAt({ x: 100, y: F, z: 0 })).toBeUndefined();
    expect(snap.palette.length).toBeLessThan(8);
    const o: PlanOptions = { start: START, area, safeEdge: 3, maxColumn: 6 };
    const here = planBuild(w, s, o);
    const ch = new MessageChannel();
    runBuildPlanWorker(ch.port2);
    const fake = Object.assign(new EventEmitter(), {
      postMessage: (m: unknown, t?: readonly ArrayBuffer[]) => ch.port1.postMessage(m, t as ArrayBuffer[]),
      terminate: () => {
        ch.port1.close();
        ch.port2.close();
        return Promise.resolve(0);
      },
      unref: () => undefined,
    });
    ch.port1.on('message', (m) => fake.emit('message', m));
    const client = new BuildPlannerClient({ spawn: () => fake as unknown as Worker });
    const there = await client.plan(s, o, snapshotWorld(w, snapshotBox(area)));
    expect(there.steps).toEqual(here.steps);
    expect(there.work).toBe(here.work);
    await client.stop();
    await expect(client.plan(s, o, snapshotWorld(w, snapshotBox(area)))).rejects.toThrow(/stopped/);
  });
});
