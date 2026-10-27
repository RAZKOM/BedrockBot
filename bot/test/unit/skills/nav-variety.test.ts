// Track AJ (PLAN.md task 7.7, docs/pathfinding.md "Movement variety"): swimming, ladders and vines,
// parkour gaps and edge sneaking. Planner checks on generated worlds, then closed loops (FakeConnection
// -> InputLoop with the own physics <- BotSkills / Navigator): the "server" is the same physics, so
// these test planning and following; the e2e suites (nav-swim, nav-ladder, nav-parkour) test the model
// against BDS.
import { describe, expect, it } from 'vitest';
import { BotSkills, type SkillResult } from '../../../src/skills/index.ts';
import { stepBody, PHYSICS, CLIMB, initialBody, IDLE_COMMAND, type BlockQuery, type MoveCommand } from '../../../src/skills/input/index.ts';
import { findPath, type PathNode } from '../../../src/skills/nav/astar.ts';
import type { NavGoal } from '../../../src/skills/nav/goals.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { blockQueryOf } from '../../../src/skills/terrain/query.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

interface Run {
  result: SkillResult | undefined;
  ticks: number;
  pos: Vec3;
  skills: BotSkills;
  minFeet: number;
  maxFeet: number;
  wet: number;
  sneaks: number;
}

async function runGoto(gen: GenWorld, start: Vec3, goal: NavGoal, opts: { maxTicks?: number; edgeSneak?: boolean } = {}): Promise<Run> {
  const { conn, loop } = harness(start);
  const skills = new BotSkills({ loop, world: fakeWorld(gen) });
  if (opts.edgeSneak !== undefined) skills.nav.edgeSneak = opts.edgeSneak;
  conn.tick(5);
  let result: SkillResult | undefined;
  const p = skills.goto(goal).then((r) => (result = r));
  let t = 0;
  let minFeet = Infinity;
  let maxFeet = -Infinity;
  let wet = 0;
  let sneaks = 0;
  const max = opts.maxTicks ?? 3000;
  while (skills.nav.busy && t < max) {
    conn.tick();
    minFeet = Math.min(minFeet, loop.state.pos.y);
    maxFeet = Math.max(maxFeet, loop.state.pos.y);
    if (loop.state.inWater) wet++;
    if (loop.command.sneak) sneaks++;
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t, pos: loop.state.pos, skills, minFeet, maxFeet, wet, sneaks };
}

const moves = (path: readonly PathNode[]) => path.map((n) => n.move);

/** A river across the whole world: z 4..9, water -62..-61 (2 deep), banks with feet at -60. */
function river(): GenWorld {
  const gen = flatGen();
  gen.fill({ x: -64, y: -62, z: 4 }, { x: 63, y: -61, z: 9 }, 'water');
  return gen;
}

/** A 10-high stone wall at z 5 (x -2..2, y -60..-51, top feet -50) with a ladder on its north face at x 0 (z 4). */
function ladderWall(block = 'ladder'): GenWorld {
  const gen = flatGen();
  gen.fill({ x: -64, y: -60, z: 5 }, { x: 63, y: -51, z: 5 }, 'stone');
  gen.fill({ x: -64, y: -60, z: 6 }, { x: 63, y: -51, z: 12 }, 'stone');
  if (block === 'ladder') gen.fill({ x: 0, y: -60, z: 4 }, { x: 0, y: -51, z: 4 }, 'ladder', { facing_direction: 2 });
  else gen.fill({ x: 0, y: -60, z: 4 }, { x: 0, y: -51, z: 4 }, 'vine', { vine_direction_bits: 1 });
  return gen;
}

/** A pit across the world at z 5..(4 + gap) from y -63 up, water at the bottom (-64), landing beyond. */
function gapWorld(gap: number, below: 'water' | 'lava' | 'air' = 'water'): GenWorld {
  const gen = flatGen();
  gen.fill({ x: -64, y: -63, z: 5 }, { x: 63, y: -61, z: 4 + gap }, 'air');
  gen.fill({ x: -64, y: -64, z: 5 }, { x: 63, y: -64, z: 4 + gap }, below === 'air' ? 'air' : below);
  return gen;
}

