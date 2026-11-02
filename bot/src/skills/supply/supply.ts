// Track BJ (wave 12, decision 0052, docs/home.md "Supply"): one answer to "how many of this do I have, and
// get me n of it loose" for every job, so no feature hand-rolls its own shulker logic. The owner noticed that
// the smart shulker box features were not applied to every feature.
//
//   available(item)        loose in the inventory + inside the carried shulker boxes (any but the flight kit's
//                          fireworks box and boxes whose wire item is unknown; the bot_loot boxes count) + what the
//                          chest memory at home holds (loose and in its boxes, bring.ts stockOf)
//   ensure(item, n, opts)  make n of it loose, the cheapest route first:
//                            1. carried boxes: the fullest of the item placed next to the bot (never on a cell
//                               `avoid` names: the build's footprint), just what is missing taken out, the box
//                               picked up again (boxes.ts takeOut; two inventory slots always stay free)
//                            2. with `home`: the chests at home through `!bring`'s withdrawal (logistics.ts
//                               withdraw, bring.ts planBring: loose stacks, whole boxes or items out of a box)
//   stow(item, keep)       the loose surplus beyond `keep` back into a carried box with room (a bot_loot box first,
//                          then the unnamed one with the most room; boxes.ts putIn): what a refill took out and the
//                          job did not use goes back, so the inventory does not fill up with it
//
//   recover()              the boxes a job left behind (a box still standing after an interrupted break, one left on
//                          the ground): broken, picked up, fetched (boxes.ts recover); ensure and stow start with it
//   room(item)             how many more of it fit loose (4 slots kept free): the build caps a refill to it
//
// The box work (recover, the carried-box rounds of ensure, stow) runs under the home logistics' serial lock (`serial`):
// never while an unload, scan or withdrawal uses boxes or the shared BoxState; ensure's home route takes the lock itself.
//
// Users: `!bring` (the home route is its own withdrawal; its extract is boxes.ts takeOut), `!build` (the materials
// count carried boxes; the runner refills a block it ran out of and tops up the scaffold blocks before a column,
// then stows the rest; runner.ts), the throwaway top-up (`topUpThrowaway`). The stash step (stash.ts) keeps its own
// packing order for filling boxes; it places and picks up with the same cell rules (boxSpots).
import { silentLogger, type Logger } from '../../log.ts';
import { maxStackOf } from '../container/chest.ts';
import type { ChestRecord } from '../../world/cache/chests.ts';
import type { Vec3 } from '../../world/types.ts';
import { BOX_SLOTS, carriedBoxes, type CarriedBox } from '../home/boxing.ts';
import { stockOf, type BringItem } from '../home/bring.ts';
import type { WithdrawReport } from '../home/logistics.ts';
import { THROWAWAY_BLOCKS } from '../survival/keeper.ts';
import type { BoxOps } from './boxes.ts';

export interface SupplyDeps {
  ops: BoxOps;
  inventory: { readonly slots: readonly ({ name: string; count: number } | null)[]; rawItem?(window: number, slot: number): unknown };
  /** The `keepBoxName` setting (bot_loot). */
  keepName(): string;
  /** The inventory slot the owner named as the fireworks box (`!fly box`): never a source. */
  flightBoxSlot?(): number | undefined;
  /** The chest memory around home (HomeLogistics.records); without it `available` counts no home stock. */
  records?(): ChestRecord[];
  /** The home route (HomeLogistics.withdraw); without it `ensure` never fetches from home. */
  withdraw?(cancelled: () => boolean, req: { item: BringItem; want: number }): Promise<WithdrawReport>;
  /** Carried boxes owed to a chest (HomeLogistics.owedSlots: an extract's box not back yet): never a source or a stow target. */
  owed?(): Set<number>;
  /** The home logistics' serial lock (HomeLogistics.exclusive); without it the box work runs at once. */
  serial?<T>(fn: () => Promise<T>): Promise<T>;
  log?: Logger;
}

export interface Availability {
  loose: number;
  /** Inside the carried boxes. */
  carried: number;
  /** In the chests at home (loose and in their boxes), by the memory. */
  home: number;
  total: number;
}

export interface EnsureOptions {
  cancelled?: () => boolean;
  /** Cells the box must not be placed on (the build's footprint). */
  avoid?: (p: Vec3) => boolean;
  /** Fetch what the carried boxes lack from the chests at home (walks there). Default false. */
  home?: boolean;
}

