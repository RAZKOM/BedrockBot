// Track F3 (docs/flight.md "Route landings and takeoffs (Track F3)", decisions/0064): the route takeoff. When
// the jump, the ledge and the vertical takeoff are all refused (the walls of a hole, a low roof, the flat
// section of a staircase, the inner platform of a stack), the route planner is asked for a way out: the air
// around the start is flooded (6-connected, through cells the body could be in) for the nearest cells under
// open sky (`exitsFrom`), and `planTakeoffRoute` searches a plan from standing (the jump, the glide on the
// falling tick, a rocket once the glide has taken: F2's takeoff primitives, GLIDE_DELAY) to a waypoint box
// there. The brain flies it with the RouteTracker as its takeoff phase, then the usual climb (brain.ts
// `routeTakeoff`). It is the last step of the takeoff chain before the walk-out legs (commands-fly.ts
// takeoffFor).
//
// Track F9a (docs/flight.md "Cave exit (Track F9a)", decisions/0077): an exit is a cell with EXIT_OPEN_SKY of air over
// it, which the hall of a cave has too, and a plan to it proves nothing after it. A route takeoff is now offered only
// with a proof of what follows (`TakeoffRouteOptions.prove`: glide.ts routeTakeoff, the whole takeoff simulated, the
// climb as it will be flown: the exit's line kept until the sky is open over the body, then the heading turned to the
// target as the path ahead clears), and what clears is ranked by how soon it is OUT under open sky (the goal's bearing
// steers nothing before that; the time to the goal only breaks a tie). The exits tried lie apart (EXIT_APART) where there is more than one way; and where none of them
// has a climb that clears, the WAYS OUT are tried (`waysOut`, `TakeoffRouteOptions.far`: the caller asks for them only
// with `flyCave` on): a flood that stays under the roof, through cells with room round the box, to the cells under the
// real sky, the plan through waypoints along the flood's way (`wayGoals`), searched in pieces.
//
// Track F9b (docs/flight.md "Learned exits (Track F9b)", decisions/0078): before any of that, a recorded flight that left
// the ground where the body stands and came out under open sky (`TakeoffRouteOptions.learned`: learn/match.ts) is the way
// out, flown along its own line by the guide follower and proven as every other route takeoff is; the caller passes the
// recordings only with `flyCave` and `flyLearned` on.
import type { Vec3 } from '../../../connection/types.ts';
import { FOLLOW_MARGIN, LINE_ROOM_MAX, lineRoom } from '../learn/follow.ts'; // Track F9b
import type { Guide } from '../learn/guide.ts'; // Track F9b
import type { GuideMatch } from '../learn/match.ts'; // Track F9b
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
/** Track F9a: the exits tried lie at least this far apart while there are such (three cells of one opening were three tries of the same plan). */
export const EXIT_APART = 8;
/** Track F9a: the proofs and plans of one takeoff stop being started after this long (ms): the body stands meanwhile. */
export const TAKEOFF_BUDGET_MS = 6000;
/** Track F9a, the ways out: the flood's reach (blocks, straight) and cells, the steps from the start that need no room (the jump), the room a cell must have round it (cells each side, two high). */
export const WAY_RADIUS = 96;
export const WAY_FLOOD_MAX = 60_000;
export const WAY_THIN = 3;
export const WAY_ROOM = 1;
/** Track F9a: ways out tried at most, at least WAY_APART apart; a waypoint every WAY_STEP cells of the flood's way. */
export const WAY_TRIES = 2;
export const WAY_APART = 12;
export const WAY_STEP = 24;
/** Track F9a: a way's waypoint box reaches this high over its cell at most (measured on the owner's cave at 3 and at 12, the air over the cell: the same 48 ticks and 4 rockets, the search 200 ms against 650). */
export const WAY_BOX_UP = 3;
/** Track F9a: the search of a way out: its pieces (goals each), budget and rockets. */
export const WAY_PIECES = 1;
export const WAY_PLAN_NODES = 80_000;
export const WAY_PLAN_MS = 2000;
export const WAY_ROCKETS = 6;
/** Track F9a: the margin a way out keeps round the box and its risk weight (ticks of cost a tick flown within a block of a solid; the exits' own are TAKEOFF_MARGIN and the planner's 0.5). */
export const WAY_MARGIN = 0.15;
export const WAY_RISK = 0.5;

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

