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
// Track R2 (decisions/0072-reachability.md "R2"): a goto that digs anyway (`allowBreak`) has a level 1 too when the
// owner's dig price is above DIG_WAY_PRICE (`digPenalty` 500 on the Realm): its level 0 digs at that price, which
// puts any dug way of a few blocks past the search's budget (9 blocks = 4500 ticks, the cost of about 1000 blocks of
// walking: "no progress"); level 1 plans the same moves at DIG_WAY_PRICE, no block budget (the owner allows breaking).
//
// Measured on the owner's cave rebuilt on bds-fly (fly-cave e2e walkA, BDS 1.26.60): a 3-high step the world cache
// reads where a stair or slab stands (cave_8 -> cave_9: the replica's stone cube), a 2-high one (cave_shortcut ->
// cave_end), and a 12-block drop that cost 8 HP (cave_14 -> cave_15) where an 8-block dug way existed.
import type { TerrainClass } from '../terrain/classify.ts';
import { isNaturalTerrain } from '../place/scaffold.ts';
import type { FallPolicy } from '../fall/policy.ts';
import type { PathOptions } from './astar.ts';

/** Blocks the dig way may dig in one goto (all its plans together). */
export const DIG_WAY_MAX_BLOCKS = 12;
/**
 * Track E9 (docs/pathfinding.md "Shut in"; decisions/0111-way-home-and-morning.md): blocks the dig way may dig in one
 * goto whose body is shut in: every level's search ended in an exhaustive `none` that touched no unloaded world (the
 * cells the body can walk, swim or drop to are a closed pocket: the foot of a shaft a mining walk dug down, a pit it
 * fell into), so nothing but digging leaves the place. Enough for a stair from the ore levels to the surface (2
 * blocks a level, 64 levels); the refused walks measured needed 13 to 61. The dig way's other rules hold (natural
 * terrain only, no slow block, nothing in the base, no fall that hurts).
 */
export const DIG_OUT_MAX_BLOCKS = 128;
/** Ticks per block the dig way digs, on top of the break time and the dig penalty (fewer blocks win). */
export const DIG_WAY_PENALTY = 100;
/** A block the best tool takes longer than this to break on the ground is refused (stone by hand 150: allowed; obsidian never). */
export const DIG_WAY_MAX_TICKS = 200;
/** Track R2: the dig penalty level 1 plans an `allowBreak` goto with when the owner's is higher (the setting's default). */
export const DIG_WAY_PRICE = 60;
/** Planner ticks per HP a fall costs at level 2 while the dig way is open (a dug way wins unless it is far slower). */
export const DIG_WAY_HP_COST = 400;

/**
 * Track R3 (docs/pathfinding.md "Long dig ways (Track R3)"): the long dig search, for a goto that digs anyway
 * (`allowBreak`) whose plain search and its BIG_SEARCH retry were cut with no progress: a dug way of tens of blocks (a
 * stair down a ravine's wall and up the other) costs thousands of ticks at any dig price above the break time, and
 * an A* whose heuristic prices a block at a walk's 3.6 ticks has to expand every node cheaper than that first (the
 * whole loaded world and every dig into it: 648 000 nodes at 60 a block, 2 s buys about 130 000). Priced at the
 * physical time of a dig (LONG_DIG_PRICE: the planner's own default, stop, aim, the break cooldown) and the heuristic
 * weighted (LONG_DIG_WEIGHT), the same crossing is found in about 31 000 nodes, 7 blocks more dug (84 against 77).
 */
export const LONG_DIG_WEIGHT = 8;
export const LONG_DIG_PRICE = 12;

/** Track R3: a level's options as the long dig search plans them (the rest, falls and rules included, unchanged). */
export function longDigOptions(o: PathOptions): PathOptions {
  return { ...o, relax: { ...o.relax, weight: Math.max(o.relax?.weight ?? 1, LONG_DIG_WEIGHT) }, costs: { ...o.costs, dig: Math.min(o.costs?.dig ?? LONG_DIG_PRICE, LONG_DIG_PRICE) } };
}

/** The goto's planning level (see above). */
export type DigWayLevel = 0 | 1 | 2;

/** What the planner digs on the dig way: how many blocks this plan may still break. */
export interface DigWay {
  left: number;
}

/**
 * The break times the dig way plans with: natural terrain only, at most DIG_WAY_MAX_TICKS a block. Track R1: a
 * "why unreachable" search (nav/reach.ts) lifts the natural-only rule (`built`) or the slow-block limit (`slow`).
 */
export function digWayBreakTicks(base: (c: TerrainClass) => number, relax?: { built?: boolean; slow?: boolean }): (c: TerrainClass) => number {
  return (c) => {
    if (!relax?.built && !isNaturalTerrain(c.name)) return Infinity;
    const t = base(c);
    return relax?.slow || t <= DIG_WAY_MAX_TICKS ? t : Infinity;
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
