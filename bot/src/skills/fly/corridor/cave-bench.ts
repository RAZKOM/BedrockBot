// Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)", ADR 0068): the offline cave benchmark. A real cave
// (cave.ts: the world cache's extract and the waypoints of a route walked through it) flown on stepBody by the
// underground flight as it is in the code, so a change to it is measured on the cave that killed it.
//
// Three ways to fly a route (consecutive waypoints = legs):
//   executor   each leg through the corridor executor (executor.ts, `underFly` true): the coarse layer over the
//              extract plans the corridor, the stretches and windows (stretches.ts) decide what is flown and what
//              walked, each window is a TrackerChain (drive.ts) on stepBody. The hand-offs are the live code's.
//   leg        each leg as one window from standing on its start: the bend points (stretches.ts bendPoints), the
//              landing on its end (landingGoal), the TrackerChain; nothing walked (the raw flight through the cave).
//   route      the whole route as one window: a waypoint box at every waypoint and the bends between them, the
//              landing on the last (a body that has to fly the cave from end to end).
// Every flight: a rocket's burn the same for each rocket of a run (9..21, F0's range) or drawn at random, its end told
// 3 ticks late; the rocket only with no boost left (flyStretch's rule); the glide from the second airborne input; a
// wall touch flown through (BDS keeps the glide) and scored with F0's wall damage; water ends the glide (stepBody);
// the planner in-thread with a budget (the live 600 ms / 40 000 nodes or a generous one), its answer optionally
// delayed by some ticks (the worker answers 9 to 13 ticks after the ask on the server).
// Walks (the executor's walk legs, the walk-only baseline) go through a `CaveWalk` the caller gives: the unit test and
// the script use the walk navigator in a closed loop (test/unit/skills/fly-cave-walk.ts); without one a walk is
// assumed done (moved to its cell, counted, not timed).
import { stepBody, wallImpactDamage } from '../../input/physics.ts';
import { IDLE_COMMAND, initialBody, type BlockQuery, type BodyState, type MoveCommand } from '../../input/types.ts';
import { CoarseLayerImpl } from '../../coarse/layer.ts';
import type { Vec3 } from '../../../world/types.ts';
import { rng } from '../route/courses.ts';
import { sweep } from '../route/grid.ts';
import { planRoute } from '../route/search.ts';
import type { RoutePlan, RouteGoal, RouteRequest } from '../route/types.ts';
import { BURN } from '../route/types.ts';
import type { CaveLeg, CaveWorld } from './cave.ts';
import { FlightCost } from './cost.ts';
import { STRETCH_LAND_LIBRARY, STRETCH_PLAN_MS, STRETCH_PLAN_NODES, STRETCH_WEIGHT, TrackerChain } from './drive.ts';
import { CorridorExecutor, type CorridorPorts, type CorridorReport, type StepOutcome } from './executor.ts';
import { bendGoal, bendPoints, boreMargin, landingGoal, type Window } from './stretches.ts';

/** The burns a cave leg is flown over: every burn of F0's range, 9 to 21 ticks. */
export const CAVE_BURNS: readonly number[] = Array.from({ length: BURN.max - BURN.min + 1 }, (_, i) => BURN.min + i);
/** The planner budgets: the live one (drive.ts) and a generous one. */
export const CAVE_BUDGETS = {
  live: { maxMs: STRETCH_PLAN_MS, maxNodes: STRETCH_PLAN_NODES },
  generous: { maxMs: 3000, maxNodes: 200_000 },
} as const;
export type CaveBudget = keyof typeof CAVE_BUDGETS;
/** The margin of a cave window (a bore 3 x 3 or more; the narrow places of a real cave are narrower than that). */
export const CAVE_MARGIN = boreMargin(3, 3);
/** The rockets in the hand at the start of a flight. */
export const CAVE_ROCKETS = 32;
/** A flight ends after this many ticks. */
export const CAVE_MAX_TICKS = 1500;

export interface CaveFlightOptions {
  /** Every rocket of the run burns this long, or `random` (drawn 9..21 from the seed). */
  burn: number | 'random';
  seed?: number;
  maxMs: number;
  maxNodes: number;
  /** The planner's answers arrive this many ticks after the ask (0: at once, in-thread). */
  latency?: number;
  margin?: number;
  maxTicks?: number;
  rockets?: number;
  /** The initial look yaw (default: towards the first goal). */
  yaw?: number;
  note?: (msg: string) => void;
}

export type FlightEnd = 'done' | 'ground' | 'water' | 'failed' | 'timeout' | 'unknown';

export interface FlightRun {
  end: FlightEnd;
  ticks: number;
  rockets: number;
  /** Wall touches while gliding, and their damage (F0's wallImpactDamage). */
  hits: number;
  damage: number;
  /** The least distance of the gliding box from a solid cell (sweep, no margin). */
  minClearance: number;
  /** Ticks with the body in water. */
  waterTicks: number;
  reached: number;
  goals: number;
  windows: number;
  plans: number;
  replans: number;
  partial: number;
  maxError: number;
  /** The body at the end (standing on the landing when done). */
  at: Vec3;
  /** The planned blocks: the straight distance from the start to the end through the goals. */
  blocks: number;
}

const centre = (c: Vec3): Vec3 => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The centre of a goal (the heuristic's aim). */
function goalPoint(g: RouteGoal): Vec3 {
  if (g.kind === 'landing') return { x: g.cell.x + 0.5, y: g.top, z: g.cell.z + 0.5 };
  return { x: (g.box.min.x + g.box.max.x) / 2, y: g.box.min.y, z: (g.box.min.z + g.box.max.z) / 2 };
}

/** Nothing solid: the free step a hit's damage is measured against. */
const OPEN: BlockQuery = { solidAt: () => false };

/**
 * Fly `goals` from standing at `from` (feet, a position) through the cave on stepBody with the chain of trackers
 * (drive.ts TrackerChain, the settings of flyStretch): see the file comment.
 */
export async function flyCaveWindow(world: CaveWorld, from: Vec3, goals: RouteGoal[], o: CaveFlightOptions): Promise<FlightRun> {
  const r = rng(o.seed ?? 1);
  const grid = world.grid;
  const latency = o.latency ?? 0;
  // the planner: in-thread, its answer at once or `latency` ticks after the ask
  let now = 0;
  const pending: { at: number; plan: RoutePlan; resolve: (p: RoutePlan) => void }[] = [];
  const plan = (req: RouteRequest): RoutePlan | Promise<RoutePlan> => {
    const p = planRoute(req, grid);
    if (latency <= 0) return p;
    return new Promise<RoutePlan>((resolve) => pending.push({ at: now + latency, plan: p, resolve }));
  };
  const first = goals[0] ? goalPoint(goals[0]) : from;
  const yaw = o.yaw ?? (Math.atan2(-(first.x - from.x), first.z - from.z) * 180) / Math.PI;
  const chain = new TrackerChain({ grid, margin: o.margin ?? CAVE_MARGIN, goals, plan, maxNodes: o.maxNodes, maxMs: o.maxMs, weight: STRETCH_WEIGHT, landLibrary: STRETCH_LAND_LIBRARY, yaw, ...(o.note ? { note: o.note } : {}) });
  let body: BodyState = initialBody({ ...from }, true);
  const rockets0 = o.rockets ?? CAVE_ROCKETS;
  let rockets = rockets0;
  const endsAt: number[] = [];
  let hits = 0;
  let damage = 0;
  let waterTicks = 0;
  let minClearance = Infinity;
  let end: FlightEnd = 'timeout';
  let falling = 0;
  const max = o.maxTicks ?? CAVE_MAX_TICKS;
  let t = 1;
  for (; t <= max; t++) {
    now = t;
    if (pending.length) {
      for (const q of pending.filter((q) => q.at <= t)) q.resolve(q.plan);
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.at <= t) pending.splice(i, 1);
      await Promise.resolve(); // the tracker's then() runs before its tick
      await Promise.resolve();
    }
    while (endsAt.length && endsAt[0]! <= t) {
      endsAt.shift();
      chain.rocketEnded();
    }
    const out = chain.tick({ pos: body.pos, vel: body.vel, gliding: body.gliding === true, onGround: body.onGround, rockets, boostTicks: body.boostTicks ?? 0 }, t);
    if (out.done) {
      end = 'done';
      break;
    }
    if (out.status === 'failed') {
      end = 'failed';
      break;
    }
    const c = out.control;
    if (body.onGround) falling = 0;
    else falling++;
    const cmd: MoveCommand = { ...IDLE_COMMAND, yaw: c.yaw, pitch: c.pitch, jump: c.jump === true, glide: body.gliding === true || body.onGround || falling >= 2 };
    // flyStretch's rule: a rocket only with no boost left on the loop
    if (c.fire && rockets > 0 && (body.boostTicks ?? 0) === 0 && body.gliding === true) {
      const burn = o.burn === 'random' ? BURN.min + Math.floor(r() * (BURN.max - BURN.min + 1)) : o.burn;
      cmd.boostStart = burn;
      rockets--;
      endsAt.length = 0;
      endsAt.push(t + burn + 3);
    }
    const before = body;
    const step = stepBody(body, cmd, world.query);
    if (!step.simulated) {
      end = 'unknown';
      break;
    }
    body = step.state;
    if (body.inWater) waterTicks++;
    if (before.gliding) {
      // (the touchdown's tick ends on the floor: not a clearance)
      if (!body.onGround) {
        const sw = sweep(grid, before.pos, body.pos, 0);
        if (sw.clearance < minClearance) minClearance = sw.clearance;
      }
      if (body.collidedHorizontally || (body.collidedVertically && !body.onGround)) {
        hits++;
        const free = stepBody(before, cmd, OPEN).state;
        damage += wallImpactDamage(Math.hypot(free.vel.x, free.vel.z), Math.hypot(body.vel.x, body.vel.z));
      }
      if (body.inWater) {
        end = 'water';
        break;
      }
      if (body.onGround) {
        const fin = chain.tick({ pos: body.pos, vel: body.vel, gliding: false, onGround: true, rockets, boostTicks: 0 }, t + 1);
        end = fin.done ? 'done' : 'ground';
        break;
      }
    }
  }
  // let a standing body settle (a landing's slide) before it is measured
  for (let k = 0; k < 20 && body.onGround && Math.hypot(body.vel.x, body.vel.z) > 0.003; k++) body = stepBody(body, IDLE_COMMAND, world.query).state;
  const s = chain.stats;
  let blocks = 0;
  let p = from;
  for (const g of goals) {
    const q = goalPoint(g);
    blocks += dist(p, q);
    p = q;
  }
  return {
    end,
    ticks: Math.min(t, max),
    rockets: rockets0 - rockets,
    hits,
    damage,
    minClearance: minClearance === Infinity ? 0 : minClearance,
    waterTicks,
    reached: chain.reached,
    goals: goals.length,
    windows: chain.windows,
    plans: s.plans,
    replans: s.replans,
    partial: s.partial,
    maxError: s.maxError,
    at: { ...body.pos },
    blocks,
  };
}

