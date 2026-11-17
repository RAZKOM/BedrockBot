// Mining data (PLAN.md task 4.1): block hardness, effective tool and harvest tier from minecraft-data,
// plus tool tiers parsed from item names. See docs/digging.md for sources and how the values were
// checked against BDS.
//
// The tables are the bot's one block data key (data/blockData.ts: bedrock_1.26.60, minecraft-data 3.119.0's
// regenerated 1.26.60 data since decision 0094). test/unit/world/data-pin.test.ts fails on a bump that changes them.
import { blockData, hardnessOf } from './blockData.ts';

export type ToolType = 'axe' | 'pickaxe' | 'shovel' | 'hoe' | 'sword' | 'shears';
export type ToolTier = 'wooden' | 'golden' | 'stone' | 'copper' | 'iron' | 'diamond' | 'netherite';

/**
 * Tool speed multiplier by tier when the tool is effective on the block (Minecraft Wiki "Breaking",
 * Bedrock values, checked 2026-10-28; copper tools from Bedrock 1.21.110).
 */
export const TIER_SPEED: Readonly<Record<ToolTier, number>> = Object.freeze({
  wooden: 2,
  stone: 4,
  copper: 5,
  iron: 6,
  diamond: 8,
  netherite: 9,
  golden: 12,
});

/** Harvest level: a block that needs tier X drops only with a tool of level >= X's level. */
export const TIER_LEVEL: Readonly<Record<ToolTier, number>> = Object.freeze({
  wooden: 0,
  golden: 0,
  stone: 1,
  copper: 1,
  iron: 2,
  diamond: 3,
  netherite: 4,
});

export interface Tool {
  type: ToolType;
  /** undefined for shears (no tier). */
  tier: ToolTier | undefined;
}

const TOOL_TYPES: readonly ToolType[] = ['pickaxe', 'shovel', 'axe', 'hoe', 'sword'];
const TIERS: readonly ToolTier[] = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'];

/** Tool type and tier of an item name (`stone_axe`, `minecraft:diamond_pickaxe`, `shears`); null for anything else. */
export function toolOf(itemName: string | null | undefined): Tool | null {
  if (!itemName) return null;
  const name = itemName.startsWith('minecraft:') ? itemName.slice(10) : itemName;
  if (name === 'shears') return { type: 'shears', tier: undefined };
  const sep = name.indexOf('_');
  if (sep < 0) return null;
  const tier = name.slice(0, sep) as ToolTier;
  const type = name.slice(sep + 1) as ToolType;
  if (!TIERS.includes(tier) || !TOOL_TYPES.includes(type)) return null;
  return { type, tier };
}

export interface BlockMining {
  name: string;
  /** -1 = unbreakable (bedrock, barrier); 0 = breaks instantly. */
  hardness: number;
  /** Tool types that mine this block faster (from the minecraft-data `material`, e.g. 'mineable/axe'). */
  effective: readonly ToolType[];
  /**
   * The block drops only when mined with one of these tool types at `minTier` or above; without
   * it the break is also slower (damage / 100 instead of / 30). undefined = drops by hand.
   */
  harvest: { types: readonly ToolType[]; minTier: ToolTier | undefined } | undefined;
  /** minecraft-data material string, kept for diagnostics. */
  material: string | undefined;
}

interface MdBlock {
  name: string;
  hardness: number | null;
  material?: string;
  harvestTools?: Record<string, boolean>;
}

/**
 * minecraft-data's bedrock `harvestTools` keys are item ids. In minecraft-data 3.119.0's regenerated data they
 * are the ids of the same version's items.json (iron_pickaxe 299, shears 424), so they are read by item name
 * (`toolOf`). (The 1.26.30 data of 3.118.0 and earlier used Java-style ids of an older table, groups of five
 * per tier from 939, which no table the bot loads has any more.) Checked against the blocks whose
 * requirements are well known (stone: any pickaxe; iron_ore: stone+; gold_ore and diamond_ore: iron+;
 * obsidian: diamond+; snow: any shovel; web: sword or shears) in the unit tests.
 */
function decodeHarvestId(id: number, items: Record<number, { name: string } | undefined>): Tool | undefined {
  return toolOf(items[id]?.name) ?? undefined;
}

function effectiveFromMaterial(material: string | undefined, name: string): ToolType[] {
  const out: ToolType[] = [];
  for (const part of (material ?? '').split(';')) {
    const m = /^mineable\/(\w+)$/.exec(part);
    if (m && TOOL_TYPES.includes(m[1] as ToolType)) out.push(m[1] as ToolType);
  }
  // 'incorrect_for_wooden_tool' = pickaxe blocks that need stone or better (iron_ore, ...).
  if (material === 'incorrect_for_wooden_tool' && !out.includes('pickaxe')) out.push('pickaxe');
  if (material === 'coweb' || name === 'web') out.push('sword', 'shears');
  if (material?.includes('leaves') && !out.includes('shears')) out.push('shears');
  if (material === 'wool') out.push('shears');
  return out;
}

function harvestFrom(md: MdBlock, items: Record<number, { name: string } | undefined>): BlockMining['harvest'] {
  if (!md.harvestTools) return undefined;
  const tools = Object.keys(md.harvestTools)
    .map((id) => decodeHarvestId(Number(id), items))
    .filter((t): t is Tool => t !== undefined);
  if (tools.length === 0) return undefined;
  const types = [...new Set(tools.map((t) => t.type))];
  let minTier: ToolTier | undefined;
  for (const t of tools) {
    if (t.tier === undefined) continue;
    if (minTier === undefined || TIER_LEVEL[t.tier] < TIER_LEVEL[minTier]) minTier = t.tier;
  }
  return { types, minTier };
}

let cache: Map<string, BlockMining> | undefined;

function table(): Map<string, BlockMining> {
  if (cache) return cache;
  const data = blockData<{ blocksArray: MdBlock[]; items: Record<number, { name: string } | undefined> }>();
  cache = new Map();
  for (const b of data.blocksArray) {
    cache.set(b.name, {
      name: b.name,
      hardness: hardnessOf(b.name, b.hardness),
      effective: effectiveFromMaterial(b.material, b.name),
      harvest: harvestFrom(b, data.items),
      material: b.material,
    });
  }
  return cache;
}

/** Mining data for a block name (with or without `minecraft:`); undefined if minecraft-data does not know it. */
export function blockMining(name: string): BlockMining | undefined {
  return table().get(name.startsWith('minecraft:') ? name.slice(10) : name);
}
