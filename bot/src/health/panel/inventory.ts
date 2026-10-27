// Track AP (wave 9, docs/panel.md "Inventory", decision 0037): the `inventory` block of /api/state.
// The page draws every slot itself (no textures, no internet): an icon class from a small hand-drawn
// glyph set, a deterministic colour from the item name, a 2 to 3 letter abbreviation, the count, a
// durability bar (the NBT `Damage` against skills/survival/tools.ts maxDurability) and, for a shulker
// box, what it holds (the raw wire item's NBT `Items`, skills/container/chest.ts shulkerContents).
import { isShulkerBox, shulkerContents, shulkerSlotsUsed } from '../../skills/container/chest.ts';
import { armourScore, armourSlotOf } from '../../skills/survival/armour.ts';
import { foodInfo } from '../../skills/survival/eat.ts';
import { maxDurability } from '../../skills/survival/tools.ts';
import type { ItemStack } from '../../world/types.ts';

/** Glyphs the page has (page.ts GLYPHS); `item` is the plain coloured tile. */
export const ICON_CLASSES = ['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'bow', 'shield', 'helmet', 'chestplate', 'leggings', 'boots', 'food', 'block', 'ore', 'box', 'bucket', 'torch', 'item'] as const;
export type IconClass = (typeof ICON_CLASSES)[number];

/** Shulker box contents in the payload: at most this many kinds (the biggest), the rest counted in `more`. */
export const BOX_KINDS_MAX = 8;

export interface PanelItem {
  /** Item name without namespace (`iron_sword`). */
  name: string;
  count: number;
  icon: IconClass;
  /** `#rrggbb`, the same for the same name on every poll and every machine. */
  colour: string;
  /** 2 to 3 letters (`ISw`, `Co`, `USB`). */
  abbr: string;
  /** Tools, weapons, armour: uses left, the maximum, percent left (0..100, rounded). */
  dur?: { left: number; max: number; pct: number };
  /** Shulker boxes: `known` false when the raw item is not there (changed locally since the server sent it). */
  box?: { known: boolean; stacks: number; items: [string, number][]; more: number };
}

export interface PanelInventory {
  /** Player inventory 0..35: 0..8 the hotbar (the bottom row on the page), 9..35 the main inventory. */
  slots: (PanelItem | null)[];
  /** Head, chest, legs, feet (window 120). */
  armour: (PanelItem | null)[];
  /** Window 119 slot 0. */
  offhand: PanelItem | null;
  /** Selected hotbar slot 0..8. */
  selected: number;
  /** Armour points of the worn pieces (0..20; skills/survival/armour.ts). */
  armourPoints: number;
  /** Empty slots of the 36. */
  free: number;
}

/** What buildInventory reads (world/inventory.ts Inventory). */
export interface InventorySource {
  readonly slots: readonly (ItemStack | null)[];
  readonly selected: number;
  window(id: number): { slots: readonly (ItemStack | null)[] } | undefined;
  rawItem(window: number, slot: number): unknown;
}

const WINDOW_INVENTORY = 0;
const WINDOW_OFFHAND = 119;
const WINDOW_ARMOR = 120;

const bare = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n);

const ARMOUR_ICONS: readonly IconClass[] = ['helmet', 'chestplate', 'leggings', 'boots'];
const FOOD_EXTRA = new Set(['cake', 'cookie', 'pumpkin_pie', 'melon_slice', 'sweet_berries', 'glow_berries', 'honey_bottle', 'chorus_fruit', 'suspicious_stew', 'enchanted_golden_apple', 'milk_bucket', 'mushroom_stew', 'beetroot_soup', 'dried_kelp']);
const BLOCK_WORDS = /(^|_)(log|wood|planks|stone|cobblestone|dirt|grass_block|sand|gravel|bricks?|slab|stairs|wall|fence|glass|wool|terracotta|concrete|deepslate|tuff|andesite|diorite|granite|netherrack|obsidian|leaves|block|table|furnace|chest|barrel|door|trapdoor|ladder|bed|hay_bale|clay|mud|basalt|blackstone|calcite|quartz|prismarine|sponge|ice|snow)$/;

/** The glyph an item is drawn with. */
export function iconClassOf(name: string, blockRuntimeId?: number): IconClass {
  const n = bare(name);
  if (n === 'milk_bucket') return 'bucket';
  if (n.endsWith('bucket')) return 'bucket';
  if (n.includes('torch') || n === 'lantern' || n === 'soul_lantern') return 'torch';
  if (isShulkerBox(n)) return 'box';
  if (n.endsWith('_sword') || n === 'mace' || n === 'trident') return 'sword';
  if (n.endsWith('_pickaxe')) return 'pickaxe';
  if (n.endsWith('_axe')) return 'axe';
  if (n.endsWith('_shovel')) return 'shovel';
  if (n.endsWith('_hoe')) return 'hoe';
  if (n === 'bow' || n === 'crossbow') return 'bow';
  if (n === 'shield') return 'shield';
  const slot = armourSlotOf(n);
  if (slot !== undefined) return ARMOUR_ICONS[slot]!;
  if (n === 'elytra') return 'chestplate';
  if (foodInfo(n) || FOOD_EXTRA.has(n)) return 'food';
  if (n.endsWith('_ore') || n === 'ancient_debris' || n.startsWith('raw_') || n === 'coal' || n === 'diamond' || n === 'emerald' || n === 'lapis_lazuli' || n === 'redstone' || n === 'quartz' || n.endsWith('_ingot') || n === 'netherite_scrap') return 'ore';
  if (n === 'chest' || n === 'trapped_chest' || n === 'barrel' || n === 'ender_chest' || n === 'bundle') return 'box';
  if (blockRuntimeId || BLOCK_WORDS.test(n)) return 'block';
  return 'item';
}

/** FNV-1a over the name (32 bit). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hslHex(h: number, s: number, l: number): string {
  const sl = s / 100;
  const ll = l / 100;
  const a = sl * Math.min(ll, 1 - ll);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Material colours (tools, armour, ingots, ores read as their material). */
const MATERIAL_COLOURS: readonly [RegExp, string][] = [
  [/^netherite_|ancient_debris/, '#5a4a4f'],
  [/^diamond/, '#4fd8d0'],
  [/^(golden_|gold_|raw_gold)/, '#f2c43d'],
  [/^(iron_|raw_iron)/, '#c9ccd1'],
  [/^(copper_|raw_copper)/, '#d0794f'],
  [/^(stone_|cobblestone$|stone$)/, '#8d8f93'],
  [/^(wooden_|oak_|bow$|crossbow$|stick$)/, '#a9824f'],
  [/^leather_/, '#8b5a33'],
  [/^chainmail_/, '#9da3ab'],
  [/^(coal|charcoal)/, '#3d3d40'],
  [/^emerald/, '#3fcf6e'],
  [/^(lapis)/, '#3557c9'],
  [/^redstone/, '#d23b2f'],
];

/** A deterministic `#rrggbb` for an item name: the material's colour when it has one, else a hash hue. */
export function itemColour(name: string): string {
  const n = bare(name);
  for (const [re, c] of MATERIAL_COLOURS) if (re.test(n)) return c;
  const h = fnv1a(n);
  return hslHex(h % 360, 45 + ((h >>> 9) % 25), 46 + ((h >>> 17) % 14));
}

/** 2 to 3 letters: one word -> its first two (`Co`), two words -> initial + the second's two (`ISw`), more -> initials (`USB`). */
export function itemAbbr(name: string): string {
  const words = bare(name).split('_').filter(Boolean);
  if (words.length === 0) return '?';
  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
  if (words.length === 1) return cap(words[0]!.slice(0, 2));
  if (words.length === 2) return words[0]!.charAt(0).toUpperCase() + cap(words[1]!.slice(0, 2));
  return words
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}

/** Uses left, maximum and percent for an item with durability (undefined: none). */
export function durabilityOf(item: Pick<ItemStack, 'name' | 'damage'>): PanelItem['dur'] {
  const max = maxDurability(item.name);
  if (max === undefined) return undefined;
  const left = Math.max(0, Math.min(max, max - (item.damage ?? 0)));
  return { left, max, pct: Math.round((left / max) * 100) };
}

/** A shulker box's contents from its raw wire item (NBT `Items`), biggest kinds first. */
export function boxContents(raw: unknown): NonNullable<PanelItem['box']> {
  if (raw === undefined) return { known: false, stacks: 0, items: [], more: 0 };
  const all = Object.entries(shulkerContents(raw)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { known: true, stacks: shulkerSlotsUsed(raw), items: all.slice(0, BOX_KINDS_MAX), more: Math.max(0, all.length - BOX_KINDS_MAX) };
}

/** One slot as the page draws it. */
export function panelItem(s: ItemStack | null | undefined, raw?: () => unknown): PanelItem | null {
  if (!s || s.count <= 0) return null;
  const name = bare(s.name);
  const item: PanelItem = { name, count: s.count, icon: iconClassOf(name, s.blockRuntimeId), colour: itemColour(name), abbr: itemAbbr(name) };
  const dur = durabilityOf(s);
  if (dur) item.dur = dur;
  if (isShulkerBox(name)) item.box = boxContents(raw?.());
  return item;
}

/** The `inventory` block: 36 slots, 4 armour slots, the offhand, the selected slot. */
export function buildInventory(inv: InventorySource): PanelInventory {
  const slots: (PanelItem | null)[] = [];
  for (let i = 0; i < 36; i++) slots.push(panelItem(inv.slots[i], () => inv.rawItem(WINDOW_INVENTORY, i)));
  const armourWin = inv.window(WINDOW_ARMOR)?.slots ?? [];
  const armour: (PanelItem | null)[] = [];
  let armourPoints = 0;
  for (let i = 0; i < 4; i++) {
    const s = armourWin[i];
    armour.push(panelItem(s, () => inv.rawItem(WINDOW_ARMOR, i)));
    if (s) armourPoints += Math.floor(armourScore(s.name) / 10);
  }
  const off = inv.window(WINDOW_OFFHAND)?.slots[0];
  return {
    slots,
    armour,
    offhand: panelItem(off, () => inv.rawItem(WINDOW_OFFHAND, 0)),
    selected: inv.selected,
    armourPoints,
    free: slots.filter((s) => s === null).length,
  };
}
