// Injected world-changing actions for the planner's dig-through, pillar-up and door moves (PLAN.md
// tasks 7.1 / 7.2), and Baritone's safety rules for breaking blocks. The navigator only plans a move
// that needs an action when the action is provided and the goto allows it (`allowBreak`,
// `allowPlace`; doors whenever `useBlock` is there). See docs/pathfinding.md.
import type { Vec3 } from '../../world/types.ts';
import type { SkillResult } from '../types.ts';
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

export interface BreakRules {
  /** Block names never broken (on top of containers, beds and the like, which never are). */
  protectedBlocks?: ReadonlySet<string> | readonly string[];
}

/**
 * Why the planner may not break the block in cell (x, y, z), or undefined when it may (Baritone's
 * rules): unknown / unbreakable / air; protected (containers, beds, spawners, `protectedBlocks`);
 * a door or gate; a liquid in or next to it (6 neighbours: it would flow in); a gravity block above
 * it (sand, gravel would fall into the gap); the cell is the floor under `feetFloor` (the block under
 * the feet: only an explicit dig-down move may break that, and there is none).
 */
export function breakBlocker(grid: NavGrid, x: number, y: number, z: number, rules: BreakRules = {}, feetFloors: readonly Vec3[] = []): string | undefined {
  const c = grid.cls(x, y, z);
  if (!c) return 'unknown';
  if (c.boxes.length === 0 && !c.liquid) return 'air';
  if (c.liquid) return 'liquid';
  if (c.unknown) return 'unknown_block';
  if (c.protect) return 'protected';
  if (c.openable) return 'openable';
  const prot = rules.protectedBlocks;
  if (prot && (Array.isArray(prot) ? (prot as readonly string[]).includes(c.name) : (prot as ReadonlySet<string>).has(c.name))) return 'protected';
  for (const f of feetFloors) if (f.x === x && f.y === y && f.z === z) return 'under_feet';
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const n = grid.cls(x + dx, y + dy, z + dz);
    if (!n) return 'unknown';
    if (n.liquid) return 'next_to_liquid';
  }
  const above = grid.cls(x, y + 1, z);
  if (above?.gravity) return 'gravity_above';
  return undefined;
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
