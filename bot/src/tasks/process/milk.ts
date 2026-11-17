// Track K1 (ADR 0096, docs/pve.md "Milk on hand"): milk on hand for `milkCure` (tasks/pve.ts), as processes:
//
// - MilkJob: one pass of the stock rule (skills/food/milk.ts planMilk) through the existing machinery: milk and empty
//   buckets out of the carried boxes (Supply.ensure), out of the chests at home when the bot is there (Supply.ensure's
//   home route, `!bring`'s withdrawal), one bucket crafted from 3 iron ingots with no bucket anywhere (the crafter, at a
//   table near or a carried one), then the empty buckets filled at the cows, mooshrooms and goats within MILK_RADIUS
//   (the Milker: the normal walk and its safety rules).
// - MilkProcess (user, `!milk [n]`): fills every empty bucket carried and stocks up to `milkKeep` (or n); guard, night and
//   flee pre-empt it like any command and it plans again afterwards.
// - MilkChore (auto, PRIORITY.chore, `autoMilk`, default off): by day, no user process, the bot within MILK_HOME of home
//   and no hostile within MILK_THREAT, with fewer than `milkKeep` milk buckets: the same pass around home. An attempt that
//   gained nothing (no cow near, no bucket and no iron) waits 10 minutes; one that gained milk 30 s. After it the home
//   return walks home.
// - The trip readiness (tasks/pve.ts tripStocks, wired by chat/commands-milk.ts): before a long trip, the same pass with no
//   cows and no craft (milk out of the boxes, and out of the chests when at home).
import type { Vec3 } from '../../connection/types.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { BUCKET, bucketCounts, kindsLine, MILK, MILK_RADIUS, planMilk, type MilkReason, type MilkResult, type MilkStockInput } from '../../skills/food/milk.ts';
import type { EntityInfo, ItemStack } from '../../world/types.ts';
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus, type StopReason } from './manager.ts';

/** The chore runs only with the bot this near home (blocks, horizontal). */
export const MILK_HOME = 16;
/** The chore checks once a second. */
const CHECK_MS = 1000;
/** After an attempt that gained nothing: the next look (ms). */
export const MILK_BACKOFF_MS = 10 * 60_000;
/** After an attempt that gained milk (ms). */
export const MILK_RETRY_MS = 30_000;

/** The storage and craft side of the stock rule (chat/commands-milk.ts wires Supply, the home logistics and the crafter). */
export interface MilkSource {
  /** What the stock rule reads now, for `keep`. */
  input(keep: number): MilkStockInput;
  /** n more of `item` loose out of the carried boxes; how many came and why fewer. */
  fromBoxes(item: string, n: number, cancelled: () => boolean): Promise<{ got: number; why?: string | undefined }>;
  /** n more of `item` loose out of the carried boxes, then the chests at home (walks there). */
  fromHome(item: string, n: number, cancelled: () => boolean): Promise<{ got: number; why?: string | undefined }>;
  /** One bucket from 3 iron ingots at a crafting table (the crafter's reply line). */
  craft(cancelled: () => boolean): Promise<{ ok: boolean; line: string }>;
}

export interface MilkDeps {
  processes: ProcessManager;
  settings: Pick<RuntimeSettings, 'get'>;
  milker: { milk(o: { center: Vec3; radius: number; want: number }, cancelled: () => boolean): Promise<MilkResult>; targets(center: Vec3, radius: number): EntityInfo[]; readonly current?: { kind: string } | undefined };
  source: MilkSource;
  /** Feet. */
  position(): Vec3;
  home(): Vec3 | undefined;
  inventory: { readonly slots: readonly (ItemStack | null)[] };
  /** Day (the chore runs by day only). */
  isDay(): boolean;
  /** A hostile near (name and distance), or undefined. */
  threat(): string | undefined;
  /** Cancel the running skill (walk, withdrawal, craft) on a pause / stop. */
  cancel(): void;
  /** After a chore's attempt: walk home when nothing is queued. */
  afterJob?(): void;
  /** The chore may start (not while a `!test` series or a `!test inv` save holds the bot); default true. */
  idle?(): boolean;
  log?: Logger;
  now?: () => number;
}

