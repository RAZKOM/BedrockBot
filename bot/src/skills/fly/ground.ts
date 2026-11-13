// Track F11 (docs/flight.md "The flight comes down where it planned to", decisions/0084): what the "nearest safe ground"
// of a forced or a priced landing may be (commands-fly.ts groundAt, brain.ts emergencyTarget). The Realm's flights of
// 2026-11-13 ended standing on fence tops and roof edges 5 to 9 blocks over a yard: places a body cannot walk off without
// a fall that hurts, and one of them a place the walk could not even start from. The column tops alone do not tell them
// from ground: a fence line on flat ground and a stepped roof both have "level neighbours". Two rules, pure functions
// over the world model:
//
//   - the shape (`standsOn`): the top block's collision boxes must end no higher than its own cell (a fence, a wall and a
//     fence gate stand 1.5 high: the body on them is half a block over where the column top says) and their top face must
//     be at least half a block wide both ways (a pane, bars, a chain, a post);
//   - the perch (`perched`): where a dry floor lies more than a safe fall under the top within PERCH_REACH blocks, the top
//     must walk down to it: a flood over the column tops, a block up or up to SAFE_FALL down a step, has to reach a
//     column within SAFE_FALL of that floor. A roof, a wall's top and a pillar do not; a hillside does, and so does a
//     platform over the sea (the sea floor is no floor to walk on).
// The landing search asks the first of its cells as well (landing.ts floorsOf: `Floor.post`).
import type { Box } from '../../world/types.ts';

/** A fall of this many blocks or fewer costs nothing (skills/fall/damage.ts SAFE_FALL). */
export const SAFE_FALL = 3;
/** A floor this near (blocks, each way) under a top makes the top a perch unless it walks down to it. */
export const PERCH_REACH = 8;
/** The flood may go this far from the top (each way) on its way down. */
export const PERCH_FLOOD = 12;
/** The least width (blocks, both ways) of the top face a body stands on. */
export const STAND_WIDTH = 0.5;

/** The top block of a column as a place to stand: `floor`; `tall` (its boxes reach over its cell: a fence, a wall); `thin` (a pane, bars, a post); `none` (no collision box). */
export function standsOn(boxes: readonly Box[]): 'floor' | 'tall' | 'thin' | 'none' {
  if (!boxes.length) return 'none';
  let top = -Infinity;
  for (const b of boxes) top = Math.max(top, b[4]);
  if (top > 1 + 1e-6) return 'tall';
  // the top face: the boxes that reach the top, taken together
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const b of boxes) {
    if (b[4] < top - 1e-6) continue;
    x0 = Math.min(x0, b[0]);
    x1 = Math.max(x1, b[3]);
    z0 = Math.min(z0, b[2]);
    z1 = Math.max(z1, b[5]);
  }
  return x1 - x0 >= STAND_WIDTH - 1e-6 && z1 - z0 >= STAND_WIDTH - 1e-6 ? 'floor' : 'thin';
}

/**
 * The column top at (x, z) with feet height `feet` is a perch: a floor lies more than SAFE_FALL under it within
 * PERCH_REACH blocks and no walk leads down to it (a flood over the tops from here, 4-way, a block up or up to SAFE_FALL
 * down a step, within PERCH_FLOOD, reaches no column within SAFE_FALL of that floor). `feetAt(x, z)`: the feet height on a
 * column's top, undefined where the model has nothing (such a column is neither floor nor way). `dry(x, z)`: the column
 * is a floor to stand on (not under water: a platform over the sea has no floor in reach, and is no perch).
 */
export function perched(feetAt: (x: number, z: number) => number | undefined, x: number, z: number, feet: number, dry: (x: number, z: number) => boolean = () => true): boolean {
  let floor = feet;
  for (let dx = -PERCH_REACH; dx <= PERCH_REACH; dx += 2) {
    for (let dz = -PERCH_REACH; dz <= PERCH_REACH; dz += 2) {
      const f = feetAt(x + dx, z + dz);
      if (f !== undefined && f < floor && dry(x + dx, z + dz)) floor = f;
    }
  }
  if (feet - floor <= SAFE_FALL) return false;
  const key = (dx: number, dz: number): number => (dx + 64) * 256 + (dz + 64);
  const seen = new Set<number>([key(0, 0)]);
  const queue: [number, number, number][] = [[0, 0, feet]];
  // (the queue grows while it is read: a breadth-first flood)
  for (const [dx, dz, at] of queue) {
    if (at <= floor + SAFE_FALL) return false;
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = dx + sx;
      const nz = dz + sz;
      if (Math.abs(nx) > PERCH_FLOOD || Math.abs(nz) > PERCH_FLOOD) continue;
      const k = key(nx, nz);
      if (seen.has(k)) continue;
      const f = feetAt(x + nx, z + nz);
      if (f === undefined || f - at > 1 || at - f > SAFE_FALL) continue;
      seen.add(k);
      queue.push([nx, nz, f]);
    }
  }
  return true;
}
