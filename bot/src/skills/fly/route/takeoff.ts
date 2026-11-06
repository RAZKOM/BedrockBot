// Track F3 (docs/flight.md "Route landings and takeoffs (Track F3)", decisions/0064): the route takeoff. When
// the jump, the ledge and the vertical takeoff are all refused (the walls of a hole, a low roof, the flat
// section of a staircase, the inner platform of a stack), the route planner is asked for a way out: the air
// around the start is flooded (6-connected, through cells the body could be in) for the nearest cells under
// open sky (`exitsFrom`), and `planTakeoffRoute` searches a plan from standing (the jump, the glide on the
// falling tick, a rocket once the glide has taken: F2's takeoff primitives, GLIDE_DELAY) to a waypoint box
// there. The brain flies it with the RouteTracker as its takeoff phase, then the usual climb (brain.ts
// `routeTakeoff`). It is the last step of the takeoff chain before the walk-out legs (commands-fly.ts
// takeoffFor).
import type { Vec3 } from '../../../connection/types.ts';
import { yawTo } from '../plan.ts';
import type { RouteGrid } from './grid.ts';
import { planRoute } from './search.ts';
import type { Planner } from './tracker.ts';
import { NO_BOOST, type RouteGoal, type RoutePlan, type RouteRequest, type RouteState } from './types.ts';

/** The flood fill's reach (cells) and the open sky an exit needs over it (cells of known air). */
export const EXIT_FLOOD_MAX = 6000;
export const EXIT_OPEN_SKY = 16;
/** Exits within this many blocks (straight line) of the start are considered, the nearest by the flood first. */
export const EXIT_RADIUS = 32;
/** The waypoint box at an exit: `EXIT_BOX` cells each way around it horizontally, from EXIT_BOX_OVER above its feet height (a jump alone never gets there: the body passes it gliding) up EXIT_BOX_UP. */
export const EXIT_BOX = 1;
export const EXIT_BOX_OVER = 2;
export const EXIT_BOX_UP = 6;
/** The search budget of a takeoff route (per exit) and the heuristic's weight. */
export const TAKEOFF_PLAN_NODES = 40_000;
export const TAKEOFF_PLAN_MS = 800;
export const TAKEOFF_WEIGHT = 2;
/** The margin round the box for a takeoff route (the staircase's 0.15 of Track F2). */
export const TAKEOFF_MARGIN = 0.15;

export interface Exit {
  /** The cell (feet in it) under open sky. */
  x: number;
  y: number;
  z: number;
  /** Cells of the flood from the start. */
  steps: number;
  /** The straight distance from the start. */
  dist: number;
}

/**
 * The cells under open sky the body could reach through the air from `from` (feet): a flood fill through the
 * air cells (6-connected, up to EXIT_FLOOD_MAX cells) from the start's feet cell, keeping the cells whose
 * column is known air for EXIT_OPEN_SKY over them and that lie at or above the start's feet (a takeoff goes
 * up and out, not down a hole), within EXIT_RADIUS. Sorted by the flood's steps (the nearest way out first).
 * An unknown cell is solid (the grid's rule).
 */
export function exitsFrom(grid: RouteGrid, from: Vec3, o: { max?: number; radius?: number; openSky?: number } = {}): Exit[] {
  const max = o.max ?? EXIT_FLOOD_MAX;
  const radius = o.radius ?? EXIT_RADIUS;
  const sky = o.openSky ?? EXIT_OPEN_SKY;
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const sz = Math.floor(from.z);
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  const seen = new Set<string>([key(sx, sy, sz)]);
  const queue: [number, number, number, number][] = [[sx, sy, sz, 0]];
  const out: Exit[] = [];
  const open = (x: number, y: number, z: number): boolean => {
    for (let k = 1; k <= sky; k++) if (grid.solid(x, y + k, z)) return false;
    return true;
  };
  for (let i = 0; i < queue.length && seen.size < max; i++) {
    const [x, y, z, steps] = queue[i]!;
    const dist = Math.hypot(x - sx, y - sy, z - sz);
    if (y >= sy && !(x === sx && z === sz && y === sy) && open(x, y, z)) out.push({ x, y, z, steps, dist });
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (Math.hypot(nx - sx, ny - sy, nz - sz) > radius) continue;
      const k = key(nx, ny, nz);
      if (seen.has(k) || grid.solid(nx, ny, nz)) continue;
      seen.add(k);
      queue.push([nx, ny, nz, steps + 1]);
    }
  }
  out.sort((a, b) => a.steps - b.steps || a.dist - b.dist);
  return out;
}

