// Track F9e round 2 (docs/flight.md "What the Realm showed (Track F9e, round 2)"; decisions/0082 addendum): how long a
// rocket burns depends on the rocket. Every burn this project had measured (Track F0: 9 to 21 ticks, n 175) was of a
// rocket the script API gives, which carries no flight duration at all. A rocket a player crafts (paper and one
// gunpowder: flight duration 1) burns ten ticks longer: 21 to 30 measured on BDS (n 55, `FLY_ENV=burn FLY_ROCKETS=crafted`),
// taken as 19 to 31, the plain rocket's range a step on. The owner's own recorded takeoffs hold a rocket's speed for 22
// to 33 ticks, and on the Realm the bot's body flew on its rocket for up to ten ticks after the model's had ended: in a
// passage that bends the two were 1 to 6 blocks apart, the follower steered the one that was not there, and five flights
// met a wall. So the burn a line is proven and flown with is the burn of the rockets at hand.
import { glideVelocity } from '../input/physics.ts';
import { BURN } from './route/types.ts';

/** The ticks a rocket burns: the shortest, the longest, and the one the nominal flight is flown with. */
export interface BurnRange {
  min: number;
  max: number;
  nominal: number;
}

/** A step of flight duration is this many ticks of burn. */
export const BURN_PER_FLIGHT = 10;
/** The highest flight duration a rocket can have. */
export const FLIGHT_MAX = 3;

/** For the e2e only (fly-cave.test.ts FLY_CAVE_PLAIN_BURN=1): `kit` false takes every rocket for the plain one, as the bot did before this round, to measure what the kit's burn changed. Nothing in the bot writes it. */
export const BURN_SWITCH = { kit: true };

/** The burn of a rocket of that flight duration (none or 0: the rocket the script API gives, route/types.ts BURN). */
export function burnRange(flight = 0): BurnRange {
  const add = BURN_SWITCH.kit ? BURN_PER_FLIGHT * Math.max(0, Math.min(FLIGHT_MAX, Math.floor(flight))) : 0;
  return { min: BURN.min + add, max: BURN.max + add, nominal: BURN.nominal + add };
}

/** The plain rocket's burn (9 to 21 ticks). */
export const BURN_PLAIN: BurnRange = Object.freeze(burnRange(0));

/**
 * The burn of the rockets in a hotbar (the first nine slots): from the shortest burn of any of them to the longest (a
 * flight takes them from whichever slot has some); the nominal is that of the rockets there are most of. No rocket: the
 * plain one's.
 */
export function burnOfHotbar(slots: readonly ({ name: string; count: number; flight?: number } | null | undefined)[], isRocket: (name: string) => boolean): BurnRange {
  let out: BurnRange | undefined;
  let most = 0;
  for (let i = 0; i < Math.min(9, slots.length); i++) {
    const s = slots[i];
    if (!s || s.count <= 0 || !isRocket(s.name)) continue;
    const b = burnRange(s.flight);
    if (!out) out = { ...b };
    else {
      out.min = Math.min(out.min, b.min);
      out.max = Math.max(out.max, b.max);
    }
    if (s.count > most) {
      most = s.count;
      out.nominal = b.nominal;
    }
  }
  return out ?? { ...BURN_PLAIN };
}

/** The burn of the rockets in a hotbar where it is not the plain rocket's (undefined: plain rockets, or none): what a line under a roof is made, proven and flown with. */
export function kitBurnOf(slots: readonly ({ name: string; count: number; flight?: number } | null | undefined)[], isRocket: (name: string) => boolean): BurnRange | undefined {
  const b = burnOfHotbar(slots, isRocket);
  return b.min === BURN_PLAIN.min && b.max === BURN_PLAIN.max ? undefined : b;
}

/**
 * Track F10 (docs/flight.md "The open-air flight on the burn of the rockets at hand"; decisions/0083): the burn the
 * flight in the open plans with: the kit's with `flyKitBurn` on (`on`), else undefined, and with plain rockets undefined
 * either way: then the climb, the cruise, the route planner's plans and every takeoff's proof think in 9 to 21 as before.
 */
export function openBurnOf(on: boolean, slots: readonly ({ name: string; count: number; flight?: number } | null | undefined)[], isRocket: (name: string) => boolean): BurnRange | undefined {
  return on ? kitBurnOf(slots, isRocket) : undefined;
}

