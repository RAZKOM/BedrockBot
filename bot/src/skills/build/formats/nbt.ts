// Java-edition NBT for the structure readers (Track B2, docs/build.md "Formats"): `.schem`, `.schematic`,
// `.litematic` and vanilla `.nbt` are big-endian NBT, gzipped (Node's own zlib; an uncompressed file is read as it
// is). prismarine-nbt parses the tags; `simplify` turns them into plain values: a long is a [high, low] pair of
// signed 32-bit halves (`longOf` makes it a BigInt), a byte array a list of signed bytes.
import { gunzipSync, gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';
import { StructureError } from './mcstructure.ts';

/** A compressed file larger than this is not read (a build of 4096 cells is a few kilobytes). */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** What gunzip may produce at most. */
export const MAX_NBT_BYTES = 64 * 1024 * 1024;
/** A structure with more cells than this (air counted) is refused before its blocks are read. */
export const MAX_VOLUME = 4 * 1024 * 1024;

export type Compound = Record<string, unknown>;

const isGzip = (b: Buffer): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** The root compound of a big-endian (optionally gzipped) NBT file, simplified, and the root's own name. */
export function readJavaNbt(buf: Buffer, name: string): { root: Compound; rootName: string } {
  if (buf.length > MAX_FILE_BYTES) throw new StructureError(`${name}: ${buf.length} bytes is too large to read (at most ${MAX_FILE_BYTES})`);
  let raw = buf;
  if (isGzip(buf)) {
    try {
      raw = gunzipSync(buf, { maxOutputLength: MAX_NBT_BYTES });
    } catch (e) {
      throw new StructureError(`${name}: not a gzip file (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  let parsed: { name?: string; type: string; value: unknown };
  try {
    parsed = nbt.parseUncompressed(raw, 'big');
  } catch (e) {
    throw new StructureError(`${name}: not a big-endian NBT file (${e instanceof Error ? e.message : String(e)})`);
  }
  if (parsed.type !== 'compound') throw new StructureError(`${name}: the NBT root is not a compound`);
  return { root: nbt.simplify(parsed as unknown as nbt.NBT) as Compound, rootName: parsed.name ?? '' };
}

/** Write a big-endian NBT root (prismarine-nbt's typed form), gzipped as the Java tools write it. */
export function writeJavaNbt(rootName: string, value: Record<string, unknown>, gzip = true): Buffer {
  const out = nbt.writeUncompressed({ type: 'compound', name: rootName, value } as unknown as nbt.NBT, 'big');
  return gzip ? gzipSync(out) : out;
}

/** A simplified NBT long ([high, low]) or a number as a BigInt (two's complement 64 bits). */
export function longOf(v: unknown): bigint {
  if (typeof v === 'bigint') return BigInt.asIntN(64, v);
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (Array.isArray(v) && v.length === 2) return BigInt.asIntN(64, (BigInt(Number(v[0]) | 0) << 32n) | BigInt(Number(v[1]) >>> 0));
  throw new StructureError(`not a long: ${JSON.stringify(v)}`);
}

/** A BigInt as prismarine-nbt's [high, low] long pair. */
export function longPair(v: bigint): [number, number] {
  const u = BigInt.asUintN(64, v);
  return [Number(BigInt.asIntN(32, u >> 32n)), Number(BigInt.asIntN(32, u & 0xffffffffn))];
}

/** An integer field (short, int, byte) or throws with the field's name. */
export function intField(o: Compound | undefined, key: string, what: string): number {
  const v = o?.[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new StructureError(`${what}: no ${key}`);
  return v;
}

/** A short read as unsigned (Sponge and MCEdit sizes are shorts up to 65535). */
export const unsignedShort = (v: number): number => v & 0xffff;

/** A compound field, or undefined. */
export function compoundField(o: Compound | undefined, key: string): Compound | undefined {
  const v = o?.[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Compound) : undefined;
}

/** Refuse a volume no build could use before reading its cells. */
export function checkVolume(name: string, x: number, y: number, z: number): void {
  if (x < 0 || y < 0 || z < 0) throw new StructureError(`${name}: negative size ${x}x${y}x${z}`);
  const v = x * y * z;
  if (v > MAX_VOLUME) throw new StructureError(`${name}: ${x}x${y}x${z} (${v} cells) is too large to read (at most ${MAX_VOLUME} cells)`);
}
