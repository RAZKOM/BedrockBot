// Farming commands (PLAN.md Phase 7 task 7.13, Track U): build a crop field and read it back in one
// request each (one console command per block would take ~150 ms x 162 for a 9 x 9 field). Stable
// @minecraft/server 2.10.0 only. Registered by main.ts through `farmHandlers(deps)`; documented in
// docs/farming.md ("Truth commands").
//
//   field x y z w d crop growth [moist]   farmland (moisturized_amount = moist, default 7) on x..x+w-1,
//                                         z..z+d-1 at height y, and `crop` (wheat, carrots, potatoes,
//                                         beetroot; `none` = air) with `growth` at y + 1
//   crops x y z w d                       the same box read back: per cell (x fastest, then z) the
//                                         block at y (`soil`: farmland / dirt / ...) and at y + 1
//                                         (`crop` typeId or null, `growth` or -1)
import { BlockPermutation, type Block, type Dimension } from '@minecraft/server';
import { TruthError, blockPos, box, int, nsId, type Box, type Vec3 } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface FarmDeps {
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
  overworld(): Dimension;
}

type FarmHandler = (args: string[]) => unknown;

/** Largest field (cells) one request may touch: 2 blocks per cell, answered in the same tick. */
const MAX_CELLS = 1024;

const short = (typeId: string) => (typeId.startsWith('minecraft:') ? typeId.slice(10) : typeId);

function fieldBox(args: string[]): { p: Vec3; w: number; d: number; b: Box } {
  const p = blockPos(args, 0);
  const w = int(args[3], 'w');
  const d = int(args[4], 'd');
  if (w < 1 || d < 1 || w * d > MAX_CELLS) throw new TruthError('bad_args', `field size ${w} x ${d} must be 1..${MAX_CELLS} cells`);
  return { p, w, d, b: box(p, { x: p.x + w - 1, y: p.y + 1, z: p.z + d - 1 }) };
}

export function farmHandlers(deps: FarmDeps): Record<string, FarmHandler> {
  const { getBlock, assertLoaded, overworld } = deps;
  return {
    field(args) {
      const { p, w, d, b } = fieldBox(args);
      const crop = args[5];
      if (!crop) throw new TruthError('bad_args', 'usage: field x y z w d crop|none growth [moist]');
      const growth = crop === 'none' ? 0 : int(args[6], 'growth');
      const moist = args[7] === undefined ? 7 : int(args[7], 'moist');
      const dim = overworld();
      assertLoaded(dim, b);
      let soil: BlockPermutation;
      let plant: BlockPermutation;
      try {
        soil = BlockPermutation.resolve('minecraft:farmland', { moisturized_amount: moist });
        plant = crop === 'none' ? BlockPermutation.resolve('minecraft:air') : BlockPermutation.resolve(nsId(crop), { growth });
      } catch (e) {
        throw new TruthError('bad_states', `cannot resolve farmland ${moist} / ${crop} ${growth}: ${String(e)}`);
      }
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          getBlock(dim, { x: p.x + dx, y: p.y, z: p.z + dz }).setPermutation(soil);
          getBlock(dim, { x: p.x + dx, y: p.y + 1, z: p.z + dz }).setPermutation(plant);
        }
      }
      return { from: b.min, to: b.max, cells: w * d, crop, growth, moist };
    },

    crops(args) {
      const { p, w, d, b } = fieldBox(args);
      const dim = overworld();
      assertLoaded(dim, b);
      const soil: string[] = [];
      const crop: (string | null)[] = [];
      const growth: number[] = [];
      const soilCounts: Record<string, number> = {};
      const cropCounts: Record<string, number> = {};
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          const s = short(getBlock(dim, { x: p.x + dx, y: p.y, z: p.z + dz }).typeId);
          soil.push(s);
          soilCounts[s] = (soilCounts[s] ?? 0) + 1;
          const top = getBlock(dim, { x: p.x + dx, y: p.y + 1, z: p.z + dz });
          const t = short(top.typeId);
          if (t === 'air') {
            crop.push(null);
            growth.push(-1);
          } else {
            crop.push(t);
            cropCounts[t] = (cropCounts[t] ?? 0) + 1;
            const g = top.permutation.getState('growth');
            growth.push(typeof g === 'number' ? g : -1);
          }
        }
      }
      return { from: b.min, to: b.max, w, d, soil, crop, growth, soilCounts, cropCounts };
    },
  };
}
