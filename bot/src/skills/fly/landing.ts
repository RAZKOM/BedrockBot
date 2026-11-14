// The landing cell of a flight that ends in a walk (wave 11, Track BF; docs/flight.md "Landing v3",
// decision 0047). Two Realm failures shaped it: a flight that "landed" on the sea floor (the highest
// solid of a column under 15 blocks of water was taken for ground) and one that landed on the roof
// of a 30 x 30 creeper spawning box because the cell came from the world cache and no walking path
// from it was ever checked. The rules here:
//
//   - only dry ground: a floor with a liquid (water, lava, kelp, seagrass, a bubble column) in the
//     body's cells or one above is never a landing cell (`Floor.wet`), nor a hazard (lava, cactus,
//     magma, fire, a lily pad, ...)
//   - only the live world model: a column the server has not sent is never landed on (the cache may
//     predate a structure), the search says `unknown` and the flight holds high until it arrives
//   - only a confirmed path: every landing cell has a bounded walking plan (reach.ts probePath, no
//     digging, no pillars) from its feet to the goal; candidates are probed nearest first (by the
//     straight distance plus three per block of height) within a probe and time budget, and a cell
//     next to one whose probe exhausted the space without a path is skipped (the same plateau)
//   - under an overhang: a floor whose ceiling is `headroom` (4) or more above the feet counts when an
//     open corridor leads in from the side (`corridorsOf`: at most `maxUnder` blocks under the roof,
//     the body's cells free, the open approach beyond it) and the approach planner's simulation from
//     the corridor's entry lands on it (`corridorLands`, the same physics and obstacle model the
//     flight flies with)
//   - a walk landing accepts a touchdown anywhere in the landing cell's flat dry neighbourhood (the
//     cells of the same floor connected to it, every one walks to it), so a touchdown a few blocks
//     off the centre is no reason to go around (`LandingTarget.cells`, plan.ts touchdownCost)
//   - nothing confirmed: the nearest safe dry ground (the flight lands there, says so, and the walk
//     still runs: it may find a way the bounded probe missed)
//   - Track F1, a precision goal (`!fly <x y z>` onto a cell that is no plain floor: a pillar top, a shaft
//     floor, an edge, a cell under a roof 3 above): dry and safe, it is the target itself (`precise`, the
//     shaft's `rim`, its floor's `cells`) when the brake / elevator landing's simulation (brake.ts) lands
//     on it, from above or along a corridor (`preciseGoal`); `style flare` keeps the Track BF behaviour
//   - Track L1, landing by time (docs/flight.md "Landing by time", decisions/0076): a covered goal (a cave, a
//     room) ranks its candidates by a flood of the walk from the goal out (`walkFlood`: the cave mouth's open
//     ground first, not the hill over it); an open cell is offered only when the approach simulated from where the
//     flight will come in (over the terrain on that side) lands on it (`approachLands`: the Realm's cave mouth in
//     a valley under a hill was flown 4 times round before); the cheapest landings beside the chosen one ride on it
//     as `alternatives`, each priced in seconds of walk (landprice.ts), for a missed approach to land on instead of
//     a go-around; a partly loaded window can still answer (`partial`) with the least walk the unloaded part could
//     offer, for the hold's price
//   - Track L2: a confirmed walk is priced by the probe's own plan (its ticks, landprice.ts probeTicks), the cells ranked
//     by that price in seconds; a covered goal's first cells by the walk flood get a longer probe (`LONG_PROBE`), cut to
//     the search time left, so the owner's cave's cells are confirmed instead of falling back unpriced
import type { Vec3 } from '../../connection/types.ts';
import type { Box } from '../../world/types.ts';
import { BrakePlanner } from './brake.ts';
import { standsOn } from './ground.ts'; // Track F11
import { PATH_MIN_S_PER_BLOCK, UNKNOWN_DETOUR, UNKNOWN_RISK_S, WALK_S_PER_BLOCK, walkPriceOf, walkSeconds, type WalkPrice } from './landprice.ts'; // Track L1; Track L2: the walk by its path
import { ApproachPlanner, APPROACH_DISTANCE, APPROACH_HEIGHT, columnKey, entryTop, hdist, landingRim, OVER, rimReach, wayIn, yawDiff, yawDir, yawTo, type FlightBody, type LandingTarget, type Obstacle } from './plan.ts';
import type { RouteGrid } from './route/grid.ts'; // Track F3
import { planLandingRoute, type LandingRouteSpec } from './route/landing.ts'; // Track F3
import type { KitBurn } from './route/types.ts'; // Track F10
import type { Planner } from './route/tracker.ts'; // Track F3

/** A cell of the live world model as the search sees it. */
export interface CellBlock {
  readonly name: string;
  readonly solid: boolean;
  /** Track F11: the block's collision boxes where the caller has them (the live model's blocks do): a floor on a fence, a wall, a pane or a post is no landing cell (ground.ts standsOn). */
  readonly boxes?: readonly Box[];
}
/** The live world model: undefined = the cell is not loaded. */
export type BlockLookup = (x: number, y: number, z: number) => CellBlock | undefined;

const LIQUID = /^(flowing_)?(water|lava)$|^bubble_column$|kelp|seagrass/;
const HAZARD = /lava|cactus|magma|fire|portal|sweet_berry|powder_snow|wither_rose|pointed_dripstone|waterlily|lily_pad|scaffolding/;
/** A cell holding a liquid (or a plant that only grows in water). */
export const isLiquidName = (name: string): boolean => LIQUID.test(name);
/** A block nobody lands on or in. */
export const isHazardName = (name: string): boolean => HAZARD.test(name);

/** No solid within this many blocks above the feet: open sky (the Track AU2 rule). */
export const OPEN_SKY = 20;
/** The body's cells and one above must be free of liquid: feet .. feet + WET_ABOVE - 1. */
export const WET_ABOVE = 3;

/** A floor of a column: a solid block with two free cells over it. */
export interface Floor {
  /** Feet height of a body standing on it (the block's y + 1). */
  feet: number;
  /** The first solid above the feet (undefined: none up to the scan's top). */
  ceiling: number | undefined;
  /** A liquid in feet .. feet + WET_ABOVE - 1. */
  wet: boolean;
  /** The floor block or the cell above it is a hazard. */
  hazard: boolean;
  /** Track F11: the floor block is nothing a body stands on as on a floor (a fence, a wall, a gate: 1.5 high; a pane, bars, a post): a way for a walk, never a landing cell. */
  post?: boolean;
}

/** The floors of column (x, z) from `yTop` down to `yBottom` (live cells only); undefined when the column is not loaded. */
export function floorsOf(look: BlockLookup, x: number, z: number, yTop: number, yBottom: number): Floor[] | undefined {
  const out: Floor[] = [];
  // cells above the first loaded one count as air (sub-chunks above the terrain may never be sent); a gap below it ends the scan
  let known = false;
  let ceiling: number | undefined;
  // the three cells above the current one (y + 1, y + 2, y + 3): [solid, liquid, name]
  let a1: CellBlock | undefined;
  let a2: CellBlock | undefined;
  let a3: CellBlock | undefined;
  for (let y = yTop; y >= yBottom; y--) {
    const b = look(x, y, z);
    if (b === undefined) {
      if (known) break;
      a3 = a2;
      a2 = a1;
      a1 = undefined;
      continue;
    }
    known = true;
    if (b.solid) {
      const free = (c: CellBlock | undefined) => !c?.solid;
      if (y + 2 <= yTop && free(a1) && free(a2)) {
        const wet = [a1, a2, a3].some((c) => c !== undefined && isLiquidName(c.name));
        // (a solid with no boxes given says nothing of its shape)
        const post = b.boxes !== undefined && b.boxes.length > 0 && standsOn(b.boxes) !== 'floor';
        out.push({ feet: y + 1, ceiling, wet, hazard: isHazardName(b.name) || (a1 !== undefined && isHazardName(a1.name)), ...(post ? { post } : {}) });
      }
      ceiling = y;
    }
    a3 = a2;
    a2 = a1;
    a1 = b;
  }
  return known ? out : undefined;
}

/**
 * Track F14: the lowest solid of column (x, z) from `from` up to the first cell that is not loaded, at the most to `to`
 * (the highest y of the column that may hold a block, where the caller knows it: LandingDeps.maxY; else the world's top);
 * undefined: none.
 */
export function solidOver(look: BlockLookup, x: number, z: number, from: number, to = 319): number | undefined {
  for (let y = from; y <= Math.min(319, to); y++) {
    const b = look(x, y, z);
    if (b === undefined) return undefined;
    if (b.solid) return y;
  }
  return undefined;
}

export type CandidateKind = 'open' | 'roof';

export interface Candidate {
  x: number;
  z: number;
  feet: number;
  kind: CandidateKind;
  ceiling: number | undefined;
  /** The ranking estimate: the straight distance plus three per block of height. */
  est: number;
  /** A lower bound of any walk from it: the straight 3D distance. */
  lb: number;
}

/**
 * A probe's answer. Track L2: a found walk carries the probe's planned ticks (landprice.ts probeTicks) when the caller has
 * them: the walk is then priced by its path, not by its blocks.
 */
export type ProbeOutcome = { status: 'found'; blocks: number; ticks?: number } | { status: 'none' } | { status: 'limited' } | { status: 'nostart' };

/** Track L2: the budget of one probe (nodes, and search ms summed over its slices). */
export interface ProbeBudget {
  nodes: number;
  ms: number;
}

export interface LandingDeps {
  look: BlockLookup;
  /** Solid cells for the approach simulation (the flight's obstacle model; unknown = free). */
  obstacle: Obstacle;
  /**
   * A bounded walking plan from feet `from` to the goal (no digging, no pillars). Without it nothing is confirmed. Track L2:
   * `budget` asks a longer probe than the caller's own (the walk flood's first cells, `LONG_PROBE`); absent, the caller's.
   */
  probe?: (from: Vec3, budget?: ProbeBudget) => Promise<ProbeOutcome>;
  /** Safe dry ground of a column under open sky (feet), the fallback beyond the candidates. */
  dryGround?: (x: number, z: number) => number | undefined;
  /** Let the event loop run (the search is sliced). */
  yieldNow?: () => Promise<void>;
  now?: () => number;
  /**
   * Track F3: the route planner for a precision goal the brake cannot land (a cell under a roof 2 above, a
   * hole, a 1 x 1 shaft): the grid (the live model, unknown = solid), the search (the worker's planner; in-thread
   * when absent) and the rockets the plan may use. Absent (or `flyRoute off`): the Track F1 search only.
   * `first` (Track F4a) overrides ROUTE_FIRST: true asks the route before the brake for every precision goal,
   * false only after it.
   */
  route?: { grid: RouteGrid; plan?: Planner; rockets?: number; first?: boolean; /** Track F10: the burn of the rockets in the hand where it is not the plain one's (route/landing.ts LandingRouteOptions.kit). */ kit?: Readonly<KitBurn> };
  /**
   * Track F14: the highest solid block of a column (the flight's own column tops: the live model, else the cache), for the
   * rim of a cell with something standing round it (plan.ts landingRim, as the brain reads it). Absent: the search's own
   * floors (`viewTops`: a column whose top it cannot see is unknown).
   */
  skyTop?: (x: number, z: number) => number | undefined;
  /**
   * Track F14: the highest y of a column that may hold a block (the live model: the top of its highest section that is
   * not all air; world/chunks.ts topY), so that the look for a roof over the search's window ends there. Absent: the look
   * goes to the first cell that is not loaded, at the most to the world's top.
   */
  maxY?: (x: number, z: number) => number | undefined;
}

export interface LandingOptions {
  /** Candidates within this many blocks of the goal (flyLandSearch). */
  radius: number;
  /** A ceiling at least this many blocks above the feet makes a floor an overhang candidate (flyHeadroom). */
  headroom: number;
  /** At most this many blocks of the corridor under the roof (flyOverhangDepth). */
  maxUnder: number;
  /** Probe plans per search (flyLandProbes). */
  probes: number;
  /** Time budget of the search in ms (probes and simulations). */
  budgetMs: number;
  /** Land on the goal itself when it is landable (`!fly <x y z>`): an exact landing of this half width. */
  exact?: number;
  /** Share of the candidate columns that must be live, else the search is `unknown` (partly loaded). */
  liveShare?: number;
  /** Track F1: the landing family (flyLandStyle): `flare` keeps the Track BF search; `auto` / `brake` add the precision goal and the brake's corridors. */
  style?: 'auto' | 'flare' | 'brake';
  /** Track F3: where the flight comes from (the body now): a route landing's bearings are tried from that side first. */
  from?: { x: number; z: number };
  /**
   * Track F8: the feet height of the rim the body must come down inside to reach an exact goal (the corridor executor's
   * opening in a cave's roof: the plane of the y portal the way goes down through). `preciseGoal` scans the rim round a
   * shaft floor only OPEN_SKY up and only where the walls touch the cell, so the dry floor under a wide, deep opening
   * (the owner's cave: 46 blocks under the rim, the pit 11 across) read as a precision cell under open sky whose simulated
   * approach flew into the pit's wall, and the cruise landed on the surface beside it. With the rim given the brake landing
   * is simulated in over it and the elevator sinks down inside.
   */
  rim?: number;
  /**
   * Track L1: answer from the loaded columns even when under `liveShare` of the window is live (the hold's look: a
   * confirmed landing on the loaded part, with `unloaded` saying how near the goal the unloaded part comes).
   */
  partial?: boolean;
  /**
   * Track L2: the longer probes for a covered goal's first cells by the walk flood (default LONG_PROBE; `count` 0: none).
   * Each is capped at the search time left (`budgetMs`), so the search's total time is kept.
   */
  longProbe?: { count: number } & ProbeBudget;
  /**
   * Track F14 (docs/flight.md "The way down to the landing"; decisions/0085; the setting `flyWayDown`): a landing lies
   * under the sky and has a way down to it. With it: a floor is `open` only with nothing over it to the top of what is
   * loaded (ColumnView.sky), and a corridor in under a roof ends under such a column; a covered goal's walk flood goes on
   * to the cave's mouth and the open ground there is a candidate however far it is (FLOOD_FAR); an open cell is offered
   * only with a simulated way down: in over what stands round it and straight down where something does (`overLands`, as
   * the brain will fly it), else an approach along one of four bearings; never because the simulations ran out
   * (APPROACH_SIMS_SKY of them).
   */
  sky?: boolean;
}

export interface LandingCell {
  x: number;
  z: number;
  feet: number;
  kind: CandidateKind | 'goal' | 'ground';
  /** Track F1: a precision goal (no plain floor: stillLandable checks it dry, safe and with PRECISE_HEADROOM). */
  precise?: boolean;
  /** Track F3: a route landing (the room over it may be as little as ROUTE_HEADROOM). */
  route?: boolean;
}

/** Track L1: a search on a partly loaded window (`LandingOptions.partial`): the live share and the least straight distance from the goal to an unloaded candidate column. */
export interface Unloaded {
  live: number;
  columns: number;
  /** Blocks: no landing on the unloaded part can walk less than this. */
  bound: number;
}

export type LandingPlan =
  | { kind: 'unknown'; line: string }
  | { kind: 'goal'; cell: LandingCell; walk: 0; target: LandingTarget; line: string }
  | { kind: 'cell'; cell: LandingCell; walk: number; target: LandingTarget; line: string; unloaded?: Unloaded }
  | { kind: 'fallback'; cell: LandingCell; walk: number; target: LandingTarget; line: string; why: string }
  | { kind: 'none'; line: string };

/** The acceptance radius of a walk landing that walks `walk` blocks (more walk, more slack). */
export function walkSlack(walk: number): number {
  return Math.min(5, 1.5 + walk / 10);
}

const fmtCell = (c: { x: number; z: number; feet: number }): string => `${c.x} ${c.feet} ${c.z}`;

/**
 * The column view of one search: floors memoised per column over a fixed height window around the
 * goal (feet from goal - 32 to goal + 48; the open-sky test needs 20 above, so the scan starts 72 up).
 */
export class ColumnView {
  private readonly memo = new Map<number, Floor[] | null>();
  readonly yTop: number;
  readonly yBottom: number;
  lookups = 0;
  private readonly look: BlockLookup;
  /**
   * Track F14 (docs/flight.md "The way down to the landing"; decisions/0085; the setting `flyWayDown`): open sky is the
   * sky. Without it a floor with OPEN_SKY (20) blocks of room over it is `open` whatever stands over that: the floor of
   * a cavern whose roof is 21 over it, under 50 blocks of mountain, was a landing under the open sky (the Realm,
   * 2026-11-14: nine flights to goals under a mountain were sent to such floors and came down on the mountain's top).
   * With it a floor's `ceiling` is looked for to the top of what is loaded in its column, and a floor with any ceiling
   * is an overhang cell (`roof`: landable only along a corridor that reaches the sky) or nothing.
   */
  readonly sky: boolean;
  /** Track F14: the highest y of a column that may hold a block (LandingDeps.maxY), where the caller knows it. */
  readonly maxY: ((x: number, z: number) => number | undefined) | undefined;

  constructor(look: BlockLookup, goalY: number, o: { sky?: boolean; maxY?: (x: number, z: number) => number | undefined } = {}) {
    this.look = look;
    this.yTop = Math.min(319, Math.floor(goalY) + 72);
    this.yBottom = Math.max(-64, Math.floor(goalY) - 36);
    this.sky = o.sky === true;
    this.maxY = o.maxY;
  }

  floors(x: number, z: number): Floor[] | undefined {
    const k = columnKey(x, z);
    const hit = this.memo.get(k);
    if (hit !== undefined) return hit ?? undefined;
    this.lookups++;
    const f = floorsOf(this.look, x, z, this.yTop, this.yBottom);
    // Track F14: what stands over the window in this column is a ceiling too (the lowest solid from the window's top up to
    // the first cell that is not loaded: the sub-chunks over a column's highest block are never sent)
    if (this.sky && f?.some((fl) => fl.ceiling === undefined)) {
      const over = solidOver(this.look, x, z, this.yTop + 1, this.maxY?.(x, z));
      if (over !== undefined) for (const fl of f) fl.ceiling ??= over;
    }
    this.memo.set(k, f ?? null);
    return f;
  }

  floorNear(x: number, z: number, feet: number, within = 1): Floor | undefined {
    let best: Floor | undefined;
    for (const f of this.floors(x, z) ?? []) if (Math.abs(f.feet - feet) <= within && (!best || Math.abs(f.feet - feet) < Math.abs(best.feet - feet))) best = f;
    return best;
  }

  /** The floor's class: open sky, an overhang with `headroom` or more, or nothing to land on. */
  kindOf(f: Floor, headroom: number): CandidateKind | undefined {
    if (f.ceiling === undefined) return f.feet + OPEN_SKY <= this.yTop ? 'open' : undefined;
    const room = f.ceiling - f.feet;
    // (Track F14: with `sky` a roof is a roof however high it is)
    if (room > OPEN_SKY && !this.sky) return 'open';
    return room >= headroom ? 'roof' : undefined;
  }

  /** Dry, no hazard, and level neighbours (each of the four has a floor within a block: neither a 1-wide column nor a hole nor an edge). */
  sound(x: number, z: number, f: Floor): boolean {
    if (f.wet || f.hazard || f.post) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = this.floorNear(x + dx, z + dz, f.feet);
      if (!n || n.wet || n.hazard) return false;
    }
    return true;
  }

  /**
   * At least three of the four neighbours are floors at exactly this height (a touchdown slides about a
   * block: a single cell between steps, like the first step of a 1-wide trench, is a precision landing
   * into a slot; bds-fly fly-walk: 4 go-arounds onto such a 1-cell target).
   */
  level(x: number, z: number, f: Floor): boolean {
    let n = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const g = this.floorNear(x + dx, z + dz, f.feet, 0);
      if (g && !g.wet && !g.hazard) n++;
    }
    return n >= 3;
  }
}

/** An open corridor into an overhang: the bearing (Bedrock yaw, from the cell outwards) and the blocks under the roof. */
export interface Corridor {
  bearing: number;
  under: number;
}

/**
 * The open corridors into an overhang cell (x, z) at `feet`: bearings 15 degrees apart along which the
 * glide's cells (feet .. feet + free - 1 on the line: 4, Track F1: 3 for the brake under a roof 3 above;
 * feet + 1 .. feet + 2 a block either side) are free and
 * loaded until a column with open sky over the feet (`OPEN_SKY`) within `maxUnder` blocks, and beyond
 * it the approach from above (cells around a line rising 0.2 per block) is free for 40 blocks (cells
 * beyond 24 out may be unloaded). Sorted: the shortest stretch under the roof first, bearings 45
 * degrees apart at least.
 */
export function corridorsOf(look: BlockLookup, x: number, z: number, feet: number, maxUnder: number, free = 4, sky = false, maxY?: (x: number, z: number) => number | undefined): Corridor[] {
  const solidOr = (cx: number, y: number, cz: number, unknown: boolean): boolean => {
    const b = look(cx, y, cz);
    return b === undefined ? unknown : b.solid;
  };
  const found: Corridor[] = [];
  for (let bearing = 0; bearing < 360; bearing += 15) {
    const d = yawDir(bearing);
    const side = { x: d.z, z: -d.x };
    const col = (s: number, lat = 0) => ({ x: Math.floor(x + 0.5 + d.x * s + side.x * lat), z: Math.floor(z + 0.5 + d.z * s + side.z * lat) });
    let openAt: number | undefined;
    let ok = true;
    for (let s = 1; s <= maxUnder + 1 && ok; s++) {
      const c = col(s);
      for (let y = feet; y <= feet + free - 1; y++) if (solidOr(c.x, y, c.z, true)) ok = false;
      for (const lat of [-1, 1]) {
        const l = col(s, lat);
        for (let y = feet + 1; y <= feet + 2; y++) if (solidOr(l.x, y, l.z, true)) ok = false;
      }
      if (!ok) break;
      let open = true;
      for (let y = feet + free; y <= feet + OPEN_SKY; y++) {
        if (solidOr(c.x, y, c.z, true)) {
          open = false;
          break;
        }
      }
      // (Track F14: with `sky` the column a corridor ends under is open to the top of what is loaded, not for 20 blocks)
      if (open && sky && solidOver(look, c.x, c.z, feet + OPEN_SKY + 1, maxY?.(c.x, c.z)) !== undefined) open = false;
      if (open) openAt = s;
      if (open) break;
    }
    if (!ok || openAt === undefined) continue;
    for (let s = openAt + 1; s <= openAt + 40 && ok; s++) {
      const c = col(s);
      const path = feet + 1 + (s - openAt) * 0.2;
      for (let y = Math.floor(path) - 1; y <= Math.ceil(path) + 2; y++) if (solidOr(c.x, y, c.z, s - openAt <= 24)) ok = false;
    }
    if (ok) found.push({ bearing, under: openAt - 1 });
  }
  found.sort((a, b) => a.under - b.under || a.bearing - b.bearing);
  const out: Corridor[] = [];
  for (const c of found) if (out.every((o) => Math.abs(((c.bearing - o.bearing + 540) % 360) - 180) >= 45)) out.push(c);
  return out;
}

/**
 * The approach simulation into an overhang along `bearing`: from the corridor's entry (56 out, 12
 * above the floor, 1.05 blocks a tick heading in; and from 40 out, 7 above) the approach planner
 * (the flight's own, with the world's solids as walls) must find a profile that lands on the target.
 * Track F1: `style` brake simulates the brake / elevator landing (brake.ts) instead, `auto` the flare
 * first, then the brake (`style` in the result: the family that landed).
 */
export function corridorLands(target: LandingTarget, bearing: number, obstacle: Obstacle, seed = 7, style: 'auto' | 'flare' | 'brake' = 'flare'): { ok: boolean; cost: number; kind: string; style: 'flare' | 'brake' } {
  const d = yawDir(bearing);
  let best: { ok: boolean; cost: number; kind: string; style: 'flare' | 'brake' } = { ok: false, cost: Infinity, kind: 'none', style: style === 'brake' ? 'brake' : 'flare' };
  for (const family of style === 'auto' ? (['flare', 'brake'] as const) : ([style] as const)) {
    for (const [out, up] of [
      [APPROACH_DISTANCE, 12],
      [40, 7],
    ] as const) {
      const body: FlightBody = { pos: { x: target.x + d.x * out, y: target.top + up, z: target.z + d.z * out }, vel: { x: -d.x * 1.05, y: -0.1, z: -d.z * 1.05 }, onGround: false, gliding: true, boostTicks: 0 };
      const c = family === 'flare' ? new ApproachPlanner(seed, obstacle).step(body, bearing + 180, target) : new BrakePlanner(seed, obstacle).step(body, bearing + 180, target);
      if (c.cost < best.cost) best = { ok: c.touchdown.kind === 'landed' && c.cost < CORRIDOR_COST, cost: c.cost, kind: c.touchdown.kind, style: family };
      if (best.ok) return best;
    }
  }
  return best;
}
/** An overhang approach is flown only when its simulated plan costs under this (a soft landing; the go-around threshold is 35). */
export const CORRIDOR_COST = 30;

/** Track F1: the least room over a precision goal (feet .. feet + 2 free: the gliding box 0.6 high, the brake's height wobble). */
export const PRECISE_HEADROOM = 3;
/**
 * Track F3: the least room over a route landing (feet .. feet + 1 free: the gliding box is 0.6 high and the
 * route planner sweeps it through the slot with 0.12 of margin; Track F2 measured on bds-fly3 that a glide in a
 * 2-high space ends, which on a cell is the touchdown).
 */
export const ROUTE_HEADROOM = 2;
/**
 * Track F4a: which precision goals (an exact `!fly x y z`) ask the route planner before Track F1's brake
 * simulation (`LandingDeps.route.first` overrides it). Measured both ways on the F3 cases (docs/flight.md
 * "Obstacle course (Track F4a)"): under a roof (a ceiling within OPEN_SKY) the route first flew 11 % fewer ticks
 * with no go-around (the brake's corridor went around 0.56 times a landing, room3 1.7), the same rockets; under
 * open sky (a hole, a shaft) the brake first flew 18 % fewer ticks and touched down 0.01 off the cell's centre
 * (the route 0.04 to 0.10). So: `covered`. From the side the route is worse: a body coming in 53 degrees off the
 * route's bearing (room3 from the north-west) was not lined up until the corridor's entry and was handed over
 * 20 over the cell (480 ticks, 6.9 rockets a trip against the brake's corridor's 274 and 1.4), so the route first
 * only when its bearing is within ROUTE_FIRST_OFF of the body's side (`LandingOptions.from`); else the brake first
 * and the route after it.
 */
export const ROUTE_FIRST: 'never' | 'covered' | 'always' = 'covered';
export const ROUTE_FIRST_OFF = 30;

/** Track F1: the top (feet height) of the wall in column (x, z) that rises from `feet` (solid from there up, at most to `to`; unknown counts as solid), or -Infinity (open at `feet`: no wall, a roof over it is none either). */
function wallTop(look: BlockLookup, x: number, z: number, feet: number, to: number): number {
  let y = feet;
  for (; y <= to; y++) {
    const b = look(x, y, z);
    if (b !== undefined && !b.solid) break;
  }
  return y === feet ? -Infinity : y;
}

/**
 * Track F1 (docs/flight.md "Manoeuvres"): the exact goal (x, z) on floor `f` as a precision target for the
 * brake / elevator landing (brake.ts): dry and safe, PRECISE_HEADROOM or more over it, with its floor's
 * cells (the same height, connected, within 1.5: a 2 x 2 shaft floor), a shaft's rim (the lowest top of
 * the columns around those cells when every one rises 2 or more over the feet: the approach, the glide
 * line and the go-around fly over it) and, under a roof (a ceiling within OPEN_SKY), the corridor in
 * (corridorsOf with the room the roof leaves). The landing is simulated (BrakePlanner, the world's solids as
 * walls): from above along four bearings, or along the corridors; undefined when nothing lands.
 */
