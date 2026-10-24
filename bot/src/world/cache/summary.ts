// One chunk column of the persistent world cache (PLAN.md task 7.12): per cell a 2-bit class over the
// column's y range, per column the top solid y and the highest roof block, and the list of marks
// (interesting blocks by name). Built from a loaded `Column`, kept current by block updates, encoded
// as a small little-endian record and deflated (raw deflate) into a region file. See docs/world-cache.md.
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Column } from '../chunks.ts';
import { fnv1a32 } from '../registry.ts';
import { localIndex } from '../subchunk.ts';
import type { StateTable } from './classes.ts';
import { SYN_LEAVES } from './classes.ts';
import { CLS_AIR, CLS_SOLID, CLS_WATER, Y_NONE, type CachedMark, type CellClass } from './types.ts';

export const SUMMARY_VERSION = 1;

/** Column index inside a chunk: z * 16 + x (x, z local). */
const colIndex = (x: number, z: number): number => (z << 4) | x;

let revCounter = 0;
/** A process-wide counter bumped on every summary change (the debug map asks for changes since a rev). */
export function nextRev(): number {
  return ++revCounter;
}
export function currentRev(): number {
  return revCounter;
}

/** Packs local (x, z) and a y offset into one number: yRel << 8 | z << 4 | x. */
const markKey = (x: number, yRel: number, z: number): number => (yRel << 8) | (z << 4) | x;

export interface MarkEntry {
  name: string;
  exposed: boolean;
}

/** A cell the cache believed one thing about and the loaded chunk says another (see `summarizeColumn`). */
export interface CellDiff {
  x: number;
  y: number;
  z: number;
  /** Stand-in index the planner may have read (0..3 class, 4 leaves). */
  before: number;
  stateId: number;
  runtimeId: number;
}

export class ChunkSummary {
  readonly cx: number;
  readonly cz: number;
  /** Lowest y (the dimension's floor). */
  y0: number;
  /** Number of y levels stored from y0; cells above are air. */
  rows: number;
  /** 2 bits per cell, index (y - y0) * 256 + z * 16 + x, 4 cells per byte (low bits first). */
  cells: Uint8Array;
  /** Highest solid y per column (z * 16 + x), Y_NONE when none. */
  readonly top = new Int16Array(256).fill(Y_NONE);
  /** Highest roof block per column (TerrainClass.roof: boxes except leaves, liquids), Y_NONE when none. */
  readonly roof = new Int16Array(256).fill(Y_NONE);
  /** Marks by markKey. */
  readonly marks = new Map<number, MarkEntry>();
  /** Wall-clock ms of the last change (block data, not the write). */
  updatedAt: number;
  /** Process-local change counter (debug map). */
  rev: number;
  private surfaceCache: { y: Int16Array; cls: Uint8Array } | undefined;

  constructor(cx: number, cz: number, y0: number, rows: number, updatedAt = Date.now()) {
    this.cx = cx;
    this.cz = cz;
    this.y0 = y0;
    this.rows = rows;
    this.cells = new Uint8Array(rows * 64);
    this.updatedAt = updatedAt;
    this.rev = nextRev();
  }

  /** Class at local (x, z) and absolute y. Outside the stored range: air. */
  cls(x: number, y: number, z: number): CellClass {
    const r = y - this.y0;
    if (r < 0 || r >= this.rows) return CLS_AIR;
    const i = r * 256 + colIndex(x, z);
    return ((this.cells[i >> 2]! >> ((i & 3) * 2)) & 3) as CellClass;
  }

  /** Stand-in index for the planner: the class, or SYN_LEAVES for a solid cell above the column's roof. */
  standIn(x: number, y: number, z: number): number {
    const c = this.cls(x, y, z);
    return c === CLS_SOLID && y > this.roof[colIndex(x, z)]! ? SYN_LEAVES : c;
  }

  setCls(x: number, y: number, z: number, c: CellClass): void {
    const r = y - this.y0;
    if (r < 0 || r >= this.rows) return;
    const i = r * 256 + colIndex(x, z);
    const b = i >> 2;
    const s = (i & 3) * 2;
    this.cells[b] = (this.cells[b]! & ~(3 << s)) | (c << s);
  }

  /** Grows the stored y range so that y fits (block placed above the highest stored row). */
  ensureRow(y: number): void {
    const need = y - this.y0 + 1;
    if (need <= this.rows) return;
    const rows = Math.ceil(need / 16) * 16;
    const cells = new Uint8Array(rows * 64);
    cells.set(this.cells);
    this.cells = cells;
    this.rows = rows;
  }

