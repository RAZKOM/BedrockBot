// Track K4 (ADR 0108, docs/flight.md "An elytra on hand"): a flyable elytra on hand, as processes (the shape of Track
// R9's rockets and Track K1's milk):
//
// - ElytraJob: one pass of the stock rule (skills/supply/elytra.ts chooseElytra) through the existing machinery: a spare
//   carried loose is put on the back in place of the worn one (one armour swap: the worn one comes into the spare's slot)
//   or, with no elytra on the back, moved to the slot the flight kit puts on (one slot exchange); one out of a carried box
//   (Supply.takeFromBox: that box placed next to the bot, the chosen elytra taken out, the box picked up again), then
//   put on the same way; one out of the chests at home in reach (Supply.ensure's home route: `!bring`'s withdrawal, the
//   stacks read at the chest: only an elytra that covers the need, the most uses first). The worn one stays carried; the
//   unloader stores it at home (unloader.ts UnloadSlot.store, elytraToStore).
// - The takeoff's hook (ElytraController.forTrip, chat/commands-fly.ts autoFly and `!fly`, tasks/process/fly.ts prepare):
//   before a trip is refused for its elytra the pass runs for that trip (boxes and the home chests in reach), and only
//   then is the trip refused and walked; the refusal says what is missing.
// - The trip readiness (tasks/pve.ts trip stock): before a long trip that may fly, with the elytra short of it and a
//   carried spare (loose or in a carried box) that covers it: the same pass with no home chests.
// - ElytraProcess (user, `!elytra`): one pass for ELYTRA_LOW_USES uses over the worn limit, home chests in reach too.
// - ElytraChore (auto, PRIORITY.chore, `autoElytra`, default off): by day, idle within ELYTRA_HOME of home, no hostile
//   within ELYTRA_THREAT, the elytra at hand under ELYTRA_LOW_USES over its worn limit and a better one to hand: the same
//   pass. A pass that changed nothing waits 10 minutes, the home chests until the count of elytra there changes.
import type { Vec3 } from '../../connection/types.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemStack } from '../../world/types.ts';
import { chooseElytra, covers, ELYTRA_LOW_USES, elytraLine, limitOf, panelElytraLine, pieceLine, spendable, type ElytraAllow, type ElytraNeed, type ElytraPiece, type ElytraState } from '../../skills/supply/elytra.ts';
import { durabilityLeft, hasMending, unbreakingLevel } from '../../skills/survival/tools.ts';
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus, type StopReason } from './manager.ts';

/** The chore runs only with the bot this near home (blocks, horizontal). */
export const ELYTRA_HOME = 16;
/** A hostile this near: the chore does not start. */
export const ELYTRA_THREAT = 16;
/** The chore checks once a second. */
const CHECK_MS = 1000;
/** After a pass that changed nothing (ms). */
export const ELYTRA_BACKOFF_MS = 10 * 60_000;
/** A carried box that gave no elytra is not opened again for this long (ms). */
export const ELYTRA_BOX_RETRY_MS = 2 * 60_000;
/** Rounds of one pass at most (a take out of a box or a home chest, then the swap). */
export const ELYTRA_ROUNDS = 3;
/** The server's armour slot after a swap: waited for this many ticks at most. */
const CONFIRM_TICKS = 20;

/** The inventory and storage side of the stock rule (chat/commands-elytra.ts wires the survival kit and Supply). */
export interface ElytraSource {
  /** Every elytra to hand now. */
  state(): ElytraState;
  /** The elytra in inventory slot `from` onto the back in place of the one worn (that one comes into slot `from`). */
  wear(from: number): Promise<{ ok: boolean; reason?: string }>;
  /** Two inventory slots exchanged (one request). */
  swap(a: number, b: number): Promise<{ ok: boolean; reason?: string }>;
  /** The elytra in slot `inBox` of the carried box in inventory slot `slot` out into the inventory. */
  fromBox(slot: number, inBox: number, cancelled: () => boolean): Promise<{ got: number; why: string }>;
  /** One elytra out of the chests at home (walks there within the home's reach): `accept` and `rank` read each stack at the chest. */
  fromHome(pick: { accept(st: ItemStack): boolean; rank(st: ItemStack): number }, cancelled: () => boolean): Promise<{ got: number; why?: string | undefined }>;
}

