// Food gathering as processes (PLAN.md task 7.16, Track X, docs/food.md).
//
// - `!food [n]` is a user process (priority 40): hunt passive food mobs until n food items were
//   picked up or none is left (never below `foodLeave` adults of a kind within 48 blocks), then cook
//   the raw food when a furnace or smoker is within 16 blocks of home and fuel is carried. Guard,
//   flee and night pre-empt it; it resumes with the next target.
// - `!cook` is a user process: walk to the furnace near home, cook every raw food carried.
// - The chore (auto, PRIORITY.chore 30, between user commands and the home return): when `autoFood`
//   is on, no user process exists, it is day, and the food carried totals fewer than `foodMin`
//   hunger points, the same hunt (+ cook) runs by itself. When an attempt found nothing it waits 10
//   minutes before the next one. At night it pauses (wants() is false) and goes on the next day.
// After a job the bot walks home (the home-return process) when a home is set and nothing is queued.
import type { RuntimeSettings } from '../../config/settings.ts';
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { CookResult, Cooker } from '../../skills/food/cook.ts';
import { inventoryFoodPoints, rawFoodCounts } from '../../skills/food/finder.ts';
import type { Hunter, HuntResult } from '../../skills/food/hunter.ts';
import type { ItemStack } from '../../world/types.ts';
import { stashFor } from '../../skills/container/stash.ts'; // Track AD
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus, type StopReason } from './manager.ts';

/** Hunt radius around where the job started. */
export const FOOD_RADIUS = 48;
/** After an attempt that found nothing: next try (ms). */
export const NOTHING_FOUND_BACKOFF_MS = 10 * 60_000;
/** After an attempt that found something but not enough: next try (ms). */
export const RETRY_MS = 30_000;
/** The chore checks its trigger at most this often (ms). */
const CHECK_MS = 1000;
/** Default `!food` count. */
export const DEFAULT_FOOD_ITEMS = 8;

export interface FoodDeps {
  processes: ProcessManager;
  settings: Pick<RuntimeSettings, 'get'>;
  hunter: Hunter;
  cooker: Cooker;
  /** Feet. */
  position(): Vec3;
  inventory: { readonly slots: readonly (ItemStack | null)[] };
  /** Day (the chore runs by day only). */
  isDay(): boolean;
  /** Cancel the running skill (fight, walk) on a pause / stop. */
  cancel(): void;
  /** After a job: walk home if one is set and nothing is queued. */
  afterJob?(): void;
  log?: Logger;
  now?: () => number;
}

export interface FoodJobResult {
  ok: boolean;
  reason: string;
  gained: number;
  killed: number;
  kinds: Record<string, number>;
  cook?: CookResult | undefined;
}

/** One hunt-then-cook job (shared by `!food`, `!cook` and the chore); resumable after a pause. */
export class FoodJob {
  phase: 'hunt' | 'cook' | 'done' = 'hunt';
  gained = 0;
  killed = 0;
  readonly kinds: Record<string, number> = {};
  huntReason = '';
  cookResult: CookResult | undefined;
  center: Vec3 | undefined;
  readonly want: number;
  readonly opts: { hunt: boolean; cook: boolean };

  constructor(want: number, opts: { hunt: boolean; cook: boolean }) {
    this.want = want;
    this.opts = opts;
    if (!opts.hunt) this.phase = 'cook';
  }

  /** Track AD: the inventory stayed full after the stash step: the job is over. */
  private full(): boolean {
    this.huntReason = 'inventory_full';
    this.phase = 'done';
    return true;
  }

