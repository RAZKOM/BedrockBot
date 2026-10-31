// `!mine <block> [n]` as a user process of the afk task (PLAN.md 7.14 + 7.8, Track Z; docs/mining.md
// "As a process"). Pre-empted (guard, flee, night, a newer command, `!pause`) = MineTask.pause() (the
// running goto / dig is cancelled; a cancelled dig is not counted as a failure); resumed =
// MineTask.resume() (a fresh scan picks the nearest target again). It ends by itself (n mined, no
// seen ore left, low health, no pickaxe) or with `!mine stop` / `!stop` / a `!farm`. A death drops it.
// Track BD: while the job explores for more ore (nothing known, below n) the status line says so with the
// round and the blocks dug (`mine iron_ore 212/1000: exploring (round 3, 420 blocks)`).
import type { MineOptions, MineState, MineTask } from '../../skills/mine/miner.ts';
import { minedItem } from '../../skills/items/catalog.ts'; // Track AD
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';
import { StashStep } from './stashStep.ts'; // Track BK: the stash step, shared with the quarry

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

  /** Track AD: the stash step (Track BK: tasks/process/stashStep.ts, shared with the quarry). */
  private readonly stash = new StashStep();

  /**
   * Track AD (docs/get.md "Stash"): every tick in control, when fewer than 2 inventory slots are free
   * (also right at the start), pause the task, run the stash step (chest, shulker box, drop junk) and
   * resume; still full: the job ends 'inventory full'. A pre-emption cancels the step (the manager's
   * control change, commands-get) and the next tick in control checks again.
   */
  tick(): void {
    const t = this.token;
    const names = this.task.names;
    this.stash.check(
      this.manager,
      this.started && this.controlled && this.task.running && this.task.state !== 'collect',
      {
        label: 'mine',
        wanted: (n) => [...names].some((b) => minedItem(b) === n),
        pause: () => this.task.pause(),
        resume: () => this.task.resume(),
        full: () => {
          this.task.stop();
          this.task.state = 'failed';
          this.task.lastError = 'inventory full';
          this.finish();
          this.resolve('failed');
        },
      },
      () => t === this.token && !this.done,
    );
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
    const vein = this.task.vein ? `, vein ${this.task.vein.done}/${this.task.vein.size}` : ''; // Track AQ
    const what = this.task.quotas.length > 1 ? `mine: ${this.task.quotaLine()}` : `mine ${[...this.task.names][0] ?? this.opts.block} ${s.mined}/${want}`; // Track AQ: several kinds
    const explore = this.controlled ? this.task.exploreLine() : undefined; // Track BD: `mine iron_ore 212/1000: exploring (round 3, 420 blocks)`
    if (explore) return { line: `${what}: ${explore}`, etaS };
    return { line: `${what} (${state}, ${s.blacklisted.length} skipped${vein})`, etaS };
  }
}
