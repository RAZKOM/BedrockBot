/*
 * Ported from Baritone (src/main/java/baritone/pathing/movement/MovementHelper.java@23723891,
 * src/main/java/baritone/pathing/precompute/Ternary.java@23723891,
 * src/main/java/baritone/utils/ToolSet.java@23723891), LGPL-3.0.
 *
 * This file is part of Baritone.
 *
 * Baritone is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Baritone is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Baritone.  If not, see <https://www.gnu.org/licenses/>.
 * The licence text is in ./LICENSE; the port is listed in THIRD_PARTY_NOTICES.md at the repo root.
 */
// Track BB (wave 11, docs/pathfinding.md "Rules"): the one rule set for "can the body stand here, walk
// through this, break this, place here, and what does breaking cost", Baritone's MovementHelper over our
// TerrainClass (skills/terrain/classify.ts: block shapes from the registry data) and the block registry's
// hardness / tool table (skills/dig). The planner's grid (nav/grid.ts), the planner worker's mirror
// (the same NavGrid over worker-grid.ts), the follower's break actions (nav/actions.ts `breakBlocker`),
// the miner's tunnel cell checks (mine/tunnel.ts, mine/wire.ts) and the Digger's break-time lookup
// (dig/digger.ts) all call these functions, so a rule changes in one place. Everything here is pure; the
// rule functions the planner calls per cell allocate nothing (`ruleCell` and `cellReaderOf`, off the hot
// path, return a small object); a `CellReader` (NavGrid, or `cellReaderOf(source)` over a TerrainSource)
// answers the neighbour lookups. Where Baritone and our measured BDS rules disagree the safer rule is kept and the
// difference is written in the rule table (docs/pathfinding.md "Rules"); the owner's rules (digPenalty,
// protectRadius, built blocks, the break rules by name, the shaft rules) stay as they were.
import { blockMining } from '../../../data/mining.ts';
import type { Vec3 } from '../../../world/types.ts';
import { estimateBreak, type BreakConditions } from '../../dig/breakTime.ts';
import { chooseTool, type SlotItem, type ToolChoice } from '../../dig/tools.ts';
import type { TerrainClass } from '../../terrain/classify.ts';
import { CLIMBERS, classAt, type TerrainSource } from '../../terrain/query.ts';

/** Baritone's `Ternary` (pathing/precompute/Ternary.java): a rule that needs the neighbours answers MAYBE. */
export const NO = 0;
export const YES = 1;
export const MAYBE = 2;
export type Ternary = typeof NO | typeof YES | typeof MAYBE;

/** What the rules read: the classified block of a cell, undefined when it is not loaded (NavGrid.cls). */
export interface CellReader {
  cls(x: number, y: number, z: number): TerrainClass | undefined;
}

/** A CellReader over a TerrainSource (the worker mirror's source, a generated test world). No cache: use a NavGrid for the planner. */
export function cellReaderOf(source: TerrainSource): CellReader {
  return { cls: (x, y, z) => classAt(source, x, y, z) };
}

/** The slots the break-time lookup reads (World's Inventory satisfies it; the worker gets a copy). */
export interface HotbarView {
  slots: readonly (SlotItem | null | undefined)[];
  selected: number;
}

// ---- settings (Baritone's Settings.java defaults, fixed here; decision 0043) ------------------------

/**
 * Baritone `allowWalkOnMagmaBlocks` (default false): magma is never a floor and never walked into. Our
 * follower has no sneak-over-magma input and the body would take damage, so the planner walks around it.
 */
export const WALK_ON_MAGMA = false;
/** Baritone `allowWalkOnBottomSlab` (default true): a bottom slab is a floor (measured, decision 0022). */
export const WALK_ON_BOTTOM_SLAB = true;
/** Baritone `assumeWalkOnWater` (default false): water is never a floor; our swim moves enter it on the surface. */
export const ASSUME_WALK_ON_WATER = false;

