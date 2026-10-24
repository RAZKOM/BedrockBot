// `!mine <block> [n]` as a user process of the afk task (PLAN.md 7.14 + 7.8, Track Z; docs/mining.md
// "As a process"). Pre-empted (guard, flee, night, a newer command, `!pause`) = MineTask.pause() (the
// running goto / dig is cancelled; a cancelled dig is not counted as a failure); resumed =
// MineTask.resume() (a fresh scan picks the nearest target again). It ends by itself (n mined, no
// seen ore left, low health, no pickaxe) or with `!mine stop` / `!stop` / a `!farm`. A death drops it.
import type { MineOptions, MineState, MineTask } from '../../skills/mine/miner.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';

export class MineProcess extends BaseProcess {
  readonly name = 'mine';
  readonly kind = 'user' as const;
  readonly result: Promise<MineState>;
  readonly task: MineTask;
  readonly opts: MineOptions;
  private resolve!: (s: MineState) => void;
  private started = false;

  constructor(task: MineTask, opts: MineOptions) {
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

  behaviour(): string {
    return `mining ${this.task.stats.mined}/${this.opts.count ?? 1} ${[...this.task.names][0] ?? this.opts.block}`;
  }

  status(): ProcessStatus {
    const s = this.task.stats;
    const want = this.opts.count ?? 1;
    const state = this.controlled ? this.task.state : this.started ? 'paused' : 'waiting';
    const elapsedS = s.startedAt !== undefined ? (Date.now() - s.startedAt) / 1000 : 0;
    const etaS = s.mined > 0 && elapsedS > 0 ? ((want - s.mined) * elapsedS) / s.mined : undefined;
    return { line: `mine ${[...this.task.names][0] ?? this.opts.block} ${s.mined}/${want} (${state}, ${s.blacklisted.length} skipped)`, etaS };
  }
}
