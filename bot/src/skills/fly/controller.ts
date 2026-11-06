// The flight controller (wave 11, Track AU; docs/flight.md "The controller"): flies one flight of the
// FlightBrain on the real body. Every tick (InputLoop.onBeforeStep) it reads the loop's state, asks
// the brain for the controls and applies them as a vanilla client would: yaw and pitch, the jump key,
// the glide request (`cmd.glide`: start_gliding goes out with a jump press, see flags.ts) and the
// rocket (an `inventory_transaction` item use of the firework in the hotbar, like eating: eat.ts
// useItemTransaction). Packet facts measured on BDS 1.26.60.6 (docs/flight.md "Packets"):
//
//   - the rocket's `add_entity` (minecraft:fireworks_rocket) arrives 1 to 3 ticks after the use, at the
//     body; the boost lasts until its `remove_entity` (Track F0: 9 to 21 ticks of burn, the removal 2 to 3
//     inputs after the last boosted tick; the loop boosts up to GLIDE.boostMaxTicks until told). A second
//     rocket while one burns extends the boost to the longer of the two (the server's union), so the boost
//     ends with the removal of the LAST of the own rockets; a use no add_entity answers within
//     ROCKET_ADD_WITHIN boosted nothing and is taken back (`loop.endBoost(ticks since the use)`). Track F3
//     lifted this plumbing into rocket.ts RocketHand, shared with the route driver (route/live.ts)
//   - the own `gliding` actor flag confirms the glide (the loop handles it: GlideEvent) and ends it on
//     ground or water contact; a voluntary stop in the air is ignored by the server
//   - the glide uses the elytra: the controller never flies without one in the chest slot (`canGlide`)
//
// The controller owns the loop's command while a flight runs (the FlightProcess of tasks/process/fly.ts
// keeps every other process away); `landNow` ends it on the nearest safe ground (`!fly stop`, `!land`,
// health, the elytra's wear).
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { EntityInfo } from '../../world/types.ts';
import type { InputLoopEvent, InputLoopState } from '../input/inputLoop.ts';
import type { BlockQuery } from '../input/types.ts';
import { FlightBrain, type BrainOptions, type FlightEnd, type FlightEndReason as BrainEndReason, type FlightPhase } from './brain.ts';
import { hdist, type FlightBody, type LandingTarget } from './plan.ts';
import { ROCKET_COOLDOWN, RocketHand, type RocketInventory } from './rocket.ts'; // Track F3: the rocket plumbing shared with route/live.ts
import type { TerrainQuery } from './terrain.ts';

export { ROCKET_COOLDOWN };
/** A takeoff that has not started a confirmed glide after this many ticks fails (`no_glide`). */
export const TAKEOFF_TIMEOUT = 120;
/**
 * A landing the local model predicted is final once the body stood this many ticks without the
 * server putting it back in the air (a correction after a touchdown the server did not see).
 */
export const SETTLE_TICKS = 10;
/** Track BF: sneak goes on this far above the landing cell in the approach / land phase (FlightDeps.sneakLanding). */
export const SNEAK_ABOVE = 2.5;
/** Track BL: a correction this far behind the local body along the heading (blocks) is the server holding it; one note per HELD_NOTE_TICKS. */
const HELD_ERROR = 2;
const HELD_NOTE_TICKS = 40;

export interface FlightLoop {
  readonly state: InputLoopState;
  /** The loop's block query; the flight wraps it so unloaded cells count as air (skyQuery) and restores it. */
  world: BlockQuery;
  readonly command: Readonly<{ yaw: number; pitch: number }>;
  setCommand(c: Partial<{ forward: number; strafe: number; yaw: number; pitch: number; jump: boolean; sneak: boolean; sprint: boolean; glide: boolean }>): void;
  onBeforeStep(fn: (tick: bigint, state: InputLoopState) => void): () => void;
  onEvent(fn: (e: InputLoopEvent) => void): () => void;
  boost(ticks?: number): void;
  endBoost(agoTicks?: number): void;
  waitTicks(n: number): Promise<void>;
}

export type FlightInventory = RocketInventory;

