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
import { APPROACH_DISTANCE, APPROACH_HEIGHT, CLIMB_RUN, DEFAULT_CLEARANCE, DEFAULT_MARGIN, flightSeconds, GLIDE_RATIO, glideMargin } from './plan.ts';
import { FLOOR_AHEAD } from './terrain.ts';

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
  /**
   * Track F21: the landing's spiral (r24) sinks this many blocks a tick (offline, 2026-11-20: 0.154 to 0.159 from 100 to
   * 400 over the goal; the Realm's r24 landing from 71 over the goal, 2026-11-18: 0.15; its r10 way down over a built-up
   * landing 0.21 to 0.23), and a trip comes down by it, not by the cruise's glide or dive, after a hold over its goal
   * (from the height it reached the goal at: `arrive`, arrivalOver) and when it is shorter than `spiralRatio` times its
   * cruise height over the goal (offline: trips of 100 to 450 blocks spiralled at 1.3 to 1.7 times their height and one at
   * 3; dove from 2; the Realm's trips of 144 and 168 blocks spiralled from 59 and 49 over the goal, about their cruise).
   */
  spiralSink: 0.15,
  spiralRatio: 3.5,
  /** Track F21 (the calibration): the circle ends this far over the goal (the approach entry, 10, and the spiral's exit, 6), where the landing flightSeconds counts begins. */
  spiralFrom: 16,
  /** ... and it replaces the cruise's last stretch from the hold's start (APPROACH_DISTANCE + 60 = 116 blocks out: 4.3 s at flightSeconds' 1.35 a tick), counted this many seconds. */
  spiralCredit: 4,
  /**
   * Track F21 (the calibration): the hold where the height the flight reaches its goal at is known (the trip's second
   * ask): the Realm's holds lasted 2, 13, 15, 18, 19 and 25 ticks (2026-11-18 to 20: the ground loads about 150 blocks
   * out, before the hold begins at 116), and a held trip looks for its landing every 40 ticks (LOOK_EVERY), a look taking
   * up to 1.2 s: 40 + 24 = 64 ticks, counted 70. `holdS` stays the first ask's (the cruise not known yet: the hold and its
   * way down together, as Track F20 counted them) and the least a held trip is asked.
   */
  holdKnown: 3.5,
  /**
   * Track F21 (the calibration): the height a flight reaches its goal at (arrivalOver): the climb's top this far over the
   * cruise (offline 2 to 10: the climb's momentum), and a body that follows the glide line this far over it (offline 37 to
   * 45 over the goal at the hold's start, for the glide line's 31: the economy's rocket buys a little over the line).
   */
  arriveOver: 10,
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

/**
 * Track F21: the share of the gliding seconds that cost an elytra a use, by its Unbreaking level (0 to 3). The server
 * takes a use on a second of gliding with the chance 1 / (level + 1), as for a tool; measured on bds-fly (BDS 1.26.60.6,
 * the chest slot's damage read every 0.3 s of flights of 1 500 blocks; docs/flight.md "Unbreaking at the takeoff"). The
 * shares here are the most a level was measured at (I 0.546, II 0.339, III 0.257 uses a second; 3, 3 and 4 flights),
 * rounded up to the hundredth, and never under 1 / (level + 1).
 */
export const UNBREAKING_SHARE: readonly number[] = Object.freeze([1, 0.55, 0.34, 0.26]);

/** The share of the gliding seconds that cost an elytra with Unbreaking `level` a use (UNBREAKING_SHARE; over III as III). */
export function useShare(level = 0): number {
  const l = Math.max(0, Math.min(UNBREAKING_SHARE.length - 1, Math.floor(level)));
  return UNBREAKING_SHARE[l]!;
}

/** `Unbreaking III` for a level (the line of a refused trip names it); '' for none. */
export function unbreakingSaid(level = 0): string {
  return level > 0 ? `Unbreaking ${['I', 'II', 'III', 'IV', 'V'][Math.min(4, Math.floor(level) - 1)]}` : '';
}

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
 * landing's circle and approach all the way. `share`: the elytra's share of the gliding seconds that cost a use (Track
 * F21: useShare of its Unbreaking level; 1 bare).
 */
