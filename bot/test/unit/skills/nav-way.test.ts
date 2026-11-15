// Track W2 way (docs/pathfinding.md "A walk keeps to its way", decisions/0088-a-walk-keeps-to-its-way.md): the whole way
// a goto walks, kept. The rules of nav/way.ts, then closed loops in made-up worlds (FakeConnection -> InputLoop with the
// own physics <- BotSkills / Navigator): a handed way walked with no search, kept against a fresh plan within the
// margin and replaced beyond it, not walked from elsewhere or when a node of it changed; the goto's own way rejoined
// after a teleport off it; a walk taken up again (`resume`) on its way; the plan line at INFO; the dive off a pool's rim;
// the move timeout of a drop beside lava; the guards (the guide and the decision name the constants with their values).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BotSkills, type SkillResult } from '../../../src/skills/index.ts';
import { initialBody, stepBody, type MoveCommand } from '../../../src/skills/input/index.ts';
import type { PathNode } from '../../../src/skills/nav/astar.ts';
import { PathFollower } from '../../../src/skills/nav/follower.ts';
import type { NavGoal } from '../../../src/skills/nav/goals.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { DROP_CREEP_TICKS, type GotoReport, type NavGotoOptions } from '../../../src/skills/nav/navigator.ts';
import {
  FOUND_WAY_MS,
  KEEP_MARGIN,
  KEEP_MIN_BLOCKS,
  REJOIN_MAX,
  REJOIN_MS,
  REJOIN_NODES,
  RESUME_KEEP_MS,
  WAY_AHEAD,
  WAY_BACK,
  WAY_ON_H,
  WAY_ON_V,
  clearlyShorter,
  nearestOnWay,
  nodeOnWay,
  wayActions,
  wayBlocks,
  wayBroken,
  wayFrom,
  wayFromHere,
} from '../../../src/skills/nav/way.ts';
import { blockQueryOf } from '../../../src/skills/terrain/query.ts';
import type { Logger } from '../../../src/log.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const FEET = -60;
const node = (x: number, z: number, move: PathNode['move'] = 'walk', feet = FEET): PathNode => ({ x, y: Math.floor(feet), z, feet, move, cost: 4.6 });
const line = (n: number, x = 0): PathNode[] => Array.from({ length: n }, (_, i) => node(x, i, i === 0 ? 'start' : 'walk'));

