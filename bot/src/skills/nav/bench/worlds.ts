// Track R1 (docs/pathfinding.md "Reachability (Track R1)"; decisions/0072-reachability.md): the reachability
// bench's world generator. Every world comes from (class, seed) alone: the same pair gives the same blocks and the
// same start / goal pairs. Classes: hills and cliffs, ravines, worm caves, water (lakes, rivers, flooded caves),
// lava, builds (walls, fenced fields, houses with doors, the protected base), pits and towers, unknown (goals
// past the loaded chunks) and long trips (the coarse layer's).
import type { Vec3 } from '../../../world/types.ts';
import { HEIGHT, MIN_Y, V, Vox, isSolid } from './vox.ts';

export const WORLD_CLASSES = ['hills', 'ravine', 'caves', 'water', 'lava', 'builds', 'pits', 'unknown', 'long'] as const;
export type WorldClass = (typeof WORLD_CLASSES)[number];

export interface BenchPair {
  /** Feet cells (block coordinates). */
  start: Vec3;
  goal: Vec3;
  /** What the pair tests (e.g. "into-house", "across-ravine"). */
  tag: string;
}

export interface BenchWorld {
  cls: WorldClass;
  seed: number;
  vox: Vox;
  /** The home point (the protected base's centre) and the protect radius, when the world has a base. */
  home?: Vec3;
  protectRadius?: number;
  /** The chunk radius the "server" keeps loaded around the bot. */
  loadRadius: number;
  /** Plan long walks over the coarse layer (the session's coarseMin 96). */
  coarse: boolean;
  pairs: BenchPair[];
}

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash2 = (seed: number, x: number, z: number): number => {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Value noise in [0, 1) at scale `s` (smoothstep-interpolated lattice). */
function noise(seed: number, x: number, z: number, s: number): number {
  const fx = x / s;
  const fz = z / s;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const u = tx * tx * (3 - 2 * tx);
  const w = tz * tz * (3 - 2 * tz);
  const a = hash2(seed, x0, z0);
  const b = hash2(seed, x0 + 1, z0);
  const c = hash2(seed, x0, z0 + 1);
  const d = hash2(seed, x0 + 1, z0 + 1);
  return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
}

/** Ground height (the grass block's y) from octaves of value noise. */
function heightField(seed: number, amp: number, base = 4): (x: number, z: number) => number {
  return (x, z) => Math.round(base + amp * (noise(seed, x, z, 48) * 0.6 + noise(seed + 7, x, z, 20) * 0.3 + noise(seed + 13, x, z, 9) * 0.1 - 0.5) * 2);
}

/** Fills the columns: bedrock, deepslate, stone, 3 dirt, grass (sand under shallow water spots stays to the classes). */
function terrain(v: Vox, h: (x: number, z: number) => number, r: () => number): void {
  for (let z = 0; z < v.sz; z++)
    for (let x = 0; x < v.sx; x++) {
      const top = Math.max(MIN_Y + 6, Math.min(MIN_Y + HEIGHT - 20, h(x, z)));
      for (let y = MIN_Y; y <= top; y++) {
        let id: number = V.stone;
        if (y === MIN_Y) id = V.bedrock;
        else if (y < -20) id = V.deepslate;
        else if (y === top) id = V.grass;
        else if (y > top - 4) id = V.dirt;
        v.set(x, y, z, id);
      }
    }
  // a few gravel and sand patches on the surface (gravity blocks next to cuts)
  const patches = Math.floor((v.sx * v.sz) / 3000);
  for (let i = 0; i < patches; i++) {
    const cx = Math.floor(r() * v.sx);
    const cz = Math.floor(r() * v.sz);
    const rad = 1 + Math.floor(r() * 3);
    const id = r() < 0.5 ? V.sand : V.gravel;
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx * dx + dz * dz > rad * rad) continue;
        const t = v.top(cx + dx, cz + dz);
        if (t > MIN_Y) for (let k = 0; k < 2; k++) v.set(cx + dx, t - k, cz + dz, id);
      }
  }
}

/** The feet cell of the column's surface (the first air over the top block), or undefined when that is not a land node. */
export function surfaceFeet(v: Vox, x: number, z: number): number | undefined {
  const t = v.top(x, z);
  if (t <= MIN_Y || !isSolid(v.get(x, t, z))) return undefined;
  return t + 1;
}

