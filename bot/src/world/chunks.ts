// Chunk store (PLAN.md task 2.2): tracks `level_chunk`, requests the column's subchunks with
// batched `subchunk_request`s (capped outstanding), decodes `subchunk` entries, caches columns and
// unloads columns far from the player.
import { createLogger, type Logger } from '../log.ts';
import type { LevelChunk, PublisherUpdate, SubChunk, SubChunkEntry } from './packets.ts';
import type { BlockRegistry } from './registry.ts';
import { decodeSubChunk, Layer, localIndex, Section } from './subchunk.ts';
import type { Vec3 } from './types.ts';
import { dimensionInfo } from './version-shims/index.ts';

export interface ChunkStoreOptions {
  logger?: Logger;
  /**
   * Columns farther than this (in chunks, Chebyshev distance from the view center) are dropped.
   * Default: the server's publisher radius (network_chunk_publisher_update) in chunks + 2.
   */
  unloadDistance?: number;
  /** Max columns with subchunk requests in flight. Default 48. */
  maxOutstanding?: number;
  /** Max columns per subchunk_request packet. Default 8. */
  batchColumns?: number;
  /** Re-request a column whose answer has not arrived after this many ms. Default 5000. */
  requestTimeoutMs?: number;
  /** Clock (ms), for tests. */
  now?: () => number;
  /**
   * Runs the deferred request pump. Default setImmediate, so a burst of level_chunk packets from one
   * network batch is grouped into few subchunk_request packets. Tests pass a synchronous runner.
   */
  defer?: (fn: () => void) => void;
}

/** A block entity as simplified NBT (`id`, `x`, `y`, `z`, ...). */
export type BlockEntity = Record<string, unknown>;

export class Column {
  readonly cx: number;
  readonly cz: number;
  readonly minCY: number;
  /** Subchunks the server has (sections at or above this index, relative to minCY, are air). */
  readonly count: number;
  /** Section per relative index: Section, null = all air, undefined = not received yet. */
  readonly sections: (Section | null | undefined)[];
  /** Relative indices still awaited. */
  readonly missing = new Set<number>();
  /** Block entities by "x,y,z" (absolute). */
  readonly blockEntities = new Map<string, BlockEntity>();
  loaded = false;
  /** When the last request for this column was sent (ms); undefined = not requested yet. */
  requestedAt: number | undefined;

  constructor(cx: number, cz: number, minCY: number, count: number, total: number) {
    this.cx = cx;
    this.cz = cz;
    this.minCY = minCY;
    this.count = count;
    this.sections = new Array<Section | null | undefined>(total);
    for (let i = 0; i < total; i++) {
      if (i < count) this.missing.add(i);
      else this.sections[i] = null;
    }
    if (count === 0) this.loaded = true;
  }
}

export type ColumnListener = (cx: number, cz: number) => void;
/** A single layer-0 block change; `i` is the section-local index (localIndex order). */
export type BlockSetListener = (col: Column, rel: number, i: number, before: number, after: number) => void;

export interface SetResult {
  /** False when the column or its section is not held; nothing changed. */
  applied: boolean;
  before: number | undefined;
  beforeRuntimeId: number | undefined;
}

const NOT_APPLIED: SetResult = Object.freeze({ applied: false, before: undefined, beforeRuntimeId: undefined });

const key = (cx: number, cz: number) => `${cx},${cz}`;

export class ChunkStore {
  readonly registry: BlockRegistry;
  private readonly log: Logger;
  private readonly opts: Required<Omit<ChunkStoreOptions, 'logger' | 'unloadDistance' | 'now' | 'defer'>>;
  private readonly unloadDistanceOpt: number | undefined;
  private readonly now: () => number;
  private readonly send: (name: string, params: Record<string, unknown>) => void;

  private readonly columns = new Map<string, Column>();
  /** Columns waiting for a request (keys). */
  private readonly queue = new Set<string>();
  /** Columns with a request in flight (keys). */
  private readonly inFlight = new Set<string>();
  /** Packets that arrived before the registry was ready. */
  private deferred: (() => void)[] = [];

