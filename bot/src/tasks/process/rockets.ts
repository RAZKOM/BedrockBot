// Track R9 (ADR 0097, docs/flight.md "Rockets on hand"): rockets on hand, as processes (the shape of Track K1's milk):
//
// - RocketJob: one pass of the stock rule (skills/fly/rockets.ts planRockets) through the existing machinery: rockets out
//   of the chests at home when the bot is there, gunpowder, paper and sugar cane out of the carried boxes (Supply.ensure)
//   and out of the chests at home (Supply.ensure's home route, `!bring`'s withdrawal), paper from sugar cane at a
//   crafting table carried or near (the crafter), the rockets in the inventory's 2 x 2 grid (the crafter, the recipe of
//   1 paper and 1 gunpowder), then the crafted rockets into the fireworks box when one is carried and has room (the box
//   rules as they are: Supply.putInto). The hotbar refill before a flight is the flight's own (`fireworksMin`).
// - RocketsProcess (user, `!rockets [n]`): up to `fireworksKeep` (or n); guard, night and flee pre-empt it like any
//   command and it plans again afterwards.
// - RocketsChore (auto, PRIORITY.chore, `autoRockets`, default off): by day, no user process, the bot within ROCKETS_HOME
//   of home and no hostile within ROCKETS_THREAT, under `fireworksKeep` with a step to take: the same pass. An attempt that
//   gained nothing waits 10 minutes; one that gained rockets 30 s. After it the home return walks home.
// - The trip readiness (tasks/pve.ts tripStocks, wired by chat/commands-rockets.ts): before a long trip that may fly
//   (`autoFly`, an elytra at hand, farther than `flyMin`), with fewer rockets carried than the flight's need and the
//   materials carried (loose or in the carried boxes): the same pass with no home chests and no box round after it.
import type { Vec3 } from '../../connection/types.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { CANE, GUNPOWDER, PAPER, planRockets, ROCKET, tripRocketNeed, type RocketCounts, type RocketItem, type RocketPlan, type RocketStockInput, type RocketStep } from '../../skills/fly/rockets.ts';
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus, type StopReason } from './manager.ts';

/** The chore runs only with the bot this near home (blocks, horizontal). */
export const ROCKETS_HOME = 16;
/** A hostile this near: the chore does not start. */
export const ROCKETS_THREAT = 16;
/** The chore checks once a second. */
const CHECK_MS = 1000;
/** After an attempt that gained nothing: the next look (ms). */
export const ROCKETS_BACKOFF_MS = 10 * 60_000;
/** After an attempt that gained rockets (ms). */
export const ROCKETS_RETRY_MS = 30_000;

/** The storage, craft and box side of the stock rule (chat/commands-rockets.ts wires Supply, the crafter and the kit). */
export interface RocketSource {
  /** What the stock rule reads now, for `keep`. */
  input(keep: number): RocketStockInput;
  /** The rockets in every carried place now. */
  counts(): RocketCounts;
  /** n more of `item` loose out of the carried boxes; how many came and why fewer. */
  fromBoxes(item: RocketItem, n: number, cancelled: () => boolean): Promise<{ got: number; why?: string | undefined }>;
  /** n more of `item` loose out of the carried boxes, then the chests at home (walks there). */
  fromHome(item: RocketItem, n: number, cancelled: () => boolean): Promise<{ got: number; why?: string | undefined }>;
  /** Craft n of paper (at a table) or rockets (the recipe of 1 paper and 1 gunpowder); the items made and the crafter's line. */
  craft(item: typeof PAPER | typeof ROCKET, n: number, cancelled: () => boolean): Promise<{ made: number; line: string }>;
  /** Up to n loose rockets of the main slots into the fireworks box (none carried, or no room: moved 0 and why). */
  stow(n: number, cancelled: () => boolean): Promise<{ moved: number; why?: string | undefined }>;
}

