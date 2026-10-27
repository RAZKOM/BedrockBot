// `!build` as a user process of the afk task (wave 9, Track AL; docs/build.md "Execution"). Pre-empted
// (guard, flee, night, a newer command, `!pause`) = the runner's running skill is cancelled and the
// step kept; resumed = the runner continues at the same step (walking again). It ends by itself
// (every step done or skipped, or out of a block) or with `!build stop` / `!stop`. A death drops it.
import type { BuildRunner, RunnerEnd } from '../../skills/build/runner.ts';
import { etaText, progressLine } from '../../skills/build/runner.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';

export type BuildEnd = RunnerEnd | { state: 'cancelled'; reason: StopReason };

export class BuildProcess extends BaseProcess {
  readonly name = 'build';
  readonly kind = 'user' as const;
  readonly runner: BuildRunner;
  readonly result: Promise<BuildEnd>;
  private resolve!: (e: BuildEnd) => void;
  readonly startedAt = Date.now();

  constructor(runner: BuildRunner) {
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

  status(): ProcessStatus {
    const eta = this.runner.etaS();
    return { line: `build ${this.runner.plan.spec.label}: ${progressLine(this.runner)}${this.controlled ? '' : ' (paused)'}`, etaS: eta };
  }

  /** `build: 212 / 640 placed, 3 skipped, eta 4 min` */
  statusText(): string {
    const eta = etaText(this.runner.etaS());
    return `build: ${progressLine(this.runner)}${eta ? `, eta ${eta}` : ''}${this.controlled ? '' : ' (paused)'}`;
  }
}