  /** Run (or go on) until done or cancelled. Returns true when the job is over. */
  async run(d: FoodDeps, cancelled: () => boolean): Promise<boolean> {
    if (this.phase === 'hunt') {
      this.center ??= d.position();
      // Track AD: the stash step (skills/container/stash.ts, docs/get.md); still full: the job ends
      if (!((await stashFor(d.processes)?.ifFull({ label: 'food' })) ?? true) && !cancelled()) return this.full();
      const r: HuntResult = await d.hunter.hunt(
        {
          want: this.want - this.gained,
          center: this.center,
          radius: FOOD_RADIUS,
          leave: () => d.settings.get('foodLeave'),
        },
        cancelled,
      );
      this.gained += r.gained;
      this.killed += r.killed;
      for (const [k, v] of Object.entries(r.kinds)) this.kinds[k] = (this.kinds[k] ?? 0) + v;
      if (r.reason === 'interrupted') return false;
      this.huntReason = r.reason;
      this.phase = this.opts.cook ? 'cook' : 'done';
    }
    if (this.phase === 'cook') {
      if (rawFoodCounts(d.inventory.slots).size > 0 && (d.cooker.canCook() || !this.opts.hunt)) {
        const r = await d.cooker.cook({}, cancelled);
        if (r.reason === 'interrupted') {
          if (cancelled()) return false;
        }
        this.cookResult = mergeCook(this.cookResult, r);
      }
      this.phase = 'done';
    }
    return true;
  }

  result(): FoodJobResult {
    const cook = this.cookResult;
    const ok = this.opts.hunt ? this.gained >= this.want : (cook?.ok ?? false);
    return { ok, reason: this.opts.hunt ? this.huntReason || 'interrupted' : (cook?.reason ?? 'nothing_to_cook'), gained: this.gained, killed: this.killed, kinds: { ...this.kinds }, cook };
  }

  line(d: FoodDeps): string {
    if (this.phase === 'cook') return d.cooker.phase === 'idle' ? 'cooking' : d.cooker.phase;
    if (!this.opts.hunt) return 'cook';
    const t = d.hunter.current;
    return `food ${this.gained}/${this.want} items${t ? ` (hunting ${t.kind})` : ''}`;
  }
}

function mergeCook(a: CookResult | undefined, b: CookResult): CookResult {
  if (!a) return b;
  const cooked = { ...a.cooked };
  for (const [k, v] of Object.entries(b.cooked)) cooked[k] = (cooked[k] ?? 0) + v;
  const fuel = { ...a.fuel };
  for (const [k, v] of Object.entries(b.fuel)) fuel[k] = (fuel[k] ?? 0) + v;
  return { ...b, cooked, fuel, ticks: a.ticks + b.ticks };
}

/** `!food [n]` and `!cook`: a user process around one FoodJob. */
export class FoodProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name: string;
  readonly result: Promise<FoodJobResult>;
  private resolve!: (r: FoodJobResult) => void;
  readonly job: FoodJob;
  private readonly d: FoodDeps;

  constructor(d: FoodDeps, job: FoodJob) {
    super();
    this.d = d;
    this.job = job;
    this.name = job.opts.hunt ? 'food' : 'cook';
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
        this.d.afterJob?.();
      },
      (err: unknown) => {
        this.d.log?.warn(`food: ${err instanceof Error ? err.message : String(err)}`);
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
    return this.job.line(this.d);
  }

  status(): ProcessStatus {
    return { line: this.job.line(this.d) };
  }
}

/** The automatic food chore (auto, PRIORITY.chore). Registered once; never done. */
export class FoodChore extends BaseProcess {
  readonly kind = 'auto' as const;
  readonly name = 'food';
  private job: FoodJob | undefined;
  private lastCheck = -Infinity;
  /** No new attempt before this time (ms, deps.now()). */
  nextTry = -Infinity;
  /** Attempts started / that found nothing, the last result. */
  readonly stats = { started: 0, nothingFound: 0, finished: 0 };
  last: FoodJobResult | undefined;
  private readonly now: () => number;
  private readonly d: FoodDeps;

