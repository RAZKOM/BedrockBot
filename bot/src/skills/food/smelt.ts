// Smelting knowledge (Track E2, docs/early-game.md "The iron age"): what a furnace makes of an item, which cooker
// takes it, how much the carried fuel smelts. Pure; the furnace window itself is skills/food/cook.ts (the cooker
// smelts ores the way it cooks food), the planner that asks for it is skills/items/obtain.ts.
//
// Facts used (Bedrock furnace recipes, BDS 1.26.60.6): a furnace smelts every input below in 200 ticks; a smoker
// cooks food only (100 ticks); a blast furnace smelts ores and raw metal only (100 ticks). One raw iron or one iron
// ore (silk-touched) gives one iron ingot; a log gives one charcoal; fuel values are cook.ts's `fuelValue` (coal 8
// items, a plank or a log 1.5).
import type { ItemStack } from '../../world/types.ts';
import { COOKED, fuelValue } from './finder.ts';

/** Non-food furnace recipes the bot uses or may meet (input -> output). Food is finder.ts's COOKED. */
export const SMELTS: Readonly<Record<string, string>> = {
  raw_iron: 'iron_ingot',
  iron_ore: 'iron_ingot',
  deepslate_iron_ore: 'iron_ingot',
  raw_gold: 'gold_ingot',
  gold_ore: 'gold_ingot',
  deepslate_gold_ore: 'gold_ingot',
  nether_gold_ore: 'gold_ingot',
  raw_copper: 'copper_ingot',
  copper_ore: 'copper_ingot',
  deepslate_copper_ore: 'copper_ingot',
  ancient_debris: 'netherite_scrap',
  cobblestone: 'stone',
  cobbled_deepslate: 'deepslate',
  stone: 'smooth_stone',
  sand: 'glass',
  red_sand: 'glass',
  clay_ball: 'brick',
  netherrack: 'netherbrick',
  cactus: 'green_dye',
  wet_sponge: 'sponge',
};

/**
 * Smelted items the obtain job plans for (`!get iron_ingot`): the input is mined (`!mine iron_ore`), then smelted. The
 * inputs, best first: the raw metal a pickaxe drops, then the ore block itself (silk touch).
 */
export const PLANNED_SMELTS: Readonly<Record<string, readonly string[]>> = {
  iron_ingot: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  gold_ingot: ['raw_gold', 'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  copper_ingot: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'],
  glass: ['sand', 'red_sand'],
};

const bare = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n);

/** What a furnace makes of `name` (food included), or undefined. */
export function smeltedOf(name: string): string | undefined {
  const n = bare(name);
  if (SMELTS[n]) return SMELTS[n];
  if (COOKED[n]) return COOKED[n];
  if (/(_log|_wood)$/.test(n) && !/crimson|warped/.test(n)) return 'charcoal';
  return undefined;
}

/** The inputs the obtain job smelts into `output` (best first), or undefined when it is not a planned smelt. */
export function smeltInputsOf(output: string): readonly string[] | undefined {
  return PLANNED_SMELTS[bare(output)];
}

/** A raw metal or an ore block (what a blast furnace takes). */
export function isOreInput(name: string): boolean {
  const n = bare(name);
  return n.startsWith('raw_') || n.endsWith('_ore') || n === 'ancient_debris';
}

/** Does this cooker block take `input`? A furnace takes all; a smoker food only; a blast furnace ores only. */
export function cookerTakes(block: string, input: string): boolean {
  const b = bare(block).replace(/^lit_/, '');
  const food = COOKED[bare(input)] !== undefined;
  if (b === 'smoker') return food;
  if (b === 'blast_furnace') return isOreInput(input);
  if (b === 'furnace') return smeltedOf(input) !== undefined;
  return false;
}

/** Ticks per item: a furnace 200; a smoker and a blast furnace 100. */
export function smeltTicksOf(block: string): number {
  const b = bare(block).replace(/^lit_/, '');
  return b === 'smoker' || b === 'blast_furnace' ? 100 : 200;
}

/** Items of `names` carried (main inventory, 0 to 35). */
export function countOf(slots: readonly (ItemStack | null | undefined)[], names: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    if (s && s.count > 0 && names.includes(s.name)) n += s.count;
  }
  return n;
}

/**
 * The items the carried fuel smelts (coal 8 each, planks and logs 1.5), leaving out what `keep` names and the
 * counts `reserve` holds back (the planks a recipe still needs).
 */
export function fuelItems(slots: readonly (ItemStack | null | undefined)[], keep?: (name: string) => boolean, reserve?: (name: string) => number): number {
  const by = new Map<string, number>();
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    if (!s || s.count <= 0 || fuelValue(s.name) <= 0 || keep?.(s.name)) continue;
    by.set(s.name, (by.get(s.name) ?? 0) + s.count);
  }
  let items = 0;
  for (const [name, c] of by) items += Math.max(0, c - (reserve?.(name) ?? 0)) * fuelValue(name);
  return Math.floor(items);
}

/** The inputs carried that smelt into one of `outputs` (or into anything planned with no `outputs`): name -> count. */
export function smeltableCounts(slots: readonly (ItemStack | null | undefined)[], outputs?: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const want = new Set(outputs ?? Object.keys(PLANNED_SMELTS));
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    if (!s || s.count <= 0) continue;
    const o = SMELTS[bare(s.name)];
    if (!o || !want.has(o) || !Object.values(PLANNED_SMELTS).some((l) => l.includes(bare(s.name)))) continue;
    out.set(s.name, (out.get(s.name) ?? 0) + s.count);
  }
  return out;
}