const SIDES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Liquid level of a liquid block: 0 = a source (Baritone `getAmount == 8`), else falling / flowing. */
export function liquidDepth(c: TerrainClass): number {
  return Number(c.states.liquid_depth ?? 0);
}

// ---- walking through -------------------------------------------------------------------------------

/**
 * Baritone `canWalkThroughBlockState`: may the body occupy this cell? YES for anything without a
 * collision box (air, plants, signs, torches, an open gate, snow layer `height` 0) and for a ladder's
 * thin box (Track AJ: the body climbs in it); NO for lava, flowing or falling water, bubble columns,
 * every hazard (`TerrainClass.danger`: fire, cobweb, sweet berry bush, powder snow, pointed dripstone,
 * end portal, cactus, magma, wither rose ...), scaffolding (its rules are not modelled) and any other
 * collision box (full blocks, slabs, carpets, closed doors and gates, fences, unknown blocks); MAYBE for a
 * still water source (Baritone walks through it when nothing flows and no liquid is above: `canWalkThrough`
 * below; our planner only enters water with the swim moves, NavGrid.swim).
 */
export function canWalkThroughClass(c: TerrainClass): Ternary {
  if (c.liquid) {
    if (c.liquid === 'lava' || c.name === 'bubble_column') return NO;
    return liquidDepth(c) === 0 ? MAYBE : NO;
  }
  if (c.danger) return NO;
  if (c.name === 'scaffolding') return NO; // Track AJ: stood on unless sneaking, climbed by jump / sneak: not modelled
  if (c.boxes.length === 0) return YES;
  if (isClimbable(c)) return YES; // a ladder's thin box is no obstacle (Track AJ)
  return NO;
}

/** Baritone `isFlowing`: the liquid at (x, y, z) is not a source, or a side neighbour holds a non-source liquid. */
export function isFlowing(r: CellReader, x: number, y: number, z: number, c: TerrainClass | undefined = r.cls(x, y, z)): boolean {
  if (!c?.liquid) return false;
  if (liquidDepth(c) !== 0) return true;
  for (const [dx, dz] of SIDES) {
    const n = r.cls(x + dx, y, z + dz);
    if (n?.liquid && liquidDepth(n) !== 0) return true;
  }
  return false;
}

/** The water the swim moves accept (NavGrid.swim): a source (or a waterlogged plant without depth), not a bubble column. */
export function isStillWater(c: TerrainClass): boolean {
  return c.liquid === 'water' && c.name !== 'bubble_column' && liquidDepth(c) === 0;
}

/**
 * Baritone `canWalkThrough(bsi, x, y, z)`: the class rule, and for a still water source the position
 * rule (`canWalkThroughPosition`): nothing flows, no liquid above, water. undefined = a cell is not loaded.
 */
export function canWalkThrough(r: CellReader, x: number, y: number, z: number, c: TerrainClass | undefined = r.cls(x, y, z)): boolean | undefined {
  if (!c) return undefined;
  const t = canWalkThroughClass(c);
  if (t === YES) return true;
  if (t === NO) return false;
  if (isFlowing(r, x, y, z, c)) return false;
  if (ASSUME_WALK_ON_WATER) return false;
  const up = r.cls(x, y + 1, z);
  if (!up) return undefined;
  if (up.liquid || up.name === 'waterlily') return false;
  return c.liquid === 'water';
}

// ---- standing ----------------------------------------------------------------------------------------

/**
 * Baritone `canWalkOnBlockState` over our shapes: a floor is a box top that covers the cell's centre and
 * is at most 1 high (`TerrainClass.floorShape`: full blocks, glass, ice, leaves, soul sand, farmland, dirt
 * paths, mud, honey, chests, slabs top and bottom, stairs, snow layers from 2 layers, carpets; never fences,
 * walls, closed gates and unknown blocks at 1.5), minus the exceptions: magma unless `allowMagma`, every
 * hazard, bubble columns and water (ours: the swim moves), lava, scaffolding and climbers (ours: climb
 * nodes). Baritone also refuses honey; ours keeps it a floor with the slow penalty (x5), because a bot
 * standing on a honey floor would otherwise have no start node (docs/pathfinding.md "Known gaps").
 * `canWalkOn(c)` is what `TerrainClass.floor` holds for the default settings.
 */