export interface WayOut extends Exit {
  /** The flood's way from the start to the cell (cells, the start first). */
  way: { x: number; y: number; z: number }[];
  /**
   * The point in the open the way out ends at: OPEN_OUT blocks from the cell along the heading with the longest run of
   * open sky from it (of 12, each column under the real sky on a line rising OPEN_RISE a block, up to OPEN_RUN), so the
   * plan leaves the roof flying into the widest open air and the climb takes over with room ahead, whatever the goal's
   * bearing. Undefined when no heading has OPEN_MIN of open sky.
   */
  open?: { x: number; y: number; z: number; run: number };
}

/** Track F9a: the open point of a way out: the run looked at (blocks), the least that counts, how far out the point lies and the line's rise a block. */
export const OPEN_RUN = 40;
export const OPEN_MIN = 14;
export const OPEN_OUT = 12;
export const OPEN_RISE = 0.3;

/**
 * Track F9a: the ways out from under a roof: a flood from the start's feet cell through the air (6-connected) that STAYS
 * under the roof: a cell under the real sky (no solid over it up to `top`, the cruise height; unknown is solid, the
 * grid's rule) is a way out and is not flooded past, so the flood is the cave's own size and not the sky's. Past the
 * first WAY_THIN steps (the jump) a cell needs room round it (WAY_ROOM cells each side, two high): the way is one a
 * gliding body has a berth in, not a crack. The ways out at least `apart` from each other, the nearest by the flood
 * first, each with the flood's way to it.
 */
export function waysOut(grid: RouteGrid, from: Vec3, top: number, o: { radius?: number; max?: number; apart?: number; tries?: number } = {}): { ways: WayOut[]; cells: number } {
  const radius = o.radius ?? WAY_RADIUS;
  const max = o.max ?? WAY_FLOOD_MAX;
  const apart = o.apart ?? WAY_APART;
  const tries = o.tries ?? WAY_TRIES;
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const sz = Math.floor(from.z);
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  // the highest solid of a column up to `top` (memo: one scan a column): a cell over it is under the sky
  const roof = new Map<string, number>();
  const roofOf = (x: number, z: number): number => {
    const k = `${x},${z}`;
    let y = roof.get(k);
    if (y === undefined) {
      y = Math.floor(top);
      while (y > sy - radius && !grid.solid(x, y, z)) y--;
      roof.set(k, y);
    }
    return y;
  };
  const room = (x: number, y: number, z: number): boolean => {
    for (let dx = -WAY_ROOM; dx <= WAY_ROOM; dx++) for (let dz = -WAY_ROOM; dz <= WAY_ROOM; dz++) for (let dy = 0; dy <= 1; dy++) if (grid.solid(x + dx, y + dy, z + dz)) return false;
    return true;
  };
  const cells: [number, number, number, number][] = [[sx, sy, sz, 0]];
  const parent: number[] = [-1];
  const seen = new Set<string>([key(sx, sy, sz)]);
  const ways: WayOut[] = [];
  for (let i = 0; i < cells.length && cells.length < max && ways.length < tries; i++) {
    const [x, y, z, steps] = cells[i]!;
    if (i > 0 && y > roofOf(x, z)) {
      if (ways.every((w) => Math.hypot(w.x - x, w.y - y, w.z - z) >= apart)) {
        const way: WayOut['way'] = [];
        for (let k = i; k >= 0; k = parent[k]!) way.push({ x: cells[k]![0], y: cells[k]![1], z: cells[k]![2] });
        // the heading with the longest run of open sky from the cell (a block's berth each side), on a gently rising line
        let open: WayOut['open'];
        for (let h = 0; h < 12; h++) {
          const r = (h * 30 * Math.PI) / 180;
          const dir = { x: -Math.sin(r), z: Math.cos(r) };
          let run = 0;
          for (let s = 1; s <= OPEN_RUN; s++) {
            const cy = Math.floor(y + 2 + s * OPEN_RISE);
            const clear = [-1, 0, 1].every((lat) => cy > roofOf(Math.floor(x + 0.5 + dir.x * s - dir.z * lat), Math.floor(z + 0.5 + dir.z * s + dir.x * lat)) + 1);
            if (!clear) break;
            run = s;
          }
          if (run >= OPEN_MIN && (!open || run > open.run)) open = { x: Math.floor(x + 0.5 + dir.x * OPEN_OUT), y: Math.floor(y + 2 + OPEN_OUT * OPEN_RISE), z: Math.floor(z + 0.5 + dir.z * OPEN_OUT), run };
        }
        ways.push({ x, y, z, steps, dist: Math.hypot(x - sx, y - sy, z - sz), way: way.reverse(), ...(open ? { open } : {}) });
      }
      continue; // under the sky: a way out, not a way on
    }
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (Math.hypot(nx - sx, ny - sy, nz - sz) > radius) continue;
      const k = key(nx, ny, nz);
      if (seen.has(k) || grid.solid(nx, ny, nz)) continue;
      if (steps >= WAY_THIN && !room(nx, ny, nz)) continue;
      seen.add(k);
      parent.push(i);
      cells.push([nx, ny, nz, steps + 1]);
    }
  }
  return { ways, cells: cells.length };
}

