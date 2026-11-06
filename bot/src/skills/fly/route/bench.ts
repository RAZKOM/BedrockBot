// Track F2: the offline benchmark harness (docs/flight.md "Route planner", "Benchmark"): a course flown on
// stepBody (the own physics engine: the glide formula with collisions, the server matches it within 0.002 a
// tick) by the tracker, with the rocket's burn drawn at random in 12..18 per rocket and its end told to the
// tracker 3 ticks late, as the server's remove_entity arrives. Metrics: success (every goal passed by the
// real body), hits (a collision while gliding), the least clearance of the real body from any solid, ticks,
// rockets, the planning time and effort, the tracker's largest error from its reference. Track F4a: the obstacle
// courses' legs flown in a chain (`flyLegs`), hits flown through and scored as the model's wall damage.
import { GLIDE, stepBody, wallImpactDamage } from '../../input/physics.ts';
import { IDLE_COMMAND, initialBody, type BlockQuery, type BodyState, type MoveCommand } from '../../input/types.ts';
import { yawDir } from '../plan.ts';
import { rng, type Course } from './courses.ts';
import { gridOf, sweep, type RouteGrid } from './grid.ts';
import { planRoute } from './search.ts';
import { checkRobust } from './robust.ts';
import { RouteTracker, type TrackerStats } from './tracker.ts';
import { BURN, headingOf, type PrimitiveFamily, type RoutePlan, type RouteRequest } from './types.ts';

export interface BenchOptions {
  seed?: number;
  /** The burn of every rocket: `random` (12..18 from the seed) or a fixed number of ticks. */
  burn?: 'random' | number;
  maxTicks?: number;
  maxNodes?: number;
  maxMs?: number;
  stackRockets?: boolean;
  /** Track F4a: TrackerOptions.lead (the first plan of a gliding body asked that many ticks ahead, the hold flown till then). */
  lead?: number;
  families?: readonly PrimitiveFamily[];
  /** Track F3: the heuristic's weight and the edge set by name of every request (a route landing's tracker flies with `landing` and ROUTE_WEIGHT). */
  weight?: number;
  library?: RouteRequest['library'];
  /** The planner sees only cells within this many blocks of the body (unknown = solid beyond); the tracker is told of "loaded chunks" every 4 blocks of travel. */
  view?: number;
  /** Check the first plan's robustness over the burn range (costs a few ms per rocket). */
  robust?: boolean;
  note?: (msg: string) => void;
  /** Every tick: the body before, the control, the body after, the tracker's output. */
  trace?: (t: number, before: BodyState, cmd: MoveCommand, after: BodyState, out: { status: string; error: number; replan?: string }) => void;
  /**
   * Track F4a: fly on after a hit (the obstacle course's score: the server's glide survives a scrape), adding the
   * wall damage of each (physics.ts wallImpactDamage); default false: the first hit ends the run.
   */
  continueOnHit?: boolean;
  /** Track F4a: the body to start from (a chained leg goes on from the last one's), instead of the course's start. */
  body?: BodyState;
  /** Track F4a: the rockets in the hand at the start (a chained leg: what the last one left), instead of the course's. */
  rockets?: number;
  /** The tracker the run flies with (the tests and the debugging scripts read its plan). */
  onTracker?: (t: RouteTracker) => void;
}

export type BenchEnd = 'done' | 'ground' | 'hit' | 'timeout' | 'failed' | 'unknown';

export interface BenchResult {
  name: string;
  success: boolean;
  end: BenchEnd;
  hits: number;
  /** The horizontal speed at the first hit. */
  hitSpeed?: number;
  minClearance: number;
  ticks: number;
  rockets: number;
  stats: TrackerStats;
  /** The first plan checked over the burn range. */
  robust?: { robust: boolean; reaches: boolean; clearance: number; branches: number };
  goals: number;
  reached: number;
  /** Track F4a: the model's wall damage over the run (with continueOnHit, every hit's; else the first's). */
  damage: number;
  /** Track F4a: the body at the end and the rockets left (the next chained leg starts there). */
  body: BodyState;
  rocketsLeft: number;
}

/** The planner the benchmark gives the tracker: the in-thread search, with the first plan's robust check when asked. */
export function benchPlanner(grid: RouteGrid, o: BenchOptions, out: { first?: RoutePlan; robust?: BenchResult['robust'] }): (req: RouteRequest) => RoutePlan {
  return (req) => {
    const p = planRoute(req, grid);
    if (!out.first) {
      out.first = p;
      if (o.robust && p.rockets > 0) {
        const r = checkRobust(req.start, p, grid, req.margin, req.goals, req.stackRockets === true);
        out.robust = { robust: r.robust, reaches: r.reaches, clearance: r.clearance, branches: r.branches.length };
      }
    }
    return p;
  };
}

