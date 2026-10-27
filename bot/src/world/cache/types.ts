// Persistent world cache (PLAN.md task 7.12): the shapes other modules read. See docs/world-cache.md.
import type { BlockInfo, Vec3 } from '../types.ts';
import type { HerdMarkStore } from './herds.ts'; // Track AF
import type { ChestMemoryStore } from './chests.ts'; // Track AG

/** 2-bit cell classes of the cache. */
export const CLS_AIR = 0;
/** Anything with a collision box (stone, logs, leaves, fences, slabs ...). */
export const CLS_SOLID = 1;
/** Water (and seagrass, kelp, bubble columns). */
export const CLS_WATER = 2;
/** Never enter: lava, fire, magma, cactus, berry bushes, cobweb, powder snow, portals ... */
export const CLS_AVOID = 3;
export type CellClass = typeof CLS_AIR | typeof CLS_SOLID | typeof CLS_WATER | typeof CLS_AVOID;

export const CLASS_NAMES: readonly string[] = ['air', 'solid', 'water', 'avoid'];

/** "No such y" in the per-column arrays. */
export const Y_NONE = -32768;

/** A remembered block worth finding again (logs, chests, ores, beds ...). */
export interface CachedMark {
  x: number;
  y: number;
  z: number;
  name: string;
  /** Some face of it touches air or water inside the same chunk (an ore the bot could have seen). */
  exposed: boolean;
  /** Track Z: the bot saw an open face of it (ore memory, skills/mine/seen.ts); persisted, survives a restart. */
  seen?: boolean;
}

/**
 * The cache as the planner's block query reads it (bot/src/skills/terrain/query.ts): synthetic blocks
 * for cells of columns that are not loaded. `World.cache` holds one when a cache is attached.
 */
export interface CachedTerrain {
  /**
   * A stand-in block for a cell of a cached column: air, stone (solid), water, lava (avoid), or
   * oak leaves for solid cells above the column's highest roof block. undefined = not cached.
   */
  blockAt(x: number, y: number, z: number): BlockInfo | undefined;
  /** The highest roof block of a cached column (the planner's sky scan start), or undefined. */
  columnTop(x: number, z: number): number | undefined;
  /** A summary of chunk column (cx, cz) is cached (on disk or in memory) for the current dimension. */
  has(cx: number, cz: number): boolean;
  /** Remembered marks of a cached chunk column (absolute positions), empty when none. */
  marks(cx: number, cz: number): readonly CachedMark[];
  /** Track Z (ore memory): flag the mark at p (loaded or cached column) as seen when it is a `name` mark. False when there is none. */
  markSeen?(p: Vec3, name: string): boolean;
  /** Track Z (ore memory): seen marks within `radius` of `origin`, loaded and cached columns of the current dimension. */
  seenMarks?(origin: Vec3, radius: number): CachedMark[];
  /** Track Z (ore memory): marks of the LOADED columns within `radius` of `origin` (a cheap ore scan without visiting every block). */
  loadedMarks?(origin: Vec3, radius: number): CachedMark[];
  /** Track AF (food v2): herd marks of passive food mobs per 16-block cell, persisted beside the regions (herds.ts). */
  readonly herds?: HerdMarkStore;
  /** Track AG (home logistics): the containers at home and what they held, persisted beside the regions (chests.ts). */
  readonly chests?: ChestMemoryStore;
}

/** A position World.find returned from the cache instead of a loaded chunk. */
export type FoundPos = Vec3 & { cached?: true };