export function descentUses(over: number, vel?: { x: number; y: number; z: number }, relief = 0, share = 1): number {
  const h = Math.max(0, over);
  const r = Math.max(0, Math.min(relief, h));
  const ticks = h - r > WEAR.diveFrom ? diveTicks(h - r - WEAR.pullOver, vel) + WEAR.pullTicks + WEAR.landTicks + r / WEAR.circleSink : h / WEAR.circleSink + WEAR.circleTicks;
  return Math.ceil((ticks / WEAR.useTicks) * WEAR.perSecond * share);
}

/**
 * The uses left at or under which the worn landing begins, for a body `over` blocks over the ground (the height it will
 * have reached: a burning rocket's rise counted): the fixed limit (`base`: kit.ts elytraWornLimit, 30, or the mending
 * reserve) and whatever the way down needs beyond the WEAR.reserve uses that limit has always kept for the landing, with
 * the margin. `share` as in descentUses (Track F21: an Unbreaking elytra's way down costs its share; the margin and the
 * reserve stay whole).
 */
export function wornLimitAt(base: number, over: number, vel?: { x: number; y: number; z: number }, relief = 0, share = 1): number {
  return base + Math.max(0, descentUses(over, vel, relief, share) + WEAR.margin - WEAR.reserve);
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
  /** Track F21: the elytra's Unbreaking level the need was counted with (0: bare). */
  unbreaking: number;
}

export interface TripShape {
  /** The climb over the start (blocks): what is over WEAR.usualClimb is counted on top. */
  climb?: number;
  /** The goal's ground is not loaded at the takeoff: the flight will hold over it until a landing is found. */
  hold?: boolean;
  /**
   * Track F21: the cruise's height over the ground (its feet y less the lower of the start's and the goal's), where it is
   * known (the flight's preparation, the walk's re-check, a new trip in the air): the flight's worn limit there (the way
   * down from it, as the brain counts it) is asked on top of the trip, and so is the spiral of a trip short for its
   * height. Absent: the trip alone, as the first ask before the cruise is known.
   */
  over?: number;
  /**
   * Track F21 (the calibration): the height over the goal the flight reaches it at (arrivalOver: the cruise's glide line,
   * the climb's top glided down, the terrain of the last 200 blocks before the goal): a held trip spirals down from
   * there. Absent with `over` given: the cruise's height (about the most it can be).
   */
  arrive?: number;
}

/** Track F21 (the calibration): the hold begins this far from the goal (brain.ts cruise: APPROACH_DISTANCE + 60). */
export const HOLD_AT = APPROACH_DISTANCE + 60;
/** Track F21 (the calibration): the terrain this far before the goal (terrain.ts FLOOR_AHEAD) holds the arriving body over it; the last FLOOR_STOP blocks are the landing's. */
export const ARRIVE_NEAR = FLOOR_AHEAD;
/** The glide line's height over the goal at the hold's start (plan.ts glideLine at HOLD_AT: 16), the spare (glideMargin) and the economy's top-up not included. */
const LINE_AT_HOLD = APPROACH_HEIGHT + (HOLD_AT - APPROACH_DISTANCE) / GLIDE_RATIO;
/** brain.ts KIT_USE_OVER (a guard test keeps them equal: wear.ts may not import the brain). */
export const ARRIVE_TOP_UP = 8;

/**
 * Track F21 (the calibration, docs/flight.md "Where a held flight is when its hold ends"): the height over the goal's top
 * (`goalTop`) a flight from `fromY` at the cruise `cruiseY` reaches its goal at, `distance` blocks on: what the brain
 * flies to. The cruise holds the body over the glide line to the goal (with its spare and the economy's top-up), the
 * climb's top glides down at GLIDE_RATIO once past the climb (CLIMB_RUN a block of height), and the terrain floor holds
 * the body over the highest column of the last ARRIVE_NEAR blocks before the goal (`nearTop`: its top; terrain.ts
 * terrainFloor: 1 + clearance over it and the glide from FLOOR_AHEAD out) up to the climb's top (the cruise is planned
 * over every column of the way: plan.ts cruiseHeight), and never under the glide line with its spare (the brain's
 * cruise top is never under it, whatever the cruise: a low cruise is flown over it). Unknown columns
 * there count as the caller's bound for them (the highest known plus UNKNOWN_SLACK). On the Realm (2026-11-18 to 20) the
 * held flights came in 27 to 119 over their goals from cruises 183 to 226 over them, held by the glide line and by a
 * hill 90 over home within 160 blocks of it.
 */
