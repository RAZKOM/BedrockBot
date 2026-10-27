// Track AG (wave 9, docs/home.md "Categories"): the small catalog the unloader uses to match an item
// with a chest label. A chest labelled `ores` (or `metals`, `minerals`) takes ores, raw metals,
// ingots, gems, coal and redstone; `wood` takes logs, planks, sticks and saplings; `food` takes food;
// `blocks` takes stone-like and building blocks; `junk` takes what the stash step would drop; `tools`
// takes tools, weapons and armour (which the unloader never moves, but `!stock` may name it); anything
// else is `misc`. The categories reuse the stash step's junk list and the survival kit's food and
// durability tables, so the three stay in agreement.
import { foodInfo } from '../survival/eat.ts';
import { armourSlotOf } from '../survival/armour.ts';
import { maxDurability } from '../survival/tools.ts';
import { isStashJunk } from '../container/stash.ts';

export type Category = 'ores' | 'wood' | 'food' | 'blocks' | 'junk' | 'tools' | 'misc';

export const CATEGORIES: readonly Category[] = ['ores', 'wood', 'food', 'blocks', 'junk', 'tools', 'misc'];

/** Label words (lower case, singular and plural) per category. */
const LABEL_WORDS: Record<Category, readonly string[]> = {
  ores: ['ore', 'ores', 'metal', 'metals', 'mineral', 'minerals', 'ingot', 'ingots', 'gem', 'gems', 'coal', 'iron', 'gold', 'diamond', 'diamonds', 'copper', 'redstone', 'lapis', 'emerald', 'emeralds'],
  wood: ['wood', 'woods', 'log', 'logs', 'plank', 'planks', 'timber', 'lumber'],
  food: ['food', 'foods', 'meat', 'crop', 'crops', 'farm'],
  blocks: ['block', 'blocks', 'stone', 'cobble', 'cobblestone', 'building', 'build', 'dirt'],
  junk: ['junk', 'trash', 'misc', 'other', 'drops', 'mob', 'mobs'],
  tools: ['tool', 'tools', 'gear', 'weapon', 'weapons', 'armour', 'armor'],
  misc: [],
};

const ORES = new Set([
  'coal', 'charcoal', 'raw_iron', 'raw_gold', 'raw_copper', 'iron_ingot', 'gold_ingot', 'copper_ingot', 'netherite_ingot', 'netherite_scrap', 'ancient_debris',
  'diamond', 'emerald', 'lapis_lazuli', 'redstone', 'quartz', 'amethyst_shard', 'iron_nugget', 'gold_nugget',
  'coal_block', 'iron_block', 'gold_block', 'copper_block', 'diamond_block', 'emerald_block', 'lapis_block', 'redstone_block', 'raw_iron_block', 'raw_gold_block', 'raw_copper_block',
]);

const BLOCKS = new Set([
  'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'coarse_dirt', 'grass_block', 'sand', 'red_sand', 'gravel', 'clay', 'andesite', 'diorite', 'granite', 'tuff', 'calcite',
  'netherrack', 'blackstone', 'basalt', 'obsidian', 'sandstone', 'red_sandstone', 'bricks', 'stone_bricks', 'mossy_cobblestone', 'smooth_stone', 'glass', 'terracotta', 'mud', 'packed_mud', 'snow_block', 'ice',
]);

const short = (name: string): string => (name.startsWith('minecraft:') ? name.slice(10) : name);
const isRealFood = (n: string): boolean => {
  const f = foodInfo(n);
  return f !== undefined && !f.bad;
};

/** The category of an item. */
export function categoryOf(name: string): Category {
  const n = short(name);
  if (ORES.has(n) || n.endsWith('_ore')) return 'ores';
  if (n.endsWith('_log') || n.endsWith('_wood') || n.endsWith('_planks') || n.endsWith('_stem') || n.endsWith('_hyphae') || n.endsWith('_sapling') || n === 'stick') return 'wood';
  if (maxDurability(n) !== undefined || armourSlotOf(n) !== undefined) return 'tools';
  if (isRealFood(n) || ['wheat', 'wheat_seeds', 'carrot', 'potato', 'beetroot', 'beetroot_seeds', 'sugar_cane', 'egg', 'melon_slice', 'pumpkin'].includes(n)) return 'food';
  if (BLOCKS.has(n) || n.endsWith('_bricks') || n.endsWith('_concrete') || n.endsWith('_terracotta') || n.endsWith('_wool')) return 'blocks';
  if (isStashJunk(n)) return 'junk';
  return 'misc';
}

/** The category a chest label names (its first matching word), or undefined for free text. */
export function labelCategory(label: string | undefined): Category | undefined {
  if (!label) return undefined;
  const words = label.toLowerCase().split(/[^a-z_]+/).filter(Boolean);
  for (const w of words) for (const c of CATEGORIES) if (LABEL_WORDS[c].includes(w)) return c;
  return undefined;
}

/** A chest label matches an item: its category, or the item's own name in the label (`coal`, `oak_log`). */
export function labelMatches(label: string | undefined, name: string): boolean {
  if (!label) return false;
  const n = short(name);
  const l = label.toLowerCase();
  if (l.split(/[^a-z_]+/).includes(n)) return true;
  return labelCategory(label) === categoryOf(n);
}
