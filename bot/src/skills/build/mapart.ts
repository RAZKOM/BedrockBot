// Track B7 (decision 0132, docs/build.md "Map art"): a map art built where the game's maps see it. A map at scale 0
// covers 128 x 128 blocks on a fixed grid; a map art file is a whole number of such squares (`MAP_SIDE`), often with one
// more row on its north side (the "noob line": the blocks the first row's shading is measured against). `!build file
// <name> map [x z | x y z]` puts the art's first map square on the grid square holding x z (or the bot's feet), the
// noob line just north of it, and, without a y, the art's lowest block of each column above the ground of that column.
import { REPLACEABLE } from '../place/place.ts';
import type { TerrainSource } from '../terrain/query.ts';
import type { BuildBlock, Cell } from './types.ts';

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

/**
 * Track B8 (decision 0133): parts of a tree (and of a huge mushroom): they stand over the ground the art goes on, and
 * the art does not go over them; one in or over the art's cells refuses the build (mapArtObstacles).
 */
export const TREE_RE = /(^|_)(log|wood|leaves|stem|hyphae)$|mushroom_block$|^(vine|bee_nest|cocoa|mangrove_roots|azalea|flowering_azalea|shroomlight|moss_carpet|pale_hanging_moss)$/;

/** Track B8: a plant or snow a block replaces when it is placed into its cell (the art's own cells may hold one). */
export function plantLike(name: string): boolean {
  return REPLACEABLE.has(name) && !/water|lava/.test(name);
}

/**
 * A column's ground: its highest block that is not air (water counts: the art goes above it). Track B8: plants (a block
 * placed into their cell replaces them) and tree parts (TREE_RE) do not count: the art goes on the ground under them,
 * and a tree part in or over its cells is reported by mapArtObstacles.
 */
export function groundTop(src: TerrainSource, x: number, z: number): number | undefined {
  const top = src.columnTop?.(x, z);
  if (top === undefined) return undefined;
  const min = src.minY ?? -64;
  for (let y = top; y >= min; y--) {
    const b = src.blockAt(x, y, z);
    if (!b) return undefined;
    if (b.name !== 'air' && !plantLike(b.name) && !TREE_RE.test(b.name)) return y;
  }
  return min - 1;
}

/** Track B8: the highest block in column x z at or over y that is not air or a plant (a tree part over the art). */
export function standsAbove(src: TerrainSource, x: number, z: number, y: number): { y: number; name: string } | undefined {
  const top = src.columnTop?.(x, z);
  if (top === undefined) return undefined;
  for (let yy = top; yy >= y; yy--) {
    const b = src.blockAt(x, yy, z);
    if (b && b.name !== 'air' && !plantLike(b.name)) return { y: yy, name: b.name };
  }
  return undefined;
}

/** Track B8: what stands in or over the art's cells (`above`: standsAbove), counted by kind, the first few cells. */
export function mapArtObstacles(cells: readonly { pos: Cell }[], above: (x: number, z: number, y: number) => { y: number; name: string } | undefined): { n: number; kinds: Map<string, number>; first: { pos: Cell; name: string }[] } {
  const kinds = new Map<string, number>();
  const first: { pos: Cell; name: string }[] = [];
  let n = 0;
  for (const c of cells) {
    const a = above(c.pos.x, c.pos.z, c.pos.y);
    if (!a) continue;
    n++;
    kinds.set(a.name, (kinds.get(a.name) ?? 0) + 1);
    if (first.length < 3) first.push({ pos: { x: c.pos.x, y: a.y, z: c.pos.z }, name: a.name });
  }
  return { n, kinds, first };
}

/**
 * The y for the file's min corner so that every column's lowest block sits above that column's ground (`blocks`: the
 * file's cells, relative to its min corner, placed at x z). `unloaded`: the art's columns whose ground is not known.
 */
