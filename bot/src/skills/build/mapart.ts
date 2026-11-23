// Track B7 (decision 0132, docs/build.md "Map art"): a map art built where the game's maps see it. A map at scale 0
// covers 128 x 128 blocks on a fixed grid; a map art file is a whole number of such squares (`MAP_SIDE`), often with one
// more row on its north side (the "noob line": the blocks the first row's shading is measured against). `!build file
// <name> map [x z | x y z]` puts the art's first map square on the grid square holding x z (or the bot's feet), the
// noob line just north of it, and, without a y, the art's lowest block of each column above the ground of that column.
import type { TerrainSource } from '../terrain/query.ts';
import type { Cell } from './types.ts';

/** Blocks a scale-0 map covers on each side. */
export const MAP_SIDE = 128;
/**
 * Where a map's square starts on the grid: a scale-0 map covers x (and z) from 128 k + MAP_GRID_OFFSET to 128 k +
 * MAP_GRID_OFFSET + 127, its centre (the map packet's origin) at 128 k. Java's grid, and measured the same on Bedrock (BDS
 * 1.26.65.1, e2e build-mapart: maps made at 6 places, negative ones and both sides of a square's edge among them).
 */
export const MAP_GRID_OFFSET = -64;

/**
 * Blocks whose Bedrock map colour is not their Java one (measured on BDS 1.26.65.1, e2e build-mapart; docs/build.md "Map
 * art"): a Java map art would show another colour there. `map` refuses them unless `skip unknown`. Kinds marked "same
 * colour" share the measured block's Java map colour and were not measured themselves.
 */
export const MAP_COLOUR_DIFFERS: Readonly<Record<string, string>> = {
  grass_block: 'tinted by the biome on Bedrock maps',
  oak_leaves: 'tinted by the biome on Bedrock maps',
  spruce_leaves: 'tinted by the biome on Bedrock maps',
  birch_leaves: 'tinted by the biome on Bedrock maps',
  jungle_leaves: 'leaves: tinted by the biome on Bedrock maps (same colour)',
  acacia_leaves: 'leaves: tinted by the biome on Bedrock maps (same colour)',
  dark_oak_leaves: 'leaves: tinted by the biome on Bedrock maps (same colour)',
  mangrove_leaves: 'leaves: tinted by the biome on Bedrock maps (same colour)',
  purple_concrete: "Bedrock's purple is lighter",
  mycelium: "Bedrock's purple is lighter",
  amethyst_block: "Bedrock's purple is lighter",
  budding_amethyst: "Bedrock's purple is lighter (same colour)",
  purple_wool: "Bedrock's purple is lighter (same colour)",
  purple_carpet: "Bedrock's purple is lighter (same colour)",
  purple_concrete_powder: "Bedrock's purple is lighter (same colour)",
  purple_shulker_box: "Bedrock's purple is lighter (same colour)",
};

/** The file's blocks `map` refuses (MAP_COLOUR_DIFFERS), by kind, as unknown blocks are counted. */
export function mapColourRefusals(blocks: readonly { name: string }[]): { java: string; count: number; reason: string }[] {
  const n = new Map<string, number>();
  for (const b of blocks) if (MAP_COLOUR_DIFFERS[b.name] !== undefined) n.set(b.name, (n.get(b.name) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([k, count]) => ({ java: k, count, reason: `another map colour: ${MAP_COLOUR_DIFFERS[k]!}` }));
}

/** The north-west corner of the scale-0 map square holding x z. */
export function mapCorner(x: number, z: number, offset = MAP_GRID_OFFSET): { x: number; z: number } {
  const f = (v: number) => Math.floor((Math.floor(v) - offset) / MAP_SIDE) * MAP_SIDE + offset;
  return { x: f(x), z: f(z) };
}

export interface MapLayout {
  /** The map square the art's first (north-west) map lands on. */
  corner: { x: number; z: number };
  /** Maps across (x) and down (z), counted in whole squares (rounded up). */
  maps: { x: number; z: number };
  /** The file has one row more than whole maps: the noob line, set just north of the first map row. */
  noob: boolean;
  /** The file's size is a whole number of maps (with the noob line). */
  whole: boolean;
  /** The file's min corner in x and z. */
  x: number;
  z: number;
}

/** Where a file of `size` goes when its first map square is the one at `corner`. */
export function mapLayout(size: { x: number; z: number }, corner: { x: number; z: number }): MapLayout {
  const noob = size.z % MAP_SIDE === 1;
  const rows = size.z - (noob ? 1 : 0);
  const whole = size.x % MAP_SIDE === 0 && rows % MAP_SIDE === 0;
  return { corner, maps: { x: Math.ceil(size.x / MAP_SIDE), z: Math.ceil(rows / MAP_SIDE) }, noob, whole, x: corner.x, z: corner.z - (noob ? 1 : 0) };
}

/** The highest cell of column x z that holds something the art must stay above (undefined: not loaded). */
export type GroundTop = (x: number, z: number) => number | undefined;

/** A column's highest block that is not air (plants, water and leaves count: the art goes above them). */
export function groundTop(src: TerrainSource, x: number, z: number): number | undefined {
  const top = src.columnTop?.(x, z);
  if (top === undefined) return undefined;
  const min = src.minY ?? -64;
  for (let y = top; y >= min; y--) {
    const b = src.blockAt(x, y, z);
    if (!b) return undefined;
    if (b.name !== 'air') return y;
  }
  return min - 1;
}

/**
 * The y for the file's min corner so that every column's lowest block sits above that column's ground (`blocks`: the
 * file's cells, relative to its min corner, placed at x z). `unloaded`: the art's columns whose ground is not known.
 */
export function mapArtY(blocks: readonly { pos: Cell }[], x: number, z: number, ground: GroundTop): { y: number | undefined; unloaded: number; columns: number } {
  const low = new Map<number, { x: number; z: number; y: number }>();
  for (const b of blocks) {
    const k = b.pos.z * 65_536 + b.pos.x;
    const c = low.get(k);
    if (!c || b.pos.y < c.y) low.set(k, { x: b.pos.x, z: b.pos.z, y: b.pos.y });
  }
  let y: number | undefined;
  let unloaded = 0;
  for (const c of low.values()) {
    const g = ground(x + c.x, z + c.z);
    if (g === undefined) {
      unloaded++;
      continue;
    }
    const need = g + 1 - c.y;
    if (y === undefined || need > y) y = need;
  }
  return { y, unloaded, columns: low.size };
}

/** `2x2 maps at 1984 -64` (the corner the reply names). */
export function mapText(l: MapLayout): string {
  return `${l.maps.x}x${l.maps.z} map${l.maps.x * l.maps.z === 1 ? '' : 's'} from ${l.corner.x} ${l.corner.z}${l.noob ? ', noob line north' : ''}${l.whole ? '' : ', not whole maps'}`;
}
