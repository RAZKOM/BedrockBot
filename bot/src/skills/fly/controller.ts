// The flight controller (wave 11, Track AU; docs/flight.md "The controller"): flies one flight of the
// FlightBrain on the real body. Every tick (InputLoop.onBeforeStep) it reads the loop's state, asks
// the brain for the controls and applies them as a vanilla client would: yaw and pitch, the jump key,
// the glide request (`cmd.glide`: start_gliding goes out with a jump press, see flags.ts) and the
// rocket (an `inventory_transaction` item use of the firework in the hotbar, like eating: eat.ts
// useItemTransaction). Packet facts measured on BDS 1.26.60.6 (docs/flight.md "Packets"):
//
//   - the rocket's `add_entity` (minecraft:fireworks_rocket) arrives 1 to 3 ticks after the use, at the
//     body; its `remove_entity` 14 to 20 ticks later ends the boost: `loop.endBoost()` re-simulates the
//     inputs since without it (the model assumes GLIDE.boostTicks and is cut here)
//   - the own `gliding` actor flag confirms the glide (the loop handles it: GlideEvent) and ends it on
//     ground or water contact; a voluntary stop in the air is ignored by the server
//   - the glide uses the elytra: the controller never flies without one in the chest slot (`canGlide`)
//
// The controller owns the loop's command while a flight runs (the FlightProcess of tasks/process/fly.ts
// keeps every other process away); `landNow` ends it on the nearest safe ground (`!fly stop`, `!land`,
// health, the elytra's wear).
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemStack } from '../../world/types.ts';
import type { EntityInfo } from '../../world/types.ts';
import type { InputLoopEvent, InputLoopState } from '../input/inputLoop.ts';
import type { BlockQuery } from '../input/types.ts';
import { useItemTransaction } from '../survival/eat.ts';
import { wireItemOf } from '../place/place.ts';
import { PHYSICS } from '../input/physics.ts';
import { FlightBrain, type BrainOptions, type FlightEnd, type FlightPhase } from './brain.ts';
import { isRocket } from './kit.ts';
import { hdist, type FlightBody, type LandingTarget } from './plan.ts';

/** Ticks between two rockets (the item-use transaction must settle; the boost of one rocket lasts 14 to 20). */
export const ROCKET_COOLDOWN = 4;
/** A takeoff that has not started a confirmed glide after this many ticks fails (`no_glide`). */
export const TAKEOFF_TIMEOUT = 120;
/**
 * A landing the local model predicted is final once the body stood this many ticks without the
 * server putting it back in the air (a correction after a touchdown the server did not see).
 */
export const SETTLE_TICKS = 10;
/** A rocket entity appearing within this many blocks of the body right after a use is ours. */
const ROCKET_NEAR = 4;

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

export interface FlightInventory {
  readonly slots: readonly (ItemStack | null)[];
  readonly selected: number;
  rawItem(window: number, slot: number): unknown;
}

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
  /** Safe ground under (x, z) for the emergency landing: the feet height of a body standing there, undefined = unknown or unsafe. */
  groundAt?(x: number, z: number): number | undefined;
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

export type FlightEndReason = Extract<FlightEnd, { ok: false }>['reason'] | 'no_glide' | 'no_elytra';

export interface FlightReport {
  ok: boolean;
  reason?: FlightEndReason;
  landedAt: Vec3 | undefined;
  /** Horizontal distance from the target centre at the end. */
  off: number | undefined;
  onTarget: boolean;
  rockets: number;
  goArounds: number;
  ticks: number;
  /** Corrections, glide events and motions seen during the flight (the loop's counters). */
  corrections: number;
  /** The server ended the glide (ground, water) this many times. */
  glideEnds: number;
  /** Touchdown speeds (the velocity of the last airborne tick), blocks per tick. */
  touchdown: { vy: number; h: number } | undefined;
  maxY: number;
}

export interface FlightOptions extends Omit<BrainOptions, 'groundAt'> {
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
}

export class FlightController {
  private readonly d: FlightDeps;
  private readonly log: Logger;
  private brain: FlightBrain | undefined;
  private target: LandingTarget | undefined;
  private unsubs: (() => void)[] = [];
  private resolve: ((r: FlightReport) => void) | undefined;
  private lastFire = -1000;
  private tickNo = 0;
  private usedAt: number | undefined;
  private rocketId: bigint | undefined;
  private corrections0 = 0;
  private glideEnds = 0;
  private everGlided = false;
  private lastAir: { vy: number; h: number } | undefined;
  private endReason: FlightEndReason | undefined;
  private baseWorld: BlockQuery | undefined;
  /** The brain called the landing done: ticks the body has stood since (the server may still disagree). */
  private settling: { ticks: number; end: FlightEnd } | undefined;
  /** Landings the server undid (the body was corrected back into the air). */
  bounces = 0;

  constructor(deps: FlightDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
  }

  /** A flight runs (from `flyTo` until the body stands after it). */
  get active(): boolean {
    return this.brain !== undefined;
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
    this.brain = new FlightBrain(target, { ...opts, groundAt: this.d.groundAt?.bind(this.d), obstacle: (x, y, z) => base.solidAt(x, y, z) === true });
    this.tickNo = 0;
    this.lastFire = -1000;
    this.usedAt = undefined;
    this.rocketId = undefined;
    this.corrections0 = loop.state.corrections;
    this.glideEnds = 0;
    this.everGlided = false;
    this.lastAir = undefined;
    this.endReason = undefined;
    this.settling = undefined;
    this.bounces = 0;
    this.baseWorld = base;
    loop.world = skyQuery(base);
    this.log.info(`flight: to ${target.x.toFixed(1)} ${target.top} ${target.z.toFixed(1)} (half ${target.half}), cruise y ${opts.cruiseY}`);
    return new Promise<FlightReport>((resolve) => {
      this.resolve = resolve;
      this.unsubs.push(
        loop.onBeforeStep((tick, state) => {
          this.tick(state);
        }),
        loop.onEvent((e) => {
          if (e.kind === 'glide') {
            if (e.gliding) this.everGlided = true;
            else this.glideEnds++;
          }
        }),
        this.d.entities.onAdd((e) => {
          this.onEntityAdd(e);
        }),
        this.d.entities.onRemove((e) => {
          if (this.rocketId !== undefined && e.uniqueId === this.rocketId) {
            this.rocketId = undefined;
            this.d.loop.endBoost();
          }
        }),
      );
      loop.setCommand({ forward: 0, strafe: 0, sprint: false, sneak: false, jump: false });
    });
  }

  /** Land now on the nearest safe ground (`!fly stop`, `!land`, health, the elytra): the flight ends `ok: false, reason`. */
  landNow(reason: Extract<FlightEnd, { ok: false }>['reason'] = 'stopped'): void {
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

  private rocketsInHotbar(): { count: number; slot: number } {
    let count = 0;
    let slot = -1;
    const slots = this.d.inventory.slots;
    for (let i = 0; i < 9; i++) {
      const s = slots[i];
      if (s && s.count > 0 && isRocket(s.name)) {
        count += s.count;
        if (slot < 0 || i === this.d.inventory.selected) slot = i;
      }
    }
    return { count, slot };
  }

  private tick(state: InputLoopState): void {
    const brain = this.brain;
    if (!brain) return;
    this.tickNo++;
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
        loop.setCommand({ glide: false, jump: false, pitch: 0, forward: 0, strafe: 0 });
        return;
      }
    }
    const rockets = this.rocketsInHotbar();
    const out = brain.step({
      tick: this.tickNo,
      body: this.body(state),
      yaw: loop.command.yaw,
      pitch: loop.command.pitch,
      rockets: rockets.count,
      canFire: this.tickNo - this.lastFire >= ROCKET_COOLDOWN && rockets.slot >= 0,
      health: this.d.health(),
      elytraLeft: this.d.elytraLeft(),
    });
    const c = out.control;
    loop.setCommand({ yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide, forward: 0, strafe: 0, sprint: false, sneak: false });
    if (c.fire && rockets.slot >= 0) this.fire(rockets.slot, state.pos);
    if (out.end) this.settling = { ticks: 0, end: out.end };
  }

  private fire(slot: number, feet: Vec3): void {
    const { inventory, hotbar } = this.d;
    if (inventory.selected !== slot) hotbar.select(slot);
    const held = wireItemOf(inventory.slots[slot], (inventory.rawItem(0, slot) ?? hotbar.rawItem(slot)) as Parameters<typeof wireItemOf>[1]);
    this.d.queue('inventory_transaction', useItemTransaction({ hotbarSlot: slot, held, eye: { x: feet.x, y: feet.y + PHYSICS.eyeHeight, z: feet.z } }));
    this.d.loop.boost();
    this.lastFire = this.tickNo;
    this.usedAt = this.tickNo;
    this.log.debug(`flight: rocket from slot ${slot} (${inventory.slots[slot]?.count ?? '?'} there)`);
  }

  private onEntityAdd(e: EntityInfo): void {
    if (e.type !== 'minecraft:fireworks_rocket' || this.usedAt === undefined || this.tickNo - this.usedAt > 10) return;
    const p = this.d.loop.state.pos;
    if (Math.hypot(e.pos.x - p.x, e.pos.y - p.y, e.pos.z - p.z) > ROCKET_NEAR + 2) return;
    this.rocketId = e.uniqueId;
    this.usedAt = undefined;
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
      goArounds: b?.stats.goArounds ?? 0,
      ticks: b?.stats.ticks ?? 0,
      corrections: s.corrections - this.corrections0,
      glideEnds: this.glideEnds,
      touchdown: this.lastAir,
      maxY: b?.stats.maxY ?? s.pos.y,
    };
  }

  private finish(ok: boolean, reason: FlightEndReason | undefined, end?: FlightEnd): void {
    if (!this.brain) return;
    const r = this.report(ok, reason, end);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.d.loop.setCommand({ glide: false, jump: false, pitch: 0, forward: 0, strafe: 0 });
    if (this.baseWorld) this.d.loop.world = this.baseWorld;
    this.baseWorld = undefined;
    this.endReason = reason;
    this.log.info(
      `flight: ${ok ? 'landed' : `ended (${reason})`} at ${r.landedAt ? `${r.landedAt.x.toFixed(2)} ${r.landedAt.y.toFixed(2)} ${r.landedAt.z.toFixed(2)}` : '?'}` +
        `${r.off !== undefined ? `, ${r.off.toFixed(2)} from the centre` : ''}; ${r.rockets} rockets, ${r.goArounds} go-arounds, ${r.ticks} ticks, ${r.corrections} corrections` +
        `${r.touchdown ? `, touchdown vy ${r.touchdown.vy.toFixed(3)} h ${r.touchdown.h.toFixed(3)}` : ''}`,
    );
    this.brain = undefined;
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(r);
  }
}
