// Track V (wave 7, docs/pve.md "Weapon pull"): move the best item for a job from the main inventory
// (slots 9..35) into the hotbar (0..8), so the combat skill fights with the sword that sat in the
// main inventory (the Realm bot held cooked beef in a fight) and the Digger uses the pickaxe that sat
// there (PLAN.md 7.11 open point).
//
//   const r = await ensureInHotbar({ hotbar, containers, inventory, score: (it) => weaponScore(it.name), toolOk, queue, runtimeId, waitTicks });
//   // { ok: true, slot: 3, item: 'iron_sword', moved: true, from: 17 }
//
// BDS 1.26.60.6 refuses item stack requests between player inventory slots unless the inventory screen
// is open (status 49 / 50; docs/survival.md "Packets", docs/interaction.md "Items"): `interact
// open_inventory` -> container_open (type 'inventory') -> item_stack_request place ... -> container_close.
// Every move goes through the task's `Containers.move` (world/containers.ts), so all item stack
// requests of the connection share one request-id counter; nothing here creates a second Containers.
// A full hotbar: the least useful hotbar item (no durability, not food, not `keep`) is parked in a free
// main-inventory slot first, then the wanted item takes its hotbar slot (two `place` requests in one
// screen). With no free main-inventory slot either the pull fails with `no_space`.
import { silentLogger, type Logger } from '../../log.ts';
import { blockMining, toolOf } from '../../data/mining.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { ItemStack } from '../../world/types.ts';
import { estimateBreak, isEffective } from '../dig/breakTime.ts';
import { wireItemOf } from '../place/place.ts';
import { FOODS } from '../survival/eat.ts';
import { maxDurability } from '../survival/tools.ts';

const HOTBAR = 9;
const SLOTS = 36;

/** `Containers` (world/containers.ts) as the moves use it. */
export interface HotbarMoveContainers {
  move(src: { window: number; slot: number }, dst: { window: number; slot: number }, count: number): Promise<{ ok: boolean; reason?: string }>;
  readonly open: { id: number; type: string } | undefined;
  onOpen(fn: (c: { id: number; type: string }) => void): () => void;
  onClose(fn: (id: number, byServer: boolean) => void): () => void;
  close(id: number, type?: string): void;
}

/**
 * The task's Containers as attached to BotSkills (`skills.attach({ containers })`, read at call time
 * through any proxy such as `settingsMover`): a public `containers` if the skills ever expose one,
 * else the attached parts. undefined = none attached (yet).
 */
export function containersOf(skills: unknown): HotbarMoveContainers | undefined {
  const s = skills as { containers?: HotbarMoveContainers; parts?: { containers?: HotbarMoveContainers } } | undefined;
  const c = s?.containers ?? s?.parts?.containers;
  return c && typeof c.move === 'function' ? c : undefined;
}

/** `Hotbar` (world/hotbar.ts) as the moves use it. */
export interface HotbarMoveHotbar {
  select(slot: number): boolean;
  noteRaw?(slot: number, item: ItemV4 | undefined): void;
}

export interface HotbarMoveInventory {
  readonly slots: readonly (ItemStack | null)[];
  readonly selected: number;
}

export interface EnsureInHotbarArgs {
  hotbar: HotbarMoveHotbar | undefined;
  containers: HotbarMoveContainers | undefined;
  inventory: HotbarMoveInventory;
  /** How good an item is for the job; 0 or less = not a candidate. The highest wins. */
  score: (item: ItemStack) => number;
  /** Track S predicate (worn tools fail it: `toolWearLimit`); failing items are never candidates. */
  toolOk?: (item: ItemStack) => boolean;
  /** Select the slot afterwards. Default true. */
  select?: boolean;
  /** Hotbar items that may not be parked in the main inventory to make room. Default: none protected beyond the rules. */
  keep?: (item: ItemStack) => boolean;
  /** Packet queue (the `interact open_inventory`). */
  queue: (name: string, params: Record<string, unknown>) => void;
  /** Own runtime id (target of `interact open_inventory`). */
  runtimeId: () => bigint;
  waitTicks: (n: number) => Promise<void>;
  logger?: Logger;
  /** For the log line. */
  label?: string;
}

