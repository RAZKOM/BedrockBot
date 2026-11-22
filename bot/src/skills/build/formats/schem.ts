// Sponge `.schem` files (Track B2, docs/build.md "Formats"): WorldEdit's and most tools' format since 1.13,
// gzipped big-endian NBT. Read from the Sponge Schematic Specification, versions 1, 2 and 3:
//
//   v1, v2: root "Schematic" { Version: int, DataVersion: int (v2), Width, Height, Length: short (unsigned),
//           Offset: int[3], PaletteMax: int, Palette: { "<block state>": int }, BlockData: byte[] (varints),
//           BlockEntities (v2) / TileEntities (v1): [...] }
//   v3:     root "" { Schematic: { Version: 3, DataVersion, Width, Height, Length, Offset,
//           Blocks: { Palette: { "<block state>": int }, Data: byte[] (varints), BlockEntities: [...] } } }
//
// The block data is one unsigned LEB128 varint per cell (7 bits a byte, the high bit set on every byte but the
// last), the cells in the order index = (y * Length + z) * Width + x. A block state is
// `minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]`. Block entities (chest contents,
// sign text), entities and biomes are not read; Offset is not used (the build's min corner goes where it is told).
import { parseJavaState, type JavaBlock } from './java.ts';
import { JavaCells } from './java-cells.ts';
import { StructureError, type Structure } from './mcstructure.ts';
import { checkVolume, compoundField, intField, readJavaNbt, unsignedShort, writeJavaNbt, type Compound } from './nbt.ts';

/** Data version written into test files (Java 1.21.1). */
export const JAVA_DATA_VERSION = 3955;

/** Decode `count` unsigned varints from a (signed) byte array. */
export function readVarints(bytes: readonly number[], count: number, what: string): number[] {
  const out = new Array<number>(count);
  let i = 0;
  for (let k = 0; k < count; k++) {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length) throw new StructureError(`${what}: block data ends after ${k} of ${count} cells`);
      const b = bytes[i++]! & 0xff;
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new StructureError(`${what}: a block data varint is longer than 5 bytes`);
    }
    out[k] = v;
  }
  return out;
}

/** Encode unsigned varints as signed bytes (prismarine-nbt's byte array). */
export function writeVarints(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let v of values) {
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v) b |= 0x80;
      out.push(b > 127 ? b - 256 : b);
    } while (v);
  }
  return out;
}

/** Parse a `.schem` file (Sponge v1, v2 or v3). */
export function readSchem(buf: Buffer, name = 'structure', version?: string): Structure {
  const { root } = readJavaNbt(buf, name);
  const s = compoundField(root, 'Schematic') ?? root;
  const v = s.Version;
  if (v !== 1 && v !== 2 && v !== 3) throw new StructureError(`${name}: Sponge schematic version ${String(v)} is not read (1, 2 and 3 are)`);
  const w = unsignedShort(intField(s, 'Width', name));
  const h = unsignedShort(intField(s, 'Height', name));
  const l = unsignedShort(intField(s, 'Length', name));
  checkVolume(name, w, h, l);
  const blocks: Compound | undefined = v === 3 ? compoundField(s, 'Blocks') : s;
  const cells = new JavaCells(version);
  const size = { x: w, y: h, z: l };
  if (!blocks) return cells.structure(name, size, 'schem'); // v3 without blocks: biomes or entities only
  const pal = compoundField(blocks, 'Palette');
  const data = v === 3 ? blocks.Data : blocks.BlockData;
  if (!pal || !Array.isArray(data)) throw new StructureError(`${name}: no ${v === 3 ? 'Blocks.Palette and Blocks.Data' : 'Palette and BlockData'}`);
  const byIndex: JavaBlock[] = [];
  for (const [state, idx] of Object.entries(pal)) {
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx > 1 << 20) throw new StructureError(`${name}: palette entry ${state} has no index`);
    byIndex[idx] = parseJavaState(state);
  }
  const mapped = cells.palette(byIndex.map((b) => b ?? parseJavaState('minecraft:air')));
  const ids = readVarints(data as number[], w * h * l, name);
  for (let y = 0; y < h; y++) {
    for (let z = 0; z < l; z++) {
      for (let x = 0; x < w; x++) {
        const id = ids[(y * l + z) * w + x]!;
        const m = mapped[id];
        if (!m || !byIndex[id]) throw new StructureError(`${name}: block id ${id} outside the palette (${byIndex.length})`);
        cells.add(x, y, z, m);
      }
    }
  }
  return cells.structure(name, size, 'schem');
}

/** A cell of a Java file a test writes: its position and Java block state. */
export interface JavaCell {
  pos: { x: number; y: number; z: number };
  /** `minecraft:oak_log[axis=x]` (namespace optional). */
  java: string;
}

/** The palette of the cells (air first) and each cell's index into it, in the order `order(x, y, z)`. */
export function javaPalette(size: { x: number; y: number; z: number }, cells: readonly JavaCell[], index: (x: number, y: number, z: number) => number): { palette: JavaBlock[]; keys: string[]; ids: number[] } {
  const keys = ['minecraft:air'];
  const palette = [parseJavaState('minecraft:air')];
  const ids = new Array<number>(size.x * size.y * size.z).fill(0);
  for (const c of cells) {
    const { x, y, z } = c.pos;
    if (x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z) throw new StructureError(`cell ${x} ${y} ${z} outside ${size.x}x${size.y}x${size.z}`);
    const b = parseJavaState(c.java);
    const key = `${b.ns}:${b.id}${Object.keys(b.props).length ? `[${Object.entries(b.props).map(([k, v]) => `${k}=${v}`).join(',')}]` : ''}`;
    let i = keys.indexOf(key);
    if (i < 0) {
      i = keys.push(key) - 1;
      palette.push(b);
    }
    ids[index(x, y, z)] = i;
  }
  return { palette, keys, ids };
}

/** Write a `.schem` (Sponge v2 or v3) holding `cells`; every other cell air. For test fixtures. */
export function writeSchem(size: { x: number; y: number; z: number }, cells: readonly JavaCell[], version: 2 | 3 = 3): Buffer {
  const { keys, ids } = javaPalette(size, cells, (x, y, z) => (y * size.z + z) * size.x + x);
  const palette = { type: 'compound', value: Object.fromEntries(keys.map((k, i) => [k, { type: 'int', value: i }])) };
  const data = { type: 'byteArray', value: writeVarints(ids) };
  const short = (n: number) => ({ type: 'short', value: n > 32767 ? n - 65536 : n });
  const common = {
    Version: { type: 'int', value: version },
    DataVersion: { type: 'int', value: JAVA_DATA_VERSION },
    Width: short(size.x),
    Height: short(size.y),
    Length: short(size.z),
    Offset: { type: 'intArray', value: [0, 0, 0] },
  };
  const none = { type: 'list', value: { type: 'compound', value: [] } };
  if (version === 2) return writeJavaNbt('Schematic', { ...common, PaletteMax: { type: 'int', value: keys.length }, Palette: palette, BlockData: data, BlockEntities: none });
  return writeJavaNbt('', { Schematic: { type: 'compound', value: { ...common, Blocks: { type: 'compound', value: { Palette: palette, Data: data, BlockEntities: none } } } } });
}
