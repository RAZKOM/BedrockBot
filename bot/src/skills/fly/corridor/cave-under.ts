// Track F22: the two-layer world of the probes that decide as the bot decides (scripts/cave-under-probe.ts has its own
// copy, from Track F9e round 2; scripts/cave-hop-walk-probe.ts uses this one): Track F5a's private fixture is the world
// CACHE, the LIVE model is the chunks within `reach` chunks of where the body last stood (`stand`), and a line under a roof
// is simulated on the live model alone, an unknown cell a solid (chat/commands-fly.ts liveSim).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caveWorld, loadCaveFixture } from './cave.ts';
import type { SimDeps } from '../glide.ts';
import { ENTRY_AIR, ENTRY_LAVA, ENTRY_SOLID, ENTRY_WATER } from '../learn/entry.ts';
import type { UnderWorld } from '../learn/under.ts';
import type { TerrainQuery } from '../terrain.ts';
import { TOP_NONE, TOP_UNKNOWN } from '../../../world/cache/export.ts';
import { CLS_AIR, CLS_SOLID, CLS_WATER } from '../../../world/cache/types.ts';
import type { Vec3 } from '../../../world/types.ts';

export interface CaveUnderWorld {
  w: UnderWorld;
  /** The simulation's world for a line under a roof: the live model alone, an unknown cell a solid. */
  liveSim: SimDeps;
  /** The cache's class of a cell (undefined: never seen). */
  cached(x: number, y: number, z: number): number | undefined;
  /** The live model is the chunks within `reach` of this place from now on (`cold`: nothing at all). */
  stand(at: Vec3, cold?: boolean): void;
  /** The live model's reach in chunks, changed (a body that has stood a while has more of them). */
  reach(chunks: number): void;
  /** A waypoint's feet cell (moved to the nearest standable one, as the routes have it). */
  cellOf(name: string): Vec3;
  /** A body can stand in the cell (on what the cache has); a solid lies over it. */
  stands(c: Vec3): boolean;
  roofed(c: Vec3): boolean;
  /** A cell of the cache is no air (water and what was never seen count). */
  seenSolid(x: number, y: number, z: number): boolean;
  top: number;
  /** The folder the fixture was read from. */
  dir: string;
}

/** The probe's world, or undefined without the fixture (`dir`, else bot/fixtures-private/cave or CAVE_FIXTURE_DIR). */
export function caveUnderWorld(reach0 = 9, dir?: string): CaveUnderWorld | undefined {
  const fix = dir ? loadCaveFixture(dir) : loadCaveFixture();
  if (!fix) return undefined;
  const e = fix.extract;
  const cw = caveWorld(e);
  const b = e.box;
  let R = reach0;
  const cached = (x: number, y: number, z: number): number | undefined => {
    if (y > b.max.y) return ENTRY_AIR;
    if (y < b.min.y) return ENTRY_SOLID;
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z || e.unknownChunk(x >> 4, z >> 4)) return undefined;
    const c = e.cls(x, y, z);
    return c === CLS_AIR ? ENTRY_AIR : c === CLS_WATER ? ENTRY_WATER : c === CLS_SOLID ? ENTRY_SOLID : ENTRY_LAVA;
  };
  let body = { cx: 0, cz: 0, cold: false };
  const live = (x: number, y: number, z: number): number | undefined => {
    if (body.cold || Math.hypot((x >> 4) - body.cx, (z >> 4) - body.cz) > R) return undefined;
    // (a chunk inside the live reach that the cache never saw: a solid, so that nothing flies through it)
    return cached(x, y, z) ?? ENTRY_SOLID;
  };
  const isSolid = (c: number | undefined): boolean => c === ENTRY_SOLID || c === ENTRY_LAVA;
  const skyTop = (x: number, z: number): number | undefined => {
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) {
      const t = e.top(x, z);
      return t === undefined || t === TOP_UNKNOWN || t === TOP_NONE ? undefined : t;
    }
    for (let y = b.max.y; y >= b.min.y; y--) if (isSolid(cached(x, y, z))) return y;
    return undefined;
  };
  const tops = new Map<number, number | undefined>();
  const terrain: TerrainQuery = (x, z) => {
    const k = x * 65536 + z;
    if (!tops.has(k)) tops.set(k, skyTop(x, z));
    return { top: tops.get(k), src: 'live' };
  };
  const liquidAt = (x: number, y: number, z: number) => ((live(x, y, z) ?? cached(x, y, z)) === ENTRY_WATER ? { liquid: 'water' as const, height: 8 / 9 } : null);
  const groundAt = (x: number, z: number): number | undefined => {
    const t = skyTop(x, z);
    return t === undefined ? undefined : t + 1;
  };
  const liveSim: SimDeps = { world: { solidAt: (x, y, z) => isSolid(live(x, y, z) ?? ENTRY_SOLID), liquidAt }, groundAt, skyTop, terrain };
  const seenSolid = (x: number, y: number, z: number): boolean => (cached(x, y, z) ?? ENTRY_SOLID) !== ENTRY_AIR;
  const cellOf = (name: string): Vec3 => {
    if (name.startsWith('landing:')) {
      const pairs = (JSON.parse(readFileSync(join(fix.dir, 'fixture.json'), 'utf8')) as { pairs?: { start: Vec3; tag: string }[] }).pairs ?? [];
      const q = pairs.find((x) => x.tag === name.slice('landing:'.length));
      if (!q) throw new Error(`no pair ${name}`);
      return { x: Math.floor(q.start.x), y: Math.floor(q.start.y + 1e-6), z: Math.floor(q.start.z) };
    }
    const p = fix.waypoints.get(name);
    if (!p) throw new Error(`no waypoint ${name}`);
    return cw.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  };
  return {
    w: { live, cached },
    liveSim,
    cached,
    stand: (at, cold = false) => {
      body = { cx: Math.floor(at.x) >> 4, cz: Math.floor(at.z) >> 4, cold };
    },
    reach: (chunks) => {
      R = chunks;
    },
    cellOf,
    stands: (c) => isSolid(cached(c.x, c.y - 1, c.z)) && !seenSolid(c.x, c.y, c.z) && !seenSolid(c.x, c.y + 1, c.z),
    roofed: (c) => {
      for (let y = c.y + 1; y <= b.max.y; y++) if (seenSolid(c.x, y, c.z)) return true;
      return false;
    },
    seenSolid,
    top: b.max.y,
    dir: fix.dir,
  };
}
