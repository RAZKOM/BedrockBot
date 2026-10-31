// Track BC (wave 11, docs/pathfinding.md "Nodes and moves"): the moves that dig (nav/baritone/moves.ts,
// Baritone's MovementTraverse / Ascend / Descend / Downward / Pillar over our grid and rules). Planner
// side: the break set and its order, the cost (our movement ticks + getMiningDurationTicks per cell), the
// refusals (liquid beside, a gravity block above with and without allowGravityAbove, the protected area, a
// built block, the floor under the feet, the shaft rules). Follower side: closed loops with fake dig /
// place actions on generated worlds (the body never enters a cell before its cells are broken; the dig-down
// stance). Budgets: the navigator's longest tick stays under maxTickMs with the dig moves on.
import { describe, expect, it } from 'vitest';
import { BotSkills, type BotSkillsOptions } from '../../../src/skills/index.ts';
import type { InputLoop } from '../../../src/skills/input/inputLoop.ts';
import { DEFAULT_COSTS, NavGrid, dropCost, findPath, getMiningDurationTicks, handBreakTicks, type MiningContext, type NavActions, type PathNode, type PathOptions, type PathResult } from '../../../src/skills/nav/index.ts';
import { SHAFT_SPARE, createBreakMoveContext, shaftBlocker } from '../../../src/skills/nav/baritone/moves.ts';
import type { Goal } from '../../../src/skills/nav/goals.ts';
import type { GotoOptions, SkillResult } from '../../../src/skills/types.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const DIRT = 15; // ticks by hand
const DIG = DEFAULT_COSTS.dig;

/**
 * A closed 3-wide lane along +z (x -1 .. 1, z 0 .. 20) with stone brick walls (built blocks: never dug) 4 high
 * and down to the bedrock (nothing tunnels under them; the lane's own floor can be dug).
 */
function lane(): GenWorld {
  const gen = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 40 });
  const wall = (x1: number, z1: number, x2: number, z2: number, top = -57) => gen.fill({ x: x1, y: -63, z: z1 }, { x: x2, y: top, z: z2 }, 'stone_bricks');
  wall(-2, -1, -2, 21);
  wall(2, -1, 2, 21);
  wall(-2, -1, 2, -1);
  wall(-2, 21, 2, 21);
  return gen;
}

const digs = (r: PathResult): Vec3[] => r.path.flatMap((n: PathNode) => n.act?.dig ?? []);
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const plan = (gen: GenWorld, start: Vec3, goal: Vec3, opts: PathOptions = {}): PathResult => findPath(new NavGrid(gen), start, { type: 'block', p: goal }, { allowBreak: true, ...opts });
/**
 * The mining ticks the rule set charges for a node's dig cells (the floors it stands on are not dug; the
 * highest dug cell of a column counts the falling stack above it, as the moves do).
 */
function miningOf(gen: GenWorld, node: PathNode, prev: PathNode, opts: Partial<MiningContext> = {}): number {
  const grid = new NavGrid(gen);
  const floors: Vec3[] = node.move === 'downward' ? [] : [{ x: prev.x, y: prev.y - 1, z: prev.z }, { x: node.x, y: node.y - 1, z: node.z }];
  const ctx: MiningContext = { breakTicks: handBreakTicks, dig: DIG, feetFloors: floors, ...opts };
  const cells = node.act!.dig!;
  const top = (p: Vec3) => !cells.some((q) => q.x === p.x && q.z === p.z && q.y > p.y);
  return cells.reduce((a, p) => a + getMiningDurationTicks(grid, p.x, p.y, p.z, ctx, top(p)), 0);
}
const roofOf = (gen: GenWorld, n: PathNode): number => (new NavGrid(gen).underground(n.x, n.z, n.feet) ? DEFAULT_COSTS.underground : 0);
const baseOf = (n: PathNode): number => (n.move === 'jump' || n.move === 'pillar' ? DEFAULT_COSTS.jump : n.move === 'drop' ? dropCost(DEFAULT_COSTS, 1) : n.move === 'downward' ? DEFAULT_COSTS.fall[1]! + DEFAULT_COSTS.digDown : DEFAULT_COSTS.walk);

