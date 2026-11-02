// Inventory keeper (PLAN.md task 7.11, Track S, docs/survival.md):
// - keep at least `throwawayMin` (setting, default 16) throwaway blocks (cobblestone, dirt, cobbled
//   deepslate, netherrack) in the hotbar while the inventory has them: a stack moves from the main
//   inventory into an empty hotbar slot (or onto a hotbar stack of the same block, or swaps with a
//   junk item in the hotbar);
// - when the inventory is full (no empty slot), drop junk (default rotten flesh, poisonous potato,
//   string, spider eye; configurable) until `freeTarget` (2) slots are free; never tools, weapons,
//   food (other than junk), armour, logs, planks, chests, torches;
// - `drop(name, n)` for `!drop`.
// Packets (verified on BDS 1.26.60.6): item_stack_request `drop { count, source, randomly: false }`;
// from a hotbar slot it works as is, from the main inventory only with the inventory screen open
// (status 49 otherwise), so every keeper action runs inside one screen. The item entity appears
// about 2.5 blocks in front of the eye (truth:items).
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemStack } from '../../world/types.ts';
import { armourSlotOf } from './armour.ts';
import { foodInfo } from './eat.ts';
import { inventorySlot, isOk, slotInfo, type StackRequests } from './screen.ts';
import { maxDurability } from './tools.ts';
import { isFlightKitItem } from '../fly/kit.ts'; // Track AU: the flight kit is never dropped
import { isShulkerBox } from '../container/chest.ts';

export const DEFAULT_THROWAWAY_MIN = 16;
export const THROWAWAY_BLOCKS: readonly string[] = ['cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack'];
export const DEFAULT_JUNK: readonly string[] = ['rotten_flesh', 'poisonous_potato', 'string', 'spider_eye'];
const INVENTORY_SIZE = 36;

const bare = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n);

/** Items the keeper never drops by itself (a `!drop` from the owner still can). */
export function neverDrop(name: string): boolean {
  const n = bare(name);
  if (isFlightKitItem(n)) return true; // Track AU: the elytra and the firework rockets (the fireworks box is a shulker box: never junk)
  if (maxDurability(n) !== undefined) return true; // tools, weapons, armour, shields ...
  if (armourSlotOf(n) !== undefined) return true;
  const food = foodInfo(n);
  if (food && !food.bad) return true;
  return (
    n.endsWith('_log') ||
    n.endsWith('_stem') ||
    n.endsWith('_wood') ||
    n.endsWith('_hyphae') ||
    n.endsWith('_planks') ||
    n === 'chest' ||
    n === 'trapped_chest' ||
    n === 'ender_chest' ||
    n.endsWith('torch') ||
    n === 'bone' ||
    n === 'gunpowder'
  );
}

export interface KeeperSettings {
  throwawayMin: number;
  throwaway: readonly string[];
  junk: readonly string[];
  /** Slots to free when full. Default 2. */
  freeTarget?: number;
}

export type KeeperStep =
  | { kind: 'stock'; from: number; to: number; item: string; count: number; mode: 'place' | 'swap' }
  | { kind: 'drop'; from: number; item: string; count: number };

/** Throwaway blocks in the hotbar. */
export function hotbarThrowaway(slots: readonly (ItemStack | null | undefined)[], throwaway: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < 9; i++) {
    const s = slots[i];
    if (s && throwaway.includes(s.name)) n += s.count;
  }
  return n;
}

/**
 * The hotbar slot to swap out when something has to come in (a shulker box for the stash step, food
 * to eat) and no slot is empty: junk first (the last such slot), else the last slot holding no tool
 * and not the selected one, preferring one that is neither the flight kit (rockets, elytra) nor a
 * shulker box (the fireworks box): the flight code expects those in the hotbar. Only when nothing
 * else is left do those qualify too. -1 when every slot is a tool, empty or selected.
 */
export function pickHotbarVictim(slots: readonly (ItemStack | null | undefined)[], selected: number, junk: readonly string[]): number {
  for (let i = 8; i >= 0; i--) if (slots[i] && junk.includes(slots[i]!.name)) return i;
  const plain = (i: number): boolean => !!slots[i] && maxDurability(bare(slots[i].name)) === undefined && i !== selected;
  for (let i = 8; i >= 0; i--) if (plain(i) && !isFlightKitItem(bare(slots[i]!.name)) && !isShulkerBox(slots[i]!.name)) return i;
  for (let i = 8; i >= 0; i--) if (plain(i)) return i;
  return -1;
}