export interface RocketDeps {
  processes: ProcessManager;
  settings: Pick<RuntimeSettings, 'get'>;
  source: RocketSource;
  /** Feet. */
  position(): Vec3;
  home(): Vec3 | undefined;
  /** Day (the chore runs by day only). */
  isDay(): boolean;
  /** A hostile within ROCKETS_THREAT (name and distance), or undefined. */
  threat(): string | undefined;
  /** An elytra at hand that may fly (worn or carried, above its worn limit): the trip readiness looks only then. */
  canFly(): boolean;
  /** The energy model's rockets for a flight of `distance` blocks (plan.ts estimateRockets with the climb it would make). */
  estimate(distance: number): number;
  /** Cancel the running skill (walk, withdrawal, craft, box) on a pause / stop. */
  cancel(): void;
  /** After a chore's attempt: walk home when nothing is queued. */
  afterJob?(): void;
  /** The chore may start (not while a `!test` series or a `!test inv` save holds the bot); default true. */
  idle?(): boolean;
  log?: Logger;
  now?: () => number;
}

export interface RocketReport {
  ok: boolean;
  /** The target and the rockets carried (every place) before and after. */
  keep: number;
  before: number;
  after: number;
  /** Rockets out of the chests at home. */
  fromHome: number;
  /** Materials brought loose (out of the boxes or the chests at home), by name. */
  fetched: Record<string, number>;
  paperMade: number;
  crafted: number;
  /** Crafted rockets put into the fireworks box. */
  stowed: number;
  /** Why it stopped short of `keep`. */
  short?: string;
  reason: 'done' | 'short' | 'interrupted';
}

export interface RocketJobOptions {
  keep: number;
  /** The chests at home may be used (when the bot is there); false: what is carried only (the trip readiness). */
  home: boolean;
  /** The crafted rockets go into the fireworks box after (false: the trip readiness keeps them loose for the flight). */
  stow: boolean;
}

const stepLine = (s: RocketStep): string =>
  s.kind === 'craft' ? `craft ${s.n} rockets` : s.kind === 'paper' ? `${s.n} paper from sugar cane` : `${s.n} ${s.item} from ${s.kind === 'boxes' ? 'a carried box' : 'the chests at home'}`;

/** `5 gunpowder from a carried box, craft 15 rockets` (status lines). */
export function planLine(p: RocketPlan): string {
  return p.steps.map(stepLine).join(', ');
}

/** One pass of the stock rule (see the file comment). */
export class RocketJob {
  readonly opts: RocketJobOptions;
  phase = 'planning';
  constructor(opts: RocketJobOptions) {
    this.opts = opts;
  }

  async run(d: RocketDeps, cancelled: () => boolean): Promise<RocketReport> {
    const o = this.opts;
    const total = () => d.source.counts().total;
    const before = total();
    const rep: RocketReport = { ok: false, keep: o.keep, before, after: before, fromHome: 0, fetched: {}, paperMade: 0, crafted: 0, stowed: 0, reason: 'done' };
    const end = (reason?: RocketReport['reason']): RocketReport => {
      rep.after = total();
      rep.reason = reason ?? (rep.after >= o.keep ? 'done' : 'short');
      rep.ok = rep.after >= o.keep || rep.after > rep.before;
      this.phase = 'done';
      return rep;
    };
    const plan = planRockets(d.source.input(o.keep), { home: o.home });
    if (plan.short) rep.short = plan.short;
    for (const step of plan.steps) {
      if (cancelled()) return end('interrupted');
      if (step.kind === 'boxes' || step.kind === 'home') {
        this.phase = `${step.item} out of ${step.kind === 'boxes' ? 'a carried box' : 'the chests at home'}`;
        const r = step.kind === 'boxes' ? await d.source.fromBoxes(step.item, step.n, cancelled) : await d.source.fromHome(step.item, step.n, cancelled);
        if (step.item === ROCKET) rep.fromHome += r.got;
        else if (r.got > 0) rep.fetched[step.item] = (rep.fetched[step.item] ?? 0) + r.got;
        if (r.got < step.n && r.why) rep.short ??= `${step.item}: ${r.why}`;
        continue;
      }
      if (step.kind === 'paper') {
        this.phase = 'paper from sugar cane';
        const r = await d.source.craft(PAPER, step.n, cancelled);
        rep.paperMade += r.made;
        if (r.made <= 0) rep.short ??= `no paper: ${r.line}`;
        continue;
      }
      this.phase = `crafting ${step.n} rockets`;
      const r = await d.source.craft(ROCKET, step.n, cancelled);
      rep.crafted += r.made;
      if (r.made < step.n) rep.short ??= r.made > 0 ? r.line : `no rockets crafted: ${r.line}`;
    }
    if (cancelled()) return end('interrupted');
    if (o.stow && rep.crafted > 0) {
      this.phase = 'rockets into the fireworks box';
      const r = await d.source.stow(rep.crafted, cancelled);
      rep.stowed = r.moved;
      if (r.moved === 0 && r.why) d.log?.info(`rockets: the crafted rockets stay loose (${r.why})`);
    }
    return end(cancelled() ? 'interrupted' : undefined);
  }