  private _dimension = 0;
  private center: { cx: number; cz: number } = { cx: 0, cz: 0 };
  private publisherRadiusChunks: number | undefined;
  private readonly defer: (fn: () => void) => void;
  private pumpScheduled = false;

  private readonly loadedFns = new Set<ColumnListener>();
  private readonly unloadFns = new Set<ColumnListener>();
  private readonly sectionFns = new Set<(col: Column, rel: number) => void>();
  private readonly blockSetFns = new Set<BlockSetListener>();

  /** Counters for diagnostics and tests. */
  readonly stats = {
    levelChunks: 0,
    requestsSent: 0,
    subchunksRequested: 0,
    entries: {} as Record<string, number>,
    decodeErrors: 0,
    unloaded: 0,
    retries: 0,
  };

  constructor(registry: BlockRegistry, send: (name: string, params: Record<string, unknown>) => void, opts: ChunkStoreOptions = {}) {
    this.registry = registry;
    this.send = send;
    this.log = opts.logger ?? createLogger('info', 'world');
    this.opts = {
      maxOutstanding: opts.maxOutstanding ?? 48,
      batchColumns: opts.batchColumns ?? 8,
      requestTimeoutMs: opts.requestTimeoutMs ?? 5000,
    };
    this.unloadDistanceOpt = opts.unloadDistance;
    this.now = opts.now ?? (() => performance.now());
    this.defer = opts.defer ?? ((fn) => void setImmediate(fn));
    registry.onReady(() => {
      this.flushDeferred();
    });
  }

  get dimension(): number {
    return this._dimension;
  }

  get minY(): number {
    return dimensionInfo(this.registry.shim, this._dimension).minY;
  }

  get maxY(): number {
    const d = dimensionInfo(this.registry.shim, this._dimension);
    return d.minY + d.height - 1;
  }

  /** Columns currently cached (loaded or not). */
  get size(): number {
    return this.columns.size;
  }

  get loadedCount(): number {
    let n = 0;
    for (const c of this.columns.values()) if (c.loaded) n++;
    return n;
  }

  /** Columns awaiting a request or an answer. */
  get pendingCount(): number {
    return this.queue.size + this.inFlight.size;
  }

  get unloadDistance(): number {
    return this.unloadDistanceOpt ?? (this.publisherRadiusChunks ?? 10) + 2;
  }

  onColumnLoaded(fn: ColumnListener): () => void {
    this.loadedFns.add(fn);
    return () => this.loadedFns.delete(fn);
  }

  onColumnUnloaded(fn: ColumnListener): () => void {
    this.unloadFns.add(fn);
    return () => this.unloadFns.delete(fn);
  }

  /** Called whenever a section is (re)placed by a decode, before onColumnLoaded. */
  onSection(fn: (col: Column, rel: number) => void): () => void {
    this.sectionFns.add(fn);
    return () => this.sectionFns.delete(fn);
  }

  /** Called after a single layer-0 block change from an update packet. */
  onBlockSet(fn: BlockSetListener): () => void {
    this.blockSetFns.add(fn);
    return () => this.blockSetFns.delete(fn);
  }

  column(cx: number, cz: number): Column | undefined {
    return this.columns.get(key(cx, cz));
  }

  allColumns(): IterableIterator<Column> {
    return this.columns.values();
  }

  isLoaded(cx: number, cz: number): boolean {
    return this.columns.get(key(cx, cz))?.loaded ?? false;
  }

  /** Drop everything (dimension change, disconnect). */
  clear(dimension = this._dimension): void {
    for (const c of [...this.columns.values()]) this.dropColumn(c);
    this.queue.clear();
    this.inFlight.clear();
    this._dimension = dimension;
  }

  /** Set the view center from the player's position (blocks). Also unloads far columns. */
  setCenter(pos: Vec3): void {
    this.center = { cx: Math.floor(pos.x) >> 4, cz: Math.floor(pos.z) >> 4 };
    this.unloadFar();
  }

  // ---- block access ------------------------------------------------------------------------

