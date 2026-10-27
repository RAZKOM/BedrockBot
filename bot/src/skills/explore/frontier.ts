// The frontier of `!explore` (wave 9, Track AI; docs/explore.md): which 16-block cell (= chunk
// column) to walk to next, and where in it to stand. Pure functions over what the world cache knows.
//
//   cells      the chunk columns whose centre lies within the radius of the centre (home, else where
//              the bot stood at the start)
//   gain       of a cell: the columns within the view radius of its centre the cache does not know yet
//              (what standing there would load); a cell with less than MIN_GAIN is "covered" for good
//              (the cache only ever learns more)
//   pick       the cheapest uncovered, unvisited cell: distance from the bot, minus a bonus for a cell
//              next to a visited one (the walk spirals outwards instead of zig-zagging)
//   stand      a dry surface column of the cell: centre first, then a 4 x 4 sample nearest the centre;
//              water, lava, canopies (leaves over the ground) and unknown columns are left out; no dry
//              column: the cell is skipped (over water or lava)
import type { CachedMark } from '../../world/cache/types.ts';
import type { Vec3 } from '../../world/types.ts';

/** Classes of the cache's cells (world/cache/types.ts). */
const CLS_SOLID = 1;
const CLS_WATER = 2;
const CLS_AVOID = 3;
const Y_NONE = -32768;

/** A cell whose walk would load fewer new columns than this is not worth the walk. */
export const MIN_GAIN = 3;
/** Cost bonus (blocks) for a cell next to a visited one. */
export const ADJACENT_BONUS = 24;

/** What the frontier reads of one cached column (world/cache/summary.ts ChunkSummary satisfies it). */
export interface ColumnSummary {
  readonly top: Int16Array;
  readonly roof: Int16Array;
  surface(): { y: Int16Array; cls: Uint8Array };
  markList(): CachedMark[];
}

/** What the explorer reads of the world cache (WorldCache satisfies it). */
export interface ExploreCache {
  /** Column (cx, cz) is cached (memory or disk), without decoding it. */
  known(cx: number, cz: number): boolean;
  /** The loaded column's summary, else the cached one. */
  summary(cx: number, cz: number): ColumnSummary | undefined;
  /** Track AF's herd marks. */
  readonly herds?: { readonly size: number } | undefined;
}

export const cellKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);
export const cellOf = (p: { x: number; z: number }): { cx: number; cz: number } => ({ cx: Math.floor(p.x) >> 4, cz: Math.floor(p.z) >> 4 });
export const cellCentre = (cx: number, cz: number): { x: number; z: number } => ({ x: cx * 16 + 8, z: cz * 16 + 8 });

/** The cells (chunk columns) whose centre lies within `radius` blocks of `centre`. */
export function cellsWithin(centre: { x: number; z: number }, radius: number): { cx: number; cz: number }[] {
  const out: { cx: number; cz: number }[] = [];
  const r = Math.ceil(radius / 16) + 1;
  const c = cellOf(centre);
  for (let cx = c.cx - r; cx <= c.cx + r; cx++) {
    for (let cz = c.cz - r; cz <= c.cz + r; cz++) {
      const m = cellCentre(cx, cz);
      if (Math.hypot(m.x - centre.x, m.z - centre.z) <= radius) out.push({ cx, cz });
    }
  }
  return out;
}

/** Columns within `view` chunks (a circle) of cell (cx, cz) that `known` does not know. */
export function gainOf(known: (cx: number, cz: number) => boolean, cx: number, cz: number, view: number): number {
  let n = 0;
  for (let dx = -view; dx <= view; dx++) {
    for (let dz = -view; dz <= view; dz++) {
      if (dx * dx + dz * dz > view * view) continue;
      if (!known(cx + dx, cz + dz)) n++;
    }
  }
  return n;
}

export interface FrontierState {
  visited: Set<number>;
  /** Cells left out for good: covered (no gain), over water, unreachable. */
  skipped: Set<number>;
}

/** Visited (or skipped as unreachable) cells next to (cx, cz) (8 neighbours). */
function nextToVisited(s: FrontierState, cx: number, cz: number): boolean {
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if ((dx || dz) && s.visited.has(cellKey(cx + dx, cz + dz))) return true;
  return false;
}

