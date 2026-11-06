// Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)", ADR 0068): a box of a world cache written as one
// compact file, so a real place the bot has seen can be flown offline and rebuilt on a test server. Read-only:
// the cache is opened `readOnly` (the bot may be running and writing the same regions; their writes are atomic
// renames). Generic: any cache directory, any box, any dimension.
//
//   node src/world/cache/export.ts <dir> --box x0 y0 z0 x1 y1 z1 [--tops x0 z0 x1 z1] [--dim n] [--out file]
//
// The box's cells (the cache's 2-bit classes: air / solid / water / avoid), the chunks of the box the cache has
// never seen (unknown: their cells are written as air and listed), and optionally the highest solid block of every
// column of a wider rectangle (`tops`: a cruise over it needs no more). Without --out the file goes to stdout, so
// it can run on a host through ssh without writing anything there (the script goes in on stdin, its relative
// imports rewritten against the host checkout's bot/ directory; the host needs the same commit and Node >= 23.6):
//
//   sed "s#'\./\([a-z]*\)\.ts'#'./src/world/cache/\1.ts'#g" src/world/cache/export.ts \
//     | ssh host 'cd ~/BedrockBot/bot && node --input-type=module-typescript - <dir> --box ... --tops ...' > extract.json
//
// The format (`CacheExtract`, JSON): the box, the cells packed 2 bits a cell (index ((y * sz) + z) * sx + x from
// the box's min, 4 cells a byte, low bits first) and deflated, base64; the unknown chunks; the tops as Int16 LE,
// deflated, base64 (TOP_UNKNOWN for a column of an unknown chunk, TOP_NONE for one with no solid block).
import { writeFileSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { CLS_AIR, Y_NONE, type CellClass } from './types.ts';

export const EXTRACT_FORMAT = 'bedrockbot-cache-extract';
export const EXTRACT_VERSION = 1;
/** A column of a chunk the cache has never seen. */
export const TOP_UNKNOWN = -32768;
/** A column with no solid block. */
export const TOP_NONE = -32767;

export interface Box3 {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface Rect2 {
  min: { x: number; z: number };
  max: { x: number; z: number };
}

/** The file as written (JSON). */
export interface CacheExtractFile {
  format: typeof EXTRACT_FORMAT;
  version: number;
  dim: number;
  box: Box3;
  /** Deflated 2-bit cells, base64. */
  cells: string;
  /** Chunks of the box never seen (cx, cz); their cells are air in `cells`. */
  unknown: [number, number][];
  /** The highest solid y of every column of `rect`, Int16 LE (index (z - min.z) * sx + (x - min.x)), deflated, base64. */
  tops?: { rect: Rect2; data: string };
  /** Counts by class over the known cells, and when it was written. */
  counts: { air: number; solid: number; water: number; avoid: number };
  exportedAt: string;
}

/** A decoded extract. */
export interface CacheExtract {
  dim: number;
  box: Box3;
  size: { x: number; y: number; z: number };
  /** The class of a cell of the box (outside the box: undefined). */
  cls(x: number, y: number, z: number): CellClass | undefined;
  /** The chunk was never seen by the cache. */
  unknownChunk(cx: number, cz: number): boolean;
  unknown: readonly [number, number][];
  /** The highest solid y of a column of the tops rectangle; TOP_UNKNOWN / TOP_NONE; undefined outside it. */
  top(x: number, z: number): number | undefined;
  topsRect?: Rect2;
  counts: CacheExtractFile['counts'];
  /** The packed cells (the server build reads them in order). */
  packed: Uint8Array;
}

/** Where cell (x, y, z) of `box` sits in the packed array. */
const indexOf = (box: Box3, sx: number, sz: number, x: number, y: number, z: number): number => ((y - box.min.y) * sz + (z - box.min.z)) * sx + (x - box.min.x);

/** What the exporter reads of a cache (`WorldCache` satisfies it). */
export interface ExtractSource {
  cachedSummary(cx: number, cz: number): { y0: number; rows: number; cls(x: number, y: number, z: number): CellClass; top: Int16Array } | undefined;
}

/** Build the extract of `box` (and the tops of `tops`) from a cache. */
export function extractBox(src: ExtractSource, dim: number, box: Box3, tops?: Rect2, now = new Date()): CacheExtractFile {
  const sx = box.max.x - box.min.x + 1;
  const sy = box.max.y - box.min.y + 1;
  const sz = box.max.z - box.min.z + 1;
  if (sx <= 0 || sy <= 0 || sz <= 0) throw new Error('empty box');
  const packed = new Uint8Array(Math.ceil((sx * sy * sz) / 4));
  const counts = { air: 0, solid: 0, water: 0, avoid: 0 };
  const names = ['air', 'solid', 'water', 'avoid'] as const;
  const unknown: [number, number][] = [];
  for (let cx = box.min.x >> 4; cx <= box.max.x >> 4; cx++) {
    for (let cz = box.min.z >> 4; cz <= box.max.z >> 4; cz++) {
      const s = src.cachedSummary(cx, cz);
      if (!s) {
        unknown.push([cx, cz]);
        continue;
      }
      const x0 = Math.max(box.min.x, cx * 16);
      const x1 = Math.min(box.max.x, cx * 16 + 15);
      const z0 = Math.max(box.min.z, cz * 16);
      const z1 = Math.min(box.max.z, cz * 16 + 15);
      for (let y = box.min.y; y <= box.max.y; y++) {
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            const c = s.cls(x & 15, y, z & 15);
            counts[names[c]]++;
            if (c === CLS_AIR) continue;
            const i = indexOf(box, sx, sz, x, y, z);
            packed[i >> 2] = packed[i >> 2]! | (c << ((i & 3) * 2));
          }
        }
      }
    }
  }
  const out: CacheExtractFile = { format: EXTRACT_FORMAT, version: EXTRACT_VERSION, dim, box, cells: deflateRawSync(packed, { level: 9 }).toString('base64'), unknown, counts, exportedAt: now.toISOString() };
  if (tops) {
    const tx = tops.max.x - tops.min.x + 1;
    const tz = tops.max.z - tops.min.z + 1;
    const data = new Int16Array(tx * tz);
    for (let z = tops.min.z; z <= tops.max.z; z++) {
      for (let x = tops.min.x; x <= tops.max.x; x++) {
        const s = src.cachedSummary(x >> 4, z >> 4);
        const t = s?.top[((z & 15) << 4) | (x & 15)];
        data[(z - tops.min.z) * tx + (x - tops.min.x)] = !s ? TOP_UNKNOWN : t === undefined || t === Y_NONE ? TOP_NONE : t;
      }
    }
    out.tops = { rect: tops, data: deflateRawSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { level: 9 }).toString('base64') };
  }
  return out;
}

