// Block palette dump (wave 8, Track AC: block registry for 1.26.60; docs/versions.md "Block states").
// Stable @minecraft/server 2.10.0 only. Registered by main.ts through `paletteHandlers()`.
//
//   palette [from] [count] [maxPerms]   block types from..from+count-1 (BlockTypes.getAll() sorted by id;
//                                       default 0, 50) or fewer once maxPerms permutations (default 1500)
//                                       are collected (at least one type per page). For each type: the states
//                                       of its default permutation, every combination of their valid values
//                                       (BlockStates.get(name).validValues) resolved with BlockPermutation.resolve
//                                       (combinations that throw are skipped), returned as
//                                       { name, states: [{ name, type, value }], default? } per permutation.
//                                       `type` is the NBT tag of the state in the network hash: byte (bool),
//                                       int (number) or string. Reply: { total, from, next, types, permutations,
//                                       skipped }; next is null after the last type.
//   palettestrip x y z from count cols [stride]   default permutations of types from..from+count-1 in a grid
//   palettestates x1 y1 z1 x2 y2 z2     typeId and typed states of every block in a box (max 4096)
import { BlockPermutation, BlockStates, BlockTypes, type Block, type Dimension } from '@minecraft/server';
import { TruthError, blockPos, box, int, iterateBox, type Box, type Vec3 } from './protocol.js';

type PaletteHandler = (args: string[]) => unknown;
type StateValue = boolean | number | string;

export interface PaletteState {
  name: string;
  type: 'byte' | 'int' | 'string';
  value: StateValue;
}

export interface PalettePermutation {
  name: string;
  states: PaletteState[];
  default?: true;
}

/** Largest cartesian product tried for one block type (the biggest vanilla type has a few hundred). */
const MAX_COMBOS = 65536;

function nbtType(v: StateValue): PaletteState['type'] {
  return typeof v === 'boolean' ? 'byte' : typeof v === 'number' ? 'int' : 'string';
}

function typed(states: Record<string, StateValue>): PaletteState[] {
  return Object.keys(states)
    .sort()
    .map((name) => ({ name, type: nbtType(states[name]!), value: states[name]! }));
}

/** Every permutation of one block type, the default first. */
export function permutationsOf(typeId: string): { perms: PalettePermutation[]; skipped: number } {
  const def = BlockPermutation.resolve(typeId);
  const defStates = def.getAllStates();
  const keys = Object.keys(defStates).sort();
  const values = keys.map((k) => {
    const valid = BlockStates.get(k)?.validValues;
    return valid && valid.length > 0 ? valid : [defStates[k]!];
  });
  const defKey = JSON.stringify(keys.map((k) => defStates[k]));
  const perms: PalettePermutation[] = [{ name: typeId, states: typed(defStates), default: true }];
  let combos = 1;
  for (const v of values) combos *= v.length;
  if (combos > MAX_COMBOS) throw new TruthError('too_many_permutations', `${typeId} has ${combos} state combinations`, { typeId, combos });
  let skipped = 0;
  const seen = new Set<string>([defKey]);
  const idx = keys.map(() => 0);
  for (let n = 0; n < combos; n++) {
    const want: Record<string, StateValue> = {};
    for (let i = 0; i < keys.length; i++) want[keys[i]!] = values[i]![idx[i]!]!;
    // next index (mixed radix, last key fastest)
    for (let i = keys.length - 1; i >= 0; i--) {
      if (++idx[i]! < values[i]!.length) break;
      idx[i] = 0;
    }
    let p: BlockPermutation;
    try {
      p = BlockPermutation.resolve(typeId, want);
    } catch {
      skipped++;
      continue;
    }
    const got = p.getAllStates();
    const key = JSON.stringify(keys.map((k) => got[k]));
    if (seen.has(key)) continue;
    seen.add(key);
    perms.push({ name: typeId, states: typed(got) });
  }
  return { perms, skipped };
}

/** What main.ts lends to these handlers. */
export interface PaletteDeps {
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
  overworld(): Dimension;
}

/** Largest strip / states box (answered in the same tick). */
const MAX_STRIP = 4096;

function sortedTypeIds(): string[] {
  return BlockTypes.getAll()
    .map((t) => t.id)
    .sort();
}

export function paletteHandlers(deps: PaletteDeps): Record<string, PaletteHandler> {
  const { getBlock, assertLoaded, overworld } = deps;
  return {
    /**
     * palettestrip x y z from count cols [stride]: the default permutation of block types from..from+count-1
     * (palette order) in a grid at height y, x fastest, `cols` per row, `stride` blocks apart (default 1;
     * 2 keeps neighbours from popping each other off). Returns the placed typeIds and positions.
     */
    palettestrip(args) {
      const p = blockPos(args, 0);
      const from = int(args[3], 'from');
      const count = int(args[4], 'count');
      const cols = int(args[5], 'cols');
      const stride = args[6] === undefined ? 1 : int(args[6], 'stride');
      if (from < 0 || count < 1 || cols < 1 || stride < 1 || count > MAX_STRIP) throw new TruthError('bad_args', `usage: palettestrip x y z from count(1..${MAX_STRIP}) cols [stride]`);
      const all = sortedTypeIds().slice(from, from + count);
      const rows = Math.ceil(all.length / cols);
      const dim = overworld();
      assertLoaded(dim, box(p, { x: p.x + stride * (cols - 1), y: p.y, z: p.z + stride * (rows - 1) }));
      const placed: { x: number; y: number; z: number; typeId: string }[] = [];
      all.forEach((typeId, i) => {
        const at = { x: p.x + stride * (i % cols), y: p.y, z: p.z + stride * Math.floor(i / cols) };
        getBlock(dim, at).setPermutation(BlockPermutation.resolve(typeId));
        placed.push({ ...at, typeId });
      });
      return { total: all.length, placed };
    },

    /** palettestates x1 y1 z1 x2 y2 z2: typeId and states of every block in the box (y, z, x order). */
    palettestates(args) {
      const b = box(blockPos(args, 0), blockPos(args, 3));
      if (b.volume > MAX_STRIP) throw new TruthError('volume_too_large', `volume ${b.volume} > ${MAX_STRIP}`);
      const dim = overworld();
      assertLoaded(dim, b);
      const blocks: { x: number; y: number; z: number; typeId: string; states: PaletteState[] }[] = [];
      for (const at of iterateBox(b)) {
        const blk = getBlock(dim, at);
        blocks.push({ ...at, typeId: blk.typeId, states: typed(blk.permutation.getAllStates()) });
      }
      return { from: b.min, to: b.max, blocks };
    },

    palette(args) {
      const from = args[0] === undefined ? 0 : int(args[0], 'from');
      const count = args[1] === undefined ? 50 : int(args[1], 'count');
      const maxPerms = args[2] === undefined ? 1500 : int(args[2], 'maxPerms');
      if (from < 0 || count < 1) throw new TruthError('bad_args', 'usage: palette [from >= 0] [count >= 1] [maxPerms]');
      const all = sortedTypeIds();
      const permutations: PalettePermutation[] = [];
      const types: string[] = [];
      let skipped = 0;
      let i = from;
      for (; i < all.length && i < from + count; i++) {
        if (types.length > 0 && permutations.length >= maxPerms) break;
        const r = permutationsOf(all[i]!);
        types.push(all[i]!);
        skipped += r.skipped;
        for (const p of r.perms) permutations.push(p);
      }
      return { total: all.length, from, next: i < all.length ? i : null, types, permutations, skipped };
    },
  };
}
