// MCEdit `.schematic` files (Track B2, docs/build.md "Formats"): the pre-1.13 format of MCEdit, Schematica and
// WorldEdit 6, gzipped big-endian NBT with numeric block ids:
//
//   { Width, Height, Length: short, Materials: "Alpha", Blocks: byte[] (id, low 8 bits), AddBlocks: byte[]
//     (optional: the high 4 bits, two cells a byte, the even cell in the high nibble), Data: byte[] (the data value,
//     low 4 bits), TileEntities: [...], Entities: [...], SchematicaMapping: { "minecraft:stone": short } (optional) }
//
// The cells in the order index = (y * Length + z) * Width + x. Each id and data value goes through the table of
// Java 1.12 ids in java-blocks.json (`legacy`) to a Java block state, then through the one mapping like every other
// Java file. An id the table does not know (a mod's, or one vanilla never had) is an unknown block; with a
// SchematicaMapping it is named by that mapping (`create:gearbox`). Only Materials "Alpha" (Java) is read.
import { legacyToJava, mapJavaState, parseJavaState, type javaToBedrock } from './java.ts';
import { JavaCells } from './java-cells.ts';
import { StructureError, type Structure } from './mcstructure.ts';
import { checkVolume, compoundField, intField, readJavaNbt, unsignedShort, writeJavaNbt } from './nbt.ts';

/** Parse a `.schematic` file. */
export function readSchematic(buf: Buffer, name = 'structure', version?: string): Structure {
  const { root } = readJavaNbt(buf, name);
  const materials = root.Materials;
  if (materials !== undefined && materials !== 'Alpha') throw new StructureError(`${name}: Materials "${typeof materials === 'string' ? materials : JSON.stringify(materials)}" is not read (only Alpha, the Java ids)`);
  const w = unsignedShort(intField(root, 'Width', name));
  const h = unsignedShort(intField(root, 'Height', name));
  const l = unsignedShort(intField(root, 'Length', name));
  checkVolume(name, w, h, l);
  const blocks = root.Blocks;
  const data = root.Data;
  const volume = w * h * l;
  if (!Array.isArray(blocks) || blocks.length !== volume) throw new StructureError(`${name}: Blocks has ${Array.isArray(blocks) ? blocks.length : 'no'} entries for ${w}x${h}x${l} (${volume})`);
  if (data !== undefined && (!Array.isArray(data) || data.length !== volume)) throw new StructureError(`${name}: Data has ${Array.isArray(data) ? data.length : 'no'} entries for ${volume} cells`);
  const add = Array.isArray(root.AddBlocks) ? (root.AddBlocks as number[]) : undefined;
  const names = new Map<number, string>();
  for (const [n, id] of Object.entries(compoundField(root, 'SchematicaMapping') ?? {})) if (typeof id === 'number') names.set(id, n.toLowerCase());
  const cells = new JavaCells(version);
  const cache = new Map<number, ReturnType<typeof javaToBedrock> | { unknown: string; reason: string }>();
  for (let y = 0; y < h; y++) {
    for (let z = 0; z < l; z++) {
      for (let x = 0; x < w; x++) {
        const i = (y * l + z) * w + x;
        let id = (blocks[i] as number) & 0xff;
        if (add) {
          const a = (add[i >> 1] ?? 0) & 0xff;
          id |= (i & 1 ? a & 0x0f : a >> 4) << 8;
        }
        const d = ((data as number[] | undefined)?.[i] ?? 0) & 0x0f;
        const key = id * 16 + d;
        let m = cache.get(key);
        if (!m) {
          const named = names.get(id);
          const vanilla = named === undefined || parseJavaState(named).ns === 'minecraft';
          const java = vanilla ? legacyToJava(id, d) : undefined;
          if (java) m = mapJavaState(java, version);
          else if (named) m = { unknown: named, reason: parseJavaState(named).ns === 'minecraft' ? 'not a Java 1.12 block id' : 'not a Bedrock block' };
          else m = { unknown: `id ${id}${d ? `:${d}` : ''}`, reason: 'not a vanilla block id' };
          cache.set(key, m);
        }
        if ('unknown' in m) cells.addUnknown(m.unknown, m.reason);
        else cells.add(x, y, z, m);
      }
    }
  }
  return cells.structure(name, { x: w, y: h, z: l }, 'schematic');
}

/** A cell of an MCEdit file a test writes: its position, numeric id and data value. */
export interface LegacyCell {
  pos: { x: number; y: number; z: number };
  id: number;
  data?: number;
}

/** Write a `.schematic` (Materials Alpha; AddBlocks when an id is over 255). For test fixtures. */
export function writeSchematic(size: { x: number; y: number; z: number }, cells: readonly LegacyCell[], mapping?: Readonly<Record<string, number>>): Buffer {
  const volume = size.x * size.y * size.z;
  const ids = new Array<number>(volume).fill(0);
  const data = new Array<number>(volume).fill(0);
  for (const c of cells) {
    const { x, y, z } = c.pos;
    if (x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z) throw new StructureError(`cell ${x} ${y} ${z} outside ${size.x}x${size.y}x${size.z}`);
    const i = (y * size.z + z) * size.x + x;
    ids[i] = c.id;
    data[i] = c.data ?? 0;
  }
  const signed = (b: number) => (b > 127 ? b - 256 : b);
  const value: Record<string, unknown> = {
    Width: { type: 'short', value: size.x },
    Height: { type: 'short', value: size.y },
    Length: { type: 'short', value: size.z },
    Materials: { type: 'string', value: 'Alpha' },
    Blocks: { type: 'byteArray', value: ids.map((v) => signed(v & 0xff)) },
    Data: { type: 'byteArray', value: data.map((v) => signed(v & 0x0f)) },
    TileEntities: { type: 'list', value: { type: 'compound', value: [] } },
    Entities: { type: 'list', value: { type: 'compound', value: [] } },
  };
  if (ids.some((v) => v > 255)) {
    const add = new Array<number>(Math.ceil(volume / 2)).fill(0);
    ids.forEach((v, i) => {
      const hi = (v >> 8) & 0x0f;
      add[i >> 1] = add[i >> 1]! | (i & 1 ? hi : hi << 4);
    });
    value.AddBlocks = { type: 'byteArray', value: add.map(signed) };
  }
  if (mapping) value.SchematicaMapping = { type: 'compound', value: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, { type: 'short', value: v }])) };
  return writeJavaNbt('Schematic', value);
}