/** Every burn of a range a proof flies after the nominal one: the two ends first, then a quarter in from each, then the rest. */
export function proofBurns(b: BurnRange): number[] {
  const q = Math.max(1, Math.round((b.max - b.min) / 4));
  const first = [b.min, b.max, b.min + q, b.max - q];
  const out = [...new Set(first)];
  for (let n = b.min; n <= b.max; n++) if (!out.includes(n) && n !== b.nominal) out.push(n);
  return out.filter((n) => n !== b.nominal);
}

/** The two mixes a proof flies (a long first rocket and short ones after it, and the other way round). */
export function proofMixes(b: BurnRange): [first: number, rest: number][] {
  return [
    [b.max, b.min],
    [b.min, b.max],
  ];
}

/** The burns of the rocket after a first one that fired nothing. */
export function proofDuds(b: BurnRange): number[] {
  return [b.nominal, b.min, b.max];
}

/**
 * Track F10 (docs/flight.md "The open-air flight on the burn of the rockets at hand"): the height a rocket fired from a
 * level glide buys when it is flown at `pitch` (negative: looking up) for the `ticks` it burns, the rise that goes on
 * after it on a level look included. Flown on the glide formula: at 15 ticks it gives the table the cruise has flown
 * with since Track AU2 (plan.ts rocketPitchFor: 6 at -10, 14 at -20, 24 at -30, 31 at -38), at 25 ticks 9, 20, 33 and
 * 42, at 19 ticks 7, 17, 27 and 35, at 31 ticks 11, 24, 38 and 48.
 */
export function rocketGain(pitch: number, ticks: number): number {
  const key = pitch * 1000 + ticks;
  const known = GAINS.get(key);
  if (known !== undefined) return known;
  let vel = { x: 0, y: -0.15, z: 1.5 };
  let y = 0;
  let top = 0;
  for (let t = 0; t < ticks + 80; t++) {
    vel = glideVelocity(vel, 0, t < ticks ? pitch : 0, t < ticks);
    y += vel.y;
    if (y > top) top = y;
    if (t >= ticks && vel.y <= 0) break;
  }
  GAINS.set(key, top);
  return top;
}
const GAINS = new Map<number, number>();

/** Track F10: the pitches a top-up is flown at, the shallowest first (plan.ts rocketPitchFor's four). */
export const GAIN_PITCHES: readonly number[] = Object.freeze([-10, -20, -30, -38]);

/**
 * Track F10: the pitch of a rocket that burns `ticks` and should buy about `gain` blocks from a level glide: between the
 * pitches of GAIN_PITCHES in proportion, to a whole degree, never steeper than the last (the climb pitch). plan.ts
 * rocketPitchFor is this for 15 ticks, rounded to 5 degrees.
 */
export function gainPitch(gain: number, ticks: number): number {
  const first = GAIN_PITCHES[0]!;
  if (gain <= rocketGain(first, ticks)) return first;
  for (let i = 1; i < GAIN_PITCHES.length; i++) {
    const p0 = GAIN_PITCHES[i - 1]!;
    const p1 = GAIN_PITCHES[i]!;
    const g0 = rocketGain(p0, ticks);
    const g1 = rocketGain(p1, ticks);
    if (gain <= g1) return Math.round(p0 + ((gain - g0) / (g1 - g0)) * (p1 - p0));
  }
  return GAIN_PITCHES[GAIN_PITCHES.length - 1]!;
}

/** Track F10: the most a rocket of that range buys from a level glide when it burns its nominal ticks: at the climb pitch (plan.ts ROCKET_CRUISE_CLIMB, 31, for the plain rocket; 42 for a crafted one). */
export function wholeGain(b: BurnRange): number {
  return Math.round(rocketGain(GAIN_PITCHES[GAIN_PITCHES.length - 1]!, b.nominal));
}

/** Track F10: the burns a searched route takeoff is proven at after the nominal one: the two ends and three ticks in from each (glide.ts PROOF_BURNS for the plain rocket: 9, 21, 12, 18). */
export function searchProofBurns(b: BurnRange): number[] {
  return [b.min, b.max, b.min + 3, b.max - 3];
}

/** The blocks a body flies under a burn of `ticks` (a rocket's speed, 1.67 a tick). */
export const burnBlocks = (ticks: number): number => ticks * 1.67;

/** A range said in a line: `9 to 21` or `19 to 31 (flight duration 1)`. */
export function burnSaid(b: BurnRange): string {
  const f = Math.round((b.nominal - BURN.nominal) / BURN_PER_FLIGHT);
  return `${b.min} to ${b.max}${b.min === BURN.min && b.max === BURN.max ? '' : b.max - b.min === BURN.max - BURN.min ? ` (flight duration ${f})` : ' (rockets of more than one kind)'}`;
}