export interface MilkReport {
  ok: boolean;
  /** The target count of milk buckets and the counts before and after. */
  keep: number;
  before: number;
  after: number;
  /** Empty buckets carried after. */
  empty: number;
  fromBoxes: number;
  fromHome: number;
  crafted: number;
  milked: number;
  kinds: Record<string, number>;
  /** Why it stopped short of `keep` (the plan's short, a source's why, the milker's reason). */
  short?: string;
  /** The milker ended on a hostile, or the pass was interrupted. */
  reason: 'done' | 'short' | 'hostile' | 'interrupted';
}

export interface MilkJobOptions {
  /** Milk buckets wanted carried. */
  keep: number;
  /** Fill buckets at the cows (and fetch or craft buckets for them); false: storage only (the trip readiness). */
  cows: boolean;
  /** Where the mobs are looked for (the bot for `!milk`, home for the chore) and how far. */
  center: () => Vec3;
  radius: number;
}

const MILK_WHY: Readonly<Partial<Record<MilkReason, string>>> = {
  no_bucket: 'no empty bucket left',
  no_mob: `no cow, mooshroom or goat within ${MILK_RADIUS} blocks`,
  refused: 'the mobs near gave no milk',
};

/** One pass of the stock rule (see the file comment). */
export class MilkJob {
  readonly opts: MilkJobOptions;
  phase = 'planning';
  constructor(opts: MilkJobOptions) {
    this.opts = opts;
  }

  async run(d: MilkDeps, cancelled: () => boolean): Promise<MilkReport> {
    const o = this.opts;
    const counts = () => bucketCounts(d.inventory.slots);
    const before = counts().milk;
    const rep: MilkReport = { ok: false, keep: o.keep, before, after: before, empty: counts().empty, fromBoxes: 0, fromHome: 0, crafted: 0, milked: 0, kinds: {}, reason: 'done' };
    const end = (reason?: MilkReport['reason']): MilkReport => {
      const c = counts();
      rep.after = c.milk;
      rep.empty = c.empty;
      rep.reason = reason ?? (rep.after >= o.keep ? 'done' : 'short');
      rep.ok = rep.after >= o.keep || rep.after > rep.before;
      this.phase = 'done';
      return rep;
    };
    const plan = planMilk(d.source.input(o.keep), { cows: o.cows });
    if (plan.short) rep.short = plan.short;
    for (const step of plan.steps) {
      if (cancelled()) return end('interrupted');
      if (step.kind === 'boxes' || step.kind === 'home') {
        this.phase = `${step.item === MILK ? 'milk' : 'buckets'} out of ${step.kind === 'boxes' ? 'a carried box' : 'the chests at home'}`;
        const r = step.kind === 'boxes' ? await d.source.fromBoxes(step.item, step.n, cancelled) : await d.source.fromHome(step.item, step.n, cancelled);
        if (step.item === MILK) {
          if (step.kind === 'boxes') rep.fromBoxes += r.got;
          else rep.fromHome += r.got;
        }
        if (r.got < step.n && r.why) rep.short ??= `${step.item}: ${r.why}`;
        continue;
      }
      if (step.kind === 'craft') {
        this.phase = 'crafting a bucket';
        const r = await d.source.craft(cancelled);
        if (r.ok) rep.crafted++;
        else {
          rep.short = `no bucket: ${r.line}`;
          break;
        }
        continue;
      }
      // the cows: as many as the empty buckets carried now and the milk still missing
      const c = counts();
      const want = Math.min(c.empty, Math.max(0, o.keep - c.milk));
      if (want <= 0) continue;
      this.phase = 'milking';
      const r = await d.milker.milk({ center: o.center(), radius: o.radius, want }, cancelled);
      rep.milked += r.milked;
      for (const [k, v] of Object.entries(r.kinds)) rep.kinds[k] = (rep.kinds[k] ?? 0) + v;
      if (r.reason === 'interrupted') return end('interrupted');
      if (r.reason === 'hostile') {
        rep.short = `stopped for ${r.threat ?? 'a hostile'}`;
        return end('hostile');
      }
      if (r.milked < want) rep.short = MILK_WHY[r.reason] ?? rep.short ?? r.reason;
    }
    return end();
  }

  line(): string {
    return `milk (${this.phase})`;
  }
}