export function mapArtY(blocks: readonly { pos: Cell }[], x: number, z: number, ground: GroundTop): { y: number | undefined; unloaded: number; columns: number; low?: number; high?: number } {
  const low = new Map<number, { x: number; z: number; y: number }>();
  for (const b of blocks) {
    const k = b.pos.z * 65_536 + b.pos.x;
    const c = low.get(k);
    if (!c || b.pos.y < c.y) low.set(k, { x: b.pos.x, z: b.pos.z, y: b.pos.y });
  }
  let y: number | undefined;
  let unloaded = 0;
  // Track B8: the ground's range under the art (said with the y chosen)
  let gLow: number | undefined;
  let gHigh: number | undefined;
  for (const c of low.values()) {
    const g = ground(x + c.x, z + c.z);
    if (g === undefined) {
      unloaded++;
      continue;
    }
    gLow = gLow === undefined ? g : Math.min(gLow, g);
    gHigh = gHigh === undefined ? g : Math.max(gHigh, g);
    const need = g + 1 - c.y;
    if (y === undefined || need > y) y = need;
  }
  return { y, unloaded, columns: low.size, ...(gLow !== undefined && gHigh !== undefined ? { low: gLow, high: gHigh } : {}) };
}

/** `2x2 maps at 1984 -64` (the corner the reply names). */
export function mapText(l: MapLayout): string {
  return `${l.maps.x}x${l.maps.z} map${l.maps.x * l.maps.z === 1 ? '' : 's'} from ${l.corner.x} ${l.corner.z}${l.noob ? ', noob line north' : ''}${l.whole ? '' : ', not whole maps'}`;
}

// ---- Track B8 (decision 0133, docs/build.md "Map art"): the valley re-height, the map's pixels, the supports

/**
 * Java's map colours (MapColor's base RGB) by Bedrock block name: the art's 27 kinds and common map art blocks. Measured
 * on BDS 1.26.65.1 (Track B7, e2e build-mapart): every kind here shows this colour on a Bedrock map except those in
 * MAP_COLOUR_DIFFERS (grass, leaves, the purple group).
 */
export const MAP_COLOURS: Readonly<Record<string, readonly [number, number, number]>> = {
  white_wool: [255, 255, 255],
  diorite: [255, 252, 245],
  mushroom_stem: [199, 199, 199],
  white_terracotta: [209, 177, 161],
  light_gray_wool: [153, 153, 153],
  iron_block: [167, 167, 167],
  raw_iron_block: [216, 175, 147],
  light_gray_terracotta: [135, 107, 98],
  oak_planks: [143, 119, 72],
  dark_oak_planks: [102, 76, 51],
  clay: [164, 168, 184],
  dirt: [151, 109, 77],
  deepslate: [100, 100, 100],
  gray_wool: [76, 76, 76],
  stone: [112, 112, 112],
  cyan_terracotta: [87, 92, 92],
  purple_terracotta: [122, 73, 88],
  gray_terracotta: [57, 41, 35],
  light_blue_terracotta: [112, 108, 138],
  brown_terracotta: [76, 50, 35],
  verdant_froglight: [127, 167, 150],
  black_wool: [25, 25, 25],
  black_terracotta: [37, 22, 16],
  sandstone: [247, 233, 163],
  cyan_wool: [76, 127, 153],
  blue_terracotta: [76, 62, 92],
  spruce_planks: [129, 86, 49],
  grass_block: [127, 178, 56],
  white_concrete: [255, 255, 255],
  orange_concrete: [216, 127, 51],
  magenta_concrete: [178, 76, 216],
  light_blue_concrete: [102, 153, 216],
  yellow_concrete: [229, 229, 51],
  lime_concrete: [127, 204, 25],
  pink_concrete: [242, 127, 165],
  gray_concrete: [76, 76, 76],
  light_gray_concrete: [153, 153, 153],
  cyan_concrete: [76, 127, 153],
  purple_concrete: [127, 63, 178],
  blue_concrete: [51, 76, 178],
  brown_concrete: [102, 76, 51],
  green_concrete: [102, 127, 51],
  red_concrete: [153, 51, 51],
  black_concrete: [25, 25, 25],
  hardened_clay: [216, 127, 51],
  orange_terracotta: [159, 82, 36],
  magenta_terracotta: [149, 87, 108],
  yellow_terracotta: [186, 133, 36],
  lime_terracotta: [103, 117, 53],
  pink_terracotta: [160, 77, 78],
  green_terracotta: [76, 82, 42],
  red_terracotta: [142, 60, 46],
  oak_leaves: [0, 124, 0],
  birch_leaves: [0, 124, 0],
  spruce_leaves: [0, 124, 0],
  birch_planks: [247, 233, 163],
  jungle_planks: [151, 109, 77],
  acacia_planks: [216, 127, 51],
  crimson_planks: [148, 63, 97],
  warped_planks: [58, 142, 140],
  mangrove_planks: [153, 51, 51],
  cherry_planks: [209, 177, 161],
  bamboo_planks: [229, 229, 51],
  lapis_block: [74, 128, 255],
  emerald_block: [0, 217, 58],
  gold_block: [250, 238, 77],
  diamond_block: [92, 219, 213],
  redstone_block: [255, 0, 0],
  quartz_block: [255, 252, 245],
  netherrack: [112, 2, 0],
  obsidian: [25, 25, 25],
  snow: [255, 255, 255],
  packed_ice: [160, 160, 255],
  slime: [127, 178, 56],
  pumpkin: [216, 127, 51],
  melon_block: [127, 204, 25],
  moss_block: [102, 127, 51],
  nether_wart_block: [153, 51, 51],
  warped_wart_block: [20, 180, 133],
  crimson_nylium: [189, 48, 49],
  warped_nylium: [22, 126, 134],
  mycelium: [127, 63, 178],
  podzol: [129, 86, 49],
  end_stone: [247, 233, 163],
  glowstone: [247, 233, 163],
  bone_block: [247, 233, 163],
  purpur_block: [178, 76, 216],
  prismarine: [76, 127, 153],
  dark_prismarine: [92, 219, 213],
  amethyst_block: [127, 63, 178],
  calcite: [209, 177, 161],
  tuff: [57, 41, 35],
  packed_mud: [151, 109, 77],
  raw_gold_block: [250, 238, 77],
  raw_copper_block: [216, 127, 51],
  coal_block: [25, 25, 25],
  honey_block: [216, 127, 51],
};

