// Track W2 (docs/pathfinding.md "Digging out of water (Track W2)", decisions/0070-water-travel.md "W2: digging out"):
// the way out of a pool or a flooded hole whose only rim is a lip or a taller bank. A swimming body cannot climb a
// bank 2 above the top water cell on BDS (Track W1, measured), so the planner may dig a step into it: break the
// lip block (and the block above it for head room) beside a surface swim node, and climb out onto the block at the
// water's level (`swimOut`). A taller bank is cut as a 1-wide staircase from there: the jump-with-breaks move
// (baritone/moves.ts `ascend`) from the cut's nodes only, so a walk that may not dig (allowBreak off) digs nothing
// but its way out of the water.
//
// The break rules hold for every cell (nav/actions.ts `breakBlocker`: protected and built blocks, containers,
// beds, the protected area around home, a liquid beside the cell, a gravity block above it). The step is planned
// from a surface swim node only (the head out of the water: the air does not run down while the bot digs; under
// water the server breaks 5 x slower again and the air would run out). Its cost is the break time with the best
// tool as the server counts it in the water (`WATER_DIG_FACTOR`, measured) + the dig penalty per block + a fixed
// DIG_OUT_PENALTY, so a swim exit wins unless it is far longer. A cell the best tool would take longer than
// DIG_OUT_MAX_TICKS to break from the water is refused as "no tool" (no punching stone for 750 ticks): a pool with
// no exit and no step to dig reports why (`trappedWhy`).
//
// Measured on BDS 1.26.60 (bds-fly, the W2 probe, the body treading water at the surface: onGround false, the eye
// above the water): grass by hand 90 ticks (18 on the ground), stone with a wooden pickaxe 113 (23), with an iron
// pickaxe 38 (8): the off-ground modifier (dig/breakTime.ts MODIFIERS.offGround, speed / 5) on the table's formula,
// exactly. Dirt by hand from a pool's floor with the head under water: 75 (15): the in-water modifier, also / 5.
import type { Vec3 } from '../../world/types.ts';
import { MODIFIERS, type BreakConditions } from '../dig/breakTime.ts';
import type { TerrainClass } from '../terrain/classify.ts';
import { avoidBreaking, avoidWalkingInto, fullFloor, getMiningDurationTicks, type BreakReason, type CellReader, type MiningContext } from './baritone/helper.ts';

/** The server's break time for a body swimming at the surface: off the ground, speed / 5 (measured). */
export const WATER_DIG_FACTOR = 1 / MODIFIERS.offGround;
/** Ticks on top of the break times and the dig penalty for digging a step out of the water (a swim exit up to about 20 blocks longer wins). */
export const DIG_OUT_PENALTY = 200;
/** A dig-out cell that takes longer than this to break from the water (the best tool, WATER_DIG_FACTOR applied) is refused ("no tool"). */
export const DIG_OUT_MAX_TICKS = 200;
/** Steps of a staircase cut up a bank (the step at the water level counts as the first). */
export const DIG_OUT_MAX_STEPS = 8;

/** Why a dig-out step beside a swim node was refused: a break rule, or one of ours. */
export type DigOutRefusal = BreakReason | 'no_tool' | 'no_floor' | 'blacklisted' | 'hazard';

/** The refusals a search met (`PathResult.digOut`), by reason, with the first block name of each. */
export interface DigOutReport {
  refused: Partial<Record<DigOutRefusal, { count: number; block: string }>>;
}

export interface DigOutStep {
  /** Mining ticks (with WATER_DIG_FACTOR) + the dig penalty per block + DIG_OUT_PENALTY. */
  extra: number;
  /** Cells to break, the higher first (nav/actions.ts break order). */
  dig: Vec3[];
}

/**
 * The step out of the water from a surface swim node at level cy (the top water cell) into column (nx, nz): the
 * body climbs out onto the block (nx, cy, nz) at the water's level (`swimOut` to feet cy + 1), so that block must
 * be a full floor, and the two body cells over it are broken where they are not free: (nx, cy + 2, nz) first (the
 * head room), then (nx, cy + 1, nz) (the lip). Undefined when nothing needs breaking (a plain swimOut) or the step is
 * refused (`refuse` hears why).
 */
