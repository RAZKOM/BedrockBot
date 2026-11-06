// The surface layer of the world cache (Track PC, decision 0060, docs/world-cache.md "Surface layer"):
// per chunk column the block a 2D map shows (the highest visible block on layer 0, flowers and snow
// layers included, glass and torches looked through), and where that block is a liquid the floor
// block under it and the depth. In a dimension with a roof (the Nether) a second layer holds the first
// standable floor under the roof, which is what a map of the Nether is useful for. Names live in a
// per-chunk table, columns hold one byte per name. The layer rides on the record as a tagged trailer
// after the marks, so the record version stays 1 and older readers (which stop after the marks) still
// read new files; a record without the trailer has no surface data and the map draws it as before.
import { CLS_AIR, CLS_SOLID, Y_NONE } from './types.ts';
import { VIS_BLOCK, VIS_LIQUID, VIS_NONE, type StateFacts } from './classes.ts';

/** Column byte meaning "no name" (nothing visible, no floor, or the name table is full). */
export const NO_NAME = 255;
/** Names a chunk's table holds at most (indices 0..254). */
export const MAX_NAMES = 255;
/** Trailer tag after the marks ('S') and its version. */
export const SURFACE_TAG = 0x53;
export const SURFACE_VERSION = 1;
/** Depth is one byte: deeper liquid reads 255. */
export const MAX_DEPTH = 255;

/** Dimensions with a bedrock roof, where the under-roof layer is recorded: the Nether. */
export function roofedDimension(dim: number): boolean {
  return dim === 1;
}

/** One map layer of a chunk: per column (z * 16 + x) the name index, its y, and for a liquid the floor name and depth. */
export interface SurfaceLayer {
  idx: Uint8Array;
  /** y of the surface block (Y_NONE when idx is NO_NAME). */
  y: Int16Array;
  /** Floor under a liquid surface (NO_NAME when the surface is not a liquid, or no floor was found above the dimension floor). */
  floor: Uint8Array;
  /** Liquid cells from the surface down to the floor (0 when not a liquid; MAX_DEPTH and deeper read MAX_DEPTH). */
  depth: Uint8Array;
}

export function newLayer(): SurfaceLayer {
  return { idx: new Uint8Array(256).fill(NO_NAME), y: new Int16Array(256).fill(Y_NONE), floor: new Uint8Array(256).fill(NO_NAME), depth: new Uint8Array(256) };
}

/** What one column scan found: names, not indices. */
export interface ColumnSurface {
  name: string;
  y: number;
  floor: string | undefined;
  depth: number;
}

/** A column surface read back with names (floorY = y - depth when there is a floor). */
export interface SurfaceColumn {
  name: string;
  y: number;
  floor?: string;
  floorY?: number;
  depth?: number;
}

/** The surface data of one chunk summary. */
export class SurfaceData {
  readonly names: string[] = [];
  private readonly ids = new Map<string, number>();
  readonly top: SurfaceLayer;
  /** The under-roof layer (roofed dimensions only). */
  under: SurfaceLayer | undefined;

  constructor(roofed: boolean) {
    this.top = newLayer();
    this.under = roofed ? newLayer() : undefined;
  }

  /** Index of a name in the table, adding it; NO_NAME when the table is full. */
  nameId(name: string): number {
    let id = this.ids.get(name);
    if (id !== undefined) return id;
    if (this.names.length >= MAX_NAMES) return NO_NAME;
    id = this.names.length;
    this.names.push(name);
    this.ids.set(name, id);
    return id;
  }

  /** Writes one column of a layer. */
  set(layer: SurfaceLayer, ci: number, c: ColumnSurface | undefined): void {
    if (!c) {
      layer.idx[ci] = NO_NAME;
      layer.y[ci] = Y_NONE;
      layer.floor[ci] = NO_NAME;
      layer.depth[ci] = 0;
      return;
    }
    layer.idx[ci] = this.nameId(c.name);
    layer.y[ci] = c.y;
    layer.floor[ci] = c.floor === undefined ? NO_NAME : this.nameId(c.floor);
    layer.depth[ci] = Math.min(MAX_DEPTH, c.depth);
  }