describe('the rules (nav/way.ts)', () => {
  it('blocks of a way: the polyline of its node centres', () => {
    expect(wayBlocks(line(11))).toBeCloseTo(10, 6);
    expect(wayBlocks(line(11), 4)).toBeCloseTo(6, 6);
    expect(wayBlocks(line(11), 0, 3)).toBeCloseTo(3, 6);
    expect(wayBlocks([node(0, 0), node(1, 1, 'diag'), node(1, 1, 'drop', FEET - 1)])).toBeCloseTo(Math.SQRT2 + 1, 6);
  });

  it('the node the body stands on: the nearest within 1 by the plane and 0.6 by height, the later on a tie', () => {
    const w = line(10);
    expect(nodeOnWay(w, { x: 0.5, y: FEET, z: 4.5 }, 0, 9)).toBe(4);
    expect(nodeOnWay(w, { x: 0.5, y: FEET, z: 5 }, 0, 9)).toBe(5); // halfway between 4 and 5: the later
    expect(nodeOnWay(w, { x: 1.4, y: FEET, z: 4.5 }, 0, 9)).toBe(4);
    expect(nodeOnWay(w, { x: 1.6, y: FEET, z: 4.5 }, 0, 9)).toBe(-1);
    expect(nodeOnWay(w, { x: 0.5, y: FEET + 0.5, z: 4.5 }, 0, 9)).toBe(4); // a slab's half
    expect(nodeOnWay(w, { x: 0.5, y: FEET + 1, z: 4.5 }, 0, 9)).toBe(-1); // a level over it: its drop would be 1 deeper
    expect(nodeOnWay(w, { x: 0.5, y: FEET, z: 5.8 }, 6, 9)).toBe(6); // only the window
    expect(nodeOnWay(w, { x: 0.5, y: FEET, z: 4.5 }, 6, 9)).toBe(-1);
  });

  it('the nearest node for a rejoin: within REJOIN_MAX by the straight line', () => {
    const w = line(20);
    expect(nearestOnWay(w, { x: 5.5, y: FEET, z: 10.5 }, 0, 19)).toEqual({ i: 10, d: 5 });
    expect(nearestOnWay(w, { x: 9.5, y: FEET, z: 10.5 }, 0, 19)).toBeUndefined();
    expect(nearestOnWay(w, { x: 5.5, y: FEET, z: 10.5 }, 12, 19)!.i).toBe(12);
  });

  it('a broken way: the first node a body can no longer stand in (actions and water moves not looked at)', () => {
    const gen = flatGen();
    const grid = new NavGrid(gen);
    const w = line(10);
    expect(wayBroken(grid, w, 0)).toBe(-1);
    gen.put(0, FEET + 1, 6, 'stone'); // the head room of node 6
    grid.clear();
    expect(wayBroken(grid, w, 0)).toBe(6);
    expect(wayBroken(grid, w, 6)).toBe(-1); // from node 6 on: the nodes after it
    const dug = line(10).map((n, i) => (i === 6 ? { ...n, act: { dig: [{ x: 0, y: FEET + 1, z: 6 }] } } : n));
    expect(wayBroken(grid, dug, 0)).toBe(-1);
  });

  it('a fresh plan replaces a kept way only when shorter by 20 % and 8 blocks', () => {
    expect(KEEP_MARGIN).toBe(0.2);
    expect(KEEP_MIN_BLOCKS).toBe(8);
    expect(clearlyShorter(79, 100)).toBe(true);
    expect(clearlyShorter(81, 100)).toBe(false);
    expect(clearlyShorter(31, 40)).toBe(true);
    expect(clearlyShorter(32, 40)).toBe(false);
    expect(clearlyShorter(20, 27)).toBe(false); // 26 % shorter, but 7 blocks
  });

  it('actions on a way, and the way from a node (the move into it done)', () => {
    const w = line(6).map((n, i) => (i === 2 ? { ...n, act: { dig: [{ x: 0, y: FEET, z: 2 }, { x: 0, y: FEET + 1, z: 2 }] } } : i === 4 ? { ...n, act: { use: [{ x: 0, y: FEET, z: 4 }] } } : n));
    expect(wayActions(w)).toBe(3);
    expect(wayActions(w, 2)).toBe(1);
    const from = wayFrom(w, 2);
    expect(from[0]).toEqual({ x: 0, y: FEET, z: 2, feet: FEET, move: 'start', cost: 0 });
    expect(from.length).toBe(4);
    expect(wayFrom(w, 0)).toEqual(w);
  });

  it('the found way handed to a walk: the newest for the same goal that starts where the body stands', () => {
    const goal = { x: 0, y: FEET, z: 9 };
    const a = { path: line(10), goal, at: 1000 };
    const b = { path: line(10), goal, at: 2000 };
    const other = { path: line(10), goal: { x: 5, y: FEET, z: 9 }, at: 3000 };
    const at = { x: 0.5, y: FEET, z: 0.5 };
    expect(wayFromHere([a, b, other], at, goal, 3000)).toBe(b.path);
    expect(wayFromHere([a, b], { x: 3, y: FEET, z: 0.5 }, goal, 3000)).toBeUndefined(); // 2.5 from its start
    expect(wayFromHere([a], at, goal, 1000 + FOUND_WAY_MS + 1)).toBeUndefined();
    expect(wayFromHere([other], at, goal, 3000)).toBeUndefined();
  });
});

// ---- closed loops ---------------------------------------------------------------------------------------------------

