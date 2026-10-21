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
import { silentLogger, type Logger } from '../log.ts';
import { WINDOW_INVENTORY, windowId, type Inventory } from './inventory.ts';
import type { WindowIdField } from './packets.ts';
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
  private readonly pending = new Map<number, (r: StackResponse) => void>();
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
  }

  /** Ask the server to close a window (it answers with its own container_close). */
  close(id: number, type = 'container'): void {
    this.source.queue('container_close', { window_id: id, window_type: type, server: false });
  }

  /** The wire StackRequestSlotInfo for a slot. */
  slotInfo(ref: SlotRef, stackId: number): Record<string, unknown> {
    let containerId: string;
    if (ref.window === WINDOW_INVENTORY) containerId = ref.slot < 9 ? this.opts.hotbarSlotType : this.opts.inventorySlotType;
    else containerId = this.opts.chestSlotType;
    return { slot_type: { container_id: containerId }, slot: ref.slot, stack_id: stackId };
  }

  /**
   * Move `count` items from `src` to `dst` with one `place` action. The model is updated at once
   * (prediction) and reconciled with the server's response (counts and stack ids); on an error
   * response or a timeout the prediction is rolled back.
   */
  move(src: SlotRef, dst: SlotRef, count: number, timeoutMs = 3000): Promise<MoveResult> {
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
    this.inventory.setItem(src.window, src.slot, left > 0 ? { ...item, count: left } : null);
    const moved: ItemStack = target ? { ...target, count: target.count + count } : { ...item, count };
    if (!target) delete moved.stackId;
    this.inventory.setItem(dst.window, dst.slot, moved);

    this.stats.requests++;
    this.source.queue('item_stack_request', { requests: [{ request_id: requestId, actions: [action], custom_names: [], cause: 'chat_public' }] });
    this.log.debug(`item_stack_request ${requestId}: place ${count} ${item.name} ${fmtRef(src)} -> ${fmtRef(dst)}`);
    return new Promise((resolve) => {
      const rollback = () => {
        this.inventory.setItem(src.window, src.slot, before.src, before.srcRaw);
        this.inventory.setItem(dst.window, dst.slot, before.dst, before.dstRaw);
      };
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        rollback();
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
          this.inventory.setItem(window, s.slot, next);
        } else {
          this.log.warn(`item_stack_response ${r.request_id}: ${s.count} items in unknown slot ${window}:${s.slot}`);
        }
      }
    }
  }

  private windowOf(containerId: string | number): number | undefined {
    if (PLAYER_SLOT_TYPES.has(containerId)) return WINDOW_INVENTORY;
    return this._open?.id;
  }

  private slotsOf(window: number): readonly (ItemStack | null)[] | undefined {
    return this.inventory.window(window)?.slots;
  }
}

function fmtRef(r: SlotRef): string {
  return `${r.window}:${r.slot}`;
}
