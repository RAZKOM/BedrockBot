// find() with a per-section index for the log, leaves and chest classes (PLAN.md task 2.6).
// The index holds section-local positions per class; it is rebuilt when a section is decoded and
// kept current by single-block updates.
import type { ChunkStore, Column } from './chunks.ts';
import type { BlockRegistry } from './registry.ts';
import type { Section } from './subchunk.ts';
import type { BlockClass, BlockInfo, FindOptions, Vec3 } from './types.ts';
import type { CachedTerrain, FoundPos } from './cache/types.ts'; // Track T

export const BLOCK_CLASSES: readonly BlockClass[] = ['log', 'leaves', 'chest'];

/** Natural (unstripped) logs and stems, any leaves, chests and trapped chests. */
export function classify(name: string): BlockClass | undefined {
  if (name.endsWith('_log') && !name.startsWith('stripped_')) return 'log';
  if (name.endsWith('_leaves')) return 'leaves';
  if (name === 'chest' || name === 'trapped_chest') return 'chest';
  return undefined;
}

type SectionIndex = Partial<Record<BlockClass, Set<number>>>;

const colKey = (cx: number, cz: number) => `${cx},${cz}`;

export class BlockFinder {
  private readonly store: ChunkStore;
  private readonly registry: BlockRegistry;
  /** column key -> relative section index -> class -> local indices */
  private readonly index = new Map<string, Map<number, SectionIndex>>();
  /** state id -> class (null = none); -1 (unknown) is never classified. */
  private readonly classCache = new Map<number, BlockClass | null>();
  /** Track T: the world cache (set by WorldCache.attach); find() adds its marks for unloaded columns. */
  cache: (CachedTerrain & { markInfo?(name: string): BlockInfo | undefined }) | undefined;

  constructor(store: ChunkStore, registry: BlockRegistry) {
    this.store = store;
    this.registry = registry;
    store.onSection((col, rel) => {
      this.indexSection(col, rel);
    });
    store.onColumnUnloaded((cx, cz) => this.index.delete(colKey(cx, cz)));
    store.onBlockSet((col, rel, i, before, after) => {
      this.updateBlock(col, rel, i, before, after);
    });
  }

  classOf(stateId: number): BlockClass | undefined {
    if (stateId < 0) return undefined;
    let c = this.classCache.get(stateId);
    if (c === undefined) {
      c = classify(this.registry.nameOf(stateId) ?? '') ?? null;
      this.classCache.set(stateId, c);
    }
    return c ?? undefined;
  }

  /** Number of indexed positions of a class (all columns). */
  count(cls: BlockClass): number {
    let n = 0;
    for (const secs of this.index.values()) for (const si of secs.values()) n += si[cls]?.size ?? 0;
    return n;
  }

  private indexSection(col: Column, rel: number): void {
    const k = colKey(col.cx, col.cz);
    let secs = this.index.get(k);
    secs?.delete(rel);
    const sec = col.sections[rel];
    if (!sec) return;
    const l = sec.layers[0];
    if (!l) return;
    // Which palette entries are interesting?
    const cls: (BlockClass | undefined)[] = [];
    let any = false;
    for (let p = 0; p < l.size; p++) {
      const c = this.classOf(l.palette[p]!);
      cls.push(c);
      if (c) any = true;
    }
    if (!any) return;
    const si: SectionIndex = {};
    for (let i = 0; i < 4096; i++) {
      const c = cls[l.index ? l.index[i]! : 0];
      if (!c) continue;
      (si[c] ??= new Set()).add(i);
    }
    if (!secs) {
      secs = new Map();
      this.index.set(k, secs);
    }
    secs.set(rel, si);
  }

  private updateBlock(col: Column, rel: number, i: number, before: number, after: number): void {
    const cb = this.classOf(before);
    const ca = this.classOf(after);
    if (cb === ca) return;
    const k = colKey(col.cx, col.cz);
    let secs = this.index.get(k);
    if (cb) secs?.get(rel)?.[cb]?.delete(i);
    if (ca) {
      if (!secs) {
        secs = new Map();
        this.index.set(k, secs);
      }
      let si = secs.get(rel);
      if (!si) {
        si = {};
        secs.set(rel, si);
      }
      (si[ca] ??= new Set()).add(i);
    }
  }

