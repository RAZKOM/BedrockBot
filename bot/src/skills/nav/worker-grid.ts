// Track AB (docs/pathfinding.md "Compute", decisions/0023): the planner worker's mirror of what
// NavGrid reads from the world model. The main thread (worker.ts, PlannerClient) turns chunk store
// and world cache events into `MirrorOp`s (copies of layer-0 section arrays, the BlockInfo of every
// state id a palette references, single block changes, cached column summaries); the worker applies
// them in order to a `MirrorWorld`, whose `source` is a TerrainSource that answers exactly like
// `worldSource(world)` on the main thread (terrain/query.ts): loaded columns from the sections, the
// rest from the cache stand-ins, undefined elsewhere.
import { Layer } from '../../world/subchunk.ts';
import type { BlockInfo, Box } from '../../world/types.ts';
import type { TerrainSource } from '../terrain/query.ts';

/** Layer 0 of a section: palette state ids (-1 = unknown runtime id), wire runtime ids, per-block palette indices (null = all palette[0]). */
export interface SectionData {
  palette: Int32Array;
  runtimeIds: Int32Array;
  size: number;
  index: Uint8Array | Uint16Array | null;
}

/** A loaded column: sections by relative index (null = all air, undefined = not received). */
export interface ColumnData {
  cx: number;
  cz: number;
  minCY: number;
  count: number;
  sections: (SectionData | null | undefined)[];
}

/** A cached (unloaded) column's summary as the planner reads it (world/cache/summary.ts ChunkSummary). */
export interface CacheColumnData {
  cx: number;
  cz: number;
  y0: number;
  rows: number;
  /** 2 bits per cell, index (y - y0) * 256 + z * 16 + x, 4 cells per byte (low bits first). */
  cells: Uint8Array;
  /** Highest roof block per column (z * 16 + x), Y_NONE when none. */
  roof: Int16Array;
}

export type MirrorOp =
  /** Dimension bounds and air (sent first, and again after a dimension change: everything is dropped). */
  | { op: 'world'; dimension: number; minY: number; maxY: number; air: number; airRid: number }
  /** BlockInfo of state ids (each sent once per worker), and the cache stand-ins [air, stone, water, lava, leaves]. */
  | { op: 'infos'; infos: BlockInfo[]; synthetic?: BlockInfo[] }
  | { op: 'column'; col: ColumnData }
  | { op: 'section'; cx: number; cz: number; rel: number; sec: SectionData | null }
  | { op: 'unload'; cx: number; cz: number }
  | { op: 'block'; x: number; y: number; z: number; stateId: number; runtimeId: number }
  | { op: 'cache'; col: CacheColumnData }
  /** The cache dropped / replaced a column's summary (re-sent when needed). */
  | { op: 'uncache'; cx: number; cz: number };

/** Copy of a section's layer 0 (main thread). */
export function sectionData(layer: Pick<Layer, 'palette' | 'runtimeIds' | 'size' | 'index'> | undefined, air: number, airRid: number): SectionData {
  if (!layer) return { palette: Int32Array.of(air), runtimeIds: Int32Array.of(airRid), size: 1, index: null };
  return {
    palette: layer.palette.slice(0, layer.size),
    runtimeIds: layer.runtimeIds.slice(0, layer.size),
    size: layer.size,
    index: layer.index ? layer.index.slice() : null,
  };
}

/** Bytes a section copy carries (for the forwarding stats). */
export function sectionBytes(s: SectionData | null | undefined): number {
  if (!s) return 0;
  return s.palette.byteLength + s.runtimeIds.byteLength + (s.index?.byteLength ?? 0);
}

const Y_NONE = -32768;
const CLS_SOLID = 1;
const SYN_LEAVES = 4;
const FULL_BOX: Box = [0, 0, 0, 1, 1, 1];

const key = (cx: number, cz: number): number => (cx + 2097152) * 4194304 + (cz + 2097152);

