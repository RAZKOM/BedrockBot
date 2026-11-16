// Track V1 (ADR 0090, docs/inventory.md): the room chore, an idle chore of the afk task (auto, PRIORITY.chore 30) that
// keeps ROOM_FLOOR (4) inventory slots free by the steps of skills/inventory/room.ts `planRoom`, one at a time, planned
// again after each (a box step moves the box and the stacks).
//
// Why four: a box step (the stash's, the Supply's, the flight kit's refill) needs a slot for the box to come back to and
// one for whatever lies there and is picked up with it (the Supply keeps two free for that: ENSURE_MIN_FREE); a fight's
// sweep and a dig's drop each bring a new kind (one slot each, gone for good when the inventory is full: a full
// inventory picks up nothing); the stash step starts a job's clean-up below two. Six (ROOM_TARGET) once it acts, so the
// next pickup does not start it again.
//
// When: no user process (running, paused or held: the owner's trips and commands come first, and a command pre-empts a
// pass at once: priority 40 over 30), no `!test` series, nothing else in control for ROOM_SETTLE_MS (a fight, a flight,
// a flee, the night shelter, the home return: all of them pre-empt it or keep it from starting, and the sweep after a
// fight picks up first) and the inventory unchanged for as long (a pile of drops picked up, items given), the survival kit, the stash step and the home logistics idle, no hostile within ROOM_MOB_RANGE;
// at home the unload goes first (HomeChore.unloadDue). Every action is one `inventory: ...` line in the log; a pass that
// boxed loot or dropped stone says one line in chat, at most every ROOM_SAY_MS; with the room short and no step left,
// one line asks the owner (a chest at home, a box, `dropStone`), at most every ROOM_ASK_MS.
import { boxPrint, countsLine, planRoom, ROOM_FLOOR, stepLine, type RoomOptions, type RoomPlan, type RoomSlot, type RoomStep } from '../../skills/inventory/room.ts';
import { isShulkerBox } from '../../skills/container/chest.ts';
import { BaseProcess, PRIORITY, type ProcessKind, type ProcessStatus } from './manager.ts';

/** The chore looks at the inventory at most this often (ms). */
export const ROOM_CHECK_MS = 1000;
/** Nothing else in control for this long before a pass starts (ms): the sweep after a fight picks up first. */
export const ROOM_SETTLE_MS = 3000;
/** After a pass that freed nothing, the next one waits this long (ms). */
export const ROOM_RETRY_MS = 2 * 60_000;
/** A step kind that failed (no cell for the box, a refused drop) is not planned again for this long (ms). */
export const ROOM_STEP_BACKOFF_MS = 5 * 60_000;
/** A chat line about a pass (loot boxed, stone dropped) at most this often (ms). */
export const ROOM_SAY_MS = 10 * 60_000;
/** The line that asks the owner for room, at most this often (ms); a new reason says it again sooner. */
export const ROOM_ASK_MS = 60 * 60_000;
/** Steps per pass at most. */
export const MAX_ROOM_STEPS = 12;
/** No pass with a hostile this near (blocks; the guard owns the fight, a placed box would stand in it). */
export const ROOM_MOB_RANGE = 12;

/** What the chore drives (wired in chat/commands-home.ts; faked in the unit tests). */
export interface RoomChoreDeps {
  /** The inventory as the plan sees it (skills/inventory/room.ts roomSlotsOf). */
  slots(): RoomSlot[];
  /** The plan's options now (settings, the fireworks box, at home with chests, a crafting table near). */
  options(): RoomOptions;
  /** When the inventory last changed (the `now` clock; a pickup, a gift, a keeper move). */
  changedAt?: () => number;
  /** No user process (running, paused or held) and no test series. */
  idle(): boolean;
  /** Something else uses the bot or the inventory now (another process in control, the kit, the stash, a home job, a hostile near). */
  busy(): boolean;
  /** The home chore's unload runs or is due (at home it goes first). */
  homeFirst?(): boolean;
  /** `count` of slot `from` onto the same item's partial stack in slot `to` (SurvivalKit.merge). */
  merge(from: number, to: number, count: number): Promise<{ ok: boolean; reason?: string }>;
  /** Drop `count` of `name`, the main inventory's smallest stacks first (SurvivalKit.drop). */
  drop(name: string, count: number): Promise<{ ok: boolean; dropped: number; reason?: string }>;
  /** Place the box of `box`, deposit `moves()`, pick it up again (Supply.putInto). */
  putIn(box: number, moves: () => { slot: number; count: number; name?: string }[], cancelled: () => boolean): Promise<{ moved: number; reason?: string }>;
  /** Craft `count` of `item` into its blocks (the compaction runner); the line, or undefined when nothing was made. */
  compact?(item: string, count: number, cancelled: () => boolean): Promise<string | undefined>;
  /** Cancel the running skill (a pre-emption). */
  cancel(): void;
  say?(line: string): void;
  /** The line that asks the owner, for a plan that is short with no step left (undefined: say nothing). */
  ask?(plan: RoomPlan): string | undefined;
  now?: () => number;
  log?: { info(m: string): void; warn(m: string): void };
}