  /**
   * Positions (block corners) within `radius` of `origin` whose block satisfies `pred`, closest first,
   * at most `max`. Air is never matched. With `opts.class` only that class's indexed positions are
   * visited; otherwise every non-air block of the loaded sections in range is.
   */
  find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: FindOptions & { cached?: boolean }): FoundPos[] {
    const { origin, radius, max } = opts;
    if (max <= 0 || radius < 0) return [];
    const cache = opts.cached === false ? undefined : this.cache; // Track T
    const r2 = radius * radius;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const minCX = Math.floor((ox - radius) / 16);
    const maxCX = Math.floor((ox + radius) / 16);
    const minCZ = Math.floor((oz - radius) / 16);
    const maxCZ = Math.floor((oz + radius) / 16);
    const minSY = Math.floor((oy - radius) / 16);
    const maxSY = Math.floor((oy + radius) / 16);
    const found: { p: Vec3; d: number }[] = [];
    const air = this.registry.airStateId;

    const consider = (x: number, y: number, z: number, info: BlockInfo) => {
      const dx = x + 0.5 - ox;
      const dy = y + 0.5 - oy;
      const dz = z + 0.5 - oz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) return;
      const p = { x, y, z };
      if (pred(info, p)) found.push({ p, d });
    };

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        const col = this.store.column(cx, cz);
        if (!col?.loaded) {
          // Track T: remembered marks of unloaded columns (world/cache), flagged `cached`
          if (cache) {
            for (const m of cache.marks(cx, cz)) {
              if (m.y < oy - radius - 1 || m.y > oy + radius + 1 || (opts.class && classify(m.name) !== opts.class)) continue;
              const info = cache.markInfo?.(m.name);
              const n = found.length;
              if (info) consider(m.x, m.y, m.z, info);
              if (found.length > n) (found[n]!.p as FoundPos).cached = true;
            }
          }
          continue;
        }
        const bx = cx << 4;
        const bz = cz << 4;
        const lo = Math.max(minSY - col.minCY, 0);
        const hi = Math.min(maxSY - col.minCY, col.sections.length - 1);
        if (opts.class) {
          const secs = this.index.get(colKey(cx, cz));
          if (!secs) continue;
          for (const [rel, si] of secs) {
            if (rel < lo || rel > hi) continue;
            const set = si[opts.class];
            if (!set) continue;
            const sec = col.sections[rel];
            if (!sec) continue;
            const by = (col.minCY + rel) << 4;
            const l = sec.layers[0]!;
            for (const i of set) {
              const s = l.stateAt(i);
              consider(bx + (i >> 8), by + (i & 15), bz + ((i >> 4) & 15), this.registry.blockInfo(s, l.runtimeIdAt(i)));
            }
          }
        } else {
          for (let rel = lo; rel <= hi; rel++) {
            const sec = col.sections[rel];
            if (!sec) continue;
            this.scanSection(sec, bx, (col.minCY + rel) << 4, bz, air, consider);
          }
        }
      }
    }
    found.sort((a, b) => a.d - b.d);
    return found.slice(0, max).map((f) => f.p);
  }

  private scanSection(
    sec: Section,
    bx: number,
    by: number,
    bz: number,
    air: number,
    consider: (x: number, y: number, z: number, info: BlockInfo) => void,
  ): void {
    const l = sec.layers[0];
    if (!l) return;
    const infos: (BlockInfo | null)[] = [];
    for (let p = 0; p < l.size; p++) {
      const s = l.palette[p]!;
      infos.push(s === air ? null : this.registry.blockInfo(s, l.runtimeIds[p]));
    }
    const idx = l.index;
    if (!idx) {
      const info = infos[0];
      if (!info) return;
      for (let i = 0; i < 4096; i++) consider(bx + (i >> 8), by + (i & 15), bz + ((i >> 4) & 15), info);
      return;
    }
    for (let i = 0; i < 4096; i++) {
      const info = infos[idx[i]!];
      if (info) consider(bx + (i >> 8), by + (i & 15), bz + ((i >> 4) & 15), info);
    }
  }
}