describe('Track BC planner: MovementTraverse (dig-through)', () => {
  const wallAt = (gen: GenWorld, z = 10, block = 'dirt') => gen.fill({ x: -1, y: -60, z }, { x: 1, y: -58, z }, block);

  it('breaks the two body cells ahead, the upper first, and pays walk + the rule set per cell', () => {
    const gen = lane();
    wallAt(gen);
    const r = plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -60, z: 15 });
    expect(r.status).toBe('found');
    const i = r.path.findIndex((n) => n.act?.dig);
    const node = r.path[i]!;
    expect(node.move).toBe('walk');
    expect(node.act!.dig!.map((p) => p.y)).toEqual([-59, -60]);
    expect(node.cost - DEFAULT_COSTS.walk - roofOf(gen, node)).toBeCloseTo(miningOf(gen, node, r.path[i - 1]!), 6);
    expect(miningOf(gen, node, r.path[i - 1]!)).toBe(2 * (DIRT + DIG));
  });

  it('refusals: water beside a cell, a gravity block above (unless allowGravityAbove, then the stack is paid), the protected area, a built block, never the floor under the feet', () => {
    const start = { x: 0, y: -60, z: 2 };
    const goal = { x: 0, y: -60, z: 15 };
    /** The wall's own cells (z 10, from the feet level up) are dug. The lane's floor may still be dug under it (a staircase). */
    const wallDug = (r: PathResult) => digs(r).some((c) => c.z === 10 && c.y >= -60);
    // water behind the wall at x 0: that column is not dug (next_to_liquid)
    let gen = lane();
    wallAt(gen);
    gen.put(0, -60, 11, 'water');
    expect(digs(plan(gen, start, goal)).some((c) => c.x === 0 && c.y >= -60)).toBe(false);
    // gravel right over a 2-high wall (nav-rules' barrier): the wall is not dug (gravity_above) and the lane is closed
    // (the goal is not below the start: no staircase under the wall is planned)
    gen = lane();
    gen.fill({ x: -1, y: -60, z: 10 }, { x: 1, y: -59, z: 10 }, 'dirt');
    gen.fill({ x: -1, y: -58, z: 10 }, { x: 1, y: -58, z: 10 }, 'gravel');
    const refused = plan(gen, start, goal);
    expect(wallDug(refused)).toBe(false);
    expect(refused.status).toBe('none');
    // Baritone's way: dug, and the gravel's break time is paid, either as the falling stack over the top cell
    // (includeFalling: a dig-through) or as a dug cell itself (an ascend onto the wall through it)
    const paid = plan(gen, start, goal, { allowGravityAbove: true });
    expect(paid.status).toBe('found');
    expect(wallDug(paid)).toBe(true);
    const i = paid.path.findIndex((n) => n.act?.dig?.some((c) => c.z === 10));
    const node = paid.path[i]!;
    const gravel = handBreakTicks(new NavGrid(gen).cls(node.x, -58, 10)!);
    expect(gravel).toBeGreaterThan(0);
    const extra = node.cost - baseOf(node) - roofOf(gen, node);
    expect(extra).toBeCloseTo(miningOf(gen, node, paid.path[i - 1]!, { rules: { allowGravityAbove: true } }), 6);
    expect(extra).toBeGreaterThanOrEqual(DIRT + DIG + gravel + DIG);
    // the protected area around home covers the wall and the floor under it: closed
    gen = lane();
    wallAt(gen);
    expect(plan(gen, start, goal, { protectedArea: { x: 0, y: -60, z: 10, r: 6 } }).status).toBe('none');
    // a built block (stone bricks) across the lane: never dug, the lane is closed
    gen = lane();
    wallAt(gen, 10, 'stone_bricks');
    const built = plan(gen, start, goal);
    expect(wallDug(built)).toBe(false);
    expect(built.status).toBe('none');
    // never the floor under the feet: the dig-through of a dirt wall digs nothing below the feet level
    gen = lane();
    wallAt(gen);
    expect(digs(plan(gen, start, goal)).every((c) => c.y >= -60)).toBe(true);
  });
});

