// Track AL (docs/build.md): the build planner (order, stands, scaffolds), materials and the runner on
// a flat fake world.
import { describe, expect, it } from 'vitest';
import { materialsLine, materialsOf, usable } from '../../../src/skills/build/materials.ts';
import { bottomUp, planBuild, planLine, PlanError, topDown, type Plan } from '../../../src/skills/build/plan.ts';
import { BuildRunner, etaText, progressLine } from '../../../src/skills/build/runner.ts';
import { canStand, reachableStands, areaAround } from '../../../src/skills/build/sim.ts';
import { parseSpec } from '../../../src/skills/build/spec.ts';
import { readLayers } from '../../../src/skills/build/formats/layers.ts';
import { placeStructure } from '../../../src/skills/build/formats/index.ts';
import { key, type BuildSpec, type Cell } from '../../../src/skills/build/types.ts';
import { FakeBot, FakeInventory, FlatWorld } from './build-fakes.ts';

const F = -60;
const START: Cell = { x: 0, y: F, z: 0 };

function spec(args: string, feet: Cell = START): BuildSpec {
  const r = parseSpec(args.split(' '), { feet });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

/** The plan's place targets in order. */
const places = (p: Plan) => p.steps.filter((s) => s.op === 'place').map((s) => (s.op === 'place' ? s.pos : START));

export const OVERHANG = JSON.stringify({ name: 'overhang', layers: [['#..'], ['#..'], ['#.#']], legend: { '#': 'cobblestone' } });

describe('build order', () => {
  it('bottom layer first, farthest from the bot first inside a layer', () => {
    const blocks = [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => ({ pos: { x, y, z: 0 }, name: 'stone' })));
    const o = bottomUp(blocks, { x: 0, y: 0, z: 0 });
    expect(o.map((b) => `${b.pos.x},${b.pos.y}`)).toEqual(['2,0', '1,0', '0,0', '2,1', '1,1', '0,1', '2,2', '1,2', '0,2']);
  });

  it('clear: top layer first, nearest first', () => {
    const c = topDown({ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 0 } }, { x: 0, y: 0, z: 0 });
    expect(c.map((p) => `${p.x},${p.y}`)).toEqual(['0,1', '1,1', '2,1', '0,0', '1,0', '2,0']);
  });
});

