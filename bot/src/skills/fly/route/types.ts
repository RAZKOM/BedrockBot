// Track F2 (docs/flight.md "Route planner"; decisions/0058-flight-planner.md): the problem statement of
// the kinodynamic flight planner. Everything here is data: the state the search carries, the controls a
// tick may hold, the goals, the edge an expansion produces and the plan the tracker flies. The physics is
// the glide formula of skills/input/physics.ts (glideVelocity); the search is search.ts, the primitives
// primitives.ts, the grid grid.ts, the tracker tracker.ts.
import type { Vec3 } from '../../../connection/types.ts';

/**
 * The boost ticks left as a RANGE: a rocket burns 12 to 18 ticks at random and its end is only known late
 * (the rocket's remove_entity arrives about 3 ticks after the fact). `min` is the ticks the burn surely
 * still runs, `max` the ticks it may run; a plan is flown on the nominal (`nominal`, GLIDE.boostTicks) and
 * checked for every end in [min, max] (robust.ts).
 */
export interface BoostRange {
  min: number;
  max: number;
  /** The ticks the plan is simulated with (the loop predicts the same nominal; the robust check varies it over [min, max]). */
  nom: number;
}

export const NO_BOOST: Readonly<BoostRange> = Object.freeze({ min: 0, max: 0, nom: 0 });
/** The burn of one flight-duration-1 rocket, measured on bds-fly (Track F0, n 175: 9 to 21 ticks, mean 15.7), nominal 15 (GLIDE.boostTicks). */
export const BURN: Readonly<{ min: number; max: number; nominal: number }> = Object.freeze({ min: 9, max: 21, nominal: 15 });
/** The boost range right after a rocket is used. */
export function freshBurn(): BoostRange {
  return { min: BURN.min, max: BURN.max, nom: BURN.nominal };
}
/** The range one tick later. */
export function burnTick(b: Readonly<BoostRange>): BoostRange {
  return { min: Math.max(0, b.min - 1), max: Math.max(0, b.max - 1), nom: Math.max(0, b.nom - 1) };
}

/** The search state: the body between two ticks. */
export interface RouteState {
  /** Feet position (the gliding box is 0.6 wide and 0.6 high over it). */
  pos: Vec3;
  /** Velocity at the end of the last tick, blocks a tick. */
  vel: Vec3;
  /** The look yaw of the last tick (the heading the body follows when it is too slow to have one). */
  yaw: number;
  boost: BoostRange;
  /** The elytra glides (false: the body stands, a takeoff comes first). */
  gliding: boolean;
  /**
   * Ticks of plain falling left before the glide takes after a jump (measured on bds-fly3: the server's
   * gliding flag comes GLIDE_DELAY ticks after the jump; a rocket used before it does nothing).
   */
  glideIn?: number;
  /** Track F4a: the next tick is the glide's first after a jump (the server's j2): a rocket used on it does nothing (F0). */
  glideFresh?: boolean;
  /** Rockets left in the hand. */
  rockets: number;
  /** Waypoints passed so far (index into `RouteGoal.waypoints`). */
  wp: number;
  /**
   * The burn branches (primitives.ts): the body as it would be had the last rocket burnt the shortest
   * (`early`, BURN.min) or the longest (`late`, BURN.max), stepped with the same controls as the nominal
   * from the fire on and swept like it, so an edge is only taken when all three clear; dropped once they
   * have converged back onto the nominal.
   */
  early?: Branch;
  late?: Branch;
}

export interface Branch {
  pos: Vec3;
  vel: Vec3;
}

/** The controls of one tick (what a vanilla client can do in the air). */
export interface RouteControl {
  yaw: number;
  pitch: number;
  /** Use a rocket this tick (the boost starts on this tick's step). */
  fire: boolean;
  /** The takeoff: press jump (on the ground) and request the glide. */
  jump?: boolean;
  glide?: boolean;
}

/** An axis-aligned box of the world (block coordinates; inclusive of `min`, exclusive of `max`). */
export interface RegionBox {
  min: Vec3;
  max: Vec3;
}

/**
 * A goal region with its constraint:
 *  - `waypoint`: pass through the box (the feet inside it on some tick); the body may be anything there
 *  - `landing`: contact with the cell's top at near-zero speed: the feet within `cell` x / z, descending onto
 *    `top` with |v| under `maxSpeed` (TOUCHDOWN_VY / TOUCHDOWN_H of plan.ts by default)
 *  - `takeoff`: a start from standing is a property of the start state (gliding false), not a goal
 */
