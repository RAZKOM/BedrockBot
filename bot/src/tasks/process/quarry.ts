// `!quarry` / `!tunnel` as a user process of the afk task (Track BK; docs/mining.md "Quarry and tunnel").
// Pre-empted (guard, flee, night, eating, a newer command, `!pause`) = QuarryJob.pause() (the runner's
// skill is cancelled); resumed = QuarryJob.resume() (the current slice is planned again from where the
// bot stands, after walking back to the job when it is far). The stash step runs like mine's
// (tasks/process/stashStep.ts): the dug blocks' items are the produce (kept, packed first) unless
// `quarryKeepStone` is off, and then the job's collects leave the junk on the ground (else they pick up
// what the stash step dropped), keeping only enough throwaway blocks for the keeper's reserve. It ends by itself (every slice, a blocked tunnel, no pickaxe, inventory full)
// or with `!quarry stop` / `!tunnel stop` / `!stop`. A death drops it.
import { isStashJunk } from '../../skills/container/stash.ts';
import { minedItem } from '../../skills/items/catalog.ts';
import type { QuarryJob, QuarryState } from '../../skills/mine/quarry.ts';
import { THROWAWAY_BLOCKS } from '../../skills/survival/keeper.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';
import { StashStep } from './stashStep.ts';

/** What the job's collects pick up: everything with quarryKeepStone on; else no junk, but throwaway blocks while short of the reserve. */
export function quarryTakes(name: string, keepStone: boolean, throwawayShort: boolean): boolean {
  if (keepStone || !isStashJunk(name)) return true;
  return throwawayShort && THROWAWAY_BLOCKS.includes(name.replace(/^minecraft:/, ''));
}

export class QuarryProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name: string;
  readonly job: QuarryJob;
  readonly result: Promise<QuarryState>;
  private resolve!: (s: QuarryState) => void;
  private started = false;
  private readonly stash = new StashStep();
  /** Setting `quarryKeepStone`: stone, cobblestone, deepslate, ... are produce (else junk for the stash step). */
  private readonly keepStone: () => boolean;

  constructor(job: QuarryJob, keepStone: () => boolean = () => true) {
    super();
    this.job = job;
    this.name = job.spec.kind;
    this.keepStone = keepStone;
    job.take = (n) => quarryTakes(n, this.keepStone(), job.throwawayShort());
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
      void this.job.start().then((s) => {
        if (this.done) return;
        this.finish();
        this.resolve(s);
      });
      return;
    }
    this.job.resume();
  }

  /** The produce: what the dug blocks drop (stone-like blocks only with quarryKeepStone on). */
  wanted(name: string): boolean {
    const keep = this.keepStone();
    return this.job.dugNames().some((b) => minedItem(b) === name && (keep || !isStashJunk(name)));
  }

  tick(): void {
    const t = this.token;
    this.stash.check(
      this.manager,
      this.started && this.controlled && this.job.state === 'run',
      {
        label: this.name,
        wanted: (n) => this.wanted(n),
        pause: () => this.job.pause(),
        resume: () => this.job.resume(),
        full: () => {
          this.job.stop();
          this.job.state = 'failed';
          this.job.lastError = 'inventory full';
          this.finish();
          this.resolve('failed');
        },
      },
      () => t === this.token && !this.done,
    );
  }

  protected halt(why: 'pause' | 'stop'): void {
    if (why === 'pause') this.job.pause();
  }

  protected override onStopped(_reason: StopReason): void {
    if (this.started) this.job.stop();
    this.resolve('stopped');
  }

  behaviour(): string {
    return `${this.job.spec.label}: ${this.job.progress()}`;
  }

  status(): ProcessStatus {
    const state = this.stash.running ? 'stashing' : this.controlled ? this.job.state : this.started ? 'paused' : 'waiting';
    return { line: `${this.job.spec.label}: ${this.job.progress()} (${state})`, etaS: this.job.etaS() };
  }
}