export function canWalkOn(c: TerrainClass, opts?: { allowMagma?: boolean }): boolean {
  if (c.floor) return true;
  return (opts?.allowMagma ?? WALK_ON_MAGMA) && c.name === 'magma' && c.floorShape;
}

/** The floor of a node standing in the cell above: a floor whose top is exactly 1 (NavGrid.stand's "block below" rule). */
export function fullFloor(c: TerrainClass, opts?: { allowMagma?: boolean }): boolean {
  return c.top === 1 && canWalkOn(c, opts);
}

/**
 * Baritone `avoidWalkingInto`: a cell the body must never move into: any liquid (water: only the swim
 * moves, lava never), magma unless `allowMagma`, and every hazard (cactus, sweet berry bush, fire, end
 * portal, cobweb, bubble column, powder snow, wither rose, pointed dripstone, lit campfires ...).
 */
export function avoidWalkingInto(c: TerrainClass, opts?: { allowMagma?: boolean }): boolean {
  if (c.liquid) return true;
  if (!c.danger) return false;
  return !((opts?.allowMagma ?? WALK_ON_MAGMA) && c.name === 'magma');
}

/**
 * Baritone `mustBeSolidToWalkOn`: a move that stands on this block finds a top to stand on. False for
 * climbers (the body hangs in them). Baritone's waterlogged partial blocks need layer 1, which the world
 * model does not read (docs/world-model.md "Known gaps"): a waterlogged slab answers like a dry one.
 */
export function mustBeSolidToWalkOn(c: TerrainClass): boolean {
  return !isClimbable(c);
}

/** Baritone `isClimbable`: the body climbs in it (ladder, vines; our CLIMBERS, measured on BDS 1.26.60: terrain/query.ts). */
export function isClimbable(c: TerrainClass): boolean {
  return c.climbable && CLIMBERS.has(c.name);
}

/** Baritone `isBottomSlab`: a slab (not a double slab) whose top is at 0.5 (MovementAscend never jumps from one onto a full block). */
export function isBottomSlab(c: TerrainClass): boolean {
  return isSlab(c) && Math.abs(c.top - 0.5) < 1e-9;
}

/** A single slab block (bottom or top half); double slabs are full cubes. */
export function isSlab(c: TerrainClass): boolean {
  return c.name.endsWith('_slab') && !c.name.endsWith('_double_slab');
}

export function isStairs(c: TerrainClass): boolean {
  return c.name.endsWith('_stairs');
}

// ---- placing ------------------------------------------------------------------------------------------

/** Bedrock blocks a placed block replaces (Java `canBeReplaced`): plants without a box, fire, liquids, structure void, light. */
const REPLACEABLE = new Set([
  'air',
  'fire',
  'soul_fire',
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'deadbush',
  'seagrass',
  'structure_void',
  'vine',
  'hanging_roots',
  'nether_sprouts',
  'crimson_roots',
  'warped_roots',
  'glow_lichen',
  'sculk_vein',
  'bubble_column',
]);

/**
 * Baritone `isReplaceable` (MovementTraverse / MovementAscend: may a throwaway block be placed into this
 * cell): air, liquids, a one-layer snow layer (`height` 0), grass / ferns and the other replaceable plants.
 */
export function isReplaceable(c: TerrainClass): boolean {
  if (c.boxes.length > 0) return false;
  if (c.liquid) return true;
  if (c.name === 'snow_layer') return Number(c.states.height ?? 0) === 0;
  return REPLACEABLE.has(c.name) || c.name.startsWith('light_block');
}

