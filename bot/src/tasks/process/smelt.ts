// `!smelt` and `!furnace` as user processes (Track E2, docs/early-game.md "The iron age", ADR 0099).
//
// - `!furnace`: a furnace set down where the cooker looks (skills/food/furnace.ts): within 16 blocks of home (the bot
//   walks home first), or next to the bot without a home; one is crafted first when none is carried (8 cobblestone and
//   the table's chain: skills/craft/chain.ts). Nothing is placed when one stands there already.
// - `!smelt [item] [n]`: the smeltable items carried (raw iron, raw gold, raw copper, sand; or the one named, n of it)
//   go into that furnace with the fuel the cooker picks (charcoal and coal first, then planks, then logs); the bot
//   waits by it (the window open) and takes every ingot out. No furnace there: it places one as `!furnace` does.
// Both are user processes (priority 40): guard, flee and night pre-empt them; a resume goes on with what is left.
import type { Logger } from '../../log.ts';
import type { CookOptions, CookResult } from '../../skills/food/cook.ts';
import type { FurnaceResult } from '../../skills/food/furnace.ts';
import type { ItemStack, Vec3 } from '../../world/types.ts';
import type { SmeltShell } from '../smelt-shell.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';

export interface SmeltDeps {
  cooker: { cook(o: CookOptions, cancelled: () => boolean): Promise<CookResult>; readonly phase: string };
  /** A furnace where the cooker looks (placed when none stands there; `already` when one did). */
  placeFurnace(cancelled: () => boolean): Promise<FurnaceResult>;
  /** Craft one furnace from what is carried (its chain: planks, the table); false when it cannot. */
  makeFurnace?(cancelled: () => boolean): Promise<boolean>;
  /** Furnaces carried. */
  furnacesCarried(): number;
  slots(): readonly (ItemStack | null)[];
  /** Cancel the running skill (a pause or a stop). */
  cancel(): void;
  /** Track E3: the smelt shell (tasks/smelt-shell.ts, `smeltShell`): one per job, kept across a pause. */
  makeShell?(): SmeltShell;
  log?: Logger;
}

export interface SmeltRequest {
  /** `furnace`: place one only; `smelt`: place when needed, then smelt. */
  kind: 'furnace' | 'smelt';
  /** The inputs smelted: name -> count carried (smelt only). */
  inputs?: (slots: readonly (ItemStack | null)[]) => Map<string, number>;
  /** At most this many items (smelt only). */
  limit?: number;
  /**
   * Track E4: the furnace an earlier smelt left its input in (a death): no furnace is placed; the bot goes there,
   * waits out what is in it and takes the output (then smelts what is carried, as any smelt).
   */
  at?: Vec3;
}

export interface SmeltJobResult {
  ok: boolean;
  /** done | the furnace's reason (no_furnace_item, walk_failed, no_spot, place_failed) | the cooker's (no_fuel, ...) | interrupted */
  reason: string;
  furnace?: FurnaceResult;
  /** A furnace was crafted for this job. */
  crafted: boolean;
  cook?: CookResult;
}

function mergeCook(a: CookResult | undefined, b: CookResult): CookResult {
  if (!a) return b;
  const cooked = { ...a.cooked };
  for (const [k, v] of Object.entries(b.cooked)) cooked[k] = (cooked[k] ?? 0) + v;
  const fuel = { ...a.fuel };
  for (const [k, v] of Object.entries(b.fuel)) fuel[k] = (fuel[k] ?? 0) + v;
  return { ...b, cooked, fuel, ticks: a.ticks + b.ticks };
}

/** One furnace-then-smelt job; resumable after a pause (a placed furnace is found again, a smelt goes on with what is left). */
export class SmeltJob {
  phase: 'furnace' | 'smelt' | 'open' | 'done' = 'furnace';
  /** Track E3: the shell the smelt waits in (built when the rule says so). */
  shell: SmeltShell | undefined;
  furnace: FurnaceResult | undefined;
  crafted = false;
  cook: CookResult | undefined;
  reason = 'done';
  /** Items smelted so far (the limit counts across resumes). */
  private smelted = 0;
  /** Items put in so far (the limit counts across resumes: a paused run's input is still in the furnace). */
  private put = 0;
  /** Track E2: the furnace a paused smelt left its input in. */
  private inFurnace: Vec3 | undefined;
  readonly req: SmeltRequest;

  constructor(req: SmeltRequest) {
    this.req = req;
    if (req.kind === 'smelt' && req.at) {
      this.phase = 'smelt';
      this.inFurnace = { ...req.at };
    }
  }

