// Block palettes dumped from BDS (wave 8, Track AC; docs/versions.md "Block states", decision 0024).
// `bot/data/block-palette/<version>.json` holds every block state of one game version as the server hashes
// it (written by tools/bump-version/dump-palette.mjs through the truth pack). The world registry builds its
// runtime-id table from it; minecraft-data's tables (1.26.30 for 1.26.51 / 1.26.60) still provide hardness
// and collision shapes, by name.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Typed (NBT) state values, the shape minecraft-data uses: { pillar_axis: { type: 'string', value: 'y' } }. */
export type PaletteTypedStates = Record<string, { type: 'byte' | 'int' | 'string'; value: number | string }>;

export interface PaletteEntry {
  /** Block name without `minecraft:` (minecraft-data naming). */
  name: string;
  /** States in sorted key order (the order the hash uses). */
  states: PaletteTypedStates;
  /** The block type's default permutation. */
  isDefault: boolean;
}

export interface BlockPalette {
  /** Game version the file is for (`1.26.60`). */
  version: string;
  /** BDS build it was dumped from (`1.26.60.6`). */
  bds: string;
  dumped: string;
  types: number;
  /** Every state, grouped by block (blocks sorted by name), the default of each block first. */
  entries: PaletteEntry[];
  /** Milliseconds spent reading and expanding the file. */
  loadMs: number;
}

/** Compact file format 1 (tools/bump-version/lib/palette-format.mjs). */
interface PaletteFile {
  format: number;
  version: string;
  bds: string;
  dumped: string;
  types: number;
  permutations: number;
  strings: string[];
  blocks: [number, [number, number, (number | string)[]][], number, number[] | null][];
}

const TAGS = ['byte', 'int', 'string'] as const;
const DATA_DIR = new URL('../../../data/block-palette/', import.meta.url);
const cache = new Map<string, BlockPalette | null>();

/** Path of the palette file for a game version (whether or not it exists). */
export function palettePath(version: string): string {
  return fileURLToPath(new URL(`${version}.json`, DATA_DIR));
}

/** Expands a compact palette file. Throws on a format it does not know. */
export function expandPalette(file: PaletteFile): Omit<BlockPalette, 'loadMs'> {
  if (file.format !== 1) throw new Error(`block palette ${file.version}: unknown format ${file.format}`);
  const S = file.strings;
  const entries: PaletteEntry[] = [];
  for (const [nameIdx, states, def, perms] of file.blocks) {
    const name = S[nameIdx]!;
    const keys = states.map((s) => S[s[0]]!);
    const tags = states.map((s) => TAGS[s[1]]!);
    const values = states.map((s, i) => (tags[i] === 'string' ? s[2].map((v) => S[v as number]!) : (s[2] as number[])));
    let product = 1;
    for (const v of values) product *= v.length;
    const at = (index: number): PaletteTypedStates => {
      const out: PaletteTypedStates = {};
      for (let i = keys.length - 1; i >= 0; i--) {
        const n = values[i]!.length;
        out[keys[i]!] = { type: tags[i]!, value: values[i]![index % n]! };
        index = Math.floor(index / n);
      }
      // keys are sorted; rebuild in that order (the loop above filled them backwards)
      const sorted: PaletteTypedStates = {};
      for (const k of keys) sorted[k] = out[k]!;
      return sorted;
    };
    entries.push({ name, states: at(def), isDefault: true });
    const list = perms ?? Array.from({ length: product }, (_, i) => i);
    for (const i of list) if (i !== def) entries.push({ name, states: at(i), isDefault: false });
  }
  return { version: file.version, bds: file.bds, dumped: file.dumped, types: file.types, entries };
}