interface Run {
  result: SkillResult | undefined;
  ticks: number;
  rep: GotoReport;
  pos: Vec3;
  /** The body's feet every tick (for "went through the gap at x"). */
  trail: Vec3[];
  lines: string[];
}

function logger(lines: string[]): Logger {
  const put = (m: string): void => {
    lines.push(m);
  };
  const l = { debug: () => undefined, info: put, warn: put, error: put, child: () => l } as unknown as Logger;
  return l;
}

/** A goto in `gen` from `start` (a resume: the second goto after a cancel at tick `cancelAt`, with `resume`). */
async function drive(gen: GenWorld, start: Vec3, goal: NavGoal, o: { goto?: NavGotoOptions; keepWays?: boolean; during?: (t: number, h: ReturnType<typeof harness>) => void; cancelAt?: number; again?: NavGotoOptions; maxTicks?: number } = {}): Promise<Run> {
  const h = harness(start);
  const lines: string[] = [];
  const skills = new BotSkills({ loop: h.loop, world: fakeWorld(gen), logger: logger(lines) });
  if (o.keepWays === false) skills.nav.keepWays = false;
  h.conn.tick(3);
  let result: SkillResult | undefined;
  let gen1 = 0;
  const go = (opts: NavGotoOptions | undefined): void => {
    const g = ++gen1;
    void skills.goto(goal, opts).then((r) => {
      if (g === gen1) result = r;
    });
  };
  go(o.goto);
  const trail: Vec3[] = [];
  let t = 0;
  const max = o.maxTicks ?? 3000;
  while ((skills.nav.busy || result === undefined) && t < max) {
    o.during?.(t, h);
    if (o.cancelAt !== undefined && t === o.cancelAt) {
      gen1++;
      skills.cancel();
      await flush();
      go(o.again);
    }
    h.conn.tick();
    await flush();
    trail.push({ ...h.loop.state.pos });
    t++;
  }
  skills.cancel();
  return { result, ticks: t, rep: skills.status().lastGoto!, pos: h.loop.state.pos, trail, lines };
}

/** A flat world with a wall across z = 15 (x -30 to 30, 3 high) and gaps (1 wide) at the given x. */
function walled(gaps: number[]): GenWorld {
  const gen = flatGen();
  gen.fill({ x: -30, y: FEET, z: 15 }, { x: 30, y: FEET + 2, z: 15 }, 'stone');
  for (const x of gaps) gen.fill({ x, y: FEET, z: 15 }, { x, y: FEET + 2, z: 15 }, 'air');
  return gen;
}

/** The goto's own plan from `start` in `gen` (the way a probe would hand). */
function planIn(gen: GenWorld, start: Vec3, goal: NavGoal): PathNode[] {
  const h = harness(start);
  const skills = new BotSkills({ loop: h.loop, world: fakeWorld(gen) });
  h.conn.tick(3);
  const r = skills.nav.plan(goal)!;
  expect(r.status).toBe('found');
  return r.path;
}

const START = { x: 0.5, y: FEET, z: 0.5 };
const GOAL: NavGoal = { type: 'block', p: { x: 0, y: FEET, z: 30 } };
/** The body went through the wall at x (its feet within 0.8 of the gap's centre while crossing z 15). */
const through = (r: Run, x: number): boolean => r.trail.some((p) => p.z > 15 && p.z < 16 && Math.abs(p.x - (x + 0.5)) < 0.8);
const searched = (rep: GotoReport) => rep.plans.filter((p) => !p.way && !p.kept);