/** A land node: feet and head air, a full block under the feet. */
export function standable(v: Vox, x: number, y: number, z: number): boolean {
  return v.get(x, y, z) === V.air && v.get(x, y + 1, z) === V.air && isSolid(v.get(x, y - 1, z));
}

/** A random surface land node in the box (tries a few times; undefined when none). */
function surfacePoint(v: Vox, r: () => number, box?: { x0: number; z0: number; x1: number; z1: number }): Vec3 | undefined {
  const b = box ?? { x0: 4, z0: 4, x1: v.sx - 5, z1: v.sz - 5 };
  for (let i = 0; i < 60; i++) {
    const x = b.x0 + Math.floor(r() * (b.x1 - b.x0 + 1));
    const z = b.z0 + Math.floor(r() * (b.z1 - b.z0 + 1));
    const y = surfaceFeet(v, x, z);
    if (y !== undefined && standable(v, x, y, z)) return { x, y, z };
  }
  return undefined;
}

/** A random point at distance [dmin, dmax] from p (surface), or undefined. */
function surfaceNear(v: Vox, r: () => number, p: Vec3, dmin: number, dmax: number): Vec3 | undefined {
  for (let i = 0; i < 80; i++) {
    const a = r() * Math.PI * 2;
    const d = dmin + r() * (dmax - dmin);
    const x = Math.round(p.x + Math.cos(a) * d);
    const z = Math.round(p.z + Math.sin(a) * d);
    if (x < 3 || z < 3 || x >= v.sx - 3 || z >= v.sz - 3) continue;
    const y = surfaceFeet(v, x, z);
    if (y !== undefined && standable(v, x, y, z)) return { x, y, z };
  }
  return undefined;
}

/** Every land node of the world in the given cells (cave floors, pit bottoms), as a list. */
function landNodesIn(v: Vox, cells: Iterable<Vec3>): Vec3[] {
  const out: Vec3[] = [];
  const seen = new Set<number>();
  for (const c of cells) {
    const k = v.index(c.x, c.y, c.z);
    if (seen.has(k)) continue;
    seen.add(k);
    if (standable(v, c.x, c.y, c.z)) out.push(c);
  }
  return out;
}

const pick = <T>(r: () => number, a: readonly T[]): T | undefined => (a.length ? a[Math.floor(r() * a.length)] : undefined);

function addPair(pairs: BenchPair[], start: Vec3 | undefined, goal: Vec3 | undefined, tag: string): void {
  if (!start || !goal) return;
  if (start.x === goal.x && start.y === goal.y && start.z === goal.z) return;
  pairs.push({ start, goal, tag });
}

// ---- carving -----------------------------------------------------------------------------------

/** A worm: a random walk of spheres from `from` (the carved cells' feet-level floor cells are returned). */
function worm(v: Vox, r: () => number, from: Vec3, o: { length: number; radius: [number, number]; pitch: number; fill?: number; waterBelow?: number }): Vec3[] {
  let x = from.x;
  let y = from.y;
  let z = from.z;
  let yaw = r() * Math.PI * 2;
  let pitch = o.pitch;
  const floors: Vec3[] = [];
  for (let i = 0; i < o.length; i++) {
    const rad = o.radius[0] + (o.radius[1] - o.radius[0]) * (0.5 + 0.5 * Math.sin(i / 9 + r()));
    const R = Math.ceil(rad);
    for (let dy = -R; dy <= R; dy++)
      for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy * 1.6 + dz * dz > rad * rad) continue;
          const cx = Math.round(x) + dx;
          const cy = Math.round(y) + dy;
          const cz = Math.round(z) + dz;
          if (cy <= MIN_Y + 2 || cx < 1 || cz < 1 || cx >= v.sx - 1 || cz >= v.sz - 1) continue;
          v.set(cx, cy, cz, o.waterBelow !== undefined && cy <= o.waterBelow ? V.water : (o.fill ?? V.air));
        }
    floors.push({ x: Math.round(x), y: Math.round(y) - R + 1, z: Math.round(z) });
    yaw += (r() - 0.5) * 0.5;
    pitch = Math.max(-0.7, Math.min(0.4, pitch + (r() - 0.5) * 0.25));
    x += Math.cos(yaw) * Math.cos(pitch);
    z += Math.sin(yaw) * Math.cos(pitch);
    y += Math.sin(pitch);
    if (y < MIN_Y + 8) pitch = 0.2;
  }
  return floors;
}

