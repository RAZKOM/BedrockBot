// Elytra flight as processes (wave 11, Track AU; docs/flight.md "Processes"):
//
//   FlyProcess (user, `fly`)   one trip: on the ground it readies the kit (refill from the fireworks
//                              box when the hotbar is low, rockets into the hotbar, the elytra on in
//                              place of the chestplate), starts the FlightController, and after the
//                              landing puts the chestplate back, refills again and tells the owner
//                              when the supply is low. `!fly ...`, `!come` / `!goto` over `flyMin`.
//   FlightProcess (auto, `flight`)  wants control while a flight is in the air, above flee (FLIGHT_PRIORITY):
//                              flee, defend and the night retreat wait for the landing, which the
//                              controller forces itself when the health drops under `fleeHealth` or
//                              the elytra wears down. Registered once by chat/commands-fly.ts.
//
// `!stop` stops the FlyProcess; in the air the controller still lands (the FlightProcess keeps
// control until the body stands), but the chestplate stays off then. `!fly stop` and `!land` land and
// let the trip finish its ground work.
import type { Vec3 } from '../../connection/types.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { FlightController, FlightReport } from '../../skills/fly/controller.ts';
import { elytraWornLimit, kitLine, kitReady, readKit, SupplyWatch, type FlightKitMemory, type KitInventory } from '../../skills/fly/kit.ts';
import type { FlightKitOps } from '../../skills/fly/kitops.ts';
import { cruiseHeight, flightSeconds, hdist, takeoffSky, type CellQuery, type LandingTarget } from '../../skills/fly/plan.ts';
import type { LandingCell, LandingPlan } from '../../skills/fly/landing.ts';
import { glideOptions, type Ledge } from '../../skills/fly/glide.ts';
import { HIGH_CRUISE_Y, highCruiseWanted } from '../../skills/fly/terrain.ts'; // Track BL
import type { SkillResult } from '../../skills/types.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';

/** The flight in the air outranks flee (100): nothing pre-empts a glide. */
export const FLIGHT_PRIORITY = PRIORITY.flee + 1;

export interface FlyTarget extends LandingTarget {
  /** For the lines: `120 45 -30`, `home`, `Steve`, the waypoint name. */
  label: string;
  /** Track AU2, fly-then-walk: the walk after the landing (`then walking 23 blocks`), for the status line. */
  then?: string;
  /**
   * Track AU2 / BF: the real goal of a flight that ends in a walk. Track BF: while the target `hold`s
   * (the goal's ground is not live yet) the landing is looked for every LOOK_EVERY ticks from
   * RETARGET_WITHIN blocks out and the flight retargeted once it is confirmed (`deps.landing`).
   */
  goal?: Vec3;
  /** Track BF: the landing cell (re-checked in the descent: dry, sound, live). */
  cell?: LandingCell;
  /** Track BF: the landing is the nearest dry ground, no walking path was confirmed (why). */
  fallback?: string;
  /** Track BF: the half width of an exact landing on the goal (`!fly <x y z>`), when it is landable. */
  exact?: number;
  /**
   * Track BH: take off by stepping off this edge of the start's platform (walk there, sneak to the edge,
   * step off, glide as the fall begins) instead of the jump (glide.ts findLedges / ledgeTakeoff).
   */
  ledge?: Ledge;
  /** Track BH: the jump takeoff's heading whose simulated climb is clear (commands-fly takeoffFor; else the sky check's). */
  takeoffYaw?: number;
  /** Track BH, the glide down: no climb (the cruise height is the target's), rockets optional, no refill from the box. */
  glide?: boolean;
}

/** Track AU2: the flight re-checks the goal's ground from this far out (the server loads chunks about 160 blocks around the body). */
export const RETARGET_WITHIN = 160;
/** Track BF: the landing search runs at most every this many ticks while the target holds. */
export const LOOK_EVERY = 40;

/**
 * Track BF: the flight target for a landing plan (landing.ts `findLanding`): the goal itself held high
 * while nothing is known or confirmed, else the plan's target with the lines the owner sees.
 */
