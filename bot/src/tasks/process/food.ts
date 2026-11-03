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
//
// Track AF (wave 8, food v2, docs/food.md, decision 0027):
// - remembered herds: when nothing is left within 48 blocks, the job walks to the nearest herd mark
//   within 200 blocks that offers something (skills/food/herds.ts) and hunts there; at most 4 trips.
// - pens: penned animals are taken only from the `chorePen` pen or with `!food n pen`, never below 2
//   adults of a kind; the leave rule counts wild animals only.
// - `!breed [type] [n]` (BreedProcess, user) and the breeding chore (BreedChore, auto, PRIORITY.chore,
//   below the food chore): with `autoBreed` on it breeds the `chorePen` pen once per 10 minutes when a
//   kind there has fewer than 8 adults and the bot carries its food.
import type { RuntimeSettings } from '../../config/settings.ts';
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { CookResult, Cooker } from '../../skills/food/cook.ts';
import { inventoryFoodPoints, rawFoodCounts } from '../../skills/food/finder.ts';
import type { Hunter, HuntResult } from '../../skills/food/hunter.ts';
import { breedFoodOf, breedItemCount, type Breeder, type BreedResult } from '../../skills/food/breed.ts'; // Track AF
import { foodKindOf } from '../../skills/food/finder.ts'; // Track AF
import { isPlayerEntity } from '../../skills/combat/hostiles.ts'; // Track AF
import { cellKey, HERD_RANGE, type HerdMemory } from '../../skills/food/herds.ts'; // Track AF
import type { Pen } from '../../skills/food/pen.ts'; // Track AF
import type { HerdMark } from '../../world/cache/herds.ts'; // Track AF
import type { EntityInfo, ItemStack } from '../../world/types.ts';
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
/** Track AF: walks to remembered herds per job. */
export const MAX_TRIPS = 4;
/** Track AF: the breeding chore's period (ms) and its target size (adults of a kind in the pen). */
export const BREED_PERIOD_MS = 10 * 60_000;
export const BREED_TARGET = 8;
/** Track AF: `!breed` looks for adults within this many blocks of the bot. */
export const BREED_RADIUS = 16;

/** Track AF: the `chorePen` setting as a block position, or undefined for `none`. */
export function parseChorePen(v: string): Vec3 | undefined {
  const n = v.trim().split(/\s+/).map(Number);
  if (n.length !== 3 || !n.every((x) => Number.isFinite(x))) return undefined;
  return { x: n[0]!, y: n[1]!, z: n[2]! };
}

export interface FoodDeps {
  /** Hunger points of the food inside the carried shulker boxes (Supply.carried): counted with the loose food by the chore. */
  boxedFoodPoints?(): number;
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
  /** Track AF: remembered herds (beyond 48 blocks). */
  herds?: HerdMemory | undefined;
  /** Track AF: the pen of the `chorePen` setting when its chunk is loaded (pen.ts). */
  chorePen?(): Pen | undefined;
  /** Track AF: wait n ticks (the tracker catches up after a walk). */
  waitTicks?(n: number): Promise<void>;
  /** Track AF: breeding (`!breed`, the breeding chore). */
  breeder?: Breeder | undefined;
  /** Track AF: the entity tracker and the pen of a mob (the breeding chore counts the pen's adults). */
  entities?: () => ReadonlyMap<bigint, EntityInfo>;
  penOf?(e: EntityInfo): Pen | undefined;
}

/** Track AF: may the hunt take penned animals of `pen`? `!food n pen` takes any pen, else only the chorePen pen. */
function penRule(d: FoodDeps, anyPen: boolean): (pen: Pen) => boolean {
  return (pen) => anyPen || pen.id === d.chorePen?.()?.id;
}

/** Track AF: may penned animals of a herd mark be taken? (the mark's cell holds the chorePen, or `!food n pen`). */
function markPenRule(d: FoodDeps, anyPen: boolean): (m: HerdMark) => boolean {
  return (m) => {
    if (anyPen) return true;
    const p = parseChorePen(d.settings.get('chorePen'));
    return p !== undefined && Math.floor(p.x) >> 4 === m.cx && Math.floor(p.z) >> 4 === m.cz;
  };
}