/** A pass as the log and the tests see it. */
export interface RoomPass {
  freeBefore: number;
  freeAfter: number;
  steps: { step: RoomStep; ok: boolean; line: string }[];
  /** Item counts (loose, by name) before and after. */
  before: Record<string, number>;
  after: Record<string, number>;
  ms: number;
  interrupted: boolean;
}

const freeOf = (slots: readonly RoomSlot[]): number => 36 - new Set(slots.filter((s) => s.count > 0 && s.slot >= 0 && s.slot < 36).map((s) => s.slot)).size;
const countsOf = (slots: readonly RoomSlot[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const s of slots) if (s.count > 0) out[s.name] = (out[s.name] ?? 0) + s.count;
  return out;
};

export class RoomChore extends BaseProcess {
  readonly name = 'room';
  readonly kind: ProcessKind = 'auto';
  private readonly d: RoomChoreDeps;
  private readonly now: () => number;
  private running = false;
  private due = false;
  private lastCheck = -Infinity;
  private quietSince = -Infinity;
  private retryAt = 0;
  private lastSay = -Infinity;
  private lastAsk = -Infinity;
  private lastAskLine: string | undefined;
  private readonly skipUntil = new Map<RoomStep['kind'], number>();
  /** Prints of the unnamed boxes this chore filled (they take more loot; at most 8 kept). */
  private readonly own = new Set<string>();
  /** The passes so far, newest last (at most 20). */
  readonly passes: RoomPass[] = [];
  readonly stats = { passes: 0, steps: 0, failed: 0, asked: 0 };

  constructor(d: RoomChoreDeps) {
    super();
    this.persistent = true;
    this.d = d;
    this.now = d.now ?? (() => Date.now());
    this.quietSince = this.now(); // a fresh bot (a login, a respawn of the task) waits its quiet too
  }

  get priority(): number {
    return PRIORITY.chore;
  }

  private skip(t: number): Set<RoomStep['kind']> {
    const out = new Set<RoomStep['kind']>();
    for (const [k, until] of this.skipUntil) if (until > t) out.add(k);
    return out;
  }

  private opts(t: number): RoomOptions {
    return { ...this.d.options(), skip: this.skip(t), ownBoxes: this.own };
  }

  /** The plan now (for `!status`-like reads and the tests). */
  plan(): RoomPlan {
    return planRoom(this.d.slots(), this.opts(this.now()));
  }

  override wants(): boolean {
    if (this.running) return true;
    const t = this.now();
    if (!this.d.idle() || this.d.busy()) {
      this.quietSince = t;
      this.due = false;
      return false;
    }
    if (t - Math.max(this.quietSince, this.d.changedAt?.() ?? -Infinity) < ROOM_SETTLE_MS) return false;
    if (t - this.lastCheck < ROOM_CHECK_MS) return this.due;
    this.lastCheck = t;
    this.due = false;
    const slots = this.d.slots();
    const opts = this.opts(t);
    if (freeOf(slots) >= (opts.floor ?? ROOM_FLOOR)) return false;
    if (this.d.homeFirst?.()) return false;
    const plan = planRoom(slots, opts);
    if (plan.steps.length === 0) {
      this.maybeAsk(plan, t);
      return false;
    }
    if (t < this.retryAt) return false;
    this.due = true;
    return true;
  }