/**
 * Track F9a: the goals of a way out: a waypoint box every `step` cells of the flood's way, 3 x 3 round the cell and as
 * high as the air over it up to WAY_BOX_UP (at least 3), then the exit's (over the cell from its feet up: the body
 * arrives flying), then the way's open point (`WayOut.open`).
 */
export function wayGoals(w: WayOut, grid: RouteGrid, step = WAY_STEP): RouteGoal[] {
  const goals: RouteGoal[] = [];
  for (let k = step; k < w.way.length - step / 2; k += step) {
    const c = w.way[k]!;
    let up = 1;
    while (up < WAY_BOX_UP && !grid.solid(c.x, c.y + up, c.z)) up++;
    goals.push({ kind: 'waypoint', box: { min: { x: c.x - 1, y: c.y, z: c.z - 1 }, max: { x: c.x + 2, y: c.y + Math.max(3, up), z: c.z + 2 } } });
  }
  goals.push({ kind: 'waypoint', box: { min: { x: w.x - EXIT_BOX, y: w.y, z: w.z - EXIT_BOX }, max: { x: w.x + EXIT_BOX + 1, y: w.y + EXIT_BOX_UP, z: w.z + EXIT_BOX + 1 } } });
  // ... and on to the open point (5 x 5, 6 high): out from under the roof with open air ahead before the climb takes over
  if (w.open) goals.push({ kind: 'waypoint', box: { min: { x: w.open.x - 2, y: w.open.y - 1, z: w.open.z - 2 }, max: { x: w.open.x + 3, y: w.open.y + 5, z: w.open.z + 3 } } });
  return goals;
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
  /** Track F9a: a way out under the roof through several goals: searched in pieces of this many goals, with this risk weight. */
  pieces?: number;
  riskCost?: number;
  /** Track F9a: the takeoff was proven (the whole of it simulated): the tick the body has open sky over it (the ranking: the quickest way OUT) and its time to the goal in ticks (the tie-break). */
  proven?: boolean;
  out?: number;
  score?: number;
  /**
   * Track F9b (docs/flight.md "Learned exits"): the way out is a recorded flight's line, flown by the guide follower with no
   * plan (`goals` is empty, `ticks` the recording's own to its first open sky, `rockets` those it fired on the line): the
   * line, the blocks along it to its first point under open sky, and how far from the body the recording left the ground.
   */
  guide?: { line: Guide; open: number; off: number };
}

/** Track F9a: the proof of a route takeoff's plan: whether what follows it clears, with the time to the goal (ticks), and the line saying what was flown or met. */
export type TakeoffProof = (route: TakeoffRoute) => Promise<{ ok: boolean; ticks?: number; out?: number; line: string }>;