/** What the keeper would do now (at most one stocking move and the drops for a full inventory). */
export function planKeeper(slots: readonly (ItemStack | null | undefined)[], s: KeeperSettings): KeeperStep[] {
  const out: KeeperStep[] = [];
  const isJunk = (it: ItemStack): boolean => s.junk.includes(it.name) && !neverDrop(it.name);
  // stocking
  if (s.throwawayMin > 0 && hotbarThrowaway(slots, s.throwaway) < s.throwawayMin) {
    let from = -1;
    for (let i = 9; i < INVENTORY_SIZE; i++) {
      const it = slots[i];
      if (it && s.throwaway.includes(it.name) && (from < 0 || it.count > slots[from]!.count)) from = i;
    }
    if (from >= 0) {
      const item = slots[from]!;
      let to = -1;
      let mode: 'place' | 'swap' = 'place';
      for (let i = 0; i < 9 && to < 0; i++) {
        const h = slots[i];
        if (h?.name === item.name && h.count < 64) to = i;
      }
      for (let i = 0; i < 9 && to < 0; i++) if (!slots[i]) to = i;
      for (let i = 8; i >= 0 && to < 0; i--) {
        const h = slots[i];
        if (h && isJunk(h)) {
          to = i;
          mode = 'swap';
        }
      }
      if (to >= 0) {
        const room = slots[to] && mode === 'place' ? 64 - slots[to]!.count : item.count;
        out.push({ kind: 'stock', from, to, item: item.name, count: Math.min(item.count, room), mode });
      }
    }
  }
  // drops when full
  const free = slots.slice(0, INVENTORY_SIZE).filter((x) => !x).length + Math.max(0, INVENTORY_SIZE - slots.length);
  const want = s.freeTarget ?? 2;
  if (free === 0) {
    const junk: number[] = [];
    for (let i = 0; i < Math.min(slots.length, INVENTORY_SIZE); i++) {
      const it = slots[i];
      if (it && isJunk(it)) junk.push(i);
    }
    // the biggest stacks of the least useful junk first (list order = least useful first)
    junk.sort((a, b) => s.junk.indexOf(slots[a]!.name) - s.junk.indexOf(slots[b]!.name) || slots[b]!.count - slots[a]!.count);
    const stockFrom = out[0]?.kind === 'stock' && out[0].mode === 'swap' ? out[0].to : -1;
    for (const i of junk.slice(0, want)) if (i !== stockFrom) out.push({ kind: 'drop', from: i, item: slots[i]!.name, count: slots[i]!.count });
  }
  return out;
}

export interface KeeperInventory {
  readonly slots: readonly (ItemStack | null)[];
  setItem(window: number, slot: number, item: ItemStack | null): void;
  /** Another window's slots (120 armour, 119 offhand) for `dropWorn`; optional for fakes. */
  window?(id: number): { readonly slots: readonly (ItemStack | null)[] } | undefined;
}

export interface KeeperMover {
  move(src: { window: number; slot: number }, dst: { window: number; slot: number }, count: number): Promise<{ ok: boolean; reason?: string }>;
}

export interface KeeperDeps {
  inventory: KeeperInventory;
  requests: StackRequests;
  /** world/containers.ts (predicted moves between player slots). */
  mover: KeeperMover;
  settings: () => KeeperSettings;
  /** A hotbar slot changed client side (Hotbar.noteRaw: the wire item is rebuilt from the model). */
  noteHotbar?: (slot: number) => void;
  logger?: Logger;
}

export interface DropResult {
  ok: boolean;
  item: string;
  dropped: number;
  reason?: string;
}

export class InventoryKeeper {
  private readonly d: KeeperDeps;
  private readonly log: Logger;
  private running = false;
  readonly stats = { stocked: 0, dropped: 0, failed: 0 };

  constructor(deps: KeeperDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
  }

  get busy(): boolean {
    return this.running;
  }

  plan(): KeeperStep[] {
    return planKeeper(this.d.inventory.slots, this.d.settings());
  }

  /** One keeper pass (nothing to do: no packet). */
  async pass(): Promise<{ stocked: number; dropped: number; failed: number }> {
    const steps = this.plan();
    const r = { stocked: 0, dropped: 0, failed: 0 };
    if (steps.length === 0 || this.running) return r;
    this.running = true;
    try {
      await this.d.requests.withScreen(async () => {
        for (const st of steps) {
          const ok = st.kind === 'stock' ? await this.stock(st) : await this.dropSlot(st.from, st.count);
          if (!ok) r.failed++;
          else if (st.kind === 'stock') r.stocked += st.count;
          else r.dropped += st.count;
        }
      });
    } finally {
      this.running = false;
    }
    this.stats.stocked += r.stocked;
    this.stats.dropped += r.dropped;
    this.stats.failed += r.failed;
    if (r.stocked || r.dropped || r.failed) this.log.info(`keeper: stocked ${r.stocked}, dropped ${r.dropped}${r.failed ? `, ${r.failed} failed` : ''}`);
    return r;
  }