export type EnsureResult =
  | { ok: true; slot: number; item: string; moved: boolean; from?: number; parked?: number }
  | { ok: false; reason: 'none' | 'no_containers' | 'no_space' | 'move_failed' | 'no_inventory_window' };

/** The best slot by `score` in [from, to); ties go to `prefer`, then the lowest slot. */
export function bestSlot(slots: readonly (ItemStack | null)[], from: number, to: number, score: (it: ItemStack) => number, ok: (it: ItemStack) => boolean = () => true, prefer = -1): { slot: number; score: number } | undefined {
  let best: { slot: number; score: number } | undefined;
  for (let i = from; i < to; i++) {
    const it = slots[i];
    if (!it || it.count <= 0 || !ok(it)) continue;
    const s = score(it);
    if (s <= 0) continue;
    if (!best || s > best.score || (s === best.score && i === prefer)) best = { slot: i, score: s };
  }
  return best;
}

/**
 * The hotbar slot to put the item in: an empty one, else the least useful item that may be parked
 * (no durability before food before anything with durability; never `keep`, never a candidate for
 * this job; the selected slot last, then the highest slot). undefined = none.
 */
export function hotbarTarget(inv: HotbarMoveInventory, score: (it: ItemStack) => number, keep: (it: ItemStack) => boolean = () => false): { slot: number; empty: boolean } | undefined {
  for (let i = 0; i < HOTBAR; i++) if (!inv.slots[i]) return { slot: i, empty: true };
  let best: { slot: number; rank: number } | undefined;
  for (let i = HOTBAR - 1; i >= 0; i--) {
    const it = inv.slots[i]!;
    if (keep(it) || score(it) > 0) continue;
    const rank = (maxDurability(it.name) !== undefined ? 20 : FOODS[it.name] ? 10 : 0) + (i === inv.selected ? 5 : 0);
    if (!best || rank < best.rank) best = { slot: i, rank };
  }
  return best ? { slot: best.slot, empty: false } : undefined;
}

/** The first free main-inventory slot (9..35). */
function freeMainSlot(inv: HotbarMoveInventory, except = -1): number | undefined {
  for (let i = HOTBAR; i < SLOTS; i++) if (!inv.slots[i] && i !== except) return i;
  return undefined;
}

/** One screen at a time per Containers (combat and the Digger may both pull). */
const locks = new WeakMap<object, Promise<unknown>>();

async function exclusive<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/**
 * Run `fn` with the inventory screen open. Another open window (a chest, the survival kit's screen)
 * is waited for up to 40 ticks; if it stays open the requests go out in it (like PlaceSkill).
 */
async function withScreen<T extends { ok: boolean }>(a: EnsureInHotbarArgs, c: HotbarMoveContainers, fn: () => Promise<T>): Promise<T | { ok: false; reason: 'no_inventory_window' }> {
  for (let i = 0; i < 40 && c.open; i++) await a.waitTicks(1);
  if (c.open) return fn();
  let opened: { id: number; type: string } | undefined;
  const offOpen = c.onOpen((o) => {
    if (o.type === 'inventory') opened = o;
  });
  a.queue('interact', { action_id: 'open_inventory', target_entity_id: a.runtimeId(), has_position: false });
  for (let i = 0; i < 20 && !opened; i++) await a.waitTicks(1);
  offOpen();
  if (!opened) return { ok: false, reason: 'no_inventory_window' };
  try {
    return await fn();
  } finally {
    const id = opened.id;
    let closed = false;
    const offClose = c.onClose((cid) => {
      if (cid === id) closed = true;
    });
    c.close(id, 'inventory');
    for (let i = 0; i < 20 && !closed; i++) await a.waitTicks(1);
    offClose();
  }
}

