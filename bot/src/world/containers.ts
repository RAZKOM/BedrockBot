// Container windows and item stack requests (PLAN.md task 4.5). Tracks `container_open` /
// `container_close` and the bot's own `item_stack_request`s with their `item_stack_response`s, on
// top of the Inventory model (window contents come from inventory_content / inventory_slot for the
// window id, which Inventory already stores).
//
// Packet shapes (minecraft-data bedrock 1.26.60 protocol.json, verified on BDS 1.26.60.6; see
// docs/wood.md "Packet shapes"):
//   container_open   { window_id, window_type: 'container', coordinates: {x,y,z}, runtime_entity_id }
//   container_close  { window_id, window_type, server }            (both directions)
//   item_stack_request { requests: [{ request_id, actions: [{ type_id: 'place', legacy_type_id?, count,
//                        source: SlotInfo, destination: SlotInfo }], custom_names: [], cause }] }
//     SlotInfo = { slot_type: { container_id: 'hotbar' | 'inventory' | 'container' | ..., dynamic_container_id? },
//                  slot, stack_id }        stack_id = the server's stack network id (0 for an empty slot)
//   item_stack_response { responses: [{ status: 'ok' | 'error', request_id,
//                        containers?: [{ slot_type, slots: [{ slot, hotbar_slot, count, item_stack_id, ... }] }] }] }
// Request ids are negative and odd, counting down (-1, -3, -5 ...), as the vanilla client does.
//
// Track AG (wave 9, docs/home.md "Slot types"): the container_id of a window's slots depends on the
// block behind it, not on the window type (every one of them opens as window_type `container`):
// chests `container` (level entity, 7), shulker boxes `shulker` (30), barrels `barrel` (58), verified
// on BDS 1.26.60.6. The chest skill sets it per window (`setSlotType`) when it opens one; windows
// without an entry use the `chestSlotType` option.
import { silentLogger, type Logger } from '../log.ts';
import { rawLike, WINDOW_ARMOR, WINDOW_INVENTORY, WINDOW_OFFHAND, windowId, type Inventory } from './inventory.ts';
import type { ItemV4, WindowIdField } from './packets.ts';
import type { ItemStack, PacketSource, Vec3 } from './types.ts';

export interface ContainerOpenPacket {
  window_id: WindowIdField;
  window_type: string | number;
  coordinates: Vec3;
  runtime_entity_id: bigint | number | string;
}

export interface ContainerClosePacket {
  window_id: WindowIdField;
  window_type: string | number;
  server: boolean;
}

export interface StackResponseSlot {
  slot: number;
  hotbar_slot: number;
  count: number;
  item_stack_id?: number;
  custom_name?: string;
  durability_correction?: number;
}

export interface StackResponseContainer {
  slot_type: { container_id: string | number; dynamic_container_id?: number };
  slots: StackResponseSlot[];
}

export interface StackResponse {
  status: 'ok' | 'error' | number;
  request_id: number;
  containers?: StackResponseContainer[];
}

/** An open container window. */
export interface OpenContainer {
  id: number;
  type: string;
  pos: Vec3;
  /** performance.now() when container_open arrived. */
  openedAt: number;
}

/** A slot of the player inventory (window 0) or of an open container window. */
export interface SlotRef {
  window: number;
  slot: number;
}

export type MoveResult =
  | { ok: true; requestId: number; response: StackResponse }
  | { ok: false; reason: 'error' | 'timeout' | 'empty_source' | 'bad_destination' | 'no_window'; requestId?: number; response?: StackResponse };

/** Container slot types (ContainerSlotType names) that address the player inventory. */
const PLAYER_SLOT_TYPES = new Set<string | number>(['hotbar', 'inventory', 'hotbar_and_inventory', 12, 28, 29]);

export interface ContainersOptions {
  logger?: Logger;
  /** Slot-type name for player inventory slots 0..8 / 9..35 in requests. Default 'hotbar' / 'inventory'. */
  hotbarSlotType?: string;
  inventorySlotType?: string;
  /** Slot-type name of a chest's slots. Default 'container' (ContainerSlotType 7, "level entity"). */
  chestSlotType?: string;
}

export class Containers {
  private readonly source: PacketSource;
  private readonly inventory: Inventory;
  private readonly log: Logger;
  private readonly opts: Required<Omit<ContainersOptions, 'logger'>>;
  private _open: OpenContainer | undefined;
  private nextRequestId = -1;
  /** Track AG: the slot type of each open window's slots (set by the opener, dropped on close). */
  private readonly windowSlotTypes = new Map<number, string>();
  private readonly pending = new Map<number, (r: StackResponse) => void>();
  /** Track AG: what each pending request predicted per slot (an ok response refills a slot another request's rollback emptied). */
  private readonly predicted = new Map<number, { window: number; slot: number; item: ItemStack; raw?: ItemV4 }[]>();
  private readonly openFns = new Set<(c: OpenContainer) => void>();
  private readonly closeFns = new Set<(id: number, byServer: boolean) => void>();
  private readonly unsubs: (() => void)[] = [];
  /** Responses seen (ok / error), for status and tests. */
  readonly stats = { requests: 0, ok: 0, error: 0, opens: 0, closes: 0 };

  constructor(source: PacketSource, inventory: Inventory, opts: ContainersOptions = {}) {
    this.source = source;
    this.inventory = inventory;
    this.log = opts.logger ?? silentLogger;
    this.opts = {
      hotbarSlotType: opts.hotbarSlotType ?? 'hotbar',
      inventorySlotType: opts.inventorySlotType ?? 'inventory',
      chestSlotType: opts.chestSlotType ?? 'container',
    };
    this.unsubs.push(
      source.on('container_open', (p) => {
        this.handleOpen(p as unknown as ContainerOpenPacket);
      }),
      source.on('container_close', (p) => {
        this.handleClose(p as unknown as ContainerClosePacket);
      }),
      source.on('item_stack_response', (p) => {
        this.handleResponses((p as unknown as { responses: StackResponse[] }).responses);
      }),
      source.on('start_game', () => {
        this._open = undefined;
        this.pending.clear();
        this.windowSlotTypes.clear(); // Track AG
        this.predicted.clear(); // Track AG
      }),
    );
  }

  /** The container window the server last opened and has not closed. */
  get open(): OpenContainer | undefined {
    return this._open;
  }

  onOpen(fn: (c: OpenContainer) => void): () => void {
    this.openFns.add(fn);
    return () => this.openFns.delete(fn);
  }

  onClose(fn: (id: number, byServer: boolean) => void): () => void {
    this.closeFns.add(fn);
    return () => this.closeFns.delete(fn);
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.pending.clear();
    this.predicted.clear(); // Track AG
  }

  /** Track AG: address the slots of window `id` as `slotType` in item stack requests (until it closes). */
  setSlotType(id: number, slotType: string): void {
    this.windowSlotTypes.set(id, slotType);
  }

  /** Track AG: the slot type requests use for window `id` (its own, else the `chestSlotType` option). */
  slotTypeOf(id: number): string {
    return this.windowSlotTypes.get(id) ?? this.opts.chestSlotType;
  }

  /** Ask the server to close a window (it answers with its own container_close). */
  close(id: number, type = 'container'): void {
    this.source.queue('container_close', { window_id: id, window_type: type, server: false });
  }

  /** The wire StackRequestSlotInfo for a slot. */
  slotInfo(ref: SlotRef, stackId: number): Record<string, unknown> {
    let containerId: string;
    if (ref.window === WINDOW_INVENTORY) containerId = ref.slot < 9 ? this.opts.hotbarSlotType : this.opts.inventorySlotType;
    else containerId = this.slotTypeOf(ref.window); // Track AG: per window
    return { slot_type: { container_id: containerId }, slot: ref.slot, stack_id: stackId };
  }

  /**
   * Move `count` items from `src` to `dst` with one `place` action. The model is updated at once
   * (prediction) and reconciled with the server's response (counts and stack ids); on an error
   * response or a timeout the prediction is rolled back.
   */
  move(src: SlotRef, dst: SlotRef, count: number, timeoutMs = 3000): Promise<MoveResult> {
    // Track P1 (world/resync.ts): never built on a model that may be stale: the server's inventory first (3 s at most)
    if (this.inventory.unsure !== undefined) return this.inventory.whenSure(3000).then(() => this.moveNow(src, dst, count, timeoutMs));
    return this.moveNow(src, dst, count, timeoutMs);
  }