  /**
   * State id at a block position: a state id, -1 for an unknown runtime id, or undefined when the
   * column is not loaded. Positions above or below the dimension are air.
   */
  stateIdAt(x: number, y: number, z: number, layer = 0): number | undefined {
    const col = this.columns.get(key(x >> 4, z >> 4));
    if (!col?.loaded) return undefined;
    const rel = (y >> 4) - col.minCY;
    if (rel < 0 || rel >= col.sections.length) return this.registry.airStateId;
    const sec = col.sections[rel];
    if (sec === undefined) return undefined;
    if (sec === null) return this.registry.airStateId;
    const l = sec.layers[layer];
    if (!l) return this.registry.airStateId;
    return l.stateAt(localIndex(x, y, z));
  }

  /** Wire runtime id at a position (for unknown blocks), or undefined when not loaded. */
  runtimeIdAt(x: number, y: number, z: number, layer = 0): number | undefined {
    const col = this.columns.get(key(x >> 4, z >> 4));
    if (!col?.loaded) return undefined;
    const sec = col.sections[(y >> 4) - col.minCY];
    if (!sec) return sec === null ? this.registry.runtimeIdOf(this.registry.airStateId) : undefined;
    return sec.layers[layer]?.runtimeIdAt(localIndex(x, y, z));
  }

  /**
   * Set a block (from update_block and friends). Returns the previous state and runtime id, or
   * applied=false when the section is not held (column unknown, or its section not received yet),
   * in which case nothing changes.
   */
  setStateId(x: number, y: number, z: number, stateId: number, runtimeId: number, layer = 0): SetResult {
    const col = this.columns.get(key(x >> 4, z >> 4));
    if (!col) return NOT_APPLIED;
    const rel = (y >> 4) - col.minCY;
    if (rel < 0 || rel >= col.sections.length) return NOT_APPLIED;
    let sec = col.sections[rel];
    if (sec === undefined) return NOT_APPLIED;
    const air = this.registry.airStateId;
    const airRid = this.registry.runtimeIdOf(air);
    if (sec === null) {
      if (stateId === air) return { applied: true, before: air, beforeRuntimeId: airRid };
      sec = Section.uniform(air, airRid);
      col.sections[rel] = sec;
    }
    while (sec.layers.length <= layer) sec.layers.push(Layer.uniform(air, airRid));
    const l = sec.layers[layer]!;
    const i = localIndex(x, y, z);
    const before = l.stateAt(i);
    const beforeRuntimeId = l.runtimeIdAt(i);
    l.set(i, stateId, runtimeId);
    if (layer === 0 && before !== stateId) for (const fn of [...this.blockSetFns]) fn(col, rel, i, before, stateId);
    return { applied: true, before, beforeRuntimeId };
  }

  // ---- packet handlers ---------------------------------------------------------------------

  handlePublisherUpdate(p: PublisherUpdate): void {
    this.publisherRadiusChunks = Math.ceil(p.radius / 16);
    this.center = { cx: p.coordinates.x >> 4, cz: p.coordinates.z >> 4 };
    this.unloadFar();
  }

