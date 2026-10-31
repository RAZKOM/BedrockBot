// Track AV (wave 11, docs/home.md "Boxing at the chests", decisions/0044-boxing.md): the owner's named
// shulker boxes and the spare empty boxes. Pure helpers over the inventory model and the chest memory.
//
// The owner: "I named the shulkers for it bot_loot ... Those are ones it should keep." A shulker box whose
// custom name (world/inventory.ts itemDisplayName: the item NBT's `display.Name`) is the `keepBoxName`
// setting (default `bot_loot`; case, colour codes and surrounding spaces ignored) is the bot's own:
//   - never unloaded as an item, never put into a chest, never used for boxing, never a spare
//   - never dropped by `!drop all` / `!drop items` (`kept 4 bot_loot boxes`)
//   - the stash step fills it first (before any unnamed box)
//   - `!unload` empties it into the inventory and unloads its items like loose stacks; the box stays
// The fireworks box of the flight kit keeps its own rule (Track AU): it is checked first.
//
// A spare is an unnamed shulker box whose NBT `Items` are empty and that is not the flight kit's. Spares
// are carried, or remembered in the chests (ChestRecord.boxes.empty counts unnamed empty boxes only since
// this track: HomeLogistics.remember moves the named ones out of the counts).
import type { ChestRecord } from '../../world/cache/chests.ts';
import { itemDisplayName } from '../../world/inventory.ts';
import { isShulkerBox, shulkerContents, shulkerSlotsUsed } from '../container/chest.ts';
import { isFireworksBox } from '../fly/kit.ts';
import { chestName } from './memory.ts';

export const DEFAULT_KEEP_BOX_NAME = 'bot_loot';
/** Slots of a shulker box. */
export const BOX_SLOTS = 27;
/** Box steps (`box`) per unload run at most. */
export const MAX_BOX_STEPS = 4;
/**
 * Fill steps (a spare filled with 27 full stacks of what the bot carries, loose and in its bot_loot boxes) per unload
 * run at most: 36 slots and a few bot_loot boxes of 27 hold about 6 boxes' worth; each step is bounded (its rounds
 * by MAX_FILL_ROUNDS in logistics.ts), so a run stays within a few minutes.
 */
export const MAX_FILL_STEPS = 6;
/** Tidy steps (a chest's own 27 full stacks of one item into a spare, the box back there) per run at most: like MAX_BOX_STEPS, a run never spends ages. */
export const MAX_TIDY_STEPS = 4;

/** `§6Bot_Loot ` -> `bot_loot`: colour / format codes and surrounding spaces dropped, lower case. */
export function plainName(s: string): string {
  return s.replace(/§./g, '').trim().toLowerCase();
}

/** The keep name to compare with (`keepBoxName`, default bot_loot). */
export function keepNameOf(setting: unknown): string {
  const v = typeof setting === 'string' ? plainName(setting) : '';
  return v || DEFAULT_KEEP_BOX_NAME;
}

/** A display name that marks the bot's own box. */
export function isKeepName(display: string | undefined, keepName: string = DEFAULT_KEEP_BOX_NAME): boolean {
  return display !== undefined && plainName(display) === keepNameOf(keepName);
}

/** A shulker box item named `keepName` (raw: the wire item with its NBT). */
export function isKeptBox(name: string, raw: unknown, keepName: string = DEFAULT_KEEP_BOX_NAME): boolean {
  return isShulkerBox(name) && isKeepName(itemDisplayName(raw), keepName);
}

export interface BoxInventory {
  readonly slots: readonly ({ name: string; count: number } | null)[];
  rawItem?(window: number, slot: number): unknown;
}

export interface CarriedBox {
  slot: number;
  name: string;
  /** NBT `Items` slots used. */
  used: number;
  contents: Record<string, number>;
  /** Named `keepBoxName`: the bot's own. */
  named: boolean;
  /** The flight kit's fireworks box (Track AU), or the slot the owner named with `!fly box`. */
  flightKit: boolean;
  /** No wire item known for the slot (its name and contents unknown, e.g. after a refused request): never a spare, never stored. */
  unknown: boolean;
}

/** The shulker boxes in the inventory (slots 0..35). */
export function carriedBoxes(inv: BoxInventory, keepName?: string, flightBoxSlot?: number): CarriedBox[] {
  const out: CarriedBox[] = [];
  inv.slots.slice(0, 36).forEach((s, i) => {
    if (!s || s.count <= 0 || !isShulkerBox(s.name)) return;
    const raw = inv.rawItem?.(0, i);
    out.push({ slot: i, name: s.name, used: shulkerSlotsUsed(raw), contents: shulkerContents(raw), named: isKeptBox(s.name, raw, keepName), flightKit: isFireworksBox(s.name, raw) || flightBoxSlot === i, unknown: raw === undefined });
  });
  return out;
}

/** Inventory slots holding a box named `keepName` (never dropped by `!drop all` / `!drop items`). */
export function keptBoxSlots(inv: BoxInventory, keepName?: string): Set<number> {
  return new Set(carriedBoxes(inv, keepName).filter((b) => b.named).map((b) => b.slot));
}

/** Carried spares: unnamed, empty, not the flight kit's, known (a box without its wire item is no spare). */
export function carriedSpares(boxes: readonly CarriedBox[]): CarriedBox[] {
  return boxes.filter((b) => !b.named && !b.flightKit && !b.unknown && b.used === 0);
}

/** `kept 4 bot_loot boxes` / `kept 1 bot_loot box` */
export function keptBoxesLine(n: number, keepName: string = DEFAULT_KEEP_BOX_NAME): string {
  return `kept ${n} ${keepNameOf(keepName)} box${n === 1 ? '' : 'es'}`;
}

/** `4 bot_loot boxes` */
export function namedBoxesWord(n: number, keepName: string = DEFAULT_KEEP_BOX_NAME): string {
  return `${n} ${keepNameOf(keepName)} box${n === 1 ? '' : 'es'}`;
}

/** `place` picks the held box, else the lowest hotbar slot of that name, else the first main slot: true when that is `slot` (after selecting it if it is in the hotbar). */
export function placesExactly(slots: readonly ({ name: string; count: number } | null)[], slot: number): boolean {
  if (slot < 9) return true;
  const name = slots[slot]?.name;
  if (!name) return false;
  for (let i = 0; i < 9; i++) if (slots[i]?.name === name && (slots[i]?.count ?? 0) > 0) return false;
  for (let i = 9; i < slot; i++) if (slots[i]?.name === name && (slots[i]?.count ?? 0) > 0) return false;
  return true;
}

const top = (c: Record<string, number>): string =>
  Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

/**
 * `!boxes`: the spare empty boxes known (carried, then the chests holding some, most first) and the
 * named boxes carried: `boxes: 3 spare (1 carried, 2 in chest 1 2 3); carrying 2 bot_loot boxes (1 empty, 1 holding 1728 sand)`.
 */
export function boxesLine(carried: readonly CarriedBox[], records: readonly ChestRecord[], keepName?: string): string {
  const spares = carriedSpares(carried).length;
  const chests = records.filter((r) => r.readAt > 0 && !r.unreachable && r.boxes.empty > 0 && !isShulkerBox(r.kind)).sort((a, b) => b.boxes.empty - a.boxes.empty);
  const inChests = chests.reduce((a, r) => a + r.boxes.empty, 0);
  const parts: string[] = [];
  const where = [...(spares ? [`${spares} carried`] : []), ...chests.slice(0, 4).map((r) => `${r.boxes.empty} in ${chestName(r)}`), ...(chests.length > 4 ? [`${chests.length - 4} more chests`] : [])];
  parts.push(spares + inChests > 0 ? `${spares + inChests} spare (${where.join(', ')})` : 'no spare empty box known (carried or in the chests I know)');
  const named = carried.filter((b) => b.named && !b.flightKit);
  if (named.length) {
    const empty = named.filter((b) => b.used === 0).length;
    const full = named.filter((b) => b.used > 0);
    const what = [...(empty ? [`${empty} empty`] : []), ...full.map((b) => `1 holding ${top(b.contents) || `${b.used} stacks`}`)];
    parts.push(`carrying ${namedBoxesWord(named.length, keepName)} (${what.join(', ')})`);
  } else parts.push(`no ${keepNameOf(keepName)} box carried`);
  return `boxes: ${parts.join('; ')}`;
}

/** The `keepBoxName` of a task (commands-home registers it; `!drop all` / `!drop items` read it). */
const keepNames = new WeakMap<object, () => unknown>();
export function setKeepBoxName(task: object, get: () => unknown): void {
  keepNames.set(task, get);
}
export function keepBoxNameOf(task: object | undefined): string {
  return keepNameOf(task ? keepNames.get(task)?.() : undefined);
}