describe('physics: water, climbing, sneaking at an edge (Track AJ, measured on BDS 1.26.60)', () => {
  const q = (gen: GenWorld): BlockQuery => blockQueryOf(gen);
  const run = (gen: GenWorld, start: Vec3, cmd: Partial<MoveCommand>, ticks: number, onGround = true) => {
    let s = initialBody(start, onGround);
    const out = [s];
    for (let i = 0; i < ticks; i++) {
      s = stepBody(s, { ...IDLE_COMMAND, ...cmd }, q(gen)).state;
      out.push(s);
    }
    return out;
  };

  it('water moves the body only below 0.4 under the surface cell: jump held bobs at the surface', () => {
    const gen = river();
    const trace = run(gen, { x: 0.5, y: -61.9, z: 6.5 }, { jump: true }, 120, false);
    const tail = trace.slice(40);
    // the body leaves the water physics above feet -60.4 (the surface cell -61 + 1 - 0.4 inset) and falls back
    expect(Math.max(...tail.map((s) => s.pos.y))).toBeGreaterThan(-60.3);
    expect(Math.min(...tail.map((s) => s.pos.y))).toBeGreaterThan(-61.3);
    expect(tail.some((s) => !s.inWater)).toBe(true);
  });

  it('climbs a ladder at 0.2 per tick pushing into it, slides at 0.2 per tick, sneak holds', () => {
    const gen = ladderWall();
    const up = run(gen, { x: 0.5, y: -60, z: 4.5 }, { forward: 1, yaw: 0 }, 20);
    const dy = up[15]!.pos.y - up[10]!.pos.y;
    expect(dy).toBeCloseTo(5 * CLIMB.up, 3);
    const top = up.at(-1)!;
    let s = top;
    const slide: number[] = [];
    for (let i = 0; i < 10; i++) {
      s = stepBody(s, { ...IDLE_COMMAND, yaw: 0 }, q(gen)).state;
      slide.push(s.pos.y);
    }
    expect(slide[8]! - slide[9]!).toBeCloseTo(CLIMB.maxFall, 3);
    const held = stepBody(stepBody(s, { ...IDLE_COMMAND, sneak: true }, q(gen)).state, { ...IDLE_COMMAND, sneak: true }, q(gen)).state;
    const held2 = stepBody(held, { ...IDLE_COMMAND, sneak: true }, q(gen)).state;
    expect(held2.pos.y).toBeCloseTo(held.pos.y, 6);
  });

  it('a sneaking body stops at an edge with its box still over the block', () => {
    const gen = flatGen();
    gen.fill({ x: -64, y: -63, z: -64 }, { x: 63, y: -61, z: 63 }, 'air');
    gen.fill({ x: 0, y: -61, z: -10 }, { x: 0, y: -61, z: 10 }, 'stone');
    // strafe right (yaw 0 faces +z, right is -x) off a 1-wide bridge at x 0
    const trace = run(gen, { x: 0.5, y: -60, z: 0.5 }, { strafe: 1, sneak: true }, 60);
    const end = trace.at(-1)!;
    expect(end.pos.y).toBeCloseTo(-60, 6);
    expect(end.pos.x + PHYSICS.width / 2).toBeGreaterThan(0);
    expect(end.pos.x + PHYSICS.width / 2).toBeLessThan(0.06);
  });
});

