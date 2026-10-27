// Chest skill (PLAN.md task 4.5): open a container block, move stacks into it, close it.
//
//   open     look at the block, then inventory_transaction { item_use / click_block } with the face
//            seen from the eye, a click point on that face, the held item exactly as the server sent
//            it and the block's runtime id; wait for container_open at that position and for the
//            window's inventory_content
//   deposit  one item_stack_request `place` per (source slot, destination slot) pair, awaited one by
//            one (world/containers.ts predicts and reconciles with item_stack_response)
//   close    container_close { window_id, window_type: 'container', server: false }; wait for the
//            server's container_close
//
// Verified on BDS 1.26.60.6 (docs/wood.md "Packet shapes"). The server does not check the view, but
// it does check the interaction distance, so callers walk next to the chest first.
//
// Track AG (wave 9, docs/home.md): every container opens as window_type `container`, but the slots of
// the window are addressed by the block's kind in item_stack_request: chests `container`, shulker
// boxes `shulker` (Track AD), barrels `barrel`. `open` sets that on the shared Containers per window
// (`slotTypeForBlock`). `snapshot` reads a window into a typed summary (counts, free slots, a double
// chest's 54 slots, empty and full shulker boxes by their NBT `Items`), `depositSlots` moves chosen
// (slot, count) pairs, `take` moves a window slot into the inventory.
import { createRequire } from 'node:module';
import { silentLogger, type Logger } from '../../log.ts';
import type { Containers, OpenContainer } from '../../world/containers.ts';
import type { Inventory } from '../../world/inventory.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { BlockInfo, ContainerView, ItemStack, PacketSource, Vec3 } from '../../world/types.ts';
import { blockCenter, EYE_HEIGHT, FACE, faceToward, lookAngles, type Face } from '../dig/look.ts';
import type { SkillResult } from '../types.ts';

const require = createRequire(import.meta.url);

const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
/** Shulker box block / item names (Bedrock: the plain one is `undyed_shulker_box`). Track AD's list, moved here by Track AG. */
export const SHULKER_BOXES: ReadonlySet<string> = new Set(['undyed_shulker_box', 'shulker_box', ...COLOURS.map((c) => `${c}_shulker_box`)]);

export function isShulkerBox(name: string): boolean {
  return SHULKER_BOXES.has(name.startsWith('minecraft:') ? name.slice(10) : name);
}

/** Blocks the chest skill opens (Track AG: shulker boxes are listed here; stash.ts no longer adds them at load time). */
export const CONTAINER_BLOCKS = new Set(['chest', 'trapped_chest', 'barrel', ...SHULKER_BOXES]);

/** item_stack_request slot types (ContainerSlotType names) by block kind, verified on BDS 1.26.60.6. */
export const CHEST_SLOT_TYPE = 'container';
/** Shulker box windows (ContainerSlotType 30); `container` and `shulker_box` are refused with status 50 (Track AD). */
export const SHULKER_SLOT_TYPE = 'shulker';
/** Barrel windows (ContainerSlotType 58); Track AG, docs/home.md "Slot types". */
export const BARREL_SLOT_TYPE = 'barrel';

/** The slot type of a container block's window. */
export function slotTypeForBlock(name: string): string {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  if (isShulkerBox(n)) return SHULKER_SLOT_TYPE;
  if (n === 'barrel') return BARREL_SLOT_TYPE;
  return CHEST_SLOT_TYPE;
}

interface NbtList {
  value?: { value?: unknown[] };
}
const nbtItems = (raw: unknown): unknown[] | undefined => {
  const list = (raw as { extra?: { nbt?: { nbt?: { value?: { Items?: NbtList } } } } } | undefined)?.extra?.nbt?.nbt?.value?.Items?.value?.value;
  return Array.isArray(list) ? list : undefined;
};

/** Slots used inside a shulker box item (the raw wire item's NBT `Items`); 0 when unknown or empty. */
export function shulkerSlotsUsed(raw: unknown): number {
  return nbtItems(raw)?.length ?? 0;
}

