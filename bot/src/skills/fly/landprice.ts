// Landing by time (flight v2, Track L1; docs/flight.md "Landing by time (Track L1)", decisions/0076-land-by-time.md).
// The owner, 2026-11-09: "It should try to land as close as it can but it shouldn't waste a whole 10 s of go-around to
// save 2 s of walking." Every landing decision is priced in seconds:
//
//   a landing         the walk from its cell to the goal (the probe's path where it is known, else the distance
//                     estimate times UNKNOWN_DETOUR plus UNKNOWN_RISK_S) plus, for a landing switched to in the air,
//                     the height it still has to lose (SINK_S_PER_BLOCK)
//   a go-around       GOAROUND_S and GOAROUND_ROCKETS x ROCKET_S, and with the chance P that the next approach lands
//                     (goAroundChance: the failure's kind, and whether the go-around before failed the same way) the
//                     walk from the target; with 1 - P the same landing as now afterwards
//
// So a go-around is flown only when P x (the best landing now - the target's walk) > its own cost: the chance of
// landing closer, times the walk it would save, must pay for the circuit. Safety is never priced: only sound, dry,
// hazard-free cells whose approach the planner's simulation lands softly are offered (landing.ts, brain.ts).
//
// The constants come from the live bot's log (the Realm, 2026-10-30 to 2026-11-09: 131 flights, 36 with a go-around)
// and from the replica of the owner's cave (bds-fly2); each says where.

/**
 * Seconds a go-around costs: the median time between two go-around decisions on the Realm (91 pairs, 2026-10-30 to
 * 2026-11-09; mean 6.9, 2.8 to 13.5), and from the last go-around to the forced landing (31 flights, median 6.0).
 */
export const GOAROUND_S = 6.2;
/** Rockets a go-around fires (the go-around phase's rockets over the go-arounds of the same flights: 152 / 135). */
export const GOAROUND_ROCKETS = 1.13;
/** Seconds a rocket is worth (a judgement: the owner's rockets are plenty, the time is what he asked about). */
export const ROCKET_S = 1;
/** The whole price of one go-around in seconds. */
export const GOAROUND_COST_S = GOAROUND_S + GOAROUND_ROCKETS * ROCKET_S;

/**
 * Seconds a block of a confirmed walk takes (the probe's path blocks, reach.ts pathBlocks): measured on the replica of the
 * owner's cave, the walks after the landings of trip C (docs/flight.md "Landing by time"); the steady sprint is 0.178.
 */
export const WALK_S_PER_BLOCK = 0.3;
/** An unconfirmed walk (a probe that ran out, nothing probed) is estimated as its ranking estimate times this ... */
export const UNKNOWN_DETOUR = 1.5;
/** ... plus this many seconds for the risk that it does not walk at all (the Realm's hill-top landings over the cave). */
export const UNKNOWN_RISK_S = 15;
/**
 * Seconds a block of height costs a landing switched to in the air (the descent circle sinks 0.15 to 0.2 a tick:
 * docs/flight.md "Descent geometry"): beyond SPIRAL_ABOVE over the approach entry the height is lost circling.
 */
export const SINK_S_PER_BLOCK = 1 / (0.17 * 20);

/** The kind of failure that sends a flight round: the best plan's touchdown (or a hard one ahead). */
export type MissKind = 'landed' | 'short' | 'over' | 'wall' | 'none' | 'route';

/**
 * The chance that the approach after a go-around lands. From the Realm's log (2026-10-30 to 2026-11-09): first go-arounds
 * whose best plan was `wall` landed after 3 of 16, `none` after 0 of 19 (5 % as a floor), `over` 1 of 1; a go-around after
 * one that failed the same way landed after 1 of 91, after one that failed another way 0 of 19. An energy miss (`over`,
 * `short`, a hard touchdown) is what a go-around fixes (it comes back at the approach height and speed): 0.8, the e2e's
 * go-arounds on bds-fly2 (fly-maneuver, fly-route-land: each landed on the next approach).
 */
export const GOAROUND_P: Readonly<Record<MissKind, number>> = Object.freeze({ landed: 0.8, short: 0.8, over: 0.8, wall: 0.19, none: 0.05, route: 0.19 });
/** After a go-around that failed the same way (1 of 91 landed) ... */
export const GOAROUND_P_REPEAT = 0.02;
/** ... after one that failed another way: half the first chance (0 of 19 landed). */
export const GOAROUND_P_OTHER = 0.5;

