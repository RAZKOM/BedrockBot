// Injected world-changing actions for the planner's dig-through, pillar-up and door moves (PLAN.md
// tasks 7.1 / 7.2), and Baritone's safety rules for breaking blocks. The navigator only plans a move
// that needs an action when the action is provided and the goto allows it (`allowBreak`,
// `allowPlace`; doors whenever `useBlock` is there). See docs/pathfinding.md.
import type { Vec3 } from '../../world/types.ts';
import type { SkillResult } from '../types.ts';
import { avoidBreaking, type BreakReason, type BreakRuleOptions } from './baritone/helper.ts'; // Track BB
import type { NavGrid } from './grid.ts';

export type NavBlockFace = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';

export interface NavActions {
  /** Break the block in cell p; resolves when it is gone. */
  dig?: (p: Vec3) => Promise<SkillResult>;
  /** Make a throwaway block occupy cell p (click the neighbour across `face`). */
  place?: (p: Vec3, face: NavBlockFace) => Promise<SkillResult>;
  /** Open (toggle) the door / gate / trapdoor at p. */
  useBlock?: (p: Vec3) => Promise<SkillResult>;
  /** Item names the planner may place, preferred first. */
  throwawayItems?: string[];
}

/** Default throwaway blocks (cheap, full cubes, no gravity). */
export const DEFAULT_THROWAWAY: readonly string[] = Object.freeze(['cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff']);

/** Unit offsets of the 6 faces. */
export const FACE_OFFSET: Readonly<Record<NavBlockFace, Readonly<Vec3>>> = Object.freeze({
  down: { x: 0, y: -1, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  west: { x: -1, y: 0, z: 0 },
  east: { x: 1, y: 0, z: 0 },
});

/**
 * The break rules' parameters: `protectedBlocks` (names never broken, on top of containers, beds and the
 * like, which never are), `protectedArea` (nothing is broken within `r` blocks of this point: the base
 * around home, `protectRadius`), `allowGravityAbove` (Baritone's way, off by default: the owner's rule).
 * Track BB: the type lives with the rule set (nav/baritone/helper.ts `BreakRuleOptions`).
 */
export type BreakRules = BreakRuleOptions;

/**
 * Why the planner may not break the block in cell (x, y, z), or undefined when it may: the shared rule
 * set (Track BB, nav/baritone/helper.ts `avoidBreaking`, Baritone's MovementHelper.avoidBreaking with the
 * owner's rules): unknown / unbreakable / air; protected (containers, beds, spawners, built blocks,
 * `protectedBlocks`); a door or gate; the protected area; the floor under `feetFloors` (the block under
 * the feet: only an explicit dig-down move may break that); ice (becomes water); infested; a liquid in
 * or next to it (6 neighbours: it would flow in); a gravity block above it (sand, gravel would fall into
 * the gap); an unsupported gravity block beside it. The planner (nav/astar.ts), the worker, the follower's
 * dig actions, the miner, the farmer and branch mining all call this.
 */
export function breakBlocker(grid: NavGrid, x: number, y: number, z: number, rules: BreakRules = {}, feetFloors: readonly Vec3[] = []): BreakReason | undefined {
  return avoidBreaking(grid, x, y, z, rules, feetFloors);
}
