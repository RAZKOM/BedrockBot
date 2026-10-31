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
import { isShulkerBox, maxStackOf, shulkerContents, shulkerSlotsUsed, type DepositResult, type OpenResult } from '../container/chest.ts';
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
        this.standing.delete(k);
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

  /** New inventory slots that taking the stack `st` out of a window uses: none for what tops up partial stacks of the same item (a shulker box never stacks). */
  slotsFor(st: { name: string; count: number; metadata?: number }): number {
    const max = maxStackOf(st.name);
    let room = 0;
    if (!isShulkerBox(st.name)) {
      for (const s of this.d.inventory.slots.slice(0, 36)) {
        if (s?.name === st.name && s.metadata === st.metadata && s.count < max) room += max - s.count;
      }
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
  async takeOut(slot: number, tally: BoxTally, cancelled: () => boolean, only?: { item: string | ((name: string) => boolean); want: number }, out?: { slot?: number }, avoid?: (p: Vec3) => boolean): Promise<string> {
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
    const o = await this.d.skills.open(placed.at);
    if (o.ok) {
      try {
        for (let i = 0; i < o.view.slots.length; i++) {
          if (cancelled()) break;
          const st = o.view.slots[i];
          if (!st) continue;
          if (only && (!(typeof only.item === 'string' ? st.name === only.item : only.item(st.name)) || got >= only.want)) continue;
          const count = only ? Math.min(st.count, only.want - got) : undefined;
          // two slots stay free (see the file comment)
          if (this.freeSlots().length - this.slotsFor(count === undefined ? st : { ...st, count }) < 2) {
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
    const o = await this.d.skills.open(placed.at);
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
    const todo = this.leftBoxes.splice(0);
    const later: Vec3[] = [];
    while (todo.length > 0) {
      if (this.freeSlots().length === 0 || cancelled()) break;
      const at = todo.shift()!;
      const m = this.meta(at);
      if (this.now() - m.since > LEFT_MAX_AGE_MS || m.tries >= MAX_FETCH_TRIES) {
        this.giveUp(at);
        continue;
      }
      if (!this.inRange(at)) {
        later.push(at); // far away: kept (chat said where)
        continue;
      }
      m.tries++;
      const before = this.boxKeys();
      await this.d.skills.goto({ type: 'near', p: centre(at), r: 1.5 }, { timeoutTicks: 400 });
      if (cancelled()) {
        todo.unshift(at);
        break;
      }
      await this.d.skills.collect(6, 100, { origin: centre(at), filter: (i) => isShulkerBox(i.name) });
      const ok = [...this.boxKeys()].some((i) => !before.has(i));
      got ||= ok;
      this.log.info(`${this.label}: the box left at ${fmtPos(at)}: ${ok ? 'picked up on the second try' : keep && m.tries < MAX_FETCH_TRIES ? 'not found yet (tried again by the next job)' : 'still not found (picked up by a player, or gone)'}`);
      if (ok) this.state.left?.delete(cellKey(at));
      else if (keep && m.tries < MAX_FETCH_TRIES) later.push(at);
      else this.giveUp(at);
    }
    this.leftBoxes.push(...later, ...todo);
    return got;
  }

  private giveUp(at: Vec3): void {
    this.state.left?.delete(cellKey(at));
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
    this.standing.delete(cellKey(at)); // gone from the world (picked up, or an item on the ground)
    if (fresh() === undefined) this.leave(at);
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
   * Place the box of `slot` next to the bot (`slot` selected when in the hotbar; `placesExactly` must hold), never on a
   * cell `avoid` names (nor under one: the lid). A different box placed (the model moved meanwhile) is broken and picked up again.
   */
  async place(slot: number, cancelled: () => boolean, avoid?: (p: Vec3) => boolean): Promise<{ at: Vec3 } | { reason: string; slot?: number }> {
    const inv = this.d.inventory.slots;
    const name = inv[slot]?.name;
    if (!name || !isShulkerBox(name)) return { reason: `no box in slot ${slot}` };
    if (!placesExactly(inv, slot)) return { reason: 'the box is not in the hotbar (another box of that colour would be placed)', slot };
    if (slot < 9) this.d.selectHotbar?.(slot);
    const others = new Map<number, string>();
    inv.slice(0, 36).forEach((x, i) => {
      if (i !== slot && x && isShulkerBox(x.name)) others.set(i, x.name);
    });
    const feet = this.d.position();
    const spots = (feet ? boxSpots((q) => this.d.blockAt(q), feet) : []).filter((p) => !avoid || (!avoid(p) && !avoid({ ...p, y: p.y + 1 })));
    let at: Vec3 | undefined;
    for (const p of spots.slice(0, 3)) {
      // standing before the place: its own block update is never read as a new container
      this.standing.add(cellKey(p));
      const r = await this.d.skills.place(p, { face: 'up', item: name });
      if (r.ok) {
        at = p;
        break;
      }
      if (!isShulkerBox(this.d.blockAt(p)?.name ?? '')) this.standing.delete(cellKey(p));
      if (cancelled()) return { reason: 'interrupted', slot };
    }
    if (!at) return { reason: 'no free cell for the box next to the bot', slot };
    // a pre-emption right after the place: the box is broken and picked up again rather than left standing
    if (cancelled()) {
      const back = await this.breakAndPickUp(at, cancelled, undefined, true);
      if (typeof back === 'string') this.sayLeft(at);
      return { reason: 'interrupted', ...(typeof back === 'number' ? { slot: back } : {}) };
    }
    const now = this.d.inventory.slots;
    if ([...others].some(([i, n]) => now[i]?.name !== n)) {
      await this.breakAndPickUp(at, () => false);
      return { reason: cancelled() ? 'interrupted' : 'placed another box than the one wanted (picked it up again)' };
    }
    return { at };
  }
}
