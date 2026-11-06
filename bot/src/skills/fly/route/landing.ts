// Track F3 (docs/flight.md "Route landings and takeoffs (Track F3)", decisions/0064): the route landing.
// A cell the flare and the brake families refuse or fly badly (a cell under a roof 2 above: the inner platform
// of a stack, a hole in the ground, the floor of a 1 x 1 shaft, a pocket in a cliff face) is handed to the
// route planner: `planLandingRoute` searches a plan from the entry the brain hands over at (ROUTE_ENTRY_OUT
// blocks out along a bearing, ROUTE_ENTRY_UP over the cell's top or rim, heading in at ROUTE_ENTRY_SPEED) onto
// the cell with Track F1's edges (`library: 'landing'`), bearing by bearing, and the first complete plan makes
// the cell landable (`LandingTarget.route`). The brain then flies the cruise to that bearing's corridor entry
// (the overhang machinery of Track BF: `bearing`), and within ROUTE_HANDOVER of the cell the RouteTracker
// (tracker.ts) flies the body onto it from its real state, re-planning as it goes (brain.ts `route`).
//
// The planner decides what is landable: the 2-high slot of the owner's stacked platforms (the gliding box is
// 0.6 high; the body comes in sideways at the slot's height with 0.12 of margin), a hole 2 deep, a shaft 10
// deep (the `via` hint over its rim: the heuristic knows the body must come down the shaft at the hover's
// sink, not fly straight at the floor), a cell under a roof at ground level (no corridor approach needed).
import type { Vec3 } from '../../../connection/types.ts';
import { HOVER_SINK } from '../maneuvers.ts';
import { yawDir } from '../plan.ts';
import type { RouteGrid } from './grid.ts';
import { planRoute } from './search.ts';
import type { Planner } from './tracker.ts';
import { NO_BOOST, type RouteGoal, type RoutePlan, type RouteRequest, type RouteState } from './types.ts';

/**
 * The entry the route is planned from: this far out along the bearing, this high over the cell's top (or rim), at this
 * speed heading in: where the cruise's glide line puts the body (APPROACH_HEIGHT over the entry top at the approach
 * distance, sinking 0.1 a block, bled to about 1.05 a tick).
 */
export const ROUTE_ENTRY_OUT = 40;
export const ROUTE_ENTRY_UP = 9;
export const ROUTE_ENTRY_SPEED = 1.0;
/** The brain hands over to the tracker within this of the cell on the bearing's side; a little beyond the planned entry so the real state is near it. */
export const ROUTE_HANDOVER = 44;
/** The heuristic's weight for a landing search (a greedier A*: the long landing edges are found in a few hundred nodes). */
export const ROUTE_WEIGHT = 2;
/** The search budget per bearing (nodes, ms) when the landing is looked for, and the tracker's in flight. */
export const ROUTE_PLAN_NODES = 40_000;
export const ROUTE_PLAN_MS = 800;
export const ROUTE_TRACK_MS = 600;
/** The creep into a slot (pitch -15 from a near stop: 0.41 a tick, sinking 0.07) the `via` hint of a low room assumes. */
export const SLOT_CREEP = 0.4;
/** The bearings tried in the open (45 degrees apart). */
export const ROUTE_BEARINGS: readonly number[] = [0, 45, 90, 135, 180, 225, 270, 315];

/** A landing cell for the route planner: its floor's cells, the top, a shaft's rim, the ceiling over it. */
export interface LandingRouteSpec {
  cells: readonly { x: number; z: number }[];
  /** The feet height on the floor. */
  top: number;
  /** A shaft: the feet height of the lowest rim around the cells (the body must come down inside). */
  rim?: number;
  /** The first solid over the floor (feet height of its bottom = the room's top); undefined = open. */
  ceiling?: number;
}

/** The route the landing is flown by (plan.ts LandingTarget.route): the hand-over and the planner's problem. */
export interface RouteHandoff {
  /** The bearing (from the cell outwards) the brain comes in along (the corridor entry, Track BF). */
  bearing: number;
  /** The planned entry state (feet, the heading in, the speed): the hand-over is near it. */
  entry: Vec3;
  yaw: number;
  speed: number;
  goals: RouteGoal[];
  margin: number;
  weight: number;
  /** The plan found from the entry (for the log and the tests): ticks, rockets, the edges, the search's effort. */
  ticks: number;
  rockets: number;
  edges: string;
  nodes: number;
  ms: number;
}

/**
 * The margin round the gliding box for a passage `room` blocks high and `width` blocks wide (the narrower of the
 * two counts; F2's: 0.12 in a 1-wide bore, 0.2 in a 2-wide, 0.3 in a 3 x 3, 0.4 in the open). A shaft's width
 * is its floor's narrower extent; a slot under a roof is open at its sides (width Infinity).
 */
