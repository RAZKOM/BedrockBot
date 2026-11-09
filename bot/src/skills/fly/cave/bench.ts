// Track F5b (docs/flight.md "Cave flight (Track F5b)"): the offline cave bench. A cave trip is flown the way the
// bot flies it: the corridor executor (corridor/executor.ts) over the coarse layer's own corridor through the
// cave (the layer over the cave's TerrainSource, FlightCost registered: no waypoints given) or over a waypoint
// route (cave/route.ts WaypointProvider: the owner's waypoints as hints), each underground window flown from
// standing on stepBody by the chain of trackers (corridor/drive.ts TrackerChain) with the burn drawn at random
// (or fixed) per rocket and its end told 3 ticks late, hits flown through and scored as the envelope's wall
// damage, the cruises and walks stubbed (a cruise lands on its cell; a walk stands on its cell and is counted in
// blocks). The score: arrived, the windows (legs) flown and how many took no damage, the damage per trip and the
// worst single hit, bail-outs, rockets, ticks, walked blocks. The cave style's rules (style.ts) are on or off.
import type { Vec3 } from '../../../connection/types.ts';
import { CoarseLayerImpl, terrainSource } from '../../coarse/index.ts';
import { stepBody, wallImpactDamage } from '../../input/physics.ts';
import { IDLE_COMMAND, initialBody, type BlockQuery, type BodyState, type MoveCommand } from '../../input/types.ts';
import { FlightCost } from '../corridor/cost.ts';
import { proofOf, STRETCH_PLAN_MS, STRETCH_PLAN_NODES, STRETCH_WEIGHT, TrackerChain, windowRequest, type StretchOptions } from '../corridor/drive.ts';
import { CorridorExecutor, type CorridorPorts, type CorridorReport, type ExecutorOptions, type StepOutcome } from '../corridor/executor.ts';
import type { CorridorProvider } from '../corridor/coarse-port.ts';
import type { CellSolid, Window } from '../corridor/stretches.ts';
import type { CaveWorld } from '../corridor/cave.ts';
import type { Cave } from '../route/caves.ts';
import { rng } from '../route/courses.ts';
import { gridOf, sweep, type RouteGrid } from '../route/grid.ts';
import { sweepGridFor } from '../route/primitives.ts';
import { planRoute } from '../route/search.ts';
import type { Planner, TrackerDebug } from '../route/tracker.ts';
import { BURN, type RouteGoal, type RoutePlan } from '../route/types.ts';
import { gridOfSnapshot, snapshotFor } from '../route/worker.ts';
import { WaypointProvider, type RoutePoint } from './route.ts';
import { CAVE_STYLE, caveExecutorOptions, caveStretchOptions, type CaveStyle } from './style.ts';

export interface CaveBenchOptions {
  seed?: number;
  /** The burn of every rocket: `random` (9..21 from the seed) or a fixed number of ticks. */
  burn?: 'random' | number;
  /** The search budget per request (default the live STRETCH_PLAN_MS / STRETCH_PLAN_NODES). */
  maxMs?: number;
  maxNodes?: number;
  /** The cave style on (its windows and rules) or off (Track F4b's windows, no rules). Default on. */
  style?: boolean;
  /** Plans come back with the worker's latency (default true); false answers at once (Track F4a's bench). */
  latency?: boolean;
  /** Track F7: every plan comes back this many ticks after it was asked for (the traces' reproducible runs); default the search's own ms. */
  latencyTicks?: number;
  /** A window's tick cap. */
  maxTicks?: number;
  /** The executor's options over the style's (tests). */
  executor?: ExecutorOptions;
  note?: (msg: string) => void;
  /** Every window flown (its goals, its run). */
  onWindow?: (w: Window, r: WindowRun) => void;
  /** The style's numbers overridden (the variants of the tables). */
  variant?: Partial<CaveStyle>;
  /** Every tick of a window: the body before, the control, the body after, the tracker's output, a hit's damage. */
  trace?: (t: number, before: BodyState, cmd: MoveCommand, after: BodyState, out: { status: string; error: number; replan?: string; debug?: TrackerDebug }, hit: number | undefined) => void;
}

/** The style of a run: CAVE_STYLE with the variant's overrides (the rules merged too). */
export function styleOf(o: CaveBenchOptions): CaveStyle {
  const v = o.variant ?? {};
  return { ...CAVE_STYLE, ...v, rules: { ...CAVE_STYLE.rules, ...(v.rules ?? {}) } };
}

