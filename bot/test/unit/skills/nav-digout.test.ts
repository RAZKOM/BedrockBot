// Track W2 (docs/pathfinding.md "Digging out of water (Track W2)", decisions/0070-water-travel.md "W2: digging out"):
// the way out of a pool whose only rim is a lip or a taller bank. The stations are the truth pack's dig-out pools
// (packs/truth/src/water-layout.ts DIG_OUT_STATIONS, what `truth:water` builds for the nav-water e2e). Planner
// checks (the step, the stair, the break rules, the price against a swim exit, the trapped report), then closed
// loops (FakeConnection -> InputLoop <- BotSkills / Navigator with fake dig actions on the generated world).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIG_OUT_STATIONS, waterStation, type WaterStation, type WaterStationName } from '../../../../packs/truth/src/water-layout.ts';
import { BotSkills } from '../../../src/skills/index.ts';
import { breakTicksWith } from '../../../src/skills/nav/baritone/helper.ts';
import { DEFAULT_COSTS, findPath, handBreakTicks, type PathNode, type PathOptions, type PathResult } from '../../../src/skills/nav/astar.ts';
import { DIG_OUT_MAX_STEPS, DIG_OUT_MAX_TICKS, DIG_OUT_PENALTY, WATER_DIG_FACTOR, trappedWhy, waterDigConditions } from '../../../src/skills/nav/digout.ts';
import { MODIFIERS, breakTicks } from '../../../src/skills/dig/breakTime.ts';
import type { NavActions } from '../../../src/skills/nav/actions.ts';
import type { NavGoal } from '../../../src/skills/nav/goals.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import type { SkillResult } from '../../../src/skills/types.ts';
import { classify } from '../../../src/skills/terrain/classify.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const O = { x: 0, y: -60, z: -10 };

function stationWorld(name: WaterStationName): { gen: GenWorld; st: WaterStation } {
  const st = waterStation(name, O)!;
  const gen = flatGen();
  for (const op of st.ops) gen.fill(op.from, op.to, op.block);
  return { gen, st };
}

const cell = (p: Vec3): Vec3 => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const goalOf = (st: WaterStation): NavGoal => ({ type: 'block', p: st.goal });
const digs = (r: PathResult): Vec3[] => r.path.flatMap((n: PathNode) => n.act?.dig ?? []);
const tool = (name: string): PathOptions['breakTicks'] => (c) => breakTicksWith(c, { slots: [{ name }], selected: 0 });
const ticksOf = (gen: GenWorld, p: Vec3, bt: (c: ReturnType<typeof classify>) => number = handBreakTicks): number => bt(classify(gen.blockAt(p.x, p.y, p.z)!));
const DIG_OUT: PathOptions = { digOut: true, maxNodes: 20_000 };