/**
 * The next cell to walk to, or undefined when every cell within the radius is visited, skipped or
 * covered. Cells found covered on the way are added to `s.skipped` (their gain only shrinks).
 */
export function pickCell(
  s: FrontierState,
  cells: readonly { cx: number; cz: number }[],
  bot: { x: number; z: number },
  known: (cx: number, cz: number) => boolean,
  view: number,
  minGain = MIN_GAIN,
): { cx: number; cz: number; gain: number; cost: number } | undefined {
  const open = cells
    .filter((c) => !s.visited.has(cellKey(c.cx, c.cz)) && !s.skipped.has(cellKey(c.cx, c.cz)))
    .map((c) => {
      const m = cellCentre(c.cx, c.cz);
      const d = Math.hypot(m.x - bot.x, m.z - bot.z);
      return { ...c, cost: d - (nextToVisited(s, c.cx, c.cz) ? ADJACENT_BONUS : 0) };
    })
    .sort((a, b) => a.cost - b.cost || a.cx - b.cx || a.cz - b.cz);
  for (const c of open) {
    const gain = gainOf(known, c.cx, c.cz, view);
    if (gain < minGain) {
      s.skipped.add(cellKey(c.cx, c.cz));
      continue;
    }
    return { cx: c.cx, cz: c.cz, gain, cost: c.cost };
  }
  return undefined;
}

/** Sample columns of a cell (local x, z), centre first, then by distance from it. */
export const SAMPLES: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [[8, 8]];
  for (const x of [2, 6, 10, 14]) for (const z of [2, 6, 10, 14]) out.push([x, z]);
  return out.sort((a, b) => Math.hypot(a[0] - 7.5, a[1] - 7.5) - Math.hypot(b[0] - 7.5, b[1] - 7.5));
})();

export type StandSpot = { p: Vec3 } | { skip: 'water' | 'lava' } | { unknown: true };

/**
 * Where to stand in cell (cx, cz): the feet cell above the first dry, open-sky sample column. A cell
 * whose samples are all water / lava is skipped; an uncached cell is `unknown` (walk to its centre).
 */
export function standSpot(summary: ColumnSummary | undefined, cx: number, cz: number): StandSpot {
  if (!summary) return { unknown: true };
  const surf = summary.surface();
  let water = 0;
  let lava = 0;
  for (const [lx, lz] of SAMPLES) {
    const i = (lz << 4) | lx;
    const y = surf.y[i]!;
    if (y === Y_NONE) continue;
    const c = surf.cls[i]!;
    if (c === CLS_WATER) {
      water++;
      continue;
    }
    if (c === CLS_AVOID) {
      lava++;
      continue;
    }
    // a canopy: the highest solid block (leaves, a trunk) is above the roof the sky rule sees
    if (c !== CLS_SOLID || summary.top[i] !== summary.roof[i]) continue;
    return { p: { x: cx * 16 + lx, y: y + 1, z: cz * 16 + lz } };
  }
  if (water + lava >= SAMPLES.length / 2) return { skip: lava > water ? 'lava' : 'water' };
  // only canopies (a forest): stand anywhere under it; the planner finds the ground
  const i = (8 << 4) | 8;
  const y = summary.roof[i]!;
  return y === Y_NONE ? { unknown: true } : { p: { x: cx * 16 + 8, y: y + 1, z: cz * 16 + 8 } };
}

/** What the explore summary counts in newly cached columns. */
export interface MarkCounts {
  ores: number;
  containers: number;
  logs: Vec3[];
}

export const CONTAINER_MARKS: ReadonlySet<string> = new Set(['chest', 'trapped_chest', 'barrel', 'ender_chest']);

export function countMarks(marks: readonly CachedMark[], into: MarkCounts, isLog: (name: string) => boolean): void {
  for (const m of marks) {
    if (m.name.endsWith('_ore') || m.name === 'ancient_debris') into.ores++;
    else if (CONTAINER_MARKS.has(m.name)) into.containers++;
    else if (isLog(m.name)) into.logs.push({ x: m.x, y: m.y, z: m.z });
  }
}
