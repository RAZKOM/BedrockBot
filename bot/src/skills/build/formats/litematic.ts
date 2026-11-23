// Litematica `.litematic` files (Track B2, docs/build.md "Formats"): gzipped big-endian NBT, read from
// Litematica's own layout (LitematicaSchematic, LitematicaBlockStateContainer, LitematicaBitArray):
//
//   { Version: int, SubVersion, MinecraftDataVersion, Metadata: { EnclosingSize: {x, y, z}, Name, Author, ... },
//     Regions: { "<name>": { Position: {x, y, z}, Size: {x, y, z},
//                            BlockStatePalette: [{ Name, Properties: { k: "v" } }], BlockStates: long[], ... } } }
//
// A region's Size may be negative on any axis: the region then runs from Position back to Position + Size + 1,
// and its cells are stored from that min corner. Each cell is a palette index of max(2, ceil(log2(palette
// size))) bits, packed into the longs from the low bit up, an index running over two longs where it does not
// fit (unlike the game's own chunk format); the cells in the order index = (y * sizeZ + z) * sizeX + x. Regions
// are placed relative to the lowest corner of them all. Tile entities, entities and pending ticks are not read.
// Track B7 (decision 0132): a region's box may be sparse and large (MAX_SPARSE_VOLUME, MAX_SPARSE_NBT_BYTES): the cells
// are read from 32-bit words and the blocks counted before any is kept (MAX_READ_BLOCKS).
import { formatJavaState, javaBlockOf, parseJavaState, type JavaBlock, type Mapped } from './java.ts';
import { JavaCells } from './java-cells.ts';
import { StructureError, type Structure } from './mcstructure.ts';
import { checkVolume, compoundField, longOf, longPair, MAX_SPARSE_NBT_BYTES, MAX_SPARSE_VOLUME, readJavaNbt, writeJavaNbt, type Compound } from './nbt.ts';
import { JAVA_DATA_VERSION, type JavaCell } from './schem.ts';
import { MAX_BUILD_CELLS } from '../types.ts';

interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Bits per palette index (LitematicaBlockStateContainer). */
export const litematicBits = (paletteSize: number): number => Math.max(2, 32 - Math.clz32(Math.max(1, paletteSize) - 1));

function vec(o: Compound | undefined, what: string): V3 {
  const x = o?.x;
  const y = o?.y;
  const z = o?.z;
  if (![x, y, z].every((v) => typeof v === 'number' && Number.isInteger(v))) throw new StructureError(`${what}: no x, y, z`);
  return { x: x as number, y: y as number, z: z as number };
}

/** The min corner of a region (Size may be negative). */
const minOf = (pos: V3, size: V3): V3 => ({ x: size.x < 0 ? pos.x + size.x + 1 : pos.x, y: size.y < 0 ? pos.y + size.y + 1 : pos.y, z: size.z < 0 ? pos.z + size.z + 1 : pos.z });
const absOf = (s: V3): V3 => ({ x: Math.abs(s.x), y: Math.abs(s.y), z: Math.abs(s.z) });

/** Read entry `i` of a packed array (entries may span two longs). */
export function unpackAt(longs: readonly bigint[], bits: number, i: number): number {
  const mask = (1n << BigInt(bits)) - 1n;
  const start = i * bits;
  const a = Math.floor(start / 64);
  const b = Math.floor((start + bits - 1) / 64);
  const off = BigInt(start % 64);
  const lo = BigInt.asUintN(64, longs[a] ?? 0n);
  if (a === b) return Number((lo >> off) & mask);
  const hi = BigInt.asUintN(64, longs[b] ?? 0n);
  return Number(((lo >> off) | (hi << (64n - off))) & mask);
}

/** Pack `values` at `bits` each, spanning longs (signed 64-bit results). */
export function packValues(values: readonly number[], bits: number): bigint[] {
  const out = new Array<bigint>(Math.ceil((values.length * bits) / 64)).fill(0n);
  values.forEach((v, i) => {
    const start = i * bits;
    const a = Math.floor(start / 64);
    const off = BigInt(start % 64);
    const val = BigInt(v);
    out[a] = BigInt.asUintN(64, out[a]! | (val << off));
    if (start % 64 + bits > 64) out[a + 1] = BigInt.asUintN(64, out[a + 1]! | (val >> (64n - off)));
  });
  return out.map((x) => BigInt.asIntN(64, x));
}

/**
 * Track B7 (decision 0132): a region's packed longs as 32-bit words, low word first (the packing runs from the low bit
 * of the first long up, so the longs are one little-endian stream of words).
 */
export function wordsOf(states: readonly unknown[]): Uint32Array {
  const w = new Uint32Array(states.length * 2);
  for (let i = 0; i < states.length; i++) {
    const v = states[i];
    if (Array.isArray(v) && v.length === 2) {
      w[2 * i] = Number(v[1]) >>> 0;
      w[2 * i + 1] = Number(v[0]) >>> 0;
      continue;
    }
    const u = BigInt.asUintN(64, longOf(v));
    w[2 * i] = Number(u & 0xffffffffn);
    w[2 * i + 1] = Number(u >> 32n);
  }
  return w;
}