export function routeMargin(room: number, width = Infinity): number {
  const n = Math.min(room, width);
  return n <= 1 ? 0.1 : n <= 2 ? 0.12 : n <= 3 ? 0.2 : n <= 4 ? 0.3 : 0.4;
}

/** The narrower horizontal extent of the cells (blocks). */
export function cellsWidth(cells: readonly { x: number; z: number }[]): number {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const c of cells) {
    x0 = Math.min(x0, c.x);
    x1 = Math.max(x1, c.x);
    z0 = Math.min(z0, c.z);
    z1 = Math.max(z1, c.z);
  }
  return Math.min(x1 - x0 + 1, z1 - z0 + 1);
}

/** The margin of a spec: a shaft (a rim) is as narrow as its floor, a room as low as its ceiling; the open is 0.4. */
export function specMargin(spec: LandingRouteSpec): number {
  const room = spec.ceiling === undefined ? Infinity : spec.ceiling - spec.top;
  const width = spec.rim !== undefined && spec.rim >= spec.top + 2 ? cellsWidth(spec.cells) : Infinity;
  return routeMargin(room, width);
}

/** The centre of the cells (the cell nearest it is the goal's `cell`). */
export function cellsCentre(cells: readonly { x: number; z: number }[]): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const c of cells) {
    x += c.x + 0.5;
    z += c.z + 0.5;
  }
  return { x: x / Math.max(1, cells.length), z: z / Math.max(1, cells.length) };
}

/** The half extent of the cells around their centre (blocks; 0.5 for one cell, 1.5 for a 3 x 3). */
export function cellsHalf(cells: readonly { x: number; z: number }[]): number {
  const c = cellsCentre(cells);
  let h = 0.5;
  for (const k of cells) h = Math.max(h, Math.abs(k.x + 0.5 - c.x) + 0.5, Math.abs(k.z + 0.5 - c.z) + 0.5);
  return h;
}

/**
 * The landing goal of a spec for an approach along `bearing`: the cell nearest the floor's centre, the other cells,
 * and the heuristic's `via` point: over the rim for a shaft (the body comes down at the hover's sink), beside the
 * room at the slot's height for a cell under a low roof (the creep in), none in the open.
 */
export function landingGoalFor(spec: LandingRouteSpec, bearing: number): RouteGoal {
  const centre = cellsCentre(spec.cells);
  let cell = spec.cells[0]!;
  let best = Infinity;
  for (const c of spec.cells) {
    const d = Math.hypot(c.x + 0.5 - centre.x, c.z + 0.5 - centre.z);
    if (d < best) {
      best = d;
      cell = c;
    }
  }
  const room = spec.ceiling === undefined ? Infinity : spec.ceiling - spec.top;
  let via: { pos: Vec3; speed: number } | undefined;
  if (spec.rim !== undefined && spec.rim >= spec.top + 2) via = { pos: { x: cell.x + 0.5, y: spec.rim + 1, z: cell.z + 0.5 }, speed: HOVER_SINK };
  else if (room <= 4) {
    // the slot's mouth: just outside the cells along the bearing, the feet as high as the room allows the box (its top under the ceiling with the margin)
    const d = yawDir(bearing);
    const out = cellsHalf(spec.cells) + 1.2;
    const margin = specMargin(spec);
    via = { pos: { x: centre.x + d.x * out, y: spec.top + Math.max(0.3, Math.min(room - 0.6 - margin - 0.1, 1.5)), z: centre.z + d.z * out }, speed: SLOT_CREEP };
  }
  return { kind: 'landing', cell, top: spec.top, maxSpeed: 0.3, ...(spec.cells.length > 1 ? { cells: [...spec.cells] } : {}), ...(via ? { via } : {}) };
}

/** The entry state of a route landing along `bearing`: ROUTE_ENTRY_OUT out from the cells' centre, ROUTE_ENTRY_UP over the top (or the rim), heading in. */
export function routeEntry(spec: LandingRouteSpec, bearing: number, rockets: number): RouteState {
  const centre = cellsCentre(spec.cells);
  const d = yawDir(bearing);
  const over = spec.rim !== undefined && spec.rim > spec.top ? spec.rim : spec.top;
  return {
    pos: { x: centre.x + d.x * ROUTE_ENTRY_OUT, y: over + ROUTE_ENTRY_UP, z: centre.z + d.z * ROUTE_ENTRY_OUT },
    vel: { x: -d.x * ROUTE_ENTRY_SPEED, y: -0.1, z: -d.z * ROUTE_ENTRY_SPEED },
    yaw: bearing + 180,
    boost: { ...NO_BOOST },
    gliding: true,
    rockets,
    wp: 0,
  };
}

