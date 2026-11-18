// `!bed` as a user process (Track E3, docs/early-game.md "A bed", ADR 0100): a carried bed set down where the night
// rule sleeps in it (skills/survival/bed-place.ts: by home, else by the shelter, else here with the `bed` waypoint set),
// then, by day, clicked once so the respawn point moves to it. A user process (priority 40): guard, flee and night
// pre-empt it; a resume places again (a bed already standing there ends it).
import type { Logger } from '../../log.ts';
import type { BedPlaceResult } from '../../skills/survival/bed-place.ts';
import type { SleepResult } from '../../skills/survival/sleep.ts';
import type { Vec3 } from '../../world/types.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';

export interface BedJobDeps {
  place(cancelled: () => boolean): Promise<BedPlaceResult>;
  /** By day: click the bed (the server moves the respawn point to it and refuses sleep); undefined by night. */
  click?(half: Vec3): Promise<SleepResult>;
  /** In the sleep window now (the night rule clicks it then). */
  night(): boolean;
  /** The bed is not by home or the shelter: set the `bed` waypoint at its head. */
  mark?(head: Vec3): boolean;
  /** Cancel the running skill. */
  cancel(): void;
  log?: Logger;
}

export interface BedJobResult {
  ok: boolean;
  reason: string;
  place?: BedPlaceResult;
  /** The day click moved the respawn point (`tile.bed.noSleep` or asleep came back). */
  spawnSet: boolean;
  /** The `bed` waypoint was set. */
  marked: boolean;
}

export class BedJob {
  phase: 'place' | 'click' | 'done' = 'place';
  place: BedPlaceResult | undefined;
  spawnSet = false;
  marked = false;
  reason = 'done';

  async run(d: BedJobDeps, cancelled: () => boolean): Promise<boolean> {
    if (this.phase === 'place') {
      const r = await d.place(cancelled);
      if (cancelled()) return false;
      this.place = r;
      if (!r.ok) {
        this.reason = r.reason;
        this.phase = 'done';
        return true;
      }
      if (!r.already && d.mark) this.marked = d.mark(r.head);
      this.phase = 'click';
    }
    if (this.phase === 'click') {
      const p = this.place;
      if (p?.ok && !p.already && !d.night() && d.click) {
        // the foot: the half next to the bot (the server refuses a click from more than about 3 blocks)
        const c = await d.click(p.foot ?? p.head);
        if (cancelled()) return false;
        // noSleep by day: the respawn point moved all the same (docs/survival.md "Sleep")
        this.spawnSet = c.ok || c.reason === 'not_night' || c.reason === 'monsters';
        d.log?.info(`bed: day click ${c.ok ? 'asleep' : (c.reason ?? 'failed')}${this.spawnSet ? ': respawn point set' : ''}`);
      }
      this.phase = 'done';
    }
    return true;
  }

  result(): BedJobResult {
    return { ok: this.reason === 'done', reason: this.reason, ...(this.place ? { place: this.place } : {}), spawnSet: this.spawnSet, marked: this.marked };
  }
}

export class BedProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name = 'bed';
  readonly result: Promise<BedJobResult>;
  private resolve!: (r: BedJobResult) => void;
  readonly job = new BedJob();
  private readonly d: BedJobDeps;

  constructor(d: BedJobDeps) {
    super();
    this.d = d;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    void this.job.run(this.d, () => t !== this.token).then(
      (over) => {
        if (!over || t !== this.token) return;
        this.finish();
        this.resolve(this.job.result());
      },
      (err: unknown) => {
        this.d.log?.warn(`bed: ${err instanceof Error ? err.message : String(err)}`);
        this.finish();
        this.resolve({ ...this.job.result(), ok: false, reason: 'error' });
      },
    );
  }

  protected halt(): void {
    this.d.cancel();
  }

  protected override onStopped(_reason: StopReason): void {
    this.resolve({ ...this.job.result(), ok: false, reason: 'interrupted' });
  }

  behaviour(): string {
    return this.job.phase === 'click' ? 'bed: setting the respawn point' : 'placing a bed';
  }

  status(): ProcessStatus {
    return { line: this.behaviour() };
  }
}