describe('planner', () => {
  it('fill 5x3x5 from outside: 75 places, no scaffold, never standing in a cell filled later', () => {
    const w = new FlatWorld();
    const s = spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`);
    const p = planBuild(w, s, { start: START });
    expect(p.work).toBe(75);
    expect(p.scaffolds).toBe(0);
    expect(p.skipped).toEqual([]);
    expect(p.materials).toEqual({ cobblestone: 75 });
    const filled = new Set<string>();
    for (const st of p.steps) {
      if (st.op !== 'place') continue;
      const f = st.stand!;
      // the stand is never a cell of the box that is still to be filled (or its head cell)
      const box = (c: Cell) => c.x >= 2 && c.x <= 6 && c.z >= 2 && c.z <= 6 && c.y >= F && c.y <= F + 2;
      for (const c of [f, { ...f, y: f.y + 1 }]) if (box(c)) expect(filled.has(key(c))).toBe(true);
      filled.add(key(st.pos));
    }
    // layers bottom up
    const ys = places(p).map((c) => c.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(planLine(p)).toBe('fill 5x3x5 cobblestone: 75 to place');
  });

  it('skips cells already holding the block and leaves other blocks', () => {
    const w = new FlatWorld();
    w.set({ x: 2, y: F, z: 2 }, 'cobblestone');
    w.set({ x: 3, y: F, z: 2 }, 'oak_planks');
    const p = planBuild(w, spec(`fill 2 ${F} 2 4 ${F} 2 cobblestone`), { start: START });
    expect([p.work, p.already, p.occupied]).toEqual([1, 1, 1]);
  });

  it('a 7-high pillar: 6 from the ground, the 7th from a one-block scaffold column, then down again', () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`pillar 3 ${F} 0 7 cobblestone`), { start: START });
    expect(p.work).toBe(7);
    expect(p.scaffolds).toBe(1);
    const ops = p.steps.map((s) => s.op);
    expect(ops.filter((o) => o === 'place')).toHaveLength(7);
    const i = ops.indexOf('pillar');
    expect(ops.slice(i)).toEqual(['pillar', 'place', 'descend']);
    const col = p.steps[i]!;
    expect(col.op === 'pillar' && col.height).toBe(1);
  });

  it('the overhang structure needs exactly one support scaffold, removed at the end of its layer', () => {
    const w = new FlatWorld();
    const s = readLayers(OVERHANG);
    const blocks = placeStructure(s, { x: 3, y: F, z: 0 });
    const p = planBuild(w, { kind: 'file', label: 'file overhang', places: blocks }, { start: START });
    expect(p.work).toBe(4);
    expect(p.scaffolds).toBe(1);
    const ops = p.steps.map((s) => `${s.op}${'pos' in s ? ` ${key(s.pos)}` : ''}`);
    expect(ops).toEqual([`place 3,${F},0`, `place 3,${F + 1},0`, `place 3,${F + 2},0`, `scaffold 4,${F + 2},0`, `place 5,${F + 2},0`, `unscaffold 4,${F + 2},0`]);
  });

  it('buildScaffold off skips what needs one', () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`pillar 3 ${F} 0 7 cobblestone`), { start: START, scaffold: false });
    expect(p.work).toBe(6);
    expect(p.skipped).toEqual([{ pos: { x: 3, y: F + 6, z: 0 }, reason: 'out of reach (buildScaffold off)' }]);
  });

  it('a 10x10 floor reaches the middle by standing on what is placed already', () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`floor 10 ${F} 10 19 19 stone`), { start: START });
    expect(p.work).toBe(100);
    expect(p.skipped).toEqual([]);
    expect(p.scaffolds).toBe(0);
  });

  it('clear and replace are dig lists in top-down order', () => {
    const w = new FlatWorld();
    for (let y = F; y <= F + 2; y++) for (let x = 2; x <= 4; x++) w.set({ x, y, z: 2 }, y === F + 1 ? 'dirt' : 'cobblestone');
    const c = planBuild(w, spec(`clear 2 ${F} 2 4 ${F + 2} 2`), { start: START });
    expect(c.work).toBe(9);
    const ys = c.steps.map((s) => (s.op === 'dig' ? s.pos.y : 0));
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);
    const r = planBuild(w, spec(`replace 2 ${F} 2 4 ${F + 2} 2 dirt stone`), { start: START });
    expect(r.work).toBe(3);
    expect(r.materials).toEqual({ stone: 3 });
    expect(r.steps.every((s) => s.op === 'replace' && s.pos.y === F + 1)).toBe(true);
  });

  it('refuses liquids, redstone and too big builds', () => {
    expect(parseSpec(`fill 0 0 0 1 1 1 water`.split(' ')).ok).toBe(false);
    expect(parseSpec(`pillar 0 0 0 3 redstone_block`.split(' ')).ok).toBe(false);
    const big = parseSpec(`fill 0 0 0 99 9 9 stone`.split(' '));
    expect(big.ok).toBe(false);
    expect(() => planBuild(new FlatWorld(), { kind: 'fill', label: 'x', places: [{ pos: START, name: 'lava' }] }, { start: START })).toThrow(PlanError);
  });

  it('reachability: steps of one block both ways, from the edge of the work area', () => {
    const w = new FlatWorld();
    // a 3-high wall ring around (10, F, 10): its inside is not reachable
    for (let x = 8; x <= 12; x++) for (let z = 8; z <= 12; z++) if (x === 8 || x === 12 || z === 8 || z === 12) for (let y = F; y <= F + 2; y++) w.set({ x, y, z }, 'stone');
    const set = reachableStands(w, areaAround([{ x: 10, y: F, z: 10 }], 6, 3), undefined);
    expect(set.has(key({ x: 10, y: F, z: 10 }))).toBe(false);
    expect(set.has(key({ x: 5, y: F, z: 5 }))).toBe(true);
    expect(canStand(w, { x: 10, y: F, z: 10 })).toBe(true);
  });
});

describe('materials', () => {
  it('a 10x4 wall with an empty inventory needs 40 cobblestone', () => {
    const p = planBuild(new FlatWorld(), spec(`wall 0 ${F} 5 9 5 4 cobblestone`), { start: START });
    const m = materialsOf(p, new FakeInventory(), { throwawayMin: 16 });
    expect(m.lines).toEqual([{ item: 'cobblestone', need: 40, have: 0, missing: 40 }]);
    expect(materialsLine(p.spec.label, m)).toBe('materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)');
  });

  it('the throwaway reserve is never built with; other throwaway kinds can hold it', () => {
    expect(usable(new FakeInventory({ cobblestone: 91 }), 'cobblestone', { throwawayMin: 16 })).toBe(75);
    expect(usable(new FakeInventory({ cobblestone: 75, dirt: 16 }), 'cobblestone', { throwawayMin: 16 })).toBe(75);
    expect(usable(new FakeInventory({ cobblestone: 75, dirt: 10 }), 'cobblestone', { throwawayMin: 16 })).toBe(69);
    expect(usable(new FakeInventory({ stone_bricks: 5 }), 'stone_bricks', { throwawayMin: 16 })).toBe(5);
    const p = planBuild(new FlatWorld(), spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`), { start: START });
    const m = materialsOf(p, new FakeInventory({ cobblestone: 75, dirt: 16 }), { throwawayMin: 16 });
    expect(m.ok).toBe(true);
    expect(materialsLine(p.spec.label, m)).toBe('materials for fill 5x3x5 cobblestone: 75 cobblestone; have everything');
  });

  it('scaffold blocks may come from the reserve (they are picked up again)', () => {
    const p = planBuild(new FlatWorld(), spec(`pillar 3 ${F} 0 7 stone`), { start: START });
    const m = materialsOf(p, new FakeInventory({ stone: 7, dirt: 16 }), { throwawayMin: 16 });
    expect(m.ok).toBe(true);
    const short = materialsOf(p, new FakeInventory({ stone: 7 }), { throwawayMin: 16 });
    expect(short.ok).toBe(false);
    expect(materialsLine(p.spec.label, short, p.scaffolds)).toContain('need 1 more throwaway blocks for scaffolding');
  });
});