export interface FlightDeps {
  loop: FlightLoop;
  /** The connection (`inventory_transaction` for the rocket). */
  queue(name: string, packet: Record<string, unknown>): void;
  inventory: FlightInventory;
  hotbar: { select(slot: number): boolean; rawItem(slot: number): unknown };
  /** The world's entity tracker: the rocket entity's add and remove. */
  entities: { onAdd(fn: (e: EntityInfo) => void): () => void; onRemove(fn: (e: EntityInfo) => void): () => void };
  health(): number;
  /** Uses left on the worn elytra (undefined when unknown). */
  elytraLeft(): number | undefined;
  /** Safe ground under (x, z) for the emergency landing, looking down from `fromY` (Track AU2: under a roof the roof is not the ground): the feet height of a body standing there, undefined = unknown or unsafe. */
  groundAt?(x: number, z: number, fromY?: number): number | undefined;
  /** Track AU2: the highest solid block of a column (the world model) for the descent geometry; undefined = unknown. */
  skyTop?(x: number, z: number): number | undefined;
  /** Track BF: hold sneak through the touchdown and the settle (the server's sneak edge rule stops the slide at an edge); released when the flight ends. */
  sneakLanding?(): boolean;
  /** Track BL: the column query of the terrain floor and the dive (live, else cache, else unknown); ticked once a game tick (`tick`). */
  terrain?: { query: TerrainQuery; tick(): void };
  /** Track BL: a cell the live model has not received is solid in the world cache (the path-ahead check sees cache-only terrain). */
  cachedSolid?(x: number, y: number, z: number): boolean;
  /** Track BL: what the model believes about a cell, for the crash notes (`live stone`, `unknown (chunk not loaded); cache: column top 175`). */
  describeCell?(x: number, y: number, z: number): string;
  log?: Logger;
}

/**
 * The block query of a flight: unloaded cells are air (a glide crosses chunks the world model has not
 * received yet; without this the loop would stop simulating and the server would correct every tick).
 * Loaded cells answer as before, so the landing collides with the real platform.
 */
export function skyQuery(base: BlockQuery): BlockQuery {
  return {
    solidAt: (x, y, z) => base.solidAt(x, y, z) ?? false,
    boxesAt: base.boxesAt ? (x, y, z) => base.boxesAt!(x, y, z) ?? [] : undefined,
    frictionAt: base.frictionAt ? (x, y, z) => base.frictionAt!(x, y, z) : undefined,
    liquidAt: base.liquidAt ? (x, y, z) => base.liquidAt!(x, y, z) ?? null : undefined,
    climbableAt: base.climbableAt ? (x, y, z) => base.climbableAt!(x, y, z) ?? false : undefined,
  };
}

export type FlightEndReason = BrainEndReason | 'no_glide' | 'no_elytra';

/** Track BF: a landing target for the log (`12.5 64 -3.5 (half 1)`, `... (12 cells, walk, in from 270)`, `... (hold)`). */
export function describeTarget(t: LandingTarget): string {
  const how = t.hold ? 'hold' : t.cells ? `${t.cells.size} cells${t.walk ? ', walk' : ''}${t.bearing !== undefined ? `, in from ${Math.round(t.bearing)} under the roof at y ${t.ceiling ?? '?'}` : ''}` : `half ${t.half}`;
  return `${t.x.toFixed(1)} ${t.top} ${t.z.toFixed(1)} (${how})`;
}