/** Item counts inside a shulker box item (NBT `Items`: one compound per stack with `Name`, `Count`). */
export function shulkerContents(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of (nbtItems(raw) ?? []) as { Name?: { value?: unknown }; Count?: { value?: unknown } }[]) {
    const name = it.Name?.value;
    const n = (typeof name === 'string' ? name : '?').replace(/^minecraft:/, '');
    out[n] = (out[n] ?? 0) + Number(it.Count?.value ?? 0);
  }
  return out;
}

/** A container window read into counts (Track AG). */
export interface ContainerSnapshot {
  /** Slots of the window (27; a double chest 54). */
  size: number;
  /** Items by name (shulker boxes counted as items too). */
  counts: Record<string, number>;
  /** Slots holding something. */
  stacks: number;
  free: number;
  /** A double chest (54 slots). */
  double: boolean;
  /** Room left on partial stacks, by item name. */
  room: Record<string, number>;
  /** Shulker boxes inside: without items (NBT `Items` empty) and with items. */
  boxes: { empty: number; full: number };
}

/** Read a window's slots (and the raw items for shulker box contents) into a ContainerSnapshot. */
export function snapshotOf(slots: readonly (ItemStack | null)[], raw?: (slot: number) => unknown): ContainerSnapshot {
  const snap: ContainerSnapshot = { size: slots.length, counts: {}, stacks: 0, free: 0, double: slots.length >= 54, room: {}, boxes: { empty: 0, full: 0 } };
  slots.forEach((s, i) => {
    if (!s || s.count <= 0) {
      snap.free++;
      return;
    }
    snap.stacks++;
    snap.counts[s.name] = (snap.counts[s.name] ?? 0) + s.count;
    const left = maxStackOf(s.name) - s.count;
    if (left > 0) snap.room[s.name] = (snap.room[s.name] ?? 0) + left;
    if (isShulkerBox(s.name)) {
      if (shulkerSlotsUsed(raw?.(i)) > 0) snap.boxes.full += s.count;
      else snap.boxes.empty += s.count;
    }
  });
  return snap;
}

/** Eye to the closest point of the block; the vanilla interaction range is about 6 (survival). */
export const OPEN_REACH = 4.5;

const AIR: ItemV4 & { extra: unknown } = {
  network_id: 0,
  count: 0,
  metadata: 0,
  has_stack_id: false,
  block_runtime_id: 0,
  extra: { has_nbt: 0, can_place_on: [], can_destroy: [] },
};

let stackSizes: Map<string, number> | undefined;

/** Max stack size of an item (minecraft-data, same bedrock data as mining.ts); default 64. */
export function maxStackOf(name: string): number {
  if (!stackSizes) {
    stackSizes = new Map();
    try {
      const mcData = require('minecraft-data') as (v: string) => { itemsArray: { name: string; stackSize: number }[] } | null;
      for (const i of mcData('bedrock_1.26.51')?.itemsArray ?? []) stackSizes.set(i.name, i.stackSize);
    } catch {
      // keep the default
    }
  }
  const short = name.startsWith('minecraft:') ? name.slice(10) : name;
  return stackSizes.get(short) ?? 64;
}

/** The point on face `face` of block `p` the click lands on (block-relative, 0..1), its centre. */
export function clickPoint(face: Face): Vec3 {
  switch (face) {
    case FACE.down:
      return { x: 0.5, y: 0, z: 0.5 };
    case FACE.up:
      return { x: 0.5, y: 1, z: 0.5 };
    case FACE.north:
      return { x: 0.5, y: 0.5, z: 0 };
    case FACE.south:
      return { x: 0.5, y: 0.5, z: 1 };
    case FACE.west:
      return { x: 0, y: 0.5, z: 0.5 };
    default:
      return { x: 1, y: 0.5, z: 0.5 };
  }
}

