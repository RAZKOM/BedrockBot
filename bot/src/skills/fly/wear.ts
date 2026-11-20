// Track F20 (docs/flight.md "A flight never outlasts its elytra (Track F20)"; decisions/0107): the elytra's uses against a
// flight. An elytra loses a use for every second of gliding and at one use left the server ends the glide in the air and
// refuses every request for another (the Realm, 2026-11-18: the live bot fell 460 blocks to its death). Three rules keep a
// flight inside what its elytra has, all pure functions here:
//
//   - the takeoff asks (`tripCover`): the uses the trip needs (its seconds at the rate measured, with slack) against the
//     uses left over the worn limit; a trip the elytra does not cover is not flown;
//   - the way down is always covered (`wornLimitAt`): in flight the worn landing begins while the uses left still cover the
//     descent from the body's height over the ground, the landing and a margin, and no rocket is fired for height the
//     uses left would not cover the way down from;
//   - the worn descent from high up is a dive, not a circle (`WEAR.divePitch`): a circle at a glide's sink loses 3 to 4
//     blocks a use, the dive 56.
//
// The numbers (bds-fly, BDS 1.26.60.6, 2026-11-19, and the glide formula the server matches):
//   uses a second of gliding   1.03, 0.96, 1.02 (58 / 58 / 66 uses in 56.5 / 60.4 / 64.8 s); with Unbreaking III 0.26
//                              (16 in 62.8 s); the Realm's log of 2026-11-18: 0.90 to 1.17 over five flights
//   blocks of height a use     level glide 3.0; the cruise's circle (pitch 8) 3.2; the forced landing's circle (pitch 15)
//                              3.8; a circle at pitch 25 / 30 5.5 / 6.8; a dive at pitch 55 / 65 / 75 / 85 21.9 / 35.6 /
//                              55.6 / 74.8 (steady; a dive needs 41 / 58 / 84 / 107 ticks to reach nine tenths of it)
//   the pull out of the dive   pitch 75, the yaw turning 6 degrees a tick: a look 30 up ends the fall (under 0.3 a tick)
//                              in 17 ticks and 19.6 blocks, at 1.02 a tick level: slow enough for the landing at once
import { glideVelocity } from '../input/physics.ts';
import { elytraMax } from './kit.ts';
import { flightSeconds } from './plan.ts';

export const WEAR = Object.freeze({
  /** Gliding ticks a use (the server's rule: one a second). */
  useTicks: 20,
  /** The uses a second a trip is estimated with: the most seen (the Realm's 1.17), rounded up. */
  perSecond: 1.2,
  /** A trip's seconds are taken this much longer than `flightSeconds` says (the Realm's two long trips took 11 and 13 % longer: a hold over the goal, terrain pull-ups, a way down over a rim). */
  tripSlack: 1.15,
  /** ... and this many uses on top. */
  tripMargin: 4,
  /** Every trip is counted with one go-around (a rocket, out and back in: 110 to 130 ticks). */
  goAroundS: 6,
  /** A trip to a goal whose ground is not loaded at the takeoff is counted with a hold over it (the Realm's holds: 15, 25 and about 30 ticks until the landing was found; flyHoldS allows 30 s, and a hold that long is ended by the worn landing, not by a fall). */
  holdS: 8,
  /** A climb over this much is counted on top of `flightSeconds` (which was measured on climbs up to flyMaxClimb), at `climbRate` blocks a tick. */
  usualClimb: 120,
  climbRate: 1,
  /** The worn descent: the dive's look down, the yaw's turn a tick (a helix some 4 blocks wide: the body comes down where it is), the pull's look up. */
  divePitch: 75,
  turn: 6,
  pullPitch: -30,
  /** The pull begins this far over the highest column within `reach` blocks of the body (the pull's 20 blocks at the dive's full speed, and room for the landing's approach). */
  pullOver: 44,
  reach: 32,
  /** The pull is over once the fall is slower than this (blocks a tick); it takes this many ticks at the most. */
  pullEnd: -0.3,
  pullTicks: 24,
  /** A body less than this over the ground comes down by the forced landing as before (no dive). */
  diveFrom: 64,
  /**
   * The ticks of the landing after the pull (the circle from 22 to 33 over the ground and the approach onto the nearest
   * safe ground: measured offline 158 to 203 from the trigger less the dive), and a forced landing without a dive: its
   * circle's sink a tick and the ticks on top (measured offline from 10 to 100 over flat ground: 44, 106, 174, 225, 285,
   * 353, 485, 541 ticks, which is the height over 0.19 and 0 to 22 more).
   */
  landTicks: 180,
  circleSink: 0.19,
  circleTicks: 60,
  /** The uses kept over what the way down needs: a rocket's climb fired just before (48 blocks and its burn), the count a use behind, the pull begun a few ticks late. */
  margin: 5,
  /** The uses the fixed worn limit has always kept for the landing itself (kit.ts ELYTRA_RESERVE): what the way down needs beyond them is added to the limit. */
  reserve: 20,
});