export type RouteGoal =
  | { kind: 'waypoint'; box: RegionBox }
  | {
      kind: 'landing';
      cell: { x: number; z: number };
      top: number;
      maxSpeed?: number;
      /**
       * Track F3: the other cells of the floor a touchdown may end in (a 3 x 3 platform, a 2 x 2 shaft floor); `cell`
       * is the one the heuristic measures to and the settle aims at. A contact inside any of them lands.
       */
      cells?: readonly { x: number; z: number }[];
      /**
       * Track F3: the heuristic's hint for a cell that cannot be reached straight (the floor of a shaft, a cell under
       * a low roof): the body must pass `pos` first, then covers the way from there at `speed` (the hover's sink down
       * a shaft, the creep into a slot). Without it the heuristic flies straight at the cell at the boosted speed
       * and a search for a shaft floor drowns in the open air over it (docs/flight.md "Route landings").
       */
      via?: { pos: Vec3; speed: number };
    };

/** Track F3: the cells of a landing goal (the cell and its `cells`). */
export function landingCells(g: Extract<RouteGoal, { kind: 'landing' }>): readonly { x: number; z: number }[] {
  return g.cells?.length ? g.cells : [g.cell];
}

export interface RouteRequest {
  start: RouteState;
  /** Passed in order; the last one ends the plan. */
  goals: RouteGoal[];
  /** The berth kept around the 0.6 box against every solid cell (blocks; plan.ts OBSTACLE_BERTH 0.4 in the open, 0.1 to 0.2 in a tunnel). */
  margin: number;
  /** Search budgets. */
  maxNodes: number;
  maxMs: number;
  /** The cost of a rocket in ticks (default ROCKET_COST). */
  rocketCost?: number;
  /** The risk weight: ticks of cost per tick flown with the box within RISK_RANGE of a solid (default RISK_COST). */
  riskCost?: number;
  /** Ticks per primitive edge (default EDGE_TICKS). */
  edgeTicks?: number;
  /** Which primitive families to use (default all; the benchmark's ablations). */
  families?: readonly PrimitiveFamily[];
  /**
   * Track F3: the edge set by name, so a request can cross to the worker: `minimal` (default) is F2's library
   * (primitives.ts libraryFor), `landing` is F2's glides, turns and rockets with Track F1's manoeuvres and the
   * brake landing's approaches and settles onto every landing goal (maneuvers-route.ts routeLibrary).
   */
  library?: 'minimal' | 'landing';
  /** Rockets may be fired while one burns (F0 measures whether they stack; default false: only when none burns for sure). */
  stackRockets?: boolean;
  /**
   * Every edge after a rocket is swept for the shortest and the longest burn too (`RouteState.early` /
   * `late`), so the plan is robust to the burn by construction (default true); when no complete plan is
   * found that way the search runs once more without, and the plan says `robust: false`.
   */
  burnBranches?: boolean;
  /** The search's seed (tie breaks; the search itself is deterministic). */
  seed?: number;
  /**
   * Track F3: the heuristic's weight (f = g + weight x h; default 1). Over 1 the search is greedier towards
   * the goal and finds a landing's long edges (an approach, a settle of 40 ticks) in far fewer nodes, for a
   * plan that may be a few ticks longer than the best one.
   */
  weight?: number;
}

export type PrimitiveFamily = 'glide' | 'turn' | 'rocket' | 'brake' | 'hover' | 'takeoff' | 'maneuver';

/**
 * What a manoeuvre exposes to become an edge of the search (the plug for Track F1's library). Pure: a control
 * law over the state, a duration and the applicability; the planner simulates it on the glide formula
 * through the grid (primitives.ts `edgeOf`) and gets the swept boxes, ticks, rockets and robustness from
 * that, never from the manoeuvre's own estimate.
 */
export interface Maneuver {
  /** A short name for the plan's log (`brake180`, `snap90L`). */
  readonly name: string;
  readonly family: PrimitiveFamily;
  /** The manoeuvre applies from this state (speed range, a rocket needed, ...). */
  applies(s: Readonly<RouteState>): boolean;
  /**
   * The controls of tick `i` (0-based) of the manoeuvre from `s` (the state at the manoeuvre's start; `now`
   * the state before tick `i`): yaw, pitch, fire. `fire` is honoured only when a rocket is in the hand and
   * the request allows it (stackRockets); the planner counts it.
   */
  control(s: Readonly<RouteState>, now: Readonly<RouteState>, i: number): RouteControl;
  /** The manoeuvre lasts this many ticks from `s` (at most EDGE_MAX_TICKS); `done` may end it earlier. */
  ticks(s: Readonly<RouteState>): number;
  /** Optional: the manoeuvre is complete before its ticks are up (a brake once the speed is under 0.2). */
  done?(s: Readonly<RouteState>, now: Readonly<RouteState>, i: number): boolean;
}