/**
 * Make sure the best item for the job is in the hotbar (and selected, unless `select: false`): when the
 * main inventory holds an item that scores higher than everything in the hotbar, move it in. Items
 * failing `toolOk` are never candidates. `{ ok: false, reason: 'none' }` when neither the hotbar nor
 * the main inventory has a candidate.
 */
export async function ensureInHotbar(a: EnsureInHotbarArgs): Promise<EnsureResult> {
  const inv = a.inventory;
  const ok = a.toolOk ?? (() => true);
  const log = a.logger ?? silentLogger;
  const inHotbar = bestSlot(inv.slots, 0, HOTBAR, a.score, ok, inv.selected);
  const inMain = bestSlot(inv.slots, HOTBAR, SLOTS, a.score, ok);
  if (!inMain || (inHotbar && inHotbar.score >= inMain.score)) {
    if (!inHotbar) return { ok: false, reason: 'none' };
    if (a.select !== false && inHotbar.slot !== inv.selected) a.hotbar?.select(inHotbar.slot);
    return { ok: true, slot: inHotbar.slot, item: inv.slots[inHotbar.slot]!.name, moved: false };
  }
  const c = a.containers;
  if (!c) return inHotbar ? keepHotbar(a, inHotbar.slot) : { ok: false, reason: 'no_containers' };
  return exclusive(c, async () => {
    // the model may have changed while waiting for the lock
    const src = bestSlot(inv.slots, HOTBAR, SLOTS, a.score, ok);
    if (!src) return { ok: false, reason: 'none' } as const;
    const target = hotbarTarget(inv, a.score, a.keep);
    if (!target) return { ok: false, reason: 'no_space' } as const;
    const park = target.empty ? undefined : freeMainSlot(inv, src.slot);
    if (!target.empty && park === undefined) return { ok: false, reason: 'no_space' } as const;
    const item = inv.slots[src.slot]!;
    const parked = target.empty ? undefined : inv.slots[target.slot]!;
    const r = await withScreen(a, c, async () => {
      if (parked && park !== undefined) {
        const p = await c.move({ window: 0, slot: target.slot }, { window: 0, slot: park }, parked.count);
        if (!p.ok) return { ok: false as const, reason: `park ${p.reason ?? 'failed'}` };
      }
      const m = await c.move({ window: 0, slot: src.slot }, { window: 0, slot: target.slot }, item.count);
      return m.ok ? { ok: true as const } : { ok: false as const, reason: m.reason ?? 'failed' };
    });
    if (!r.ok) {
      log.warn(`hotbar: moving ${item.name} ${src.slot} -> ${target.slot}${a.label ? ` (${a.label})` : ''} failed: ${'reason' in r ? r.reason : '?'}`);
      return { ok: false, reason: 'reason' in r && r.reason === 'no_inventory_window' ? 'no_inventory_window' : 'move_failed' } as const;
    }
    a.hotbar?.noteRaw?.(target.slot, wireItemOf(inv.slots[target.slot], undefined));
    log.info(`hotbar: ${item.name} moved from slot ${src.slot} to ${target.slot}${parked ? ` (${parked.name} parked in ${park})` : ''}${a.label ? ` for ${a.label}` : ''}`);
    if (a.select !== false && target.slot !== inv.selected) a.hotbar?.select(target.slot);
    return { ok: true, slot: target.slot, item: item.name, moved: true, from: src.slot, ...(park !== undefined ? { parked: park } : {}) } as const;
  });
}

function keepHotbar(a: EnsureInHotbarArgs, slot: number): EnsureResult {
  if (a.select !== false && slot !== a.inventory.selected) a.hotbar?.select(slot);
  return { ok: true, slot, item: a.inventory.slots[slot]!.name, moved: false };
}

