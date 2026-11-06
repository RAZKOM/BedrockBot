// Track W1 (docs/pathfinding.md "Water (Track W1)", decisions/0070-water-travel.md): walking and following
// through water. The stations are the truth pack's (packs/truth/src/water-layout.ts, what `truth:water` builds
// for the e2e nav-water suite), built here in a generated world with the waterfall's flow put in place. Planner
// checks (dive nodes, the air budget, starts under water), then closed loops (FakeConnection -> InputLoop with the
// own physics <- BotSkills / Navigator): the "server" is the same physics, so these test planning and following;
// the e2e suite tests the model against BDS.
import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { W1_STATIONS, waterStation, type WaterStation, type WaterStationName } from '../../../../packs/truth/src/water-layout.ts';
import { BotSkills, type SkillResult } from '../../../src/skills/index.ts';
import { IDLE_COMMAND, initialBody, stepBody, type MoveCommand } from '../../../src/skills/input/index.ts';
import { findPath, type PathNode } from '../../../src/skills/nav/astar.ts';
import type { NavGoal } from '../../../src/skills/nav/goals.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { AIR_KEEP, AIR_MARGIN, AIR_MAX, AIR_MIN_BUDGET, AirClock, airBudget, bodyInWater, diveGoalBudget, headUnderWater, underSurface } from '../../../src/skills/nav/water.ts';
import { blockQueryOf } from '../../../src/skills/terrain/query.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const O = { x: 0, y: -60, z: -10 };

/** The station built in a flat generated world, the server's flow (`flows`) put in place of the kicks. */
function stationWorld(name: WaterStationName): { gen: GenWorld; st: WaterStation } {
  const st = waterStation(name, O)!;
  const gen = flatGen();
  for (const op of st.ops) gen.fill(op.from, op.to, op.block);
  for (const f of st.flows) gen.put(f.p.x, f.p.y, f.p.z, 'water', { liquid_depth: f.depth });
  return { gen, st };
}

const cell = (p: Vec3): Vec3 => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const goalOf = (st: WaterStation): NavGoal => ({ type: 'block', p: st.goal });
const moves = (path: readonly PathNode[]): string[] => path.map((n) => n.move);

interface Run {
  result: SkillResult | undefined;
  ticks: number;
  pos: Vec3;
  /** The navigator's air clock's low point (0..300). */
  minAir: number;
  /** Ticks in water (the physics test). */
  wet: number;
  /** The lowest feet height while the goal was above the start (sinking while climbing). */
  minFeet: number;
  /** Stuck events of the goto (move timeouts, no progress). */
  stuck: number;
}

async function runGoto(gen: GenWorld, start: Vec3, goal: NavGoal, opts: { maxTicks?: number; air?: number } = {}): Promise<Run> {
  const { conn, loop } = harness(start);
  const skills = new BotSkills({ loop, world: fakeWorld(gen) });
  if (opts.air !== undefined) skills.nav.airClock.air = opts.air;
  conn.tick(5);
  let result: SkillResult | undefined;
  const p = skills.goto(goal).then((r) => (result = r));
  let t = 0;
  let minAir = Infinity;
  let wet = 0;
  let minFeet = Infinity;
  const max = opts.maxTicks ?? 3000;
  while (skills.nav.busy && t < max) {
    conn.tick();
    minAir = Math.min(minAir, skills.nav.airClock.air);
    minFeet = Math.min(minFeet, loop.state.pos.y);
    if (loop.state.inWater) wet++;
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t, pos: loop.state.pos, minAir, wet, minFeet, stuck: skills.status().lastGoto?.stuck ?? 0 };
}