  /** Drop up to `n` (default all) of `name` from the inventory; never from the slots in `skip` (Track AV: the named boxes, the flight kit). */
  async drop(name: string, n = Infinity, skip?: ReadonlySet<number>): Promise<DropResult> {
    const item = bare(name);
    const have = this.d.inventory.slots.reduce((a, s, i) => a + (s?.name === item && !skip?.has(i) ? s.count : 0), 0);
    if (have === 0) return { ok: false, item, dropped: 0, reason: 'none' };
    if (this.running) return { ok: false, item, dropped: 0, reason: 'busy' };
    this.running = true;
    let dropped = 0;
    try {
      const r = await this.d.requests.withScreen(async () => {
        let left = Math.min(n, have);
        // main inventory first, smallest stacks first (keep the hotbar stocked)
        const order = this.d.inventory.slots
          .map((s, i) => ({ s, i }))
          .filter((x) => x.s?.name === item && !skip?.has(x.i))
          .sort((a, b) => Number(a.i < 9) - Number(b.i < 9) || a.s!.count - b.s!.count);
        for (const { i } of order) {
          if (left <= 0) break;
          const c = Math.min(left, this.d.inventory.slots[i]?.count ?? 0);
          if (c <= 0) continue;
          if (!(await this.dropSlot(i, c))) return false;
          dropped += c;
          left -= c;
        }
        return true;
      });
      this.stats.dropped += dropped;
      if (r !== true) return { ok: false, item, dropped, reason: r === false ? 'refused' : r.reason };
      return { ok: true, item, dropped };
    } finally {
      this.running = false;
    }
  }

  /**
   * `!drop all` also sheds the worn armour (window 120, slots 0 head .. 3 feet) and the offhand (window
   * 119; the request slot of the offhand container is 1). Every piece is one drop request from the
   * inventory screen; a refusal is reported, not retried.
   */
  async dropWorn(): Promise<{ dropped: string[]; refused: string[] }> {
    const out = { dropped: [] as string[], refused: [] as string[] };
    if (this.running) return out;
    this.running = true;
    try {
      await this.d.requests.withScreen(async () => {
        const pieces: { window: number; slot: number; container: string; reqSlot: number }[] = [
          ...[0, 1, 2, 3].map((slot) => ({ window: 120, slot, container: 'armor', reqSlot: slot })),
          { window: 119, slot: 0, container: 'offhand', reqSlot: 1 },
        ];
        for (const w of pieces) {
          const it = this.d.inventory.window?.(w.window)?.slots[w.slot];
          if (!it || it.count <= 0) continue;
          const r = await this.d.requests.send([{ type_id: 'drop', legacy_type_id: 3, count: it.count, source: slotInfo(w.container, w.reqSlot, it.stackId), randomly: false }]);
          if (isOk(r)) {
            out.dropped.push(it.name);
            this.d.inventory.setItem(w.window, w.slot, null);
            this.stats.dropped += it.count;
          } else {
            out.refused.push(it.name);
            this.log.warn(`keeper: drop worn ${it.name} (${w.container}) refused (${String(r.status)})`);
          }
        }
        return true;
      });
    } finally {
      this.running = false;
    }
    return out;
  }

  private async dropSlot(slot: number, count: number): Promise<boolean> {
    const it = this.d.inventory.slots[slot];
    if (!it || count <= 0) return false;
    const r = await this.d.requests.send([{ type_id: 'drop', legacy_type_id: 3, count: Math.min(count, it.count), source: inventorySlot(slot, it.stackId), randomly: false }]);
    if (!isOk(r)) {
      this.log.warn(`keeper: drop ${count} ${it.name} from slot ${slot} refused (${String(r.status)})`);
      return false;
    }
    // Containers applies the response's count; an emptied slot comes back with count 0
    const now = this.d.inventory.slots[slot];
    if (now?.name === it.name && now.count === it.count) {
      const left = it.count - count;
      this.d.inventory.setItem(0, slot, left > 0 ? { ...it, count: left } : null);
    }
    if (slot < 9) this.d.noteHotbar?.(slot);
    return true;
  }

  private async stock(st: Extract<KeeperStep, { kind: 'stock' }>): Promise<boolean> {
    const inv = this.d.inventory;
    const src = inv.slots[st.from];
    if (src?.name !== st.item) return false;
    if (st.mode === 'place') {
      const r = await this.d.mover.move({ window: 0, slot: st.from }, { window: 0, slot: st.to }, st.count);
      if (!r.ok) {
        this.log.warn(`keeper: move ${st.count} ${st.item} ${st.from} -> ${st.to} failed: ${r.reason}`);
        return false;
      }
      this.d.noteHotbar?.(st.to);
      return true;
    }
    const dst = inv.slots[st.to];
    if (!dst) return false;
    inv.setItem(0, st.from, { ...dst });
    inv.setItem(0, st.to, { ...src });
    const r = await this.d.requests.send([{ type_id: 'swap', legacy_type_id: 2, source: inventorySlot(st.from, src.stackId), destination: inventorySlot(st.to, dst.stackId) }]);
    if (!isOk(r)) {
      inv.setItem(0, st.from, src);
      inv.setItem(0, st.to, dst);
      this.log.warn(`keeper: swap ${st.item} (${st.from}) <-> ${dst.name} (${st.to}) refused (${String(r.status)})`);
      return false;
    }
    this.d.noteHotbar?.(st.to);
    return true;
  }
}