describe('a handed way (GotoOptions.way)', () => {
  it('is walked from the node the body stands on, with no search of its own, through the gap it takes', async () => {
    const way = planIn(walled([4]), START, GOAL); // the way through x 4 (the direct gap closed)
    const run = await drive(walled([0, 4]), START, GOAL, { goto: { way } });
    expect(run.result).toEqual({ ok: true });
    expect(run.rep.plans[0]).toMatchObject({ reason: 'start', way: 'on', status: 'found', expanded: 0 });
    expect(searched(run.rep)).toEqual([]); // the fresh plan beside it is the only search, and the way stayed
    expect(run.rep.plans.find((p) => p.kept)?.kept).toBe('way');
    expect(through(run, 4)).toBe(true); // a fresh plan goes through x 0: 30.0 blocks against the way's 31.1
    expect(run.lines.some((l) => /walking the handed way from node 0 of \d+ \(start\)/.test(l))).toBe(true);
    const before = await drive(walled([0, 4]), START, GOAL, { goto: { way }, keepWays: false });
    expect(through(before, 0)).toBe(true);
  });

  it('a fresh plan clearly shorter replaces it where the two meet', async () => {
    const way = planIn(walled([18]), START, GOAL); // 2 x 23.4 against 30: 36 % longer, 17 blocks
    const run = await drive(walled([0, 18]), START, GOAL, { goto: { way } });
    expect(run.result).toEqual({ ok: true });
    expect(run.rep.plans[0]!.way).toBe('on');
    expect(run.rep.plans.find((p) => p.kept)?.kept).toBe('fresh');
    expect(through(run, 0)).toBe(true);
    expect(run.lines.some((l) => l.includes('the fresh plan is clearly shorter'))).toBe(true);
  });

  it('is not walked from where the body does not stand on it or near it', async () => {
    const way = planIn(walled([4]), START, GOAL);
    const run = await drive(walled([0, 4]), { x: 20.5, y: FEET, z: 0.5 }, GOAL, { goto: { way } });
    expect(run.result).toEqual({ ok: true });
    expect(run.rep.plans[0]!.way).toBeUndefined();
    expect(run.lines.some((l) => l.includes('off its way by more than 8 blocks'))).toBe(true);
  });

  it('is not walked when a node of it can no longer be stood in', async () => {
    const way = planIn(walled([4]), START, GOAL);
    const gen = walled([0, 4]);
    const n = way[Math.floor(way.length / 2)]!;
    gen.put(n.x, n.y + 1, n.z, 'stone');
    const run = await drive(gen, START, GOAL, { goto: { way } });
    expect(run.result).toEqual({ ok: true });
    expect(run.rep.plans[0]!.way).toBeUndefined();
    expect(run.lines.some((l) => /of its way \(.*\) can no longer be stood on: planning afresh/.test(l))).toBe(true);
  });
});