export interface ElytraDeps {
  processes: ProcessManager;
  settings: Pick<RuntimeSettings, 'get'>;
  source: ElytraSource;
  /** Feet. */
  position(): Vec3;
  home(): Vec3 | undefined;
  isDay(): boolean;
  threat(): string | undefined;
  /** Cancel the running skill (a box, a walk to a chest) on a pause / stop. */
  cancel(): void;
  waitTicks(n: number): Promise<void>;
  /** After a chore's pass: walk home when nothing is queued. */
  afterJob?(): void;
  /** The chore may start (not while a `!test` series or a `!test inv` save holds the bot); default true. */
  idle?(): boolean;
  log?: Logger;
  now?: () => number;
}

export interface ElytraReport {
  ok: boolean;
  /** The elytra at hand before and after (uses left; undefined: none). */
  before: number | undefined;
  after: number | undefined;
  /** Where the elytra put on came from. */
  from?: 'loose' | 'box' | 'home';
  /** The need was covered before the pass (nothing done). */
  already: boolean;
  /** Why the need is still not covered. */
  why?: string;
  reason: 'done' | 'short' | 'interrupted';
}

/** The uses of an elytra stack read at a chest. */
const usesOf = (st: Pick<ItemStack, 'name' | 'damage' | 'enchants'>): { left: number; mending: boolean; unbreaking: number } => ({ left: durabilityLeft(st) ?? 0, mending: hasMending(st), unbreaking: unbreakingLevel(st) });

/** One pass of the stock rule (see the file comment). */
export class ElytraJob {
  readonly need: ElytraNeed;
  readonly allow: ElytraAllow;
  phase = 'looking';
  constructor(need: ElytraNeed, allow: ElytraAllow) {
    this.need = need;
    this.allow = allow;
  }

  async run(d: ElytraDeps, cancelled: () => boolean, blocked: { box?: (p: ElytraPiece) => boolean; failed?: (src: 'box' | 'home', p?: ElytraPiece) => void } = {}): Promise<ElytraReport> {
    const tw = d.settings.get('toolWearLimit');
    const s0 = d.source.state();
    const rep: ElytraReport = { ok: false, before: s0.current?.left, after: s0.current?.left, already: false, reason: 'done' };
    const end = (reason?: ElytraReport['reason']): ElytraReport => {
      const s = d.source.state();
      rep.after = s.current?.left;
      rep.ok = !!s.current && covers(s.current, tw, this.need);
      rep.reason = reason ?? (rep.ok ? 'done' : 'short');
      if (rep.ok) delete rep.why;
      this.phase = 'done';
      return rep;
    };
    let allow = this.allow;
    for (let round = 0; round < ELYTRA_ROUNDS; round++) {
      if (cancelled()) return end('interrupted');
      const s = d.source.state();
      // (a carried box that gave nothing a moment ago is not opened again)
      const st = blocked.box ? { ...s, spares: s.spares.filter((p) => p.source !== 'box' || !blocked.box!(p)) } : s;
      const c = chooseElytra(st, tw, this.need, allow);
      if (c.kind === 'ok') {
        if (round === 0) rep.already = true;
        return end();
      }
      if (c.kind === 'none') {
        rep.why ??= c.why;
        return end();
      }
      if (c.kind === 'home') {
        this.phase = 'an elytra out of the chests at home';
        // (Track F21: compared and ranked by what each flies: an Unbreaking one's uses count for more)
        const r = await d.source.fromHome({ accept: (x) => covers(usesOf(x), tw, this.need) && (!s.current || spendable(usesOf(x), tw) > spendable(s.current, tw)), rank: (x) => spendable(usesOf(x), tw) }, cancelled);
        if (r.got <= 0) {
          rep.why = `the chests at home gave none that covers it${r.why ? ` (${r.why})` : ''}`;
          blocked.failed?.('home');
          allow = { ...allow, home: false };
          continue;
        }
        rep.from = 'home';
        continue;
      }
      const p = c.piece;
      if (p.source === 'box') {
        this.phase = 'an elytra out of a carried box';
        const r = await d.source.fromBox(p.slot!, p.inBox ?? 0, cancelled);
        if (r.got <= 0) {
          rep.why = `the carried box gave none (${r.why})`;
          blocked.failed?.('box', p);
          allow = { ...allow, boxes: false };
          continue;
        }
        rep.from = 'box';
        continue;
      }
      // a loose spare: onto the back in place of the worn one, else into the slot the kit puts on
      this.phase = 'putting the spare on';
      const cur = s.current;
      const r = cur?.source === 'back' ? await d.source.wear(p.slot!) : cur?.source === 'kit' && cur.slot !== undefined ? await d.source.swap(cur.slot, p.slot!) : { ok: false, reason: 'no elytra at hand to swap with' };
      if (!r.ok) {
        rep.why = `the swap failed (${r.reason ?? 'refused'})`;
        return end();
      }
      rep.from ??= 'loose';
      for (let i = 0; i < CONFIRM_TICKS && d.source.state().current?.left !== p.left; i++) await d.waitTicks(1);
      d.log?.info(`elytra: ${cur?.source === 'back' ? 'put on' : 'moved to the kit slot'} the spare from slot ${p.slot} (${pieceLine(p, tw)}); the worn one (${cur ? pieceLine(cur, tw) : '?'}) is carried in slot ${p.slot}`);
    }
    return end(cancelled() ? 'interrupted' : undefined);
  }

