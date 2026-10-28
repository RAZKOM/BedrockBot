// The flight brain (wave 11, Track AU; docs/flight.md "The controller"): a pure per-tick state
// machine from the body (position, velocity, gliding, boost) to the controls a vanilla player has
// (yaw, pitch, the jump key, the glide request, a rocket). Phases:
//
//   takeoff   on the ground: jump; falling: request the glide (start_gliding goes out with the next
//             input; from a ledge the fall is the takeoff)
//   climb     rockets back to back, pitched up, until the cruise height
//   cruise    level, heading for the target; a rocket when the height falls under the slope towards
//             the approach entry (SINK_RATIO), a shallow dive when the speed stalls
//   approach  within APPROACH_DISTANCE: the ApproachPlanner of plan.ts re-optimises a three-segment
//             profile (approach pitch to a flare point, a hard pull-up that trades the speed for
//             height, a shallow settle) every tick from the real body and the brain flies its pitch:
//             the body comes in low, zoom-climbs to the platform top with the speed bled off and
//             sinks onto it near its centre; the server's glide ends on ground contact
//   goaround  no candidate lands: one rocket, a climbing turn away, back out to the approach
//             distance, and a new approach (at most `goArounds`)
//   land      an emergency or the go-arounds used up: the nearest safe ground ahead, same landing
//
// The brain never moves the body itself: skills/fly/controller.ts feeds it the InputLoop's state and
// applies its controls; the unit tests and the offline simulator drive it with the physics engine.
import type { Vec3 } from '../../connection/types.ts';
import {
  APPROACH_DISTANCE,
  APPROACH_HEIGHT,
  ApproachPlanner,
  approachHopeless,
  approachYaw,
  DEFAULT_GO_AROUNDS,
  hdist,
  SINK_RATIO,
  STALL_SPEED,
  turnTowards,
  yawTo,
  type FlightBody,
  type LandingTarget,
} from './plan.ts';

export type FlightPhase = 'takeoff' | 'climb' | 'cruise' | 'approach' | 'goaround' | 'land' | 'done';

export interface BrainInput {
  tick: number;
  body: FlightBody;
  /** The current look (the command's yaw / pitch). */
  yaw: number;
  pitch: number;
  /** Rockets at hand (in the hotbar) and whether one may be fired this tick (the last use settled). */
  rockets: number;
  canFire: boolean;
  health: number;
  elytraLeft: number | undefined;
}

export interface BrainControl {
  yaw: number;
  pitch: number;
  jump: boolean;
  glide: boolean;
  /** Use a rocket this tick. */
  fire: boolean;
}

export type FlightEnd =
  | { ok: true; landedAt: Vec3; off: number; onTarget: boolean }
  | { ok: false; reason: 'landed_off' | 'no_rockets' | 'health' | 'elytra_worn' | 'stopped' | 'lost'; landedAt: Vec3; off: number; onTarget: boolean };

export interface BrainOptions {
  /** The cruise height (feet y) to climb to and hold. */
  cruiseY: number;
  goArounds?: number;
  /** Land at once under this health (fleeHealth) or at / under this many elytra uses (toolWearLimit + 20). */
  fleeHealth?: number;
  elytraWornAt?: number;
  /** Safe ground under (x, z): the feet height of a body standing there, undefined when unknown or unsafe. */
  groundAt?: (x: number, z: number) => number | undefined;
  /** The pitch of a climbing rocket (negative = looking up). */
  climbPitch?: number;
  /** A solid cell at integer (x, y, z) in the world model (the approach planner avoids them; unknown = false). */
  obstacle?: (x: number, y: number, z: number) => boolean;
  /** The planner's seed (deterministic flights). */
  seed?: number;
}

export interface FlightStats {
  rockets: number;
  goArounds: number;
  ticks: number;
  maxY: number;
  /** Corrections are the loop's business; the brain counts approach ticks and the pitch range it used. */
  approachTicks: number;
}

const CLIMB_PITCH = -38;

/** The rocket climb's pitch for a climb of `height` blocks: shallow for a short one (a -38 climb overshoots a 12-block one by 14 blocks of momentum). */
export function climbPitchFor(height: number): number {
  return height <= 15 ? -20 : height <= 30 ? -30 : CLIMB_PITCH;
}

