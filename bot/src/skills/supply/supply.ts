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
// Track B4 (decision 0129, docs/build.md "Shulker boxes"), for a large build fed from boxes:
//   contents(), boxRoom()  what the carried boxes hold by item, and their free slots
//   takeMany(want)         several kinds out of the carried boxes, a box at a time, each set down once (takeBack)
//   stowMany(keep)         the loose surplus of several kinds into the boxes with room
//   outstanding(), watch() the boxes out in the world now (standing, left on the ground) and one watcher of them
//   adopt(cells)           boxes a session before left (the build's progress file): the next recover picks them up
//
// The box work (recover, the carried-box rounds of ensure, stow) runs under the home logistics' serial lock (`serial`):
// never while an unload, scan or withdrawal uses boxes or the shared BoxState; ensure's home route takes the lock itself.
//
// Users: `!bring` (the home route is its own withdrawal; its extract is boxes.ts takeOut), `!build` (the materials
// count carried boxes; the runner refills a block it ran out of and tops up the scaffold blocks before a column,
// then stows the rest; runner.ts), the throwaway top-up (`topUpThrowaway`), and through `restockFromBoxes` /
// `carried`: the eater (no food loose: 16 good food out of a box, never mid-fight or off the ground), the food chore
// (boxed food counts with the loose food), tunnel and branch torches (32 out of a box when none is loose), and the
// flight (rockets in any other carried box before the takeoff; the kit check counts them). The stash step (stash.ts) keeps its own
// packing order for filling boxes; it places and picks up with the same cell rules (boxSpots).
import { silentLogger, type Logger } from '../../log.ts';
import { maxStackOf } from '../container/chest.ts';
import type { ChestRecord } from '../../world/cache/chests.ts';
import type { Vec3 } from '../../world/types.ts';
import { BOX_SLOTS, carriedBoxes, type CarriedBox } from '../home/boxing.ts';
import { stockOf } from '../home/bring.ts';
import { roomLine, type WithdrawReport, type WithdrawRequest } from '../home/logistics.ts';
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
  withdraw?(cancelled: () => boolean, req: WithdrawRequest): Promise<WithdrawReport>;
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
  /**
   * Track K3: free inventory slots the job needs after a take from home (the crafted rockets, the milk a bucket stack
   * turns into): with no room for the take and these, the withdrawal unloads that many stacks at home first.
   */
  spare?: number;
  /** Track K4: the home route's choice of stacks, read at the chest (logistics.ts WithdrawRequest.pick: an elytra's uses). */
  pick?: WithdrawRequest['pick'];
  /** Track K4: false skips the carried boxes (the stock rule chose the home chests: a box would give any elytra, worn too). Default true. */
  boxes?: boolean;
}

export interface EnsureResult {
  ok: boolean;
  /** Loose after the call. */
  loose: number;
  /** Taken out of carried boxes / brought from home. */
  fromBoxes: number;
  fromHome: number;
  reason?: string;
  /** Track K3: the room the home route made first (logistics.ts roomLine: `made room: unloaded 1 stack (64 andesite)`). */
  room?: string;
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

  /** Track T3 follow-up 2: BoxOps.takeBack under the serial lock (`!test inv restore` takes a preset's boxed items back). */
  unbox(slot: number, want: Readonly<Record<string, number>>, cancelled: () => boolean = () => false): Promise<{ taken: Record<string, number>; slot?: number; why?: string }> {
    return this.serial(() => this.d.ops.takeBack(slot, want, { requests: 0 }, cancelled));
  }