/** Entry `i` of `bits` (at most 31) each in the words (unpackAt without a BigInt a cell). */
export function unpackWord(words: Uint32Array, bits: number, i: number): number {
  const start = i * bits;
  const w = Math.floor(start / 32);
  const off = start - w * 32;
  let v = words[w]! >>> off;
  if (off + bits > 32) v |= words[w + 1]! << (32 - off);
  return (v & ((1 << bits) - 1)) >>> 0;
}

/**
 * Track B7: the most blocks a file may hold to be read (twice what a build takes: a file a little over the build's
 * limit is still listed with its count, and refused for its size by the build).
 */
export const MAX_READ_BLOCKS = 2 * MAX_BUILD_CELLS;

/**
 * Parse a `.litematic` file. Track B7 (decision 0132): a region's box may be large and mostly air (a map art: 256 x 145 x
 * 257, 9.5 M cells, 65 792 blocks): the cells are read from the packed words (no value a cell), the blocks counted first
 * and kept only when there are at most MAX_READ_BLOCKS.
 */
export function readLitematic(buf: Buffer, name = 'structure', version?: string): Structure {
  const { root } = readJavaNbt(buf, name, MAX_SPARSE_NBT_BYTES);
  const regions = compoundField(root, 'Regions');
  if (!regions || Object.keys(regions).length === 0) throw new StructureError(`${name}: no Regions`);
  const parsed: { name: string; min: V3; size: V3; r: Compound }[] = [];
  for (const [rn, rv] of Object.entries(regions)) {
    const r = rv && typeof rv === 'object' && !Array.isArray(rv) ? (rv as Compound) : undefined;
    if (!r) continue;
    const pos = vec(compoundField(r, 'Position'), `${name}: region ${rn} Position`);
    const size = vec(compoundField(r, 'Size'), `${name}: region ${rn} Size`);
    const a = absOf(size);
    checkVolume(`${name}: region ${rn}`, a.x, a.y, a.z, MAX_SPARSE_VOLUME);
    parsed.push({ name: rn, min: minOf(pos, size), size: a, r });
  }
  if (parsed.length === 0) throw new StructureError(`${name}: no Regions`);
  const lo = { x: Math.min(...parsed.map((p) => p.min.x)), y: Math.min(...parsed.map((p) => p.min.y)), z: Math.min(...parsed.map((p) => p.min.z)) };
  const hi = { x: Math.max(...parsed.map((p) => p.min.x + p.size.x)), y: Math.max(...parsed.map((p) => p.min.y + p.size.y)), z: Math.max(...parsed.map((p) => p.min.z + p.size.z)) };
  const size = { x: hi.x - lo.x, y: hi.y - lo.y, z: hi.z - lo.z };
  checkVolume(name, size.x, size.y, size.z, MAX_SPARSE_VOLUME);
  const cells = new JavaCells(version);
  const regionCells: { p: (typeof parsed)[number]; words: Uint32Array; bits: number; mapped: Mapped[]; air: Uint8Array }[] = [];
  let blocks = 0;
  for (const p of parsed) {
    const pal = p.r.BlockStatePalette;
    const states = p.r.BlockStates;
    if (!Array.isArray(pal) || pal.length === 0) throw new StructureError(`${name}: region ${p.name} has no BlockStatePalette`);
    if (!Array.isArray(states)) throw new StructureError(`${name}: region ${p.name} has no BlockStates`);
    const palette: JavaBlock[] = (pal as { Name?: unknown; Properties?: unknown }[]).map((e) => javaBlockOf(e));
    const mapped = cells.palette(palette);
    const bits = litematicBits(palette.length);
    if (bits > 31) throw new StructureError(`${name}: region ${p.name}: a palette of ${palette.length} entries`);
    const volume = p.size.x * p.size.y * p.size.z;
    if (states.length < Math.ceil((volume * bits) / 64)) throw new StructureError(`${name}: region ${p.name}: ${states.length} longs for ${volume} cells of ${bits} bits`);
    const words = wordsOf(states);
    p.r.BlockStates = undefined; // the pairs can go as soon as the words are made
    const air = Uint8Array.from(mapped, (m) => (m.ok && m.name === 'air' ? 1 : 0));
    // the blocks counted before any is kept (a large box of air reads fast; a file of too many blocks keeps none)
    for (let i = 0; i < volume; i++) {
      const id = unpackWord(words, bits, i);
      if (id >= mapped.length) throw new StructureError(`${name}: region ${p.name}: index ${id} outside the palette (${palette.length})`);
      if (!air[id]) blocks++;
    }
    if (blocks > MAX_READ_BLOCKS) throw new StructureError(`${name}: more than ${MAX_READ_BLOCKS} blocks in ${size.x}x${size.y}x${size.z} is too large to read`);
    regionCells.push({ p, words, bits, mapped, air });
  }
  const one = regionCells.length === 1;
  // overlapping regions: the later region's non-air cell wins, as Litematica places them in order (a cell's index in
  // the whole box as the key: at most MAX_SPARSE_VOLUME)
  const at = one ? undefined : new Map<number, Mapped>();
  for (const { p, words, bits, mapped, air } of regionCells) {
    const ox = p.min.x - lo.x;
    const oy = p.min.y - lo.y;
    const oz = p.min.z - lo.z;
    let i = 0;
    for (let y = 0; y < p.size.y; y++) {
      for (let z = 0; z < p.size.z; z++) {
        for (let x = 0; x < p.size.x; x++, i++) {
          const id = unpackWord(words, bits, i);
          if (air[id]) continue;
          const m = mapped[id]!;
          if (at) at.set(((oy + y) * size.z + (oz + z)) * size.x + (ox + x), m);
          else cells.add(ox + x, oy + y, oz + z, m);
        }
      }
    }
  }
  if (at) {
    for (const [k, m] of at) {
      const x = k % size.x;
      const z = Math.floor(k / size.x) % size.z;
      const y = Math.floor(k / (size.x * size.z));
      cells.add(x, y, z, m);
    }
  }
  return cells.structure(name, size, 'litematic');
}

