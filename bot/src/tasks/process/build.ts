// `!build` as a user process of the afk task (wave 9, Track AL; docs/build.md "Execution"). Pre-empted
// (guard, flee, night, a newer command, `!pause`) = the runner's running skill is cancelled and the
// step kept; resumed = the runner continues at the same step (walking again). It ends by itself
// (every step done or skipped, or out of a block) or with `!build stop` / `!stop`. A death drops it.
// Track B3 (decision 0128): the work is one runner, or a large build's job (skills/build/job.ts), which also ends
// `restock` when a fetch round should run (the controller runs it and starts the job again in a new process).
import type { BuildWork, RunnerEnd } from '../../skills/build/runner.ts';
import { etaText, progressLine } from '../../skills/build/runner.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';

export type BuildEnd = RunnerEnd | { state: 'cancelled'; reason: StopReason };

export class BuildProcess extends BaseProcess {
  readonly name = 'build';
  readonly kind = 'user' as const;
  readonly runner: BuildWork;
  readonly result: Promise<BuildEnd>;
  private resolve!: (e: BuildEnd) => void;
  readonly startedAt = Date.now();

  constructor(runner: BuildWork) {
    super();
    this.runner = runner;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    // the runner of a pause may still be winding down (its skill was cancelled): start once it ended
    const go = (): void => {
      if (t !== this.token || this.done) return;
      if (this.runner.busy) {
        setTimeout(go, 50);
        return;
      }
      void this.runner.run().then(
        (end) => {
          if (t !== this.token || this.done || end.state === 'paused') return;
          this.finish();
          this.resolve(end);
        },
        (e: unknown) => {
          if (t !== this.token || this.done) return;
          this.finish();
          this.resolve({ state: 'stopped', reason: e instanceof Error ? e.message : String(e) });
        },
      );
    };
    go();
  }

  protected halt(): void {
    this.runner.pause();
  }

  protected override onStopped(reason: StopReason): void {
    this.runner.pause();
    this.resolve({ state: 'cancelled', reason });
  }

  behaviour(): string {
    return `building (${this.runner.plan.spec.label})`;
  }

  private more(): string {
    const d = this.runner.detail?.();
    return d ? `, ${d}` : '';
  }

  status(): ProcessStatus {
    const eta = this.runner.etaS();
    return { line: `build ${this.runner.plan.spec.label}: ${progressLine(this.runner)}${this.more()}${this.controlled ? '' : ' (paused)'}`, etaS: eta };
  }

  /** `build: 212 / 640 placed, 3 skipped, eta 4 min` (Track B3: `, section 3 of 12` for a large build) */
  statusText(): string {
    const eta = etaText(this.runner.etaS());
    return `build: ${progressLine(this.runner)}${this.more()}${eta ? `, eta ${eta}` : ''}${this.controlled ? '' : ' (paused)'}`;
  }
}

/** Track B6: per task, the items a running build needs (the build's, what its fetch brings and makes from). */
const keeps = new WeakMap<object, () => readonly string[]>();

/** Track B6: register the build's items (chat/commands-build.ts). */
export function setBuildKeeps(task: object, fn: () => readonly string[]): void {
  keeps.set(task, fn);
}

/**
 * Track B6 (decision 0131): what a running build needs now (none without a build): a withdrawal's room for a take
 * (docs/home.md "Room for a take") never unloads them (it unloaded what the step before had brought).
 */
export function buildKeepsOf(task: object): readonly string[] {
  return keeps.get(task)?.() ?? [];
}

/**
 * Track B6 (decision 0131): a user process that does nothing, there from a `!build` (or a resume) until the build, its
 * fetch and the boxes after it are over. The chores (home unload, mend, rockets, food, the room chore, ...) start only
 * with no user process at all, and a build's own processes come and go: between them (a fetch round starting, the plan
 * after a fetch, a step's process ending) the manager gave the body to a chore, which put the build's boxes and what
 * was just brought back into the chests. Ranked just over the chores and under every command (PRIORITY.chore + 1): it
 * holds the body only when nothing else of the build wants it. `!stop` stops it with the rest.
 */
export class BuildHoldProcess extends BaseProcess {
  readonly name = 'build-hold';
  readonly kind = 'user' as const;
  private readonly what: () => string;

  constructor(what: () => string) {
    super();
    this.what = what;
  }

  get priority(): number {
    return PRIORITY.chore + 1;
  }

  protected run(): void {}

  protected halt(): void {}

  /** The build is over: dropped from the manager. */
  end(): void {
    this.finish();
  }

  behaviour(): string {
    return `between the steps of a build (${this.what()})`;
  }

  status(): ProcessStatus {
    return { line: `build ${this.what()}: between steps (the home chores wait)` };
  }
}

/**
 * Track B4 (decision 0129): a build's work with the carried shulker boxes as a user process of its own (named apart from
 * `build`, so it pre-empts a fetch's process instead of replacing it): the handed-over boxes picked up, a fetch round's
 * take out of or stow into the boxes, the boxes a stop or a restart left recovered. `work(cancelled)` runs again from
 * the start after a pre-emption (it reads what is left to do itself); `cancel` stops the running skill. The result is
 * the work's own line, or `cancelled: <reason>`.
 */
export class BoxWorkProcess extends BaseProcess {
  readonly name = 'build-boxes';
  readonly kind = 'user' as const;
  readonly result: Promise<string>;
  private resolve!: (line: string) => void;
  private busy = false;
  private readonly what: string;
  private readonly work: (cancelled: () => boolean) => Promise<string>;
  private readonly cancel: () => void;

  constructor(what: string, work: (cancelled: () => boolean) => Promise<string>, cancel: () => void = () => {}) {
    super();
    this.what = what;
    this.work = work;
    this.cancel = cancel;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  /** The work is still winding down (after a pause or a stop). */
  get running(): boolean {
    return this.busy;
  }

  protected run(t: number): void {
    const go = (): void => {
      if (t !== this.token || this.done) return;
      if (this.busy) {
        setTimeout(go, 50);
        return;
      }
      this.busy = true;
      void this.work(() => t !== this.token || this.done)
        .then(
          (line) => {
            if (t !== this.token || this.done) return;
            this.finish();
            this.resolve(line);
          },
          (e: unknown) => {
            if (t !== this.token || this.done) return;
            this.finish();
            this.resolve(`failed: ${e instanceof Error ? e.message : String(e)}`);
          },
        )
        .finally(() => {
          this.busy = false;
        });
    };
    go();
  }

  protected halt(): void {
    this.cancel();
  }

  protected override onStopped(reason: StopReason): void {
    this.resolve(`cancelled: ${reason}`);
  }

  behaviour(): string {
    return this.what;
  }

  status(): ProcessStatus {
    return { line: `build: ${this.what}${this.controlled ? '' : ' (paused)'}` };
  }
}
