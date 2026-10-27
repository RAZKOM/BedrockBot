// `.mcstructure` files (wave 9, Track AL; docs/build.md "Formats"): Bedrock's structure-block format,
// uncompressed little-endian NBT:
//
//   { format_version: int 1, size: [int sx, sy, sz], structure_world_origin: [int x, y, z],
//     structure: { block_indices: [[int ...], [int ...]], entities: [...],
//                  palette: { default: { block_palette: [{ name, states, version }], block_position_data } } } }
//
// block_indices[0] is the block layer, [1] the waterlogging layer (ignored here); index i of the cell
// (x, y, z) is (x * sy + y) * sz + z (x outermost, z innermost); -1 = structure void (nothing). The
// layout is the one BDS loads (packs/truth/structures/truth/probe.mcstructure is placed by truth:place
// and compared cell by cell in build-file.test.ts). Entities and block entity data are not read.
import nbt from 'prismarine-nbt';
import { blockId, isAirName, type BuildBlock } from '../types.ts';

/** A structure relative to its min corner (0, 0, 0). */
export interface Structure {
  name: string;
  size: { x: number; y: number; z: number };
  /** Every non-air cell. */
  blocks: BuildBlock[];
}

export class StructureError extends Error {
  override name = 'StructureError';
}

/** Block data version written into new files (1.21.60.33, upgraded by newer servers on load). */
export const BLOCK_VERSION = 18168865;

/** Index of cell (x, y, z) in block_indices. */
export function mcIndex(size: { y: number; z: number }, x: number, y: number, z: number): number {
  return (x * size.y + y) * size.z + z;
}

interface PaletteEntry {
  name?: unknown;
  states?: unknown;
}

/** Parse a .mcstructure file. */
export function readMcstructure(buf: Buffer, name = 'structure'): Structure {
  let root: Record<string, unknown>;
  try {
    root = nbt.simplify(nbt.parseUncompressed(buf, 'little')) as Record<string, unknown>;
  } catch (e) {
    throw new StructureError(`${name}: not a little-endian NBT file (${e instanceof Error ? e.message : String(e)})`);
  }
  const size = root.size;
  if (!Array.isArray(size) || size.length !== 3 || !size.every((v) => Number.isInteger(v) && (v as number) >= 0)) throw new StructureError(`${name}: no size [x, y, z]`);
  const [sx, sy, sz] = size as number[];
  const s = root.structure as { block_indices?: unknown; palette?: { default?: { block_palette?: unknown } } } | undefined;
  const layers = s?.block_indices;
  if (!Array.isArray(layers) || !Array.isArray(layers[0])) throw new StructureError(`${name}: no structure.block_indices`);
  const indices = layers[0] as number[];
  const volume = sx! * sy! * sz!;
  if (indices.length !== volume) throw new StructureError(`${name}: ${indices.length} block indices for a ${sx}x${sy}x${sz} structure (${volume})`);
  const pal = s?.palette?.default?.block_palette;
  if (!Array.isArray(pal)) throw new StructureError(`${name}: no structure.palette.default.block_palette`);
  const palette = (pal as PaletteEntry[]).map((p, i) => {
    if (typeof p.name !== 'string') throw new StructureError(`${name}: palette entry ${i} has no name`);
    const states = p.states && typeof p.states === 'object' ? (p.states as Record<string, unknown>) : {};
    return { name: blockId(p.name), states };
  });
  const blocks: BuildBlock[] = [];
  for (let x = 0; x < sx!; x++) {
    for (let y = 0; y < sy!; y++) {
      for (let z = 0; z < sz!; z++) {
        const i = indices[mcIndex({ y: sy!, z: sz! }, x, y, z)]!;
        if (i < 0) continue;
        const p = palette[i];
        if (!p) throw new StructureError(`${name}: block index ${i} outside the palette (${palette.length})`);
        if (isAirName(p.name)) continue;
        blocks.push({ pos: { x, y, z }, name: p.name, ...(Object.keys(p.states).length ? { states: p.states } : {}) });
      }
    }
  }
  return { name, size: { x: sx!, y: sy!, z: sz! }, blocks };
}

/** NBT tag for a plain state value (strings, booleans as bytes, integers as ints). */
function stateTag(v: unknown): { type: 'string' | 'byte' | 'int'; value: string | number } {
  if (typeof v === 'string') return { type: 'string', value: v };
  if (typeof v === 'boolean') return { type: 'byte', value: v ? 1 : 0 };
  if (typeof v === 'number' && Number.isInteger(v)) return { type: 'int', value: v };
  throw new StructureError(`state value ${JSON.stringify(v)} is not a string, boolean or integer`);
}

/**
 * Write a .mcstructure (the layout above): `blocks` relative to (0, 0, 0) inside `size`, every other
 * cell air. Used for test fixtures and round trips.
 */
export function writeMcstructure(size: { x: number; y: number; z: number }, blocks: readonly BuildBlock[]): Buffer {
  const palette: { name: string; states: Readonly<Record<string, unknown>> }[] = [{ name: 'minecraft:air', states: {} }];
  const index = new Map<string, number>([['minecraft:air{}', 0]]);
  const indices = new Array<number>(size.x * size.y * size.z).fill(0);
  for (const b of blocks) {
    const { x, y, z } = b.pos;
    if (x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z) throw new StructureError(`block at ${x} ${y} ${z} outside ${size.x}x${size.y}x${size.z}`);
    const name = `minecraft:${blockId(b.name)}`;
    const states = b.states ?? {};
    const k = `${name}${JSON.stringify(states)}`;
    let i = index.get(k);
    if (i === undefined) {
      i = palette.length;
      palette.push({ name, states });
      index.set(k, i);
    }
    indices[mcIndex(size, x, y, z)] = i;
  }
  const intList = (arr: number[]) => ({ type: 'list', value: { type: 'int', value: arr } });
  const root = {
    type: 'compound',
    name: '',
    value: {
      format_version: { type: 'int', value: 1 },
      size: intList([size.x, size.y, size.z]),
      structure_world_origin: intList([0, 0, 0]),
      structure: {
        type: 'compound',
        value: {
          block_indices: { type: 'list', value: { type: 'list', value: [{ type: 'int', value: indices }, { type: 'int', value: indices.map(() => -1) }] } },
          entities: { type: 'list', value: { type: 'compound', value: [] } },
          palette: {
            type: 'compound',
            value: {
              default: {
                type: 'compound',
                value: {
                  block_palette: {
                    type: 'list',
                    value: {
                      type: 'compound',
                      value: palette.map((p) => ({
                        name: { type: 'string', value: p.name },
                        states: { type: 'compound', value: Object.fromEntries(Object.entries(p.states).map(([k, v]) => [k, stateTag(v)])) },
                        version: { type: 'int', value: BLOCK_VERSION },
                      })),
                    },
                  },
                  block_position_data: { type: 'compound', value: {} },
                },
              },
            },
          },
        },
      },
    },
  };
  return nbt.writeUncompressed(root as unknown as nbt.NBT, 'little');
}
