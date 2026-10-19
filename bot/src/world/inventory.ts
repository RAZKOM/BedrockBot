// Inventory model (PLAN.md task 2.5): `inventory_content`, `inventory_slot`, clientbound
// `inventory_transaction` (how BDS announces /give), `player_hotbar` and our own `mob_equipment`.
import type { InventoryContent, InventorySlot, InventoryTransaction, ItemV4, MobEquipment, PlayerHotbar, WindowIdField } from './packets.ts';
import { toBigInt } from './packets.ts';
import type { ContainerView, ItemStack } from './types.ts';

/** minecraft-data's WindowID mapper names -> numeric ids. */
export const WINDOW_IDS: Readonly<Record<string, number>> = {
  inventory: 0,
  first: 1,
  last: 100,
  offhand: 119,
  armor: 120,
  creative: 121,
  hotbar: 122,
  fixed_inventory: 123,
  ui: 124,
  none: -1,
};

export const WINDOW_INVENTORY = 0;
export const WINDOW_OFFHAND = 119;
export const WINDOW_ARMOR = 120;
/** Player inventory size: 9 hotbar slots (0..8) + 27 main slots. */
export const INVENTORY_SIZE = 36;

export function windowId(w: WindowIdField): number {
  if (typeof w === 'number') return w;
  const n = WINDOW_IDS[w];
  if (n !== undefined) return n;
  const parsed = Number(w);
  return Number.isFinite(parsed) ? parsed : -1;
}

export class Inventory {
  private readonly windows = new Map<number, (ItemStack | null)[]>();
  private readonly toItem: (i: ItemV4) => ItemStack | null;
  private readonly selfRuntimeId: () => bigint;
  private _selected = 0;
  private readonly changeFns = new Set<(window: number, slot: number | undefined) => void>();

  constructor(toItem: (i: ItemV4) => ItemStack | null, selfRuntimeId: () => bigint) {
    this.toItem = toItem;
    this.selfRuntimeId = selfRuntimeId;
    this.windows.set(WINDOW_INVENTORY, new Array<ItemStack | null>(INVENTORY_SIZE).fill(null));
  }

  /** Player inventory slots (0..8 hotbar, 9..35 main). */
  get slots(): readonly (ItemStack | null)[] {
    return this.windows.get(WINDOW_INVENTORY) ?? [];
  }

  /** Selected hotbar slot (0..8). */
  get selected(): number {
    return this._selected;
  }

  /** Item in the selected hotbar slot. */
  get held(): ItemStack | null {
    return this.slots[this._selected] ?? null;
  }

  window(id: number): ContainerView | undefined {
    const slots = this.windows.get(id);
    return slots ? { id, slots } : undefined;
  }

  /** Total count of an item (name without namespace) in the player inventory. */
  count(name: string): number {
    const short = name.startsWith('minecraft:') ? name.slice(10) : name;
    let n = 0;
    for (const s of this.slots) if (s?.name === short) n += s.count;
    return n;
  }

  onChange(fn: (window: number, slot: number | undefined) => void): () => void {
    this.changeFns.add(fn);
    return () => this.changeFns.delete(fn);
  }

  clear(): void {
    this.windows.clear();
    this.windows.set(WINDOW_INVENTORY, new Array<ItemStack | null>(INVENTORY_SIZE).fill(null));
  }

  handleInventoryContent(p: InventoryContent): void {
    const id = windowId(p.window_id);
    this.windows.set(
      id,
      p.input.map((i) => this.toItem(i)),
    );
    this.emit(id, undefined);
  }

  handleInventorySlot(p: InventorySlot): void {
    this.setSlot(windowId(p.window_id), p.slot, p.item);
  }

  private setSlot(id: number, slot: number, item: ItemV4): void {
    let slots = this.windows.get(id);
    if (!slots) {
      slots = [];
      this.windows.set(id, slots);
    }
    while (slots.length <= slot) slots.push(null);
    slots[slot] = this.toItem(item);
    this.emit(id, slot);
  }

  /**
   * Server-initiated changes (e.g. /give, truth:give) arrive as a clientbound inventory_transaction
   * of type 'normal' whose 'container' actions carry the new slot contents.
   */
  handleInventoryTransaction(p: InventoryTransaction): void {
    const t = p.transaction;
    if (t.transaction_type !== 'normal' || !t.actions) return;
    for (const a of t.actions) {
      if (a.source_type !== 'container' || a.window_id === undefined) continue;
      this.setSlot(windowId(a.window_id), a.slot, a.new_item);
    }
  }

  handlePlayerHotbar(p: PlayerHotbar): void {
    if (windowId(p.window_id) !== WINDOW_INVENTORY) return;
    if (p.select_slot && p.selected_slot >= 0 && p.selected_slot < 9) this._selected = p.selected_slot;
  }

  handleMobEquipment(p: MobEquipment): void {
    if (toBigInt(p.runtime_entity_id) !== this.selfRuntimeId()) return;
    if (windowId(p.window_id) === WINDOW_INVENTORY && p.selected_slot >= 0 && p.selected_slot < 9) this._selected = p.selected_slot;
  }

  /** The client changed the selected slot itself (it must also send mob_equipment). */
  select(slot: number): void {
    if (slot >= 0 && slot < 9) this._selected = slot;
  }

  private emit(window: number, slot: number | undefined): void {
    for (const fn of [...this.changeFns]) fn(window, slot);
  }
}
