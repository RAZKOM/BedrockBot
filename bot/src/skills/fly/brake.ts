// The brake / elevator landing (flight v2, Track F1; docs/flight.md "Manoeuvres (flight v2, Track F1)",
// decisions/0057-flight-manoeuvres.md): a landing family of the profile search (plan.ts ProfilePlanner)
// beside the flare's. Instead of a zoom climb that trades the speed for height and settles onto the
// platform (the flare: a touchdown at 0.3 blocks a tick that slides 0.6 to 0.8 on), the body comes in
// level at a moderate speed, brakes near the cell (the look straight back takes a fifth of the speed a
// tick: 1.05 -> 0.2 in 8 ticks over 3.5 blocks, the pitch holding the height), keeps station over it
// (the look as a thruster: the dive term pushes along it while sinking) and sinks straight down onto it
// (the elevator, 0.149 a tick at pitch 0): a touchdown nearly still, 0.1 or less from the centre.
//
//   A1  pitchA1 for ticksA1 ticks         \ the flare's approach segments (the same yaw law: towards the
//   A2  pitchA2 until brakeAt from the cell / target), arriving over the cell's top (or the shaft's rim)
//   K   station keeping over the cell (maneuvers.ts keepYaw): while faster than BRAKE_FAST it is the brake
//       (the look back along the velocity, pitch pitchK), then the hover / creep onto the centre, sinking
//       at pitch pitchE until the feet touch the cell (the elevator)
//
// Lands where the flare cannot: a 1 x 1 pillar top, the floor of a shaft (the approach flies over the rim:
// LandingTarget.rim), a cell under a roof 3 above, a cell before a wall. The planner re-optimises the free
// parameters every tick from the real body like the flare's (in K only the pitches are left: few samples).
import { BRAKE_HOLD_PITCH, keepYaw, speedOf, type Maneuver } from './maneuvers.ts';
import { approachYaw, glideRollout, hdist, ProfilePlanner, touchdownCheck, type FlightBody, type LandingTarget, type Obstacle, type ProfileFamily, type Touchdown } from './plan.ts';

export interface BrakeProfile {
  /** A1: the pitch held for `ticksA1` ticks. */
  pitchA1: number;
  ticksA1: number;
  /** A2: the pitch held until `brakeAt`. */
  pitchA2: number;
  /** K begins this many blocks (horizontal) before the cell centre. */
  brakeAt: number;
  /** K: the brake's pitch while faster than BRAKE_FAST (-30 holds the height from 1.05 to 1.5). */
  pitchK: number;
  /** K: the elevator's pitch once slower (0 sinks 0.149 a tick, 20 sinks 0.225). */
  pitchE: number;
}

export type BrakePhase = 'A1' | 'A2' | 'K';

export interface BrakeState {
  phase: BrakePhase;
  /** Ticks spent in A1. */
  ticksA: number;
}

export const BRAKE_START: Readonly<BrakeState> = Object.freeze({ phase: 'A1', ticksA: 0 });

/** The ranges the brake planner samples from. */
export const BRAKE_RANGES = Object.freeze({
  pitchA1: [-30, 45],
  ticksA1: [0, 40],
  pitchA2: [-30, 45],
  brakeAt: [2, 16],
  pitchK: [-45, 0],
  pitchE: [0, 30],
} as const);
const BRAKE_STEPS: Record<keyof BrakeProfile, number> = { pitchA1: 5, ticksA1: 4, pitchA2: 5, brakeAt: 1, pitchK: 5, pitchE: 10 };

/** K brakes (pitchK) while the horizontal speed is over this; slower, the elevator's pitch (pitchE). */
export const BRAKE_FAST = 0.35;
/** The longest brake landing simulated (the approach from 56 out, the brake, an elevator 20 down: about 250). */
export const BRAKE_MAX_TICKS = 400;
/** Track F8: the elevator's slowest sink (pitch 0, blocks a tick): the ticks a deeper rim adds to the simulation's horizon. */
export const ELEVATOR_SINK_MIN = 0.149;
/** Track F8: the simulation's horizon for a target: BRAKE_MAX_TICKS, plus the sink past 20 down inside a deeper rim (the owner's cave: a pit 46 deep takes about 310 ticks of elevator alone). */
export function brakeMaxTicks(target: Pick<LandingTarget, 'top' | 'rim'>): number {
  const depth = target.rim !== undefined ? target.rim - target.top : 0;
  return BRAKE_MAX_TICKS + Math.max(0, Math.ceil((depth - 20) / ELEVATOR_SINK_MIN));
}
/**
 * `flyLandStyle auto`: the brake landing is flown when its plan costs this much less than the flare's
 * (the flare is the measured landing; the brake wins where the flare cannot be soft: a 1 x 1 cell, a shaft).
 */
