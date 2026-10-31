// Track BL (docs/flight.md "Terrain-safe cruise", decisions/0055): the terrain under and ahead of a flight.
// The Realm crashes of 2026-10-31 (roof / lost / landed_off 250 to 340 blocks from home, in the mountains
// north of it) had one cause: the cruise's rocket economy let the body sink along the glide line towards the
// approach entry, and that line ignored the terrain between. The cruise now keeps above a terrain floor:
//
//   floor = max over the columns s blocks ahead (every FLOOR_STEP, up to FLOOR_AHEAD, never past the target's
//           approach) of   top + 1 + clearance + s / GLIDE_RATIO     (glide over it without a rocket)
//
// with `top` from the live world model, else the world cache (`cache`), else an assumed bound (`unknown`):
// the highest known top met so far along the scan (or around the body) plus UNKNOWN_SLACK, rising
// UNKNOWN_RISE a block into the unknown, capped at the build limit. Unknown columns within HOLD_RANGE count in
// full (the body holds or climbs instead of sinking into terrain it has not received); farther ones are
// discounted by a later rocket climb (CLIMB_SLOPE), since they will load long before the body is there.
//
// `TerrainMemo` memoises the column query per column and drops a chunk's columns when the chunk arrives or
// changes (the command layer wires the chunk events), so the per-tick scan costs a map lookup per column.
import { APPROACH_DISTANCE, GLIDE_RATIO, hdist, type Obstacle } from './plan.ts';

export type TerrainSource = 'live' | 'cache' | 'unknown';
/** A column's highest solid block (`top`, undefined when unknown) and where that came from. */
export interface TerrainColumn {
  top: number | undefined;
  src: TerrainSource;
}
export type TerrainQuery = (x: number, z: number) => TerrainColumn;

/** The highest block is y 319: a body whose feet are at 320 or more cannot hit anything. */
export const BUILD_TOP = 320;
/** Track BL: the high cruise flies this far over the build limit (feet y HIGH_CRUISE_Y). */
export const HIGH_MARGIN = 8;
export const HIGH_CRUISE_Y = BUILD_TOP + HIGH_MARGIN;
/** An unknown column is assumed this much higher than the highest known top seen before it along the scan. */
export const UNKNOWN_SLACK = 24;
/** ... and this much more per block into the unknown. */
export const UNKNOWN_RISE = 0.25;
/** Unknown columns within this many blocks ahead count in full (hold, never sink into them). */
export const HOLD_RANGE = 64;
/** The terrain floor looks this far ahead along the heading (blocks), every FLOOR_STEP blocks. */
export const FLOOR_AHEAD = 200;
export const FLOOR_STEP = 2;
/** Blocks of ground a rocket climb takes per block of height, pessimistic (the measured 1.25 plus the reaction). */
export const CLIMB_SLOPE = 1.6;
/** The floor stops this far before the target (the approach and the descent geometry take the last stretch). */
export const FLOOR_STOP = APPROACH_DISTANCE - 16;

export interface TerrainFloor {
  /** The least feet height the body should have now (undefined when nothing was scanned). */
  need: number | undefined;
  /** The column that sets it: blocks ahead, its top and the top's source ('assumed' = an unknown column's bound). */
  at: number;
  top: number;
  src: TerrainSource | 'assumed';
  x: number;
  z: number;
  /** Columns scanned that were unknown (no live data, no cache) and cache-only. */
  unknown: number;
  cached: number;
  /** The highest known (live or cache) top of the scan. */
  knownMax: number | undefined;
}

/** The assumed top of an unknown column `beyond` blocks past the last known one, from the highest known top before it. */
export function assumedTop(knownMax: number, beyond: number): number {
  return Math.min(BUILD_TOP, knownMax + UNKNOWN_SLACK + UNKNOWN_RISE * Math.max(0, beyond));
}

/**
 * The terrain floor ahead of `from` towards `toward` (see the file comment). `seedTop` is the highest known
 * top around the body (the bound for unknown columns before any known one); `stopAt` is the target (the
 * scan ends FLOOR_STOP before it).
 */
