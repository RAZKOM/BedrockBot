// Track R2 (docs/pathfinding.md "Reachability (Track R1)", its R2 part; decisions/0072-reachability.md "R2"): a real
// place as a bench world. A box of the bot's world cache (world/cache/export.ts, the 2-bit classes) becomes the
// bench's voxels (vox.ts), so the closed loop (test/unit/skills/reach-sim.ts) walks it as it walks a generated world:
// solid is grass on the surface, dirt for 3 under it and stone deeper (the cache does not keep block names); water
// is still water; avoid (lava, fire, magma, cactus ...) is lava; under the box stone, bedrock at the world's floor;
// over it air.
//
// The fixture is private data (the owner's world): it lives in the git-ignored bot/fixtures-private/<name>/ and
// nothing in the repository names its place. Its spec (`fixture.json`) gives the extract's file, the corner of the
// bench world in world coordinates (`origin`: x and z only, y is kept), edits applied before the run (a pillar the
// bot left, a creeper's crater, in world coordinates) and the start / goal pairs (world coordinates, or waypoint
// names of the bot's waypoint file next to it). Every caller skips when `loadFixture` answers undefined.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Vec3 } from '../../../world/types.ts';
import { CLS_SOLID, CLS_WATER, CLS_AVOID } from '../../../world/cache/types.ts';
import { decodeExtract, type CacheExtract, type CacheExtractFile } from '../../../world/cache/export.ts';
import { MIN_Y, V, Vox } from './vox.ts';
import type { BenchPair, BenchWorld } from './worlds.ts';

/** The fixture spec's file in its directory. */
export const FIXTURE_SPEC_FILE = 'fixture.json';

/** A box of cells set before the run (world coordinates, inclusive). */
export interface FixtureEdit {
  min: Vec3;
  max: Vec3;
  to: 'air' | 'solid';
}

/** A point: world coordinates, or a waypoint's name (its feet cell). */
export type FixturePoint = Vec3 | string;

export interface FixtureSpec {
  /** The extract's file name in the fixture directory. */
  extract: string;
  /** The bot's waypoint file (`{ waypoints: { name: { x, y, z } } }`) in the directory, for named points. */
  waypoints?: string;
  /** World x / z of the bench world's cell (0, y, 0). Default the extract box's min corner. */
  origin?: { x: number; z: number };
  edits?: FixtureEdit[];
  pairs: { start: FixturePoint; goal: FixturePoint; tag: string }[];
  /** The chunk radius loaded round the bot (default 6). */
  loadRadius?: number;
}

export interface Fixture {
  dir: string;
  world: BenchWorld;
  /** World coordinates of a bench cell (the log lines of a run are in bench coordinates). */
  toWorld(p: Vec3): Vec3;
}

/** The default fixture directory: bot/fixtures-private/<name> (git-ignored). */
export function fixtureDir(name: string): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures-private', name);
}

/**
 * The bench's voxels of an extract: x / z from `origin`, y as it is (the world's height from MIN_Y to the extract's
 * top, rounded up to a section).
 */
export function extractVox(e: CacheExtract, origin: { x: number; z: number }): Vox {
  const top = e.box.max.y;
  const height = Math.ceil((top + 1 - MIN_Y) / 16) * 16;
  const sx = e.box.max.x - origin.x + 1;
  const sz = e.box.max.z - origin.z + 1;
  const v = new Vox(sx, sz, height);
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const wx = x + origin.x;
      const wz = z + origin.z;
      v.set(x, MIN_Y, z, V.bedrock);
      for (let y = MIN_Y + 1; y < e.box.min.y; y++) v.set(x, y, z, V.stone);
      // down the column: grass under air, dirt for 3 under that, stone deeper
      let depth = 99;
      for (let y = top; y >= e.box.min.y; y--) {
        const c = e.cls(wx, y, wz);
        if (c === CLS_SOLID) {
          depth++;
          v.set(x, y, z, depth === 0 ? V.grass : depth <= 3 ? V.dirt : V.stone);
        } else {
          depth = -1;
          if (c === CLS_WATER) {
            v.set(x, y, z, V.water);
            depth = 99;
          } else if (c === CLS_AVOID) {
            v.set(x, y, z, V.lava);
            depth = 99;
          }
        }
      }
    }
  }
  return v;
}

/** Apply a fixture's edits (world coordinates) to its voxels. */
export function applyEdits(v: Vox, edits: readonly FixtureEdit[], origin: { x: number; z: number }): void {
  for (const ed of edits) {
    for (let y = Math.min(ed.min.y, ed.max.y); y <= Math.max(ed.min.y, ed.max.y); y++)
      for (let z = Math.min(ed.min.z, ed.max.z); z <= Math.max(ed.min.z, ed.max.z); z++)
        for (let x = Math.min(ed.min.x, ed.max.x); x <= Math.max(ed.min.x, ed.max.x); x++) {
          const bx = x - origin.x;
          const bz = z - origin.z;
          if (ed.to === 'air') v.set(bx, y, bz, V.air);
          else v.set(bx, y, bz, v.get(bx, y + 1, bz) === V.air ? V.grass : V.dirt);
        }
  }
}

/** The fixture named `name` (bot/fixtures-private/<name>/fixture.json), or undefined when it is not there. */
export function loadFixture(name: string, dir = fixtureDir(name)): Fixture | undefined {
  const specFile = join(dir, FIXTURE_SPEC_FILE);
  if (!existsSync(specFile)) return undefined;
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as FixtureSpec;
  const exFile = join(dir, spec.extract);
  if (!existsSync(exFile)) return undefined;
  const e = decodeExtract(JSON.parse(readFileSync(exFile, 'utf8')) as CacheExtractFile);
  const origin = spec.origin ?? { x: e.box.min.x, z: e.box.min.z };
  const vox = extractVox(e, origin);
  applyEdits(vox, spec.edits ?? [], origin);
  const wps = new Map<string, Vec3>();
  if (spec.waypoints && existsSync(join(dir, spec.waypoints))) {
    const raw = JSON.parse(readFileSync(join(dir, spec.waypoints), 'utf8')) as { waypoints?: Record<string, { x: number; y: number; z: number }> };
    for (const [n, p] of Object.entries(raw.waypoints ?? {})) wps.set(n, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
  }
  const point = (p: FixturePoint): Vec3 => {
    const w = typeof p === 'string' ? wps.get(p) : p;
    if (!w) throw new Error(`fixture ${name}: no waypoint ${typeof p === 'string' ? p : JSON.stringify(p)}`);
    return { x: w.x - origin.x, y: w.y, z: w.z - origin.z };
  };
  const pairs: BenchPair[] = spec.pairs.map((p) => ({ start: point(p.start), goal: point(p.goal), tag: p.tag }));
  const world: BenchWorld = { cls: 'fixture', seed: 0, vox, loadRadius: spec.loadRadius ?? 6, coarse: true, pairs };
  return { dir, world, toWorld: (p) => ({ x: p.x + origin.x, y: p.y, z: p.z + origin.z }) };
}