export interface FlightReport {
  ok: boolean;
  reason?: FlightEndReason;
  landedAt: Vec3 | undefined;
  /** Horizontal distance from the target centre at the end. */
  off: number | undefined;
  onTarget: boolean;
  rockets: number;
  /** Track AU2: rockets by the phase that fired them. */
  rocketsBy: { climb: number; cruise: number; goaround: number; land: number };
  /** Track AU2: the descent geometry flown (`spiral r12 at 0 out from 50 above`, `S-turns from 48 above`). */
  descents: string[];
  /** Track AU2: ticks the path-ahead check steered away from a solid. */
  steered: number;
  goArounds: number;
  ticks: number;
  /** Corrections, glide events and motions seen during the flight (the loop's counters). */
  corrections: number;
  /** The server ended the glide (ground, water) this many times. */
  glideEnds: number;
  /** Touchdown speeds (the velocity of the last airborne tick), blocks per tick. */
  touchdown: { vy: number; h: number } | undefined;
  maxY: number;
  /** Track BF: ticks held over a goal that was not landable yet. */
  holdTicks?: number;
  /** Track BF: horizontal distance from the predicted touchdown to where the body stood when the flight ended (the post-landing slide). */
  slide?: number;
  /** Track BF: sneak was held through the touchdown (FlightDeps.sneakLanding). */
  sneak?: boolean;
  /** Track BH: a ledge takeoff's fall until the glide flew (blocks under the edge). */
  ledgeDrop?: number;
  /** Track BL: the terrain avoidances (one line each) and the dive descents flown; the server held the body (a wall or a chunk it had not loaded) this many times. */
  avoidances?: string[];
  dives?: number;
  held?: number;
  /** Track F1: the landing family flown (`flare`, `brake`), the approaches the brake took over from a missing flare, the ticks in the brake's K. */
  landStyle?: 'flare' | 'brake';
  brakeRescues?: number;
  brakeTicks?: number;
  /** Track F3: the route tracker flew the landing this many ticks (its plans, re-plans and largest error), and the route takeoff's ticks. */
  routeTicks?: number;
  routePlans?: number;
  routeReplans?: number;
  routeMaxError?: number;
  routeTakeoffTicks?: number;
}

export interface FlightOptions extends Omit<BrainOptions, 'groundAt' | 'obstacle' | 'skyTop' | 'terrain'> {
  /** Track BL: keep the terrain floor (default true; a glide down flies its simulated plan without it). */
  terrainFloor?: boolean;
  /** The brain's seed (deterministic planning per flight). */
  seed?: number;
}

/** The glide's own counters for the status line. */
export interface FlightStatus {
  active: boolean;
  phase: FlightPhase | undefined;
  target: LandingTarget | undefined;
  distance: number | undefined;
  rockets: number;
  goArounds: number;
  ticks: number;
  /** Track AU2: the descent geometry being flown, if any. */
  descending: string | undefined;
}

export class FlightController {
  private readonly d: FlightDeps;
  private readonly log: Logger;
  private brain: FlightBrain | undefined;
  private target: LandingTarget | undefined;
  private unsubs: (() => void)[] = [];
  private resolve: ((r: FlightReport) => void) | undefined;
  /** The promise of the flight that runs (`flight`). */
  private current: Promise<FlightReport> | undefined;
  private tickNo = 0;
  /** Track F3: the rocket hand (rocket.ts): the uses, the cooldown, the rocket entity's life. */
  private readonly rockets: RocketHand;
  private corrections0 = 0;
  private glideEnds = 0;
  private everGlided = false;
  private lastAir: { vy: number; h: number } | undefined;
  private endReason: FlightEndReason | undefined;
  private baseWorld: BlockQuery | undefined;
  /** The brain called the landing done: ticks the body has stood since (the server may still disagree). */
  private settling: { ticks: number; end: FlightEnd; at: Vec3 } | undefined;
  private sneaked = false;
  /** Track BL: the server held the body back (a crash note each, at most one per HELD_NOTE_TICKS). */
  private held = 0;
  private heldNoteAt = -1000;
  /** Landings the server undid (the body was corrected back into the air). */
  bounces = 0;

  constructor(deps: FlightDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.rockets = new RocketHand({ loop: deps.loop, queue: (n, p) => deps.queue(n, p), inventory: deps.inventory, hotbar: deps.hotbar, entities: deps.entities, ...(deps.log ? { log: deps.log } : {}) });
  }

  /** A flight runs (from `flyTo` until the body stands after it). */
  get active(): boolean {
    return this.brain !== undefined;
  }

  /** The flight that runs now (the promise `flyTo` returned), undefined on the ground: a new trip in the air takes it over (FlyProcess.adopt). */
  get flight(): Promise<FlightReport> | undefined {
    return this.brain ? this.current : undefined;
  }

