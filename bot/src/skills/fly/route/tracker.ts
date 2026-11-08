// Track F2: the per-tick tracker that flies a route plan (docs/flight.md "Route planner", "The tracker").
//
// Every tick the real body (the loop's state, or stepBody's in the benchmark) is matched to the plan's
// reference state nearest in time, and the next control is re-optimised around the plan's over a short
// horizon: the plan's control and small yaw / pitch perturbations are each flown for HORIZON ticks on the
// glide formula followed by the plan's controls, scored by the distance to the reference path and a hit
// penalty, and the best first tick is flown (the landing planner's style: re-optimise from the real state,
// fly the first tick). A new plan is asked for from the real state when the body is more than `replanError`
// off the reference, when the corridor of the next LOOKAHEAD plan ticks is blocked in the grid (newly loaded
// chunks, a changed block), when a correction moved the body, or when the plan runs out. The old plan is
// flown meanwhile (the planner may answer later, from a worker); with no plan at all the body holds a level
// glide along its heading, or steers clear (the evade rule) when that glide would hit. A rocket goes only on
// a plan being tracked whose clearance is PLAN_CLEAR_MIN or more: never without a plan, never on one that
// grazes a solid (a Realm cave death flew powered on such plans), so the glide bleeds its speed instead.
import type { Vec3 } from '../../../connection/types.ts';
import { glideVelocity } from '../../input/physics.ts';
import { keepYaw } from '../maneuvers.ts';
import { sweep, type RouteGrid } from './grid.ts';
import { crossesFloor, inBurnTail, landsOn, passes, replayBurns, stepState, sweepGridFor } from './primitives.ts';
import { startMarginFor } from './search.ts';
import { BURN, NO_BOOST, burnTick, cloneState, freshBurn, headingOf, hspeed, landingCells, type BoostRange, type PrimitiveFamily, type RouteControl, type RouteGoal, type RoutePlan, type RouteRequest, type RouteState } from './types.ts';

/** Ticks of the plan ahead of the body checked against the grid every tick. */
export const LOOKAHEAD = 20;
/** The re-optimisation horizon (ticks). */
export const HORIZON = 8;
/** The distance from the reference that asks for a new plan (blocks). */
export const REPLAN_ERROR = 1.0;
const YAW_STEPS = [0, -4, 4, -8, 8, -16, 16];
const PITCH_STEPS = [0, -6, 6, -12, 12];
/** Track F7 (tube): the wider offsets, held over the horizon, tried only when the plan's own best control collides. */
const WIDE_YAWS = [-25, 25, -35, 35, -50, 50, -70, 70];
const WIDE_PITCHES = [0, -20, 20];
const HIT_PENALTY = 1000;
/** Track F4a: the held candidates while the burn's end is unknown and the plan's tail hits for one of its ends (offsets from the heading; pitches). */
const HOLD_YAWS = [0, -15, 15, -30, 30, -50, 50, -90, 90];
const HOLD_PITCHES = [-20, 0, 15, 35];
/** Consecutive ticks without any plan (every answer empty) before the tracker gives up. */
const PLANLESS_MAX = 40;
/**
 * The least plan clearance (blocks) a rocket is fired on. A plan made with the request's margin clears every solid
 * by more than it (0.1 to 0.3); one under this was asked for from a body already within the margin of a solid (its
 * first edges swept on half the body's real clearance, `startMarginFor`): the log's "clearance 0.00". Flying it
 * powered is how the bot died in a Realm cave (partial plans at clearance 0, 6.5 and 2.8 of wall damage).
 */
export const PLAN_CLEAR_MIN = 0.05;

/**
 * Track F5b (docs/flight.md "Cave flight"): the cave style's rules on the tracker, all off by default (the open-air
 * drivers and the courses fly as before). A cave is flown in short committed pieces: a rocket only where the plan
 * is cleared far enough ahead to stop in, never on top of speed, and a body left without a plan stops and comes down
 * rather than gliding on into what no plan has swept.
 */
export interface TrackerRules {
  /**
   * The commit horizon (ticks; the 180 brake stops the body in about 10 ticks and 5 blocks): a partial plan is asked
   * again this far before its end, and a partial plan shorter than it counts as "the planner is not sure" (partialStop).
   */
  commitTicks?: number;
  /**
   * No rocket on a partial plan whose remainder from the body's index is under `commitTicks`. Measured harmful on the
   * cave set (a plan's rocket is its turn: refused, the body leaves the plan and hits the wall it was turning from), so
   * the cave style leaves it off; kept for the record.
   */
  refuseUncommitted?: boolean;
  /** No rocket while the body's horizontal speed is at or over this (blocks a tick). Measured harmful like refuseUncommitted; off in the style. */
  fireSpeedMax?: number;
  /**
   * Bail out after this many consecutive gliding ticks without a plan being tracked (the hold or the evade rule flying):
   * the 180 brake at the pitch that stays clear longest, then the hover's sink to whatever floor is under the body
   * (`status` 'bailing'; the driver sees the ground). No more plans are asked for once it begins. Undefined: never.
   */
  bailAfter?: number;
  /**
   * A planner that is not sure stops the body: a new plan is asked for `commitTicks` before a partial plan's end (not
   * only when it runs out), and when SHORT_PARTIALS partial plans in a row come back shorter than `commitTicks` for
   * a gliding body (the search cannot see even the stopping distance ahead), the tracker bails out. The Realm cave's
   * partial plans ran out into walls at speed, re-planned every few ticks; this lands the body instead.
   */
  partialStop?: boolean;
  /**
   * Fly complete plans only: a partial answer while a complete plan is being tracked is ignored (the plan was proven
   * from the takeoff; the horizon's re-optimisation absorbs the drift), and when that complete plan's corridor ahead is
   * blocked (a chunk loaded, a correction) and the answer is partial, the tracker bails out rather than fly it.
   */
  completeOnly?: boolean;
  /**
   * A re-plan in flight is asked from the plan's reference state this many ticks ahead of the body (the worker's
   * latency: 12 ticks for 600 ms), not from the body now: the answer then meets the body where it is, as F4a's `lead`
   * does for the first plan. Asked from the body now, the answer was for a state 12 ticks old, 15 blocks behind
   * a body that had meanwhile left the old plan, and the tracker turned round to chase it.
   */
  replanLead?: number;
  /** Bail out when the body is this far off its reference (blocks) and no fresh plan has come: the brake, not a chase. */
  bailError?: number;
  /**
   * Track F6: the plan's reference states are re-timed to the burn read off the body (`retime`): a burn that ended early
   * or runs on past the nominal re-flies the plan's controls with that burn, so the body is tracked against where its
   * controls really take it instead of a reference it left (F5b's hits: 1 to 1.5 off a proven plan under a burn other than
   * the plan's nominal, before `bailError` fired).
   */
  retime?: boolean;
  /**
   * Track F7: the tube controller (docs/flight.md "Tight passages"). The body is matched to the plan by POSITION (up to
   * LOCATE_AHEAD ticks ahead of the time index, never behind the last match: a burn longer or shorter than the plan's
   * nominal shifts the body along the path, not off it), the horizon's tracking cost is the distance to the nearest point
   * of the reference path (not the point at the same tick), the candidates hold a yaw or pitch offset over the whole
   * horizon besides the first tick (a sustained correction), a re-timed reference is adopted also where the plan's
   * controls would hit (the hazard asks for a plan; the horizon steers), and the body's own forecast decides the
   * bail-out: when the best control still collides within the commit horizon, the brake begins now (a brake 3 ticks
   * before a wall halves the hit; the bail at `bailError` came after the drift, at the wall).
   */
  tube?: boolean;
  /**
   * Track F7: a complete plan whose corridor is blocked ahead (`completeOnly`) and whose re-plan comes back partial bails out
   * (F5b's rule; default true). With the tube the body's own forecast guards every tick, so the style measures the rule off:
   * the partial answer is ignored and the body flies on while its forecast is clear.
   */
  blockedBail?: boolean;
}

/** Track F7: the plan states the body may be matched to ahead of the time index (ticks), and the reference points round the matched tick the tracking cost measures to. */
export const LOCATE_AHEAD = 8;
export const TRACK_SLACK = 3;

/** Track F5b: the brake's pitches tried at a bail-out (the envelope: -30 holds the height over the 10 ticks, 0 loses 1.2). */
const BAIL_PITCHES = [-30, -15, 0, 15];
/** Track F5b: this many partial plans in a row under `commitTicks` long (`partialStop`) bail the body out, when the body has at least SHORT_PARTIAL_SPEED (blocks a tick). */
export const SHORT_PARTIALS = 2;
export const SHORT_PARTIAL_SPEED = 0.5;
/** Under this horizontal speed the bail-out sinks (the hover flip). */
const BAIL_SLOW = 0.3;
/** Track F7 (tube): ticks in a row over `bailError` before the bail-out. */
export const LOST_TICKS = 3;
/** Track F7 (tube): the ticks no candidate may keep clear for, should the burn end now, before the bail-out. */
export const END_FORECAST = 5;
/** Track F7 (tube): a plan asked from ahead whose start is farther than this from the body when it is due is dropped (blocks). */
export const NEXT_PLAN_FAR = 1.5;
/** Track F7 (tube): the closed-loop settle: within this of the landing cell (blocks, horizontal) and under this speed the tracker flies the station keeping onto the cell itself. */
export const SETTLE_LOOP_NEAR = 4;
export const SETTLE_LOOP_SPEED = 0.5;
/** Track F7: the closed-loop settle's phases: over this speed the brake holds the height (pitch -30), farther than this from the cell the creep looks at it nose up (pitch -15: 0.4 a tick for 0.07 of sink), else the station keeping's flip sinks (0.149). */
const SETTLE_BRAKE_SPEED = 0.35;
const SETTLE_CREEP_FROM = 0.6;

