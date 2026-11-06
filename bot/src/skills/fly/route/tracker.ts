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
import { sweep, type RouteGrid } from './grid.ts';
import { crossesFloor, inBurnTail, landsOn, passes, stepState, sweepGridFor } from './primitives.ts';
import { startMarginFor } from './search.ts';
import { BURN, NO_BOOST, burnTick, freshBurn, headingOf, hspeed, landingCells, type BoostRange, type PrimitiveFamily, type RouteControl, type RouteGoal, type RoutePlan, type RouteRequest, type RouteState } from './types.ts';

/** Ticks of the plan ahead of the body checked against the grid every tick. */
export const LOOKAHEAD = 20;
/** The re-optimisation horizon (ticks). */
export const HORIZON = 8;
/** The distance from the reference that asks for a new plan (blocks). */
export const REPLAN_ERROR = 1.0;
const YAW_STEPS = [0, -4, 4, -8, 8, -16, 16];
const PITCH_STEPS = [0, -6, 6, -12, 12];
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
}

export type TrackerStatus = 'planning' | 'tracking' | 'holding' | 'done' | 'failed';

export interface TrackerOutput {
  control: RouteControl;
  status: TrackerStatus;
  /** All goals passed by the real body. */
  done: boolean;
  /** A new plan was asked for this tick, and why. */
  replan?: string;
  /** The distance from the reference this tick. */
  error: number;
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
    this.boost = { ...NO_BOOST };
    this.burnEnded = true;
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
    if (this.pending) return;
    let start = this.stateOf(b);
    // Track F4a: the first plan of a gliding body from where the hold takes it in `lead` ticks (TrackerOptions.lead)
    const lead = !this.plan && b.gliding ? Math.max(0, this.o.lead ?? 0) : 0;
    for (let k = 0, yaw = this.yaw; k < lead; k++) {
      yaw = headingOf(start.vel, yaw);
      start = stepState(start, { yaw, pitch: 0, fire: false }, false).next;
    }
    const at = now + lead;
    const req: RouteRequest = {
      start,
      goals: this.remainingGoals(),
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
    };
    this.pending = true;
    if (this.plan) this.stats.replans++;
    this.stats.plans++;
    const asked = this.wp;
    const adopt = (p: RoutePlan): void => {
      this.pending = false;
      this.stats.planMs += p.ms;
      if (!p.complete) this.stats.partial++;
      this.stats.first ??= { nodes: p.nodes, expanded: p.expanded, ms: p.ms, ticks: p.ticks, rockets: p.rockets, complete: p.complete, robust: p.robust, clearance: p.clearance };
      this.o.note?.(`route: ${why}: ${p.complete ? 'plan' : `partial plan (${p.why ?? '?'})`}${p.robust ? '' : ' (not robust)'} ${p.ticks} ticks, ${p.rockets} rockets, clearance ${p.clearance.toFixed(2)}, ${p.expanded} expanded of ${p.nodes} in ${p.ms.toFixed(0)} ms: ${p.edges.map((e) => e.name).join(' ')}`);
      if (asked !== this.wp) return; // a goal was passed meanwhile: the plan's goals are stale, ask again next tick
      if (p.controls.length === 0) {
        // no edge from the body's state (within the margin of a solid): the evade rule flies, the planner is asked again
        if (!this.plan) this.planless++;
        if (this.planless > PLANLESS_MAX) this.failed = p.why ?? 'no plan';
        return;
      }
      this.planless = 0;
      this.plan = p;
      this.planStart = start;
      this.planGoals = req.goals;
      this.planWp0 = asked;
      this.planTick = at;
      this.cursor = -1;
    };
    const r = this.o.plan(req);
    if (r instanceof Promise) {
      r.then(adopt, (e: unknown) => {
        this.pending = false;
        this.o.note?.(`route: the planner failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    } else adopt(r);
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
    const lo = this.cursor === -1 ? -1 : Math.max(-1, Math.min(expect, this.cursor) - 2);
    const hi = Math.min(p.states.length - 1, Math.max(expect, this.cursor) + 3);
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

  /** The plan's corridor over the next LOOKAHEAD ticks from index `i` sweeps clear in the grid now. */
  private corridorClear(i: number): boolean {
    const p = this.plan!;
    for (let k = i; k < Math.min(p.states.length - 1, i + LOOKAHEAD); k++) {
      if (sweep(this.o.grid, this.ref(k).pos, this.ref(k + 1).pos, this.o.margin).hit) return false;
    }
    return true;
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
  private horizonCost(cur: RouteState, c0: RouteControl, next: number, margin: number, goals: readonly RouteGoal[], stack: boolean, track: boolean, hold = false): number {
    const p = this.plan!;
    let s: RouteState = { ...cur, wp: this.wp - this.planWp0 };
    let cost = 0;
    for (let t = 0; t < HORIZON; t++) {
      const idx = next + t;
      const c = t === 0 ? c0 : hold ? { ...c0, fire: false } : idx < p.controls.length ? p.controls[idx]! : { ...p.controls[p.controls.length - 1]!, fire: false };
      const r = stepState(s, c, stack, undefined, this.o.grid);
      const g = goals[r.next.wp];
      const crossing = crossesFloor(g, s.pos, r.next.pos);
      const landed = crossing && landsOn(g!, s.pos, r.next.pos, r.next.vel);
      if ((crossing && !landed) || (!landed && sweep(sweepGridFor(this.o.grid, g, s.pos), s.pos, r.next.pos, margin).hit)) {
        cost += HIT_PENALTY * (HORIZON - t);
        break;
      }
      if (track) {
        const ref = p.states[Math.min(p.states.length - 1, idx)]!.pos;
        const w = 1 / (1 + t * 0.25);
        const dx = r.next.pos.x - ref.x;
        const dyy = r.next.pos.y - ref.y;
        const dz = r.next.pos.z - ref.z;
        cost += w * (dx * dx + dyy * dyy + dz * dz);
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
    const costOf = (c0: RouteControl, hold: boolean): number => {
      let cost = this.horizonCost(cur, c0, next, margin, goals, stack, true, hold);
      for (const e of ends) cost += this.horizonCost({ ...cur, boost: { ...b, nom: e } }, c0, next, margin, goals, stack, false, hold);
      return cost;
    };
    let bestCost = Infinity;
    let best = base;
    let planSafe = true;
    for (const dy of YAW_STEPS) {
      for (const dp of PITCH_STEPS) {
        const c0: RouteControl = { ...base, yaw: base.yaw + dy, pitch: Math.max(-90, Math.min(90, base.pitch + dp)) };
        const cost = costOf(c0, false) + Math.abs(dy) * 0.002 + Math.abs(dp) * 0.002; // prefer the plan's own control among equals
        if (cost < bestCost) {
          bestCost = cost;
          best = c0;
        }
      }
    }
    if (ends.length && bestCost >= HIT_PENALTY) {
      // every candidate followed by the plan hits for some end of the burn: the held ones, with wider turns, and a re-plan
      planSafe = false;
      for (const dy of HOLD_YAWS) {
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
  private readBoost(b: TrackerBody): void {
    if (!this.lastVel || !this.lastControl || !b.gliding || this.boost.max === 0) return;
    const c = this.lastControl;
    const on = glideVelocity(this.lastVel, c.yaw, c.pitch, true);
    const off = glideVelocity(this.lastVel, c.yaw, c.pitch, false);
    const dOn = Math.hypot(on.x - b.vel.x, on.y - b.vel.y, on.z - b.vel.z);
    const dOff = Math.hypot(off.x - b.vel.x, off.y - b.vel.y, off.z - b.vel.z);
    if (dOff < dOn * 0.5 && this.boost.nom > 0) {
      // the burn ended before the nominal: the body flew a plain glide tick
      this.boost = { ...NO_BOOST };
      this.burnEnded = true;
      this.stats.burnsRead++;
    } else if (dOn < dOff * 0.5 && this.boost.nom === 0 && this.boost.max > 0) {
      // the burn goes on past the nominal: the plan assumed it over. Track F4a: the belief's nominal moves to the middle
      // of what may be left (an end before it is read at once; one after it is read again), and the re-plan this asks
      // for branches the rest of the range (search.ts)
      this.boost = { ...this.boost, nom: Math.max(1, Math.ceil(this.boost.max / 2)) };
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
    this.stats.fired = Math.max(0, this.stats.fired - 1);
    this.fireLater = true;
  }

  /** One tick: the control to fly now from the real body. */
  tick(b: TrackerBody, now: number): TrackerOutput {
    this.stats.ticks++;
    this.readBoost(b);
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
    if (this.failed) return { control: this.holdClear(b), status: 'failed', done: false, error: 0 };
    let replan: string | undefined;
    if (!this.plan) {
      replan = this.stats.plans === 0 ? 'start' : 'next goal';
      this.request(b, now, replan);
    }
    let control: RouteControl;
    let error = 0;
    let status: TrackerStatus = 'planning';
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
      const blocked = (this.changed || (now & 3) === 0) && !this.corridorClear(i);
      const out = i >= p.states.length - 2;
      const planBoost = this.ref(i).boost.nom > 0;
      let again: string | undefined;
      if (error > (this.o.replanError ?? REPLAN_ERROR)) again = `off the reference by ${error.toFixed(2)}`;
      else if (this.corrected && error > (this.o.replanError ?? REPLAN_ERROR) / 2) again = `a correction moved the body ${error.toFixed(2)} off`;
      else if (blocked) again = 'the corridor ahead is blocked';
      else if (this.burnEnded && planBoost && this.boost.nom === 0) again = 'the rocket ended before the plan assumed';
      // Track F4a: a burn past the plan's nominal (F0: 9 to 21 ticks) was never re-planned (F2 asked only for an early end)
      else if (this.burnEnded && !planBoost && this.boost.nom > 0) again = 'the rocket burns on past the plan';
      else if (out && !p.complete) again = 'the partial plan ran out';
      else if (out) again = 'the plan ran out';
      this.corrected = false;
      this.changed = false;
      this.burnEnded = false;
      if (again && !replan) {
        replan = again;
        this.request(b, now, again);
      }
      // a plan adopted just now (an in-thread planner answers at once) starts at its own state: locate again
      const j = this.plan === p ? i : this.locate(b, now);
      this.cursor = j;
      if (blocked && !this.plan.complete && out && this.plan === p) control = this.holdClear(b);
      else {
        control = this.optimise(cur, j);
        status = 'tracking';
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
    // no powered flight without a plan being tracked, or on one that grazes a solid (PLAN_CLEAR_MIN): the plan's rocket,
    // a late one and a held one are dropped (the next safe plan fires its own), and the glide bleeds the speed
    const flying = status === 'tracking' ? this.plan : undefined;
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
        this.stats.fired++;
        this.fireLater = false;
        this.burnReplanned = false;
      } else {
        if (b.rockets > 0 && !b.gliding) this.fireLater = true;
        control = { ...control, fire: false };
      }
    }
    this.boost = burnTick(this.boost);
    this.yaw = control.yaw;
    this.lastControl = control;
    return { control, status, done: false, ...(replan ? { replan } : {}), error };
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
