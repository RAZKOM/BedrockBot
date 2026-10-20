// Break-time table (PLAN.md task 4.1). Pure functions over bot/src/data/mining.ts.
//
//   damage per tick = speed / hardness / (canHarvest ? 30 : 100)
//   ticks           = ceil(1 / damage)            (0 when hardness is 0: instant)
//
// speed = 1 by hand or with a tool that is not effective on the block; the tier multiplier
// (TIER_SPEED) when it is effective; then the documented modifiers below. Measured on BDS 1.26.51:
// the server finishes the break exactly on this tick count (docs/digging.md).
import { TIER_LEVEL, TIER_SPEED, blockMining, toolOf, type BlockMining, type Tool } from '../../data/mining.ts';

/**
 * Speed modifiers (Minecraft Wiki "Breaking", Bedrock). Not applied by `dig()` yet: the bot never has
 * effects, never mines under water or in the air, and has no enchanted tools.
 * TODO(phase 5): read effects from `mob_effect`, water from the world model, onGround from the input loop.
 */
export const MODIFIERS = Object.freeze({
  /** Efficiency N adds N^2 + 1 to an effective tool's speed. */
  efficiencyBonus: (level: number) => (level > 0 ? level * level + 1 : 0),
  /** Haste N multiplies speed by 1 + 0.2 N (Java form; Bedrock also scales damage by 1.2^N and its speed formula changes in 26.70: TODO measure). */
  haste: (level: number) => 1 + 0.2 * level,
  /** Mining Fatigue N multiplies speed by 0.3^min(N, 4) (Java form; Bedrock: speed 0.3^N and damage 0.7^N: TODO measure). */
  miningFatigue: (level: number) => 0.3 ** Math.min(level, 4),
  /** Head in water without Aqua Affinity: speed / 5. */
  inWater: 1 / 5,
  /** Not on the ground (jumping, flying, falling): speed / 5. */
  offGround: 1 / 5,
});

export interface BreakConditions {
  efficiency?: number;
  haste?: number;
  miningFatigue?: number;
  inWater?: boolean;
  offGround?: boolean;
}

export interface BreakEstimate {
  /** Ticks from start_break to the break; 0 = instant; Infinity = unbreakable. */
  ticks: number;
  /** The tool multiplier used (1 = hand speed). */
  speed: number;
  /** The tool is effective on the block. */
  effective: boolean;
  /** The block drops its item with this tool. */
  canHarvest: boolean;
}

/** Sword speeds that are not the tier multiplier (Bedrock): cobweb 15, anything else 1.5. TODO: bamboo (instant). */
function swordSpeed(block: BlockMining): number {
  return block.name === 'web' ? 15 : 1.5;
}

export function isEffective(block: BlockMining, tool: Tool | null): boolean {
  return tool !== null && block.effective.includes(tool.type);
}

export function canHarvest(block: BlockMining, tool: Tool | null): boolean {
  const h = block.harvest;
  if (!h) return true;
  if (!tool || !h.types.includes(tool.type)) return false;
  if (h.minTier === undefined || tool.tier === undefined) return true;
  return TIER_LEVEL[tool.tier] >= TIER_LEVEL[h.minTier];
}

/** Break estimate for a block's mining data and a tool (null = hand or a non-tool item). */
export function estimateBreak(block: BlockMining, tool: Tool | null, cond: BreakConditions = {}): BreakEstimate {
  const effective = isEffective(block, tool);
  const harvest = canHarvest(block, tool);
  let speed = 1;
  if (effective && tool) {
    if (tool.type === 'sword') speed = swordSpeed(block);
    else if (tool.type === 'shears') speed = block.material === 'wool' ? 5 : 15; // web, leaves (wiki values; not measured yet)
    else if (tool.tier) speed = TIER_SPEED[tool.tier];
    speed += MODIFIERS.efficiencyBonus(cond.efficiency ?? 0);
  } else if (tool?.type === 'sword') {
    speed = swordSpeed(block);
  }
  if (cond.haste) speed *= MODIFIERS.haste(cond.haste);
  if (cond.miningFatigue) speed *= MODIFIERS.miningFatigue(cond.miningFatigue);
  if (cond.inWater) speed *= MODIFIERS.inWater;
  if (cond.offGround) speed *= MODIFIERS.offGround;
  if (block.hardness < 0) return { ticks: Infinity, speed, effective, canHarvest: harvest };
  if (block.hardness === 0) return { ticks: 0, speed, effective, canHarvest: harvest };
  const divisor = harvest ? 30 : 100;
  // ticks = ceil(1 / (speed / hardness / divisor)) = ceil(hardness * divisor / speed); the epsilon
  // keeps exact products such as 0.6 * 30 = 18.000000000000004 from rounding up.
  const ticks = Math.max(1, Math.ceil((block.hardness * divisor) / speed - 1e-9));
  return { ticks, speed, effective, canHarvest: harvest };
}

/** Convenience: ticks to break `blockName` with `itemName` (null = empty hand); undefined if the block is unknown. */
export function breakTicks(blockName: string, itemName: string | null, cond?: BreakConditions): number | undefined {
  const b = blockMining(blockName);
  return b ? estimateBreak(b, toolOf(itemName), cond).ticks : undefined;
}