export interface EnsureResult {
  ok: boolean;
  /** Loose after the call. */
  loose: number;
  /** Taken out of carried boxes / brought from home. */
  fromBoxes: number;
  fromHome: number;
  reason?: string;
}

/** Item names as given (a word, or several kinds that count alike: the throwaway blocks). */
type Names = string | readonly string[];
const list = (n: Names): string[] => (typeof n === 'string' ? [n] : [...n]).map((x) => x.replace(/^minecraft:/, ''));

/** Box rounds per ensure at most (each one a place, take, break and pickup). */
export const MAX_ENSURE_ROUNDS = 4;
/** Free inventory slots ensure needs to start (the box's own slot frees one more; takeOut keeps two free). */
export const ENSURE_MIN_FREE = 2;
/** Inventory slots `room` keeps free (the box, its pickup, what the job picks up meanwhile). */
export const ROOM_MARGIN = 4;

export class Supply {
  private readonly d: SupplyDeps;
  private readonly log: Logger;

  constructor(d: SupplyDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
  }

  /** The carried boxes items may come out of or go into (not the flight kit's, not unknown ones, not one owed to a chest). */
  boxes(): CarriedBox[] {
    const owed = this.d.owed?.() ?? new Set<number>();
    return carriedBoxes(this.d.inventory, this.d.keepName(), this.d.flightBoxSlot?.()).filter((b) => !b.flightKit && !b.unknown && !owed.has(b.slot));
  }

  loose(names: Names): number {
    const ns = list(names);
    let n = 0;
    for (const s of this.d.inventory.slots.slice(0, 36)) if (s && s.count > 0 && ns.includes(s.name.replace(/^minecraft:/, ''))) n += s.count;
    return n;
  }

  /** Items of `names` inside the carried boxes. */
  carried(names: Names): number {
    const ns = list(names);
    return this.boxes().reduce((a, b) => a + ns.reduce((x, k) => x + (b.contents[k] ?? 0), 0), 0);
  }

  available(names: Names): Availability {
    const ns = list(names);
    const loose = this.loose(ns);
    const carried = this.carried(ns);
    let home = 0;
    if (this.d.records) {
      const s = stockOf(this.d.records(), { word: ns[0] ?? '', names: ns, boxes: false });
      home = s.loose + s.boxed;
    }
    return { loose, carried, home, total: loose + carried + home };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    return this.d.serial ? this.d.serial(fn) : fn();
  }

  /** How many more of `names` (the first one's stack size) fit loose with `margin` slots kept free. */
  room(names: Names, margin = ROOM_MARGIN): number {
    const ns = list(names);
    const max = maxStackOf(ns[0] ?? '');
    let partial = 0;
    let free = 0;
    for (let i = 0; i < 36; i++) {
      const s = this.d.inventory.slots[i];
      if (!s || s.count <= 0) free++;
      else if (ns.includes(s.name.replace(/^minecraft:/, ''))) partial += Math.max(0, max - s.count);
    }
    return Math.max(0, free - margin) * max + partial;
  }

  /** The boxes a job left behind (see the file comment). */
  recover(cancelled: () => boolean = () => false): Promise<void> {
    if (!this.d.ops.pending) return Promise.resolve();
    return this.serial(() => this.d.ops.recover(cancelled));
  }

  /** Make `n` of `names` loose (see the file comment). */
  async ensure(names: Names, n: number, opts: EnsureOptions = {}): Promise<EnsureResult> {
    const ns = list(names);
    const cancelled = opts.cancelled ?? (() => false);
    const res: EnsureResult = { ok: false, loose: this.loose(ns), fromBoxes: 0, fromHome: 0 };
    if (res.loose < n) {
      const stop = await this.serial(() => this.fromBoxes(ns, n, res, cancelled, opts.avoid));
      if (stop) return { ...res, reason: stop };
    }
    if (res.loose < n && opts.home && this.d.withdraw) {
      const before = res.loose;
      const w = await this.d.withdraw(cancelled, { item: { word: ns[0] ?? '', names: ns, boxes: false }, want: n });
      res.loose = this.loose(ns);
      res.fromHome = Math.max(0, res.loose - before);
      if (!w.ok) res.reason = w.reason ?? 'the chests at home gave less';
    }
    res.ok = res.loose >= n;
    if (res.ok) delete res.reason;
    else res.reason ??= this.carried(ns) > 0 ? 'the carried boxes could not give more' : 'no more in the carried boxes';
    return res;
  }

