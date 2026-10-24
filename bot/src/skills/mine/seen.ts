// Ore memory for legit mining (PLAN.md task 7.14, docs/mining.md). BDS sends every block of a loaded
// chunk, buried ores included (no anti-xray), so "legit" is a rule the bot keeps itself:
//
//   exposure  a block is SEEN when at least one of its 6 neighbours is loaded and open (no collision
//             box and not a liquid: air, cave air, torches, plants ...), i.e. a player could see one
//             of its faces from somewhere. A block whose 6 neighbours are all solid (or unloaded, or
//             liquid) is BURIED and never recorded, so never a target.
//   sources   (1) `scan(origin, radius)`: World.find over the loaded chunks; (2) block updates: a
//             cell that becomes open (the bot dug it, a block was removed) exposes its neighbours,
//             and a block placed next to an open cell is exposed; (3) `noteDug(p)` after own digs.
//   memory    a seen position stays seen while the block there is still the same (also after its
//             chunk unloads); when the world model shows another block there it is forgotten.
//
// Limits (documented): exposure is not visibility. An ore facing a sealed air pocket inside the rock
// counts as seen although no player could have looked into the pocket; a line-of-sight test from
// the bot's eye would be stricter but would forget ores the bot walked past. The miner digs its way
// to an ore only through blocks on the line of sight (see lineOfSight), so it never digs into rock
// towards an ore it has not got a face of.
import type { BlockInfo, Vec3 } from '../../world/types.ts';

export const LIQUIDS: ReadonlySet<string> = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);

/** Ores the memory records even when no `!mine` asks for them (ore memory). */
export function isOreName(name: string): boolean {
  return name.endsWith('_ore') || name === 'ancient_debris';
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** A cell a face can be seen through: loaded, no collision box, not a liquid, not an unresolved block. */
export function isOpen(b: BlockInfo | undefined): boolean {
  return !!b && b.name !== 'unknown' && b.boxes.length === 0 && !LIQUIDS.has(b.name);
}

/** The open neighbours of `p` (the faces of `p` a player could see). */
export function openFaces(blockAt: (p: Vec3) => BlockInfo | undefined, p: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const n = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
    if (isOpen(blockAt(n))) out.push(n);
  }
  return out;
}

export function isExposed(blockAt: (p: Vec3) => BlockInfo | undefined, p: Vec3): boolean {
  return openFaces(blockAt, p).length > 0;
}

export interface SeenOre {
  p: Vec3;
  name: string;
  /** How it was first seen. */
  how: 'scan' | 'update' | 'dug';
  /** Sequence number (insertion order). */
  n: number;
}

export interface OreWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  find(pred: (b: BlockInfo, p: Vec3) => boolean, o: { origin: Vec3; radius: number; max: number }): Vec3[];
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
}

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

export class OreMemory {
  private readonly world: OreWorld;
  private readonly seen = new Map<string, SeenOre>();
  /** Names recorded besides ores (the blocks a running !mine asks for). */
  private readonly extra = new Set<string>();
  private n = 0;
  private readonly off: () => void;
  /** Interesting blocks the last scan found buried (not recorded). */
  lastBuried = 0;
  lastScanMs = 0;

  constructor(world: OreWorld) {
    this.world = world;
    this.off = world.onBlockUpdate((p, _before, after) => {
      this.onUpdate(p, after);
    });
  }

  dispose(): void {
    this.off();
  }

  /** Record `names` too (e.g. `!mine stone`), not just ores. */
  watch(names: Iterable<string>): void {
    for (const n of names) this.extra.add(n);
  }

  interesting(name: string): boolean {
    return isOreName(name) || this.extra.has(name);
  }

  get size(): number {
    return this.seen.size;
  }

  has(p: Vec3): boolean {
    return this.seen.has(key(p));
  }

  all(): SeenOre[] {
    return [...this.seen.values()];
  }

  private add(p: Vec3, name: string, how: SeenOre['how']): boolean {
    const k = key(p);
    const cur = this.seen.get(k);
    if (cur?.name === name) return false;
    this.seen.set(k, { p: { x: p.x, y: p.y, z: p.z }, name, how, n: ++this.n });
    return true;
  }

  /** Record every exposed interesting block in the loaded chunks within `radius` of `origin`. */
  scan(origin: Vec3, radius: number): number {
    const t0 = performance.now();
    const blockAt = (p: Vec3) => this.world.blockAt(p);
    let added = 0;
    let buried = 0;
    const found = this.world.find((b) => this.interesting(b.name), { origin, radius, max: 100_000 });
    for (const p of found) {
      const b = blockAt(p);
      if (!b) continue;
      if (isExposed(blockAt, p)) {
        if (this.add(p, b.name, 'scan')) added++;
      } else if (!this.seen.has(key(p))) buried++;
    }
    this.lastBuried = buried;
    this.lastScanMs = performance.now() - t0;
    return added;
  }

