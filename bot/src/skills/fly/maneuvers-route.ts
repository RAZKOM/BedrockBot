// Track F1 -> Track F2 (docs/flight.md "Manoeuvres (flight v2, Track F1)": the planner's edges;
// decisions/0057-flight-manoeuvres.md): the manoeuvre library as edges of the route planner. Track F2's
// search (route/types.ts `Maneuver`, route/primitives.ts `edgeOf`) flies an edge's law itself, on its
// tick-exact stepState, and sweeps the box through its grid. What it takes from a manoeuvre is the law
// only:
//
//   applies(s)          may the manoeuvre start from this state
//   control(s, now, i)  the look (and a rocket) of tick i (0-based), from the start s, the state now
//   ticks(s)            the edge's length (at most 40)
//   done(s, now, i)     the exit met after tick i
//
// `asRoute` wraps a library manoeuvre (maneuvers.ts, brake.ts) into that shape, and `routeLibrary` is the
// edge set for a request: the brake landing's settle onto each landing goal, the brake and the hover
// (these replace F2's minimal brake180 / hover / settle), and the turns, snaps, partial brakes and zooms. The
// interfaces below mirror route/types.ts structurally, so the planner takes these as its own Maneuver.
// Nothing here checks the world or estimates an outcome; runManeuver (maneuvers.ts) stays the library's
// own rollout for brain.ts and the tests.
import type { Vec3 } from '../../connection/types.ts';
import { brakeApproach, settleOnto } from './brake.ts';
import { brake180, glideTurn, headingOf, hover, normYaw, partialBrake, snapTurn, speedOf, zoomClimb, type Maneuver, type ManeuverLaw, type ManeuverLook, type ManeuverState } from './maneuvers.ts';

/** The boost left as a range (route/types.ts BoostRange): `nom` is what the planner simulates, `max` what may still burn. */
export interface RouteBoost {
  min: number;
  max: number;
  nom: number;
}

/** The fields of the planner's state (route/types.ts RouteState) a manoeuvre reads. */
export interface RouteStateView {
  pos: Vec3;
  vel: Vec3;
  /** The look yaw of the last tick. */
  yaw: number;
  boost: RouteBoost;
  gliding: boolean;
  /** Ticks of plain falling before the server's glide takes (after a jump): no manoeuvre applies before it. */
  glideIn?: number;
  rockets: number;
}

/** One tick's controls (route/types.ts RouteControl without the takeoff keys). */
export interface RouteLook {
  yaw: number;
  pitch: number;
  fire: boolean;
}

export type RouteFamily = 'glide' | 'turn' | 'rocket' | 'brake' | 'hover' | 'takeoff' | 'maneuver';

/** route/types.ts Maneuver. */
export interface RouteManeuver {
  readonly name: string;
  readonly family: RouteFamily;
  applies(s: Readonly<RouteStateView>): boolean;
  control(s: Readonly<RouteStateView>, now: Readonly<RouteStateView>, i: number): RouteLook;
  ticks(s: Readonly<RouteStateView>): number;
  done?(s: Readonly<RouteStateView>, now: Readonly<RouteStateView>, i: number): boolean;
}

/** The goals a library is built for (route/types.ts RouteGoal; only a landing goal's cell and top are read). */
export type RouteGoalView = { kind: 'waypoint' } | { kind: 'landing'; cell: { x: number; z: number }; top: number; maxSpeed?: number };

/** route/types.ts EDGE_MAX_TICKS: an edge lasts at most this many ticks. */
export const ROUTE_EDGE_MAX_TICKS = 40;

/** The library's state for a planner state (the pitch is the last tick's look, which no law reads but the exit's hold). */
export function maneuverStateOf(s: Readonly<RouteStateView>, pitch = 0): ManeuverState {
  return { pos: s.pos, vel: s.vel, boostTicks: s.boost.nom, yaw: s.yaw, pitch };
}