/** The land nodes in and around a list of worm floor points (a few cells down to the floor each). */
function wormNodes(v: Vox, floors: readonly Vec3[]): Vec3[] {
  const cells: Vec3[] = [];
  for (const f of floors)
    for (let dy = 3; dy >= -4; dy--)
      for (const [dx, dz] of [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const)
        cells.push({ x: f.x + dx, y: f.y + dy, z: f.z + dz });
  return landNodesIn(v, cells);
}

// ---- the classes -------------------------------------------------------------------------------

function hills(seed: number): BenchWorld {
  const r = rng(seed);
  const v = new Vox(144, 144);
  const base = heightField(seed, 10 + r() * 8);
  // cliff zones: the height quantised in steps of 3 .. 7 (sheer faces), and one sheer escarpment
  const step = 3 + Math.floor(r() * 5);
  const ex = 30 + Math.floor(r() * 80);
  const eh = 6 + Math.floor(r() * 14);
  const h = (x: number, z: number): number => {
    let y = base(x, z);
    if (noise(seed + 99, x, z, 40) > 0.55) y = Math.floor(y / step) * step;
    if (x > ex + Math.round(6 * Math.sin(z / 11))) y += eh;
    return y;
  };
  terrain(v, h, r);
  const pairs: BenchPair[] = [];
  for (let i = 0; i < 14; i++) {
    const s = surfacePoint(v, r);
    addPair(pairs, s, s && surfaceNear(v, r, s, 12, 70), i % 2 ? 'across-cliff' : 'hills');
  }
  return { cls: 'hills', seed, vox: v, loadRadius: 6, coarse: true, pairs };
}

function ravine(seed: number): BenchWorld {
  const r = rng(seed);
  const v = new Vox(144, 144);
  terrain(v, heightField(seed, 6), r);
  const pairs: BenchPair[] = [];
  const bottoms: Vec3[] = [];
  const n = 1 + Math.floor(r() * 2);
  for (let k = 0; k < n; k++) {
    // a trench along a wandering line across the world
    const alongX = r() < 0.5;
    let c = 30 + r() * 84;
    const depth = 10 + Math.floor(r() * 26);
    const water = r() < 0.3;
    for (let t = 2; t < 142; t++) {
      c += (r() - 0.5) * 1.2;
      const w = 2 + Math.floor(3 * (0.5 + 0.5 * Math.sin(t / 13 + k))) + Math.floor(r() * 2);
      for (let o = -w; o <= w; o++) {
        const x = alongX ? t : Math.round(c) + o;
        const z = alongX ? Math.round(c) + o : t;
        const top = v.top(x, z);
        // walls narrow towards the floor; a ledge now and then
        const d = depth - Math.floor(Math.abs(o) * (0.5 + r() * 0.6));
        const floor = top - d;
        for (let y = floor; y <= top; y++) v.set(x, y, z, V.air);
        if (water && Math.abs(o) <= 1) v.set(x, floor - 1, z, V.water);
        if (Math.abs(o) <= 1 && t % 9 === 0) bottoms.push({ x, y: floor, z });
      }
    }
  }
  const floorNodes = landNodesIn(v, bottoms.flatMap((b) => [0, 1, 2, -1, -2].map((dy) => ({ x: b.x, y: b.y + dy, z: b.z }))));
  for (let i = 0; i < 6; i++) {
    const s = surfacePoint(v, r);
    addPair(pairs, s, s && surfaceNear(v, r, s, 20, 60), 'across-ravine');
  }
  for (let i = 0; i < 4; i++) addPair(pairs, surfacePoint(v, r), pick(r, floorNodes), 'into-ravine');
  for (let i = 0; i < 4; i++) addPair(pairs, pick(r, floorNodes), surfacePoint(v, r), 'out-of-ravine');
  return { cls: 'ravine', seed, vox: v, loadRadius: 6, coarse: true, pairs };
}

function caves(seed: number): BenchWorld {
  const r = rng(seed);
  const v = new Vox(144, 144);
  terrain(v, heightField(seed, 8, 20), r);
  const nodes: Vec3[] = [];
  const n = 2 + Math.floor(r() * 3);
  for (let k = 0; k < n; k++) {
    const m = surfacePoint(v, r, { x0: 24, z0: 24, x1: 120, z1: 120 });
    if (!m) continue;
    const floors = worm(v, r, { x: m.x, y: m.y, z: m.z }, { length: 60 + Math.floor(r() * 100), radius: [1.2, 2.6 + r()], pitch: -0.35 });
    nodes.push(...wormNodes(v, floors));
  }
  // closed pockets (no mouth): the world's own class (a)
  for (let k = 0; k < 2; k++) {
    const p = { x: 30 + Math.floor(r() * 84), y: -40 + Math.floor(r() * 30), z: 30 + Math.floor(r() * 84) };
    nodes.push(...wormNodes(v, worm(v, r, p, { length: 20 + Math.floor(r() * 20), radius: [1.5, 2.5], pitch: 0 })));
  }
  const pairs: BenchPair[] = [];
  for (let i = 0; i < 6; i++) addPair(pairs, surfacePoint(v, r), pick(r, nodes), 'into-cave');
  for (let i = 0; i < 4; i++) addPair(pairs, pick(r, nodes), pick(r, nodes), 'in-cave');
  for (let i = 0; i < 3; i++) addPair(pairs, pick(r, nodes), surfacePoint(v, r), 'out-of-cave');
  return { cls: 'caves', seed, vox: v, loadRadius: 6, coarse: true, pairs };
}

function water(seed: number): BenchWorld {
  const r = rng(seed);
  const v = new Vox(144, 144);
  const level = 6;
  const base = heightField(seed, 8, level + 2);
  // a lake (a bowl under the water level) and a river (a channel across)
  const lx = 30 + r() * 80;
  const lz = 30 + r() * 80;
  const lr = 10 + r() * 14;
  const riverX = r() < 0.5;
  const rc = 20 + r() * 100;
  const rw = 2 + Math.floor(r() * 5);
  const rd = 2 + Math.floor(r() * 3);
  const h = (x: number, z: number): number => {
    let y = base(x, z);
    const d = Math.hypot(x - lx, z - lz);
    if (d < lr) y = Math.min(y, level - Math.round((1 - d / lr) * (2 + lr / 3)));
    const c = (riverX ? z : x) - (rc + 8 * Math.sin((riverX ? x : z) / 17));
    if (Math.abs(c) <= rw) y = Math.min(y, level - rd);
    return y;
  };
  terrain(v, h, r);
  for (let z = 0; z < v.sz; z++)
    for (let x = 0; x < v.sx; x++) {
      const t = v.top(x, z);
      for (let y = t + 1; y <= level; y++) v.set(x, y, z, V.water);
      if (t < level) v.set(x, t, z, r() < 0.5 ? V.sand : V.dirt);
    }
  // an island in the lake now and then
  if (r() < 0.5) {
    const ir = 2 + Math.floor(r() * 3);
    for (let dz = -ir; dz <= ir; dz++) for (let dx = -ir; dx <= ir; dx++) if (dx * dx + dz * dz <= ir * ir) v.fill({ x: Math.round(lx) + dx, y: MIN_Y + 1, z: Math.round(lz) + dz }, { x: Math.round(lx) + dx, y: level + 1, z: Math.round(lz) + dz }, V.stone);
  }
  // a flooded cave: a worm under the water level, filled with water below `level - 1`
  const fc: Vec3[] = [];
  const mouth = surfacePoint(v, r, { x0: 20, z0: 20, x1: 124, z1: 124 });
  if (mouth) fc.push(...worm(v, r, { x: mouth.x, y: mouth.y - 1, z: mouth.z }, { length: 40 + Math.floor(r() * 40), radius: [1.3, 2.4], pitch: -0.3, waterBelow: level - 2 - Math.floor(r() * 6) }));
  settleLiquid(v, V.water, WATER_SPREAD);
  const caveCells = fc.flatMap((f) => [0, 1, 2, -1, -2, 3].map((dy) => ({ x: f.x, y: f.y + dy, z: f.z })));
  const caveNodes = landNodesIn(v, caveCells);
  const caveWater = caveCells.filter((c) => v.get(c.x, c.y, c.z) === V.water);
  const pairs: BenchPair[] = [];
  const lake = { x: Math.round(lx), z: Math.round(lz) };
  for (let i = 0; i < 4; i++) {
    const s = surfacePoint(v, r);
    addPair(pairs, s, s && surfaceNear(v, r, s, 25, 70), 'across-water');
  }
  for (let i = 0; i < 3; i++) {
    const a = r() * Math.PI * 2;
    const p = { x: Math.round(lake.x + Math.cos(a) * (lr + 4)), z: Math.round(lake.z + Math.sin(a) * (lr + 4)) };
    const s = surfaceFeet(v, p.x, p.z);
    const q = surfaceNear(v, r, { x: lake.x, y: 0, z: lake.z }, lr + 3, lr + 8);
    addPair(pairs, s !== undefined && standable(v, p.x, s, p.z) ? { x: p.x, y: s, z: p.z } : undefined, q, 'around-lake');
  }
  // a goal in the water: the lake's surface or its floor
  for (let i = 0; i < 2; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * lr * 0.7;
    const x = Math.round(lake.x + Math.cos(a) * d);
    const z = Math.round(lake.z + Math.sin(a) * d);
    let floor = level;
    while (floor > MIN_Y && v.get(x, floor - 1, z) === V.water) floor--;
    if (v.get(x, level, z) === V.water) addPair(pairs, surfacePoint(v, r), { x, y: i === 0 ? level : floor, z }, i === 0 ? 'water-surface' : 'water-floor');
  }
  for (let i = 0; i < 3; i++) addPair(pairs, surfacePoint(v, r), pick(r, caveNodes.length ? caveNodes : caveWater), 'flooded-cave');
  return { cls: 'water', seed, vox: v, loadRadius: 6, coarse: true, pairs };
}

/** Overworld lava flows this many blocks from its source on a floor; water 7. */
const LAVA_SPREAD = 3;
const WATER_SPREAD = 7;

/**
 * Track R1: a liquid as the server would have it: a cell of it over air falls into it, one on a floor spreads into the
 * air beside it up to `spread` blocks. The generators left lava with open air at its side (a dip's lava beside a lower
 * floor cell: the bench killed the body there, lava:4:12) and lake water over air a worm carved under the lake's floor
 * (the body stuck diving into it, water:8:7); the game keeps neither.
 */
export function settleLiquid(v: Vox, id: number, spread: number): void {
  const q: [number, number, number, number][] = [];
  for (let y = MIN_Y; y < MIN_Y + HEIGHT; y++) for (let z = 0; z < v.sz; z++) for (let x = 0; x < v.sx; x++) if (v.get(x, y, z) === id) q.push([x, y, z, 0]);
  for (const [x, y, z, d] of q) {
    // (the queue grows as the liquid flows: the iterator reads its length each step)
    if (v.get(x, y - 1, z) === V.air) {
      v.set(x, y - 1, z, id);
      q.push([x, y - 1, z, 0]);
      continue;
    }
    if (d >= spread) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (v.get(x + dx, y, z + dz) !== V.air) continue;
      v.set(x + dx, y, z + dz, id);
      q.push([x + dx, y, z + dz, d + 1]);
    }
  }
}

