// `!farm [radius]` as a user process of the afk task (PLAN.md 7.13 + 7.8, Track Z; docs/farming.md
// "As a process"). Pre-empted (guard, flee, night, a newer command, `!pause`) = FarmTask.pause() (the
// running dig / place / goto is cancelled, counters kept); resumed = FarmTask.resume() (it scans the
// field again and goes on). It runs until stopped (`!farm stop`, `!stop`, a `!mine`): when there is
// nothing to do it waits (re-scans every 60 s) and reports idle() so the keepalive nudge may run.
// It survives a death (paused while dead, resumed after the respawn, like gather).
import type { Vec3 } from '../../connection/types.ts';
import type { FarmOptions, FarmState, FarmTask } from '../../skills/farm/farmer.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';

export class FarmProcess extends BaseProcess {
  readonly name = 'farm';
  readonly kind = 'user' as const;
  override readonly survivesDeath = true;
  readonly result: Promise<FarmState>;
  readonly task: FarmTask;
  readonly opts: FarmOptions;
  private resolve!: (s: FarmState) => void;
  private started = false;

  constructor(task: FarmTask, opts: FarmOptions) {
    super();
    this.task = task;
    this.opts = opts;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(): void {
    if (!this.started) {
      this.started = true;
      void this.task.start(this.opts).then((s) => {
        // stop() resolves through onStopped; a failure (or maxRounds) ends the process here
        if (this.done) return;
        this.finish();
        this.resolve(s);
      });
      return;
    }
    this.task.resume();
  }

  protected halt(why: 'pause' | 'stop'): void {
    if (why === 'pause') this.task.pause();
  }

  protected override onStopped(_reason: StopReason): void {
    if (this.started) this.task.stop();
    this.resolve('stopped');
  }

  /** Waiting for crops to grow: the bot stands, the keepalive nudge may run. */
  idle(): boolean {
    return this.task.state === 'waiting' || this.task.state === 'full';
  }

  behaviour(): string {
    return `farming (${this.task.stats.harvested} harvested)`;
  }

  status(): ProcessStatus {
    const s = this.task.stats;
    const c = this.opts.center;
    const state = this.controlled ? this.task.state : this.started ? 'paused' : 'waiting';
    return { line: `farm r=${this.opts.radius ?? 8} at ${fmtC(c)}: ${s.harvested} harvested, ${s.planted} planted, ${s.boneMealUsed} bone meal, ${s.trips} trips (${state})` };
  }
}

function fmtC(c: Vec3): string {
  return `${Math.floor(c.x)} ${Math.floor(c.y)} ${Math.floor(c.z)}`;
}
