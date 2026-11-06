// Persistent world cache (PLAN.md task 7.12). See docs/world-cache.md.
//
//   const cache = openWorldCache(world, { server: '127.0.0.1:19184' });   // attach to a World
//   world.cache?.blockAt(x, y, z);     // stand-in block of an unloaded, cached column (terrain/query.ts uses it)
//   world.find(pred, { ..., class: 'log' });   // includes cached logs, flagged `cached: true`
//   findCachedTrees(world, cache, origin, radius);
//   await cache.flush();  cache.close();
import { dirname, join } from 'node:path';
import { defaultConfigPath } from '../../config/config.ts';
import type { Logger } from '../../log.ts';
import { fnv1a32 } from '../registry.ts';
import { WorldCache, type CacheHost, type WorldCacheOptions } from './cache.ts';

export { WorldCache } from './cache.ts';
export type { CacheHost, MapTile, WorldCacheOptions, WorldCacheStats } from './cache.ts';
export { ChunkSummary, decodeSummary, encodeSummary, encodeRaw, summarizeColumn, currentRev } from './summary.ts';
export { StateTable, isInteresting, cellClassOf, mapView, VIS_NONE, VIS_BLOCK, VIS_LIQUID, type MapVisibility } from './classes.ts';
export { SurfaceData, NO_NAME, MAX_NAMES, MAX_DEPTH, roofedDimension, scanTop, scanUnderRoof, type SurfaceLayer, type SurfaceColumn, type ColumnSurface } from './surface.ts'; // Track PC
export { parseRegion, serializeRegion, readRegion, regionFileName, regionOf, slotOf, REGION_SIZE } from './region.ts';
export { findCachedTrees, cachedLookup, type CachedTree } from './trees.ts';
export * from './types.ts';
export { HerdMarks, HERD_FILE, type HerdMark, type HerdMarkStore, type HerdCounts } from './herds.ts'; // Track AF
export { ChestMemory, CHEST_FILE, chestKey, type ChestRecord, type ChestMemoryStore } from './chests.ts'; // Track AG

/**
 * A directory-safe id for a connection target, so caches of different servers never mix: a readable
 * slug plus 8 hex digits of FNV-1a over the full label. BDS: `host:port`; Realm: `realm:<name or id>`.
 */
export function serverIdFor(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const hash = (fnv1a32(Buffer.from(label, 'utf8')) >>> 0).toString(16).padStart(8, '0');
  return `${slug || 'server'}-${hash}`;
}

/** `<config dir>/cache`: next to the config file (default %LOCALAPPDATA%\bedrockbot\cache or ~/.bedrockbot/cache). */
export function defaultCacheRoot(configPath: string = defaultConfigPath()): string {
  return join(dirname(configPath), 'cache');
}

export interface OpenCacheOptions extends Omit<WorldCacheOptions, 'dir'> {
  /** The cache root (`<config dir>/cache`). Default `defaultCacheRoot()`. */
  root?: string;
  /** Connection target label (see `serverIdFor`). */
  server: string;
  logger?: Logger;
}

/** Creates the cache for a server under `root/<server id>` and attaches it to the world model. */
export function openWorldCache(world: CacheHost, opts: OpenCacheOptions): WorldCache {
  const dir = join(opts.root ?? defaultCacheRoot(), serverIdFor(opts.server));
  const cache = new WorldCache({ ...opts, dir });
  cache.attach(world);
  opts.logger?.info(`world cache: ${dir}`);
  return cache;
}
