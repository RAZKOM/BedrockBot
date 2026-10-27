// Track AS (wave 10, docs/home.md "Bring", decision 0040): `!bring` as a user process (PRIORITY.user 40).
// Two phases, each run again from scratch after a pre-emption (flee, guard, night, a newer command,
// !pause): the withdrawal plans from the chest memory and the inventory (what is already carried
// counts, so a resumed withdrawal only takes what is still missing), the delivery walks to the player
// again from wherever the bot stands (the come logic: the tracked player, else the locator bar) or home.
import type { WithdrawReport } from '../../skills/home/logistics.ts';
import type { BringItem } from '../../skills/home/bring.ts';
import { BaseProcess, PRIORITY, type ProcessKind, type ProcessStatus, type StopReason } from './manager.ts';

export interface BringJob {
  item: BringItem;
  want: number;
  /** A player name, or home. */
  to: { player: string } | { home: true };
}

export interface DeliverResult {
  ok: boolean;
  reason?: string;
  /** Where the items ended up: at the player (within 2 blocks) or at home. */
  at: 'player' | 'home';
  /** Why the bot went home instead of to the player (`Steve is not online`). */
  fallback?: string;
}

export interface BringResult {
  withdraw: WithdrawReport;
  deliver: DeliverResult | undefined;
}

/** What the process drives (wired in chat/commands-bring.ts; faked in the unit tests). */
export interface BringRunner {
  withdraw(cancelled: () => boolean, job: BringJob): Promise<WithdrawReport>;
  /** Walk to the player (within 2 blocks) or home. */
  deliver(cancelled: () => boolean, job: BringJob): Promise<DeliverResult>;
  /** Cancel the running skill (walk, follow). */
  cancel(): void;
  /** Blocks left on the current walk, for the status line. */
  remaining?(): number | undefined;
}

export type BringPhase = 'withdraw' | 'deliver';

/** Merge a resumed withdrawal's report into the earlier one. */
export function mergeWithdraw(a: WithdrawReport | undefined, b: WithdrawReport): WithdrawReport {
  if (!a) return b;
  const taken = { ...a.taken };
  for (const [k, v] of Object.entries(b.taken)) taken[k] = (taken[k] ?? 0) + v;
  return {
    ...b,
    taken,
    from: [...new Set([...a.from, ...b.from])],
    boxes: [...a.boxes, ...b.boxes],
    chests: a.chests + b.chests,
    requests: a.requests + b.requests,
    ms: a.ms + b.ms,
  };
}

export class BringProcess extends BaseProcess {
  readonly name = 'bring';
  readonly kind: ProcessKind = 'user';
  readonly result: Promise<BringResult | undefined>;
  private resolve!: (r: BringResult | undefined) => void;
  private readonly runner: BringRunner;
  readonly job: BringJob;
  phase: BringPhase = 'withdraw';
  report: WithdrawReport | undefined;
  private runs = 0;

  constructor(runner: BringRunner, job: BringJob) {
    super();
    this.runner = runner;
    this.job = job;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  private target(): string {
    return 'player' in this.job.to ? this.job.to.player : 'home';
  }

  protected run(t: number): void {
    this.runs++;
    const cancelled = () => t !== this.token || this.done;
    const fail = () => {
      if (cancelled()) return;
      this.finish();
      this.resolve(undefined);
    };
    if (this.phase === 'withdraw') {
      void this.runner.withdraw(cancelled, this.job).then((rep) => {
        this.report = mergeWithdraw(this.report, rep); // an interrupted run's takes count too
        if (cancelled()) return;
        // nothing carried and no box taken: nothing to bring
        if (rep.carried <= 0 && this.report.boxes.length === 0) {
          this.finish();
          this.resolve({ withdraw: this.report, deliver: undefined });
          return;
        }
        this.phase = 'deliver';
        this.deliver(t);
      }, fail);
      return;
    }
    this.deliver(t);
  }

  private deliver(t: number): void {
    const cancelled = () => t !== this.token || this.done;
    void this.runner.deliver(cancelled, this.job).then(
      (d) => {
        if (cancelled()) return;
        this.finish();
        this.resolve({ withdraw: this.report!, deliver: d });
      },
      () => {
        if (cancelled()) return;
        this.finish();
        this.resolve(undefined);
      },
    );
  }

  protected halt(): void {
    this.runner.cancel();
  }

  protected override onStopped(_reason: StopReason): void {
    this.resolve(undefined);
  }

  behaviour(): string {
    return this.phase === 'withdraw' ? `taking ${this.job.item.word} out of the chests` : `bringing ${this.job.item.word} to ${this.target()}`;
  }

  status(): ProcessStatus {
    const state = this.controlled ? 'running' : this.runs > 0 ? 'paused' : 'waiting';
    const left = this.controlled && this.phase === 'deliver' ? this.runner.remaining?.() : undefined;
    const what = `bring ${this.job.want} ${this.job.item.word} to ${this.target()}`;
    const doing = this.phase === 'withdraw' ? 'taking from the chests' : `walking to ${this.target()}${left !== undefined ? `, ${Math.round(left)} blocks left` : ''}`;
    return { line: `${what}: ${doing} (${state})` };
  }
}