describe('water rules (nav/water.ts)', () => {
  it('the air budget: a breathing start keeps AIR_KEEP, a start under water what it has left (at least AIR_MIN_BUDGET)', () => {
    expect(airBudget(undefined, false)).toBeCloseTo((AIR_MAX - AIR_KEEP) / AIR_MARGIN, 6);
    expect(airBudget(40, false)).toBeCloseTo((AIR_MAX - AIR_KEEP) / AIR_MARGIN, 6); // the air refills before the dive
    expect(airBudget(200, true)).toBeCloseTo((200 - 20) / AIR_MARGIN, 6);
    expect(airBudget(30, true)).toBe(AIR_MIN_BUDGET);
    expect(airBudget(undefined, true)).toBeCloseTo((AIR_MAX - 20) / AIR_MARGIN, 6);
    // to a goal under water and back up: no minimum (that is there for the way up only)
    expect(diveGoalBudget(40, false)).toBe(airBudget(40, false));
    expect(diveGoalBudget(30, true)).toBeCloseTo((30 - 20) / AIR_MARGIN, 6);
    expect(diveGoalBudget(200, true)).toBe(airBudget(200, true));
  });

  it('a point under the surface: its cell and the one above it water', () => {
    const { gen } = stationWorld('pool6');
    const grid = new NavGrid(gen);
    const cls = (x: number, y: number, z: number) => grid.cls(x, y, z);
    expect(underSurface(cls, { x: O.x + 0.5, y: O.y, z: O.z + 8.5 })).toBe(true); // the floor, 6 under
    expect(underSurface(cls, { x: O.x + 0.5, y: O.y + 5, z: O.z + 8.5 })).toBe(false); // the top water cell
    expect(underSurface(cls, { x: O.x + 0.5, y: O.y + 6, z: O.z + 1.5 })).toBe(false); // the bank
  });

  it('the air clock runs down 1 a tick under water (to -20) and refills out of it', () => {
    const c = new AirClock();
    for (let i = 0; i < 100; i++) c.step(true);
    expect(c.air).toBe(200);
    expect(c.under).toBe(100);
    for (let i = 0; i < 400; i++) c.step(true);
    expect(c.air).toBe(-20);
    c.step(false);
    expect(c.under).toBe(0);
    for (let i = 0; i < 200; i++) c.step(false);
    expect(c.air).toBe(AIR_MAX);
  });

  it('in water and head under water: the cells at the feet and the eye', () => {
    const { gen } = stationWorld('pool6');
    const grid = new NavGrid(gen);
    const cls = (x: number, y: number, z: number) => grid.cls(x, y, z);
    // on the floor of the 6-deep pool: in water, the head under
    const floor = { x: O.x + 0.5, y: O.y, z: O.z + 8.5 };
    expect(bodyInWater(cls, { pos: floor })).toBe(true);
    expect(headUnderWater(cls, floor)).toBe(true);
    // at the surface (feet in the top water cell, the eye above it): in water, breathing
    const top = { x: O.x + 0.5, y: O.y + 5.2, z: O.z + 8.5 };
    expect(bodyInWater(cls, { pos: top })).toBe(true);
    expect(headUnderWater(cls, top)).toBe(false);
    // bobbing just over the surface (the physics test says dry for a tick): still in water
    expect(bodyInWater(cls, { pos: { ...top, y: O.y + 6.3 }, inWater: false })).toBe(true);
    // on the bank: dry
    expect(bodyInWater(cls, { pos: { x: O.x + 0.5, y: O.y + 6, z: O.z + 1.5 }, inWater: false })).toBe(false);
    expect(grid.submerged(O.x, O.y, O.z + 8)).toBe(true);
    expect(grid.submerged(O.x, O.y + 5, O.z + 8)).toBe(false);
  });

  it('dive nodes: water that is not a surface node, the head in water or air; not a bubble column', () => {
    const { gen } = stationWorld('pool6');
    const grid = new NavGrid(gen);
    expect(grid.dive(O.x, O.y, O.z + 8)).toBe(O.y);
    expect(grid.dive(O.x, O.y + 4, O.z + 8)).toBe(O.y + 4);
    expect(Number.isNaN(grid.dive(O.x, O.y + 5, O.z + 8)!)).toBe(true); // the surface: a swim node
    expect(grid.swim(O.x, O.y + 5, O.z + 8)).toBe(O.y + 5);
    gen.put(O.x, O.y + 2, O.z + 6, 'bubble_column');
    grid.clear();
    expect(Number.isNaN(grid.dive(O.x, O.y + 2, O.z + 6)!)).toBe(true);
  });
});

