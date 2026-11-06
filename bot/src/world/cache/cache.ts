// Persistent world cache (PLAN.md task 7.12): remembers a compact summary of every chunk column the
// bot has seen, per server, in region files under `<config dir>/cache/<server id>/`, and serves it to
// the planner (terrain/query.ts) and the finders (find.ts) for columns that are not loaded.
//
//   load      a column that finishes loading is summarized (summary.ts) and kept "live"; if the
//             planner read stand-ins from the cache for it, the cells whose movement signature
//             differs are announced as block updates (World.onBlockUpdate), so a running goto
//             invalidates its grid and re-plans exactly as when blocks change.
//   updates   block updates of loaded columns update the live summary.
//   unload    the live summary is encoded into its region (deflated record) and kept decoded in an
//             LRU for planning; dirty live summaries are also encoded every `flushIntervalMs`.
//   disk      changed regions are written on the flush timer (async, atomic rename) and on close()
//             (sync). Regions are read lazily on the first lookup of one of their chunks.
// See docs/world-cache.md and docs/decisions/0015-world-cache.md.
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { silentLogger, type Logger } from '../../log.ts';
import type { ChunkStore, Column } from '../chunks.ts';
import type { BlockRegistry } from '../registry.ts';
import type { BlockInfo, Vec3 } from '../types.ts';
import { StateTable } from './classes.ts';
import { readRegion, regionFileName, regionMtime, regionOf, slotOf, writeRegion, writeRegionSync, RegionFormatError } from './region.ts';
import type { ChunkSummary } from './summary.ts';
import { cellKey, decodeSummary, encodeRaw, encodeSummary, summarizeColumn, type CellDiff } from './summary.ts';
import { decodeSeenMarks } from './summary.ts'; // Track Z: ore memory (seen marks)
import { HerdMarks } from './herds.ts'; // Track AF: herd marks (food v2), a sidecar of the cache dir
import { ChestMemory } from './chests.ts'; // Track AG: chest memory (home logistics), a sidecar of the cache dir
import { Y_NONE, type CachedMark, type CachedTerrain } from './types.ts';
import { roofedDimension, type SurfaceData } from './surface.ts'; // Track PC: the map's surface layer

export interface WorldCacheOptions {
  /** Directory of this server's region files (`<config dir>/cache/<server id>`). */
  dir: string;
  /** Encode dirty live summaries and write changed regions this often (ms). Default 30 000; 0 = only on unload / close. */
  flushIntervalMs?: number;
  /** Decoded summaries of unloaded columns kept in memory (LRU). Default 1024 (about 15 to 30 MB on a generated world). */
  maxChunks?: number;
  /** Regions (deflated records) kept in memory (LRU). Default 32 (a full region is about 1 to 2 MB). */
  maxRegions?: number;
  /** Map tiles (surface height and class per column, 768 bytes each) kept in memory. Default 16 384. */
  maxTiles?: number;
  /** Never write (inspection tools). */
  readOnly?: boolean;
  logger?: Logger;
}

/** What `attach` needs from the world model (`World` satisfies it). */
export interface CacheHost {
  chunks: ChunkStore;
  registry: BlockRegistry;
  updates: { emit?(p: Vec3, before: BlockInfo | undefined, after: BlockInfo): void };
  finder: { cache?: CachedTerrain | undefined };
  cache?: CachedTerrain | undefined;
}

interface Region {
  dim: number;
  rx: number;
  rz: number;
  chunks: Map<number, Uint8Array>;
  /** Slots changed since the last write. */
  changed: Set<number>;
  mtimeMs: number | undefined;
  writing: Promise<void> | undefined;
}

/** A map tile: per column the surface y (Y_NONE = nothing) and its class. */
export interface MapTile {
  cx: number;
  cz: number;
  live: boolean;
  rev: number;
  updatedAt: number;
  y: Int16Array;
  cls: Uint8Array;
  /** Track PC: the surface layer (names compacted, a copy); undefined for a record without one. */
  surf?: SurfaceData;
}