export interface TakeoffRouteOptions {
  /** Exits tried at most (default 3). */
  tries?: number;
  rockets?: number;
  margin?: number;
  maxNodes?: number;
  maxMs?: number;
  weight?: number;
  /** Track F9a: a plan is offered only when this proves what follows it (glide.ts routeTakeoff); without it the first complete plan is taken, unproven (Track F3's rule: the tests and the benches). */
  prove?: TakeoffProof;
  /** Track F9a: when no exit's climb clears, the ways out under the roof (`waysOut` up to `top`, the cruise height): powered flight under a roof, so the caller asks only with `flyCave` on. */
  far?: { top: number; radius?: number; tries?: number; rockets?: number; margin?: number; riskCost?: number; maxNodes?: number; maxMs?: number };
  /** Track F9a: no new plan or proof once this long has gone (default TAKEOFF_BUDGET_MS). */
  budgetMs?: number;
  now?: () => number;
  /**
   * Track F9b: the recorded flights that leave the ground where the body stands and come out under open sky (learn/match.ts
   * matchExits, the nearest first). Each is tried before anything else, up to LEARNED_TRIES, and only with `prove`: a
   * recording is a guide, not a licence, and nothing learned is offered unproven. Powered flight under a roof: the caller
   * passes them only with `flyCave` and `flyLearned` on.
   */
  learned?: { matches: readonly GuideMatch[]; tries?: number };
}

/** Track F9b: the learned ways out proven at most for one takeoff (each proof is up to fifteen simulations, about a twentieth of a second each). */
export const LEARNED_TRIES = 3;

/** Track F9b: a recorded line as a takeoff route: its exit is the line's first point under open sky, its ticks the recording's own to there. */
export function learnedRoute(m: GuideMatch, from: Vec3, yaw: number): TakeoffRoute {
  const g = m.guide;
  const k = Math.min(g.points.length - 1, Math.round(m.open));
  const p = g.points[k]!;
  return {
    exit: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), steps: Math.round(m.open), dist: Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) },
    goals: [],
    margin: FOLLOW_MARGIN,
    weight: TAKEOFF_WEIGHT,
    yaw,
    ticks: Math.round(g.ticks[k] ?? 0),
    rockets: g.rockets.filter((r) => r.at <= m.open).length,
    edges: `the recorded line ${g.path}`,
    nodes: 0,
    ms: 0,
    guide: { line: g, open: m.open, off: m.off },
  };
}

/** Track F9a: the exits to try: the nearest, then those at least `apart` from every one chosen, then (fewer than `tries` such) the nearest in other columns, as before. */
export function exitsToTry(exits: readonly Exit[], tries: number, apart = EXIT_APART): Exit[] {
  const out: Exit[] = [];
  for (const e of exits) {
    if (out.length >= tries) break;
    if (out.every((c) => Math.hypot(c.x - e.x, c.y - e.y, c.z - e.z) >= apart)) out.push(e);
  }
  const cols = new Set(out.map((e) => `${e.x},${e.z}`));
  for (const e of exits) {
    if (out.length >= tries) break;
    if (cols.has(`${e.x},${e.z}`)) continue;
    cols.add(`${e.x},${e.z}`);
    out.push(e);
  }
  return out;
}

/**
 * Plan a takeoff route from standing at `from` to the nearest exits under open sky (exitsFrom), towards `target`.
 * `plan` runs the search (the worker's planner, or the in-thread one). Track F9a: with `prove` every complete plan
 * is proven (the climb after it) and the proven one that is out under open sky soonest wins (the time to the goal
 * breaks a tie: a takeoff from under a roof first gets OUT, then flies to the goal); none proven and `far`: the ways out under the roof (`waysOut`), the first proven. Without `prove` the first
 * exit with a complete plan wins (Track F3). Undefined route: no exit, no plan, or nothing proven; `tried` says why.
 */