// ---- Track Z: log clusters (remembered or loaded forests) for the gather task ------------------------

/** A group of logs no farther than `link` blocks from each other (a forest, a grove, a lone tree). */
export interface LogCluster {
  /** Mean position of the logs (block corner coordinates). */
  center: Vec3;
  /** The logs, nearest to the search origin first. */
  logs: FoundPos[];
  /** Logs remembered by the world cache (unloaded columns). */
  cached: number;
  /** Distance from the search origin to the nearest log. */
  distance: number;
}

/**
 * Group logs into clusters (single link: two logs within `link` blocks of each other on every axis
 * are in the same cluster), nearest to `origin` first. Grid-hashed: about linear in the logs.
 */
export function logClusters(logs: readonly FoundPos[], origin: Vec3, link = 6): LogCluster[] {
  const parent = logs.map((_, i) => i);
  const root = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[i] !== r) {
      const next = parent[i]!;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const cell = (v: number) => Math.floor(v / link);
  const grid = new Map<string, number[]>();
  logs.forEach((p, i) => {
    const k = `${cell(p.x)},${cell(p.y)},${cell(p.z)}`;
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  logs.forEach((p, i) => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of grid.get(`${cell(p.x) + dx},${cell(p.y) + dy},${cell(p.z) + dz}`) ?? []) {
            if (j <= i) continue;
            const q = logs[j]!;
            if (Math.abs(q.x - p.x) <= link && Math.abs(q.y - p.y) <= link && Math.abs(q.z - p.z) <= link) parent[root(j)] = root(i);
          }
        }
  });
  const groups = new Map<number, FoundPos[]>();
  logs.forEach((p, i) => {
    const r = root(i);
    const g = groups.get(r);
    if (g) g.push(p);
    else groups.set(r, [p]);
  });
  const dist = (p: Vec3) => Math.hypot(p.x + 0.5 - origin.x, p.y + 0.5 - origin.y, p.z + 0.5 - origin.z);
  const out: LogCluster[] = [];
  for (const g of groups.values()) {
    const n = g.length;
    const center = { x: g.reduce((a, p) => a + p.x, 0) / n, y: g.reduce((a, p) => a + p.y, 0) / n, z: g.reduce((a, p) => a + p.z, 0) / n };
    const sorted = [...g].sort((a, b) => dist(a) - dist(b));
    out.push({ center, logs: sorted, cached: g.filter((p) => p.cached).length, distance: dist(sorted[0]!) });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/**
 * Log clusters within `radius` of `origin` from World.find: loaded logs and, with a world cache,
 * remembered logs of unloaded columns (flagged `cached`). Logs for which `skip` is true (Track R's
 * blacklist) are left out.
 */
export function findLogClusters(
  world: { find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: FindOptions & { cached?: boolean }): FoundPos[] },
  origin: Vec3,
  radius: number,
  opts: { skip?: (p: Vec3) => boolean; link?: number; maxLogs?: number; maxBelow?: number; maxAbove?: number } = {},
): LogCluster[] {
  const logs = world.find((b) => classify(b.name) === 'log', { origin, radius, max: opts.maxLogs ?? 4096, class: 'log' });
  const skip = opts.skip;
  // a vertical window: logs deep below (ancient cities, mineshafts: measured at y -10 under a y 64 start) are no forest
  const lo = origin.y - (opts.maxBelow ?? Infinity);
  const hi = origin.y + (opts.maxAbove ?? Infinity);
  return logClusters(
    logs.filter((p) => p.y >= lo && p.y <= hi && !skip?.(p)),
    origin,
    opts.link ?? 6,
  );
}