export function arrivalOver(o: { distance: number; fromY: number; cruiseY: number; goalTop: number; nearTop?: number | undefined; clearance?: number; margin?: number }): number {
  const top = o.cruiseY + WEAR.arriveOver;
  const run = Math.max(0, o.cruiseY - o.fromY) * CLIMB_RUN;
  const glide = top - Math.max(0, o.distance - run - HOLD_AT) / GLIDE_RATIO;
  const line = o.goalTop + LINE_AT_HOLD + glideMargin(o.margin ?? DEFAULT_MARGIN, o.distance) + ARRIVE_TOP_UP + WEAR.arriveOver;
  const terrain = o.nearTop !== undefined ? o.nearTop + 1 + (o.clearance ?? DEFAULT_CLEARANCE) + ARRIVE_NEAR / GLIDE_RATIO : -Infinity;
  return Math.max(0, Math.max(line, Math.min(top, Math.max(glide, terrain))) - o.goalTop);
}

/** Track F21: TripShape.over for a cruise at feet `cruiseY` from feet `fromY` to a goal whose top is `goalTop`. */
export function cruiseOver(cruiseY: number, fromY: number, goalTop: number): number {
  return Math.max(0, cruiseY - Math.min(fromY, goalTop));
}

/**
 * Track F21: the uses the flight keeps over its fixed worn limit at the cruise's height `over` the ground (wear.ts
 * wornLimitAt beyond `base`, with a rocket's rise and its burn: the brain's rule for a cruise rocket), at the elytra's
 * `share`. A trip the takeoff allows must not reach that limit before its landing.
 */
export function cruiseKeep(over: number | undefined, share = 1): number {
  if (!(over !== undefined && over > 0)) return 0;
  return wornLimitAt(0, over + ROCKET_RISE, undefined, 0, share) + Math.ceil(ROCKET_USES * share);
}

/**
 * The uses a flight of `distance` blocks needs (about): its seconds (plan.ts flightSeconds: the takeoff, the cruise at the
 * speed it flies and the landing) with the slack, a go-around, a hold where the goal's ground is not loaded yet and a
 * climb's part over the usual, at WEAR.perSecond, and the margin. The call an upkeep rule asks before a trip.
 * `unbreaking`: the elytra's Unbreaking level (Track F21): the seconds cost its share of a use each (useShare), the
 * slack, the rate's margin and the 4 on top kept as they are.
 */
export function tripUses(distance: number, shape: TripShape = {}, unbreaking = 0): number {
  const d = Math.max(0, distance);
  const fs = flightSeconds(d);
  const climbExtra = Math.max(0, (shape.climb ?? 0) - WEAR.usualClimb) / WEAR.climbRate / 20;
  let seconds = fs * WEAR.tripSlack + WEAR.goAroundS + (shape.hold ? WEAR.holdS : 0) + climbExtra;
  // Track F21: with the cruise known, the spiral where the flight comes down by one, and the flight's own worn limit at
  // the cruise. After a hold over the goal (the calibration, docs/flight.md "Where a held flight is when its hold ends"):
  // the hold as long as the records show and the circle from the height the flight reaches the goal at (`arrive`), over
  // the trip without its slack (the slack Track F20 measured was that way down) and never under Track F20's ask; a trip
  // short for its height: the climb and the spiral from the cruise, whichever is longer.
  const over = shape.over !== undefined && shape.over > 0 ? shape.over : 0;
  const arrive = shape.arrive !== undefined ? Math.max(0, shape.arrive) : over;
  const spiral = (h: number): number => Math.max(0, h - WEAR.spiralFrom) / WEAR.spiralSink / 20;
  if (shape.hold && arrive > 0) seconds = Math.max(seconds, fs + Math.max(0, spiral(arrive) - WEAR.spiralCredit) + WEAR.goAroundS + WEAR.holdKnown + climbExtra);
  else if (!shape.hold && over > 0 && d < WEAR.spiralRatio * over) seconds = Math.max(seconds, over / WEAR.climbRate / 20 + spiral(Math.max(arrive, over)) + WEAR.goAroundS);
  const share = useShare(unbreaking);
  return Math.ceil(seconds * WEAR.perSecond * share) + WEAR.tripMargin + cruiseKeep(over, share);
}