export async function planTakeoffRoute(grid: RouteGrid, from: Vec3, target: { x: number; z: number }, o: TakeoffRouteOptions = {}, plan?: Planner): Promise<{ route: TakeoffRoute | undefined; exits: number; tried: string[]; ways?: number; learned?: number }> {
  const exits = exitsFrom(grid, from);
  const tried: string[] = [];
  const now = o.now ?? (() => performance.now());
  const t0 = now();
  const spent = (): boolean => now() - t0 > (o.budgetMs ?? TAKEOFF_BUDGET_MS);
  const run: Planner = plan ?? ((req) => planRoute(req, grid));
  const yaw = yawTo(from, target);
  const margin = o.margin ?? TAKEOFF_MARGIN;
  const weight = o.weight ?? TAKEOFF_WEIGHT;
  const wayMargin = o.far?.margin ?? WAY_MARGIN;
  const wayRisk = o.far?.riskCost ?? WAY_RISK;
  /** One candidate: the plan to its goals, then (with `prove`) the proof; the route when it may be flown. */
  const attempt = async (e: Exit, goals: RouteGoal[], at: string, far: boolean): Promise<TakeoffRoute | undefined> => {
    const req: RouteRequest = {
      start: takeoffStart(from, yaw, far ? (o.far?.rockets ?? WAY_ROCKETS) : (o.rockets ?? 4)),
      goals,
      margin: far ? wayMargin : margin,
      ...(far ? { riskCost: wayRisk } : {}),
      maxNodes: far ? (o.far?.maxNodes ?? WAY_PLAN_NODES) : (o.maxNodes ?? TAKEOFF_PLAN_NODES),
      maxMs: far ? (o.far?.maxMs ?? WAY_PLAN_MS) : (o.maxMs ?? TAKEOFF_PLAN_MS),
      weight,
      ...(far ? { pieces: WAY_PIECES } : {}),
    };
    let p: RoutePlan;
    try {
      p = await run(req);
    } catch (err) {
      tried.push(`${at}: the planner failed (${err instanceof Error ? err.message : String(err)})`);
      return undefined;
    }
    if (!p.complete) {
      tried.push(`${at}: no plan (${p.why ?? '?'}; ${p.nodes} nodes, ${p.ms.toFixed(0)} ms)`);
      return undefined;
    }
    const route: TakeoffRoute = { exit: e, goals, margin: far ? wayMargin : margin, ...(far ? { riskCost: wayRisk } : {}), weight, yaw, ticks: p.ticks, rockets: p.rockets, edges: p.edges.map((k) => k.name).join(' '), nodes: p.nodes, ms: p.ms, ...(far ? { pieces: WAY_PIECES } : {}) };
    const planned = `${at}: ${p.ticks} ticks, ${p.rockets} rockets, ${p.nodes} nodes, ${p.ms.toFixed(0)} ms (${route.edges})`;
    if (!o.prove) {
      tried.push(planned);
      return route;
    }
    const proof = await o.prove(route);
    if (!proof.ok) {
      tried.push(`${planned}; the climb after it: ${proof.line}: refused`);
      return undefined;
    }
    tried.push(`${planned}; the climb after it: ${proof.line}`);
    return { ...route, proven: true, ...(proof.out !== undefined ? { out: proof.out } : {}), ...(proof.ticks !== undefined ? { score: proof.ticks } : {}) };
  };
  // Track F9b: the learned ways out first: a recorded flight that left the ground here and came out under open sky, flown
  // along its own line. The first whose whole takeoff proves clear is taken; one that does not (the world changed since, the
  // line does not suit this body) is refused in a line and the takeoff goes on as it would without a recording.
  let learned: number | undefined;
  if (o.learned && o.prove) {
    learned = 0;
    // (the nearest takeoff first, but a line that itself passes within the follower's berth of a block comes after those that
    // do not: of two takes of one way out the one with room is the one to fly; the owner's own nearest take passes a block
    // beside its start at a quarter of a block)
    const takes = o.learned.matches.map((m) => ({ m, room: lineRoom(grid, m.guide, m.open) }));
    takes.sort((a, b) => Number(a.room < FOLLOW_MARGIN) - Number(b.room < FOLLOW_MARGIN) || a.m.off - b.m.off);
    for (const { m, room } of takes.slice(0, o.learned.tries ?? LEARNED_TRIES)) {
      if (tried.length && spent()) break;
      learned++;
      const route = learnedRoute(m, from, yaw);
      const g = m.guide;
      const at = `the learned way out along ${g.path} (it left the ground ${m.off.toFixed(1)} from here, ${m.open.toFixed(0)} blocks to open sky in ${route.ticks} ticks, ${route.rockets} rocket${route.rockets === 1 ? '' : 's'}, its line ${room >= LINE_ROOM_MAX ? `${LINE_ROOM_MAX} or more` : room.toFixed(2)} from the nearest block)`;
      const proof = await o.prove(route);
      if (!proof.ok) {
        tried.push(`${at}: ${proof.line}: refused`);
        continue;
      }
      tried.push(`${at}: ${proof.line}`);
      return { route: { ...route, proven: true, ...(proof.out !== undefined ? { out: proof.out } : {}), ...(proof.ticks !== undefined ? { score: proof.ticks } : {}) }, exits: exits.length, tried, learned };
    }
  }
  const more = learned !== undefined ? { learned } : {};
  let best: TakeoffRoute | undefined;
  // (an exit beside one whose climb was refused is the same opening: its climb is the same one)
  const refused: Exit[] = [];
  for (const e of exitsToTry(exits, o.tries ?? 3)) {
    if (tried.length && spent()) break;
    if (refused.some((q) => Math.hypot(q.x - e.x, q.y - e.y, q.z - e.z) < EXIT_APART)) continue;
    const n0 = tried.length;
    const r = await attempt(e, [exitGoal(e)], `${e.x} ${e.y} ${e.z} (${e.steps} cells away)`, false);
    if (!r && tried.length > n0 && tried[tried.length - 1]!.endsWith(': refused')) refused.push(e);
    if (!r) continue;
    if (!o.prove) return { route: r, exits: exits.length, tried, ...more };
    // the quickest way OUT (open sky over the body), whatever the goal's bearing; the time to the goal only breaks a tie
    const key = (q: TakeoffRoute): [number, number] => [q.out ?? Infinity, q.score ?? Infinity];
    const [a, b] = [key(r), best ? key(best) : [Infinity, Infinity]];
    if (!best || a[0] < b[0]! || (a[0] === b[0] && a[1] < b[1]!)) best = r;
  }
  if (best || !o.far) return { route: best, exits: exits.length, tried, ...more };
  // none of the exits has a climb that clears (or there is none): the ways out under the roof
  const out = waysOut(grid, from, o.far.top, { ...(o.far.radius !== undefined ? { radius: o.far.radius } : {}), ...(o.far.tries !== undefined ? { tries: o.far.tries } : {}) });
  if (!out.ways.length) tried.push(`no way out under the roof to the open sky (a flood of ${out.cells} cells, within ${o.far.radius ?? WAY_RADIUS})`);
  // (a way out beside one that had no plan or no clear climb is the same mouth: two cells of the owner's cave's mouth, 13 apart,
  // were two searches of 2 s to the same end)
  const failed: WayOut[] = [];
  for (const w of out.ways) {
    if (spent()) {
      tried.push(`the way out at ${w.x} ${w.y} ${w.z}: not tried (${Math.round(now() - t0)} ms gone)`);
      break;
    }
    if (failed.some((q) => Math.hypot(q.x - w.x, q.y - w.y, q.z - w.z) < 2 * WAY_APART)) continue;
    const goals = wayGoals(w, grid);
    const r = await attempt(w, goals, `the way out at ${w.x} ${w.y} ${w.z} (${w.steps} cells under the roof, ${goals.length} goals)`, true);
    if (r) return { route: r, exits: exits.length, tried, ways: out.ways.length, ...more };
    failed.push(w);
  }
  return { route: undefined, exits: exits.length, tried, ways: out.ways.length, ...more };
}