export interface AsRouteOptions {
  /** The edge's name in the plan's log (default the manoeuvre's). */
  name?: string;
  /** Default 'maneuver'. */
  family?: RouteFamily;
  /** Only while no rocket may burn (boost.max 0): a brake, a hover or a settle that a burn would defeat. */
  quiet?: boolean;
  /** The law fires a rocket: one must be in the hand. */
  rocket?: boolean;
  /** A further condition on the start. */
  when?: (s: Readonly<RouteStateView>) => boolean;
  /** The edge's ticks (default the manoeuvre's cap), at most ROUTE_EDGE_MAX_TICKS. */
  ticks?: number;
}

/**
 * A library manoeuvre as a planner edge. `p` is the parameters, or a function of the start state that gives
 * them (a turn by an offset from the heading). The law is a closure with memory (a zoom remembers it has
 * risen), so the edge keeps one law per start. `control` and `done` must be called in tick order from one
 * start, as edgeOf does. A call with i = 0 or from another start begins the law afresh. `done(s, now, i)`
 * evaluates the law for tick i + 1 and keeps that look for the `control(s, now, i + 1)` that follows, so
 * the law sees every tick exactly once. A law that exits on a tick holds the last look for that tick: the
 * planner stops on `done` before it.
 */
export function asRoute<P extends object>(m: Maneuver<P>, p: P | ((s: Readonly<RouteStateView>) => P), o: AsRouteOptions = {}): RouteManeuver {
  const param = (s: Readonly<RouteStateView>): P => (typeof p === 'function' ? p(s) : p);
  interface Run {
    start: Readonly<RouteStateView>;
    law: ManeuverLaw;
    pitch: number;
    peek?: { now: Readonly<RouteStateView>; i: number; look: ManeuverLook };
  }
  let run: Run | undefined;
  const fresh = (s: Readonly<RouteStateView>): Run => ({ start: s, law: m.law(maneuverStateOf(s), param(s)), pitch: 0 });
  return {
    name: o.name ?? m.name,
    family: o.family ?? 'maneuver',
    applies: (s) => s.gliding && !s.glideIn && (!o.quiet || s.boost.max === 0) && (!o.rocket || s.rockets > 0) && (o.when?.(s) ?? true) && m.entry(maneuverStateOf(s), param(s)) === undefined,
    control(s, now, i) {
      if (i === 0 || run?.start !== s) run = fresh(s);
      const r = run;
      const look = r.peek?.now === now && r.peek.i === i ? r.peek.look : r.law(maneuverStateOf(now, r.pitch), i + 1);
      delete r.peek;
      if (look.done) return { yaw: now.yaw, pitch: r.pitch, fire: false };
      r.pitch = look.pitch;
      return { yaw: look.yaw, pitch: look.pitch, fire: look.fire === true };
    },
    ticks: (s) => Math.min(ROUTE_EDGE_MAX_TICKS, Math.max(1, o.ticks ?? m.maxTicks(param(s)))),
    done(s, now, i) {
      if (run?.start !== s) return false;
      const look = run.law(maneuverStateOf(now, run.pitch), i + 2);
      run.peek = { now, i: i + 1, look };
      return look.done === true;
    },
  };
}

/** The settle onto a landing goal's cell (brake.ts settleOnto: brake over it, creep, sink at `pitchE`), one edge of up to 40 ticks; the planner chains it until the touchdown. */
export function settleRoute(g: { cell: { x: number; z: number }; top: number }, pitchE = 0): RouteManeuver {
  return asRoute(settleOnto, { at: { x: g.cell.x + 0.5, z: g.cell.z + 0.5 }, top: g.top, pitchE }, { name: `settle${pitchE ? `+${pitchE}` : ''}`, quiet: true, ticks: ROUTE_EDGE_MAX_TICKS });
}

/** approachRoute applies within this of the cell (two or three 40-tick edges at about 1 a tick). */
export const APPROACH_NEAR = 48;

