// Track F2: the tracker on the real body (docs/flight.md "Route planner", "On the server"): `flyRoute` binds a
// RouteTracker to the InputLoop for one route, the way FlightController flies the FlightBrain. Every tick
// (loop.onBeforeStep) the loop's state is the tracker's body, the tracker's control becomes the loop's
// command (yaw, pitch, the jump key for a takeoff, the glide wanted throughout) and a rocket is used as the
// controller does it: the item-use transaction of the firework in the hotbar, `loop.boost()`, the rocket's
// `remove_entity` ending it (`loop.endBoost()` and the tracker's `rocketEnded`). Corrections the loop replays
// are passed to the tracker (`noteCorrection`). Used by the e2e (test/e2e/fly-route.test.ts) as the bare
// route driver; the flight's own integration is the brain's `route` phase and route takeoff (Track F3,
// brain.ts). The rocket plumbing is rocket.ts RocketHand, shared with the controller (Track F3 lifted the
// copy Track F2 left here).
import type { Vec3 } from '../../../connection/types.ts';
import { silentLogger } from '../../../log.ts';
import type { BlockQuery } from '../../input/types.ts';
import type { FlightLoop } from '../controller.ts';
import { RocketHand, type RocketDeps } from '../rocket.ts';
import { gridOf, sweep } from './grid.ts';
import { planRoute } from './search.ts';
import { RouteTracker, type Planner, type TrackerStats } from './tracker.ts';
import type { PrimitiveFamily, RouteGoal, RouteRequest } from './types.ts';

export interface RouteLiveDeps extends Omit<RocketDeps, 'loop'> {
  loop: FlightLoop;
  /** The block query the route is planned over (unknown cells are solid; the loop's own query, not the cruise's skyQuery). */
  world: BlockQuery;
}

export interface RouteLiveOptions {
  goals: RouteGoal[];
  margin: number;
  /** The planner (default: the in-thread search; a RoutePlannerClient's `plannerOver(grid)` runs it in the worker). */
  planner?: (grid: ReturnType<typeof gridOf>) => Planner;
  maxNodes?: number;
  maxMs?: number;
  stackRockets?: boolean;
  /**
   * Track F4a: TrackerOptions.lead. Default: with a worker planner (`planner`), the ticks of `maxMs` and 2 more (the
   * worker answers that late); in-thread 0 (the answer comes before the next tick).
   */
  lead?: number;
  families?: readonly PrimitiveFamily[];
  /** Track F4a: the edge set and the heuristic's weight of every request (an obstacle course's leg ending in a landing: `landing`, ROUTE_WEIGHT). */
  library?: RouteRequest['library'];
  weight?: number;
  /** The flight ends after this many ticks (default 1200). */
  maxTicks?: number;
  note?: (msg: string) => void;
  /** Every tick: the loop's state before the control and the control (the e2e's trace). */
  trace?: (tick: number, s: { pos: Vec3; vel: Vec3; gliding: boolean; onGround: boolean; boostTicks: number }, c: { yaw: number; pitch: number; fire: boolean; jump?: boolean }, status: string) => void;
}

export type RouteLiveEnd = 'done' | 'ground' | 'failed' | 'timeout' | 'stopped';

export interface RouteLiveReport {
  end: RouteLiveEnd;
  ticks: number;
  rockets: number;
  /** Collisions of the local model while gliding (the server's damage is the truth pack's business). */
  hits: number;
  corrections: number;
  /** The largest correction the loop replayed (blocks). */
  maxCorrection: number;
  /** The least clearance of the local body from any solid of the world model while gliding. */
  minClearance: number;
  /** Rocket uses the plan asked for before the server's gliding flag (held back). */
  heldFires: number;
  reached: number;
  goals: number;
  stats: TrackerStats;
  landedAt: Vec3;
}