describe('Track BC planner: the goal-below gate', () => {
  const wallAt = (gen: GenWorld, z = 10) => gen.fill({ x: -1, y: -60, z }, { x: 1, y: -58, z }, 'dirt');
  const opts: PathOptions = { allowPlace: true, throwaway: 64 };

  it('a same-level goal behind a dirt wall: dig-through, no dig-down and no staircase into the open floor (even with the blocks for a shaft)', () => {
    const gen = lane();
    wallAt(gen);
    const r = plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -60, z: 15 }, opts);
    expect(r.status).toBe('found');
    expect(r.path.some((n) => n.move === 'walk' && n.act?.dig)).toBe(true);
    expect(r.path.some((n) => n.move === 'downward')).toBe(false);
    expect(r.path.some((n) => n.move === 'drop' && n.act?.dig)).toBe(false);
    expect(digs(r).every((c) => c.y >= -60)).toBe(true);
    expect(r.expanded).toBeLessThan(300);
  });

  it('a same-level goal behind a built (undiggable) wall is unreachable without blocks to pillar over it: no staircase under it', () => {
    const gen = lane();
    gen.fill({ x: -1, y: -60, z: 10 }, { x: 1, y: -58, z: 10 }, 'stone_bricks');
    expect(plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -60, z: 15 }, { allowPlace: false }).status).toBe('none');
    // with throwaway blocks the way is over the wall (2 pillars and a jump onto its top), still not under it
    const over = plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -60, z: 15 }, opts);
    expect(over.status).toBe('found');
    expect(over.path.filter((n) => n.move === 'pillar').length).toBeGreaterThanOrEqual(2);
    expect(digs(over)).toEqual([]);
  });

  it('a goal below the wall\'s far side is reached by a staircase under it', () => {
    const gen = lane();
    gen.fill({ x: -1, y: -60, z: 10 }, { x: 1, y: -58, z: 10 }, 'stone_bricks');
    gen.fill({ x: -1, y: -61, z: 14 }, { x: 1, y: -61, z: 16 }, 'air'); // a 1-deep hollow behind the wall
    const r = plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -61, z: 15 }, { allowPlace: false });
    expect(r.status).toBe('found');
    expect(r.path.some((n) => n.move === 'drop' && n.act?.dig)).toBe(true);
    expect(digs(r).some((c) => c.z === 10 && c.y >= -60)).toBe(false);
  });

  it('an xz goal never digs down', () => {
    const gen = lane();
    gen.fill({ x: -1, y: -61, z: 12 }, { x: 1, y: -61, z: 20 }, 'air');
    const r = findPath(new NavGrid(gen), { x: 0, y: -60, z: 2 }, { type: 'xz', x: 0, z: 15 }, { allowBreak: true, ...opts });
    expect(r.status).toBe('found');
    expect(r.path.some((n) => n.move === 'downward' || (n.move === 'drop' && n.act?.dig))).toBe(false);
  });
});

describe('Track BC planner: MovementAscend (jump with head-room breaks)', () => {
  /** The lane's floor rises by one from z 8 on (a dirt plateau); a dirt lintel at y -58 over z 6 .. 8 blocks the plain jump's head room. */
  function plateau(): GenWorld {
    const gen = lane();
    gen.fill({ x: -1, y: -60, z: 8 }, { x: 1, y: -60, z: 20 }, 'dirt');
    gen.fill({ x: -1, y: -58, z: 6 }, { x: 1, y: -58, z: 8 }, 'dirt');
    return gen;
  }

  it('breaks the head room over the start and the cell over the target, then jumps (cost jump + the rule set)', () => {
    const gen = plateau();
    const r = plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -59, z: 15 });
    expect(r.status).toBe('found');
    const i = r.path.findIndex((n) => n.move === 'jump' && n.act?.dig);
    expect(i).toBeGreaterThan(0);
    const node = r.path[i]!;
    const prev = r.path[i - 1]!;
    expect(node.y).toBe(-59);
    expect(node.act!.dig!.map(key)).toEqual([key({ x: prev.x, y: -58, z: prev.z }), key({ x: node.x, y: -58, z: node.z })]);
    expect(node.cost - DEFAULT_COSTS.jump - roofOf(gen, node)).toBeCloseTo(miningOf(gen, node, prev), 6);
    // without the ascend: the plain jump has no head room under the lintel; the way is a dig-through tunnel into the plateau and a plain jump past the lintel (no cheaper: A* took the ascend)
    const off = plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -59, z: 15 }, { moves: { digAscend: false, digDescend: false, digDownward: false } });
    expect(off.status).toBe('found');
    expect(off.path.some((n) => n.move === 'jump' && n.act?.dig)).toBe(false);
    expect(off.cost).toBeGreaterThanOrEqual(r.cost - 1e-6);
    // a goal that is not below the start plans no staircase down into the open floor: the search stays small
    expect(r.expanded).toBeLessThan(400);
  });

  it('the jump exists but for the start\'s head room alone (a lintel over the approach only): an ascend with one break', () => {
    const gen = lane();
    gen.fill({ x: -1, y: -60, z: 8 }, { x: 1, y: -60, z: 20 }, 'dirt'); // the plateau
    gen.fill({ x: -1, y: -60, z: 8 }, { x: 1, y: -60, z: 8 }, 'stone_bricks'); // its first row undiggable (a dig-through into it + a plain jump would tie)
    gen.fill({ x: -1, y: -58, z: 7 }, { x: 1, y: -58, z: 7 }, 'dirt'); // the lintel over the approach cell only
    const r = plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -59, z: 15 });
    expect(r.status).toBe('found');
    const jump = r.path.find((n) => n.move === 'jump' && n.act?.dig);
    expect(jump).toBeDefined();
    expect(jump!.act!.dig!.map(key)).toEqual([key({ x: jump!.x, y: -58, z: 7 })]);
    expect(r.path.some((n) => n.move === 'downward' || (n.move === 'drop' && n.act?.dig))).toBe(false); // a goal above: no digging down
  });

  it('refuses a head-room break under a gravity block, with or without allowGravityAbove (Baritone: it would fall on us)', () => {
    const gen = plateau();
    gen.fill({ x: -1, y: -57, z: 6 }, { x: 1, y: -57, z: 8 }, 'gravel');
    for (const allowGravityAbove of [false, true]) {
      const r = plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -59, z: 15 }, { allowGravityAbove });
      const jumps = r.path.filter((n) => n.move === 'jump' && n.act?.dig);
      expect(jumps, `allowGravityAbove ${allowGravityAbove}`).toEqual([]);
    }
  });
});