  handleLevelChunk(p: LevelChunk): void {
    if (!this.registry.ready) {
      this.deferred.push(() => {
        this.handleLevelChunk(p);
      });
      return;
    }
    this.stats.levelChunks++;
    if (p.dimension !== this._dimension) {
      this.log.debug(`level_chunk for dimension ${p.dimension} while in ${this._dimension}; ignored`);
      return;
    }
    const dim = dimensionInfo(this.registry.shim, p.dimension);
    const minCY = dim.minY >> 4;
    const total = dim.height >> 4;
    const k = key(p.x, p.z);
    const old = this.columns.get(k);
    if (old) this.dropColumn(old);

    if (p.highest_subchunk_count !== undefined || p.sub_chunk_count <= 0 || p.sub_chunk_count > total) {
      // Subchunk request mode: "limited" (highest_subchunk_count given) or "limitless" (request all).
      const count = Math.max(0, Math.min(total, p.highest_subchunk_count ?? total));
      const col = new Column(p.x, p.z, minCY, count, total);
      this.columns.set(k, col);
      if (col.loaded) this.emitLoaded(col);
      else if (this.chunkDistance(col.cx, col.cz) <= this.unloadDistance) this.queue.add(k);
      else this.dropColumn(col, false);
    } else {
      // Legacy mode: sections are in the payload (BDS 1.26 does not use this).
      const col = new Column(p.x, p.z, minCY, 0, total);
      let off = 0;
      for (let i = 0; i < p.sub_chunk_count; i++) {
        const dec = decodeSubChunk(p.payload.subarray(off), (rid) => this.registry.stateIdFromRuntimeId(rid), this.registry.shim.maxSubChunkVersion);
        off += dec.size;
        col.sections[i] = dec.section;
      }
      this.columns.set(k, col);
      for (let i = 0; i < p.sub_chunk_count; i++) this.emitSection(col, i);
      this.emitLoaded(col);
    }
    this.schedulePump();
  }

  handleSubChunk(p: SubChunk): void {
    if (!this.registry.ready) {
      this.deferred.push(() => {
        this.handleSubChunk(p);
      });
      return;
    }
    if (p.dimension !== this._dimension) return;
    const touched = new Set<Column>();
    for (const e of p.entries) {
      const col = this.columns.get(key(p.origin.x + e.dx, p.origin.z + e.dz));
      this.stats.entries[e.result] = (this.stats.entries[e.result] ?? 0) + 1;
      if (!col) continue;
      if (this.applyEntry(col, p.origin.y + e.dy, e)) touched.add(col);
    }
    for (const col of touched) this.checkComplete(col);
    this.schedulePump();
  }

  /** Returns true when the column should be re-checked for completeness. */
  private applyEntry(col: Column, cy: number, e: SubChunkEntry): boolean {
    const rel = cy - col.minCY;
    switch (e.result) {
      case 'success': {
        if (rel < 0 || rel >= col.sections.length) return false;
        if (!e.payload) {
          this.log.warn(`subchunk ${col.cx},${cy},${col.cz}: success without payload`);
          return false;
        }
        try {
          const dec = decodeSubChunk(e.payload, (rid) => this.registry.stateIdFromRuntimeId(rid), this.registry.shim.maxSubChunkVersion);
          if (dec.y !== undefined && dec.y !== cy) {
            this.log.warn(`subchunk ${col.cx},${cy},${col.cz}: payload says y index ${dec.y}; using ${cy}`);
          }
          col.sections[rel] = dec.section;
          this.replaceBlockEntities(col, cy, dec.blockEntities);
        } catch (err) {
          this.stats.decodeErrors++;
          this.log.error(`subchunk ${col.cx},${cy},${col.cz} decode failed: ${err instanceof Error ? err.message : String(err)}`);
          col.sections[rel] = null;
        }
        col.missing.delete(rel);
        this.emitSection(col, rel);
        return true;
      }
      case 'success_all_air':
      case 'y_index_out_of_bounds':
        if (rel >= 0 && rel < col.sections.length) {
          col.sections[rel] = null;
          col.missing.delete(rel);
          this.emitSection(col, rel);
        }
        return true;
      case 'chunk_not_found':
        // The server no longer has this column for us (out of its view): forget it.
        this.dropColumn(col);
        return false;
      default:
        this.log.warn(`subchunk ${col.cx},${cy},${col.cz}: result ${e.result}`);
        if (rel >= 0 && rel < col.sections.length) {
          col.missing.delete(rel);
          if (col.sections[rel] === undefined) col.sections[rel] = null;
        }
        return true;
    }
  }