/** The ticks a dive at WEAR.divePitch (the yaw turning) takes to lose `drop` blocks from the velocity `vel`, on the glide formula. */
export function diveTicks(drop: number, vel: { x: number; y: number; z: number } = { x: 0, y: -0.15, z: 1.5 }): number {
  if (!(drop > 0)) return 0;
  let v = { ...vel };
  let yaw = (Math.atan2(-v.x, v.z) * 180) / Math.PI;
  let lost = 0;
  let t = 0;
  // (the first 150 ticks on the formula: the dive is still gathering its fall; the rest at the steady fall it has by then)
  for (; t < 150 && lost < drop; t++) {
    yaw += WEAR.turn;
    v = glideVelocity(v, yaw, WEAR.divePitch, false);
    lost -= v.y;
  }
  if (lost < drop) t += Math.ceil((drop - lost) / Math.max(0.5, -v.y));
  return t;
}

/**
 * The uses the way down from `over` blocks over the lowest ground round the body takes, at the trip's rate
 * (WEAR.perSecond). `relief`: how far the highest ground round the body stands over the lowest. The dive is pulled out
 * over the highest, so a body WEAR.diveFrom or more over that dives to the pull's height, pulls and lands, and the
 * landing may still have the relief to come down by its circle; a body lower than that comes down by the forced
 * landing's circle and approach all the way.
 */
export function descentUses(over: number, vel?: { x: number; y: number; z: number }, relief = 0): number {
  const h = Math.max(0, over);
  const r = Math.max(0, Math.min(relief, h));
  const ticks = h - r > WEAR.diveFrom ? diveTicks(h - r - WEAR.pullOver, vel) + WEAR.pullTicks + WEAR.landTicks + r / WEAR.circleSink : h / WEAR.circleSink + WEAR.circleTicks;
  return Math.ceil((ticks / WEAR.useTicks) * WEAR.perSecond);
}

/**
 * The uses left at or under which the worn landing begins, for a body `over` blocks over the ground (the height it will
 * have reached: a burning rocket's rise counted): the fixed limit (`base`: kit.ts elytraWornLimit, 30, or the mending
 * reserve) and whatever the way down needs beyond the WEAR.reserve uses that limit has always kept for the landing, with
 * the margin.
 */
export function wornLimitAt(base: number, over: number, vel?: { x: number; y: number; z: number }, relief = 0): number {
  return base + Math.max(0, descentUses(over, vel, relief) + WEAR.margin - WEAR.reserve);
}

export interface TripCover {
  ok: boolean;
  /** The uses the trip needs (about), the uses the elytra has and the limit it must keep. */
  need: number;
  left: number;
  limit: number;
  /** No elytra flies this trip: it needs more than a new one has over the limit. */
  never: boolean;
  /** The blocks a new elytra flies (for the line of a trip none covers). */
  reach: number;
}

export interface TripShape {
  /** The climb over the start (blocks): what is over WEAR.usualClimb is counted on top. */
  climb?: number;
  /** The goal's ground is not loaded at the takeoff: the flight will hold over it until a landing is found. */
  hold?: boolean;
}

