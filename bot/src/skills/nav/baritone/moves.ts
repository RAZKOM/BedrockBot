/*
 * Ported from Baritone (src/main/java/baritone/pathing/movement/movements/MovementTraverse.java@23723891,
 * src/main/java/baritone/pathing/movement/movements/MovementAscend.java@23723891,
 * src/main/java/baritone/pathing/movement/movements/MovementDescend.java@23723891,
 * src/main/java/baritone/pathing/movement/movements/MovementDownward.java@23723891,
 * src/main/java/baritone/pathing/movement/movements/MovementPillar.java@23723891), LGPL-3.0.
 *
 * This file is part of Baritone.
 *
 * Baritone is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Baritone is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Baritone.  If not, see <https://www.gnu.org/licenses/>.
 * The licence text is in ./LICENSE; the port is listed in THIRD_PARTY_NOTICES.md at the repo root.
 */
// Track BC (wave 11, docs/pathfinding.md "Nodes and moves"): the moves that dig, as Baritone's movements
// compute them (the cells each move breaks, in the order the follower breaks them, and the cost), over
// our grid (nav/grid.ts NavGrid as a CellReader), our tick costs (nav/costs.ts) and the shared rule set
// (./helper.ts: `getMiningDurationTicks` with `avoidBreaking`, the owner's rules included). nav/astar.ts
// calls these under `allowBreak`; the planner worker runs the same code over its mirror grid.
//
//   traverse   MovementTraverse: walk into the next cell after breaking its two body cells (the upper one
//              with the falling stack above it); the target's floor is a full block
//   ascend     MovementAscend: jump up one block after breaking the head room above the start, the target's
//              feet cell and the cell above it; never from a bottom slab (the start stands on a full block)
//   descend    MovementDescend: walk off the edge into the cell one lower after breaking its three body
//              cells; a known full floor under it (Baritone's longer falls with breaks are not ported)
//   downward   MovementDownward: dig the block under the feet and drop one; only under the shaft rules of
//              mine/tunnel.ts `shaftRule` (rule 6 of the port: ours win over Baritone's)
//   pillar     MovementPillar: jump and place a block under the feet after breaking the cell above the head
//
// Costs: our movement ticks (`base`: walk, jump, dropCost, fall[1]) plus the mining ticks of every broken
// cell (`extra`: break time with the best tool + `PathCosts.dig`, the owner's digPenalty), as Baritone adds
// getMiningDurationTicks to its movement cost. `includeFalling` only for the top cell of a dig (Baritone).
// Refusals come from the rule set (liquids beside, gravity above unless `allowGravityAbove`, the protected
// area, built blocks, the floor under the feet) and from the movements' own checks (a gravity block over a
// head-room cell that is broken, the shaft rules). Everything is pure; the per-move functions allocate only
// when they return a move.
import type { Vec3 } from '../../../world/types.ts';
import { PHYSICS } from '../../input/physics.ts';
import type { PathCosts } from '../costs.ts';
import { dropCost } from '../costs.ts';
import { cellKey } from '../grid.ts';
import { YES, avoidWalkingInto, canWalkThroughClass, fullFloor, getMiningDurationTicks, type CellReader, type MiningContext } from './helper.ts';

// ---- sneak-through (ours, not Baritone's: a Java body does not fit under 1.5 blocks either) ----------------

/**
 * Track BC (owner, 2026-10-30: "sneaking makes you fit through smaller gaps"): the body may occupy cell
 * (x, y, z) sneaking: its feet cell is passable over a full floor, and its head cell is blocked only by
 * boxes whose underside is at least the sneaking box's height (input/physics.ts `sneakHeight` 1.49,
 * bedboo-measured on BDS) above the feet: a top slab leaves 1.5, a top trapdoor 1.81. A standing body
 * (1.8) does not fit there (`NavGrid.stand` is BLOCKED), so such a cell is a sneak node: entered, left and
 * crossed by `sneak` moves at the sneak walking cost (walk / 0.3: Baritone's SNEAK_ONE_BLOCK_COST), never
 * jumped from, dropped from or dug from. Descending into such a gap is not a move: a sneaking body stops at
 * an edge (the sneak edge rule, physics.ts `backOffFromEdge`) and a standing body that falls in lands on
 * the ceiling block instead. Undefined when a cell is not loaded.
 */