  /** In the air (gliding) right now. */
  get airborne(): boolean {
    return this.active && (this.d.loop.state.gliding || !this.d.loop.state.onGround);
  }

  status(): FlightStatus {
    const b = this.brain;
    const pos = this.d.loop.state.pos;
    return {
      active: b !== undefined,
      phase: b?.phase,
      target: this.target,
      distance: b && this.target ? hdist(pos, this.target) : undefined,
      rockets: b?.stats.rockets ?? 0,
      goArounds: b?.stats.goArounds ?? 0,
      ticks: b?.stats.ticks ?? 0,
      descending: b?.descending,
    };
  }

  /** Why the last flight ended early (undefined after a landing on the target). */
  get lastEnd(): FlightEndReason | undefined {
    return this.endReason;
  }

  /** The brain's last approach choice (logs, tests). */
  get approach(): { pitch: number; cost: number; kind: string; phase: string } | undefined {
    return this.brain?.lastApproach;
  }

  /**
   * Fly to `target` and land on it. Resolves when the body stands again (or the takeoff failed). The
   * caller makes sure the elytra is worn and rockets are in the hotbar.
   */
  flyTo(target: LandingTarget, opts: FlightOptions): Promise<FlightReport> {
    if (this.brain) return Promise.resolve(this.report(false, 'stopped'));
    const { loop } = this.d;
    this.target = target;
    const base = loop.world;
    // Track BL: the obstacle sees the live model, and the cache where the live model has nothing (unknown stays air for the physics)
    const cached = this.d.cachedSolid?.bind(this.d);
    const obstacle = (x: number, y: number, z: number): boolean => {
      const s = base.solidAt(x, y, z);
      return s === true || (s === undefined && cached?.(x, y, z) === true);
    };
    this.brain = new FlightBrain(target, { ...opts, groundAt: this.d.groundAt?.bind(this.d), skyTop: this.d.skyTop?.bind(this.d), obstacle, ...(this.d.terrain && opts.terrainFloor !== false ? { terrain: this.d.terrain.query } : {}), note:
 (m) => this.log.info(`flight: ${m}`) });
    this.held = 0;
    this.heldNoteAt = -1000;
    this.tickNo = 0;
    this.rockets.reset();
    this.corrections0 = loop.state.corrections;
    this.glideEnds = 0;
    this.everGlided = false;
    this.lastAir = undefined;
    this.endReason = undefined;
    this.settling = undefined;
    this.sneaked = false;
    this.bounces = 0;
    this.baseWorld = base;
    loop.world = skyQuery(base);
    this.log.info(`flight: to ${describeTarget(target)}, cruise y ${opts.cruiseY}${opts.takeoffYaw !== undefined ? `, takeoff heading ${Math.round(opts.takeoffYaw)}` : ''}${opts.ledge ? `, ledge takeoff heading ${Math.round(opts.ledge.yaw)}` : ''}`);
    const flight = new Promise<FlightReport>((resolve) => {
      this.resolve = resolve;
      this.unsubs.push(
        loop.onBeforeStep((tick, state) => {
          this.tick(state);
        }),
        loop.onEvent((e) => {
          // (Track F0: the loop taking back a request the server never confirmed is no glide end)
          if (e.kind === 'glide' && e.refused !== true) {
            if (e.gliding) this.everGlided = true;
            else {
              this.glideEnds++;
              this.contactNote();
            }
          }
          if (e.kind === 'correction') this.correctionNote(e.local, e.server, e.error);
        }),
        this.rockets.attach(() => this.tickNo),
      );
      loop.setCommand({ forward: 0, strafe: 0, sprint: false, sneak: false, jump: false });
    });
    this.current = flight;
    return flight;
  }

  /**
   * Track AU2: move the landing target while the flight is on its way (before the approach); false once the approach has begun.
   * `cruiseY`: a new trip taken over in the air may need a higher cruise than the one the flight started with (never lowered).
   */
  retarget(target: LandingTarget, o: { cruiseY?: number } = {}): boolean {
    if (!this.brain?.retarget(target, this.body(this.d.loop.state), o)) return false;
    this.target = target;
    this.log.info(`flight: retargeted to ${describeTarget(target)}`);
    return true;
  }