/** The click_block use-item transaction (inventory_transaction params). */
export function clickBlockTransaction(a: { pos: Vec3; face: Face; hotbarSlot: number; held: ItemV4 | undefined; eye: Vec3; blockRuntimeId: number }): Record<string, unknown> {
  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use',
      actions: [],
      transaction_data: {
        action_type: 'click_block',
        trigger_type: 'player_input',
        block_position: { x: a.pos.x, y: a.pos.y, z: a.pos.z },
        face: a.face,
        hotbar_slot: a.hotbarSlot,
        hand: 'main_hand',
        held_item: a.held && a.held.network_id !== 0 ? a.held : AIR,
        player_pos: { ...a.eye },
        click_pos: clickPoint(a.face),
        block_runtime_id: a.blockRuntimeId,
        client_prediction: 'success',
        client_cooldown_state: 'off',
      },
    },
  };
}

export interface ChestLoop {
  readonly state: { pos: Vec3; ready: boolean };
  setCommand(c: { yaw?: number; pitch?: number }): void;
  waitTicks(n: number): Promise<void>;
}

export interface ChestWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  readonly chunks: { runtimeIdAt(x: number, y: number, z: number): number | undefined };
  readonly inventory: Inventory;
}

export interface ChestDeps {
  source: Pick<PacketSource, 'queue'>;
  loop: ChestLoop;
  world: ChestWorld;
  containers: Containers;
  /** Raw wire item of a hotbar slot (Hotbar.rawItem); the transaction echoes the held item. */
  rawHotbarItem?: (slot: number) => ItemV4 | undefined;
  logger?: Logger;
}

export type OpenResult = { ok: true; view: ContainerView; open: OpenContainer; block?: string } | { ok: false; reason: string };

export interface DepositReport {
  /** Items moved by name. */
  moved: Record<string, number>;
  total: number;
  requests: number;
  errors: number;
}

export type DepositResult = (SkillResult & DepositReport) & { reason?: string };

export interface OpenOptions {
  /** Ticks to wait for container_open. Default 40. */
  timeoutTicks?: number;
  reach?: number;
}

/** Waits until `check()` is true, checking every tick, for at most `ticks` ticks. */
async function waitFor(loop: ChestLoop, check: () => boolean, ticks: number): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (check()) return true;
    await loop.waitTicks(1);
  }
  return check();
}

const samePos = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;

export class ChestSkill {
  private readonly d: ChestDeps;
  private readonly log: Logger;

  constructor(deps: ChestDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
  }

  private eye(): Vec3 {
    const f = this.d.loop.state.pos;
    return { x: f.x, y: f.y + EYE_HEIGHT, z: f.z };
  }

