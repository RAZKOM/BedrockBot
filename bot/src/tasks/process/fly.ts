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
   * Track AU2: the real goal when this target is the goal itself with its ground still unknown at the
   * takeoff (too far to be loaded): once the flight is within `RETARGET_WITHIN` blocks the landable
   * cell near it is looked for again and the flight retargeted to it (`deps.landingNear`).
   */
  goal?: Vec3;
}

/** Track AU2: the flight re-checks the goal's ground from this far out (the server loads chunks about 160 blocks around the body). */
export const RETARGET_WITHIN = 160;

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
  /** Track AU2, fly then walk: the landable cell near a goal (commands-fly.ts `landingNear`), for the retarget in flight. */
  landingNear?: (goal: Vec3) => Promise<{ x: number; z: number; top: number; walk: number; loaded: boolean } | null | undefined>;
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

  protected override onStopped(reason: StopReason): void {
    if (this.phase === 'flying' && this.d.controller.active) {
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
    const ready = kitReady(kit, wear);
    if (!ready.ok) {
      this.end({ ok: false, reason: ready.line });
      return;
    }
    const min = s.get('fireworksMin');
    if (kit.rocketsHotbar < min && kit.boxRockets > 0) {
      const r = await this.d.kitOps.refillFromBox(() => t === this.token);
      if (t !== this.token) return;
      this.notes.push(`refill before: ${r.ok ? `${r.taken} rockets` : (r.reason ?? 'failed')}`);
      kit = this.kit();
    }
    if (kit.rocketsHotbar === 0) {
      const r = await this.d.kitOps.rocketsToHotbar();
      if (t !== this.token) return;
      if (!r.ok) {
        this.end({ ok: false, reason: `fly: ${r.reason ?? 'no rockets in the hotbar'}` });
        return;
      }
      kit = this.kit();
    }
    if (kit.rocketsHotbar === 0 && kit.rockets === 0) {
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
    const from = this.d.position();
    if (!from) {
      this.end({ ok: false, reason: 'fly: position unknown' });
      return;
    }
    const cz = cruiseHeight(from, this.target, (x, z) => this.d.skyTop(x, z), { clearance: s.get('flyClearance'), margin: s.get('flyMargin'), maxClimb: s.get('flyMaxClimb') });
    // Track AU2: open sky over the start and the takeoff run (the owner's indoor takeoff flew into the roof)
    const sky = takeoffSky(from, this.target, cz.y, s.get('flyTakeoffRun'), this.d.cell);
    if (!sky.ok) {
      this.log.info(`fly: ${this.target.label}: ${sky.line}`);
      this.end({ ok: false, reason: sky.line });
      return;
    }
    this.log.info(`fly: to ${this.target.label} (${Math.round(this.distance)} blocks): cruise y ${cz.y.toFixed(1)} (highest column ${cz.highest ?? '?'}, ${cz.unknown} unknown, the glide needs ${cz.needed.toFixed(0)}); ${kitLine(this.kit())}`);
    this.phase = 'flying';
    this.flight = this.d.controller.flyTo(this.target, {
      cruiseY: cz.y,
      goArounds: s.get('flyGoArounds'),
      fleeHealth: s.get('fleeHealth'),
      elytraWornAt: elytraWornLimit(wear),
      margin: s.get('flyMargin'),
      takeoffYaw: sky.yaw,
    });
    void this.flight.then((r) => {
      this.report = r;
      if (this.done) return;
      this.phase = 'after';
      // the FlightProcess held control in the air; when it lets go the manager resumes us (run -> advance)
      if (this.controlled) void this.advance(this.token);
    });
    if (this.target.goal && this.d.landingNear) void this.retargetNear(this.target.goal, this.d.landingNear);
  }

  /**
   * Track AU2, fly then walk: the goal's ground was unknown at the takeoff; once the flight is within
   * RETARGET_WITHIN blocks (the chunks there are loaded) the landable cell near the goal is looked for
   * and, when it is not the goal itself, the flight is retargeted to it and the owner told.
   */
  private async retargetNear(goal: Vec3, near: NonNullable<FlyDeps['landingNear']>): Promise<void> {
    // not gated on the token: the `flight` process holds control in the air and this process is paused
    // (its token moves on) until the landing, like the flight's own `.then` above
    let unknown = 0;
    for (;;) {
      await this.d.waitTicks(10);
      if (this.done || this.phase !== 'flying' || !this.d.controller.active) return;
      const c = this.d.controller.status();
      if (c.distance === undefined || c.distance > RETARGET_WITHIN) continue;
      if (c.phase === 'land' || c.phase === 'done' || c.distance < 15) return;
      const cell = await near(goal);
      if (this.done || this.phase !== 'flying') return;
      if (cell === null) {
        // loaded and nothing landable within flyLandSearch: the goal itself stays the target, no more searching
        this.log.info(`fly: nothing landable near ${this.target.label} (${Math.round(c.distance)} blocks out): aiming at it`);
        return;
      }
      if (!cell) {
        // the goal's chunk is not loaded yet: again in 10 ticks (the chunks often arrive as the approach begins)
        if (++unknown % 10 === 1) this.log.info(`fly: the ground at ${this.target.label} is not known yet (${Math.round(c.distance)} blocks out, ${c.phase})`);
        continue;
      }
      if (!cell.loaded) {
        if (++unknown % 10 === 1) this.log.info(`fly: the ground at ${this.target.label} is only cached so far (${Math.round(c.distance)} blocks out, ${c.phase})`);
        continue;
      }
      if (cell.walk <= 0) return; // the goal itself is landable
      const target: FlyTarget = { x: cell.x + 0.5, z: cell.z + 0.5, top: cell.top, half: 1, label: this.target.label, then: `then walking ${Math.round(cell.walk)} blocks` };
      if (Math.abs(target.x - this.target.x) < 0.1 && Math.abs(target.z - this.target.z) < 0.1 && target.top === this.target.top) return; // the same cell as planned
      if (!this.d.controller.retarget(target)) return;
      (this as { target: FlyTarget }).target = target;
      this.log.info(`fly: ${this.target.label} is not landable: landing ${Math.round(cell.walk)} blocks from it, then walking`);
      this.d.say(`fly: landing ${Math.round(cell.walk)} blocks from ${this.target.label} (no landing spot on it), then walking`);
      return;
    }
  }

  private async after(t: number): Promise<void> {
    const r = this.report;
    if (!r) return;
    const s = this.d.settings;
    // stand still a moment: the landing's last corrections
    await this.d.waitTicks(5);
    if (t !== this.token) return;
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
