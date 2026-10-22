// Generated test worlds for the pathfinder and closed-loop movement tests: a dense box of blocks
// (minecraft-data state ids, real collision shapes) that implements TerrainSource. Outside the box
// the world is "not loaded".
import type { BlockInfo, Vec3 } from '../../../src/world/types.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import type { TerrainSource } from '../../../src/skills/terrain/query.ts';

export class GenWorld implements TerrainSource {
  readonly x0: number;
  readonly z0: number;
  readonly y0: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  private readonly data: Uint16Array;
  private readonly palette: BlockInfo[] = [];
  private readonly ids = new Map<string, number>();
  private readonly listeners = new Set<(p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void>();

  constructor(from: Vec3, size: Vec3) {
    this.x0 = from.x;
    this.y0 = from.y;
    this.z0 = from.z;
    this.sx = size.x;
    this.sy = size.y;
    this.sz = size.z;
    this.data = new Uint16Array(size.x * size.y * size.z);
    this.id('air');
  }

  private id(name: string, states?: Record<string, unknown>): number {
    const key = `${name}|${JSON.stringify(states ?? {})}`;
    let i = this.ids.get(key);
    if (i === undefined) {
      i = this.palette.length;
      this.palette.push(blockInfoOf(name, states));
      this.ids.set(key, i);
    }
    return i;
  }

  private index(x: number, y: number, z: number): number {
    const lx = x - this.x0;
    const ly = y - this.y0;
    const lz = z - this.z0;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) return -1;
    return (ly * this.sz + lz) * this.sx + lx;
  }

  /** Highest / lowest y of the box (the planner's sky scan range). */
  get maxY(): number {
    return this.y0 + this.sy - 1;
  }

  get minY(): number {
    return this.y0;
  }

  blockAt(x: number, y: number, z: number): BlockInfo | undefined {
    const i = this.index(x, y, z);
    if (i < 0) return undefined;
    return this.palette[this.data[i]!];
  }

  /** The BlockInfo of a state id used in this world. */
  infoOf(stateId: number): BlockInfo | undefined {
    return this.palette.find((b) => b.stateId === stateId);
  }

  /** Set a block (no event). */
  put(x: number, y: number, z: number, name: string, states?: Record<string, unknown>): void {
    const i = this.index(x, y, z);
    if (i < 0) throw new Error(`outside the world: ${x} ${y} ${z}`);
    this.data[i] = this.id(name, states);
  }

  /** Fill an inclusive box (no events). */
  fill(a: Vec3, b: Vec3, name: string, states?: Record<string, unknown>): void {
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++)
      for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++)
        for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) this.put(x, y, z, name, states);
  }

  /** Set a block and fire onBlockUpdate (like an update_block packet). */
  set(x: number, y: number, z: number, name: string, states?: Record<string, unknown>): void {
    const before = this.blockAt(x, y, z);
    this.put(x, y, z, name, states);
    const after = this.blockAt(x, y, z)!;
    for (const fn of [...this.listeners]) fn({ x, y, z }, before, after);
  }

  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** A BDS-like flat world: bedrock -64, dirt -63..-62, grass -61; air above. */
export function flatGen(from: Vec3 = { x: -64, y: -64, z: -64 }, size: Vec3 = { x: 128, y: 24, z: 128 }): GenWorld {
  const w = new GenWorld(from, size);
  const x1 = from.x + size.x - 1;
  const z1 = from.z + size.z - 1;
  w.fill({ x: from.x, y: -64, z: from.z }, { x: x1, y: -64, z: z1 }, 'bedrock');
  w.fill({ x: from.x, y: -63, z: from.z }, { x: x1, y: -62, z: z1 }, 'dirt');
  w.fill({ x: from.x, y: -61, z: from.z }, { x: x1, y: -61, z: z1 }, 'grass_block');
  return w;
}

/** Deterministic PRNG (mulberry32). */
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

/**
 * Hilly terrain: a smooth value-noise height field (grass top between y -61 and -49, so 1-block
 * terraces and 2..4-block cliffs), water in the low spots, oak trees with leaves, slabs on some
 * terrace edges. Size 128 x 128 by default, centred on (0, 0).
 */
export function hillyGen(seed: number, half = 64): GenWorld {
  const from = { x: -half, y: -64, z: -half };
  const size = { x: 2 * half, y: 32, z: 2 * half };
  const w = new GenWorld(from, size);
  const r = rng(seed);
  const cell = 16;
  const n = (2 * half) / cell + 2;
  const grid: number[] = [];
  for (let i = 0; i < n * n; i++) grid.push(r());
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, z: number): number => {
    const gx = (x + half) / cell;
    const gz = (z + half) / cell;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = smooth(gx - ix);
    const fz = smooth(gz - iz);
    const v = (a: number, b: number) => grid[(iz + b) * n + (ix + a)]!;
    return (v(0, 0) * (1 - fx) + v(1, 0) * fx) * (1 - fz) + (v(0, 1) * (1 - fx) + v(1, 1) * fx) * fz;
  };
  const heights = new Int16Array(size.x * size.z);
  for (let z = -half; z < half; z++) {
    for (let x = -half; x < half; x++) {
      const h = -61 + Math.round(noise(x, z) * 12 + (r() < 0.02 ? 1 : 0));
      heights[(z + half) * size.x + (x + half)] = h;
      w.put(x, -64, z, 'bedrock');
      for (let y = -63; y < h; y++) w.put(x, y, z, y < h - 3 ? 'stone' : 'dirt');
      w.put(x, h, z, 'grass_block');
    }
  }
  const H = (x: number, z: number) => heights[(z + half) * size.x + (x + half)]!;
  // water in low spots
  const waterLevel = -58;
  for (let z = -half; z < half; z++) for (let x = -half; x < half; x++) for (let y = H(x, z) + 1; y <= waterLevel; y++) w.put(x, y, z, 'water');
  // slabs on some terrace edges (a step of 1 becomes two half steps)
  for (let i = 0; i < 300; i++) {
    const x = -half + 1 + Math.floor(r() * (2 * half - 2));
    const z = -half + 1 + Math.floor(r() * (2 * half - 2));
    const h = H(x, z);
    if (h <= waterLevel) continue;
    if ([H(x + 1, z), H(x - 1, z), H(x, z + 1), H(x, z - 1)].some((o) => o === h + 1)) w.put(x, h + 1, z, 'oak_slab');
  }
  // trees
  for (let i = 0; i < 40; i++) {
    const x = -half + 3 + Math.floor(r() * (2 * half - 6));
    const z = -half + 3 + Math.floor(r() * (2 * half - 6));
    const h = H(x, z);
    if (h <= waterLevel || h + 7 >= from.y + size.y) continue;
    for (let y = h + 3; y <= h + 6; y++) {
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dz) <= (y > h + 4 ? 2 : 3)) w.put(x + dx, y, z + dz, 'oak_leaves');
    }
    for (let y = h + 1; y <= h + 5; y++) w.put(x, y, z, 'oak_log');
  }
  return w;
}

/** Feet height of the highest standable surface in a column (grass, slab ...), or undefined (water). */
export function surfaceFeet(w: GenWorld, x: number, z: number): number | undefined {
  for (let y = w.y0 + w.sy - 1; y >= w.y0; y--) {
    const b = w.blockAt(x, y, z);
    if (!b || b.name === 'air') continue;
    if (b.name === 'water') return undefined;
    if (b.name.endsWith('_leaves') || b.name.endsWith('_log')) return undefined;
    const top = Math.max(...b.boxes.map((bx) => bx[4]));
    return y + top;
  }
  return undefined;
}