/** The goals of a flight through `stops` (feet cells): the bend points between consecutive stops, a waypoint box at each inner stop, the landing on the last. */
export function caveGoals(world: CaveWorld, stops: readonly Vec3[]): RouteGoal[] {
  const goals: RouteGoal[] = [];
  for (let i = 1; i < stops.length; i++) {
    const a = centre(stops[i - 1]!);
    const b = centre(stops[i]!);
    for (const c of bendPoints(world.solid, a, b)) goals.push(bendGoal(c));
    goals.push(i === stops.length - 1 ? landingGoal(stops[i]!, world.solid) : bendGoal(stops[i]!));
  }
  return goals;
}

// ---- the walk ------------------------------------------------------------------------------------------

/** A walk from a standing body to a feet cell (the walk navigator in a closed loop, or a stand-in). */
export type CaveWalk = (from: Vec3, to: Vec3) => Promise<{ ok: boolean; at: Vec3; ticks: number; reason?: string; waterTicks?: number }>;

/** No walk simulated: the body is put on the cell (the walk counted, not timed). */
export const assumedWalk: CaveWalk = (_from, to) => Promise.resolve({ ok: true, at: centre(to), ticks: 0, reason: 'assumed' });

// ---- the executor ------------------------------------------------------------------------------------------

export interface ExecutorRun {
  leg: string;
  ok: boolean;
  reason?: string;
  report: CorridorReport;
  /** The windows flown (each a FlightRun) and the walks. */
  flights: FlightRun[];
  walks: { to: Vec3; ok: boolean; ticks: number; blocks: number; reason?: string }[];
  /** The sky stretches (cruises): not flown offline, the body put on their cell. */
  skies: number;
  /** Totals over the flights. */
  ticks: number;
  rockets: number;
  hits: number;
  damage: number;
  minClearance: number;
  partial: number;
  replans: number;
  waterTicks: number;
  flownBlocks: number;
  walkBlocks: number;
  walkTicks: number;
  ms: number;
}

/** A coarse layer over the cave with flight's costs (what `!fly` plans on). */
export function caveLayer(world: CaveWorld): CoarseLayerImpl {
  const layer = new CoarseLayerImpl(world.coarse);
  layer.setCost('fly', new FlightCost());
  return layer;
}