  /** ensure's carried-box rounds (under the serial lock): 'interrupted' ends ensure at once; other stops are in `res.reason`. */
  private async fromBoxes(ns: string[], n: number, res: EnsureResult, cancelled: () => boolean, avoid: ((p: Vec3) => boolean) | undefined): Promise<string | undefined> {
    if (this.d.ops.pending) await this.d.ops.recover(cancelled);
    if (cancelled()) return 'interrupted';
    if (this.boxes().length > 0 && this.d.ops.freeSlots().length < ENSURE_MIN_FREE) {
      res.reason = 'my inventory is full';
      return undefined;
    }
    const tally = { requests: 0 };
    for (let round = 0; round < MAX_ENSURE_ROUNDS && res.loose < n; round++) {
      if (cancelled()) return 'interrupted';
      const box = this.boxes()
        .map((b) => ({ b, has: ns.reduce((x, k) => x + (b.contents[k] ?? 0), 0) }))
        .filter((x) => x.has > 0)
        .sort((a, b) => b.has - a.has || a.b.slot - b.b.slot)[0];
      if (!box) break;
      const before = res.loose;
      const r = await this.d.ops.takeOut(box.b.slot, tally, cancelled, { item: (k) => ns.includes(k.replace(/^minecraft:/, '')), want: n - res.loose }, undefined, avoid);
      res.loose = this.loose(ns);
      res.fromBoxes += Math.max(0, res.loose - before);
      this.log.info(`supply: ${res.loose - before} ${ns.join('/')} out of the box in slot ${box.b.slot} (${r}); ${res.loose} of ${n} loose`);
      if (r === 'interrupted') return r;
      // anything but emptied (the box not back, no cell, not opened): no further round
      if (res.loose <= before || !r.startsWith('emptied')) {
        res.reason = r;
        break;
      }
    }
    return undefined;
  }

  /**
   * Put the loose items of `names` beyond `keep` back into a carried box with room: a bot_loot box first, then the one
   * with the most free slots. The items stowed, and why it stopped short.
   */
  stow(names: Names, keep: number, opts: Pick<EnsureOptions, 'cancelled' | 'avoid'> = {}): Promise<{ stowed: number; reason?: string }> {
    return this.serial(async () => {
      if (this.d.ops.pending) await this.d.ops.recover(opts.cancelled ?? (() => false));
      return this.stowNow(list(names), keep, opts);
    });
  }

  private async stowNow(ns: string[], keep: number, opts: Pick<EnsureOptions, 'cancelled' | 'avoid'>): Promise<{ stowed: number; reason?: string }> {
    const surplus = this.loose(ns) - keep;
    if (surplus <= 0) return { stowed: 0 };
    const box = this.boxes()
      .filter((b) => b.used < BOX_SLOTS)
      .sort((a, b) => Number(b.named) - Number(a.named) || a.used - b.used || a.slot - b.slot)[0];
    if (!box) return { stowed: 0, reason: 'no carried box with room' };
    const before = this.loose(ns);
    const moves = (): { slot: number; count: number; name: string }[] => {
      // the surplus from the last slots first (the hotbar keeps what the job still holds)
      let left = this.loose(ns) - keep;
      const out: { slot: number; count: number; name: string }[] = [];
      for (let i = 35; i >= 0 && left > 0; i--) {
        const s = this.d.inventory.slots[i];
        if (!s || s.count <= 0 || !ns.includes(s.name.replace(/^minecraft:/, ''))) continue;
        const c = Math.min(s.count, left);
        out.push({ slot: i, count: c, name: s.name });
        left -= c;
      }
      return out;
    };
    const r = await this.d.ops.putIn(box.slot, moves, { requests: 0 }, opts.cancelled ?? (() => false), opts.avoid ? { avoid: opts.avoid } : {});
    const stowed = Math.max(0, before - this.loose(ns));
    if ('reason' in r) return { stowed, reason: r.reason };
    if (typeof r.back === 'string') return { stowed, reason: r.back };
    return { stowed };
  }

  /** The throwaway blocks for scaffolding and pillaring: at least `min` loose, out of the carried boxes. */
  topUpThrowaway(min: number, opts: EnsureOptions = {}): Promise<EnsureResult> {
    return this.ensure(THROWAWAY_BLOCKS, min, opts);
  }
}

const supplies = new WeakMap<object, Supply>();

/** The task's Supply (registered by commands-home; `!build` reads it at run time). */
export function setSupply(task: object, s: Supply): void {
  supplies.set(task, s);
}
export function supplyOf(task: object | undefined): Supply | undefined {
  return task ? supplies.get(task) : undefined;
}
