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
// - Track K3: `!milk far` (a MilkProcess with `far`): the mobs within `milkRange` of the bot, in view or seen, walked to by
//   day, and home again after a far walk (`goHome`); the chore looks within `milkRange` of home (default 24: as before).
//   A take from the chests at home with a full inventory makes room there first (logistics.ts withdraw); the reply says it.
import type { Vec3 } from '../../connection/types.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { BUCKET, bucketCounts, candidateLine, kindsLine, MILK, MILK_RADIUS, MILK_RANGE_MAX, planMilk, type FarCandidate, type MilkResult, type MilkStep, type MilkStockInput } from '../../skills/food/milk.ts';
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
  /** n more of `item` loose out of the carried boxes, then the chests at home (walks there); `room`: the room made there first (Track K3). */
  fromHome(item: string, n: number, cancelled: () => boolean): Promise<{ got: number; why?: string | undefined; room?: string | undefined }>;
  /** One bucket from 3 iron ingots at a crafting table (the crafter's reply line). */
  craft(cancelled: () => boolean): Promise<{ ok: boolean; line: string }>;
}

export interface MilkDeps {
  processes: ProcessManager;
  settings: Pick<RuntimeSettings, 'get'>;
  milker: {
    milk(o: { center: Vec3; radius: number; want: number; far?: boolean }, cancelled: () => boolean): Promise<MilkResult>;
    targets(center: Vec3, radius: number): EntityInfo[];
    /** Track K3: the range choice (in view and seen); without it `!milk far` looks at the mobs in view only. */
    farChoice?(center: Vec3, radius: number): { target?: FarCandidate; nearest?: FarCandidate };
    readonly current?: { kind: string } | undefined;
  };
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
  /** Track K3: after `!milk far` walked out: the walk home (the normal walk); why it ended short. */
  goHome?(cancelled: () => boolean): Promise<{ ok: boolean; reason?: string | undefined }>;
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
  /** Track K2: the first step that got less than it wanted and why (`buckets out of the chests at home: ...`); the reply says it before `short`. */
  failed?: string;
  /** Track K3: the room a take from the chests at home made first (`made room: unloaded 1 stack (64 andesite)`). */
  room?: string;
  /** Track K3: the far walk (`a cow 50 blocks away`) and how the walk home ended (`walked home`, `the walk home: timeout`). */
  walked?: string;
  home?: string;
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
  /** Track K3: `!milk far`: the mobs seen count too, the nearest known one is named, and the bot walks home after a far walk. */
  far?: boolean;
}

/** Track K3: why the milker milked fewer, in words (the radius of the job). */
function milkWhy(r: MilkResult, radius: number, far: boolean): string | undefined {
  switch (r.reason) {
    case 'no_bucket':
      return 'no empty bucket left';
    case 'no_mob':
      if (!far) return `no cow, mooshroom or goat within ${radius} blocks`;
      return `no cow, mooshroom or goat known within ${radius} blocks (${r.nearest ? `the nearest I know: ${candidateLine(r.nearest)}` : 'none seen'})`;
    case 'refused':
      return 'the mobs near gave no milk';
    case 'night':
      return 'night fell (a walk beyond 24 blocks runs by day)';
    case 'walk_failed':
      return `the walk to the mob failed (${r.walkWhy ?? 'failed'})`;
    default:
      return undefined;
  }
}

/** `2 bucket from the chests at home`, `2 at the cows`, `a bucket crafted` (the logs). */
function stepLine(s: MilkStep): string {
  return s.kind === 'cows' ? `${s.n} at the cows` : s.kind === 'craft' ? 'a bucket crafted' : `${s.n} ${s.item} from ${s.kind === 'boxes' ? 'a carried box' : 'the chests at home'}`;
}