/** `milk: 2 milk buckets carried (1 out of a carried box, 1 from a cow)` and what stood in the way. */
export function milkReply(r: MilkReport): string {
  const got: string[] = [];
  if (r.fromBoxes > 0) got.push(`${r.fromBoxes} out of a carried box`);
  if (r.fromHome > 0) got.push(`${r.fromHome} from the chests at home`);
  if (r.crafted > 0) got.push(`a bucket crafted from 3 iron ingots`);
  if (r.milked > 0) got.push(kindsLine(r.kinds));
  const head = `milk: ${r.after} milk bucket${r.after === 1 ? '' : 's'} carried`;
  const what = got.length ? ` (${got.join(', ')})` : r.after === r.before ? ' (nothing new)' : '';
  const tail: string[] = [];
  if (r.reason === 'interrupted') tail.push('stopped');
  if (r.after < r.keep) tail.push(`${r.keep - r.after} short of ${r.keep}${r.short ? `: ${r.short}` : ''}`);
  if (r.empty > 0) tail.push(`${r.empty} empty bucket${r.empty === 1 ? '' : 's'} left`);
  return `${head}${what}${tail.length ? `; ${tail.join('; ')}` : ''}`;
}

/** `!milk [n]`: a user process around one MilkJob; after a pause it plans again from what it has. */
export class MilkProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name = 'milk';
  readonly result: Promise<MilkReport>;
  private resolve!: (r: MilkReport) => void;
  private readonly d: MilkDeps;
  private job: MilkJob;
  /** Milk buckets carried when the command came (a resumed pass reports from there). */
  private readonly startMilk: number;
  private readonly sum = { fromBoxes: 0, fromHome: 0, crafted: 0, milked: 0, kinds: {} as Record<string, number> };

  constructor(d: MilkDeps, opts: MilkJobOptions) {
    super();
    this.d = d;
    this.job = new MilkJob(opts);
    this.startMilk = bucketCounts(d.inventory.slots).milk;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    const job = new MilkJob(this.job.opts);
    this.job = job;
    void job.run(this.d, () => t !== this.token).then(
      (r) => {
        // what a pass did before a pause counts in the reply
        this.sum.fromBoxes += r.fromBoxes;
        this.sum.fromHome += r.fromHome;
        this.sum.crafted += r.crafted;
        this.sum.milked += r.milked;
        for (const [k, v] of Object.entries(r.kinds)) this.sum.kinds[k] = (this.sum.kinds[k] ?? 0) + v;
        if (t !== this.token) return;
        this.finish();
        this.resolve({ ...r, ...this.sum, kinds: { ...this.sum.kinds }, before: this.startMilk, ok: r.after >= r.keep || r.after > this.startMilk });
      },
      (err: unknown) => {
        this.d.log?.warn(`milk: ${err instanceof Error ? err.message : String(err)}`);
        this.finish();
        this.resolve(this.blank('interrupted'));
      },
    );
  }

  private blank(reason: MilkReport['reason']): MilkReport {
    const c = bucketCounts(this.d.inventory.slots);
    return { ok: false, keep: this.job.opts.keep, before: this.startMilk, after: c.milk, empty: c.empty, ...this.sum, kinds: { ...this.sum.kinds }, reason };
  }

  protected halt(): void {
    this.d.cancel();
  }

  protected override onStopped(_reason: StopReason): void {
    this.resolve(this.blank('interrupted'));
  }

  behaviour(): string {
    return this.job.line();
  }

  status(): ProcessStatus {
    return { line: this.job.line() };
  }
}

/** The background refill (auto, PRIORITY.chore; see the file comment). Registered once; never done. */
export class MilkChore extends BaseProcess {
  readonly kind = 'auto' as const;
  readonly name = 'milk';
  private job: MilkJob | undefined;
  private lastCheck = -Infinity;
  /** No new attempt before this time (ms, deps.now()). */
  nextTry = -Infinity;
  readonly stats = { checks: 0, started: 0, finished: 0, skipped: 0 };
  last: MilkReport | undefined;
  /** Why the last check did not start (status). */
  lastWhy = '';
  private readonly now: () => number;
  private readonly d: MilkDeps;