/** Read an extract file's JSON. */
export function decodeExtract(f: CacheExtractFile): CacheExtract {
  if (f.format !== EXTRACT_FORMAT || f.version !== EXTRACT_VERSION) throw new Error(`not a cache extract (${String(f.format)} v${String(f.version)})`);
  const box = f.box;
  const sx = box.max.x - box.min.x + 1;
  const sy = box.max.y - box.min.y + 1;
  const sz = box.max.z - box.min.z + 1;
  const packed = new Uint8Array(inflateRawSync(Buffer.from(f.cells, 'base64')));
  if (packed.length < Math.ceil((sx * sy * sz) / 4)) throw new Error('cache extract: cells truncated');
  const unknownSet = new Set(f.unknown.map(([cx, cz]) => `${cx},${cz}`));
  let topData: Int16Array | undefined;
  let tx = 0;
  if (f.tops) {
    const raw = inflateRawSync(Buffer.from(f.tops.data, 'base64'));
    topData = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    tx = f.tops.rect.max.x - f.tops.rect.min.x + 1;
  }
  const rect = f.tops?.rect;
  return {
    dim: f.dim,
    box,
    size: { x: sx, y: sy, z: sz },
    cls(x, y, z) {
      if (x < box.min.x || x > box.max.x || y < box.min.y || y > box.max.y || z < box.min.z || z > box.max.z) return undefined;
      const i = indexOf(box, sx, sz, x, y, z);
      return ((packed[i >> 2]! >> ((i & 3) * 2)) & 3) as CellClass;
    },
    unknownChunk: (cx, cz) => unknownSet.has(`${cx},${cz}`),
    unknown: f.unknown,
    top(x, z) {
      if (!topData || !rect || x < rect.min.x || x > rect.max.x || z < rect.min.z || z > rect.max.z) return undefined;
      return topData[(z - rect.min.z) * tx + (x - rect.min.x)];
    },
    ...(rect ? { topsRect: rect } : {}),
    counts: f.counts,
    packed,
  };
}