  private replaceBlockEntities(col: Column, cy: number, list: Record<string, unknown>[]): void {
    for (const k of [...col.blockEntities.keys()]) {
      const y = Number(k.split(',')[1]);
      if (y >> 4 === cy) col.blockEntities.delete(k);
    }
    for (const be of list) {
      const x = Number(be.x);
      const y = Number(be.y);
      const z = Number(be.z);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) col.blockEntities.set(`${x},${y},${z}`, be);
    }
  }

  private checkComplete(col: Column): void {
    if (col.loaded || col.missing.size > 0) return;
    col.loaded = true;
    col.requestedAt = undefined;
    this.inFlight.delete(key(col.cx, col.cz));
    this.emitLoaded(col);
  }

  // ---- request scheduling ------------------------------------------------------------------

  /** Pump once after the current burst of packets has been handled. */
  schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    this.defer(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  /** Send queued requests up to the outstanding cap, and retry timed-out ones. Call on every tick. */
  pump(): void {
    if (!this.registry.ready) return;
    const now = this.now();
    for (const k of [...this.inFlight]) {
      const col = this.columns.get(k);
      if (!col || col.loaded) {
        this.inFlight.delete(k);
        continue;
      }
      if (col.requestedAt !== undefined && now - col.requestedAt > this.opts.requestTimeoutMs) {
        this.inFlight.delete(k);
        this.queue.add(k);
        this.stats.retries++;
        this.log.debug(`subchunk request for ${k} timed out; re-queued`);
      }
    }
    let room = this.opts.maxOutstanding - this.inFlight.size;
    if (room <= 0 || this.queue.size === 0) return;
    // Closest columns first.
    const wanted = [...this.queue]
      .map((k) => this.columns.get(k))
      .filter((c): c is Column => c !== undefined && !c.loaded)
      .sort((a, b) => this.chunkDistance(a.cx, a.cz) - this.chunkDistance(b.cx, b.cz));
    for (const k of [...this.queue]) if (!this.columns.get(k) || this.columns.get(k)?.loaded) this.queue.delete(k);
    while (room > 0 && wanted.length > 0) {
      const first = wanted.shift()!;
      const batch = [first];
      // Group nearby columns: offsets are i8, keep them well within range.
      for (let i = 0; i < wanted.length && batch.length < Math.min(this.opts.batchColumns, room); ) {
        const c = wanted[i]!;
        if (Math.abs(c.cx - first.cx) <= 64 && Math.abs(c.cz - first.cz) <= 64) {
          batch.push(c);
          wanted.splice(i, 1);
        } else {
          i++;
        }
      }
      const requests: { x: number; y: number; z: number }[] = [];
      for (const c of batch) {
        for (const rel of c.missing) requests.push({ x: c.cx - first.cx, y: rel, z: c.cz - first.cz });
        c.requestedAt = now;
        const k = key(c.cx, c.cz);
        this.queue.delete(k);
        this.inFlight.add(k);
      }
      room -= batch.length;
      this.stats.requestsSent++;
      this.stats.subchunksRequested += requests.length;
      this.send('subchunk_request', {
        dimension: this._dimension,
        origin: { x: first.cx, y: first.minCY, z: first.cz },
        requests,
      });
    }
  }

  // ---- unloading ---------------------------------------------------------------------------

  private chunkDistance(cx: number, cz: number): number {
    return Math.max(Math.abs(cx - this.center.cx), Math.abs(cz - this.center.cz));
  }

  private unloadFar(): void {
    const limit = this.unloadDistance;
    for (const col of [...this.columns.values()]) {
      if (this.chunkDistance(col.cx, col.cz) > limit) this.dropColumn(col);
    }
  }

  private dropColumn(col: Column, emit = true): void {
    const k = key(col.cx, col.cz);
    if (this.columns.get(k) !== col) return;
    this.columns.delete(k);
    this.queue.delete(k);
    this.inFlight.delete(k);
    this.stats.unloaded++;
    if (emit) for (const fn of [...this.unloadFns]) fn(col.cx, col.cz);
  }

  private emitLoaded(col: Column): void {
    for (const fn of [...this.loadedFns]) fn(col.cx, col.cz);
  }

  private emitSection(col: Column, rel: number): void {
    for (const fn of [...this.sectionFns]) fn(col, rel);
  }

  private flushDeferred(): void {
    const list = this.deferred;
    this.deferred = [];
    for (const fn of list) fn();
  }
}