  /** Recomputes top and roof of one column from the cells (roof facts need the real block: `roofAt`). */
  rescanColumn(x: number, z: number, roofAt: (y: number) => boolean): void {
    let top = Y_NONE;
    let roof = Y_NONE;
    for (let y = this.y0 + this.rows - 1; y >= this.y0; y--) {
      const c = this.cls(x, y, z);
      if (c === CLS_AIR) continue;
      if (c === CLS_SOLID && top === Y_NONE) top = y;
      if (roof === Y_NONE && roofAt(y)) roof = y;
      if (top !== Y_NONE && roof !== Y_NONE) break;
    }
    this.top[colIndex(x, z)] = top;
    this.roof[colIndex(x, z)] = roof;
  }

  setMark(x: number, y: number, z: number, name: string | undefined): void {
    const k = markKey(x, y - this.y0, z);
    if (name === undefined) this.marks.delete(k);
    else this.marks.set(k, { name, exposed: this.exposedAt(x, y, z) });
  }

  /** Marks with absolute positions. */
  markList(): CachedMark[] {
    const bx = this.cx * 16;
    const bz = this.cz * 16;
    const out: CachedMark[] = [];
    for (const [k, m] of this.marks) out.push({ x: bx + (k & 15), y: this.y0 + (k >> 8), z: bz + ((k >> 4) & 15), name: m.name, exposed: m.exposed });
    return out;
  }

  /** Some face touches air or water inside this chunk. */
  exposedAt(x: number, y: number, z: number): boolean {
    const open = (c: CellClass) => c === CLS_AIR || c === CLS_WATER;
    if (open(this.cls(x, y + 1, z)) || (y - 1 >= this.y0 && open(this.cls(x, y - 1, z)))) return true;
    if (x > 0 && open(this.cls(x - 1, y, z))) return true;
    if (x < 15 && open(this.cls(x + 1, y, z))) return true;
    if (z > 0 && open(this.cls(x, y, z - 1))) return true;
    return z < 15 && open(this.cls(x, y, z + 1));
  }

  /** Recomputes every mark's exposed flag. */
  refreshExposed(): void {
    for (const [k, m] of this.marks) m.exposed = this.exposedAt(k & 15, this.y0 + (k >> 8), (k >> 4) & 15);
  }

  touch(now = Date.now()): void {
    this.updatedAt = now;
    this.rev = nextRev();
    this.surfaceCache = undefined;
  }

  /** Per column the highest non-air y (max of top and roof) and its class (debug map). */
  surface(): { y: Int16Array; cls: Uint8Array } {
    if (!this.surfaceCache) {
      const y = new Int16Array(256);
      const cls = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        const sy = Math.max(this.top[i]!, this.roof[i]!);
        y[i] = sy;
        cls[i] = sy === Y_NONE ? CLS_AIR : this.cls(i & 15, sy, i >> 4);
      }
      this.surfaceCache = { y, cls };
    }
    return this.surfaceCache;
  }

  /** FNV-1a over the classes, column arrays and marks (not the timestamps): equal for equal content. */
  checksum(): string {
    return (fnv1a32(encodeBody(this, false)) >>> 0).toString(16).padStart(8, '0');
  }
}

// ---- building from a loaded column -------------------------------------------------------------

/** Index of the highest section holding anything (relative), or -1. */
function highestSection(col: Column): number {
  for (let rel = col.sections.length - 1; rel >= 0; rel--) if (col.sections[rel]) return rel;
  return -1;
}

const CELL_Y_OFFSET = 4096;
/** Key of a cell read from the cache: (y + 4096) * 256 + z * 16 + x (local x, z). */
export const cellKey = (x: number, y: number, z: number): number => (y + CELL_Y_OFFSET) * 256 + ((z << 4) | x);

/** What the planner read from the cached summary of a column before it loaded. */
export interface ReadCells {
  summary: ChunkSummary;
  /** Cells read through blockAt (`cellKey`). */
  cells: ReadonlySet<number>;
  /** Columns (z * 16 + x) whose roof was read through columnTop. */
  roofCols: ReadonlySet<number>;
}

/**
 * Summarizes a loaded column. With `old` (the cached summary and the cells the planner read from it),
 * also returns the read cells whose stand-in differs from the real block by movement signature, and
 * the roof cell of every read column whose roof moved.
 */