export interface FoodJobResult {
  ok: boolean;
  reason: string;
  gained: number;
  killed: number;
  kinds: Record<string, number>;
  cook?: CookResult | undefined;
  /** Track AF: walks to remembered herds (`x z: 120 blocks, reached in 31.2 s`). */
  trips?: string[];
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
  readonly opts: { hunt: boolean; cook: boolean; pens?: boolean };
  /** Track AF: the herd mark being walked to, cells already visited, trips made (log lines). */
  trip: HerdMark | undefined;
  readonly visited = new Set<string>();
  readonly trips: string[] = [];

  constructor(want: number, opts: { hunt: boolean; cook: boolean; pens?: boolean }) {
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
      const anyPen = this.opts.pens === true;
      for (;;) {
        if (!this.trip) {
          // Track AD: the stash step (skills/container/stash.ts, docs/get.md); still full: the job ends
          if (!((await stashFor(d.processes)?.ifFull({ label: 'food' })) ?? true) && !cancelled()) return this.full();
          const r: HuntResult = await d.hunter.hunt(
            {
              want: this.want - this.gained,
              center: this.center,
              radius: FOOD_RADIUS,
              leave: () => d.settings.get('foodLeave'),
              penAllowed: penRule(d, anyPen), // Track AF
            },
            cancelled,
          );
          this.gained += r.gained;
          this.killed += r.killed;
          for (const [k, v] of Object.entries(r.kinds)) this.kinds[k] = (this.kinds[k] ?? 0) + v;
          if (r.reason === 'interrupted') return false;
          this.huntReason = r.reason;
          // Track AF: nothing left in range: the nearest remembered herd within 200 blocks
          if (r.reason !== 'none_left' || this.gained >= this.want || !d.herds || this.trips.length >= MAX_TRIPS) break;
          const here = d.position();
          this.visited.add(cellKey(Math.floor(here.x) >> 4, Math.floor(here.z) >> 4));
          const m = d.herds.next(here, { leave: d.settings.get('foodLeave'), skip: this.visited, penAllowed: markPenRule(d, anyPen) });
          if (!m) break;
          this.trip = m;
          this.visited.add(cellKey(m.cx, m.cz));
          d.log?.info(`food: nothing left within ${FOOD_RADIUS} blocks; walking to the herd remembered at ${Math.round(m.x)} ${Math.round(m.y)} ${Math.round(m.z)} (${Math.round(Math.hypot(m.x - here.x, m.z - here.z))} blocks)`);
        }
        const m = this.trip;
        const from = d.position();
        const dist = Math.hypot(m.x - from.x, m.z - from.z);
        const t0 = performance.now();
        const w = await d.hunter.walkTo({ x: m.x, y: m.y, z: m.z }, 4, Math.max(600, Math.ceil(dist * 15)));
        if (cancelled()) return false; // paused or stopped: a resume walks on to the same mark
        this.trip = undefined;
        this.trips.push(`${Math.round(m.x)} ${Math.round(m.z)}: ${Math.round(dist)} blocks, ${w.ok ? 'reached' : w.reason} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        this.center = { x: m.x, y: m.y, z: m.z };
        await d.waitTicks?.(20); // the entity tracker catches up after the walk
        if (cancelled()) return false;
      }
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
    return { ok, reason: this.opts.hunt ? this.huntReason || 'interrupted' : (cook?.reason ?? 'nothing_to_cook'), gained: this.gained, killed: this.killed, kinds: { ...this.kinds }, cook, trips: [...this.trips] };
  }

  line(d: FoodDeps): string {
    if (this.phase === 'cook') return d.cooker.phase === 'idle' ? 'cooking' : d.cooker.phase;
    if (!this.opts.hunt) return 'cook';
    const t = d.hunter.current;
    if (this.trip) return `food ${this.gained}/${this.want} items (walking to the herd at ${Math.round(this.trip.x)} ${Math.round(this.trip.z)})`; // Track AF
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
      points: inventoryFoodPoints(d.inventory.slots) + (d.boxedFoodPoints?.() ?? 0),
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
    const leave = this.d.settings.get('foodLeave');
    const inRange = this.d.hunter.peek({ center, radius: FOOD_RADIUS, leave: () => leave, penAllowed: penRule(this.d, false) });
    // Track AF: a remembered herd within 200 blocks counts too
    const mark = inRange ? undefined : this.d.herds?.next(center, { leave, penAllowed: markPenRule(this.d, false) });
    if (!inRange && !mark) {
      this.nextTry = now + NOTHING_FOUND_BACKOFF_MS;
      this.stats.nothingFound++;
      this.d.log?.info(`food chore: ${c.points} food points carried (< ${c.min}), nothing to hunt within ${FOOD_RADIUS} blocks (${this.d.hunter.herdLine(center, FOOD_RADIUS)}; keeping ${leave} of each) and no herd remembered within ${HERD_RANGE}; next look in 10 min`);
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

  /** Track AF: the breeding chore (when a breeder is wired). */
  readonly breedChore: BreedChore | undefined;

  constructor(d: FoodDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.chore = d.processes.add(new FoodChore(d));
    this.breedChore = d.breeder ? d.processes.add(new BreedChore(d, this.chore)) : undefined; // Track AF
  }

  /** `!food [n] [pen]` (Track AF: `pens` lets the hunt take penned animals down to 2 adults of a kind). */
  food(n: number, pens = false): FoodProcess {
    this.chore.drop();
    this.breedChore?.drop();
    this.log.info(`food: gathering ${n} food items${pens ? ' (pens too)' : ''}`);
    return this.d.processes.add(new FoodProcess(this.d, new FoodJob(n, { hunt: true, cook: true, pens })));
  }

  /** Track AF: `!breed [type] [n]`. */
  breed(kind: string | undefined, pairs: number): BreedProcess | undefined {
    if (!this.d.breeder) return undefined;
    this.chore.drop();
    this.breedChore?.drop();
    this.log.info(`breed: ${pairs} pair(s) of ${kind ?? 'any kind'}`);
    return this.d.processes.add(new BreedProcess(this.d, { kind, pairs, center: this.d.position(), radius: BREED_RADIUS }));
  }

  /** `!cook`. */
  cook(): FoodProcess {
    this.chore.drop();
    this.breedChore?.drop();
    return this.d.processes.add(new FoodProcess(this.d, new FoodJob(0, { hunt: false, cook: true })));
  }

  dispose(): void {
    this.d.processes.stop(this.chore);
    if (this.breedChore) this.d.processes.stop(this.breedChore);
  }
}

// ---- Track AF: breeding ------------------------------------------------------------------------------

export interface BreedJobOptions {
  kind: string | undefined;
  pairs: number;
  center: Vec3;
  radius: number;
  pen?: Pen | undefined;
}

const NO_BREED: Omit<BreedResult, 'ok' | 'reason'> = { kind: undefined, fed: 0, pairs: 0, babies: 0, refused: 0, ms: 0 };

function mergeBreed(a: BreedResult | undefined, b: BreedResult): BreedResult {
  if (!a) return b;
  return { ...b, kind: b.kind ?? a.kind, fed: a.fed + b.fed, pairs: a.pairs + b.pairs, babies: a.babies + b.babies, refused: a.refused + b.refused, ms: a.ms + b.ms, ok: a.ok || b.ok };
}

/** `!breed [type] [n]`: a user process around Breeder.breed; after a pause it goes on with the pairs left. */
export class BreedProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name = 'breed';
  readonly result: Promise<BreedResult>;
  private resolve!: (r: BreedResult) => void;
  private sum: BreedResult | undefined;
  private readonly d: FoodDeps;
  readonly opts: BreedJobOptions;

  constructor(d: FoodDeps, opts: BreedJobOptions) {
    super();
    this.d = d;
    this.opts = opts;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    const breeder = this.d.breeder;
    if (!breeder) {
      this.finish();
      this.resolve({ ...NO_BREED, ok: false, reason: 'no_pair', kind: this.opts.kind });
      return;
    }
    const left = this.opts.pairs - (this.sum?.pairs ?? 0);
    void breeder.breed({ ...this.opts, kind: this.opts.kind ?? this.sum?.kind, pairs: Math.max(1, left) }, () => t !== this.token).then(
      (r) => {
        if (t !== this.token) {
          if (r.fed > 0) this.sum = mergeBreed(this.sum, { ...r, babies: 0 });
          return;
        }
        this.sum = mergeBreed(this.sum, r);
        this.finish();
        this.resolve(this.sum);
        this.d.afterJob?.();
      },
      (err: unknown) => {
        this.d.log?.warn(`breed: ${err instanceof Error ? err.message : String(err)}`);
        this.finish();
        this.resolve({ ...NO_BREED, ...this.sum, ok: false, reason: 'interrupted' });
      },
    );
  }

  protected halt(): void {
    this.d.cancel();
  }

  protected override onStopped(_reason: StopReason): void {
    this.resolve({ ...NO_BREED, kind: this.opts.kind, ...this.sum, ok: false, reason: 'interrupted' });
  }

  behaviour(): string {
    const c = this.d.breeder?.current;
    return `breed ${this.sum?.pairs ?? 0}/${this.opts.pairs} pairs${c ? ` (feeding ${c.kind})` : ''}`;
  }

  status(): ProcessStatus {
    return { line: this.behaviour() };
  }
}

export interface BreedPlan {
  kind: string;
  adults: number;
  breedable: number;
  pairs: number;
}

/**
 * The breeding chore (auto, PRIORITY.chore, after the food chore): with `autoBreed` on and a `chorePen`
 * within 200 blocks, by day, with no user process and the food chore idle, once per 10 minutes: walk to
 * the pen, then feed pairs of a kind that has fewer than 8 adults there (and 2+ breedable ones) and
 * whose food the bot carries, up to 8 adults. Registered once (persistent), never done.
 */
export class BreedChore extends BaseProcess {
  readonly kind = 'auto' as const;
  readonly name = 'breed';
  private job: { pos: Vec3 } | undefined;
  private lastCheck = -Infinity;
  /** No new attempt before this time (ms, deps.now()). */
  nextTry = -Infinity;
  readonly stats = { checks: 0, started: 0, finished: 0, skipped: 0 };
  last: BreedResult | undefined;
  /** Why the last check did not start (status). */
  lastWhy = '';
  private readonly now: () => number;
  private readonly d: FoodDeps;
  private readonly food: FoodChore;

  constructor(d: FoodDeps, food: FoodChore) {
    super();
    this.d = d;
    this.food = food;
    this.persistent = true;
    this.now = d.now ?? (() => performance.now());
  }

  get priority(): number {
    return PRIORITY.chore;
  }

  get running(): boolean {
    return this.job !== undefined;
  }

  /** What the pen offers now (loaded pen: the tracker; else the herd mark of its cell), or why nothing. */
  plan(pos: Vec3): BreedPlan | string {
    const d = this.d;
    const breeder = d.breeder;
    if (!breeder) return 'no breeder';
    const slots = d.inventory.slots;
    const pen = d.chorePen?.();
    const counts = new Map<string, { adults: number; breedable: number }>();
    if (pen && d.entities) {
      for (const [k, list] of breeder.candidates({ center: pos, radius: 16, pen })) counts.set(k, { adults: 0, breedable: list.length });
      for (const e of d.entities().values()) {
        const k = foodKindOf(e.type);
        if (!k || isPlayerEntity(e) || d.hunter.isBaby(e.runtimeId)) continue;
        if (Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z) > 16 || d.penOf?.(e)?.id !== pen.id) continue;
        const c = counts.get(k) ?? { adults: 0, breedable: 0 };
        c.adults++;
        counts.set(k, c);
      }
    } else {
      const m = d.herds?.store.get(Math.floor(pos.x) >> 4, Math.floor(pos.z) >> 4);
      if (!m) return 'the pen is not in view and no herd is remembered there';
      for (const [k, c] of Object.entries(m.penned)) counts.set(k, { adults: c.adults, breedable: c.adults });
    }
    let best: BreedPlan | undefined;
    const why: string[] = [];
    for (const [kind, c] of counts) {
      const food = breedItemCount(slots, kind);
      if (c.adults >= BREED_TARGET) why.push(`${kind} ${c.adults} adults (${BREED_TARGET} wanted)`);
      else if (c.breedable < 2) why.push(`${kind} ${c.breedable} breedable`);
      else if (food < 2) why.push(`no ${breedFoodOf(kind).slice(0, 2).join(' or ')} for the ${kind}s`);
      else {
        const pairs = Math.max(1, Math.min(Math.floor(c.breedable / 2), BREED_TARGET - c.adults, Math.floor(food / 2)));
        if (!best || c.adults < best.adults) best = { kind, adults: c.adults, breedable: c.breedable, pairs };
      }
    }
    return best ?? (why.length ? why.join(', ') : 'no animals in the pen');
  }

  override wants(): boolean {
    if (this.job) return this.d.isDay();
    const now = this.now();
    if (now - this.lastCheck < CHECK_MS || now < this.nextTry) return false;
    this.lastCheck = now;
    const d = this.d;
    if (!d.settings.get('autoBreed') || !d.breeder) return false;
    const pos = parseChorePen(d.settings.get('chorePen'));
    if (!pos) return false;
    if (!d.isDay() || d.processes.userProcesses().length > 0 || this.food.running) return false;
    this.stats.checks++;
    const me = d.position();
    const far = Math.hypot(pos.x - me.x, pos.z - me.z);
    const skip = (why: string): boolean => {
      this.lastWhy = why;
      this.stats.skipped++;
      this.nextTry = now + BREED_PERIOD_MS;
      d.log?.info(`breed chore: ${why}; next look in 10 min`);
      return false;
    };
    if (far > HERD_RANGE) return skip(`the pen is ${Math.round(far)} blocks away (more than ${HERD_RANGE})`);
    const p = this.plan(pos);
    if (typeof p === 'string') return skip(p);
    this.job = { pos };
    this.stats.started++;
    this.lastWhy = '';
    d.log?.info(`breed chore: ${p.kind} ${p.adults} adults in the pen (fewer than ${BREED_TARGET}), feeding ${p.pairs} pair(s)`);
    return true;
  }

  /** Drop the current attempt (a command replaces it). */
  drop(): void {
    if (!this.job) return;
    this.job = undefined;
    this.token++;
    if (this.controlled) this.d.cancel();
  }

  protected run(t: number): void {
    const job = this.job;
    if (!job) return;
    const cancelled = (): boolean => t !== this.token || this.job !== job;
    const go = async (): Promise<BreedResult | undefined> => {
      const d = this.d;
      const me = d.position();
      const far = Math.hypot(job.pos.x - me.x, job.pos.z - me.z);
      if (far > 8) {
        await d.hunter.walkTo(job.pos, 3, Math.max(600, Math.ceil(far * 15)));
        if (cancelled()) return undefined;
        await d.waitTicks?.(20);
        if (cancelled()) return undefined;
      }
      const p = this.plan(job.pos);
      if (typeof p === 'string') {
        this.lastWhy = p;
        return { ...NO_BREED, ok: false, reason: 'no_pair' };
      }
      return d.breeder!.breed({ kind: p.kind, pairs: p.pairs, center: job.pos, radius: 16, pen: d.chorePen?.() }, cancelled);
    };
    void go().then(
      (r) => {
        if (!r || cancelled()) return;
        this.end(r);
      },
      (err: unknown) => {
        this.d.log?.warn(`breed chore: ${err instanceof Error ? err.message : String(err)}`);
        if (this.job === job) this.end(undefined);
      },
    );
  }

  private end(r: BreedResult | undefined): void {
    this.job = undefined;
    this.last = r;
    this.stats.finished++;
    this.nextTry = this.now() + BREED_PERIOD_MS;
    this.d.log?.info(`breed chore: done, ${r ? `${r.pairs} pair(s), ${r.babies} baby(ies) (${r.reason})` : 'error'}`);
    this.d.afterJob?.();
  }

  protected halt(): void {
    this.d.cancel();
  }

  protected override reset(): void {
    this.job = undefined;
  }

  behaviour(): string {
    const c = this.d.breeder?.current;
    return this.job ? `breeding${c ? ` ${c.kind}` : ''} (auto)` : 'breed (auto)';
  }

  status(): ProcessStatus {
    return { line: this.behaviour() };
  }
}