interface MirrorColumn {
  minCY: number;
  count: number;
  sections: (Layer | null | undefined)[];
}

/** What changed since the last `takeChanges()` (the worker's grid cache follows). */
export interface MirrorChanges {
  /** Columns loaded / unloaded / sections replaced / cache entries changed: the grid cache is dropped. */
  structural: boolean;
  /** Single block changes (the grid forgets these cells). */
  blocks: { x: number; y: number; z: number }[];
}

/** The worker's copy of the world model (see the file comment). */
export class MirrorWorld {
  private readonly columns = new Map<number, MirrorColumn>();
  private readonly cache = new Map<number, CacheColumnData>();
  private readonly infos: (BlockInfo | undefined)[] = [];
  private readonly unknownInfos = new Map<number, BlockInfo>();
  private synthetic: BlockInfo[] | undefined;
  private air = 0;
  private airRid = 0;
  dimension = 0;
  minY = -64;
  maxY = 319;
  private changes: MirrorChanges = { structural: false, blocks: [] };
  /** Ops applied (for stats). */
  applied = 0;
  readonly source: TerrainSource;

  constructor() {
    const live = (x: number, y: number, z: number): BlockInfo | undefined => this.liveBlockAt(x, y, z);
    const src: TerrainSource = {
      blockAt: (x, y, z) => live(x, y, z) ?? this.cachedBlockAt(x, y, z),
      liveBlockAt: live,
      cached: (x, z) => !this.columns.has(key(x >> 4, z >> 4)) && this.cache.has(key(x >> 4, z >> 4)),
      columnTop: (x, z) => this.columnTop(x, z),
    };
    Object.defineProperty(src, 'minY', { get: () => this.minY, enumerable: true });
    Object.defineProperty(src, 'maxY', { get: () => this.maxY, enumerable: true });
    this.source = src;
  }

  get columnCount(): number {
    return this.columns.size;
  }

  get cacheCount(): number {
    return this.cache.size;
  }

  /** Changes since the last call (and resets them). */
  takeChanges(): MirrorChanges {
    const c = this.changes;
    this.changes = { structural: false, blocks: [] };
    return c;
  }

  apply(op: MirrorOp): void {
    this.applied++;
    switch (op.op) {
      case 'world':
        this.columns.clear();
        this.cache.clear();
        this.dimension = op.dimension;
        this.minY = op.minY;
        this.maxY = op.maxY;
        this.air = op.air;
        this.airRid = op.airRid;
        this.changes.structural = true;
        return;
      case 'infos':
        for (const i of op.infos) if (i.stateId >= 0) this.infos[i.stateId] = i;
        if (op.synthetic) this.synthetic = op.synthetic;
        return;
      case 'column': {
        const c = op.col;
        this.columns.set(key(c.cx, c.cz), { minCY: c.minCY, count: c.count, sections: c.sections.map((s) => toLayer(s)) });
        this.changes.structural = true;
        return;
      }
      case 'section': {
        const col = this.columns.get(key(op.cx, op.cz));
        if (!col || op.rel < 0 || op.rel >= col.sections.length) return;
        col.sections[op.rel] = toLayer(op.sec);
        this.changes.structural = true;
        return;
      }
      case 'unload':
        if (this.columns.delete(key(op.cx, op.cz))) this.changes.structural = true;
        if (this.cache.delete(key(op.cx, op.cz))) this.changes.structural = true;
        return;
      case 'block':
        this.setBlock(op.x, op.y, op.z, op.stateId, op.runtimeId);
        return;
      case 'cache':
        this.cache.set(key(op.col.cx, op.col.cz), op.col);
        this.changes.structural = true;
        return;
      case 'uncache':
        if (this.cache.delete(key(op.cx, op.cz))) this.changes.structural = true;
        return;
    }
  }