/**
 * The uses a flight of `distance` blocks needs (about): its seconds (plan.ts flightSeconds: the takeoff, the cruise at the
 * speed it flies and the landing) with the slack, a go-around, a hold where the goal's ground is not loaded yet and a
 * climb's part over the usual, at WEAR.perSecond, and the margin. The call an upkeep rule asks before a trip.
 */
export function tripUses(distance: number, shape: TripShape = {}): number {
  const seconds = flightSeconds(Math.max(0, distance)) * WEAR.tripSlack + WEAR.goAroundS + (shape.hold ? WEAR.holdS : 0) + Math.max(0, (shape.climb ?? 0) - WEAR.usualClimb) / WEAR.climbRate / 20;
  return Math.ceil(seconds * WEAR.perSecond) + WEAR.tripMargin;
}

/** The longest flight (blocks) an elytra with `uses` to spend covers (tripUses read backwards, a held goal). */
export function tripReach(uses: number): number {
  const seconds = ((uses - WEAR.tripMargin) / WEAR.perSecond - WEAR.goAroundS - WEAR.holdS) / WEAR.tripSlack;
  return Math.max(0, Math.floor((seconds - 8) * 1.35 * 20));
}

/**
 * The takeoff's question: does the elytra cover the trip? `left`: the uses on the elytra (undefined: unknown, the trip
 * is flown as before); `limit`: the worn limit it must keep (kit.ts elytraWornLimit); `distance`, `shape`: the flight.
 */
export function tripCover(left: number | undefined, limit: number, distance: number, shape: TripShape = {}): TripCover {
  const need = tripUses(distance, shape);
  const reach = tripReach(elytraMax() - limit);
  if (left === undefined) return { ok: true, need, left: elytraMax(), limit, never: false, reach };
  return { ok: left - limit >= need, need, left, limit, never: need > elytraMax() - limit, reach };
}

/**
 * `the elytra has 58 uses left (30 kept for the landing) and the trip of 2250 blocks needs about 125: not flying`; for a
 * trip no elytra covers: `... needs about 5300, more than a new elytra has (432; one flies about 8900 blocks): not flying`.
 */
export function tripCoverLine(c: TripCover, distance: number): string {
  const trip = `the trip of ${Math.round(distance)} blocks needs about ${c.need}`;
  return `the elytra has ${c.left} uses left (${c.limit} kept for the landing) and ${trip}${c.never ? `, more than a new elytra has (${elytraMax()}; one flies about ${c.reach} blocks)` : ''}: not flying`;
}

/** The line is one of `tripCoverLine`'s (a flight refused for the elytra's uses: the trip goes on on foot). */
export function isTripCoverLine(line: string | undefined): boolean {
  return line !== undefined && /the elytra has \d+ uses left .*: not flying/.test(line);
}

/**
 * Track F20: the bot's own count of the uses since the server last said. The server names the elytra's damage once a
 * use (world/inventory.ts handleArmorDamage); where that word does not come (a packet lost, a server that sends the slot
 * only now and then: before this track the count in flight was up to 53 uses behind), a use is counted for every
 * WEAR.useTicks gliding ticks since the count last changed. With Unbreaking the server's count changes every few seconds
 * and the own count is at most that gap behind it, on the safe side.
 */
export class UsesCount {
  private seen: number | undefined;
  private ticks = 0;

  /** The uses left this tick: `said` (the inventory model's count) less the gliding seconds since it last changed. */
  step(said: number | undefined, gliding: boolean): number | undefined {
    if (said === undefined) {
      this.seen = undefined;
      this.ticks = 0;
      return undefined;
    }
    if (said !== this.seen) {
      this.seen = said;
      this.ticks = 0;
    } else if (gliding) this.ticks++;
    return said - Math.floor(this.ticks / WEAR.useTicks);
  }
}

/** The climb a rocket fired now may still add before the worn landing is looked at again (a crafted rocket's whole gain at the climb pitch, burn.ts: 48) and the uses its burn takes. */
export const ROCKET_RISE = 48;
export const ROCKET_USES = Math.ceil(31 / WEAR.useTicks);