  private maybeAsk(plan: RoomPlan, t: number): void {
    const line = this.d.ask?.(plan);
    if (!line) return;
    if (line === this.lastAskLine && t - this.lastAsk < ROOM_ASK_MS) return;
    if (t - this.lastSay < ROOM_SAY_MS) return; // a new reason (or a pass line a moment ago): not sooner than ROOM_SAY_MS
    this.lastAsk = t;
    this.lastSay = t;
    this.lastAskLine = line;
    this.stats.asked++;
    this.d.log?.info(`inventory: asked the owner: ${line}`);
    this.d.say?.(line);
  }

  protected run(tok: number): void {
    if (this.running) return;
    this.running = true;
    // a pass pre-empted a moment ago may still be waiting on its cancelled step: the new one starts after it
    const prev = this.inflight ?? Promise.resolve();
    const p = prev
      .then(() => (tok === this.token ? this.pass(tok) : undefined))
      .then(
        () => this.ended(tok),
        (e: unknown) => {
          this.d.log?.warn(`inventory: the pass failed: ${e instanceof Error ? e.message : String(e)}`);
          this.ended(tok);
        },
      );
    this.inflight = p;
    void p.finally(() => {
      if (this.inflight === p) this.inflight = undefined;
    });
  }

  /** The pass running (or still finishing after a pre-emption). */
  private inflight: Promise<void> | undefined;

  /** Resolves when no pass runs (the tests). */
  async settled(): Promise<void> {
    while (this.inflight) await this.inflight;
  }

  private ended(tok: number): void {
    if (tok !== this.token) return; // paused or stopped meanwhile: run() starts a fresh pass on resume
    this.running = false;
    this.due = false;
    this.lastCheck = -Infinity;
    this.yieldControl();
  }

  private async pass(tok: number): Promise<void> {
    const t0 = this.now();
    const alive = () => tok === this.token;
    const first = this.d.slots();
    const pass: RoomPass = { freeBefore: freeOf(first), freeAfter: 0, steps: [], before: countsOf(first), after: {}, ms: 0, interrupted: false };
    this.stats.passes++;
    for (let i = 0; i < MAX_ROOM_STEPS; i++) {
      if (!alive()) break;
      const plan = planRoom(this.d.slots(), { ...this.opts(this.now()), started: true });
      const step = plan.steps[0];
      if (!step) break;
      const r = await this.runStep(step, alive);
      if (!alive()) {
        pass.steps.push({ step, ok: false, line: `${stepLine(step)}: interrupted` });
        break;
      }
      pass.steps.push({ step, ok: r.ok, line: r.line });
      this.stats.steps++;
      if (!r.ok) {
        this.stats.failed++;
        this.skipUntil.set(step.kind, this.now() + ROOM_STEP_BACKOFF_MS);
      }
    }
    const last = this.d.slots();
    pass.freeAfter = freeOf(last);
    pass.after = countsOf(last);
    pass.ms = this.now() - t0;
    pass.interrupted = !alive();
    this.passes.push(pass);
    if (this.passes.length > 20) this.passes.shift();
    const lines = pass.steps.map((s) => s.line).join('; ') || 'nothing to do';
    this.d.log?.info(`inventory: ${pass.freeBefore} -> ${pass.freeAfter} slots free in ${(pass.ms / 1000).toFixed(1)} s${pass.interrupted ? ' (interrupted)' : ''}: ${lines}`);
    if (!pass.interrupted && pass.freeAfter <= pass.freeBefore) this.retryAt = this.now() + ROOM_RETRY_MS;
    // one chat line when something the owner may look for went into a box or was dropped (not junk, not a merge)
    const told = pass.steps.filter((s) => s.ok && (s.step.kind === 'box' || s.step.kind === 'stone'));
    if (told.length > 0 && this.now() - this.lastSay >= ROOM_SAY_MS) {
      this.lastSay = this.now();
      this.d.say?.(`inventory: ${pass.freeBefore} -> ${pass.freeAfter} slots free: ${told.map((s) => s.line).join('; ')}`);
    }
  }