/** Blocks a body rising at vy still climbs after the boost ends (pitched level: vy decays by about 0.04 per tick). */
export function climbMomentum(vy: number): number {
  return vy > 0 ? (vy * vy) / 0.08 : 0;
}
const CRUISE_BAND = 7;
/** Cruise: more than this above the approach entry height near the target -> spiral down until SPIRAL_UNTIL above it. */
const SPIRAL_ABOVE = 22;
const SPIRAL_UNTIL = 10;
/** Degrees of yaw per tick while spiralling (a circle of about 6 blocks radius at cruise speed). */
const SPIRAL_TURN = 12;
/** Cruise: within this many blocks before the approach distance the speed is bled to APPROACH_SPEED (pitch -6: 1.3 -> 1.0 in 30 ticks). */
const BLEED_DISTANCE = 40;
const APPROACH_SPEED = 1.05;
const GOAROUND_OUT = APPROACH_DISTANCE + 12;

export class FlightBrain {
  phase: FlightPhase = 'takeoff';
  readonly target: LandingTarget;
  readonly stats: FlightStats = { rockets: 0, goArounds: 0, ticks: 0, maxY: -Infinity, approachTicks: 0 };
  /** Why the flight is ending early (set by `landNow`), kept for the outcome. */
  private endReason: Extract<FlightEnd, { ok: false }>['reason'] | undefined;
  private readonly o: Required<Pick<BrainOptions, 'cruiseY' | 'goArounds' | 'fleeHealth' | 'elytraWornAt' | 'climbPitch'>> & Pick<BrainOptions, 'groundAt'>;
  private jumped = false;
  private requested = false;
  private wasGliding = false;
  /** The emergency landing target (phase `land`). */
  private emergency: LandingTarget | undefined;
  /** Go-around: flying away until out, then back. */
  private outbound = false;
  private lastChoice: { pitch: number; cost: number; kind: string; phase: string } | undefined;
  /** The landing planner of the current approach (reset for every new approach). */
  private readonly planner: ApproachPlanner;
  private startY: number | undefined;
  private noRocketTicks = 0;
  /** Cruise: spiralling down (far too high near the target). */
  private spiral = false;

  constructor(target: LandingTarget, opts: BrainOptions) {
    this.target = target;
    this.o = {
      cruiseY: opts.cruiseY,
      goArounds: opts.goArounds ?? DEFAULT_GO_AROUNDS,
      fleeHealth: opts.fleeHealth ?? 8,
      elytraWornAt: opts.elytraWornAt ?? 30,
      climbPitch: opts.climbPitch ?? CLIMB_PITCH, // adapted to the climb's height at the takeoff (climbPitchFor)
      groundAt: opts.groundAt,
    };
    this.planner = new ApproachPlanner(opts.seed ?? 12345, opts.obstacle);
  }

  /** The current aim (the landing target, or the emergency one). */
  get aim(): LandingTarget {
    return this.emergency ?? this.target;
  }

  get lastApproach(): { pitch: number; cost: number; kind: string; phase: string } | undefined {
    return this.lastChoice;
  }

  /** Land now (`!fly stop`, `!land`, health, the elytra): the nearest safe ground ahead. */
  landNow(reason: Extract<FlightEnd, { ok: false }>['reason'], body: FlightBody): void {
    if (this.phase === 'done') return;
    this.endReason ??= reason;
    if (this.phase === 'takeoff' && !body.gliding) {
      // not in the air yet: nothing to land
      this.phase = 'done';
      return;
    }
    this.emergency = this.emergencyTarget(body);
    this.planner.reset();
    this.phase = 'land';
  }

  /**
   * The body is in the air again after the brain called the landing done (the server corrected a
   * touchdown the local model predicted): fly on. Near the target the approach starts over; far from
   * it (or when the flight was ending anyway) the nearest safe ground.
   */
  bounce(body: FlightBody): void {
    if (this.phase !== 'done') return;
    if (this.endReason === undefined && hdist(body.pos, this.target) <= APPROACH_DISTANCE) {
      this.phase = 'approach';
      this.planner.reset();
      return;
    }
    this.phase = 'cruise';
    this.landNow(this.endReason ?? 'lost', body);
  }