  line(): string {
    return `elytra (${this.phase})`;
  }
}

/** `elytra: put on the spare from a carried box (432/432 ...); the worn one (58/432) is carried`, or what is missing. */
export function elytraReply(r: ElytraReport, s: ElytraState, toolWearLimit: number): string {
  const now = s.current ? pieceLine(s.current, toolWearLimit) : 'none';
  if (r.already) return `elytra: ${now} covers it already`;
  const src = r.from === 'box' ? 'from a carried box' : r.from === 'home' ? 'from the chests at home' : 'carried loose';
  const head = r.after !== r.before && r.after !== undefined ? `elytra: put on the spare ${src}: ${now}${r.before !== undefined ? `; the worn one (${r.before}) is carried` : ''}` : `elytra: ${now}`;
  return `${head}${r.reason === 'interrupted' ? '; stopped' : ''}${!r.ok && r.why ? `; ${r.why}` : ''}`;
}

/** `!elytra`: a user process around one ElytraJob. */
export class ElytraProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name = 'elytra';
  readonly result: Promise<ElytraReport>;
  private resolve!: (r: ElytraReport) => void;
  private readonly d: ElytraDeps;
  private job: ElytraJob;
  private readonly c: ElytraController;

  constructor(c: ElytraController, need: ElytraNeed, allow: ElytraAllow) {
    super();
    this.c = c;
    this.d = c.d;
    this.job = new ElytraJob(need, allow);
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    const job = new ElytraJob(this.job.need, this.job.allow);
    this.job = job;
    void this.c.serial(() => job.run(this.d, () => t !== this.token, this.c.blocks())).then(
      (r) => {
        if (t !== this.token) return;
        this.finish();
        this.resolve(r);
      },
      (err: unknown) => {
        this.d.log?.warn(`elytra: ${err instanceof Error ? err.message : String(err)}`);
        this.finish();
        this.resolve({ ok: false, before: undefined, after: undefined, already: false, reason: 'interrupted' });
      },
    );
  }

  protected halt(): void {
    this.d.cancel();
  }

  protected override onStopped(_reason: StopReason): void {
    const s = this.d.source.state();
    this.resolve({ ok: false, before: s.current?.left, after: s.current?.left, already: false, reason: 'interrupted' });
  }

  behaviour(): string {
    return this.job.line();
  }

  status(): ProcessStatus {
    return { line: this.job.line() };
  }
}