/** Baritone `isBlockNormalCube` exceptions: full shapes a block cannot be placed against (or stood on as a normal cube). */
const NOT_NORMAL_CUBE = new Set(['bamboo', 'moving_block', 'scaffolding', 'pointed_dripstone', 'amethyst_cluster']);

/** Baritone `isBlockNormalCube`: a full 1 x 1 x 1 collision box of a known block, minus its exceptions (shulker boxes, bamboo, scaffolding, dripstone, amethyst). */
export function isNormalCube(c: TerrainClass): boolean {
  return c.fullCube && !c.unknown && !c.liquid && !NOT_NORMAL_CUBE.has(c.name) && !c.name.endsWith('shulker_box');
}

/** Baritone `canPlaceAgainst`: the centre of a side face takes a click (a normal cube or glass); not carpets, slabs, fences, unknown blocks. */
export function canPlaceAgainst(c: TerrainClass): boolean {
  return isNormalCube(c) || c.name === 'glass' || c.name === 'tinted_glass' || c.name.endsWith('_stained_glass');
}

// ---- breaking -----------------------------------------------------------------------------------------

/** Why a block may not be broken (nav/actions.ts `breakBlocker` returns these). */
export type BreakReason =
  /** the cell or a neighbour is not loaded */
  | 'unknown'
  /** nothing to break (also hazards without a box: fire, a berry bush) */
  | 'air'
  | 'liquid'
  /** an unresolved runtime id: never dug (decision 0009) */
  | 'unknown_block'
  /** bedrock, barriers, portals: the registry's hardness -1 */
  | 'unbreakable'
  /** containers, beds, spawners, built blocks (`isBuiltBlock`), `protectedBlocks` */
  | 'protected'
  /** doors, gates, trapdoors are used, not dug */
  | 'openable'
  /** inside `protectedArea` (the base around home, `protectRadius`) */
  | 'protected_area'
  /** the floor under the feet (`feetFloors`) */
  | 'under_feet'
  /** Baritone: ice becomes water when broken (Bedrock too, over a solid block); frosted ice melts */
  | 'ice'
  /** Baritone: infested blocks spawn a silverfish */
  | 'infested'
  /** water or lava in one of the 6 neighbours (ours: stricter than Baritone's side rule) */
  | 'next_to_liquid'
  /** a gravity block right above (ours: refused; Baritone adds its break time, `includeFalling`) */
  | 'gravity_above'
  /** Baritone `avoidUpdatingFallingBlocks`: an unsupported gravity block beside the cell would fall */
  | 'gravity_beside';

/** The rule set's parameters (nav/actions.ts `BreakRules` is this type). */
export interface BreakRuleOptions {
  /** Block names never broken (on top of containers, beds and the like, which never are). */
  protectedBlocks?: ReadonlySet<string> | readonly string[];
  /** Nothing is broken within `r` blocks (3D, block centres) of this point: the base around home (`protectRadius`). */
  protectedArea?: { x: number; y: number; z: number; r: number };
  /**
   * Baritone's way with a gravity block above the cell: allowed, the stacked falling blocks are broken too
   * and `getMiningDurationTicks(..., includeFalling)` counts their break times. Default false: the owner's
   * rule, nothing with a gravity block above it is dug (the planner walks around).
   */
  allowGravityAbove?: boolean;
}

const NO_RULES: BreakRuleOptions = {};
const NO_FLOORS: readonly Vec3[] = [];

/** Baritone `avoidBreaking`: ice and frosted ice become water when broken. */
export function isIce(c: TerrainClass): boolean {
  return c.name === 'ice' || c.name === 'frosted_ice';
}

/** Baritone `avoidBreaking`: an infested block (`infested_*`, the old `monster_egg`) spawns a silverfish. */
export function isInfested(c: TerrainClass): boolean {
  return c.name.startsWith('infested_') || c.name === 'monster_egg';
}

/** The registry says the block cannot be broken (hardness -1: bedrock, barrier, end portal frame ...). */
export function isUnbreakable(c: TerrainClass): boolean {
  const m = blockMining(c.name);
  return m !== undefined && m.hardness < 0;
}

