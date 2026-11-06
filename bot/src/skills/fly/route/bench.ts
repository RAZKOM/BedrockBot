// Track F2: the offline benchmark harness (docs/flight.md "Route planner", "Benchmark"): a course flown on
// stepBody (the own physics engine: the glide formula with collisions, the server matches it within 0.002 a
// tick) by the tracker, with the rocket's burn drawn at random in 12..18 per rocket and its end told to the
// tracker 3 ticks late, as the server's remove_entity arrives. Metrics: success (every goal passed by the
// real body), hits (a collision while gliding), the least clearance of the real body from any solid, ticks,
// rockets, the planning time and effort, the tracker's largest error from its reference.
import { GLIDE, stepBody } from '../../input/physics.ts';
import { IDLE_COMMAND, initialBody, type BlockQuery, type BodyState, type MoveCommand } from '../../input/types.ts';
import { yawDir } from '../plan.ts';
import { rng, type Course } from './courses.ts';
import { gridOf, sweep, type RouteGrid } from './grid.ts';
import { planRoute } from './search.ts';
import { checkRobust } from './robust.ts';
import { RouteTracker, type TrackerStats } from './tracker.ts';
import { BURN, type PrimitiveFamily, type RoutePlan, type RouteRequest } from './types.ts';

export interface BenchOptions {
  seed?: number;
  /** The burn of every rocket: `random` (12..18 from the seed) or a fixed number of ticks. */
  burn?: 'random' | number;
  maxTicks?: number;
  maxNodes?: number;
  maxMs?: number;
  stackRockets?: boolean;
  families?: readonly PrimitiveFamily[];
  /** The planner sees only cells within this many blocks of the body (unknown = solid beyond); the tracker is told of "loaded chunks" every 4 blocks of travel. */
  view?: number;
  /** Check the first plan's robustness over the burn range (costs a few ms per rocket). */
  robust?: boolean;
  note?: (msg: string) => void;
  /** Every tick: the body before, the control, the body after, the tracker's output. */
  trace?: (t: number, before: BodyState, cmd: MoveCommand, after: BodyState, out: { status: string; error: number; replan?: string }) => void;
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
    ...(o.families ? { families: o.families } : {}),
    yaw: course.start.yaw,
    ...(o.note ? { note: o.note } : {}),
  });
  const s = course.start;
  let body: BodyState = initialBody(s.pos, s.standing === true);
  if (!s.standing) {
    const d = yawDir(s.yaw);
    body = { ...body, gliding: true, onGround: false, vel: { x: d.x * s.speed, y: -0.1, z: d.z * s.speed } };
  }
  let rockets = s.rockets;
  let hits = 0;
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
    // the glide is wanted throughout; after a jump the server starts the glide only once the body falls, a tick after the
    // request (bds-fly3: the brain's takeoff asks on a falling tick too), so the harness withholds the model's glide until
    // the second falling tick (stepBody itself would glide from the first airborne tick)
    if (body.onGround) falling = 0;
    else if (body.vel.y < 0) falling++;
    const glideNow = body.gliding === true || body.onGround || falling >= 2;
    const cmd: MoveCommand = { ...IDLE_COMMAND, yaw: c.yaw, pitch: c.pitch, jump: c.jump === true, glide: glideNow };
    if (c.fire && rockets > 0) {
      const burn = o.burn === undefined || o.burn === 'random' ? BURN.min + Math.floor(r() * (BURN.max - BURN.min + 1)) : o.burn;
      cmd.boostStart = burn;
      rockets--;
      endsAt.push(t + burn + 3);
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
        end = 'hit';
        break;
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
    rockets: s.rockets - rockets,
    stats: tracker.stats,
    ...(first.robust ? { robust: first.robust } : {}),
    goals: course.goals.length,
    reached: tracker.reached,
  };
}

/** A one-line summary of a result for the tables. */
export function benchLine(r: BenchResult): string {
  const f = r.stats.first;
  return `${r.name}: ${r.success ? 'ok' : r.end} ${r.reached}/${r.goals} goals, ${r.hits} hits${r.hitSpeed !== undefined ? ` (at ${r.hitSpeed.toFixed(2)} b/t)` : ''}, clearance ${r.minClearance.toFixed(2)}, ${r.ticks} ticks, ${r.rockets} rockets, plans ${r.stats.plans} (${r.stats.replans} re, ${r.stats.partial} partial) ${r.stats.planMs.toFixed(0)} ms, first ${f ? `${f.expanded} expanded in ${f.ms.toFixed(0)} ms${f.complete ? '' : ' partial'}` : '-'}, max error ${r.stats.maxError.toFixed(2)}${r.robust ? `, robust ${r.robust.robust ? 'yes' : 'NO'} (${r.robust.branches} branches, clearance ${r.robust.clearance.toFixed(2)})` : ''}`;
}

export const BENCH_NOMINAL_BURN = GLIDE.boostTicks;
