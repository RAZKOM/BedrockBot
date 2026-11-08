// Track W3 (docs/pathfinding.md "Water (Track W1)", its part "When the plain walk finds no way (Track W3)";
// decisions/0070-water-travel.md "W3"): a walk through waypoints a player set must get there, unhurt. The stations
// are the truth pack's (packs/truth/src/water-layout.ts W3_STATIONS, what `truth:water` builds for the nav-water
// e2e). Planner checks (the dig way's budget, natural blocks only, a goal cell in water), then closed loops
// (FakeConnection -> InputLoop <- BotSkills / Navigator with fake dig actions on the generated world): the levels
// (no fall that hurts while a harmless way exists, the dig way before the fall, the fall when digging cannot do it).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { W3_STATIONS, waterStation, type WaterStation, type WaterStationName } from '../../../../packs/truth/src/water-layout.ts';
import { fallPolicy, type FallPolicy } from '../../../src/skills/fall/policy.ts';
import { BotSkills } from '../../../src/skills/index.ts';
import type { NavActions } from '../../../src/skills/nav/actions.ts';
import { findPath, handBreakTicks, type PathNode, type PathOptions, type PathResult } from '../../../src/skills/nav/astar.ts';
import { DIG_WAY_HP_COST, DIG_WAY_MAX_BLOCKS, DIG_WAY_MAX_TICKS, DIG_WAY_PENALTY, digWayBreakTicks, fallsHurt, harmlessFalls, lastResortFalls } from '../../../src/skills/nav/digway.ts';
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
const WAY: PathOptions = { allowBreak: true, digWay: { left: DIG_WAY_MAX_BLOCKS }, maxNodes: 40_000 };
const POLICY = (health = 20): FallPolicy =>
  fallPolicy({ enabled: true, health, healthKnown: true, absorption: 0, margin: 8, epf: 0, burning: false, hostileDistance: Infinity, bucket: false, clutchOn: true, waterWorks: true, clutchMax: 40 })!;

describe('Track W3 rules (nav/digway.ts)', () => {
  it('the dig way breaks natural terrain only, and nothing slower than DIG_WAY_MAX_TICKS', () => {
    const bt = digWayBreakTicks(handBreakTicks);
    const g = flatGen();
    const c = (name: string) => {
      g.put(0, -50, 0, name);
      return classify(g.blockAt(0, -50, 0)!);
    };
    expect(bt(c('dirt'))).toBe(handBreakTicks(c('dirt')));
    expect(bt(c('stone'))).toBe(handBreakTicks(c('stone')));
    expect(bt(c('stone'))).toBeLessThanOrEqual(DIG_WAY_MAX_TICKS); // by hand: allowed
    expect(bt(c('stone_bricks'))).toBe(Infinity); // a build
    expect(bt(c('oak_planks'))).toBe(Infinity);
    expect(bt(c('obsidian'))).toBe(Infinity); // natural, far too slow
  });

  it('levels 0 and 1 take harmless falls only; level 2 the full budget, a hurt priced high while the dig way is open', () => {
    const p = POLICY();
    expect(p.hpBudget).toBeGreaterThan(0);
    expect(fallsHurt(p)).toBe(true);
    const h = harmlessFalls(p);
    expect(h.hpBudget).toBe(0);
    expect(h.clutch).toBe(false);
    expect(fallsHurt(h)).toBe(false);
    expect(lastResortFalls(p, false)).toBe(p);
    expect(lastResortFalls(p, true).hpCost).toBe(Math.max(p.hpCost, DIG_WAY_HP_COST));
    expect(fallsHurt(POLICY(8))).toBe(false); // at the margin: blocked
    expect(fallsHurt(undefined)).toBe(false);
  });
});