function lava(seed: number): BenchWorld {
  const r = rng(seed);
  const v = new Vox(144, 144);
  terrain(v, heightField(seed, 7, 10), r);
  const n = 4 + Math.floor(r() * 5);
  for (let k = 0; k < n; k++) {
    // a surface lava pool 1-2 deep, or a pocket just under the surface (a cut next to it is refused)
    const p = surfacePoint(v, r, { x0: 10, z0: 10, x1: 134, z1: 134 });
    if (!p) continue;
    const rad = 2 + Math.floor(r() * 4);
    const under = r() < 0.4;
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx * dx + dz * dz > rad * rad) continue;
        const t = v.top(p.x + dx, p.z + dz);
        if (under) v.set(p.x + dx, t - 2, p.z + dz, V.lava);
        else for (let k2 = 0; k2 < 1 + Math.floor(r() * 2); k2++) v.set(p.x + dx, t - k2, p.z + dz, V.lava);
      }
  }
  // a lava lake cutting the world in two along a line now and then (the way round or nothing)
  if (r() < 0.4) {
    const z0 = 40 + Math.floor(r() * 60);
    for (let x = 0; x < v.sx; x++) for (let z = z0; z < z0 + 4; z++) v.set(x, v.top(x, z), z, V.lava);
  }
  const caveNodes: Vec3[] = [];
  const m = surfacePoint(v, r, { x0: 30, z0: 30, x1: 114, z1: 114 });
  if (m) {
    const floors = worm(v, r, m, { length: 70, radius: [1.4, 2.6], pitch: -0.35 });
    caveNodes.push(...wormNodes(v, floors));
    // lava in the cave's dips
    for (const f of floors) if (r() < 0.12) v.set(f.x, f.y - 1, f.z, V.lava);
  }
  settleLiquid(v, V.lava, LAVA_SPREAD);
  const pairs: BenchPair[] = [];
  for (let i = 0; i < 10; i++) {
    const s = surfacePoint(v, r);
    addPair(pairs, s, s && surfaceNear(v, r, s, 10, 60), 'near-lava');
  }
  for (let i = 0; i < 3; i++) addPair(pairs, surfacePoint(v, r), pick(r, caveNodes.filter((c) => standable(v, c.x, c.y, c.z))), 'lava-cave');
  return { cls: 'lava', seed, vox: v, loadRadius: 6, coarse: true, pairs };
}