export interface WorldCacheStats {
  summarized: number;
  summarizeMs: number;
  encoded: number;
  encodeMs: number;
  /** Deflated bytes of all encodes (average record size = encodedBytes / encoded). */
  encodedBytes: number;
  /** Bytes before deflate. */
  rawBytes: number;
  decoded: number;
  decodeMs: number;
  regionReads: number;
  regionReadMs: number;
  regionWrites: number;
  regionWriteMs: number;
  regionBytesWritten: number;
  /** Planner lookups served from the cache (cells). */
  lookups: number;
  /** Columns loaded after the planner read them from the cache, and the cells announced as changed. */
  corrections: number;
  correctionCells: number;
  evictedChunks: number;
  evictedRegions: number;
  flushes: number;
  errors: number;
  /** Track Z: seen flags carried onto loading columns, and the time it took (ms). */
  seenCarried: number;
  seenCarryMs: number;
}

const OFF = 2 ** 21;
/** Numeric key of (dimension, cx, cz). */
const ckey = (dim: number, cx: number, cz: number): number => (dim * 2 ** 22 + (cx + OFF)) * 2 ** 22 + (cz + OFF);
const rkey = (dim: number, rx: number, rz: number): number => ckey(dim, rx, rz);

function touchLru<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.delete(k);
  m.set(k, v);
}

export class WorldCache implements CachedTerrain {
  readonly dir: string;
  readonly stats: WorldCacheStats = {
    summarized: 0,
    summarizeMs: 0,
    encoded: 0,
    encodeMs: 0,
    encodedBytes: 0,
    rawBytes: 0,
    decoded: 0,
    decodeMs: 0,
    regionReads: 0,
    regionReadMs: 0,
    regionWrites: 0,
    regionWriteMs: 0,
    regionBytesWritten: 0,
    lookups: 0,
    corrections: 0,
    correctionCells: 0,
    evictedChunks: 0,
    evictedRegions: 0,
    flushes: 0,
    errors: 0,
    seenCarried: 0, // Track Z
    seenCarryMs: 0,
  };
  private readonly log: Logger;
  private readonly flushIntervalMs: number;
  private readonly maxChunks: number;
  private readonly maxRegions: number;
  private readonly maxTiles: number;
  private readonly readOnly: boolean;
  private host: CacheHost | undefined;
  private table: StateTable | undefined;
  private readonly unsubs: (() => void)[] = [];
  /** Summaries of loaded columns (current dimension). */
  private readonly live = new Map<number, ChunkSummary>();
  private readonly dirtyLive = new Set<number>();
  /** Decoded summaries of unloaded columns (LRU). */
  private readonly decodedLru = new Map<number, ChunkSummary>();
  /** Regions (deflated records by slot), LRU. */
  private readonly regions = new Map<number, Region>();
  private readonly tiles = new Map<number, MapTile>();
  /** Per unloaded column, the cells (and roofs) the planner read as stand-ins since it was last loaded. */
  private readonly touched = new Map<number, { cells: Set<number>; roofCols: Set<number> }>();
  private memoKey = Number.NaN;
  private memo: ChunkSummary | undefined;
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private closed = false;
  private dimOverride: number | undefined;
  /** Track AF: herd marks (passive food mobs per 16-block cell), written with every flush. */
  readonly herds: HerdMarks;
  /** Track AG: the containers at home (chests.ts), written with every flush. */
  readonly chests: ChestMemory;

  constructor(opts: WorldCacheOptions) {
    this.dir = opts.dir;
    this.herds = new HerdMarks({ dir: opts.dir, dimension: () => this.dimension, readOnly: opts.readOnly ?? false }); // Track AF
    this.chests = new ChestMemory({ dir: opts.dir, dimension: () => this.dimension, readOnly: opts.readOnly ?? false }); // Track AG
    this.log = opts.logger ?? silentLogger;
    this.flushIntervalMs = opts.flushIntervalMs ?? 30_000;
    this.maxChunks = opts.maxChunks ?? 1024;
    this.maxRegions = opts.maxRegions ?? 32;
    this.maxTiles = opts.maxTiles ?? 16_384;
    this.readOnly = opts.readOnly ?? false;
  }

