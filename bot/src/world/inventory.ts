// Inventory model (PLAN.md task 2.5): `inventory_content`, `inventory_slot`, clientbound
// `inventory_transaction` (how BDS announces /give), `player_hotbar` and our own `mob_equipment`.
// Every slot also keeps the raw wire ItemV4 as the server sent it (`rawItem`): packets such as
// mob_equipment and inventory_transaction must echo items exactly. Item stack requests (Phase 4.5,
// world/containers.ts) change slots through `setItem` (client prediction, then the server's
// item_stack_response).
import type { InventoryContent, InventorySlot, InventoryTransaction, ItemV4, MobEquipment, PlayerArmorDamage, PlayerHotbar, WindowIdField } from './packets.ts';
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
  /** Raw wire items per window and slot (undefined = never reported or changed by a prediction). */
  private readonly raws = new Map<number, (ItemV4 | undefined)[]>();
  private readonly toItem: (i: ItemV4) => ItemStack | null;
  private readonly selfRuntimeId: () => bigint;
  private _selected = 0;
  private readonly changeFns = new Set<(window: number, slot: number | undefined) => void>();

  constructor(toItem: (i: ItemV4) => ItemStack | null, selfRuntimeId: () => bigint) {
    this.toItem = toItem;
    this.selfRuntimeId = selfRuntimeId;
    this.windows.set(WINDOW_INVENTORY, new Array<ItemStack | null>(INVENTORY_SIZE).fill(null));
  }

  // ---- Track P1: an unreadable packet leaves the model unsure until the server's full inventory comes back ----------
  private _unsure: string | undefined;
  private readonly sureFns = new Set<() => void>();
  /** Inventory packets lost to a parse failure (counted by `markLost`). */
  lostPackets = 0;
  /** Full contents of the player inventory (window 0 inventory_content) received so far: a resync bumps it. */
  contentGeneration = 0;
  /** Asks the server for the whole inventory (world/resync.ts sets it: an inventory_mismatch transaction). */
  resyncer: ((reason: string) => void) | undefined;

  /** Why the model may differ from the server's inventory (a packet it never read), undefined when it is sure. */
  get unsure(): string | undefined {
    return this._unsure;
  }

  /** An inventory packet could not be read: the model is unsure until the next full inventory_content. */
  markLost(reason: string): void {
    this.lostPackets++;
    this.markUnsure(reason);
  }

  /** The model may differ from the server's (until the next full inventory_content). */
  markUnsure(reason: string): void {
    this._unsure = reason;
  }

  /** Mark unsure and ask the server for the whole inventory (no-op without a resyncer). */
  requestResync(reason: string): void {
    this._unsure ??= reason;
    this.resyncer?.(reason);
  }

  /** Give up waiting (the server never answered): the model is used as it is. */
  clearUnsure(): void {
    if (this._unsure === undefined) return;
    this._unsure = undefined;
    for (const fn of [...this.sureFns]) fn();
  }

  /** Resolves true once the model is sure (at once when it is), false after `timeoutMs`. */
  whenSure(timeoutMs: number): Promise<boolean> {
    if (this._unsure === undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.sureFns.delete(fn);
        resolve(ok);
      };
      const fn = () => done(true);
      const timer = setTimeout(() => done(this._unsure === undefined), timeoutMs);
      this.sureFns.add(fn);
    });
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

  /** The wire item last reported for a slot (undefined: never reported, or changed locally since). */
  rawItem(window: number, slot: number): ItemV4 | undefined {
    return this.raws.get(window)?.[slot];
  }

  /** Window ids currently held (0 is always there). */
  windowIds(): number[] {
    return [...this.windows.keys()];
  }

  /**
   * Set a slot from the client side (item stack request prediction or response). Creates the window if
   * needed. The raw wire item is the one given; without one (Track F12), the last wire item the server
   * sent for the same stack (its stack network id, the same item) with the count and stack id of `item`
   * (`rawLike`): a stack moved or swapped by a request is the same stack with the same NBT on the
   * server, so a use or a selection echoes it whole. Else, for the same item kind staying in the slot
   * (a count or a stack id the response changed: the crafter's, a merge), the slot's own wire item so
   * rewritten. Undefined when no such wire item is known (the slot's raw is cleared, as before).
   */
  setItem(window: number, slot: number, item: ItemStack | null, raw?: ItemV4): void {
    let slots = this.windows.get(window);
    if (!slots) {
      slots = [];
      this.windows.set(window, slots);
    }
    while (slots.length <= slot) slots.push(null);
    let r = raw ?? (item ? this.rawOfStack(item) : undefined);
    if (!r && item) {
      const own = this.rawsOf(window)[slot];
      const was = slots[slot];
      if (own && was && own.network_id === item.networkId && own.metadata === item.metadata && was.networkId === item.networkId) r = rawLike(own, item);
    }
    slots[slot] = item;
    this.rawsOf(window)[slot] = r;
    this.remember(r);
    this.emit(window, slot);
  }

  /** Track F12: the wire item last seen for `item`'s stack (by stack id), rewritten to `item`'s count; undefined when none is known. */
  rawOfStack(item: ItemStack): ItemV4 | undefined {
    if (item.stackId === undefined) return undefined;
    const seen = this.byStack.get(item.stackId);
    return seen?.network_id === item.networkId ? rawLike(seen, item) : undefined;
  }

  /** Track F12: wire items by stack id (the server's stack network ids are never reused), the newest 512. */
  private readonly byStack = new Map<number, ItemV4>();

  private remember(raw: ItemV4 | undefined): void {
    if (!raw?.has_stack_id || raw.stack_id === undefined || raw.network_id === 0) return;
    this.byStack.delete(raw.stack_id);
    this.byStack.set(raw.stack_id, raw);
    if (this.byStack.size > 512) this.byStack.delete(this.byStack.keys().next().value!);
  }

  /** Forget a container window (container_close). The player inventory (0) is never removed. */
  removeWindow(window: number): void {
    if (window === WINDOW_INVENTORY) return;
    this.windows.delete(window);
    this.raws.delete(window);
    this.emit(window, undefined);
  }

  /** Player inventory slots (0..35) that are empty. */
  freeSlots(): number[] {
    const out: number[] = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) if (!this.slots[i]) out.push(i);
    return out;
  }

  /**
   * How many of `name` still fit into the player inventory (empty slots and partial stacks of the
   * same item, `maxStack` per slot).
   */
  room(name: string, maxStack = 64): number {
    const short = name.startsWith('minecraft:') ? name.slice(10) : name;
    let n = 0;
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = this.slots[i];
      if (!s) n += maxStack;
      else if (s.name === short) n += Math.max(0, maxStack - s.count);
    }
    return n;
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
    this.raws.clear();
    this.byStack.clear();
    this.windows.set(WINDOW_INVENTORY, new Array<ItemStack | null>(INVENTORY_SIZE).fill(null));
  }

  private rawsOf(window: number): (ItemV4 | undefined)[] {
    let r = this.raws.get(window);
    if (!r) {
      r = [];
      this.raws.set(window, r);
    }
    return r;
  }

  handleInventoryContent(p: InventoryContent): void {
    const id = windowId(p.window_id);
    this.windows.set(
      id,
      p.input.map((i) => this.toItem(i)),
    );
    this.raws.set(id, [...p.input]);
    for (const r of p.input) this.remember(r); // Track F12
    if (id === WINDOW_INVENTORY) {
      // Track P1: the server's whole inventory: what a lost packet changed is in it
      this.contentGeneration++;
      this.clearUnsure();
    }
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
    this.rawsOf(id)[slot] = item;
    this.remember(item); // Track F12
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

  /**
   * Track F20 (docs/flight.md "A flight never outlasts its elytra (Track F20)"): the wear of worn armour. The server does
   * not send the armour slot again when a piece takes a use: it sends player_armor_damage with the piece's new damage
   * value (BDS 1.26.60.6: one a second of gliding for the elytra, one a hit for each piece worn). Without this the model
   * kept the damage of the last time the slot itself was sent: on bds-fly an elytra's count was 53 uses behind after 58 s
   * of flight, and four iron pieces hit three times stayed at 10 / 20 / 30 / 40 while the server had 13 / 23 / 33 / 43. The
   * piece keeps its place, its stack id and its wire item; only `damage` changes.
   */
  handleArmorDamage(p: PlayerArmorDamage): void {
    const slots = this.windows.get(WINDOW_ARMOR);
    if (!slots) return;
    for (const e of p.entries ?? []) {
      if (typeof e.damage !== 'number' || !Number.isFinite(e.damage) || e.damage < 0) continue;
      const at = armourIndex(e.armor_slot);
      const item = at === undefined ? undefined : slots[at];
      if (at === undefined || !item || item.damage === e.damage) continue;
      slots[at] = { ...item, damage: e.damage };
      this.emit(WINDOW_ARMOR, at);
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

/** minecraft-data's names for the first values of a player_armor_damage entry's slot byte. */
const ARMOUR_SLOT_NAMES: Readonly<Record<string, number>> = { helmet: 0, chestplate: 1, leggings: 2, boots: 3, body: 4 };

/**
 * Track F20: the armour window's slot (0 head, 1 chest, 2 legs, 3 feet) a player_armor_damage entry is about. Measured on
 * BDS 1.26.60.6 with four iron pieces at damage 10 / 20 / 30 / 40 hit once: the entries read `helmet` 11, `leggings` 21,
 * `body` 31 and a bare `6` with 41: the byte is twice the slot (0, 2, 4, 6), which minecraft-data 3.119 reads as its enum
 * of 0 to 4. So the slot is half the byte; an odd byte is no slot measured and is left alone. (A protocol file that reads
 * the byte differently shows in the e2e: test/e2e/fly-wear.test.ts holds the bot's count against the server's.)
 */
export function armourIndex(slot: string | number): number | undefined {
  const byte = typeof slot === 'number' ? slot : ARMOUR_SLOT_NAMES[slot];
  if (byte === undefined || !Number.isInteger(byte) || byte < 0 || byte > 6 || byte % 2 !== 0) return undefined;
  return byte / 2;
}

/**
 * Track F12: the wire item `raw` (its NBT, block runtime id, can-place/destroy lists) as the stack `item` now is:
 * its count, and its stack id (none when the model has none yet: a split into an empty slot before the
 * server's item_stack_response names the new stack). A stack the bot's own item stack request moved, merged
 * or split keeps its NBT on the server; only the count and the stack id change, and the response says both.
 */
export function rawLike<T extends ItemV4>(raw: T, item: { count: number; stackId?: number }): T {
  const out = { ...raw, count: item.count, has_stack_id: item.stackId !== undefined } as T;
  if (item.stackId !== undefined) out.stack_id = item.stackId;
  else delete out.stack_id;
  return out;
}

/**
 * Track AV: the custom name of an item (an anvil or a script's `nameTag`), from the raw wire item's NBT:
 * `extra.nbt.nbt.value.display.value.Name.value` (a string; colour codes such as `§6` are kept).
 * Verified on BDS 1.26.60 (bds-home, a box named by truth:nameinv): an unnamed box has `has_nbt: 0`; a
 * named empty one `{display: {Name: 'bot_loot'}}`; a named full one has `Items` and `display` side by side
 * (naming keeps the contents). Undefined without a name.
 */
export function itemDisplayName(raw: unknown): string | undefined {
  const v = (raw as { extra?: { nbt?: { nbt?: { value?: { display?: { value?: { Name?: { value?: unknown } } } } } } } } | undefined)?.extra?.nbt?.nbt?.value?.display?.value?.Name?.value;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Track BI: the enchantments of a raw wire item: `extra.nbt.nbt.value.ench.value.value[]` of `{id, lvl}` shorts
 * (verified on BDS 1.26.60 with /enchant on diamond boots: feather falling id 2, protection id 0). Undefined
 * without any.
 */
export function itemEnchants(raw: unknown): { id: number; lvl: number }[] | undefined {
  const list = (raw as { extra?: { nbt?: { nbt?: { value?: { ench?: { value?: { value?: unknown } } } } } } } | undefined)?.extra?.nbt?.nbt?.value?.ench?.value?.value;
  if (!Array.isArray(list)) return undefined;
  const out: { id: number; lvl: number }[] = [];
  for (const e of list as { id?: { value?: unknown }; lvl?: { value?: unknown } }[]) {
    const id = e.id?.value;
    const lvl = e.lvl?.value;
    if (typeof id === 'number' && typeof lvl === 'number') out.push({ id, lvl });
  }
  return out.length ? out : undefined;
}
