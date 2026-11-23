// Track BJ (wave 12, decision 0052, docs/home.md "Supply"): the carried shulker box next to the bot, the
// one routine every job uses. Moved here out of the home logistics (logistics.ts, Track AG/AV), where the
// unload's box, fill and empty steps grew it; `!bring`'s extract and the build's refill (supply.ts) use it
// too, so there is one copy of each step:
//
//   place     the box of an inventory slot onto a free cell next to the bot (stash.ts boxSpots; never a cell
//             `avoid` names, e.g. the build's footprint); it must be the box the place skill picks
//             (`placesExactly`; `toHotbar` moves it there first); a different box placed (the model moved
//             meanwhile) is broken and picked up again
//   take out  open it, take what fits (or `only` that item, `want` of it at most), always keeping two
//             inventory slots free (the box's own and one for whatever else lies there and is picked up with
//             it: the pickup found the inventory full, Realm 2026-10-30), close
//   put in    open it, deposit the moves the caller plans (planned again after each pass: the survival keeper
//             may move a stack to the hotbar meanwhile), close
//   pick up   break it (a box broken meanwhile: straight to the pickup) and collect it, nearer first; not
//             found: remembered and walked to at once, else later (`fetchLeft`)
//   recover   a box still standing (its break was interrupted: `standing` keeps it until the box is confirmed
//             gone) is broken and picked up, the boxes left on the ground fetched; at the start of every job that
//             uses boxes (the unload's debts, `!bring`'s withdrawal, the Supply's ensure / stow, the build's run).
//             Only within RECOVER_RANGE blocks of the bot (a farther one is kept, and chat said where it was left);
//             a box on the ground is given up after MAX_FETCH_TRIES walks or LEFT_MAX_AGE_MS (said in chat)
//   cancel    after a pre-emption the clean-up is short (one break, one pickup within 4 blocks), the rest is left
//             to `recover`: the process that pre-empted owns the bot
//
// The logistics' BoxOps and the Supply's share one `BoxState` (left boxes, standing cells), so either job clears
// what the other left behind; the home chore ignores the block updates of a standing cell.
//
// Container traffic goes through the skills given (the chest skill sets the `shulker` slot type per window).
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, ContainerView, Vec3 } from '../../world/types.ts';
import type { CollectOptions, CollectResult } from '../collect/collect.ts';
import { isShulkerBox, maxStackOf, shulkerContents, shulkerSlotsUsed, stacksOnto, type DepositResult, type OpenResult } from '../container/chest.ts';
import { boxSpots } from '../container/stash.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import { isKeptBox, placesExactly } from '../home/boxing.ts';
import { fmtPos } from '../home/memory.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';