/** A map pixel's shade: its block higher than, level with or lower than the block north of it, whatever the step. */
export type Shade = 'higher' | 'level' | 'lower';
/** The shade's factor out of 255 (measured on Bedrock by Track B7, Java's too). */
export const SHADE_FACTOR: Readonly<Record<Shade, number>> = { higher: 255, level: 220, lower: 180 };

/** The colour a map shows for a block with a shade (undefined: a kind with no colour in MAP_COLOURS). */
export function pixelColour(name: string, shade: Shade): [number, number, number] | undefined {
  const c = MAP_COLOURS[name];
  if (!c) return undefined;
  const f = SHADE_FACTOR[shade];
  return [Math.floor((c[0] * f) / 255), Math.floor((c[1] * f) / 255), Math.floor((c[2] * f) / 255)];
}

/** A column's top block (what a map sees there). */
interface Top {
  y: number;
  name: string;
}

const colKey = (x: number, z: number): number => x * 1_048_576 + z;

function topsOf(blocks: readonly BuildBlock[]): Map<number, Top & { x: number; z: number }> {
  const out = new Map<number, Top & { x: number; z: number }>();
  for (const b of blocks) {
    const k = colKey(b.pos.x, b.pos.z);
    const t = out.get(k);
    if (!t || b.pos.y > t.y) out.set(k, { x: b.pos.x, z: b.pos.z, y: b.pos.y, name: b.name });
  }
  return out;
}

export interface MapPixel {
  x: number;
  z: number;
  name: string;
  shade: Shade;
}

/**
 * Track B8: how a map shades a step. Both games compute e = dy * 4/5 + ((x + z) & 1 - 0.5) * 0.4 for a block dy over the
 * block north of it (x z its world column; a scale-0 map's pixel has the same parity), higher when e > 0.6, lower when
 * e < -0.6. A step of 1 lands on 0.6 at one parity: Java's doubles come out a hair over it (any step of 1 shows), Bedrock
 * does not (measured on BDS 1.26.60.6, e2e build-mapart `BUILD_MAPART_SHADE`: a step up of 1 is level where x + z is
 * even, a step down of 1 level where it is odd; steps of 2 or more always shade). `java`: the shade a Java map art
 * means (the sign of the step); `bedrock`: what a Bedrock map shows.
 */
export type ShadeRule = 'java' | 'bedrock';

export function stepShade(dy: number, x: number, z: number, rule: ShadeRule = 'bedrock'): Shade {
  if (rule === 'java') return dy > 0 ? 'higher' : dy === 0 ? 'level' : 'lower';
  // in tenths: 8 dy + 2 (x + z odd) or - 2 (even), against 6
  const e = 8 * dy + (((x + z) & 1) === 1 ? 2 : -2);
  return e > 6 ? 'higher' : e < -6 ? 'lower' : 'level';
}

