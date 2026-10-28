// The flight brain (wave 11, Track AU and AU2; docs/flight.md "The controller"): a pure per-tick state
// machine from the body (position, velocity, gliding, boost) to the controls a vanilla player has
// (yaw, pitch, the jump key, the glide request, a rocket). Phases:
//
//   takeoff   on the ground: jump; falling: request the glide (start_gliding goes out with the next
//             input; from a ledge the fall is the takeoff); along the takeoff heading the sky check chose
//   climb     rockets back to back, pitched up, until the cruise height; the path ahead is checked
//             every tick (Track AU2): a solid within 20 ticks of the predicted glide levels the climb
//             off or turns it, and when nothing clears (a roof) the flight ends on the ground under it
//   cruise    level towards the target along the glide line (Track AU2, the energy model): a rocket
//             only when the projected glide no longer reaches the approach entry with the margin to
//             spare, pitched up to buy height (cheaper than speed); far too high near the target the
//             descent geometry: a circle that fits the columns around the target, else S-turns
//   approach  within APPROACH_DISTANCE: the ApproachPlanner of plan.ts re-optimises a four-segment
//             profile (approach pitches to a flare point, a hard pull-up that trades the speed for
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
import { GLIDE } from '../input/physics.ts';
import {
  APPROACH_DISTANCE,
  APPROACH_HEIGHT,
  ApproachPlanner,
  approachHopeless,
  approachYaw,
  circleYaw,
  DEFAULT_GO_AROUNDS,
  DEFAULT_MARGIN,
  GLIDE_RATIO,
  glideLine,
  glideMargin,
  hdist,
  pathAhead,
  ROCKET_CRUISE_CLIMB,
  rocketPitchFor,
  spiralFit,
  STALL_SPEED,
  turnTowards,
  yawDiff,
  yawTo,
  type FlightBody,
  type LandingTarget,
  type SpiralFit,
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

export type FlightEndReason = 'landed_off' | 'no_rockets' | 'health' | 'elytra_worn' | 'stopped' | 'lost' | 'roof';

export type FlightEnd =
  | { ok: true; landedAt: Vec3; off: number; onTarget: boolean }
  | { ok: false; reason: FlightEndReason; landedAt: Vec3; off: number; onTarget: boolean };

export interface BrainOptions {
  /** The cruise height (feet y) to climb to and hold (the cap of every climb, the cruise's boosts included). */
  cruiseY: number;
  goArounds?: number;
  /** Land at once under this health (fleeHealth) or at / under this many elytra uses (toolWearLimit + 20). */
  fleeHealth?: number;
  elytraWornAt?: number;
  /** Safe ground under (x, z), looking down from `fromY`: the feet height of a body standing there, undefined when unknown or unsafe. */
  groundAt?: (x: number, z: number, fromY?: number) => number | undefined;
  /** The pitch of a climbing rocket (negative = looking up). */
  climbPitch?: number;
  /** A solid cell at integer (x, y, z) in the world model (the approach planner avoids them; unknown = false). */
  obstacle?: (x: number, y: number, z: number) => boolean;
  /** The highest solid block of a column (the world model), for the descent geometry; undefined = unknown. */
  skyTop?: (x: number, z: number) => number | undefined;
  /** Track AU2: the spare height above the glide line the cruise keeps (flyMargin). */
  margin?: number;
  /** Track AU2: the takeoff heading the sky check chose (held until the climb is above the obstacles); default towards the target. */
  takeoffYaw?: number;
  /** The planner's seed (deterministic flights). */
  seed?: number;
}

export interface FlightStats {
  rockets: number;
  /** Track AU2: rockets by the phase that fired them. */
  rocketsBy: { climb: number; cruise: number; goaround: number; land: number };
  goArounds: number;
  ticks: number;
  maxY: number;
  /** Corrections are the loop's business; the brain counts approach ticks and the pitch range it used. */
  approachTicks: number;
  /** Track AU2: the descent geometry flown (for the log and the tests). */
  descents: string[];
  /** Track AU2: ticks the path-ahead check steered the climb or the cruise away from a solid. */
  steered: number;
  /** Track AU2: the height above the approach entry when the cruise handed over to the approach (the energy model's arrival). */
  entryAbove?: number;
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
/**
 * Cruise: more than this above the approach entry height near the target -> the descent geometry (a
 * circle or S-turns) until SPIRAL_UNTIL above it. Track AU had 22 / 10; the offline trips show the
 * planner going around (a rocket, 110 ticks) from 12 above the entry, while a circle from there costs
 * 40 ticks and no rocket: every arrival over 12 now descends to 6 above first.
 */
export const SPIRAL_ABOVE = 12;
export const SPIRAL_UNTIL = 6;
/** Cruise: within this many blocks before the approach distance the speed is bled to APPROACH_SPEED (pitch -6: 1.3 -> 1.0 in 30 ticks). */
const BLEED_DISTANCE = 40;
const APPROACH_SPEED = 1.05;
const GOAROUND_OUT = APPROACH_DISTANCE + 12;
/** Track AU2: the ticks of glide the path-ahead check looks at. */
export const LOOKAHEAD_TICKS = 20;
/** Track AU2: the climb holds the takeoff heading until this far above the start (above a tree). */
const TAKEOFF_HOLD = 12;
/** Track AU2: the lateral swing of the S-turns (blocks each side of the line) and their heading off the bearing (degrees). */
const STURN_WIDTH = 12;
const STURN_ANGLE = 70;
/** Track AU2: where a circle is tried when none fits around the target (blocks before it on the approach line). */
const SPIRAL_OUT = [30, 45, 60, 80] as const;

type Descent =
  | {
      kind: 'spiral';
      fit: SpiralFit;
      dir: 1 | -1;
      exitY: number;
      /** A circle farther out is tangent to the approach line: it is left at this point, heading in along the line. */
      exitAt?: { x: number; z: number };
    }
  | { kind: 'sturn'; side: 1 | -1; anchor: { x: number; z: number }; exitY: number };

export class FlightBrain {
  phase: FlightPhase = 'takeoff';
  /** The landing target (Track AU2: `retarget` may move it before the approach). */
  target: LandingTarget;
  readonly stats: FlightStats = { rockets: 0, rocketsBy: { climb: 0, cruise: 0, goaround: 0, land: 0 }, goArounds: 0, ticks: 0, maxY: -Infinity, approachTicks: 0, descents: [], steered: 0 };
  // (entryAbove is set by the cruise when it hands over to the approach)
  /** Why the flight is ending early (set by `landNow`), kept for the outcome. */
  private endReason: FlightEndReason | undefined;
  private readonly o: Required<Pick<BrainOptions, 'cruiseY' | 'goArounds' | 'fleeHealth' | 'elytraWornAt' | 'climbPitch' | 'margin'>> & Pick<BrainOptions, 'groundAt' | 'obstacle' | 'skyTop' | 'takeoffYaw'>;
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
  /** Track AU2: the descent geometry being flown (far too high near the target). */
  private descent: Descent | undefined;
  /** Track AU2: the cruise's rocket pitch (chosen for the height it should buy; held while it burns) and whether the burning rocket is the cruise's. */
  private cruisePitch = CLIMB_PITCH;
  private cruiseFired = false;
  /** Track AU2: the pitch of the climb's burning rocket (the last one is tuned to what is missing). */
  private burnPitch = CLIMB_PITCH;
  /** Track AU2: the go-around's height: the approach entry + 6, or the clearance over the columns around the target (walls). */
  private goaroundY: number | undefined;
  /** Track AU2: a `roof` landing's ground must lie within this many blocks ahead (before the solid nothing cleared). */
  private emergencyWithin: number | undefined;
  /** Track AU2: the descent geometry was tried and found nothing at this aim (no second search per approach). */
  private descentNone = false;

  constructor(target: LandingTarget, opts: BrainOptions) {
    this.target = target;
    this.o = {
      cruiseY: opts.cruiseY,
      goArounds: opts.goArounds ?? DEFAULT_GO_AROUNDS,
      fleeHealth: opts.fleeHealth ?? 8,
      elytraWornAt: opts.elytraWornAt ?? 30,
      climbPitch: opts.climbPitch ?? CLIMB_PITCH, // adapted to the climb's height at the takeoff (climbPitchFor)
      margin: opts.margin ?? DEFAULT_MARGIN,
      groundAt: opts.groundAt,
      obstacle: opts.obstacle,
      skyTop: opts.skyTop,
      takeoffYaw: opts.takeoffYaw,
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

  /** The descent geometry being flown (`spiral r12 at 30 out`, `S-turns`), for the status line. */
  get descending(): string | undefined {
    if (!this.descent) return undefined;
    return this.descent.kind === 'spiral' ? `spiral r${this.descent.fit.radius}` : 'S-turns';
  }

  /**
   * Track AU2, fly then walk: move the landing target (to the landable cell near a goal whose ground
   * was unknown at the takeoff) while the flight is still on its way (takeoff, climb or cruise; the
   * approach and the landing keep theirs). True when taken.
   */
  retarget(target: LandingTarget, body?: FlightBody): boolean {
    if (this.phase === 'land' || this.phase === 'done') return false;
    // in the approach only while there is room to re-plan (the goal's chunks often load just as it begins)
    if ((this.phase === 'approach' || this.phase === 'goaround') && (!body || hdist(body.pos, this.target) < 15)) return false;
    this.target = target;
    if (this.phase === 'goaround') this.outbound = true;
    this.descent = undefined;
    this.descentNone = false;
    this.goaroundY = undefined;
    this.planner.reset();
    return true;
  }

  /** Land now (`!fly stop`, `!land`, health, the elytra, a roof): the nearest safe ground ahead. */
  landNow(reason: FlightEndReason, body: FlightBody): void {
    if (this.phase === 'done') return;
    this.endReason ??= reason;
    if (this.phase === 'takeoff' && !body.gliding) {
      // not in the air yet: nothing to land
      this.phase = 'done';
      return;
    }
    this.emergency = this.emergencyTarget(body, reason === 'roof' ? this.emergencyWithin : undefined);
    this.emergencyWithin = undefined;
    this.planner.reset();
    this.descent = undefined;
    this.descentNone = false;
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
      this.burnPitch = this.o.climbPitch;
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

  /** The heading the takeoff and the early climb hold: the sky check's heading until TAKEOFF_HOLD above the start, else the target's. */
  private climbYaw(b: FlightBody): number {
    if (this.o.takeoffYaw !== undefined && this.startY !== undefined && b.pos.y < this.startY + TAKEOFF_HOLD) return this.o.takeoffYaw;
    return yawTo(b.pos, this.target);
  }

  private takeoff(i: BrainInput, ctl: BrainControl): BrainControl {
    const b = i.body;
    ctl.yaw = turnTowards(i.yaw, this.climbYaw(b), 30);
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

  /**
   * Fire a rocket this tick, unless the boosted path at `pitch` meets a solid within LOOKAHEAD_TICKS
   * (Track AU2 review: the unboosted check climbs 7 blocks over 20 ticks, the boosted one 20: a roof 8
   * to 19 above was not seen before the rocket went). False when no rocket goes.
   */
  private fire(i: BrainInput, ctl: BrainControl, by: keyof FlightStats['rocketsBy'], pitch?: number): boolean {
    if (i.rockets <= 0 || !i.canFire || i.body.boostTicks > 0) return false;
    // (not for the takeoff's rocket a block off the ground: the slow body's path "hits" the ground under its feet, as in steerClear)
    const justOff = this.startY !== undefined && i.body.pos.y < this.startY + 2 && Math.hypot(i.body.vel.x, i.body.vel.z) < 0.7;
    if (pitch !== undefined && !justOff && this.o.obstacle && i.body.gliding && pathAhead({ ...i.body, boostTicks: GLIDE.boostTicks }, ctl.yaw, pitch, LOOKAHEAD_TICKS, this.o.obstacle) !== undefined) {
      this.stats.steered++;
      return false;
    }
    ctl.fire = true;
    this.stats.rockets++;
    this.stats.rocketsBy[by]++;
    return true;
  }

  /**
   * Track AU2: the path ahead. When the glide of the next LOOKAHEAD_TICKS ticks with the controls in
   * `ctl` meets a solid cell of the world model, the first of these that clears is flown instead:
   * level off, pitch down a little, turn 30 / 60 / 90 degrees either way (the side nearer the
   * target's bearing first). Nothing clears (a roof, a wall all round): the flight ends on the ground
   * under it (`roof`), a stall landing rather than an impact. True when the controls were changed.
   */
  private steerClear(i: BrainInput, ctl: BrainControl, o: { noLanding?: boolean } = {}): boolean {
    const obstacle = this.o.obstacle;
    if (!obstacle || !i.body.gliding) return false;
    const b = i.body;
    // just off the ground (the takeoff's first ticks, slow and a block up): the ground under the feet is no obstacle;
    // a slow body (near the stall) cannot be steered: every path sinks, the speed recovery comes first
    if (Math.hypot(b.vel.x, b.vel.z) < 0.7) return false;
    if (pathAhead(b, ctl.yaw, ctl.pitch, LOOKAHEAD_TICKS, obstacle) === undefined) return false;
    const toTarget = yawDiff(ctl.yaw, yawTo(b.pos, this.target));
    const side: (1 | -1)[] = toTarget >= 0 ? [1, -1] : [-1, 1];
    const candidates: { yaw: number; pitch: number }[] = [
      { yaw: ctl.yaw, pitch: Math.max(0, ctl.pitch) },
      { yaw: ctl.yaw, pitch: Math.max(10, ctl.pitch) },
      ...[30, 60, 90].flatMap((a) => side.map((s) => ({ yaw: ctl.yaw + s * a, pitch: Math.max(0, ctl.pitch) }))),
      { yaw: ctl.yaw, pitch: 25 },
    ];
    for (const c of candidates) {
      if (pathAhead(b, c.yaw, c.pitch, LOOKAHEAD_TICKS, obstacle) !== undefined) continue;
      ctl.yaw = c.yaw;
      ctl.pitch = c.pitch;
      ctl.fire = false;
      this.stats.steered++;
      return true;
    }
    // nothing clears: come down under it (the planner lands it with the roof's cells as walls); not in a
    // go-around or a descent near the target, where low structures are the planner's business (a house wall
    // 4 blocks behind a landing cell ended a flight early on bds-fly)
    if (o.noLanding) return false;
    ctl.fire = false;
    ctl.pitch = 15;
    this.stats.steered++;
    if (this.phase !== 'land') {
      // the ground for the stall landing must lie before the solid nothing cleared: the straight glide's first hit
      const hit = pathAhead(b, ctl.yaw, 0, 60, obstacle);
      const h = Math.hypot(b.vel.x, b.vel.z);
      this.emergencyWithin = hit !== undefined ? Math.max(6, hit * h - 2) : undefined;
      this.landNow('roof', b);
    }
    return true;
  }

  private climb(i: BrainInput, ctl: BrainControl): BrainControl {
    const b = i.body;
    ctl.glide = true;
    ctl.yaw = turnTowards(i.yaw, this.climbYaw(b));
    const d = hdist(b.pos, this.target);
    // the climb goes on after the last rocket: a body rising at vy keeps about vy^2 / 0.08 blocks of climb
    const willReach = b.pos.y + climbMomentum(b.vel.y);
    if (willReach >= this.o.cruiseY || d <= APPROACH_DISTANCE + 6) {
      this.phase = d <= APPROACH_DISTANCE + 6 ? 'approach' : 'cruise';
      return this.phase === 'approach' ? this.approach(i, ctl, this.target) : this.cruise(i, ctl);
    }
    const h = Math.hypot(b.vel.x, b.vel.z);
    if (b.boostTicks > 0) {
      // the momentum will carry the last blocks: the cruise takes over now (it levels the burning rocket off; a
      // -38 climb held to the end overshot the cruise by 9, and a level-off inside the climb fired one rocket more)
      if (willReach >= this.o.cruiseY - 3) {
        this.phase = 'cruise';
        return this.cruise(i, ctl);
      }
      ctl.pitch = this.burnPitch;
      this.steerClear(i, ctl);
      return ctl;
    }
    if (i.rockets <= 0) {
      // nothing to climb with: cruise with what we have (and land short if it comes to that)
      this.phase = 'cruise';
      return this.cruise(i, ctl);
    }
    // between rockets: keep the speed, pitch up only while it lasts; the next rocket only when the momentum will not carry us there
    ctl.pitch = h < STALL_SPEED + 0.15 ? 10 : h < 0.9 ? -10 : this.o.climbPitch;
    if (this.steerClear(i, ctl)) return ctl;
    // every climb rocket is a full one at the climb pitch: a rocket costs the same whatever it buys (a last one
    // tuned to the deficit cost one more rocket per climb in the offline trips), the overshoot is levelled off;
    // the boosted path at that pitch must be clear (fire checks it)
    if (willReach < this.o.cruiseY - 6 && this.fire(i, ctl, 'climb', this.burnPitch)) ctl.pitch = this.burnPitch;
    return ctl;
  }

  /**
   * The cruise (Track AU2, the energy model of docs/flight.md "Rocket economy"): glide level along the
   * line that reaches the approach entry at GLIDE_RATIO; a rocket only when the projected height (the
   * climb's momentum included) falls under that line plus the margin, pitched up for the height it
   * should buy (the whole rocket's worth when the glide ahead is long, just enough to arrive a little
   * over the margin when it is the last). Far too high near the target: the descent geometry.
   */
  private cruise(i: BrainInput, ctl: BrainControl): BrainControl {
    const b = i.body;
    ctl.glide = true;
    const d = hdist(b.pos, this.target);
    const h = Math.hypot(b.vel.x, b.vel.z);
    const aboveEntry = b.pos.y - (this.target.top + APPROACH_HEIGHT);
    // far too high near the target: the descent geometry (a circle that fits the columns, else S-turns)
    if (this.descent || (aboveEntry > SPIRAL_ABOVE && d <= APPROACH_DISTANCE + 60 && !this.descentNone)) {
      if (this.descend(i, ctl, this.target)) return ctl;
    }
    ctl.yaw = turnTowards(i.yaw, yawTo(b.pos, this.target));
    // the approach starts at APPROACH_DISTANCE, earlier when high (the planner's dive candidates take about 2.5 blocks per block of height)
    if (d <= APPROACH_DISTANCE + Math.min(40, Math.max(0, aboveEntry - 6) * 2.5)) {
      this.phase = 'approach';
      this.planner.reset();
      this.stats.entryAbove ??= aboveEntry;
      return this.approach(i, ctl, this.target);
    }
    const spare = glideMargin(this.o.margin, d);
    const above = b.pos.y + climbMomentum(b.vel.y) - glideLine(this.target, d);
    if (b.boostTicks > 0) {
      // a rocket burning: a top-up of the cruise climbs at the pitch chosen for it, the climb's last rocket at
      // the climb pitch (the boost steers the velocity onto the look: levelled off, a burning rocket halves vy
      // every tick and the climb's momentum is lost; the whole burn goes into height, the cap of flyMaxClimb
      // bounds the climb's rockets, not the last one's run-out)
      ctl.pitch = this.cruiseFired ? this.cruisePitch : this.o.climbPitch;
      this.steerClear(i, ctl);
      return ctl;
    }
    this.cruiseFired = false;
    if (i.rockets <= 0) this.noRocketTicks++;
    // under the margin by more than 3 (the climb hands over within 3 of its height: that is on the margin, not
    // under it), judged at glide speed only: a slow body (after the climb, after a circle) sinks while it
    // regains its speed and that sink is not a shortfall of height (two needless top-ups at 600 blocks on bds-fly)
    if (above < spare - 3 && h >= 1.1 && i.rockets > 0) {
      // the height this rocket should buy: a whole rocket's worth while the glide ahead can use it, else just enough
      const glideAhead = d - APPROACH_DISTANCE;
      const gain = glideAhead > ROCKET_CRUISE_CLIMB * GLIDE_RATIO ? ROCKET_CRUISE_CLIMB : Math.min(ROCKET_CRUISE_CLIMB, Math.max(6, spare + 8 - above));
      this.cruisePitch = rocketPitchFor(gain);
      // the boosted climb at that pitch must be clear for the next 20 ticks (fire checks it; else glide on)
      if (this.fire(i, ctl, 'cruise', this.cruisePitch)) {
        ctl.pitch = this.cruisePitch;
        this.cruiseFired = true;
        return ctl;
      }
    }
    if (h < STALL_SPEED + 0.1) ctl.pitch = 15;
    else if (h < 0.95) ctl.pitch = 8; // slow: a shallow dive recovers the speed without a rocket
    else if (d <= APPROACH_DISTANCE + BLEED_DISTANCE && h > APPROACH_SPEED) ctl.pitch = -6; // before the approach: bleed the speed towards APPROACH_SPEED (the flare's climb grows with its square)
    else if (h > 1.7) ctl.pitch = -3;
    else ctl.pitch = 0;
    this.steerClear(i, ctl);
    // out of rockets and sinking under the slope: the approach from wherever we are (it lands short if it must)
    if (i.rockets <= 0 && b.pos.y < this.target.top + 2 && d > APPROACH_DISTANCE) this.landNow('no_rockets', b);
    return ctl;
  }

  /**
   * Track AU2, the descent geometry (docs/flight.md "Descent geometry"): far too high near `aim`, come
   * down to SPIRAL_UNTIL above the glide line without going anywhere. A circle of the largest radius
   * (6 to 24) whose columns are all lower than the exit height less 3 is flown around the aim; when
   * none fits there, around a point on the approach line 30 to 80 blocks before it; when none fits
   * anywhere, S-turns (70 degrees off the bearing, 12 blocks each side) on the way in. A level circle
   * sinks 0.15 to 0.2 blocks a tick. True while the controls are set; false once low enough.
   */
  private descend(i: BrainInput, ctl: BrainControl, aim: LandingTarget): boolean {
    const b = i.body;
    const h = Math.hypot(b.vel.x, b.vel.z);
    if (!this.descent) {
      const chosen = this.chooseDescent(b, aim);
      if (!chosen) {
        this.descentNone = true;
        return false;
      }
      this.descent = chosen;
      this.stats.descents.push(chosen.kind === 'spiral' ? `spiral r${chosen.fit.radius} at ${Math.round(hdist(chosen.fit.centre, aim))} out from ${Math.round(b.pos.y - aim.top)} above` : `S-turns from ${Math.round(b.pos.y - aim.top)} above`);
    }
    const dsc = this.descent;
    if (b.pos.y <= dsc.exitY) {
      // a circle around the aim is left heading at it (within 45 degrees) and at least 28 blocks out; a circle
      // farther out is tangent to the approach line and left at the tangent point heading in along the line
      // (the open side of a walled platform); either way at the latest 10 under the exit height
      const heading = h > 0.05 ? (Math.atan2(-b.vel.x, b.vel.z) * 180) / Math.PI : i.yaw;
      const headingIn = Math.abs(yawDiff(heading, yawTo(b.pos, aim)));
      // ... and with the speed bled in the circle (under 1.15): a short circle left fast (1.3 to 1.5) handed the
      // planner a body with too much energy and cost go-arounds on bds-fly (the 300-block flights)
      const leave =
        dsc.kind !== 'spiral' ||
        (h <= 1.15 && (dsc.exitAt ? hdist(b.pos, dsc.exitAt) <= 4 && headingIn <= 35 : headingIn <= 45 && hdist(b.pos, aim) >= APPROACH_DISTANCE / 2)) ||
        b.pos.y <= dsc.exitY - 10;
      if (leave) {
        this.descent = undefined;
        this.planner.reset();
        return false;
      }
    }
    ctl.glide = true;
    if (dsc.kind === 'spiral') {
      ctl.yaw = circleYaw(i.yaw, b.pos, dsc.fit.centre, dsc.fit.radius, dsc.dir);
    } else {
      // S-turns: the lateral offset from the line anchor -> aim decides the side; the heading is the bearing swung off by STURN_ANGLE
      const bearing = yawTo(dsc.anchor, aim);
      const r = (bearing * Math.PI) / 180;
      const dir = { x: -Math.sin(r), z: Math.cos(r) };
      const rel = { x: b.pos.x - dsc.anchor.x, z: b.pos.z - dsc.anchor.z };
      const lateral = rel.x * dir.z - rel.z * dir.x; // positive = to the right of the line (Bedrock yaw grows to the left)
      if (Math.abs(lateral) > STURN_WIDTH && Math.sign(lateral) === -dsc.side) dsc.side = -dsc.side as 1 | -1;
      ctl.yaw = turnTowards(i.yaw, yawTo(b.pos, aim) + dsc.side * STURN_ANGLE, 15);
      // close before the approach: straighten out, the planner takes it from here
      if (hdist(b.pos, aim) <= APPROACH_DISTANCE + 10) {
        this.descent = undefined;
        this.planner.reset();
        return false;
      }
    }
    // the emergency descent sinks a little faster (pitch 15: about 0.25 blocks a tick) than the cruise's (8)
    ctl.pitch = h > 1.4 ? 0 : h < STALL_SPEED + 0.1 ? 20 : this.phase === 'land' ? 15 : 8;
    this.steerClear(i, ctl, { noLanding: true });
    return true;
  }

  /**
   * The descent geometry for `aim` from the body's position: a circle around the aim; else a circle
   * farther out, tangent to the approach line at 30 / 45 / 60 / 80 blocks before the aim (its centre a
   * radius beside the line, the largest radius 6 to 24 whose columns are free), left at the tangent
   * point heading in; else S-turns.
   */
  private chooseDescent(b: FlightBody, aim: LandingTarget): Descent | undefined {
    const sky = this.o.skyTop;
    const exitAt = (distance: number): number => glideLine(aim, distance) + SPIRAL_UNTIL;
    if (sky) {
      // one column lookup per column for this choice (the fits overlap)
      const memo = new Map<number, number | undefined>();
      const skyTop = (x: number, z: number): number | undefined => {
        const k = x * 65536 + z;
        if (!memo.has(k)) memo.set(k, sky(x, z));
        return memo.get(k);
      };
      const d = hdist(b.pos, aim);
      const ux = d > 1e-6 ? (b.pos.x - aim.x) / d : 0;
      const uz = d > 1e-6 ? (b.pos.z - aim.z) / d : 1;
      const heading = Math.hypot(b.vel.x, b.vel.z) > 0.05 ? (Math.atan2(-b.vel.x, b.vel.z) * 180) / Math.PI : 0;
      // along a circle the body moves by s * (-sin ang, cos ang) of its angle from the centre; Bedrock's yaw of (dx, dz) is atan2(-dx, dz)
      const tangent = (centre: { x: number; z: number }, at: { x: number; z: number }, s: 1 | -1): number => {
        const ang = Math.atan2(at.z - centre.z, at.x - centre.x);
        return (Math.atan2(s * Math.sin(ang), s * Math.cos(ang)) * 180) / Math.PI;
      };
      // around the aim: the largest circle that fits, turned the way the heading already points
      const exit0 = exitAt(APPROACH_DISTANCE);
      if (b.pos.y > exit0) {
        const fit = spiralFit(aim, Math.min(b.pos.y, exit0) - 3, skyTop);
        if (fit) {
          const dir: 1 | -1 = Math.abs(yawDiff(heading, tangent(fit.centre, b.pos, 1))) <= Math.abs(yawDiff(heading, tangent(fit.centre, b.pos, -1))) ? 1 : -1;
          return { kind: 'spiral', fit, dir, exitY: exit0 };
        }
      }
      // farther out: a circle tangent to the approach line at `out`, its centre a radius to one side
      for (const out of SPIRAL_OUT) {
        if (out > d + 10) continue; // never a circle behind the body
        const exitY = exitAt(Math.max(out, APPROACH_DISTANCE));
        if (b.pos.y <= exitY) continue;
        const p = { x: aim.x + ux * out, z: aim.z + uz * out };
        for (const side of [1, -1] as const) {
          for (const r of [24, 18, 12, 8, 6]) {
            const centre = { x: p.x + side * r * -uz, z: p.z + side * r * ux };
            const fit = spiralFit(centre, Math.min(b.pos.y, exitY) - 3, skyTop);
            if (!fit || fit.radius < r) continue;
            const circle: SpiralFit = { centre: fit.centre, radius: r };
            // leave the circle at the tangent point heading at the aim: the direction whose tangent there points in
            const dir: 1 | -1 = Math.abs(yawDiff(yawTo(p, aim), tangent(circle.centre, p, 1))) <= Math.abs(yawDiff(yawTo(p, aim), tangent(circle.centre, p, -1))) ? 1 : -1;
            return { kind: 'spiral', fit: circle, dir, exitY, exitAt: p };
          }
        }
      }
    }
    if (this.phase === 'land') return undefined; // the emergency landing from high up: the planner's dive, not S-turns over unknown ground
    const exitY = exitAt(APPROACH_DISTANCE);
    if (b.pos.y <= exitY) return undefined;
    return { kind: 'sturn', side: 1, anchor: { x: b.pos.x, z: b.pos.z }, exitY };
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
    // the emergency landing from high up: the descent geometry over the spot first (the planner has no soft way down from there)
    if (this.phase === 'land' && (this.descent || (b.pos.y - (aim.top + APPROACH_HEIGHT) > SPIRAL_ABOVE && !this.descentNone)) && hdist(b.pos, aim) < 40) {
      if (this.descend(i, ctl, aim)) return ctl;
    }
    ctl.yaw = approachYaw(i.yaw, b.pos, aim);
    if (b.boostTicks > 0) {
      ctl.pitch = -25;
      return ctl;
    }
    const d = hdist(b.pos, aim);
    const choice = this.planner.step(b, ctl.yaw, aim);
    // the emergency landing keeps steering clear of solids on the way down (the planner's cells see the ground around the aim, the path-ahead check the rest)
    if (this.phase === 'land' && d > aim.half + 4) {
      const probe: BrainControl = { ...ctl, pitch: choice.pitch };
      if (this.steerClear(i, probe, { noLanding: true })) {
        ctl.yaw = probe.yaw;
        ctl.pitch = probe.pitch;
        return ctl;
      }
    }
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
      const want = (this.goaroundY ??= this.goaroundHeight());
      if (b.boostTicks > 0) ctl.pitch = b.pos.y < want ? -30 : -5;
      else if (b.pos.y < want - 2 && this.fire(i, ctl, 'goaround', -30)) ctl.pitch = -30;
      else ctl.pitch = b.pos.y > want + 4 ? 10 : 0;
      if (d >= GOAROUND_OUT && b.pos.y <= want + 6) this.outbound = false;
      this.steerClear(i, ctl, { noLanding: true });
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

  /**
   * Track AU2: the go-around's height: the approach entry + 6, or 7 above the highest column within 30
   * blocks of the target when the world model knows higher ones (walls around a platform: the turn
   * away and back is flown over them, not into them).
   */
  private goaroundHeight(): number {
    let y = this.target.top + APPROACH_HEIGHT + 6;
    const skyTop = this.o.skyTop;
    if (!skyTop) return y;
    const cx = Math.floor(this.target.x);
    const cz = Math.floor(this.target.z);
    for (let dx = -30; dx <= 30; dx++) {
      for (let dz = -30; dz <= 30; dz++) {
        if (dx * dx + dz * dz > 900) continue;
        const t = skyTop(cx + dx, cz + dz); // every column (a 1-wide pillar counts); unknown columns are ignored
        if (t !== undefined && t + 1 + 6 > y) y = t + 1 + 6;
      }
    }
    return y;
  }

  /**
   * The emergency landing: safe ground ahead, as far as a shallow glide from here reaches (else straight
   * down the slope); `within` (a `roof` landing) caps the distance before the solid nothing cleared.
   * No known ground ahead: the headings 45 and 90 degrees either side are tried before the fallback
   * 10 blocks ahead at the target's height (a void below).
   */
  private emergencyTarget(b: FlightBody, within?: number): LandingTarget {
    const h = Math.hypot(b.vel.x, b.vel.z);
    const yaw = h > 0.05 ? (Math.atan2(-b.vel.x, b.vel.z) * 180) / Math.PI : 0;
    const ground = this.o.groundAt;
    const fromY = b.pos.y + 1; // Track AU2: looking down from the body (under a roof the roof is not the ground)
    const along = (heading: number, dists: readonly number[]): LandingTarget | undefined => {
      const dir = { x: -Math.sin((heading * Math.PI) / 180), z: Math.cos((heading * Math.PI) / 180) };
      for (const dist of dists) {
        if (within !== undefined && dist > within) break;
        const x = b.pos.x + dir.x * dist;
        const z = b.pos.z + dir.z * dist;
        const top = ground ? ground(Math.floor(x), Math.floor(z), fromY) : undefined;
        if (top === undefined) continue;
        const drop = b.pos.y - top;
        // not above us; low enough for a straight approach (the glide slope), else the spiral over it takes the height
        if (drop < 0) continue;
        if (within === undefined && dist < Math.min(drop, SPIRAL_ABOVE + APPROACH_HEIGHT) * 1.3) continue;
        return { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5, top, half: 4 };
      }
      return undefined;
    };
    const dists = within !== undefined ? [6, 8, 10, 13, 16, 20, 24] : [10, 16, 24, 32, 45, 60];
    for (const off of [0, 45, -45, 90, -90]) {
      const best = along(yaw + off, dists);
      if (best) return best;
    }
    const dir = { x: -Math.sin((yaw * Math.PI) / 180), z: Math.cos((yaw * Math.PI) / 180) };
    const near = Math.min(10, within ?? 10);
    const top = ground?.(Math.floor(b.pos.x + dir.x * near), Math.floor(b.pos.z + dir.z * near), fromY) ?? ground?.(Math.floor(b.pos.x), Math.floor(b.pos.z), fromY);
    return { x: b.pos.x + dir.x * near, z: b.pos.z + dir.z * near, top: top ?? this.target.top, half: 6 };
  }
}