export type WindowEnd = 'done' | 'ground' | 'water' | 'failed' | 'timeout' | 'unknown';

export interface WindowRun {
  end: WindowEnd;
  ticks: number;
  rockets: number;
  hits: number;
  /** The wall damage over the window and the worst single hit. */
  damage: number;
  maxHit: number;
  minClearance: number;
  reached: number;
  goals: number;
  trackers: number;
  plans: number;
  replans: number;
  partial: number;
  /** The tracker rules' refusals and the bail-out. */
  refused: number;
  uncommitted: number;
  bailed: boolean;
  bailTicks: number;
  at: Vec3;
  /** The window's length (blocks) along its goals from the start. */
  blocks: number;
  /** Track F7: the tracker's time per tick on this machine (ms; the mean and the worst tick), the M4's budget question. */
  tickMs: number;
  tickMsMax: number;
}

/** The ticks a plan of `ms` takes to come back from the worker (the loop ticks on meanwhile: 50 ms a tick). */
export const latencyTicks = (ms: number): number => Math.ceil(ms / 50);

/**
 * Fly one window from standing at `from` on stepBody with the chain of trackers, the burn drawn per rocket, hits flown
 * through. As the live bot has it: the search runs over a dense snapshot of the window (route/worker.ts) and every
 * plan comes back `latencyTicks` after it was asked for (`latency`, default true: the body flies on meanwhile), except
 * the proven first plan (`firstPlan`), which is there before the takeoff.
 */