  constructor(d: FoodDeps) {
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

  /** The trigger's view of things, for `!food status`. */
  check(): { auto: boolean; points: number; min: number; day: boolean; users: number; waitS: number } {
    const d = this.d;
    return {
      auto: d.settings.get('autoFood'),
      points: inventoryFoodPoints(d.inventory.slots),
      min: d.settings.get('foodMin'),
      day: d.isDay(),
      users: d.processes.userProcesses().length,
      waitS: Math.max(0, Math.ceil((this.nextTry - this.now()) / 1000)),
    };
  }

  override wants(): boolean {
    if (this.job) return this.d.isDay();
    const now = this.now();
    if (now - this.lastCheck < CHECK_MS || now < this.nextTry) return false;
    this.lastCheck = now;
    const c = this.check();
    if (!c.auto || !c.day || c.users > 0 || c.points >= c.min) return false;
    const center = this.d.position();
    if (!this.d.hunter.peek({ center, radius: FOOD_RADIUS, leave: () => this.d.settings.get('foodLeave') })) {
      this.nextTry = now + NOTHING_FOUND_BACKOFF_MS;
      this.stats.nothingFound++;
      this.d.log?.info(`food chore: ${c.points} food points carried (< ${c.min}), nothing to hunt within ${FOOD_RADIUS} blocks (${this.d.hunter.herdLine(center, FOOD_RADIUS)}; keeping ${this.d.settings.get('foodLeave')} of each); next look in 10 min`);
      return false;
    }
    // aim at twice the minimum (raw beef is 3 points)
    const want = Math.max(4, Math.ceil((2 * c.min - c.points) / 3));
    this.job = new FoodJob(want, { hunt: true, cook: true });
    this.job.center = center;
    this.stats.started++;
    this.d.log?.info(`food chore: ${c.points} food points carried (< ${c.min}), hunting ${want} items`);
    return true;
  }

  /** Drop the current attempt (a `!food` / `!cook` from the owner replaces it). */
  drop(): void {
    if (!this.job) return;
    this.job = undefined;
    this.token++;
    if (this.controlled) this.d.cancel();
  }

  protected run(t: number): void {
    const job = this.job;
    if (!job) return;
    void job.run(this.d, () => t !== this.token || this.job !== job).then(
      (over) => {
        if (!over || this.job !== job) return;
        this.end(job);
      },
      (err: unknown) => {
        this.d.log?.warn(`food chore: ${err instanceof Error ? err.message : String(err)}`);
        if (this.job === job) this.end(job);
      },
    );
  }

  private end(job: FoodJob): void {
    this.job = undefined;
    const r = job.result();
    this.last = r;
    this.stats.finished++;
    this.nextTry = this.now() + (r.gained === 0 ? NOTHING_FOUND_BACKOFF_MS : RETRY_MS);
    if (r.gained === 0) this.stats.nothingFound++;
    this.d.log?.info(`food chore: done, ${r.gained} items from ${r.killed} kills (${r.reason})${r.cook ? `, cook ${r.cook.reason}` : ''}`);
    this.d.afterJob?.();
  }

  protected halt(): void {
    this.d.cancel();
  }

  protected override reset(): void {
    this.job = undefined;
  }

  behaviour(): string {
    return this.job ? `${this.job.line(this.d)} (auto)` : 'food (auto)';
  }

  status(): ProcessStatus {
    return { line: this.behaviour() };
  }
}

/** Builds the chore and starts `!food` / `!cook` jobs. */
export class FoodController {
  readonly chore: FoodChore;
  private readonly log: Logger;
  readonly d: FoodDeps;

  constructor(d: FoodDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.chore = d.processes.add(new FoodChore(d));
  }

  /** `!food [n]`. */
  food(n: number): FoodProcess {
    this.chore.drop();
    this.log.info(`food: gathering ${n} food items`);
    return this.d.processes.add(new FoodProcess(this.d, new FoodJob(n, { hunt: true, cook: true })));
  }

  /** `!cook`. */
  cook(): FoodProcess {
    this.chore.drop();
    return this.d.processes.add(new FoodProcess(this.d, new FoodJob(0, { hunt: false, cook: true })));
  }

  dispose(): void {
    this.d.processes.stop(this.chore);
  }
}