export function terrainFloor(q: TerrainQuery, from: { x: number; z: number }, toward: { x: number; z: number }, o: { clearance: number; ahead?: number; stopAt?: { x: number; z: number }; seedTop?: number }): TerrainFloor {
  const d = hdist(from, toward);
  const ux = d > 1e-6 ? (toward.x - from.x) / d : 0;
  const uz = d > 1e-6 ? (toward.z - from.z) / d : 1;
  const stop = o.stopAt ? hdist(from, o.stopAt) - FLOOR_STOP : Infinity;
  const len = Math.min(o.ahead ?? FLOOR_AHEAD, stop);
  const out: TerrainFloor = { need: undefined, at: 0, top: 0, src: 'live', x: 0, z: 0, unknown: 0, cached: 0, knownMax: undefined };
  let knownMax = o.seedTop;
  let lastKnown = 0;
  for (let s = FLOOR_STEP; s <= len; s += FLOOR_STEP) {
    const x = Math.floor(from.x + ux * s);
    const z = Math.floor(from.z + uz * s);
    const c = q(x, z);
    let top: number;
    let src: TerrainFloor['src'];
    let need: number;
    if (c.top !== undefined && c.src !== 'unknown') {
      top = c.top;
      src = c.src;
      if (c.src === 'cache') out.cached++;
      knownMax = knownMax === undefined ? top : Math.max(knownMax, top);
      out.knownMax = out.knownMax === undefined ? top : Math.max(out.knownMax, top);
      lastKnown = s;
      need = top + 1 + o.clearance + s / GLIDE_RATIO;
    } else {
      out.unknown++;
      if (knownMax === undefined) continue; // nothing known to bound it by (never the case in flight: the start is known)
      top = assumedTop(knownMax, s - lastKnown);
      src = 'assumed';
      need = top + 1 + o.clearance + Math.min(s, HOLD_RANGE) / GLIDE_RATIO - Math.max(0, s - HOLD_RANGE) / CLIMB_SLOPE;
    }
    if (out.need === undefined || need > out.need) Object.assign(out, { need, at: s, top, src, x, z });
  }
  return out;
}

/**
 * Track BL: a cell query for the dive descent's corridor where unknown is not air: a live column answers
 * from `obstacle`; a column the cache alone knows is solid up to its top; an unknown column is solid up to
 * its assumed bound (`knownMax` + UNKNOWN_SLACK).
 */
export function strictObstacle(q: TerrainQuery, obstacle: Obstacle | undefined, knownMax: number): Obstacle {
  return (x, y, z) => {
    const c = q(x, z);
    if (c.src === 'live') return obstacle ? obstacle(x, y, z) : c.top !== undefined && y <= c.top;
    if (c.src === 'cache') return c.top !== undefined && y <= c.top;
    return y <= assumedTop(knownMax, 0);
  };
}

/** Track BL: `auto` takes the high cruise only for trips this long ... */
export const HIGH_AUTO_MIN = 1500;
/** ... whose glide needs nearly that height anyway (within this much of HIGH_CRUISE_Y) ... */
export const HIGH_AUTO_SLACK = 40;

/**
 * Track BL (flyHighCruise): fly the high cruise? `always`; never with `off`; `auto` for a long trip
 * (HIGH_AUTO_MIN) over terrain the bot has never seen (unknown columns under the line, neither live nor in
 * the cache) whose glide needs within HIGH_AUTO_SLACK of the high cruise's height anyway. Measured offline
 * (docs/flight.md "High cruise"): 2300 blocks from y 70 cost 19 rockets high against 6 on the economy, so
 * the economy with the terrain floor stays the default wherever the terrain is known.
 */
export function highCruiseWanted(mode: string, o: { distance: number; needed: number; unknown: number }): boolean {
  if (mode === 'always') return true;
  if (mode !== 'auto') return false;
  return o.distance >= HIGH_AUTO_MIN && o.unknown > 0 && o.needed >= HIGH_CRUISE_Y - HIGH_AUTO_SLACK;
}

/** A column key (any int x, z within +-2^20). */

const keyOf = (x: number, z: number): number => (x + 1048576) * 2097152 + (z + 1048576);

/**
 * Track BL: a memo of a TerrainQuery per column. Known columns stay until their chunk is invalidated
 * (`invalidateChunk`: the chunk arrived or a block in it changed); unknown ones are asked again after
 * `unknownTtl` calls of `tick()` (a chunk event may be missed; the flight ticks it every game tick).
 */
export class TerrainMemo {
  private readonly memo = new Map<number, { c: TerrainColumn; at: number }>();
  private now = 0;
  private readonly base: TerrainQuery;
  private readonly unknownTtl: number;
  constructor(base: TerrainQuery, unknownTtl = 20) {
    this.base = base;
    this.unknownTtl = unknownTtl;
  }

  readonly query: TerrainQuery = (x, z) => {
    const k = keyOf(x, z);
    const m = this.memo.get(k);
    if (m && (m.c.src !== 'unknown' || this.now - m.at < this.unknownTtl)) return m.c;
    const c = this.base(x, z);
    this.memo.set(k, { c, at: this.now });
    return c;
  };

  tick(): void {
    this.now++;
    if (this.memo.size > 200_000) this.memo.clear();
  }

  invalidateChunk(cx: number, cz: number): void {
    for (let dx = 0; dx < 16; dx++) for (let dz = 0; dz < 16; dz++) this.memo.delete(keyOf(cx * 16 + dx, cz * 16 + dz));
  }

  clear(): void {
    this.memo.clear();
  }
}