export function summarizeColumn(col: Column, table: StateTable, old?: ReadCells, now = Date.now()): { summary: ChunkSummary; diffs: CellDiff[] } {
  const y0 = col.minCY * 16;
  const hi = highestSection(col);
  const s = new ChunkSummary(col.cx, col.cz, y0, (hi + 1) * 16, now);
  const diffs: CellDiff[] = [];
  const synSigs = old ? table.syntheticSigs() : undefined;
  const airSig = synSigs?.[CLS_AIR];
  const air = table.registry.airStateId;
  const cells = s.cells;
  for (let rel = 0; rel <= hi; rel++) {
    const sec = col.sections[rel];
    const l = sec?.layers[0];
    if (!l) continue;
    const n = l.size;
    const cls = new Uint8Array(n);
    const roof = new Uint8Array(n);
    const sig = new Int32Array(n);
    const mark: (string | undefined)[] = new Array<string | undefined>(n);
    let anyMark = false;
    for (let p = 0; p < n; p++) {
      const f = table.of(l.palette[p]!);
      cls[p] = f.cls;
      roof[p] = f.roof ? 1 : 0;
      sig[p] = f.sig;
      mark[p] = f.mark;
      if (f.mark) anyMark = true;
    }
    const idx = l.index;
    const yb = (col.minCY + rel) * 16;
    const rowBase = rel * 16 * 256;
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        const ci = colIndex(x, z);
        const base = (x << 8) | (z << 4);
        for (let dy = 0; dy < 16; dy++) {
          const p = idx ? idx[base | dy]! : 0;
          const c = cls[p]!;
          if (c !== CLS_AIR) {
            const i = rowBase + dy * 256 + ci;
            cells[i >> 2] = cells[i >> 2]! | (c << ((i & 3) * 2));
            if (c === CLS_SOLID) s.top[ci] = yb + dy;
          }
          if (roof[p]) s.roof[ci] = yb + dy;
          if (anyMark) {
            const m = mark[p];
            if (m) s.marks.set(markKey(x, yb + dy - y0, z), { name: m, exposed: false });
          }
        }
      }
    }
  }
  s.refreshExposed();
  if (old && synSigs) {
    // the cells the planner read as stand-ins: compare by movement signature
    const cellAt = (x: number, y: number, z: number): void => {
      const before = old.summary.standIn(x, y, z);
      const r = y - y0;
      const l = r >= 0 && r >> 4 <= hi ? col.sections[r >> 4]?.layers[0] : undefined;
      const stateId = l ? l.stateAt(localIndex(x, y, z)) : air;
      const sigNow = l ? table.of(stateId).sig : airSig!;
      if (sigNow === synSigs[before]) return;
      diffs.push({ x: col.cx * 16 + x, y, z: col.cz * 16 + z, before, stateId, runtimeId: l && stateId < 0 ? l.runtimeIdAt(localIndex(x, y, z)) : 0 });
    };
    const seen = new Set<number>();
    for (const k of old.cells) {
      seen.add(k);
      cellAt(k & 15, Math.floor(k / 256) - CELL_Y_OFFSET, (k >> 4) & 15);
    }
    // a column whose sky scan read the cached roof: announce the real roof cell when it moved
    for (const ci of old.roofCols) {
      const a = old.summary.roof[ci]!;
      const b2 = s.roof[ci]!;
      if (a === b2) continue;
      const y = b2 !== Y_NONE ? b2 : a;
      const k = cellKey(ci & 15, y, ci >> 4);
      if (seen.has(k)) continue;
      const l = col.sections[(y - y0) >> 4]?.layers[0];
      const stateId = l ? l.stateAt(localIndex(ci & 15, y, ci >> 4)) : air;
      diffs.push({ x: col.cx * 16 + (ci & 15), y, z: col.cz * 16 + (ci >> 4), before: old.summary.standIn(ci & 15, y, ci >> 4), stateId, runtimeId: l && stateId < 0 ? l.runtimeIdAt(localIndex(ci & 15, y, ci >> 4)) : 0 });
    }
  }
  return { summary: s, diffs };
}

// ---- encoding ----------------------------------------------------------------------------------

/**
 * Record layout (little endian), before deflate:
 *   u8 version, i32 cx, i32 cz, f64 updatedAt, i16 y0, u16 rows, i16 top[256], i16 roof[256],
 *   u8 cells[rows * 64], u16 nameCount, (u8 len, utf8 name) x nameCount,
 *   u32 markCount, (u32 key, u8 nameIndex, u8 flags[bit0 exposed]) x markCount (keys ascending).
 * `withHeader` false drops version, position and timestamp (the checksum input).
 */