/** The waypoint box of an exit: EXIT_BOX cells each way around it, from EXIT_BOX_OVER over its feet height up to EXIT_BOX_UP. */
export function exitGoal(e: Exit): RouteGoal {
  return { kind: 'waypoint', box: { min: { x: e.x - EXIT_BOX, y: e.y + EXIT_BOX_OVER, z: e.z - EXIT_BOX }, max: { x: e.x + EXIT_BOX + 1, y: e.y + EXIT_BOX_UP, z: e.z + EXIT_BOX + 1 } } };
}

/** The standing start state of a takeoff route. */
export function takeoffStart(from: Vec3, yaw: number, rockets: number): RouteState {
  return { pos: { ...from }, vel: { x: 0, y: 0, z: 0 }, yaw, boost: { ...NO_BOOST }, gliding: false, rockets, wp: 0 };
}

export interface TakeoffRoute {
  exit: Exit;
  goals: RouteGoal[];
  margin: number;
  weight: number;
  /** The heading the climb turns to after the exit (towards the target). */
  yaw: number;
  ticks: number;
  rockets: number;
  edges: string;
  nodes: number;
  ms: number;
}

export interface TakeoffRouteOptions {
  /** Exits tried at most (default 3), and exits the same column as an earlier one skipped. */
  tries?: number;
  rockets?: number;
  margin?: number;
  maxNodes?: number;
  maxMs?: number;
  weight?: number;
}

/**
 * Plan a takeoff route from standing at `from` to the nearest exits under open sky (exitsFrom), towards
 * `target` (the climb's heading afterwards): the first exit with a complete plan wins. `plan` runs the search
 * (the worker's planner, or the in-thread one). Undefined route: no exit, or no plan to any tried.
 */
export async function planTakeoffRoute(grid: RouteGrid, from: Vec3, target: { x: number; z: number }, o: TakeoffRouteOptions = {}, plan?: Planner): Promise<{ route: TakeoffRoute | undefined; exits: number; tried: string[] }> {
  const exits = exitsFrom(grid, from);
  const tried: string[] = [];
  if (!exits.length) return { route: undefined, exits: 0, tried };
  const run: Planner = plan ?? ((req) => planRoute(req, grid));
  const yaw = yawTo(from, target);
  const seen = new Set<string>();
  let tries = 0;
  for (const e of exits) {
    const col = `${e.x},${e.z}`;
    if (seen.has(col)) continue;
    seen.add(col);
    if (tries++ >= (o.tries ?? 3)) break;
    const goals = [exitGoal(e)];
    const req: RouteRequest = { start: takeoffStart(from, yaw, o.rockets ?? 4), goals, margin: o.margin ?? TAKEOFF_MARGIN, maxNodes: o.maxNodes ?? TAKEOFF_PLAN_NODES, maxMs: o.maxMs ?? TAKEOFF_PLAN_MS, weight: o.weight ?? TAKEOFF_WEIGHT };
    let p: RoutePlan;
    try {
      p = await run(req);
    } catch (err) {
      tried.push(`${e.x} ${e.y} ${e.z}: the planner failed (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const at = `${e.x} ${e.y} ${e.z} (${e.steps} cells away)`;
    if (p.complete) {
      tried.push(`${at}: ${p.ticks} ticks, ${p.rockets} rockets, ${p.nodes} nodes, ${p.ms.toFixed(0)} ms (${p.edges.map((k) => k.name).join(' ')})`);
      return { route: { exit: e, goals, margin: req.margin, weight: req.weight ?? TAKEOFF_WEIGHT, yaw, ticks: p.ticks, rockets: p.rockets, edges: p.edges.map((k) => k.name).join(' '), nodes: p.nodes, ms: p.ms }, exits: exits.length, tried };
    }
    tried.push(`${at}: no plan (${p.why ?? '?'}; ${p.nodes} nodes, ${p.ms.toFixed(0)} ms)`);
  }
  return { route: undefined, exits: exits.length, tried };
}
