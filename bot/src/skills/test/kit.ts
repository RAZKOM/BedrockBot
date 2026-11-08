// Track T1 (ADR 0075): the test kit, and the commands that put it back on the bot.
//
// The kit is what the bot should carry at the start of every run: worn pieces (`@head`, `@chest`, `@legs`, `@feet`,
// `@offhand`) and inventory items with a count. Where it comes from (the `testKit` setting):
//   start   (default) what the bot carried when the series began (snapshotKit), shulker boxes left out (their contents
//           cannot be given back by a command; loose rockets are)
//   file    <tests dir>/kit.json: ["elytra", "firework_rocket 64", "diamond_chestplate @chest", ...] or the same as one string
//   a list  `elytra, firework_rocket 64, diamond_chestplate @chest, cooked_beef 32` typed into !set testKit
//
// planKit compares the kit with what the inventory model holds now and returns the commands: `/replaceitem` for an empty
// worn slot (the piece goes straight on), `/give` for whatever is missing (a worn piece whose slot holds something else,
// e.g. the elytra on the back in place of the chestplate, is given, never overwritten), and a fresh elytra in place of one
// with fewer than `elytraMin` uses left (the same slot, /replaceitem). Enchantments do not come back (/give has no
// enchantment component on Bedrock). Item names are checked (lower case, digits, underscores) before they go into a command.
import type { ItemStack } from '../../world/types.ts';
import { isShulkerBox } from '../container/chest.ts';
import { durabilityLeft } from '../survival/tools.ts';

export type WornSlot = 'head' | 'chest' | 'legs' | 'feet' | 'offhand';
export const WORN_SLOTS: readonly WornSlot[] = ['head', 'chest', 'legs', 'feet', 'offhand'];

/** The Bedrock slot of each worn piece for /replaceitem. */
const SLOT_NAME: Readonly<Record<WornSlot, string>> = {
  head: 'slot.armor.head 0',
  chest: 'slot.armor.chest 0',
  legs: 'slot.armor.legs 0',
  feet: 'slot.armor.feet 0',
  offhand: 'slot.weapon.offhand 0',
};

export interface KitEntry {
  item: string;
  count: number;
  slot?: WornSlot;
}

/** The most of one item a kit entry asks for (36 stacks). */
export const KIT_MAX_COUNT = 2304;
/** TEST_LIMITS.elytraMin (series.ts): a fresh elytra replaces one with fewer uses left (432 is new). */
export const ELYTRA_MIN_DEFAULT = 100;

const ITEM_RE = /^[a-z][a-z0-9_]{0,63}$/;

export class KitError extends Error {
  override name = 'KitError';
}

/** `elytra, firework_rocket 64, diamond_chestplate @chest` -> entries. Throws KitError. */
export function parseKitText(text: string): KitEntry[] {
  const out: KitEntry[] = [];
  for (const part0 of text.split(/[,;\n]/)) {
    const part = part0.trim().toLowerCase();
    if (!part) continue;
    const words = part.split(/\s+/);
    let item: string | undefined;
    let count = 1;
    let slot: WornSlot | undefined;
    for (const w of words) {
      if (w.startsWith('@')) {
        const s = w.slice(1) as WornSlot;
        if (!WORN_SLOTS.includes(s)) throw new KitError(`unknown slot ${w} (${WORN_SLOTS.map((x) => `@${x}`).join(' ')})`);
        slot = s;
      } else if (/^\d+$/.test(w)) count = Number(w);
      else if (item === undefined) item = w.replace(/^minecraft:/, '');
      else throw new KitError(`"${part}": one item per entry`);
    }
    if (!item || !ITEM_RE.test(item)) throw new KitError(`"${part}": not an item name`);
    if (count < 1 || count > KIT_MAX_COUNT) throw new KitError(`"${part}": the count must be 1..${KIT_MAX_COUNT}`);
    if (slot) count = 1;
    out.push({ item, count, ...(slot ? { slot } : {}) });
  }
  return out;
}

/** Entries -> `elytra, firework_rocket 64, diamond_chestplate @chest`. */
export function formatKit(kit: readonly KitEntry[]): string {
  return kit.map((e) => `${e.item}${e.count > 1 ? ` ${e.count}` : ''}${e.slot ? ` @${e.slot}` : ''}`).join(', ');
}

/** What the bot carries, as the kit code reads it: inventory 0..35, the four armour slots (window 120), the offhand (119). */
export interface KitView {
  slots: readonly (ItemStack | null)[];
  worn: Readonly<Record<WornSlot, ItemStack | null>>;
}

export interface KitViewSource {
  readonly slots: readonly (ItemStack | null)[];
  window?(id: number): { readonly slots: readonly (ItemStack | null)[] } | undefined;
}

export function kitView(inv: KitViewSource): KitView {
  const armor = inv.window?.(120)?.slots ?? [];
  const off = inv.window?.(119)?.slots ?? [];
  const at = (a: readonly (ItemStack | null)[], i: number): ItemStack | null => {
    const s = a[i];
    return s && s.count > 0 ? s : null;
  };
  return { slots: inv.slots.slice(0, 36), worn: { head: at(armor, 0), chest: at(armor, 1), legs: at(armor, 2), feet: at(armor, 3), offhand: at(off, 0) } };
}

const usable = (name: string): boolean => ITEM_RE.test(name) && !isShulkerBox(name);

/** The kit the bot carries now (the `start` kit): worn pieces with their slot, inventory items summed by name. */
export function snapshotKit(v: KitView): KitEntry[] {
  const out: KitEntry[] = [];
  for (const slot of WORN_SLOTS) {
    const s = v.worn[slot];
    if (s && usable(s.name)) out.push({ item: s.name, count: 1, slot });
  }
  const counts = new Map<string, number>();
  for (const s of v.slots) if (s && s.count > 0 && usable(s.name)) counts.set(s.name, (counts.get(s.name) ?? 0) + s.count);
  for (const [item, count] of counts) out.push({ item, count: Math.min(count, KIT_MAX_COUNT) });
  return out;
}

export interface KitPlan {
  commands: string[];
  /** `chest diamond_chestplate (worn)`, `firework_rocket +40`, `elytra (fresh: 31 uses left)` for the log and the record. */
  notes: string[];
}

/** The replaceitem slot of an inventory index (0..8 hotbar, 9..35 the rest). */
export function inventorySlotName(i: number): string {
  return i < 9 ? `slot.hotbar ${i}` : `slot.inventory ${i - 9}`;
}

/**
 * The commands that make `v` carry `kit` (pure). A fresh elytra replaces any carried elytra with fewer than `elytraMin`
 * uses left (0 = never); that check runs with an empty kit too.
 */
export function planKit(kit: readonly KitEntry[], v: KitView, opts: { elytraMin?: number } = {}): KitPlan {
  const commands: string[] = [];
  const notes: string[] = [];
  // the worn-out elytra first: the same slot gets a new one, so the counts below see it as carried
  const elytraMin = opts.elytraMin ?? 0;
  if (elytraMin > 0) {
    const worn = v.worn.chest;
    const left = worn?.name === 'elytra' ? durabilityLeft(worn) : undefined;
    if (left !== undefined && left < elytraMin) {
      commands.push(`/replaceitem entity @s ${SLOT_NAME.chest} elytra`);
      notes.push(`elytra on the back (fresh: ${left} uses left)`);
    }
    v.slots.forEach((s, i) => {
      if (s?.name !== 'elytra') return;
      const l = durabilityLeft(s);
      if (l === undefined || l >= elytraMin) return;
      commands.push(`/replaceitem entity @s ${inventorySlotName(i)} elytra`);
      notes.push(`elytra in slot ${i} (fresh: ${l} uses left)`);
    });
  }
  // what is carried, by name; worn pieces are taken by their own entries first
  const pool = new Map<string, number>();
  for (const s of v.slots) if (s && s.count > 0) pool.set(s.name, (pool.get(s.name) ?? 0) + s.count);
  const take = (name: string, n: number): number => {
    const have = pool.get(name) ?? 0;
    const got = Math.min(have, n);
    pool.set(name, have - got);
    return got;
  };
  const wornLeft = new Map<WornSlot, ItemStack | null>(WORN_SLOTS.map((s) => [s, v.worn[s]]));
  for (const e of kit) {
    if (!e.slot || !ITEM_RE.test(e.item)) continue;
    const on = wornLeft.get(e.slot);
    if (on?.name === e.item) {
      wornLeft.set(e.slot, null);
      continue;
    }
    if (take(e.item, 1) === 1) continue; // carried, not worn (the elytra flight wears the elytra in its place): fine
    if (!on) {
      commands.push(`/replaceitem entity @s ${SLOT_NAME[e.slot]} ${e.item}`);
      notes.push(`${e.slot} ${e.item} (worn)`);
    } else {
      commands.push(`/give @s ${e.item} 1`);
      notes.push(`${e.item} +1 (the ${e.slot} slot holds ${on.name})`);
    }
  }
  // worn pieces no entry claimed count as carried (an elytra on the back for a kit that lists it loose)
  for (const s of wornLeft.values()) if (s) pool.set(s.name, (pool.get(s.name) ?? 0) + 1);
  for (const e of kit) {
    if (e.slot || !ITEM_RE.test(e.item)) continue;
    const missing = e.count - take(e.item, e.count);
    if (missing <= 0) continue;
    commands.push(`/give @s ${e.item} ${missing}`);
    notes.push(`${e.item} +${missing}`);
  }
  return { commands, notes };
}