export function targetFromPlan(plan: LandingPlan, base: { label: string; goal: Vec3; half: number; exact?: number }): FlyTarget {
  const goal = base.goal;
  const common = { label: base.label, goal, ...(base.exact !== undefined ? { exact: base.exact } : {}) };
  switch (plan.kind) {
    case 'unknown':
    case 'none':
      return { x: goal.x + 0.5, z: goal.z + 0.5, top: goal.y, half: base.half, hold: true, ...common };
    case 'goal':
      return { ...plan.target, ...common, cell: plan.cell };
    case 'cell':
      return { ...plan.target, ...common, cell: plan.cell, then: `then walking ${Math.round(plan.walk)} blocks` };
    case 'fallback':
      return { ...plan.target, ...common, cell: plan.cell, fallback: plan.why, then: `then trying to walk ${Math.round(plan.walk)} blocks` };
  }
}

/** Track BF: the owner's line for a landing that is not on the goal (undefined for the goal itself or a hold). */
export function landingLine(t: FlyTarget, walk: number): string | undefined {
  if (t.hold || !t.cell || t.cell.kind === 'goal') return undefined;
  const at = `${t.cell.x} ${t.cell.feet} ${t.cell.z}`;
  if (t.fallback) return `fly: no landing spot near ${t.label} with a walking path (${t.fallback}); landing on dry ground at ${at}, then trying to walk`;
  return `fly: landing ${Math.round(walk)} blocks from ${t.label}${t.bearing !== undefined ? ' (under the overhang)' : ''}, then walking`;
}

export interface FlyDeps {
  controller: FlightController;
  kitOps: FlightKitOps;
  inventory: KitInventory;
  memory(): FlightKitMemory;
  settings: Pick<RuntimeSettings, 'get'>;
  position(): Vec3 | undefined;
  /** The highest solid block of a column (the world model, then the cache), undefined = unknown. */
  skyTop(x: number, z: number): number | undefined;
  /** Track AU2: a cell of the world model (true = solid, false = air, undefined = not loaded) for the sky check over the takeoff. */
  cell: CellQuery;
  /** Track BF, fly then walk: the landing for a goal (landing.ts `findLanding`, commands-fly.ts), for the look in flight. */
  landing?: (goal: Vec3, label: string, exact: number | undefined) => Promise<LandingPlan>;
  /** Track BF: the landing cell is still dry, sound and live (re-checked in the descent). */
  cellOk?: (cell: LandingCell) => boolean;
  /** Track BH: walk to a block (the ledge's edge cell) without a process of its own (the navigator; BotSkills.goto). */
  walkTo?: (p: Vec3) => Promise<SkillResult>;
  /** Track BH: the body is held prone (InputLoopState.prone) and the way out (BotSkills.unprone: break what keeps it from standing). */
  prone?: () => boolean;
  unprone?: () => Promise<{ ok: boolean; dug: string[]; why?: string }>;
  /** The owner's lines (the supply whispers, the kept-kit notes). */
  say(msg: string): void;
  waitTicks(n: number): Promise<void>;
  supply?: SupplyWatch;
  log?: Logger;
}

export type FlyPhase = 'prepare' | 'flying' | 'after' | 'done';

export interface FlyOutcome {
  ok: boolean;
  reason?: string;
  target: FlyTarget;
  distance: number;
  report?: FlightReport;
  /** Seconds from the start of the trip to the end. */
  seconds: number;
  /** Ground-work notes (refill, the chestplate), for the log. */
  notes: string[];
}

export class FlyProcess extends BaseProcess {
  readonly name = 'fly';
  readonly kind = 'user' as const;
  readonly target: FlyTarget;
  readonly result: Promise<FlyOutcome>;
  phase: FlyPhase = 'prepare';
  private resolve!: (r: FlyOutcome) => void;
  private readonly d: FlyDeps;
  private readonly log: Logger;
  private report: FlightReport | undefined;
  private readonly notes: string[] = [];
  private readonly t0 = Date.now();
  private readonly distance: number;
  private flight: Promise<FlightReport> | undefined;
  /** A new trip took this flight over in the air (`handOver`): stopping this process does not land it. */
  private handedOver = false;
  /** `adopt`: the flight in the air flies to this trip's target now (false: it lands where it was going first). */
  retargeted = false;