describe('physics: the sneak key sinks the body in water (Track W1, measured on BDS 1.26.60)', () => {
  it('v.y -0.158 after 8 ticks on the server; the model is within 0.01 and reaches -0.185', () => {
    const { gen } = stationWorld('pool6');
    const q = blockQueryOf(gen);
    let s = initialBody({ x: O.x + 0.5, y: O.y + 4, z: O.z + 8.5 }, false);
    const cmd: MoveCommand = { ...IDLE_COMMAND, sneak: true };
    const vs: number[] = [];
    for (let i = 0; i < 30 && s.pos.y > O.y + 0.05; i++) {
      s = stepBody(s, cmd, q).state;
      vs.push(s.vel.y);
    }
    expect(vs[7]!).toBeGreaterThan(-0.168);
    expect(vs[7]!).toBeLessThan(-0.148);
    expect(Math.min(...vs)).toBeGreaterThan(-0.186);
    // idle: the slow sink (-0.025 a tick) the server shows
    let t = initialBody({ x: O.x + 0.5, y: O.y + 3, z: O.z + 8.5 }, false);
    for (let i = 0; i < 40; i++) t = stepBody(t, IDLE_COMMAND, q).state;
    expect(t.vel.y).toBeCloseTo(-0.025, 3);
  });
});