/** Pickaxes, axes and shovels: how much a tool helps breaking `block` (0 = not at all). */
export function digToolScore(block: string): (item: ItemStack) => number {
  const b = blockMining(block);
  if (!b) return () => 0;
  const hand = estimateBreak(b, null);
  return (item) => {
    const tool = toolOf(item.name);
    if (!tool || (tool.type !== 'pickaxe' && tool.type !== 'axe' && tool.type !== 'shovel') || !isEffective(b, tool)) return 0;
    const est = estimateBreak(b, tool);
    const gain = Math.max(0, hand.ticks - est.ticks);
    return (est.canHarvest && !hand.canHarvest ? 10_000 : 0) + gain;
  };
}

/** What a HotbarPuller needs; the getters are read at every pull (parts may be attached later). */
export interface HotbarPullerDeps {
  containers: () => HotbarMoveContainers | undefined;
  hotbar: () => HotbarMoveHotbar | undefined;
  inventory: () => HotbarMoveInventory | undefined;
  toolOk: () => (item: ItemStack) => boolean;
  queue: (name: string, params: Record<string, unknown>) => void;
  runtimeId: () => bigint;
  waitTicks: (n: number) => Promise<void>;
  logger?: Logger;
  now?: () => number;
}

/** After a failed pull the same job is not tried again for this long (ms). */
export const PULL_RETRY_MS = 10_000;

/**
 * `ensureInHotbar` with a memory: `pull(job, score)` returns undefined (synchronously) when nothing in
 * the main inventory beats the hotbar or the job failed less than 10 s ago, so a caller can do
 * `const p = puller.pull(...); if (p) await p;` without loops. `digHook` is the Digger's `pullTool`.
 */
export class HotbarPuller {
  private readonly d: HotbarPullerDeps;
  private readonly now: () => number;
  private readonly failedUntil = new Map<string, number>();
  private readonly running = new Map<string, Promise<EnsureResult>>();
  readonly stats = { pulls: 0, moved: 0, failed: 0 };

  constructor(d: HotbarPullerDeps) {
    this.d = d;
    this.now = d.now ?? (() => performance.now());
  }

  /** True when the main inventory holds a better candidate than the hotbar (and the job may be tried). */
  wants(job: string, score: (item: ItemStack) => number): boolean {
    const inv = this.d.inventory();
    if (!inv || (this.failedUntil.get(job) ?? 0) > this.now()) return false;
    const ok = this.d.toolOk();
    const m = bestSlot(inv.slots, HOTBAR, SLOTS, score, ok);
    if (!m) return false;
    const h = bestSlot(inv.slots, 0, HOTBAR, score, ok);
    return !h || m.score > h.score;
  }

  pull(job: string, score: (item: ItemStack) => number, opts: { select?: boolean; keep?: (item: ItemStack) => boolean } = {}): Promise<EnsureResult> | undefined {
    const busy = this.running.get(job);
    if (busy) return busy;
    if (!this.wants(job, score)) return undefined;
    const inv = this.d.inventory()!;
    this.stats.pulls++;
    const p = ensureInHotbar({
      hotbar: this.d.hotbar(),
      containers: this.d.containers(),
      inventory: inv,
      score,
      toolOk: this.d.toolOk(),
      queue: this.d.queue,
      runtimeId: this.d.runtimeId,
      waitTicks: this.d.waitTicks,
      label: job,
      ...(opts.select !== undefined ? { select: opts.select } : {}),
      ...(opts.keep ? { keep: opts.keep } : {}),
      ...(this.d.logger ? { logger: this.d.logger } : {}),
    })
      .then((r) => {
        if (r.ok && r.moved) this.stats.moved++;
        if (!r.ok) {
          this.stats.failed++;
          this.failedUntil.set(job, this.now() + PULL_RETRY_MS);
        }
        return r;
      })
      .finally(() => {
        this.running.delete(job);
      });
    this.running.set(job, p);
    return p;
  }

  /** The Digger's `pullTool` hook: a pickaxe / axe / shovel for `block` from the main inventory, if one beats the hotbar. */
  readonly digHook = (block: string): Promise<unknown> | undefined => this.pull(`dig ${block}`, digToolScore(block), { select: false });
}