/** Fly `course` offline: see the file comment. */
export function flyCourse(course: Course, o: BenchOptions = {}): BenchResult {
  const r = rng(o.seed ?? 1);
  const world: BlockQuery = course.world;
  const known = gridOf(world);
  let at = { ...course.start.pos };
  const grid: RouteGrid = o.view === undefined ? known : { solid: (x, y, z) => (Math.hypot(x + 0.5 - at.x, z + 0.5 - at.z) > o.view! ? true : known.solid(x, y, z)) };
  const first: { first?: RoutePlan; robust?: BenchResult['robust'] } = {};
  const tracker = new RouteTracker({
    grid,
    margin: course.margin,
    goals: course.goals,
    plan: benchPlanner(grid, o, first),
    maxNodes: o.maxNodes ?? 40_000,
    maxMs: o.maxMs ?? 2000,
    ...(o.stackRockets !== undefined ? { stackRockets: o.stackRockets } : {}),
    ...(o.lead !== undefined ? { lead: o.lead } : {}),
    ...(o.families ? { families: o.families } : {}),
    ...(o.weight !== undefined ? { weight: o.weight } : {}),
    ...(o.library !== undefined ? { library: o.library } : course.library !== undefined ? { library: course.library } : {}),
    ...(o.weight === undefined && course.weight !== undefined ? { weight: course.weight } : {}),
    yaw: o.body ? headingOf(o.body.vel, course.start.yaw) : course.start.yaw,
    ...(o.note ? { note: o.note } : {}),
  });
  o.onTracker?.(tracker);
  const s = course.start;
  let body: BodyState = o.body ? { ...o.body } : initialBody(s.pos, s.standing === true);
  if (!o.body && !s.standing) {
    const d = yawDir(s.yaw);
    body = { ...body, gliding: true, onGround: false, vel: { x: d.x * s.speed, y: -0.1, z: d.z * s.speed } };
  }
  const rockets0 = o.rockets ?? s.rockets;
  let rockets = rockets0;
  let hits = 0;
  let damage = 0;
  let hitSpeed: number | undefined;
  let minClearance = Infinity;
  let end: BenchEnd = 'timeout';
  const endsAt: number[] = [];
  let lastLoad = { ...at };
  let falling = 0;
  const max = o.maxTicks ?? 600;
  let t = 1;
  for (; t <= max; t++) {
    // the server's late notice of the rocket's end
    while (endsAt.length && endsAt[0]! <= t) {
      endsAt.shift();
      tracker.rocketEnded();
    }
    if (o.view !== undefined && Math.hypot(body.pos.x - lastLoad.x, body.pos.z - lastLoad.z) >= 4) {
      lastLoad = { ...body.pos };
      tracker.noteWorldChange();
    }
    at = { ...body.pos };
    const out = tracker.tick({ pos: body.pos, vel: body.vel, gliding: body.gliding === true, onGround: body.onGround, rockets }, t);
    if (out.done) {
      end = 'done';
      break;
    }
    if (out.status === 'failed') {
      end = 'failed';
      break;
    }
    const c = out.control;
    // the glide is wanted throughout; after a jump the server refuses the request on the first airborne input and takes it
    // from the second (Track F0, docs/flight-envelope.md section 8), so the harness withholds the model's glide on the
    // first airborne step (stepBody itself would glide from it)
    if (body.onGround) falling = 0;
    else falling++;
    const glideNow = body.gliding === true || body.onGround || falling >= 2;
    const cmd: MoveCommand = { ...IDLE_COMMAND, yaw: c.yaw, pitch: c.pitch, jump: c.jump === true, glide: glideNow };
    if (c.fire && rockets > 0) {
      const burn = o.burn === undefined || o.burn === 'random' ? BURN.min + Math.floor(r() * (BURN.max - BURN.min + 1)) : o.burn;
      // a rocket used while one burns (in its tail, or `stackRockets`): the boost is the union of the lifetimes (Track
      // F0); the driver tells the tracker of the last removal only (rocket.ts RocketHand), so a notice of an earlier
      // rocket still on its way is dropped
      const left = body.boostTicks ?? 0;
      cmd.boostStart = Math.max(burn, left);
      rockets--;
      endsAt.length = 0;
      endsAt.push(t + Math.max(burn, left) + 3);
    }
    const before = body;
    const step = stepBody(body, cmd, world);
    if (!step.simulated) {
      end = 'unknown';
      break;
    }
    body = step.state;
    o.trace?.(t, before, cmd, body, { status: out.status, error: out.error, ...(out.replan ? { replan: out.replan } : {}) });
    if (before.gliding) {
      const sw = sweep(known, before.pos, body.pos, 0);
      if (sw.clearance < minClearance) minClearance = sw.clearance;
      if (body.collidedHorizontally || (body.collidedVertically && !body.onGround)) {
        hits++;
        hitSpeed ??= Math.hypot(before.vel.x, before.vel.z);
        // the speed the glide step gave before the wall clipped it: the same step through empty space
        const free = stepBody(before, cmd, OPEN).state;
        damage += wallImpactDamage(Math.hypot(free.vel.x, free.vel.z), Math.hypot(body.vel.x, body.vel.z));
        if (!o.continueOnHit || !body.gliding) {
          end = 'hit';
          break;
        }
      }
      if (body.onGround) {
        // the glide ended on the ground: a landing goal is judged by the tracker next tick, anything else failed
        const g = course.goals[tracker.reached];
        if (g?.kind !== 'landing') {
          end = 'ground';
          break;
        }
      }
    }
  }
  if (end === 'done' || end === 'ground') {
    // the last tick's goal check
    const out = tracker.tick({ pos: body.pos, vel: body.vel, gliding: body.gliding === true, onGround: body.onGround, rockets }, t + 1);
    if (out.done) end = 'done';
  }
  return {
    name: course.name,
    success: end === 'done',
    end,
    hits,
    ...(hitSpeed !== undefined ? { hitSpeed } : {}),
    minClearance: minClearance === Infinity ? 0 : minClearance,
    ticks: Math.min(t, max),
    rockets: rockets0 - rockets,
    stats: tracker.stats,
    ...(first.robust ? { robust: first.robust } : {}),
    goals: course.goals.length,
    reached: tracker.reached,
    damage,
    body,
    rocketsLeft: rockets,
  };
}