export async function flyWindow(world: BlockQuery, from: Vec3, goals: RouteGoal[], margin: number, o: CaveBenchOptions = {}, seed = o.seed ?? 1, firstPlan?: RoutePlan, planGrid: RouteGrid = gridOf(world), height?: number, floor?: CellSolid): Promise<WindowRun> {
  const r = rng(seed);
  const style: Partial<StretchOptions> & { margin: number } = (o.style ?? true) ? caveStretchOptions({ margin, ...(height !== undefined ? { height } : {}) }, styleOf(o)) : { margin };
  const req = windowRequest({ goals }, from, 16, { margin: style.margin, maxNodes: o.maxNodes, maxMs: o.maxMs });
  const grid: RouteGrid = gridOfSnapshot(snapshotFor(planGrid, req));
  const yaw = req.start.yaw;
  let t = 1;
  const pending: { at: number; resolve: (p: RoutePlan) => void; plan: RoutePlan }[] = [];
  let searchMs = 0; // (the in-thread search's time inside a tick, taken out of the tracker's tick time)
  const planner: Planner = (q) => {
    const s0 = performance.now();
    const p = planRoute(q, grid);
    searchMs += performance.now() - s0;
    if (o.latency === false) return p;
    return new Promise<RoutePlan>((resolve) => pending.push({ at: t + (o.latencyTicks ?? latencyTicks(p.ms)), resolve, plan: p }));
  };
  const chain = new TrackerChain({
    grid,
    margin: style.margin,
    goals,
    plan: planner,
    maxNodes: o.maxNodes ?? STRETCH_PLAN_NODES,
    maxMs: o.maxMs ?? STRETCH_PLAN_MS,
    weight: STRETCH_WEIGHT,
    landLibrary: 'landing',
    yaw,
    ...(style.window !== undefined ? { window: style.window } : {}),
    ...(style.rules ? { rules: style.rules } : {}),
    ...(style.riskCost !== undefined ? { riskCost: style.riskCost } : {}),
    ...(style.geodesic ? { geodesic: true } : {}),
    ...(style.pieces !== undefined ? { pieces: style.pieces } : {}),
    ...(style.midBurns ? { midBurns: true } : {}),
    ...(firstPlan ? { firstPlan } : {}),
    ...(floor ? { floor } : {}),
    ...(o.note ? { note: o.note } : {}),
  });
  let body: BodyState = initialBody({ ...from }, true);
  let rockets = 16;
  const endsAt: number[] = [];
  let hits = 0;
  let damage = 0;
  let maxHit = 0;
  let minClearance = Infinity;
  let end: WindowEnd = 'timeout';
  let falling = 0;
  let blocks = 0;
  let last = { ...from };
  const max = o.maxTicks ?? 900;
  let tickMsSum = 0;
  let tickMsMax = 0;
  let tickN = 0;
  for (; t <= max; t++) {
    while (endsAt.length && endsAt[0]! <= t) {
      endsAt.shift();
      // (Track F7: as the loop, F0 decision 4: the boost ends with the LAST rocket's removal; an earlier rocket's notice while a
      // later one still burns is no end)
      if (!endsAt.length) chain.rocketEnded();
    }
    // the plans whose worker time has passed arrive now (the tracker adopts them in a microtask)
    if (pending.some((p) => p.at <= t)) {
      for (const p of pending.filter((q) => q.at <= t)) p.resolve(p.plan);
      pending.splice(0, pending.length, ...pending.filter((q) => q.at > t));
      await Promise.resolve();
      await Promise.resolve();
    }
    const tk0 = performance.now();
    searchMs = 0;
    const out = chain.tick({ pos: body.pos, vel: body.vel, gliding: body.gliding === true, onGround: body.onGround, rockets, boostTicks: body.boostTicks ?? 0 }, t);
    const tk = Math.max(0, performance.now() - tk0 - searchMs);
    tickMsSum += tk;
    tickN++;
    if (tk > tickMsMax) tickMsMax = tk;
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
    // Track F7: a rocket goes whenever the tracker asks for one (its belief applies the plan's rule: none before the burn's
    // earliest end), as the live driver now does (drive.ts). A rocket used while one still burns extends the boost to the
    // later end (F0: the union of the two lifetimes, no stronger push). Before, the bench and the driver held every rocket
    // until the running burn's end, which the plans never assumed: the plan's reference boosted on and the body did not.
    if (c.fire && rockets > 0 && body.gliding === true) {
      const burn = o.burn === undefined || o.burn === 'random' ? BURN.min + Math.floor(r() * (BURN.max - BURN.min + 1)) : o.burn;
      cmd.boostStart = Math.max(body.boostTicks ?? 0, burn);
      rockets--;
      endsAt.push(t + burn + 3);
    } else if (c.fire) chain.fireHeld(); // Track F6: the rocket was not used (none left, not gliding yet), the belief drops its burn
    const before = body;
    const step = stepBody(body, cmd, world);
    if (!step.simulated) {
      end = 'unknown';
      break;
    }
    body = step.state;
    blocks += Math.hypot(body.pos.x - last.x, body.pos.z - last.z);
    last = { ...body.pos };
    let hit: number | undefined;
    // (Track F7: every tick to the trace, the takeoff's too: a window that never glided has rows)
    const traced = (): void => o.trace?.(t, before, cmd, body, { status: out.status, error: out.error, ...(out.replan ? { replan: out.replan } : {}), ...(out.debug ? { debug: out.debug } : {}) }, hit);
    if (!before.gliding) traced();
    if (before.gliding) {
      // the least clearance in the air (the landing cell's floor is no obstacle near it: the touchdown sinks through the
      // margin; a bail-out's sink comes down through it too)
      if (body.gliding && out.status !== 'bailing') {
        const sw = sweep(sweepGridFor(grid, goals[goals.length - 1], before.pos), before.pos, body.pos, 0);
        if (sw.clearance < minClearance) minClearance = sw.clearance;
      }
      if (body.collidedHorizontally) {
        hits++;
        const d = wallImpactDamage(Math.hypot(before.vel.x, before.vel.z), Math.hypot(body.vel.x, body.vel.z));
        damage += d;
        hit = d;
        if (d > maxHit) maxHit = d;
      } else if (body.collidedVertically && !body.onGround) {
        hits++;
        hit = 0;
      }
      traced();
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
  const s = chain.stats;
  return {
    end,
    ticks: t,
    rockets: 16 - rockets,
    hits,
    damage,
    maxHit,
    minClearance: minClearance === Infinity ? 0 : minClearance,
    reached: chain.reached,
    goals: goals.length,
    trackers: chain.windows,
    plans: s.plans,
    replans: s.replans,
    partial: s.partial,
    refused: s.refused ?? 0,
    uncommitted: s.uncommitted ?? 0,
    bailed: chain.bailing,
    bailTicks: s.bailTicks ?? 0,
    at: { ...body.pos },
    blocks,
    tickMs: tickN ? tickMsSum / tickN : 0,
    tickMsMax,
  };
}

export interface CaveTrip {
  name: string;
  arrived: boolean;
  reason?: string;
  windows: WindowRun[];
  /** Windows flown and those with no wall damage; cruises (stubbed); walks and the blocks walked. */
  legs: number;
  legsClean: number;
  /** Track F7: windows that ended on their landing cell (the chain done), not in a bail-out or on some other floor. */
  landed: number;
  /** Track F7: the tracker's worst tick (ms) over the trip's windows. */
  tickMsMax: number;
  cruises: number;
  walks: number;
  walkedBlocks: number;
  flownBlocks: number;
  damage: number;
  maxHit: number;
  hits: number;
  rockets: number;
  ticks: number;
  bailouts: number;
  water: number;
  plans: number;
  replans: number;
  /** The corridor's legs as the layer planned them; the proofs asked, the windows cut back, the walks for want of a proof. */
  corridor: string;
  proofs: number;
  cuts: number;
  unproven: number;
  ms: number;
  report: CorridorReport;
}

/** A world a trip is flown through: the body's cells (stepBody), the planner's grid (unknown solid) and the executor's cell query. */
export interface TripWorld {
  name: string;
  query: BlockQuery;
  /** The planner's grid and the executor's cells (Track F6: water is an obstacle in both), and the cells a body stands on. */
  grid: RouteGrid;
  solid: CellSolid;
  floor?: CellSolid;
}

/** A generated cave as a trip's world. */
export function tripWorldOf(cave: Cave): TripWorld {
  const blocked = (x: number, y: number, z: number): boolean => cave.world.solidAt(x, y, z) === true || (cave.world.liquidAt?.(x, y, z) ?? null) !== null;
  return { name: cave.name, query: cave.world, grid: { solid: blocked }, solid: blocked, floor: (x, y, z) => cave.world.solidAt(x, y, z) };
}

/** Track F5a's real cave (corridor/cave.ts caveWorld) as a trip's world. */
export function tripWorldOfCave(world: CaveWorld, name = 'cave'): TripWorld {
  return { name, query: world.query, grid: world.grid, solid: world.solid, floor: world.floor };
}

/** The layer over a cave's terrain, flight's prices registered. */
export function caveLayer(cave: Cave): CoarseLayerImpl {
  const layer = new CoarseLayerImpl(terrainSource(cave.terrain));
  layer.setCost('fly', new FlightCost());
  return layer;
}

/** The sky over a cave cell: the column's highest solid of the mass is above it (covered) or not. */
export function coveredIn(cave: Cave): (cell: Vec3) => boolean {
  return (cell) => {
    for (let y = cave.bounds.max.y; y > cell.y; y--) if (cave.world.solidAt(Math.floor(cell.x), y, Math.floor(cell.z))) return true;
    return false;
  };
}

/**
 * A cave trip from `start` (standing) to `goal` over `provider`'s corridors with the executor: the windows flown on
 * stepBody (flyWindow), the cruises and walks stubbed.
 */
export async function flyTrip(cave: TripWorld, provider: CorridorProvider, start: Vec3, goal: Vec3, o: CaveBenchOptions = {}, name = cave.name): Promise<CaveTrip> {
  const t0 = performance.now();
  const centre = (c: Vec3): Vec3 => ({ x: Math.floor(c.x) + 0.5, y: Math.floor(c.y), z: Math.floor(c.z) + 0.5 });
  let pos = centre(start);
  const windows: WindowRun[] = [];
  let cruises = 0;
  let walks = 0;
  let walkedBlocks = 0;
  let water = 0;
  let k = 0;
  const seed = o.seed ?? 1;
  const ports: CorridorPorts = {
    provider,
    position: () => ({ ...pos }),
    dim: () => 0,
    solid: cave.solid,
    ...(cave.floor ? { floor: cave.floor } : {}),
    loaded: () => true,
    waitLoaded: () => Promise.resolve(true),
    flySky: (cell) => {
      cruises++;
      pos = centre(cell);
      return Promise.resolve({ ok: true, at: { ...pos }, rockets: 2 });
    },
    proveWindow: (win) => {
      const st = styleOf(o);
      const on = o.style ?? true;
      // (Track F6: the proof's request prices the risk and measures the way as the window's trackers will)
      const so = on ? caveStretchOptions(win, st) : { margin: win.margin };
      const req = windowRequest(win, pos, 16, { ...so, maxNodes: st.proveNodes, maxMs: o.maxMs === undefined ? st.proveMs : Math.max(o.maxMs, st.proveMs) });
      const g = gridOfSnapshot(snapshotFor(cave.grid, req));
      const p = planRoute(req, g);
      o.note?.(`proof: ${p.complete ? 'complete' : `partial (${p.why ?? '?'})`} ${p.reached}/${win.goals.length} goals, ${p.ticks} ticks, ${p.rockets} rockets, clearance ${p.clearance.toFixed(2)}, ${p.expanded} expanded in ${p.ms.toFixed(0)} ms`);
      return Promise.resolve(proofOf(p));
    },
    flyUnder: async (win, _label, plan) => {
      const r = await flyWindow(cave.query, pos, win.goals, win.margin, o, seed * 97 + ++k, plan, cave.grid, win.height, cave.floor);
      windows.push(r);
      o.onWindow?.(win, r);
      if (r.end === 'water') water++;
      pos = { ...r.at };
      // a body in water or on a floor it cannot stand on (the bench): the nearest cell under it is where it stands
      pos.y = Math.floor(pos.y + 1e-6);
      const out: StepOutcome = { ok: r.end === 'done', ...(r.end === 'done' ? {} : { reason: r.end }), at: { ...pos }, rockets: r.rockets, replans: r.replans, ticks: r.ticks, ...(r.bailed ? { bailed: true } : {}) };
      return out;
    },
    walk: (cell) => {
      walks++;
      walkedBlocks += Math.hypot(cell.x + 0.5 - pos.x, cell.z + 0.5 - pos.z);
      pos = centre(cell);
      return Promise.resolve({ ok: true, at: { ...pos } });
    },
    stopped: () => false,
    // the executor's own lines go to the note too (the trip's steps, the proofs, the cuts)
    ...(o.note ? { log: { debug() {}, info: (m: string) => o.note!(m), warn: (m: string) => o.note!(m), error: (m: string) => o.note!(m) } } : {}),
  };
  const ex = new CorridorExecutor(ports, { ...caveExecutorOptions(o.style ?? true, styleOf(o)), ...(o.executor ?? {}) });
  const report = await ex.run({ x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) }, name);
  const sum = (f: (w: WindowRun) => number): number => windows.reduce((a, w) => a + f(w), 0);
  return {
    name,
    arrived: report.ok,
    ...(report.reason ? { reason: report.reason } : {}),
    windows,
    legs: windows.length,
    legsClean: windows.filter((w) => w.damage === 0).length,
    landed: windows.filter((w) => w.end === 'done').length,
    tickMsMax: windows.reduce((a, w) => Math.max(a, w.tickMsMax), 0),
    cruises,
    walks,
    walkedBlocks,
    flownBlocks: sum((w) => w.blocks),
    damage: sum((w) => w.damage),
    maxHit: windows.reduce((a, w) => Math.max(a, w.maxHit), 0),
    hits: sum((w) => w.hits),
    rockets: sum((w) => w.rockets),
    ticks: sum((w) => w.ticks),
    bailouts: windows.filter((w) => w.bailed).length,
    water,
    plans: report.plans,
    replans: report.replans,
    corridor: report.legs.map((l) => `${l.how} ${l.blocks}`).join(', '),
    proofs: report.proofs,
    cuts: report.cuts,
    unproven: report.unproven,
    ms: performance.now() - t0,
    report,
  };
}

/** The cave flown on the coarse layer's own corridor from its mouth cell to its goal: no waypoints. */
export function flyCaveCorridor(cave: Cave, o: CaveBenchOptions = {}): Promise<CaveTrip> {
  return flyTrip(tripWorldOf(cave), caveLayer(cave), cave.start, cave.goal, o, `${cave.name} (corridor)`);
}

/** The cave flown along its waypoints (the generator's floor cells every 20 blocks: the stand-in for the owner's). */
export function flyCaveWaypoints(cave: Cave, o: CaveBenchOptions = {}, points: readonly RoutePoint[] = cave.waypoints.map((c, i) => ({ name: `wp_${i}`, cell: c }))): Promise<CaveTrip> {
  const provider = new WaypointProvider(points, { covered: coveredIn(cave) });
  return flyTrip(tripWorldOf(cave), provider, points[0]!.cell, points[points.length - 1]!.cell, o, `${cave.name} (waypoints)`);
}

/** The damage bands of the distribution (the upper bound of each; the last is open). */
export const DAMAGE_BANDS: readonly number[] = [0, 1, 3, 6, 10, 20];

export interface CaveScore {
  runs: number;
  arrived: number;
  /** Trips whose damage reached a death (20, no healing between windows), and the worst single hit over the set. */
  fatal: number;
  maxHit: number;
  legs: number;
  legsClean: number;
  /** Track F7: windows that ended on their landing cell, and the tracker's worst tick (ms) over the set. */
  landed: number;
  tickMsMax: number;
  /** Trips per damage band (DAMAGE_BANDS: 0, (0, 1], (1, 3], (3, 6], (6, 10], (10, 20], over 20). */
  bands: number[];
  damage: number;
  rockets: number;
  ticks: number;
  bailouts: number;
  water: number;
  walkedBlocks: number;
  flownBlocks: number;
}

/** The health the bot starts a trip with (a death: this much damage over one trip). */
export const FATAL_DAMAGE = 20;

export function scoreCaves(trips: readonly CaveTrip[]): CaveScore {
  const n = Math.max(1, trips.length);
  const mean = (f: (t: CaveTrip) => number): number => trips.reduce((a, t) => a + f(t), 0) / n;
  const bands = new Array<number>(DAMAGE_BANDS.length + 1).fill(0);
  for (const t of trips) {
    let i = DAMAGE_BANDS.findIndex((b) => t.damage <= b);
    if (i < 0) i = DAMAGE_BANDS.length;
    bands[i]!++;
  }
  return {
    runs: trips.length,
    arrived: trips.filter((t) => t.arrived).length,
    fatal: trips.filter((t) => t.damage >= FATAL_DAMAGE || t.maxHit >= FATAL_DAMAGE).length,
    maxHit: trips.reduce((a, t) => Math.max(a, t.maxHit), 0),
    legs: trips.reduce((a, t) => a + t.legs, 0),
    legsClean: trips.reduce((a, t) => a + t.legsClean, 0),
    landed: trips.reduce((a, t) => a + (t.landed ?? 0), 0),
    tickMsMax: trips.reduce((a, t) => Math.max(a, t.tickMsMax ?? 0), 0),
    bands,
    damage: mean((t) => t.damage),
    rockets: mean((t) => t.rockets),
    ticks: mean((t) => t.ticks),
    bailouts: trips.reduce((a, t) => a + t.bailouts, 0),
    water: trips.reduce((a, t) => a + t.water, 0),
    walkedBlocks: mean((t) => t.walkedBlocks),
    flownBlocks: mean((t) => t.flownBlocks),
  };
}

export function caveScoreLine(name: string, s: CaveScore): string {
  const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(0)}%` : '-');
  return `${name}: ${s.arrived}/${s.runs} arrived (${pct(s.arrived, s.runs)}), ${s.fatal} fatal, legs ${s.legsClean}/${s.legs} clean (${pct(s.legsClean, s.legs)}), landed ${s.landed}/${s.legs} (${pct(s.landed, s.legs)}), damage mean ${s.damage.toFixed(2)} max hit ${s.maxHit.toFixed(1)}, bands [${s.bands.join(' ')}], ${s.bailouts} bail-outs, ${s.water} water, ${s.rockets.toFixed(1)} rockets, ${s.ticks.toFixed(0)} ticks, flown ${s.flownBlocks.toFixed(0)} walked ${s.walkedBlocks.toFixed(0)} blocks, worst tick ${s.tickMsMax.toFixed(1)} ms`;
}

export function caveTripLine(t: CaveTrip): string {
  return `${t.name}: ${t.arrived ? 'arrived' : `gave up (${t.reason ?? '?'})`}, ${t.legs} windows (${t.legsClean} clean, ${t.landed} landed), ${t.cruises} cruises, ${t.walks} walks (${t.walkedBlocks.toFixed(0)} blocks), flown ${t.flownBlocks.toFixed(0)}, damage ${t.damage.toFixed(1)} (max hit ${t.maxHit.toFixed(1)}, ${t.hits} hits), ${t.bailouts} bail-outs, ${t.water} water, ${t.rockets} rockets, ${t.ticks} ticks, ${t.plans} corridor plans (${t.replans} re), ${t.proofs} proofs (${t.cuts} cut, ${t.unproven} unproven), ${(t.ms / 1000).toFixed(1)} s [${t.corridor}]`;
}

/** The burns a cave is scored over: the range's ends and middle, and random draws (as the obstacle course's COURSE_BURNS). */
export const CAVE_BURNS: readonly (number | 'random')[] = [BURN.min, 12, BURN.nominal, 18, BURN.max, 'random', 'random', 'random'];