  line(): string {
    return `rockets (${this.phase})`;
  }
}

/** `rockets: 64 carried (60 crafted, 6 paper from sugar cane, 60 into the fireworks box)` and what stood in the way. */
export function rocketsReply(r: RocketReport): string {
  const got: string[] = [];
  if (r.fromHome > 0) got.push(`${r.fromHome} from the chests at home`);
  if (r.crafted > 0) got.push(`${r.crafted} crafted`);
  if (r.paperMade > 0) got.push(`${r.paperMade} paper from sugar cane`);
  const fetched = Object.entries(r.fetched).map(([k, v]) => `${v} ${k}`);
  if (fetched.length) got.push(`${fetched.join(', ')} fetched`);
  if (r.stowed > 0) got.push(`${r.stowed} into the fireworks box`);
  const head = `rockets: ${r.after} carried`;
  const what = got.length ? ` (${got.join(', ')})` : r.after === r.before ? ' (nothing new)' : '';
  const tail: string[] = [];
  if (r.reason === 'interrupted') tail.push('stopped');
  if (r.after < r.keep) tail.push(`${r.keep - r.after} short of ${r.keep}${r.short ? `: ${r.short.replace(/^\d+ short: /, '')}` : ''}`);
  return `${head}${what}${tail.length ? `; ${tail.join('; ')}` : ''}`;
}