/** The background stock (auto, PRIORITY.chore; see the file comment). Registered once; never done. */
export class ElytraChore extends BaseProcess {
  readonly kind = 'auto' as const;
  readonly name = 'elytra';
  private job: ElytraJob | undefined;
  private lastCheck = -Infinity;
  /** No new pass before this time (ms, deps.now()). */
  nextTry = -Infinity;
  readonly stats = { checks: 0, started: 0, finished: 0 };
  last: ElytraReport | undefined;
  lastWhy = '';
  private readonly now: () => number;
  private readonly c: ElytraController;

  constructor(c: ElytraController) {
    super();
    this.c = c;
    this.persistent = true;
    this.now = c.d.now ?? (() => performance.now());
  }

  get priority(): number {
    return PRIORITY.chore;
  }

  get running(): boolean {
    return this.job !== undefined;
  }

  override wants(): boolean {
    const d = this.c.d;
    if (this.job) return d.isDay() && !d.threat();
    const now = this.now();
    if (now - this.lastCheck < CHECK_MS || now < this.nextTry) return false;
    this.lastCheck = now;
    if (!d.settings.get('autoElytra')) return false;
    if (!d.isDay() || d.processes.userProcesses().length > 0 || !(d.idle?.() ?? true)) return false;
    const home = d.home();
    if (!home) {
      this.lastWhy = 'no home set';
      return false;
    }
    const me = d.position();
    if (Math.hypot(me.x - home.x, me.z - home.z) > ELYTRA_HOME || d.threat()) return false;
    const s = d.source.state();
    if (!s.current && s.spares.length === 0 && s.home === 0) return false; // no elytra at all: nothing to keep
    const need = this.c.lowNeed();
    const allow = this.c.allowNow(true);
    const c = chooseElytra(this.c.unblocked(s), d.settings.get('toolWearLimit'), need, allow);
    if (c.kind === 'ok') return false;
    this.stats.checks++;
    if (c.kind === 'none') {
      this.lastWhy = c.why;
      this.nextTry = now + ELYTRA_BACKOFF_MS;
      return false;
    }
    this.job = new ElytraJob(need, allow);
    this.stats.started++;
    this.lastWhy = '';
    d.log?.info(`elytra chore: ${s.current ? pieceLine(s.current, d.settings.get('toolWearLimit')) : 'no elytra'}: ${c.why}`);
    return true;
  }

  drop(): void {
    if (!this.job) return;
    this.job = undefined;
    this.token++;
    if (this.controlled) this.c.d.cancel();
  }

  protected run(t: number): void {
    const job = this.job;
    if (!job) return;
    const fresh = new ElytraJob(job.need, job.allow);
    this.job = fresh;
    void this.c.serial(() => fresh.run(this.c.d, () => t !== this.token || this.job !== fresh, this.c.blocks())).then(
      (r) => {
        if (this.job !== fresh || r.reason === 'interrupted') return;
        this.end(r);
      },
      (err: unknown) => {
        this.c.d.log?.warn(`elytra chore: ${err instanceof Error ? err.message : String(err)}`);
        if (this.job === fresh) this.end(undefined);
      },
    );
  }

  private end(r: ElytraReport | undefined): void {
    this.job = undefined;
    this.last = r;
    this.stats.finished++;
    const gained = !!r && r.after !== undefined && (r.before === undefined || r.after > r.before);
    this.nextTry = this.now() + (gained ? CHECK_MS : ELYTRA_BACKOFF_MS);
    if (r && !r.ok) this.lastWhy = r.why ?? 'short';
    const d = this.c.d;
    d.log?.info(`elytra chore: done, ${r ? elytraReply(r, d.source.state(), d.settings.get('toolWearLimit')) : 'error'}`);
    d.afterJob?.();
  }

  protected halt(): void {
    this.c.d.cancel();
  }