describe('planner: movement-variety moves (Track AJ)', () => {
  it('crosses a river by swimming (enter, swim, climb out)', () => {
    const grid = new NavGrid(river());
    const r = findPath(grid, { x: 0, y: -60, z: 1 }, { type: 'block', p: { x: 0, y: -60, z: 13 } });
    expect(r.status).toBe('found');
    const m = moves(r.path);
    expect(m).toContain('swim');
    expect(m).toContain('swimOut');
    // never more than 0 blocks under water: every swim node is a surface cell
    for (const n of r.path.filter((n) => n.move === 'swim')) expect(n.y).toBe(-61);
  });

  it('swimming can be switched off (PathOptions.moves)', () => {
    const grid = new NavGrid(river());
    const r = findPath(grid, { x: 0, y: -60, z: 1 }, { type: 'block', p: { x: 0, y: -60, z: 13 } }, { moves: { swim: false }, maxNodes: 5000 });
    expect(r.status).not.toBe('found');
  });

  it('climbs a ladder up a wall and steps onto the top; climbs down again', () => {
    const grid = new NavGrid(ladderWall());
    const up = findPath(grid, { x: 0, y: -60, z: 1 }, { type: 'block', p: { x: 0, y: -50, z: 8 } });
    expect(up.status).toBe('found');
    expect(moves(up.path).filter((m) => m === 'climb').length).toBeGreaterThanOrEqual(9);
    expect(moves(up.path)).toContain('climbOut');
    const down = findPath(grid, { x: 0, y: -50, z: 8 }, { type: 'block', p: { x: 0, y: -60, z: 1 } });
    expect(down.status).toBe('found');
    expect(moves(down.path).filter((m) => m === 'climb').length).toBeGreaterThanOrEqual(9);
  });

  it('vines climb like ladders', () => {
    const grid = new NavGrid(ladderWall('vine'));
    const up = findPath(grid, { x: 0, y: -60, z: 1 }, { type: 'block', p: { x: 0, y: -50, z: 8 } });
    expect(up.status).toBe('found');
    expect(moves(up.path)).toContain('climb');
  });

  it('jumps a 1-block and a 2-block gap over water; never over lava or a deep drop', () => {
    for (const g of [1, 2]) {
      const grid = new NavGrid(gapWorld(g));
      const r = findPath(grid, { x: 0, y: -60, z: 1 }, { type: 'block', p: { x: 0, y: -60, z: 10 } });
      expect(r.status, `gap ${g}`).toBe('found');
      const pk = r.path.find((n) => n.move === 'parkour');
      expect(pk?.gap?.length).toBe(g);
      expect(pk?.gap?.z).toBe(4);
    }
    for (const below of ['lava', 'air'] as const) {
      const grid = new NavGrid(gapWorld(2, below));
      const r = findPath(grid, { x: 0, y: -60, z: 1 }, { type: 'block', p: { x: 0, y: -60, z: 10 } }, { maxNodes: 3000 });
      expect(r.status, below).not.toBe('found');
    }
  });

  it('treats a ladder cell as passable and scaffolding as an obstacle', () => {
    const gen = ladderWall();
    gen.put(3, -60, 2, 'scaffolding', { stability: 0, stability_check: 0 });
    const grid = new NavGrid(gen);
    expect(grid.stand(0, -60, 4)).toBe(-60);
    expect(Number.isNaN(grid.stand(3, -60, 2)!)).toBe(true);
    // walking along the ladder's face is fine, walking through it towards the wall is not possible anyway
    expect(grid.climberLets(0, -60, 4, 1, 0, true)).toBe(true);
    expect(grid.climberLets(0, -60, 4, 0, 1, true)).toBe(true);
    expect(grid.climberLets(0, -60, 4, 0, 1, false)).toBe(false);
  });
});

describe('closed loop: swimming, ladders, vines, parkour, edge sneaking (Track AJ)', () => {
  it('swims across a 6-wide river and climbs out', async () => {
    const run = await runGoto(river(), { x: 0.5, y: -60, z: 1.5 }, { type: 'block', p: { x: 0, y: -60, z: 13 } });
    expect(run.result).toEqual({ ok: true });
    expect(run.wet).toBeGreaterThan(20);
    expect(run.pos.z).toBeGreaterThan(13);
    expect(run.pos.y).toBeCloseTo(-60, 3);
  });

  it('climbs a 10-block ladder, steps onto the wall, and comes back down', async () => {
    const gen = ladderWall();
    const up = await runGoto(gen, { x: 0.5, y: -60, z: 1.5 }, { type: 'block', p: { x: 0, y: -50, z: 8 } });
    expect(up.result).toEqual({ ok: true });
    expect(up.pos.y).toBeCloseTo(-50, 3);
    const down = await runGoto(gen, { x: 0.5, y: -50, z: 8.5 }, { type: 'block', p: { x: 0, y: -60, z: 1 } });
    expect(down.result).toEqual({ ok: true });
    expect(down.pos.y).toBeCloseTo(-60, 3);
  });

  it('climbs a vine wall', async () => {
    const run = await runGoto(ladderWall('vine'), { x: 0.5, y: -60, z: 1.5 }, { type: 'block', p: { x: 0, y: -50, z: 8 } });
    expect(run.result).toEqual({ ok: true });
    expect(run.pos.y).toBeCloseTo(-50, 3);
  });

  for (const g of [1, 2]) {
    it(`jumps a ${g}-block gap over a pit (no fall)`, async () => {
      const run = await runGoto(gapWorld(g), { x: 0.5, y: -60, z: 1.5 }, { type: 'block', p: { x: 0, y: -60, z: 10 } });
      expect(run.result).toEqual({ ok: true });
      expect(run.minFeet).toBeGreaterThan(-60.01);
    });
  }

  it('sneaks near the edges of a 1-wide bridge over a deep pit and never falls', async () => {
    const gen = flatGen();
    gen.fill({ x: -64, y: -64, z: 2 }, { x: 63, y: -61, z: 24 }, 'air');
    gen.fill({ x: 0, y: -61, z: 2 }, { x: 0, y: -61, z: 24 }, 'stone');
    const run = await runGoto(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 26 } });
    expect(run.result).toEqual({ ok: true });
    expect(run.minFeet).toBeGreaterThan(-60.01);
  });
});