export async function preciseGoal(view: ColumnView, look: BlockLookup, obstacle: Obstacle, x: number, z: number, f: Floor, o: Pick<LandingOptions, 'maxUnder' | 'from' | 'rim'>, route?: LandingDeps['route']): Promise<{ target: LandingTarget; line: string } | undefined> {
  if (f.wet || f.hazard) return undefined;
  const room = f.ceiling === undefined ? Infinity : f.ceiling - f.feet;
  // Track F3: a room of 2 is legal when the route planner finds a way in (below); without it 3 is the least
  if (room < (route ? ROUTE_HEADROOM : PRECISE_HEADROOM)) return undefined;
  const least = Math.min(PRECISE_HEADROOM, room);
  // the floor's cells: the same height, dry, connected, within 1.5
  const cells = new Set<number>([columnKey(x, z)]);
  const list: [number, number][] = [[x, z]];
  for (const [cx, cz] of list) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (cells.has(columnKey(nx, nz)) || Math.hypot(nx - x, nz - z) > 1.5) continue;
      const g = view.floorNear(nx, nz, f.feet, 0);
      if (!g || g.wet || g.hazard || (g.ceiling === undefined ? Infinity : g.ceiling - g.feet) < least) continue;
      cells.add(columnKey(nx, nz));
      list.push([nx, nz]);
    }
  }
  // the rim: every column around the cells is a wall from the floor up, 2 or more over the feet (a shaft), its lowest top
  let rim = Infinity;
  for (const [cx, cz] of list) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (cells.has(columnKey(cx + dx, cz + dz))) continue;
        rim = Math.min(rim, wallTop(look, cx + dx, cz + dz, f.feet, f.feet + OPEN_SKY));
      }
    }
  }
  // Track F8: a rim the caller knows (the opening in a cave's roof the corridor goes down through): the body comes down inside
  // it, whatever the walls next to the cell say (a wide pit's floor cell has floor cells, not walls, round it)
  if (o.rim !== undefined && o.rim >= f.feet + 2 && room > OPEN_SKY) rim = Math.max(Number.isFinite(rim) ? rim : -Infinity, o.rim);
  const shaft = Number.isFinite(rim) && rim >= f.feet + 2;
  const base: LandingTarget = { x: x + 0.5, z: z + 0.5, top: f.feet, half: 0.5, precise: true, ...(cells.size > 1 ? { cells } : {}), ...(shaft ? { rim } : {}) };
  const what = shaft ? `a ${o.rim !== undefined && rim === o.rim ? 'pit' : 'shaft'} floor ${rim - f.feet} deep (${cells.size} cell${cells.size === 1 ? '' : 's'})` : room > OPEN_SKY ? `a precision cell (${cells.size} cell${cells.size === 1 ? '' : 's'} at its height)` : `a cell under a roof ${room} above`;
  const corridors = room > OPEN_SKY ? [] : corridorsOf(look, x, z, f.feet, o.maxUnder, Math.min(4, room)).slice(0, 3);
  // Track F3: the route planner (docs/flight.md "Route landings and takeoffs"): a plan from an entry along some
  // bearing onto the cells (the corridors' bearings first under a roof, every 45 degrees else); the planner's
  // sweep decides what fits (a slot 2 high, a hole, the shaft's bore)
  const byRoute = async (): Promise<{ target: LandingTarget; line: string } | undefined> => {
    if (!route) return undefined;
    const spec: LandingRouteSpec = { cells: list.map(([cx, cz]) => ({ x: cx, z: cz })), top: f.feet, ...(shaft ? { rim } : {}), ...(f.ceiling !== undefined && room <= OPEN_SKY ? { ceiling: f.ceiling } : {}) };
    // the bearing on the body's side first (the cruise comes in along it: no flight past the cell and back), under a roof the corridors'
    const prefer = corridors.length ? corridors[0]!.bearing : o.from ? yawTo({ x: x + 0.5, z: z + 0.5 }, o.from) : undefined;
    const r = await planLandingRoute(route.grid, spec, { ...(prefer !== undefined ? { prefer } : {}), ...(route.rockets !== undefined ? { rockets: route.rockets } : {}), ...(route.kit ? { kit: route.kit } : {}) }, route.plan);
    if (!r.route) return undefined;
    const t: LandingTarget = { ...base, bearing: r.route.bearing, route: r.route, ...(f.ceiling !== undefined && room <= OPEN_SKY ? { ceiling: f.ceiling } : {}) };
    return { target: t, line: `${what}, a route landing in from ${r.route.bearing} (${r.route.ticks} ticks, ${r.route.rockets} rockets; ${r.route.nodes} nodes in ${r.route.ms.toFixed(0)} ms: ${r.route.edges}; tried ${r.tried.length} bearing${r.tried.length === 1 ? '' : 's'})` };
  };
  // Track F4a: the route before the brake (`ROUTE_FIRST`, measured in docs/flight.md "Obstacle course (Track F4a)")
  const routeFirst = route !== undefined && (route.first ?? (ROUTE_FIRST === 'always' || (ROUTE_FIRST === 'covered' && room <= OPEN_SKY)));
  let first: Awaited<ReturnType<typeof byRoute>>;
  if (routeFirst) {
    first = await byRoute();
    // (by default only along the body's side: from farther off its bearing the brake's corridor first, the route after it)
    const off = first && o.from ? Math.abs(yawDiff(first.target.route!.bearing, yawTo({ x: x + 0.5, z: z + 0.5 }, o.from))) : 0;
    if (first && (route.first === true || off <= ROUTE_FIRST_OFF)) return first;
  }
  if (room >= PRECISE_HEADROOM) {
    if (room > OPEN_SKY) {
      // open above: the brake from the approach entry over its top (or the rim) along four bearings
      for (const bearing of [0, 90, 180, 270]) {
        const d = yawDir(bearing);
        const body: FlightBody = { pos: { x: base.x + d.x * APPROACH_DISTANCE, y: entryTop(base) + APPROACH_HEIGHT, z: base.z + d.z * APPROACH_DISTANCE }, vel: { x: -d.x * 1.05, y: -0.1, z: -d.z * 1.05 }, onGround: false, gliding: true, boostTicks: 0 };
        const c = new BrakePlanner(7, obstacle).step(body, bearing + 180, base);
        if (c.touchdown.kind === 'landed' && c.cost < CORRIDOR_COST) return { target: base, line: `${what}, the brake landing simulated in from ${bearing} (cost ${c.cost.toFixed(1)})` };
      }
    } else {
      // under a roof: along a corridor with the room it leaves
      for (const k of corridors) {
        const t: LandingTarget = { ...base, bearing: k.bearing, ...(f.ceiling !== undefined ? { ceiling: f.ceiling } : {}) };
        const sim = corridorLands(t, k.bearing, obstacle, 7, 'brake');
        if (sim.ok) return { target: t, line: `${what}, in from ${k.bearing} (${k.under} under the roof, the brake landing simulated: cost ${sim.cost.toFixed(1)})` };
      }
    }
  }
  if (!route) return undefined;
  return routeFirst ? first : byRoute();
}

/** The ranking's extra walk for an overhang landing: 4, and 2 per block of the corridor under the roof (the open ground beside a big roof wins). */
export function roofPenalty(corridor: Corridor | undefined): number {
  return corridor ? 4 + 2 * corridor.under : 0;
}

/** At most this many overhang cells get their corridors looked for in one search (each is about 24 x 13 short column scans). */
export const MAX_ROOF_CELLS = 240;

/**
 * The cells a walk landing on `c` accepts: the floors at the same height connected to it (4-way)
 * within `radius`, every one sound and of the same class (open sky, or an overhang with the headroom).
 */
export function cellsAround(view: ColumnView, c: { x: number; z: number; feet: number }, kind: CandidateKind, radius: number, headroom: number): Set<number> {
  const out = new Set<number>([columnKey(c.x, c.z)]);
  const queue: [number, number][] = [[c.x, c.z]];
  while (queue.length) {
    const [x, z] = queue.shift()!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      const k = columnKey(nx, nz);
      if (out.has(k) || Math.hypot(nx - c.x, nz - c.z) > radius) continue;
      const f = view.floorNear(nx, nz, c.feet, 0);
      if (!f || view.kindOf(f, headroom) !== kind || !view.sound(nx, nz, f)) continue;
      out.add(k);
      queue.push([nx, nz]);
    }
  }
  return out;
}

/**
 * The plateau of `c`: the floors at exactly its height connected to it (4-way, any class, dry), up to
 * `max` cells within `radius`. A probe that exhausted the space from `c` without a path proves the
 * same for every one of them (they walk to each other on the flat).
 */
export function plateauOf(view: ColumnView, c: { x: number; z: number; feet: number }, radius = 64, max = 6000): Set<number> {
  const out = new Set<number>([columnKey(c.x, c.z)]);
  const queue: [number, number][] = [[c.x, c.z]];
  while (queue.length && out.size < max) {
    const [x, z] = queue.shift()!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      const k = columnKey(nx, nz);
      if (out.has(k) || Math.abs(nx - c.x) > radius || Math.abs(nz - c.z) > radius) continue;
      const f = view.floorNear(nx, nz, c.feet, 0);
      if (!f || f.wet) continue;
      out.add(k);
      queue.push([nx, nz]);
    }
  }
  return out;
}

/** A walk-landing target on `c` with its accepted cells. */
export function walkTarget(c: LandingCell, cells: ReadonlySet<number>, extra: Partial<LandingTarget> = {}): LandingTarget {
  let half = 0.5;
  for (const k of cells) {
    const x = Math.floor(k / 65536);
    const z = k % 65536;
    const dx = ((x - (c.x & 0xffff) + 98304) % 65536) - 32768;
    const dz = ((z - (c.z & 0xffff) + 98304) % 65536) - 32768;
    half = Math.max(half, Math.hypot(dx, dz) + 0.5);
  }
  return { x: c.x + 0.5, z: c.z + 0.5, top: c.feet, half, cells, walk: true, ...extra };
}

/** The candidate cells within `radius` of the goal (every cell out to 8, every other beyond), and how much of the window is live. */
export function candidatesNear(view: ColumnView, goal: Vec3, o: Pick<LandingOptions, 'radius' | 'headroom'>): { list: Candidate[]; columns: number; live: number; bound: number } {
  const gx = Math.floor(goal.x);
  const gz = Math.floor(goal.z);
  const list: Candidate[] = [];
  let columns = 0;
  let live = 0;
  // Track L1: the nearest column that is not loaded (no landing there walks less than its straight distance)
  let bound = Infinity;
  for (let r = 1; r <= o.radius; r++) {
    const step = r > 8 ? 2 : 1;
    for (let dx = -r; dx <= r; dx += step) {
      for (let dz = -r; dz <= r; dz += step) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        columns++;
        const x = gx + dx;
        const z = gz + dz;
        const floors = view.floors(x, z);
        if (!floors) {
          bound = Math.min(bound, Math.hypot(dx, dz));
          continue;
        }
        live++;
        for (const f of floors) {
          if (f.feet > goal.y + 48 || f.feet < goal.y - 32) continue;
          const kind = view.kindOf(f, o.headroom);
          if (!kind || !view.sound(x, z, f) || !view.level(x, z, f)) continue;
          const dy = f.feet - goal.y;
          list.push({ x, z, feet: f.feet, kind, ceiling: f.ceiling, est: Math.hypot(dx, dz) + 3 * Math.abs(dy), lb: Math.hypot(dx, dz, dy) });
        }
      }
    }
  }
  list.sort((a, b) => a.est - b.est);
  return { list, columns, live, bound };
}