describe('Track BC planner: MovementDescend (step down with breaks)', () => {
  /** The lane's floor drops by one from z 8 on (the grass dug out); a dirt lintel at y -59 over z 8 blocks the plain drop. */
  function ledge(): GenWorld {
    const gen = lane();
    gen.fill({ x: -1, y: -61, z: 8 }, { x: 1, y: -61, z: 20 }, 'air');
    gen.fill({ x: -1, y: -59, z: 8 }, { x: 1, y: -59, z: 8 }, 'dirt');
    return gen;
  }

  it('breaks the blocking cell of the lower column and drops one (cost dropCost(1) + the rule set)', () => {
    const gen = ledge();
    const r = plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -61, z: 15 });
    expect(r.status).toBe('found');
    const i = r.path.findIndex((n) => n.move === 'drop' && n.act?.dig);
    expect(i).toBeGreaterThan(0);
    const node = r.path[i]!;
    expect(node.y).toBe(-61);
    expect(node.act!.dig!.map(key)).toEqual([key({ x: node.x, y: -59, z: 8 })]);
    expect(node.cost - dropCost(DEFAULT_COSTS, 1) - roofOf(gen, node)).toBeCloseTo(miningOf(gen, node, r.path[i - 1]!), 6);
    expect(plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -61, z: 15 }, { moves: { digAscend: false, digDescend: false, digDownward: false } }).status).toBe('none');
  });

  it('never into liquid: with water in the lower cells the step down is refused (the way is a tunnel under it, 2 blocks from the water)', () => {
    const gen = ledge();
    gen.fill({ x: -1, y: -61, z: 8 }, { x: 1, y: -61, z: 8 }, 'water');
    const r = plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -61, z: 15 });
    expect(r.path.some((n) => n.z === 8 && n.y === -61)).toBe(false);
    expect(digs(r).some((c) => c.z === 8 && c.y >= -61)).toBe(false);
    for (const c of digs(r)) expect(new NavGrid(gen).cls(c.x, c.y, c.z)?.liquid).toBeUndefined();
    expect(plan(gen, { x: 0, y: -60, z: 2 }, { x: 0, y: -61, z: 15 }, { moves: { digAscend: false, digDescend: false, digDownward: false } }).status).toBe('none');
  });
});