export function sneakFits(grid: CellReader, x: number, y: number, z: number): boolean | undefined {
  const feet = grid.cls(x, y, z);
  const head = grid.cls(x, y + 1, z);
  const below = grid.cls(x, y - 1, z);
  if (!feet || !head || !below) return undefined;
  if (canWalkThroughClass(feet) !== YES) return false;
  if (!fullFloor(below) || below.danger) return false;
  if (head.liquid || head.danger || head.boxes.length === 0 || head.unknown) return false;
  if (avoidWalkingInto(head)) return false;
  const clear = PHYSICS.sneakHeight - 1;
  for (const b of head.boxes) if (b[1] < clear) return false;
  return true;
}

/** A move that breaks blocks: our movement ticks, the mining ticks on top, the cells to break (in break order). */
export interface BreakMove {
  /** The movement's ticks (walk, jump, drop, fall): multiplied by the target floor's cost factor in the search. */
  base: number;
  /** Mining ticks (break time + dig penalty per cell) and the other flat extras (the place, the dig-down stance). */
  extra: number;
  /** Cells to break before the move, in order (the higher cell of a column first, the start's head room first). */
  dig: Vec3[];
}

/**
 * Throwaway blocks a shaft needs beyond its depth before the planner digs down (mine/tunnel.ts `PILLAR_SPARE`:
 * the way back up a 1 x 1 shaft is a pillar, and the pillar must not run out of blocks).
 */
export const SHAFT_SPARE = 4;

/** What the moves read and the rules they apply (built once per search by nav/astar.ts). */
export interface BreakMoveContext {
  grid: CellReader;
  costs: PathCosts;
  /** The rule set's inputs (break times, the dig penalty, the break rules, the blacklist); `feetFloors` is set per move here. */
  mining: MiningContext;
  /** Pillar-up is planned (a place action and throwaway blocks): the shaft's way back up. */
  allowPlace: boolean;
  /** Throwaway blocks in the hotbar. */
  throwaway: number;
  /** Lowest y of the world (the shaft rules never dig within 2 of it). */
  minY: number;
  /** Set by a move that read an unloaded cell (the search records it as `sawUnknown` and clears it). */
  unknown: boolean;
  /** Scratch: the floors a move stands on (never dug), 1 or 2 cells, reused across calls. */
  readonly floors1: [Vec3];
  readonly floors2: [Vec3, Vec3];
  /**
   * Per-search caches (a dig cell is asked about from up to 6 directions): the mining ticks of a cell
   * (key: cellKey x 2 + includeFalling) and the shaft verdict of a column (key: cellKey of the dug block).
   * The moves' dig cells never coincide with their feet floors, so the rule set's answer does not depend on
   * the move asking. Like the search's relaxed nodes, the caches are not refreshed by block updates during
   * the search (the navigator re-plans on changes near the path).
   */
  readonly mined: Map<number, number>;
  readonly shafts: Map<number, number>;
}

export function createBreakMoveContext(o: { grid: CellReader; costs: PathCosts; mining: MiningContext; allowPlace: boolean; throwaway: number; minY: number }): BreakMoveContext {
  return {
    grid: o.grid,
    costs: o.costs,
    mining: o.mining,
    allowPlace: o.allowPlace,
    throwaway: o.throwaway,
    minY: o.minY,
    unknown: false,
    floors1: [{ x: 0, y: 0, z: 0 }],
    floors2: [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    ],
    mined: new Map(),
    shafts: new Map(),
  };
}

const setFloor = (f: Vec3, x: number, y: number, z: number): void => {
  f.x = x;
  f.y = y;
  f.z = z;
};

/** A cell the body cannot pass as it is (a box or a liquid): the move breaks it (or is refused by the rules). */
function needsDig(ctx: BreakMoveContext, x: number, y: number, z: number): boolean | undefined {
  const c = ctx.grid.cls(x, y, z);
  if (!c) {
    ctx.unknown = true;
    return undefined;
  }
  return c.boxes.length > 0 || c.liquid !== undefined;
}

/**
 * Baritone `getMiningDurationTicks` for one cell of a move: 0 when the body walks through it, Infinity when
 * the rules refuse it (`ctx.mining.feetFloors` names the floors the move stands on). Undefined cells flag
 * `unknown`.
 */