  async open(pos: Vec3, opts: OpenOptions = {}): Promise<OpenResult> {
    const { loop, world, containers, source } = this.d;
    const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    if (!loop.state.ready) return { ok: false, reason: 'not_ready' };
    const block = world.blockAt(p);
    if (!block) return { ok: false, reason: 'unloaded' };
    if (!CONTAINER_BLOCKS.has(block.name)) return { ok: false, reason: `not_a_container:${block.name}` };
    const eye = this.eye();
    const gap = (e: number, lo: number) => Math.max(lo - e, 0, e - (lo + 1));
    const dist = Math.hypot(gap(eye.x, p.x), gap(eye.y, p.y), gap(eye.z, p.z));
    if (dist > (opts.reach ?? OPEN_REACH)) return { ok: false, reason: 'unreachable' };
    // A window the server still thinks is open is closed first.
    const stale = containers.open;
    if (stale) await this.close(stale.id);

    loop.setCommand(lookAngles(eye, blockCenter(p)));
    await loop.waitTicks(2);
    const face = faceToward(this.eye(), p);
    const opened = new Promise<OpenContainer | undefined>((resolve) => {
      const off = containers.onOpen((c) => {
        if (samePos(c.pos, p)) {
          off();
          resolve(c);
        }
      });
      void loop.waitTicks(opts.timeoutTicks ?? 40).then(() => {
        off();
        resolve(undefined);
      });
    });
    const slot = world.inventory.selected;
    source.queue(
      'inventory_transaction',
      clickBlockTransaction({ pos: p, face, hotbarSlot: slot, held: this.d.rawHotbarItem?.(slot), eye: this.eye(), blockRuntimeId: world.chunks.runtimeIdAt(p.x, p.y, p.z) ?? 0 }),
    );
    const c = await opened;
    if (!c) {
      this.log.info(`open ${p.x} ${p.y} ${p.z}: no container_open`);
      return { ok: false, reason: 'timeout' };
    }
    // The window's contents (inventory_content for the window id) follow container_open.
    const haveContents = await waitFor(loop, () => world.inventory.window(c.id) !== undefined, 20);
    if (!haveContents) return { ok: false, reason: 'no_contents' };
    const view = world.inventory.window(c.id)!;
    (containers as Partial<Pick<Containers, 'setSlotType'>>).setSlotType?.(c.id, slotTypeForBlock(block.name)); // Track AG: per window (shulker, barrel)
    this.log.info(`opened ${block.name} at ${p.x} ${p.y} ${p.z}: window ${c.id}, ${view.slots.filter(Boolean).length} stacks`);
    return { ok: true, view, open: c, block: block.name };
  }

  /**
   * Move every inventory stack that passes `filter` into the open window `view.id`: onto partial
   * stacks of the same item first, then into empty slots. Stops with `container_full`.
   */
  async deposit(view: ContainerView, filter: (i: ItemStack) => boolean, opts: { maxErrors?: number } = {}): Promise<DepositResult> {
    const { world, containers } = this.d;
    const report: DepositReport = { moved: {}, total: 0, requests: 0, errors: 0 };
    const window = view.id;
    if (containers.open?.id !== window || !world.inventory.window(window)) return { ok: false, reason: 'not_open', ...report };
    const maxErrors = opts.maxErrors ?? 3;
    for (let slot = 0; slot < 36; slot++) {
      for (;;) {
        const item = world.inventory.slots[slot];
        if (!item || !filter(item)) break;
        const chest = world.inventory.window(window)?.slots ?? [];
        const max = maxStackOf(item.name);
        let dst = chest.findIndex((s) => s !== null && s.name === item.name && s.metadata === item.metadata && s.count < max);
        if (dst < 0) dst = chest.findIndex((s) => s === null);
        if (dst < 0) return { ok: false, reason: 'container_full', ...report };
        const room = max - (chest[dst]?.count ?? 0);
        const n = Math.min(item.count, room);
        report.requests++;
        const r = await containers.move({ window: 0, slot }, { window, slot: dst }, n);
        if (!r.ok) {
          report.errors++;
          this.log.warn(`deposit ${n} ${item.name} ${slot} -> ${window}:${dst}: ${r.reason}`);
          if (report.errors >= maxErrors) return { ok: false, reason: `request_${r.reason}`, ...report };
          continue;
        }
        report.moved[item.name] = (report.moved[item.name] ?? 0) + n;
        report.total += n;
      }
    }
    return { ok: true, ...report };
  }

  /** Track AG: the open window `view.id` read into a ContainerSnapshot (with shulker box contents from the raw items). */
  snapshot(view: ContainerView | number): ContainerSnapshot | undefined {
    const id = typeof view === 'number' ? view : view.id;
    const w = this.d.world.inventory.window(id);
    if (!w) return undefined;
    return snapshotOf(w.slots, (i) => this.d.world.inventory.rawItem(id, i));
  }

