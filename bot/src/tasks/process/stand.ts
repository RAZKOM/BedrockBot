// Track F22 (docs/flight.md "The hop asked from a walk (Track F22)"; decisions/0082 addendum 2): the body STANDS while a
// flight under a roof is decided. A line under a roof is proven from where the body stood when the decision began, and
// the decision takes seconds (the flood, up to three lines of 18 simulations): on the Realm another process walked the
// body on meanwhile (a chore's walk before the trip's own process existed, a walk taken up again after a piece of the
// way), the body was 3 to 21 blocks from its proof when the answer came, and the answer was thrown away.
//
// The stand is a user process like the walk and the flight it decides for: it pauses what walked the body (a chore, an
// older command), it is pre-empted by what a walk is pre-empted by (flee, the guard, the night shelter: survival comes
// first, and the decision then asks again: skills/fly/learn/standing.ts), and it ends when the decision has its answer.
// It cannot outlive its decision: after `maxMs` it stops wanting control and is dropped. For a trip the bot makes by
// itself (the home return) it runs as that trip does: automatic and low, so that it takes the body from no command and
// no chore, and drops no pending home return as a command would.
import { BaseProcess, PRIORITY, type ProcessKind, type ProcessStatus } from './manager.ts';

/** A stand that nobody ended is dropped after this long (ms): the longest decision is the wait for the live model and three proofs. */
export const STAND_MAX_MS = 45_000;

export interface StandOptions {
  /** What the body stands for, for `!status` (`deciding the flight to cave_end`). */
  label: string;
  /** The body's own controls at rest (the input loop's command: no walk, no jump). */
  still(): void;
  now?: () => number;
  maxMs?: number;
  /** A trip the bot makes by itself (the home return): the stand runs as that, low and automatic, and takes the body from nothing a command or a chore runs. */
  auto?: boolean;
}

export class StandProcess extends BaseProcess {
  readonly name = 'stand';
  readonly kind: ProcessKind;
  /** Times another process took the body while the stand wanted it. */
  lost = 0;
  private readonly o: StandOptions;
  private readonly now: () => number;
  private readonly since: number;

  constructor(o: StandOptions) {
    super();
    this.o = o;
    this.kind = o.auto ? 'auto' : 'user';
    this.now = o.now ?? (() => Date.now());
    this.since = this.now();
  }

  get priority(): number {
    return this.o.auto ? PRIORITY.home : PRIORITY.user;
  }

  /** The stand was ended or stopped: it holds nothing any more. */
  get over(): boolean {
    return this.done;
  }

  /** The stand has the body now. */
  get held(): boolean {
    return this.controlled;
  }

  override wants(): boolean {
    if (this.done) return false;
    if (this.now() - this.since > (this.o.maxMs ?? STAND_MAX_MS)) {
      this.end();
      return false;
    }
    return true;
  }

  protected run(): void {
    this.o.still();
  }

  protected halt(why: 'pause' | 'stop'): void {
    if (why === 'pause') this.lost++;
  }

  /** The decision has its answer (or gave up): the stand is over. */
  end(): void {
    this.finish();
  }

  status(): ProcessStatus {
    return { line: this.o.label };
  }
}

/**
 * Track F22: the process a call added: the newest of `after` that was not there `before`. A watched walk follows its
 * own process by this: the process that has the body when the walk is asked for may be another's (a fight that is on:
 * the walk's process waits under it), and the walk that followed that one never asked again.
 */
export function addedSince<T>(before: ReadonlySet<T>, after: readonly T[]): T | undefined {
  for (let i = after.length - 1; i >= 0; i--) if (!before.has(after[i]!)) return after[i];
  return undefined;
}