async function main(argv: string[]): Promise<number> {
  const take = (flag: string, n: number): number[] | undefined => {
    const at = argv.indexOf(flag);
    if (at < 0) return undefined;
    const v = argv.splice(at, n + 1).slice(1).map(Number);
    if (v.length !== n || v.some((x) => !Number.isFinite(x))) throw new Error(`${flag} takes ${n} numbers`);
    return v;
  };
  const outAt = argv.indexOf('--out');
  const out = outAt >= 0 ? argv.splice(outAt, 2)[1] : undefined;
  const dim = take('--dim', 1)?.[0] ?? 0;
  const b = take('--box', 6);
  const t = take('--tops', 4);
  const dir = argv.find((a) => a !== '-');
  if (!dir || !b) {
    console.error('usage: node src/world/cache/export.ts <dir> --box x0 y0 z0 x1 y1 z1 [--tops x0 z0 x1 z1] [--dim n] [--out file]');
    return 2;
  }
  const box: Box3 = { min: { x: Math.min(b[0]!, b[3]!), y: Math.min(b[1]!, b[4]!), z: Math.min(b[2]!, b[5]!) }, max: { x: Math.max(b[0]!, b[3]!), y: Math.max(b[1]!, b[4]!), z: Math.max(b[2]!, b[5]!) } };
  const tops: Rect2 | undefined = t ? { min: { x: Math.min(t[0]!, t[2]!), z: Math.min(t[1]!, t[3]!) }, max: { x: Math.max(t[0]!, t[2]!), z: Math.max(t[1]!, t[3]!) } } : undefined;
  // the cache (and its registry's dependencies) only for the CLI: the decoder stays light for the loaders
  const { WorldCache } = await import('./cache.ts');
  const cache = new WorldCache({ dir, readOnly: true, maxChunks: 4096, maxRegions: 16 });
  cache.useDimension(dim);
  const t0 = performance.now();
  const f = extractBox(cache, dim, box, tops);
  const json = JSON.stringify(f);
  console.error(`export: box ${box.max.x - box.min.x + 1} x ${box.max.y - box.min.y + 1} x ${box.max.z - box.min.z + 1}, ${f.unknown.length} unknown chunks, ${JSON.stringify(f.counts)}, ${json.length} bytes, ${Math.round(performance.now() - t0)} ms`);
  if (out) {
    writeFileSync(out, json);
    return 0;
  }
  // stdout may be a pipe (ssh): exit only once it is written
  return new Promise<number>((resolve) => process.stdout.write(json, () => resolve(0)));
}

const entry = process.argv[1]?.replaceAll('\\', '/') ?? '';
if (entry.endsWith('cache/export.ts') || entry === '-' || process.env.CACHE_EXPORT_MAIN === '1') void main(process.argv.slice(2)).then((code) => process.exit(code));