export const BRAKE_BIAS = 4;

/** The control law of a brake profile (the brain and the simulation share it): the look for this tick and the state after it (pure). */
export function brakeControl(p: BrakeProfile, st: BrakeState, s: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; yaw: number }, target: LandingTarget): { yaw: number; pitch: number; next: BrakeState } {
  let { phase, ticksA } = st;
  if (phase === 'A1') {
    if (ticksA >= p.ticksA1) phase = 'A2';
    else ticksA++;
  }
  if (phase !== 'K' && hdist(s.pos, target) <= p.brakeAt) phase = 'K';
  if (phase === 'K') return { ...keepLook(s, target, p.pitchK, p.pitchE), next: { phase, ticksA } };
  return { yaw: approachYaw(s.yaw, s.pos, target), pitch: phase === 'A1' ? p.pitchA1 : p.pitchA2, next: { phase, ticksA } };
}

/** Segment K's look: the station keeping over `at` (keepYaw), at `pitchK` while faster than BRAKE_FAST (the brake), then at `pitchE` (the creep, the hover, the elevator). */
export function keepLook(s: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; yaw: number }, at: { x: number; z: number }, pitchK: number, pitchE: number): { yaw: number; pitch: number } {
  return { yaw: keepYaw(s, at), pitch: speedOf(s.vel) > BRAKE_FAST ? pitchK : pitchE };
}

/** settleOnto starts within this of the cell centre (BRAKE_RANGES.brakeAt's top: K never begins farther out). */
export const SETTLE_ONTO_NEAR = BRAKE_RANGES.brakeAt[1];

/**
 * Segment K as a library manoeuvre (maneuvers.ts `Maneuver`; Track F2's settle onto a landing cell): brake
 * over the cell centre, creep onto it, hover, sink at `pitchE` (0: 0.149 a tick, 20: 0.225) until the feet
 * reach `top`. The touchdown itself is the caller's world check (runManeuver's target, the planner's sweep).
 * Flown on bds-fly2 as the K of every brake landing of fly-maneuver.test.ts.
 */
export const settleOnto: Maneuver<{ at: { x: number; z: number }; top: number; pitchK?: number; pitchE?: number }> = {
  name: 'settleOnto',
  status: 'measured',
  note: "the brake landing's K: brake over the cell (pitch -30 holds the height), creep onto the centre, sink 0.149 a tick (pitch 0) or 0.225 (20) onto it",
  entry: (s, p) => (s.pos.y <= p.top ? 'not over the cell top' : hdist(s.pos, p.at) > SETTLE_ONTO_NEAR ? 'too far from the cell (approach first)' : undefined),
  law: (_s0, p) => (s) => (s.pos.y <= p.top ? { yaw: s.yaw, pitch: s.pitch, done: true } : keepLook(s, p.at, p.pitchK ?? BRAKE_HOLD_PITCH, p.pitchE ?? 0)),
  maxTicks: () => BRAKE_MAX_TICKS,
};

/**
 * The whole brake landing with fixed parameters, as a library manoeuvre: A2 towards the cell at `pitchA`
 * (the approach yaw law) until `brakeAt` from its centre, then K (settleOnto's law). It is brakeControl with
 * no A1, a pure law with no search inside, for a planner that sweeps what it flies (Track F2). The profile
 * search (BrakePlanner) is what picks the parameters for the brain.
 */