// ---- Track L1: the walk flood, the approach check, the alternatives ------------------------------------------------

/** Track L1: floors the walk flood visits at most (each reads its four neighbour columns, memoised by the ColumnView). */
export const FLOOD_MAX = 20000;
/** Track L1: the flood keeps this many blocks beyond the candidate radius (a walk that bends out round a hill). */
export const FLOOD_BEYOND = 8;
/** Track L1: a candidate the flood did not reach ranks behind every one it did, by this many blocks more. */
export const FLOOD_UNREACHED = 64;

/** Track L1: the walk flood from a goal: the steps of the walk from a floor to the goal (undefined: not reached), and the nearest open-sky floor it reached (the walk's entrance). */
export interface WalkFlood {
  steps(x: number, feet: number, z: number): number | undefined;
  entrance: { x: number; z: number; feet: number; steps: number } | undefined;
  floors: number;
}

/**
 * Track L1 (docs/flight.md "Landing by time"): a breadth-first flood of the walk to the goal over the floors of the live
 * model (ColumnView: a solid with two free cells over it), backwards from the goal's own floor: a floor walks to its
 * neighbour (4-way) at the same height, a block up when it has 3 of room to jump in, or down by up to 3 when the column
 * it drops into is free that high; a floor with a hazard is no way, a wet one is (a swim). A step is a block of walk, so
 * the flood's steps rank the candidates of a covered goal by their walk, not by the straight line (the hill over a cave
 * is near in a straight line and far on foot); the probe plan (reach.ts) still confirms the walk. Bounded by FLOOD_MAX
 * floors and the candidate radius plus FLOOD_BEYOND.
 */
export function walkFlood(view: ColumnView, goal: { x: number; z: number; feet: number }, radius: number, max = FLOOD_MAX): WalkFlood {
  const fl = flooder(view, goal, radius + FLOOD_BEYOND, max);
  fl.advance(Infinity);
  return fl.result();
}

/**
 * Track F14 (docs/flight.md "The way down to the landing"): how far the walk flood of a covered goal goes when open sky
 * is the sky (`ColumnView.sky`). A cave's mouth is where its walk first comes out under the sky, and that is as far from
 * a goal deep in it as the cave is long: on the Realm's cave 36 to 100 blocks in the plane (50 to 143 steps of the flood)
 * from ten goals, eight of them outside the candidate window of 48. So the flood goes on to `reach` blocks each way and
 * `max` floors, and stops `more` steps past the first floor under the sky (the ground round the mouth: its landing cells);
 * the open floors it meets outside the candidate window, at most `cells` of them, are candidates like the window's own.
 * It runs in slices of `slice` floors with the event loop let in between (a flood of 40 000 floors is 0.2 s).
 */
export const FLOOD_FAR = Object.freeze({ reach: 128, max: 60_000, more: 24, cells: 64, slice: 2500 });

/** Track F14: the far flood (see FLOOD_FAR): `open` lists the landing cells under the sky (sound, level) it met outside the window of `radius`, nearest by the walk first. */
export async function walkFloodFar(view: ColumnView, goal: { x: number; z: number; feet: number }, radius: number, headroom: number, yieldNow: () => Promise<void>): Promise<WalkFlood & { open: { x: number; z: number; feet: number; steps: number }[]; /** The steps of the last floor it visited: a floor it did not reach walks at least this far. */ last: number }> {
  const open: { x: number; z: number; feet: number; steps: number }[] = [];
  let first: number | undefined;
  let last = 0;
  const fl = flooder(view, goal, Math.max(radius + FLOOD_BEYOND, FLOOD_FAR.reach), FLOOD_FAR.max, (x, z, f, s) => {
    if (view.kindOf(f, headroom) === 'open') {
      first ??= s;
      // (a landing cell: sound and level, as the window's own candidates are)
      if (Math.max(Math.abs(x - goal.x), Math.abs(z - goal.z)) > radius && open.length < FLOOD_FAR.cells && view.sound(x, z, f) && view.level(x, z, f)) open.push({ x, z, feet: f.feet, steps: s });
    }
    last = s;
    return first !== undefined && s > first + FLOOD_FAR.more;
  });
  while (!fl.advance(FLOOD_FAR.slice)) await yieldNow();
  return { ...fl.result(), open, last };
}

/** The walk flood's loop (walkFlood's, unchanged), in steps: `advance(n)` visits up to n floors more and says whether it is done; `visit` (Track F14) sees each floor as it is visited and may end the flood. */
function flooder(view: ColumnView, goal: { x: number; z: number; feet: number }, reach: number, max: number, visit?: (x: number, z: number, f: Floor, steps: number) => boolean): { advance(n: number): boolean; result(): WalkFlood } {
  const steps = new Map<number, number>();
  const key = (x: number, z: number, feet: number): number => columnKey(x, z) * 1024 + (feet - view.yBottom);
  const queue: { x: number; z: number; f: Floor; s: number }[] = [];
  const own = view.floorNear(goal.x, goal.z, goal.feet, 0);
  let entrance: WalkFlood['entrance'];
  if (own && !own.hazard) {
    steps.set(key(goal.x, goal.z, own.feet), 0);
    queue.push({ x: goal.x, z: goal.z, f: own, s: 0 });
  }
  let head = 0;
  let ended = false;
  const advance = (n: number): boolean => {
    for (let k0 = 0; k0 < n && !ended && head < queue.length && steps.size < max; k0++, head++) {
      const { x, z, f, s } = queue[head]!;
      if (!entrance && view.kindOf(f, 2) === 'open') entrance = { x, z, feet: f.feet, steps: s };
      if (visit?.(x, z, f, s)) {
        ended = true;
        break;
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const nz = z + dz;
        if (Math.abs(nx - goal.x) > reach || Math.abs(nz - goal.z) > reach) continue;
        for (const n1 of view.floors(nx, nz) ?? []) {
          const d = n1.feet - f.feet;
          if (d < -1 || d > 3 || n1.hazard) continue;
          // (backwards: the walker goes from n1 to f) a block up from n1 wants room to jump there; a drop from n1 wants f's column free to n1's head
          if (d === -1 && n1.ceiling !== undefined && n1.ceiling - n1.feet < 3) continue;
          if (d > 0 && f.ceiling !== undefined && f.ceiling < n1.feet + 2) continue;
          const k = key(nx, nz, n1.feet);
          if (steps.has(k)) continue;
          steps.set(k, s + 1);
          queue.push({ x: nx, z: nz, f: n1, s: s + 1 });
        }
      }
    }
    return ended || head >= queue.length || steps.size >= max;
  };
  return { advance, result: () => ({ steps: (x, feet, z) => steps.get(key(x, z, feet)), entrance, floors: steps.size }) };
}

/** Track L1: approach simulations (each a planner's cold start, about 10 ms) one landing search may run for its open cells. */
export const APPROACH_SIMS = 24;

/**
 * Track L1: the height a flight comes in over a cell from `bearing`: the approach entry (APPROACH_HEIGHT over the top or the
 * rim at APPROACH_DISTANCE out), or 3 over the highest floor on that line when the terrain there is higher (the cruise's
 * terrain floor and the go-around height keep the body over it: the Realm's cave mouth under a hill was flown at 80 over it).
 */
export function entryHeight(view: ColumnView, target: LandingTarget, bearing: number): number {
  const d = yawDir(bearing);
  let top = entryTop(target) + APPROACH_HEIGHT;
  for (let s = Math.ceil(target.half) + 2; s <= APPROACH_DISTANCE; s += 2) {
    const f = view.floors(Math.floor(target.x + d.x * s), Math.floor(target.z + d.z * s))?.[0];
    if (f && f.feet + 3 > top) top = f.feet + 3;
  }
  return top;
}

/**
 * Track L1: an open landing's approach, simulated as the flight will fly it (the flight's own planners, the world's solids
 * as walls): from APPROACH_DISTANCE out at `entryHeight` along the bearings given (the body's side first), the flare and,
 * unless `style` is flare, the brake; landed under CORRIDOR_COST on the first that does (`style` the family), else not.
 * `sims` counts the planner runs (at most `budget`).
 */
export interface ApproachSim {
  ok: boolean;
  bearing?: number;
  style?: 'flare' | 'brake';
  cost: number;
  /** The best simulated touchdown's kind. */
  kind: string;
  /** Simulations run (0: the budget was spent before this cell, nothing is known). */
  tried: number;
}

export function approachLands(view: ColumnView, target: LandingTarget, bearings: readonly number[], obstacle: Obstacle, style: 'auto' | 'flare' | 'brake', budget: { sims: number; max: number }): ApproachSim {
  let best: ApproachSim = { ok: false, cost: Infinity, kind: 'none', tried: 0 };
  let tried = 0;
  for (const bearing of bearings) {
    const d = yawDir(bearing);
    const y = entryHeight(view, target, bearing);
    for (const family of style === 'auto' ? (['flare', 'brake'] as const) : ([style] as const)) {
      if (budget.sims >= budget.max) return { ...best, tried };
      budget.sims++;
      tried++;
      const body: FlightBody = { pos: { x: target.x + d.x * APPROACH_DISTANCE, y, z: target.z + d.z * APPROACH_DISTANCE }, vel: { x: -d.x * 1.05, y: -0.1, z: -d.z * 1.05 }, onGround: false, gliding: true, boostTicks: 0 };
      const c = family === 'flare' ? new ApproachPlanner(7, obstacle).step(body, bearing + 180, target) : new BrakePlanner(7, obstacle).step(body, bearing + 180, target);
      if (c.touchdown.kind === 'landed' && c.cost < CORRIDOR_COST) return { ok: true, bearing, style: family, cost: c.cost, kind: 'landed', tried };
      if (c.cost < best.cost) best = { ok: false, cost: c.cost, kind: c.touchdown.kind, tried };
    }
  }
  return { ...best, tried };
}