  private async runStep(step: RoomStep, alive: () => boolean): Promise<{ ok: boolean; line: string }> {
    const log = this.d.log;
    const done = (ok: boolean, line: string) => {
      if (ok) log?.info(`inventory: ${line}`);
      else log?.warn(`inventory: ${line}`);
      return { ok, line };
    };
    switch (step.kind) {
      case 'merge': {
        const r = await this.d.merge(step.from, step.to, step.count);
        return done(r.ok, r.ok ? stepLine(step) : `${stepLine(step)} failed: ${r.reason ?? 'refused'}`);
      }
      case 'junk':
      case 'stone': {
        const r = await this.d.drop(step.name, step.count);
        const line = step.kind === 'junk' ? `dropped ${r.dropped} ${step.name} (junk)` : `dropped ${r.dropped} ${step.name} (dropStone ${step.keep})`;
        return done(r.dropped > 0, r.ok ? line : `${line}: ${r.reason ?? 'refused'}`);
      }
      case 'rockets':
      case 'box': {
        const planned = new Map<string, number>();
        for (const m of step.moves) {
          const name = 'name' in m ? m.name : 'firework_rocket';
          planned.set(name, (planned.get(name) ?? 0) + m.count);
        }
        const loose = (): Map<string, number> => {
          const out = new Map<string, number>();
          for (const s of this.d.slots()) if (planned.has(s.name)) out.set(s.name, (out.get(s.name) ?? 0) + s.count);
          return out;
        };
        const start = loose();
        const slotsPlanned = new Set(step.moves.map((m) => m.slot));
        // the planned stacks as they are now (by name: a hotbar exchange for the box may move one), never more than planned
        const moves = (): { slot: number; count: number; name: string }[] => {
          const now = loose();
          const left = new Map([...planned].map(([k, v]) => [k, v - ((start.get(k) ?? 0) - (now.get(k) ?? 0))]));
          const live = this.d.slots().filter((s) => planned.has(s.name) && s.slot !== step.box);
          // the planned slots first, then any other slot of the kind (a stack moved by the box's hotbar exchange)
          live.sort((a, b) => Number(!slotsPlanned.has(a.slot)) - Number(!slotsPlanned.has(b.slot)) || Number(a.slot < 9) - Number(b.slot < 9) || b.slot - a.slot);
          const out: { slot: number; count: number; name: string }[] = [];
          for (const s of live) {
            const l = left.get(s.name) ?? 0;
            if (l <= 0) continue;
            const c = Math.min(l, s.count);
            out.push({ slot: s.slot, count: c, name: s.name });
            left.set(s.name, l - c);
          }
          return out;
        };
        const printsBefore = new Set(this.boxPrints());
        const r = await this.d.putIn(step.box, moves, () => !alive());
        if (step.kind === 'box') this.noteOwn(printsBefore);
        const now = loose();
        const moved = [...planned.keys()].map((k) => ({ name: k, count: Math.max(0, (start.get(k) ?? 0) - (now.get(k) ?? 0)) })).filter((x) => x.count > 0);
        const what = step.kind === 'rockets' ? `${moved.reduce((a, x) => a + x.count, 0)} firework_rocket into the fireworks box` : `boxed ${countsLine(moved)} into the shulker box in slot ${step.box}`;
        const ok = moved.length > 0 && !r.reason;
        return done(ok, r.reason ? `${what} (${r.reason})` : what);
      }
      case 'compact': {
        if (!this.d.compact) return done(false, `${stepLine(step)}: no crafter`);
        const line = await this.d.compact(step.item, step.count, () => !alive());
        return done(line !== undefined, line ?? `${stepLine(step)}: nothing crafted`);
      }
    }
  }

  /** The prints of the unnamed boxes carried that hold something (not the fireworks box, not a bot_loot box). */
  private boxPrints(): string[] {
    return this.d
      .slots()
      .filter((s) => isShulkerBox(s.name) && !s.flightKit && !s.named && !s.unknown && (s.boxUsed ?? 0) > 0)
      .map((s) => boxPrint(s.boxItems));
  }

  /** After a box step: the boxes holding something new are this chore's (the print of what they held before goes). */
  private noteOwn(before: ReadonlySet<string>): void {
    const after = this.boxPrints();
    const fresh = after.filter((p) => !before.has(p));
    if (fresh.length === 0) return;
    for (const p of before) if (!after.includes(p)) this.own.delete(p);
    for (const p of fresh) this.own.add(p);
    while (this.own.size > 8) this.own.delete(this.own.values().next().value!);
  }

  protected halt(): void {
    if (!this.running) return;
    this.running = false;
    this.d.cancel();
  }

  protected override reset(): void {
    this.running = false;
    this.due = false;
  }

  behaviour(): string {
    return 'making room in the inventory';
  }

  status(): ProcessStatus {
    return { line: `room: ${this.running ? 'making room in the inventory' : 'idle'}` };
  }
}
