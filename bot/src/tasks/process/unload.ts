// Track AG (wave 9, docs/home.md "Processes"): home logistics as processes of the afk task.
//
//   HomeJobProcess (user, PRIORITY.user 40)   `!unload [all]` and `!chests scan`: the job runs now; a
//                                             pre-emption (flee, guard, night, a newer command, !pause)
//                                             cancels it, a resume runs it again from a fresh plan
//                                             (the memory and the inventory say what is left to do)
//   HomeChore (auto, PRIORITY.chore 30)       with nothing else to do and the bot within 8 blocks of
//                                             home: the first scan of the session, containers that
//                                             appeared within homeChestRadius (read them), and with
//                                             `autoUnload` on an unload when more than 8 stacks of
//                                             unloadable items or a full shulker box are carried, or
//                                             when a `!get` job just ended at home (its reply then says
//                                             what went where); then, with nothing to unload, a tidy job
//                                             when a home chest holds 27 full stacks' worth of one item
//                                             loose and a spare is known (docs/home.md "Full boxes out of
//                                             the chests"; at most every TIDY_BACKOFF_MS when it boxed nothing)
import type { ScanReport, UnloadReport } from '../../skills/home/logistics.ts';
import { BaseProcess, PRIORITY, type ProcessKind, type ProcessStatus, type StopReason } from './manager.ts';

/** The chore unloads above this many stacks of unloadable items (or with any full shulker box). */
export const AUTO_UNLOAD_STACKS = 8;
/** After an unload that left items (or failed), the chore waits this long before trying again (ms). */
export const UNLOAD_BACKOFF_MS = 5 * 60_000;
/** After a tidy job that boxed nothing (or failed), the chore waits this long before the next one (ms). */
export const TIDY_BACKOFF_MS = 10 * 60_000;
/** After a scan that failed for some containers, the chore does not retry them for this long (ms). */
export const SCAN_BACKOFF_MS = 2 * 60_000;
/** The chore looks at its triggers at most this often (ms). */
const CHECK_MS = 1000;

export type HomeJob = { kind: 'unload'; all?: boolean } | { kind: 'scan'; force?: boolean; retry?: boolean; only?: { x: number; y: number; z: number }[] } | { kind: 'tidy' }; // Track AN: retry
export type HomeJobResult = { kind: 'unload'; report: UnloadReport } | { kind: 'scan'; report: ScanReport } | { kind: 'tidy'; report: UnloadReport };

/** What the processes drive (HomeLogistics satisfies it; unit tests fake it). */
export interface HomeRunner {
  unload(cancelled: () => boolean, opts?: { all?: boolean }): Promise<UnloadReport>;
  scan(cancelled: () => boolean, opts?: { force?: boolean; retry?: boolean; only?: { x: number; y: number; z: number }[] }): Promise<ScanReport>;
  /** The home chests' own full boxes' worth into spares (tidy steps only). */
  tidy?(cancelled: () => boolean): Promise<UnloadReport>;
  /** Cancel the running skill (goto, dig, ...). */
  cancel(): void;
}

function runJob(r: HomeRunner, job: HomeJob, cancelled: () => boolean): Promise<HomeJobResult> {
  if (job.kind === 'unload') return r.unload(cancelled, { all: job.all ?? false }).then((report) => ({ kind: 'unload', report }));
  if (job.kind === 'tidy') return (r.tidy ? r.tidy(cancelled) : Promise.reject(new Error('no tidy'))).then((report) => ({ kind: 'tidy', report }));
  return r.scan(cancelled, { ...(job.force ? { force: true } : {}), ...(job.retry ? { retry: true } : {}), ...(job.only ? { only: job.only } : {}) }).then((report) => ({ kind: 'scan', report }));
}

/** `!unload [all]`, `!chests scan` (user). */
export class HomeJobProcess extends BaseProcess {
  readonly name: string;
  readonly kind: ProcessKind = 'user';
  readonly result: Promise<HomeJobResult | undefined>;
  private resolve!: (r: HomeJobResult | undefined) => void;
  private readonly runner: HomeRunner;
  readonly job: HomeJob;
  private runs = 0;

