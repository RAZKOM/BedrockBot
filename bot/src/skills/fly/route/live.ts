// Track F2: the tracker on the real body (docs/flight.md "Route planner", "On the server"): `flyRoute` binds a
// RouteTracker to the InputLoop for one route, the way FlightController flies the FlightBrain. Every tick
// (loop.onBeforeStep) the loop's state is the tracker's body, the tracker's control becomes the loop's
// command (yaw, pitch, the jump key for a takeoff, the glide wanted throughout) and a rocket is used as the
// controller does it: the item-use transaction of the firework in the hotbar, `loop.boost()`, the rocket's
// `remove_entity` ending it (`loop.endBoost()` and the tracker's `rocketEnded`). Corrections the loop replays
// are passed to the tracker (`noteCorrection`). Used by the e2e (test/e2e/fly-route.test.ts); no command
// wires it yet (the full integration into the flight comes with Track F3).
//
// Duplicated from controller.ts on purpose (the controller's rocket plumbing is private to its flight and
// this driver must not edit it): `fire`, the rocket entity's add / remove match, `rocketsInHotbar`.
import type { Vec3 } from '../../../connection/types.ts';
import { silentLogger, type Logger } from '../../../log.ts';
import type { EntityInfo, ItemStack } from '../../../world/types.ts';
import { PHYSICS } from '../../input/physics.ts';
import type { BlockQuery } from '../../input/types.ts';
import { useItemTransaction } from '../../survival/eat.ts';
import { wireItemOf } from '../../place/place.ts';
import type { FlightLoop } from '../controller.ts';
import { isRocket } from '../kit.ts';
import { gridOf, sweep } from './grid.ts';
import { planRoute } from './search.ts';
import { RouteTracker, type Planner, type TrackerStats } from './tracker.ts';
import type { PrimitiveFamily, RouteGoal } from './types.ts';

/** Ticks between two rockets (controller.ts ROCKET_COOLDOWN). */
const ROCKET_COOLDOWN = 4;
/** A rocket entity appearing within this many blocks of the body right after a use is ours (controller.ts ROCKET_NEAR + 2). */
const ROCKET_NEAR = 6;

export interface RouteLiveDeps {
  loop: FlightLoop;
  /** The block query the route is planned over (unknown cells are solid; the loop's own query, not the cruise's skyQuery). */
  world: BlockQuery;
  queue(name: string, packet: Record<string, unknown>): void;
  inventory: { readonly slots: readonly (ItemStack | null)[]; readonly selected: number; rawItem(window: number, slot: number): unknown };
  hotbar: { select(slot: number): boolean; rawItem(slot: number): unknown };
  entities: { onAdd(fn: (e: EntityInfo) => void): () => void; onRemove(fn: (e: EntityInfo) => void): () => void };
  log?: Logger;
}

export interface RouteLiveOptions {
  goals: RouteGoal[];
  margin: number;
  /** The planner (default: the in-thread search; a RoutePlannerClient's `plannerOver(grid)` runs it in the worker). */
  planner?: (grid: ReturnType<typeof gridOf>) => Planner;
  maxNodes?: number;
  maxMs?: number;
  stackRockets?: boolean;
  families?: readonly PrimitiveFamily[];
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
    ...(o.families ? { families: o.families } : {}),
    yaw: loop.command.yaw,
    note: (m) => {
      log.info(m);
      o.note?.(m);
    },
  });
  let tick = 0;
  let lastFire = -100;
  let usedAt: number | undefined;
  let rocketId: bigint | number | undefined;
  let rockets = 0;
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

  const rocketsInHotbar = (): { count: number; slot: number } => {
    let count = 0;
    let slot = -1;
    for (let i = 0; i < 9; i++) {
      const s = d.inventory.slots[i];
      if (s && s.count > 0 && isRocket(s.name)) {
        count += s.count;
        if (slot < 0 || i === d.inventory.selected) slot = i;
      }
    }
    return { count, slot };
  };
  const fire = (slot: number, feet: Vec3): void => {
    if (d.inventory.selected !== slot) d.hotbar.select(slot);
    const held = wireItemOf(d.inventory.slots[slot], (d.inventory.rawItem(0, slot) ?? d.hotbar.rawItem(slot)) as Parameters<typeof wireItemOf>[1]);
    d.queue('inventory_transaction', useItemTransaction({ hotbarSlot: slot, held, eye: { x: feet.x, y: feet.y + PHYSICS.eyeHeight, z: feet.z } }));
    loop.boost();
    lastFire = tick;
    usedAt = tick;
    rockets++;
    log.debug(`route: rocket from slot ${slot}`);
  };

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
    // the glide is requested once the body falls (the server starts a glide on a falling tick only, measured on bds-fly3;
    // the brain's takeoff does the same): a request while the jump rises had the model glide 6 ticks before the server
    const glide = state.gliding || (!state.onGround && state.vel.y < 0);
    loop.setCommand({ yaw: c.yaw, pitch: c.pitch, jump: c.jump === true, glide, forward: 0, strafe: 0, sprint: false, sneak: false });
    // (a rocket used before the server's gliding flag does nothing, measured on bds-fly3: the use waits for the flag)
    const firing = c.fire && r.slot >= 0 && tick - lastFire >= ROCKET_COOLDOWN && serverGliding;
    if (c.fire && !firing && r.slot >= 0) heldFires++;
    o.trace?.(tick, { pos: { ...state.pos }, vel: { ...state.vel }, gliding: state.gliding, onGround: state.onGround, boostTicks: state.boostTicks }, { yaw: c.yaw, pitch: c.pitch, fire: firing, ...(c.jump ? { jump: true } : {}) }, out.status);
    if (firing) fire(r.slot, state.pos);
    if (tick >= max) finish?.('timeout');
  });
  const offEvent = loop.onEvent((e) => {
    if (e.kind === 'correction') {
      corrections++;
      if (e.error !== undefined && e.error > maxCorrection) maxCorrection = e.error;
      tracker.noteCorrection();
    } else if (e.kind === 'glide') serverGliding = e.gliding;
  });
  const offAdd = d.entities.onAdd((e) => {
    if (e.type !== 'minecraft:fireworks_rocket' || usedAt === undefined || tick - usedAt > 10) return;
    const p = loop.state.pos;
    if (Math.hypot(e.pos.x - p.x, e.pos.y - p.y, e.pos.z - p.z) > ROCKET_NEAR) return;
    rocketId = e.uniqueId;
    usedAt = undefined;
  });
  const offRemove = d.entities.onRemove((e) => {
    if (rocketId === undefined || e.uniqueId !== rocketId) return;
    rocketId = undefined;
    loop.endBoost();
    tracker.rocketEnded();
  });

  const done = new Promise<RouteLiveReport>((resolve) => {
    let ended = false;
    finish = (end) => {
      if (ended) return;
      ended = true;
      offStep();
      offEvent();
      offAdd();
      offRemove();
      loop.setCommand({ jump: false, pitch: 0, forward: 0, strafe: 0 });
      resolve({
        end,
        ticks: tick,
        rockets,
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