/**
 * The pixels a map shows of the blocks: each column's top block, shaded by its height against the top of the column just
 * north of it (same x, z - 1) by `rule` (`java` by default: what a Java map art means; `bedrock` with `at`, the world
 * column of the blocks' x 0 z 0, for what a Bedrock map shows). A column with no column north of it (the noob line) is
 * no pixel: its shade depends on what stands outside the art.
 */
export function mapPixels(blocks: readonly BuildBlock[], o: { rule?: ShadeRule; at?: { x: number; z: number } } = {}): MapPixel[] {
  const tops = topsOf(blocks);
  const rule = o.rule ?? 'java';
  const ax = o.at?.x ?? 0;
  const az = o.at?.z ?? 0;
  const out: MapPixel[] = [];
  for (const t of tops.values()) {
    const n = tops.get(colKey(t.x, t.z - 1));
    if (!n) continue;
    out.push({ x: t.x, z: t.z, name: t.name, shade: stepShade(t.y - n.y, ax + t.x, az + t.z, rule) });
  }
  return out;
}

/** The pixels of `a` and `b` that differ (a pixel only one of them has counts too). */
export function pixelDiffs(a: readonly MapPixel[], b: readonly MapPixel[]): { x: number; z: number; a?: string; b?: string }[] {
  const text = (p: MapPixel): string => {
    const c = pixelColour(p.name, p.shade);
    return c ? c.join(',') : `${p.name}/${p.shade}`;
  };
  const am = new Map(a.map((p) => [colKey(p.x, p.z), p] as const));
  const bm = new Map(b.map((p) => [colKey(p.x, p.z), p] as const));
  const out: { x: number; z: number; a?: string; b?: string }[] = [];
  for (const [k, p] of am) {
    const q = bm.get(k);
    if (!q || text(p) !== text(q)) out.push({ x: p.x, z: p.z, a: text(p), ...(q ? { b: text(q) } : {}) });
  }
  for (const [k, q] of bm) if (!am.has(k)) out.push({ x: q.x, z: q.z, b: text(q) });
  return out;
}

export interface ValleyStrip {
  /** The strip's x (file coordinates). */
  x: number;
  /** Lowest and highest block of the strip, as given and re-heighted. */
  before: [number, number];
  after: [number, number];
}

export interface Valley {
  /** The blocks re-heighted (file coordinates; the lowest at y 0). */
  blocks: BuildBlock[];
  /** The art's height (highest - lowest + 1), as given and re-heighted. */
  before: number;
  after: number;
  strips: ValleyStrip[];
}

/**
 * Track B8 (decision 0133): the lowest heights that give the same map on Bedrock. A pixel's shade depends only on its
 * block's height against the block north of it, so each north-south strip (one x) is re-heighted on its own: every step
 * keeps the shade the file means (its sign: `java`) and the heights are the least that show it on a Bedrock map
 * (stepShade `bedrock`: a step of 1 where its parity shows it, else 2; a level step may be a step of 1 where the map
 * shows that level), none under 0: every block the least height the steps before and after it allow (a backward pass
 * for what the descents ahead need, a forward pass taking the least). `at`: the world column of the file's x 0 z 0 (the parity). The noob
 * line (z = 0) stays the first row's reference. One block a column only (a staircase map art); a strip with a gap in z
 * starts again after it. The pixels are the same: mapPixels of the file (`java`) and of the result (`bedrock`, at) agree.
 */