  /** Make `n` of `names` loose (see the file comment). */
  async ensure(names: Names, n: number, opts: EnsureOptions = {}): Promise<EnsureResult> {
    const ns = list(names);
    const cancelled = opts.cancelled ?? (() => false);
    const res: EnsureResult = { ok: false, loose: this.loose(ns), fromBoxes: 0, fromHome: 0 };
    if (res.loose < n && opts.boxes !== false) {
      const stop = await this.serial(() => this.fromBoxes(ns, n, res, cancelled, opts.avoid));
      if (stop) return { ...res, reason: stop };
    }
    if (res.loose < n && opts.home && this.d.withdraw) {
      const before = res.loose;
      const w = await this.d.withdraw(cancelled, { item: { word: ns[0] ?? '', names: ns, boxes: false }, want: n, ...(opts.spare ? { spare: opts.spare } : {}), ...(opts.pick ? { pick: opts.pick } : {}) });
      res.loose = this.loose(ns);
      res.fromHome = Math.max(0, res.loose - before);
      const room = roomLine(w);
      if (room) res.room = room;
      // Track K2: a withdrawal that ended "done" with fewer (the chests held fewer than remembered) says so too;
      // Track K3: a full inventory in words, with why no room was made
      const why = w.reason === 'inventory_full' ? `my inventory is full${w.room?.why ? ` (${w.room.unloaded > 0 ? 'room made short: ' : 'no room made: '}${w.room.why})` : ''}` : w.reason;
      if (!w.ok || res.loose < n) res.reason = why ?? (res.fromHome > 0 ? `the chests at home gave ${res.fromHome} of ${n - before}` : 'the chests at home gave none (fewer there than remembered)');
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

  /**
   * Track V1 (the room chore, tasks/process/room.ts): put the stacks `moves()` names into the carried box of `slot` (any
   * box, the fireworks box included: the rockets beyond two stacks go there), under the serial lock after the recovery of
   * a box left behind; `moves` is asked again for each deposit pass (the box's own slot and a hotbar exchange move stacks).
   * The items moved, and why it stopped short (the box not placed, not opened, not carried again).
   */
  putInto(slot: number, moves: () => { slot: number; count: number; name?: string }[], opts: Pick<EnsureOptions, 'cancelled' | 'avoid'> = {}): Promise<{ moved: number; reason?: string }> {
    const cancelled = opts.cancelled ?? (() => false);
    return this.serial(async () => {
      if (this.d.ops.pending) await this.d.ops.recover(cancelled);
      if (cancelled()) return { moved: 0, reason: 'interrupted' };
      const r = await this.d.ops.putIn(slot, () => moves(), { requests: 0 }, cancelled, opts.avoid ? { avoid: opts.avoid } : {});
      if ('reason' in r) return { moved: 0, reason: r.reason };
      if (typeof r.back === 'string') return { moved: r.moved, reason: r.back };
      return { moved: r.moved, ...(r.open ? { reason: `open: ${r.open}` } : {}) };
    });
  }

  /**
   * Track K4 (ADR 0108): one item out of one carried box, the stack in that box's slot `inBox` only (the elytra the stock
   * rule chose by its uses), under the serial lock after the recovery of a box left behind: the box placed, opened, the
   * stack taken, closed, broken, picked up (boxes.ts takeOut). The step's word (`emptied partly`, or why not) and how many
   * of `name` came loose.
   */
  takeFromBox(slot: number, name: string, inBox: number, opts: Pick<EnsureOptions, 'cancelled' | 'avoid'> = {}): Promise<{ got: number; why: string }> {
    const cancelled = opts.cancelled ?? (() => false);
    return this.serial(async () => {
      if (this.d.ops.pending) await this.d.ops.recover(cancelled);
      if (cancelled()) return { got: 0, why: 'interrupted' };
      if (!this.boxes().some((b) => b.slot === slot)) return { got: 0, why: `no box to take from in slot ${slot}` };
      if (this.d.ops.freeSlots().length < ENSURE_MIN_FREE) return { got: 0, why: 'my inventory is full' };
      const before = this.loose(name);
      const r = await this.d.ops.takeOut(slot, { requests: 0 }, cancelled, { item: (k) => k.replace(/^minecraft:/, '') === name, want: 1, slot: inBox }, undefined, opts.avoid);
      const got = Math.max(0, this.loose(name) - before);
      this.log.info(`supply: ${got} ${name} out of the box in slot ${slot} (its slot ${inBox}: ${r})`);
      return { got, why: r };
    });
  }

  /** The throwaway blocks for scaffolding and pillaring: at least `min` loose, out of the carried boxes. */
  topUpThrowaway(min: number, opts: EnsureOptions = {}): Promise<EnsureResult> {
    return this.ensure(THROWAWAY_BLOCKS, min, opts);
  }

  // ---- Track B4 (decision 0129): a large build fed from the carried boxes

  /** Everything the usable carried boxes hold, by item (the same boxes as `carried`). */
  contents(): Map<string, number> {
    const out = new Map<string, number>();
    for (const b of this.boxes()) for (const [k, v] of Object.entries(b.contents)) if (v > 0) out.set(k, (out.get(k) ?? 0) + v);
    return out;
  }

  /** Free inventory slots (0..35). */
  freeSlots(): number {
    return this.d.ops.freeSlots().length;
  }

  /** Free slots in the usable carried boxes (what a stow can put in, in stacks). */
  boxRoom(notInto?: (name: string) => boolean): number {
    return this.boxes()
      .filter((b) => !(notInto && b.used === 0 && notInto(b.name))) // Track B6: an empty box that is itself a build block
      .reduce((a, b) => a + Math.max(0, BOX_SLOTS - b.used), 0);
  }

  /**
   * Take `want` (item -> count) out of the carried boxes, a box at a time (the one holding most of what is still wanted
   * first), each placed on a cell `avoid` allows, opened, the items taken (BoxOps.takeBack: two inventory slots stay
   * free), broken and picked up again; at most one round a box. What was taken, how many boxes were set down, and why it
   * stopped short (undefined: all of it).
   */
  takeMany(want: Readonly<Record<string, number>>, opts: Pick<EnsureOptions, 'cancelled' | 'avoid'> = {}): Promise<{ taken: Record<string, number>; boxes: number; reason?: string }> {
    const cancelled = opts.cancelled ?? (() => false);
    return this.serial(async () => {
      if (this.d.ops.pending) await this.d.ops.recover(cancelled);
      const taken: Record<string, number> = {};
      const left = (k: string) => Math.max(0, (want[k] ?? 0) - (taken[k] ?? 0));
      let boxes = 0;
      let reason: string | undefined;
      const tried = new Set<string>();
      for (let round = 0; round < BOX_SLOTS; round++) {
        if (cancelled()) return { taken, boxes, reason: 'interrupted' };
        // a box by what it holds of the rest of the want (its contents and colour: a slot may move meanwhile)
        const pick = this.boxes()
          .map((b) => ({ b, has: Object.keys(want).reduce((a, k) => a + Math.min(left(k), b.contents[k] ?? 0), 0), id: `${b.name}|${JSON.stringify(b.contents)}` }))
          .filter((x) => x.has > 0 && !tried.has(x.id))
          .sort((a, b) => b.has - a.has || a.b.slot - b.b.slot)[0];
        if (!pick) break;
        tried.add(pick.id);
        if (this.d.ops.freeSlots().length < ENSURE_MIN_FREE + 1) {
          reason = 'my inventory is full';
          break;
        }
        const ask: Record<string, number> = {};
        for (const k of Object.keys(want)) {
          const n = Math.min(left(k), pick.b.contents[k] ?? 0);
          if (n > 0) ask[k] = n;
        }
        const r = await this.d.ops.takeBack(pick.b.slot, ask, { requests: 0 }, cancelled, opts.avoid);
        boxes++;
        for (const [k, v] of Object.entries(r.taken)) taken[k] = (taken[k] ?? 0) + v;
        this.log.info(`supply: ${Object.entries(r.taken).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'} out of the box in slot ${pick.b.slot}${r.why ? ` (${r.why})` : ''}`);
        if (r.why === 'interrupted') return { taken, boxes, reason: 'interrupted' };
        // the box not set down, not opened, not back, or no room: no further box
        if (r.why && r.why !== 'not all found in the box') {
          reason = r.why;
          break;
        }
        if (Object.keys(want).every((k) => left(k) === 0)) break;
      }
      if (!reason && Object.keys(want).some((k) => left(k) > 0)) reason = this.boxes().some((b) => Object.keys(want).some((k) => (b.contents[k] ?? 0) > 0 && left(k) > 0)) ? 'the carried boxes could not give more' : 'no more in the carried boxes';
      return { taken, boxes, ...(reason ? { reason } : {}) };
    });
  }

  /**
   * Put the loose items of `keep`'s kinds beyond `keep[item]` into the carried boxes with room (a bot_loot box first, then
   * the one with the most room; one round a box, each placed on a cell `avoid` allows): what a build's fetch round made and
   * the inventory cannot hold. The items stowed by kind, and why it stopped short.
   */
  stowMany(keep: Readonly<Record<string, number>>, opts: Pick<EnsureOptions, 'cancelled' | 'avoid'> & { notInto?: (name: string) => boolean } = {}): Promise<{ stowed: Record<string, number>; boxes: number; reason?: string }> {
    const cancelled = opts.cancelled ?? (() => false);
    return this.serial(async () => {
      if (this.d.ops.pending) await this.d.ops.recover(cancelled);
      const kinds = Object.keys(keep);
      const surplus = (k: string) => Math.max(0, this.loose(k) - (keep[k] ?? 0));
      const before = Object.fromEntries(kinds.map((k) => [k, this.loose(k)]));
      let boxes = 0;
      let reason: string | undefined;
      const tried = new Set<number>();
      for (let round = 0; round < BOX_SLOTS && kinds.some((k) => surplus(k) > 0); round++) {
        if (cancelled()) {
          reason = 'interrupted';
          break;
        }
        const box = this.boxes()
          .filter((b) => b.used < BOX_SLOTS && !tried.has(b.slot) && !(opts.notInto && b.used === 0 && opts.notInto(b.name))) // Track B6: not a build's own empty box
          .sort((a, b) => Number(b.named) - Number(a.named) || a.used - b.used || a.slot - b.slot)[0];
        if (!box) {
          reason = 'no carried box with room';
          break;
        }
        tried.add(box.slot);
        // the surplus from the last slots first (the hotbar keeps what the job still holds); planned again each pass
        const moves = (): { slot: number; count: number; name: string }[] => {
          const out: { slot: number; count: number; name: string }[] = [];
          const left = new Map(kinds.map((k) => [k, surplus(k)] as const));
          for (let i = 35; i >= 0; i--) {
            const s = this.d.inventory.slots[i];
            const k = s ? s.name.replace(/^minecraft:/, '') : '';
            const l = left.get(k) ?? 0;
            if (!s || s.count <= 0 || l <= 0) continue;
            const c = Math.min(s.count, l);
            out.push({ slot: i, count: c, name: s.name });
            left.set(k, l - c);
          }
          return out;
        };
        const r = await this.d.ops.putIn(box.slot, moves, { requests: 0 }, cancelled, opts.avoid ? { avoid: opts.avoid } : {});
        boxes++;
        if ('reason' in r) {
          reason = r.reason;
          break;
        }
        if (typeof r.back === 'string') {
          reason = r.back;
          break;
        }
        if (r.open) {
          reason = `open: ${r.open}`;
          break;
        }
      }
      const stowed: Record<string, number> = {};
      for (const k of kinds) {
        const n = Math.max(0, (before[k] ?? 0) - this.loose(k));
        if (n > 0) stowed[k] = n;
      }
      this.log.info(`supply: ${Object.entries(stowed).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'} into ${boxes} carried box${boxes === 1 ? '' : 'es'}${reason ? ` (${reason})` : ''}`);
      return { stowed, boxes, ...(reason ? { reason } : {}) };
    });
  }

  /** Track B4: the boxes a job left in the world now: still standing (an interrupted break) and on the ground. */
  outstanding(): { standing: Vec3[]; left: Vec3[] } {
    const st = this.d.ops.state;
    const cell = (k: string): Vec3 => {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      return { x, y, z };
    };
    return { standing: [...st.standing].map(cell), left: st.leftBoxes.map((p) => ({ x: p.x, y: p.y, z: p.z })) };
  }

  /**
   * Track B4: watch the boxes out in the world (`outstanding` changed: a box set down, broken, left, picked up), called
   * synchronously before the place request goes. One watcher; undefined clears it.
   */
  watch(fn: (() => void) | undefined): void {
    this.d.ops.state.onChange = fn;
  }

  /**
   * Track B4: boxes another session left (a build's progress file after a restart): standing cells are broken and picked
   * up, left cells walked to and the box picked up, by the next `recover` (each within RECOVER_RANGE of the bot then).
   */
  adopt(cells: { standing?: readonly Vec3[]; left?: readonly Vec3[] }): void {
    const st = this.d.ops.state;
    for (const p of cells.standing ?? []) st.standing.add(`${p.x},${p.y},${p.z}`);
    for (const p of cells.left ?? []) if (!st.leftBoxes.some((q) => q.x === p.x && q.y === p.y && q.z === p.z)) st.leftBoxes.push({ x: p.x, y: p.y, z: p.z });
    st.onChange?.();
  }
}

const supplies = new WeakMap<object, Supply>();

/** The task's Supply (registered by commands-home; `!build` reads it at run time). */
export function setSupply(task: object, s: Supply): void {
  supplies.set(task, s);
}
/**
 * A job out of an item (torches for a tunnel, food, rockets): n of it out of the carried shulker boxes, when they hold
 * any (Supply.ensure; the home route is not taken). True when some came out.
 */
export async function restockFromBoxes(task: object | undefined, item: string | readonly string[], n: number): Promise<boolean> {
  const s = supplyOf(task);
  if (!s || s.carried(item) <= 0) return false;
  return (await s.ensure(item, n)).ok;
}

export function supplyOf(task: object | undefined): Supply | undefined {
  return task ? supplies.get(task) : undefined;
}
