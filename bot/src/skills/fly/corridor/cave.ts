// Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)", ADR 0068): a real place the bot has seen, as the
// flight benchmark's world. The world cache's extract of a box (world/cache/export.ts) is read into the worlds the
// flight code plans and flies over offline, in world coordinates:
//   - `grid` (route/grid.ts RouteGrid) and `solid` (stretches.ts CellSolid): solid and avoid cells, unknown chunks,
//     everything outside the box sideways and under it are solid; over the box is air (the box reaches over the
//     highest top);
//   - `query` (stepBody's BlockQuery): the same cells, water as water (a glide ends in it);
//   - `coarse` (skills/coarse/source.ts CoarseSource, read-only use): the chunks wholly inside the box, the cache's
//     classes as they are, solid under the box; the chunks the box cuts and the unknown ones are unknown;
//   - `terrain` (terrain/query.ts TerrainSource): stone, water and air blocks for the walk navigator.
// The fixture (the extract and the waypoints of a route someone walked) is private data: it lives in a git-ignored
// directory (`CAVE_FIXTURE_DIR`, default bot/fixtures-private/cave) and nothing in the repository names its place.
// Every caller skips when `loadCaveFixture` answers undefined.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Vec3 } from '../../../world/types.ts';
import type { BlockInfo } from '../../../world/types.ts';
import { CLS_AIR, CLS_SOLID, CLS_WATER, type CellClass } from '../../../world/cache/types.ts';
import { decodeExtract, type CacheExtract, type CacheExtractFile } from '../../../world/cache/export.ts';
import type { BlockQuery } from '../../input/types.ts';
import type { ChunkCells, CoarseSource } from '../../coarse/source.ts';
import { blockInfoOf } from '../../terrain/shapes.ts';
import type { TerrainSource } from '../../terrain/query.ts';
import type { RouteGrid } from '../route/grid.ts';
import { standable, type CellSolid } from './stretches.ts';

/** The env var naming the fixture directory (the extract and the waypoints). */
export const CAVE_DIR_ENV = 'CAVE_FIXTURE_DIR';
/** The fixture's files in that directory. */
export const CAVE_EXTRACT_FILE = 'extract.json';
export const CAVE_WAYPOINTS_FILE = 'waypoints.json';
/** The overworld's height range (the coarse source's floor and ceiling). */
export const OVERWORLD_MIN_Y = -64;
export const OVERWORLD_MAX_Y = 319;

/** The default fixture directory: bot/fixtures-private/cave (git-ignored). */
export function caveFixtureDir(): string {
  const env = process.env[CAVE_DIR_ENV];
  if (env) return resolve(env);
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures-private/cave');
}

export interface CaveFixture {
  dir: string;
  extract: CacheExtract;
  /** The waypoints by name (the bot's waypoint file: `{ waypoints: { name: { x, y, z } } }`). */
  waypoints: ReadonlyMap<string, Vec3>;
}

/** The fixture in `dir`, or undefined when its files are not there (the public repository, CI). */
export function loadCaveFixture(dir = caveFixtureDir()): CaveFixture | undefined {
  const ex = join(dir, CAVE_EXTRACT_FILE);
  const wp = join(dir, CAVE_WAYPOINTS_FILE);
  if (!existsSync(ex) || !existsSync(wp)) return undefined;
  const extract = decodeExtract(JSON.parse(readFileSync(ex, 'utf8')) as CacheExtractFile);
  const raw = JSON.parse(readFileSync(wp, 'utf8')) as { waypoints?: Record<string, { x: number; y: number; z: number }> };
  const waypoints = new Map<string, Vec3>();
  for (const [name, p] of Object.entries(raw.waypoints ?? {})) waypoints.set(name, { x: p.x, y: p.y, z: p.z });
  return { dir, extract, waypoints };
}

export interface CaveWorld {
  extract: CacheExtract;
  /** The class of a cell (outside the box: solid sideways and under it, air over it; unknown chunks solid). */
  cls(x: number, y: number, z: number): CellClass;
  grid: RouteGrid;
  solid: CellSolid;
  query: BlockQuery;
  coarse: CoarseSource;
  terrain: TerrainSource & { readonly minY: number; readonly maxY: number };
  /** The standable feet cell nearest to `p` (a waypoint), searching up to 3 down and 4 up and 2 sideways. */
  feetCell(p: Vec3): Vec3 | undefined;
}

const WATER_HEIGHT = 8 / 9;

