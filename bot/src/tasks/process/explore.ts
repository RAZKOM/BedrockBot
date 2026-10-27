// `!explore [radius]` as a user process of the afk task (wave 9, Track AI; docs/explore.md). Trip
// readiness first (a long walk: eat and put on armour when food or health is below 14, Track W's
// prepareTrip through the PvE controller), then the Explorer's frontier walk. Pre-empted (guard, flee,
// night, a newer command, `!pause`) = Explorer.pause() (the walk is cancelled, the cell kept);
// resumed = Explorer.resume() (the same cell again). It ends by itself (no cell left, too many failed
// walks) or with `!explore stop` / `!stop`. A death drops it.
import type { ExploreOptions, ExploreState, Explorer } from '../../skills/explore/explorer.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';
import type { PrepPhase } from './readiness.ts';

/** Trip readiness as the PvE controller offers it (tasks/pve.ts prepNeeded / prepare). */
export interface ExplorePrep {
  needed(): boolean;
  prepare(alive: () => boolean, phase: (p: PrepPhase) => void): Promise<void>;
}

export class ExploreProcess extends BaseProcess {
  readonly name = 'explore';
  readonly kind = 'user' as const;
  readonly result: Promise<ExploreState>;
  readonly task: Explorer;
  readonly opts: ExploreOptions;
  private readonly prep: ExplorePrep | undefined;
  private resolve!: (s: ExploreState) => void;
  private started = false;
  /** Trip readiness running (`preparing: eating`). */
  preparing: PrepPhase | undefined;

  constructor(task: Explorer, opts: ExploreOptions, prep?: ExplorePrep) {
    super();
    this.task = task;
    this.opts = opts;
    this.prep = prep;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    if (this.started) {
      this.task.resume();
      return;
    }
    if (this.prep?.needed()) {
      void this.prep
        .prepare(
          () => t === this.token,
          (p) => {
            this.preparing = p;
          },
        )
        .finally(() => {
          this.preparing = undefined;
          if (t === this.token && !this.done) this.begin();
        });
      return;
    }
    this.begin();
  }

  private begin(): void {
    this.started = true;
    void this.task.start(this.opts).then((s) => {
      if (this.done) return;
      this.finish();
      this.resolve(s);
    });
  }

  protected halt(why: 'pause' | 'stop'): void {
    if (why === 'pause') this.task.pause();
  }

  protected override onStopped(_reason: StopReason): void {
    if (this.started) this.task.stop();
    this.resolve('stopped');
  }

  behaviour(): string {
    return this.preparing ? `preparing: ${this.preparing}` : `exploring r=${this.opts.radius}`;
  }

  status(): ProcessStatus {
    const s = this.task.stats;
    const state = this.preparing ? `preparing: ${this.preparing}` : this.controlled ? this.task.state : this.started ? 'paused' : 'waiting';
    const left = Math.max(0, s.cells - s.visited - s.water - s.lava - s.unreachable - s.covered);
    return { line: `explore r=${this.opts.radius} ${s.visited} cells visited, ${s.newColumns} new chunks (${state}, ${left} cells open)` };
  }
}