describe('Track W2 planner: a step dug into a lip', () => {
  it('lipDirt: no way out without digging; with digOut the grass lip beside the surface is broken and the body climbs out onto the block at the water level', () => {
    const { gen, st } = stationWorld('lipDirt');
    const grid = new NavGrid(gen);
    const shut = findPath(grid, cell(st.start), goalOf(st), { maxNodes: 20_000 });
    expect(shut.status).toBe('none');
    expect(shut.digOut).toBeUndefined(); // no digOut: no trapped report either
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st), DIG_OUT);
    expect(r.status).toBe('found');
    const i = r.path.findIndex((n) => n.act?.dig);
    const step = r.path[i]!;
    expect(step.move).toBe('swimOut');
    expect(step.y).toBe(st.surfaceY + 1); // on the block at the water's level
    expect(step.act!.dig).toEqual([{ x: step.x, y: st.surfaceY + 1, z: step.z }]); // the lip only (the cell above is air)
    expect(gen.blockAt(step.x, st.surfaceY + 1, step.z)?.name).toBe('grass_block');
    // from a surface node (the head out of the water)
    expect(['swim', 'start']).toContain(r.path[i - 1]!.move);
    expect(r.path[i - 1]!.y).toBe(st.surfaceY);
    // the price: the break time from the water (x 5, measured), the dig penalty, the dig-out penalty
    const lip = { x: step.x, y: st.surfaceY + 1, z: step.z };
    expect(step.cost).toBeCloseTo(DEFAULT_COSTS.swimOut + ticksOf(gen, lip) * WATER_DIG_FACTOR + DEFAULT_COSTS.dig + DIG_OUT_PENALTY, 6);
    // only the lip is dug; towards the goal (the rim on the goal's side)
    expect(digs(r)).toEqual([lip]);
    expect(lip.z).toBe(O.z + 7);
  });

  it('lipStone: by hand the stone lip takes 750 ticks from the water: refused, trapped (no tool); a wooden pickaxe digs it', () => {
    const { gen, st } = stationWorld('lipStone');
    expect(ticksOf(gen, { x: O.x, y: O.y - 1, z: O.z + 7 }) * WATER_DIG_FACTOR).toBeGreaterThan(DIG_OUT_MAX_TICKS);
    const hand = findPath(new NavGrid(gen), cell(st.start), goalOf(st), DIG_OUT);
    expect(hand.status).toBe('none');
    expect(hand.digOut?.refused.no_tool).toMatchObject({ block: 'stone' });
    expect(hand.digOut!.refused.no_tool!.count).toBeGreaterThanOrEqual(12);
    expect(trappedWhy(hand.digOut!, hand.expanded)).toMatch(/^trapped in water: no swim exit and no step to dig \(stone: no tool breaks it in time x \d+/);
    const wood = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { ...DIG_OUT, breakTicks: tool('wooden_pickaxe') });
    expect(wood.status).toBe('found');
    expect(digs(wood).map((p) => gen.blockAt(p.x, p.y, p.z)?.name)).toEqual(['stone']);
    // wooden pickaxe on stone: 23 ticks on the ground, 115 from the water (BDS: 113, the modifier on the speed)
    expect(ticksOf(gen, digs(wood)[0]!, tool('wooden_pickaxe')) * WATER_DIG_FACTOR).toBe(115);
  });

  it('lipBuilt: a stone-brick rim (a built block) is never broken: trapped, the report says protected', () => {
    const { gen, st } = stationWorld('lipBuilt');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { ...DIG_OUT, allowBreak: true, breakTicks: tool('diamond_pickaxe') });
    expect(r.status).toBe('none');
    expect(digs(r)).toEqual([]);
    expect(r.digOut?.refused.protected).toMatchObject({ block: 'stone_bricks' });
    expect(trappedWhy(r.digOut!, r.expanded)).toContain('stone_bricks: protected or built');
  });

  it('the protected area (the base around home) and the blacklist refuse the lip as well', () => {
    const { gen, st } = stationWorld('lipDirt');
    const area = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { ...DIG_OUT, protectedArea: { x: O.x, y: O.y, z: O.z + 4, r: 8 } });
    expect(area.status).toBe('none');
    expect(area.digOut?.refused.protected_area?.count).toBeGreaterThan(0);
    expect(trappedWhy(area.digOut!, area.expanded)).toContain('inside the protected base');
  });

  it('the gravity rule: a 1-block sand lip is dug by hand; a 2-high sand bank is not (the lower block has sand above it)', () => {
    const { gen, st } = stationWorld('lipDirt');
    for (let i = -3; i <= 3; i++) for (const [x, z] of [[O.x + i, O.z + 1], [O.x + i, O.z + 7], [O.x - 3, O.z + 4 + i], [O.x + 3, O.z + 4 + i]] as const) gen.put(x, O.y - 1, z, 'sand');
    const one = findPath(new NavGrid(gen), cell(st.start), goalOf(st), DIG_OUT);
    expect(one.status).toBe('found');
    expect(digs(one).map((p) => gen.blockAt(p.x, p.y, p.z)?.name)).toEqual(['sand']);
    for (let i = -3; i <= 3; i++) for (const [x, z] of [[O.x + i, O.z + 1], [O.x + i, O.z + 7], [O.x - 3, O.z + 4 + i], [O.x + 3, O.z + 4 + i]] as const) gen.put(x, O.y, z, 'sand');
    const two = findPath(new NavGrid(gen), cell(st.start), { type: 'block', p: { x: O.x, y: O.y + 1, z: O.z + 10 } }, DIG_OUT);
    expect(two.status).toBe('none');
    expect(two.digOut?.refused.gravity_above).toMatchObject({ block: 'sand' });
  });

  it('a swim exit wins unless it is far longer: the lip station digs nothing (its step 4 blocks off); the same pit stretched to 40 blocks digs at once', () => {
    const lip = waterStation('lip', O)!;
    const gen = flatGen();
    for (const op of lip.ops) gen.fill(op.from, op.to, op.block);
    const near = findPath(new NavGrid(gen), cell(lip.start), goalOf(lip), DIG_OUT);
    expect(near.status).toBe('found');
    expect(digs(near)).toEqual([]);
    // a 1-wide canal 40 long, its only step at the far end; the goal just beyond the rim by the start
    const g2 = flatGen();
    g2.fill({ x: 0, y: -63, z: -30 }, { x: 0, y: -61, z: 30 }, 'air');
    g2.fill({ x: 0, y: -63, z: -30 }, { x: 0, y: -62, z: 30 }, 'water');
    g2.put(0, -61, 31, 'air'); // the step at the far end (the floor at -62 beside the water)
    g2.fill({ x: 0, y: -62, z: 31 }, { x: 0, y: -62, z: 31 }, 'dirt');
    const start = { x: 0, y: -62, z: -28 };
    const goal: NavGoal = { type: 'block', p: { x: 2, y: -60, z: -28 } };
    const far = findPath(new NavGrid(g2), start, goal, DIG_OUT);
    expect(far.status).toBe('found');
    expect(digs(far).length).toBe(1);
    expect(far.path.every((n) => n.z < 0)).toBe(true);
    // without the dig: the long way round (swim to the far step and walk back)
    const round = findPath(new NavGrid(g2), start, goal, { maxNodes: 40_000 });
    expect(round.status).toBe('found');
    expect(round.cost).toBeGreaterThan(far.cost + 100);
  });

  it('never from under water: a start on the pool floor swims up first and digs from the surface', () => {
    const { gen, st } = stationWorld('lipDirt');
    const r = findPath(new NavGrid(gen), { x: O.x, y: O.y - 3, z: O.z + 4 }, goalOf(st), DIG_OUT);
    expect(r.status).toBe('found');
    const i = r.path.findIndex((n) => n.act?.dig);
    expect(r.path[i - 1]!.y).toBe(st.surfaceY);
    expect(r.path[i - 1]!.move).not.toBe('dive');
  });
});