function encodeBody(s: ChunkSummary, withHeader: boolean): Uint8Array {
  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  const keys = [...s.marks.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    const n = s.marks.get(k)!.name;
    if (!nameIdx.has(n)) {
      nameIdx.set(n, names.length);
      names.push(n);
    }
  }
  const nameBytes = names.map((n) => Buffer.from(n, 'utf8'));
  const head = withHeader ? 1 + 4 + 4 + 8 : 0;
  const size = head + 4 + 1024 + s.cells.length + 2 + nameBytes.reduce((a, b) => a + 1 + b.length, 0) + 4 + keys.length * 6;
  const buf = Buffer.alloc(size);
  let o = 0;
  if (withHeader) {
    o = buf.writeUInt8(SUMMARY_VERSION, o);
    o = buf.writeInt32LE(s.cx, o);
    o = buf.writeInt32LE(s.cz, o);
    o = buf.writeDoubleLE(s.updatedAt, o);
  }
  o = buf.writeInt16LE(s.y0, o);
  o = buf.writeUInt16LE(s.rows, o);
  for (let i = 0; i < 256; i++) o = buf.writeInt16LE(s.top[i]!, o);
  for (let i = 0; i < 256; i++) o = buf.writeInt16LE(s.roof[i]!, o);
  buf.set(s.cells, o);
  o += s.cells.length;
  o = buf.writeUInt16LE(names.length, o);
  for (const b of nameBytes) {
    o = buf.writeUInt8(b.length, o);
    buf.set(b, o);
    o += b.length;
  }
  o = buf.writeUInt32LE(keys.length, o);
  for (const k of keys) {
    const m = s.marks.get(k)!;
    o = buf.writeUInt32LE(k, o);
    o = buf.writeUInt8(nameIdx.get(m.name)!, o);
    o = buf.writeUInt8(m.exposed ? 1 : 0, o);
  }
  return buf;
}

/** The uncompressed record (exposed for size measurements). */
export function encodeRaw(s: ChunkSummary): Uint8Array {
  return encodeBody(s, true);
}

/** Deflated record as stored in a region file. */
export function encodeSummary(s: ChunkSummary): Uint8Array {
  return deflateRawSync(encodeBody(s, true), { level: 6 });
}

export class SummaryFormatError extends Error {
  override name = 'SummaryFormatError';
}

/** Inverse of `encodeSummary`. Throws SummaryFormatError on a bad record. */
export function decodeSummary(data: Uint8Array): ChunkSummary {
  let buf: Buffer;
  try {
    buf = inflateRawSync(data);
  } catch (e) {
    throw new SummaryFormatError(`inflate failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    let o = 0;
    const version = buf.readUInt8(o);
    o += 1;
    if (version !== SUMMARY_VERSION) throw new SummaryFormatError(`summary version ${version}, expected ${SUMMARY_VERSION}`);
    const cx = buf.readInt32LE(o);
    const cz = buf.readInt32LE(o + 4);
    const updatedAt = buf.readDoubleLE(o + 8);
    o += 16;
    const y0 = buf.readInt16LE(o);
    const rows = buf.readUInt16LE(o + 2);
    o += 4;
    if (rows % 16 !== 0 || rows > 4096) throw new SummaryFormatError(`bad row count ${rows}`);
    const s = new ChunkSummary(cx, cz, y0, rows, updatedAt);
    for (let i = 0; i < 256; i++, o += 2) s.top[i] = buf.readInt16LE(o);
    for (let i = 0; i < 256; i++, o += 2) s.roof[i] = buf.readInt16LE(o);
    if (o + rows * 64 > buf.length) throw new SummaryFormatError('truncated cells');
    s.cells.set(buf.subarray(o, o + rows * 64));
    o += rows * 64;
    const nameCount = buf.readUInt16LE(o);
    o += 2;
    const names: string[] = [];
    for (let i = 0; i < nameCount; i++) {
      const len = buf.readUInt8(o);
      names.push(buf.toString('utf8', o + 1, o + 1 + len));
      o += 1 + len;
    }
    const markCount = buf.readUInt32LE(o);
    o += 4;
    for (let i = 0; i < markCount; i++, o += 6) {
      const name = names[buf.readUInt8(o + 4)];
      if (name === undefined) throw new SummaryFormatError('bad name index');
      s.marks.set(buf.readUInt32LE(o), { name, exposed: (buf.readUInt8(o + 5) & 1) === 1 });
    }
    return s;
  } catch (e) {
    if (e instanceof SummaryFormatError) throw e;
    throw new SummaryFormatError(`bad record: ${e instanceof Error ? e.message : String(e)}`);
  }
}
