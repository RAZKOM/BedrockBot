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
// glide along its heading.
import type { Vec3 } from '../../../connection/types.ts';
import { glideVelocity } from '../../input/physics.ts';
import { sweep, type RouteGrid } from './grid.ts';
import { crossesFloor, landsOn, passes, stepState, sweepGridFor } from './primitives.ts';
import { startMarginFor } from './search.ts';
import { NO_BOOST, burnTick, freshBurn, headingOf, hspeed, type BoostRange, type PrimitiveFamily, type RouteControl, type RouteGoal, type RoutePlan, type RouteRequest, type RouteState } from './types.ts';

/** Ticks of the plan ahead of the body checked against the grid every tick. */
export const LOOKAHEAD = 20;
/** The re-optimisation horizon (ticks). */
export const HORIZON = 8;
/** The distance from the reference that asks for a new plan (blocks). */
export const REPLAN_ERROR = 1.0;
const YAW_STEPS = [0, -4, 4, -8, 8, -16, 16];
const PITCH_STEPS = [0, -6, 6, -12, 12];
const HIT_PENALTY = 1000;
/** Consecutive ticks without any plan (every answer empty) before the tracker gives up. */
const PLANLESS_MAX = 40;

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
    const start = this.stateOf(b);
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
      this.o.note?.(`route: ${why}: ${p.complete ? 'plan' : `partial plan (${p.why ?? '?'})`} ${p.ticks} ticks, ${p.rockets} rockets, clearance ${p.clearance.toFixed(2)}, ${p.expanded} expanded of ${p.nodes} in ${p.ms.toFixed(0)} ms: ${p.edges.map((e) => e.name).join(' ')}`);
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
      this.planTick = now;
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

  /** Re-optimise the next control around the plan's control at index `i + 1` from the real state. */
  private optimise(cur: RouteState, i: number): RouteControl {
    const p = this.plan!;
    const next = i + 1;
    const base = next < p.controls.length ? p.controls[next]! : { ...p.controls[p.controls.length - 1]!, fire: false };
    if (!cur.gliding) return base; // the takeoff tick: as planned
    const goals = this.planGoals;
    const stack = this.o.stackRockets === true;
    const margin = startMarginFor(this.o.grid, cur, this.o.margin);
    let bestCost = Infinity;
    let best = base;
    for (const dy of YAW_STEPS) {
      for (const dp of PITCH_STEPS) {
        const c0: RouteControl = { ...base, yaw: base.yaw + dy, pitch: Math.max(-90, Math.min(90, base.pitch + dp)) };
        let s: RouteState = { ...cur, wp: this.wp - this.planWp0 };
        let cost = 0;
        for (let t = 0; t < HORIZON; t++) {
          const idx = next + t;
          const c = t === 0 ? c0 : idx < p.controls.length ? p.controls[idx]! : { ...p.controls[p.controls.length - 1]!, fire: false };
          const r = stepState(s, c, stack, undefined, this.o.grid);
          const ref = p.states[Math.min(p.states.length - 1, idx)]!.pos;
          const g = goals[r.next.wp];
          const crossing = crossesFloor(g, s.pos, r.next.pos);
          const landed = crossing && landsOn(g!, s.pos, r.next.pos, r.next.vel);
          if ((crossing && !landed) || (!landed && sweep(sweepGridFor(this.o.grid, g, s.pos), s.pos, r.next.pos, margin).hit)) {
            cost += HIT_PENALTY * (HORIZON - t);
            break;
          }
          const w = 1 / (1 + t * 0.25);
          const dx = r.next.pos.x - ref.x;
          const dyy = r.next.pos.y - ref.y;
          const dz = r.next.pos.z - ref.z;
          cost += w * (dx * dx + dyy * dyy + dz * dz);
          if (landed) break;
          while (r.next.wp < goals.length && passes(goals[r.next.wp]!, s.pos, r.next.pos)) r.next.wp++;
          s = r.next;
          if (s.wp >= goals.length) break;
        }
        cost += Math.abs(dy) * 0.002 + Math.abs(dp) * 0.002; // prefer the plan's own control among equals
        if (cost < bestCost) {
          bestCost = cost;
          best = c0;
        }
      }
    }
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
      // the burn goes on past the nominal: the plan assumed it over
      this.boost = { ...this.boost, nom: 1 };
      this.burnEnded = true;
      this.stats.burnsRead++;
    }
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
        if (g.kind === 'waypoint' ? passes(g, this.lastPos, b.pos) : b.onGround && Math.floor(b.pos.x) === g.cell.x && Math.floor(b.pos.z) === g.cell.z && Math.abs(b.pos.y - g.top) < 0.6) {
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
    if (this.failed) return { control: this.hold(b), status: 'failed', done: false, error: 0 };
    let replan: string | undefined;
    if (!this.plan) {
      replan = this.stats.plans === 0 ? 'start' : 'next goal';
      this.request(b, now, replan);
    }
    let control: RouteControl;
    let error = 0;
    let status: TrackerStatus = 'planning';
    if (this.plan) {
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
      else if (this.burnEnded && planBoost) again = 'the rocket ended before the plan assumed';
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
      if (blocked && !this.plan.complete && out && this.plan === p) control = this.hold(b);
      else {
        control = this.optimise(cur, j);
        status = 'tracking';
      }
    } else if (this.planless > 0 && b.gliding) {
      // the last answer had no edge from here: keep clear while asking again
      if (!this.pending) this.request(b, now, 'no edge from the body (evading)');
      control = this.evade(this.stateOf(b));
      status = 'holding';
    } else {
      control = this.hold(b);
      status = this.pending ? 'planning' : 'holding';
    }
    // the rocket: as the plan says, once per burn (unless rockets stack)
    if (control.fire) {
      if (b.rockets > 0 && b.gliding && (this.boost.max === 0 || this.o.stackRockets === true)) {
        this.boost = freshBurn();
        this.stats.fired++;
      } else control = { ...control, fire: false };
    }
    this.boost = burnTick(this.boost);
    this.yaw = control.yaw;
    this.lastControl = control;
    return { control, status, done: false, ...(replan ? { replan } : {}), error };
  }
}

/** The plan's horizontal speed at an index, for the log. */
export function planSpeedAt(p: RoutePlan, i: number): number {
  return hspeed(p.states[Math.min(p.states.length - 1, Math.max(0, i))]!.vel);
}