/** A region a test writes: its Position, its Size (negative on any axis allowed) and cells relative to its min corner. */
export interface LitematicRegion {
  name: string;
  pos: V3;
  size: V3;
  cells: readonly JavaCell[];
}

/** Write a `.litematic` with the regions; every other cell air. For test fixtures. */
export function writeLitematic(regions: readonly LitematicRegion[], meta: { name?: string; author?: string } = {}): Buffer {
  const compound = (value: Record<string, unknown>) => ({ type: 'compound', value });
  const int = (value: number) => ({ type: 'int', value });
  const xyz = (v: V3) => compound({ x: int(v.x), y: int(v.y), z: int(v.z) });
  const out: Record<string, unknown> = {};
  let total = 0;
  let volume = 0;
  const mins = regions.map((r) => minOf(r.pos, r.size));
  const sizes = regions.map((r) => absOf(r.size));
  regions.forEach((r, ri) => {
    const a = sizes[ri]!;
    const keys = ['minecraft:air'];
    const palette: JavaBlock[] = [parseJavaState('minecraft:air')];
    const ids = new Array<number>(a.x * a.y * a.z).fill(0);
    for (const c of r.cells) {
      const b = parseJavaState(c.java);
      const key = formatJavaState(b);
      let i = keys.indexOf(key);
      if (i < 0) {
        i = keys.push(key) - 1;
        palette.push(b);
      }
      const { x, y, z } = c.pos;
      if (x < 0 || y < 0 || z < 0 || x >= a.x || y >= a.y || z >= a.z) throw new StructureError(`cell ${x} ${y} ${z} outside region ${r.name}`);
      ids[(y * a.z + z) * a.x + x] = i;
      total++;
    }
    volume += ids.length;
    const longs = packValues(ids, litematicBits(palette.length));
    out[r.name] = compound({
      Position: xyz(r.pos),
      Size: xyz(r.size),
      BlockStatePalette: {
        type: 'list',
        value: {
          type: 'compound',
          value: palette.map((b) => ({
            Name: { type: 'string', value: `${b.ns}:${b.id}` },
            ...(Object.keys(b.props).length ? { Properties: compound(Object.fromEntries(Object.entries(b.props).map(([k, v]) => [k, { type: 'string', value: v }]))) } : {}),
          })),
        },
      },
      BlockStates: { type: 'longArray', value: longs.map((l) => longPair(l)) },
      TileEntities: { type: 'list', value: { type: 'compound', value: [] } },
      Entities: { type: 'list', value: { type: 'compound', value: [] } },
      PendingBlockTicks: { type: 'list', value: { type: 'compound', value: [] } },
      PendingFluidTicks: { type: 'list', value: { type: 'compound', value: [] } },
    });
  });
  const lo = { x: Math.min(...mins.map((m) => m.x)), y: Math.min(...mins.map((m) => m.y)), z: Math.min(...mins.map((m) => m.z)) };
  const hi = { x: Math.max(...mins.map((m, i) => m.x + sizes[i]!.x)), y: Math.max(...mins.map((m, i) => m.y + sizes[i]!.y)), z: Math.max(...mins.map((m, i) => m.z + sizes[i]!.z)) };
  const long = (n: number) => ({ type: 'long', value: longPair(BigInt(n)) });
  return writeJavaNbt('', {
    Version: int(6),
    SubVersion: int(1),
    MinecraftDataVersion: int(JAVA_DATA_VERSION),
    Metadata: compound({
      EnclosingSize: xyz({ x: hi.x - lo.x, y: hi.y - lo.y, z: hi.z - lo.z }),
      Name: { type: 'string', value: meta.name ?? 'test' },
      Author: { type: 'string', value: meta.author ?? 'test' },
      Description: { type: 'string', value: '' },
      RegionCount: int(regions.length),
      TotalBlocks: int(total),
      TotalVolume: int(volume),
      TimeCreated: long(0),
      TimeModified: long(0),
    }),
    Regions: compound(out),
  });
}