export function valley(blocks: readonly BuildBlock[], o: { at?: { x: number; z: number } } = {}): Valley {
  const ax = o.at?.x ?? 0;
  const az = o.at?.z ?? 0;
  // the least rise and drop that shade on a Bedrock map at a block's column
  const rise = (x: number, z: number): number => (stepShade(1, ax + x, az + z) === 'higher' ? 1 : 2);
  const drop = (x: number, z: number): number => (stepShade(-1, ax + x, az + z) === 'lower' ? 1 : 2);
  // a step of 1 a Bedrock map shows level (up where x + z is even, down where odd): a level row may drift by it
  const flatUp = (x: number, z: number): number => (stepShade(1, ax + x, az + z) === 'level' ? 1 : 0);
  const flatDown = (x: number, z: number): number => (stepShade(-1, ax + x, az + z) === 'level' ? 1 : 0);
  const tops = topsOf(blocks);
  if (tops.size !== blocks.length) throw new Error(`valley: ${blocks.length - tops.size} columns hold more than one block (a staircase map art has one a column)`);
  const strips = new Map<number, (Top & { x: number; z: number; b: BuildBlock })[]>();
  for (const b of blocks) {
    let l = strips.get(b.pos.x);
    if (!l) strips.set(b.pos.x, (l = []));
    l.push({ x: b.pos.x, z: b.pos.z, y: b.pos.y, name: b.name, b });
  }
  const out: BuildBlock[] = [];
  const rows: ValleyStrip[] = [];
  let lo0 = Infinity;
  let hi0 = -Infinity;
  let hi1 = -Infinity;
  for (const x of [...strips.keys()].sort((a, b) => a - b)) {
    const l = strips.get(x)!.sort((a, b) => a.z - b.z);
    const n = l.length;
    const sign = (i: number): number => (i > 0 && l[i]!.z === l[i - 1]!.z + 1 ? Math.sign(l[i]!.y - l[i - 1]!.y) : 2); // 2: no north block (a run starts)
    // the least height each block needs for the steps after it (back to front), then the heights front to back
    const need = new Int32Array(n);
    for (let i = n - 2; i >= 0; i--) {
      const s = sign(i + 1);
      need[i] = s === -1 ? need[i + 1]! + drop(x, l[i + 1]!.z) : s === 0 ? Math.max(0, need[i + 1]! - flatUp(x, l[i + 1]!.z)) : 0;
    }
    const h = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const s = sign(i);
      if (s === 0) {
        // level: the least of the heights the map shows level that the steps after it allow
        const p = h[i - 1]!;
        const lo = p - flatDown(x, l[i]!.z);
        h[i] = lo >= need[i]! ? lo : p >= need[i]! ? p : p + flatUp(x, l[i]!.z);
      } else h[i] = s === 2 ? need[i]! : s === 1 ? Math.max(h[i - 1]! + rise(x, l[i]!.z), need[i]!) : need[i]!;
    }
    let a0 = Infinity;
    let b0 = -Infinity;
    let a1 = Infinity;
    let b1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = l[i]!;
      a0 = Math.min(a0, c.y);
      b0 = Math.max(b0, c.y);
      a1 = Math.min(a1, h[i]!);
      b1 = Math.max(b1, h[i]!);
      out.push({ ...c.b, pos: { x: c.x, y: h[i]!, z: c.z } });
    }
    lo0 = Math.min(lo0, a0);
    hi0 = Math.max(hi0, b0);
    hi1 = Math.max(hi1, b1);
    rows.push({ x, before: [a0, b0], after: [a1, b1] });
  }
  return { blocks: out, before: blocks.length ? hi0 - lo0 + 1 : 0, after: blocks.length ? hi1 + 1 : 0, strips: rows };
}

/** `valley 77 high (a strip 31 at the median), was 145` */
export function valleyText(v: Valley): string {
  const highs = v.strips.map((s) => s.after[1] + 1).sort((a, b) => a - b);
  const mid = highs[highs.length >> 1] ?? 0;
  return `valley ${v.after} high (a strip ${mid} at the median), was ${v.before}`;
}

/**
 * Track B8 (decision 0133): the highest scaffold column a valley map art pillars up (its height over the ground, less the
 * reach, decides; the art is at most 384 high, a column at most this). A fall from 32 already kills: no new risk.
 */
export const MAP_COLUMN_MAX = 128;

/** Track B8: the block a support is (a cheap one; under an art block a map never sees it). */
export const MAP_SUPPORT = 'cobblestone';

/** Track B8: a support chain goes at most this far down (past it the planner's own supports take over). */
export const SUPPORT_DEPTH = 384;

/**
 * Track B8: the world as the supports see it: true for a block a placement can click (the ground, a block placed
 * before), false for air or a plant, undefined where it is not known (not loaded).
 */
export type SolidAt = (x: number, y: number, z: number) => boolean | undefined;

