// Track F22 (docs/flight.md "The hop asked from a walk (Track F22)"; decisions/0082 addendum 2): a flight under a roof is
// DECIDED STANDING. Its line is proven from where the body stood when the decision began, the decision takes seconds,
// and on the Realm the body was walked on meanwhile (by a chore before the trip had a process of its own, by a fight, by
// a walk taken up again after a piece of the way): 3, 8 and 21 blocks from its proof when the answer came, which was
// thrown away each time.
//
// The rule, in one place for the bot (chat/commands-fly.ts autoFly) and the tests:
//
//   1 the body is HELD first (tasks/process/stand.ts: a process of the trip's own rank that stands), and is at rest
//     (on the ground, not moving) before the decision is asked for;
//   2 the decision is asked from where it stands then;
//   3 an answer whose line begins more than `tolerance` blocks from the body when it comes (a fight or a flight on foot
//     had the body meanwhile: the hold does not stand in the way of those) is not flown, and the decision is asked ONCE
//     more, standing again;
//   4 an answer that is stale a second time is given up with a line that says what the trip does instead (it walks, and
//     the walk asks again as it gets on). Nothing is thrown away twice in a row without that line.
import type { Vec3 } from '../../../connection/types.ts';

/** The hold the body is taken with (tasks/process/stand.ts StandProcess, or a test's). */
export interface StandHold {
  /** The hold has the body now (no other process moves it). */
  readonly held: boolean;
  /** Times another process took the body from the hold. */
  readonly lost: number;
  /** The hold was taken away for good (the owner's stop, a death): nothing is waited for. */
  readonly over: boolean;
  end(): void;
}

export interface StandingDeps {
  hold(): StandHold;
  position(): Vec3 | undefined;
  /** The body is at rest: on the ground, not moving. */
  still(): boolean;
  waitTicks(n: number): Promise<void>;
  log(line: string): void;
  /** What has the body when the hold does not (a process's name), for the lines. */
  holder?(): string | undefined;
}

/** The body is waited for this many ticks to be held and at rest before a decision (a fight that has it ends first), and so many to come to rest once held. */
export const STAND_WAIT_TICKS = 200;
export const STAND_REST_TICKS = 20;
/** The decisions asked for one answer at most: the first, and one more when its answer came stale. */
export const STAND_ASKS = 2;

export interface StandingAnswer<T> {
  /** The decision's answer, to be carried out from where the body stands (undefined: none, or given up). */
  answer?: T;
  /** The decisions asked (0: the body was never held at rest). */
  asks: number;
  /** Answers not used because the body was no longer where they were proven from. */
  stale: number;
  /** Why there is no answer when the decision itself had one: for the caller's own line. */
  gaveUp?: string;
}

/**
 * Ask `decide` with the body held and at rest (see the file comment). `startOf` gives the place an answer was proven from
 * (undefined: an answer that holds from anywhere near, a walk, a site); `tolerance`: how far from it the body may be when
 * the answer comes. `what`: the decision's name for the lines (`the flight to cave_end`).
 */
export async function decideStanding<T>(d: StandingDeps, what: string, tolerance: number, decide: (from: Vec3) => Promise<T | undefined>, startOf: (answer: T) => Vec3 | undefined): Promise<StandingAnswer<T>> {
  const h = d.hold();
  let asks = 0;
  let stale = 0;
  try {
    for (;;) {
      // held and at rest: a process over the hold (a fight) ends first; the walk the hold paused comes to a stop
      let waited = 0;
      let rest = 0;
      while (waited < STAND_WAIT_TICKS && !h.over && !(h.held && d.still())) {
        await d.waitTicks(1);
        waited++;
        if (h.held && ++rest > STAND_REST_TICKS) break;
      }
      const from = d.position();
      if (!h.held || !from) {
        const by = d.holder?.();
        const gaveUp = h.over ? 'the stand was stopped' : `${by ? `${by} has the body` : 'the body is not held'} after ${waited} ticks`;
        d.log(`fly: ${what} is not decided: ${gaveUp}${stale ? ` (${stale} answer${stale === 1 ? '' : 's'} came stale before)` : ''}; the trip walks, and the walk asks again as it gets on`);
        return { asks, stale, gaveUp };
      }
      const lost0 = h.lost;
      asks++;
      const answer = await decide({ ...from });
      if (answer === undefined) return { asks, stale };
      const p0 = startOf(answer);
      const here = d.position();
      const moved = p0 && here ? Math.hypot(here.x - p0.x, here.y - p0.y, here.z - p0.z) : 0;
      if (moved <= tolerance) return { answer, asks, stale };
      stale++;
      const by = h.lost > lost0 ? (d.holder?.() ?? 'another process') : undefined;
      const why = by ? `${by} had the body while the decision ran` : 'it was moved while the decision ran';
      if (asks >= STAND_ASKS) {
        const gaveUp = `the body is ${moved.toFixed(1)} blocks from where the answer was proven (${why}), the second time in a row`;
        d.log(`fly: ${what}: ${gaveUp}: not asked a third time; the trip walks, and the walk asks again as it gets on`);
        return { asks, stale, gaveUp };
      }
      d.log(`fly: ${what}: the body is ${moved.toFixed(1)} blocks from where the answer was proven (${why}): not flown from here; asked once more, standing`);
    }
  } finally {
    h.end();
  }
}
