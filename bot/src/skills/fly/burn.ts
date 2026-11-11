// Track F9e round 2 (docs/flight.md "What the Realm showed (Track F9e, round 2)"; decisions/0082 addendum): how long a
// rocket burns depends on the rocket. Every burn this project had measured (Track F0: 9 to 21 ticks, n 175) was of a
// rocket the script API gives, which carries no flight duration at all. A rocket a player crafts (paper and one
// gunpowder: flight duration 1) burns ten ticks longer: 21 to 30 measured on BDS (n 55, `FLY_ENV=burn FLY_ROCKETS=crafted`),
// taken as 19 to 31, the plain rocket's range a step on. The owner's own recorded takeoffs hold a rocket's speed for 22
// to 33 ticks, and on the Realm the bot's body flew on its rocket for up to ten ticks after the model's had ended: in a
// passage that bends the two were 1 to 6 blocks apart, the follower steered the one that was not there, and five flights
// met a wall. So the burn a line is proven and flown with is the burn of the rockets at hand.
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

/** The blocks a body flies under a burn of `ticks` (a rocket's speed, 1.67 a tick). */
export const burnBlocks = (ticks: number): number => ticks * 1.67;

/** A range said in a line: `9 to 21` or `19 to 31 (flight duration 1)`. */
export function burnSaid(b: BurnRange): string {
  const f = Math.round((b.nominal - BURN.nominal) / BURN_PER_FLIGHT);
  return `${b.min} to ${b.max}${b.min === BURN.min && b.max === BURN.max ? '' : b.max - b.min === BURN.max - BURN.min ? ` (flight duration ${f})` : ' (rockets of more than one kind)'}`;
}