describe('planner: through water (Track W1)', () => {
  it('every station has a way from its start to its goal', () => {
    for (const name of W1_STATIONS) {
      const { gen, st } = stationWorld(name);
      const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { maxNodes: 20_000 });
      expect(r.status, name).toBe('found');
    }
  });

  it('pool2: swims across the surface, never under it', () => {
    const { gen, st } = stationWorld('pool2');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st));
    expect(moves(r.path)).toContain('swim');
    expect(moves(r.path)).toContain('swimOut');
    expect(moves(r.path)).not.toContain('dive');
  });

  it('pool6: from the floor, 6 under the surface, up the dive nodes to the surface and out', () => {
    const { gen, st } = stationWorld('pool6');
    const r = findPath(new NavGrid(gen), cell(st.deepStart!), goalOf(st), { air: 120 });
    expect(r.status).toBe('found');
    const dives = r.path.filter((n) => n.move === 'dive');
    expect(dives.length).toBeGreaterThanOrEqual(4);
    // straight up: never deeper than the start, never sideways under water before the surface
    for (const n of dives) expect(n.y).toBeGreaterThanOrEqual(O.y);
    expect(moves(r.path)).toContain('swimOut');
  });

  it('column: in through the inlet, up the 8-high column, out onto the top', () => {
    const { gen, st } = stationWorld('column');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st));
    expect(r.status).toBe('found');
    const up = r.path.filter((n) => n.move === 'dive' && n.x === O.x && n.z === O.z + 4);
    expect(up.length).toBeGreaterThanOrEqual(6);
    expect(moves(r.path)).toContain('swimOut');
  });

  it('waterfall: up the falling water to the shelf', () => {
    const { gen, st } = stationWorld('waterfall');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st));
    expect(r.status).toBe('found');
    const fall = r.path.filter((n) => n.move === 'dive' && n.x === O.x && (n.z === O.z + 4 || n.z === O.z + 5) && n.y >= O.y);
    expect(fall.length).toBeGreaterThanOrEqual(8);
  });

  it('lip: never out over the 1-block lip (BDS does not lift a swimming body that high): out at the step', () => {
    const { gen, st } = stationWorld('lip');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st));
    expect(r.status).toBe('found');
    const out = r.path.find((n) => n.move === 'swimOut')!;
    expect(out).toMatchObject({ x: O.x - 3, y: O.y - 1, z: O.z + 2 });
    // the step filled in: no way out at all (the lip is a wall)
    gen.put(O.x - 3, O.y - 1, O.z + 2, 'grass_block');
    const shut = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { maxNodes: 5000 });
    expect(shut.status).not.toBe('found');
    expect(shut.path.some((n) => n.move === 'swimOut')).toBe(false);
  });

  it('tunnel: dives under the roof of the 3-long sump; the air budget refuses a 20-long one', () => {
    const { gen, st } = stationWorld('tunnel');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st));
    expect(r.status).toBe('found');
    const under = r.path.filter((n) => n.move === 'dive' && n.z >= O.z + 8 && n.z <= O.z + 10);
    expect(under.length).toBe(3);
    // the same sump 20 long: about 210 ticks under water, more than the budget (126 from a breathing start)
    const long = flatGen();
    long.fill({ x: -3, y: -63, z: -30 }, { x: 3, y: -57, z: 30 }, 'stone');
    long.fill({ x: 0, y: -60, z: -28 }, { x: 0, y: -58, z: -24 }, 'air');
    long.fill({ x: 0, y: -62, z: -23 }, { x: 0, y: -61, z: 23 }, 'water');
    long.fill({ x: 0, y: -60, z: -23 }, { x: 0, y: -58, z: -23 }, 'air');
    long.fill({ x: 0, y: -60, z: 23 }, { x: 0, y: -58, z: 23 }, 'air');
    long.fill({ x: 0, y: -60, z: 24 }, { x: 0, y: -58, z: 28 }, 'air');
    const g = new NavGrid(long);
    const refused = findPath(g, { x: 0, y: -60, z: -27 }, { type: 'block', p: { x: 0, y: -60, z: 27 } }, { maxNodes: 20_000 });
    expect(refused.status).not.toBe('found');
    // a partial way never ends under water
    if (refused.path.length) expect(refused.path.at(-1)!.move).not.toBe('dive');
    // dive moves off: the 3-long sump is not passed either
    const off = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { moves: { dive: false }, maxNodes: 20_000 });
    expect(off.status).not.toBe('found');
  });

  it('a start under water with little air: only a short way up (the budget from what is left)', () => {
    const { gen, st } = stationWorld('pool6');
    // 30 air: the minimum budget (60 ticks): straight up is 5 x 8 = 40, still found
    const r = findPath(new NavGrid(gen), cell(st.deepStart!), goalOf(st), { air: 30 });
    expect(r.status).toBe('found');
    // the tunnel from the middle of its sump with 30 air: out at one end (at most 2 cells across)
    const t = stationWorld('tunnel');
    const mid = findPath(new NavGrid(t.gen), { x: O.x, y: O.y - 2, z: O.z + 9 }, goalOf(t.st), { air: 30 });
    expect(mid.status).toBe('found');
    expect(mid.path[0]!.move).toBe('start');
  });

  it('a `near` goal around a point in water (a swimming player) is reached at a surface node', () => {
    const { gen } = stationWorld('pool2');
    const p = { x: O.x + 0.5, y: O.y - 1.2, z: O.z + 8.5 };
    const r = findPath(new NavGrid(gen), { x: O.x, y: O.y, z: O.z + 1 }, { type: 'near', p, r: 2 });
    expect(r.status).toBe('found');
    expect(r.path.at(-1)!.move).toBe('swim');
  });

  it('a `near` goal around a point under the surface (a waypoint on a pool floor) is reached at a dive node, within the air', () => {
    const { gen, st } = stationWorld('pool6');
    const floor = { type: 'near', p: { x: O.x + 0.5, y: O.y, z: O.z + 12.5 }, r: 1.5 } as const;
    // from the bank: down to the floor (the way back up, 6 x 8 ticks, within the budget)
    const r = findPath(new NavGrid(gen), cell(st.start), floor);
    expect(r.status).toBe('found');
    const end = r.path.at(-1)!;
    expect(end.move).toBe('dive');
    expect(end.y).toBeLessThanOrEqual(O.y + 1);
    // from the floor with 60 air: (60 - 20) / 1.5 = 27 ticks, less than 4 across and 6 up: not a goal there
    const low = findPath(new NavGrid(gen), cell(st.deepStart!), floor, { air: 60, maxNodes: 20_000 });
    expect(low.status).not.toBe('found');
    if (low.path.length > 1) expect(low.path.at(-1)!.move).not.toBe('dive');
    // under a roof (no air straight up): never a goal under water
    const roofed = stationWorld('tunnel');
    const sump = findPath(new NavGrid(roofed.gen), cell(roofed.st.start), { type: 'near', p: { x: O.x + 0.5, y: O.y - 2, z: O.z + 9.5 }, r: 1 }, { maxNodes: 20_000 });
    expect(sump.status).not.toBe('found');
  });
});