/** Track K3: the `milkRange` setting (default 24 = MILK_RADIUS), clamped to MILK_RADIUS..MILK_RANGE_MAX. */
export function milkRange(settings: Pick<RuntimeSettings, 'get'>): number {
  const r = Number(settings.get('milkRange'));
  return Number.isFinite(r) ? Math.max(MILK_RADIUS, Math.min(MILK_RANGE_MAX, Math.round(r))) : MILK_RADIUS;
}

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
    // Track K2: the plan in the log, so an empty one (nothing to take: the reason) is seen as well as a short step
    if (plan.want > 0) d.log?.info(`milk: plan for ${plan.want}: ${plan.steps.length ? plan.steps.map(stepLine).join(', ') : 'nothing to do'}${plan.short ? ` (${plan.short})` : ''}`);
    for (const step of plan.steps) {
      if (cancelled()) return end('interrupted');
      if (step.kind === 'boxes' || step.kind === 'home') {
        this.phase = `${step.item === MILK ? 'milk' : 'buckets'} out of ${step.kind === 'boxes' ? 'a carried box' : 'the chests at home'}`;
        const r: { got: number; why?: string | undefined; room?: string | undefined } = step.kind === 'boxes' ? await d.source.fromBoxes(step.item, step.n, cancelled) : await d.source.fromHome(step.item, step.n, cancelled);
        if (r.room) {
          d.log?.info(`milk: ${this.phase}: ${r.room}`);
          rep.room = rep.room ? `${rep.room}; ${r.room}` : r.room;
        }
        if (step.item === MILK) {
          if (step.kind === 'boxes') rep.fromBoxes += r.got;
          else rep.fromHome += r.got;
        }
        if (r.got < step.n) {
          // Track K2: a step that got less is the reason the reply gives (the plan's short only described the plan)
          const why = r.why ?? `got ${r.got} of ${step.n}`;
          d.log?.info(`milk: ${this.phase}: got ${r.got} of ${step.n} (${why})`);
          rep.failed ??= `${this.phase}: ${why}`;
          if (cancelled()) return end('interrupted');
        }
        continue;
      }
      if (step.kind === 'craft') {
        this.phase = 'crafting a bucket';
        const r = await d.source.craft(cancelled);
        if (r.ok) rep.crafted++;
        else {
          d.log?.info(`milk: crafting a bucket: ${r.line}`);
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
      const r = await d.milker.milk({ center: o.center(), radius: o.radius, want, ...(o.far ? { far: true } : {}) }, cancelled);
      rep.milked += r.milked;
      for (const [k, v] of Object.entries(r.kinds)) rep.kinds[k] = (rep.kinds[k] ?? 0) + v;
      if (r.walked) rep.walked = candidateLine(r.walked);
      if (r.reason === 'interrupted') return end('interrupted');
      if (r.reason === 'hostile') {
        rep.short = `stopped for ${r.threat ?? 'a hostile'}`;
        await this.walkHome(d, rep, cancelled);
        return end('hostile');
      }
      if (r.milked < want) rep.short = milkWhy(r, o.radius, !!o.far) ?? rep.short ?? r.reason;
    }
    await this.walkHome(d, rep, cancelled);
    return end();
  }

  /** Track K3: `!milk far` walked out: home again (the normal walk), when a home is set and the bot is away from it. */
  private async walkHome(d: MilkDeps, rep: MilkReport, cancelled: () => boolean): Promise<void> {
    if (!this.opts.far || !rep.walked || !d.goHome || cancelled()) return;
    const h = d.home();
    const me = d.position();
    if (!h || Math.hypot(me.x - (h.x + 0.5), me.z - (h.z + 0.5)) <= MILK_HOME) return;
    this.phase = 'walking home';
    const r = await d.goHome(cancelled);
    if (cancelled()) return;
    rep.home = r.ok ? 'walked home' : `the walk home ended: ${r.reason ?? 'failed'}`;
    d.log?.info(`milk: ${rep.home}`);
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
  const why = r.failed ?? r.short; // Track K2: what failed first, before what the plan expected
  if (r.after < r.keep) tail.push(`${r.keep - r.after} short of ${r.keep}${why ? `: ${why}` : ''}`);
  if (r.empty > 0) tail.push(`${r.empty} empty bucket${r.empty === 1 ? '' : 's'} left`);
  if (r.room) tail.push(r.room); // Track K3: the stacks unloaded at home for the take
  if (r.walked) tail.push(`went to ${r.walked}${r.home ? `; ${r.home}` : ''}`); // Track K3: `!milk far`
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
    // Track K3: within milkRange of home (default 24, MILK_RADIUS: as before)
    const range = milkRange(d.settings);
    if (!storage && d.milker.targets(home, range).length === 0) return skip(`no cow, mooshroom or goat within ${range} blocks of home`);
    this.job = new MilkJob({ keep, cows: true, center: () => home, radius: range });
    this.stats.started++;
    this.lastWhy = '';
    d.log?.info(`milk chore: ${bucketCounts(d.inventory.slots).milk} of ${keep} milk buckets carried: ${plan.steps.map(stepLine).join(', ')}`);
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
    if (r && r.after < r.keep) this.lastWhy = r.failed ?? r.short ?? `${r.keep - r.after} short`;
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

  /**
   * `!milk [n]`: n milk buckets carried (default: milkKeep, or every empty bucket carried when that is more). Track K3:
   * `far`: the mobs within milkRange, in view or seen, walked to by day, and the walk home after.
   */
  milk(n?: number, far = false): MilkProcess {
    this.chore.drop();
    const c = bucketCounts(this.d.inventory.slots);
    const keep = n ?? Math.max(this.keep(), c.milk + c.empty);
    const radius = far ? milkRange(this.d.settings) : MILK_RADIUS;
    this.log.info(`milk: ${c.milk} milk and ${c.empty} empty buckets carried, ${keep} wanted${far ? ` (far: within ${radius})` : ''}`);
    return this.d.processes.add(new MilkProcess(this.d, { keep, cows: true, center: () => this.d.position(), radius, ...(far ? { far: true } : {}) }));
  }

  /** Track K3: `!milk far`'s look before it starts: the mob it would go to, or the nearest known one (or none). */
  farLook(): { range: number; target?: FarCandidate; nearest?: FarCandidate } {
    const range = milkRange(this.d.settings);
    const ch = this.d.milker.farChoice?.(this.d.position(), range) ?? {};
    return { range, ...ch };
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

  /**
   * Track REL2: the `!status` part and the panel's row show while there is something to say: milk buckets carried, or
   * autoMilk on with milkKeep over 0 (a newcomer with the chore off never set a milk goal). `!milk status` says it all.
   */
  private shown(milk: number): boolean {
    return milk > 0 || (this.keep() > 0 && this.d.settings.get('autoMilk') === true);
  }

  /** `1/2 (1 empty bucket)`, `0/2 (no bucket, no iron ...)` for `!status`; undefined with no milk carried and autoMilk off (or milkKeep 0). */
  statusPart(): string | undefined {
    const keep = this.keep();
    const c = bucketCounts(this.d.inventory.slots);
    if (!this.shown(c.milk)) return undefined;
    const parts: string[] = [];
    if (c.empty > 0) parts.push(`${c.empty} empty bucket${c.empty === 1 ? '' : 's'}`);
    if (c.milk < keep) {
      const plan = planMilk(this.d.source.input(keep), { cows: true });
      if (plan.steps.length === 0 && plan.short) parts.push(plan.short);
    }
    return `${c.milk}/${keep}${parts.length ? ` (${parts.join('; ')})` : ''}`;
  }

  /** The panel's milk row: `1 of 2 milk buckets, 1 empty`; undefined when statusPart is. */
  panelLine(): string | undefined {
    const keep = this.keep();
    const c = bucketCounts(this.d.inventory.slots);
    if (!this.shown(c.milk)) return undefined;
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
    // Track K3: with milkRange raised, what `!milk far` would go to
    const look = this.farLook();
    const far = look.range > MILK_RADIUS ? `; milkRange ${look.range}: ${look.target ? `next ${candidateLine(look.target)}` : look.nearest ? `none within, the nearest ${candidateLine(look.nearest)}` : 'none seen'}` : '';
    const parts = [
      `milk: ${i.milk} of ${keep} carried, ${i.empty} empty bucket${i.empty === 1 ? '' : 's'}`,
      `in carried boxes ${i.boxedMilk} milk, ${i.boxedEmpty} buckets; at home ${i.homeMilk} milk, ${i.homeEmpty} buckets`,
      `${near} cow${near === 1 ? '' : 's'} (or mooshrooms, goats) within ${MILK_RADIUS}${far}`,
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