/** Track L1: the bearings an open landing's approach is simulated along: the body's side first, then a quarter round each way and the far side. */
export function approachBearings(target: { x: number; z: number }, from?: { x: number; z: number }): number[] {
  const first = from && hdist(from, target) > 1 ? yawTo(target, from) : 0;
  return [first, first + 90, first - 90, first + 180].map((b) => ((b % 360) + 360) % 360);
}

/**
 * Track F14: approach simulations a search may run with `sky` (LandingOptions.sky). A cell whose approach does not land
 * costs eight (four bearings, the flare and the brake), so APPROACH_SIMS (24) was spent on three cells; past the budget a
 * cell was taken with no simulation at all, and on the Realm that cell was the landing in 9 of the 13 flights that ended
 * off their site on 2026-11-14 (`N approaches not simulated: budget`). With `sky` a cell is never taken unsimulated, so
 * the budget is what bounds how many cells are tried: twice as many.
 */
export const APPROACH_SIMS_SKY = 48;

/**
 * Track F14: the way in over what stands round a cell (plan.ts landingRim, brain.ts `lookRim`: the landing of Track F11
 * from the start): a circle round the cell over the highest column within OVER.reach of it, the brake in over that to the
 * cell's centre, the elevator straight down. Simulated as the flight will fly it: the body on a circle of OVER.circle at
 * the height that circle is left at (plan.ts wayIn), the brake's planner with the cell under that rim (`rim`, `rimWithin`),
 * from up to four sides. `downS` is what the way straight down costs a landing in seconds (the elevator sinks 0.15 to
 * 0.3 a tick: ELEVATOR_S_PER_BLOCK for every block of the rim over the floor).
 */
export const ELEVATOR_S_PER_BLOCK = 0.25;

export interface OverSim {
  ok: boolean;
  cost: number;
  downS: number;
  tried: number;
  /** Why not, in words (for the search's line). */
  why: string;
}

/** Track F14: does the way in over `rim` land on `target`? At most `budget.max` simulations in all. */
export function overLands(target: LandingTarget, rim: number, obstacle: Obstacle, budget: { sims: number; max: number }): OverSim {
  const over: LandingTarget = { ...target, rim, rimWithin: rimReach(target) };
  const y = wayIn(rim, undefined, OVER.circle);
  let best = { cost: Infinity, kind: 'none' };
  let tried = 0;
  for (const bearing of [0, 90, 180, 270]) {
    if (budget.sims >= budget.max) break;
    budget.sims++;
    tried++;
    const d = yawDir(bearing);
    // on the circle, flying along it (the tangent, a quarter turn on from the bearing), at the speed a circle that small holds
    const body: FlightBody = { pos: { x: target.x + d.x * OVER.circle, y, z: target.z + d.z * OVER.circle }, vel: { x: -d.z * 0.65, y: -0.15, z: d.x * 0.65 }, onGround: false, gliding: true, boostTicks: 0 };
    const c = new BrakePlanner(7, obstacle).step(body, bearing + 90, over);
    if (c.touchdown.kind === 'landed' && c.cost < CORRIDOR_COST) return { ok: true, cost: c.cost, downS: (rim - target.top) * ELEVATOR_S_PER_BLOCK, tried, why: '' };
    if (c.cost < best.cost) best = { cost: c.cost, kind: c.touchdown.kind };
  }
  return { ok: false, cost: best.cost, downS: 0, tried, why: tried ? `${best.kind} ${best.cost.toFixed(0)}` : 'budget' };
}

/** Track F14: the column tops the way in over a cell is read from when the caller gives none (LandingDeps.skyTop): the view's highest floor of a column with nothing over it; a column whose top the view cannot see is unknown. */
export function viewTops(view: ColumnView): (x: number, z: number) => number | undefined {
  return (x, z) => {
    const f = view.floors(x, z)?.[0];
    return f && f.ceiling === undefined ? f.feet - 1 : undefined;
  };
}

/** Track L1: a partly loaded window answers the hold's look (`partial`) only with at least this share of it live (else `unknown` at once). */
export const PARTIAL_MIN_SHARE = 0.5;

/** Track L1: alternatives a landing carries at most (the cheapest landings beside the chosen one), and probes the search may spend on them past its stop. */
export const ALTERNATIVES = 3;
export const ALT_PROBES = 2;
/** Track L1: alternatives lie at least this many blocks apart (else they are one landing). */
export const ALT_APART = 6;
/** Track L1: open cells within this many blocks of one whose approach did not land are not tried (the same hollow). */
export const NO_APPROACH_NEAR = 3;

/**
 * Track L2 (docs/flight.md "Landing by time", "L2"): the longer probes of a covered goal's first cells by the walk flood:
 * the caller's probe (commands-fly.ts LAND_PROBE_NODES / LAND_PROBE_MS, 6 000 nodes in 400 ms) ran out on every cell of the
 * owner's cave, so the landing was a fallback priced as unknown. Measured on the fixture on the test host
 * (`scripts/land-probe-bench.ts`): the flood's first 8 cells each took 17 400 to 18 700 nodes in 65 to 105 ms without the
 * surface preference (41 000 to 41 800 nodes, 160 to 430 ms with it); 60 000 nodes leaves 3x room, 1 500 ms 10x.
 */
export const LONG_PROBE: Readonly<{ count: number } & ProbeBudget> = Object.freeze({ count: 3, nodes: 60_000, ms: 1500 });
/** Track L2: a long probe is cut to the search time left; under this many ms left the caller's own probe runs instead. */
export const LONG_PROBE_MIN_MS = 400;

/**
 * The landing for a walk to `goal` (see the file comment). `label` names the goal in the log line.
 */