describe('Track BC planner: MovementDownward (dig down under the shaft rules)', () => {
  const start = { x: 0, y: -60, z: 2 };
  /** Two blocks under the floor (the flat world's bedrock is at -64: a third block is within 2 of the world floor). */
  const under2 = { x: 0, y: -62, z: 2 };
  const shaft: PathOptions = { allowPlace: true, throwaway: 64 };

  it('digs the block under the feet twice (fall + digDown + the rule set per block); needs allowPlace and the depth + 4 throwaway blocks', () => {
    const gen = lane();
    const r = plan(gen, start, under2, shaft);
    expect(r.status).toBe('found');
    const down = r.path.filter((n) => n.move === 'downward');
    expect(down.map((n) => n.y)).toEqual([-61, -62]);
    expect(down.map((n) => key(n.act!.dig![0]!))).toEqual(['0,-61,2', '0,-62,2']);
    const node = down[0]!;
    expect(node.cost - (DEFAULT_COSTS.fall[1]! + DEFAULT_COSTS.digDown) - roofOf(gen, node)).toBeCloseTo(miningOf(gen, node, r.path[0]!), 6);
    // the way back must be guaranteed: no place action / no throwaway blocks, no dig-down move
    expect(plan(gen, start, under2).path.some((n) => n.move === 'downward')).toBe(false);
    // blocks for one block of depth only: no dig-down two below the start (the planner takes a staircase instead)
    expect(plan(gen, start, under2, { allowPlace: true, throwaway: 1 + SHAFT_SPARE }).path.filter((n) => n.move === 'downward').every((n) => n.y >= -61)).toBe(true);
    expect(plan(gen, start, under2, { allowPlace: true, throwaway: SHAFT_SPARE }).path.some((n) => n.move === 'downward')).toBe(false);
    expect(plan(gen, start, under2, { ...shaft, moves: { digDownward: false } }).path.some((n) => n.move === 'downward')).toBe(false);
  });

  it('shaft rules: liquid 1 to 2 below (the column or a side), dripstone within 3 below, a gravity block over the head, the world floor, no floor below', () => {
    const ctx = (gen: GenWorld) => createBreakMoveContext({ grid: new NavGrid(gen), costs: DEFAULT_COSTS, mining: { breakTicks: handBreakTicks, dig: DIG }, allowPlace: true, throwaway: 64, minY: gen.minY });
    let gen = lane();
    expect(shaftBlocker(ctx(gen), 0, -61, 2)).toBeUndefined();
    expect(shaftBlocker(ctx(gen), 0, -62, 2)).toBeUndefined();
    expect(shaftBlocker(ctx(gen), 0, -63, 2)).toBe('world_floor');
    gen.put(1, -63, 2, 'lava'); // a side neighbour 2 below the dug block
    expect(shaftBlocker(ctx(gen), 0, -61, 2)).toBe('liquid_below');
    gen = lane();
    gen.put(0, -63, 2, 'water');
    expect(shaftBlocker(ctx(gen), 0, -61, 2)).toBe('liquid_below');
    gen = lane();
    gen.put(-1, -64, 3, 'pointed_dripstone', { hanging: 0, dripstone_thickness: 'tip' });
    expect(shaftBlocker(ctx(gen), 0, -61, 2)).toBe('dripstone_below');
    gen = lane();
    gen.put(0, -58, 2, 'gravel'); // over the head of a body standing at feet -60
    expect(shaftBlocker(ctx(gen), 0, -61, 2)).toBe('gravity_above');
    gen = lane();
    gen.put(0, -62, 2, 'air'); // a cave under the block
    expect(shaftBlocker(ctx(gen), 0, -61, 2)).toBe('no_floor_below');
    // and the planner obeys: lava beside the start's column moves the shaft to another column
    gen = lane();
    gen.put(1, -63, 2, 'lava');
    const r = plan(gen, start, { x: -1, y: -62, z: 2 }, shaft);
    expect(r.status).toBe('found');
    expect(r.path.filter((n) => n.move === 'downward').every((n) => n.x !== 0)).toBe(true);
    // never within 2 of the world floor: a goal 3 under is not reached by digging down
    gen = lane();
    const deep = plan(gen, start, { x: 0, y: -63, z: 2 }, shaft);
    expect(deep.path.filter((n) => n.move === 'downward').every((n) => n.y >= -62)).toBe(true);
  });
});

describe('Track BC planner: MovementPillar (pillar-up under a low ceiling)', () => {
  /** A 2-deep 1 x 1 pit at (0, z 2) under a dirt lid two above the pit's head room. */
  function pit(): GenWorld {
    const gen = lane();
    gen.fill({ x: 0, y: -62, z: 2 }, { x: 0, y: -61, z: 2 }, 'air');
    gen.put(0, -60, 2, 'dirt'); // the cell above the body's head (feet -62: cells -62, -61)
    return gen;
  }

  it('breaks the cell above the head, then jumps and places (dig + place on one node); without allowBreak the pit is closed', () => {
    const gen = pit();
    const start = { x: 0, y: -62, z: 2 };
    const goal = { x: 0, y: -60, z: 10 };
    const r = findPath(new NavGrid(gen), start, { type: 'block', p: goal }, { allowBreak: true, allowPlace: true, throwaway: 64 });
    expect(r.status).toBe('found');
    const node = r.path.find((n) => n.move === 'pillar');
    expect(node?.act?.dig?.map(key)).toEqual(['0,-60,2']);
    expect(node?.act?.place?.p).toEqual({ x: 0, y: -62, z: 2 });
    expect(node!.cost - DEFAULT_COSTS.jump - roofOf(gen, node!)).toBeCloseTo(DEFAULT_COSTS.place + DIRT + DIG, 6);
    expect(findPath(new NavGrid(gen), start, { type: 'block', p: goal }, { allowPlace: true, throwaway: 64 }).status).toBe('none');
    // a gravity block over the lid: refused (it would fall on us), with or without allowGravityAbove; the pit is left by digging sideways instead
    gen.put(0, -59, 2, 'gravel');
    for (const allowGravityAbove of [false, true]) {
      const g = findPath(new NavGrid(gen), start, { type: 'block', p: goal }, { allowBreak: true, allowPlace: true, throwaway: 64, allowGravityAbove });
      expect(g.path.some((n) => n.move === 'pillar' && n.act?.dig), `allowGravityAbove ${allowGravityAbove}`).toBe(false);
    }
  });
});