export interface BoxSkills {
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
  open(p: Vec3): Promise<OpenResult>;
  closeContainer(view: ContainerView | number): Promise<boolean>;
  take(view: ContainerView, slot: number, count?: number, prefer?: readonly number[]): Promise<{ ok: boolean; reason?: string; to?: number; moved: number }>;
  depositSlots(view: ContainerView, moves: readonly { slot: number; count: number; name?: string }[]): Promise<DepositResult>;
  place(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult>;
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
  collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<CollectResult>;
}

export interface BoxOpsDeps {
  skills: BoxSkills;
  inventory: { readonly slots: readonly ({ name: string; count: number; metadata?: number } | null)[]; rawItem?(window: number, slot: number): unknown };
  blockAt(p: Vec3): BlockInfo | undefined;
  position(): Vec3 | undefined;
  /** The `keepBoxName` setting (bot_loot): a picked-up box of the other sort is not taken for the one broken. */
  keepName(): string;
  /** Select a hotbar slot (Hotbar.select), so the placed box is the one wanted. */
  selectHotbar?(slot: number): void;
  /** A box the place skill would not pick by itself: move it where it would (its slot), or why not. */
  toHotbar?(slot: number, cancelled: () => boolean): Promise<number | string>;
  log?: Logger;
  /** The log lines' prefix (`unload`, `supply`). */
  label?: string;
  /** Another BoxOps' state to share (the task's Supply shares the logistics'). */
  state?: BoxState;
  /** A line for the owner (chat): where a box was left, a box given up. */
  notify?(line: string): void;
  now?(): number;
}

/** Track BJ: `recover` walks to a box within this many blocks of the bot only. */
export const RECOVER_RANGE = 24;
/** Track BJ: walks to a box left on the ground before it is given up. */
export const MAX_FETCH_TRIES = 3;
/** Track BJ: a box left on the ground this long is given up (30 min). */
export const LEFT_MAX_AGE_MS = 30 * 60_000;

/** Boxes a BoxOps left in the world (shared by the BoxOps of one task). */
export interface BoxState {
  /** Boxes broken and not picked up again: walked back for (at once, or once there is room). */
  readonly leftBoxes: Vec3[];
  /** Cells (`x,y,z`) where a box stands or is being placed: no home container; cleared once the box is confirmed gone. */
  readonly standing: Set<string>;
  /** Per left box (`x,y,z`): walks so far and when it was left. */
  readonly left?: Map<string, { tries: number; since: number }>;
  /**
   * Track B4 (decision 0129): called after `standing` or `leftBoxes` changed (a box set down, broken, left or picked up),
   * synchronously, so a job can record a box out in the world before the place request goes (the build's progress file).
   */
  onChange?: (() => void) | undefined;
}

/** Counts of what a step did (the callers' reports: UnloadReport, WithdrawReport). */
export interface BoxTally {
  requests: number;
}

const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
const cellKey = (p: Vec3): string => `${p.x},${p.y},${p.z}`;

export class BoxOps {
  private readonly d: BoxOpsDeps;
  private readonly log: Logger;
  readonly state: BoxState;