/** The request of a route landing from `start` (the planned entry, or the tracker's real state). */
export function landingRequest(start: RouteState, goals: RouteGoal[], margin: number, o: { maxNodes?: number; maxMs?: number; weight?: number } = {}): RouteRequest {
  return { start, goals, margin, maxNodes: o.maxNodes ?? ROUTE_PLAN_NODES, maxMs: o.maxMs ?? ROUTE_PLAN_MS, weight: o.weight ?? ROUTE_WEIGHT, library: 'landing' };
}

export interface LandingRouteOptions {
  /** The bearings to try, in order (default ROUTE_BEARINGS from `prefer` round). */
  bearings?: readonly number[];
  /** The bearing tried first (the side the body comes from). */
  prefer?: number;
  /** Rockets the plan may use (default 2). */
  rockets?: number;
  maxNodes?: number;
  maxMs?: number;
  weight?: number;
  /** The margin round the box (default specMargin: the passage's narrower side). */
  margin?: number;
  /** At most this many bearings (default all given). */
  tries?: number;
  /** No `via` hint on the goal (the tests' ablation). */
  noVia?: boolean;
}

export interface LandingRouteResult {
  route: RouteHandoff | undefined;
  /** One note per bearing tried. */
  tried: string[];
}

/**
 * Plan a route landing onto `spec` on `grid`: bearing by bearing (the preferred first) a search from the entry
 * state onto the cells; the first complete plan wins. `plan` runs the search (the worker's planner, or the
 * in-thread one by default). Undefined route: no bearing has a plan (the notes say how far each got).
 */
export async function planLandingRoute(grid: RouteGrid, spec: LandingRouteSpec, o: LandingRouteOptions = {}, plan?: Planner): Promise<LandingRouteResult> {
  const margin = o.margin ?? specMargin(spec);
  const base = o.bearings ?? ROUTE_BEARINGS;
  const prefer = o.prefer;
  const bearings = prefer === undefined ? [...base] : [...base].sort((a, b) => Math.abs((((a - prefer) % 360) + 540) % 360 - 180) - Math.abs((((b - prefer) % 360) + 540) % 360 - 180));
  const run: Planner = plan ?? ((req) => planRoute(req, grid));
  const tried: string[] = [];
  // the weights tried per bearing: the greedy one first (the stacks, the shaft, a room: a few hundred nodes), then the plain
  // A* (a pocket in a cliff face wants the dive before the turn in, which the greedy search skips; measured offline)
  const weights = o.weight !== undefined ? [o.weight] : ROUTE_WEIGHTS;
  for (const bearing of bearings.slice(0, o.tries ?? ROUTE_TRIES)) {
    const g0 = landingGoalFor(spec, bearing);
    const goals = [o.noVia && g0.kind === 'landing' ? { ...g0, via: undefined } : g0];
    const start = routeEntry(spec, bearing, o.rockets ?? 2);
    for (const weight of weights) {
      const req = landingRequest(start, goals, margin, { ...o, weight });
      let p: RoutePlan;
      try {
        p = await run(req);
      } catch (e) {
        tried.push(`${Math.round(bearing)} w${weight}: the planner failed (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      if (p.complete) {
        tried.push(`${Math.round(bearing)} w${weight}: ${p.ticks} ticks, ${p.rockets} rockets, ${p.nodes} nodes, ${p.ms.toFixed(0)} ms (${p.edges.map((e) => e.name).join(' ')})`);
        return {
          route: { bearing, entry: start.pos, yaw: start.yaw, speed: ROUTE_ENTRY_SPEED, goals, margin, weight, ticks: p.ticks, rockets: p.rockets, edges: p.edges.map((e) => e.name).join(' '), nodes: p.nodes, ms: p.ms },
          tried,
        };
      }
      tried.push(`${Math.round(bearing)} w${weight}: no plan (${p.why ?? '?'}; ${p.nodes} nodes, ${p.ms.toFixed(0)} ms)`);
      // (a bearing whose entry is inside a solid, or whose every edge hits at once, is no better at another weight)
      if (p.nodes <= 1) break;
    }
  }
  return { route: undefined, tried };
}

/** The heuristic weights tried per bearing, in order (ROUTE_WEIGHT first). */
export const ROUTE_WEIGHTS: readonly number[] = [ROUTE_WEIGHT, 1];
/** Bearings tried at most for one landing (each up to ROUTE_WEIGHTS searches of ROUTE_PLAN_MS). */
export const ROUTE_TRIES = 6;