  /** One tick: the controls for the body now, and the outcome once it stands. */
  step(i: BrainInput): { control: BrainControl; end?: FlightEnd } {
    const b = i.body;
    this.stats.ticks++;
    if (this.startY === undefined) {
      this.startY = b.pos.y;
      if (this.o.climbPitch === CLIMB_PITCH) this.o.climbPitch = climbPitchFor(this.o.cruiseY - b.pos.y);
    }
    if (b.pos.y > this.stats.maxY) this.stats.maxY = b.pos.y;
    const ctl: BrainControl = { yaw: i.yaw, pitch: i.pitch, jump: false, glide: this.requested, fire: false };

    // the forced landings
    if (this.phase !== 'land' && this.phase !== 'done' && this.phase !== 'takeoff') {
      if (i.health < this.o.fleeHealth) this.landNow('health', b);
      else if (i.elytraLeft !== undefined && i.elytraLeft <= this.o.elytraWornAt) this.landNow('elytra_worn', b);
    }

    // standing after a glide: the flight is over
    if (this.wasGliding && !b.gliding && b.onGround) {
      this.phase = 'done';
      return { control: { ...ctl, glide: false, pitch: 0 }, end: this.outcome(b) };
    }
    if (b.gliding) this.wasGliding = true;

    switch (this.phase) {
      case 'takeoff':
        return { control: this.takeoff(i, ctl) };
      case 'climb':
        return { control: this.climb(i, ctl) };
      case 'cruise':
        return { control: this.cruise(i, ctl) };
      case 'approach':
        return { control: this.approach(i, ctl, this.target) };
      case 'goaround':
        return { control: this.goaround(i, ctl) };
      case 'land':
        return { control: this.approach(i, ctl, this.aim) };
      case 'done':
        return { control: { ...ctl, glide: false }, end: this.outcome(b) };
    }
  }

  private outcome(b: FlightBody): FlightEnd {
    const t = this.target;
    const off = hdist(b.pos, t);
    const onTarget = off <= t.half + 0.5 && Math.abs(b.pos.y - t.top) < 1.2;
    if (this.endReason) return { ok: false, reason: this.endReason, landedAt: { ...b.pos }, off, onTarget };
    if (onTarget) return { ok: true, landedAt: { ...b.pos }, off, onTarget };
    return { ok: false, reason: 'landed_off', landedAt: { ...b.pos }, off, onTarget };
  }

  private takeoff(i: BrainInput, ctl: BrainControl): BrainControl {
    const b = i.body;
    ctl.yaw = turnTowards(i.yaw, yawTo(b.pos, this.target), 30);
    ctl.pitch = 0;
    if (b.gliding) {
      this.phase = 'climb';
      return this.climb(i, ctl);
    }
    if (b.onGround && !this.jumped) {
      this.jumped = true;
      ctl.jump = true;
      return ctl;
    }
    // airborne and falling: the glide (the engine starts it with the next input; BDS wants the request while falling)
    if (!b.onGround && b.vel.y < 0) {
      this.requested = true;
      ctl.glide = true;
      ctl.pitch = this.o.climbPitch;
    } else if (b.onGround && this.jumped && !this.requested) {
      // back on the ground without a glide (the jump was spent): jump again
      this.jumped = false;
    }
    return ctl;
  }

  private fire(i: BrainInput, ctl: BrainControl): boolean {
    if (i.rockets <= 0 || !i.canFire || i.body.boostTicks > 0) return false;
    ctl.fire = true;
    this.stats.rockets++;
    return true;
  }

  private climb(i: BrainInput, ctl: BrainControl): BrainControl {
    const b = i.body;
    ctl.glide = true;
    ctl.yaw = turnTowards(i.yaw, yawTo(b.pos, this.target));
    const d = hdist(b.pos, this.target);
    // the climb goes on after the last rocket: a body rising at vy keeps about vy^2 / 0.08 blocks of climb
    const willReach = b.pos.y + climbMomentum(b.vel.y);
    if (willReach >= this.o.cruiseY || d <= APPROACH_DISTANCE + 6) {
      this.phase = d <= APPROACH_DISTANCE + 6 ? 'approach' : 'cruise';
      return this.phase === 'approach' ? this.approach(i, ctl, this.target) : this.cruise(i, ctl);
    }
    const h = Math.hypot(b.vel.x, b.vel.z);
    if (b.boostTicks > 0) {
      ctl.pitch = this.o.climbPitch;
      return ctl;
    }
    if (i.rockets <= 0) {
      // nothing to climb with: cruise with what we have (and land short if it comes to that)
      this.phase = 'cruise';
      return this.cruise(i, ctl);
    }
    // between rockets: keep the speed, pitch up only while it lasts; the next rocket only when the momentum will not carry us there
    ctl.pitch = h < STALL_SPEED + 0.15 ? 10 : h < 0.9 ? -10 : this.o.climbPitch;
    if (willReach < this.o.cruiseY - 6 && this.fire(i, ctl)) ctl.pitch = this.o.climbPitch;
    return ctl;
  }