/** Fly one route on the real body; resolves when the route is done, the glide ends, or the tick cap is hit. `stop()` on the handle ends it early. */
export function flyRoute(d: RouteLiveDeps, o: RouteLiveOptions): { done: Promise<RouteLiveReport>; stop(): void } {
  const log = d.log ?? silentLogger;
  const { loop } = d;
  const grid = gridOf(d.world);
  const planner: Planner = o.planner ? o.planner(grid) : (req) => planRoute(req, grid);
  const tracker = new RouteTracker({
    grid,
    margin: o.margin,
    goals: o.goals,
    plan: planner,
    maxNodes: o.maxNodes ?? 40_000,
    maxMs: o.maxMs ?? 300,
    ...(o.stackRockets !== undefined ? { stackRockets: o.stackRockets } : {}),
    lead: o.lead ?? (o.planner ? Math.ceil((o.maxMs ?? 300) / 50) + 2 : 0),
    ...(o.families ? { families: o.families } : {}),
    ...(o.library !== undefined ? { library: o.library } : {}),
    ...(o.weight !== undefined ? { weight: o.weight } : {}),
    yaw: loop.command.yaw,
    note: (m) => {
      log.info(m);
      o.note?.(m);
    },
  });
  let tick = 0;
  const hand = new RocketHand({ loop, queue: d.queue, inventory: d.inventory, hotbar: d.hotbar, entities: d.entities, log }, { onEnd: () => tracker.rocketEnded(), scope: 'route' });
  let hits = 0;
  let corrections = 0;
  let maxCorrection = 0;
  let minClearance = Infinity;
  let wasGliding = false;
  /** The server's gliding flag (the loop's GlideEvent); a glide the loop already predicts at the start counts as confirmed. */
  let serverGliding = loop.state.gliding;
  let heldFires = 0;
  let lastPos: Vec3 | undefined;
  let finish: ((end: RouteLiveEnd) => void) | undefined;
  const max = o.maxTicks ?? 1200;

  const rocketsInHotbar = (): { count: number; slot: number } => hand.rocketsInHotbar();

  const offStep = loop.onBeforeStep((_t, state) => {
    tick++;
    if (lastPos && state.gliding) {
      const sw = sweep(grid, lastPos, state.pos, 0);
      if (sw.clearance < minClearance) minClearance = sw.clearance;
    }
    lastPos = { ...state.pos };
    if (wasGliding && !state.gliding && state.onGround && tracker.reached < o.goals.length) {
      // the glide ended on the ground before the goals: judged by the tracker (a landing goal) next
      const out = tracker.tick({ pos: state.pos, vel: state.vel, gliding: false, onGround: true, rockets: rocketsInHotbar().count }, tick);
      finish?.(out.done ? 'done' : 'ground');
      return;
    }
    if (state.gliding && (state.collidedHorizontally || (state.collidedVertically && !state.onGround))) hits++;
    wasGliding = state.gliding;
    const r = rocketsInHotbar();
    const out = tracker.tick({ pos: state.pos, vel: state.vel, gliding: state.gliding, onGround: state.onGround, rockets: r.count }, tick);
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
    // the glide is requested from the first airborne tick: the input loop holds the request on the input right after the
    // jump (the server refuses that one) and asks on the 2nd airborne input, which the server takes (Track F0; F2's
    // wait for the fall came from a teleport artefact)
    const glide = state.gliding || !state.onGround;
    loop.setCommand({ yaw: c.yaw, pitch: c.pitch, jump: c.jump === true, glide, forward: 0, strafe: 0, sprint: false, sneak: false });
    // (a rocket used before the server's gliding flag does nothing, measured on bds-fly3: the use waits for the flag)
    const firing = c.fire && r.slot >= 0 && hand.canFire(tick) && serverGliding;
    if (c.fire && !firing) {
      if (r.slot >= 0) heldFires++;
      // Track F4a: the tracker counted that rocket as burning; it takes back the burn it had and fires again next tick
      tracker.fireHeld();
    }
    o.trace?.(tick, { pos: { ...state.pos }, vel: { ...state.vel }, gliding: state.gliding, onGround: state.onGround, boostTicks: state.boostTicks }, { yaw: c.yaw, pitch: c.pitch, fire: firing, ...(c.jump ? { jump: true } : {}) }, out.status);
    if (firing) hand.fire(r.slot, state.pos, tick);
    if (tick >= max) finish?.('timeout');
  });
  const offEvent = loop.onEvent((e) => {
    if (e.kind === 'correction') {
      corrections++;
      if (e.error !== undefined && e.error > maxCorrection) maxCorrection = e.error;
      tracker.noteCorrection();
    } else if (e.kind === 'glide' && !(e as { refused?: true }).refused) serverGliding = e.gliding;
  });
  const offRockets = hand.attach(() => tick);

  const done = new Promise<RouteLiveReport>((resolve) => {
    let ended = false;
    finish = (end) => {
      if (ended) return;
      ended = true;
      offStep();
      offEvent();
      offRockets();
      loop.setCommand({ jump: false, pitch: 0, forward: 0, strafe: 0 });
      resolve({
        end,
        ticks: tick,
        rockets: hand.fired,
        hits,
        corrections,
        maxCorrection,
        minClearance: minClearance === Infinity ? 0 : minClearance,
        heldFires,
        reached: tracker.reached,
        goals: o.goals.length,
        stats: tracker.stats,
        landedAt: { ...loop.state.pos },
      });
    };
  });
  return { done, stop: () => finish?.('stopped') };
}