export async function findLanding(goal: Vec3, label: string, deps: LandingDeps, o: LandingOptions): Promise<LandingPlan> {
  const now = deps.now ?? (() => performance.now());
  const t0 = now();
  const yieldNow = deps.yieldNow ?? (() => Promise.resolve());
  const gx = Math.floor(goal.x);
  const gz = Math.floor(goal.z);
  const gy = Math.floor(goal.y);
  if (deps.look(gx, gy, gz) === undefined) return { kind: 'unknown', line: `landing for ${label}: the goal's ground is not loaded yet` };
  const view = new ColumnView(deps.look, gy, { sky: o.sky === true, ...(deps.maxY ? { maxY: deps.maxY } : {}) });
  // the goal itself: landable under open sky, dry, level (Track F8: not when the caller says it lies under a rim: the floor of a
  // wide pit has sky over it and level neighbours, but the flare's approach along the glide line would meet the pit's wall;
  // the precision landing below comes down inside the rim)
  const own = view.floorNear(gx, gz, gy);
  const underRim = own !== undefined && o.rim !== undefined && o.rim >= own.feet + 2;
  if (own && !underRim && view.kindOf(own, o.headroom) === 'open' && view.sound(gx, gz, own)) {
    const cell: LandingCell = { x: gx, z: gz, feet: own.feet, kind: 'goal' };
    const target: LandingTarget =
      o.exact !== undefined ? { x: gx + 0.5, z: gz + 0.5, top: own.feet, half: o.exact } : walkTarget(cell, cellsAround(view, cell, 'open', walkSlack(0) + 1, o.headroom), { walkS: 0, walkKnown: true });
    return { kind: 'goal', cell, walk: 0, target, line: `landing for ${label}: the goal itself (${fmtCell(cell)}, ${o.exact !== undefined ? 'exact' : `${target.cells?.size ?? 1} cells`})` };
  }
  // Track F1: an exact goal that is no plain floor (a pillar top, a shaft floor, an edge, under a low roof): the
  // brake / elevator landing onto it when its simulation lands (flyLandStyle flare: the Track BF search below)
  if (o.exact !== undefined && own && o.style !== 'flare') {
    const p = await preciseGoal(view, deps.look, deps.obstacle, gx, gz, own, o, deps.route);
    if (p) {
      const cell: LandingCell = { x: gx, z: gz, feet: own.feet, kind: 'goal', precise: true, ...(p.target.route ? { route: true } : {}) };
      return { kind: 'goal', cell, walk: 0, target: p.target, line: `landing for ${label}: the goal itself (${fmtCell(cell)}, ${p.line})` };
    }
  }
  const { list, columns, live, bound } = candidatesNear(view, goal, o);
  await yieldNow();
  // Track L1: a partly loaded window answers only when asked (the hold's look), and only with a confirmed landing
  const partial = live < columns * (o.liveShare ?? 0.85);
  if (partial && (!o.partial || live < columns * PARTIAL_MIN_SHARE)) return { kind: 'unknown', line: `landing for ${label}: only ${live} of ${columns} columns loaded around the goal` };
  // Track L1: a covered goal (a cave, a room, the floor under a rim) ranks its candidates by the walk flood from its own floor
  const covered = own !== undefined && !own.hazard && (underRim || view.kindOf(own, 2) !== 'open');
  // (Track F14: with `sky` the flood goes on to the cave's mouth, and the open ground it meets beyond the window is a candidate)
  const far = covered && o.sky ? await walkFloodFar(view, { x: gx, z: gz, feet: own.feet }, o.radius, o.headroom, yieldNow) : undefined;
  const flood = far ?? (covered ? walkFlood(view, { x: gx, z: gz, feet: own.feet }, o.radius) : undefined);
  if (flood) await yieldNow();
  let farCells = 0;
  for (const p of far?.open ?? []) {
    const dy = p.feet - goal.y;
    list.push({ x: p.x, z: p.z, feet: p.feet, kind: 'open', ceiling: undefined, est: Math.hypot(p.x - gx, p.z - gz) + 3 * Math.abs(dy), lb: Math.hypot(p.x - gx, p.z - gz, dy) });
    farCells++;
  }
  const rankOf = (c: Candidate): { key: number; lb: number; steps?: number } => {
    const steps = flood?.steps(c.x, c.feet, c.z);
    if (!flood) return { key: c.est, lb: c.lb };
    // (the flood walks 4-way, a path cuts the corners: no walk is shorter than the steps over the square root of 2)
    // (Track F14: a cell the far flood did not reach walks farther than every floor it visited, if it walks at all)
    return steps === undefined ? { key: Math.max(c.est, far?.last ?? 0) + FLOOD_UNREACHED, lb: c.lb } : { key: steps, lb: Math.max(c.lb, steps / Math.SQRT2), steps };
  };
  interface Probed {
    c: Candidate;
    result: string;
    blocks?: number;
    corridor?: Corridor;
    status: ProbeOutcome['status'] | 'skip';
  }
  // Track L2: a confirmed walk's price (by the probe's path when it gave ticks), and its note in the line
  const priceOf = (r: { blocks: number; ticks?: number }): { walkS: number; by: WalkPrice } => {
    const w = { blocks: r.blocks, known: true, ...(r.ticks !== undefined ? { ticks: r.ticks } : {}) };
    return { walkS: walkSeconds(w), by: walkPriceOf(w) };
  };
  const priceNote = (s: number, by: WalkPrice): string => `${s.toFixed(1)} s${by === 'path' ? '' : ` ${by}`}`;
  // Track F1: the overhang cells only the brake's simulation lands on (the brain plans the brake there from the start)
  const brakeOnly = new Set<Candidate>();
  const probed: Probed[] = [];
  // probes that exhausted the space without a path: their whole plateau is skipped (feet -> columns)
  const dead = new Map<number, Set<number>>();
  const isDead = (c: Candidate): boolean => [...dead.entries()].some(([feet, cols]) => feet === c.feet && cols.has(columnKey(c.x, c.z)));
  // Track L1: the landable cells found (a confirmed walk and, in the open, a simulated approach), cheapest first
  interface Landable {
    c: Candidate;
    /** The probe's path blocks. */
    walk: number;
    /** Track L2: the walk's price in seconds (landprice.ts walkSeconds) and how it was priced. */
    walkS: number;
    by: WalkPrice;
    /** The ranking cost in seconds: the walk's price plus roofPenalty at WALK_S_PER_BLOCK. */
    rankS: number;
    corridor?: Corridor;
    simulated: boolean;
  }
  const landable: Landable[] = [];
  let best: Landable | undefined;
  // Track L1: open cells whose approach the simulation did not land (the cells round them are skipped too: the same valley)
  const noApproach: Candidate[] = [];
  const nearNoApproach = (c: Candidate): boolean => noApproach.some((n) => Math.abs(n.feet - c.feet) <= 1 && Math.hypot(n.x - c.x, n.z - c.z) <= NO_APPROACH_NEAR);
  const simBudget = { sims: 0, max: o.sky ? APPROACH_SIMS_SKY : APPROACH_SIMS };
  // Track F14: the open cells whose way down is in over what stands round them (overLands), with what that costs in seconds
  const overCells = new Map<Candidate, number>();
  // (the column tops: the view's own floors, which it has read already; the flight's where the view cannot see a top; one
  // look a column a search: the cells round one candidate are the cells round the next)
  const topMemo = new Map<number, number | undefined>();
  const ownTops = viewTops(view);
  const tops = (x: number, z: number): number | undefined => {
    const k = columnKey(x, z);
    if (!topMemo.has(k)) topMemo.set(k, ownTops(x, z) ?? deps.skyTop?.(x, z));
    return topMemo.get(k);
  };
  // Track F14: a cell's rim (plan.ts landingRim), looked up once, and the seconds its way straight down costs
  const rims = new Map<Candidate, ReturnType<typeof landingRim>>();
  const rimOf = (c: Candidate): ReturnType<typeof landingRim> => {
    let r = rims.get(c);
    if (!r) rims.set(c, (r = landingRim({ x: c.x + 0.5, z: c.z + 0.5, top: c.feet }, tops)));
    return r;
  };
  const downOf = (c: Candidate): number => {
    const r = o.sky && c.kind === 'open' ? rimOf(c) : undefined;
    return r?.rim !== undefined ? (r.rim - c.feet) * ELEVATOR_S_PER_BLOCK : 0;
  };
  let unsimulated = 0;
  let probes = 0;
  let extraProbes = 0;
  let sims = 0;
  let roofsLooked = 0;
  // a queue by the ranking estimate: an overhang cell is re-queued once its corridors are known, with the
  // extra walk its corridor costs (roofPenalty), so the open ground beside a deep roof comes first
  interface Entry {
    c: Candidate;
    key: number;
    lb: number;
    /** Track L2: the flood's steps (a cell the flood reached). */
    steps?: number;
    corridors?: Corridor[];
  }
  const queue: Entry[] = list.map((c) => ({ c, ...rankOf(c) })).sort((a, b) => a.key - b.key);
  const push = (e: Entry): void => {
    let i = queue.findIndex((q) => q.key > e.key);
    if (i < 0) i = queue.length;
    queue.splice(i, 0, e);
  };
  // Track L1: past the stop rule a few more probes look for alternatives (cells ALT_APART from the chosen one and each other)
  const apartOf = (a: Candidate, b: Candidate): boolean => Math.hypot(a.x - b.x, a.z - b.z) >= ALT_APART || Math.abs(a.feet - b.feet) > 2;
  const apart = (c: Candidate): boolean => landable.every((l) => apartOf(l.c, c));
  let alternativesOnly = false;
  // Track L2: the longer probes for the flood's first cells (a covered goal only)
  const long = o.longProbe ?? LONG_PROBE;
  let longProbes = 0;
  // Track L2: seconds a block of straight distance takes at least: the probe's fastest pace once a probe gave ticks (the
  // walks are priced by their paths), else the pace the blocks are priced at
  let lbPace = WALK_S_PER_BLOCK;
  while (queue.length) {
    const e = queue.shift()!;
    const c = e.c;
    // (a confirmed walk within a tenth, at least 2 blocks' worth, of what any later candidate could do is good enough;
    // Track L2: in seconds)
    if (best && !alternativesOnly && e.lb * lbPace >= best.rankS - Math.max(2 * WALK_S_PER_BLOCK, best.rankS * 0.1)) {
      if (landable.length > ALTERNATIVES) break;
      alternativesOnly = true;
    }
    if (alternativesOnly && (extraProbes >= ALT_PROBES || landable.length > ALTERNATIVES)) break;
    if (probes >= o.probes + (alternativesOnly ? ALT_PROBES : 0) || now() - t0 >= o.budgetMs) break;
    if (isDead(c)) continue;
    // Track F14: a cell whose walk and way straight down together cannot beat the best so far is not probed (the stop rule
    // above bounds the walk alone, and a best with a long way down would let every cell within that many more seconds of
    // walk be probed: 16 probes on a built hill where 4 do)
    if (best && !alternativesOnly && o.sky && e.lb * lbPace + downOf(c) >= best.rankS - Math.max(2 * WALK_S_PER_BLOCK, best.rankS * 0.1)) continue;
    if (alternativesOnly && (c.kind !== 'open' || !apart(c))) continue;
    if (c.kind === 'open' && nearNoApproach(c)) continue;
    let corridor: Corridor | undefined;
    if (c.kind === 'roof' && !e.corridors) {
      if (++roofsLooked > MAX_ROOF_CELLS) continue;
      const corridors = corridorsOf(deps.look, c.x, c.z, c.feet, o.maxUnder, 4, o.sky === true, deps.maxY);
      if (roofsLooked % 16 === 0) await yieldNow();
      if (!corridors.length) continue;
      const extra = roofPenalty(corridors[0]);
      push({ c, key: e.key + extra, lb: e.lb + extra, ...(e.steps !== undefined ? { steps: e.steps } : {}), corridors });
      continue;
    }
    if (c.kind === 'roof') {
      const corridors = e.corridors!;
      const cells = cellsAround(view, c, 'roof', 1.5, o.headroom);
      for (const k of corridors.slice(0, 2)) {
        sims++;
        const target = walkTarget({ ...c, kind: 'roof' }, cells, { bearing: k.bearing });
        const sim = corridorLands(target, k.bearing, deps.obstacle, 7, o.style ?? 'flare');
        if (sim.ok) {
          corridor = k;
          if (sim.style === 'brake') brakeOnly.add(c);
          break;
        }
      }
      if (!corridor) {
        probed.push({ c, result: 'no-sim', status: 'skip' });
        continue;
      }
    }
    if (!deps.probe) break;
    probes++;
    if (alternativesOnly) extraProbes++;
    // Track L2: the flood's first cells get the longer probe, cut to the search time left (the total is kept)
    const left = o.budgetMs - (now() - t0);
    const longOne = flood !== undefined && e.steps !== undefined && longProbes < long.count && left >= LONG_PROBE_MIN_MS;
    if (longOne) longProbes++;
    const r = await deps.probe({ x: c.x + 0.5, y: c.feet, z: c.z + 0.5 }, longOne ? { nodes: long.nodes, ms: Math.min(long.ms, Math.floor(left)) } : undefined);
    await yieldNow();
    const tag = longOne ? ' long' : '';
    if (r.status === 'found') {
      const { walkS, by } = priceOf(r);
      if (by === 'path') lbPace = PATH_MIN_S_PER_BLOCK;
      const said = `path ${Math.round(r.blocks)} ${priceNote(walkS, by)}${tag}`;
      // Track L1: an open cell is landable only when the approach from where the flight will come in lands on it
      let simulated = corridor !== undefined;
      if (c.kind === 'open') {
        const t = walkTarget({ ...c, kind: 'open' }, cellsAround(view, c, 'open', walkSlack(r.blocks), o.headroom));
        // Track F14: a cell with something standing round it is flown in over that and straight down (plan.ts landingRim, the
        // brain's own rule): that way is what is simulated for it; open ground, and a cell whose way straight down is too
        // long, by the approach along the ground as before
        const rim = o.sky ? rimOf(c) : undefined;
        const ov = rim?.rim !== undefined ? overLands(t, rim.rim, deps.obstacle, simBudget) : undefined;
        const a: ApproachSim = ov ? { ok: ov.ok, cost: ov.cost, kind: ov.why, tried: ov.tried } : approachLands(view, t, approachBearings(t, o.from), deps.obstacle, o.style ?? 'flare', simBudget);
        sims += a.tried;
        if (a.tried > 0) await yieldNow();
        if (a.tried > 0 && !a.ok) {
          noApproach.push(c);
          probed.push({ c, result: ov ? `${said}, no way in over what stands round it (${ov.why})` : `${said}, no approach (${a.kind}${Number.isFinite(a.cost) ? ` ${a.cost.toFixed(0)}` : ''})`, blocks: r.blocks, status: 'skip' });
          continue;
        }
        // (Track F14: nor is a cell offered because the simulations ran out: its way down is not known)
        if (o.sky && a.tried === 0) {
          unsimulated++;
          probed.push({ c, result: `${said}, not simulated (budget)`, blocks: r.blocks, status: 'skip' });
          continue;
        }
        simulated = a.ok;
        if (!a.ok) unsimulated++;
        if (a.ok && a.style === 'brake') brakeOnly.add(c);
        if (ov?.ok) overCells.set(c, ov.downS);
      }
      // an overhang landing counts as a little more walk than an open one (the approach is harder), more the deeper under the roof
      // (Track F14: and a way in over what stands round the cell as the seconds its way straight down takes)
      const rankS = walkS + roofPenalty(corridor) * WALK_S_PER_BLOCK + (overCells.get(c) ?? 0);
      probed.push({ c, result: `${said}${overCells.has(c) ? `, in over what stands round it (${overCells.get(c)!.toFixed(1)} s down)` : ''}`, blocks: r.blocks, ...(corridor ? { corridor } : {}), status: 'found' });
      const l: Landable = { c, walk: r.blocks, walkS, by, rankS, ...(corridor ? { corridor } : {}), simulated };
      // (one per neighbourhood: the cheapest of the cells within ALT_APART of each other)
      const near = landable.filter((x) => !apartOf(x.c, c));
      if (near.every((x) => rankS < x.rankS)) {
        for (const x of near) landable.splice(landable.indexOf(x), 1);
        landable.push(l);
        landable.sort((a, b) => a.rankS - b.rankS);
      }
      if (!best || rankS < best.rankS) best = l;
    } else {
      probed.push({ c, result: `${r.status}${tag}`, ...(corridor ? { corridor } : {}), status: r.status });
      if (r.status === 'none') {
        const cols = dead.get(c.feet) ?? new Set<number>();
        for (const k of plateauOf(view, c)) cols.add(k);
        dead.set(c.feet, cols);
      }
    }
  }
  const ms = Math.round(now() - t0);
  const roofs = list.filter((c) => c.kind === 'roof').length;
  const tried = probed
    .slice(0, 10)
    .map((p) => `${fmtCell(p.c)}${p.c.kind === 'roof' ? `/roof${p.corridor ? ` b${p.corridor.bearing}` : ''}` : ''}:${p.result}`)
    .join(', ');
  const floodNote = flood ? `, walk flood ${flood.floors} floors${flood.entrance ? ` (open sky ${flood.entrance.steps} steps from the goal at ${fmtCell(flood.entrance)}${farCells ? `, ${farCells} cells there beyond the window` : ''})` : ', no open sky reached'}` : '';
  const head = `landing for ${label}: ${list.length} candidates (${roofs} under a roof), ${probes} probes, ${sims} approach sims${unsimulated ? ` (${unsimulated} approach${unsimulated === 1 ? '' : 'es'} not simulated: budget)` : ''}${floodNote}, ${ms} ms${tried ? `: ${tried}` : ''}`;
  // Track L1: a landable cell's target, priced in seconds of walk
  const targetOf = (l: Landable): { cell: LandingCell; walk: number; target: LandingTarget } => {
    const c = l.c;
    const walk = l.walk;
    const cell: LandingCell = { x: c.x, z: c.z, feet: c.feet, kind: c.kind };
    const cells = cellsAround(view, cell, c.kind, walkSlack(walk), o.headroom);
    const extra: Partial<LandingTarget> = {
      ...(l.corridor ? { bearing: l.corridor.bearing, ...(c.ceiling !== undefined ? { ceiling: c.ceiling } : {}) } : {}),
      ...(brakeOnly.has(c) ? { precise: true } : {}),
      walkS: l.walkS,
      walkKnown: true,
      walkBy: l.by,
      name: `${fmtCell(cell)}${l.corridor ? ' under a roof' : ''}`,
    };
    return { cell, walk, target: walkTarget(cell, cells, extra) };
  };
  // Track L2: the line says how each price was made (by the probe's path, or the blocks at WALK_S_PER_BLOCK)
  const byNote = (by: WalkPrice | undefined): string => (by === 'path' ? 'by its path' : by === 'pace' ? `at ${WALK_S_PER_BLOCK} s a block` : 'unconfirmed');
  if (best) {
    const chosen = targetOf(best);
    const alts = landable
      .filter((l) => l !== best && l.c.kind === 'open' && l.simulated)
      .slice(0, ALTERNATIVES)
      .map((l) => targetOf(l).target);
    const target: LandingTarget = alts.length ? { ...chosen.target, alternatives: alts } : chosen.target;
    const { cell, walk } = chosen;
    const altNote = alts.length ? `; alternatives ${alts.map((a) => `${a.name} ${priceNote(a.walkS!, a.walkBy ?? 'pace')}`).join(', ')}` : '';
    const unloaded = partial ? { live, columns, bound } : undefined;
    return {
      kind: 'cell',
      cell,
      walk,
      target,
      ...(unloaded ? { unloaded } : {}),
      line: `${head} -> ${fmtCell(cell)}${best.corridor ? ` under a roof (ceiling ${best.c.ceiling}), in from ${best.corridor.bearing}` : ''}, ${Math.round(walk)} blocks of walk (${target.walkS!.toFixed(1)} s ${byNote(best.by)}), ${chosen.target.cells?.size ?? 1} cells${altNote}${unloaded ? `; ${live} of ${columns} columns loaded, the nearest unloaded ${bound.toFixed(0)} out` : ''}`,
    };
  }
  // Track L1: a partly loaded window with nothing confirmed says nothing (the hold waits for more of it)
  if (partial) return { kind: 'unknown', line: `${head} -> nothing confirmed on the loaded part (${live} of ${columns} columns loaded)` };
  // nothing confirmed: the nearest safe dry ground; a probe that ran out of budget before one that proved there is no way
  // (Track L1: not a cell whose approach the simulation did not land, while another is known)
  const rank = (s: Probed['status'] | undefined, c: Candidate): number => (nearNoApproach(c) ? 2.5 : s === 'limited' || s === 'nostart' ? 0 : s === undefined ? 1 : s === 'none' ? 3 : 2);
  const statusOf = new Map(probed.map((p) => [p.c, p.status]));
  const open = list.filter((c) => c.kind === 'open').sort((a, b) => rank(statusOf.get(a), a) - rank(statusOf.get(b), b) || rankOf(a).key - rankOf(b).key);
  let pick: LandingCell | undefined;
  let est = 0;
  const first = open[0];
  // (Track L1: the walk estimate of a cell the flood reached is its steps)
  const estOf = (c: Candidate): number => rankOf(c).steps ?? c.est;
  if (first && rank(statusOf.get(first), first) < 2.5) {
    pick = { x: first.x, z: first.z, feet: first.feet, kind: 'open' };
    est = estOf(first);
  }
  if (!pick && deps.dryGround) {
    // dry open ground farther out or far below (the candidates keep to 32 under and 48 over the goal)
    for (let r = 2; r <= o.radius * 2 && !pick; r += 2) {
      for (let dx = -r; dx <= r && !pick; dx += 2) {
        for (let dz = -r; dz <= r; dz += 2) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const feet = deps.dryGround(gx + dx, gz + dz);
          if (feet === undefined) continue;
          pick = { x: gx + dx, z: gz + dz, feet, kind: 'ground' };
          est = Math.hypot(dx, dz) + 3 * Math.abs(feet - gy);
          break;
        }
      }
    }
  }
  if (!pick && first) {
    pick = { x: first.x, z: first.z, feet: first.feet, kind: 'open' };
    est = estOf(first);
  }
  if (!pick) return { kind: 'none', line: `${head} -> no dry ground known near it` };
  const cells = pick.kind === 'ground' ? new Set([columnKey(pick.x, pick.z)]) : cellsAround(view, pick, 'open', 2.5, o.headroom);
  const why = deps.probe ? (probed.length ? 'no walking path from any landing cell near it' : 'no landing cell near it') : 'no path check available';
  const walkS = walkSeconds({ blocks: est, known: false });
  return { kind: 'fallback', cell: pick, walk: est, target: walkTarget(pick, cells, { walkS, walkKnown: false, walkBy: 'unknown', name: fmtCell(pick) }), why, line: `${head} -> none confirmed: dry ground at ${fmtCell(pick)} (${why}; about ${walkS.toFixed(0)} s of walk, unconfirmed: ${Math.round(est)} blocks x ${UNKNOWN_DETOUR} + ${UNKNOWN_RISK_S} s)` };
}

/** The walk from `p` to the goal is still what the plan said: the landing cell is dry, sound and live (re-checked in the descent; Track F1: a precision goal dry, safe and with PRECISE_HEADROOM). */
export function stillLandable(look: BlockLookup, c: { x: number; z: number; feet: number; precise?: boolean; route?: boolean }, headroom: number): boolean {
  const view = new ColumnView(look, c.feet);
  const f = view.floorNear(c.x, c.z, c.feet, 0);
  if (c.precise) return !!f && !f.wet && !f.hazard && (f.ceiling === undefined || f.ceiling - f.feet >= (c.route ? ROUTE_HEADROOM : PRECISE_HEADROOM));
  return !!f && view.kindOf(f, headroom) !== undefined && view.sound(c.x, c.z, f);
}

/** Distance helper for callers (the goal and a landing cell centre). */
export const cellDistance = (a: { x: number; z: number }, c: LandingCell): number => hdist(a, { x: c.x + 0.5, z: c.z + 0.5 });