/** One edge of the search: a primitive flown from a state through the grid. */
export interface RouteEdge {
  name: string;
  family: PrimitiveFamily;
  out: RouteState;
  /** The per-tick controls (ticks long). */
  controls: RouteControl[];
  /** The feet position after each tick (ticks long). */
  path: Vec3[];
  ticks: number;
  rockets: number;
  /** The least clearance of the swept box from any solid cell along the edge (blocks, capped at RISK_RANGE). */
  clearance: number;
  /** The risk along the edge: the sum over its ticks of (1 - clearance / RISK_RANGE), 0 when every tick is RISK_RANGE clear. */
  risk: number;
  /** The edge has no rocket, or its rocket's every burn end in the range sweeps clear (robust.ts checks the whole plan again). */
  robust: boolean;
}

export interface RoutePlan {
  /** The controls tick by tick from the start state. */
  controls: RouteControl[];
  /** The state after each tick (controls.length long); `states[i]` follows `controls[i]`. */
  states: RouteState[];
  /** The edges in order (for the log). */
  edges: { name: string; at: number; ticks: number }[];
  ticks: number;
  rockets: number;
  cost: number;
  /** The least clearance along the plan (blocks, capped at RISK_RANGE). */
  clearance: number;
  /** All goals reached (else the plan is the best partial: the node nearest the next goal). */
  complete: boolean;
  /** Waypoints reached by the plan. */
  reached: number;
  /** Every rocket's burn end in [BURN.min, BURN.max] sweeps clear along the plan's controls (robust.ts). */
  robust: boolean;
  /** The least clearance over the burn branches (blocks), or undefined without rockets. */
  robustClearance?: number;
  /** The search's effort. */
  nodes: number;
  expanded: number;
  ms: number;
  /** The budget ended the search (nodes or ms) before the open list emptied. */
  budget: 'none' | 'nodes' | 'ms';
  /** Why no complete plan, when not complete. */
  why?: string;
}

/** Ticks of cost per rocket (a rocket is worth about 20 ticks of flight to the economy; the search prefers a glide that costs under that). */
export const ROCKET_COST = 20;
/** Cost per tick flown with the box within RISK_RANGE of a solid. */
export const RISK_COST = 0.5;
/** The clearance under which a tick counts as risky (blocks beyond the margin). */
export const RISK_RANGE = 1.0;
/** Ticks per primitive edge (the look lags the velocity by about 2 ticks under a rocket: 3 ticks is one decision). */
export const EDGE_TICKS = 3;
export const EDGE_MAX_TICKS = 40;
/**
 * Airborne inputs of plain jump physics before the server's glide takes after a jump. Track F0 measured it on
 * bds-fly (docs/flight-envelope.md section 8): the input right after the jump's is refused, the glide takes from
 * the 2nd airborne input on, while the body still rises (F2's "only once the body falls" was a teleport
 * artefact). The input loop holds a request on the 1st airborne input and asks on the 2nd. A jump clipped by a
 * 2-high ceiling has only 2 airborne inputs: the body is back on the floor before any glide (no jump takeoff
 * there; CLIPPED_GLIDE_DELAY keeps the same one input of plain physics so the search finds that out).
 */
export const GLIDE_DELAY = 1;
export const CLIPPED_GLIDE_DELAY = 1;

export function cloneState(s: Readonly<RouteState>): RouteState {
  return { ...s, pos: { ...s.pos }, vel: { ...s.vel }, boost: { ...s.boost } };
}

/** The distance between two feet positions. */
export const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The horizontal speed. */
export const hspeed = (v: { x: number; z: number }): number => Math.hypot(v.x, v.z);

/** The heading of the velocity as a Bedrock yaw (0 = +z, 90 = -x), or `fallback` when the body is too slow to have one. */
export function headingOf(v: { x: number; z: number }, fallback: number, min = 0.05): number {
  if (hspeed(v) < min) return fallback;
  return (Math.atan2(-v.x, v.z) * 180) / Math.PI;
}

/** A waypoint box around a centre: `half` blocks each way in x / z, `up` blocks of height from `y` (feet). */
export function waypointAt(c: { x: number; y: number; z: number }, half: number, up: number): RouteGoal {
  return { kind: 'waypoint', box: { min: { x: c.x - half, y: c.y, z: c.z - half }, max: { x: c.x + half, y: c.y + up, z: c.z + half } } };
}

export function inBox(b: RegionBox, p: Vec3): boolean {
  return p.x >= b.min.x && p.x < b.max.x && p.y >= b.min.y && p.y < b.max.y && p.z >= b.min.z && p.z < b.max.z;
}

export function boxCentre(b: RegionBox): Vec3 {
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
}

/** The point of a goal the heuristic measures to. */
export function goalPoint(g: RouteGoal): Vec3 {
  return g.kind === 'waypoint' ? boxCentre(g.box) : { x: g.cell.x + 0.5, y: g.top, z: g.cell.z + 0.5 };
}
