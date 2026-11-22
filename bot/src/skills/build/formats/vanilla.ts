// Vanilla Java structure files, `.nbt` (Track B2, docs/build.md "Formats"): what a Java structure block saves
// and what data packs ship, gzipped big-endian NBT, read from the game's StructureTemplate layout:
//
//   { DataVersion: int, size: [int x, y, z], palette: [{ Name, Properties: { k: "v" } }]
//     (or palettes: [[...], ...], several variants: the first is read),
//     blocks: [{ state: int, pos: [int x, y, z], nbt?: {...} }], entities: [...] }
//
// Only the listed cells are part of the structure (an unlisted cell is a structure void: left as it is); a listed
// air cell is left out too (the builder never digs for a file build). Block entity data (`nbt`) and entities are
// not read.
import { formatJavaState, javaBlockOf, parseJavaState, type JavaBlock } from './java.ts';
import { JavaCells } from './java-cells.ts';
import { StructureError, type Structure } from './mcstructure.ts';
import { checkVolume, readJavaNbt, writeJavaNbt } from './nbt.ts';
import { JAVA_DATA_VERSION, type JavaCell } from './schem.ts';

const isInt3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isInteger(n));

/** Parse a vanilla `.nbt` structure. */
export function readVanilla(buf: Buffer, name = 'structure', version?: string): Structure {
  const { root } = readJavaNbt(buf, name);
  if (!isInt3(root.size)) throw new StructureError(`${name}: no size [x, y, z]`);
  const [sx, sy, sz] = root.size;
  checkVolume(name, sx, sy, sz);
  const pal = Array.isArray(root.palette) ? root.palette : Array.isArray(root.palettes) && Array.isArray(root.palettes[0]) ? (root.palettes[0] as unknown[]) : undefined;
  if (!pal) throw new StructureError(`${name}: no palette`);
  const blocks = root.blocks;
  if (!Array.isArray(blocks)) throw new StructureError(`${name}: no blocks list`);
  const cells = new JavaCells(version);
  const mapped = cells.palette((pal as { Name?: unknown; Properties?: unknown }[]).map((e) => javaBlockOf(e)));
  for (const b of blocks as { state?: unknown; pos?: unknown }[]) {
    if (typeof b.state !== 'number' || !isInt3(b.pos)) throw new StructureError(`${name}: a block without state or pos`);
    const m = mapped[b.state];
    if (!m) throw new StructureError(`${name}: state ${b.state} outside the palette (${pal.length})`);
    const [x, y, z] = b.pos;
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) throw new StructureError(`${name}: block at ${x} ${y} ${z} outside ${sx}x${sy}x${sz}`);
    cells.add(x, y, z, m);
  }
  return cells.structure(name, { x: sx, y: sy, z: sz }, 'nbt');
}

/** Write a vanilla `.nbt` structure listing `cells` (nothing else is part of it). For test fixtures. */
export function writeVanilla(size: { x: number; y: number; z: number }, cells: readonly JavaCell[]): Buffer {
  const keys: string[] = [];
  const palette: JavaBlock[] = [];
  const blocks: { state: number; pos: [number, number, number] }[] = [];
  for (const c of cells) {
    const b = parseJavaState(c.java);
    const key = formatJavaState(b);
    let i = keys.indexOf(key);
    if (i < 0) {
      i = keys.push(key) - 1;
      palette.push(b);
    }
    blocks.push({ state: i, pos: [c.pos.x, c.pos.y, c.pos.z] });
  }
  const ints = (v: readonly number[]) => ({ type: 'list', value: { type: 'int', value: [...v] } });
  return writeJavaNbt('', {
    DataVersion: { type: 'int', value: JAVA_DATA_VERSION },
    size: ints([size.x, size.y, size.z]),
    palette: {
      type: 'list',
      value: {
        type: 'compound',
        value: palette.map((b) => ({
          Name: { type: 'string', value: `${b.ns}:${b.id}` },
          ...(Object.keys(b.props).length ? { Properties: { type: 'compound', value: Object.fromEntries(Object.entries(b.props).map(([k, v]) => [k, { type: 'string', value: v }])) } } : {}),
        })),
      },
    },
    blocks: { type: 'list', value: { type: 'compound', value: blocks.map((b) => ({ state: { type: 'int', value: b.state }, pos: ints(b.pos) })) } },
    entities: { type: 'list', value: { type: 'compound', value: [] } },
  });
}