  constructor(d: BoxOpsDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.state = d.state ?? { leftBoxes: [], standing: new Set(), left: new Map() };
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private meta(at: Vec3): { tries: number; since: number } {
    const m = this.state.left;
    const k = cellKey(at);
    let e = m?.get(k);
    if (!e) {
      e = { tries: 0, since: this.now() };
      m?.set(k, e);
    }
    return e;
  }

  /** Within RECOVER_RANGE blocks of the bot (unknown position: yes). */
  private inRange(at: Vec3): boolean {
    const f = this.d.position();
    return !f || Math.hypot(f.x - at.x - 0.5, f.y - at.y, f.z - at.z - 0.5) <= RECOVER_RANGE;
  }

  /** Remember a box left on the ground (once per cell). */
  private leave(at: Vec3): void {
    if (this.leftBoxes.some((p) => cellKey(p) === cellKey(at))) return;
    this.leftBoxes.push(at);
    this.meta(at);
    this.changed();
  }

  /** Track B4: the BoxState's watcher (BoxState.onChange); a watcher that throws is logged, never the box work's failure. */
  private changed(): void {
    try {
      this.state.onChange?.();
    } catch (e) {
      this.log.warn(`${this.label}: box state watcher: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Track B4: a cell where a box stands now (marked before its place request: the watcher records it first). */
  private markStanding(p: Vec3): void {
    const k = cellKey(p);
    if (this.standing.has(k)) return;
    this.standing.add(k);
    this.changed();
  }

  /** Track B4: a standing cell's box is gone from the world (picked up, broken, never placed). */
  private unmarkStanding(p: Vec3 | string): void {
    if (this.standing.delete(typeof p === 'string' ? p : cellKey(p))) this.changed();
  }

  /** Say where a box was left when it is still on the ground (not picked up by the walk to it). */
  private sayLeft(at: Vec3): void {
    if (this.leftBoxes.some((p) => cellKey(p) === cellKey(at))) this.d.notify?.(`left a shulker box on the ground at ${fmtPos(at)}; I pick it up when I am near it again`);
  }

  /** Boxes broken and not picked up again (BoxState). */
  get leftBoxes(): Vec3[] {
    return this.state.leftBoxes;
  }

  /** Cells where a box stands (BoxState): the chore ignores their block updates. */
  get standing(): Set<string> {
    return this.state.standing;
  }

  /** Something to clean up: a box standing or one left on the ground. */
  get pending(): boolean {
    return this.standing.size > 0 || this.leftBoxes.length > 0;
  }

  /**
   * Boxes this layer left behind: one still standing (an interrupted break) is broken and picked up, a cell whose box
   * is gone is forgotten (its item, if any, fetched), then the left boxes are fetched. Run with nothing else using boxes.
   */
  async recover(cancelled: () => boolean): Promise<void> {
    for (const k of [...this.standing]) {
      if (cancelled()) return;
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      const at = { x, y, z };
      const b = this.d.blockAt(at);
      if (!b || b.name === 'unknown') continue; // not loaded: kept for later
      if (!isShulkerBox(b.name)) {
        this.unmarkStanding(k);
        continue;
      }
      if (!this.inRange(at)) continue; // far away: kept (chat said where)
      const feet = this.d.position();
      if (feet && Math.hypot(feet.x - x - 0.5, feet.z - z - 0.5) > 3.5) await this.d.skills.goto({ type: 'near', p: centre(at), r: 2 }, { timeoutTicks: 400 });
      const back = await this.breakAndPickUp(at, () => false);
      this.log.info(`${this.label}: the box left standing at ${fmtPos(at)}: ${typeof back === 'number' ? 'picked up' : back}`);
    }
    await this.fetchLeft(cancelled);
  }

  private get label(): string {
    return this.d.label ?? 'unload';
  }

  /** Free inventory slots (0..35). */
  freeSlots(): number[] {
    const out: number[] = [];
    this.d.inventory.slots.slice(0, 36).forEach((s, i) => {
      if (!s || s.count <= 0) out.push(i);
    });
    for (let i = this.d.inventory.slots.length; i < 36; i++) out.push(i);
    return out;
  }

  /** Box slots carried (inventory slot -> NBT slots used). */
  boxSlots(): Map<number, number> {
    const out = new Map<number, number>();
    this.d.inventory.slots.slice(0, 36).forEach((s, i) => {
      if (s && s.count > 0 && isShulkerBox(s.name)) out.set(i, shulkerSlotsUsed(this.d.inventory.rawItem?.(0, i)));
    });
    return out;
  }

  /** The inventory slots holding a shulker box. */
  boxKeys(): Set<number> {
    return new Set(this.boxSlots().keys());
  }

  /** Is the box in inventory slot `i` a named (bot_loot) one? */
  namedAt(i: number): boolean {
    return isKeptBox(this.d.inventory.slots[i]?.name ?? '', this.d.inventory.rawItem?.(0, i), this.d.keepName());
  }

  /**
   * New inventory slots that taking the stack `st` out of a window uses: none for what tops up partial stacks of the same
   * item (a shulker box never stacks). Track V1c: a partial stack with other wire NBT than `raw` (`st`'s wire item) has
   * no room for it (a Flight 2 rocket never tops up a Flight 1 stack); one whose NBT is not known still counts.
   */
  slotsFor(st: { name: string; count: number; metadata?: number }, raw?: unknown): number {
    const max = maxStackOf(st.name);
    let room = 0;
    if (!isShulkerBox(st.name)) {
      this.d.inventory.slots.slice(0, 36).forEach((s, i) => {
        if (s && s.count < max && stacksOnto(st, raw, s, this.d.inventory.rawItem?.(0, i)) !== false) room += max - s.count;
      });
    }
    return Math.ceil(Math.max(0, st.count - room) / max);
  }

  /** What identifies the box of `slot`: its name, its custom name and its contents. */
  private identity(slot: number): string {
    const raw = this.d.inventory.rawItem?.(0, slot);
    const c = shulkerContents(raw);
    return `${this.d.inventory.slots[slot]?.name ?? ''}|${this.namedAt(slot)}|${Object.keys(c).sort().map((k) => `${k}:${c[k]}`).join(',')}`;
  }

  /** The slot of the box with identity `id` (`prefer` first). */
  private locate(id: string, prefer: number): number | undefined {
    if (isShulkerBox(this.d.inventory.slots[prefer]?.name ?? '') && this.identity(prefer) === id) return prefer;
    return [...this.boxKeys()].find((i) => this.identity(i) === id);
  }

  /** The box of `slot` where the place skill picks it (`toHotbar`), or why not. */
  private async exact(slot: number, cancelled: () => boolean): Promise<number | string> {
    if (placesExactly(this.d.inventory.slots, slot)) return slot;
    if (!this.d.toHotbar) return 'the box is not in the hotbar';
    return this.d.toHotbar(slot, cancelled);
  }

  /**
   * Place the box of `slot`, take what fits into the inventory (`only`: that item, `want` of it at most; the rest stays in
   * the box), break it, pick it up: `emptied` / `emptied partly` or why not; `out.slot`: where the box came back to.
   * The slot the placed box left stays free for it: the broken box drops as an item and needs a slot to come back to
   * (the contents filled it, the box stayed on the ground and the run stuck, Realm 2026-10-30).
   */
  async takeOut(slot: number, tally: BoxTally, cancelled: () => boolean, only?: { item: string | ((name: string) => boolean); want: number; /** Track K4: that slot of the box only (the elytra chosen by its uses) */ slot?: number }, out?: { slot?: number }, avoid?: (p: Vec3) => boolean): Promise<string> {
    const named = this.namedAt(slot);
    const id = this.identity(slot);
    const s = await this.exact(slot, cancelled);
    if (typeof s === 'string') {
      // never placed: still carried, maybe moved by the hotbar move (found by its name and contents)
      const at = this.locate(id, slot);
      if (out && at !== undefined) out.slot = at;
      return s;
    }
    const placed = await this.place(s, cancelled, avoid);
    if ('reason' in placed) {
      if (out && placed.slot !== undefined) out.slot = placed.slot;
      return placed.reason;
    }
    let left = 0;
    let got = 0;
    const o = await this.openPlaced(placed.at);
    if (o.ok) {
      try {
        const wanted = (name: string): boolean => !only || (typeof only.item === 'string' ? name === only.item : only.item(name));
        // (Track K4: the slot asked for, while it holds the item; else any slot of it, as without one)
        const pinned = only?.slot !== undefined && o.view.slots[only.slot] && wanted(o.view.slots[only.slot]!.name) ? only.slot : undefined;
        for (let i = 0; i < o.view.slots.length; i++) {
          if (cancelled()) break;
          const st = o.view.slots[i];
          if (!st) continue;
          if (only && (!wanted(st.name) || got >= only.want || (pinned !== undefined && i !== pinned))) continue;
          const count = only ? Math.min(st.count, only.want - got) : undefined;
          // two slots stay free (see the file comment)
          if (this.freeSlots().length - this.slotsFor(count === undefined ? st : { ...st, count }, this.d.inventory.rawItem?.(o.view.id, i)) < 2) {
            left++;
            continue;
          }
          const t = await this.d.skills.take(o.view, i, count);
          got += t.moved;
          if (t.moved > 0) tally.requests++;
          if (o.view.slots[i]) left++;
          if (!t.ok && t.reason !== 'inventory_full') break;
        }
      } finally {
        await this.d.skills.closeContainer(o.view);
      }
    }
    // picked up also after a cancel (a short try; the rest and an interrupted break: `standing` / the left boxes for `recover`)
    const back = await this.cleanUp(placed.at, cancelled, named);
    if (typeof back === 'string') return back;
    if (out) out.slot = back;
    if (cancelled()) return 'interrupted';
    if (!o.ok) return `open: ${o.reason}`;
    return left > 0 ? 'emptied partly' : 'emptied';
  }

  /**
   * Track T3 follow-up 2 (`!test inv restore`): place the box of `slot`, take out at most `want` of each item (by name),
   * the box's last slots first (what a deposit added sits in the slots that were free; the box's own stacks keep theirs),
   * keeping two inventory slots free as takeOut does, break it and pick it up: what was taken, the box's slot after, and
   * why it stopped (undefined: all of `want` taken).
   */
  async takeBack(slot: number, want: Readonly<Record<string, number>>, tally: BoxTally, cancelled: () => boolean, avoid?: (p: Vec3) => boolean): Promise<{ taken: Record<string, number>; slot?: number; why?: string }> {
    const taken: Record<string, number> = {};
    const named = this.namedAt(slot);
    const id = this.identity(slot);
    const s = await this.exact(slot, cancelled);
    if (typeof s === 'string') {
      const at = this.locate(id, slot);
      return { taken, ...(at !== undefined ? { slot: at } : {}), why: s };
    }
    const placed = await this.place(s, cancelled, avoid); // Track B4: the build's cells to avoid
    if ('reason' in placed) return { taken, ...(placed.slot !== undefined ? { slot: placed.slot } : {}), why: placed.reason };
    const left = (n: string) => (want[n] ?? 0) - (taken[n] ?? 0);
    let why: string | undefined;
    const o = await this.openPlaced(placed.at);
    if (o.ok) {
      try {
        for (let i = o.view.slots.length - 1; i >= 0; i--) {
          if (cancelled()) break;
          const st = o.view.slots[i];
          if (!st || left(st.name) <= 0) continue;
          const count = Math.min(st.count, left(st.name));
          if (this.freeSlots().length - this.slotsFor({ ...st, count }, this.d.inventory.rawItem?.(o.view.id, i)) < 2) {
            why = 'no room in the inventory';
            continue;
          }
          const t = await this.d.skills.take(o.view, i, count);
          if (t.moved > 0) {
            taken[st.name] = (taken[st.name] ?? 0) + t.moved;
            tally.requests++;
          }
          if (!t.ok && t.reason !== 'inventory_full') {
            why = `take: ${t.reason ?? 'failed'}`;
            break;
          }
        }
      } finally {
        await this.d.skills.closeContainer(o.view);
      }
    } else why = `open: ${o.reason}`;
    const back = await this.cleanUp(placed.at, cancelled, named);
    if (typeof back === 'string') return { taken, why: back };
    if (cancelled()) why = 'interrupted';
    if (!why && Object.keys(want).some((n) => left(n) > 0)) why = 'not all found in the box';
    return { taken, slot: back, ...(why ? { why } : {}) };
  }

  /**
   * Place the box of `slot` (where the place skill picks it) next to the bot, deposit `moves(view)` in up to 3 passes
   * (an empty list ends them), close, break it and pick it up again, also after a cancel (never left standing): the
   * items moved, the box's slot after the pickup (or why it did not come back), and why the box did not open.
   */
  async putIn(slot: number, moves: (view: ContainerView) => { slot: number; count: number; name?: string }[], tally: BoxTally, cancelled: () => boolean, opts: { onMoved?: (r: DepositResult) => void; avoid?: (p: Vec3) => boolean } = {}): Promise<{ moved: number; back: number | string; open?: string } | { reason: string }> {
    const named = this.namedAt(slot);
    const s = await this.exact(slot, cancelled);
    if (typeof s === 'string') return { reason: s };
    const placed = await this.place(s, cancelled, opts.avoid);
    if ('reason' in placed) return placed;
    let moved = 0;
    const o = await this.openPlaced(placed.at);
    if (o.ok) {
      try {
        for (let pass = 0; pass < 3; pass++) {
          const m = moves(o.view);
          if (m.length === 0) break;
          const r = await this.d.skills.depositSlots(o.view, m);
          tally.requests += r.requests;
          moved += r.total;
          opts.onMoved?.(r);
          if (r.total === 0 || r.reason === 'container_full' || cancelled()) break;
        }
      } finally {
        await this.d.skills.closeContainer(o.view);
      }
    }
    const back = await this.cleanUp(placed.at, cancelled, named);
    return { moved, back, ...(o.ok ? {} : { open: o.reason }) };
  }

  /**
   * Walk back to the boxes left on the ground and pick them up: true when a box came back. `keep`: one still not found
   * stays remembered for the next job's try (the walk right after the break), else it is given up.
   */
  async fetchLeft(cancelled: () => boolean, keep = false): Promise<boolean> {
    let got = false;
    // (Track B4: each box stays in the list until it is picked up or given up, so a watcher reading the list mid-walk, the
    // build's progress, still sees it; before, the list was emptied for the walk and refilled after)
    const todo = [...this.leftBoxes];
    while (todo.length > 0) {
      if (this.freeSlots().length === 0 || cancelled()) break;
      const at = todo.shift()!;
      const m = this.meta(at);
      if (this.now() - m.since > LEFT_MAX_AGE_MS || m.tries >= MAX_FETCH_TRIES) {
        this.giveUp(at);
        continue;
      }
      if (!this.inRange(at)) continue; // far away: kept (chat said where)
      m.tries++;
      const before = this.boxKeys();
      await this.d.skills.goto({ type: 'near', p: centre(at), r: 1.5 }, { timeoutTicks: 400 });
      if (cancelled()) break;
      await this.d.skills.collect(6, 100, { origin: centre(at), filter: (i) => isShulkerBox(i.name) });
      const ok = [...this.boxKeys()].some((i) => !before.has(i));
      got ||= ok;
      this.log.info(`${this.label}: the box left at ${fmtPos(at)}: ${ok ? 'picked up on the second try' : keep && m.tries < MAX_FETCH_TRIES ? 'not found yet (tried again by the next job)' : 'still not found (picked up by a player, or gone)'}`);
      if (ok) {
        this.state.left?.delete(cellKey(at));
        this.forget(at);
      } else if (!(keep && m.tries < MAX_FETCH_TRIES)) this.giveUp(at);
    }
    return got;
  }

  /** Track B4: a left box picked up or given up: out of the list. */
  private forget(at: Vec3): void {
    const i = this.leftBoxes.findIndex((p) => cellKey(p) === cellKey(at));
    if (i < 0) return;
    this.leftBoxes.splice(i, 1);
    this.changed();
  }

  private giveUp(at: Vec3): void {
    this.state.left?.delete(cellKey(at));
    this.forget(at);
    this.d.notify?.(`gave up on the shulker box left at ${fmtPos(at)} (not found)`);
  }

  /**
   * Break the box at `at` and pick it up again (also an empty one): its new inventory slot, or why not. `named`: the
   * box broken is (true) or is not (false) a bot_loot box: a new slot of the other sort (another box lying there) is
   * not taken for it. A box not picked up is remembered (also on a cancel) and fetched later.
   */
  async breakAndPickUp(at: Vec3, cancelled: () => boolean, named?: boolean, quick = false): Promise<number | string> {
    const before = this.boxKeys();
    // a box broken meanwhile (a player, a mob, an explosion): no dig, straight to the pickup
    const b = this.d.blockAt(at);
    if (b && b.name !== 'unknown' && isShulkerBox(b.name)) {
      const dg = await this.d.skills.dig(at);
      // still standing: `standing` keeps the cell (the chore ignores it; `recover` breaks it later)
      if (!dg.ok && dg.reason !== 'no_block') {
        this.d.notify?.(`a shulker box still stands at ${fmtPos(at)}; I break it and pick it up when I am near it again`);
        return dg.reason === 'interrupted' ? 'interrupted' : `break: ${dg.reason ?? 'failed'}`;
      }
    }
    const fresh = (): number | undefined => [...this.boxKeys()].find((i) => !before.has(i) && (named === undefined || this.namedAt(i) === named));
    // `quick` (after a cancel): one pickup close by, the rest is left to `recover`
    for (const radius of quick ? [4] : [4, 6, 10]) {
      await this.d.skills.collect(radius, 100, { origin: centre(at), filter: (i) => isShulkerBox(i.name) });
      if (fresh() !== undefined) break;
      if (cancelled()) break;
    }
    // gone from the world (picked up, or an item on the ground; Track B4: left first, so a watcher never sees it nowhere)
    if (fresh() === undefined) this.leave(at);
    this.unmarkStanding(at);
    if (fresh() === undefined && cancelled()) return 'interrupted';
    return fresh() ?? `the box was not picked up again (left at ${fmtPos(at)})`;
  }

  /** After the work at a placed box: cancelled meanwhile, the short clean-up (see the file comment), else pickUpOrFetch. */
  private cleanUp(at: Vec3, cancelled: () => boolean, named?: boolean): Promise<number | string> {
    if (!cancelled()) return this.pickUpOrFetch(at, () => false, named);
    return this.breakAndPickUp(at, cancelled, named, true).then((r) => {
      if (typeof r === 'string') this.sayLeft(at);
      return r;
    });
  }

  /** breakAndPickUp, then (not picked up) a walk to it at once: its slot, or why not. */
  async pickUpOrFetch(at: Vec3, cancelled: () => boolean, named?: boolean): Promise<number | string> {
    const keys = this.boxKeys();
    const back = await this.breakAndPickUp(at, cancelled, named);
    if (typeof back !== 'string' || back === 'interrupted') return back;
    await this.fetchLeft(cancelled, true);
    const got = [...this.boxKeys()].find((i) => !keys.has(i) && (named === undefined || this.namedAt(i) === named));
    if (got === undefined) this.sayLeft(at);
    return got ?? back;
  }

  /**
   * Track V1c: open the box just placed at `at`; one more click when the first gets no container_open (the Realm
   * 2026-11-16: placed, `no container_open`, the cell's lid free in the model as far as the log shows), and the block
   * over the lid in the log line when neither opens it (a block with a collision box there keeps a box shut:
   * container/stash.ts lidOpen).
   */
  private async openPlaced(at: Vec3): Promise<OpenResult> {
    const first = await this.d.skills.open(at);
    if (first.ok || first.reason !== 'timeout') return first;
    const again = await this.d.skills.open(at);
    const lid = this.d.blockAt({ ...at, y: at.y + 1 });
    this.log.warn(`${this.label}: the box at ${fmtPos(at)} did not open on the first click (${again.ok ? 'opened on the second' : `nor the second: ${again.reason}`}; over the lid: ${lid?.name ?? 'not loaded'}${lid && lid.boxes.length > 0 ? ' with a collision box' : ''})`);
    return again;
  }

  /**
   * Place the box of `slot` next to the bot (`slot` selected when in the hotbar; `placesExactly` must hold), never on a
   * cell `avoid` names (nor under one: the lid). A different box placed (the model moved meanwhile) is broken and picked up again;
   * which box went is told by the census of the boxes carried (`wrongBox`), not by their slots.
   */
  async place(slot: number, cancelled: () => boolean, avoid?: (p: Vec3) => boolean): Promise<{ at: Vec3 } | { reason: string; slot?: number }> {
    const inv = this.d.inventory.slots;
    const name = inv[slot]?.name;
    if (!name || !isShulkerBox(name)) return { reason: `no box in slot ${slot}` };
    if (!placesExactly(inv, slot)) return { reason: 'the box is not in the hotbar (another box of that colour would be placed)', slot };
    if (slot < 9) this.d.selectHotbar?.(slot);
    // Track V1 follow-up 3: the boxes by what they are (name, custom name, contents), not by slot: an exchange, a keeper
    // move or a resync may move another box meanwhile (the Realm 2026-11-16 judged the right box placed the wrong one)
    const want = this.identity(slot);
    const before = this.boxCensus();
    const feet = this.d.position();
    const spots = (feet ? boxSpots((q) => this.d.blockAt(q), feet) : []).filter((p) => !avoid || (!avoid(p) && !avoid({ ...p, y: p.y + 1 })));
    let at: Vec3 | undefined;
    for (const p of spots.slice(0, 3)) {
      // standing before the place: its own block update is never read as a new container (Track B4: and a watcher has
      // recorded it before the request goes)
      this.markStanding(p);
      const r = await this.d.skills.place(p, { face: 'up', item: name });
      if (r.ok) {
        at = p;
        break;
      }
      if (!isShulkerBox(this.d.blockAt(p)?.name ?? '')) this.unmarkStanding(p);
      if (cancelled()) return { reason: 'interrupted', slot };
    }
    if (!at) return { reason: 'no free cell for the box next to the bot', slot };
    // a pre-emption right after the place: the box is broken and picked up again rather than left standing
    if (cancelled()) {
      const back = await this.breakAndPickUp(at, cancelled, undefined, true);
      if (typeof back === 'string') this.sayLeft(at);
      return { reason: 'interrupted', ...(typeof back === 'number' ? { slot: back } : {}) };
    }
    const wrong = wrongBox(before, this.boxCensus(), want, name);
    if (wrong) {
      this.log.warn(`${this.label}: placed another box than the ${name} wanted at ${fmtPos(at)}: ${wrong}`);
      await this.breakAndPickUp(at, () => false);
      return { reason: cancelled() ? 'interrupted' : `placed another box than the one wanted (picked it up again): ${wrong}` };
    }
    return { at };
  }

  /** The boxes carried by identity (name, custom name, contents): how many of each. */
  private boxCensus(): Map<string, number> {
    const out = new Map<string, number>();
    for (const i of this.boxKeys()) {
      const id = this.identity(i);
      out.set(id, (out.get(id) ?? 0) + 1);
    }
    return out;
  }
}

/**
 * Track V1 follow-up 3: was another box placed than the one wanted? The census of the carried boxes before and after the
 * place (by identity, BoxOps.identity), wherever they lie: every box but the wanted one is still carried, and the wanted
 * one is gone or (the server's slot update not in yet) still there. The change when another box went, else undefined.
 */
export function wrongBox(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>, want: string, wantName: string): string | undefined {
  const nameOf = (id: string) => id.slice(0, id.indexOf('|'));
  const byName = (m: ReadonlyMap<string, number>) => {
    const out = new Map<string, number>();
    for (const [id, n] of m) out.set(nameOf(id), (out.get(nameOf(id)) ?? 0) + n);
    return out;
  };
  // by name first (a box whose contents the model lost still counts as itself)
  const nb = byName(before);
  const na = byName(after);
  const lost: string[] = [];
  for (const [n, c] of nb) {
    const a = na.get(n) ?? 0;
    if (a < c - (n === wantName ? 1 : 0)) lost.push(`${n} ${c} -> ${a}`);
  }
  if (lost.length > 0) return `gone from the inventory: ${lost.join(', ')}`;
  // a box of the same colour: the one gone must be the wanted one
  for (const [id, c] of before) {
    if (id === want || nameOf(id) !== wantName) continue;
    const a = after.get(id) ?? 0;
    if (a < c && (after.get(want) ?? 0) >= (before.get(want) ?? 0)) return `the other ${wantName} (${id.split('|').slice(1).join(' ') || 'empty'}) is gone, the wanted one still carried`;
  }
  return undefined;
}