  constructor(runner: HomeRunner, job: HomeJob) {
    super();
    this.runner = runner;
    this.job = job;
    this.name = job.kind === 'unload' ? 'unload' : 'chests';
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    this.runs++;
    void runJob(this.runner, this.job, () => t !== this.token || this.done).then(
      (r) => {
        if (t !== this.token || this.done) return;
        this.finish();
        this.resolve(r);
      },
      () => {
        if (t !== this.token || this.done) return;
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
    return this.job.kind === 'unload' ? 'unloading at home' : 'reading the chests at home';
  }

  status(): ProcessStatus {
    const state = this.controlled ? 'running' : this.runs > 0 ? 'paused' : 'waiting';
    return { line: `${this.job.kind === 'unload' ? `unload${this.job.kind === 'unload' && this.job.all ? ' all' : ''}` : 'chests scan'} (${state})` };
  }
}

/** What the chore looks at (wired in chat/commands-home.ts; faked in the unit tests). */
export interface HomeChoreDeps {
  runner: HomeRunner;
  /** Within 8 blocks of home (and a home is set). */
  atHome(): boolean;
  /** No user process is there (running, paused or held). */
  idle(): boolean;
  autoUnload(): boolean;
  /** Unloadable stacks carried and full shulker boxes. */
  load(): { stacks: number; fullBoxes: number };
  /** Read containers remembered around home. */
  known(): number;
  /** A tidy job is due (a home chest holds a full box's worth of one item loose, a spare is known). */
  tidyDue?(): boolean;
  /** A `!get` job ended (since the last call): true once per job. */
  getEnded?(): boolean;
  /** The report of an unload run for a `!get` job (the line goes to chat). */
  onGetUnload?(r: UnloadReport): void;
  now?: () => number;
  log?: { info(m: string): void };
}

/** The automatic scans and unloads (auto, PRIORITY.chore). Registered once; never done. */
export class HomeChore extends BaseProcess {
  readonly name = 'home-chore';
  readonly kind: ProcessKind = 'auto';
  private readonly d: HomeChoreDeps;
  private readonly now: () => number;
  /** The first scan of this session is still due. */
  sessionScan = true;
  /** Containers that appeared within the radius (read them). */
  readonly pending = new Map<string, { x: number; y: number; z: number }>();
  private job: HomeJob | undefined;
  private forGet = false;
  private getWaiting = false;
  private running = false;
  private lastCheck = -Infinity;
  private unloadAfter = 0;
  private tidyAfter = 0;
  private scanAfter = 0;
  last: HomeJobResult | undefined;
  readonly stats = { scans: 0, unloads: 0, getUnloads: 0, tidies: 0 };

  constructor(d: HomeChoreDeps) {
    super();
    this.persistent = true;
    this.d = d;
    this.now = d.now ?? (() => Date.now());
  }

  get priority(): number {
    return PRIORITY.chore;
  }

  /** A new session (spawn): the first scan near home is due again. */
  newSession(): void {
    this.sessionScan = true;
  }

  /** A container block appeared at p (within the radius): read it at the next chance. */
  appeared(p: { x: number; y: number; z: number }): void {
    this.pending.set(`${p.x},${p.y},${p.z}`, { x: p.x, y: p.y, z: p.z });
  }

  override wants(): boolean {
    if (this.running) return true;
    const t = this.now();
    if (this.d.getEnded?.()) this.getWaiting = true;
    if (t - this.lastCheck < CHECK_MS) return this.job !== undefined;
    this.lastCheck = t;
    this.job = this.next(t);
    return this.job !== undefined;
  }

  /** The job due now, if any. */
  next(t: number): HomeJob | undefined {
    const d = this.d;
    if (!d.atHome()) {
      this.getWaiting = false; // a !get job that ended away from home unloads nothing
      return undefined;
    }
    if (!d.idle()) return undefined;
    if ((this.sessionScan || this.pending.size > 0) && t >= this.scanAfter) {
      return this.sessionScan ? { kind: 'scan' } : { kind: 'scan', force: true, only: [...this.pending.values()] };
    }
    if (!d.autoUnload() || d.known() === 0) {
      this.getWaiting = false;
      return undefined;
    }
    const load = d.load();
    if (this.getWaiting && (load.stacks > 0 || load.fullBoxes > 0)) {
      this.forGet = true;
      return { kind: 'unload' };
    }
    this.getWaiting = false;
    if (t < this.unloadAfter) return undefined;
    if (load.stacks > AUTO_UNLOAD_STACKS || load.fullBoxes > 0) return { kind: 'unload' };
    if (t >= this.tidyAfter && this.d.runner.tidy && this.d.tidyDue?.()) return { kind: 'tidy' };
    return undefined;
  }

  protected run(tok: number): void {
    const job = this.job ?? this.next(this.now());
    if (!job) return;
    this.job = job;
    this.running = true;
    const forGet = this.forGet;
    void runJob(this.d.runner, job, () => tok !== this.token).then(
      (r) => this.ended(tok, job, r, forGet),
      () => this.ended(tok, job, undefined, forGet),
    );
  }

  private ended(tok: number, job: HomeJob, r: HomeJobResult | undefined, forGet: boolean): void {
    if (tok !== this.token) return; // paused or stopped meanwhile: run() starts it again on resume
    this.running = false;
    this.job = undefined;
    this.last = r;
    const t = this.now();
    if (job.kind === 'scan') {
      this.stats.scans++;
      const failed = r?.kind === 'scan' ? r.report.failed.length : 1;
      if (r?.kind === 'scan' && r.report.ok) {
        this.sessionScan = false;
        for (const p of job.only ?? []) this.pending.delete(`${p.x},${p.y},${p.z}`);
        if (!job.only) this.pending.clear();
        // a container that could not be opened is not retried at once (it stays for the next session);
        // Track AN: one the bot cannot walk to is remembered as unreachable by the scan itself, and the
        // reachable ones beyond the scan's read cap are read at the next idle moment
        for (const p of r.report.pending ?? []) this.appeared(p);
      }
      if (failed > 0 || !r?.report.ok) this.scanAfter = t + SCAN_BACKOFF_MS;
    } else if (job.kind === 'tidy') {
      this.stats.tidies++;
      const rep = r?.kind === 'tidy' ? r.report : undefined;
      if (!rep || !rep.ok || !rep.boxed?.length) this.tidyAfter = t + TIDY_BACKOFF_MS;
    } else {
      this.stats.unloads++;
      if (forGet) {
        this.stats.getUnloads++;
        this.forGet = false;
        this.getWaiting = false;
        if (r?.kind === 'unload') this.d.onGetUnload?.(r.report);
      }
      const rep = r?.kind === 'unload' ? r.report : undefined;
      if (!rep || !rep.ok || rep.left.length > 0 || rep.moved.length === 0) this.unloadAfter = t + UNLOAD_BACKOFF_MS;
    }
    this.d.log?.info(`home chore: ${job.kind} done`);
    this.yieldControl();
  }

  protected halt(): void {
    // a job that just ended gives control back without cancelling anything
    if (!this.running) return;
    this.running = false;
    this.d.runner.cancel();
  }

  protected override reset(): void {
    this.running = false;
    this.job = undefined;
  }

  behaviour(): string {
    return this.job?.kind === 'unload' ? 'unloading at home' : this.job?.kind === 'tidy' ? 'boxing full stacks in the chests at home' : 'reading the chests at home';
  }

  status(): ProcessStatus {
    const j = this.job;
    return { line: `home chore: ${j ? (j.kind === 'unload' ? 'unloading' : j.kind === 'tidy' ? 'boxing full stacks in the chests' : `reading ${j.only ? j.only.length : 'all'} containers`) : 'idle'}` };
  }
}
