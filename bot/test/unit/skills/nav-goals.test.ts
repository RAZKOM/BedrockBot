// Task 7.10 goal types and the failure blacklist, without a server: predicates and heuristics of
// any / getToBlock / yLevel / runAway / surface, closed-loop gotos in the nav sim for each, the
// blacklist (goals, `any` members, action cells) and the report (`reached`, `skipped`, `blacklisted`).
import { describe, expect, it } from 'vitest';
import { checkReach, EYE_HEIGHT } from '../../../src/skills/dig/look.ts';
import { BotSkills, type BotSkillsOptions } from '../../../src/skills/index.ts';
import { NavBlacklist, NavGrid, blockKey, findPath, goalKey, goalTest, localGround, type NavActions, type NavGoal, type NavGotoOptions } from '../../../src/skills/nav/index.ts';
import type { InputLoop } from '../../../src/skills/input/inputLoop.ts';
import type { SkillResult } from '../../../src/skills/types.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** One bot in a generated world; several gotos in a row share the navigator (and its blacklist). */
class Sim {
  readonly h: ReturnType<typeof harness>;
  readonly skills: BotSkills;
  readonly gen: GenWorld;
  constructor(gen: GenWorld, start: Vec3, nav: Partial<BotSkillsOptions> = {}) {
    this.gen = gen;
    this.h = harness(start);
    this.skills = new BotSkills({ loop: this.h.loop, world: fakeWorld(gen), ...nav });
    this.h.conn.tick(3);
  }

  get pos(): Vec3 {
    return this.h.loop.state.pos;
  }

  async goto(goal: NavGoal, opts: NavGotoOptions = {}, maxTicks = 3000, during?: (t: number) => void): Promise<{ result: SkillResult | undefined; ticks: number }> {
    let result: SkillResult | undefined;
    const p = this.skills.goto(goal, opts).then((r) => (result = r));
    let t = 0;
    while (this.skills.nav.busy && t < maxTicks) {
      during?.(t);
      this.h.conn.tick();
      await flush();
      t++;
    }
    this.skills.cancel();
    await p;
    return { result, ticks: t };
  }

  /** Ticks with nothing running (the blacklist clock runs on). */
  async idle(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.h.conn.tick();
      if (i % 50 === 0) await flush();
    }
  }
}

const cobble = () => ({ slots: [{ name: 'cobblestone', count: 64 }], selected: 0 });

/** Pillar-up place action on a GenWorld (as in nav-v2.test.ts: the PlaceSkill jumps by itself). */
function placeActions(gen: GenWorld, log: string[], loop: InputLoop): NavActions {
  return {
    place: async (p) => {
      log.push(`place ${p.x},${p.y},${p.z}`);
      loop.setCommand({ forward: 0, jump: true });
      for (let i = 0; i < 20 && loop.state.pos.y < p.y + 1.05; i++) await loop.waitTicks(1);
      loop.setCommand({ jump: false });
      if (loop.state.pos.y < p.y + 1.05) return { ok: false, reason: 'not_above' };
      gen.set(p.x, p.y, p.z, 'cobblestone');
      return { ok: true };
    },
    throwawayItems: ['cobblestone'],
  };
}

/** A glass shell around cell p (all 26 neighbours). */
function glassShell(gen: GenWorld, p: Vec3): void {
  gen.fill({ x: p.x - 1, y: p.y - 1, z: p.z - 1 }, { x: p.x + 1, y: p.y + 1, z: p.z + 1 }, 'glass');
  gen.put(p.x, p.y, p.z, 'oak_log');
}