  /** The height the cruise wants here: the cruise height, descending along the glide slope into the approach entry. */
  private wantY(b: FlightBody): number {
    const d = hdist(b.pos, this.target);
    const slope = this.target.top + APPROACH_HEIGHT + Math.max(0, d - APPROACH_DISTANCE) * SINK_RATIO;
    return Math.min(this.o.cruiseY, slope);
  }

  private cruise(i: BrainInput, ctl: BrainControl): BrainControl {
    const b = i.body;
    ctl.glide = true;
    const d = hdist(b.pos, this.target);
    const want = this.wantY(b);
    const h = Math.hypot(b.vel.x, b.vel.z);
    const excess = b.pos.y + climbMomentum(b.vel.y) - want;
    // far too high near the target: spiral down (a level circle sinks 0.15 blocks/tick without going anywhere)
    const aboveEntry = b.pos.y - (this.target.top + APPROACH_HEIGHT);
    if (this.spiral || (aboveEntry > SPIRAL_ABOVE && d <= APPROACH_DISTANCE + 60)) {
      if (this.spiralDown(i, ctl, this.target)) return ctl;
    }
    ctl.yaw = turnTowards(i.yaw, yawTo(b.pos, this.target));
    // the approach starts at APPROACH_DISTANCE, earlier when high (the planner's dive candidates take about 2.5 blocks per block of height)
    if (d <= APPROACH_DISTANCE + Math.min(40, Math.max(0, aboveEntry - 6) * 2.5)) {
      this.phase = 'approach';
      this.planner.reset();
      return this.approach(i, ctl, this.target);
    }
    if (b.boostTicks > 0) {
      // a rocket burning: climb while the momentum will not reach the wanted height, else level off (the boost keeps the speed)
      ctl.pitch = excess < -CRUISE_BAND ? -30 : excess < 0 ? -5 : 10;
      return ctl;
    }
    if (i.rockets <= 0) this.noRocketTicks++;
    if (excess < -CRUISE_BAND && this.fire(i, ctl)) {
      ctl.pitch = -30;
      return ctl;
    }
    if (h < STALL_SPEED + 0.1) ctl.pitch = 15;
    else if (excess > CRUISE_BAND) ctl.pitch = h > 1.7 ? 5 : Math.min(50, 15 + Math.round(excess * 1.5)); // too high: dive, steeper the higher, never too fast
    else if (h < 0.95) ctl.pitch = 8;
    else if (d <= APPROACH_DISTANCE + BLEED_DISTANCE && h > APPROACH_SPEED) ctl.pitch = -6; // before the approach: bleed the speed towards APPROACH_SPEED (the flare's climb grows with its square)
    else ctl.pitch = 0;
    // out of rockets and sinking under the slope: the approach from wherever we are (it lands short if it must)
    if (i.rockets <= 0 && b.pos.y < this.target.top + 2 && d > APPROACH_DISTANCE) this.landNow('no_rockets', b);
    return ctl;
  }

  /**
   * A level circle over `aim` (SPIRAL_TURN degrees of yaw a tick) while the body is more than
   * SPIRAL_UNTIL above the approach entry: it sinks 0.15 to 0.2 blocks a tick without going anywhere
   * and keeps the speed moderate (the zoom climb of the flare grows with the square of the speed).
   * True while it spirals (the controls are set); false once low enough.
   */
  private spiralDown(i: BrainInput, ctl: BrainControl, aim: LandingTarget): boolean {
    const b = i.body;
    const h = Math.hypot(b.vel.x, b.vel.z);
    this.spiral = b.pos.y - (aim.top + APPROACH_HEIGHT) > SPIRAL_UNTIL;
    if (!this.spiral) return false;
    ctl.glide = true;
    ctl.yaw = i.yaw + SPIRAL_TURN;
    // the emergency spiral sinks a little faster (pitch 15: about 0.25 blocks a tick) than the cruise's (8)
    ctl.pitch = h > 1.4 ? 0 : h < STALL_SPEED + 0.1 ? 20 : this.phase === 'land' ? 15 : 8;
    return true;
  }

