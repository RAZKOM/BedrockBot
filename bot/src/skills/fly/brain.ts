// The flight brain (wave 11, Track AU and AU2; docs/flight.md "The controller"): a pure per-tick state
// machine from the body (position, velocity, gliding, boost) to the controls a vanilla player has
// (yaw, pitch, the jump key, the glide request, a rocket). Phases:
//
//   takeoff   on the ground: jump; falling: request the glide (start_gliding goes out with the next
//             input; from a ledge the fall is the takeoff); along the takeoff heading the sky check chose.
//             Track BH, the ledge takeoff (`ledge`): sneak-walk to the edge along its heading, release the
//             sneak there and step off; the glide is requested as the fall begins and dived (LEDGE_DIVE)
//             until it flies (LEDGE_SPEED), no rocket needed
//   climb    rockets back to back, pitched up, until the cruise height; the path ahead is checked
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
  SPIRAL_RADII,
  STALL_SPEED,
  yawDir,
  turnTowards,
  yawDiff,
  yawTo,
  type FlightBody,
  type LandingTarget,
  type Obstacle,
  type SpiralFit,
} from './plan.ts';
import { assumedTop, BUILD_TOP, CLIMB_SLOPE, strictObstacle, terrainFloor, type TerrainFloor, type TerrainQuery } from './terrain.ts'; // Track BL
import { DIVE_END_MAX, DIVE_MIN_ABOVE, DIVE_MIN_ABOVE_FORCED, divePhase, divePitch, planDive, simulateDive, type DivePhase, type DiveProfile } from './dive.ts'; // Track BL

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
  /** Track BH, the ledge takeoff: walk forward (the walk to the edge and the step off), sneaking up to the edge. */
  forward?: number;
  sneak?: boolean;
}

/** (Track BF: `no_landing`: the hold over a goal that never got a landing timed out; the nearest dry ground.) */
export type FlightEndReason = 'landed_off' | 'no_rockets' | 'health' | 'elytra_worn' | 'stopped' | 'lost' | 'roof' | 'no_landing';

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
  /**
   * Track BH: a ledge takeoff instead of the jump (docs/flight.md "Ledge takeoff"): the body stands on the
   * edge cell; `yaw` is the heading off the edge (the fall corridor checked along it). The takeoff and the
   * climb hold it until TAKEOFF_HOLD above the start, like the sky check's heading.
   */
  ledge?: { yaw: number };
  /**
   * Track BL (docs/flight.md "Terrain-safe cruise"): the column query (live, else cache, else unknown) the
   * climb and the cruise keep their terrain floor over (the sink line never goes under it), the dive descent
   * checks its corridor against (unknown is not air there), and the crash notes read.
   */
  terrain?: TerrainQuery;
  /** Track BL: the clearance over the terrain floor (flyClearance). */
  clearance?: number;
  /** Track BL: the high cruise (flyHighCruise): hold over the build limit until the descent can begin. */
  highCruise?: boolean;
  /** Track BL: the descent from high up (flyDescent): `auto` dives when the simulation passes, `dive` from lower, `spiral` never. */
  descent?: 'auto' | 'dive' | 'spiral';
  /** Track BF: one line per notable decision (every go-around with its reason, the hold, the corridor), for the log. */
  note?: (msg: string) => void;
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
  /** Track BF: ticks spent holding high near a target that is not landable yet (`LandingTarget.hold`). */
  holdTicks: number;
  /** Track BF: why each go-around was flown (one line each). */
  goAroundReasons: string[];
  /** Track BH, a ledge takeoff: ticks of the walk to the edge, and the height the fall took until the glide flew (LEDGE_SPEED). */
  ledgeWalkTicks?: number;
  ledgeDrop?: number;
  /** Track BL: one line per terrain avoidance (reason, distance, height gained), and the dives flown. */
  avoidances: string[];
  dives: number;
}