/** The longest flight (blocks) an elytra with `uses` to spend covers (tripUses read backwards, a held goal); `unbreaking` as there. */
export function tripReach(uses: number, unbreaking = 0): number {
  const seconds = ((uses - WEAR.tripMargin) / (WEAR.perSecond * useShare(unbreaking)) - WEAR.goAroundS - WEAR.holdS) / WEAR.tripSlack;
  return Math.max(0, Math.floor((seconds - 8) * 1.35 * 20));
}

/**
 * The takeoff's question: does the elytra cover the trip? `left`: the uses on the elytra (undefined: unknown, the trip
 * is flown as before); `limit`: the worn limit it must keep (kit.ts elytraWornLimit); `distance`, `shape`: the flight;
 * `unbreaking`: the elytra's Unbreaking level (Track F21; `never` and `reach` are then for a new elytra of that level).
 */
export function tripCover(left: number | undefined, limit: number, distance: number, shape: TripShape = {}, unbreaking = 0): TripCover {
  const need = tripUses(distance, shape, unbreaking);
  const reach = tripReach(elytraMax() - limit, unbreaking);
  if (left === undefined) return { ok: true, need, left: elytraMax(), limit, never: false, reach, unbreaking };
  return { ok: left - limit >= need, need, left, limit, never: need > elytraMax() - limit, reach, unbreaking };
}

/**
 * `the elytra has 58 uses left (30 kept for the landing) and the trip of 2250 blocks needs about 125: not flying`; for a
 * trip no elytra covers: `... needs about 5300, more than a new elytra has (432; one flies about 8900 blocks): not flying`.
 * An Unbreaking elytra is named so (`the elytra (Unbreaking III) has ...`, `more than a new one with Unbreaking III has`).
 */
export function tripCoverLine(c: TripCover, distance: number): string {
  const trip = `the trip of ${Math.round(distance)} blocks needs about ${c.need}`;
  const u = unbreakingSaid(c.unbreaking);
  const what = u ? `the elytra (${u})` : 'the elytra';
  const newOne = u ? `a new one with ${u}` : 'a new elytra';
  return `${what} has ${c.left} uses left (${c.limit} kept for the landing) and ${trip}${c.never ? `, more than ${newOne} has (${elytraMax()}; one flies about ${c.reach} blocks)` : ''}: not flying`;
}

/** The line is one of `tripCoverLine`'s (a flight refused for the elytra's uses: the trip goes on on foot). */
export function isTripCoverLine(line: string | undefined): boolean {
  return line !== undefined && /the elytra (\(Unbreaking [IV]+\) )?has \d+ uses left .*: not flying/.test(line);
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
  /**
   * Track F21: the elytra's share of the gliding seconds that cost a use (useShare): an Unbreaking elytra is counted a
   * use for every WEAR.useTicks / share gliding ticks, the most its level was measured to wear (bare: every 20). Before,
   * every elytra was counted at 20 and an Unbreaking III one ran up to four times ahead of the server's word.
   */
  private readonly share: number;
  constructor(share = 1) {
    this.share = share > 0 ? Math.min(1, share) : 1;
  }

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
    return said - Math.floor((this.ticks * this.share) / WEAR.useTicks);
  }
}

/** The climb a rocket fired now may still add before the worn landing is looked at again (a crafted rocket's whole gain at the climb pitch, burn.ts: 48) and the uses its burn takes. */
export const ROCKET_RISE = 48;
export const ROCKET_USES = Math.ceil(31 / WEAR.useTicks);