  private setBlock(x: number, y: number, z: number, stateId: number, runtimeId: number): void {
    const col = this.columns.get(key(x >> 4, z >> 4));
    if (!col) return;
    const rel = (y >> 4) - col.minCY;
    if (rel < 0 || rel >= col.sections.length) return;
    let sec = col.sections[rel];
    if (sec === undefined) return;
    if (sec === null) {
      if (stateId === this.air) return;
      sec = Layer.uniform(this.air, this.airRid);
      col.sections[rel] = sec;
    }
    sec.set(((x & 15) << 8) | ((z & 15) << 4) | (y & 15), stateId, runtimeId);
    this.changes.blocks.push({ x, y, z });
  }

  /** Same as ChunkStore.stateIdAt + registry.blockInfo for loaded columns; undefined when not loaded here. */
  liveBlockAt(x: number, y: number, z: number): BlockInfo | undefined {
    const col = this.columns.get(key(x >> 4, z >> 4));
    if (!col) return undefined;
    const rel = (y >> 4) - col.minCY;
    if (rel < 0 || rel >= col.sections.length) return this.info(this.air, 0);
    const sec = col.sections[rel];
    if (sec === undefined) return undefined;
    if (sec === null) return this.info(this.air, 0);
    const i = ((x & 15) << 8) | ((z & 15) << 4) | (y & 15);
    const s = sec.stateAt(i);
    return this.info(s, s < 0 ? sec.runtimeIdAt(i) : 0);
  }

  private info(stateId: number, runtimeId: number): BlockInfo {
    if (stateId >= 0) {
      const i = this.infos[stateId];
      if (i) return i;
    }
    return this.unknownInfo(runtimeId);
  }

  /** As BlockRegistry.unknownInfo: an unresolved runtime id is a solid full block named `unknown`. */
  private unknownInfo(runtimeId: number): BlockInfo {
    let info = this.unknownInfos.get(runtimeId);
    if (!info) {
      info = Object.freeze({ name: 'unknown', stateId: -1, states: Object.freeze({ runtime_id: runtimeId }), hardness: -1, solid: true, boxes: Object.freeze([FULL_BOX]) });
      this.unknownInfos.set(runtimeId, info);
    }
    return info;
  }

  /** As WorldCache.blockAt: the stand-in of a cached column's cell. */
  private cachedBlockAt(x: number, y: number, z: number): BlockInfo | undefined {
    const s = this.cache.get(key(x >> 4, z >> 4));
    const syn = this.synthetic;
    if (!s || !syn) return undefined;
    const lx = x & 15;
    const lz = z & 15;
    const r = y - s.y0;
    let c = 0;
    if (r >= 0 && r < s.rows) {
      const i = r * 256 + lz * 16 + lx;
      c = (s.cells[i >> 2]! >> ((i & 3) * 2)) & 3;
    }
    return syn[c === CLS_SOLID && y > s.roof[lz * 16 + lx]! ? SYN_LEAVES : c];
  }

  /** As worldSource().columnTop: the top of the highest non-empty section, else the cache's highest roof. */
  private columnTop(x: number, z: number): number | undefined {
    const col = this.columns.get(key(x >> 4, z >> 4));
    if (!col) {
      const s = this.cache.get(key(x >> 4, z >> 4));
      if (!s) return undefined;
      const r = s.roof[(z & 15) * 16 + (x & 15)]!;
      return r === Y_NONE ? s.y0 - 1 : r;
    }
    for (let rel = Math.min(col.count, col.sections.length) - 1; rel >= 0; rel--) {
      const sec = col.sections[rel];
      if (sec === undefined) return undefined;
      if (sec !== null) return (col.minCY + rel) * 16 + 15;
    }
    return col.minCY * 16 - 1;
  }
}

function toLayer(s: SectionData | null | undefined): Layer | null | undefined {
  if (!s) return s;
  return new Layer(s.palette, s.runtimeIds, s.size, s.index);
}
