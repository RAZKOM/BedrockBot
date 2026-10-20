// Hotbar slot selection (PLAN.md task 4.2). The client announces a slot change with `mob_equipment`
// (own runtime id, the item in the new slot, slot = selected_slot = 0..8, window 'inventory'); BDS
// 1.26.51 takes it as is (verified with truth:pos selectedSlot, docs/digging.md). The packet must
// carry the item exactly as the server sent it, so this class keeps the raw wire items of hotbar
// slots 0..8 from the same packets the Inventory model reads.
import type { Inventory } from './inventory.ts';
import { WINDOW_INVENTORY, windowId } from './inventory.ts';
import type { InventoryContent, InventorySlot, InventoryTransaction, ItemV4 } from './packets.ts';
import type { PacketSource } from './types.ts';

const HOTBAR_SLOTS = 9;
/** What the protocol sends for an empty slot. */
const AIR: ItemV4 & { extra: unknown } = {
  network_id: 0,
  count: 0,
  metadata: 0,
  has_stack_id: false,
  block_runtime_id: 0,
  extra: { has_nbt: 0, can_place_on: [], can_destroy: [] },
};

export interface HotbarOptions {
  inventory: Inventory;
  /** Own runtime entity id (World.self.runtimeId once start_game arrived). */
  runtimeId: () => bigint;
}

export class Hotbar {
  private readonly source: PacketSource;
  private readonly inventory: Inventory;
  private readonly runtimeId: () => bigint;
  private readonly raw: (ItemV4 | undefined)[] = new Array<ItemV4 | undefined>(HOTBAR_SLOTS).fill(undefined);
  private readonly unsubs: (() => void)[] = [];

  constructor(source: PacketSource, opts: HotbarOptions) {
    this.source = source;
    this.inventory = opts.inventory;
    this.runtimeId = opts.runtimeId;
    this.unsubs.push(
      source.on('inventory_content', (p) => {
        const c = p as unknown as InventoryContent;
        if (windowId(c.window_id) !== WINDOW_INVENTORY) return;
        for (let i = 0; i < HOTBAR_SLOTS; i++) this.raw[i] = c.input[i];
      }),
      source.on('inventory_slot', (p) => {
        const s = p as unknown as InventorySlot;
        if (windowId(s.window_id) === WINDOW_INVENTORY && s.slot < HOTBAR_SLOTS) this.raw[s.slot] = s.item;
      }),
      source.on('inventory_transaction', (p) => {
        const t = (p as unknown as InventoryTransaction).transaction;
        if (t.transaction_type !== 'normal' || !t.actions) return;
        for (const a of t.actions) {
          if (a.source_type !== 'container' || a.window_id === undefined) continue;
          if (windowId(a.window_id) === WINDOW_INVENTORY && a.slot < HOTBAR_SLOTS) this.raw[a.slot] = a.new_item;
        }
      }),
      source.on('start_game', () => {
        this.raw.fill(undefined);
      }),
    );
  }

  /** Currently selected hotbar slot (0..8). */
  get selected(): number {
    return this.inventory.selected;
  }

  /** The wire item last seen in a hotbar slot (undefined = never reported, i.e. empty). */
  rawItem(slot: number): ItemV4 | undefined {
    return this.raw[slot];
  }

  /**
   * Select a hotbar slot: queues `mob_equipment` (sent with the next tick's batch, before that tick's
   * `player_auth_input`) and updates the inventory model. Returns false for a slot outside 0..8.
   */
  select(slot: number): boolean {
    if (!Number.isInteger(slot) || slot < 0 || slot >= HOTBAR_SLOTS) return false;
    const item = this.raw[slot] ?? AIR;
    this.source.queue('mob_equipment', {
      runtime_entity_id: this.runtimeId(),
      item: item.network_id === 0 ? AIR : item,
      slot,
      selected_slot: slot,
      window_id: 'inventory',
    });
    this.inventory.select(slot);
    return true;
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
  }
}