/**
 * Baritone `avoidBreaking` + `avoidAdjacentBreaking` with our additions: why the block in cell (x, y, z)
 * may not be broken, or undefined when it may. In order: not loaded; nothing there (`air`: no box and no
 * liquid, hazards without a box included); a liquid; an unknown runtime id; unbreakable; protected
 * (containers, beds, spawners, built blocks, `protectedBlocks`); a door / gate / trapdoor; inside the
 * protected area; the floor under the feet (`feetFloors`); ice (becomes water); infested; a liquid in any
 * of the 6 neighbours (Baritone: above and the sides, sources only; ours is stricter: a flow would reach the
 * body); a gravity block right above (Baritone pays its break time instead: `allowGravityAbove`); an
 * unsupported gravity block beside (Baritone `avoidUpdatingFallingBlocks`).
 */
export function avoidBreaking(r: CellReader, x: number, y: number, z: number, rules: BreakRuleOptions = NO_RULES, feetFloors: readonly Vec3[] = NO_FLOORS): BreakReason | undefined {
  const c = r.cls(x, y, z);
  if (!c) return 'unknown';
  if (c.boxes.length === 0 && !c.liquid) return 'air';
  if (c.liquid) return 'liquid';
  if (c.unknown) return 'unknown_block';
  if (isUnbreakable(c)) return 'unbreakable';
  if (c.protect) return 'protected';
  if (c.openable) return 'openable';
  const prot = rules.protectedBlocks;
  if (prot && (Array.isArray(prot) ? (prot as readonly string[]).includes(c.name) : (prot as ReadonlySet<string>).has(c.name))) return 'protected';
  const area = rules.protectedArea;
  if (area && Math.hypot(x + 0.5 - area.x, y + 0.5 - area.y, z + 0.5 - area.z) <= area.r) return 'protected_area';
  for (const f of feetFloors) if (f.x === x && f.y === y && f.z === z) return 'under_feet';
  if (isIce(c)) return 'ice';
  if (isInfested(c)) return 'infested';
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const n = r.cls(x + dx, y + dy, z + dz);
    if (!n) return 'unknown';
    if (n.liquid) return 'next_to_liquid';
  }
  const above = r.cls(x, y + 1, z);
  if (above?.gravity && !rules.allowGravityAbove) return 'gravity_above';
  for (const [dx, dz] of SIDES) {
    const n = r.cls(x + dx, y, z + dz);
    if (!n?.gravity) continue;
    const under = r.cls(x + dx, y - 1, z + dz);
    if (!under) return 'unknown';
    // FallingBlock.isFree: air, a liquid or fire below it (no box): the block is unsupported
    if (under.boxes.length === 0) return 'gravity_beside';
  }
  return undefined;
}

/**
 * Baritone `ToolSet.getBestDestructionTime`: ticks to break a block with the best hotbar tool (dig/tools.ts
 * `chooseTool`: our measured BDS break-time table), the empty hand without an inventory; Infinity when the
 * registry does not know the block or nothing breaks it.
 */
export function breakTicksWith(block: TerrainClass | string, inv: HotbarView | undefined, cond?: BreakConditions): number {
  const name = typeof block === 'string' ? block : block.name;
  if (inv) return chooseTool(name, inv.slots, inv.selected, cond)?.ticks ?? Infinity;
  const m = blockMining(name);
  return m ? estimateBreak(m, null, cond).ticks : Infinity;
}

/**
 * Baritone `ToolSet.getBestSlot` for the Digger: the hotbar slot that breaks `block` fastest (dig/tools.ts
 * rules: fewest ticks, then one that harvests, then no tool worn, then the selected slot). `toolOk` drops
 * worn tools (Track S: they count as an empty hand). undefined when the registry does not know the block.
 */