/**
 * Track F7 (tube): the landing's last blocks flown from the real state (brake.ts keepLook's phases, the creep nose up): a
 * body stopped 1.6 blocks short of its cell at 0.6 over it sank into the pool beside the cell under the station keeping's
 * flip alone (0.3 a tick at most, 0.149 of sink).
 */
export function settleControl(cur: Readonly<RouteState>, at: { x: number; z: number }): RouteControl {
  const h = hspeed(cur.vel);
  const d = Math.hypot(at.x - cur.pos.x, at.z - cur.pos.z);
  if (h > SETTLE_BRAKE_SPEED) return { yaw: keepYaw(cur, at), pitch: -30, fire: false };
  if (d > SETTLE_CREEP_FROM) return { yaw: (Math.atan2(-(at.x - cur.pos.x), at.z - cur.pos.z) * 180) / Math.PI, pitch: -15, fire: false };
  return { yaw: keepYaw(cur, at), pitch: 0, fire: false };
}
/** Track F7: the sink looks for a dry floor this many cells round the body's column, this far down, and chooses again every SINK_RETARGET ticks. */
export const SINK_REACH = 3;
export const SINK_DEPTH = 16;
const SINK_RETARGET = 8;

export interface TrackerBody {
  pos: Vec3;
  vel: Vec3;
  gliding: boolean;
  onGround: boolean;
  rockets: number;
}

export type Planner = (req: RouteRequest) => RoutePlan | Promise<RoutePlan>;

export interface TrackerOptions {
  grid: RouteGrid;
  margin: number;
  goals: RouteGoal[];
  plan: Planner;
  maxNodes: number;
  maxMs: number;
  stackRockets?: boolean;
  families?: readonly PrimitiveFamily[];
  rocketCost?: number;
  riskCost?: number;
  edgeTicks?: number;
  replanError?: number;
  /** The initial look yaw (a standing body has no heading). */
  yaw?: number;
  note?: (msg: string) => void;
  /** Track F3: the heuristic's weight and the edge set by name (RouteRequest.weight / .library) of every request. */
  weight?: number;
  library?: RouteRequest['library'];
  /**
   * Track F4a: ticks ahead the first plan of a gliding body is asked for (a worker answers some ticks after the
   * ask): the plan starts at the state the hold reaches then and the hold flies until then, so the plan meets the
   * body where it is. 0 (the default): the plan starts at the body now and meets it wherever the hold took it
   * (the e2e's courses started in the air at 0.3 a tick and fell off every first plan).
   */
  lead?: number;
  /** Track F5b: the cave style's rules (default none: the tracker flies as Track F4a left it). */
  rules?: TrackerRules;
  /**
   * Track F7: a cell the body may stand on (the real solids; the grid has water as solid too). With it the bail-out's sink
   * creeps onto the nearest dry floor within SINK_REACH (the hover's station keeping, maneuvers.ts keepYaw) instead of
   * coming down wherever it stopped: on the owner's cave half the bail-outs sank into the pools, and a body in a pool has
   * no takeoff (ADR 0068), so the next window was walked.
   */
  floor?: (x: number, y: number, z: number) => boolean | undefined;
  /** Track F6: every request's heuristic measures through the air (RouteRequest.geodesic), and the search's pieces (RouteRequest.pieces). */
  geodesic?: boolean;
  pieces?: number;
}

export type TrackerStatus = 'planning' | 'tracking' | 'holding' | 'bailing' | 'done' | 'failed';

export interface TrackerOutput {
  control: RouteControl;
  status: TrackerStatus;
  /** All goals passed by the real body. */
  done: boolean;
  /** A new plan was asked for this tick, and why. */
  replan?: string;
  /** The distance from the reference this tick. */
  error: number;
  /** Track F7: what the tracker saw this tick (the benches' traces): the reference matched, the plan's own control, the burn believed. */
  debug?: TrackerDebug;
}

export interface TrackerDebug {
  ref: Vec3;
  /** The plan index matched and the plan's length. */
  cursor: number;
  len: number;
  belief: BoostRange;
  /** The plan's reference boost at the match (nominal ticks left). */
  refBoost: number;
  planned?: RouteControl;
  complete?: boolean;
  /** Track F7: the landing flown closed loop this tick. */
  settle?: boolean;
  /** The plan's goals (its own list) and where its last state is. */
  goals?: number;
  end?: Vec3;
}

export interface TrackerStats {
  plans: number;
  replans: number;
  planMs: number;
  /** The plans that came back incomplete. */
  partial: number;
  fired: number;
  corrections: number;
  holdTicks: number;
  /** Ticks flown by the evade rule (no plan had an edge from the body's state). */
  evadeTicks: number;
  /** Burn ends (or extensions) read off the body's velocity before the server's notice. */
  burnsRead: number;
  maxError: number;
  /** The ticks the tracker ran. */
  ticks: number;
  /** Rockets not fired: asked for with no plan being tracked, or on a plan under PLAN_CLEAR_MIN. */
  refused?: number;
  /** Track F5b (completeOnly): partial answers ignored while a complete plan was flown. */
  partialIgnored?: number;
  /** Track F5b: rockets not fired by the cave rules (a partial plan short of the commit horizon, the body over the speed cap). */
  uncommitted?: number;
  /** Track F5b: ticks flown by the bail-out (the brake and the sink). */
  bailTicks?: number;
  /** Track F6: the plan's reference re-timed to a burn read off the body (`retime`). */
  retimed?: number;
  /** Track F7 (tube): ticks the landing was flown closed loop (the station keeping onto the cell), and plans asked from ahead dropped for starting far from the body. */
  settleTicks?: number;
  dropped?: number;
  /** Track F7 (tube): ticks a wider held offset was flown because the plan's own control collided, and bail-outs for no control keeping clear should the burn end now. */
  wide?: number;
  endBails?: number;
  /** Track F7 (tube): ticks a candidate clear both with and without the boost was flown instead of the plan's best, which met a wall should the burn end now. */
  endSaves?: number;
  /** The first plan's effort. */
  first?: { nodes: number; expanded: number; ms: number; ticks: number; rockets: number; complete: boolean; robust: boolean; clearance: number };
}

export class RouteTracker {
  private plan: RoutePlan | undefined;
  private planStart: RouteState | undefined;
  /** The goals the current plan was made for (the ones left at its request) and the goals passed before it. */
  private planGoals: RouteGoal[] = [];
  private planWp0 = 0;
  /** The tick the current plan's start state is at. */
  private planTick = 0;
  private cursor = -1;
  private pending = false;
  private boost: BoostRange = { ...NO_BOOST };
  private wp = 0;
  private lastPos: Vec3 | undefined;
  private lastVel: Vec3 | undefined;
  private yaw: number;
  private corrected = false;
  private changed = false;
  private burnEnded = false;
  /** Consecutive ticks without a plan after an empty answer. */
  private planless = 0;
  private failed: string | undefined;
  private lastControl: RouteControl | undefined;
  /**
   * Track F3: a rocket the plan asked for on a tick the body was not gliding yet (the server starts a glide a
   * tick or two after the model: F2's measurement): used on the first gliding tick instead of never.
   */
  private fireLater = false;
  /** Track F4a: the last optimise found the plan's tail hitting for an end of the running burn (asks for a re-plan once a burn). */
  private burnUnsafe = false;
  private burnReplanned = false;
  /** Track F4a: the belief before the last rocket asked for (a stacked rocket the driver held leaves the running burn). */
  private boostBefore: BoostRange = { ...NO_BOOST };
  /** Track F4a: the plan whose control `flownNext` the last tracking tick flew (a skipped rocket is fired late). */
  private flownPlan: RoutePlan | undefined;
  private flownNext = -1;
  /** The plan (null: none) the last refused rocket was noted for (one note each). */
  private refusedFor: RoutePlan | null | undefined;
  /** Track F5b: consecutive gliding ticks without a plan being tracked, and the bail-out's phase once it began. */
  private planlessGliding = 0;
  private bail: 'brake' | 'sink' | undefined;
  /** Track F7: the dry cell the sink creeps onto (undefined: none found, the hover sinks straight down), and when it was chosen. */
  private sinkAt: { x: number; z: number; dry: boolean } | undefined;
  private sinkChosen = -1000;
  /** The tick of the last `tick` call (a plan adopted between ticks is placed against it). */
  private now = 0;
  /** Track F5b: partial plans in a row adopted for a gliding body that were shorter than the commit horizon. */
  private shortPartials = 0;
  /** Track F5b (completeOnly): the complete plan being flown is blocked ahead: only a complete answer may replace it, a partial one bails. */
  private needComplete = false;
  /** Track F5b (replanLead): a plan asked from ahead that starts later than now: the old plan is flown until its start tick. */
  private nextPlan: { p: RoutePlan; start: RouteState; goals: RouteGoal[]; wp0: number; at: number } | undefined;
  /** Track F6 (retime): the tick the burning rocket was fired at (the belief's fresh burn), undefined when none burns. */
  private firedAt: number | undefined;
  /** Track F6: the plan's controls under the burn read off the body hit at this index (the reference kept nominal), -1 when clear. */
  private burnHazard = -1;
  /** Track F6: the belief's nominal ticks left when the last control was flown (the step `readBoost` judges was boosted iff this was over 0). */
  private nomBefore = 0;
  /** Track F7 (tube): the tick of the horizon the body's own forecast on the control chosen collides at (-1: clear), and whether every candidate hit the margin. */
  private forecastHit = -1;
  private forecastUnsafe = false;
  private forecastReplanned = false;
  /** Track F7 (tube): the plan under the burn read was asked for once for the current hazard. */
  private hazardAsked = false;
  /**
   * Track F7: the burns read so far for the plan's rockets, in fire order (`retime` re-flies the plan with all of them: before,
   * each re-timing gave the rockets read earlier their nominal back, and the reference jumped 1.5 off a body tracking at 0.00
   * when a window's second rocket ended early).
   */
  private burnsRead: number[] = [];
  /** Track F7 (tube): the forecast's collision speed (blocks a tick) on the control chosen, when it collides. */
  private forecastSpeed = 0;
  /** Track F7 (tube): ticks in a row the body has been over `bailError` off its reference. */
  private lostTicks = 0;
  readonly stats: TrackerStats = { plans: 0, replans: 0, planMs: 0, partial: 0, fired: 0, corrections: 0, holdTicks: 0, evadeTicks: 0, burnsRead: 0, maxError: 0, ticks: 0 };