/** Fly `leg` through the corridor executor (underFly true unless said otherwise), each window on stepBody. */
export async function runCaveExecutor(world: CaveWorld, leg: CaveLeg, o: CaveFlightOptions & { walk?: CaveWalk; underFly?: boolean; layer?: CoarseLayerImpl; planMs?: number }): Promise<ExecutorRun> {
  const t0 = performance.now();
  const layer = o.layer ?? caveLayer(world);
  const walk = o.walk ?? assumedWalk;
  let pos = centre(leg.from);
  const flights: FlightRun[] = [];
  const walks: ExecutorRun['walks'] = [];
  let skies = 0;
  let n = 0;
  const ports: CorridorPorts = {
    provider: layer,
    position: () => ({ ...pos }),
    dim: () => world.extract.dim,
    solid: world.solid,
    loaded: () => true,
    waitLoaded: () => Promise.resolve(true),
    flySky: (cell) => {
      // the cruise is not benched here (the cave's sky is its mouth): the body is put on the cell
      skies++;
      pos = centre(cell);
      return Promise.resolve({ ok: true, at: { ...pos }, reason: 'sky not flown offline' });
    },
    flyUnder: async (win: Window): Promise<StepOutcome> => {
      const f = await flyCaveWindow(world, pos, win.goals, { ...o, seed: (o.seed ?? 1) * 97 + n++, margin: win.margin });
      flights.push(f);
      pos = f.at;
      return { ok: f.end === 'done', reason: f.end, at: { ...pos }, rockets: f.rockets, replans: f.replans, ticks: f.ticks };
    },
    walk: async (cell) => {
      const w = await walk(pos, cell);
      walks.push({ to: cell, ok: w.ok, ticks: w.ticks, blocks: Math.hypot(cell.x + 0.5 - pos.x, cell.z + 0.5 - pos.z), ...(w.reason ? { reason: w.reason } : {}) });
      pos = w.at;
      return { ok: w.ok, at: { ...pos }, ticks: w.ticks, ...(w.reason ? { reason: w.reason } : {}) };
    },
    stopped: () => false,
  };
  const ex = new CorridorExecutor(ports, { underFly: o.underFly ?? true, ...(o.planMs !== undefined ? { planMs: o.planMs } : {}) });
  const report = await ex.run(leg.to, leg.name);
  const sum = (f: (r: FlightRun) => number): number => flights.reduce((a, r) => a + f(r), 0);
  return {
    leg: leg.name,
    ok: report.ok,
    ...(report.reason ? { reason: report.reason } : {}),
    report,
    flights,
    walks,
    skies,
    ticks: sum((f) => f.ticks),
    rockets: sum((f) => f.rockets),
    hits: sum((f) => f.hits),
    damage: sum((f) => f.damage),
    minClearance: flights.length ? Math.min(...flights.map((f) => f.minClearance)) : Infinity,
    partial: sum((f) => f.partial),
    replans: sum((f) => f.replans),
    waterTicks: sum((f) => f.waterTicks),
    flownBlocks: sum((f) => f.blocks),
    walkBlocks: walks.reduce((a, w) => a + w.blocks, 0),
    walkTicks: walks.reduce((a, w) => a + w.ticks, 0),
    ms: performance.now() - t0,
  };
}

// ---- the score --------------------------------------------------------------------------------------------

/** A leg's flights over the burns, summed up (the scoreboard's row). */
export interface CaveScore {
  name: string;
  runs: number;
  done: number;
  /** Done with no wall touch. */
  clean: number;
  hit: number;
  /** Means over the runs. */
  ticks: number;
  rockets: number;
  damage: number;
  partial: number;
  replans: number;
  /** The least clearance over every run. */
  minClearance: number;
  /** The ends that were not `done`, counted. */
  ends: Record<string, number>;
}

export function caveScore(name: string, rs: readonly FlightRun[]): CaveScore {
  const n = Math.max(1, rs.length);
  const mean = (f: (r: FlightRun) => number): number => rs.reduce((a, r) => a + f(r), 0) / n;
  const ends: Record<string, number> = {};
  for (const r of rs) if (r.end !== 'done') ends[r.end] = (ends[r.end] ?? 0) + 1;
  return {
    name,
    runs: rs.length,
    done: rs.filter((r) => r.end === 'done').length,
    clean: rs.filter((r) => r.end === 'done' && r.hits === 0).length,
    hit: rs.filter((r) => r.hits > 0).length,
    ticks: mean((r) => r.ticks),
    rockets: mean((r) => r.rockets),
    damage: mean((r) => r.damage),
    partial: mean((r) => r.partial),
    replans: mean((r) => r.replans),
    minClearance: rs.length ? Math.min(...rs.map((r) => r.minClearance)) : 0,
    ends,
  };
}

/** One markdown row: | leg | done | clean | hit | ticks | rockets | damage | min clearance | partial | re-plans | other ends | */
export function caveScoreRow(s: CaveScore): string {
  const ends = Object.entries(s.ends).map(([k, v]) => `${k} ${v}`).join(', ');
  return `| ${s.name} | ${s.done}/${s.runs} | ${s.clean} | ${s.hit} | ${s.ticks.toFixed(0)} | ${s.rockets.toFixed(1)} | ${s.damage.toFixed(1)} | ${s.minClearance.toFixed(2)} | ${s.partial.toFixed(1)} | ${s.replans.toFixed(1)} | ${ends || '-'} |`;
}

export const CAVE_SCORE_HEADER = '| leg | done | clean | hit | ticks | rockets | damage | min clearance | partial | re-plans | other ends |\n|---|---|---|---|---|---|---|---|---|---|---|';