/** The dumped palette of a game version, or undefined when there is no dump for it (cached). */
export function loadPalette(version: string): BlockPalette | undefined {
  const hit = cache.get(version);
  if (hit !== undefined) return hit ?? undefined;
  const path = palettePath(version);
  if (!existsSync(path)) {
    cache.set(version, null);
    return undefined;
  }
  const t0 = performance.now();
  const file = JSON.parse(readFileSync(path, 'utf8')) as PaletteFile;
  if (file.version !== version) throw new Error(`${path} is for ${file.version}, not ${version}`);
  const palette: BlockPalette = { ...expandPalette(file), loadMs: 0 };
  palette.loadMs = performance.now() - t0;
  cache.set(version, palette);
  return palette;
}

/**
 * The minecraft-data block whose shape and hardness a block that minecraft-data does not know borrows
 * (blocks added after its data version, e.g. 1.26.60's poplar wood set, wool and concrete stairs and slabs):
 * by name suffix. Undefined for blocks with no obvious relative (icicle, ice_crystal, disc_press, ...), which
 * stay full solid cubes.
 */
export function shapeDonor(name: string): string | undefined {
  for (const [suffix, donor] of DONORS) if (name.endsWith(suffix)) return donor;
  return undefined;
}

const DONORS: readonly (readonly [string, string])[] = [
  ['_double_slab', 'oak_double_slab'],
  ['_slab', 'oak_slab'],
  ['_stairs', 'oak_stairs'],
  ['_wall_sign', 'wall_sign'],
  ['_standing_sign', 'standing_sign'],
  ['_hanging_sign', 'oak_hanging_sign'],
  ['_leaves', 'oak_leaves'],
  ['_bed', 'bed'],
  ['_button', 'wooden_button'],
  ['_pressure_plate', 'wooden_pressure_plate'],
  ['_trapdoor', 'trapdoor'],
  ['_door', 'wooden_door'],
  ['_fence_gate', 'fence_gate'],
  ['_fence', 'oak_fence'],
  ['_sapling', 'oak_sapling'],
  ['_shelf', 'oak_shelf'],
  ['_log', 'oak_log'],
  ['_wood', 'oak_wood'],
  ['_planks', 'oak_planks'],
];

// ---- hashing ---------------------------------------------------------------------------------

const enc = new TextEncoder();
const strBytes = new Map<string, Uint8Array>();
function bytesOf(s: string): Uint8Array {
  let b = strBytes.get(s);
  if (!b) strBytes.set(s, (b = enc.encode(s)));
  return b;
}

/**
 * Bedrock's hashed block runtime id without building the NBT: FNV-1a 32 over the little-endian NBT bytes of
 * { name: "minecraft:<name>", states: { ...in the given (sorted) key order } } with an unnamed root, exactly
 * what registry.ts `blockHash` writes with prismarine-nbt (the unit test compares both on every state).
 */
export function fastBlockHash(name: string, states: PaletteTypedStates): number {
  let h = 0x811c9dc5;
  const byte = (b: number): void => {
    h = Math.imul(h ^ (b & 0xff), 0x01000193);
  };
  const str = (s: string): void => {
    const b = bytesOf(s);
    byte(b.length);
    byte(b.length >> 8);
    for (const c of b) h = Math.imul(h ^ c, 0x01000193);
  };
  byte(10); // compound
  byte(0); // root name length 0
  byte(0);
  byte(8); // string "name"
  str('name');
  str(name.includes(':') ? name : `minecraft:${name}`);
  byte(10); // compound "states"
  str('states');
  for (const key of Object.keys(states)) {
    const v = states[key]!;
    if (v.type === 'byte') {
      byte(1);
      str(key);
      byte(Number(v.value));
    } else if (v.type === 'int') {
      byte(3);
      str(key);
      const n = Number(v.value) | 0;
      byte(n);
      byte(n >> 8);
      byte(n >> 16);
      byte(n >> 24);
    } else {
      byte(8);
      str(key);
      str(String(v.value));
    }
  }
  byte(0); // end of states
  byte(0); // end of root
  return h | 0;
}