  private approach(i: BrainInput, ctl: BrainControl, aim: LandingTarget): BrainControl {
    const b = i.body;
    ctl.glide = true;
    this.stats.approachTicks++;
    // a rocket still burning when the landing was ordered: stop the climb (the momentum of a climb is vy^2 / 0.08 blocks)
    if (this.phase === 'land' && b.boostTicks > 0) {
      ctl.yaw = approachYaw(i.yaw, b.pos, aim);
      ctl.pitch = 15;
      return ctl;
    }
    // the emergency landing from high up: spiral down over the spot first (the planner has no soft way down from there)
    if (this.phase === 'land' && (this.spiral || b.pos.y - (aim.top + APPROACH_HEIGHT) > SPIRAL_ABOVE) && hdist(b.pos, aim) < 40) {
      if (this.spiralDown(i, ctl, aim)) return ctl;
      this.planner.reset();
    }
    ctl.yaw = approachYaw(i.yaw, b.pos, aim);
    if (b.boostTicks > 0) {
      ctl.pitch = -25;
      return ctl;
    }
    const d = hdist(b.pos, aim);
    const choice = this.planner.step(b, ctl.yaw, aim);
    this.lastChoice = { pitch: choice.pitch, cost: choice.cost, kind: choice.touchdown.kind, phase: choice.phase };
    if (this.phase === 'approach' && approachHopeless(choice, this.planner.missing, d)) {
      if (this.stats.goArounds < this.o.goArounds && i.rockets > 0) {
        this.stats.goArounds++;
        this.phase = 'goaround';
        this.outbound = true;
        this.planner.reset();
        return this.goaround(i, ctl);
      }
      // no go-around left: land on the nearest safe ground instead and report
      this.landNow(this.stats.goArounds >= this.o.goArounds ? 'landed_off' : 'no_rockets', b);
      return this.approach(i, ctl, this.aim);
    }
    ctl.pitch = choice.pitch;
    // a stall far from the target would drop us short: never pitch up below stall speed out there
    const h = Math.hypot(b.vel.x, b.vel.z);
    if (h < STALL_SPEED - 0.1 && ctl.pitch < 0 && d > aim.half + 6 && (choice.phase === 'A1' || choice.phase === 'A2')) ctl.pitch = 10;
    return ctl;
  }

  private goaround(i: BrainInput, ctl: BrainControl): BrainControl {
    const b = i.body;
    ctl.glide = true;
    const d = hdist(b.pos, this.target);
    const away = yawTo(this.target, b.pos);
    if (this.outbound) {
      ctl.yaw = turnTowards(i.yaw, away, 12);
      const want = this.target.top + APPROACH_HEIGHT + 6;
      if (b.boostTicks > 0) ctl.pitch = b.pos.y < want ? -30 : -5;
      else if (b.pos.y < want - 2 && this.fire(i, ctl)) ctl.pitch = -30;
      else ctl.pitch = b.pos.y > want + 4 ? 10 : 0;
      if (d >= GOAROUND_OUT && b.pos.y <= want + 6) this.outbound = false;
      return ctl;
    }
    // back in: turn towards the target, then the approach again
    ctl.yaw = turnTowards(i.yaw, yawTo(b.pos, this.target), 12);
    ctl.pitch = b.boostTicks > 0 ? -15 : 0;
    if (Math.abs(ctl.yaw - yawTo(b.pos, this.target)) < 1 && d <= APPROACH_DISTANCE + 4) {
      this.phase = 'approach';
      return this.approach(i, ctl, this.target);
    }
    return ctl;
  }

  /** The emergency landing: safe ground ahead, as far as a shallow glide from here reaches (else straight down the slope). */
  private emergencyTarget(b: FlightBody): LandingTarget {
    const h = Math.hypot(b.vel.x, b.vel.z);
    const yaw = h > 0.05 ? (Math.atan2(-b.vel.x, b.vel.z) * 180) / Math.PI : 0;
    const dir = { x: -Math.sin((yaw * Math.PI) / 180), z: Math.cos((yaw * Math.PI) / 180) };
    const ground = this.o.groundAt;
    let best: LandingTarget | undefined;
    for (const dist of [10, 16, 24, 32, 45, 60]) {
      const x = b.pos.x + dir.x * dist;
      const z = b.pos.z + dir.z * dist;
      const top = ground ? ground(Math.floor(x), Math.floor(z)) : undefined;
      if (top === undefined) continue;
      const drop = b.pos.y - top;
      // not above us; low enough for a straight approach (the glide slope), else the spiral over it takes the height
      if (drop < 0) continue;
      if (dist < Math.min(drop, SPIRAL_ABOVE + APPROACH_HEIGHT) * 1.3) continue;
      best = { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5, top, half: 4 };
      break;
    }
    if (best) return best;
    const top = ground?.(Math.floor(b.pos.x + dir.x * 10), Math.floor(b.pos.z + dir.z * 10)) ?? ground?.(Math.floor(b.pos.x), Math.floor(b.pos.z));
    return { x: b.pos.x + dir.x * 10, z: b.pos.z + dir.z * 10, top: top ?? this.target.top, half: 6 };
  }
}