describe('the kept way after a correction, and a resume', () => {
  const tp = (dx: number) => (t: number, h: ReturnType<typeof harness>) => {
    if (t !== 30) return;
    const p = h.loop.state.pos;
    h.conn.receive('move_player', { runtime_id: 7, position: { x: p.x + dx, y: FEET + 1.62, z: p.z }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'teleport', on_ground: true, ridden_runtime_id: 0, tick: 0n });
  };
  const tpAt = (x: number) => (t: number, h: ReturnType<typeof harness>) => {
    if (t !== 30) return;
    h.conn.receive('move_player', { runtime_id: 7, position: { x, y: FEET + 1.62, z: h.loop.state.pos.z }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'teleport', on_ground: true, ridden_runtime_id: 0, tick: 0n });
  };

  it('a teleport 4 to 6 blocks off a handed way: rejoined by a small search a few nodes on, the gap it took kept', async () => {
    const way = planIn(walled([4]), START, GOAL);
    const run = await drive(walled([0, 4]), START, GOAL, { goto: { way }, during: tpAt(-4.5) });
    expect(run.result).toEqual({ ok: true });
    const re = run.rep.plans.filter((p) => p.reason === 'correction');
    expect(re.length).toBe(1);
    expect(re[0]!.way).toBe('rejoin');
    expect(re[0]!.expanded).toBeLessThan(REJOIN_NODES);
    expect(run.lines.some((l) => /blocks off its way at .* \(correction\): rejoining it/.test(l))).toBe(true);
    expect(through(run, 4)).toBe(true);
    const before = await drive(walled([0, 4]), START, GOAL, { goto: { way }, during: tpAt(-4.5), keepWays: false });
    expect(before.rep.plans.find((p) => p.reason === 'correction')!.way).toBeUndefined();
  });

  it('a teleport off the goto\'s own way: planned afresh, as before (a rejoin\'s kink sent the pure pursuit off the path again)', async () => {
    const run = await drive(flatGen(), START, GOAL, { during: tp(5) });
    expect(run.result).toEqual({ ok: true });
    const re = run.rep.plans.filter((p) => p.reason === 'correction');
    expect(re.length).toBe(1);
    expect(re[0]!.way).toBeUndefined();
  });

  it('a teleport farther than REJOIN_MAX off a handed way: planned afresh', async () => {
    const way = planIn(walled([4]), START, GOAL);
    const run = await drive(walled([0, 4]), START, GOAL, { goto: { way }, during: tp(-(REJOIN_MAX + 3)) });
    expect(run.result).toEqual({ ok: true });
    expect(run.rep.plans.find((p) => p.reason === 'correction')!.way).toBeUndefined();
  });

  it('a walk taken up again (`resume`) walks on along the way the interrupted goto was walking', async () => {
    const way = planIn(walled([4]), START, GOAL);
    const run = await drive(walled([0, 4]), START, GOAL, { goto: { way }, cancelAt: 40, again: { resume: true } });
    expect(run.result).toEqual({ ok: true });
    // (the body coasted on after the cancel: on the way again where it stands, or rejoined a node or two on)
    expect(['on', 'rejoin']).toContain(run.rep.plans[0]!.way);
    expect(run.lines.some((l) => /walking the resumed way from node \d+|\(start\): rejoining it/.test(l))).toBe(true);
    expect(searched(run.rep)).toEqual([]);
    expect(through(run, 4)).toBe(true);
    // without `resume` the second goto plans afresh (the way of the first is not handed to every goto)
    const plain = await drive(walled([0, 4]), START, GOAL, { goto: { way }, cancelAt: 40, again: {} });
    expect(plain.rep.plans[0]!.way).toBeUndefined();
  });
});

describe('the plan line', () => {
  it('every plan of a walk to a place is one INFO line with its blocks and its end', async () => {
    const run = await drive(walled([0]), START, GOAL);
    const plans = run.lines.filter((l) => l.startsWith("goto: plan ("));
    expect(plans.length).toBe(run.rep.plans.length);
    expect(plans[0]).toMatch(/^goto: plan \(start[^)]*\) found, \d+ nodes, [\d.]+ blocks, \d+ expanded, .*, ends /);
  });
});

