// Track F4b (docs/flight.md "Corridor flight"): the underground stretch of a corridor flown on the route
// planner (ADR 0058) from standing, a chain of trackers along it.
//
// One RouteTracker plans every request through all its goals to the last, so a stretch of 150 blocks
// gets partial plans (the 2 s budget runs out half way) and the tail of a partial plan can leave the body
// where no edge makes the next bend (measured offline on the corridor world: every window up to 96 blocks
// flew and landed, 128 and more hit after the straight). The chain cuts the stretch's goals into windows of
// CHAIN_WINDOW goals that overlap by one: when the active tracker has CHAIN_AHEAD goals left the next one
// is made (its first plan asked for from the body's state then) and ticked alongside without flying (it
// holds until it has a plan, so it fires nothing and its goal count stays true); the moment its plan arrives
// it takes over (the burning rocket seeded into it) and the old one is dropped. Only the last window lands.
// Each plan is a complete one of about 60 to 80 blocks; the receding horizon is the trackers' own re-plans.
//
// `flyStretch` binds the chain to the InputLoop for one stretch the way route/live.ts `flyRoute` binds one
// tracker (the same rocket plumbing, rocket.ts RocketHand), plus: the world's chunk arrivals tell the
// trackers (noteWorldChange), and a correction that puts the server's body more than HELD_ERROR behind the
// local one while gliding is counted as the server holding the body (a chunk it has not loaded: ADR 0055),
// with one note naming the chunk edge.
import type { Vec3 } from '../../../connection/types.ts';
import { silentLogger, type Logger } from '../../../log.ts';
import type { FlightLoop } from '../controller.ts';
import { RocketHand, type RocketDeps } from '../rocket.ts';
import { sweep, type RouteGrid } from '../route/grid.ts';
import { planRoute } from '../route/search.ts';
import { RouteTracker, type Planner, type TrackerBody, type TrackerOutput, type TrackerStats } from '../route/tracker.ts';
import type { RouteGoal, RouteRequest } from '../route/types.ts';

/** Goals per tracker of the chain, and how many goals before the active one's end the next one is made. */
export const CHAIN_WINDOW = 5;
export const CHAIN_AHEAD = 2;
/** The search budget per request and the heuristic's weight (Track F3's route weight: the greedy search finds a bore's plan in a few hundred nodes). */
export const STRETCH_PLAN_NODES = 40_000;
export const STRETCH_PLAN_MS = 600;
export const STRETCH_WEIGHT = 2;
/** A stretch's flight ends after this many ticks (a bore of 160 blocks takes about 170). */
export const STRETCH_MAX_TICKS = 900;
/** A correction this far behind the local body along the heading while gliding is the server holding the body. */
export const HELD_ERROR = 2;
/** One held note per this many ticks. */
export const HELD_NOTE_TICKS = 40;

export interface ChainOptions {
  grid: RouteGrid;
  margin: number;
  /** The stretch's goals in order; the last one ends the flight (a landing). */
  goals: RouteGoal[];
  plan: Planner;
  maxNodes?: number;
  maxMs?: number;
  weight?: number;
  library?: RouteRequest['library'];
  /** The last window's (the landing's) edge set and weight, when it is not the first window. */
  landLibrary?: RouteRequest['library'];
  landWeight?: number;
  yaw: number;
  window?: number;
  ahead?: number;
  note?: (msg: string) => void;
}

export interface ChainBody extends TrackerBody {
  /** The ticks the burning rocket is expected to burn still (the loop's boostTicks), 0 when none burns. */
  boostTicks: number;
}

/** The trackers of a stretch, one window of goals each. */
export class TrackerChain {
  private active: RouteTracker;
  private activeFrom = 0;
  private activeTo: number;
  private next: { t: RouteTracker; from: number; to: number } | undefined;
  private readonly done: TrackerStats[] = [];
  /** Trackers made (windows) and hand-overs between them. */
  windows = 1;
  switches = 0;
  private readonly o: ChainOptions;