  constructor(d: MilkDeps) {
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

  override wants(): boolean {
    if (this.job) return this.d.isDay() && !this.d.threat();
    const now = this.now();
    if (now - this.lastCheck < CHECK_MS || now < this.nextTry) return false;
    this.lastCheck = now;
    const d = this.d;
    const keep = d.settings.get('milkKeep');
    if (!d.settings.get('autoMilk') || keep <= 0) return false;
    if (!d.isDay() || d.processes.userProcesses().length > 0 || !(d.idle?.() ?? true)) return false;
    const home = d.home();
    if (!home) {
      this.lastWhy = 'no home set';
      return false;
    }
    const me = d.position();
    if (Math.hypot(me.x - home.x, me.z - home.z) > MILK_HOME || d.threat()) return false;
    if (bucketCounts(d.inventory.slots).milk >= keep) return false;
    this.stats.checks++;
    const skip = (why: string): boolean => {
      this.lastWhy = why;
      this.stats.skipped++;
      this.nextTry = now + MILK_BACKOFF_MS;
      d.log?.info(`milk chore: ${why}; next look in 10 min`);
      return false;
    };
    const plan = planMilk(d.source.input(keep), { cows: true });
    if (plan.steps.length === 0) return skip(plan.short ?? 'nothing to do');
    const storage = plan.steps.some((s) => s.kind !== 'cows');
    if (!storage && d.milker.targets(home, MILK_RADIUS).length === 0) return skip(`no cow, mooshroom or goat within ${MILK_RADIUS} blocks of home`);
    this.job = new MilkJob({ keep, cows: true, center: () => home, radius: MILK_RADIUS });
    this.stats.started++;
    this.lastWhy = '';
    d.log?.info(`milk chore: ${bucketCounts(d.inventory.slots).milk} of ${keep} milk buckets carried: ${plan.steps.map((s) => (s.kind === 'cows' ? `${s.n} at the cows` : s.kind === 'craft' ? 'a bucket crafted' : `${s.n} ${s.item} from ${s.kind === 'boxes' ? 'a carried box' : 'the chests at home'}`)).join(', ')}`);
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
    const fresh = new MilkJob(job.opts); // a resumed attempt plans again from what it has
    this.job = fresh;
    void fresh.run(this.d, () => t !== this.token || this.job !== fresh).then(
      (r) => {
        if (this.job !== fresh || r.reason === 'interrupted') return;
        this.end(r);
      },
      (err: unknown) => {
        this.d.log?.warn(`milk chore: ${err instanceof Error ? err.message : String(err)}`);
        if (this.job === fresh) this.end(undefined);
      },
    );
  }

  private end(r: MilkReport | undefined): void {
    this.job = undefined;
    this.last = r;
    this.stats.finished++;
    const gained = r ? r.after - r.before : 0;
    this.nextTry = this.now() + (gained > 0 && r?.reason !== 'hostile' ? MILK_RETRY_MS : MILK_BACKOFF_MS);
    if (r && r.after < r.keep) this.lastWhy = r.short ?? `${r.keep - r.after} short`;
    this.d.log?.info(`milk chore: done, ${r ? milkReply(r) : 'error'}`);
    this.d.afterJob?.();
  }

  protected halt(): void {
    this.d.cancel();
  }

  protected override reset(): void {
    this.job = undefined;
  }

  behaviour(): string {
    return this.job ? `${this.job.line()} (auto)` : 'milk (auto)';
  }

  status(): ProcessStatus {
    return { line: this.behaviour() };
  }
}

/** Builds the chore, starts `!milk` and runs the trip readiness's pass. */
export class MilkController {
  readonly chore: MilkChore;
  readonly d: MilkDeps;
  private readonly log: Logger;
  /** The trip readiness passes run (tests, the status). */
  tripRuns = 0;

  constructor(d: MilkDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.chore = d.processes.add(new MilkChore(d));
  }

  keep(): number {
    return this.d.settings.get('milkKeep');
  }

  /** `!milk [n]`: n milk buckets carried (default: milkKeep, or every empty bucket carried when that is more). */
  milk(n?: number): MilkProcess {
    this.chore.drop();
    const c = bucketCounts(this.d.inventory.slots);
    const keep = n ?? Math.max(this.keep(), c.milk + c.empty);
    this.log.info(`milk: ${c.milk} milk and ${c.empty} empty buckets carried, ${keep} wanted`);
    return this.d.processes.add(new MilkProcess(this.d, { keep, cows: true, center: () => this.d.position(), radius: MILK_RADIUS }));
  }