describe('the dive off a pool\'s rim (follower.ts dive)', () => {
  /** A 1 x 1 pool two deep at (0, 1), the body standing on its rim with its box 0.03 over the block at z 0. */
  function rim(): { grid: NavGrid; gen: GenWorld; path: PathNode[] } {
    const gen = flatGen();
    gen.put(0, FEET - 1, 1, 'water');
    gen.put(0, FEET - 2, 1, 'water');
    gen.put(0, FEET - 3, 1, 'stone');
    const grid = new NavGrid(gen);
    return { grid, gen, path: [node(0, 1, 'start'), node(0, 1, 'dive', FEET - 2)] };
  }

  it('no sneak on dry ground over the column: the body steps off the rim into the water (it timed out sneaking)', () => {
    const { grid, gen, path } = rim();
    const f = new PathFollower(path, grid);
    const q = blockQueryOf(gen);
    let s = initialBody({ x: 0.5, y: FEET, z: 1.27 }, true);
    let wet = -1;
    let sneaked = false;
    for (let t = 0; t < 40 && wet < 0; t++) {
      const cmd = f.step(s, 0).cmd;
      sneaked ||= cmd.sneak === true && s.onGround;
      s = stepBody(s, { ...cmd, sneak: cmd.sneak ?? false } as MoveCommand, q).state;
      if (s.inWater) wet = t;
    }
    expect(sneaked).toBe(false);
    expect(wet).toBeGreaterThanOrEqual(0);
    expect(wet).toBeLessThan(20);
  });

  it('in the water above the node it still sinks with sneak (W1 as it was)', () => {
    const { grid, path } = rim();
    const f = new PathFollower(path, grid);
    const cmd = f.step({ pos: { x: 0.5, y: FEET - 1, z: 1.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: false, collidedHorizontally: false, inWater: true }, 0).cmd;
    expect(cmd.sneak).toBe(true);
    expect(cmd.forward).toBe(0);
  });
});

describe('the move timeout of a drop beside lava', () => {
  it('counts the creep off its edge (DROP_CREEP_TICKS), a drop with nothing beside it does not', () => {
    expect(DROP_CREEP_TICKS).toBe(30);
    const gen = flatGen();
    gen.put(3, FEET - 2, 1, 'lava');
    const grid = new NavGrid(gen);
    const f = new PathFollower([node(0, 0, 'start'), node(2, 0, 'drop', FEET - 1), node(4, 0, 'drop', FEET - 1)], grid);
    expect(f.creepsInto(node(2, 0, 'drop', FEET - 1))).toBe(true);
    expect(f.creepsInto(node(6, 0, 'drop', FEET - 1))).toBe(false);
    expect(f.creepsInto(node(2, 0, 'walk'))).toBe(false);
  });
});

describe('Track W2 way guards (decision 0088)', () => {
  const read = (p: string): string => readFileSync(new URL(`../../../../docs/${p}`, import.meta.url), 'utf8');
  /** The guide's section, to the next `## ` heading. */
  const wayGuide = (doc: string): string => {
    const at = doc.indexOf('### A walk keeps to its way');
    if (at < 0) return '';
    const end = doc.indexOf('\n## ', at);
    return doc.slice(at, end < 0 ? undefined : end);
  };

  it('the guide and the decision name the constants with their values', () => {
    const [DOC, FLIGHT, ADR] = [read('pathfinding.md'), read('flight.md'), read('decisions/0088-a-walk-keeps-to-its-way.md')];
    const section = wayGuide(DOC);
    expect(section.length).toBeGreaterThan(100);
    for (const [name, v] of [
      ['KEEP_MARGIN', String(KEEP_MARGIN)],
      ['KEEP_MIN_BLOCKS', String(KEEP_MIN_BLOCKS)],
      ['REJOIN_MAX', String(REJOIN_MAX)],
      ['WAY_AHEAD', String(WAY_AHEAD)],
      ['WAY_BACK', String(WAY_BACK)],
      ['RESUME_KEEP_MS', String(RESUME_KEEP_MS)],
      ['DROP_CREEP_TICKS', String(DROP_CREEP_TICKS)],
    ] as const) {
      expect(section).toMatch(new RegExp(`${name}\\D{0,12}${v.replace('.', '\\.')}`));
      expect(ADR).toContain(name);
    }
    expect(section).toContain(`${WAY_ON_H}`);
    expect(section).toContain(`${WAY_ON_V}`);
    expect(section).toContain(`${REJOIN_NODES}`);
    expect(section).toContain(`${REJOIN_MS}`);
    expect(FLIGHT).toContain('The walk after a landing takes the probe\'s way');
    expect(FLIGHT).toContain(`${FOUND_WAY_MS / 60_000} minutes`);
  });

  it('the guide and the decision name no place of the owner\'s world', () => {
    const [DOC, ADR] = [read('pathfinding.md'), read('decisions/0088-a-walk-keeps-to-its-way.md')];
    const section = wayGuide(DOC);
    expect(section.length).toBeGreaterThan(100);
    for (const text of [section, ADR]) expect(text).not.toMatch(/\b\d{3} -?\d{1,3} -?\d{2,3}\b/);
  });
});