describe('Track BG2 planner: a pillar needs head room for the jump (PlaceSkill: no_headroom)', () => {
  it('no pillar in a 3-high room (the cell 3 above the feet is a block); in a 4-high one, yes; pillar + dig refused under a second block', () => {
    const goal = { x: 0, y: -59, z: 2 }; // only a block placed at (0, -60, 2) makes this a node
    const opts: PathOptions = { allowPlace: true, throwaway: 64 };
    for (const [top, found] of [[-57, false], [-56, true]] as const) {
      const gen = lane();
      gen.fill({ x: -1, y: top, z: 0 }, { x: 1, y: top, z: 20 }, 'stone_bricks');
      const r = plan(gen, { x: 0, y: -60, z: 0 }, goal, { ...opts, allowBreak: false });
      expect(r.status === 'found', `ceiling ${top}`).toBe(found);
      if (found) expect(r.path.at(-1)!.move).toBe('pillar');
    }
    // the pit under a dirt lid (MovementPillar) with another block right over the lid: refused (the head room after the dig)
    const gen = lane();
    gen.fill({ x: 0, y: -62, z: 2 }, { x: 0, y: -61, z: 2 }, 'air');
    gen.put(0, -60, 2, 'dirt');
    gen.put(0, -59, 2, 'dirt');
    const r = findPath(new NavGrid(gen), { x: 0, y: -62, z: 2 }, { type: 'block', p: { x: 0, y: -60, z: 10 } }, { allowBreak: true, ...opts });
    expect(r.path.some((n) => n.move === 'pillar' && n.act?.dig?.some((c) => c.y === -60) && n.act.place?.p.y === -62)).toBe(false);
  });
});

describe('Track BC planner: sneak-through (a 1.5-high gap under top slabs)', () => {
  const TOP_SLAB = { 'minecraft:vertical_half': 'top' };
  /** The lane with a ceiling of top slabs at head height over z 6 .. 12 (gap 1.5); `floor` adds carpet under it (gap 1.44). */
  function lowPassage(carpet = false): GenWorld {
    const gen = lane();
    gen.fill({ x: -1, y: -59, z: 6 }, { x: 1, y: -59, z: 12 }, 'smooth_stone_slab', TOP_SLAB);
    if (carpet) gen.fill({ x: -1, y: -60, z: 6 }, { x: 1, y: -60, z: 12 }, 'white_carpet');
    return gen;
  }

  it('the top slab leaves 1.5: sneak nodes at the sneak walking cost, no other move leaves them; a carpet under it (1.44) closes the lane', () => {
    const gen = lowPassage();
    const grid = new NavGrid(gen);
    const slab = grid.cls(0, -59, 8)!;
    expect(slab.top).toBe(1);
    expect(Math.min(...slab.boxes.map((b) => b[1]))).toBeCloseTo(0.5, 9);
    expect(grid.stand(0, -60, 8)).toBeNaN(); // a standing body does not fit
    const r = findPath(grid, { x: 0, y: -60, z: 2 }, { type: 'block', p: { x: 0, y: -60, z: 16 } }, {});
    expect(r.status).toBe('found');
    const sneaks = r.path.filter((n) => n.move === 'sneak');
    expect(sneaks.length).toBe(8); // into z 6, through 7 .. 12, out onto z 13
    expect(sneaks.every((n) => n.y === -60)).toBe(true);
    for (const n of sneaks) expect(n.cost).toBeCloseTo(DEFAULT_COSTS.sneakWalk + roofOf(gen, n), 6);
    expect(DEFAULT_COSTS.sneakWalk).toBeCloseTo(15.44, 1);
    // the switch, and the lower gap
    expect(findPath(grid, { x: 0, y: -60, z: 2 }, { type: 'block', p: { x: 0, y: -60, z: 16 } }, { moves: { sneak: false } }).status).toBe('none');
    expect(findPath(new NavGrid(lowPassage(true)), { x: 0, y: -60, z: 2 }, { type: 'block', p: { x: 0, y: -60, z: 16 } }, {}).status).toBe('none');
    // a goal under the ceiling is reached sneaking; a start under it leaves sneaking
    expect(findPath(grid, { x: 0, y: -60, z: 2 }, { type: 'block', p: { x: 0, y: -60, z: 9 } }, {}).status).toBe('found');
    const out = findPath(grid, { x: 0, y: -60, z: 9 }, { type: 'block', p: { x: 0, y: -60, z: 2 } }, {});
    expect(out.status).toBe('found');
    expect(out.path[1]!.move).toBe('sneak');
  });
});