describe('goal predicates and heuristics', () => {
  // (Track BD's twoBlocks / threeBlocks below: nav/goals.ts, mine/baritone/mineProcess.ts)
  it('getToBlock: the 8 columns around (block at the feet or the head), on top, 2 below; in reach; never the cell itself', () => {
    const gen = flatGen();
    const grid = new NavGrid(gen);
    const t = { x: 5, y: -60, z: 5 };
    gen.put(5, -60, 5, 'stone');
    const g = goalTest({ type: 'getToBlock', p: t }, grid);
    const ok = (x: number, y: number, z: number, feet = y) => g.done(x, y, z, feet);
    expect([ok(4, -60, 5), ok(6, -60, 5), ok(5, -60, 4), ok(5, -60, 6)]).toEqual([true, true, true, true]);
    expect(ok(4, -61, 5)).toBe(true); // block at head height
    expect(ok(5, -59, 5)).toBe(true); // on top
    expect(ok(5, -62, 5)).toBe(false); // 2 below: the only face it sees is on the ground
    expect(goalTest({ type: 'getToBlock', p: t, face: false }, grid).done(5, -62, 5, -62)).toBe(true); // 2 below (block above the head)
    expect([ok(4, -60, 4), ok(6, -61, 4)]).toEqual([true, true]); // diagonals (faces west / north visible)
    expect([ok(5, -60, 5), ok(3, -60, 5), ok(4, -59, 5), ok(5, -58, 5), ok(4, -62, 5)]).toEqual([false, false, false, false, false]);
    // heuristic: octile distance to the column, minus a diagonal step
    expect(g.h(0, -60, 5)).toBeCloseTo(5 - Math.SQRT2, 9);
    expect(g.h(4, -60, 5)).toBe(0);
    expect(g.h(4, -60, 4)).toBe(0);
    // a short reach rules out standing on top (eye 1.62 above the top face)
    expect(goalTest({ type: 'getToBlock', p: t, reach: 1.5 }, grid).done(5, -59, 5, -59)).toBe(false);
  });

  it('getToBlock: a visible face when the block has one; adjacency only for a buried block', () => {
    const gen = flatGen();
    const grid = new NavGrid(gen);
    // a block whose north, east and top faces are covered with glass
    const t = { x: 5, y: -60, z: 5 };
    gen.put(5, -60, 5, 'stone');
    gen.put(5, -60, 4, 'glass');
    gen.put(6, -60, 5, 'glass');
    gen.put(5, -59, 5, 'glass');
    const g = goalTest({ type: 'getToBlock', p: t }, grid);
    expect(g.done(6, -60, 4, -60)).toBe(false); // north-east diagonal: adjacent, in reach, only covered faces in view
    expect(g.done(4, -60, 5, -60)).toBe(true); // west side
    expect(g.done(6, -60, 6, -60)).toBe(true); // south-east diagonal sees the south face
    expect(goalTest({ type: 'getToBlock', p: t, face: false }, grid).done(6, -60, 4, -60)).toBe(true);
    // fully enclosed: no face to see, adjacency is enough
    const gen2 = flatGen();
    glassShell(gen2, { x: 5, y: -59, z: 5 });
    const g2 = goalTest({ type: 'getToBlock', p: { x: 5, y: -59, z: 5 } }, new NavGrid(gen2));
    expect(g2.done(4, -60, 5, -60)).toBe(true);
  });

  it('any: done at any member, h = min, member() names the first one done', () => {
    const g = goalTest({ type: 'any', goals: [{ type: 'block', p: { x: 10, y: -60, z: 0 } }, { type: 'xz', x: -3, z: 0 }, { type: 'yLevel', y: -50 }] });
    expect(g.h(0, -60, 0)).toBe(3);
    expect(g.done(-3, -60, 0, -60)).toBe(true);
    expect(g.member!(-3, -60, 0, -60)).toBe(1);
    expect(g.member!(10, -60, 0, -60)).toBe(0);
    expect(g.member!(0, -50, 0, -50)).toBe(2);
    expect(g.member!(1, -60, 1, -60)).toBe(-1);
    expect(goalTest({ type: 'any', goals: [] }).h(0, 0, 0)).toBe(0);
  });

  it('Track BD: twoBlocks / threeBlocks (Baritone GoalTwoBlocks / MineProcess.GoalThreeBlocks): the ore column, feet in its cell or 1 / 2 below; octile heuristic; keyed by the ore; found inside stone with allowBreak', () => {
    const two = goalTest({ type: 'twoBlocks', p: { x: 5, y: -58, z: 5 } });
    expect([two.done(5, -58, 5, -58), two.done(5, -59, 5, -59), two.done(5, -60, 5, -60), two.done(4, -58, 5, -58), two.done(5, -57, 5, -57)]).toEqual([true, true, false, false, false]);
    const three = goalTest({ type: 'threeBlocks', p: { x: 5, y: -58, z: 5 } });
    expect([three.done(5, -58, 5, -58), three.done(5, -59, 5, -59), three.done(5, -60, 5, -60), three.done(5, -61, 5, -61)]).toEqual([true, true, true, false]);
    expect(three.h(0, -60, 5)).toBe(5);
    expect(two.h(5, -40, 5)).toBe(0);
    expect(goalKey({ type: 'twoBlocks', p: { x: 5, y: -58, z: 5 } })).toBe('b:5,-58,5');
    expect(goalKey({ type: 'threeBlocks', p: { x: 5, y: -58, z: 5 } })).toBe('b:5,-58,5');
    // a composite over an ore buried in stone: found with dig-through moves, the feet end in the ore's column under it
    const gen = flatGen();
    gen.fill({ x: 2, y: -60, z: -3 }, { x: 12, y: -55, z: 3 }, 'stone');
    gen.put(8, -58, 0, 'iron_ore');
    const goal: NavGoal = { type: 'any', goals: [{ type: 'threeBlocks', p: { x: 8, y: -58, z: 0 } }] };
    const r = findPath(new NavGrid(gen), { x: 0, y: -60, z: 0 }, goal, { allowBreak: true, maxNodes: 200_000, maxMs: 20_000 });
    expect(r.status).toBe('found');
    expect(r.path.at(-1)).toMatchObject({ x: 8, z: 0 });
    expect([-58, -59, -60]).toContain(r.path.at(-1)!.y);
    expect(r.path.some((n) => n.act?.dig?.length)).toBe(true);
    expect(findPath(new NavGrid(gen), { x: 0, y: -60, z: 0 }, goal, { maxNodes: 20_000 }).status).not.toBe('found');
  });

  it('yLevel and runAway', () => {
    const y = goalTest({ type: 'yLevel', y: -55 });
    expect([y.done(0, -55, 0, -55), y.done(0, -56, 0, -56), y.h(0, -60, 0), y.h(0, -50, 0)]).toEqual([true, false, 5, 5]);
    const r = goalTest({ type: 'runAway', from: { x: 0.5, y: -60, z: 0.5 }, r: 10 });
    expect(r.done(10, -60, 0, -60)).toBe(true);
    expect(r.done(5, -60, 5, -60)).toBe(false);
    expect(r.h(0, -60, 0)).toBe(10);
    expect(r.h(4, -60, 0)).toBe(6);
    // several threats: the nearest counts; a function is read when the test is built
    let calls = 0;
    const two = goalTest({ type: 'runAway', from: () => (calls++, [{ x: 0.5, y: 0, z: 0.5 }, { x: 20.5, y: 0, z: 0.5 }]), r: 10 });
    expect(calls).toBe(1);
    expect(two.done(10, -60, 0, -60)).toBe(true);
    expect(two.done(12, -60, 0, -60)).toBe(false);
    expect(goalTest({ type: 'runAway', from: () => undefined, r: 5 }).done(0, 0, 0, 0)).toBe(true);
  });

  it('surface: sky above the head and not in a pit (a step below the 25th percentile of the column tops around)', () => {
    const gen = flatGen();
    gen.fill({ x: 0, y: -64, z: 0 }, { x: 0, y: -61, z: 0 }, 'air'); // a 1 x 1 shaft, 4 deep (to the bedrock layer)
    gen.put(0, -64, 0, 'bedrock');
    gen.fill({ x: 10, y: -60, z: -2 }, { x: 14, y: -57, z: 2 }, 'stone'); // a roofed room with a cave inside
    gen.fill({ x: 11, y: -60, z: -1 }, { x: 13, y: -59, z: 1 }, 'air');
    const grid = new NavGrid(gen);
    const s = goalTest({ type: 'surface' }, grid);
    expect(localGround(grid, 0, 0)).toBe(-60);
    expect(s.done(5, -60, 5, -60)).toBe(true); // flat ground
    expect(s.done(0, -63, 0, -63)).toBe(false); // bottom of the shaft (sky above, 3 below the ground)
    expect(s.h(0, -63, 0)).toBeCloseTo(3 - 0.5625, 6);
    expect(s.done(0, -61, 0, -61)).toBe(false); // a block below the rim: not yet
    expect(s.done(0, -61, 0, -60.5)).toBe(true); // on a slab in the top cell: out
    expect(s.done(12, -60, 0, -60)).toBe(false); // under the roof
    expect(goalTest({ type: 'surface' }).done(0, -60, 0, -60)).toBe(false); // no grid: never
  });

  it('findPath with an any goal reaches the nearest member', () => {
    const gen = flatGen();
    const grid = new NavGrid(gen);
    const targets = [20, 8, 14].map((x) => ({ x, y: -60, z: 0 }));
    for (const t of targets) gen.put(t.x, t.y, t.z, 'oak_log');
    const goal: NavGoal = { type: 'any', goals: targets.map((p): NavGoal => ({ type: 'getToBlock', p })) };
    const r = findPath(grid, { x: 0, y: -60, z: 0 }, goal);
    expect(r.status).toBe('found');
    expect(r.path.at(-1)).toMatchObject({ x: 7, z: 0 });
    const end = r.path.at(-1)!;
    expect(goalTest(goal, grid).member!(end.x, end.y, end.z, end.feet)).toBe(1);
  });
});