describe('Track W3 planner: the dig way', () => {
  it('step2: no plain way onto a 2-high block; the dig way cuts one block of its face, priced DIG_WAY_PENALTY on top', () => {
    const { gen, st } = stationWorld('step2');
    expect(findPath(new NavGrid(gen), cell(st.start), goalOf(st), { maxNodes: 40_000 }).status).not.toBe('found');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st), WAY);
    expect(r.status).toBe('found');
    expect(digs(r)).toHaveLength(1);
    expect(gen.blockAt(digs(r)[0]!.x, digs(r)[0]!.y, digs(r)[0]!.z)?.name).toBe('stone');
    // the same plan with allowBreak alone (no dig way) costs DIG_WAY_PENALTY less a block
    const plain = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { allowBreak: true, maxNodes: 40_000 });
    expect(digs(plain)).toHaveLength(1);
    expect(r.cost - plain.cost).toBeCloseTo(DIG_WAY_PENALTY, 6);
  });

  it('step3: a stair of three dug blocks; a budget of two finds none', () => {
    const { gen, st } = stationWorld('step3');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st), WAY);
    expect(r.status).toBe('found');
    expect(digs(r)).toHaveLength(3);
    for (const d of digs(r)) expect(gen.blockAt(d.x, d.y, d.z)?.name).toBe('dirt');
    const short = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { ...WAY, digWay: { left: 2 } });
    expect(short.status).not.toBe('found');
    expect(digs(short).length).toBeLessThanOrEqual(2);
  });

  it('never a built block: the same 2-high step of stone bricks has no dig way', () => {
    const { gen, st } = stationWorld('step2');
    gen.fill({ x: O.x - 3, y: O.y, z: O.z + 6 }, { x: O.x + 3, y: O.y + 1, z: O.z + 14 }, 'stone_bricks');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st), WAY);
    expect(r.status).not.toBe('found');
    expect(digs(r)).toEqual([]);
  });

  it('drop6: with harmless falls only, no plain way down; the dig way digs down and drops no more than 3', () => {
    const { gen, st } = stationWorld('drop6');
    const falls = harmlessFalls(POLICY());
    const plain = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { falls, maxNodes: 40_000 });
    expect(plain.status).not.toBe('found');
    const hurt = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { falls: POLICY(), maxNodes: 40_000 });
    expect(hurt.status).toBe('found'); // the 6-block fall (3 HP) the long-fall policy would take
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { ...WAY, falls });
    expect(r.status).toBe('found');
    expect(digs(r).length).toBeGreaterThanOrEqual(3);
    expect(digs(r).length).toBeLessThanOrEqual(DIG_WAY_MAX_BLOCKS);
    let maxDrop = 0;
    for (let i = 1; i < r.path.length; i++) maxDrop = Math.max(maxDrop, r.path[i - 1]!.feet - r.path[i]!.feet);
    expect(maxDrop).toBeLessThanOrEqual(3);
  });

  it('a block goal whose cell is water: reached at the surface of a 1-deep floor (wetGoal) and diving on a pool floor (pool2)', () => {
    const { gen, st } = stationWorld('wetGoal');
    const r = findPath(new NavGrid(gen), cell(st.start), goalOf(st), { maxNodes: 40_000 });
    expect(r.status).toBe('found');
    const end = r.path.at(-1)!;
    expect([end.x, end.y, end.z]).toEqual([st.goal.x, st.goal.y, st.goal.z]);
    expect(end.move).toBe('swim');
    const pool = stationWorld('pool2');
    const floor = { x: O.x, y: pool.st.surfaceY - 1, z: O.z + 8 };
    expect(gen.blockAt(floor.x, floor.y, floor.z)).toBeDefined();
    const d = findPath(new NavGrid(pool.gen), cell(pool.st.start), { type: 'block', p: floor }, { maxNodes: 40_000 });
    expect(d.status).toBe('found');
    expect(d.path.at(-1)!.move).toBe('dive');
    expect([d.path.at(-1)!.x, d.path.at(-1)!.y, d.path.at(-1)!.z]).toEqual([floor.x, floor.y, floor.z]);
  });

  it('every W3 station is in the truth pack list', () => {
    expect([...W3_STATIONS]).toEqual(['step2', 'step3', 'drop6', 'wetGoal']);
  });
});

interface Drive {
  result: SkillResult | undefined;
  ticks: number;
  pos: Vec3;
  skills: BotSkills;
  log: string[];
  /** The longest fall the body took (blocks, from the top of the airtime to the landing). */
  maxFall: number;
  info: string[];
}

/** Fake dig actions on the GenWorld: 8 ticks a block. */
function fakeActions(gen: GenWorld, log: string[], loop: { waitTicks(n: number): Promise<void> }): NavActions {
  return {
    dig: async (p) => {
      log.push(`dig ${p.x - O.x},${p.y - O.y},${p.z - O.z} ${gen.blockAt(p.x, p.y, p.z)?.name}`);
      await loop.waitTicks(8);
      gen.set(p.x, p.y, p.z, 'air');
      return { ok: true };
    },
  };
}

async function drive(gen: GenWorld, start: Vec3, goal: NavGoal, opts: { digWay?: boolean; health?: number; maxTicks?: number } = {}): Promise<Drive> {
  const { conn, loop } = harness(start);
  const log: string[] = [];
  const info: string[] = [];
  const world = { ...fakeWorld(gen), self: { health: opts.health ?? 20, food: 20, healthKnown: true } };
  const logger = { debug() {}, info: (m: string) => info.push(m), warn: (m: string) => info.push(m), error() {} };
  const skills = new BotSkills({ loop, world, actions: fakeActions(gen, log, loop), logger, mainMs: 1000, ...(opts.digWay !== undefined ? { digWay: opts.digWay } : {}) });
  conn.tick(5);
  let result: SkillResult | undefined;
  const p = skills.goto(goal).then((r) => (result = r));
  let t = 0;
  let top = loop.state.pos.y;
  let maxFall = 0;
  const max = opts.maxTicks ?? 3000;
  while (skills.nav.busy && t < max) {
    conn.tick();
    await Promise.resolve();
    const s = loop.state;
    if (s.onGround || s.inWater) {
      maxFall = Math.max(maxFall, top - s.pos.y);
      top = s.pos.y;
    } else top = Math.max(top, s.pos.y);
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t, pos: loop.state.pos, skills, log, maxFall, info };
}

