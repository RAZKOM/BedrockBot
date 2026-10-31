// Track BL (docs/flight.md "Takeoff sites" and "Flight re-check on long walks"; decisions/0055-terrain-safe-cruise.md):
//
//   - the takeoff-site search: when the takeoff from here is refused (a roof, trees, a valley) the cells
//     within flySiteSearch blocks in any direction that stand on their column's top under open sky are
//     ranked by the estimated walk there plus the flight from there (`siteCandidates`); commands-fly.ts
//     simulates the takeoff from the best ones (any heading: the climbing turn back towards the goal is
//     part of the simulation, its corridor checked with unknown-is-not-air), probes the walk to the ones
//     that clear, and walks to the first with a path when flying from it beats walking the whole way by
//     flyPreferRatio (`preferSite`).
//   - the re-check on a long walk (`RecheckState`): the walk looks for a takeoff again every
//     flyRecheckBlocks blocks walked, when the kit becomes ready, and when the walk comes out from under a
//     roof; the landing search at most every RECHECK_SEARCH_MS, never again near a spot where the takeoff
//     was refused (RECHECK_FAIL_RADIUS, for RECHECK_FAIL_MS).
//
// Pure functions: commands-fly.ts wires them to the world model, the probe planner and the walk.
import { flightSeconds, hdist } from './plan.ts';

/** Seconds per block of the steady sprint (plan.ts walkMinutes). */
export const WALK_S_PER_BLOCK = 3.564 / 20;
/** Candidate cells are looked at on this grid (blocks) ... */
export const SITE_STEP = 2;
/** ... from this far out (nearer: the takeoff from here was just refused) ... */
export const SITE_MIN = 4;
/** ... and no more than this far above or below the feet (a roof top is no site to walk to). */
export const SITE_MAX_RISE = 12;
/** The estimated walk to a site is the straight line times this (the path bends round things). */
export const SITE_DETOUR = 1.3;
/** Takeoff simulations, walk probes and the time budget (ms) of one search. */
export const SITE_SIMS = 12;
export const SITE_PROBES = 6;
export const SITE_BUDGET_MS = 3000;

export interface SiteCell {
  x: number;
  z: number;
  /** Feet height when standing on the cell. */
  feet: number;
  /** Straight-line distance from the start. */
  dist: number;
  /** Distance from the cell to the goal. */
  flyDist: number;
  /** The estimated seconds: walk there (SITE_DETOUR) plus the flight. */
  cost: number;
}

/** Seconds of a trip: `walkBlocks` walked, then `flyDist` flown (flightSeconds: the takeoff, the climb and the landing included). */
export function siteSeconds(walkBlocks: number, flyDist: number): number {
  return walkBlocks * WALK_S_PER_BLOCK + flightSeconds(flyDist);
}

/** Walk to the site and fly: walking the whole way (`walkAll` blocks) takes more than `ratio` times as long. */
export function preferSite(walkAll: number, walkToSite: number, flyDist: number, ratio: number): boolean {
  return walkAll * WALK_S_PER_BLOCK > ratio * siteSeconds(walkToSite, flyDist);
}

/**
 * The candidate takeoff sites around `from` (within `radius`, any direction), cheapest first: cells whose
 * `landable` feet (the column's top under open sky) are within SITE_MAX_RISE of the feet; `skip` leaves
 * out cells (near a refused takeoff). The goal side is not preferred beyond what the flight saves.
 */
export function siteCandidates(
  from: { x: number; y: number; z: number },
  goal: { x: number; z: number },
  radius: number,
  landable: (x: number, z: number) => number | undefined,
  skip?: (x: number, z: number) => boolean,
): SiteCell[] {
  const out: SiteCell[] = [];
  const fx = Math.floor(from.x);
  const fz = Math.floor(from.z);
  for (let dx = -radius; dx <= radius; dx += SITE_STEP) {
    for (let dz = -radius; dz <= radius; dz += SITE_STEP) {
      const dist = Math.hypot(dx, dz);
      if (dist < SITE_MIN || dist > radius) continue;
      const x = fx + dx;
      const z = fz + dz;
      if (skip?.(x, z)) continue;
      const feet = landable(x, z);
      if (feet === undefined || Math.abs(feet - from.y) > SITE_MAX_RISE) continue;
      const flyDist = hdist({ x: x + 0.5, z: z + 0.5 }, goal);
      out.push({ x, z, feet, dist, flyDist, cost: siteSeconds(dist * SITE_DETOUR, flyDist) });
    }
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/** The re-check on a long walk: at most one landing search this often (ms) ... */
export const RECHECK_SEARCH_MS = 20_000;
/** ... no takeoff try within this many blocks of a refused one ... */
export const RECHECK_FAIL_RADIUS = 16;
/** ... for this long (ms). */
export const RECHECK_FAIL_MS = 5 * 60_000;
/** The walk is looked at this often (ms). */
export const RECHECK_EVERY_MS = 1000;

export type RecheckWhy = 'distance' | 'kit' | 'sky';

/**
 * Track BL: when a long walk should look for a takeoff again (cheap: no world scan beyond the caller's
 * `open` flag): every `every` blocks walked since the last look, when the kit has become ready, when the
 * body has come out from under a roof (`open` turned true); never near a refused takeoff, never more than
 * one landing search per RECHECK_SEARCH_MS.
 */
export class RecheckState {
  private last: { x: number; z: number } | undefined;
  private kit: boolean | undefined;
  private open: boolean | undefined;
  private searchAt = -Infinity;
  private readonly failed: { x: number; z: number; at: number }[];

  constructor(failed: { x: number; z: number; at: number }[] = []) {
    this.failed = failed;
  }

  /** A refused takeoff here (shared by the walks of a task: pass the same array). */
  refused(p: { x: number; z: number }, now: number): void {
    this.failed.push({ x: p.x, z: p.z, at: now });
  }

  /** Near a takeoff refused within RECHECK_FAIL_MS. */
  nearRefused(p: { x: number; z: number }, now: number): boolean {
    for (let i = this.failed.length - 1; i >= 0; i--) {
      const f = this.failed[i]!;
      if (now - f.at > RECHECK_FAIL_MS) this.failed.splice(i, 1);
      else if (hdist(f, p) < RECHECK_FAIL_RADIUS) return true;
    }
    return false;
  }

  /** Look again now? `p` the body, `kit` the kit ready, `open` the sky over the body open; `every` flyRecheckBlocks. */
  due(p: { x: number; z: number }, kit: boolean, open: boolean, every: number, now: number): RecheckWhy | undefined {
    const first = this.last === undefined;
    const kitNow = kit && this.kit === false;
    const skyNow = open && this.open === false;
    this.kit = kit;
    this.open = open;
    if (first) {
      this.last = { x: p.x, z: p.z };
      return undefined;
    }
    const why: RecheckWhy | undefined = kitNow ? 'kit' : skyNow ? 'sky' : hdist(this.last!, p) >= every ? 'distance' : undefined;
    if (!why || !kit) return undefined;
    if (now - this.searchAt < RECHECK_SEARCH_MS) return undefined;
    if (this.nearRefused(p, now)) return undefined;
    this.last = { x: p.x, z: p.z };
    this.searchAt = now;
    return why;
  }
}