async function runAll(w: FlatWorld, bot: FakeBot, p: Plan): Promise<BuildRunner> {
  const r = new BuildRunner(p, bot.deps());
  const end = await r.run();
  expect(end).toEqual({ state: 'done' });
  return r;
}

describe('runner (fake bot)', () => {
  it('builds the 5x3x5 box exactly from 75 cobblestone + 16 dirt, the reserve untouched', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 75, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const r = await runAll(w, bot, p);
    expect(r.stats.placed).toBe(75);
    for (let y = F; y <= F + 2; y++) for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) expect(w.name({ x, y, z })).toBe('cobblestone');
    expect(bot.inv.count('cobblestone')).toBe(0);
    expect(bot.inv.count('dirt')).toBe(16);
    expect(progressLine(r)).toBe('75 / 75 placed, 0 skipped');
  });

  it('stops when only the reserve is left', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 75 }), { x: 0.5, y: F, z: 0.5 });
    const r = new BuildRunner(p, bot.deps());
    const end = await r.run();
    expect(end).toEqual({ state: 'stopped', reason: 'out of cobblestone (16 kept as the throwaway reserve)' });
    expect(r.stats.placed).toBe(59);
  });

  it('the pillar: pillars up once, places the top, digs the scaffold and stands on the ground again', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`pillar 3 ${F} 0 7 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 7, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const r = await runAll(w, bot, p);
    for (let y = F; y < F + 7; y++) expect(w.name({ x: 3, y, z: 0 })).toBe('cobblestone');
    expect(bot.pillarJumps).toBe(1);
    expect(bot.maxFeetY).toBe(F + 1);
    expect(bot.feet.y).toBe(F);
    expect(r.stats).toMatchObject({ placed: 7, scaffoldsPlaced: 1, scaffoldsRemoved: 1 });
    expect(bot.inv.count('dirt')).toBe(16); // the scaffold came back
  });

  it('scaffolds use a kind the build does not need, and out of blocks on a column the bot climbs down first', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`pillar 3 ${F} 0 7 cobblestone`), { start: START });
    // 6 cobblestone for 7 cells: the 7th (from the column) fails
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 6, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    bot.throwawayMin = 0;
    const r = new BuildRunner(p, bot.deps());
    expect(await r.run()).toEqual({ state: 'stopped', reason: 'out of cobblestone' });
    expect(bot.log.filter((l) => l.includes('(pillar)'))).toEqual([`place 2,${F},0 dirt (pillar)`]);
    expect(r.stats).toMatchObject({ placed: 6, scaffoldsPlaced: 1, scaffoldsRemoved: 1 });
    expect(bot.feet.y).toBe(F);
  });

  it('the overhang: one support scaffold placed and dug again', async () => {
    const w = new FlatWorld();
    const blocks = placeStructure(readLayers(OVERHANG), { x: 3, y: F, z: 0 });
    const p = planBuild(w, { kind: 'file', label: 'file overhang', places: blocks }, { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 4, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const r = await runAll(w, bot, p);
    expect(w.name({ x: 5, y: F + 2, z: 0 })).toBe('cobblestone');
    expect(w.name({ x: 4, y: F + 2, z: 0 })).toBe('air');
    expect(r.stats).toMatchObject({ placed: 4, scaffoldsPlaced: 1, scaffoldsRemoved: 1 });
  });

  it('retries a rejected placement twice, then skips and reports', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`floor 2 ${F} 0 3 0 stone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ stone: 5 }), { x: 0.5, y: F, z: 0.5 }, { rejectFirst: 3 });
    const r = await runAll(w, bot, p);
    expect(r.stats.placed).toBe(1);
    expect(r.stats.skipped).toHaveLength(1);
    expect(r.stats.skipped[0]!.reason).toBe('place: place: rejected');
    expect(r.stats.retries).toBe(2);
  });

  it('pause stops at the running step and run() continues there', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`floor 2 ${F} 0 6 0 stone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ stone: 5 }), { x: 0.5, y: F, z: 0.5 });
    const r = new BuildRunner(p, bot.deps());
    let n = 0;
    bot.onStep = () => {
      if (++n === 4) r.pause();
    };
    expect(await r.run()).toEqual({ state: 'paused' });
    expect(bot.cancelled).toBe(1);
    const placed = r.stats.placed;
    expect(placed).toBeLessThan(5);
    bot.onStep = undefined;
    expect(await r.run()).toEqual({ state: 'done' });
    expect(r.stats.placed).toBe(5);
    expect(r.stats.processed).toBe(5);
  });

  it('clear digs the box empty', async () => {
    const w = new FlatWorld();
    for (let y = F; y <= F + 2; y++) for (let x = 2; x <= 4; x++) for (let z = 2; z <= 4; z++) w.set({ x, y, z }, 'cobblestone');
    const p = planBuild(w, spec(`clear 2 ${F} 2 4 ${F + 2} 4`), { start: START });
    const bot = new FakeBot(w, new FakeInventory(), { x: 0.5, y: F, z: 0.5 });
    const r = await runAll(w, bot, p);
    expect(r.stats.dug).toBe(27);
    for (let y = F; y <= F + 2; y++) for (let x = 2; x <= 4; x++) for (let z = 2; z <= 4; z++) expect(w.name({ x, y, z })).toBe('air');
    expect(bot.inv.count('cobblestone')).toBe(27);
  });

  it('eta text', () => {
    expect(etaText(40)).toBe('40 s');
    expect(etaText(240)).toBe('4 min');
    expect(etaText(undefined)).toBeUndefined();
  });
});