  /** One column of a layer with names, undefined when nothing is recorded there. */
  read(layer: SurfaceLayer, ci: number): SurfaceColumn | undefined {
    const i = layer.idx[ci]!;
    if (i === NO_NAME) return undefined;
    const out: SurfaceColumn = { name: this.names[i]!, y: layer.y[ci]! };
    const f = layer.floor[ci]!;
    if (layer.depth[ci]! > 0 || f !== NO_NAME) out.depth = layer.depth[ci]!;
    if (f !== NO_NAME) {
      out.floor = this.names[f]!;
      out.floorY = out.y - out.depth!;
    }
    return out;
  }

  /** A copy with the name table reduced to the names in use (encode, map tiles). */
  compact(): SurfaceData {
    const out = new SurfaceData(this.under !== undefined);
    const copy = (from: SurfaceLayer, to: SurfaceLayer): void => {
      for (let ci = 0; ci < 256; ci++) {
        const i = from.idx[ci]!;
        if (i === NO_NAME) continue;
        to.idx[ci] = out.nameId(this.names[i]!);
        to.y[ci] = from.y[ci]!;
        const f = from.floor[ci]!;
        to.floor[ci] = f === NO_NAME ? NO_NAME : out.nameId(this.names[f]!);
        to.depth[ci] = from.depth[ci]!;
      }
    };
    copy(this.top, out.top);
    if (this.under && out.under) copy(this.under, out.under);
    return out;
  }
}

// ---- scanning a column -----------------------------------------------------------------------------

/** Liquid below a liquid surface: the floor (first visible non-liquid block) and the depth. */
function liquidFloor(stateAt: (y: number) => number, facts: (s: number) => StateFacts, ySurf: number, yLo: number): { floor: string | undefined; depth: number } {
  for (let y = ySurf - 1; y >= yLo; y--) {
    const f = facts(stateAt(y));
    if (f.vis === VIS_BLOCK) return { floor: f.mapName, depth: ySurf - y };
  }
  return { floor: undefined, depth: ySurf - yLo + 1 };
}

/**
 * The top layer of a column: the highest visible block from `yHi` down to `yLo` (VIS_NONE skipped),
 * and for a liquid the floor and depth. undefined when the column shows nothing.
 */
export function scanTop(stateAt: (y: number) => number, facts: (s: number) => StateFacts, yHi: number, yLo: number): ColumnSurface | undefined {
  for (let y = yHi; y >= yLo; y--) {
    const f = facts(stateAt(y));
    if (f.vis === VIS_NONE) continue;
    if (f.vis === VIS_BLOCK) return { name: f.mapName, y, floor: undefined, depth: 0 };
    return { name: f.mapName, y, ...liquidFloor(stateAt, facts, y, yLo) };
  }
  return undefined;
}

/**
 * The under-roof layer (roofed dimensions): below the roof (the first run of non-air-class cells from
 * the top), the first floor with two open cells above it. A floor is a solid block or a liquid; open
 * cells are the cache's air class (no box: air, roots, fungi, vines, fire). A slit only one cell high is
 * counted as more roof. When the cell just above the floor is visible (crimson roots on nylium, a
 * fungus), that is the surface the map shows, at its own y.
 */
export function scanUnderRoof(stateAt: (y: number) => number, facts: (s: number) => StateFacts, yHi: number, yLo: number): ColumnSurface | undefined {
  let y = yHi;
  while (y >= yLo && facts(stateAt(y)).cls === CLS_AIR) y--; // open sky above the roof (none in the Nether)
  let gap = 0;
  let aboveFacts: StateFacts | undefined;
  for (; y >= yLo; y--) {
    const f = facts(stateAt(y));
    const floor = f.cls === CLS_SOLID || f.vis === VIS_LIQUID;
    if (!floor) {
      if (f.cls === CLS_AIR) {
        gap++;
        aboveFacts = f;
      } else {
        gap = 0; // an avoid cell without a floor role (fire is air class; cobweb, portals): not open
        aboveFacts = undefined;
      }
      continue;
    }
    if (gap >= 2) {
      if (f.vis === VIS_LIQUID) return { name: f.mapName, y, ...liquidFloor(stateAt, facts, y, yLo) };
      if (aboveFacts?.vis === VIS_BLOCK) return { name: aboveFacts.mapName, y: y + 1, floor: undefined, depth: 0 };
      return { name: f.mapName, y, floor: undefined, depth: 0 };
    }
    gap = 0;
    aboveFacts = undefined;
  }
  return undefined;
}