  /**
   * Track AG: move exactly the given (inventory slot, count) pairs into the open window: onto partial
   * stacks of the same item first, then into empty slots. A pair whose slot no longer holds `name`
   * (when given) is skipped. Stops with `container_full`.
   */
  async depositSlots(view: ContainerView, moves: readonly { slot: number; count: number; name?: string }[], opts: { maxErrors?: number } = {}): Promise<DepositResult> {
    const { world, containers } = this.d;
    const report: DepositReport = { moved: {}, total: 0, requests: 0, errors: 0 };
    const window = view.id;
    if (containers.open?.id !== window || !world.inventory.window(window)) return { ok: false, reason: 'not_open', ...report };
    const maxErrors = opts.maxErrors ?? 3;
    for (const m of moves) {
      let left = m.count;
      while (left > 0) {
        const item = world.inventory.slots[m.slot];
        if (!item || item.count <= 0 || (m.name !== undefined && item.name !== m.name)) break;
        const chest = world.inventory.window(window)?.slots ?? [];
        const max = maxStackOf(item.name);
        let dst = chest.findIndex((s) => s !== null && s.name === item.name && s.metadata === item.metadata && s.count < max && !isShulkerBox(s.name));
        if (dst < 0) dst = chest.findIndex((s) => s === null);
        if (dst < 0) return { ok: false, reason: 'container_full', ...report };
        const n = Math.min(left, item.count, max - (chest[dst]?.count ?? 0));
        report.requests++;
        const r = await containers.move({ window: 0, slot: m.slot }, { window, slot: dst }, n);
        if (!r.ok) {
          report.errors++;
          this.log.warn(`deposit ${n} ${item.name} ${m.slot} -> ${window}:${dst}: ${r.reason}`);
          if (report.errors >= maxErrors) return { ok: false, reason: `request_${r.reason}`, ...report };
          continue;
        }
        report.moved[item.name] = (report.moved[item.name] ?? 0) + n;
        report.total += n;
        left -= n;
      }
    }
    return { ok: true, ...report };
  }

  /**
   * Track AG: move `count` items (default all) of window slot `slot` into the inventory: onto a partial
   * stack of the same item, else into an empty slot (the slots in `prefer` first, e.g. the hotbar).
   */
  async take(view: ContainerView, slot: number, count?: number, prefer: readonly number[] = []): Promise<{ ok: boolean; reason?: string; to?: number; moved: number }> {
    const { world, containers } = this.d;
    const window = view.id;
    if (containers.open?.id !== window) return { ok: false, reason: 'not_open', moved: 0 };
    const item = world.inventory.window(window)?.slots[slot];
    if (!item) return { ok: false, reason: 'empty_source', moved: 0 };
    const max = maxStackOf(item.name);
    let want = Math.min(count ?? item.count, item.count);
    let moved = 0;
    let to: number | undefined;
    while (want > 0) {
      const inv = world.inventory.slots;
      let dst = isShulkerBox(item.name) ? -1 : inv.findIndex((s, i) => i < 36 && s !== null && s.name === item.name && s.metadata === item.metadata && s.count < max);
      if (dst < 0) dst = prefer.find((i) => !inv[i]) ?? -1;
      if (dst < 0) dst = inv.findIndex((s, i) => i < 36 && !s);
      if (dst < 0) return { ok: moved > 0, reason: 'inventory_full', moved, ...(to !== undefined ? { to } : {}) };
      const n = Math.min(want, max - (inv[dst]?.count ?? 0));
      const r = await containers.move({ window, slot }, { window: 0, slot: dst }, n);
      if (!r.ok) return { ok: moved > 0, reason: `request_${r.reason}`, moved, ...(to !== undefined ? { to } : {}) };
      moved += n;
      want -= n;
      to = dst;
    }
    return { ok: true, moved, ...(to !== undefined ? { to } : {}) };
  }

  /** Close a window and wait for the server's container_close (at most `timeoutTicks`). */
  async close(id: number, timeoutTicks = 20): Promise<boolean> {
    const { containers, loop } = this.d;
    let closed = false;
    const off = containers.onClose((cid) => {
      if (cid === id) closed = true;
    });
    containers.close(id);
    const ok = await waitFor(loop, () => closed, timeoutTicks);
    off();
    return ok;
  }
}