const CLIMB_PITCH = -38;
/** Track BH, the ledge takeoff: the dive's pitch after the step off and the speed at which the glide flies (then the usual phases). */
export const LEDGE_DIVE = 20;
export const LEDGE_SPEED = 0.7;
/** Track BH: the sneak is released at the edge once the body stood still this many ticks (the edge rule holds it), or after LEDGE_WALK_MAX ticks of walking. */
const LEDGE_STILL = 2;
const LEDGE_WALK_MAX = 60;

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
/** Track BF: an overhang's corridor is entered from this far out along its bearing. */
export const CORRIDOR_OUT = 64;
/** Track BF: columns whose top is this far above an overhang cell's floor are the roof the corridor goes under (ignored by its go-around height). */
const OPEN_ABOVE = 4;
/** Track BL: the terrain floor is recomputed every this many ticks; a detour heading is held this long; the dive is looked for every DIVE_EVERY ticks. */
const FLOOR_EVERY = 4;
const DETOUR_TICKS = 40;
const DIVE_EVERY = 5;
/** Track BL: the dive is checked this many ticks ahead every tick and re-simulated every DIVE_RECHECK ticks. */
const DIVE_AHEAD = 12;
const DIVE_RECHECK = 10;

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
  readonly stats: FlightStats = { rockets: 0, rocketsBy: { climb: 0, cruise: 0, goaround: 0, land: 0 }, goArounds: 0, ticks: 0, maxY: -Infinity, approachTicks: 0, descents: [], steered: 0, holdTicks: 0, goAroundReasons: [], avoidances: [], dives: 0 };
  // (entryAbove is set by the cruise when it hands over to the approach)
  /** Why the flight is ending early (set by `landNow`), kept for the outcome. */
  private endReason: FlightEndReason | undefined;
  private readonly o: Required<Pick<BrainOptions, 'cruiseY' | 'goArounds' | 'fleeHealth' | 'elytraWornAt' | 'climbPitch' | 'margin'>> & Pick<BrainOptions, 'groundAt' | 'obstacle' | 'skyTop' | 'takeoffYaw' | 'note' | 'ledge' | 'terrain' | 'highCruise'> & { clearance: number; descentMode: 'auto' | 'dive' | 'spiral' };
  private jumped = false;
  private requested = false;
  private wasGliding = false;
  /** The emergency landing target (phase `land`). */
  private emergency: LandingTarget | undefined;
  /** Go-around: flying away until out, then back. */
  private outbound = false;
  /** Track AU2 review: the bearing (from the target) the go-around flies out on and comes back along: null = straight away from the target, undefined = not chosen yet. */
  private goaroundBearing: number | null | undefined;
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
  /** Track BF: the holding circle over a target that is not landable yet (`LandingTarget.hold`). */
  private holding: { fit: SpiralFit; dir: 1 | -1; y: number } | undefined;
  /** Track BH, the ledge takeoff: ticks walked towards the edge, ticks standing still there, the sneak released, the step taken. */
  private ledgeWalk = 0;
  private ledgeStill = 0;
  private ledgeReleased = false;
  private ledgeOff = false;
  /** Track BH: descent circles flown again instead of a go-around (no rocket, too high). */
  private glideRedescents = 0;
  /** Track BL: the terrain floor (recomputed every FLOOR_EVERY ticks), the avoidance being flown, a detour heading. */
  private floor: TerrainFloor | undefined;
  private floorAt = -1000;
  private avoid: { reason: string; y0: number; maxY: number; rockets0: number; clearTicks: number } | undefined;
  private detour: { yaw: number; until: number } | undefined;
  /** Track BL: the dive descent being flown, and the tick of the last dive search (one every DIVE_EVERY ticks). */
  private dive: { p: DiveProfile; phase: DivePhase; from: number; since: number; aborted: boolean } | undefined;
  private diveLook = -1000;
  /** Track BL: a dive was aborted this approach: no other one (the circle). */
  private diveBanned = false;
  private diveWhy: string | undefined;

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
      takeoffYaw: opts.takeoffYaw ?? opts.ledge?.yaw,
      note: opts.note,
      ledge: opts.ledge,
      terrain: opts.terrain,
      highCruise: opts.highCruise,
      clearance: opts.clearance ?? 12,
      descentMode: opts.descent ?? 'auto',
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
    if (this.holding && this.target.hold) return 'holding';
    if (this.dive) return 'dive';
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
    const wasHold = this.target.hold === true;
    this.target = target;
    // Track BF: a target that is not landable yet is held over from the cruise (no approach to it)
    if (target.hold && (this.phase === 'approach' || this.phase === 'goaround')) this.phase = 'cruise';
    if (wasHold && !target.hold && this.holding) this.o.note?.(`holding over: the landing is confirmed after ${this.stats.holdTicks} ticks of holding`);
    this.holding = undefined;
    this.dive = undefined;
    if (this.phase === 'goaround') this.outbound = true;
    this.goaroundBearing = undefined;
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
    this.dive = undefined;
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
    if (this.o.ledge) return this.ledgeTakeoff(i, ctl, this.o.ledge.yaw);
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
   * Track BH, the ledge takeoff (docs/flight.md "Ledge takeoff"): turn to the edge's heading, walk to the
   * edge sneaking (the edge rule holds the body there whatever happens), release the sneak once it stands
   * still at the edge and walk off; the glide is requested on the first falling tick ("from a ledge the
   * fall is the takeoff") and dived at LEDGE_DIVE along the heading until it flies at LEDGE_SPEED, then
   * the climb (which hands over to the cruise at once when the cruise height is not above the start).
   */
  private ledgeTakeoff(i: BrainInput, ctl: BrainControl, yaw: number): BrainControl {
    const b = i.body;
    const h = Math.hypot(b.vel.x, b.vel.z);
    ctl.yaw = turnTowards(i.yaw, yaw, 30);
    if (b.gliding) {
      if (h >= LEDGE_SPEED) {
        this.stats.ledgeDrop = (this.startY ?? b.pos.y) - b.pos.y;
        this.o.note?.(`ledge takeoff: gliding at ${h.toFixed(2)} blocks a tick, ${this.stats.ledgeDrop.toFixed(1)} under the edge, after ${this.ledgeWalk} ticks of walk`);
        this.phase = 'climb';
        return this.climb(i, ctl);
      }
      ctl.glide = true;
      ctl.pitch = LEDGE_DIVE;
      return ctl;
    }
    if (b.onGround && !this.ledgeOff) {
      ctl.pitch = 0;
      ctl.sneak = !this.ledgeReleased;
      if (Math.abs(yawDiff(ctl.yaw, yaw)) > 1) return ctl; // turned first: a walk while turning drifts off the edge's line
      this.ledgeWalk++;
      this.stats.ledgeWalkTicks = this.ledgeWalk;
      ctl.forward = 1;
      if (!this.ledgeReleased) {
        this.ledgeStill = h < 0.003 && this.ledgeWalk > 3 ? this.ledgeStill + 1 : 0;
        if (this.ledgeStill >= LEDGE_STILL || this.ledgeWalk > LEDGE_WALK_MAX) this.ledgeReleased = true;
      }
      return ctl;
    }
    // off the edge: the glide as soon as the fall begins (BDS wants the request while falling)
    this.ledgeOff = true;
    ctl.forward = 1;
    ctl.pitch = LEDGE_DIVE;
    if (!b.onGround && b.vel.y < 0) {
      this.requested = true;
      ctl.glide = true;
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
    // Track BL: never hand over under the terrain floor ahead (a mountain the cruise height did not know)
    const climbTo = Math.max(this.o.cruiseY, this.terrainNeed(b) ?? -Infinity);
    if (willReach >= climbTo || d <= APPROACH_DISTANCE + 6) {
      // (Track BF: a held target or an overhang's corridor is flown from the cruise, never straight into an approach)
      // (Track BH: nor from far too high: a glide down off a ledge 40 up starts within the approach distance; the cruise's descent geometry first)
      const high = b.pos.y - (this.target.top + APPROACH_HEIGHT) > SPIRAL_ABOVE;
      this.phase = d <= APPROACH_DISTANCE + 6 && !this.target.hold && this.linedUp(b) && !high ? 'approach' : 'cruise';
      return this.phase === 'approach' ? this.approach(i, ctl, this.target) : this.cruise(i, ctl);
    }
    const h = Math.hypot(b.vel.x, b.vel.z);
    if (b.boostTicks > 0) {
      // the momentum will carry the last blocks: the cruise takes over now (it levels the burning rocket off; a
      // -38 climb held to the end overshot the cruise by 9, and a level-off inside the climb fired one rocket more)
      if (willReach >= climbTo - 3) {
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
    // Track BL: within 6 of the climb's top and no rocket burning: no rocket would be fired for it (below), so the cruise takes over
    // (e2e: from a platform 200 up the climb hung at y 151 under a cruise of 152 all the way to the target, no dive looked for)
    if (willReach >= climbTo - 6) {
      this.phase = 'cruise';
      return this.cruise(i, ctl);
    }
    // between rockets: keep the speed, pitch up only while it lasts; the next rocket only when the momentum will not carry us there
    ctl.pitch = h < STALL_SPEED + 0.15 ? 10 : h < 0.9 ? -10 : this.o.climbPitch;
    if (this.steerClear(i, ctl)) return ctl;
    // every climb rocket is a full one at the climb pitch: a rocket costs the same whatever it buys (a last one
    // tuned to the deficit cost one more rocket per climb in the offline trips), the overshoot is levelled off;
    // the boosted path at that pitch must be clear (fire checks it)
    if (willReach < climbTo - 6 && this.fire(i, ctl, 'climb', this.burnPitch)) ctl.pitch = this.burnPitch;
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
    const dTarget = hdist(b.pos, this.target);
    // Track BF: not landable yet: hold high over it until the trip retargets (the goal's chunks, the probes)
    if (this.target.hold && dTarget <= APPROACH_DISTANCE + 60) return this.hold(i, ctl);
    // Track BL: the dive descent being flown (hands over to the approach, or aborts back into the cruise)
    if (this.dive) {
      if (this.flyDive(i, ctl)) return ctl;
      if (this.phase === 'approach') return this.approach(i, ctl, this.target);
    }
    // Track BF: an overhang's corridor: first out to its entry, then in along it (the glide line counts the way round)
    const entry = this.linedUp(b) ? undefined : this.corridorEntry();
    const d = entry ? hdist(b.pos, entry) + CORRIDOR_OUT : dTarget;
    const h = Math.hypot(b.vel.x, b.vel.z);
    const aboveEntry = b.pos.y - (this.target.top + APPROACH_HEIGHT);
    const spiralDue = aboveEntry > SPIRAL_ABOVE && d <= APPROACH_DISTANCE + 60 && !this.descentNone;
    // Track BL: far above the entry: the dive descent when its simulation passes (looked for every DIVE_EVERY ticks
    // on the way in, and once more when the circle would begin); a window still ahead keeps the cruise going
    if (!this.descent && !entry && this.diveAllowed(aboveEntry, d) && (spiralDue || this.stats.ticks - this.diveLook >= DIVE_EVERY)) {
      this.diveLook = this.stats.ticks;
      const r = this.tryDive(i, b, spiralDue);
      if (r === 'dive') {
        if (this.flyDive(i, ctl)) return ctl;
        if (this.phase === 'approach') return this.approach(i, ctl, this.target);
      }
      if (r === 'wait' && spiralDue && d > APPROACH_DISTANCE + 20) {
        // (the window is still ahead: no circle yet)
      } else if (spiralDue) {
        if (this.descend(i, ctl, this.target)) return ctl;
      }
    } else if (this.descent || spiralDue) {
      // far too high near the target: the descent geometry (a circle that fits the columns, else S-turns)
      if (this.descend(i, ctl, this.target)) return ctl;
    }
    // Track BL: a detour heading around terrain no climb clears in time
    const detouring = this.detour !== undefined && this.stats.ticks < this.detour.until;
    if (!detouring) this.detour = undefined;
    ctl.yaw = turnTowards(i.yaw, detouring ? this.detour!.yaw : yawTo(b.pos, entry ?? this.target));
    // the approach starts at APPROACH_DISTANCE, earlier when high (the planner's dive candidates take about 2.5 blocks per block of height)
    if (!entry && d <= APPROACH_DISTANCE + Math.min(this.target.bearing !== undefined ? 8 : 40, Math.max(0, aboveEntry - 6) * 2.5)) {
      if (this.target.bearing !== undefined) this.o.note?.(`approach along the corridor (in from ${Math.round(this.target.bearing)}) from ${Math.round(d)} blocks out, ${Math.round(aboveEntry + APPROACH_HEIGHT)} above the floor`);
      this.phase = 'approach';
      this.planner.reset();
      this.stats.entryAbove ??= aboveEntry;
      return this.approach(i, ctl, this.target);
    }
    const spare = glideMargin(this.o.margin, d);
    const projected = b.pos.y + climbMomentum(b.vel.y);
    const above = projected - glideLine(this.target, d);
    // Track BL: the terrain floor ahead (the sink line never goes under it) and the high cruise's floor
    const need = this.terrainNeed(b);
    const high = this.highFloor(d);
    const terrainShort = need !== undefined ? need - projected : -Infinity;
    const highShort = high !== undefined ? high - projected : -Infinity;
    if (b.boostTicks > 0) {
      // a rocket burning: a top-up of the cruise climbs at the pitch chosen for it, the climb's last rocket at
      // the climb pitch (the boost steers the velocity onto the look: levelled off, a burning rocket halves vy
      // every tick and the climb's momentum is lost; the whole burn goes into height, the cap of flyMaxClimb
      // bounds the climb's rockets, not the last one's run-out)
      ctl.pitch = this.cruiseFired ? this.cruisePitch : this.o.climbPitch;
      this.trackAvoid(b, terrainShort, i.rockets);
      this.steerClear(i, ctl);
      return ctl;
    }
    this.cruiseFired = false;
    if (i.rockets <= 0) this.noRocketTicks++;
    const fl = this.floor;
    // Track BL: steep (the climb a rocket can still make before the column is reached falls short): back-to-back
    // rockets at the climb pitch; out of reach even so: a detour heading with a lower profile
    const steep = fl !== undefined && terrainShort > 0 && terrainShort > (fl.at - 10) / CLIMB_SLOPE / 2;
    if (steep && fl && terrainShort > (fl.at - 6) / 1.25 && !detouring && i.rockets > 0) this.chooseDetour(b, ctl.yaw, projected);
    this.trackAvoid(b, terrainShort, i.rockets);
    // under the margin by more than 3 (the climb hands over within 3 of its height: that is on the margin, not
    // under it), judged at glide speed only: a slow body (after the climb, after a circle) sinks while it
    // regains its speed and that sink is not a shortfall of height (two needless top-ups at 600 blocks on bds-fly);
    // Track BL: under the terrain floor or the high cruise's floor at any flying speed
    const short = Math.max(terrainShort, highShort);
    const econ = above < spare - 3 && h >= 1.1;
    if ((econ || (short > 0 && h >= 0.8)) && i.rockets > 0) {
      // the height this rocket should buy: a whole rocket's worth while the glide ahead can use it, else just enough
      const glideAhead = d - APPROACH_DISTANCE;
      let gain = econ ? (glideAhead > ROCKET_CRUISE_CLIMB * GLIDE_RATIO ? ROCKET_CRUISE_CLIMB : Math.min(ROCKET_CRUISE_CLIMB, Math.max(6, spare + 8 - above))) : 6;
      if (short > 0) gain = Math.max(gain, Math.min(ROCKET_CRUISE_CLIMB, short + 8));
      if (high !== undefined && highShort > 0) gain = ROCKET_CRUISE_CLIMB; // the high cruise: a whole rocket's worth each
      this.cruisePitch = steep ? CLIMB_PITCH : rocketPitchFor(gain);
      // the boosted climb at that pitch must be clear for the next 20 ticks (fire checks it; else glide on)
      if (this.fire(i, ctl, 'cruise', this.cruisePitch)) {
        ctl.pitch = this.cruisePitch;
        this.cruiseFired = true;
        return ctl;
      }
    }
    if (h < STALL_SPEED + 0.1) ctl.pitch = 15;
    else if (h < 0.95) ctl.pitch = 8; // slow: a shallow dive recovers the speed without a rocket
    else if (d <= APPROACH_DISTANCE + BLEED_DISTANCE && h > APPROACH_SPEED && terrainShort < 0) ctl.pitch = -6; // before the approach: bleed the speed towards APPROACH_SPEED (the flare's climb grows with its square)
    else if (h > 1.7) ctl.pitch = -3;
    else ctl.pitch = 0;
    this.steerClear(i, ctl);
    // out of rockets and sinking under the slope: the approach from wherever we are (it lands short if it must)
    if (i.rockets <= 0 && b.pos.y < this.target.top + 2 && d > APPROACH_DISTANCE) this.landNow('no_rockets', b);
    return ctl;
  }

  // ---- Track BL: the terrain floor, the high cruise, the avoidance lines, the dive descent ---------------------

  /** The highest known (live or cache) column top around the body (the bound for unknown columns before any known one). */
  private seedTop(b: FlightBody): number | undefined {
    const q = this.o.terrain;
    if (!q) return undefined;
    let top: number | undefined;
    // a ring 16 out, not the column under the body: a start on a platform in the air (a pillar, the farm over home) is no terrain;
    // the ground around it is (e2e: from a 3x3 platform 200 up the floor over the unknown columns climbed the flight to y 190)
    for (const [dx, dz] of [[16, 0], [-16, 0], [0, 16], [0, -16], [11, 11], [-11, 11], [11, -11], [-11, -11]] as const) {
      const c = q(Math.floor(b.pos.x) + dx, Math.floor(b.pos.z) + dz);
      if (c.top !== undefined && c.src !== 'unknown') top = top === undefined ? c.top : Math.max(top, c.top);
    }
    return top;
  }

  /** The terrain floor's feet height now (terrain.ts terrainFloor along the heading to the target or the detour), every FLOOR_EVERY ticks. */
  private terrainNeed(b: FlightBody): number | undefined {
    const q = this.o.terrain;
    if (!q) return undefined;
    if (this.floor && this.stats.ticks - this.floorAt < FLOOR_EVERY) return this.floor.need;
    const corridor = this.linedUp(b) ? undefined : this.corridorEntry();
    let toward: { x: number; z: number } = corridor ?? this.target;
    if (this.detour && this.stats.ticks < this.detour.until) {
      const dir = yawDir(this.detour.yaw);
      toward = { x: b.pos.x + dir.x * 200, z: b.pos.z + dir.z * 200 };
    }
    const seed = this.seedTop(b);
    this.floor = terrainFloor(q, b.pos, toward, { clearance: this.o.clearance, stopAt: this.target, ...(seed !== undefined ? { seedTop: seed } : {}) });
    this.floorAt = this.stats.ticks;
    return this.floor.need;
  }

  /**
   * Track BL, the high cruise: over the build limit (BUILD_TOP + 2, nothing to hit) until the descent can
   * begin: the dive's reach from there (or the glide's, without the dive).
   */
  private highFloor(d: number): number | undefined {
    if (!this.o.highCruise) return undefined;
    const drop = BUILD_TOP + 2 - (this.target.top + APPROACH_HEIGHT);
    const reach = this.o.descentMode === 'spiral' ? APPROACH_DISTANCE + drop * GLIDE_RATIO : APPROACH_DISTANCE + DIVE_END_MAX + drop * 1.6 + 60;
    return d > reach ? BUILD_TOP + 2 : undefined;
  }

  /** Track BL: one line when the terrain floor starts to lift the cruise (reason, distance, the height wanted) and one when it is cleared (the height gained). */
  private trackAvoid(b: FlightBody, terrainShort: number, rockets: number): void {
    const fl = this.floor;
    if (!this.avoid) {
      if (terrainShort <= 0 || fl?.need === undefined) return;
      const what = fl.src === 'assumed' ? `unknown columns (assumed up to y ${Math.round(fl.top)})` : `terrain at y ${fl.top} (${fl.src})`;
      const reason = `${what} ${Math.round(fl.at)} blocks ahead at ${fl.x} ${fl.z}`;
      this.avoid = { reason, y0: b.pos.y, maxY: b.pos.y, rockets0: this.stats.rockets, clearTicks: 0 };
      this.o.note?.(`terrain ahead: ${reason} needs y ${fl.need.toFixed(0)}, the glide would be at ${(b.pos.y + climbMomentum(b.vel.y)).toFixed(0)}: pulling up (${rockets} rockets)`);
      return;
    }
    const a = this.avoid;
    a.maxY = Math.max(a.maxY, b.pos.y);
    a.clearTicks = terrainShort < -4 && b.boostTicks === 0 ? a.clearTicks + 1 : 0;
    if (a.clearTicks < 20) return;
    const line = `${a.reason}: gained ${(a.maxY - a.y0).toFixed(0)} blocks (y ${a.y0.toFixed(0)} -> ${a.maxY.toFixed(0)}), ${this.stats.rockets - a.rockets0} rockets`;
    this.stats.avoidances.push(line);
    this.o.note?.(`terrain cleared: ${line}`);
    this.avoid = undefined;
  }

  /** Track BL: terrain no rocket climb clears in time: the heading (30 / 60 / 90 degrees either side) whose profile is lowest, held for DETOUR_TICKS. */
  private chooseDetour(b: FlightBody, yaw: number, projected: number): void {
    const q = this.o.terrain;
    if (!q) return;
    const seed = this.seedTop(b);
    let best: { yaw: number; deficit: number } | undefined;
    for (const off of [30, -30, 60, -60, 90, -90]) {
      const dir = yawDir(yaw + off);
      const f = terrainFloor(q, b.pos, { x: b.pos.x + dir.x * 120, z: b.pos.z + dir.z * 120 }, { clearance: this.o.clearance, ahead: 120, ...(seed !== undefined ? { seedTop: seed } : {}) });
      const deficit = f.need === undefined ? -Infinity : f.need - projected - Math.max(0, f.at - 10) / 1.25;
      if (!best || deficit < best.deficit) best = { yaw: yaw + off, deficit };
    }
    if (!best) return;
    this.detour = { yaw: best.yaw, until: this.stats.ticks + DETOUR_TICKS };
    this.floorAt = -1000;
    this.o.note?.(`terrain ahead too steep to climb in time (${this.floor ? `y ${Math.round(this.floor.top)} ${Math.round(this.floor.at)} blocks out` : '?'}): a detour heading ${Math.round(yawDiff(yawTo(b.pos, this.target), best.yaw))} degrees off the bearing for ${DETOUR_TICKS} ticks`);
  }

  /** Track BL: a dive descent may be looked for (flyDescent, no corridor, no hold, high enough, near enough). */
  private diveAllowed(aboveEntry: number, d: number): boolean {
    if (this.o.descentMode === 'spiral' || this.target.bearing !== undefined || this.target.hold || this.phase !== 'cruise' || this.diveBanned) return false;
    const min = this.o.descentMode === 'dive' ? DIVE_MIN_ABOVE_FORCED : DIVE_MIN_ABOVE;
    return aboveEntry > min && d <= APPROACH_DISTANCE + DIVE_END_MAX + 1.6 * aboveEntry + 60 && !this.targetWalled();
  }

  /**
   * Track BL: walls or trees within 20 blocks of the target rise above it (more than 3): the descent planner's circle or S-turns
   * fit such a place, the dive's low hand-over does not (e2e fly-descent walled: 1 of 10 dives went round 4 times and touched a
   * wall). Known columns only, once per target.
   */
  private walled: { t: LandingTarget; v: boolean } | undefined;
  private targetWalled(): boolean {
    if (this.walled?.t === this.target) return this.walled.v;
    let v = false;
    const tx = Math.floor(this.target.x);
    const tz = Math.floor(this.target.z);
    const inner = this.target.half + 2;
    for (let dx = -20; dx <= 20 && !v; dx += 2) {
      for (let dz = -20; dz <= 20 && !v; dz += 2) {
        if (Math.abs(dx) <= inner && Math.abs(dz) <= inner) continue;
        const top = this.o.skyTop?.(tx + dx, tz + dz);
        if (top !== undefined && top > this.target.top + 2) v = true;
      }
    }
    this.walled = { t: this.target, v };
    return v;
  }

  /** The corridor query of the dive: unknown is not air (terrain.ts strictObstacle), and the column tops under the path. */
  private diveCells(b: FlightBody): { obstacle: Obstacle; clearTop: (x: number, z: number) => number | undefined } {
    const q = this.o.terrain;
    const knownMax = this.floor?.knownMax ?? this.seedTop(b) ?? b.pos.y;
    if (!q) return { obstacle: this.o.obstacle ?? (() => false), clearTop: (x, z) => this.o.skyTop?.(x, z) };
    return {
      obstacle: strictObstacle(q, this.o.obstacle, knownMax),
      clearTop: (x, z) => {
        const c = q(x, z);
        return c.src === 'unknown' || c.top === undefined ? assumedTop(knownMax, 0) : c.top;
      },
    };
  }

  /** Track BL: the dive search now: 'dive' (committed), 'wait' (its window is still ahead), 'none' (no dive from here). */
  private tryDive(i: BrainInput, b: FlightBody, last: boolean): 'dive' | 'wait' | 'none' {
    const plan = planDive(b, i.yaw, this.target, this.diveCells(b));
    const aboveEntry = b.pos.y - (this.target.top + APPROACH_HEIGHT);
    if (plan.ok && plan.profile) {
      this.dive = { p: plan.profile, phase: 'dive', from: b.pos.y, since: this.stats.ticks, aborted: false };
      this.stats.dives++;
      this.stats.descents.push(`dive ${plan.profile.divePitch}/${plan.profile.pullPitch} at ${Math.round(hdist(b.pos, this.target))} out from ${Math.round(b.pos.y - this.target.top)} above`);
      this.o.note?.(`dive descent from ${aboveEntry.toFixed(0)} over the entry, ${hdist(b.pos, this.target).toFixed(0)} out: ${plan.why} (${plan.sims} simulations)`);
      return 'dive';
    }
    if (last && !plan.wait && this.diveWhy !== plan.why) this.o.note?.(`no dive descent (${plan.why}): the descent circle`);
    this.diveWhy = plan.why;
    return plan.wait ? 'wait' : 'none';
  }

  /**
   * Track BL: fly the committed dive (dive.ts divePhase / divePitch, the approach yaw law): re-simulated
   * against the corridor every DIVE_RECHECK ticks of the dive and checked DIVE_AHEAD ticks ahead every
   * tick; a solid or the clearance gone pulls out at once and the cruise takes over again (no second dive
   * this approach). At the hand-over the approach begins. True while the dive's controls are set.
   */
  private flyDive(i: BrainInput, ctl: BrainControl): boolean {
    const dv = this.dive!;
    const b = i.body;
    const ph = divePhase(dv.p, dv.phase, b.pos, b.vel);
    const t = this.stats.ticks - dv.since;
    if (ph === 'done' || (dv.aborted && ph === 'bleed')) {
      this.dive = undefined;
      const aboveEntry = b.pos.y - (this.target.top + APPROACH_HEIGHT);
      if (dv.aborted) {
        this.diveBanned = true;
        return false;
      }
      this.o.note?.(`dive descent: handed over after ${t} ticks, ${hdist(b.pos, this.target).toFixed(0)} out, ${aboveEntry.toFixed(1)} over the entry at ${Math.hypot(b.vel.x, b.vel.z).toFixed(2)} blocks a tick (from y ${dv.from.toFixed(0)})`);
      this.phase = 'approach';
      this.planner.reset();
      this.stats.entryAbove ??= aboveEntry;
      return false;
    }
    dv.phase = ph;
    ctl.glide = true;
    ctl.yaw = approachYaw(i.yaw, b.pos, this.target);
    ctl.pitch = divePitch(dv.p, ph);
    if (ph === 'dive' && !dv.aborted) {
      const cells = this.diveCells(b);
      let why: string | undefined;
      // (only the ticks until the pull-out: the profile pulls out over the ground, a held dive would not)
      const until = Math.min(DIVE_AHEAD, Math.floor((b.pos.y - dv.p.pullAt) / Math.max(1, -b.vel.y)));
      const ahead = until > 0 ? pathAhead(b, ctl.yaw, ctl.pitch, until, cells.obstacle) : undefined;
      if (ahead !== undefined) why = `a solid ${ahead} ticks ahead`;
      else if (t > 0 && t % DIVE_RECHECK === 0) {
        const s = simulateDive(b, i.yaw, this.target, dv.p, 'dive', cells);
        if (!s.ok && s.why && !/too far|too near|over the entry|under the entry/.test(s.why)) why = s.why;
      }
      if (why) {
        this.o.note?.(`dive descent aborted at y ${b.pos.y.toFixed(0)} (${why}): pulling out, then the cruise`);
        dv.aborted = true;
        dv.phase = 'pull';
        ctl.pitch = dv.p.pullPitch;
      }
    }
    return true;
  }

  /**
   * Track BF: the body is lined up with the target's corridor (an overhang landing: `bearing`): at
   * least 36 blocks out along it, within 30 degrees of it, heading in (within 60 degrees). Always
   * true without a corridor.
   */
  private linedUp(b: FlightBody): boolean {
    const bearing = this.target.bearing;
    if (bearing === undefined) return true;
    const rel = { x: b.pos.x - this.target.x, z: b.pos.z - this.target.z };
    const dist = Math.hypot(rel.x, rel.z);
    if (dist < 1e-6) return false;
    const off = Math.abs(yawDiff(bearing, yawTo(this.target, b.pos)));
    const h = Math.hypot(b.vel.x, b.vel.z);
    const heading = h > 0.05 ? (Math.atan2(-b.vel.x, b.vel.z) * 180) / Math.PI : bearing + 180;
    return dist * Math.cos((off * Math.PI) / 180) >= 36 && off <= 30 && Math.abs(yawDiff(heading, bearing + 180)) <= 60;
  }

  /** Track BF: the corridor's entry point (CORRIDOR_OUT out along the bearing), undefined without a corridor. */
  private corridorEntry(): { x: number; z: number } | undefined {
    const bearing = this.target.bearing;
    if (bearing === undefined) return undefined;
    const d = yawDir(bearing);
    return { x: this.target.x + d.x * CORRIDOR_OUT, z: this.target.z + d.z * CORRIDOR_OUT };
  }

  /**
   * Track BF: hold high over a target that is not landable yet (its chunks have not arrived, the
   * landing is being confirmed): a circle of the largest radius that fits the columns at the hold
   * height (the go-around height: 7 over the highest column within 30 blocks, at least the approach
   * entry + 6), a rocket when it sinks 6 under it, never an approach. The trip retargets the flight
   * (or ends the hold after `flyHoldS`).
   */
  private hold(i: BrainInput, ctl: BrainControl): BrainControl {
    const b = i.body;
    const t = this.target;
    this.stats.holdTicks++;
    if (!this.holding) {
      const y = Math.max(this.goaroundHeight(), glideLine(t, APPROACH_DISTANCE) + SPIRAL_UNTIL);
      const fit = (this.o.skyTop ? spiralFit(t, Math.max(y, b.pos.y) - 3, this.o.skyTop) : undefined) ?? { centre: { x: t.x, z: t.z }, radius: SPIRAL_RADII.max };
      const heading = Math.hypot(b.vel.x, b.vel.z) > 0.05 ? (Math.atan2(-b.vel.x, b.vel.z) * 180) / Math.PI : 0;
      const ang = Math.atan2(b.pos.z - fit.centre.z, b.pos.x - fit.centre.x);
      const tangent = (s: 1 | -1): number => (Math.atan2(s * Math.sin(ang), s * Math.cos(ang)) * 180) / Math.PI;
      const dir: 1 | -1 = Math.abs(yawDiff(heading, tangent(1))) <= Math.abs(yawDiff(heading, tangent(-1))) ? 1 : -1;
      this.holding = { fit, dir, y };
      this.o.note?.(`holding over ${t.x.toFixed(0)} ${t.top} ${t.z.toFixed(0)} (not landable yet): circle r${fit.radius} at y ${Math.round(y)}`);
    }
    const hd = this.holding;
    const h = Math.hypot(b.vel.x, b.vel.z);
    ctl.glide = true;
    ctl.yaw = circleYaw(i.yaw, b.pos, hd.fit.centre, hd.fit.radius, hd.dir);
    if (b.boostTicks > 0) ctl.pitch = b.pos.y < hd.y ? -30 : -5;
    else if (b.pos.y < hd.y - 6 && h >= 0.9 && this.fire(i, ctl, 'cruise', -30)) ctl.pitch = -30;
    else ctl.pitch = h < STALL_SPEED + 0.1 ? 20 : b.pos.y > hd.y + 8 ? 8 : h > 1.4 ? 0 : 3;
    this.steerClear(i, ctl, { noLanding: true });
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
    // Track BF: a circle left at a tangent point gets a window as deep as one lap sinks (a level circle sinks
    // 0.15 to 0.2 a tick): with only the 10 blocks under the exit height the body reached them on the far side
    // of a 24-block circle and was forced out anywhere, too low and off the line (bds-fly, the farm: go-around)
    const lapSink = dsc.kind === 'spiral' && dsc.exitAt ? ((2 * Math.PI * dsc.fit.radius) / Math.max(0.8, h)) * 0.18 : 0;
    if (b.pos.y <= dsc.exitY + Math.max(0, lapSink - 10)) {
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
      // Track BF: an overhang's corridor fixes the approach line (only the tangent circles on it, left heading in)
      const corridor = aim === this.target && this.target.bearing !== undefined ? yawDir(this.target.bearing) : undefined;
      const ux = corridor ? corridor.x : d > 1e-6 ? (b.pos.x - aim.x) / d : 0;
      const uz = corridor ? corridor.z : d > 1e-6 ? (b.pos.z - aim.z) / d : 1;
      const heading = Math.hypot(b.vel.x, b.vel.z) > 0.05 ? (Math.atan2(-b.vel.x, b.vel.z) * 180) / Math.PI : 0;
      // along a circle the body moves by s * (-sin ang, cos ang) of its angle from the centre; Bedrock's yaw of (dx, dz) is atan2(-dx, dz)
      const tangent = (centre: { x: number; z: number }, at: { x: number; z: number }, s: 1 | -1): number => {
        const ang = Math.atan2(at.z - centre.z, at.x - centre.x);
        return (Math.atan2(s * Math.sin(ang), s * Math.cos(ang)) * 180) / Math.PI;
      };
      // around the aim: the largest circle that fits, turned the way the heading already points
      const exit0 = exitAt(APPROACH_DISTANCE);
      if (b.pos.y > exit0 && !corridor) {
        const fit = spiralFit(aim, Math.min(b.pos.y, exit0) - 3, skyTop);
        if (fit) {
          const dir: 1 | -1 = Math.abs(yawDiff(heading, tangent(fit.centre, b.pos, 1))) <= Math.abs(yawDiff(heading, tangent(fit.centre, b.pos, -1))) ? 1 : -1;
          return { kind: 'spiral', fit, dir, exitY: exit0 };
        }
      }
      // farther out: a circle tangent to the approach line at `out`, its centre a radius to one side
      for (const out of corridor ? ([45, 60, 80, 30] as const) : SPIRAL_OUT) {
        if (out > d + 10 && !corridor) continue; // never a circle behind the body
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
    if (this.target.bearing !== undefined) return undefined; // Track BF: S-turns would come in from anywhere, not along the corridor
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
      // Track BF: every go-around says why (the loops the owner saw were not explained in the log)
      const td = choice.touchdown;
      const why =
        td.kind !== 'landed'
          ? `no landing plan for ${this.planner.missing} ticks (best: ${td.kind}, cost ${choice.cost.toFixed(0)}, ${td.off.toFixed(1)} from the centre)`
          : `hard touchdown ahead (cost ${choice.cost.toFixed(0)}: vy ${td.vel.y.toFixed(2)}, h ${Math.hypot(td.vel.x, td.vel.z).toFixed(2)}, ${td.off.toFixed(1)} from the centre)`;
      const line = `${why} at ${d.toFixed(0)} blocks out, ${(b.pos.y - aim.top).toFixed(0)} above, ${Math.hypot(b.vel.x, b.vel.z).toFixed(2)} blocks a tick${aim.walk ? `, a walk landing of ${aim.cells?.size ?? 0} cells` : `, half ${aim.half}`}`;
      this.stats.goAroundReasons.push(line);
      if (this.stats.goArounds < this.o.goArounds && i.rockets > 0) {
        this.o.note?.(`go-around ${this.stats.goArounds + 1}: ${line}`);
        this.stats.goArounds++;
        this.phase = 'goaround';
        this.outbound = true;
        this.goaroundBearing = undefined;
        this.planner.reset();
        return this.goaround(i, ctl);
      }
      // Track BH: without a rocket but too high (`over`, the entry more than 4 under the body): a descent circle again
      // instead of the emergency landing (the glide down has height to spend, no rocket to climb with); at most twice
      if (td.kind === 'over' && b.pos.y - (aim.top + APPROACH_HEIGHT) > 4 && this.glideRedescents < 2) {
        this.glideRedescents++;
        this.o.note?.(`no rocket for a go-around, too high: a descent circle again (${this.glideRedescents}); ${line}`);
        this.phase = 'cruise';
        this.descent = undefined;
        this.descentNone = false;
        this.planner.reset();
        const c = this.chooseDescent(b, aim);
        if (c) {
          this.descent = c;
          this.stats.descents.push(c.kind === 'spiral' ? `spiral r${c.fit.radius} at ${Math.round(hdist(c.fit.centre, aim))} out from ${Math.round(b.pos.y - aim.top)} above (again)` : `S-turns from ${Math.round(b.pos.y - aim.top)} above (again)`);
          if (this.descend(i, ctl, aim)) return ctl;
        }
        return this.cruise(i, ctl);
      }
      // no go-around left: land on the nearest safe ground instead and report
      this.o.note?.(`no go-around left (${this.stats.goArounds} flown, ${i.rockets} rockets): the nearest safe ground; ${line}`);
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
      // the way back in must be open (Track AU2 review: a landing cell 2 blocks before a house wall, retargeted while
      // the body circled beyond the house, went around 4 times straight away from it and came back over the house)
      if (this.goaroundBearing === undefined) this.goaroundBearing = this.openBearing(away);
      const outAt = this.goaroundBearing === null ? undefined : { x: this.target.x - Math.sin((this.goaroundBearing * Math.PI) / 180) * GOAROUND_OUT, z: this.target.z + Math.cos((this.goaroundBearing * Math.PI) / 180) * GOAROUND_OUT };
      ctl.yaw = turnTowards(i.yaw, outAt ? yawTo(b.pos, outAt) : away, 12);
      const want = (this.goaroundY ??= this.goaroundHeight());
      if (b.boostTicks > 0) ctl.pitch = b.pos.y < want ? -30 : -5;
      else if (b.pos.y < want - 2 && this.fire(i, ctl, 'goaround', -30)) ctl.pitch = -30;
      else ctl.pitch = b.pos.y > want + 4 ? 10 : 0;
      if ((outAt ? hdist(b.pos, outAt) <= 12 || d >= GOAROUND_OUT + 30 : d >= GOAROUND_OUT) && b.pos.y <= want + 6) this.outbound = false;
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
   * Track AU2 review: the bearing (from the target) of the go-around's way back in: the bearing away from
   * the target when the last 24 blocks of that approach line are clear (every known column top under the
   * target's top), else the nearest of 45 / 90 / 135 / 180 degrees off it that is; null (straight away, the
   * Track AU behaviour) when the first is clear, nothing is known or nothing is clear.
   */
  private openBearing(away: number): number | null {
    const skyTop = this.o.skyTop;
    if (!skyTop) return null;
    const t = this.target;
    if (t.bearing !== undefined) return t.bearing; // Track BF: an overhang is only ever approached along its corridor
    const clear = (bearing: number): boolean => {
      const r = (bearing * Math.PI) / 180;
      for (let dist = t.half + 1; dist <= 24; dist++) {
        const top = skyTop(Math.floor(t.x - Math.sin(r) * dist), Math.floor(t.z + Math.cos(r) * dist));
        if (top !== undefined && top + 1 > t.top + 0.5) return false;
      }
      return true;
    };
    if (clear(away)) return null;
    for (const off of [45, -45, 90, -90, 135, -135, 180]) if (clear(away + off)) return away + off;
    return null;
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
    const bearing = this.target.bearing;
    if (bearing !== undefined) {
      // Track BF: an overhang's go-around is flown out and back along its corridor: only the columns of the corridor's
      // open stretch count (the roof over the cell is what the corridor goes under, not over)
      const d = yawDir(bearing);
      for (let s = Math.ceil(this.target.half) + 2; s <= GOAROUND_OUT; s++) {
        for (const lat of [-3, 0, 3]) {
          const x = Math.floor(this.target.x + d.x * s + d.z * lat);
          const z = Math.floor(this.target.z + d.z * s - d.x * lat);
          const t = skyTop(x, z);
          if (t !== undefined && t < this.target.top + OPEN_ABOVE && t + 1 + 6 > y) y = t + 1 + 6;
        }
      }
      return y;
    }
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
   * No known ground ahead: the headings 45, 90 and 135 degrees either side and behind are tried (the
   * nearest heading first) before the fallback 10 blocks ahead at the target's height (a void below).
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
    // ahead first, then round to behind (Track AU2 review: over a void the nearest known ground may lie back the way we came)
    for (const off of [0, 45, -45, 90, -90, 135, -135, 180]) {
      const best = along(yaw + off, dists);
      if (best) return best;
    }
    const dir = { x: -Math.sin((yaw * Math.PI) / 180), z: Math.cos((yaw * Math.PI) / 180) };
    const near = Math.min(10, within ?? 10);
    const top = ground?.(Math.floor(b.pos.x + dir.x * near), Math.floor(b.pos.z + dir.z * near), fromY) ?? ground?.(Math.floor(b.pos.x), Math.floor(b.pos.z), fromY);
    return { x: b.pos.x + dir.x * near, z: b.pos.z + dir.z * near, top: top ?? this.target.top, half: 6 };
  }
}