  private readonly o: TrackerOptions;

  constructor(o: TrackerOptions) {
    this.o = o;
    this.yaw = o.yaw ?? 0;
  }

  get current(): RoutePlan | undefined {
    return this.plan;
  }

  /** Goals passed by the real body so far. */
  get reached(): number {
    return this.wp;
  }

  get boostRange(): Readonly<BoostRange> {
    return this.boost;
  }

  /** Track F5b: the bail-out has begun (the brake, then the sink); the tracker flies nothing else from here. */
  get bailing(): boolean {
    return this.bail !== undefined;
  }

  /**
   * Track F5b: the bail-out's control. The 180 brake while the body still has speed, at the pitch of BAIL_PITCHES that
   * sweeps clear (no margin) the longest over the horizon, then the hover flip (the elevator descent, 0.149 a tick)
   * until the floor.
   */
  private bailControl(cur: RouteState, now: number): RouteControl {
    this.stats.bailTicks = (this.stats.bailTicks ?? 0) + 1;
    if (this.bail === 'brake' && hspeed(cur.vel) < BAIL_SLOW) this.bail = 'sink';
    if (this.bail === 'sink') {
      // Track F7: onto a dry floor when one is within reach (the station keeping's creep: a look towards the cell while
      // off it, the flip over it), else the hover's sink where the body is
      if (this.o.floor && now - this.sinkChosen >= SINK_RETARGET) {
        this.sinkAt = this.sinkTarget(cur);
        this.sinkChosen = now;
        if (this.sinkAt && !this.sinkAt.dry) this.o.note?.('route: the bail-out sinks onto water: no dry floor within reach');
        else if (this.sinkAt && (Math.abs(this.sinkAt.x + 0.5 - cur.pos.x) > 0.6 || Math.abs(this.sinkAt.z + 0.5 - cur.pos.z) > 0.6)) this.o.note?.(`route: the bail-out creeps onto the dry cell ${this.sinkAt.x} ${this.sinkAt.z}`);
      }
      const at = this.sinkAt;
      if (at?.dry) {
        const d = Math.hypot(at.x + 0.5 - cur.pos.x, at.z + 0.5 - cur.pos.z);
        // (the settle's phases: the nose-up creep while off the cell, 0.4 a tick for 0.07 of sink, the flip over it)
        if (d > 0.25 || hspeed(cur.vel) > 0.08) return settleControl(cur, { x: at.x + 0.5, z: at.z + 0.5 });
      }
      return { yaw: cur.yaw + (now & 1 ? 180 : 0), pitch: 0, fire: false };
    }
    const h = headingOf(cur.vel, cur.yaw);
    let best: RouteControl = { yaw: h + 180, pitch: BAIL_PITCHES[0]!, fire: false };
    let bestScore = -Infinity;
    for (const pitch of BAIL_PITCHES) {
      const c: RouteControl = { yaw: h + 180, pitch, fire: false };
      let s = cur;
      let score = 0;
      for (let t = 0; t < HORIZON; t++) {
        const r = stepState(s, c, false);
        const sw = sweep(this.o.grid, s.pos, r.next.pos, 0);
        if (sw.hit) {
          score -= HORIZON - t;
          break;
        }
        score += sw.clearance;
        s = r.next;
      }
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  /**
   * Track F7: the cell the sink aims at: the column under the body when its first solid is a floor (dry), else the nearest
   * column within SINK_REACH whose first solid under the body's height is a floor, with air at the body's height and all the
   * way down (the creep must not cross a wall). The body's own column when nothing dry is in reach (`dry` false).
   */
  private sinkTarget(cur: RouteState): { x: number; z: number; dry: boolean } | undefined {
    const floor = this.o.floor;
    if (!floor) return undefined;
    const grid = this.o.grid;
    const cx = Math.floor(cur.pos.x);
    const cz = Math.floor(cur.pos.z);
    const feet = Math.floor(cur.pos.y + 1e-6);
    /** The first solid under `feet` in the column, whether it is dry, or undefined when none within SINK_DEPTH. */
    const under = (x: number, z: number): { y: number; dry: boolean } | undefined => {
      for (let y = feet; y >= feet - SINK_DEPTH; y--) {
        if (grid.solid(x, y, z)) return { y, dry: floor(x, y, z) === true };
      }
      return undefined;
    };
    const own = under(cx, cz);
    if (own?.dry) return { x: cx, z: cz, dry: true };
    let best: { x: number; z: number; d: number } | undefined;
    for (let dx = -SINK_REACH; dx <= SINK_REACH; dx++) {
      for (let dz = -SINK_REACH; dz <= SINK_REACH; dz++) {
        if (!dx && !dz) continue;
        const x = cx + dx;
        const z = cz + dz;
        // room for the box at the body's height, and the way down clear
        if (grid.solid(x, feet, z) || grid.solid(x, feet + 1, z)) continue;
        const u = under(x, z);
        if (!u?.dry) continue;
        // (a cell no deeper than a short fall under the body: the creep is slow, the sink is not)
        if (feet - u.y > 6) continue;
        const d = Math.hypot(x + 0.5 - cur.pos.x, z + 0.5 - cur.pos.z);
        if (!best || d < best.d) best = { x, z, d };
      }
    }
    if (best) return { x: best.x, z: best.z, dry: true };
    return own ? { x: cx, z: cz, dry: false } : undefined;
  }

  /**
   * Track F7 (tube): the landing cell's centre when the body is to settle onto it closed loop: the next goal is the landing,
   * no burn may run, the body is slow, above the cell and within SETTLE_LOOP_NEAR of it.
   */
  private settleCell(cur: RouteState): { x: number; z: number } | undefined {
    const g = this.o.goals[this.wp];
    if (g?.kind !== 'landing' || !cur.gliding || cur.boost.max > 0 || hspeed(cur.vel) >= SETTLE_LOOP_SPEED) return undefined;
    const at = { x: g.cell.x + 0.5, z: g.cell.z + 0.5 };
    if (cur.pos.y <= g.top || Math.hypot(cur.pos.x - at.x, cur.pos.z - at.z) > SETTLE_LOOP_NEAR) return undefined;
    return at;
  }

  /** The loop replayed a server correction: the body moved. */
  noteCorrection(): void {
    this.corrected = true;
    this.stats.corrections++;
  }

  /** Cells changed (a chunk loaded, a block set): the corridor is checked again. */
  noteWorldChange(): void {
    this.changed = true;
  }

  /** The server removed the burning rocket (its end is known now): the plan assumed the nominal burn, so it is asked for again. */
  rocketEnded(): void {
    // (Track F6: the notice comes about 3 ticks after the end; the body's velocity already told the tracker and re-timed the plan)
    this.boost = { ...NO_BOOST };
    this.burnEnded = true;
    this.firedAt = undefined;
  }

  /**
   * Track F6 (`rules.retime`): the plan's reference states re-flown with the burn read off the body: `burn` ticks for the
   * rocket fired at `firedAt` (the plan's own rocket at that tick, or the burn the plan started under), every other rocket
   * nominal. The controls are unchanged; `locate`, the horizon's tracking cost and `replanLead` then read where the plan's
   * controls take a body under this burn. A rocket fired outside the plan (a hold's late rocket) leaves it alone.
   */
  private retime(burn: number, now: number): void {
    const p = this.plan;
    const F = this.firedAt;
    if (!p || F === undefined || !this.planStart || !this.o.rules?.retime) return;
    const stack = this.o.stackRockets === true;
    this.burnHazard = -1;
    let states: RouteState[];
    if (F >= this.planTick) {
      // the plan's own rocket, control index F - planTick: the k-th fired
      const idx = F - this.planTick;
      if (idx >= p.controls.length || !p.controls[idx]!.fire) return;
      let k = 0;
      for (let i = 0; i < idx; i++) if (p.controls[i]!.fire) k++;
      this.burnsRead[k] = burn;
      states = replayBurns(this.planStart, p.controls, this.planGoals, this.burnsRead, stack);
    } else {
      // the burn was running when the plan started: the ticks of it left at the plan's first control
      const left = Math.max(0, F + burn - this.planTick);
      if (left === this.planStart.boost.nom) return;
      const start: RouteState = { ...cloneState(this.planStart), boost: { ...this.planStart.boost, nom: left } };
      states = replayBurns(start, p.controls, this.planGoals, this.burnsRead, stack);
    }
    if (states.length !== p.states.length) return;
    // the plan's controls under this burn must still clear the walls ahead: the plan was proven for the burn's extremes
    // only (the branches), and a burn between them can carry the body into a wall the nominal path misses (tight-107
    // at burn 12: the re-timed reference ran into the wall 3 ticks on and the body followed it, 12 of damage). A
    // reference that hits is not adopted: the body keeps the nominal, which is clear, and the hazard asks for a complete
    // plan or the bail-out (tick: `burnHazard`)
    // (judged on PLAN_CLEAR_MIN, a collision course, not the margin: the plan keeps the margin at the burn's extremes by construction and a
    // burn between them grazes it in a clean bore without touching anything)
    const hit = this.firstBlocked(Math.max(0, this.cursor), states, PLAN_CLEAR_MIN);
    if (hit >= 0) {
      if (this.burnHazard !== hit) this.hazardAsked = false;
      this.burnHazard = hit;
      if (!this.o.rules?.tube) {
        this.changed = true;
        this.o.note?.(`route: the plan's controls under a burn of ${burn} ticks hit at tick ${hit + 1} of ${states.length}: the reference stays nominal`);
        return;
      }
      // Track F7 (tube): the re-timed reference is where the body is; it is adopted, the hazard asks for a plan (tick) and the
      // horizon steers round it from the body's real state (kept nominal, the reference ran away from the body and the error
      // bail stopped the body, in the open, for a wall it was not going to hit: 5 of 5 bail-outs of a tight-107 trip)
      this.o.note?.(`route: the plan's controls under a burn of ${burn} ticks hit at tick ${hit + 1} of ${states.length}: the reference re-timed, a plan asked`);
    }
    p.states = states;
    this.changed = true; // (the corridor ahead is checked again on the new reference)
    this.stats.retimed = (this.stats.retimed ?? 0) + 1;
    this.o.note?.(`route: the plan's reference re-timed to a burn of ${burn} ticks (fired at tick ${F}, now ${now})`);
  }

  /** Track F3: a rocket of the flight already burns when the tracker takes the body over: `ticks` expected left (the loop's `boostTicks`), up to BURN.max - BURN.nominal more. */
  seedBoost(ticks: number): void {
    if (ticks <= 0) return;
    this.boost = { min: Math.max(1, ticks - 3), max: ticks + (BURN.max - BURN.nominal), nom: ticks };
  }

  /**
   * No plan has an edge from here (the body is within the margin of a solid): the control that keeps the
   * body clear of a hit the longest over the horizon with no margin, while the planner is asked every tick.
   */
  private evade(cur: RouteState): RouteControl {
    const h = headingOf(cur.vel, cur.yaw);
    let best: RouteControl = { yaw: h, pitch: 0, fire: false };
    let bestScore = -Infinity;
    for (const dy of [0, -15, 15, -30, 30, -45, 45, -90, 90, 180]) {
      for (const pitch of [-20, 0, 20]) {
        const c: RouteControl = { yaw: h + dy, pitch, fire: false };
        let s = cur;
        let score = 0;
        for (let t = 0; t < HORIZON; t++) {
          const r = stepState(s, c, false);
          const sw = sweep(this.o.grid, s.pos, r.next.pos, 0);
          if (sw.hit) {
            score -= HORIZON - t;
            break;
          }
          score += sw.clearance;
          s = r.next;
        }
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    this.stats.evadeTicks++;
    return best;
  }

  /** The route state of the real body now (the remaining goals: wp 0). */
  stateOf(b: TrackerBody): RouteState {
    return { pos: { ...b.pos }, vel: { ...b.vel }, yaw: this.yaw, boost: { ...this.boost }, gliding: b.gliding, rockets: b.rockets, wp: 0 };
  }

  private remainingGoals(): RouteGoal[] {
    return this.o.goals.slice(this.wp);
  }

  private request(b: TrackerBody, now: number, why: string): void {
    if (this.pending || this.bail) return;
    let start = this.stateOf(b);
    // Track F4a: the first plan of a gliding body from where the hold takes it in `lead` ticks (TrackerOptions.lead)
    const lead = !this.plan && b.gliding ? Math.max(0, this.o.lead ?? 0) : 0;
    for (let k = 0, yaw = this.yaw; k < lead; k++) {
      yaw = headingOf(start.vel, yaw);
      start = stepState(start, { yaw, pitch: 0, fire: false }, false).next;
    }
    let at = now + lead;
    let wp0 = this.wp;
    let goals = this.remainingGoals();
    // Track F5b (replanLead): a re-plan in flight from the plan's reference `replanLead` ticks ahead of the body
    const rl = this.o.rules?.replanLead ?? 0;
    if (this.plan && b.gliding && rl > 0 && this.cursor >= 0 && this.cursor < this.plan.states.length - 1) {
      const p = this.plan;
      const j = Math.min(p.states.length - 1, this.cursor + rl);
      const ref = p.states[j]!;
      let used = 0;
      for (let k = this.cursor + 1; k <= j; k++) if (p.controls[k]?.fire) used++;
      wp0 = this.planWp0 + ref.wp;
      goals = this.o.goals.slice(wp0);
      if (goals.length === 0) return; // the plan's rest passes every goal: nothing to ask for
      start = { ...cloneState(ref), rockets: Math.max(0, b.rockets - used), wp: 0 };
      delete start.early;
      delete start.late;
      at = now + (j - this.cursor);
    }
    const req: RouteRequest = {
      start,
      goals,
      margin: this.o.margin,
      maxNodes: this.o.maxNodes,
      maxMs: this.o.maxMs,
      ...(this.o.stackRockets !== undefined ? { stackRockets: this.o.stackRockets } : {}),
      ...(this.o.families ? { families: this.o.families } : {}),
      ...(this.o.rocketCost !== undefined ? { rocketCost: this.o.rocketCost } : {}),
      ...(this.o.riskCost !== undefined ? { riskCost: this.o.riskCost } : {}),
      ...(this.o.edgeTicks !== undefined ? { edgeTicks: this.o.edgeTicks } : {}),
      ...(this.o.weight !== undefined ? { weight: this.o.weight } : {}),
      ...(this.o.library !== undefined ? { library: this.o.library } : {}),
      ...(this.o.geodesic ? { geodesic: true } : {}),
      ...(this.o.pieces !== undefined ? { pieces: this.o.pieces } : {}),
    };
    this.pending = true;
    if (this.plan) this.stats.replans++;
    this.stats.plans++;
    const asked = wp0;
    const adopt = (p: RoutePlan): void => {
      this.pending = false;
      this.stats.planMs += p.ms;
      if (!p.complete) this.stats.partial++;
      this.stats.first ??= { nodes: p.nodes, expanded: p.expanded, ms: p.ms, ticks: p.ticks, rockets: p.rockets, complete: p.complete, robust: p.robust, clearance: p.clearance };
      this.o.note?.(`route: ${why}: ${p.complete ? 'plan' : `partial plan (${p.why ?? '?'})`}${p.robust ? '' : ' (not robust)'} ${p.ticks} ticks, ${p.rockets} rockets, clearance ${p.clearance.toFixed(2)}, ${p.expanded} expanded of ${p.nodes} in ${p.ms.toFixed(0)} ms: ${p.edges.map((e) => e.name).join(' ')}`);
      // a goal was passed meanwhile (the plan's goals are stale, ask again next tick), or the bail-out began; a plan asked
      // from ahead (replanLead) may start past goals the body has not reached yet
      if (asked < this.wp || (asked !== this.wp && !rl) || this.bail) return;
      if (p.controls.length === 0) {
        // no edge from the body's state (within the margin of a solid): the evade rule flies, the planner is asked again
        if (!this.plan) this.planless++;
        if (this.planless > PLANLESS_MAX) this.failed = p.why ?? 'no plan';
        // Track F5b: a standing body whose search emptied its open list (no takeoff fits here) fails at once, not after 40 ticks
        if (!start.gliding && p.budget === 'none' && this.o.rules) this.failed = p.why ?? 'no takeoff from here';
        return;
      }
      this.planless = 0;
      // Track F5b (completeOnly): a complete plan is never replaced by a partial one; blocked ahead, a partial answer bails
      if (this.o.rules?.completeOnly && !p.complete && this.plan?.complete && b.gliding) {
        if (this.needComplete && this.o.rules.blockedBail !== false) {
          this.bail = 'brake';
          this.o.note?.('route: the plan ahead is blocked and the new plan is partial: bailing out (the brake, then the sink to the floor)');
        } else this.stats.partialIgnored = (this.stats.partialIgnored ?? 0) + 1;
        return;
      }
      this.needComplete = false;
      // Track F5b: a partial plan for a body gliding with speed shorter than the commit horizon (partialStop counts them; a
      // slow body near a landing gets short partial settles and is no danger)
      const commit = this.o.rules?.commitTicks ?? 0;
      if (start.gliding && hspeed(start.vel) >= SHORT_PARTIAL_SPEED && !p.complete && commit > 0 && p.controls.length < commit) this.shortPartials++;
      else this.shortPartials = 0;
      if (rl > 0 && this.plan && at > this.now + 1 && this.cursor < this.plan.states.length - 2) {
        // Track F5b: asked from ahead and back early: the old plan flies on until the new one's start tick
        this.nextPlan = { p, start, goals: req.goals, wp0: asked, at };
        return;
      }
      // Track F7 (tube): a plan asked from the reference ahead meets the body only where the body still goes (tick: the same
      // check when it is due); back late, it would be adopted now, 4.5 blocks from a body whose reference was re-timed since
      // (checked here only when it is adopted now: back early, the body has not reached its start yet)
      if (this.o.rules?.tube && rl > 0 && this.plan && start.gliding && this.lastPos && this.farFrom(p, start, this.lastPos)) {
        this.o.note?.(`route: the plan asked from ahead starts over ${NEXT_PLAN_FAR} from the body (the reference moved since): dropped`);
        this.stats.dropped = (this.stats.dropped ?? 0) + 1;
        return;
      }
      this.adoptNow(p, start, req.goals, asked, at);
    };
    const r = this.o.plan(req);
    if (r instanceof Promise) {
      r.then(adopt, (e: unknown) => {
        this.pending = false;
        this.o.note?.(`route: the planner failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    } else adopt(r);
  }

  private adoptNow(p: RoutePlan, start: RouteState, goals: RouteGoal[], wp0: number, at: number): void {
    this.plan = p;
    this.planStart = start;
    this.planGoals = goals;
    this.planWp0 = wp0;
    this.planTick = at;
    this.cursor = -1;
    this.flownPlan = undefined;
    this.nextPlan = undefined;
    this.burnHazard = -1;
    this.hazardAsked = false;
    this.forecastReplanned = false;
    this.forecastHit = -1;
    this.burnsRead = [];
  }

  /** Track F7: the body at `pos` is farther than NEXT_PLAN_FAR from a plan's start and its first states. */
  private farFrom(p: RoutePlan, start: RouteState, pos: Vec3): boolean {
    let d = Infinity;
    for (const q of [start.pos, ...p.states.slice(0, 4).map((x) => x.pos)]) d = Math.min(d, Math.hypot(q.x - pos.x, q.y - pos.y, q.z - pos.z));
    return d > NEXT_PLAN_FAR;
  }

  /** The plan's state at index `i` (-1: the state the plan was made from). */
  private ref(i: number): RouteState {
    const p = this.plan!;
    return i < 0 ? this.planStart! : p.states[Math.min(p.states.length - 1, i)]!;
  }

  /** The index of the plan state the body matches now (nearest in position among those near in time; -1 = the plan's start). */
  private locate(b: TrackerBody, now: number): number {
    const p = this.plan!;
    const expect = now - this.planTick - 1; // states[i] is the body after control i, flown at planTick + i
    // a plan just adopted from a worker answers for a state some ticks old: the body is matched anywhere up to the
    // expected index (the hold flown meanwhile is not the plan's start)
    const tube = this.o.rules?.tube === true;
    // (Track F7, tube: the match never goes back: a body sinking beside a descending path matched earlier and earlier states)
    const lo = this.cursor === -1 ? -1 : Math.max(-1, Math.min(expect, this.cursor) - (tube ? 0 : 2));
    const hi = Math.min(p.states.length - 1, Math.max(expect, this.cursor) + (tube ? LOCATE_AHEAD : 3));
    let best = Math.max(-1, Math.min(p.states.length - 1, expect));
    let bd = Infinity;
    for (let i = lo; i <= hi; i++) {
      const s = this.ref(i).pos;
      const d = Math.hypot(s.x - b.pos.x, s.y - b.pos.y, s.z - b.pos.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * The plan's corridor over the next LOOKAHEAD ticks from index `i` sweeps clear in the grid now: a solid that was not
   * there when the plan was made (a chunk loaded, a block set). Track F5b: swept with the plan's own least clearance when
   * that is under the margin (a plan from a standing start, or from a body already within the margin of a solid, keeps
   * less than the margin on its first edges by construction: `startMarginFor`), so a plan is never "blocked" by the
   * walls it was planned past (F4b's windows re-planned "the corridor ahead is blocked" over and over on such plans).
   */
  private corridorClear(i: number): boolean {
    return this.firstBlocked(i) < 0;
  }

  /** Track F6: the index of the first state of `states` (the plan's by default) within LOOKAHEAD of `i` whose step hits, -1 when the corridor is clear. */
  private firstBlocked(i: number, states: readonly RouteState[] = this.plan!.states, marginOverride?: number): number {
    const p = this.plan!;
    // (the cave rules only: the open-air drivers keep Track F4a's check as measured; with the plan's clearance as the margin
    // the obstacle course's rings and tunnel re-planned less on bds-fly2 and scraped)
    const cave = this.o.rules !== undefined;
    const margin = marginOverride ?? (cave ? Math.min(this.o.margin, Math.max(0, p.clearance - 0.02)) : this.o.margin);
    const at = (k: number): RouteState => (k < 0 ? this.planStart! : states[Math.min(states.length - 1, k)]!);
    for (let k = i; k < Math.min(states.length - 1, i + LOOKAHEAD); k++) {
      const a = at(k);
      if (cave && !a.gliding) continue; // the takeoff tick leaves the floor it stands on
      // (the landing cell's floor is no obstacle near it, as the search had it: primitives.ts sweepGridFor)
      const grid = cave ? sweepGridFor(this.o.grid, this.planGoals[a.wp], a.pos) : this.o.grid;
      if (sweep(grid, a.pos, at(k + 1).pos, margin).hit) {
        const q = at(k + 1).pos;
        if (states === p.states) this.o.note?.(`route: the plan's corridor is blocked at tick ${k + 1} of ${p.states.length} (${q.x.toFixed(1)} ${q.y.toFixed(1)} ${q.z.toFixed(1)}, margin ${margin.toFixed(2)})`);
        return k;
      }
    }
    return -1;
  }

  private hold(b: TrackerBody): RouteControl {
    this.stats.holdTicks++;
    return { yaw: headingOf(b.vel, this.yaw), pitch: 0, fire: false };
  }

  /**
   * No plan to fly: the level hold while it sweeps clear (no margin) for HORIZON ticks on the burn believed, else the
   * evade rule's control (the corridor's next window handed over with no plan in a cave held straight on).
   */
  private holdClear(b: TrackerBody): RouteControl {
    const c: RouteControl = { yaw: headingOf(b.vel, this.yaw), pitch: 0, fire: false };
    if (b.gliding) {
      let s = this.stateOf(b);
      for (let t = 0; t < HORIZON; t++) {
        const next = stepState(s, c, false).next;
        if (sweep(this.o.grid, s.pos, next.pos, 0).hit) return this.evade(this.stateOf(b));
        s = next;
      }
    }
    this.stats.holdTicks++;
    return c;
  }

  /**
   * The cost of flying `c0` now and the plan's controls after it for HORIZON ticks from `cur`: the hit penalty, and with
   * `track` the weighted squared distance from the plan's reference path.
   */
  private horizonCost(cur: RouteState, c0: RouteControl, next: number, margin: number, goals: readonly RouteGoal[], stack: boolean, track: boolean, hold = false, delta?: { dy: number; dp: number }, out?: { hitAt: number; speed: number; wall?: boolean }, ticks = HORIZON): number {
    const p = this.plan!;
    const tube = this.o.rules?.tube === true;
    let s: RouteState = { ...cur, wp: Math.max(0, this.wp - this.planWp0) };
    let cost = 0;
    if (out) {
      out.hitAt = -1;
      out.speed = 0;
    }
    for (let t = 0; t < ticks; t++) {
      const idx = next + t;
      // (Track F7: the forecast ends with the plan: past its last control the body is on its landing, or the next plan's; the
      // last control repeated sank the forecast through the landing's floor and bailed every window out 8 ticks before its cell)
      if (out && t > 0 && idx >= p.controls.length) break;
      let c = t === 0 ? c0 : hold ? { ...c0, fire: false } : idx < p.controls.length ? p.controls[idx]! : { ...p.controls[p.controls.length - 1]!, fire: false };
      // Track F7: the offset held over the horizon (a sustained correction, not a one-tick nudge)
      if (delta && t > 0) c = { ...c, yaw: c.yaw + delta.dy, pitch: Math.max(-90, Math.min(90, c.pitch + delta.dp)) };
      const r = stepState(s, c, stack, undefined, this.o.grid);
      const g = goals[r.next.wp];
      const crossing = crossesFloor(g, s.pos, r.next.pos);
      const landed = crossing && landsOn(g!, s.pos, r.next.pos, r.next.vel);
      const swept = !landed && sweep(sweepGridFor(this.o.grid, g, s.pos), s.pos, r.next.pos, margin).hit;
      if ((crossing && !landed) || swept) {
        cost += HIT_PENALTY * (HORIZON - t);
        // (the forecast's collision is a solid in the way, not a touchdown beside the landing cell: that is the settle's business)
        if (out && swept) {
          out.hitAt = t;
          out.speed = hspeed(s.vel);
          // a wall or the floor / a ceiling, in the move's own order (y first, then x and z: moveBody): the vertical leg clear and
          // the horizontal one hitting is a wall, the riser of a rising floor under a dive included (the body meets it with its
          // horizontal speed: tight-107's second window, 8.5)
          out.wall = !sweep(sweepGridFor(this.o.grid, g, s.pos), s.pos, { x: s.pos.x, y: r.next.pos.y, z: s.pos.z }, margin).hit;
        }
        break;
      }
      if (track) {
        const w = 1 / (1 + t * 0.25);
        if (tube) {
          // Track F7: the distance to the nearest reference point round the tick (the path, not the timetable: a body
          // slower or faster than the plan's nominal is not pulled along the track, only onto it)
          let best = Infinity;
          for (let k = Math.max(0, idx - TRACK_SLACK); k <= Math.min(p.states.length - 1, idx + TRACK_SLACK); k++) {
            const ref = p.states[k]!.pos;
            const dx = r.next.pos.x - ref.x;
            const dyy = r.next.pos.y - ref.y;
            const dz = r.next.pos.z - ref.z;
            const d = dx * dx + dyy * dyy + dz * dz;
            if (d < best) best = d;
          }
          cost += w * best;
        } else {
          const ref = p.states[Math.min(p.states.length - 1, idx)]!.pos;
          const dx = r.next.pos.x - ref.x;
          const dyy = r.next.pos.y - ref.y;
          const dz = r.next.pos.z - ref.z;
          cost += w * (dx * dx + dyy * dyy + dz * dz);
        }
      }
      if (landed) break;
      while (r.next.wp < goals.length && passes(goals[r.next.wp]!, s.pos, r.next.pos)) r.next.wp++;
      s = r.next;
      if (s.wp >= goals.length) break;
    }
    return cost;
  }

  /** Re-optimise the next control around the plan's control at index `i + 1` from the real state. */
  private optimise(cur: RouteState, i: number): RouteControl {
    const p = this.plan!;
    const next = i + 1;
    const base = next < p.controls.length ? p.controls[next]! : { ...p.controls[p.controls.length - 1]!, fire: false };
    if (!cur.gliding) return base; // the takeoff tick: as planned
    const goals = this.planGoals;
    const stack = this.o.stackRockets === true;
    const margin = startMarginFor(this.o.grid, cur, this.o.margin);
    // Track F4a: the burn's end is not known while it may still come (F0: 9 to 21 ticks): each candidate is flown on the
    // belief's nominal for the tracking cost and on the earliest and the latest end for the hits too, followed by the
    // plan's controls and, while the end is unknown, also held (a turn begun early, before a turn the plan flies on a boost
    // that may be over by then). The e2e's 3 x 3 tunnel scraped its arc on a burn that ended 6 ticks before the nominal and
    // its ceiling on one that ran 4 past it.
    const b = cur.boost;
    const ends = b.max > 0 && b.min < b.max ? [b.min, Math.min(b.max, HORIZON + 1)].filter((e) => e !== b.nom) : [];
    const costOf = (c0: RouteControl, hold: boolean, delta?: { dy: number; dp: number }): number => {
      let cost = this.horizonCost(cur, c0, next, margin, goals, stack, true, hold, delta);
      // (Track F6: in a cave the ends are judged on half the margin: a plan robust to the burn by construction keeps the margin at
      // the extremes, and a tail "hit" at the full margin for an end in between stopped windows that were tracking at 0.00)
      const endMargin = this.o.rules ? margin * 0.5 : margin;
      for (const e of ends) cost += this.horizonCost({ ...cur, boost: { ...b, nom: e } }, c0, next, endMargin, goals, stack, false, hold, delta);
      return cost;
    };
    let bestCost = Infinity;
    let best = base;
    let bestDelta: { dy: number; dp: number } | undefined;
    let planSafe = true;
    const tube = this.o.rules?.tube === true;
    for (const dy of YAW_STEPS) {
      for (const dp of PITCH_STEPS) {
        const c0: RouteControl = { ...base, yaw: base.yaw + dy, pitch: Math.max(-90, Math.min(90, base.pitch + dp)) };
        const cost = costOf(c0, false) + Math.abs(dy) * 0.002 + Math.abs(dp) * 0.002; // prefer the plan's own control among equals
        if (cost < bestCost) {
          bestCost = cost;
          best = c0;
          bestDelta = undefined;
        }
        // Track F7 (tube): the same offset held over the horizon
        if (tube && (dy !== 0 || dp !== 0)) {
          const delta = { dy, dp };
          const held = costOf(c0, false, delta) + Math.abs(dy) * 0.003 + Math.abs(dp) * 0.003;
          if (held < bestCost) {
            bestCost = held;
            best = c0;
            bestDelta = delta;
          }
        }
      }
    }
    if (tube) {
      // Track F7: the body's own forecast on the control chosen: a collision (PLAN_CLEAR_MIN, not the margin) within the horizon
      // is what the bail-out is decided on (tick), and every candidate hitting the margin asks for a plan
      const fc = { hitAt: -1, speed: 0 };
      this.horizonCost(cur, best, next, PLAN_CLEAR_MIN, goals, stack, false, false, bestDelta, fc);
      // The burn may end this tick (min 0, the nominal still running): can ANY candidate keep clear for END_FORECAST ticks without
      // the boost? A plan's brake or turn flown under the boost (the rocket brake reverses the body in a tick; a turn at 1.55 a
      // tick) met the wall when the burn's last tick was plain, 7 to 11 of damage one tick after a clear forecast. The same check
      // on the control chosen alone bailed every straight-bore flight out of its dive (the plan's recorded dive without the boost
      // sinks to the floor, where a nose-up candidate recovers), so the question is whether some control saves it, not the plan's
      // (a WALL only: the floor of a 3-high bore 3 ticks under a dive the boost was to pull out of is no wall, and a touch of it
      // at a glide's angle hurts nothing)
      if (fc.hitAt < 0 && b.max > 0 && b.min === 0 && b.nom > 0) {
        const noBoost = { ...cur, boost: { ...b, nom: 0 } };
        const f0: { hitAt: number; speed: number; wall?: boolean } = { hitAt: -1, speed: 0 };
        this.horizonCost(noBoost, best, next, PLAN_CLEAR_MIN, goals, stack, false, false, bestDelta, f0, END_FORECAST);
        if (f0.hitAt >= 0 && f0.wall) {
          // the control chosen meets a wall should the burn end now: the cheapest candidate that keeps clear both ways is flown
          // instead (tight-107 at the random burns of seed 7: the plan's brake under the boost, the burn's last tick plain, 11.6)
          let saveCost = Infinity;
          let save: RouteControl | undefined;
          const f1 = { hitAt: -1, speed: 0 };
          for (const dy of [...YAW_STEPS, ...WIDE_YAWS]) {
            for (const dp of [...PITCH_STEPS, ...WIDE_PITCHES]) {
              const c0: RouteControl = { ...base, yaw: base.yaw + dy, pitch: Math.max(-90, Math.min(90, base.pitch + dp)) };
              const delta = { dy, dp };
              this.horizonCost(noBoost, c0, next, PLAN_CLEAR_MIN, goals, stack, false, false, delta, f0, END_FORECAST);
              if (f0.hitAt >= 0 && f0.wall) continue;
              this.horizonCost(cur, c0, next, PLAN_CLEAR_MIN, goals, stack, false, false, delta, f1);
              if (f1.hitAt >= 0) continue;
              const cost = costOf(c0, false, delta);
              if (cost < saveCost) {
                saveCost = cost;
                save = c0;
              }
            }
          }
          if (save) {
            best = save;
            this.stats.endSaves = (this.stats.endSaves ?? 0) + 1;
          } else {
            fc.hitAt = Math.max(0, f0.hitAt);
            fc.speed = hspeed(cur.vel);
            this.stats.endBails = (this.stats.endBails ?? 0) + 1;
          }
        }
      }
      if (fc.hitAt >= 0) {
        // the last resort before the brake: wider offsets held over the horizon (a bend the plan's controls take too late for a
        // body the burn carried faster), the clearest of those that do not collide (F6 kept these out of a cave because they
        // jumped the body off a plan that was fine; here they are tried only when the plan's own control collides)
        let wideCost = Infinity;
        for (const dy of WIDE_YAWS) {
          for (const dp of WIDE_PITCHES) {
            const c0: RouteControl = { ...base, yaw: base.yaw + dy, pitch: Math.max(-90, Math.min(90, base.pitch + dp)) };
            const delta = { dy, dp };
            const f2 = { hitAt: -1, speed: 0 };
            this.horizonCost(cur, c0, next, PLAN_CLEAR_MIN, goals, stack, false, false, delta, f2);
            if (f2.hitAt >= 0) continue;
            const cost = costOf(c0, false, delta);
            if (cost < wideCost) {
              wideCost = cost;
              best = c0;
              fc.hitAt = -1;
              fc.speed = 0;
            }
          }
        }
        if (wideCost < Infinity) this.stats.wide = (this.stats.wide ?? 0) + 1;
      }
      this.forecastHit = fc.hitAt;
      this.forecastSpeed = fc.speed;
      this.forecastUnsafe = bestCost >= HIT_PENALTY;
    }
    if (ends.length && bestCost >= HIT_PENALTY) {
      // every candidate followed by the plan hits for some end of the burn: the held ones, with wider turns, and a re-plan.
      // Track F6: not in a cave. There the plan is robust to the burn by construction and the body was on it (error 0.00
      // for 36 ticks in the owner's cave); the held candidate (a yaw 90 off the heading) took it 1.3 off the plan in one
      // tick and the window bailed out 2 blocks off. The cave rules keep the plan's own best control and ask for the
      // complete re-plan (`burnUnsafe`); a burn that does end where the tail hits is met by the re-timed reference and
      // the bail-out within the commit horizon.
      planSafe = false;
      for (const dy of this.o.rules ? [] : HOLD_YAWS) {
        for (const dp of HOLD_PITCHES) {
          const c0: RouteControl = { ...base, yaw: headingOf(cur.vel, base.yaw) + dy, pitch: dp };
          const cost = costOf(c0, true) + 0.5; // (the plan's tail first among equals)
          if (cost < bestCost) {
            bestCost = cost;
            best = c0;
          }
        }
      }
    }
    this.burnUnsafe = !planSafe;
    return best;
  }

  /**
   * The boost read off the body: the velocity the last control produced is either the boosted or the plain
   * glide step of the last velocity (the gain is 0.5 towards 1.5 along the look: the two are far apart), so
   * the body tells whether the rocket still burns before the server's late notice does. Between the nominal
   * end and the latest one the belief follows the body; a burn that ended early is seen at once.
   */
  private readBoost(b: TrackerBody, now: number): void {
    if (!this.lastVel || !this.lastControl || !b.gliding || this.boost.max === 0) return;
    const c = this.lastControl;
    const on = glideVelocity(this.lastVel, c.yaw, c.pitch, true);
    const off = glideVelocity(this.lastVel, c.yaw, c.pitch, false);
    const dOn = Math.hypot(on.x - b.vel.x, on.y - b.vel.y, on.z - b.vel.z);
    const dOff = Math.hypot(off.x - b.vel.x, off.y - b.vel.y, off.z - b.vel.z);
    // (Track F6: the step judged was flown with `nomBefore` ticks of the nominal left: boosted iff over 0. Judged on the
    // belief after its tick, the last nominal tick read as "burns on past the plan" and the next as "ended early": two
    // re-plans a nominal burn)
    if (dOff < dOn * 0.5 && this.nomBefore > 0) {
      // the burn ended before the nominal: the body flew a plain glide tick (Track F6: the step at now - 1 was plain, so the
      // rocket fired at F burnt now - 1 - F ticks: the plan's reference is re-timed to that)
      if (this.firedAt !== undefined) this.retime(Math.max(1, now - 1 - this.firedAt), now);
      this.boost = { ...NO_BOOST };
      this.burnEnded = true;
      this.firedAt = undefined;
      this.stats.burnsRead++;
    } else if (dOn < dOff * 0.5 && this.nomBefore === 0 && this.boost.max > 0) {
      // the burn goes on past the nominal: the plan assumed it over. Track F4a: the belief's nominal moves to the middle
      // of what may be left (an end before it is read at once; one after it is read again), and the re-plan this asks
      // for branches the rest of the range (search.ts)
      this.boost = { ...this.boost, nom: Math.max(1, Math.ceil(this.boost.max / 2)) };
      // (Track F6: the reference re-timed to the burn so far plus the belief's middle; re-timed again when the end is read)
      if (this.firedAt !== undefined) this.retime(now - this.firedAt + this.boost.nom, now);
      this.burnEnded = true;
      this.stats.burnsRead++;
    }
  }

  /**
   * Track F4a: the rocket the last tick asked for was not used (the driver held it: the server's gliding flag had not
   * come yet, or the hand was busy): the belief drops the burn it assumed and the rocket goes on the next tick it can.
   */
  fireHeld(): void {
    if (this.boost.max === 0) return;
    // (a rocket stacked on a running burn: that burn goes on; the belief ticked once since)
    this.boost = burnTick(this.boostBefore);
    this.firedAt = undefined;
    this.stats.fired = Math.max(0, this.stats.fired - 1);
    this.fireLater = true;
  }

  /**
   * One tick: the control to fly now from the real body. `shadow` (Track F5b): the tracker is ticked alongside the one
   * flying (the chain's next window planning ahead): its ticks without a plan are not the body's, so they never bail.
   */
  tick(b: TrackerBody, now: number, shadow = false): TrackerOutput {
    this.stats.ticks++;
    this.now = now;
    // Track F5b (replanLead): the plan asked from ahead takes over at its start tick, or when the old one is out
    if (this.nextPlan && !this.bail && (now >= this.nextPlan.at || !this.plan || this.cursor >= this.plan.states.length - 2)) {
      const n = this.nextPlan;
      // Track F7 (tube): a plan asked from the reference ahead meets the body only if the body is still going there: the
      // reference may have been re-timed since (a burn read), and a plan adopted 4.5 blocks from its start bailed the body out
      // "off the plan" in the open. Far from its start, the plan is dropped (the usual reasons ask again)
      const far = this.o.rules?.tube === true && n.start.gliding && this.farFrom(n.p, n.start, b.pos);
      if (far) {
        this.o.note?.(`route: the plan asked from ahead starts over ${NEXT_PLAN_FAR} from the body (the reference moved since): dropped`);
        this.nextPlan = undefined;
        this.stats.dropped = (this.stats.dropped ?? 0) + 1;
      } else if (n.wp0 >= this.wp) this.adoptNow(n.p, n.start, n.goals, n.wp0, n.at);
      else this.nextPlan = undefined;
    }
    this.readBoost(b, now);
    this.lastVel = { ...b.vel };
    // the goals passed by the real body
    if (this.lastPos) {
      const goals = this.o.goals;
      while (this.wp < goals.length) {
        const g = goals[this.wp]!;
        if (g.kind === 'waypoint' ? passes(g, this.lastPos, b.pos) : b.onGround && landingCells(g).some((c) => Math.floor(b.pos.x) === c.x && Math.floor(b.pos.z) === c.z) && Math.abs(b.pos.y - g.top) < 0.6) {
          this.wp++;
          // (the plan goes on: its goals are its own list, `planGoals`; only a new request takes the ones left)
          this.o.note?.(`route: goal ${this.wp} of ${goals.length} passed at tick ${now}`);
        } else break;
      }
    }
    this.lastPos = { ...b.pos };
    if (this.wp >= this.o.goals.length) {
      const c = { yaw: this.yaw, pitch: 0, fire: false };
      this.lastControl = c;
      return { control: c, status: 'done', done: true, error: 0 };
    }
    if (this.bail) {
      const c = this.bailControl(this.stateOf(b), now);
      this.yaw = c.yaw;
      this.lastControl = c;
      this.nomBefore = this.boost.nom;
      this.boost = burnTick(this.boost);
      return { control: c, status: 'bailing', done: false, error: 0 };
    }
    if (this.failed) return { control: this.holdClear(b), status: 'failed', done: false, error: 0 };
    let replan: string | undefined;
    if (!this.plan) {
      replan = this.stats.plans === 0 ? 'start' : 'next goal';
      this.request(b, now, replan);
    }
    let control: RouteControl;
    let error = 0;
    let status: TrackerStatus = 'planning';
    let debug: TrackerDebug | undefined;
    if (this.plan && now < this.planTick) {
      // Track F4a: a plan asked ahead (`lead`) starts later: the hold it was made from flies until then
      control = this.holdClear(b);
    } else if (this.plan) {
      const p = this.plan;
      const i = this.locate(b, now);
      this.cursor = i;
      const ref = this.ref(i).pos;
      error = Math.hypot(ref.x - b.pos.x, ref.y - b.pos.y, ref.z - b.pos.z);
      if (error > this.stats.maxError) this.stats.maxError = error;
      const cur = this.stateOf(b);
      // Track F6: a burn read off the body whose controls would hit ahead (retime) asks for a complete plan as a loaded chunk
      // would, but never the bail-out on its own: it is an open-loop forecast the horizon corrects (a plan robust to the
      // burn's extremes grazes the floor of a clean bore for the burns between, flown open loop; closed loop it lands)
      const tube = this.o.rules?.tube === true;
      const blockedAt = this.changed || (now & 3) === 0 ? this.firstBlocked(i) : -1;
      if (this.burnHazard >= 0 && this.burnHazard < i) this.burnHazard = -1; // (the body is past it)
      // (Track F7, tube: the hazard under the burn read is a re-plan's reason, not a blocked corridor: the body is tracked on the re-timed reference and its own forecast decides the bail-out)
      const hazard = this.burnHazard >= i;
      const blocked = blockedAt >= 0 || (hazard && !tube);
      const out = i >= p.states.length - 2;
      const planBoost = this.ref(i).boost.nom > 0;
      let again: string | undefined;
      if (error > (this.o.replanError ?? REPLAN_ERROR)) again = `off the reference by ${error.toFixed(2)}`;
      else if (this.corrected && error > (this.o.replanError ?? REPLAN_ERROR) / 2) again = `a correction moved the body ${error.toFixed(2)} off`;
      else if (blocked) again = 'the corridor ahead is blocked';
      else if (tube && hazard && !this.pending && !this.hazardAsked) again = "the plan's controls under the burn read hit ahead";
      else if (this.burnEnded && planBoost && this.boost.nom === 0) again = 'the rocket ended before the plan assumed';
      // Track F4a: a burn past the plan's nominal (F0: 9 to 21 ticks) was never re-planned (F2 asked only for an early end)
      else if (this.burnEnded && !planBoost && this.boost.nom > 0) again = 'the rocket burns on past the plan';
      else if (out && !p.complete) again = 'the partial plan ran out';
      else if (out) again = 'the plan ran out';
      // Track F5b: a partial plan is asked again `commitTicks` before its end (the stop at its end is the fallback)
      else if (this.o.rules?.partialStop && !p.complete && (this.o.rules.commitTicks ?? 0) > 0 && p.states.length - 1 - i <= this.o.rules.commitTicks!) again = 'the partial plan is nearly out';
      this.corrected = false;
      this.changed = false;
      this.burnEnded = false;
      if (again && !replan) {
        replan = again;
        if (tube && hazard) this.hazardAsked = true; // (once per hazard: the answer may be "no edge" every tick)
        // Track F5b (completeOnly): a complete plan blocked ahead wants a complete replacement, else the bail-out
        if (this.o.rules?.completeOnly && p.complete && blocked) this.needComplete = true;
        this.request(b, now, again);
      }
      // Track F6: a plan blocked within the commit horizon in a cave: no plan can come back in time (the worker's 12 ticks),
      // and the horizon's small perturbations cannot steer round a wall in a 3-wide passage: the bail-out now (the brake
      // stops the body in about 5 blocks). tight-107 at burn 12: the wall 5 ticks ahead, the re-plan asked, 12 of damage.
      const commit = this.o.rules?.commitTicks ?? 0;
      // (judged on a collision course, PLAN_CLEAR_MIN, not the margin: a re-timed reference that comes within the margin of the
      // floor before its settle asked for a plan and must not stop the body for that)
      // (Track F7, tube: the reference's collision course is the open-loop forecast; the body's own, on the control chosen, decides below)
      const collisionAt = !tube && blockedAt >= 0 && blockedAt - i <= commit ? this.firstBlocked(i, p.states, PLAN_CLEAR_MIN) : -1;
      if (this.o.rules?.completeOnly && collisionAt >= 0 && b.gliding && commit > 0 && collisionAt - i <= commit && this.plan === p) {
        this.bail = 'brake';
        this.o.note?.(`route: the plan is blocked ${collisionAt - i} ticks ahead (under the commit horizon of ${commit}): bailing out (the brake, then the sink to the floor)`);
        const c = this.bailControl(cur, now);
        this.yaw = c.yaw;
        this.lastControl = c;
        this.nomBefore = this.boost.nom;
        this.boost = burnTick(this.boost);
        return { control: c, status: 'bailing', done: false, ...(replan ? { replan } : {}), error };
      }
      // a plan adopted just now (an in-thread planner answers at once) starts at its own state: locate again
      const j = this.plan === p ? i : this.locate(b, now);
      this.cursor = j;
      const settleAt = tube ? this.settleCell(cur) : undefined;
      if (blocked && !this.plan.complete && out && this.plan === p) control = this.holdClear(b);
      else if (settleAt) {
        // Track F7 (tube): the landing flown closed loop: a slow body near its landing cell keeps station over the cell and sinks
        // (maneuvers.ts keepYaw, the settle's own law from the REAL state), instead of replaying the plan's recorded flips,
        // which land the plan's body and leave the real one hovering down beside the cell (the owner's cave: windows that
        // reached their last goal and stopped 0.5 off it, then bailed out "off the plan" into a pool)
        control = settleControl(cur, settleAt);
        status = 'tracking';
        debug = { ref: this.ref(j).pos, cursor: j, len: this.plan.states.length, belief: { ...this.boost }, refBoost: 0, settle: true };
        this.stats.settleTicks = (this.stats.settleTicks ?? 0) + 1;
        this.forecastHit = -1;
        this.forecastUnsafe = false;
      } else {
        control = this.optimise(cur, j);
        status = 'tracking';
        // Track F7 (tube): the body's own forecast on the control chosen collides within the commit horizon: the brake now
        // (at any speed: a slow body's touch costs nothing, but what it touches may be a pool: the owner's cave's second window
        // sank into one at 0.2 a tick on a re-timed reference; the bail-out's sink looks for a dry floor instead)
        if (tube && this.forecastHit >= 0 && this.forecastHit < commit && b.gliding && this.plan === p) {
          this.bail = 'brake';
          this.o.note?.(`route: the body's forecast on its best control collides ${this.forecastHit + 1} ticks ahead at ${this.forecastSpeed.toFixed(2)} a tick: bailing out (the brake, then the sink to the floor)`);
          const c = this.bailControl(cur, now);
          this.yaw = c.yaw;
          this.lastControl = c;
          this.nomBefore = this.boost.nom;
          this.boost = burnTick(this.boost);
          return { control: c, status: 'bailing', done: false, ...(replan ? { replan } : {}), error };
        }
        // Track F7 (tube): every candidate hits the margin within the horizon: a plan from here, once a plan
        if (tube && this.forecastUnsafe && !this.forecastReplanned && !replan && !this.pending) {
          this.forecastReplanned = true;
          replan = "the body's forecast hits the margin ahead";
          this.request(b, now, replan);
        }
        debug = { ref: this.ref(j).pos, cursor: j, len: this.plan.states.length, belief: { ...this.boost }, refBoost: this.ref(j).boost.nom, ...(j + 1 < this.plan.controls.length ? { planned: this.plan.controls[j + 1]! } : {}), complete: this.plan.complete, goals: this.planGoals.length, end: this.plan.states[this.plan.states.length - 1]?.pos ?? this.planStart!.pos };
        // Track F4a: the body matched a state past the next control (it runs a tick ahead of the reference): a rocket
        // the plan fires on a control skipped so is fired now (the e2e's tunnel lost its corner's rocket so)
        const plan = this.plan;
        const k = j + 1;
        if (plan !== this.flownPlan) this.flownPlan = plan;
        else if (!control.fire && k > this.flownNext + 1) {
          for (let m = this.flownNext + 1; m < Math.min(k, plan.controls.length); m++) {
            if (plan.controls[m]!.fire) {
              control = { ...control, fire: true };
              break;
            }
          }
        }
        this.flownNext = k;
        if (this.burnUnsafe && !this.burnReplanned && !replan) {
          // Track F4a: a plan from here with the burn's whole range branched (search.ts), once a burn
          this.burnReplanned = true;
          replan = "the plan's tail hits for an end of the burn";
          // Track F6 (completeOnly): the plan ahead is unsafe for an end of the burn: a partial answer bails, as when blocked
          if (this.o.rules?.completeOnly && this.plan.complete) this.needComplete = true;
          this.request(b, now, replan);
        }
      }
    } else if (this.planless > 0 && b.gliding) {
      // the last answer had no edge from here: keep clear while asking again
      if (!this.pending) this.request(b, now, 'no edge from the body (evading)');
      control = this.evade(this.stateOf(b));
      status = 'holding';
    } else {
      control = this.holdClear(b);
      status = this.pending ? 'planning' : 'holding';
    }
    // Track F5b: a body gliding without a plan being tracked for `bailAfter` ticks stops and comes down (the bail-out);
    // the ticks of a shadow tracker (the chain's next window) are not the body's
    const rules = this.o.rules;
    if (!shadow && b.gliding && status !== 'tracking') this.planlessGliding++;
    else if (status === 'tracking') this.planlessGliding = 0;
    const planless = rules?.bailAfter !== undefined && this.planlessGliding >= rules.bailAfter && status !== 'tracking';
    // Track F5b: the planner is not sure (partialStop): SHORT_PARTIALS partial plans in a row under the commit horizon
    const partialOut = rules?.partialStop === true && this.shortPartials >= SHORT_PARTIALS;
    // Track F5b: the body far off its reference (bailError): the stop, not a chase of a plan it has left
    // (Track F7, tube: the error must stay over `bailError` for LOST_TICKS ticks: a re-timed reference moves the reference, not
    // the body, and the horizon converges on it in a few ticks; the body's own forecast guards the walls meanwhile)
    const over = rules?.bailError !== undefined && status === 'tracking' && error > rules.bailError;
    this.lostTicks = over ? this.lostTicks + 1 : 0;
    const lost = over && (rules?.tube !== true || this.lostTicks >= LOST_TICKS);
    if (b.gliding && (planless || partialOut || lost)) {
      this.bail = 'brake';
      this.o.note?.(`route: ${planless ? `no plan for ${this.planlessGliding} ticks in the air` : partialOut ? `${this.shortPartials} partial plans in a row under ${rules?.commitTicks} ticks` : `${error.toFixed(1)} blocks off the plan`}: bailing out (the brake, then the sink to the floor)`);
      const c = this.bailControl(this.stateOf(b), now);
      this.yaw = c.yaw;
      this.lastControl = c;
      this.nomBefore = this.boost.nom;
      this.boost = burnTick(this.boost);
      return { control: c, status: 'bailing', done: false, ...(replan ? { replan } : {}), error };
    }
    // no powered flight without a plan being tracked, or on one that grazes a solid (PLAN_CLEAR_MIN): the plan's rocket,
    // a late one and a held one are dropped (the next safe plan fires its own), and the glide bleeds the speed
    const flying = status === 'tracking' ? this.plan : undefined;
    // Track F5b: the cave rules: a partial plan must be cleared `commitTicks` past the body (room to stop in), and no
    // rocket on top of speed (`fireSpeedMax`)
    if (rules && flying && (control.fire || this.fireLater) && flying.clearance >= PLAN_CLEAR_MIN) {
      const left = flying.states.length - 1 - Math.max(0, this.cursor);
      const short = rules.refuseUncommitted === true && !flying.complete && (rules.commitTicks ?? 0) > 0 && left < rules.commitTicks!;
      const fast = rules.fireSpeedMax !== undefined && hspeed(b.vel) >= rules.fireSpeedMax;
      if (short || fast) {
        if (control.fire || b.gliding) {
          this.stats.uncommitted = (this.stats.uncommitted ?? 0) + 1;
          if (this.refusedFor !== flying) {
            this.refusedFor = flying;
            this.o.note?.(`route: no rocket ${short ? `on a partial plan cleared ${left} ticks ahead (under ${rules.commitTicks})` : `at ${hspeed(b.vel).toFixed(2)} a tick (over ${rules.fireSpeedMax})`}: the glide goes on unpowered`);
          }
        }
        control = { ...control, fire: false };
        this.fireLater = false;
      }
    }
    if ((control.fire || this.fireLater) && (flying === undefined || flying.clearance < PLAN_CLEAR_MIN)) {
      if (control.fire || b.gliding) {
        this.stats.refused = (this.stats.refused ?? 0) + 1;
        if (this.refusedFor !== (flying ?? null)) {
          this.refusedFor = flying ?? null;
          this.o.note?.(`route: no rocket ${flying ? `on a plan with clearance ${flying.clearance.toFixed(2)} (under ${PLAN_CLEAR_MIN})` : `with no plan to fly (${status})`}: the glide goes on unpowered`);
        }
      }
      control = { ...control, fire: false };
      this.fireLater = false;
    }
    // the rocket: as the plan says, once per burn (unless rockets stack); asked for before the glide took, it goes on the first gliding tick
    if (this.fireLater && b.gliding && b.rockets > 0 && mayFire(this.boost) && !control.fire) {
      control = { ...control, fire: true };
      this.fireLater = false;
    }
    if (control.fire) {
      if (b.rockets > 0 && b.gliding && (mayFire(this.boost) || this.o.stackRockets === true)) {
        this.boostBefore = { ...this.boost };
        this.boost = freshBurn();
        this.firedAt = now; // Track F6 (retime): the plan's reference follows this rocket's real burn
        this.stats.fired++;
        this.fireLater = false;
        this.burnReplanned = false;
      } else {
        if (b.rockets > 0 && !b.gliding) this.fireLater = true;
        control = { ...control, fire: false };
      }
    }
    this.nomBefore = this.boost.nom;
    this.boost = burnTick(this.boost);
    this.yaw = control.yaw;
    this.lastControl = control;
    return { control, status, done: false, ...(replan ? { replan } : {}), error, ...(debug ? { debug } : {}) };
  }
}

/**
 * Track F4a: whether the tracker may fire a rocket on the body's burn belief: no burn, or one that may be over
 * (`inBurnTail`, the rule the plans are made with). With the union of the two lifetimes (F0) the burn after the
 * rocket is the fresh one the plan assumed, however long the old one runs on.
 */
function mayFire(b: Readonly<BoostRange>): boolean {
  return b.max === 0 || inBurnTail(b);
}

/** The plan's horizontal speed at an index, for the log. */
export function planSpeedAt(p: RoutePlan, i: number): number {
  return hspeed(p.states[Math.min(p.states.length - 1, Math.max(0, i))]!.vel);
}