  constructor(o: ChainOptions) {
    this.o = o;
    this.activeTo = Math.min(o.goals.length, o.window ?? CHAIN_WINDOW);
    this.active = this.make(0, this.activeTo, o.yaw);
  }

  private make(from: number, to: number, yaw: number): RouteTracker {
    const o = this.o;
    // the last window lands: its own edge set and weight when given (Track F3's landing edges, after the takeoff window)
    const last = to >= o.goals.length && from > 0;
    const library = last && o.landLibrary !== undefined ? o.landLibrary : o.library;
    const weight = last && o.landWeight !== undefined ? o.landWeight : o.weight;
    return new RouteTracker({
      grid: o.grid,
      margin: o.margin,
      goals: o.goals.slice(from, to),
      plan: o.plan,
      maxNodes: o.maxNodes ?? STRETCH_PLAN_NODES,
      maxMs: o.maxMs ?? STRETCH_PLAN_MS,
      ...(weight !== undefined ? { weight } : {}),
      ...(library !== undefined ? { library } : {}),
      yaw,
      ...(o.note ? { note: o.note } : {}),
    });
  }

  /** Goals of the stretch passed by the body. */
  get reached(): number {
    return this.activeFrom + this.active.reached;
  }

  get goals(): number {
    return this.o.goals.length;
  }

  /** The trackers' stats summed (the first plan's effort is the first tracker's). */
  get stats(): TrackerStats {
    const all = [...this.done, this.active.stats, ...(this.next ? [this.next.t.stats] : [])];
    const s: TrackerStats = { plans: 0, replans: 0, planMs: 0, partial: 0, fired: 0, corrections: 0, holdTicks: 0, evadeTicks: 0, burnsRead: 0, maxError: 0, ticks: 0 };
    for (const t of all) {
      s.plans += t.plans;
      s.replans += t.replans;
      s.planMs += t.planMs;
      s.partial += t.partial;
      s.fired += t.fired;
      s.corrections += t.corrections;
      s.holdTicks += t.holdTicks;
      s.evadeTicks += t.evadeTicks;
      s.burnsRead += t.burnsRead;
      s.maxError = Math.max(s.maxError, t.maxError);
      s.ticks += t.ticks;
    }
    const first = all[0]?.first;
    if (first) s.first = first;
    return s;
  }

  rocketEnded(): void {
    this.active.rocketEnded();
  }

  noteCorrection(): void {
    this.active.noteCorrection();
    this.next?.t.noteCorrection();
  }

  noteWorldChange(): void {
    this.active.noteWorldChange();
    this.next?.t.noteWorldChange();
  }

  /** One tick: the control to fly now. */
  tick(b: ChainBody, now: number): TrackerOutput {
    const n = this.o.goals.length;
    // the next window, made CHAIN_AHEAD goals before the active one's end (it overlaps by one goal)
    if (!this.next && this.activeTo < n && this.activeTo - this.reached <= (this.o.ahead ?? CHAIN_AHEAD)) {
      const from = this.activeTo - 1;
      const to = Math.min(n, from + (this.o.window ?? CHAIN_WINDOW));
      this.next = { t: this.make(from, to, this.o.yaw), from, to };
      this.windows++;
      this.o.note?.(`corridor: window ${this.windows} (goals ${from + 1} to ${to} of ${n}) asked for at tick ${now}`);
    }
    const nx = this.next;
    if (nx) {
      const hold = nx.t.tick(b, now); // no plan yet: it holds (no rocket), keeps its goal count true, asks for its plan
      if (nx.t.current || this.active.reached >= this.activeTo - this.activeFrom) {
        this.done.push(this.active.stats);
        this.active = nx.t;
        this.activeFrom = nx.from;
        this.activeTo = nx.to;
        this.next = undefined;
        this.switches++;
        this.o.note?.(`corridor: window ${this.windows} takes over at tick ${now}${nx.t.current ? '' : ' (no plan yet: holding)'}`);
        // the rocket burning now (fired by the window before) is the new window's (seeded after its tick: its belief was made
        // without it); no second one on top of it
        if (b.boostTicks > 0) {
          this.active.seedBoost(b.boostTicks);
          if (hold.control.fire) return { ...hold, control: { ...hold.control, fire: false } };
        }
        return hold;
      }
    }
    const out = this.active.tick(b, now);
    if (out.done && this.activeTo < n) {
      // the active window is over but the next has no plan yet (it is ticked next time): hold the heading meanwhile
      return { ...out, done: false, status: 'planning' };
    }
    return out;
  }
}

export interface StretchDeps extends Omit<RocketDeps, 'loop'> {
  loop: FlightLoop;
  /** The cells the stretch is planned over (unknown cells are solid: commands-fly's route grid over the live model). */
  grid: RouteGrid;
  /** The search (a RoutePlannerClient's `plannerOver(grid)` runs it in the worker); default the in-thread search. */
  plan?: Planner;
  /** Chunk columns arriving (the world's onColumnLoaded); the trackers check their corridors again. */
  columnLoaded?: (fn: (cx: number, cz: number) => void) => () => void;
  log?: Logger;
}

/** The landing window's edge set (Track F3's landing edges: the brake approaches and settles; 6 of 6 offline against 2 of 6 without at the bend). */
export const STRETCH_LAND_LIBRARY: RouteRequest['library'] = 'landing';

export interface StretchOptions {
  goals: RouteGoal[];
  margin: number;
  maxNodes?: number;
  maxMs?: number;
  weight?: number;
  library?: RouteRequest['library'];
  landLibrary?: RouteRequest['library'];
  maxTicks?: number;
  window?: number;
  note?: (msg: string) => void;
}

export type StretchEnd = 'done' | 'ground' | 'failed' | 'timeout' | 'stopped';

export interface StretchReport {
  end: StretchEnd;
  ticks: number;
  rockets: number;
  hits: number;
  corrections: number;
  maxCorrection: number;
  /** Corrections that held the body back (a chunk the server had not loaded, or a wall the model did not have). */
  held: number;
  minClearance: number;
  reached: number;
  goals: number;
  windows: number;
  stats: TrackerStats;
  landedAt: Vec3;
}

/** Fly one underground stretch from standing; resolves when its landing is done, the glide ends, or the tick cap is hit. */
export function flyStretch(d: StretchDeps, o: StretchOptions): { done: Promise<StretchReport>; stop(): void } {
  const log = d.log ?? silentLogger;
  const { loop, grid } = d;
  const planner: Planner = d.plan ?? ((req) => planRoute(req, grid));
  const chain = new TrackerChain({
    grid,
    margin: o.margin,
    goals: o.goals,
    plan: planner,
    maxNodes: o.maxNodes ?? STRETCH_PLAN_NODES,
    maxMs: o.maxMs ?? STRETCH_PLAN_MS,
    weight: o.weight ?? STRETCH_WEIGHT,
    landLibrary: o.landLibrary ?? STRETCH_LAND_LIBRARY,
    ...(o.library !== undefined ? { library: o.library } : {}),
    ...(o.window !== undefined ? { window: o.window } : {}),
    yaw: loop.command.yaw,
    note: (m) => {
      log.info(m);
      o.note?.(m);
    },
  });
  let tick = 0;
  const hand = new RocketHand({ loop, queue: d.queue, inventory: d.inventory, hotbar: d.hotbar, entities: d.entities, log }, { onEnd: () => chain.rocketEnded(), scope: 'corridor' });
  let hits = 0;
  let corrections = 0;
  let maxCorrection = 0;
  let held = 0;
  let heldNoteAt = -1000;
  let minClearance = Infinity;
  let wasGliding = false;
  let serverGliding = loop.state.gliding;
  let lastPos: Vec3 | undefined;
  let finish: ((end: StretchEnd) => void) | undefined;
  const max = o.maxTicks ?? STRETCH_MAX_TICKS;

  const offStep = loop.onBeforeStep((_t, state) => {
    tick++;
    if (lastPos && state.gliding) {
      const sw = sweep(grid, lastPos, state.pos, 0);
      if (sw.clearance < minClearance) minClearance = sw.clearance;
    }
    lastPos = { ...state.pos };
    const body = { pos: state.pos, vel: state.vel, gliding: state.gliding, onGround: state.onGround, rockets: hand.rocketsInHotbar().count, boostTicks: state.boostTicks };
    if (wasGliding && !state.gliding && state.onGround && chain.reached < chain.goals) {
      const out = chain.tick({ ...body, gliding: false, onGround: true }, tick);
      finish?.(out.done ? 'done' : 'ground');
      return;
    }
    if (state.gliding && (state.collidedHorizontally || (state.collidedVertically && !state.onGround))) hits++;
    wasGliding = state.gliding;
    const r = hand.rocketsInHotbar();
    const out = chain.tick(body, tick);
    if (out.done) {
      finish?.('done');
      return;
    }
    if (out.status === 'failed') {
      finish?.('failed');
      return;
    }
    const c = out.control;
    hand.tick(tick);
    // the glide from the first airborne tick (the loop holds the request one input; Track F0 / F3), as live.ts
    const glide = state.gliding || !state.onGround;
    loop.setCommand({ yaw: c.yaw, pitch: c.pitch, jump: c.jump === true, glide, forward: 0, strafe: 0, sprint: false, sneak: false });
    if (c.fire && r.slot >= 0 && hand.canFire(tick) && serverGliding && state.boostTicks === 0) hand.fire(r.slot, state.pos, tick);
    if (tick >= max) finish?.('timeout');
  });
  const offEvent = loop.onEvent((e) => {
    if (e.kind === 'correction') {
      corrections++;
      if (e.error !== undefined && e.error > maxCorrection) maxCorrection = e.error;
      chain.noteCorrection();
      heldBy(e.local, e.server, e.error);
    } else if (e.kind === 'glide' && !(e as { refused?: true }).refused) serverGliding = e.gliding;
  });
  /** ADR 0055's held body: the server's body behind the local one along the heading, a chunk edge named when it is at one. */
  const heldBy = (local: Vec3 | undefined, server: Vec3, error: number | undefined): void => {
    const s = loop.state;
    if (!s.gliding || !local || error === undefined || error < HELD_ERROR) return;
    const h = Math.hypot(s.vel.x, s.vel.z);
    if (h < 0.3) return;
    const ahead = ((local.x - server.x) * s.vel.x + (local.z - server.z) * s.vel.z) / h;
    if (ahead < HELD_ERROR * 0.8) return;
    held++;
    if (tick - heldNoteAt < HELD_NOTE_TICKS) return;
    heldNoteAt = tick;
    const edge = (c: number, u: number): boolean => Math.abs(u) > 0.3 && Math.abs(c - Math.round(c / 16) * 16) <= 0.35;
    const chunkEdge = edge(server.x, s.vel.x / h) || edge(server.z, s.vel.z / h);
    log.warn(`corridor: held by the server at ${server.x.toFixed(2)} ${server.y.toFixed(2)} ${server.z.toFixed(2)} (the local body ${ahead.toFixed(1)} ahead)${chunkEdge ? ': at a chunk edge, the server had not loaded the next chunk' : ''} (${held} so far)`);
  };
  const offRockets = hand.attach(() => tick);
  const offChunks = d.columnLoaded?.(() => chain.noteWorldChange()) ?? ((): void => {});

  const done = new Promise<StretchReport>((resolve) => {
    let ended = false;
    finish = (end) => {
      if (ended) return;
      ended = true;
      offStep();
      offEvent();
      offRockets();
      offChunks();
      // on the ground the glide request goes (the walk after it must not glide off a step); in the air it stays (the caller lands)
      loop.setCommand({ jump: false, pitch: 0, forward: 0, strafe: 0, ...(loop.state.onGround ? { glide: false } : {}) });
      resolve({
        end,
        ticks: tick,
        rockets: hand.fired,
        hits,
        corrections,
        maxCorrection,
        held,
        minClearance: minClearance === Infinity ? 0 : minClearance,
        reached: chain.reached,
        goals: chain.goals,
        windows: chain.windows,
        stats: chain.stats,
        landedAt: { ...loop.state.pos },
      });
    };
  });
  return { done, stop: () => finish?.('stopped') };
}
