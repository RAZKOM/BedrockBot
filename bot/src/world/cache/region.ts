// Region files of the world cache: 32 x 32 chunk columns per file, `r.<rx>.<rz>.bin`, each chunk a
// deflated summary record (summary.ts). Layout (little endian):
//   "BBWC" magic, u8 version (1), u8 reserved, u16 count, then count x (u8 lx, u8 lz, u32 length, bytes).
// Files are replaced atomically (write `<name>.<pid>.tmp`, then rename). See docs/world-cache.md.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const REGION_MAGIC = 'BBWC';
export const REGION_VERSION = 1;
export const REGION_SIZE = 32;

/** Region coordinate of a chunk coordinate. */
export const regionOf = (c: number): number => c >> 5;
/** Index of a chunk inside its region: lz * 32 + lx. */
export const slotOf = (cx: number, cz: number): number => ((cz & 31) << 5) | (cx & 31);

export function regionFileName(rx: number, rz: number): string {
  return `r.${rx}.${rz}.bin`;
}

export class RegionFormatError extends Error {
  override name = 'RegionFormatError';
}

/** Parses a region file into slot -> deflated record. */
export function parseRegion(buf: Uint8Array): Map<number, Uint8Array> {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 8 || b.toString('latin1', 0, 4) !== REGION_MAGIC) throw new RegionFormatError('not a region file (magic)');
  const version = b.readUInt8(4);
  if (version !== REGION_VERSION) throw new RegionFormatError(`region version ${version}, expected ${REGION_VERSION}`);
  const count = b.readUInt16LE(6);
  const out = new Map<number, Uint8Array>();
  let o = 8;
  for (let i = 0; i < count; i++) {
    if (o + 6 > b.length) throw new RegionFormatError('truncated entry header');
    const lx = b.readUInt8(o);
    const lz = b.readUInt8(o + 1);
    const len = b.readUInt32LE(o + 2);
    o += 6;
    if (lx > 31 || lz > 31 || o + len > b.length) throw new RegionFormatError('bad entry');
    out.set((lz << 5) | lx, new Uint8Array(b.subarray(o, o + len)));
    o += len;
  }
  return out;
}

/** Serializes slot -> deflated record (slots ascending). */
export function serializeRegion(chunks: ReadonlyMap<number, Uint8Array>): Uint8Array {
  const slots = [...chunks.keys()].sort((a, b) => a - b);
  let size = 8;
  for (const s of slots) size += 6 + chunks.get(s)!.length;
  const b = Buffer.alloc(size);
  b.write(REGION_MAGIC, 0, 'latin1');
  b.writeUInt8(REGION_VERSION, 4);
  b.writeUInt16LE(slots.length, 6);
  let o = 8;
  for (const s of slots) {
    const data = chunks.get(s)!;
    b.writeUInt8(s & 31, o);
    b.writeUInt8(s >> 5, o + 1);
    b.writeUInt32LE(data.length, o + 2);
    b.set(data, o + 6);
    o += 6 + data.length;
  }
  return b;
}

export interface RegionOnDisk {
  chunks: Map<number, Uint8Array>;
  /** mtime (ms) of the file read, undefined when it did not exist. */
  mtimeMs: number | undefined;
}

/** Reads a region file; a missing file is an empty region. Throws RegionFormatError on a corrupt file. */
export function readRegion(dir: string, rx: number, rz: number): RegionOnDisk {
  const path = join(dir, regionFileName(rx, rz));
  if (!existsSync(path)) return { chunks: new Map(), mtimeMs: undefined };
  const mtimeMs = statSync(path).mtimeMs;
  return { chunks: parseRegion(readFileSync(path)), mtimeMs };
}

/** mtime of a region file, undefined when missing. */
export function regionMtime(dir: string, rx: number, rz: number): number | undefined {
  try {
    return statSync(join(dir, regionFileName(rx, rz))).mtimeMs;
  } catch {
    return undefined;
  }
}

let tmpSeq = 0;

/** Atomic synchronous write (shutdown, eviction). Returns the bytes written. */
export function writeRegionSync(dir: string, rx: number, rz: number, chunks: ReadonlyMap<number, Uint8Array>): number {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, regionFileName(rx, rz));
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  const data = serializeRegion(chunks);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
  return data.length;
}

/** Atomic asynchronous write (periodic flush). Resolves with the bytes written. */
export async function writeRegion(dir: string, rx: number, rz: number, chunks: ReadonlyMap<number, Uint8Array>): Promise<number> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, regionFileName(rx, rz));
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  const data = serializeRegion(chunks);
  await writeFile(tmp, data);
  await rename(tmp, path);
  return data.length;
}