  /** Before a long trip: milk is missing to milkKeep and the carried boxes (or the chests at home, when there) hold some. */
  tripNeeded(): boolean {
    const keep = this.keep();
    if (keep <= 0) return false;
    const plan = planMilk(this.d.source.input(keep), { cows: false });
    return plan.steps.length > 0;
  }

  /** The trip readiness's pass: storage only (no cow, no craft). */
  async tripRun(alive: () => boolean): Promise<MilkReport> {
    this.tripRuns++;
    const keep = this.keep();
    const r = await new MilkJob({ keep, cows: false, center: () => this.d.position(), radius: MILK_RADIUS }).run(this.d, () => !alive());
    this.log.info(`trip: ${milkReply(r)}`);
    return r;
  }

  /** `1/2 (1 empty bucket)`, `0/2 (no bucket, no iron ...)` for `!status`; undefined with milkKeep 0 and no milk. */
  statusPart(): string | undefined {
    const keep = this.keep();
    const c = bucketCounts(this.d.inventory.slots);
    if (keep <= 0 && c.milk === 0) return undefined;
    const parts: string[] = [];
    if (c.empty > 0) parts.push(`${c.empty} empty bucket${c.empty === 1 ? '' : 's'}`);
    if (c.milk < keep) {
      const plan = planMilk(this.d.source.input(keep), { cows: true });
      if (plan.steps.length === 0 && plan.short) parts.push(plan.short);
    }
    return `${c.milk}/${keep}${parts.length ? ` (${parts.join('; ')})` : ''}`;
  }

  /** The panel's milk row: `1 of 2 milk buckets, 1 empty`; undefined with milkKeep 0 and no milk. */
  panelLine(): string | undefined {
    const keep = this.keep();
    const c = bucketCounts(this.d.inventory.slots);
    if (keep <= 0 && c.milk === 0) return undefined;
    return `${c.milk} of ${keep} milk bucket${keep === 1 ? '' : 's'}${c.empty > 0 ? `, ${c.empty} empty` : ''}${this.chore.running ? ' (refilling)' : ''}`;
  }

  /** `!milk status`. */
  statusLine(): string {
    const keep = this.keep();
    const d = this.d;
    const i = d.source.input(keep);
    const plan = planMilk(i, { cows: true });
    const near = d.milker.targets(d.position(), MILK_RADIUS).length;
    const ch = this.chore;
    const waitS = Math.max(0, Math.ceil((ch.nextTry - (d.now ?? (() => performance.now()))()) / 1000));
    const parts = [
      `milk: ${i.milk} of ${keep} carried, ${i.empty} empty bucket${i.empty === 1 ? '' : 's'}`,
      `in carried boxes ${i.boxedMilk} milk, ${i.boxedEmpty} buckets; at home ${i.homeMilk} milk, ${i.homeEmpty} buckets`,
      `${near} cow${near === 1 ? '' : 's'} (or mooshrooms, goats) within ${MILK_RADIUS}`,
      `autoMilk ${d.settings.get('autoMilk') ? 'on' : 'off'}${ch.running ? ', running' : waitS > 0 ? `, next look in ${waitS} s` : ''}${ch.lastWhy ? ` (${ch.lastWhy})` : ''}`,
      `milkCraft ${d.settings.get('milkCraft') ? 'on' : 'off'}`,
    ];
    if (plan.want > 0) parts.push(plan.steps.length ? `next: ${plan.steps.map((s) => (s.kind === 'cows' ? `${s.n} at the cows` : s.kind === 'craft' ? 'craft a bucket' : `${s.n} ${s.item === MILK ? 'milk' : BUCKET} from ${s.kind === 'boxes' ? 'a box' : 'home'}`)).join(', ')}${plan.short ? ` (${plan.short})` : ''}` : (plan.short ?? ''));
    return parts.filter((p) => p).join('; ');
  }

  dispose(): void {
    this.d.processes.stop(this.chore);
  }
}
