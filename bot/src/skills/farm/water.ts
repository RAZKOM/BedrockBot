// Water for a starter plot (Track E8, docs/farming.md "Water for the plot", ADR 0105), pure over block lookups so the
// unit tests need no server. The rules, for any world:
//
//   surface   a still source with no water over it and nothing solid in the WATER_SKY cells above (air, plants and
//             leaves are open): a pool in a cave has its roof, and a fresh world's plot had one 9 under it whose six
//             nearest cells were all the search took (tried three times, never reached, and the reply said "no still
//             water within 96" with the sea 23 off);
//   pools     the sources grouped (cells within WATER_POOL_LINK of each other are one pool), nearest the plot first by
//             x and z, so a pool that cannot be reached costs one try, not three;
//   seen      loaded columns are read first-hand; with a world cache, a column remembered with water on top (its map
//             layer) is a candidate too, as far as WATER_SEEN from the plot: the walk there decides;
//   search    with no pool known, legs of WATER_SEARCH_OUT out from the plot along x and z, WATER_SEARCH_STEP at a time,
//             looking again after each step (the server loads the chunks round the bot as it goes).
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import { isWater, isWaterSource } from './plot.ts';

/** Loaded blocks searched for still surface water round the plot (a sphere; BDS loads 10 chunks round the bot). */
export const WATER_LOOK = 160;
/** Water seen (loaded or remembered) this far from the plot (x, z) is fetched; the walk there and back is the cost. */
export const WATER_SEEN = 256;
/** Cells over a source that must be open for it to count as surface water. */
export const WATER_SKY = 24;
/** Sources this close (x, z; 2 up or down) are one pool. */
export const WATER_POOL_LINK = 4;
/** Pools tried before the search walk. */
export const WATER_POOLS = 4;
/** The search walk: legs this far out from the plot, a look after each step of this length, at most this long (ms). */
export const WATER_SEARCH_OUT = 96;
export const WATER_SEARCH_STEP = 32;
export const WATER_SEARCH_MS = 300_000;
/** The legs' directions (x, z), in order. */
export const WATER_SEARCH_DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

type BlockAt = (p: Vec3) => BlockInfo | undefined;

/** Nothing over `p` for `up` cells but air, plants and leaves (unloaded height counts as open). */
export function openAbove(blockAt: BlockAt, p: Vec3, up = WATER_SKY): boolean {
  for (let y = p.y + 1; y <= p.y + up; y++) {
    const b = blockAt({ x: p.x, y, z: p.z });
    if (!b) return true;
    if (b.name === 'unknown' || isWater(b)) return false;
    if (b.boxes.length > 0 && !b.name.endsWith('_leaves')) return false;
  }
  return true;
}

/**
 * A still source a bucket can take from above: no water over it, open for WATER_SKY cells and, with `top`, up to
 * `top` (the plot's height and a margin): a cave under a mountain can be more than 24 high (a fresh world's plot at y
 * 85 had six "open" pools tried at y 22 to 59 in caves, none reached).
 */
export function surfaceSource(blockAt: BlockAt, top?: number): (b: BlockInfo, p: Vec3) => boolean {
  return (b, p) => isWaterSource(b) && !isWater(blockAt({ x: p.x, y: p.y + 1, z: p.z })) && openAbove(blockAt, p, Math.max(WATER_SKY, (top ?? 0) - p.y));
}

/** Cells over the plot's height a source must be open to (the plot's own trees and fence count as open). */
export const WATER_TOP_MARGIN = 8;

export interface WaterPool {
  /** The pool's cells (sources, or remembered water columns), nearest the origin first. */
  cells: Vec3[];
  /** Its cell nearest the origin (x, z). */
  at: Vec3;
  /** That cell's distance from the origin (x, z). */
  dist: number;
  /** Read off loaded blocks, or remembered by the world cache (the walk there decides). */
  seen: 'loaded' | 'remembered';
}

const flat = (a: Vec3, b: Vec3): number => Math.hypot(a.x + 0.5 - b.x, a.z + 0.5 - b.z);