/**
 * Track B8 (decision 0133): the supports a one-block-a-column art needs so that every block has something to click when
 * its turn comes, the build going in tiles of `side` x `side` columns (job.ts `tiles`, in any order), each tile bottom
 * layer first. A block can be clicked against a block under it (the ground, a support), a block beside it in the same
 * layer placed before it, or a block that is there already; so in each tile every group of cells joined side by side in
 * a layer needs one cell with something under it. A group without one gets a chain of supports under one of its cells,
 * the shortest there is: down to the first cell with a block of the tile (or of the world) beside it, or onto a block.
 * A support only ever stands under its own column's art block, so a map never sees it and it never becomes a column's
 * top. `solid`: the world (SolidAt; without it, or where it is not known, the ground is taken flat, just under the art's lowest block). Returns
 * the support cells.
 */
export function mapSupports(art: readonly { pos: Cell }[], o: { side: number; origin: { x: number; z: number }; solid?: SolidAt | undefined }): Cell[] {
  let artLow = Infinity;
  for (const c of art) artLow = Math.min(artLow, c.pos.y);
  // where the world is not known (not loaded), the ground is taken just under the art's lowest block: the same supports
  // whatever the bot has loaded (at the command and at a resume from elsewhere)
  const solid: SolidAt = (x, y, z) => o.solid?.(x, y, z) ?? y < artLow;
  const tilesOf = new Map<number, Cell[]>();
  for (const c of art) {
    const k = Math.floor((c.pos.x - o.origin.x) / o.side) * 65_536 + Math.floor((c.pos.z - o.origin.z) / o.side);
    let l = tilesOf.get(k);
    if (!l) tilesOf.set(k, (l = []));
    l.push(c.pos);
  }
  const out: Cell[] = [];
  const ck = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  const SIDE4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  for (const cells of tilesOf.values()) {
    const s = new Set<string>(cells.map((c) => ck(c.x, c.y, c.z)));
    const byY = new Map<number, Cell[]>();
    const addCell = (c: Cell) => {
      let l = byY.get(c.y);
      if (!l) byY.set(c.y, (l = []));
      l.push(c);
    };
    for (const c of cells) addCell(c);
    const ys = [...byY.keys()].sort((a, b) => b - a);
    let low = ys.at(-1) ?? 0;
    const there = (x: number, y: number, z: number): boolean => solid(x, y, z) === true;
    const has = (x: number, y: number, z: number): boolean => s.has(ck(x, y, z)) || there(x, y, z);
    const beside = (x: number, y: number, z: number): boolean => SIDE4.some(([dx, dz]) => has(x + dx, y, z + dz));
    for (let y = ys[0] ?? 0; y >= low; y--) {
      const layer = byY.get(y);
      if (!layer) continue;
      const seen = new Set<string>();
      for (const c0 of layer) {
        if (seen.has(ck(c0.x, y, c0.z))) continue;
        // the group of cells joined side by side in this layer
        const group: Cell[] = [c0];
        seen.add(ck(c0.x, y, c0.z));
        // (an array's iterator reads its length each step: the cells pushed are visited too)
        for (const g of group) {
          for (const [dx, dz] of SIDE4) {
            const k = ck(g.x + dx, y, g.z + dz);
            if (!seen.has(k) && s.has(k)) {
              seen.add(k);
              group.push({ x: g.x + dx, y, z: g.z + dz });
            }
          }
        }
        // anchored: a cell already there, one with a block (or a cell of the build) under it, or one beside a block
        if (group.some((g) => there(g.x, y, g.z) || has(g.x, y - 1, g.z) || SIDE4.some(([dx, dz]) => there(g.x + dx, y, g.z + dz)))) continue;
        // the shortest chain down under one of them
        let best: Cell | undefined;
        let bestN = Infinity;
        for (const g of group) {
          for (let d = 1; d <= SUPPORT_DEPTH && d < bestN; d++) {
            const yy = y - d;
            const here = solid(g.x, yy, g.z);
            if (here === undefined) break;
            if (here) {
              // a block under the chain: d - 1 supports rest on it
              if (d - 1 < bestN) {
                bestN = d - 1;
                best = g;
              }
              break;
            }
            if (beside(g.x, yy, g.z)) {
              bestN = d;
              best = g;
              break;
            }
          }
        }
        if (!best || bestN < 1) continue; // nothing under it that is known: the planner's own supports
        for (let d = 1; d <= bestN; d++) {
          const c = { x: best.x, y: y - d, z: best.z };
          s.add(ck(c.x, c.y, c.z));
          addCell(c);
          out.push(c);
          low = Math.min(low, c.y);
        }
      }
    }
  }
  return out;
}