export const brakeApproach: Maneuver<{ at: { x: number; z: number }; top: number; pitchA: number; brakeAt: number; pitchK?: number; pitchE?: number }> = {
  name: 'brakeApproach',
  status: 'measured',
  note: 'the brake landing in one: glide in towards the cell at pitchA, brake brakeAt before its centre, creep, sink onto it',
  entry: (s, p) => (s.pos.y <= p.top ? 'not over the cell top' : undefined),
  law(_s0, p) {
    const prof: BrakeProfile = { pitchA1: p.pitchA, ticksA1: 0, pitchA2: p.pitchA, brakeAt: p.brakeAt, pitchK: p.pitchK ?? BRAKE_HOLD_PITCH, pitchE: p.pitchE ?? 0 };
    const target: LandingTarget = { x: p.at.x, z: p.at.z, top: p.top, half: 0.5 };
    let st: BrakeState = BRAKE_START;
    return (s) => {
      if (s.pos.y <= p.top) return { yaw: s.yaw, pitch: s.pitch, done: true };
      const c = brakeControl(prof, st, s, target);
      st = c.next;
      return { yaw: c.yaw, pitch: c.pitch };
    };
  },
  maxTicks: () => BRAKE_MAX_TICKS,
};

/**
 * Simulate a brake profile from `body` (in state `st`, looking along `yaw`) until the feet touch the cell
 * (plan.ts touchdownCheck without the overshoot: the brake comes back to the cell), a solid in the box, the
 * body under the cell's top beside it (short: in K under the top, in A 2 under it, which no brake climbs
 * back from), or `maxTicks`.
 */
export function simulateBrake(body: FlightBody, yaw: number, target: LandingTarget, p: BrakeProfile, st: BrakeState = BRAKE_START, maxTicks = brakeMaxTicks(target), obstacle?: Obstacle): Touchdown {
  let bs = st;
  const touch = touchdownCheck(target, obstacle, false);
  const r = glideRollout<Touchdown>(
    body,
    yaw,
    0,
    maxTicks,
    (s) => {
      const c = brakeControl(p, bs, s, target);
      bs = c.next;
      return { yaw: c.yaw, pitch: c.pitch };
    },
    (k) => {
      const td = touch(k);
      if (td) return td;
      if (k.next.y < target.top - (bs.phase === 'K' ? 0.5 : 2)) return { kind: 'short', pos: k.next, vel: k.vel, ticks: k.t, off: hdist(k.next, target) };
      return undefined;
    },
  );
  return r.result ?? { kind: 'none', pos: r.pos, vel: r.vel, ticks: maxTicks, off: hdist(r.pos, target) };
}

/** The brake / elevator family of the profile search. */
export const BRAKE_FAMILY: ProfileFamily<BrakeProfile, BrakeState> = {
  style: 'brake',
  params: ['pitchE', 'pitchK', 'brakeAt', 'pitchA2', 'pitchA1', 'ticksA1'],
  ranges: BRAKE_RANGES,
  steps: BRAKE_STEPS,
  base: { pitchA1: 0, ticksA1: 0, pitchA2: 0, brakeAt: 6, pitchK: -30, pitchE: 0 },
  start: BRAKE_START,
  free(st) {
    const s = new Set<keyof BrakeProfile>(['pitchE', 'pitchK']);
    if (st.phase !== 'K') {
      s.add('brakeAt');
      s.add('pitchA2');
    }
    if (st.phase === 'A1') {
      s.add('pitchA1');
      s.add('ticksA1');
    }
    return s;
  },
  // in K two pitches are left (and the station keeping absorbs the rest): few samples
  samples: (st, good) => (st.phase === 'K' ? { wide: good ? 4 : 12, near: 6, rounds: 2 } : { wide: good ? 20 : 60, near: 24, rounds: 2 }),
  simulate: (body, yaw, target, p, st, obstacle) => simulateBrake(body, yaw, target, p, st, brakeMaxTicks(target), obstacle),
  control: (p, st, body, yaw, target) => brakeControl(p, st, { pos: body.pos, vel: body.vel, yaw }, target),
  phase: (st) => st.phase,
};

/** The brake family's planner (the brain passes the current look as the yaw: the family has its own yaw law). */
export class BrakePlanner extends ProfilePlanner<BrakeProfile, BrakeState> {
  constructor(seed = 54321, obstacle?: Obstacle) {
    super(BRAKE_FAMILY, seed, obstacle);
  }
}