export function bestTool<T extends SlotItem>(block: string, slots: readonly (T | null | undefined)[], selected: number, cond?: BreakConditions, toolOk?: (item: T) => boolean): ToolChoice | undefined {
  return chooseTool(block, toolOk ? slots.map((s) => (s && !toolOk(s) ? null : s)) : slots, selected, cond);
}

/** What `getMiningDurationTicks` needs (Baritone's CalculationContext: tool set, break rules, the additional cost). */
export interface MiningContext {
  /** Ticks to break a block with the best tool at hand (`breakTicksWith`), Infinity when it cannot be broken. */
  breakTicks: (c: TerrainClass) => number;
  /** Ticks per broken block on top of the break time: `PathCosts.dig` (the owner's `digPenalty`, Baritone `blockBreakAdditionalPenalty`). */
  dig: number;
  rules?: BreakRuleOptions;
  /** The floors the move stands on (never dug). */
  feetFloors?: readonly Vec3[];
  /** Cells a dig already failed on (the blacklist): never again in this goto. */
  noBreak?: (x: number, y: number, z: number) => boolean;
}

/**
 * Baritone `getMiningDurationTicks`: the ticks a move pays for cell (x, y, z): 0 when the body walks through
 * it as it is, Infinity when it may not be broken (`avoidBreaking`, a liquid, nothing breaks it), else the
 * break time with the best tool plus `dig`. With `includeFalling` (Baritone: the top cell of a dig only) a
 * gravity block above is counted too, recursively: it falls into the gap and is broken again (reachable only
 * with `rules.allowGravityAbove`; under the owner's rule the cell is refused instead). nav/astar.ts
 * `digThrough` composes the same three parts inline (`breakBlocker`, `breakTicks`, `costs.dig`) with the
 * same free rule; a unit test keeps them equal (fire and ladder cells included).
 */
export function getMiningDurationTicks(r: CellReader, x: number, y: number, z: number, ctx: MiningContext, includeFalling: boolean): number {
  const c = r.cls(x, y, z);
  if (!c) return Infinity;
  // nav/astar.ts digThrough's "free" rule: no box, no liquid, no hazard costs nothing; a hazard without a box
  // (fire, a berry bush, a wither rose) is neither walked into nor dug; a ladder's box is a built block (protected)
  if (c.boxes.length === 0 && !c.liquid) return avoidWalkingInto(c) ? Infinity : 0;
  if (c.liquid) return Infinity;
  if (ctx.noBreak?.(x, y, z)) return Infinity;
  const why = avoidBreaking(r, x, y, z, ctx.rules, ctx.feetFloors);
  if (why) return Infinity;
  const t = ctx.breakTicks(c);
  if (!Number.isFinite(t)) return Infinity;
  let result = t + ctx.dig;
  if (includeFalling) {
    const above = r.cls(x, y + 1, z);
    if (above?.gravity) result += getMiningDurationTicks(r, x, y + 1, z, ctx, true);
  }
  return result;
}

// ---- the miner's cell view (mine/tunnel.ts TunnelCell) -------------------------------------------------

/** The tunnel planner's view of a cell (mine/tunnel.ts `TunnelCell`), from the rules above. */
export interface RuleCell {
  /** The body passes (`canWalkThroughClass` YES: no box, no liquid, no hazard; a ladder's or vine's cell counts). */
  open: boolean;
  /** A floor the body may stand on (`canWalkOn`). */
  solid: boolean;
  liquid: boolean;
  gravity: boolean;
  dripstone: boolean;
  /** The body must never move into it (`avoidWalkingInto`: liquids and hazards, with or without a box). */
  hazard: boolean;
}

/** The miner's cell facts of a classified block (mine/tunnel.ts `TunnelWorld.cell`). Allocates (one object per call: not the planner's hot path). */
export function ruleCell(c: TerrainClass): RuleCell {
  return { open: canWalkThroughClass(c) === YES, solid: canWalkOn(c), liquid: c.liquid !== undefined, gravity: c.gravity, dripstone: c.name.includes('pointed_dripstone'), hazard: avoidWalkingInto(c) };
}
