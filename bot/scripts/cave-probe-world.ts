// Track F9e: the world set-up of the cave probes over Track F5a's private fixture, in one place (scripts/cave-exit-probe.ts,
// cave-drawn-probe.ts and cave-learned-entry-probe.ts each have their own copy of it; scripts/cave-hop-probe.ts uses this
// one): the fixture's cells inside its box, the extract's column tops beside it (solid up to the top, air over it; a
// column the cache never saw is air), the liquids inside the box, and the simulation's ground and terrain questions.
import { caveWorld, loadCaveFixture, replicaCoarse } from '../src/skills/fly/corridor/cave.ts';
import type { SimDeps } from '../src/skills/fly/glide.ts';
import type { RouteGrid } from '../src/skills/fly/route/grid.ts';
import type { TerrainQuery } from '../src/skills/fly/terrain.ts';
import { TOP_NONE, TOP_UNKNOWN } from '../src/world/cache/export.ts';
import { CLS_AIR, CLS_WATER } from '../src/world/cache/types.ts';
import type { Vec3 } from '../src/world/types.ts';

export interface CaveProbeWorld {
  /** The follower's grid (water an obstacle). */
  grid: RouteGrid;
  deps: SimDeps;
  solidAt(x: number, y: number, z: number): boolean;
  /** A waypoint's feet cell (moved to the nearest standable one, as the routes have it). */
  cellOf(name: string): Vec3;
  /** A body can stand in the cell; a solid lies over it. */
  stands(c: Vec3): boolean;
  roofed(c: Vec3): boolean;
  /** The waypoints inside the box, in their natural order. */
  names: string[];
  top: number;
}

/** The probe's world, or undefined without the fixture (bot/fixtures-private/cave or CAVE_FIXTURE_DIR). */
export function caveProbeWorld(o: { replica?: boolean } = {}): CaveProbeWorld | undefined {
  const fix = loadCaveFixture();
  if (!fix) return undefined;
  const e = fix.extract;
  const world = caveWorld(e);
  // (`replica`: the world as the replica on the test server has it instead (corridor/cave.ts replicaCoarse, as
  // scripts/cave-learned-entry-probe.ts --replica): the same box inside its stone shell, the terraces round it, the home pad)
  const homeAt = fix.waypoints.get('home');
  const replica = o.replica ? replicaCoarse(world, homeAt ? { home: { x: Math.floor(homeAt.x), y: Math.floor(homeAt.y), z: Math.floor(homeAt.z) } } : {}) : undefined;
  const replicaCls = (x: number, y: number, z: number): number | undefined => replica!.chunk(x >> 4, z >> 4, e.dim)?.cls(x & 15, y, z & 15);
  const grid: RouteGrid = replica ? { solid: (x, y, z) => replicaCls(x, y, z) !== CLS_AIR } : world.grid;
  const b = e.box;
  const inBox = (x: number, z: number): boolean => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z;
  const outsideSolid = (x: number, y: number, z: number): boolean => {
    const t = e.top(x, z);
    return t !== undefined && t !== TOP_UNKNOWN && t !== TOP_NONE && y <= t;
  };
  const solidAt = replica
    ? (x: number, y: number, z: number): boolean => {
        const c = replicaCls(x, y, z);
        return c !== undefined && c !== CLS_AIR && c !== CLS_WATER;
      }
    : (x: number, y: number, z: number): boolean => (inBox(x, z) ? world.query.solidAt(x, y, z) === true : outsideSolid(x, y, z));
  const query = { solidAt, liquidAt: (x: number, y: number, z: number) => (inBox(x, z) ? world.query.liquidAt!(x, y, z) : null) };
  const skyTop = (x: number, z: number, fromY?: number): number | undefined => {
    for (let y = Math.min(b.max.y, Math.floor(fromY ?? b.max.y)); y >= b.min.y; y--) if (solidAt(x, y, z)) return y;
    return undefined;
  };
  const groundAt = (x: number, z: number, fromY?: number): number | undefined => {
    const t = skyTop(x, z, fromY);
    return t === undefined || grid.solid(x, t + 1, z) ? undefined : t + 1;
  };
  const tops = new Map<string, number | undefined>();
  const terrain: TerrainQuery = (x, z) => {
    const k = `${x},${z}`;
    if (!tops.has(k)) tops.set(k, skyTop(x, z));
    return { top: tops.get(k), src: 'live' };
  };
  const cellOf = (name: string): Vec3 => {
    const p = fix.waypoints.get(name);
    if (!p) throw new Error(`no waypoint ${name}`);
    return world.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  };
  const stands = (c: Vec3): boolean => grid.solid(c.x, c.y - 1, c.z) && !grid.solid(c.x, c.y, c.z) && !grid.solid(c.x, c.y + 1, c.z);
  const roofed = (c: Vec3): boolean => {
    for (let y = c.y + 1; y <= b.max.y; y++) if (grid.solid(c.x, y, c.z)) return true;
    return false;
  };
  const names = [...fix.waypoints.keys()].filter((n) => inBox(cellOf(n).x, cellOf(n).z)).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  return { grid, deps: { world: query, groundAt, skyTop: (x, z) => skyTop(x, z), terrain }, solidAt, cellOf, stands, roofed, names, top: b.max.y };
}
