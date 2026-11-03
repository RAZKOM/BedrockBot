// Tool wear (PLAN.md task 7.11, docs/survival.md): `toolOk(item)` is false for a tool, weapon or
// armour piece whose durability left is at most `toolWearLimit` (setting, default 10), so the Digger's
// tool choice and the CombatController's weapon choice skip it while something else exists (both take
// the predicate through their `toolOk` hook; a skipped slot counts as an empty hand). The durability
// used up comes from the item NBT's `Damage` (world model `ItemStack.damage`, verified on BDS
// 1.26.60.6: `extra.nbt.nbt.value.Damage = { type: 'int', value }`); the maximum from the table below
// (Bedrock values, minecraft-data `maxDurability`).
import type { ItemStack } from '../../world/types.ts';

/** Default `toolWearLimit`: a tool with this many uses left or fewer is not chosen. */
export const DEFAULT_TOOL_WEAR_LIMIT = 10;

const TIERS: Readonly<Record<string, number>> = { wooden: 59, stone: 131, iron: 250, golden: 32, diamond: 1561, netherite: 2031 };
const TOOL_KINDS = ['sword', 'pickaxe', 'axe', 'shovel', 'hoe'];
const ARMOUR_MAX: Readonly<Record<string, number>> = {
  leather_helmet: 55,
  leather_chestplate: 80,
  leather_leggings: 75,
  leather_boots: 65,
  chainmail_helmet: 165,
  chainmail_chestplate: 240,
  chainmail_leggings: 225,
  chainmail_boots: 195,
  iron_helmet: 165,
  iron_chestplate: 240,
  iron_leggings: 225,
  iron_boots: 195,
  golden_helmet: 77,
  golden_chestplate: 112,
  golden_leggings: 105,
  golden_boots: 91,
  diamond_helmet: 363,
  diamond_chestplate: 528,
  diamond_leggings: 495,
  diamond_boots: 429,
  netherite_helmet: 407,
  netherite_chestplate: 592,
  netherite_leggings: 555,
  netherite_boots: 481,
  turtle_helmet: 275,
};
const OTHER_MAX: Readonly<Record<string, number>> = {
  shears: 238,
  flint_and_steel: 64,
  bow: 384,
  crossbow: 464,
  fishing_rod: 384,
  trident: 250,
  shield: 336,
  mace: 500,
  elytra: 432,
  carrot_on_a_stick: 25,
  warped_fungus_on_a_stick: 100,
  brush: 64,
};

/** Bedrock maximum durability of an item (undefined: no durability). */
export function maxDurability(name: string): number | undefined {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  const a = ARMOUR_MAX[n] ?? OTHER_MAX[n];
  if (a !== undefined) return a;
  const us = n.lastIndexOf('_');
  if (us < 0) return undefined;
  const tier = TIERS[n.slice(0, us)];
  return tier !== undefined && TOOL_KINDS.includes(n.slice(us + 1)) ? tier : undefined;
}

/** Uses left before the item breaks (undefined: the item has no durability). */
export function durabilityLeft(item: Pick<ItemStack, 'name' | 'damage'>): number | undefined {
  const max = maxDurability(item.name);
  if (max === undefined) return undefined;
  return Math.max(0, max - (item.damage ?? 0));
}

/** Bedrock's enchantment id of Mending (NBT `ench` id 26). */
export const ENCH_MENDING = 26;
/** Default `mendAt`: a Mending item at or under this share of its durability (percent) is set aside to be mended. */
export const DEFAULT_MEND_AT = 10;

/** The item carries Mending (ItemStack.enchants, world/inventory.ts itemEnchants). */
export function hasMending(item: { enchants?: readonly { id: number }[] | undefined }): boolean {
  return (item.enchants ?? []).some((e) => e.id === ENCH_MENDING);
}

/** Uses left at or under which a Mending item is set aside (`pct` of its maximum, rounded up); 0 without durability or pct 0. */
export function mendReserve(name: string, pct: number): number {
  const max = maxDurability(name);
  return max === undefined || pct <= 0 ? 0 : Math.ceil((max * pct) / 100);
}

/**
 * A Mending item set aside to be mended: worn down to the reserve but not yet to the hard limit (`toolWearLimit`): the
 * owner wants such an item kept, not used until it breaks (`!mend` repairs it). undefined: not a Mending item, or fine.
 */
export function setAsideForMending(item: Pick<ItemStack, 'name' | 'damage' | 'enchants'>, limit: number, pct: number): { left: number; reserve: number } | undefined {
  if (!hasMending(item)) return undefined;
  const left = durabilityLeft(item);
  const reserve = mendReserve(item.name, pct);
  return left !== undefined && left <= reserve && left > limit ? { left, reserve } : undefined;
}

/**
 * `toolOk(item)`: false when the item has durability and at most `limit()` uses left (a Mending item: at most its
 * mending reserve, `mendAt()` percent of its maximum, when that is more); true for anything without durability
 * (blocks, food, an empty hand never reach it).
 */
export function makeToolOk(limit: () => number = () => DEFAULT_TOOL_WEAR_LIMIT, mendAt?: () => number): (item: Pick<ItemStack, 'name' | 'damage' | 'enchants'>) => boolean {
  return (item) => {
    const left = durabilityLeft(item);
    if (left === undefined) return true;
    const reserve = mendAt && hasMending(item) ? mendReserve(item.name, mendAt()) : 0;
    return left > Math.max(limit(), reserve);
  };
}
