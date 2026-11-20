// Track E10 (docs/early-game.md "A step lost to flights", ADR 0112): what took a job's step its time when the flight on foot
// kept taking the body. Measured on a fresh snowy world (Track E5): under spruce, skeletons in the shade paused a `!gather`
// step flight after flight until its 10 minutes ran out, and the job ended with no reply naming the cause. The job counts
// the flights while a step runs (the flee process holding the body, the hostile kinds near then) and:
//   - every step's record says them: `!gather 4: 0 of 4 logs in 182 s: 6 flights took 141 s (skeleton)`;
//   - a step that is mostly flight ends early (FLIGHT_STEP_MIN_MS run, FLIGHT_SHARE of it fleeing, FLIGHT_MIN flights,
//     fewer items than one every FLIGHT_GAIN_MS) and the job stops with that line instead of running out the step's limit; when
//     the bot flees is not changed. Measured on the flat test server (a skeleton held still by the trees, no blade): 37
//     flights in 180 s, 105 s of them fleeing (58 %), 0 logs: the flights are short and the walk back to the tree is lost
//     between them, so the share alone is not the measure. Nothing gained for 120 s was not either: one run took 2 logs in
//     180 s (33 flights, 97 s fleeing) and went on; a gather that works gets a log every few seconds.

import { classify, entityFeet } from '../skills/combat/hostiles.ts';
import type { EntityInfo, Vec3 } from '../world/types.ts';

/** A step is judged mostly flight only after this long (ms): one flight and its recovery take up to about 60 s. */
export const FLIGHT_STEP_MIN_MS = 120_000;
/** ... with at least this share of its time spent fleeing (the walks back between flights are lost too) ... */
export const FLIGHT_SHARE = 0.4;
/** ... over at least this many flights (one long flight is a flight, not a step lost to them) ... */
export const FLIGHT_MIN = 3;
/** ... and fewer items gained than one every this many ms (a step that still gets its items goes on, flights or not). */
export const FLIGHT_GAIN_MS = 30_000;

/** The hostile kinds named for a flight are those within this many blocks of the bot while it flees. */
export const FLIGHT_MOBS_NEAR = 24;

/** What holds the body instead of the step (the flee process) and the hostile kinds near it then. */
export interface Preempt {
  by: string;
  mobs: readonly string[];
}

export class StepFlights {
  n = 0;
  private done = 0;
  private since: number | undefined;
  readonly mobs = new Set<string>();

  /** One poll: `p` is what holds the body now (undefined: nothing, or the step itself). */
  observe(p: Preempt | undefined, now: number): void {
    const fleeing = p?.by === 'flee';
    if (fleeing) for (const m of p.mobs) this.mobs.add(m.replace(/^minecraft:/, ''));
    if (fleeing && this.since === undefined) {
      this.n++;
      this.since = now;
    } else if (!fleeing && this.since !== undefined) {
      this.done += now - this.since;
      this.since = undefined;
    }
  }

  /** Time spent fleeing so far (ms). */
  ms(now: number): number {
    return this.done + (this.since !== undefined ? now - this.since : 0);
  }

  /** The step has run `elapsed` ms, gained `gained` items and was mostly flight. */
  mostly(elapsed: number, now: number, gained = 0): boolean {
    return elapsed >= FLIGHT_STEP_MIN_MS && gained * FLIGHT_GAIN_MS < elapsed && this.n >= FLIGHT_MIN && this.ms(now) >= FLIGHT_SHARE * elapsed;
  }

  /** `6 flights took 141 s (skeleton)`, or undefined with none. */
  text(now: number): string | undefined {
    if (this.n === 0) return undefined;
    const kinds = [...this.mobs].sort();
    return `${this.n} flight${this.n === 1 ? '' : 's'} took ${Math.round(this.ms(now) / 1000)} s${kinds.length ? ` (${kinds.join(', ')})` : ''}`;
  }
}

/** `!gather 4: 0 of 4 logs in 182 s: 6 flights took 141 s (skeleton)` */
export function flightLine(command: string, progress: string, seconds: number, flights: string): string {
  return `!${command}: ${progress} in ${Math.round(seconds)} s: ${flights}`;
}

/** The bot's side of `preempt` (wired in commands-kit.ts): the flee process holding the body and the hostile kinds near. */
export interface PreemptSource {
  active(): { name: string } | undefined;
  position(): Vec3 | undefined;
  entities(): Iterable<EntityInfo>;
  /** A mob the fight has seen die (its entity can linger a moment). */
  dead(runtimeId: EntityInfo['runtimeId']): boolean;
}

export function preemptPort(src: PreemptSource): () => Preempt | undefined {
  return () => {
    const a = src.active();
    if (a?.name !== 'flee') return undefined;
    const at = src.position();
    const mobs = new Set<string>();
    if (at) {
      for (const e of src.entities()) {
        if (classify(e.type) !== 'hostile' || src.dead(e.runtimeId)) continue;
        const p = entityFeet(e);
        if (Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z) <= FLIGHT_MOBS_NEAR) mobs.add(e.type);
      }
    }
    return { by: a.name, mobs: [...mobs] };
  };
}