// ---- closed loops -----------------------------------------------------------------------------------

interface Drive {
  result: SkillResult | undefined;
  ticks: number;
  pos: Vec3;
  skills: BotSkills;
  log: string[];
}

/** Fake dig / place actions on a GenWorld (as nav-v2.test.ts: the Digger takes ticks; the PlaceSkill jumps by itself). */
function fakeActions(gen: GenWorld, log: string[], loop: InputLoop): NavActions {
  return {
    dig: async (p) => {
      log.push(`dig ${key(p)} ${gen.blockAt(p.x, p.y, p.z)?.name}`);
      await loop.waitTicks(8);
      gen.set(p.x, p.y, p.z, 'air');
      return { ok: true };
    },
    place: async (p, face) => {
      log.push(`place ${key(p)} ${face}`);
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

const cobble = () => ({ slots: [{ name: 'cobblestone', count: 64 }], selected: 0 });

async function drive(gen: GenWorld, start: Vec3, goal: Goal, o: { goto?: GotoOptions; nav?: Partial<BotSkillsOptions>; maxTicks?: number } = {}): Promise<Drive> {
  const { conn, loop } = harness(start);
  const log: string[] = [];
  const skills = new BotSkills({ loop, world: fakeWorld(gen), inventory: cobble, ...o.nav, actions: fakeActions(gen, log, loop) });
  conn.tick(3);
  let result: SkillResult | undefined;
  const p = skills.goto(goal, { allowBreak: true, ...o.goto }).then((r) => (result = r));
  let t = 0;
  const max = o.maxTicks ?? 3000;
  while (skills.nav.busy && t < max) {
    conn.tick();
    await flush();
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t, pos: loop.state.pos, skills, log };
}

describe('Track BC follower: the moves that dig, closed loop', () => {
  it('dig-down: two blocks under the feet, the body drops into each hole and stands still until it lands', async () => {
    const gen = lane();
    const run = await drive(gen, { x: 0.5, y: -60, z: 2.5 }, { type: 'block', p: { x: 0, y: -62, z: 2 } }, { goto: { allowPlace: true } });
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    expect(run.log).toEqual(['dig 0,-61,2 grass_block', 'dig 0,-62,2 dirt']);
    expect(run.pos.y).toBeCloseTo(-62, 3);
    expect(Math.hypot(run.pos.x - 0.5, run.pos.z - 2.5)).toBeLessThan(0.3);
    const rep = run.skills.status().lastGoto!;
    expect(rep.actions).toMatchObject({ dig: 2, failed: 0 });
    expect(rep.stuck).toBe(0);
  });

  it('a descend-dig into the shaft column and then dig-downs (the body starts beside the column): the e2e cave shape', async () => {
    const gen = lane();
    const run = await drive(gen, { x: 0.5, y: -60, z: 2.5 }, { type: 'block', p: { x: 0, y: -62, z: 3 } }, { goto: { allowPlace: true } });
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    expect(run.pos.y).toBeCloseTo(-62, 3);
    expect(run.log.filter((l) => l.startsWith('dig')).length).toBeGreaterThanOrEqual(2);
    expect(run.skills.status().lastGoto!.actions.failed).toBe(0);
    expect(run.skills.status().lastGoto!.stuck).toBe(0);
  });

  it('ascend with head-room breaks: the lintel cells are dug before the jump, the plateau is reached', async () => {
    const gen = lane();
    gen.fill({ x: -1, y: -60, z: 8 }, { x: 1, y: -60, z: 20 }, 'dirt');
    gen.fill({ x: -1, y: -58, z: 6 }, { x: 1, y: -58, z: 8 }, 'dirt');
    const run = await drive(gen, { x: 0.5, y: -60, z: 2.5 }, { type: 'block', p: { x: 0, y: -59, z: 15 } });
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    expect(run.pos.y).toBeCloseTo(-59, 3);
    const digsDone = run.log.filter((l) => l.startsWith('dig'));
    expect(digsDone).toHaveLength(2);
    expect(digsDone.every((l) => l.includes(',-58,'))).toBe(true);
    expect(run.skills.status().lastGoto!.actions.failed).toBe(0);
  });

  it('descend with a break: the blocking cell is dug, then the body steps down', async () => {
    const gen = lane();
    gen.fill({ x: -1, y: -61, z: 8 }, { x: 1, y: -61, z: 20 }, 'air');
    gen.fill({ x: -1, y: -59, z: 8 }, { x: 1, y: -59, z: 8 }, 'dirt');
    const run = await drive(gen, { x: 0.5, y: -60, z: 2.5 }, { type: 'block', p: { x: 0, y: -61, z: 15 } });
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    expect(run.pos.y).toBeCloseTo(-61, 3);
    expect(run.log.filter((l) => l.startsWith('dig'))).toHaveLength(1);
    expect(run.log[0]).toMatch(/^dig -?\d,-59,8 dirt/);
  });

  it('pillar-up under a lid: the lid is dug, then the block is placed and the pit left', async () => {
    const gen = lane();
    gen.fill({ x: 0, y: -62, z: 2 }, { x: 0, y: -61, z: 2 }, 'air');
    gen.put(0, -60, 2, 'dirt');
    const run = await drive(gen, { x: 0.5, y: -62, z: 2.5 }, { type: 'block', p: { x: 0, y: -60, z: 10 } }, { goto: { allowPlace: true } });
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    expect(run.log.slice(0, 2)).toEqual(['dig 0,-60,2 dirt', 'place 0,-62,2 down']);
    expect(run.pos.y).toBeCloseTo(-60, 3);
  });

  it('sneak-through: the body sneaks under a 1.5-high top-slab ceiling and stands up again behind it (the physics has the 1.49 sneak box)', async () => {
    const gen = lane();
    gen.fill({ x: -1, y: -59, z: 6 }, { x: 1, y: -59, z: 12 }, 'smooth_stone_slab', { 'minecraft:vertical_half': 'top' });
    const run = await drive(gen, { x: 0.5, y: -60, z: 2.5 }, { type: 'block', p: { x: 0, y: -60, z: 16 } }, { goto: { allowBreak: false } });
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    const rep = run.skills.status().lastGoto!;
    expect(rep.sneakTicks ?? 0).toBeGreaterThan(20);
    expect(rep.stuck).toBe(0);
    expect(rep.actions.dig).toBe(0);
    expect(run.pos.z).toBeGreaterThan(16);
  });

  it('sneak-through: a goto that starts mid-passage (the body under the ceiling) plans from its sneak node and gets out', async () => {
    const gen = lane();
    gen.fill({ x: -1, y: -59, z: 6 }, { x: 1, y: -59, z: 12 }, 'smooth_stone_slab', { 'minecraft:vertical_half': 'top' });
    const run = await drive(gen, { x: 0.5, y: -60, z: 9.5 }, { type: 'block', p: { x: 0, y: -60, z: 16 } }, { goto: { allowBreak: false } });
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    const rep = run.skills.status().lastGoto!;
    expect(rep.plans[0]!.status).toBe('found');
    expect(rep.sneakTicks ?? 0).toBeGreaterThan(10);
    expect(run.pos.z).toBeGreaterThan(16);
    // a goal under the ceiling is accepted and reached sneaking
    const inside = await drive(gen, { x: 0.5, y: -60, z: 2.5 }, { type: 'block', p: { x: 0, y: -60, z: 9 } }, { goto: { allowBreak: false } });
    expect(inside.result, inside.log.join('\n')).toEqual({ ok: true });
    expect(Math.floor(inside.pos.z)).toBe(9);
  });

  it('budgets: a dig-heavy goto (a goal inside a dirt block, sliced searches with the worker-sized budget) keeps every navigator tick under 100 ms', async () => {
    // A* expands every node cheaper than the dig route (open ground and the descend layers under it: about 9 000
    // here), more than the in-thread 40 ms main plan holds; the planner worker's budget (2 s) is the production path
    const gen = flatGen({ x: -24, y: -64, z: -24 }, { x: 48, y: 24, z: 48 });
    gen.fill({ x: -6, y: -60, z: 4 }, { x: 6, y: -56, z: 16 }, 'dirt');
    const run = await drive(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 12 } }, { maxTicks: 4000, nav: { mainMs: 2000, segmentMs: 2000, segmentNodes: 500_000 } });
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    const rep = run.skills.status().lastGoto!;
    expect(rep.actions.dig).toBeGreaterThanOrEqual(10);
    expect(rep.maxTickMs).toBeLessThan(100);
    expect(Math.hypot(run.pos.x - 0.5, run.pos.z - 12.5)).toBeLessThan(0.3);
  });
});