  /** The dimension lookups refer to: the attached world's, else 0 (or `useDimension`). */
  get dimension(): number {
    return this.dimOverride ?? this.host?.chunks.dimension ?? 0;
  }

  /** For tools without a world: look up this dimension. */
  useDimension(dim: number): void {
    this.dimOverride = dim;
    this.memoKey = Number.NaN;
  }

  /** Directory of a dimension's region files (the overworld directly in `dir`). */
  dimDir(dim: number): string {
    return dim === 0 ? this.dir : join(this.dir, `dim${dim}`);
  }

  // ---- wiring ------------------------------------------------------------------------------------

  /** Hooks the cache into a world model (World): chunk load / unload, sections, block updates, find, query. */
  attach(host: CacheHost): () => void {
    if (this.host) throw new Error('WorldCache is already attached');
    this.host = host;
    this.table = new StateTable(host.registry);
    const chunks = host.chunks;
    this.unsubs.push(
      chunks.onColumnLoaded((cx, cz) => {
        this.guard('load', () => {
          this.onLoaded(cx, cz);
        });
      }),
      chunks.onColumnUnloaded((cx, cz) => {
        this.guard('unload', () => {
          this.onUnloaded(cx, cz);
        });
      }),
      chunks.onSection((col) => {
        if (col.loaded)
          this.guard('section', () => {
            this.resummarize(col);
          });
      }),
      chunks.onBlockSet((col, rel, i, _before, after) => {
        this.guard('block', () => {
          this.onBlockSet(col, rel, i, after);
        });
      }),
    );
    // columns already loaded when attaching
    for (const col of chunks.allColumns()) if (col.loaded) this.guard('load', () => this.onLoaded(col.cx, col.cz));
    host.cache = this;
    host.finder.cache = this;
    if (this.flushIntervalMs > 0 && !this.readOnly) {
      this.timer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
      this.timer.unref();
    }
    return () => {
      this.detach();
    };
  }