/** A house: plank walls (a door in one), a plank roof, glass windows. Returns the inside floor cells. */
function house(v: Vox, r: () => number, x0: number, z0: number, w: number, d: number, y: number, doorOn: boolean): Vec3[] {
  const hgt = 3 + Math.floor(r() * 2);
  const inside: Vec3[] = [];
  v.fill({ x: x0, y: y - 1, z: z0 }, { x: x0 + w - 1, y: y - 1, z: z0 + d - 1 }, V.planks);
  for (let yy = y; yy < y + hgt; yy++)
    for (let z = z0; z < z0 + d; z++)
      for (let x = x0; x < x0 + w; x++) {
        const edge = x === x0 || z === z0 || x === x0 + w - 1 || z === z0 + d - 1;
        v.set(x, yy, z, edge ? (yy === y + 1 && (x + z) % 3 === 0 && x !== x0 && x !== x0 + w - 1 ? V.glass : V.planks) : V.air);
        if (!edge && yy === y) inside.push({ x, y, z });
      }
  v.fill({ x: x0, y: y + hgt, z: z0 }, { x: x0 + w - 1, y: y + hgt, z: z0 + d - 1 }, V.planks);
  if (doorOn) {
    // the door in the south wall (z0 + d - 1), passage along z; the outside cell levelled
    const dx = x0 + 1 + Math.floor(r() * (w - 2));
    const dz = z0 + d - 1;
    v.set(dx, y, dz, V.doorZLo);
    v.set(dx, y + 1, dz, V.doorZHi);
    v.set(dx, y - 1, dz + 1, V.grass);
    v.set(dx, y, dz + 1, V.air);
    v.set(dx, y + 1, dz + 1, V.air);
  }
  return inside;
}