function mine(ctx: BreakMoveContext, x: number, y: number, z: number, includeFalling: boolean): number {
  const k = cellKey(x, y, z) * 2 + (includeFalling ? 1 : 0);
  const hit = ctx.mined.get(k);
  if (hit !== undefined) return hit;
  if (needsDig(ctx, x, y, z) === undefined) return Infinity; // (not cached: the cell may load later)
  const t = getMiningDurationTicks(ctx.grid, x, y, z, ctx.mining, includeFalling);
  ctx.mined.set(k, t);
  return t;
}

/** The target's floor: a known full block that is a floor (Baritone `canWalkOn` of the block below the target). */
function floorAt(ctx: BreakMoveContext, x: number, y: number, z: number): boolean {
  const c = ctx.grid.cls(x, y, z);
  if (!c) {
    ctx.unknown = true;
    return false;
  }
  return fullFloor(c) && !c.danger;
}

/**
 * Baritone MovementTraverse.cost (the "walk, not a bridge" branch): from feet cell (x, y, z) standing on a
 * full block into (nx, y, nz) whose floor (nx, y - 1, nz) is a full block, breaking its body cells
 * (nx, y + 1, nz) (the falling stack above it counted) and (nx, y, nz). Baritone's bridge branch (placing
 * the target's floor) is not ported: pillar-up is our only placing move. Undefined when nothing needs
 * breaking (the plain walk) or a cell is refused.
 */
export function traverse(ctx: BreakMoveContext, x: number, y: number, z: number, nx: number, nz: number): BreakMove | undefined {
  if (!floorAt(ctx, nx, y - 1, nz)) return undefined;
  const upper = needsDig(ctx, nx, y + 1, nz);
  const lower = needsDig(ctx, nx, y, nz);
  if (upper === undefined || lower === undefined) return undefined;
  if (!upper && !lower) return undefined;
  const floors = ctx.floors2;
  setFloor(floors[0], x, y - 1, z);
  setFloor(floors[1], nx, y - 1, nz);
  ctx.mining.feetFloors = floors;
  const t1 = mine(ctx, nx, y, nz, false);
  if (!Number.isFinite(t1)) return undefined;
  const t2 = mine(ctx, nx, y + 1, nz, true); // only include falling on the upper block to break
  if (!Number.isFinite(t2)) return undefined;
  const dig: Vec3[] = [];
  if (upper) dig.push({ x: nx, y: y + 1, z: nz });
  if (lower) dig.push({ x: nx, y, z: nz });
  return { base: ctx.costs.walk, extra: t1 + t2, dig };
}

/**
 * Baritone MovementAscend.cost (the "no placement" branch): from feet cell (x, y, z) standing on a full
 * block up into (nx, y + 1, nz) whose floor (nx, y, nz) is a full block, breaking the head room above the
 * start (x, y + 2, z), the target's feet cell (nx, y + 1, nz) and the cell above it (nx, y + 2, nz) (the
 * falling stack above that one counted). Refused whenever a falling block sits 3 above the start (Baritone:
 * "it would fall on us and possibly suffocate us"), head room broken or not, whatever `allowGravityAbove` says.
 * Baritone never ascends from a bottom slab onto a full block: our start stands on a full block (the
 * planner's measured stairs and slab walks, decision 0022, handle the partial floors). Undefined when
 * nothing needs breaking (the plain jump) or a cell is refused.
 */
export function ascend(ctx: BreakMoveContext, x: number, y: number, z: number, nx: number, nz: number): BreakMove | undefined {
  if (!floorAt(ctx, nx, y, nz)) return undefined;
  const head = needsDig(ctx, x, y + 2, z);
  const feet = needsDig(ctx, nx, y + 1, nz);
  const top = needsDig(ctx, nx, y + 2, nz);
  if (head === undefined || feet === undefined || top === undefined) return undefined;
  if (!head && !feet && !top) return undefined;
  // Baritone MovementAscend: a FallingBlock at src.up(3) "would fall on us and possibly suffocate us": refused
  // whenever it is there (Baritone's condition `canWalkThrough(src.up(1)) || !(srcUp2 is falling)` always holds
  // here, the body's head cell being free), broken head room or not
  const over = ctx.grid.cls(x, y + 3, z);
  if (!over) {
    ctx.unknown = true;
    return undefined;
  }
  if (over.gravity) return undefined;
  const floors = ctx.floors2;
  setFloor(floors[0], x, y - 1, z);
  setFloor(floors[1], nx, y, nz);
  ctx.mining.feetFloors = floors;
  let extra = mine(ctx, x, y + 2, z, false);
  if (!Number.isFinite(extra)) return undefined;
  extra += mine(ctx, nx, y + 1, nz, false);
  if (!Number.isFinite(extra)) return undefined;
  extra += mine(ctx, nx, y + 2, nz, true);
  if (!Number.isFinite(extra)) return undefined;
  const dig: Vec3[] = [];
  if (head) dig.push({ x, y: y + 2, z });
  if (top) dig.push({ x: nx, y: y + 2, z: nz });
  if (feet) dig.push({ x: nx, y: y + 1, z: nz });
  return { base: ctx.costs.jump, extra, dig };
}