describe('Track W3 navigator: the levels, closed loop', () => {
  it('step2: the plain plan finds nothing, the dig way digs one block and the goto arrives on top', async () => {
    const { gen, st } = stationWorld('step2');
    const run = await drive(gen, st.start, goalOf(st), { digWay: true });
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log).toHaveLength(1);
    expect(run.pos.y).toBeCloseTo(st.goal.y, 3);
    const rep = run.skills.status().lastGoto!;
    expect(rep.plans[0]!.status).not.toBe('found'); // level 0
    expect(rep.failures).toBe(0); // the level change is no failure
    expect(run.info.some((l) => l.includes('no way without digging up to 12 natural blocks'))).toBe(true);
  });

  it('step2 with the dig way off: unreachable, nothing dug', async () => {
    const { gen, st } = stationWorld('step2');
    const run = await drive(gen, st.start, goalOf(st), { digWay: false });
    expect(run.result).toEqual({ ok: false, reason: 'unreachable' });
    expect(run.log).toEqual([]);
  });

  it('step3: a 3-high step of dirt: three blocks dug, on top', async () => {
    const { gen, st } = stationWorld('step3');
    const run = await drive(gen, st.start, goalOf(st), { digWay: true });
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log).toHaveLength(3);
    expect(run.pos.y).toBeCloseTo(st.goal.y, 3);
  });

  it('drop6: the dig way digs down rather than take the 6-block fall (3 HP) the long-fall policy allows', async () => {
    const { gen, st } = stationWorld('drop6');
    const run = await drive(gen, st.start, goalOf(st), { digWay: true });
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log.length).toBeGreaterThanOrEqual(3);
    expect(run.maxFall).toBeLessThan(3.5);
    expect(run.info.some((l) => l.includes('fall of'))).toBe(false); // the FallGuard saw no fall that hurts
  });

  it('drop6 with the dig way off: level 2 takes the fall the policy allows (decision 0057)', async () => {
    const { gen, st } = stationWorld('drop6');
    const run = await drive(gen, st.start, goalOf(st), { digWay: false });
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log).toEqual([]);
    expect(run.maxFall).toBeGreaterThan(5.5);
    expect(run.info.some((l) => l.includes('no way without a fall that hurts'))).toBe(true);
  });

  it('no fall that hurts while a harmless way exists: a plateau 6 high with a staircase down its side', async () => {
    const { gen, st } = stationWorld('drop6');
    for (let i = 0; i < 5; i++) gen.fill({ x: O.x + 4, y: O.y, z: O.z + 2 + i }, { x: O.x + 4, y: O.y + 4 - i, z: O.z + 2 + i }, 'stone');
    const run = await drive(gen, st.start, goalOf(st), { digWay: true });
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log).toEqual([]); // the stairs, not the dig way
    expect(run.maxFall).toBeLessThan(3.5);
    expect(run.skills.status().lastGoto!.plans[0]!.status).toBe('found'); // level 0 found it
  });

  it('a tower too tall for the budget (20 high): the dig way cannot reach the ground, the goto still gets down', async () => {
    const gen = flatGen({ x: -32, y: -64, z: -32 }, { x: 64, y: 40, z: 64 });
    gen.fill({ x: 0, y: -60, z: 0 }, { x: 2, y: -41, z: 2 }, 'stone');
    const run = await drive(gen, { x: 1.5, y: -40, z: 1.5 }, { type: 'block', p: { x: 10, y: -60, z: 1 } }, { digWay: true, maxTicks: 6000 });
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log.length).toBeLessThanOrEqual(DIG_WAY_MAX_BLOCKS);
  });

  it('the dig-out pools with the dig way on: a stone lip by hand and a stone-brick rim stay trapped, with the W2 reason', async () => {
    for (const [name, re] of [['lipStone', /^trapped in water: no swim exit and no step to dig \(stone: no tool breaks it in time/], ['lipBuilt', /^trapped in water: no swim exit and no step to dig \(stone_bricks: protected or built/]] as const) {
      const { gen, st } = stationWorld(name);
      const run = await drive(gen, st.start, goalOf(st), { digWay: true });
      expect(run.result, run.info.join('\n')).toEqual({ ok: false, reason: 'unreachable' });
      expect(run.log, name).toEqual([]);
      expect(run.skills.status().lastGoto!.why ?? '', name).toMatch(re);
    }
  });

  it('wetGoal: a block goal in a 1-deep water floor is reached there', async () => {
    const { gen, st } = stationWorld('wetGoal');
    const run = await drive(gen, st.start, goalOf(st));
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(cell(run.pos)).toEqual(st.goal);
  });

  it('Navigator.digWay is read at every plan; off by default', () => {
    const { gen, st } = stationWorld('step2');
    const { conn, loop } = harness(st.start);
    const skills = new BotSkills({ loop, world: fakeWorld(gen) });
    expect(skills.nav.digWay()).toBe(false);
    skills.nav.digWay = () => true;
    expect(skills.nav.digWay()).toBe(true);
    conn.tick(1);
    skills.cancel();
  });
});

describe('Track W3 guards (decision 0070 "W3")', () => {
  const DOC = readFileSync(new URL('../../../../docs/pathfinding.md', import.meta.url), 'utf8');
  const ADR = readFileSync(new URL('../../../../docs/decisions/0070-water-travel.md', import.meta.url), 'utf8');
  const SETTINGS = readFileSync(new URL('../../../src/config/settings.ts', import.meta.url), 'utf8');

  it('the guide has the W3 subsection under "Water (Track W1)" naming the constants with their values; the decision has its addendum', () => {
    const w1 = DOC.indexOf('\n## Water (Track W1)\n');
    const at = DOC.indexOf('\n### When the plain walk finds no way (Track W3)\n');
    const next = DOC.indexOf('\n## ', w1 + 4);
    expect(w1).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(w1);
    expect(next < 0 || at < next).toBe(true);
    const part = DOC.slice(at, next < 0 ? undefined : next);
    for (const [k, v] of [['DIG_WAY_MAX_BLOCKS', DIG_WAY_MAX_BLOCKS], ['DIG_WAY_PENALTY', DIG_WAY_PENALTY], ['DIG_WAY_MAX_TICKS', DIG_WAY_MAX_TICKS], ['DIG_WAY_HP_COST', DIG_WAY_HP_COST]] as const) expect(part).toContain(`${k} = ${v}`);
    expect(part).toContain('digWay');
    expect(ADR).toMatch(/\n## W3: /);
  });

  it('the session setting digWay exists, default on', () => {
    expect(SETTINGS).toMatch(/digWay: \{ kind: 'boolean', default: true,/);
  });
});