/** Scans both layers of column ci into `data`. */
export function scanColumnInto(data: SurfaceData, ci: number, stateAt: (y: number) => number, facts: (s: number) => StateFacts, yHi: number, yLo: number): void {
  data.set(data.top, ci, scanTop(stateAt, facts, yHi, yLo));
  if (data.under) data.set(data.under, ci, scanUnderRoof(stateAt, facts, yHi, yLo));
}

// ---- the record trailer --------------------------------------------------------------------------

/**
 * Trailer layout (after the marks, before deflate): u8 tag 'S', u8 version 1, u8 flags (bit 0 = under
 * layer present), u8 nameCount, (u8 len, utf8 name) x nameCount, then per layer (top, then under when
 * present): u8 idx[256], i16 dy[256], u8 floor[256], u8 depth[256]. The top layer's dy is y minus
 * max(top, roof) of the column (0 or 1 almost everywhere, so it deflates to nearly nothing; 0 when either
 * side is none); the under layer stores y itself. Names are the compacted table.
 */
export function trailerSize(d: SurfaceData): number {
  let n = 4;
  for (const name of d.names) n += 1 + Buffer.byteLength(name, 'utf8');
  return n + (d.under ? 2 : 1) * 256 * 5;
}

export function writeTrailer(buf: Buffer, o: number, d: SurfaceData, base: Int16Array): number {
  o = buf.writeUInt8(SURFACE_TAG, o);
  o = buf.writeUInt8(SURFACE_VERSION, o);
  o = buf.writeUInt8(d.under ? 1 : 0, o);
  o = buf.writeUInt8(d.names.length, o);
  for (const name of d.names) {
    const b = Buffer.from(name, 'utf8');
    o = buf.writeUInt8(b.length, o);
    buf.set(b, o);
    o += b.length;
  }
  const layer = (l: SurfaceLayer, rel: Int16Array | undefined): void => {
    buf.set(l.idx, o);
    o += 256;
    for (let i = 0; i < 256; i++) {
      const y = l.y[i]!;
      const b = rel?.[i] ?? Y_NONE;
      o = buf.writeInt16LE(l.idx[i] === NO_NAME ? 0 : rel === undefined ? y : y === Y_NONE || b === Y_NONE ? y : y - b, o);
    }
    buf.set(l.floor, o);
    o += 256;
    buf.set(l.depth, o);
    o += 256;
  };
  layer(d.top, base);
  if (d.under) layer(d.under, undefined);
  return o;
}

/** Reads a trailer at `o` (undefined when the record ends there: no surface data). Throws on a bad trailer. */
export function readTrailer(buf: Buffer, o: number, base: Int16Array): SurfaceData | undefined {
  if (o >= buf.length) return undefined;
  if (buf.readUInt8(o) !== SURFACE_TAG) throw new Error(`unknown trailer tag ${buf.readUInt8(o)}`);
  const version = buf.readUInt8(o + 1);
  if (version !== SURFACE_VERSION) return undefined; // a newer surface format: read the record without it
  const flags = buf.readUInt8(o + 2);
  const count = buf.readUInt8(o + 3);
  o += 4;
  const d = new SurfaceData((flags & 1) === 1);
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt8(o);
    d.nameId(buf.toString('utf8', o + 1, o + 1 + len));
    o += 1 + len;
  }
  const layer = (l: SurfaceLayer, rel: Int16Array | undefined): void => {
    if (o + 256 * 5 > buf.length) throw new Error('truncated surface layer');
    l.idx.set(buf.subarray(o, o + 256));
    o += 256;
    for (let i = 0; i < 256; i++, o += 2) {
      const v = buf.readInt16LE(o);
      const idx = l.idx[i]!;
      if (idx !== NO_NAME && idx >= count) throw new Error('bad surface name index');
      const b = rel?.[i] ?? Y_NONE;
      l.y[i] = idx === NO_NAME ? Y_NONE : rel === undefined || v === Y_NONE || b === Y_NONE ? v : v + b;
    }
    l.floor.set(buf.subarray(o, o + 256));
    o += 256;
    l.depth.set(buf.subarray(o, o + 256));
    o += 256;
  };
  layer(d.top, base);
  if (d.under) layer(d.under, undefined);
  return d;
}
