// Track F2: the voxel grid the route planner searches and the swept collision of the gliding box through it.
//
// The body while gliding is a 0.6 x 0.6 x 0.6 box over the feet (physics.ts GLIDE.height; moveBody moves
// that box). One tick of flight moves it up to about 2.5 blocks, more than a cell, so a check at the tick's
// end alone can step through a one-block wall (plan.ts pathAhead checks the midpoint too). Here the whole
// move is swept: the hull of the box at the tick's start and end, grown by the margin, against every cell it
// overlaps. An unknown cell is solid (a ceiling the model has not loaded is still a ceiling; the cruise's
// skyQuery does the opposite on purpose, and the takeoff sky check does this).
import type { Vec3 } from '../../../connection/types.ts';
import { GLIDE, PHYSICS } from '../../input/physics.ts';
import type { BlockQuery } from '../../input/types.ts';
import { RISK_RANGE } from './types.ts';

/** The grid the search reads: `solid` is true for a solid or unknown cell. */
export interface RouteGrid {
  solid(x: number, y: number, z: number): boolean;
  /** Track F6: the box the grid knows (a worker's snapshot: everything outside is solid), so a distance field (field.ts) can stay inside it. */
  bounds?: { min: Vec3; size: Vec3 };
}

/** A RouteGrid over a BlockQuery: unknown cells are solid (`unknownSolid`, default true). */
export function gridOf(q: BlockQuery, unknownSolid = true): RouteGrid {
  return { solid: (x, y, z) => q.solidAt(x, y, z) ?? unknownSolid };
}

/** A grid over a set of solid cells (the tests, the worker's snapshot). */
export function gridOfCells(solid: (x: number, y: number, z: number) => boolean): RouteGrid {
  return { solid };
}

export interface SweepResult {
  /** The hull of the move (the margin included) overlaps a solid cell. */
  hit: boolean;
  /** The distance from the hull (without the margin) to the nearest solid cell within RISK_RANGE, else RISK_RANGE. */
  clearance: number;
}

const HALF = PHYSICS.width / 2;
const H = GLIDE.height;

/** The move is sampled every this many blocks (the box at each sample is tested, not the hull: a diagonal move in a diagonal bore would fail on the hull's corners). */
export const SWEEP_STEP = 0.25;

/**
 * Sweep the gliding box from feet `from` to feet `to` through `grid` with `margin` around it, the way
 * moveBody moves it: first the whole y move, then x, then z (an L-shaped path, not the straight line: a
 * body climbing a 45-degree stair rises into the step's ceiling before it goes forward). The box at every
 * SWEEP_STEP along the three legs (the corners included) is tested against the solid cells of the move's
 * hull grown by RISK_RANGE: a hit when a solid cell is within the margin of any sampled box, else the least
 * distance from the box to a solid (the risk term, capped at RISK_RANGE).
 */
export function sweep(grid: RouteGrid, from: Vec3, to: Vec3, margin: number): SweepResult {
  const r = RISK_RANGE;
  const hx0 = Math.min(from.x, to.x) - HALF - r;
  const hx1 = Math.max(from.x, to.x) + HALF + r;
  const hy0 = Math.min(from.y, to.y) - r;
  const hy1 = Math.max(from.y, to.y) + H + r;
  const hz0 = Math.min(from.z, to.z) - HALF - r;
  const hz1 = Math.max(from.z, to.z) + HALF + r;
  // the solid cells of the hull (half-open on the far side: a face on a cell boundary is not inside the next cell)
  const solids: number[] = [];
  for (let y = Math.floor(hy0); y <= Math.ceil(hy1) - 1; y++) {
    for (let z = Math.floor(hz0); z <= Math.ceil(hz1) - 1; z++) {
      for (let x = Math.floor(hx0); x <= Math.ceil(hx1) - 1; x++) if (grid.solid(x, y, z)) solids.push(x, y, z);
    }
  }
  if (!solids.length) return { hit: false, clearance: r };
  let clearance = r;
  // the box at feet (px, py, pz) against the solids: the hit, or the least gap folded into `clearance`
  const test = (px: number, py: number, pz: number): boolean => {
    const x0 = px - HALF;
    const x1 = px + HALF;
    const y1 = py + H;
    const z0 = pz - HALF;
    const z1 = pz + HALF;
    for (let i = 0; i < solids.length; i += 3) {
      const x = solids[i]!;
      const y = solids[i + 1]!;
      const z = solids[i + 2]!;
      // the gap between the box and the unit cell on each axis
      const dx = Math.max(0, x - x1, x0 - (x + 1));
      const dy = Math.max(0, y - y1, py - (y + 1));
      const dz = Math.max(0, z - z1, z0 - (z + 1));
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= margin) return true;
      if (d < clearance) clearance = d;
    }
    return false;
  };
  // the three legs of the move in moveBody's order
  const legs: [number, number, number][] = [
    [from.x, to.y, from.z],
    [to.x, to.y, from.z],
    [to.x, to.y, to.z],
  ];
  let px = from.x;
  let py = from.y;
  let pz = from.z;
  if (test(px, py, pz)) return { hit: true, clearance: 0 };
  for (const [lx, ly, lz] of legs) {
    const mx = lx - px;
    const my = ly - py;
    const mz = lz - pz;
    const len = Math.abs(mx) + Math.abs(my) + Math.abs(mz);
    if (len === 0) continue;
    const n = Math.max(1, Math.ceil(len / SWEEP_STEP));
    for (let j = 1; j <= n; j++) {
      const f = j / n;
      if (test(px + mx * f, py + my * f, pz + mz * f)) return { hit: true, clearance: 0 };
    }
    px = lx;
    py = ly;
    pz = lz;
  }
  return { hit: false, clearance };
}

/** The box at rest at `p` (no move) against the grid: the start state's own check. */
export function boxClear(grid: RouteGrid, p: Vec3, margin: number): SweepResult {
  return sweep(grid, p, p, margin);
}

/** The lowest solid cell at or under `y` in column (x, z) within `depth` cells, as the feet height on it; undefined when none. */
export function floorUnder(grid: RouteGrid, x: number, y: number, z: number, depth = 64): number | undefined {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  for (let cy = Math.floor(y) - 1; cy >= Math.floor(y) - depth; cy--) if (grid.solid(cx, cy, cz)) return cy + 1;
  return undefined;
}
