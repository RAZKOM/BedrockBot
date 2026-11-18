// A starter farm as processes (Track E6, docs/farming.md "A starter farm", ADR 0102).
//
// - FarmNewProcess (user, priority 40): the plot work of `!farm new` (skills/farm/setup.ts FarmPlotJob: seeds, water,
//   clear, till, plant, fence). Guard, flee and night pre-empt it; a resume goes on with the phase it was in.
// - FarmChore (auto, PRIORITY.chore, the `farmFood` setting, default off: it digs crops and places seeds): by day, with no
//   user process and the food chore idle, at the bot's own farm (the `farm` waypoint within FARM_CHORE_RANGE): when
//   FARM_RIPE crops (or a quarter of the crops) are ripe, or the food carried is under `foodMin` and the ripe crops and
//   the wheat carried make a loaf, it harvests and replants the field (the farmer's loop) and crafts bread from the wheat.
//   The food chore lets it go first (`farmFirst`): the hunt runs only when the farm has nothing to give.
import type { RuntimeSettings } from '../../config/settings.ts';
import type { Vec3 } from '../../connection/types.ts';
import type { Logger } from '../../log.ts';
import type { FarmOptions, FarmState } from '../../skills/farm/farmer.ts';
import type { FarmPlotJob, PlotJobDeps } from '../../skills/farm/setup.ts';
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus, type StopReason } from './manager.ts';

/** The chore works a farm whose middle is within this many blocks of the bot. */
export const FARM_CHORE_RANGE = 64;
/** Ripe crops that start a harvest whatever the food carried (or a quarter of the crops when that is fewer). */
export const FARM_RIPE = 16;

/**
 * The ripe crops that start a harvest: FARM_RIPE, or a quarter of the crops when that is fewer. The crops, not the
 * farmland: a watered 9 x 9 keeps its 80 cells tilled with 21 seeds planted (a fresh world), and a quarter of the 80
 * asked for 16 of the 21.
 */
export function ripeMinOf(field: { cells: number; crops?: number }): number {
  return Math.max(1, Math.min(FARM_RIPE, Math.ceil((field.crops ?? field.cells) / 4)));
}
/** Wheat a loaf takes. */
export const BREAD_WHEAT = 3;
/**
 * The ripe crops that start a harvest while food is short: as many as make a loaf with the wheat carried. One ripe
 * crop used to be enough, and on a fresh world the bot walked 25 blocks out for 1 wheat and no bread while the hunt
 * waited for it.
 */
export function hungryRipeOf(wheat: number): number {
  return Math.max(1, BREAD_WHEAT - wheat);
}
/** The chore looks at the field at most this often (ms), and after a run that got nothing waits this long. */
const CHECK_MS = 5000;
export const FARM_IDLE_MS = 5 * 60_000;

export interface FarmNewResult {
  ok: boolean;
  reason: string;
}

export class FarmNewProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name = 'farmnew';
  readonly result: Promise<FarmNewResult>;
  private resolve!: (r: FarmNewResult) => void;
  readonly job: FarmPlotJob;
  private readonly d: PlotJobDeps & { cancel(): void };

  constructor(d: PlotJobDeps & { cancel(): void }, job: FarmPlotJob) {
    super();
    this.d = d;
    this.job = job;
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
        this.resolve({ ok: !this.job.stop, reason: this.job.stop ?? 'done' });
      },
      (err: unknown) => {
        this.d.log?.warn(`farm new: ${err instanceof Error ? err.message : String(err)}`);
        this.finish();
        this.resolve({ ok: false, reason: 'error' });
      },
    );
  }

  protected halt(): void {
    this.job.halt(this.d);
    this.d.cancel();
  }

  protected override onStopped(_reason: StopReason): void {
    this.resolve({ ok: false, reason: 'interrupted' });
  }

  behaviour(): string {
    return `farm new: ${this.job.phase}`;
  }

  status(): ProcessStatus {
    const s = this.job.stats;
    return { line: `farm new ${this.job.site.n}x${this.job.site.n} at ${this.job.site.water.x} ${this.job.site.water.y} ${this.job.site.water.z}: ${this.job.phase} (${s.grassBroken} grass, ${s.tilled} tilled, ${s.planted} planted, ${s.fenced} fences)` };
  }
}