/** Flattens the area to height y (the grass top at y - 1). */
function flatten(v: Vox, x0: number, z0: number, x1: number, z1: number, y: number): void {
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      for (let yy = y; yy < MIN_Y + HEIGHT; yy++) v.set(x, yy, z, V.air);
      for (let yy = v.top(x, z) + 1; yy < y; yy++) v.set(x, yy, z, V.dirt);
      v.set(x, y - 1, z, V.grass);
    }
}

function builds(seed: number): BenchWorld {
  const r = rng(seed);
  const v = new Vox(144, 144);
  terrain(v, heightField(seed, 4, 6), r);
  const y = 8;
  // the base: flat, home at the centre, protect radius 48 (the setting's default) or 24
  const home = { x: 72, y, z: 72 };
  const protectRadius = r() < 0.5 ? 48 : 24;
  flatten(v, 40, 40, 104, 104, y);
  const goals: { p: Vec3; tag: string }[] = [];
  // houses: some with a door, some closed (no door: (b) built blocks, or (b) the base)
  for (let k = 0; k < 4; k++) {
    const x0 = 44 + (k % 2) * 30 + Math.floor(r() * 8);
    const z0 = 44 + Math.floor(k / 2) * 30 + Math.floor(r() * 8);
    const inside = house(v, r, x0, z0, 5 + Math.floor(r() * 3), 5 + Math.floor(r() * 3), y, r() < 0.75);
    const g = pick(r, inside);
    if (g) goals.push({ p: g, tag: 'into-house' });
  }
  // a fenced field: a gap in the fence or none (no gap: dig under it, outside the base only)
  const fx = r() < 0.5 ? 10 : 108;
  const fz = 20 + Math.floor(r() * 80);
  const fw = 10 + Math.floor(r() * 10);
  flatten(v, fx - 2, fz - 2, fx + fw + 2, fz + fw + 2, y);
  const gap = r() < 0.5;
  for (let t = 0; t <= fw; t++)
    for (const [x, z] of [
      [fx + t, fz],
      [fx + t, fz + fw],
      [fx, fz + t],
      [fx + fw, fz + t],
    ] as const) {
      if (gap && x === fx + Math.floor(fw / 2) && z === fz) continue;
      v.set(x, y, z, V.fence);
    }
  goals.push({ p: { x: fx + Math.floor(fw / 2), y, z: fz + Math.floor(fw / 2) }, tag: gap ? 'into-field' : 'into-closed-field' });
  // a walled compound inside the base: bricks 4 high, an opening or none
  const cx0 = 60;
  const cz0 = 58 + Math.floor(r() * 6);
  const open = r() < 0.5;
  for (let t = 0; t <= 12; t++)
    for (const [x, z] of [
      [cx0 + t, cz0],
      [cx0 + t, cz0 + 12],
      [cx0, cz0 + t],
      [cx0 + 12, cz0 + t],
    ] as const) {
      if (open && z === cz0 + 12 && (x === cx0 + 6 || x === cx0 + 7)) continue;
      v.fill({ x, y, z }, { x, y: y + 3, z }, V.bricks);
    }
  goals.push({ p: { x: cx0 + 6, y, z: cz0 + 6 }, tag: open ? 'into-compound' : 'into-closed-compound' });
  // a vault sealed in bedrock under the ground, away from the field: (a) the world closes it, whatever the rules
  const vx = fx === 10 ? 118 : 16;
  const vz = 20 + Math.floor(r() * 90);
  const vy = y - 8;
  v.fill({ x: vx - 1, y: vy - 1, z: vz - 1 }, { x: vx + 3, y: vy + 2, z: vz + 3 }, V.bedrock);
  v.fill({ x: vx, y: vy, z: vz }, { x: vx + 2, y: vy + 1, z: vz + 2 }, V.air);
  goals.push({ p: { x: vx + 1, y: vy, z: vz + 1 }, tag: 'into-vault' });
  // free-standing walls of cobblestone across the open ground
  for (let k = 0; k < 3; k++) {
    const wx = 10 + Math.floor(r() * 124);
    const wz = 10 + Math.floor(r() * 124);
    const along = r() < 0.5;
    const len = 8 + Math.floor(r() * 20);
    for (let t = 0; t < len; t++) {
      const x = along ? wx + t : wx;
      const z = along ? wz : wz + t;
      const top = v.top(x, z);
      if (top > MIN_Y) v.fill({ x, y: top + 1, z }, { x, y: top + 3, z }, V.cobble);
    }
  }
  const pairs: BenchPair[] = [];
  for (const g of goals) {
    addPair(pairs, surfaceNear(v, r, g.p, 15, 45), g.p, g.tag);
  }
  for (let i = 0; i < 6; i++) {
    const s = surfacePoint(v, r);
    addPair(pairs, s, s && surfaceNear(v, r, s, 15, 60), 'builds');
  }
  return { cls: 'builds', seed, vox: v, home, protectRadius, loadRadius: 6, coarse: true, pairs };
}

