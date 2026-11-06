// Item and container events from inventory diffs (decision 0059, docs/events.md "Batching"). No skill
// reports what it picked up, crafted or stored, and none has to: the tally watches the inventory
// model (slots 0..35, the offhand and the armour) and turns every change into a delta per item name.
//
// - While a storage window (chest, barrel, shulker box, ender chest: window type `container`) is open,
//   the deltas belong to that container: at container_close one `container.deposit` (what left the
//   inventory) and one `container.withdraw` (what came in), with the block position.
// - Every other delta goes into the running batch, written as one `items.changed` (gained / lost per
//   name and the jobs that ran meanwhile) at the end of each job and once a minute, never per stack.
// - After a spawn the inventory arrives in several packets: the first SETTLE_MS only set the baseline
//   (a reconnect never reads as "gained everything").
import type { Vec3 } from '../connection/types.ts';
import type { ItemStack } from '../world/types.ts';
import { events as defaultBus, type EventBus } from './bus.ts';

/** Inventory windows counted: the player inventory, the offhand, the armour. */
export const COUNTED_WINDOWS = [0, 119, 120] as const;
/** Window types that are storage (container_open `window_type`). */
export const STORAGE_TYPES: ReadonlySet<string> = new Set(['container', '0', 'minecart_chest', 'chest_boat']);
export const ITEMS_FLUSH_MS = 60_000;
export const SETTLE_MS = 3000;
/** Names kept per batch (the rest are summed under `other`). */
const MAX_NAMES = 64;

export interface TallyInventory {
  window(id: number): { slots: readonly (ItemStack | null)[] } | undefined;
  onChange(fn: (window: number, slot: number | undefined) => void): () => void;
}

export interface ItemTallyOptions {
  inventory: TallyInventory;
  bus?: EventBus;
  flushMs?: number;
  settleMs?: number;
  now?: () => number;
  /** The block name at a container's position (the world model), for the event text. */
  blockAt?: (p: Vec3) => string | undefined;
}

type Counts = Map<string, number>;

function add(m: Counts, k: string, n: number): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

function toRecord(m: Counts): Record<string, number> {
  const e = [...m.entries()].filter(([, n]) => n !== 0).sort((a, b) => b[1] - a[1]);
  const out: Record<string, number> = {};
  for (const [k, n] of e.slice(0, MAX_NAMES)) out[k] = n;
  const rest = e.slice(MAX_NAMES).reduce((a, [, n]) => a + n, 0);
  if (rest) out.other = (out.other ?? 0) + rest;
  return out;
}

/** Item name -> count over the counted windows. */
export function countInventory(inv: Pick<TallyInventory, 'window'>): Counts {
  const m: Counts = new Map();
  for (const w of COUNTED_WINDOWS) {
    const slots = inv.window(w)?.slots ?? [];
    const end = w === 0 ? Math.min(slots.length, 36) : slots.length;
    for (let i = 0; i < end; i++) {
      const s = slots[i];
      if (s && s.count > 0) add(m, s.name, s.count);
    }
  }
  return m;
}

export class ItemTally {
  private readonly o: ItemTallyOptions;
  private readonly bus: EventBus;
  private readonly now: () => number;
  private base: Counts | undefined;
  private settleUntil = 0;
  private gained: Counts = new Map();
  private lost: Counts = new Map();
  private jobs = new Set<string>();
  /** Jobs started and not ended (named in every batch while they run). */
  private readonly running = new Map<string, number>();
  private since: number;
  private session: { pos: Vec3; type: string; in: Counts; out: Counts } | undefined;
  private queued = false;
  private readonly unsubs: (() => void)[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(o: ItemTallyOptions) {
    this.o = o;
    this.bus = o.bus ?? defaultBus;
    this.now = o.now ?? Date.now;
    this.since = this.now();
    this.unsubs.push(
      o.inventory.onChange((w) => {
        if (!(COUNTED_WINDOWS as readonly number[]).includes(w) || this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          this.diff();
        });
      }),
      this.bus.subscribe((e) => {
        if (e.kind === 'job.started') {
          const j = (e.data as { job: string }).job;
          this.jobs.add(j);
          this.running.set(j, (this.running.get(j) ?? 0) + 1);
        } else if (e.kind === 'job.finished' || e.kind === 'job.failed' || e.kind === 'job.stopped') {
          const j = (e.data as { job: string }).job;
          this.jobs.add(j);
          const n = (this.running.get(j) ?? 1) - 1;
          if (n > 0) this.running.set(j, n);
          else this.running.delete(j);
          this.flush();
        }
      }),
    );
    this.timer = setInterval(() => {
      this.flush();
    }, o.flushMs ?? ITEMS_FLUSH_MS);
    this.timer.unref();
  }

  /** A new session (spawn, reconnect): the next SETTLE_MS of changes only set the baseline. */
  reset(): void {
    this.diff();
    this.base = undefined;
    this.settleUntil = this.now() + (this.o.settleMs ?? SETTLE_MS);
    this.session = undefined;
  }

  /** Count the inventory and book the change since the last count. */
  diff(): void {
    const cur = countInventory(this.o.inventory);
    const base = this.base;
    this.base = cur;
    if (!base || this.now() < this.settleUntil) return;
    const s = this.session;
    for (const k of new Set([...cur.keys(), ...base.keys()])) {
      const d = (cur.get(k) ?? 0) - (base.get(k) ?? 0);
      if (d === 0) continue;
      if (s) add(d > 0 ? s.in : s.out, k, Math.abs(d));
      else add(d > 0 ? this.gained : this.lost, k, Math.abs(d));
    }
  }

  /** container_open: storage windows start a session (earlier changes are booked first). */
  containerOpen(pos: Vec3, type: string): void {
    this.diff();
    this.closeSession();
    if (STORAGE_TYPES.has(type)) this.session = { pos: { x: pos.x, y: pos.y, z: pos.z }, type, in: new Map(), out: new Map() };
  }

  /** container_close: the session's deposit / withdraw events. */
  containerClose(): void {
    this.diff();
    this.closeSession();
  }

  private closeSession(): void {
    const s = this.session;
    this.session = undefined;
    if (!s) return;
    const block = this.o.blockAt?.(s.pos);
    const extra = block ? { block } : {};
    if (s.out.size) this.bus.emit('container.deposit', { at: s.pos, ...extra, items: toRecord(s.out) });
    if (s.in.size) this.bus.emit('container.withdraw', { at: s.pos, ...extra, items: toRecord(s.in) });
  }

  /** Write the batch as one items.changed (nothing when nothing changed). */
  flush(): void {
    this.diff();
    const gained = toRecord(this.gained);
    const lost = toRecord(this.lost);
    const now = this.now();
    if (Object.keys(gained).length || Object.keys(lost).length) {
      this.bus.emit('items.changed', { gained, lost, jobs: [...this.jobs], periodS: Math.round((now - this.since) / 1000) });
    }
    this.gained = new Map();
    this.lost = new Map();
    this.jobs = new Set(this.running.keys());
    this.since = now;
  }

  stop(): void {
    this.closeSession();
    this.flush();
    clearInterval(this.timer);
    for (const u of this.unsubs.splice(0)) u();
  }
}