  /** Track E4: the job is over (done, or ended with a reason). */
  get over(): boolean {
    return this.phase === 'done';
  }

  /** Track E4: the furnace holding this job's input after an interruption (undefined: none known, or nothing went in). */
  get heldAt(): Vec3 | undefined {
    if (this.phase === 'done') return undefined;
    return this.inFurnace ?? (this.put > 0 ? this.cook?.furnace : undefined);
  }

  /** Run (or go on) until done or cancelled; true when the job is over. */
  async run(d: SmeltDeps, cancelled: () => boolean): Promise<boolean> {
    if (this.phase === 'furnace') {
      let r = await d.placeFurnace(cancelled);
      if (cancelled()) return false;
      if (!r.ok && r.reason === 'no_furnace_item' && d.makeFurnace && !this.crafted) {
        const made = await d.makeFurnace(cancelled);
        if (cancelled()) return false;
        if (made && d.furnacesCarried() > 0) {
          this.crafted = true;
          r = await d.placeFurnace(cancelled);
          if (cancelled()) return false;
        }
      }
      this.furnace = r;
      if (!r.ok) {
        this.reason = r.reason;
        this.phase = 'done';
        return true;
      }
      this.phase = this.req.kind === 'smelt' ? 'smelt' : 'done';
    }
    if (this.phase === 'smelt') {
      const o: CookOptions = { inputs: this.req.inputs! };
      if (this.req.limit !== undefined) o.limit = Math.max(0, this.req.limit - this.put);
      // Track E2: after a pause the furnace still holds what went in: back there first, even with nothing left to put in
      if (this.inFurnace) o.at = this.inFurnace;
      // Track E4: the furnace this job set down or found (one the bot placed may stand beyond the cooker's 16) first
      else if (this.furnace?.ok) o.prefer = this.furnace.pos;
      // Track E3: a smelt that outlasts the day, or one by night, waits in a shell next to the furnace
      const at = this.inFurnace ?? (this.furnace?.ok ? this.furnace.pos : undefined);
      if (d.makeShell && at) {
        this.shell ??= d.makeShell();
        const total = [...this.req.inputs!(d.slots()).values()].reduce((a, b) => a + b, 0);
        await this.shell.close(at, Math.min(total, o.limit ?? Infinity), cancelled);
        if (cancelled()) return false;
      }
      const r = await d.cooker.cook(o, cancelled);
      this.smelted += Object.values(r.cooked).reduce((a, b) => a + b, 0);
      this.put += r.put ?? Object.values(r.cooked).reduce((a, b) => a + b, 0);
      this.cook = mergeCook(this.cook, r);
      if (cancelled()) {
        // a flee or a guard fight closed the window (measured on a fresh world: a skeleton by night, the flee after 78 s)
        if (r.furnace) this.inFurnace = r.furnace;
        return false;
      }
      this.inFurnace = undefined;
      this.reason = r.reason;
      this.phase = 'open';
    }
    if (this.phase === 'open') {
      // Track E3: out of the shell (by night at dawn); a pre-emption leaves it standing for the resume
      if (this.shell?.closed) {
        await this.shell.open(cancelled);
        if (cancelled()) return false;
      }
      this.phase = 'done';
    }
    return true;
  }

  result(): SmeltJobResult {
    return { ok: this.reason === 'done', reason: this.reason, ...(this.furnace ? { furnace: this.furnace } : {}), crafted: this.crafted, ...(this.cook ? { cook: this.cook } : {}) };
  }

  line(d: SmeltDeps): string {
    if (this.phase === 'furnace') return this.req.kind === 'furnace' ? 'placing a furnace' : 'smelt: placing a furnace';
    if (this.phase === 'smelt') return d.cooker.phase === 'idle' ? (this.shell?.closed ? 'smelting (in a shell)' : 'smelting') : `${d.cooker.phase}${this.shell?.closed ? ' (in a shell)' : ''}`;
    if (this.phase === 'open') return 'smelt: in the shell until it is safe to open';
    return this.req.kind;
  }
}

export class SmeltProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name: string;
  readonly result: Promise<SmeltJobResult>;
  private resolve!: (r: SmeltJobResult) => void;
  readonly job: SmeltJob;
  private readonly d: SmeltDeps;

  constructor(d: SmeltDeps, job: SmeltJob) {
    super();
    this.d = d;
    this.job = job;
    this.name = job.req.kind;
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
        this.d.log?.warn(`${this.name}: ${err instanceof Error ? err.message : String(err)}`);
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