/** What the farm chore sees and does (the chat side wires it to the world, the farmer and the crafter). */
export interface FarmChoreDeps {
  processes: ProcessManager;
  settings: Pick<RuntimeSettings, 'get'>;
  /** The bot's own farm: the water cell in its middle and its size, or undefined. */
  farm(): { water: Vec3; n: number } | undefined;
  position(): Vec3 | undefined;
  isDay(): boolean;
  /** Food points carried (the food chore's count). */
  foodPoints(): number;
  /** Ripe crops and farmland cells of the field round `water` (loaded cells only); undefined when not loaded. */
  field(water: Vec3, n: number): { ripe: number; cells: number; crops?: number } | undefined;
  wheat(): number;
  /** The food chore runs now. */
  foodBusy(): boolean;
  farmer: { start(o: FarmOptions): Promise<FarmState>; stop(): void; readonly stats: { harvested: number; planted: number } };
  /**
   * Pick up the drops that fell into the middle water cell (the farmer's pickup walks into the hole and times out),
   * from the cells beside it; how many were picked up.
   */
  pickMiddle?(water: Vec3, cancelled: () => boolean): Promise<number>;
  /** Craft bread from the wheat carried (all of it); the loaves made. */
  bread(cancelled: () => boolean): Promise<number>;
  cancel(): void;
  afterJob?(): void;
  now?: () => number;
  log?: Logger;
}

export class FarmChore extends BaseProcess {
  readonly kind = 'auto' as const;
  /** Not `farm`: that is `!farm`'s own process, and lookups by name (`processes.find('farm')`) must find it alone. */
  readonly name = 'farmchore';
  private job: { water: Vec3; n: number; got: number; why: string } | undefined;
  private lastCheck = -Infinity;
  nextTry = -Infinity;
  readonly stats = { started: 0, harvested: 0, planted: 0, bread: 0, finished: 0 };
  /** The last check's reason (status). */
  lastWhy = '';
  private readonly d: FarmChoreDeps;
  private readonly now: () => number;
  private phase: 'farm' | 'bread' = 'farm';

  constructor(d: FarmChoreDeps) {
    super();
    this.d = d;
    this.persistent = true;
    this.now = d.now ?? (() => performance.now());
  }

  get priority(): number {
    return PRIORITY.chore;
  }

  get running(): boolean {
    return this.job !== undefined;
  }

  /** Food is short and the farm can give some now (the food chore's `farmFirst`). */
  canFeed(): boolean {
    const d = this.d;
    if (!d.settings.get('farmFood')) return false;
    if (this.job) return true;
    if (this.now() < this.nextTry) return false; // after a run that got nothing the hunt goes first
    if (d.wheat() >= BREAD_WHEAT) return true;
    const f = d.farm();
    const me = d.position();
    if (!f || !me || Math.hypot(f.water.x - me.x, f.water.z - me.z) > FARM_CHORE_RANGE) return false;
    return (d.field(f.water, f.n)?.ripe ?? 0) >= hungryRipeOf(d.wheat());
  }

  /** Why the chore would or would not run now (`!farm status`). */
  why(): string {
    const d = this.d;
    if (!d.settings.get('farmFood')) return 'farmFood off';
    const f = d.farm();
    if (!f) return 'no farm (!farm new)';
    const me = d.position();
    if (!me) return 'not spawned';
    const far = Math.hypot(f.water.x - me.x, f.water.z - me.z);
    if (far > FARM_CHORE_RANGE) return `the farm is ${Math.round(far)} blocks away (more than ${FARM_CHORE_RANGE})`;
    const field = d.field(f.water, f.n);
    if (!field) return 'the farm is not loaded';
    const ripeMin = ripeMinOf(field);
    const hungry = d.foodPoints() < d.settings.get('foodMin');
    return `${field.ripe} of ${field.crops ?? field.cells} ripe (${hungry ? `food short: ${hungryRipeOf(d.wheat())}` : `${ripeMin}`} start a harvest), ${d.wheat()} wheat carried`;
  }