/** The chance the next approach lands after a go-around for a miss of `kind`, the go-around before (if any) having failed as `previous`. */
export function goAroundChance(kind: MissKind, previous?: MissKind): number {
  if (previous === undefined) return GOAROUND_P[kind];
  return previous === kind ? GOAROUND_P_REPEAT : GOAROUND_P[kind] * GOAROUND_P_OTHER;
}

/** A walk to the goal as the price sees it: blocks, and whether a probe confirmed them. */
export interface WalkEstimate {
  blocks: number;
  known: boolean;
}

/** Seconds of a walk: the confirmed path's blocks, or the estimate times UNKNOWN_DETOUR plus UNKNOWN_RISK_S. */
export function walkSeconds(w: WalkEstimate): number {
  if (w.blocks <= 0 && w.known) return 0;
  return w.known ? w.blocks * WALK_S_PER_BLOCK : w.blocks * UNKNOWN_DETOUR * WALK_S_PER_BLOCK + UNKNOWN_RISK_S;
}

/** A landing that can be taken now instead of a go-around: what it is (for the line) and its price in seconds. */
export interface LandingOffer {
  what: string;
  /** The walk from it to the goal (walkSeconds). */
  walkS: number;
  /** Seconds before its touchdown beyond what the approach would take anyway (the height to lose). */
  extraS: number;
}

export interface GoAroundQuestion {
  /** The failure of this approach. */
  kind: MissKind;
  /** How the go-around before this one (this flight, this target) failed. */
  previous?: MissKind;
  /** The walk from the target's cell to the goal (0: the goal itself). */
  targetWalkS: number;
  /** Landings now, any order (the decision takes the cheapest). */
  offers: readonly LandingOffer[];
  /** A go-around is possible at all (one left, a rocket at hand). */
  canGoAround: boolean;
}

export interface GoAroundAnswer {
  goAround: boolean;
  /** The landing taken instead (an index into `offers`), when not going round. */
  offer?: number;
  /** One line for the log: the prices on both sides. */
  line: string;
}

const s1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : 'inf');

/**
 * The decision at a missed approach: go round when the chance of landing on the target, times the walk that saves
 * against the cheapest landing now, is worth more than the go-around costs (GOAROUND_COST_S); else that landing.
 * With nothing to land on now a go-around is flown while one is left (the old rule).
 */
export function decideGoAround(q: GoAroundQuestion): GoAroundAnswer {
  const p = goAroundChance(q.kind, q.previous);
  let best = -1;
  let bestS = Infinity;
  q.offers.forEach((o, i) => {
    const s = o.walkS + o.extraS;
    if (s < bestS) {
      best = i;
      bestS = s;
    }
  });
  const saving = p * (bestS - q.targetWalkS);
  const ga = `a go-around (${s1(GOAROUND_COST_S)} s with ${GOAROUND_ROCKETS} rockets, P ${p.toFixed(2)} to land ${s1(q.targetWalkS)} s of walk from the goal)`;
  if (best < 0) return { goAround: q.canGoAround, line: `nothing to land on now; ${ga}: ${q.canGoAround ? 'going round' : 'none left'}` };
  const o = q.offers[best]!;
  const now = `land now on ${o.what} (${s1(o.walkS)} s of walk${o.extraS > 0.05 ? ` + ${s1(o.extraS)} s down` : ''})`;
  const goAround = q.canGoAround && saving > GOAROUND_COST_S;
  return { goAround, ...(goAround ? {} : { offer: best }), line: `${now} against ${ga}: saves ${s1(saving)} s ${goAround ? '>' : '<='} ${s1(GOAROUND_COST_S)} s: ${goAround ? 'going round' : q.canGoAround ? 'landing now' : 'landing now (no go-around left)'}` };
}

/**
 * Track L1, the hold over a goal whose ground is not all loaded: the best confirmed landing on the loaded part
 * (`partialWalkS`) is taken when no landing on the unloaded part could save more than waiting for the next look costs:
 * `boundWalkS` is the least walk any unloaded column could have (its straight distance from the goal, walked at
 * WALK_S_PER_BLOCK), `waitS` the time until the next look (LOOK_EVERY ticks).
 */
export function holdWorth(partialWalkS: number, boundWalkS: number, waitS: number): { wait: boolean; line: string } {
  const most = Math.max(0, partialWalkS - boundWalkS);
  const wait = most > waitS;
  return { wait, line: `the loaded part's landing walks ${s1(partialWalkS)} s; an unloaded column could save at most ${s1(most)} s against ${s1(waitS)} s of waiting: ${wait ? 'holding' : 'landing now'}` };
}