describe('closed loop: the goal types in the nav sim', () => {
  it('any over 10 logs reaches the nearest and reports which member', async () => {
    const gen = flatGen();
    const logs: Vec3[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * 2 * Math.PI;
      const d = 8 + ((i * 7) % 10) * 2; // 8..26 blocks, member 0 is the nearest
      logs.push({ x: Math.round(Math.cos(a) * d), y: -60, z: Math.round(Math.sin(a) * d) });
    }
    for (const p of logs) gen.fill(p, { ...p, y: -56 }, 'oak_log');
    const nearest = logs.reduce((b, p, i) => (Math.hypot(p.x, p.z) < Math.hypot(logs[b]!.x, logs[b]!.z) ? i : b), 0);
    const sim = new Sim(gen, { x: 0.5, y: -60, z: 0.5 });
    const run = await sim.goto({ type: 'any', goals: logs.map((p) => ({ type: 'getToBlock', p })) });
    expect(run.result).toEqual({ ok: true });
    const rep = sim.skills.status().lastGoto!;
    expect(rep.reached?.index).toBe(nearest);
    const t = logs[nearest]!;
    const eye = { x: sim.pos.x, y: sim.pos.y + EYE_HEIGHT, z: sim.pos.z };
    expect(checkReach(eye, t, 4.5).ok).toBe(true);
    expect(Math.max(Math.abs(Math.floor(sim.pos.x) - t.x), Math.abs(Math.floor(sim.pos.z) - t.z))).toBe(1);
  });

  it('getToBlock stands next to the block with a visible face (not at the diagonal that sees only glass)', async () => {
    const gen = flatGen();
    const t = { x: 0, y: -60, z: 10 };
    gen.put(t.x, t.y, t.z, 'stone');
    gen.put(0, -60, 9, 'glass'); // north
    gen.put(-1, -60, 10, 'glass'); // west
    gen.put(0, -59, 10, 'glass'); // top
    const sim = new Sim(gen, { x: -3.5, y: -60, z: 6.5 });
    const run = await sim.goto({ type: 'getToBlock', p: t });
    expect(run.result).toEqual({ ok: true });
    const c = { x: Math.floor(sim.pos.x), z: Math.floor(sim.pos.z) };
    expect(Math.max(Math.abs(c.x - t.x), Math.abs(c.z - t.z))).toBe(1);
    expect(c).not.toEqual({ x: -1, z: 9 }); // the nearest adjacent cell sees only glass
    const eye = { x: sim.pos.x, y: sim.pos.y + EYE_HEIGHT, z: sim.pos.z };
    expect(checkReach(eye, t, 4.5).ok).toBe(true);
  });

  it('yLevel climbs a staircase (feet -59, -58, -57, -56) and stops at the first cell at -57', async () => {
    const gen = flatGen();
    for (let i = 0; i < 4; i++) gen.fill({ x: -2, y: -60, z: 6 + i }, { x: 2, y: -60 + i, z: 6 + i }, 'stone');
    gen.fill({ x: -2, y: -60, z: 10 }, { x: 2, y: -57, z: 14 }, 'stone');
    const sim = new Sim(gen, { x: 0.5, y: -60, z: 0.5 });
    const run = await sim.goto({ type: 'yLevel', y: -57 });
    expect(run.result).toEqual({ ok: true });
    expect(sim.pos.y).toBeCloseTo(-57, 3);
    expect(Math.floor(sim.pos.z)).toBe(8); // the first step at feet -57, not the steps or the plateau above it
  });

  it('runAway from a point gains at least the radius, away from the threat', async () => {
    const gen = flatGen();
    const sim = new Sim(gen, { x: 0.5, y: -60, z: 0.5 });
    const threat = { x: -1.5, y: -60, z: 0.5 };
    const d0 = Math.hypot(sim.pos.x - threat.x, sim.pos.z - threat.z);
    const run = await sim.goto({ type: 'runAway', from: threat, r: 16 });
    expect(run.result).toEqual({ ok: true });
    const d1 = Math.hypot(sim.pos.x - threat.x, sim.pos.z - threat.z);
    expect(d1).toBeGreaterThanOrEqual(16 - 0.5);
    expect(d1 - d0).toBeGreaterThanOrEqual(16 - d0 - 0.5);
    expect(sim.pos.x).toBeGreaterThan(10); // straight away (+x), not around the threat
  });

  it('runAway from a moving threat (a function) plans on when the threat has followed', async () => {
    const gen = flatGen();
    const sim = new Sim(gen, { x: 0.5, y: -60, z: 0.5 });
    let threat: Vec3 = { x: -1.5, y: -60, z: 0.5 };
    let jumped = false;
    const run = await sim.goto({ type: 'runAway', from: () => threat, r: 10 }, {}, 3000, () => {
      if (!jumped && sim.pos.x > 6) {
        jumped = true;
        threat = { x: 9.5, y: -60, z: 0.5 }; // it caught up (in front of where the plan ends)
      }
    });
    expect(run.result).toEqual({ ok: true });
    expect(jumped).toBe(true);
    expect(Math.hypot(sim.pos.x - threat.x, sim.pos.z - threat.z)).toBeGreaterThanOrEqual(10 - 0.5);
  });

  it('surface: out of a 4-deep shaft by pillaring (unreachable without blocks)', async () => {
    const shaft = () => {
      const gen = flatGen({ x: -16, y: -67, z: -16 }, { x: 32, y: 27, z: 32 });
      gen.fill({ x: -16, y: -67, z: -16 }, { x: 15, y: -65, z: 15 }, 'stone');
      gen.fill({ x: 0, y: -64, z: 0 }, { x: 0, y: -61, z: 0 }, 'air');
      return gen;
    };
    const none = await new Sim(shaft(), { x: 0.5, y: -64, z: 0.5 }).goto({ type: 'surface' }, { allowPlace: true });
    expect(none.result).toEqual({ ok: false, reason: 'unreachable' });
    const gen = shaft();
    const log: string[] = [];
    const h = harness({ x: 0.5, y: -64, z: 0.5 });
    const skills = new BotSkills({ loop: h.loop, world: fakeWorld(gen), actions: placeActions(gen, log, h.loop), inventory: cobble });
    h.conn.tick(3);
    let result: SkillResult | undefined;
    const p = skills.goto({ type: 'surface' }, { allowPlace: true }).then((r) => (result = r));
    for (let t = 0; t < 3000 && skills.nav.busy; t++) {
      h.conn.tick();
      await flush();
    }
    await p;
    expect(result, log.join('\n')).toEqual({ ok: true });
    expect(h.loop.state.pos.y).toBeCloseTo(-60, 3); // on a pillar flush with the ground around
    expect(log.length).toBeGreaterThanOrEqual(3);
  });

  it('surface: out of a cave to the open sky; already there = done at once', async () => {
    const gen = flatGen();
    gen.fill({ x: -3, y: -60, z: -3 }, { x: 3, y: -57, z: 12 }, 'stone');
    gen.fill({ x: -2, y: -60, z: -2 }, { x: 2, y: -59, z: 2 }, 'air'); // a room
    gen.fill({ x: 0, y: -60, z: 3 }, { x: 0, y: -59, z: 12 }, 'air'); // a tunnel out to +z
    const sim = new Sim(gen, { x: 0.5, y: -60, z: 0.5 });
    const run = await sim.goto({ type: 'surface' });
    expect(run.result).toEqual({ ok: true });
    expect(sim.skills.nav.grid.underground(Math.floor(sim.pos.x), Math.floor(sim.pos.z), sim.pos.y)).toBe(false);
    expect(sim.pos.z).toBeGreaterThan(12);
    const again = await sim.goto({ type: 'surface' });
    expect(again.result).toEqual({ ok: true });
    expect(again.ticks).toBeLessThan(10);
  });
});