/** The flight's and the walk's worlds over an extract (see the file comment). */
export function caveWorld(e: CacheExtract): CaveWorld {
  const b = e.box;
  const cls = (x: number, y: number, z: number): CellClass => {
    if (y > b.max.y) return CLS_AIR;
    if (y < b.min.y || x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) return CLS_SOLID;
    if (e.unknownChunk(x >> 4, z >> 4)) return CLS_SOLID;
    return e.cls(x, y, z)!;
  };
  // solid and avoid cells are walls for the flight (the replica builds both as stone)
  const isSolid = (x: number, y: number, z: number): boolean => {
    const c = cls(x, y, z);
    return c !== CLS_AIR && c !== CLS_WATER;
  };
  const grid: RouteGrid = { solid: isSolid };
  const query: BlockQuery = {
    solidAt: isSolid,
    liquidAt: (x, y, z) => (cls(x, y, z) === CLS_WATER ? { liquid: 'water', height: WATER_HEIGHT } : null),
  };
  // the coarse layer's chunks: wholly inside the box and seen
  const inside = (cx: number, cz: number): boolean => cx * 16 >= b.min.x && cx * 16 + 15 <= b.max.x && cz * 16 >= b.min.z && cz * 16 + 15 <= b.max.z && !e.unknownChunk(cx, cz);
  const views = new Map<string, ChunkCells>();
  const coarse: CoarseSource = {
    minY: OVERWORLD_MIN_Y,
    maxY: OVERWORLD_MAX_Y,
    chunk(cx, cz, dim) {
      if (dim !== e.dim || !inside(cx, cz)) return undefined;
      const k = `${cx},${cz}`;
      let v = views.get(k);
      if (!v) {
        const rows = Math.ceil((b.max.y + 1 - OVERWORLD_MIN_Y) / 16) * 16;
        v = { y0: OVERWORLD_MIN_Y, rows, cls: (x, y, z) => cls(cx * 16 + x, y, cz * 16 + z) };
        views.set(k, v);
      }
      return v;
    },
  };
  const blocks: BlockInfo[] = [blockInfoOf('air'), blockInfoOf('stone'), blockInfoOf('water'), blockInfoOf('stone')];
  const terrain = {
    minY: OVERWORLD_MIN_Y,
    maxY: b.max.y + 1,
    blockAt: (x: number, y: number, z: number): BlockInfo | undefined => (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z ? undefined : blocks[cls(x, y, z)]),
  };
  const solid: CellSolid = isSolid;
  const feetCell = (p: Vec3): Vec3 | undefined => {
    const x0 = Math.floor(p.x);
    const y0 = Math.floor(p.y);
    const z0 = Math.floor(p.z);
    for (const dy of [0, 1, -1, 2, -2, 3, -3, 4]) {
      for (let r = 0; r <= 2; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            if (standable(solid, x0 + dx, y0 + dy, z0 + dz)) return { x: x0 + dx, y: y0 + dy, z: z0 + dz };
          }
        }
      }
    }
    return undefined;
  };
  return { extract: e, cls, grid, solid, query, coarse, terrain, feetCell };
}

// ---- the routes ---------------------------------------------------------------------------------------

export interface CaveRoute {
  name: string;
  /** The waypoints in order. */
  stops: readonly string[];
  what: string;
}

/** Route A: the whole path walked, start to end through every numbered waypoint. */
export const ROUTE_A: CaveRoute = {
  name: 'A',
  stops: ['cave_start', ...Array.from({ length: 21 }, (_, i) => `cave_${i + 1}`), 'cave_end'],
  what: 'the full path, cave_start through cave_1 .. cave_21 to cave_end',
};
/** Route B: the shortcut (flight only, the owner says): from cave_4 and cave_5 up through cave_shortcut to cave_end. */
export const ROUTE_B: CaveRoute = { name: 'B', stops: ['cave_4', 'cave_5', 'cave_shortcut', 'cave_end'], what: 'the shortcut, cave_4 and cave_5 up through cave_shortcut to cave_end' };
/** Trip C: home, the entrance by cave_2 (the open sky), cave_start. */
export const TRIP_C: CaveRoute = { name: 'C', stops: ['home', 'cave_2', 'cave_start'], what: 'home to the entrance by cave_2 and in to cave_start' };

export interface CaveLeg {
  route: string;
  /** `cave_4 -> cave_5` */
  name: string;
  from: Vec3;
  to: Vec3;
  /** The straight distance between the two feet cells. */
  blocks: number;
}

/** The legs of a route between consecutive waypoints, as standable feet cells (a waypoint missing or with no floor near it throws). */
export function caveLegs(fix: CaveFixture, world: CaveWorld, route: CaveRoute): CaveLeg[] {
  const cells = route.stops.map((n) => {
    const p = fix.waypoints.get(n);
    if (!p) throw new Error(`cave fixture: no waypoint ${n}`);
    const c = world.feetCell(p);
    if (!c) throw new Error(`cave fixture: no floor near waypoint ${n}`);
    return c;
  });
  const out: CaveLeg[] = [];
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1]!;
    const c = cells[i]!;
    out.push({ route: route.name, name: `${route.stops[i - 1]} -> ${route.stops[i]}`, from: a, to: c, blocks: Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z) });
  }
  return out;
}

/** `p` moved by `d` (the replica's offset: replica = real + d). */
export const shift = (p: Vec3, d: Vec3): Vec3 => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });
