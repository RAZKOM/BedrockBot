// Trees remembered by the world cache (PLAN.md task 7.12): logs of unloaded columns come back from
// World.find flagged `cached`; this groups them into trees with the tree model of the wood skills
// (skills/tree/tree.ts) over a lookup that reads loaded blocks first, then the cached marks (logs by
// name), then the cache's stand-ins (solid cells above a column's roof read as leaves). Cached trees
// are candidates: walk there, and the loaded chunk decides (detectTree on real blocks).
import { treesFrom, type Tree, type TreeOptions } from '../../skills/tree/tree.ts';
import type { BlockInfo, Vec3 } from '../types.ts';
import type { WorldCache } from './cache.ts';
import type { FoundPos } from './types.ts';

export interface CachedTreeWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: { origin: Vec3; radius: number; max: number; class?: 'log' }): FoundPos[];
}

export type CachedTree = Tree & { cached: true };

const isLogName = (n: string): boolean => (n.endsWith('_log') && !n.startsWith('stripped_')) || n === 'crimson_stem' || n === 'warped_stem';

/** A block lookup over loaded blocks, then cached marks, then cached stand-ins. */
export function cachedLookup(world: Pick<CachedTreeWorld, 'blockAt'>, cache: WorldCache): (p: Vec3) => BlockInfo | undefined {
  const marksByChunk = new Map<string, Map<string, string>>();
  return (p) => {
    const real = world.blockAt(p);
    if (real) return real;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    const ck = `${x >> 4},${z >> 4}`;
    let marks = marksByChunk.get(ck);
    if (!marks) {
      marks = new Map(cache.marks(x >> 4, z >> 4).map((m) => [`${m.x},${m.y},${m.z}`, m.name]));
      marksByChunk.set(ck, marks);
    }
    const name = marks.get(`${x},${y},${z}`);
    if (name) return cache.markInfo(name) ?? cache.blockAt(x, y, z);
    return cache.blockAt(x, y, z);
  };
}

/**
 * Trees whose logs are remembered by the cache (columns not loaded now) within `radius` of `origin`,
 * closest first. Leaves and soil are only approximate in the cache, so the defaults accept bare log
 * columns (`minLeaves` 0, `requireSoil` false); `partial` is true for every cached tree.
 */
export function findCachedTrees(world: CachedTreeWorld, cache: WorldCache, origin: Vec3, radius: number, opts: TreeOptions = {}): CachedTree[] {
  const logs = world.find((b) => isLogName(b.name), { origin, radius, max: 4096, class: 'log' }).filter((p) => p.cached);
  const trees = treesFrom(cachedLookup(world, cache), logs, origin, { minLeaves: 0, requireSoil: false, ...opts });
  return trees.map((t) => ({ ...t, partial: true, cached: true as const }));
}