/** Nothing solid: the free step a hit's damage is measured against. */
const OPEN: BlockQuery = { solidAt: () => false };

/**
 * Track F4a: fly the legs of an obstacle course in order (route/courses.ts layoutCourses): a chained leg starts from
 * the body and the rockets the last one ended with when that one was done, from its own start otherwise (a stack or
 * a shaft leg: from its hand-over entry). Hits are flown through and scored (`continueOnHit`).
 */
export function flyLegs(legs: readonly Course[], o: BenchOptions = {}): BenchResult[] {
  const out: BenchResult[] = [];
  let last: BenchResult | undefined;
  legs.forEach((leg, i) => {
    const on = leg.chained && last?.success === true;
    const r = flyCourse(leg, { continueOnHit: true, ...o, seed: (o.seed ?? 1) * 31 + i, ...(on ? { body: last!.body, rockets: last!.rocketsLeft } : {}) });
    out.push(r);
    last = r;
  });
  return out;
}

/** Track F4a: a course's score over runs (the tables of docs/flight.md "Obstacle course (Track F4a)"). */
export interface CourseScore {
  name: string;
  runs: number;
  /** Runs that passed every goal. */
  done: number;
  /** Runs done without a hit. */
  clean: number;
  /** Means over the runs. */
  ticks: number;
  rockets: number;
  damage: number;
  hits: number;
  replans: number;
  /** The goals passed, the least over the runs. */
  reachedMin: number;
  goals: number;
}

export function scoreOf(name: string, rs: readonly BenchResult[]): CourseScore {
  const n = Math.max(1, rs.length);
  const mean = (f: (r: BenchResult) => number): number => rs.reduce((a, r) => a + f(r), 0) / n;
  return {
    name,
    runs: rs.length,
    done: rs.filter((r) => r.success).length,
    clean: rs.filter((r) => r.success && r.hits === 0).length,
    ticks: mean((r) => r.ticks),
    rockets: mean((r) => r.rockets),
    damage: mean((r) => r.damage),
    hits: mean((r) => r.hits),
    replans: mean((r) => r.stats.replans),
    reachedMin: rs.reduce((a, r) => Math.min(a, r.reached), Infinity),
    goals: rs[0]?.goals ?? 0,
  };
}

/** One row of the score table. */
export function scoreLine(s: CourseScore): string {
  return `${s.name}: ${s.done}/${s.runs} done, ${s.clean} clean, ${s.ticks.toFixed(0)} ticks, ${s.rockets.toFixed(1)} rockets, damage ${s.damage.toFixed(1)}, ${s.hits.toFixed(1)} hits, ${s.replans.toFixed(1)} replans, goals >= ${s.reachedMin}/${s.goals}`;
}

/** The burns an obstacle course is scored over: every rocket of a run burns the same (the range's ends, its middle) or at random. */
export const COURSE_BURNS: readonly (number | 'random')[] = [BURN.min, 12, BURN.nominal, 18, BURN.max, 'random', 'random', 'random'];

/** A one-line summary of a result for the tables. */
export function benchLine(r: BenchResult): string {
  const f = r.stats.first;
  return `${r.name}: ${r.success ? 'ok' : r.end} ${r.reached}/${r.goals} goals, ${r.hits} hits${r.hitSpeed !== undefined ? ` (at ${r.hitSpeed.toFixed(2)} b/t)` : ''}, clearance ${r.minClearance.toFixed(2)}, ${r.ticks} ticks, ${r.rockets} rockets, plans ${r.stats.plans} (${r.stats.replans} re, ${r.stats.partial} partial) ${r.stats.planMs.toFixed(0)} ms, first ${f ? `${f.expanded} expanded in ${f.ms.toFixed(0)} ms${f.complete ? '' : ' partial'}` : '-'}, max error ${r.stats.maxError.toFixed(2)}${r.robust ? `, robust ${r.robust.robust ? 'yes' : 'NO'} (${r.robust.branches} branches, clearance ${r.robust.clearance.toFixed(2)})` : ''}`;
}

export const BENCH_NOMINAL_BURN = GLIDE.boostTicks;