/**
 * Baritone MovementDescend.cost (the one-block descend; `dynamicFallCost`, the longer falls with breaks
 * and the water-bucket falls, is not ported: our drop rules stay, nav/astar.ts): from feet cell (x, y, z)
 * standing on a full block into (nx, y - 1, nz) whose floor (nx, y - 2, nz) is a known full block,
 * breaking the target column's three body cells (nx, y + 1, nz) (the falling stack above it counted),
 * (nx, y, nz) and (nx, y - 1, nz). Never into a liquid (the rules refuse liquid cells and cells beside
 * one). Undefined when nothing needs breaking (the plain drop) or a cell is refused.
 */
export function descend(ctx: BreakMoveContext, x: number, y: number, z: number, nx: number, nz: number): BreakMove | undefined {
  if (!floorAt(ctx, nx, y - 2, nz)) return undefined;
  const top = needsDig(ctx, nx, y + 1, nz);
  const mid = needsDig(ctx, nx, y, nz);
  const low = needsDig(ctx, nx, y - 1, nz);
  if (top === undefined || mid === undefined || low === undefined) return undefined;
  if (!top && !mid && !low) return undefined;
  const floors = ctx.floors2;
  setFloor(floors[0], x, y - 1, z);
  setFloor(floors[1], nx, y - 2, nz);
  ctx.mining.feetFloors = floors;
  let extra = mine(ctx, nx, y - 1, nz, false);
  if (!Number.isFinite(extra)) return undefined;
  extra += mine(ctx, nx, y, nz, false);
  if (!Number.isFinite(extra)) return undefined;
  extra += mine(ctx, nx, y + 1, nz, true); // only the top block in the 3 we need to mine needs to consider the falling blocks above
  if (!Number.isFinite(extra)) return undefined;
  const dig: Vec3[] = [];
  if (top) dig.push({ x: nx, y: y + 1, z: nz });
  if (mid) dig.push({ x: nx, y, z: nz });
  if (low) dig.push({ x: nx, y: y - 1, z: nz });
  return { base: dropCost(ctx.costs, 1), extra, dig };
}

const SHAFT_SIDES: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Why the shaft rules (mine/tunnel.ts `shaftRule`, the owner's rules; rule 6 of the port) refuse digging
 * the block `q` = (x, qy, z) under the feet, undefined when they allow it: never within 2 blocks of the
 * world's floor; no liquid in the column or its 4 side neighbours 1 or 2 blocks below q; no pointed
 * dripstone in the 3 x 3 columns 1 to 3 blocks below; the block below q known and a full floor (never into a
 * cave or an unknown block); no gravity block over the body's head (the cell 3 above q: the shaft's top
 * once the bot is down there). Unloaded cells are `unknown`.
 */
export type ShaftReason = 'world_floor' | 'liquid_below' | 'dripstone_below' | 'no_floor_below' | 'gravity_above' | 'unknown';
const SHAFT_REASONS: readonly (ShaftReason | undefined)[] = [undefined, 'world_floor', 'liquid_below', 'dripstone_below', 'no_floor_below', 'gravity_above', 'unknown'];

export function shaftBlocker(ctx: BreakMoveContext, x: number, qy: number, z: number): ShaftReason | undefined {
  const k = cellKey(x, qy, z);
  const hit = ctx.shafts.get(k);
  if (hit !== undefined) return SHAFT_REASONS[hit];
  const why = shaftBlockerUncached(ctx, x, qy, z);
  if (why !== 'unknown') ctx.shafts.set(k, SHAFT_REASONS.indexOf(why));
  return why;
}