/** Cells grouped into pools (single link on a grid: within `link` on x and z, 2 on y), nearest `origin` first. */
export function poolsOf(cells: readonly Vec3[], origin: Vec3, seen: WaterPool['seen'] = 'loaded', link = WATER_POOL_LINK): WaterPool[] {
  const parent = cells.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const cell = (v: number): number => Math.floor(v / link);
  const grid = new Map<string, number[]>();
  cells.forEach((p, i) => {
    const k = `${cell(p.x)},${cell(p.z)}`;
    const g = grid.get(k);
    if (g) g.push(i);
    else grid.set(k, [i]);
  });
  cells.forEach((p, i) => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const j of grid.get(`${cell(p.x) + dx},${cell(p.z) + dz}`) ?? []) {
          if (j <= i) continue;
          const q = cells[j]!;
          if (Math.abs(q.x - p.x) <= link && Math.abs(q.z - p.z) <= link && Math.abs(q.y - p.y) <= 2) parent[root(j)] = root(i);
        }
  });
  const groups = new Map<number, Vec3[]>();
  cells.forEach((p, i) => {
    const r = root(i);
    const g = groups.get(r);
    if (g) g.push(p);
    else groups.set(r, [p]);
  });
  return [...groups.values()]
    .map((g) => {
      const sorted = [...g].sort((a, b) => flat(a, origin) - flat(b, origin));
      return { cells: sorted, at: sorted[0]!, dist: flat(sorted[0]!, origin), seen };
    })
    .sort((a, b) => a.dist - b.dist);
}

export interface WaterLookDeps {
  blockAt: BlockAt;
  find(pred: (b: BlockInfo, p: Vec3) => boolean, o: { origin: Vec3; radius: number; max: number }): Vec3[];
  /** The world cache's map layer (CachedTerrain.surfaceAt); undefined without a cache. */
  surfaceAt?: (x: number, z: number) => { name: string; y: number } | undefined;
}

/**
 * Water pools round `plot` (x, z within `range`), nearest first: still surface sources of the loaded blocks within
 * WATER_LOOK of `from` (the bot), and with a cache the columns it remembers with water on top that are not loaded now.
 * `skip` leaves out cells of pools tried already.
 */
export function waterPools(d: WaterLookDeps, plot: Vec3, from: Vec3, range = WATER_SEEN, skip: (p: Vec3) => boolean = () => false): WaterPool[] {
  const near = (p: Vec3): boolean => flat(p, { x: plot.x + 0.5, y: plot.y, z: plot.z + 0.5 }) <= range && !skip(p);
  const centre = { x: plot.x + 0.5, y: plot.y, z: plot.z + 0.5 };
  const still = surfaceSource(d.blockAt, plot.y + WATER_TOP_MARGIN);
  const loaded = d.find(still, { origin: from, radius: WATER_LOOK, max: 20_000 }).filter(near);
  const remembered: Vec3[] = [];
  if (d.surfaceAt) {
    // the map layer: loaded columns past the search sphere (checked on their blocks) and remembered ones
    const had = new Set(loaded.map((p) => `${p.x},${p.z}`));
    const r = Math.ceil(range);
    for (let cx = (plot.x - r) >> 4; cx <= (plot.x + r) >> 4; cx++) {
      for (let cz = (plot.z - r) >> 4; cz <= (plot.z + r) >> 4; cz++) {
        for (let i = 0; i < 256; i++) {
          const x = cx * 16 + (i & 15);
          const z = cz * 16 + (i >> 4);
          const s = d.surfaceAt(x, z);
          if (s?.name !== 'water' || had.has(`${x},${z}`)) continue;
          const p = { x, y: s.y, z };
          if (!near(p)) continue;
          const b = d.blockAt(p);
          if (b === undefined) remembered.push(p);
          else if (still(b, p)) loaded.push(p);
        }
      }
    }
  }
  return [...poolsOf(loaded, centre, 'loaded'), ...poolsOf(remembered, centre, 'remembered')].sort((a, b) => a.dist - b.dist);
}

/** The search legs' step targets from `plot`: per leg the points WATER_SEARCH_STEP apart out to WATER_SEARCH_OUT. */
export function searchLegs(plot: Vec3, out = WATER_SEARCH_OUT, step = WATER_SEARCH_STEP): Vec3[][] {
  return WATER_SEARCH_DIRS.map(([dx, dz]) => {
    const leg: Vec3[] = [];
    for (let s = step; s <= out; s += step) leg.push({ x: plot.x + dx * s, y: plot.y + 1, z: plot.z + dz * s });
    return leg;
  });
}