  protected override reset(): void {
    this.job = undefined;
  }

  behaviour(): string {
    return this.job ? `${this.job.line()} (auto)` : 'elytra (auto)';
  }

  status(): ProcessStatus {
    return { line: this.behaviour() };
  }
}

/** Builds the chore, runs the takeoff's and the readiness's passes, starts `!elytra`, gives the lines. */
export class ElytraController {
  readonly chore: ElytraChore;
  readonly d: ElytraDeps;
  private readonly log: Logger;
  private chain: Promise<unknown> = Promise.resolve();
  /** Carried boxes (`slot:inBox`) that gave no elytra, until when (ms). */
  private readonly boxFailed = new Map<string, number>();
  /** The chests at home gave none that covers the need while they held this many elytra. */
  private homeFailedAt: number | undefined;
  /** The takeoff's and the readiness's passes run (tests, the status). */
  readonly stats = { tripPasses: 0, readiness: 0, swaps: 0 };

  constructor(d: ElytraDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.chore = d.processes.add(new ElytraChore(this));
  }

  private now(): number {
    return (this.d.now ?? (() => performance.now()))();
  }

  /** One pass at a time (the readiness's and the takeoff's for one trip come one after the other). */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The need of the chore and `!elytra`: ELYTRA_LOW_USES uses over the worn limit. */
  lowNeed(): ElytraNeed {
    return { uses: ELYTRA_LOW_USES };
  }

  /** The sources a pass may use now: the carried boxes; the home chests when in reach and not known to hold none that helps. */
  allowNow(home: boolean): ElytraAllow {
    const s = this.d.source.state();
    return { boxes: true, home: home && s.homeInReach && this.homeFailedAt !== s.home };
  }

  /** The state with the boxes that just gave nothing left out. */
  unblocked(s: ElytraState): ElytraState {
    const now = this.now();
    return { ...s, spares: s.spares.filter((p) => p.source !== 'box' || (this.boxFailed.get(`${p.slot}:${p.inBox}`) ?? -Infinity) <= now) };
  }

  /** The job's memory of failed sources. */
  blocks(): { box: (p: ElytraPiece) => boolean; failed: (src: 'box' | 'home', p?: ElytraPiece) => void } {
    return {
      box: (p) => (this.boxFailed.get(`${p.slot}:${p.inBox}`) ?? -Infinity) > this.now(),
      failed: (src, p) => {
        if (src === 'box' && p) this.boxFailed.set(`${p.slot}:${p.inBox}`, this.now() + ELYTRA_BOX_RETRY_MS);
        if (src === 'home') this.homeFailedAt = this.d.source.state().home;
      },
    };
  }

  private tw(): number {
    return this.d.settings.get('toolWearLimit');
  }

  /**
   * The takeoff's question (chat/commands-fly.ts, tasks/process/fly.ts): before a trip of `distance` blocks is refused for
   * its elytra, a better one is put on when one is to hand (`act` false: only looked at, nothing moves: a walk is on).
   * `line`: what a refusal adds when the elytra still does not cover the trip (`; no spare that covers it (...)`).
   */
  /** The takeoff's question without acting: `act` true when a pass would put a better elytra on; `line` the refusal's tail when none covers the trip. */
  ask(distance: number, o: { hold?: boolean; home?: boolean } = {}): { act: boolean; line?: string } {
    if (!this.d.settings.get('elytraSpare')) return { act: false };
    const c = chooseElytra(this.unblocked(this.d.source.state()), this.tw(), { distance, ...(o.hold ? { shape: { hold: true } } : {}) }, this.allowNow(o.home !== false));
    if (c.kind === 'none') return c.never ? { act: false } : { act: false, line: `; ${c.why}` }; // (a trip no elytra covers: the cover line says so)
    return { act: c.kind !== 'ok' };
  }