function shaftBlockerUncached(ctx: BreakMoveContext, x: number, qy: number, z: number): ShaftReason | undefined {
  if (qy < ctx.minY + 2) return 'world_floor';
  const grid = ctx.grid;
  // (cells under the world's floor hold nothing: the scans stop there)
  for (let dy = 1; dy <= 2 && qy - dy >= ctx.minY; dy++) {
    for (const [dx, dz] of SHAFT_SIDES) {
      const c = grid.cls(x + dx, qy - dy, z + dz);
      if (!c) return 'unknown';
      if (c.liquid) return 'liquid_below';
    }
  }
  for (let dy = 1; dy <= 3 && qy - dy >= ctx.minY; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = grid.cls(x + dx, qy - dy, z + dz);
        if (!c) return 'unknown';
        if (c.name.includes('pointed_dripstone')) return 'dripstone_below';
      }
    }
  }
  const below = grid.cls(x, qy - 1, z);
  if (!below) return 'unknown';
  if (!fullFloor(below) || below.danger) return 'no_floor_below';
  const over = grid.cls(x, qy + 3, z);
  if (!over) return 'unknown';
  if (over.gravity) return 'gravity_above';
  return undefined;
}

/**
 * Baritone MovementDownward.cost: dig the block under the feet of (x, y, z) and drop one into its cell
 * (Baritone: `canWalkOn` two below, FALL_N_BLOCKS_COST[1] + the mining ticks). Ours on top of that: only
 * under the shaft rules (`shaftBlocker`), and only with a guaranteed way back up: pillar-up planned
 * (`allowPlace`: a place action and throwaway blocks) with enough blocks for the depth below the search's
 * start plus SHAFT_SPARE (`depth`: blocks the new feet are below the start). The break rules' under-feet
 * rule does not apply (this is the one move that digs the floor). Undefined when refused.
 */
export function downward(ctx: BreakMoveContext, x: number, y: number, z: number, depth: number): BreakMove | undefined {
  if (!ctx.allowPlace || depth + SHAFT_SPARE > ctx.throwaway) return undefined;
  const why = shaftBlocker(ctx, x, y - 1, z);
  if (why === 'unknown') ctx.unknown = true;
  if (why) return undefined;
  if (needsDig(ctx, x, y - 1, z) !== true) return undefined;
  ctx.mining.feetFloors = undefined;
  const t = mine(ctx, x, y - 1, z, false);
  if (!Number.isFinite(t)) return undefined;
  const costs = ctx.costs;
  return { base: costs.fall[1] ?? 5, extra: t + costs.digDown, dig: [{ x, y: y - 1, z }] };
}

/**
 * Baritone MovementPillar.cost (the "not a ladder" branch) when the cell above the head is in the way:
 * from feet cell (x, y, z) standing on a full block, break (x, y + 2, z) and jump, placing a block in the
 * feet cell. Refused when a falling block sits over the broken cell (Baritone: it would fall on us; the
 * block we stand in is air, so Baritone's "both falling" exception never applies), when the cell is a
 * fence gate (ours: every door / gate, `openable`), and from a bottom slab (ours: the start stands on a
 * full block; Track O's PlaceSkill clicks the top of the block below the feet, which a slab floor in the
 * feet cell has not). Baritone's 0.1 penalty for pillaring on air is not ported (no floor, no node).
 * Undefined when the cell above the head is free (the plain pillar) or refused.
 */
export function pillar(ctx: BreakMoveContext, x: number, y: number, z: number): BreakMove | undefined {
  const head = needsDig(ctx, x, y + 2, z);
  if (!head) return undefined;
  const over = ctx.grid.cls(x, y + 3, z);
  if (!over) {
    ctx.unknown = true;
    return undefined;
  }
  if (over.gravity) return undefined;
  if (over.boxes.length > 0) return undefined; // Track BG2: the jump's head room (PlaceSkill: no_headroom)
  const floors = ctx.floors1;
  setFloor(floors[0], x, y - 1, z);
  ctx.mining.feetFloors = floors;
  const t = mine(ctx, x, y + 2, z, false);
  if (!Number.isFinite(t)) return undefined;
  const costs = ctx.costs;
  return { base: costs.jump, extra: costs.place + t, dig: [{ x, y: y + 2, z }] };
}
