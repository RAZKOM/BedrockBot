// The stash step of a work process (Track AD's step out of MineProcess, shared since Track BK with
// `!quarry` / `!tunnel`; docs/get.md "Stash"): every tick in control, when fewer than 2 inventory slots
// are free, pause the job, run the stash step (chest, shulker box, drop junk) and resume it; still full:
// the job ends 'inventory full'. A pre-emption cancels the step (the manager's control change,
// commands-get) and the next tick in control checks again.
import { stashFor } from '../../skills/container/stash.ts';

/** The job a stash step pauses and resumes. */
export interface StashJob {
  /** `mine`, `quarry`: the stash step's log label. */
  label: string;
  /** The job's produce: never dropped as junk, packed first. */
  wanted(name: string): boolean;
  pause(): void;
  /** Before the step walks off (the job paused): e.g. a quarry climbs out of its pit. */
  leave?(): Promise<void>;
  resume(): void;
  /** Still full after the step: end the job with 'inventory full'. */
  full(): void;
}

export class StashStep {
  private busy = false;

  /** The step runs (the job is paused meanwhile). */
  get running(): boolean {
    return this.busy;
  }

  /**
   * Call from the process' tick(): `manager` is the process manager (the stash is registered per
   * manager), `ready` the process' own conditions (in control, started, the job running). `alive()` is
   * asked after the step: false (stopped or paused meanwhile) = leave the job as it is.
   */
  check(manager: object | undefined, ready: boolean, job: StashJob, alive: () => boolean): void {
    const s = stashFor(manager);
    if (!s || this.busy || !ready || !s.needed()) return;
    this.busy = true;
    job.pause();
    void (async () => {
      try {
        if (job.leave) {
          await job.leave();
          if (!alive()) return;
        }
        const ok = await s.ifFull({ label: job.label, wanted: (n) => job.wanted(n) });
        if (!alive()) return;
        if (ok) job.resume();
        else job.full();
      } finally {
        this.busy = false;
      }
    })();
  }
}