/** `!rockets [n]`: a user process around one RocketJob; after a pause it plans again from what it has. */
export class RocketsProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name = 'rockets';
  readonly result: Promise<RocketReport>;
  private resolve!: (r: RocketReport) => void;
  private readonly d: RocketDeps;
  private job: RocketJob;
  private readonly startTotal: number;
  private readonly sum = { fromHome: 0, paperMade: 0, crafted: 0, stowed: 0, fetched: {} as Record<string, number> };

  constructor(d: RocketDeps, opts: RocketJobOptions) {
    super();
    this.d = d;
    this.job = new RocketJob(opts);
    this.startTotal = d.source.counts().total;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    const job = new RocketJob(this.job.opts);
    this.job = job;
    void job.run(this.d, () => t !== this.token).then(
      (r) => {
        this.sum.fromHome += r.fromHome;
        this.sum.paperMade += r.paperMade;
        this.sum.crafted += r.crafted;
        this.sum.stowed += r.stowed;
        for (const [k, v] of Object.entries(r.fetched)) this.sum.fetched[k] = (this.sum.fetched[k] ?? 0) + v;
        if (t !== this.token) return;
        this.finish();
        this.resolve({ ...r, ...this.sum, fetched: { ...this.sum.fetched }, before: this.startTotal, ok: r.after >= r.keep || r.after > this.startTotal });
      },
      (err: unknown) => {
        this.d.log?.warn(`rockets: ${err instanceof Error ? err.message : String(err)}`);
        this.finish();
        this.resolve(this.blank('interrupted'));
      },
    );
  }

  private blank(reason: RocketReport['reason']): RocketReport {
    return { ok: false, keep: this.job.opts.keep, before: this.startTotal, after: this.d.source.counts().total, ...this.sum, fetched: { ...this.sum.fetched }, reason };
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

/** The background stock (auto, PRIORITY.chore; see the file comment). Registered once; never done. */
export class RocketsChore extends BaseProcess {
  readonly kind = 'auto' as const;
  readonly name = 'rockets';
  private job: RocketJob | undefined;
  private lastCheck = -Infinity;
  /** No new attempt before this time (ms, deps.now()). */
  nextTry = -Infinity;
  readonly stats = { checks: 0, started: 0, finished: 0, skipped: 0 };
  last: RocketReport | undefined;
  /** Why the last check did not start (status). */
  lastWhy = '';
  private readonly now: () => number;
  private readonly d: RocketDeps;

  constructor(d: RocketDeps) {
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
    const keep = d.settings.get('fireworksKeep');
    if (!d.settings.get('autoRockets') || keep <= 0) return false;
    if (!d.isDay() || d.processes.userProcesses().length > 0 || !(d.idle?.() ?? true)) return false;
    const home = d.home();
    if (!home) {
      this.lastWhy = 'no home set';
      return false;
    }
    const me = d.position();
    if (Math.hypot(me.x - home.x, me.z - home.z) > ROCKETS_HOME || d.threat()) return false;
    if (d.source.counts().total >= keep) return false;
    this.stats.checks++;
    const plan = planRockets(d.source.input(keep), { home: true });
    if (plan.steps.length === 0) {
      this.lastWhy = plan.short ?? 'nothing to do';
      this.stats.skipped++;
      this.nextTry = now + ROCKETS_BACKOFF_MS;
      d.log?.info(`rockets chore: ${this.lastWhy}; next look in 10 min`);
      return false;
    }
    this.job = new RocketJob({ keep, home: true, stow: true });
    this.stats.started++;
    this.lastWhy = '';
    d.log?.info(`rockets chore: ${plan.have} of ${keep} rockets carried: ${planLine(plan)}`);
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
    const fresh = new RocketJob(job.opts); // a resumed attempt plans again from what it has
    this.job = fresh;
    void fresh.run(this.d, () => t !== this.token || this.job !== fresh).then(
      (r) => {
        if (this.job !== fresh || r.reason === 'interrupted') return;
        this.end(r);
      },
      (err: unknown) => {
        this.d.log?.warn(`rockets chore: ${err instanceof Error ? err.message : String(err)}`);
        if (this.job === fresh) this.end(undefined);
      },
    );
  }

  private end(r: RocketReport | undefined): void {
    this.job = undefined;
    this.last = r;
    this.stats.finished++;
    const gained = r ? r.after - r.before : 0;
    this.nextTry = this.now() + (gained > 0 ? ROCKETS_RETRY_MS : ROCKETS_BACKOFF_MS);
    if (r && r.after < r.keep) this.lastWhy = r.short ?? `${r.keep - r.after} short`;
    this.d.log?.info(`rockets chore: done, ${r ? rocketsReply(r) : 'error'}`);
    this.d.afterJob?.();
  }

  protected halt(): void {
    this.d.cancel();
  }

  protected override reset(): void {
    this.job = undefined;
  }

  behaviour(): string {
    return this.job ? `${this.job.line()} (auto)` : 'rockets (auto)';
  }

  status(): ProcessStatus {
    return { line: this.behaviour() };
  }
}

/** Builds the chore, starts `!rockets` and runs the trip readiness's pass. */
export class RocketsController {
  readonly chore: RocketsChore;
  readonly d: RocketDeps;
  private readonly log: Logger;
  /** The trip readiness passes run (tests, the status). */
  tripRuns = 0;

  constructor(d: RocketDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.chore = d.processes.add(new RocketsChore(d));
  }

  keep(): number {
    return this.d.settings.get('fireworksKeep');
  }

  /** `!rockets [n]`: n rockets carried (default fireworksKeep). */
  rockets(n?: number): RocketsProcess {
    this.chore.drop();
    const keep = n ?? this.keep();
    this.log.info(`rockets: ${this.d.source.counts().total} carried, ${keep} wanted`);
    return this.d.processes.add(new RocketsProcess(this.d, { keep, home: true, stow: true }));
  }

  /**
   * The rockets a trip to `to` should start with: 0 when it will not fly (`autoFly` off, no elytra that may fly, not
   * farther than `flyMin`, `fireworksKeep` 0); else the flight's need there and back (never under `fireworksMin`), at most
   * `fireworksKeep`. An unknown goal: `fireworksMin`.
   */
  tripNeed(to: Vec3 | undefined): number {
    const d = this.d;
    const keep = this.keep();
    if (keep <= 0 || !d.settings.get('autoFly') || !d.canFly()) return 0;
    const min = d.settings.get('fireworksMin');
    if (!to) return Math.min(keep, min);
    const me = d.position();
    const dist = Math.hypot(to.x - me.x, to.z - me.z);
    if (dist < d.settings.get('flyMin')) return 0;
    return Math.min(keep, tripRocketNeed(d.estimate(dist), min));
  }

  /** Before a long trip: fewer rockets than its need and the materials carried for at least one craft. */
  tripNeeded(to: Vec3 | undefined): boolean {
    const need = this.tripNeed(to);
    if (need <= 0 || this.d.source.counts().total >= need) return false;
    return planRockets(this.d.source.input(this.keep()), { home: false }).crafts > 0;
  }

  /** The trip readiness's pass: what is carried only, up to fireworksKeep, the rockets left loose for the flight. */
  async tripRun(alive: () => boolean): Promise<RocketReport> {
    this.tripRuns++;
    const r = await new RocketJob({ keep: this.keep(), home: false, stow: false }).run(this.d, () => !alive());
    this.log.info(`trip: ${rocketsReply(r)}`);
    return r;
  }

  /** `40/64 (no gunpowder (carried, in the boxes or at home))` for `!status`; undefined with fireworksKeep 0 and no rockets. */
  statusPart(): string | undefined {
    const keep = this.keep();
    const c = this.d.source.counts();
    if (keep <= 0 && c.total === 0) return undefined;
    const parts: string[] = [];
    if (c.total < keep) {
      const plan = planRockets(this.d.source.input(keep), { home: true });
      // the `!status` line is long already: the reason without its "(carried, in the boxes ...)" detail (`!rockets status` has it)
      if (plan.short) parts.push(plan.short.replace(/^\d+ short: /, '').replace(/ \([^()]*\)/g, ''));
    }
    return `${c.total}/${keep}${parts.length ? ` (${parts.join('; ')})` : ''}`;
  }

  /** The panel's rockets row: `40 of 64 (12 loose, 28 in the box), 10 gunpowder, 4 paper`. */
  panelLine(): string | undefined {
    const keep = this.keep();
    const c = this.d.source.counts();
    if (keep <= 0 && c.total === 0) return undefined;
    const i = this.d.source.input(keep);
    const where = [`${c.loose} loose`, ...(c.box > 0 ? [`${c.box} in the box`] : []), ...(c.boxed > 0 ? [`${c.boxed} in other boxes`] : [])];
    const mats = [`${i.gunpowder.loose + i.gunpowder.boxed} gunpowder`, `${i.paper.loose + i.paper.boxed} paper`, ...(i.cane.loose + i.cane.boxed > 0 ? [`${i.cane.loose + i.cane.boxed} sugar cane`] : [])];
    return `${c.total} of ${keep} (${where.join(', ')}), ${mats.join(', ')}${this.chore.running ? ' (crafting)' : ''}`;
  }

  /** `!rockets status`. */
  statusLine(): string {
    const keep = this.keep();
    const d = this.d;
    const i = d.source.input(keep);
    const c = i.rockets;
    const plan = planRockets(i, { home: true });
    const ch = this.chore;
    const waitS = Math.max(0, Math.ceil((ch.nextTry - (d.now ?? (() => performance.now()))()) / 1000));
    const st = (s: { loose: number; boxed: number; home: number }) => `${s.loose} carried, ${s.boxed} in boxes, ${s.home} at home`;
    const parts = [
      `rockets: ${c.total} of ${keep} (${c.loose} loose, ${c.box} in the fireworks box, ${c.boxed} in other boxes; ${i.homeRockets} at home)`,
      `gunpowder ${st(i.gunpowder)}`,
      `paper ${st(i.paper)}`,
      `sugar cane ${st(i.cane)}`,
      `a crafting table ${i.table ? 'near or carried' : 'not near'}${i.atHome ? '; at home' : ''}`,
      `autoRockets ${d.settings.get('autoRockets') ? 'on' : 'off'}${ch.running ? ', running' : waitS > 0 ? `, next look in ${waitS} s` : ''}${ch.lastWhy ? ` (${ch.lastWhy})` : ''}`,
    ];
    if (plan.want > 0) parts.push(plan.steps.length ? `next: ${planLine(plan)}${plan.short ? ` (${plan.short})` : ''}` : (plan.short ?? ''));
    return parts.filter((p) => p).join('; ');
  }

  dispose(): void {
    this.d.processes.stop(this.chore);
  }
}

export { CANE, GUNPOWDER, PAPER, ROCKET };
