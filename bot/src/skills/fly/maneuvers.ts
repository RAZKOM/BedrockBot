// The manoeuvre library (flight v2, Track F1; docs/flight.md "Manoeuvres (flight v2, Track F1)",
// decisions/0057-flight-manoeuvres.md). Each manoeuvre is a pure control law over the glide formula of
// skills/input/physics.ts (glideVelocity, which the server matches within 0.002 a tick) with its entry and
// exit conditions, and every one runs on the shared rollout (plan.ts glideRollout) against the world model
// (plan.ts hitsObstacle), so a planner can roll it out before it flies it:
//
//   state in -> (law, ticks) -> state out + the cells the body's box swept + the rockets it fired
//
// which is the edge of a search over manoeuvres (Track F2's planner). The laws only use what a vanilla
// client has: the look (yaw, pitch) and a rocket. The physics they lean on (docs/flight.md "Physics"):
//
//   - the heading follows the look: v.xz += (l.xz / cos * h - v.xz) * 0.1. Looking back (yaw + 180) takes
//     a fifth of the speed a tick (the brake); looking 96 degrees off turns the velocity fastest, 6.4
//     degrees a tick (the turn radius is about 9 times the speed in blocks)
//   - the dive term pushes along the look by 0.1 x the sink (0.015 a tick at the hover's 0.149): near a
//     standstill the look is a thruster, so the look's direction each tick steers a slow drift (station
//     keeping, the precision creep) and a look flipped every tick holds still while sinking 0.149
//   - the pull term (pitch up) turns speed into lift along any heading: a brake at pitch -30 holds its height
//   - a rocket pulls the velocity onto the look (a drone at about 1.6 blocks a tick, 2 ticks of lag)
//
// Status per manoeuvre: `measured` (flown on bds-fly: the flare, the spiral, the dive), `model` (the
// formula only until Track F0 measures it on BDS: the one-tick 180 snaps, the flip every tick) and `stub`
// (the interface only, until F0 says whether the server allows it at all: the short boost by a hotbar
// switch, stacked rockets, the wall kiss).
import type { Vec3 } from '../../connection/types.ts';
import { DIVE_BLEED_PITCH, divePhase, divePitch, type DivePhase, type DiveProfile } from './dive.ts';
import {
  approachYaw,
  circleYaw,
  FLARE_MAX,
  glideRollout,
  hdist,
  hitsObstacle,
  midpoint,
  SETTLE_SPEED,
  STALL_SPEED,
  touchdownCheck,
  yawDiff,
  type LandingTarget,
  type Obstacle,
  type RolloutLook,
  type RolloutState,
  type Touchdown,
} from './plan.ts';

/** The state a manoeuvre starts from and hands over: the body (feet, blocks a tick, boost left) with the look it holds. */
export type ManeuverState = RolloutState;
/** One tick of a law: the look, a rocket, or `done` (the exit met before this tick). */
export type ManeuverLook = RolloutLook;
/** A running law (its memory inside the closure: a fresh one per run). */
export type ManeuverLaw = (s: ManeuverState, t: number) => ManeuverLook;

export type ManeuverStatus = 'measured' | 'model' | 'stub';

export interface Maneuver<P> {
  readonly name: string;
  readonly status: ManeuverStatus;
  /** One line: what it does and what it is for. */
  readonly note: string;
  /** Why it cannot start from `s` (undefined: it can). */
  entry(s: ManeuverState, p: P): string | undefined;
  /** The law from `s` on (its exit is the law's `done`). */
  law(s: ManeuverState, p: P): ManeuverLaw;
  /** The tick cap of a run (the law has not exited by then: the run ends `timeout`). */
  maxTicks(p: P): number;
}

// ---- helpers ------------------------------------------------------------------------------------------

/** Horizontal speed (blocks a tick). */
export const speedOf = (v: { x: number; z: number }): number => Math.hypot(v.x, v.z);
/** The Bedrock yaw of a horizontal direction (0 = +z, 90 = -x). */
export const yawOfDir = (dx: number, dz: number): number => (Math.atan2(-dx, dz) * 180) / Math.PI;
/** The Bedrock yaw of the horizontal velocity (the heading); `fallback` when nearly still. */
export const headingOf = (v: { x: number; z: number }, fallback = 0): number => (speedOf(v) > 1e-4 ? yawOfDir(v.x, v.z) : fallback);
/** A yaw in (-180, 180]. */
export const normYaw = (y: number): number => yawDiff(0, y);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The align term's share a tick (physics.ts GLIDE.align): the velocity's turn towards the look. */
const ALIGN = 0.1;
/** The look offset that turns the velocity fastest (cos = -ALIGN / (1 - ALIGN)): 96.4 degrees, 6.4 degrees a tick. */
export const TURN_OFFSET_MAX = (Math.acos(-ALIGN / (1 - ALIGN)) * 180) / Math.PI;
/** The heading change one tick of the align term makes with the look `offset` degrees off the velocity (degrees). */
export function turnRate(offsetDeg: number): number {
  const r = (Math.abs(offsetDeg) * Math.PI) / 180;
  return (Math.atan2(ALIGN * Math.sin(r), 1 - ALIGN + ALIGN * Math.cos(r)) * 180) / Math.PI;
}
export const TURN_RATE_MAX = turnRate(TURN_OFFSET_MAX);
/** The look offset (degrees, 0 .. TURN_OFFSET_MAX) whose align term turns the heading by `rateDeg` a tick (bisection). */
export function turnOffsetFor(rateDeg: number): number {
  if (rateDeg >= TURN_RATE_MAX) return TURN_OFFSET_MAX;
  let lo = 0;
  let hi = TURN_OFFSET_MAX;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (turnRate(mid) < rateDeg) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
/** The turn radius (blocks) at speed `h` with the look `offset` degrees off the velocity (no rocket; the speed decays in a hard turn). */
export function turnRadius(h: number, offsetDeg: number): number {
  const w = (turnRate(offsetDeg) * Math.PI) / 180;
  return w > 1e-9 ? h / w : Infinity;
}

/**
 * Station keeping (the hover, the precision creep, the elevator; the brake while fast): a PD law on the
 * horizontal position. The wanted velocity is `kp` x the error, capped at `vmax`; the look points along
 * the velocity change still needed (the dive term pushes along it, the align term turns or takes the
 * velocity towards it; looking straight back is the brake); inside `band` of the point and nearly still
 * the look flips 180 degrees every tick (the pushes cancel: a hover sinking 0.149 a tick). Offline from a
 * standstill 3 blocks off: on the point within 0.15 after about 33 ticks, then within 0.05.
 */
export const KEEP = Object.freeze({ kp: 0.15, kd: 1, vmax: 0.3, band: 0.04, still: 0.03 });
export interface KeepGains { kp: number; kd: number; vmax: number; band: number; still: number }
export function keepYaw(s: { pos: Vec3; vel: Vec3; yaw: number }, at: { x: number; z: number }, g: KeepGains = KEEP): number {
  const ex = at.x - s.pos.x;
  const ez = at.z - s.pos.z;
  const e = Math.hypot(ex, ez);
  if (e < g.band && speedOf(s.vel) < g.still) return normYaw(s.yaw + 180);
  const k = Math.min(g.kp, g.vmax / Math.max(1e-9, e));
  return yawOfDir(ex * k - g.kd * s.vel.x, ez * k - g.kd * s.vel.z);
}

/** Track F1: the hover's sink a tick by pitch (the look flipped every tick, from a standstill; formula): 0 -> 0.149, +-10 -> 0.167, +-20 -> 0.225, 30 -> 0.34. */
export const HOVER_SINK = 0.149;
/** The brake: the pitch that holds the height from a level glide (from 1.48 blocks a tick: -30 loses 0.05 over the brake, 0 loses 1.2, -40 gains 0.23). */
export const BRAKE_HOLD_PITCH = -30;
/** A body slower than this is braked (the station keeping's own law takes over from the brake180). */
export const BRAKE_DONE = 0.2;

/** The brake's pitch that holds `holdY`: -30 on it, -40 under it, levelling towards 0 a block over it. */
export function holdPitch(y: number, holdY: number): number {
  return clamp(BRAKE_HOLD_PITCH + 30 * (y - holdY), -40, 0);
}

// ---- the manoeuvres -----------------------------------------------------------------------------------

/** 180 brake: look straight back along the velocity; the pitch holds the entry height (or `pitch`). */
export const brake180: Maneuver<{ pitch?: number; holdY?: number; until?: number }> = {
  name: 'brake180',
  status: 'model',
  note: 'look straight back: a fifth of the speed a tick, 1.48 -> 0.17 in 10 ticks over 5.5 blocks, the height held (1.05 -> 0.18 in 8 over 3.5)',
  entry: (s) => (speedOf(s.vel) < 0.3 ? 'too slow to brake' : undefined),
  law(s0, p) {
    const holdY = p.holdY ?? s0.pos.y;
    return (s) => {
      const h = speedOf(s.vel);
      if (h < (p.until ?? BRAKE_DONE)) return { yaw: s.yaw, pitch: s.pitch, done: true };
      return { yaw: normYaw(headingOf(s.vel, s.yaw) + 180), pitch: p.pitch ?? holdPitch(s.pos.y, holdY) };
    };
  },
  maxTicks: () => 40,
};

/** Partial brake: the look held `offset` (100 to 170) degrees off the entry heading to one side: slows while the velocity swings round to that side. */
export const partialBrake: Maneuver<{ offset: number; side: 1 | -1; pitch?: number; until?: number; ticks?: number }> = {
  name: 'partialBrake',
  status: 'model',
  note: 'the look held 100 to 170 degrees off the heading: slows while drifting sideways (a brake that also moves the stop point off the line)',
  entry: (s, p) => (speedOf(s.vel) < 0.3 ? 'too slow to brake' : p.offset < 90 || p.offset > 180 ? 'the offset must be 90 to 180 degrees' : undefined),
  law(s0, p) {
    const yaw = normYaw(headingOf(s0.vel, s0.yaw) + p.side * p.offset);
    return (s, t) => (speedOf(s.vel) < (p.until ?? BRAKE_DONE) || t > (p.ticks ?? 40) ? { yaw: s.yaw, pitch: s.pitch, done: true } : { yaw, pitch: p.pitch ?? BRAKE_HOLD_PITCH });
  },
  maxTicks: (p) => (p.ticks ?? 40) + 1,
};

/** Hover (station keeping): hold the point (the entry's by default) for `ticks`, sinking HOVER_SINK at pitch 0. */
export const hover: Maneuver<{ at?: { x: number; z: number }; ticks: number; pitch?: number }> = {
  name: 'hover',
  status: 'model',
  note: 'station keeping: the look as a thruster towards the point, flipped every tick when on it; sinks 0.149 a tick at pitch 0',
  entry: (s) => (speedOf(s.vel) > 0.5 ? 'too fast to hover (brake first)' : undefined),
  law(s0, p) {
    const at = p.at ?? { x: s0.pos.x, z: s0.pos.z };
    return (s, t) => (t > p.ticks ? { yaw: s.yaw, pitch: s.pitch, done: true } : { yaw: keepYaw(s, at), pitch: p.pitch ?? 0 });
  },
  maxTicks: (p) => p.ticks + 1,
};

/** Precision creep: the station keeping's drift onto `to` (at most `vmax` a tick), done when on it (within `within`) and still. */
export const creep: Maneuver<{ to: { x: number; z: number }; within?: number; vmax?: number; pitch?: number }> = {
  name: 'creep',
  status: 'model',
  note: 'a slow drift (0.3 a tick at most) steered onto a point by the look, sinking 0.149 a tick; done on the point and still',
  entry: (s) => (speedOf(s.vel) > 0.6 ? 'too fast to creep (brake first)' : undefined),
  law(_s0, p) {
    const g = { ...KEEP, ...(p.vmax !== undefined ? { vmax: p.vmax } : {}) };
    return (s) => (hdist(s.pos, p.to) <= (p.within ?? 0.1) && speedOf(s.vel) < 0.03 ? { yaw: s.yaw, pitch: s.pitch, done: true } : { yaw: keepYaw(s, p.to, g), pitch: p.pitch ?? 0 });
  },
  maxTicks: () => 200,
};

/** Elevator descent: station keeping over `at` (the entry's point) while sinking, down to `downTo` (feet y); pitch 0 sinks 0.149, 20 sinks 0.225. */
export const elevator: Maneuver<{ at?: { x: number; z: number }; downTo: number; pitch?: number }> = {
  name: 'elevator',
  status: 'model',
  note: 'the hover sinking straight down (0.149 a tick at pitch 0, 0.225 at 20): down a shaft, onto a pillar, under a roof',
  entry: (s, p) => (speedOf(s.vel) > 0.5 ? 'too fast for the elevator (brake first)' : s.pos.y <= p.downTo ? 'already down' : undefined),
  law(s0, p) {
    const at = p.at ?? { x: s0.pos.x, z: s0.pos.z };
    return (s) => (s.pos.y <= p.downTo ? { yaw: s.yaw, pitch: s.pitch, done: true } : { yaw: keepYaw(s, at), pitch: p.pitch ?? 0 });
  },
  maxTicks: () => 2000,
};

/** Powered snap turn: the look snapped to `heading` under a rocket (fired at the entry when `fire` and none burns); done when the velocity follows it. */
export const snapTurn: Maneuver<{ heading: number; pitch?: number; fire?: boolean; within?: number }> = {
  name: 'snapTurn',
  status: 'model',
  note: 'under a rocket the velocity follows the look with about 2 ticks of lag: a 90 degree turn in 4 ticks at 1.5 a tick, 2 degrees short when the look comes back',
  entry: (s, p) => (s.boostTicks <= 0 && !p.fire ? 'no rocket burning (fire one)' : undefined),
  law(_s0, p) {
    return (s, t) => {
      const h = speedOf(s.vel);
      if (t > 1 && (Math.abs(yawDiff(headingOf(s.vel, s.yaw), p.heading)) <= (p.within ?? 5) || s.boostTicks <= 0) && h > 0.05) return { yaw: s.yaw, pitch: s.pitch, done: true };
      return { yaw: p.heading, pitch: p.pitch ?? 0, ...(t === 1 && p.fire && s.boostTicks <= 0 ? { fire: true } : {}) };
    };
  },
  maxTicks: () => 30,
};

/** Coordinated glide turn: the look offset each tick for the turn `radius` at the speed now (turnOffsetFor), towards `heading`; no rocket. */
export const glideTurn: Maneuver<{ heading: number; radius: number; pitch?: number }> = {
  name: 'glideTurn',
  status: 'model',
  note: 'the look offset that turns the heading at speed / radius a tick (at most 6.4 degrees a tick: the radius is at least 9 x the speed)',
  entry: (s) => (speedOf(s.vel) < 0.5 ? 'too slow to turn' : undefined),
  law(_s0, p) {
    return (s) => {
      const h = speedOf(s.vel);
      const heading = headingOf(s.vel, s.yaw);
      const left = yawDiff(heading, p.heading);
      const rate = (h / Math.max(0.5, p.radius)) * (180 / Math.PI);
      if (Math.abs(left) <= Math.max(0.5, rate * 0.6) || h < 0.3) return { yaw: s.yaw, pitch: s.pitch, done: true };
      // the last tick's offset only what is left (no overshoot of the new heading)
      const want = Math.min(rate, Math.abs(left));
      return { yaw: normYaw(heading + Math.sign(left) * turnOffsetFor(want)), pitch: p.pitch ?? 0 };
    };
  },
  maxTicks: () => 200,
};

/** Zoom climb: pull up at `pitch` along the heading, trading speed for height, until the top of the climb (or `toY`, or the speed under `minH`). */
export const zoomClimb: Maneuver<{ pitch: number; toY?: number; minH?: number; ticks?: number }> = {
  name: 'zoomClimb',
  status: 'model',
  note: 'pitch up and coast: the climb grows with the square of the speed (from 1.0: +2.7 to +4.7; from 1.5: +18 to +22, pitch -30 to -60), to hop an obstacle without a rocket',
  entry: (s) => (speedOf(s.vel) < 0.6 ? 'too slow to zoom' : undefined),
  law(s0, p) {
    const yaw = headingOf(s0.vel, s0.yaw);
    let rose = false;
    return (s, t) => {
      if (s.vel.y > 0) rose = true;
      const stop = (rose && s.vel.y <= 0) || speedOf(s.vel) < (p.minH ?? SETTLE_SPEED) || (p.toY !== undefined && s.pos.y >= p.toY) || t > (p.ticks ?? 80);
      return stop ? { yaw: s.yaw, pitch: s.pitch, done: true } : { yaw, pitch: p.pitch };
    };
  },
  maxTicks: (p) => (p.ticks ?? 80) + 1,
};

/** The flare (Track AU's segment B, measured): zoomClimb with the landing planner's exit (the top of the climb, the speed under 0.35, 40 ticks). */
export const flare: Maneuver<{ pitch: number }> = {
  name: 'flare',
  status: 'measured',
  note: "the landing's pull-up (segment B of the flare profile): -20 to -85 until the top of the climb, under 0.35 or 40 ticks",
  entry: (s, p) => zoomClimb.entry(s, p),
  law: (s0, p) => zoomClimb.law(s0, { pitch: p.pitch, minH: SETTLE_SPEED, ticks: FLARE_MAX }),
  maxTicks: () => FLARE_MAX + 1,
};

/** The descent circle (Track AU2, measured): pure pursuit on the circle, pitch 8 (0 over 1.4 a tick, 20 near the stall), down to `exitY`. */
export const spiral: Maneuver<{ centre: { x: number; z: number }; radius: number; dir: 1 | -1; exitY: number }> = {
  name: 'spiral',
  status: 'measured',
  note: 'the descent circle: sinks 0.15 to 0.2 a tick without going anywhere',
  entry: (s, p) => (s.pos.y <= p.exitY ? 'already under the exit height' : undefined),
  law(_s0, p) {
    return (s) => {
      if (s.pos.y <= p.exitY) return { yaw: s.yaw, pitch: s.pitch, done: true };
      const h = speedOf(s.vel);
      return { yaw: circleYaw(s.yaw, s.pos, p.centre, p.radius, p.dir), pitch: h > 1.4 ? 0 : h < STALL_SPEED + 0.1 ? 20 : 8 };
    };
  },
  maxTicks: () => 4000,
};

/** The dive descent (Track BL, measured): dive, pull, bleed towards `target` (dive.ts divePhase / divePitch), done at the hand-over. */
export const dive: Maneuver<{ profile: DiveProfile; target: { x: number; z: number } }> = {
  name: 'dive',
  status: 'measured',
  note: 'dive at 55 to 85, pull out at -15 to -45, bleed at -6 to 1.05 a tick: from 250 up in about 170 ticks',
  entry: (s, p) => (s.pos.y <= p.profile.pullAt ? 'already under the pull-out height' : undefined),
  law(_s0, p) {
    let phase: DivePhase = 'dive';
    return (s) => {
      const ph = divePhase(p.profile, phase, s.pos, s.vel);
      if (ph === 'done') return { yaw: s.yaw, pitch: s.pitch, done: true };
      phase = ph;
      return { yaw: approachYaw(s.yaw, s.pos, p.target), pitch: ph === 'bleed' ? DIVE_BLEED_PITCH : divePitch(p.profile, ph) };
    };
  },
  maxTicks: () => 600,
};

/** The vertical climb (the vertical takeoff's straight climb): look straight up, a rocket whenever none burns and the coast would not reach `top` (feet y). */
export const verticalClimb: Maneuver<{ top: number }> = {
  name: 'verticalClimb',
  status: 'model',
  note: 'pitch -90 on rockets: 30 up in 23 ticks on one rocket (the boost, then the coast to the top)',
  entry: (s, p) => (s.pos.y >= p.top ? 'already over the top' : undefined),
  law(_s0, p) {
    return (s) => {
      if (s.pos.y >= p.top) return { yaw: s.yaw, pitch: s.pitch, done: true };
      const coast = s.vel.y > 0 ? (s.vel.y * s.vel.y) / 0.2 : 0;
      return { yaw: s.yaw, pitch: -90, ...(s.boostTicks <= 0 && s.pos.y + coast < p.top ? { fire: true } : {}) };
    };
  },
  maxTicks: () => 300,
};

/** Interface stubs until Track F0 measures what the server allows (docs/flight.md "Manoeuvres": the stubs). */
function stub<P>(name: string, note: string): Maneuver<P> {
  return {
    name,
    status: 'stub',
    note,
    entry: () => 'not available: not measured on the server yet (Track F0)',
    law: () => (s) => ({ yaw: s.yaw, pitch: s.pitch, done: true }),
    maxTicks: () => 0,
  };
}
/** The short boost: a hotbar slot switch mid-rocket to cut the burn short. Track F0 measured that BDS does NOT cut the boost on a switch (nor fires rockets from the offhand): a no-op kept for the record, it refuses every entry. */
export const shortBoost: Maneuver<{ ticks: number; heading: number; pitch: number }> = stub('shortBoost', 'a rocket cut after `ticks` by a hotbar slot switch: Track F0 measured that a switch does not cut the boost (docs/flight-envelope.md section 5); never available');
/** Stacked rockets: a second rocket before the first one's burn ends. Track F0: the boost is the UNION of the lifetimes (no doubling); the continuous boost is sound but no manoeuvre uses it yet. */
export const stackedBoost: Maneuver<{ rockets: number; heading: number; pitch: number }> = stub('stackedBoost', 'rockets re-fired before the burn ends: Track F0 measured the union of the lifetimes, no stronger push (docs/flight-envelope.md section 4); not flown by a planner yet');
/** The wall kiss: touch a wall under the impact-damage threshold to stop. */
export const wallKiss: Maneuver<{ wall: Vec3; maxSpeed: number }> = stub('wallKiss', 'a touch of a wall under the impact threshold as a brake; F0 measures the threshold on BDS');
/** The rocket brake: a rocket while looking back (a near-instant stop, then a reverse unless the burn is cut: needs the short boost). */
export const rocketBrake: Maneuver<{ until: number }> = stub('rocketBrake', 'a rocket fired looking back: stops in 2 to 3 ticks, then reverses; useful only with the short boost');

/** Every manoeuvre of the library by name (the planner's edge set; the stubs refuse every entry). */
export const MANEUVERS = Object.freeze({ brake180, partialBrake, hover, creep, elevator, snapTurn, glideTurn, zoomClimb, flare, spiral, dive, verticalClimb, shortBoost, stackedBoost, wallKiss, rocketBrake });

// ---- the simulator hook -------------------------------------------------------------------------------

/** The key of a cell (x, y, z) in a run's swept set (x, z wrapped to 16 bits, y from -64 in 9 bits). */
export function cellKey(x: number, y: number, z: number): number {
  return (x & 0xffff) * 33554432 + (z & 0xffff) * 512 + ((y + 64) & 0x1ff);
}
/** The cell (x, y, z) of a swept key (x, z as the 16-bit wrap: callers compare keys, not coordinates). */
export function cellOfKey(k: number): { x: number; y: number; z: number } {
  return { x: Math.floor(k / 33554432), z: Math.floor(k / 512) % 65536, y: (k % 512) - 64 };
}

/** Adds the cells the gliding box (0.6 wide, 0.6 high) at `p` overlaps to `into`. */
export function sweepBox(p: Vec3, into: Set<number>): void {
  for (let x = Math.floor(p.x - 0.3); x <= Math.floor(p.x + 0.3); x++) for (let z = Math.floor(p.z - 0.3); z <= Math.floor(p.z + 0.3); z++) for (let y = Math.floor(p.y); y <= Math.floor(p.y + 0.6); y++) into.add(cellKey(x, y, z));
}

export interface RunOptions {
  /** The world model's solids (unknown = free): a hit ends the run (`hit`). */
  obstacle?: Obstacle;
  /** The berth around the body's box for the hits (default 0: the box itself; the planners use OBSTACLE_BERTH 0.4). */
  berth?: number;
  /** A landing target: a touchdown on it ends the run `landed` (plan.ts touchdownCheck: its walls, its footprint). */
  target?: LandingTarget;
  /** Rockets at hand (default unlimited): a law's rocket beyond them is not fired. */
  rockets?: number;
  /** Collect the swept cells (default true). */
  sweep?: boolean;
  /** Cap the run (default the manoeuvre's own). */
  maxTicks?: number;
}

export type RunEnd = 'done' | 'landed' | 'hit' | 'missed' | 'timeout' | 'refused';

export interface ManeuverRun {
  name: string;
  ok: boolean;
  end: RunEnd;
  why?: string;
  start: ManeuverState;
  /** The state handed over (the next manoeuvre starts from it). */
  out: ManeuverState;
  ticks: number;
  rockets: number;
  /** The cells the body's box overlapped (cellKey), at every tick's end and midpoint. */
  swept: Set<number>;
  /** A touchdown (with `target`). */
  touchdown?: Touchdown;
  minY: number;
  maxY: number;
  /** Horizontal distance covered from the start to the end. */
  moved: number;
}

/**
 * Roll a manoeuvre out from `start` on the shared rollout: its law each tick until its exit (`done`), a
 * touchdown on `o.target` (`landed`, or `missed`: beside it, short, into its side), a solid in the box
 * (`hit`) or the tick cap (`timeout`); the entry refused is `refused` (0 ticks). Pure.
 */
export function runManeuver<P>(m: Maneuver<P>, p: P, start: ManeuverState, o: RunOptions = {}): ManeuverRun {
  const swept = new Set<number>();
  const base = { name: m.name, start, swept };
  const why = m.entry(start, p);
  if (why) return { ...base, ok: false, end: 'refused', why, out: start, ticks: 0, rockets: 0, minY: start.pos.y, maxY: start.pos.y, moved: 0 };
  const law = m.law(start, p);
  let left = o.rockets ?? Infinity;
  let minY = start.pos.y;
  let maxY = start.pos.y;
  const sweep = o.sweep !== false;
  const berth = o.berth ?? 0;
  const touch = o.target ? touchdownCheck(o.target, o.obstacle, false) : undefined;
  interface Stop { end: RunEnd; why: string; touchdown?: Touchdown }
  const r = glideRollout<Stop>(
    start,
    start.yaw,
    start.pitch,
    o.maxTicks ?? m.maxTicks(p),
    (s, t) => {
      const look = law(s, t);
      if (look.fire && s.boostTicks <= 0) {
        if (left <= 0) return { ...look, fire: false };
        left--;
      }
      return look;
    },
    (k) => {
      minY = Math.min(minY, k.next.y);
      maxY = Math.max(maxY, k.next.y);
      if (sweep) {
        sweepBox(k.next, swept);
        sweepBox(midpoint(k.pos, k.next), swept);
      }
      if (touch) {
        const td = touch(k);
        if (td) return td.kind === 'landed' ? { end: 'landed', why: `landed ${td.off.toFixed(2)} from the centre`, touchdown: td } : { end: td.kind === 'wall' ? 'hit' : 'missed', why: `${td.kind} at ${td.pos.x.toFixed(1)} ${td.pos.y.toFixed(1)} ${td.pos.z.toFixed(1)}`, touchdown: td };
      } else if (o.obstacle && (hitsObstacle(o.obstacle, k.next, berth) || hitsObstacle(o.obstacle, midpoint(k.pos, k.next), berth))) {
        return { end: 'hit', why: `a solid at ${Math.floor(k.next.x)} ${Math.floor(k.next.y)} ${Math.floor(k.next.z)} after ${k.t} ticks` };
      }
      return undefined;
    },
  );
  const out: ManeuverState = { pos: r.pos, vel: r.vel, boostTicks: r.boostTicks, yaw: r.yaw, pitch: r.pitch };
  const stop = r.result;
  const end: RunEnd = stop ? stop.end : r.done ? 'done' : 'timeout';
  return {
    ...base,
    ok: end === 'done' || end === 'landed',
    end,
    ...(stop ? { why: stop.why } : end === 'timeout' ? { why: `no exit after ${r.ticks} ticks` } : {}),
    out,
    ticks: r.ticks,
    rockets: r.rockets,
    ...(stop?.touchdown ? { touchdown: stop.touchdown } : {}),
    minY,
    maxY,
    moved: hdist(start.pos, r.pos),
  };
}

/** One edge of a chain: a manoeuvre with its parameters (or a function of the state it starts from). */
export interface ChainStep {
  m: Maneuver<never>;
  /** The parameters, or a function of the state the step starts from that gives them. */
  p: unknown;
}

/** A chain of manoeuvres flown one after the other (each from the state the last handed over); stops at the first that does not end ok or that lands. */
export function runChain(steps: readonly ChainStep[], start: ManeuverState, o: RunOptions = {}): { ok: boolean; runs: ManeuverRun[]; out: ManeuverState; ticks: number; rockets: number; swept: Set<number>; landed: boolean } {
  const runs: ManeuverRun[] = [];
  const swept = new Set<number>();
  let s = start;
  let rockets = 0;
  let ticks = 0;
  let left = o.rockets ?? Infinity;
  for (const step of steps) {
    const p = typeof step.p === 'function' ? (step.p as (s: ManeuverState) => unknown)(s) : step.p;
    const r = runManeuver(step.m as Maneuver<unknown>, p, s, { ...o, rockets: left });
    runs.push(r);
    for (const k of r.swept) swept.add(k);
    rockets += r.rockets;
    left -= r.rockets;
    ticks += r.ticks;
    s = r.out;
    if (!r.ok || r.end === 'landed') break;
  }
  const last = runs[runs.length - 1];
  return { ok: runs.length === steps.length && runs.every((r) => r.ok) || last?.end === 'landed', runs, out: s, ticks, rockets, swept, landed: last?.end === 'landed' };
}