  /** Land now on the nearest safe ground (`!fly stop`, `!land`, health, the elytra): the flight ends `ok: false, reason`. */
  landNow(reason: BrainEndReason = 'stopped'): void {
    if (!this.brain) return;
    this.brain.landNow(reason, this.body(this.d.loop.state));
    if (this.brain.phase === 'done' && !this.settling) this.finish(false, reason);
  }

  dispose(): void {
    if (this.brain) this.finish(false, 'stopped');
  }

  private body(s: InputLoopState): FlightBody {
    return { pos: s.pos, vel: s.vel, onGround: s.onGround, gliding: s.gliding, boostTicks: s.boostTicks };
  }

  /**
   * Track BL, deliverable 5: a correction that puts the server's body more than HELD_ERROR behind the local
   * one along the heading while gliding is a wall the model did not have (or a chunk the server had not
   * loaded: BDS holds a body at the edge of a chunk it has not loaded, the Realm's z 656.3 and 832.3): one
   * note naming the cell ahead of the server's body and what the model believed there.
   */
  private correctionNote(local: Vec3 | undefined, server: Vec3, error: number | undefined): void {
    const s = this.d.loop.state;
    if (!this.brain || !s.gliding || !local || error === undefined || error < HELD_ERROR) return;
    const v = s.vel;
    const h = Math.hypot(v.x, v.z);
    if (h < 0.3) return;
    const ahead = ((local.x - server.x) * v.x + (local.z - server.z) * v.z) / h;
    if (ahead < HELD_ERROR * 0.8) return;
    this.held++;
    if (this.tickNo - this.heldNoteAt < HELD_NOTE_TICKS) return;
    this.heldNoteAt = this.tickNo;
    const ux = v.x / h;
    const uz = v.z / h;
    const cx = Math.floor(server.x + ux * 0.9);
    const cy = Math.floor(server.y + 0.3);
    const cz = Math.floor(server.z + uz * 0.9);
    const edge = (c: number, u: number): boolean => Math.abs(u) > 0.3 && Math.abs(c - Math.round(c / 16) * 16) <= 0.35;
    const chunkEdge = edge(server.x, ux) || edge(server.z, uz);
    const what = this.d.describeCell?.(cx, cy, cz) ?? '?';
    this.log.warn(
      `flight: held by the server at ${server.x.toFixed(2)} ${server.y.toFixed(2)} ${server.z.toFixed(2)} (the local body ${ahead.toFixed(1)} ahead, ${this.brain.phase}${this.target ? `, ${hdist(server, this.target).toFixed(0)} from the target` : ''}): the cell ahead ${cx} ${cy} ${cz} is ${what}${chunkEdge ? '; at a chunk edge: the server had not loaded the next chunk' : ''} (${this.held} held corrections so far)`,
    );
  }

  /** Track BL, deliverable 5: the glide ended by contact away from the landing (mid-route): the cells around and ahead of the body and what the model believed there. */
  private contactNote(): void {
    const b = this.brain;
    const s = this.d.loop.state;
    if (!b || !this.target || b.phase === 'approach' || b.phase === 'land' || b.phase === 'done' || b.phase === 'takeoff') return;
    if (hdist(s.pos, this.target) < 20) return;
    const h = Math.hypot(s.vel.x, s.vel.z);
    const ux = h > 0.05 ? s.vel.x / h : 0;
    const uz = h > 0.05 ? s.vel.z / h : 0;
    const cells = [
      [Math.floor(s.pos.x + ux), Math.floor(s.pos.y + 0.3), Math.floor(s.pos.z + uz)],
      [Math.floor(s.pos.x), Math.floor(s.pos.y - 0.5), Math.floor(s.pos.z)],
    ] as const;
    this.log.warn(`flight: the glide ended by contact mid-route at ${s.pos.x.toFixed(2)} ${s.pos.y.toFixed(2)} ${s.pos.z.toFixed(2)} (${b.phase}, ${hdist(s.pos, this.target).toFixed(0)} from the target): ${cells.map(([x, y, z]) => `${x} ${y} ${z} ${this.d.describeCell?.(x, y, z) ?? '?'}`).join('; ')}`);
  }