  private detach(): void {
    for (const u of this.unsubs.splice(0)) u();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const h = this.host;
    if (h) {
      if (h.cache === this) h.cache = undefined;
      if (h.finder.cache === this) h.finder.cache = undefined;
    }
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.stats.errors++;
      this.log.warn(`world cache: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- live summaries ------------------------------------------------------------------------------

  private onLoaded(cx: number, cz: number): void {
    const h = this.host;
    const table = this.table;
    if (!h || !table || !h.registry.ready) return;
    const col = h.chunks.column(cx, cz);
    if (!col?.loaded) return;
    const dim = h.chunks.dimension;
    const k = ckey(dim, cx, cz);
    const read = this.touched.get(k);
    const oldSummary = read ? this.cachedSummary(cx, cz) : undefined;
    const old = read && oldSummary ? { summary: oldSummary, cells: read.cells, roofCols: read.roofCols } : undefined;
    const t0 = performance.now();
    const { summary, diffs } = summarizeColumn(col, table, old, Date.now(), roofedDimension(dim));
    this.stats.summarized++;
    this.stats.summarizeMs += performance.now() - t0;
    this.carrySeen(dim, cx, cz, k, summary, oldSummary); // Track Z: remembered seen ores stay seen
    this.live.set(k, summary);
    this.dirtyLive.add(k);
    this.decodedLru.delete(k);
    this.touched.delete(k);
    if (this.memoKey === k) this.memoKey = Number.NaN;
    if (old) {
      this.stats.corrections++;
      this.emitDiffs(diffs);
    }
  }

  private resummarize(col: Column): void {
    const h = this.host;
    const table = this.table;
    if (!h || !table) return;
    const k = ckey(h.chunks.dimension, col.cx, col.cz);
    const prev = this.live.get(k);
    if (!prev) return;
    const t0 = performance.now();
    const next = summarizeColumn(col, table, undefined, Date.now(), roofedDimension(h.chunks.dimension)).summary;
    next.applySeen(prev.seenMarks()); // Track Z
    this.live.set(k, next);
    this.stats.summarized++;
    this.stats.summarizeMs += performance.now() - t0;
    this.dirtyLive.add(k);
  }

  private onBlockSet(col: Column, rel: number, i: number, after: number): void {
    const h = this.host;
    const table = this.table;
    if (!h || !table) return;
    const k = ckey(h.chunks.dimension, col.cx, col.cz);
    const s = this.live.get(k);
    if (!s) return;
    const x = i >> 8;
    const z = (i >> 4) & 15;
    const y = (col.minCY + rel) * 16 + (i & 15);
    const f = table.of(after);
    if (f.cls !== 0) s.ensureRow(y);
    s.setCls(x, y, z, f.cls);
    const bx = col.cx * 16 + x;
    const bz = col.cz * 16 + z;
    s.rescanColumn(x, z, (yy) => {
      const st = h.chunks.stateIdAt(bx, yy, bz);
      return st !== undefined && table.of(st).roof;
    });
    s.setMark(x, y, z, f.mark);
    const air = h.registry.airStateId;
    s.rescanSurface(x, z, (yy) => h.chunks.stateIdAt(bx, yy, bz) ?? air, (st) => table.of(st)); // Track PC
    // neighbours' exposed flags
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
      const m = s.marks.get(((y + dy - s.y0) << 8) | (nz << 4) | nx);
      if (m) m.exposed = s.exposedAt(nx, y + dy, nz);
    }
    s.touch();
    this.dirtyLive.add(k);
  }

  private onUnloaded(cx: number, cz: number): void {
    const h = this.host;
    if (!h) return;
    const dim = h.chunks.dimension;
    const k = ckey(dim, cx, cz);
    const s = this.live.get(k);
    if (!s) return;
    this.live.delete(k);
    this.dirtyLive.delete(k);
    this.store(dim, s);
    touchLru(this.decodedLru, k, s);
    if (this.memoKey === k) this.memoKey = Number.NaN;
    this.evictChunks();
  }

  private emitDiffs(diffs: CellDiff[]): void {
    const h = this.host;
    const table = this.table;
    if (!h || !table || diffs.length === 0) return;
    this.stats.correctionCells += diffs.length;
    const emit = h.updates.emit?.bind(h.updates);
    if (!emit) return;
    const syn = table.synthetic();
    for (const d of diffs) emit({ x: d.x, y: d.y, z: d.z }, syn[d.before], h.registry.blockInfo(d.stateId, d.runtimeId));
  }

  // ---- encode / regions ------------------------------------------------------------------------------

  /** Encodes a summary into its region (in memory; written on the next flush). */
  private store(dim: number, s: ChunkSummary): void {
    if (this.readOnly) return;
    const t0 = performance.now();
    const raw = encodeRaw(s).length;
    const data = encodeSummary(s);
    this.stats.encoded++;
    this.stats.encodeMs += performance.now() - t0;
    this.stats.encodedBytes += data.length;
    this.stats.rawBytes += raw;
    const r = this.region(dim, regionOf(s.cx), regionOf(s.cz));
    const slot = slotOf(s.cx, s.cz);
    r.chunks.set(slot, data);
    r.changed.add(slot);
    this.setTile(ckey(dim, s.cx, s.cz), s, false);
  }

  private region(dim: number, rx: number, rz: number): Region {
    const k = rkey(dim, rx, rz);
    let r = this.regions.get(k);
    if (r) {
      touchLru(this.regions, k, r);
      return r;
    }
    const t0 = performance.now();
    let chunks = new Map<number, Uint8Array>();
    let mtimeMs: number | undefined;
    try {
      const disk = readRegion(this.dimDir(dim), rx, rz);
      chunks = disk.chunks;
      mtimeMs = disk.mtimeMs;
      if (mtimeMs !== undefined) this.stats.regionReads++;
    } catch (e) {
      this.stats.errors++;
      const path = join(this.dimDir(dim), regionFileName(rx, rz));
      this.log.warn(`world cache: region ${path} unreadable (${e instanceof Error ? e.message : String(e)}); starting it empty`);
      if (e instanceof RegionFormatError && !this.readOnly) {
        try {
          renameSync(path, `${path}.corrupt-${Date.now()}`);
        } catch {
          // keep going with an empty region
        }
      }
    }
    this.stats.regionReadMs += performance.now() - t0;
    r = { dim, rx, rz, chunks, changed: new Set(), mtimeMs, writing: undefined };
    this.regions.set(k, r);
    this.evictRegions();
    return r;
  }

  private evictRegions(): void {
    if (this.regions.size <= this.maxRegions) return;
    for (const [k, r] of this.regions) {
      if (this.regions.size <= this.maxRegions) break;
      if (r.writing) continue;
      if (r.changed.size > 0) this.writeSync(r);
      this.regions.delete(k);
      this.stats.evictedRegions++;
    }
  }

  private evictChunks(): void {
    while (this.decodedLru.size > this.maxChunks) {
      const first = this.decodedLru.keys().next().value!;
      this.decodedLru.delete(first);
      if (this.memoKey === first) this.memoKey = Number.NaN;
      this.stats.evictedChunks++;
    }
  }

  /** Disk entries written by another process since we read the region win for the slots we did not change. */
  private mergeFromDisk(r: Region, keep: ReadonlySet<number>): void {
    const dir = this.dimDir(r.dim);
    const m = regionMtime(dir, r.rx, r.rz);
    if (m === undefined || m === r.mtimeMs) return;
    try {
      const disk = readRegion(dir, r.rx, r.rz);
      for (const [slot, data] of disk.chunks) {
        if (keep.has(slot)) continue;
        r.chunks.set(slot, data);
        const cx = r.rx * 32 + (slot & 31);
        const cz = r.rz * 32 + (slot >> 5);
        const k = ckey(r.dim, cx, cz);
        this.decodedLru.delete(k);
        this.tiles.delete(k);
        if (this.memoKey === k) this.memoKey = Number.NaN;
      }
    } catch (e) {
      this.stats.errors++;
      this.log.warn(`world cache: merging region ${r.rx},${r.rz} from disk failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private writeSync(r: Region): void {
    if (this.readOnly || r.changed.size === 0) return;
    const keep = new Set(r.changed);
    this.mergeFromDisk(r, keep);
    const t0 = performance.now();
    try {
      const n = writeRegionSync(this.dimDir(r.dim), r.rx, r.rz, r.chunks);
      r.changed.clear();
      r.mtimeMs = regionMtime(this.dimDir(r.dim), r.rx, r.rz);
      this.stats.regionWrites++;
      this.stats.regionBytesWritten += n;
    } catch (e) {
      this.stats.errors++;
      this.log.warn(`world cache: writing region ${r.rx},${r.rz} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.stats.regionWriteMs += performance.now() - t0;
  }

  private async writeAsync(r: Region): Promise<void> {
    if (this.readOnly || r.changed.size === 0) return;
    if (r.writing) await r.writing;
    const keep = new Set(r.changed);
    r.changed.clear();
    this.mergeFromDisk(r, keep);
    const snapshot = new Map(r.chunks);
    const t0 = performance.now();
    const p = (async () => {
      try {
        const n = await writeRegion(this.dimDir(r.dim), r.rx, r.rz, snapshot);
        r.mtimeMs = regionMtime(this.dimDir(r.dim), r.rx, r.rz);
        this.stats.regionWrites++;
        this.stats.regionBytesWritten += n;
      } catch (e) {
        for (const s of keep) r.changed.add(s);
        this.stats.errors++;
        this.log.warn(`world cache: writing region ${r.rx},${r.rz} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.stats.regionWriteMs += performance.now() - t0;
    })();
    r.writing = p;
    await p;
    if (r.writing === p) r.writing = undefined;
  }

  /** Encodes dirty live summaries into their regions (no disk I/O). */
  private encodeDirty(): void {
    const dim = this.host?.chunks.dimension ?? 0;
    for (const k of this.dirtyLive) {
      const s = this.live.get(k);
      if (s) this.store(dim, s);
    }
    this.dirtyLive.clear();
  }

  /** Encodes dirty live summaries and writes every changed region (async). */
  flush(): Promise<void> {
    if (this.readOnly || this.closed) return Promise.resolve();
    if (this.flushing) return this.flushing;
    const p = (async () => {
      this.encodeDirty();
      for (const r of [...this.regions.values()]) if (r.changed.size > 0) await this.writeAsync(r);
      await this.herds.flush(); // Track AF
      await this.chests.flush(); // Track AG
      this.stats.flushes++;
    })().finally(() => {
      this.flushing = undefined;
    });
    this.flushing = p;
    return p;
  }

  /** Synchronous flush of everything (live columns included), e.g. at exit. */
  flushSync(): void {
    if (this.readOnly) return;
    this.encodeDirty();
    for (const r of this.regions.values()) this.writeSync(r);
    this.herds.flushSync(); // Track AF
    this.chests.flushSync(); // Track AG
    this.stats.flushes++;
  }

  /** Flushes synchronously and detaches. The cache stays readable. */
  close(): void {
    if (this.closed) return;
    this.flushSync();
    this.closed = true;
    this.detach();
  }

  // ---- lookups (CachedTerrain) -----------------------------------------------------------------------

  /** The cached summary of an unloaded column of the current dimension (decoding it if needed). */
  cachedSummary(cx: number, cz: number): ChunkSummary | undefined {
    const dim = this.dimension;
    const k = ckey(dim, cx, cz);
    if (k === this.memoKey) return this.memo;
    let s = this.decodedLru.get(k);
    if (s) {
      touchLru(this.decodedLru, k, s);
    } else {
      s = this.decodeFromRegion(dim, cx, cz);
      if (s) {
        this.decodedLru.set(k, s);
        this.evictChunks();
      }
    }
    this.memoKey = k;
    this.memo = s;
    return s;
  }

  private decodeFromRegion(dim: number, cx: number, cz: number): ChunkSummary | undefined {
    const data = this.region(dim, regionOf(cx), regionOf(cz)).chunks.get(slotOf(cx, cz));
    if (!data) return undefined;
    const t0 = performance.now();
    try {
      const s = decodeSummary(data);
      this.stats.decoded++;
      return s;
    } catch (e) {
      this.stats.errors++;
      this.log.warn(`world cache: chunk ${cx},${cz} unreadable: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    } finally {
      this.stats.decodeMs += performance.now() - t0;
    }
  }

  /** Live (loaded) summary, else the cached one. */
  summary(cx: number, cz: number): ChunkSummary | undefined {
    return this.live.get(ckey(this.dimension, cx, cz)) ?? this.cachedSummary(cx, cz);
  }

  /** The loaded column's summary, if loaded and summarized. */
  liveSummary(cx: number, cz: number): ChunkSummary | undefined {
    return this.live.get(ckey(this.dimension, cx, cz));
  }

  blockAt(x: number, y: number, z: number): BlockInfo | undefined {
    const cx = x >> 4;
    const cz = z >> 4;
    const s = this.cachedSummary(cx, cz);
    if (!s || !this.table) return undefined;
    this.stats.lookups++;
    this.readSet(this.memoKey).cells.add(cellKey(x & 15, y, z & 15));
    return this.table.synthetic()[s.standIn(x & 15, y, z & 15)];
  }

  columnTop(x: number, z: number): number | undefined {
    const s = this.cachedSummary(x >> 4, z >> 4);
    if (!s) return undefined;
    this.readSet(this.memoKey).roofCols.add(((z & 15) << 4) | (x & 15));
    const r = s.roof[((z & 15) << 4) | (x & 15)]!;
    return r === Y_NONE ? s.y0 - 1 : r;
  }

  private readSet(k: number): { cells: Set<number>; roofCols: Set<number> } {
    let r = this.touched.get(k);
    if (!r) {
      r = { cells: new Set(), roofCols: new Set() };
      this.touched.set(k, r);
    }
    return r;
  }

  has(cx: number, cz: number): boolean {
    return this.cachedSummary(cx, cz) !== undefined;
  }

  marks(cx: number, cz: number): readonly CachedMark[] {
    return this.cachedSummary(cx, cz)?.markList() ?? [];
  }

  /** Stand-in BlockInfo for a mark name (find predicates), or undefined. */
  markInfo(name: string): BlockInfo | undefined {
    return this.table?.infoByName(name);
  }

  /** Is (cx, cz) present in the cache for the current dimension (in memory or on disk), without decoding? */
  known(cx: number, cz: number): boolean {
    const dim = this.dimension;
    const k = ckey(dim, cx, cz);
    if (this.live.has(k) || this.decodedLru.has(k)) return true;
    return this.region(dim, regionOf(cx), regionOf(cz)).chunks.has(slotOf(cx, cz));
  }

  // ---- Track Z: ore memory (seen marks, docs/world-cache.md "Seen marks") ----------------------------

  /** A loading column takes the seen flags of what the cache remembered for it (decoded summary, else only the record's marks). */
  private carrySeen(dim: number, cx: number, cz: number, k: number, s: ChunkSummary, old: ChunkSummary | undefined): void {
    const t0 = performance.now();
    const prev = old ?? this.decodedLru.get(k);
    let seen: Map<number, string> | undefined;
    if (prev) seen = prev.seenMarks();
    else {
      const data = this.region(dim, regionOf(cx), regionOf(cz)).chunks.get(slotOf(cx, cz));
      if (data) {
        try {
          seen = decodeSeenMarks(data);
        } catch {
          // an unreadable record: nothing to carry (cachedSummary reports it when read)
        }
      }
    }
    if (seen?.size) this.stats.seenCarried += s.applySeen(seen);
    this.stats.seenCarryMs += performance.now() - t0;
  }

  /** Flag the mark at `p` (a loaded or cached column) as seen when it is a `name` mark; written with the next flush. */
  markSeen(p: Vec3, name: string): boolean {
    if (this.readOnly) return false;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    const dim = this.dimension;
    const k = ckey(dim, x >> 4, z >> 4);
    const live = this.live.get(k);
    if (live) {
      const r = live.markSeen(x & 15, y, z & 15, name);
      if (r === 1) this.dirtyLive.add(k);
      return r >= 0;
    }
    const s = this.cachedSummary(x >> 4, z >> 4);
    if (!s) return false;
    const r = s.markSeen(x & 15, y, z & 15, name);
    if (r === 1) this.store(dim, s);
    return r >= 0;
  }

  /** Seen marks within `radius` of `origin` (loaded columns first-hand, others from the cache). */
  seenMarks(origin: Vec3, radius: number): CachedMark[] {
    return this.marksNear(origin, radius, true, true);
  }

  /** Marks of the loaded columns within `radius` of `origin`. */
  loadedMarks(origin: Vec3, radius: number): CachedMark[] {
    return this.marksNear(origin, radius, false, false);
  }

  private marksNear(origin: Vec3, radius: number, seenOnly: boolean, cached: boolean): CachedMark[] {
    const out: CachedMark[] = [];
    const dim = this.dimension;
    const r2 = radius * radius;
    for (let cx = Math.floor((origin.x - radius) / 16); cx <= Math.floor((origin.x + radius) / 16); cx++) {
      for (let cz = Math.floor((origin.z - radius) / 16); cz <= Math.floor((origin.z + radius) / 16); cz++) {
        const s = this.live.get(ckey(dim, cx, cz)) ?? (cached && this.known(cx, cz) ? this.cachedSummary(cx, cz) : undefined);
        if (!s) continue;
        for (const m of s.markList()) {
          if (seenOnly && !m.seen) continue;
          const d = (m.x + 0.5 - origin.x) ** 2 + (m.y + 0.5 - origin.y) ** 2 + (m.z + 0.5 - origin.z) ** 2;
          if (d <= r2) out.push(m);
        }
      }
    }
    return out;
  }

  // ---- debug map -----------------------------------------------------------------------------------

  private setTile(k: number, s: ChunkSummary, live: boolean): MapTile {
    const surf = s.surface();
    const t: MapTile = { cx: s.cx, cz: s.cz, live, rev: s.rev, updatedAt: s.updatedAt, y: surf.y, cls: surf.cls, ...(s.surf ? { surf: s.surf.compact() } : {}) }; // Track PC: surface names
    touchLru(this.tiles, k, t);
    while (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value!);
    return t;
  }

  /** Map tile of a column (live or cached), undefined when the cache has nothing for it. */
  tile(cx: number, cz: number): MapTile | undefined {
    const dim = this.dimension;
    const k = ckey(dim, cx, cz);
    const live = this.live.get(k);
    if (live) {
      const t = this.tiles.get(k);
      return t?.live && t.rev === live.rev ? t : this.setTile(k, live, true);
    }
    const t = this.tiles.get(k);
    if (t && !t.live) return t;
    const s = this.decodedLru.get(k) ?? this.decodeFromRegion(dim, cx, cz);
    return s ? this.setTile(k, s, false) : undefined;
  }

  /** Counts for status pages. */
  info(): { live: number; dirty: number; decoded: number; regions: number; tiles: number; approxBytes: number } {
    let bytes = 0;
    const surfBytes = (s: ChunkSummary): number => (s.surf ? (s.surf.under ? 2600 : 1300) : 0); // Track PC
    for (const s of this.live.values()) bytes += s.cells.length + 1024 + s.marks.size * 48 + surfBytes(s);
    for (const s of this.decodedLru.values()) bytes += s.cells.length + 1024 + s.marks.size * 48 + surfBytes(s);
    for (const r of this.regions.values()) for (const d of r.chunks.values()) bytes += d.length;
    for (const t of this.tiles.values()) bytes += 800 + (t.surf ? (t.surf.under ? 2600 : 1300) : 0); // Track PC: surface layers
    return { live: this.live.size, dirty: this.dirtyLive.size, decoded: this.decodedLru.size, regions: this.regions.size, tiles: this.tiles.size, approxBytes: bytes };
  }

  /** Every chunk stored in the regions currently in memory plus the live ones (dimension `dim`). */
  storedChunks(dim = this.dimension): { cx: number; cz: number }[] {
    const out = new Map<string, { cx: number; cz: number }>();
    for (const r of this.regions.values()) {
      if (r.dim !== dim) continue;
      for (const slot of r.chunks.keys()) {
        const cx = r.rx * 32 + (slot & 31);
        const cz = r.rz * 32 + (slot >> 5);
        out.set(`${cx},${cz}`, { cx, cz });
      }
    }
    if (dim === this.dimension) for (const s of this.live.values()) out.set(`${s.cx},${s.cz}`, { cx: s.cx, cz: s.cz });
    return [...out.values()];
  }

  /** Loads (reads) a region into memory without decoding its chunks (tools). */
  loadRegion(rx: number, rz: number, dim = this.dimension): number {
    return this.region(dim, rx, rz).chunks.size;
  }
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