  async forTrip(distance: number, o: { hold?: boolean; climb?: number; act?: boolean; home?: boolean } = {}): Promise<{ changed: boolean; line?: string }> {
    if (!this.d.settings.get('elytraSpare')) return { changed: false };
    // (Track F21: `climb`: the flight's preparation asks again with the climb known)
    const shape = { ...(o.hold ? { hold: true } : {}), ...(o.climb !== undefined ? { climb: o.climb } : {}) };
    const need: ElytraNeed = { distance, ...(Object.keys(shape).length ? { shape } : {}) };
    const allow = this.allowNow(o.home !== false);
    const s = this.unblocked(this.d.source.state());
    const c = chooseElytra(s, this.tw(), need, allow);
    if (c.kind === 'ok') return { changed: false };
    if (c.kind === 'none') return c.never ? { changed: false } : { changed: false, line: `; ${c.why}` };
    if (o.act === false) return { changed: false };
    this.stats.tripPasses++;
    this.log.info(`elytra: the trip of ${Math.round(distance)} blocks: ${s.current ? pieceLine(s.current, this.tw()) : 'no elytra'} does not cover it; ${c.why}`);
    const before = s.current?.left;
    const r = await this.serial(() => new ElytraJob(need, allow).run(this.d, () => false, this.blocks()));
    if (r.after !== before) this.stats.swaps++;
    this.log.info(`elytra: the trip of ${Math.round(distance)} blocks: ${elytraReply(r, this.d.source.state(), this.tw())}`);
    return r.ok ? { changed: r.after !== before } : { changed: r.after !== before, line: `; ${r.why ?? 'no spare that covers it'}` };
  }

  /** The trip readiness: a trip of `distance` blocks that may fly, the elytra short of it, a carried spare (loose or boxed) that covers it. */
  tripNeeded(distance: number | undefined): boolean {
    if (!this.d.settings.get('elytraSpare') || !this.d.settings.get('autoFly') || distance === undefined || distance <= this.d.settings.get('flyMin')) return false;
    const c = chooseElytra(this.unblocked(this.d.source.state()), this.tw(), { distance }, { boxes: true, home: false });
    return c.kind === 'swap';
  }

  /** The trip readiness's pass: carried sources only (never a walk to storage from it). */
  async tripRun(distance: number, alive: () => boolean): Promise<ElytraReport> {
    this.stats.readiness++;
    const r = await this.serial(() => new ElytraJob({ distance }, { boxes: true, home: false }).run(this.d, () => !alive(), this.blocks()));
    this.log.info(`trip: ${elytraReply(r, this.d.source.state(), this.tw())}`);
    return r;
  }

  /** `!elytra`: one pass for ELYTRA_LOW_USES over the worn limit (the home chests in reach too). */
  elytra(): ElytraProcess {
    this.chore.drop();
    return this.d.processes.add(new ElytraProcess(this, this.lowNeed(), this.allowNow(true)));
  }

  /** `!elytra status`. */
  statusLine(): string {
    const s = this.d.source.state();
    const ch = this.chore;
    const waitS = Math.max(0, Math.ceil((ch.nextTry - this.now()) / 1000));
    const auto = `autoElytra ${this.d.settings.get('autoElytra') ? 'on' : 'off'}${ch.running ? ', running' : waitS > 0 ? `, next look in ${waitS} s` : ''}${ch.lastWhy ? ` (${ch.lastWhy})` : ''}`;
    return `${elytraLine(s, this.tw())}; worn limit ${s.current ? limitOf(s.current, this.tw()) : limitOf({ mending: false }, this.tw())}; ${auto}`;
  }

  /** `58/432 (covers about 600 blocks); no spare ...` for `!status`; undefined with no elytra at all. */
  statusPart(): string | undefined {
    const s = this.d.source.state();
    if (!s.current && s.spares.length === 0 && s.home === 0) return undefined;
    return elytraLine(s, this.tw()).replace(/^elytra /, '');
  }

  /** The panel's elytra row. */
  panelLine(): string | undefined {
    return panelElytraLine(this.d.source.state(), this.tw());
  }

  dispose(): void {
    this.d.processes.stop(this.chore);
  }
}