describe('blacklist', () => {
  it('counts failures, skips after N for `ticks`, a success or the expiry forgets', () => {
    let now = 0;
    const b = new NavBlacklist({ failures: 3, ticks: 100, now: () => now });
    expect(b.fail('b:1,2,3')).toBe(false);
    expect(b.fail('b:1,2,3')).toBe(false);
    expect(b.has('b:1,2,3')).toBe(false);
    expect(b.fail('b:1,2,3', 'unreachable')).toBe(true);
    expect(b.has('b:1,2,3')).toBe(true);
    expect(b.blocked({ x: 1.5, y: 2, z: 3.9 })).toBe(true);
    expect(b.size).toBe(1);
    expect(b.list()[0]).toMatchObject({ key: 'b:1,2,3', fails: 3, until: 100, why: 'unreachable' });
    now = 99;
    expect(b.has('b:1,2,3')).toBe(true);
    now = 100;
    expect(b.has('b:1,2,3')).toBe(false);
    expect(b.count('b:1,2,3')).toBe(0);
    b.fail('b:4,5,6');
    b.fail('b:4,5,6');
    b.succeed('b:4,5,6');
    expect(b.count('b:4,5,6')).toBe(0);
    // failures far apart (more than `ticks`) never add up
    b.fail('xz:1,1');
    now = 300;
    b.fail('xz:1,1');
    expect(b.count('xz:1,1')).toBe(1);
    // action cells as planner sets
    b.fail('dig:1,-60,2');
    b.fail('dig:1,-60,2');
    b.fail('dig:1,-60,2');
    expect(b.cells('dig').size).toBe(1);
    expect(b.cells('place').size).toBe(0);
  });

  it('goal keys', () => {
    expect(goalKey({ type: 'block', p: { x: 1.5, y: -60, z: -2.5 } })).toBe('b:1,-60,-3');
    expect(goalKey({ type: 'near', p: { x: 1.5, y: -60, z: 2.5 }, r: 2 })).toBe('b:1,-60,2');
    expect(goalKey({ type: 'getToBlock', p: { x: 1, y: -60, z: 2 } })).toBe(blockKey({ x: 1, y: -60, z: 2 }));
    expect(goalKey({ type: 'xz', x: 3, z: 4 })).toBe('xz:3,4');
    expect(goalKey({ type: 'yLevel', y: -40 })).toBe('y:-40');
    expect(goalKey({ type: 'surface' })).toBeUndefined();
    expect(goalKey({ type: 'runAway', from: { x: 0, y: 0, z: 0 }, r: 3 })).toBeUndefined();
  });

  it('an unreachable log (walled in glass) is blacklisted after 3 failures; the next any goto skips it', async () => {
    const gen = flatGen();
    const walled = { x: 4, y: -60, z: 0 };
    glassShell(gen, walled);
    const open = { x: 12, y: -60, z: 6 };
    gen.put(open.x, open.y, open.z, 'oak_log');
    const sim = new Sim(gen, { x: 0.5, y: -60, z: 0.5 }, { unloadedWaitTicks: 0 });
    for (let i = 1; i <= 3; i++) {
      const r = await sim.goto({ type: 'getToBlock', p: walled }, { timeoutTicks: 1200 });
      expect(r.result).toEqual({ ok: false, reason: 'unreachable' });
      expect(sim.skills.nav.blacklist.count(blockKey(walled))).toBe(i);
    }
    expect(sim.skills.nav.blacklist.blocked(walled)).toBe(true);
    expect(sim.skills.status().lastGoto!.blacklisted).toEqual([blockKey(walled)]);
    const r = await sim.goto({ type: 'any', goals: [{ type: 'getToBlock', p: walled }, { type: 'getToBlock', p: open }] });
    expect(r.result).toEqual({ ok: true });
    const rep = sim.skills.status().lastGoto!;
    expect(rep.skipped).toEqual([blockKey(walled)]);
    expect(rep.reached?.index).toBe(1);
    // the goal alone: refused at once
    const again = await sim.goto({ type: 'getToBlock', p: walled });
    expect(again.result).toEqual({ ok: false, reason: 'blacklisted' });
    expect(again.ticks).toBe(0);
    // ... until it expires (6000 ticks by default; this navigator's clock)
    await sim.idle(6000);
    expect(sim.skills.nav.blacklist.blocked(walled)).toBe(false);
  }, 30_000);

  it('plain block / near / xz gotos neither consult nor feed it unless asked', async () => {
    const gen = flatGen();
    const sealed = { x: 6, y: -60, z: 0 };
    gen.fill({ x: 5, y: -60, z: -1 }, { x: 7, y: -58, z: 1 }, 'stone');
    gen.put(6, -60, 0, 'air');
    gen.put(6, -59, 0, 'air');
    const sim = new Sim(gen, { x: 0.5, y: -60, z: 0.5 }, { unloadedWaitTicks: 0 });
    await sim.goto({ type: 'block', p: sealed });
    expect(sim.skills.nav.blacklist.count(blockKey(sealed))).toBe(0);
    await sim.goto({ type: 'block', p: sealed }, { blacklist: true });
    expect(sim.skills.nav.blacklist.count(blockKey(sealed))).toBe(1);
  }, 30_000);

  it('an `any` that ends unreachable blames the member it was heading for', async () => {
    const gen = flatGen();
    const a = { x: 5, y: -60, z: 0 };
    const b = { x: -20, y: -60, z: 0 };
    glassShell(gen, a);
    glassShell(gen, b);
    const sim = new Sim(gen, { x: 0.5, y: -60, z: 0.5 }, { unloadedWaitTicks: 0 });
    const r = await sim.goto({ type: 'any', goals: [{ type: 'getToBlock', p: a }, { type: 'getToBlock', p: b }] }, { timeoutTicks: 1200 });
    expect(r.result?.ok).toBe(false);
    expect(sim.skills.nav.blacklist.count(blockKey(a))).toBe(1);
    expect(sim.skills.nav.blacklist.count(blockKey(b))).toBe(0);
  }, 30_000);

  it('a dig that keeps failing at a cell is blacklisted: the planner stops planning through it', async () => {
    const gen = flatGen();
    // a 3-high dirt wall across x -20..20 at z 6, the goal behind it: digging through is the short way
    gen.fill({ x: -20, y: -60, z: 6 }, { x: 20, y: -58, z: 6 }, 'dirt');
    const digs: string[] = [];
    const actions: NavActions = {
      dig: (p) => {
        digs.push(`${p.x},${p.y},${p.z}`);
        return Promise.resolve({ ok: false, reason: 'refused' });
      },
    };
    const sim = new Sim(gen, { x: 0.5, y: -60, z: 0.5 }, { actions, unloadedWaitTicks: 0, maxFailures: 1 });
    const goal: NavGoal = { type: 'block', p: { x: 0, y: -60, z: 12 } };
    for (let i = 0; i < 3; i++) await sim.goto(goal, { allowBreak: true, timeoutTicks: 1500 });
    const first = digs[0]!;
    expect(digs.filter((d) => d === first).length).toBe(3);
    expect(sim.skills.nav.blacklist.has(`dig:${first}`)).toBe(true);
    digs.length = 0;
    await sim.goto(goal, { allowBreak: true, timeoutTicks: 1500 });
    expect(digs).not.toContain(first);
  }, 60_000);
});