  /** The bot broke the block at `p`: its neighbours now have an open face. */
  noteDug(p: Vec3): void {
    this.exposeAround(p, 'dug');
  }

  private exposeAround(p: Vec3, how: SeenOre['how']): void {
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const n = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
      const b = this.world.blockAt(n);
      if (b && this.interesting(b.name)) this.add(n, b.name, how);
    }
  }

  private onUpdate(p: Vec3, after: BlockInfo): void {
    const k = key(p);
    const cur = this.seen.get(k);
    if (cur && cur.name !== after.name) this.seen.delete(k);
    if (isOpen(after)) this.exposeAround(p, 'update');
    else if (this.interesting(after.name) && isExposed((q) => this.world.blockAt(q), p)) this.add(p, after.name, 'update');
  }

  /**
   * Seen blocks named in `names`, nearest to `origin` first. Positions whose loaded block is now
   * something else are forgotten; unloaded ones are left out (but remembered).
   */
  targets(names: ReadonlySet<string>, origin: Vec3): SeenOre[] {
    const out: { o: SeenOre; d: number }[] = [];
    for (const [k, o] of this.seen) {
      if (!names.has(o.name)) continue;
      const b = this.world.blockAt(o.p);
      if (!b) continue;
      if (b.name !== o.name) {
        this.seen.delete(k);
        continue;
      }
      out.push({ o, d: Math.hypot(o.p.x + 0.5 - origin.x, o.p.y + 0.5 - origin.y, o.p.z + 0.5 - origin.z) });
    }
    return out.sort((a, b) => a.d - b.d || a.o.n - b.o.n).map((x) => x.o);
  }
}

// ---- line of sight ------------------------------------------------------------------------------

export interface SightResult {
  /** A ray from the eye reaches the target block before any other block with a collision box. */
  clear: boolean;
  /** On a blocked sight: the first solid block on the ray to the target's centre. */
  blocker?: Vec3;
}

/** First cell with a collision box (or a liquid) on the segment a -> b, other than `target`; voxel walk. */
export function firstHit(blockAt: (p: Vec3) => BlockInfo | undefined, a: Vec3, b: Vec3, target: Vec3): Vec3 | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  let x = Math.floor(a.x);
  let y = Math.floor(a.y);
  let z = Math.floor(a.z);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const sz = Math.sign(dz);
  const tdx = sx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = sy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = sz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tx = sx > 0 ? (x + 1 - a.x) * tdx : sx < 0 ? (a.x - x) * tdx : Infinity;
  let ty = sy > 0 ? (y + 1 - a.y) * tdy : sy < 0 ? (a.y - y) * tdy : Infinity;
  let tz = sz > 0 ? (z + 1 - a.z) * tdz : sz < 0 ? (a.z - z) * tdz : Infinity;
  for (let i = 0; i < 64; i++) {
    if (x === target.x && y === target.y && z === target.z) return undefined;
    if (i > 0) {
      const c = blockAt({ x, y, z });
      if (!c || c.boxes.length > 0 || LIQUIDS.has(c.name)) return { x, y, z };
    }
    if (tx <= ty && tx <= tz) {
      if (tx > 1) break;
      x += sx;
      tx += tdx;
    } else if (ty <= tz) {
      if (ty > 1) break;
      y += sy;
      ty += tdy;
    } else {
      if (tz > 1) break;
      z += sz;
      tz += tdz;
    }
  }
  return undefined;
}

/**
 * Can the eye see a face of `target`? Rays to the centres of its open faces (and its centre); the
 * first that reaches the block wins. Otherwise the blocker on the ray to the nearest open face.
 */
export function lineOfSight(blockAt: (p: Vec3) => BlockInfo | undefined, eye: Vec3, target: Vec3): SightResult {
  const faces = openFaces(blockAt, target).map((n) => ({
    x: target.x + 0.5 + (n.x - target.x) * 0.499,
    y: target.y + 0.5 + (n.y - target.y) * 0.499,
    z: target.z + 0.5 + (n.z - target.z) * 0.499,
  }));
  const points = [...faces, { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }];
  points.sort((a, b) => Math.hypot(a.x - eye.x, a.y - eye.y, a.z - eye.z) - Math.hypot(b.x - eye.x, b.y - eye.y, b.z - eye.z));
  let blocker: Vec3 | undefined;
  for (const pt of points) {
    const hit = firstHit(blockAt, eye, pt, target);
    if (!hit) return { clear: true };
    blocker ??= hit;
  }
  return { clear: false, ...(blocker ? { blocker } : {}) };
}