  private tick(state: InputLoopState): void {
    const brain = this.brain;
    if (!brain) return;
    this.tickNo++;
    this.rockets.tick(this.tickNo);
    this.d.terrain?.tick();
    const { loop } = this.d;
    if (state.gliding) this.lastAir = { vy: state.vel.y, h: Math.hypot(state.vel.x, state.vel.z) };
    // a takeoff the server never confirmed: give up (the elytra is missing or the glide is refused)
    if (!this.everGlided && this.tickNo > TAKEOFF_TIMEOUT) {
      this.finish(false, 'no_glide');
      return;
    }
    // after a predicted touchdown: wait for the server to agree (it stands, no correction lifts it)
    if (this.settling) {
      if (state.gliding || (!state.onGround && state.vel.y < -0.1)) {
        this.bounces++;
        this.log.warn(`flight: the server put the body back in the air after a predicted landing (bounce ${this.bounces}); flying on`);
        this.settling = undefined;
        brain.bounce(this.body(state));
      } else if (++this.settling.ticks >= SETTLE_TICKS) {
        const end = this.settling.end;
        this.finish(end.ok, end.ok ? undefined : end.reason, end);
        return;
      } else {
        loop.setCommand({ glide: false, jump: false, pitch: 0, forward: 0, strafe: 0, sneak: this.sneaked });
        return;
      }
    }
    const rockets = this.rockets.rocketsInHotbar();
    const out = brain.step({
      tick: this.tickNo,
      body: this.body(state),
      yaw: loop.command.yaw,
      pitch: loop.command.pitch,
      rockets: rockets.count,
      canFire: this.rockets.canFire(this.tickNo) && rockets.slot >= 0,
      health: this.d.health(),
      elytraLeft: this.d.elytraLeft(),
    });
    const c = out.control;
    // Track BF: sneak through the touchdown (docs/flight.md "Sneak at the touchdown")
    const low = this.target !== undefined && state.pos.y - this.target.top < SNEAK_ABOVE && (brain.phase === 'land' || brain.phase === 'approach' || brain.phase === 'done');
    if (low && this.d.sneakLanding?.() === true) this.sneaked = true;
    // (Track BH: the ledge takeoff walks to the edge sneaking and steps off: `forward`, `sneak` from the brain)
    loop.setCommand({ yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide, forward: c.forward ?? 0, strafe: 0, sprint: false, sneak: (this.sneaked && low) || c.sneak === true });
    if (c.fire && rockets.slot >= 0) this.rockets.fire(rockets.slot, state.pos, this.tickNo);
    if (out.end) this.settling = { ticks: 0, end: out.end, at: { ...state.pos } };
  }

  private report(ok: boolean, reason: FlightEndReason | undefined, end?: FlightEnd): FlightReport {
    const b = this.brain;
    const s = this.d.loop.state;
    const landedAt = end?.landedAt ?? { ...s.pos };
    return {
      ok,
      ...(reason ? { reason } : {}),
      landedAt,
      off: end?.off ?? (this.target ? hdist(landedAt, this.target) : undefined),
      onTarget: end?.onTarget ?? false,
      rockets: b?.stats.rockets ?? 0,
      rocketsBy: b ? { ...b.stats.rocketsBy } : { climb: 0, cruise: 0, goaround: 0, land: 0 },
      descents: b ? [...b.stats.descents] : [],
      steered: b?.stats.steered ?? 0,
      goArounds: b?.stats.goArounds ?? 0,
      ticks: b?.stats.ticks ?? 0,
      corrections: s.corrections - this.corrections0,
      glideEnds: this.glideEnds,
      touchdown: this.lastAir,
      maxY: b?.stats.maxY ?? s.pos.y,
      holdTicks: b?.stats.holdTicks ?? 0,
      ...(this.settling ? { slide: hdist(this.settling.at, s.pos) } : {}),
      sneak: this.sneaked,
      ...(b?.stats.ledgeDrop !== undefined ? { ledgeDrop: b.stats.ledgeDrop } : {}),
      ...(b ? { avoidances: [...b.stats.avoidances], dives: b.stats.dives } : {}),
      held: this.held,
      ...(b?.stats.landStyle ? { landStyle: b.stats.landStyle, brakeRescues: b.stats.brakeRescues, brakeTicks: b.stats.brakeTicks } : {}),
      ...(b?.stats.routeTicks ? { routeTicks: b.stats.routeTicks, routePlans: b.stats.routePlans, routeReplans: b.stats.routeReplans, routeMaxError: b.stats.routeMaxError } : {}),
      ...(b?.stats.routeTakeoffTicks !== undefined ? { routeTakeoffTicks: b.stats.routeTakeoffTicks } : {}),
    };
  }

  private finish(ok: boolean, reason: FlightEndReason | undefined, end?: FlightEnd): void {
    if (!this.brain) return;
    const r = this.report(ok, reason, end);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.d.loop.setCommand({ glide: false, jump: false, pitch: 0, forward: 0, strafe: 0, sneak: this.sneaked });
    // Track BF: sneak stays on until the slide has stopped (the settle ends after 10 ticks with the body still
    // moving: bds-fly measured 0.6 to 2.2 blocks more after the report), then is released (at most 40 ticks)
    if (this.sneaked) {
      let n = 0;
      const off = this.d.loop.onBeforeStep((_t, s) => {
        if (++n < 40 && Math.hypot(s.vel.x, s.vel.z) > 0.003) return;
        off();
        if (!this.brain) this.d.loop.setCommand({ sneak: false });
      });
    }
    if (this.baseWorld) this.d.loop.world = this.baseWorld;
    this.baseWorld = undefined;
    this.endReason = reason;
    this.log.info(
      `flight: ${ok ? 'landed' : `ended (${reason})`} at ${r.landedAt ? `${r.landedAt.x.toFixed(2)} ${r.landedAt.y.toFixed(2)} ${r.landedAt.z.toFixed(2)}` : '?'}` +
        `${r.off !== undefined ? `, ${r.off.toFixed(2)} from the centre` : ''}; ${r.rockets} rockets (${r.rocketsBy.climb} climb, ${r.rocketsBy.cruise} cruise, ${r.rocketsBy.goaround} go-around), ${r.goArounds} go-arounds, ${r.ticks} ticks, ${r.corrections} corrections` +
        `${r.touchdown ? `, touchdown vy ${r.touchdown.vy.toFixed(3)} h ${r.touchdown.h.toFixed(3)}` : ''}, max y ${r.maxY.toFixed(1)}${r.descents.length ? `, descent ${r.descents.join('; ')}` : ''}${r.steered ? `, steered ${r.steered} ticks` : ''}${r.holdTicks ? `, held ${r.holdTicks} ticks` : ''}${r.slide !== undefined ? `, slide ${r.slide.toFixed(2)}${r.sneak ? ' (sneaking)' : ''}` : ''}${r.ledgeDrop !== undefined ? `, ledge takeoff (gliding ${r.ledgeDrop.toFixed(1)} under the edge)` : ''}${r.avoidances?.length ? `, ${r.avoidances.length} terrain avoidance${r.avoidances.length === 1 ? '' : 's'}` : ''}${r.dives ? `, ${r.dives} dive${r.dives === 1 ? '' : 's'}` : ''}${r.held ? `, held by the server ${r.held} times` : ''}${r.landStyle ? `, landing ${r.landStyle}${r.landStyle === 'brake' ? ` (${r.brakeTicks} ticks braked / station-kept${r.brakeRescues ? `, ${r.brakeRescues} instead of a go-around` : ''})` : ''}` : ''}${r.routeTicks ? `, landing route (${r.routeTicks} ticks on the route tracker, ${r.routePlans} plans, ${r.routeReplans} re-plans, max error ${r.routeMaxError?.toFixed(2)})` : ''}${r.routeTakeoffTicks !== undefined ? `, route takeoff (${r.routeTakeoffTicks} ticks)` : ''}`,
    );
    this.brain = undefined;
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(r);
  }
}