export function digOutStep(grid: CellReader, mining: MiningContext, cy: number, nx: number, nz: number, refuse: (why: DigOutRefusal, c: TerrainClass) => void): DigOutStep | undefined {
  const floor = grid.cls(nx, cy, nz);
  if (!floor) return undefined;
  if (floor.liquid || !fullFloor(floor) || floor.danger) {
    if (!floor.liquid && floor.boxes.length) refuse('no_floor', floor);
    return undefined;
  }
  const feetFloors = [{ x: nx, y: cy, z: nz }];
  const wet: MiningContext = { ...mining, feetFloors, breakTicks: (c) => mining.breakTicks(c) * WATER_DIG_FACTOR };
  const dig: Vec3[] = [];
  let extra = 0;
  for (const y of [cy + 2, cy + 1]) {
    const c = grid.cls(nx, y, nz);
    if (!c) return undefined;
    if (c.boxes.length === 0 && !c.liquid) {
      if (avoidWalkingInto(c)) {
        refuse('hazard', c);
        return undefined;
      }
      continue;
    }
    const why = cellRefusal(grid, nx, y, nz, wet);
    if (why) {
      refuse(why, c);
      return undefined;
    }
    extra += getMiningDurationTicks(grid, nx, y, nz, wet, y === cy + 2);
    dig.push({ x: nx, y, z: nz });
  }
  if (!dig.length) return undefined;
  return { extra: extra + DIG_OUT_PENALTY, dig };
}

/** Why one dig-out cell is refused (the break rules, the blacklist, too slow to break from the water), or undefined. */
function cellRefusal(grid: CellReader, x: number, y: number, z: number, wet: MiningContext): DigOutRefusal | undefined {
  if (wet.noBreak?.(x, y, z)) return 'blacklisted';
  const why = avoidBreaking(grid, x, y, z, wet.rules, wet.feetFloors);
  if (why) return why;
  const c = grid.cls(x, y, z)!;
  const t = wet.breakTicks(c);
  if (!Number.isFinite(t) || t > DIG_OUT_MAX_TICKS) return 'no_tool';
  return undefined;
}

/** Collects the refusals of one search (PathSearch). */
export class DigOutRefusals {
  readonly refused: DigOutReport['refused'] = {};

  add(why: DigOutRefusal, c: TerrainClass): void {
    const r = this.refused[why];
    if (r) r.count++;
    else this.refused[why] = { count: 1, block: c.name };
  }

  report(): DigOutReport {
    return { refused: { ...this.refused } };
  }
}

const REFUSAL_TEXT: Partial<Record<DigOutRefusal, string>> = {
  protected: 'protected or built',
  protected_area: 'inside the protected base',
  no_tool: 'no tool breaks it in time',
  gravity_above: 'a gravity block above',
  gravity_beside: 'an unsupported gravity block beside',
  next_to_liquid: 'water beside it',
  unbreakable: 'unbreakable',
  unknown_block: 'unknown block',
  openable: 'a door',
  blacklisted: 'a dig there failed',
  no_floor: 'no floor at the water level',
  hazard: 'a hazard',
  ice: 'ice',
  infested: 'infested',
};

/**
 * The goto's reason for a search from water that found no way out: "trapped in water: no swim exit and no step
 * to dig (stone: no tool breaks it in time x 12; stone_bricks: protected or built x 4)".
 */
export function trappedWhy(r: DigOutReport, expanded: number): string {
  const parts = Object.entries(r.refused)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([why, v]) => `${v.block}: ${REFUSAL_TEXT[why as DigOutRefusal] ?? why} x ${v.count}`);
  return `trapped in water: no swim exit and no step to dig (${parts.length ? parts.join('; ') : 'no rim block beside the surface'}; ${expanded} nodes expanded)`;
}

/** The break conditions of a dig from this body (the Digger's expected ticks: the server's in-water and off-ground modifiers, measured). */
export function waterDigConditions(s: { onGround: boolean }, headUnder: boolean): BreakConditions {
  return { ...(s.onGround ? {} : { offGround: true }), ...(headUnder ? { inWater: true } : {}) };
}
