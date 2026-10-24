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
//
// Persistence (Track Z, docs/mining.md "Ore memory across restarts"): with a world cache attached
// (`world.cache`, world/cache) every recorded ore also flags its cache mark as `seen` (flags bit 1 of
// the region record), so the record survives a restart; `recall(origin, radius)` (called by every
// `scan`) brings the remembered ones back without seeing them again. `scanMarks` is the cheap passive
// scan over the cache's marks of the loaded columns (same exposure rule), run by the mine controller
// every few seconds so ores the bot merely walks past are remembered too.
import type { CachedMark } from '../../world/cache/types.ts';
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
  /**
   * How it was first seen (`cache`: remembered from the world cache, e.g. before a restart; `known`:
   * never seen, found buried or as a cache mark, a target only with `mineSeenOnly` off).
   */
  how: 'scan' | 'update' | 'dug' | 'cache' | 'known';
  /** A `known` block of an unloaded column (the world cache's mark). */
  cached?: boolean;
  /** Sequence number (insertion order). */
  n: number;
}

export interface OreWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  find(pred: (b: BlockInfo, p: Vec3) => boolean, o: { origin: Vec3; radius: number; max: number }): Vec3[];
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
  /** The world cache (World.cache), read at call time: persistence of the seen records. */
  readonly cache?: OreCache | undefined;
}

/** What the memory uses of the world cache (WorldCache satisfies it). */
export interface OreCache {
  markSeen?(p: Vec3, name: string): boolean;
  seenMarks?(origin: Vec3, radius: number): CachedMark[];
  loadedMarks?(origin: Vec3, radius: number): CachedMark[];
}

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

/** Remembered (cached) records are recalled within this radius of the bot at every scan (blocks). */
export const RECALL_RADIUS = 96;

export class OreMemory {
  private readonly world: OreWorld;
  private readonly seen = new Map<string, SeenOre>();
  /** Track Z: interesting blocks of the last scan that were not seen (buried / cached marks). */
  private readonly known = new Map<string, SeenOre>();
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
    // persist (Track Z): flag the cache mark; a remembered record is already flagged. A block update
    // may reach the memory before the cache has the mark: such records are retried by scanMarks.
    if (how !== 'cache') this.persist(k);
    return true;
  }

  private persist(k: string): void {
    const o = this.seen.get(k);
    const c = this.world.cache;
    if (!o || !c?.markSeen) return;
    if (c.markSeen(o.p, o.name)) {
      this.persisted++;
      this.unpersisted.delete(k);
    } else this.unpersisted.add(k);
  }

  /** Records whose cache mark was not there yet (retried by scanMarks). */
  private readonly unpersisted = new Set<string>();

  /** Records flagged in the world cache by this memory (persisted for the next start). */
  persisted = 0;
  /** Records brought back from the world cache (seen before, e.g. before a restart). */
  recalled = 0;
  lastRecallMs = 0;

  /**
   * Bring back the records the world cache remembers within `radius` of `origin` (seen before, also
   * by an earlier process). A loaded position whose block is something else now is skipped (the
   * cache mark is gone with the block anyway). Returns how many were new.
   */
  recall(origin: Vec3, radius: number): number {
    const marks = this.world.cache?.seenMarks?.(origin, radius);
    if (!marks) return 0;
    const t0 = performance.now();
    let added = 0;
    for (const m of marks) {
      if (!this.interesting(m.name)) continue;
      const p = { x: m.x, y: m.y, z: m.z };
      const b = this.world.blockAt(p);
      if (b && b.name !== m.name) continue;
      if (this.add(p, m.name, 'cache')) added++;
    }
    this.recalled += added;
    this.lastRecallMs = performance.now() - t0;
    return added;
  }

  /**
   * Passive scan (cheap): the world cache's marks of the loaded columns within `radius`, recorded
   * when exposed (the same rule as `scan`). Without a cache it does nothing (returns -1).
   */
  scanMarks(origin: Vec3, radius: number): number {
    const marks = this.world.cache?.loadedMarks?.(origin, radius);
    if (!marks) return -1;
    const t0 = performance.now();
    for (const k of [...this.unpersisted]) this.persist(k);
    const blockAt = (p: Vec3) => this.world.blockAt(p);
    let added = 0;
    for (const m of marks) {
      if (!this.interesting(m.name)) continue;
      const p = { x: m.x, y: m.y, z: m.z };
      if (this.seen.get(key(p))?.name === m.name) continue;
      if (blockAt(p)?.name !== m.name || !isExposed(blockAt, p)) continue;
      if (this.add(p, m.name, 'scan')) added++;
    }
    this.lastScanMarksMs = performance.now() - t0;
    return added;
  }

  lastScanMarksMs = 0;

  /** Record every exposed interesting block in the loaded chunks within `radius` of `origin` (and recall the cache's). */
  scan(origin: Vec3, radius: number): number {
    const t0 = performance.now();
    this.recall(origin, Math.max(radius, RECALL_RADIUS));
    const blockAt = (p: Vec3) => this.world.blockAt(p);
    let added = 0;
    let buried = 0;
    // World.find also returns the world cache's marks of unloaded columns (flagged `cached`): names by position
    const names = new Map<string, string>();
    const found = this.world.find(
      (b, p) => {
        if (!this.interesting(b.name)) return false;
        names.set(key(p), b.name);
        return true;
      },
      { origin, radius, max: 100_000 },
    );
    this.known.clear();
    for (const p of found) {
      const b = blockAt(p);
      if (!b) {
        // Track Z: remembered by the cache, not loaded now: known, never seen from here
        const name = names.get(key(p));
        if (name && !this.seen.has(key(p))) this.known.set(key(p), { p: { x: p.x, y: p.y, z: p.z }, name, how: 'known', n: ++this.n, cached: true });
        continue;
      }
      if (isExposed(blockAt, p)) {
        if (this.add(p, b.name, 'scan')) added++;
      } else if (!this.seen.has(key(p))) {
        buried++;
        this.known.set(key(p), { p: { x: p.x, y: p.y, z: p.z }, name: b.name, how: 'known', n: ++this.n });
      }
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
  targets(names: ReadonlySet<string>, origin: Vec3, opts: { seenOnly?: boolean } = {}): SeenOre[] {
    const out: { o: SeenOre; d: number }[] = [];
    const dist = (o: SeenOre) => Math.hypot(o.p.x + 0.5 - origin.x, o.p.y + 0.5 - origin.y, o.p.z + 0.5 - origin.z);
    for (const [k, o] of this.seen) {
      if (!names.has(o.name)) continue;
      const b = this.world.blockAt(o.p);
      if (!b) continue;
      if (b.name !== o.name) {
        this.seen.delete(k);
        continue;
      }
      out.push({ o, d: dist(o) });
    }
    // Track Z (`mineSeenOnly` off): every known block of the names too, buried or remembered by the cache
    if (opts.seenOnly === false) {
      for (const [k, o] of this.known) {
        if (!names.has(o.name) || this.seen.has(k)) continue;
        const b = this.world.blockAt(o.p);
        if (b ? b.name !== o.name : !o.cached) continue;
        out.push({ o, d: dist(o) });
      }
    }
    return out.sort((a, b) => a.d - b.d || a.o.n - b.o.n).map((x) => x.o);
  }

  /** Track Z: matching blocks the last scan found that were never seen (buried, or remembered by the cache). */
  get knownCount(): number {
    return this.known.size;
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