function pits(seed: number): BenchWorld {
  const r = rng(seed);
  const v = new Vox(144, 144);
  terrain(v, heightField(seed, 5, 12), r);
  const bottoms: { p: Vec3; tag: string }[] = [];
  const tops: { p: Vec3; tag: string }[] = [];
  for (let k = 0; k < 6; k++) {
    const p = surfacePoint(v, r, { x0: 12, z0: 12, x1: 130, z1: 130 });
    if (!p) continue;
    const s = 1 + Math.floor(r() * 3);
    const depth = 4 + Math.floor(r() * 26);
    const t = p.y - 1;
    for (let dz = 0; dz < s; dz++) for (let dx = 0; dx < s; dx++) for (let yy = t - depth + 1; yy <= t + 6; yy++) v.set(p.x + dx, yy, p.z + dz, V.air);
    // water at the bottom of some (a safe landing the planner will not take for a long fall)
    if (r() < 0.25) v.set(p.x, t - depth + 1, p.z, V.water);
    // (the goal on a water bottom is the water cell: a block goal in water is reached swimming in it)
    bottoms.push({ p: { x: p.x, y: t - depth + 1, z: p.z }, tag: `pit${s}x${s}-${depth}` });
  }
  for (let k = 0; k < 5; k++) {
    const p = surfacePoint(v, r, { x0: 12, z0: 12, x1: 130, z1: 130 });
    if (!p) continue;
    const s = 1 + Math.floor(r() * 3);
    const hgt = 2 + Math.floor(r() * 11);
    const stairs = r() < 0.4;
    for (let dz = 0; dz < s; dz++) for (let dx = 0; dx < s; dx++) v.fill({ x: p.x + dx, y: p.y, z: p.z + dz }, { x: p.x + dx, y: p.y + hgt - 1, z: p.z + dz }, V.stone);
    if (stairs) for (let i = 0; i < hgt - 1; i++) v.fill({ x: p.x - 1 - i, y: p.y, z: p.z }, { x: p.x - 1 - i, y: p.y + hgt - 2 - i, z: p.z }, V.stone);
    tops.push({ p: { x: p.x, y: p.y + hgt, z: p.z }, tag: `tower${s}x${s}-${hgt}${stairs ? '-stairs' : ''}` });
  }
  const pairs: BenchPair[] = [];
  for (const b of bottoms) addPair(pairs, surfaceNear(v, r, b.p, 8, 30), b.p, b.tag);
  for (const b of bottoms.slice(0, 3)) addPair(pairs, b.p, surfaceNear(v, r, b.p, 8, 30), `out-of-${b.tag}`);
  for (const t of tops) addPair(pairs, surfaceNear(v, r, t.p, 8, 30), t.p, t.tag);
  for (const t of tops.slice(0, 2)) addPair(pairs, t.p, surfaceNear(v, r, t.p, 8, 30), `off-${t.tag}`);
  return { cls: 'pits', seed, vox: v, loadRadius: 6, coarse: true, pairs };
}

