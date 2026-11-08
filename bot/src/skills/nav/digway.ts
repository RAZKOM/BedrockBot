// Track W3 (docs/pathfinding.md "Water (Track W1)", its W3 part "When the plain walk finds no way";
// decisions/0070-water-travel.md "W3"): what a walk does when the plain search finds no way at all. The owner's
// requirement: a walk through the waypoints they set must get there, and unhurt. A goto plans in levels, each only
// after the one before it found no way (an exhaustive `none`, or a search that went nowhere):
//
//   level 0  the plain walk (no digging unless the goto allows it) with no fall that hurts: the long-fall policy's
//            damage budget is held at 0 (a harmless landing stays allowed). Most gotos end here.
//   level 1  the dig way (navigator `digWay`, the session's setting `digWay`): a step too high for a jump, a shaft or
//            a ledge is cut by digging (the moves that dig, baritone/moves.ts, as with `allowBreak`), natural terrain
//            only (place/scaffold.ts `isNaturalTerrain`: stone, dirt, ores ...; never a player's build), at most
//            DIG_WAY_MAX_BLOCKS blocks a goto, each priced DIG_WAY_PENALTY on top of its break time and the dig
//            penalty; a block the best tool takes longer than DIG_WAY_MAX_TICKS to break is refused. Still no fall
//            that hurts: a drop is dug down instead.
//   level 2  the falls that hurt, as the long-fall policy allows them (decision 0057), the dig way still open (a
//            hurt then priced DIG_WAY_HP_COST a HP). Only when the policy has damage to give.
//
// Measured on the owner's cave rebuilt on bds-fly (fly-cave e2e walkA, BDS 1.26.60): a 3-high step the world cache
// reads where a stair or slab stands (cave_8 -> cave_9: the replica's stone cube), a 2-high one (cave_shortcut ->
// cave_end), and a 12-block drop that cost 8 HP (cave_14 -> cave_15) where an 8-block dug way existed.
import type { TerrainClass } from '../terrain/classify.ts';
import { isNaturalTerrain } from '../place/scaffold.ts';
import type { FallPolicy } from '../fall/policy.ts';

/** Blocks the dig way may dig in one goto (all its plans together). */
export const DIG_WAY_MAX_BLOCKS = 12;
/** Ticks per block the dig way digs, on top of the break time and the dig penalty (fewer blocks win). */
export const DIG_WAY_PENALTY = 100;
/** A block the best tool takes longer than this to break on the ground is refused (stone by hand 150: allowed; obsidian never). */
export const DIG_WAY_MAX_TICKS = 200;
/** Planner ticks per HP a fall costs at level 2 while the dig way is open (a dug way wins unless it is far slower). */
export const DIG_WAY_HP_COST = 400;

/** The goto's planning level (see above). */
export type DigWayLevel = 0 | 1 | 2;

/** What the planner digs on the dig way: how many blocks this plan may still break. */
export interface DigWay {
  left: number;
}

/** The break times the dig way plans with: natural terrain only, at most DIG_WAY_MAX_TICKS a block. */
export function digWayBreakTicks(base: (c: TerrainClass) => number): (c: TerrainClass) => number {
  return (c) => {
    if (!isNaturalTerrain(c.name)) return Infinity;
    const t = base(c);
    return t <= DIG_WAY_MAX_TICKS ? t : Infinity;
  };
}

/** Levels 0 and 1: harmless landings only (no damage budget, so no clutch either). */
export function harmlessFalls(p: FallPolicy): FallPolicy {
  return { ...p, hpBudget: Math.min(0, p.hpBudget), clutch: false };
}

/** Level 2: the full budget; a hurt priced DIG_WAY_HP_COST a HP while the dig way is open. */
export function lastResortFalls(p: FallPolicy, digging: boolean): FallPolicy {
  return digging ? { ...p, hpCost: Math.max(p.hpCost, DIG_WAY_HP_COST) } : p;
}

/** The policy has damage (or a clutch) to give: level 2 can do what the levels before could not. */
export function fallsHurt(p: FallPolicy | undefined): boolean {
  return !!p && !p.blocked && (p.hpBudget > 0 || p.clutch);
}