describe('closed loop: through water (Track W1)', () => {
  /** W1_OUT=<file>: the runs' ticks, air low-points and lowest feet (the model's numbers for docs/pathfinding.md). */
  const notes: string[] = [];
  const note = (label: string, r: Run): void => {
    notes.push(`${label}: ${r.result?.ok ? 'ok' : JSON.stringify(r.result)} in ${r.ticks} ticks, air low ${r.minAir}, in water ${r.wet} ticks, lowest feet ${r.minFeet.toFixed(2)}, stuck ${r.stuck}`);
  };
  afterAll(() => {
    if (process.env.W1_OUT) writeFileSync(process.env.W1_OUT, notes.join('\n'));
  });
  for (const name of ['pool2', 'pool6', 'column', 'waterfall', 'tunnel'] as const) {
    it(`${name}: from the start to the goal`, async () => {
      const { gen, st } = stationWorld(name);
      const run = await runGoto(gen, st.start, goalOf(st), { maxTicks: 2500 });
      note(name, run);
      expect(run.result, `${name} after ${run.ticks} ticks at ${JSON.stringify(run.pos)}`).toEqual({ ok: true });
      expect(cell(run.pos)).toMatchObject({ y: st.goal.y });
      expect(Math.hypot(run.pos.x - (st.goal.x + 0.5), run.pos.z - (st.goal.z + 0.5))).toBeLessThan(1.2);
      expect(run.minAir).toBeGreaterThan(AIR_KEEP - 20);
      expect(run.stuck).toBe(0);
    });
  }

  it('pool6: down from the floor start, never sinking, up and out', async () => {
    const { gen, st } = stationWorld('pool6');
    const run = await runGoto(gen, st.deepStart!, goalOf(st), { maxTicks: 2500, air: 200 });
    note('pool6 from the floor (air 200)', run);
    expect(run.result).toEqual({ ok: true });
    expect(run.pos.y).toBeCloseTo(O.y + 6, 2);
    expect(run.minFeet).toBeGreaterThan(O.y - 0.05);
  });

  it('a `near` goal around a swimmer reached at the start (a path of one surface node): done there, the body held up', async () => {
    const { gen } = stationWorld('pool2');
    const run = await runGoto(gen, { x: O.x + 0.5, y: O.y - 1, z: O.z + 8.5 }, { type: 'near', p: { x: O.x + 0.5, y: O.y - 1, z: O.z + 10.5 }, r: 3 }, { maxTicks: 400 });
    expect(run.result).toEqual({ ok: true });
    expect(run.ticks).toBeLessThan(40);
    expect(run.stuck).toBe(0);
    expect(run.minFeet).toBeGreaterThan(O.y - 1.6);
  });

  it('pool6: from the bank down to a point on the floor (a waypoint under water): done there', async () => {
    const { gen, st } = stationWorld('pool6');
    const run = await runGoto(gen, st.start, { type: 'near', p: { x: O.x + 0.5, y: O.y, z: O.z + 12.5 }, r: 1.5 }, { maxTicks: 1500 });
    note('pool6 bank to the floor', run);
    expect(run.result).toEqual({ ok: true });
    // the goal's node within r (1.5) of the point, the body within SWIM_ARRIVE (0.7) of that node's centre
    expect(Math.hypot(run.pos.x - (O.x + 0.5), run.pos.y - O.y, run.pos.z - (O.z + 12.5))).toBeLessThan(2.2);
    expect(run.pos.y).toBeLessThan(O.y + 1.6);
    expect(run.minAir).toBeGreaterThan(AIR_KEEP + 40);
    expect(run.stuck).toBe(0);
  });

  it('lip: from the water along the lip to the step and out onto the bank', async () => {
    const { gen, st } = stationWorld('lip');
    const run = await runGoto(gen, st.start, goalOf(st), { maxTicks: 1500 });
    note('lip', run);
    expect(run.result).toEqual({ ok: true });
    expect(run.pos.y).toBeCloseTo(O.y, 2);
    expect(run.stuck).toBe(0);
  });
});