  override wants(): boolean {
    if (this.job) return this.d.isDay();
    const now = this.now();
    if (now - this.lastCheck < CHECK_MS || now < this.nextTry) return false;
    this.lastCheck = now;
    const d = this.d;
    if (!d.settings.get('farmFood') || !d.isDay() || d.processes.userProcesses().length > 0 || d.foodBusy()) return false;
    const f = d.farm();
    const me = d.position();
    if (!f || !me) return false;
    const hungry = d.foodPoints() < d.settings.get('foodMin');
    const far = Math.hypot(f.water.x - me.x, f.water.z - me.z);
    const field = far <= FARM_CHORE_RANGE ? d.field(f.water, f.n) : undefined;
    const ripe = field?.ripe ?? 0;
    const ripeMin = field ? ripeMinOf(field) : 1;
    let why: string | undefined;
    if (field && ripe >= ripeMin) why = `${ripe} of ${field.crops ?? field.cells} crops ripe`;
    else if (hungry && field && ripe >= hungryRipeOf(d.wheat())) why = `${d.foodPoints()} food points carried (< ${d.settings.get('foodMin')}), ${ripe} crops ripe`;
    else if (hungry && d.wheat() >= BREAD_WHEAT) why = `${d.foodPoints()} food points carried, ${d.wheat()} wheat for bread`;
    if (!why) {
      this.lastWhy = this.why();
      return false;
    }
    this.job = { water: f.water, n: f.n, got: 0, why };
    this.phase = field && ripe > 0 ? 'farm' : 'bread';
    this.stats.started++;
    d.log?.info(`farm chore: ${why}: ${this.phase === 'farm' ? 'harvesting the farm' : 'baking'}`);
    return true;
  }

  protected run(t: number): void {
    const job = this.job;
    if (!job) return;
    const cancelled = (): boolean => t !== this.token || this.job !== job;
    const go = async (): Promise<boolean> => {
      const d = this.d;
      if (this.phase === 'farm') {
        // the farmer's counters start at 0 with every run (FarmTask.start)
        const work = async (): Promise<void> => {
          await d.farmer.start({ center: { x: job.water.x + 0.5, y: job.water.y + 1, z: job.water.z + 0.5 }, radius: (job.n - 1) / 2 + 1, follow: true, maxRange: 4 });
          job.got += d.farmer.stats.harvested;
          this.stats.harvested += d.farmer.stats.harvested;
          this.stats.planted += d.farmer.stats.planted;
        };
        await work();
        if (cancelled()) return false;
        // measured (e2e): 24 harvested, 12 wheat and 10 seeds floating in the middle water, 13 replanted, 4 bread
        const picked = d.pickMiddle ? await d.pickMiddle(job.water, cancelled) : 0;
        if (cancelled()) return false;
        if (picked > 0) {
          await work(); // the seeds picked up plant the cells left bare
          if (cancelled()) return false;
        }
        this.phase = 'bread';
      }
      if (d.wheat() >= BREAD_WHEAT) {
        const n = await d.bread(cancelled);
        this.stats.bread += n;
        if (cancelled()) return false;
      }
      return true;
    };
    void go().then(
      (over) => {
        if (!over || this.job !== job) return;
        this.end(job);
      },
      (err: unknown) => {
        this.d.log?.warn(`farm chore: ${err instanceof Error ? err.message : String(err)}`);
        if (this.job === job) this.end(job);
      },
    );
  }

  private end(job: { got: number }): void {
    this.job = undefined;
    this.stats.finished++;
    const got = job.got;
    this.nextTry = this.now() + (got > 0 ? CHECK_MS : FARM_IDLE_MS);
    this.d.log?.info(`farm chore: done, ${got} harvested, ${this.d.wheat()} wheat and the bread baked (${this.stats.bread} loaves so far)`);
    this.d.afterJob?.();
  }

  /** Drop the current run (a command replaces it). */
  drop(): void {
    if (!this.job) return;
    this.job = undefined;
    this.token++;
    if (this.controlled) this.halt();
  }

  protected halt(): void {
    if (this.phase === 'farm') this.d.farmer.stop();
    this.d.cancel();
  }

  protected override reset(): void {
    this.job = undefined;
  }

  behaviour(): string {
    return this.job ? `farm: ${this.phase === 'farm' ? 'harvesting' : 'baking'} (auto)` : 'farm (auto)';
  }

  status(): ProcessStatus {
    return { line: this.behaviour() };
  }
}
