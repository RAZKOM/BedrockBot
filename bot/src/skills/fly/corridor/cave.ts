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
import { decodeExtract, TOP_NONE, TOP_UNKNOWN, type CacheExtract, type CacheExtractFile } from '../../../world/cache/export.ts';
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
  /** The flight's cells (Track F6: water is an obstacle here too) and, `floor`, what a body stands on (the real solids). */
  solid: CellSolid;
  floor: CellSolid;
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
  // Track F6: the planner's grid has water as an obstacle too: a glide ends in water (the server's rule, stepBody's `water`
  // end), so a plan may not fly through a pool, and keeps the margin over its surface (three of six windows of one trip
  // through the owner's cave ended in its water floors before)
  const grid: RouteGrid = { solid: (x, y, z) => cls(x, y, z) !== CLS_AIR };
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
  // Track F6: the flight's cells have water as an obstacle (the planner's grid above, the windows' floors and landings),
  // what a body stands on is the real solid (so a cell over a pool is no landing and a body in a pool no takeoff: ADR 0068)
  const solid: CellSolid = (x, y, z) => grid.solid(x, y, z);
  const floor: CellSolid = isSolid;
  const feetCell = (p: Vec3): Vec3 | undefined => {
    const x0 = Math.floor(p.x);
    const y0 = Math.floor(p.y);
    const z0 = Math.floor(p.z);
    for (const dy of [0, 1, -1, 2, -2, 3, -3, 4]) {
      for (let r = 0; r <= 2; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            if (standable(isSolid, x0 + dx, y0 + dy, z0 + dz)) return { x: x0 + dx, y: y0 + dy, z: z0 + dz };
          }
        }
      }
    }
    return undefined;
  };
  return { extract: e, cls, grid, solid, floor, query, coarse, terrain, feetCell };
}

/** Track F8: the flat world's feet height outside the replica's box (fly-truth.ts FEET_Y) and the stone shell's thickness round the box's sides. */
export const REPLICA_FLAT_FEET = -60;
export const REPLICA_SHELL = 1;
/** Track F8: no terrace within this many chunks of home (the owner's roofs are column tops there). */
export const REPLICA_HOME_CHUNKS = 1;

/**
 * Track F8: the real terrain's heights round the box, a chunk at a time, from the extract's column tops (`--tops`, a wider
 * rectangle than the box): the chunk's LOWEST known column top (stone up to it is never higher than the real ground), for
 * the chunks of the rectangle not wholly inside the box; undefined elsewhere (the flat world). On the replica the box
 * stood as a mesa 160 blocks over the flat world: the cliff round it read as `cave` air to the layer (the chunk-local sky
 * rule) and the corridor into cave_start ran along it; the Realm's ground continues at the surface's height.
 */
export function replicaTerraces(e: CacheExtract, o: { home?: Vec3 } = {}): (cx: number, cz: number) => number | undefined {
  const r = e.topsRect;
  const b = e.box;
  const cache = new Map<string, number | undefined>();
  // (no terrace in the chunks round home: the tops there are the owner's roofs, and the e2e builds the pad at the real height)
  const hx = o.home ? Math.floor(o.home.x) >> 4 : undefined;
  const hz = o.home ? Math.floor(o.home.z) >> 4 : undefined;
  return (cx, cz) => {
    if (!r) return undefined;
    if (hx !== undefined && hz !== undefined && Math.abs(cx - hx) <= REPLICA_HOME_CHUNKS && Math.abs(cz - hz) <= REPLICA_HOME_CHUNKS) return undefined;
    const k = `${cx},${cz}`;
    if (cache.has(k)) return cache.get(k);
    let top: number | undefined;
    const x0 = cx * 16;
    const z0 = cz * 16;
    const insideBox = x0 >= b.min.x && x0 + 15 <= b.max.x && z0 >= b.min.z && z0 + 15 <= b.max.z;
    if (!insideBox && x0 + 15 >= r.min.x && x0 <= r.max.x && z0 + 15 >= r.min.z && z0 <= r.max.z) {
      let lowest = Infinity;
      for (let x = x0; x <= x0 + 15; x++) {
        for (let z = z0; z <= z0 + 15; z++) {
          if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) continue;
          const t = e.top(x, z);
          if (t === undefined || t === TOP_UNKNOWN || t === TOP_NONE) continue;
          if (t < lowest) lowest = t;
        }
      }
      if (Number.isFinite(lowest)) top = lowest;
    }
    cache.set(k, top);
    return top;
  };
}

/**
 * Track F8: the world as the replica on bds-fly2 has it (fly-cave.test.ts), for the coarse layer offline: the box as the
 * extract, the flat world's ground outside it (feet at REPLICA_FLAT_FEET), the home pad (5 x 5 at the waypoint's height),
 * air above everything, every chunk known, and a stone shell REPLICA_SHELL thick round the box's sides from the flat
 * ground up to the box's top. The shell is what the e2e builds too: without it the box's edge slices the cave open to
 * the flat world (a cliff with the cave's cross-section in it) and the layer's corridor into cave_start went in through
 * that cut face, 33 blocks from the goal, where the fixture (solid outside the box) and the Realm have no opening.
 */
export function replicaCoarse(world: CaveWorld, o: { home?: Vec3; shell?: number; flatFeet?: number; terraces?: boolean } = {}): CoarseSource {
  const b = world.extract.box;
  const shell = o.shell ?? REPLICA_SHELL;
  const flat = o.flatFeet ?? REPLICA_FLAT_FEET;
  const home = o.home;
  const terrace = o.terraces === false ? () => undefined : replicaTerraces(world.extract, home ? { home } : {});
  const rows = Math.ceil((b.max.y + 1 - OVERWORLD_MIN_Y) / 16) * 16;
  const cls = (x: number, y: number, z: number): CellClass => {
    const inX = x >= b.min.x && x <= b.max.x;
    const inZ = z >= b.min.z && z <= b.max.z;
    if (inX && inZ && y >= b.min.y && y <= b.max.y) return world.cls(x, y, z);
    if (y > b.max.y) return CLS_AIR;
    // the shell: the ring of `shell` cells round the box's footprint, from the flat ground to the box's top
    if (!(inX && inZ) && x >= b.min.x - shell && x <= b.max.x + shell && z >= b.min.z - shell && z <= b.max.z + shell && y >= flat - 1) return CLS_SOLID;
    if (inX && inZ) return CLS_SOLID; // under the box
    if (home && Math.abs(x - home.x) <= 2 && Math.abs(z - home.z) <= 2 && y === home.y - 1) return CLS_SOLID;
    // the terraces: the real terrain's height round the box, a chunk at a time (its lowest known column top)
    const t = terrace(x >> 4, z >> 4);
    if (t !== undefined && y <= t) return CLS_SOLID;
    return y < flat ? CLS_SOLID : CLS_AIR;
  };
  const views = new Map<string, ChunkCells>();
  return {
    minY: OVERWORLD_MIN_Y,
    maxY: OVERWORLD_MAX_Y,
    chunk(cx, cz, dim) {
      if (dim !== world.extract.dim) return undefined;
      const k = `${cx},${cz}`;
      let v = views.get(k);
      if (!v) {
        v = { y0: OVERWORLD_MIN_Y, rows, cls: (x, y, z) => cls(cx * 16 + x, y, cz * 16 + z) };
        views.set(k, v);
      }
      return v;
    },
  };
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