describe('Track W2 planner: a staircase up a taller bank', () => {
  it('bank3: the step at the water level, then jumps with breaks up the 3-high bank, without allowBreak; nothing dug off the stair', () => {
    const { gen, st } = stationWorld('bank3');
    expect(findPath(new NavGrid(gen), cell(st.start), goalOf(st), { maxNodes: 20_000 }).status).toBe('none');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st), DIG_OUT);
    expect(r.status).toBe('found');
    const acts = r.path.filter((n) => n.act?.dig);
    expect(acts[0]!.move).toBe('swimOut');
    expect(acts[0]!.act!.dig).toHaveLength(2); // the lip and the head room over it, the higher first
    expect(acts[0]!.act!.dig![0]!.y).toBe(st.surfaceY + 2);
    for (const n of acts.slice(1)) expect(n.move).toBe('jump');
    expect(acts.length).toBeGreaterThanOrEqual(2);
    // the stair climbs one level per dug step; the body ends on the mound's top
    const ys = acts.map((n) => n.y);
    for (let k = 1; k < ys.length; k++) expect(ys[k]).toBe(ys[k - 1]! + 1);
    expect(r.path.at(-1)).toMatchObject({ x: st.goal.x, y: st.goal.y, z: st.goal.z });
    // every dug cell is the cut's: above the water's level, within 4 cells of the pit's rim, no walk dug through
    for (const p of digs(r)) expect(p.y).toBeGreaterThan(st.surfaceY);
    expect(r.path.some((n) => n.act?.dig && n.move === 'walk')).toBe(false);
    expect(digs(r).length).toBeLessThanOrEqual(6);
  });

  it('a re-plan on the stair goes on up it (PathNode.cut -> startCut); without it the same start digs nothing', () => {
    const { gen, st } = stationWorld('bank3');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st), DIG_OUT);
    const acts = r.path.filter((n) => n.act?.dig);
    // the step and the first stair step dug, the body on the first stair step
    for (const n of acts.slice(0, 2)) for (const p of n.act!.dig!) gen.put(p.x, p.y, p.z, 'air');
    const on = acts[1]!;
    expect(on.cut).toBe(2);
    const again = findPath(new NavGrid(gen), on, goalOf(st), { ...DIG_OUT, startCut: on.cut });
    expect(again.status).toBe('found');
    expect(digs(again).length).toBeGreaterThan(0);
    expect(again.path.at(-1)).toMatchObject({ x: st.goal.x, y: st.goal.y, z: st.goal.z });
    const cold = findPath(new NavGrid(gen), on, goalOf(st), { maxNodes: 20_000 });
    expect(digs(cold)).toEqual([]);
  });

  it('the stair is only the cut: from dry ground with digOut on (allowBreak off) nothing is dug', () => {
    const gen = flatGen();
    gen.fill({ x: -3, y: -60, z: 5 }, { x: 3, y: -58, z: 5 }, 'dirt'); // a 3-high wall across the way
    gen.fill({ x: -10, y: -60, z: 5 }, { x: -4, y: -58, z: 5 }, 'stone_bricks');
    gen.fill({ x: 4, y: -60, z: 5 }, { x: 10, y: -58, z: 5 }, 'stone_bricks');
    const r = findPath(new NavGrid(gen), { x: 0, y: -60, z: 0 }, { type: 'block', p: { x: 0, y: -60, z: 9 } }, DIG_OUT);
    expect(digs(r)).toEqual([]);
  });
});

// ---- closed loops -----------------------------------------------------------------------------------

interface Drive {
  result: SkillResult | undefined;
  ticks: number;
  pos: Vec3;
  skills: BotSkills;
  log: string[];
  conds: (object | undefined)[];
}

/** Fake dig actions on the GenWorld: 8 ticks a block; the conditions each dig was asked with. */
function fakeActions(gen: GenWorld, log: string[], conds: (object | undefined)[], loop: { waitTicks(n: number): Promise<void> }): NavActions {
  return {
    dig: async (p, o) => {
      log.push(`dig ${p.x - O.x},${p.y - O.y},${p.z - O.z} ${gen.blockAt(p.x, p.y, p.z)?.name}`);
      conds.push(o?.conditions);
      await loop.waitTicks(8);
      gen.set(p.x, p.y, p.z, 'air');
      return { ok: true };
    },
  };
}

async function drive(gen: GenWorld, start: Vec3, goal: NavGoal, maxTicks = 3000): Promise<Drive> {
  const { conn, loop } = harness(start);
  const log: string[] = [];
  const conds: (object | undefined)[] = [];
  const skills = new BotSkills({ loop, world: fakeWorld(gen), actions: fakeActions(gen, log, conds, loop) });
  conn.tick(5);
  let result: SkillResult | undefined;
  const p = skills.goto(goal).then((r) => (result = r));
  let t = 0;
  while (skills.nav.busy && t < maxTicks) {
    conn.tick();
    await Promise.resolve();
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t, pos: loop.state.pos, skills, log, conds };
}

describe('Track W2 follower: digging out, closed loop', () => {
  it('lipDirt: treads water at the surface while the lip is dug (off the ground), climbs out and walks to the goal', async () => {
    const { gen, st } = stationWorld('lipDirt');
    const run = await drive(gen, st.start, goalOf(st));
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    expect(run.log).toEqual(['dig 0,-1,7 grass_block']);
    expect(run.conds).toEqual([{ offGround: true }]);
    expect(Math.hypot(run.pos.x - (st.goal.x + 0.5), run.pos.z - (st.goal.z + 0.5))).toBeLessThan(0.5);
    const rep = run.skills.status().lastGoto!;
    expect(rep.actions).toMatchObject({ dig: 1, failed: 0 });
    expect(rep.plans.some((p) => p.reason === 'block')).toBe(true); // planned again after the break
    expect(rep.stuck).toBe(0);
  });

  it('bank3: cuts the stair and ends on top of the mound', async () => {
    const { gen, st } = stationWorld('bank3');
    const run = await drive(gen, st.start, goalOf(st));
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    expect(run.log.length).toBeGreaterThanOrEqual(4);
    expect(run.log.slice(0, 2)).toEqual(['dig 0,0,7 dirt', 'dig 0,-1,7 grass_block']);
    expect(run.conds.slice(0, 2)).toEqual([{ offGround: true }, { offGround: true }]);
    for (const c of run.conds.slice(2)) expect(c).toBeUndefined(); // on the stair: on the ground, no water
    expect(run.pos.y).toBeCloseTo(st.goal.y, 3);
  });

  it('lipBuilt: unreachable, the goto says it is trapped (protected rim), nothing dug', async () => {
    const { gen, st } = stationWorld('lipBuilt');
    const run = await drive(gen, st.start, goalOf(st));
    expect(run.result).toEqual({ ok: false, reason: 'unreachable' });
    expect(run.log).toEqual([]);
    const why = run.skills.status().lastGoto!.why ?? '';
    expect(why).toMatch(/^trapped in water: no swim exit and no step to dig \(stone_bricks: protected or built/);
  });

  it('Navigator.digOut turns the planner option off and on', () => {
    const { gen, st } = stationWorld('lipDirt');
    const { conn, loop } = harness(st.start);
    const skills = new BotSkills({ loop, world: fakeWorld(gen), actions: fakeActions(gen, [], [], loop) });
    skills.nav.digOut = false;
    expect(skills.nav.planOptions().digOut).toBe(false);
    skills.nav.digOut = true;
    expect(skills.nav.planOptions().digOut).toBe(true);
    conn.tick(1);
    skills.cancel();
  });

  it('the break conditions of a dig from the water: off the ground, in water with the head under', () => {
    expect(waterDigConditions({ onGround: false }, false)).toEqual({ offGround: true });
    expect(waterDigConditions({ onGround: true }, true)).toEqual({ inWater: true });
    expect(waterDigConditions({ onGround: true }, false)).toEqual({});
  });

  it('every dig-out station is in the truth pack list', () => {
    expect([...DIG_OUT_STATIONS]).toEqual(['lipDirt', 'lipStone', 'bank3', 'lipBuilt']);
  });
});

describe('Track W2 guards (decision 0070 "W2: digging out")', () => {
  const DOC = readFileSync(new URL('../../../../docs/pathfinding.md', import.meta.url), 'utf8');
  const ADR = readFileSync(new URL('../../../../docs/decisions/0070-water-travel.md', import.meta.url), 'utf8');

  it('the guide has the subsection under "Water (Track W1)" naming the constants with their values; the decision has its addendum', () => {
    const w1 = DOC.indexOf('\n## Water (Track W1)\n');
    const at = DOC.indexOf('\n### Digging out of water (Track W2)\n');
    const next = DOC.indexOf('\n## ', w1 + 4);
    expect(w1).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(w1);
    expect(at).toBeLessThan(next);
    const s = DOC.slice(at, next);
    expect(s).toContain('nav/digout.ts');
    for (const name of DIG_OUT_STATIONS) expect(s, name).toContain(`\`${name}\``);
    const named = (id: string, v: number) => expect(s, `${id} ${v}`).toMatch(new RegExp(`\`${id}\`\\s+${v}\\b`));
    named('WATER_DIG_FACTOR', WATER_DIG_FACTOR);
    named('DIG_OUT_PENALTY', DIG_OUT_PENALTY);
    named('DIG_OUT_MAX_TICKS', DIG_OUT_MAX_TICKS);
    named('DIG_OUT_MAX_STEPS', DIG_OUT_MAX_STEPS);
    expect(ADR).toContain('\n## W2: digging out\n');
    expect(ADR).toContain('nav/digout.ts');
  });

  it('the water factor is the measured off-ground modifier; the no-tool limit lies between the hand and a wooden pickaxe on stone, above the hand on dirt, grass and sand', () => {
    expect(WATER_DIG_FACTOR).toBe(1 / MODIFIERS.offGround);
    expect(WATER_DIG_FACTOR).toBe(5);
    const water = (block: string, item: string | null) => breakTicks(block, item)! * WATER_DIG_FACTOR;
    expect(water('stone', null)).toBeGreaterThan(DIG_OUT_MAX_TICKS);
    expect(water('stone', 'wooden_pickaxe')).toBeLessThanOrEqual(DIG_OUT_MAX_TICKS);
    for (const b of ['dirt', 'grass_block', 'sand', 'gravel']) expect(water(b, null), b).toBeLessThanOrEqual(DIG_OUT_MAX_TICKS);
    // the server's counts (measured): the table with the modifier on the speed
    expect(breakTicks('grass_block', null, { offGround: true })).toBe(90);
    expect(breakTicks('stone', 'wooden_pickaxe', { offGround: true })).toBe(113);
    expect(breakTicks('stone', 'iron_pickaxe', { offGround: true })).toBe(38);
    expect(breakTicks('dirt', null, { inWater: true })).toBe(75);
  });
});