function unknown(seed: number): BenchWorld {
  const r = rng(seed);
  const v = new Vox(400, 400);
  const base = heightField(seed, 12, 8);
  const h = (x: number, z: number): number => base(x, z) + (noise(seed + 5, x, z, 90) > 0.6 ? 6 : 0);
  terrain(v, h, r);
  // a few walls and cliffs out there the bot cannot see at the start
  for (let k = 0; k < 6; k++) {
    const wx = Math.floor(r() * 380);
    const wz = Math.floor(r() * 380);
    const along = r() < 0.5;
    for (let t = 0; t < 40; t++) {
      const x = along ? wx + t : wx;
      const z = along ? wz : wz + t;
      const top = v.top(x, z);
      if (top > MIN_Y) v.fill({ x, y: top + 1, z }, { x, y: top + 4, z }, V.stone);
    }
  }
  const pairs: BenchPair[] = [];
  for (let i = 0; i < 18; i++) {
    const s = surfacePoint(v, r, { x0: 100, z0: 100, x1: 300, z1: 300 });
    addPair(pairs, s, s && surfaceNear(v, r, s, 100, 180), 'unloaded-goal');
  }
  return { cls: 'unknown', seed, vox: v, loadRadius: 4, coarse: false, pairs };
}

function long(seed: number): BenchWorld {
  const r = rng(seed);
  const v = new Vox(448, 448);
  const base = heightField(seed, 14, 10);
  const ex = 120 + Math.floor(r() * 200);
  const h = (x: number, z: number): number => base(x, z) + (x > ex + Math.round(10 * Math.sin(z / 23)) ? 9 : 0);
  terrain(v, h, r);
  // a river across, a ravine across, a long wall
  const rz = 100 + Math.floor(r() * 250);
  for (let x = 0; x < v.sx; x++)
    for (let o = -3; o <= 3; o++) {
      const z = rz + o + Math.round(6 * Math.sin(x / 19));
      const t = v.top(x, z);
      for (let y = t - 3; y <= t; y++) v.set(x, y, z, y <= t - 1 ? V.water : V.air);
    }
  const rx = 80 + Math.floor(r() * 300);
  for (let z = 0; z < v.sz; z++)
    for (let o = -2; o <= 2; o++) {
      const x = rx + o + Math.round(4 * Math.sin(z / 15));
      const t = v.top(x, z);
      for (let y = t - 18; y <= t; y++) v.set(x, y, z, V.air);
    }
  const wz = 50 + Math.floor(r() * 350);
  for (let x = 30; x < 300; x++) {
    const t = v.top(x, wz);
    if (t > MIN_Y) v.fill({ x, y: t + 1, z: wz }, { x, y: t + 4, z: wz }, V.bricks);
  }
  const pairs: BenchPair[] = [];
  for (let i = 0; i < 18; i++) {
    const s = surfacePoint(v, r, { x0: 20, z0: 20, x1: 428, z1: 428 });
    addPair(pairs, s, s && surfaceNear(v, r, s, 180, 330), 'long');
  }
  return { cls: 'long', seed, vox: v, loadRadius: 6, coarse: true, pairs };
}

const GENERATORS: Record<WorldClass, (seed: number) => BenchWorld> = { hills, ravine, caves, water, lava, builds, pits, unknown, long };

/** The world of `cls` from `seed`. */
export function benchWorld(cls: WorldClass, seed: number): BenchWorld {
  return GENERATORS[cls](seed);
}