  constructor(target: FlyTarget, deps: FlyDeps) {
    super();
    this.target = target;
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    const p = deps.position();
    this.distance = p ? hdist(p, target) : 0;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  /** Land now (`!fly stop`, `!land`): the trip then finishes its ground work. */
  land(reason: 'stopped' | 'health' | 'elytra_worn' = 'stopped'): boolean {
    if (this.phase !== 'flying') return false;
    this.d.controller.landNow(reason);
    return true;
  }

  status(): ProcessStatus {
    const c = this.d.controller.status();
    if (this.phase === 'flying' && c.active) {
      const left = c.distance ?? this.distance;
      return { line: `flying to ${this.target.label}: ${c.phase ?? '?'}${c.descending ? ` (${c.descending})` : ''}, ${Math.round(left)} blocks left, ${c.rockets} rocket${c.rockets === 1 ? '' : 's'}${this.target.then ? `, ${this.target.then}` : ''}`, etaS: flightSeconds(left) - 8 };
    }
    if (this.phase === 'prepare') return { line: `readying the flight kit for ${this.target.label}` };
    if (this.phase === 'after') return { line: `landed near ${this.target.label}: the chestplate and the rockets` };
    return { line: `flight to ${this.target.label} over` };
  }

  behaviour(): string {
    return this.phase === 'flying' ? `flying to ${this.target.label}` : `flight to ${this.target.label} (${this.phase})`;
  }

  protected run(t: number, _resumed: boolean): void {
    void this.advance(t);
  }

  protected halt(): void {
    // the ground steps check the token between their moves; the flight itself is not ours to stop here
  }

  /**
   * A new trip takes over this flight in the air (the next FlyProcess `adopt`s it): when this process is
   * replaced it ends `replaced` without landing, and its trip's walk does not run.
   */
  handOver(): void {
    this.handedOver = true;
  }

  /**
   * Take over the flight in the air for this trip instead of preparing a new one (a `!goto`, `!come` or
   * `!fly` while flying; the trip before it `handOver`s): the flight is retargeted to this trip's target,
   * its cruise raised when the new trip needs more; once it lands this process does the ground work
   * (chestplate, refill) as after its own flight. A retarget the brain refuses (the approach has begun,
   * the touchdown is near) leaves the flight going to where it was: `retargeted` is false then and the
   * caller starts the trip again from the ground. False when there is no flight to take over.
   */
  adopt(cruiseY?: number): boolean {
    const f = this.d.controller.flight;
    if (!f || this.phase !== 'prepare') return false;
    this.phase = 'flying';
    this.flight = f;
    this.retargeted = this.d.controller.retarget(this.target, cruiseY !== undefined ? { cruiseY } : {});
    this.log.info(`fly: the flight in the air ${this.retargeted ? 'flies on' : 'lands where it was going first (too close to its touchdown to move it), then the trip starts again'} to ${this.target.label}`);
    void f.then((r) => {
      this.report = r;
      if (this.done) return;
      this.phase = 'after';
      if (this.controlled) void this.advance(this.token);
    });
    if (this.retargeted && this.target.goal && this.d.landing) void this.watchLanding(this.target.goal, this.d.landing);
    return true;
  }

  protected override onStopped(reason: StopReason): void {
    if (this.phase === 'flying' && this.d.controller.active && !this.handedOver) {
      this.log.info(`fly: stopped (${reason}) in the air: landing`);
      this.d.controller.landNow('stopped');
    }
    this.resolve(this.outcome({ ok: false, reason: reason === 'replaced' ? 'replaced' : 'interrupted' }));
  }

  private outcome(r: SkillResult): FlyOutcome {
    return { ok: r.ok, ...(r.ok ? {} : { reason: r.reason ?? 'failed' }), target: this.target, distance: this.distance, ...(this.report ? { report: this.report } : {}), seconds: Math.round((Date.now() - this.t0) / 1000), notes: this.notes };
  }

  private end(r: SkillResult): void {
    this.phase = 'done';
    this.finish();
    this.resolve(this.outcome(r));
  }

  private kit() {
    return readKit(this.d.inventory, this.d.memory());
  }

  private async advance(t: number): Promise<void> {
    try {
      if (this.phase === 'prepare') await this.prepare(t);
      if (t !== this.token) return;
      if (this.phase === 'after') await this.after(t);
    } catch (e) {
      if (t === this.token) this.end({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  private async prepare(t: number): Promise<void> {
    const s = this.d.settings;
    const wear = s.get('toolWearLimit');
    let kit = this.kit();
    const glide = this.target.glide === true;
    const ready = kitReady(kit, wear);
    // Track BH: a glide down needs no rocket (the elytra's uses are checked the same)
    if (!ready.ok && !(glide && ready.reason === 'no_rockets')) {
      this.end({ ok: false, reason: ready.line });
      return;
    }
    const min = s.get('fireworksMin');
    if (glide) {
      // rockets optional: into the hotbar when there are some, no refill (no box placed on a ledge)
      if (kit.rocketsHotbar === 0 && kit.rockets > 0) await this.d.kitOps.rocketsToHotbar();
      if (t !== this.token) return;
      kit = this.kit();
    } else if (kit.rocketsHotbar < min && kit.boxRockets > 0) {
      const r = await this.d.kitOps.refillFromBox(() => t === this.token);
      if (t !== this.token) return;
      this.notes.push(`refill before: ${r.ok ? `${r.taken} rockets` : (r.reason ?? 'failed')}`);
      kit = this.kit();
    }
    if (kit.rocketsHotbar === 0 && !glide) {
      const r = await this.d.kitOps.rocketsToHotbar();
      if (t !== this.token) return;
      if (!r.ok) {
        this.end({ ok: false, reason: `fly: ${r.reason ?? 'no rockets in the hotbar'}` });
        return;
      }
      kit = this.kit();
    }
    if (kit.rocketsHotbar === 0 && kit.rockets === 0 && !glide) {
      this.end({ ok: false, reason: 'fly: no firework rockets at hand' });
      return;
    }
    if (!kit.elytraWorn) {
      const w = await this.d.kitOps.wearElytra();
      if (t !== this.token) return;
      if (!w.ok) {
        this.end({ ok: false, reason: `fly: ${w.reason ?? 'the elytra could not be put on'}` });
        return;
      }
      // the server confirms the armour slot with inventory_slot: give it a moment
      for (let i = 0; i < 20 && !this.kit().elytraWorn; i++) await this.d.waitTicks(1);
      if (t !== this.token) return;
      if (!this.kit().elytraWorn) {
        this.end({ ok: false, reason: 'fly: the elytra is not on my back (the server did not confirm it)' });
        return;
      }
    }
    // Track BH: a ledge takeoff walks to the edge cell first (the navigator, no digging needed: the ledge is on the start's platform)
    const ledge = this.target.ledge;
    if (ledge) {
      const at = { x: ledge.x, y: ledge.feet, z: ledge.z };
      const here = this.d.position();
      const there = here && Math.floor(here.x) === ledge.x && Math.floor(here.z) === ledge.z && Math.abs(here.y - ledge.feet) < 0.5;
      if (!there) {
        const w = this.d.walkTo ? await this.d.walkTo(at) : { ok: false, reason: 'no walking' };
        if (t !== this.token) return;
        if (!w.ok) {
          this.end({ ok: false, reason: `fly: could not walk to the edge at ${ledge.x} ${ledge.feet} ${ledge.z} (${w.reason ?? 'failed'})` });
          return;
        }
      }
      await this.d.waitTicks(4);
      if (t !== this.token) return;
    }
    const from = this.d.position();
    if (!from) {
      this.end({ ok: false, reason: 'fly: position unknown' });
      return;
    }
    if (ledge && (Math.floor(from.x) !== ledge.x || Math.floor(from.z) !== ledge.z || Math.abs(from.y - ledge.feet) > 0.5)) {
      this.end({ ok: false, reason: `fly: not on the edge cell ${ledge.x} ${ledge.feet} ${ledge.z} after the walk (at ${Math.floor(from.x)} ${Math.floor(from.y)} ${Math.floor(from.z)})` });
      return;
    }
    const cz = cruiseHeight(from, this.target, (x, z) => this.d.skyTop(x, z), { clearance: s.get('flyClearance'), margin: s.get('flyMargin'), maxClimb: s.get('flyMaxClimb') });
    // Track AU2: open sky over the start and the takeoff run (the owner's indoor takeoff flew into the roof); Track BH: a
    // ledge takeoff was simulated from the edge instead (its corridor, the glide out from under an overhang)
    const sky = ledge ? undefined : takeoffSky(from, this.target, cz.y, s.get('flyTakeoffRun'), this.d.cell);
    if (sky && !sky.ok) {
      this.log.info(`fly: ${this.target.label}: ${sky.line}`);
      this.end({ ok: false, reason: sky.line });
      return;
    }
    // Track BL: the high cruise (flyHighCruise) over the build limit: `always`, or `auto` for a long trip over unseen terrain that needs nearly that height anyway
    const high = !glide && highCruiseWanted(String(s.get('flyHighCruise')), { distance: this.distance, needed: cz.needed, unknown: cz.unknown });
    const cruiseY = glide && ledge ? this.target.top : high ? Math.max(cz.y, HIGH_CRUISE_Y) : cz.y;
    this.log.info(
      `fly: to ${this.target.label} (${Math.round(this.distance)} blocks): ${glide ? `a glide down (no climb, ${this.kit().rocketsHotbar} rockets at hand)` : `cruise y ${cruiseY.toFixed(1)}${high ? ' (the high cruise)' : ''} (highest column ${cz.highest ?? '?'}, ${cz.unknown} unknown, the glide needs ${cz.needed.toFixed(0)})`}${ledge ? `, a ledge takeoff from ${ledge.x} ${ledge.feet} ${ledge.z} heading ${Math.round(ledge.yaw)}` : ''}; ${kitLine(this.kit())}`,
    );
    this.phase = 'flying';
    // Track BL: the terrain floor, the clearance, the high cruise and the descent mode (a glide down keeps its simulated plan: no floor)
    const bl = { clearance: s.get('flyClearance'), descent: String(s.get('flyDescent')) as 'auto' | 'dive' | 'spiral', ...(high ? { highCruise: true } : {}) };
    const opts = glide && ledge ? { ...glideOptions(this.target, ledge, { margin: s.get('flyMargin'), goArounds: s.get('flyGoArounds') }), terrainFloor: false, descent: bl.descent } : { cruiseY, margin: s.get('flyMargin'), goArounds: s.get('flyGoArounds'), ...(ledge ? { ledge: { yaw: ledge.yaw } } : {}), ...bl };

    this.flight = this.d.controller.flyTo(this.target, {
      ...opts,
      fleeHealth: s.get('fleeHealth'),
      elytraWornAt: elytraWornLimit(wear),
      ...(sky?.ok ? { takeoffYaw: this.target.takeoffYaw ?? sky.yaw } : {}),
    });
    void this.flight.then((r) => {
      this.report = r;
      if (this.done) return;
      this.phase = 'after';
      // the FlightProcess held control in the air; when it lets go the manager resumes us (run -> advance)
      if (this.controlled) void this.advance(this.token);
    });
    if (this.target.goal && this.d.landing) void this.watchLanding(this.target.goal, this.d.landing);
  }

  /**
   * Track BF (docs/flight.md "Landing v3"): the landing of a flight that ends in a walk is only ever a
   * cell of the live world model with a confirmed walking path to the goal. While the target holds
   * (the goal's ground is not loaded, or nothing near it is known) the landing is looked for every
   * LOOK_EVERY ticks from RETARGET_WITHIN blocks out, and the flight retargeted once there is one (a
   * confirmed cell, or the nearest dry ground with a line saying so). A chosen cell is re-checked in
   * the descent (dry, sound, live) and searched again when it fails. Holding longer than `flyHoldS`
   * ends the flight on the nearest dry ground (`no_landing`; the walk still runs).
   */
  private async watchLanding(goal: Vec3, find: NonNullable<FlyDeps['landing']>): Promise<void> {
    // not gated on the token: the `flight` process holds control in the air and this process is paused
    // (its token moves on) until the landing, like the flight's own `.then` above
    let ticks = 0;
    let lastLook = -Infinity;
    let holdSince: number | undefined;
    let unknown = 0;
    const holdTicks = this.d.settings.get('flyHoldS') * 20;
    for (;;) {
      await this.d.waitTicks(10);
      ticks += 10;
      if (this.done || this.phase !== 'flying' || !this.d.controller.active) return;
      const c = this.d.controller.status();
      if (c.phase === 'land' || c.phase === 'done') return;
      const t = this.target;
      if (!t.hold) {
        // a chosen cell: re-checked every LOOK_EVERY ticks until the touchdown is near
        if (c.distance !== undefined && c.distance < 6) return;
        if (!t.cell || !this.d.cellOk || ticks - lastLook < LOOK_EVERY) continue;
        lastLook = ticks;
        if (this.d.cellOk(t.cell)) continue;
        this.log.info(`fly: the landing cell ${t.cell.x} ${t.cell.feet} ${t.cell.z} is no longer landable (${Math.round(c.distance ?? 0)} blocks out): looking again`);
      } else {
        if (c.distance === undefined || c.distance > RETARGET_WITHIN) continue;
        if (c.descending === 'holding') holdSince ??= ticks;
        if (holdSince !== undefined && ticks - holdSince > holdTicks) {
          this.log.info(`fly: held ${Math.round((ticks - holdSince) / 20)} s over ${t.label} without a landing: the nearest dry ground`);
          this.d.say(`fly: no landing near ${t.label} after ${Math.round((ticks - holdSince) / 20)} s (its ground did not load or nothing walks there); landing on the nearest dry ground, then trying to walk`);
          this.d.controller.landNow('no_landing');
          return;
        }
        if (ticks - lastLook < LOOK_EVERY) continue;
        lastLook = ticks;
      }
      const plan = await find(goal, t.label, t.exact);
      if (this.done || this.phase !== 'flying' || !this.d.controller.active) return;
      if (plan.kind === 'unknown' || plan.kind === 'none') {
        if (++unknown % 5 === 1) this.log.info(`fly: ${plan.line} (${Math.round(c.distance ?? 0)} blocks out, ${c.phase}${c.descending ? `, ${c.descending}` : ''})`);
        if (!t.hold) {
          const held = targetFromPlan(plan, { label: t.label, goal, half: t.half, ...(t.exact !== undefined ? { exact: t.exact } : {}) });
          if (this.d.controller.retarget(held)) (this as { target: FlyTarget }).target = held;
        }
        continue;
      }
      this.log.info(`fly: ${plan.line}`);
      const next = targetFromPlan(plan, { label: t.label, goal, half: t.half, ...(t.exact !== undefined ? { exact: t.exact } : {}) });
      if (!t.hold && t.cell && next.cell?.x === t.cell.x && next.cell.z === t.cell.z && next.cell.feet === t.cell.feet) continue; // the same cell
      if (!this.d.controller.retarget(next)) {
        this.log.info(`fly: the landing could not be moved now (${c.phase}, ${Math.round(c.distance ?? 0)} blocks out)`);
        continue;
      }
      (this as { target: FlyTarget }).target = next;
      const line = landingLine(next, plan.kind === 'goal' ? 0 : plan.walk);
      if (line) this.d.say(line);
    }
  }

  private async after(t: number): Promise<void> {
    const r = this.report;
    if (!r) return;
    const s = this.d.settings;
    // stand still a moment: the landing's last corrections
    await this.d.waitTicks(5);
    if (t !== this.token) return;
    // Track BH: a glide that ended under less than 1.8 of headroom (a canopy, a slab roof) leaves the body prone: dig it free
    if (this.d.prone?.() && this.d.unprone) {
      const u = await this.d.unprone();
      if (t !== this.token) return;
      this.log.info(`fly: prone after the landing: ${u.ok ? `standing again${u.dug.length ? ` after breaking ${u.dug.join(', ')}` : ''}` : `still prone (${u.why ?? '?'})`}`);
      if (!u.ok) this.d.say(`fly: I landed somewhere I cannot stand up (${u.why ?? '?'}); help me out`);
    }
    const c = await this.d.kitOps.wearChestplate();
    if (t !== this.token) return;
    if (!c.ok) this.notes.push(c.reason ?? 'chestplate not put back');
    let kit = this.kit();
    const min = s.get('fireworksMin');
    if (kit.rocketsHotbar < min && kit.boxRockets > 0 && r.ok) {
      const f = await this.d.kitOps.refillFromBox(() => t === this.token);
      if (t !== this.token) return;
      this.notes.push(`refill after: ${f.ok ? `${f.taken} rockets` : (f.reason ?? 'failed')}`);
      kit = this.kit();
    }
    for (const line of (this.d.supply ?? new SupplyWatch()).check(kit, min, s.get('toolWearLimit'))) this.d.say(line);
    if (r.ok) this.end({ ok: true });
    else this.end({ ok: false, reason: r.reason ?? 'landed_off' });
  }
}

/** The in-air holder of control: above everything while the controller flies; it never moves the body itself. */
export class FlightProcess extends BaseProcess {
  readonly name = 'flight';
  readonly kind = 'auto' as const;
  private readonly controller: FlightController;

  constructor(controller: FlightController) {
    super();
    this.controller = controller;
    this.persistent = true;
  }

  get priority(): number {
    return FLIGHT_PRIORITY;
  }

  override wants(): boolean {
    return this.controller.active;
  }

  protected run(): void {}

  protected halt(): void {}

  status(): ProcessStatus {
    const c = this.controller.status();
    return { line: c.active ? `in the air: ${c.phase ?? '?'}${c.distance !== undefined ? `, ${Math.round(c.distance)} blocks to go` : ''}, ${c.rockets} rockets` : 'on the ground' };
  }
}