  private moveNow(src: SlotRef, dst: SlotRef, count: number, timeoutMs: number): Promise<MoveResult> {
    const from = this.slotsOf(src.window);
    const to = this.slotsOf(dst.window);
    if (!from || !to) return Promise.resolve({ ok: false, reason: 'no_window' });
    const item = from[src.slot] ?? null;
    if (!item || count <= 0 || count > item.count) return Promise.resolve({ ok: false, reason: 'empty_source' });
    const target = to[dst.slot] ?? null;
    if (target && (target.name !== item.name || target.metadata !== item.metadata)) return Promise.resolve({ ok: false, reason: 'bad_destination' });

    const requestId = this.nextRequestId;
    this.nextRequestId -= 2;
    const action = {
      type_id: 'place',
      legacy_type_id: 1,
      count,
      source: this.slotInfo(src, item.stackId ?? 0),
      destination: this.slotInfo(dst, target?.stackId ?? 0),
    };
    // Prediction (rolled back on error).
    const before = { src: item, dst: target, srcRaw: this.inventory.rawItem(src.window, src.slot), dstRaw: this.inventory.rawItem(dst.window, dst.slot) };
    const left = item.count - count;
    const srcNow = left > 0 ? { ...item, count: left } : null;
    // Track F12: the wire items follow the stacks (the NBT stays, the count and the stack id are the model's;
    // the response's counts and ids then rewrite them in apply): the source's rest keeps its own, a merge the
    // target's, a stack moved or split into an empty slot the source's. Before, only a whole stack moved into
    // an empty slot kept one (Track AG), and a hotbar stack topped up from a box was used with a wire item
    // rebuilt from the model, its NBT lost (a firework's `Fireworks`): the server refused the use
    const srcItemRaw = before.srcRaw ?? this.inventory.rawOfStack(item);
    const srcRawNow = srcNow && srcItemRaw ? rawLike(srcItemRaw, srcNow) : undefined;
    this.inventory.setItem(src.window, src.slot, srcNow, srcRawNow);
    const moved: ItemStack = target ? { ...target, count: target.count + count } : { ...item, count };
    if (!target) delete moved.stackId;
    const base = target ? (before.dstRaw ?? this.inventory.rawOfStack(target)) : srcItemRaw;
    const dstRaw = base ? rawLike(base, moved) : undefined;
    this.inventory.setItem(dst.window, dst.slot, moved, dstRaw);

    this.predicted.set(requestId, [
      { window: src.window, slot: src.slot, item, ...(srcItemRaw ? { raw: srcItemRaw } : {}) },
      { window: dst.window, slot: dst.slot, item: moved, ...(dstRaw ? { raw: dstRaw } : {}) },
    ]);
    this.stats.requests++;
    const lost0 = this.inventory.lostPackets;
    this.source.queue('item_stack_request', { requests: [{ request_id: requestId, actions: [action], custom_names: [], cause: 'chat_public' }] });
    this.log.debug(`item_stack_request ${requestId}: place ${count} ${item.name} ${fmtRef(src)} -> ${fmtRef(dst)}`);
    return new Promise((resolve) => {
      // Track AG: a slot the server rewrote meanwhile (inventory_slot: an item picked up into the slot
      // the request aimed at) keeps the server's state; only the prediction itself is undone
      const unchanged = (ref: SlotRef, item: ItemStack | null, raw: ItemV4 | undefined) =>
        (this.slotsOf(ref.window)?.[ref.slot] ?? null) === item && this.inventory.rawItem(ref.window, ref.slot) === raw;
      const rollback = () => {
        if (unchanged(src, srcNow, srcRawNow)) this.inventory.setItem(src.window, src.slot, before.src, before.srcRaw);
        if (unchanged(dst, moved, dstRaw)) this.inventory.setItem(dst.window, dst.slot, before.dst, before.dstRaw);
      };
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.predicted.delete(requestId); // Track AG
        rollback();
        // Track P1: perhaps the response was the lost packet: the server's inventory undoes a wrong rollback
        if (this.inventory.lostPackets !== lost0) this.inventory.requestResync('a request got no response after a lost packet');
        resolve({ ok: false, reason: 'timeout', requestId });
      }, timeoutMs);
      this.pending.set(requestId, (r) => {
        clearTimeout(timer);
        if (r.status === 'ok' || r.status === 0) {
          resolve({ ok: true, requestId, response: r });
        } else {
          rollback();
          resolve({ ok: false, reason: 'error', requestId, response: r });
        }
      });
    });
  }

  // ---- packet handlers ---------------------------------------------------------------------

  handleOpen(p: ContainerOpenPacket): void {
    const c: OpenContainer = {
      id: windowId(p.window_id),
      type: String(p.window_type),
      pos: { x: p.coordinates.x, y: p.coordinates.y, z: p.coordinates.z },
      openedAt: performance.now(),
    };
    this._open = c;
    this.stats.opens++;
    this.log.debug(`container_open window ${c.id} (${c.type}) at ${c.pos.x} ${c.pos.y} ${c.pos.z}`);
    for (const fn of [...this.openFns]) fn(c);
  }

  handleClose(p: ContainerClosePacket): void {
    const id = windowId(p.window_id);
    this.stats.closes++;
    if (this._open?.id === id) this._open = undefined;
    this.windowSlotTypes.delete(id); // Track AG
    this.inventory.removeWindow(id);
    this.log.debug(`container_close window ${id} (server ${p.server})`);
    for (const fn of [...this.closeFns]) fn(id, p.server);
  }

  handleResponses(responses: StackResponse[]): void {
    for (const r of responses) {
      const ok = r.status === 'ok' || r.status === 0;
      if (ok) this.stats.ok++;
      else this.stats.error++;
      if (ok) this.apply(r);
      else this.log.warn(`item_stack_response ${r.request_id}: ${String(r.status)}`);
      this.predicted.delete(r.request_id); // Track AG
      const fn = this.pending.get(r.request_id);
      if (fn) {
        this.pending.delete(r.request_id);
        fn(r);
      }
    }
  }

  /** Counts and stack ids from an ok response (the item kind stays what the prediction put there). */
  private apply(r: StackResponse): void {
    for (const c of r.containers ?? []) {
      const window = this.windowOf(c.slot_type.container_id);
      if (window === undefined) continue;
      const slots = this.slotsOf(window);
      for (const s of c.slots) {
        const cur = slots?.[s.slot] ?? null;
        if (s.count <= 0) {
          this.inventory.setItem(window, s.slot, null);
        } else if (cur) {
          const next: ItemStack = { ...cur, count: s.count };
          if (s.item_stack_id !== undefined) next.stackId = s.item_stack_id;
          // Track AG: keep the wire item (NBT); Track F12: with the server's count and stack id, so a use echoes the stack as it holds it
          const raw = this.inventory.rawItem(window, s.slot) ?? this.inventory.rawOfStack(cur);
          this.inventory.setItem(window, s.slot, next, raw ? rawLike(raw, next) : undefined);
        } else if (this.predicted.get(r.request_id)?.find((x) => x.window === window && x.slot === s.slot)) {
          // Track AG: the slot this request filled was emptied meanwhile (another request's rollback): the server says it holds the item
          const was = this.predicted.get(r.request_id)!.find((x) => x.window === window && x.slot === s.slot)!;
          const next: ItemStack = { ...was.item, count: s.count };
          if (s.item_stack_id !== undefined) next.stackId = s.item_stack_id;
          this.inventory.setItem(window, s.slot, next, was.raw ? rawLike(was.raw, next) : undefined);
        } else if (window !== WINDOW_ARMOR && window !== WINDOW_OFFHAND) {
          // (an armour or offhand slot the requester fills after the response: the server's inventory_slot confirms it, armour.ts)
          this.log.warn(`item_stack_response ${r.request_id}: ${s.count} items in unknown slot ${window}:${s.slot}`);
        }
      }
    }
  }

  private windowOf(containerId: string | number): number | undefined {
    if (PLAYER_SLOT_TYPES.has(containerId)) return WINDOW_INVENTORY;
    // Track F12: the armour and offhand containers are their own windows (120, 119), never the open one: the
    // elytra's swap was applied to slot 1 of the inventory screen's window ("1 items in unknown slot W:1" on
    // every flight), and with a chest open it would have rewritten the chest's slot 1
    if (containerId === 'armor' || containerId === 6) return WINDOW_ARMOR;
    if (containerId === 'offhand' || containerId === 34) return WINDOW_OFFHAND;
    return this._open?.id;
  }

  private slotsOf(window: number): readonly (ItemStack | null)[] | undefined {
    return this.inventory.window(window)?.slots;
  }
}

function fmtRef(r: SlotRef): string {
  return `${r.window}:${r.slot}`;
}