/** The brake landing onto a goal's cell in one law (brake.ts brakeApproach: in at `pitchA`, the brake `brakeAt` before the centre, then the settle), from up to APPROACH_NEAR out. */
export function approachRoute(g: { cell: { x: number; z: number }; top: number }, pitchA: number, brakeAt: number): RouteManeuver {
  const at = { x: g.cell.x + 0.5, z: g.cell.z + 0.5 };
  const name = `approach${pitchA ? (pitchA > 0 ? '+' : '') + String(pitchA) : ''}/${String(brakeAt)}`;
  return asRoute(brakeApproach, { at, top: g.top, pitchA, brakeAt }, { name, quiet: true, when: (s) => Math.hypot(s.pos.x - at.x, s.pos.z - at.z) <= APPROACH_NEAR, ticks: ROUTE_EDGE_MAX_TICKS });
}

/** The approaches routeLibrary offers per landing goal: [pitchA, brakeAt] (a slight pull that holds the height over a rim, level, a slight dive; the brake 4 or 8 out). */
export const APPROACHES: readonly (readonly [number, number])[] = [
  [-10, 4],
  [0, 4],
  [0, 8],
  [10, 4],
  [10, 8],
];

const side = (offset: number): string => (offset < 0 ? 'L' : 'R');
const fast = (min: number) => (s: Readonly<RouteStateView>): boolean => speedOf(s.vel) >= min;

/**
 * The edge set for a request (search.ts `library`).
 * - For each landing goal:
 *   - the settle onto its cell at pitch 0 and 20. They sink 0.149 and 0.225 a tick, under the planner's
 *     0.3 touchdown;
 *   - the brake landing's approaches (APPROACHES), from up to 48 out.
 * - The brake180, holding the height and at pitch 0.
 * - The hover (station keeping in place, 4 ticks).
 * - With `extras` (default true): the partial brakes (140 and 160, both sides), the powered snaps (45 and 90,
 *   both sides, a rocket), the glide turns (45 and 90 at radius 20) and the zooms (-30 and -45).
 */
export function routeLibrary(goals: readonly RouteGoalView[] = [], o: { extras?: boolean } = {}): RouteManeuver[] {
  const out: RouteManeuver[] = [];
  for (const g of goals) {
    if (g.kind !== 'landing') continue;
    for (const pitchE of [0, 20]) out.push(settleRoute(g, pitchE));
    for (const [pitchA, brakeAt] of APPROACHES) out.push(approachRoute(g, pitchA, brakeAt));
  }
  out.push(asRoute(brake180, {}, { name: 'brake180', quiet: true, when: fast(0.5) }));
  out.push(asRoute(brake180, { pitch: 0 }, { name: 'brake180+0', quiet: true, when: fast(0.5) }));
  out.push(asRoute(hover, { ticks: 4 }, { name: 'hover', quiet: true, when: (s) => speedOf(s.vel) < 0.35, ticks: 4 }));
  if (o.extras === false) return out;
  for (const off of [140, 160]) for (const dir of [-1, 1] as const) out.push(asRoute(partialBrake, { offset: off, side: dir }, { name: `brake${off}${side(dir)}`, quiet: true, when: fast(0.5) }));
  for (const off of [-90, -45, 45, 90]) out.push(asRoute(snapTurn, (s) => ({ heading: normYaw(headingOf(s.vel, s.yaw) + off), fire: true }), { name: `snap${Math.abs(off)}${side(off)}`, quiet: true, rocket: true }));
  for (const off of [-90, -45, 45, 90]) out.push(asRoute(glideTurn, (s) => ({ heading: normYaw(headingOf(s.vel, s.yaw) + off), radius: 20 }), { name: `glideTurn${Math.abs(off)}${side(off)}` }));
  for (const pitch of [-30, -45]) out.push(asRoute(zoomClimb, { pitch, ticks: ROUTE_EDGE_MAX_TICKS }, { name: `zoom${pitch}` }));
  return out;
}
