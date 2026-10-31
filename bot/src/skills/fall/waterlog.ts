// Track BH (docs/movement.md "Water bucket clutch"): where a water bucket puts its water, and whether that
// water breaks a fall. Verified on BDS 1.26.60.6 (bds-gaunt, 2026-10-30): the bot clicked the top face of
// each block with a water bucket (item_use / click_block, face 1) and the update_block packets and
// truth:block showed where the water went:
//
//   above      full blocks that do not take water (stone, glass, hay, soul sand -> a bubble column):
//              a water source in the cell above (layer 0)
//   inside     waterloggable blocks: the water goes into the clicked block's layer 1 and nothing is
//              placed above: bottom and top slabs, stairs (either way up), fences, cobblestone walls,
//              glass panes, iron bars, leaves, scaffolding, lanterns, copper grates, mangrove roots,
//              ladders, campfires (put out)
//   used       interactive blocks use the click instead (no water, the bucket stays full): chests,
//              trapdoors (it opened), standing and hanging signs (the edit screen)
//   replaced   a snow layer or a moss carpet on top: the water washed it away (flowing water in its cell,
//              the source one cell higher)
//
// A fall onto it from 8 and 12 blocks (truth:hurtlog): water in the cell the feet end in breaks the fall
// (a source above stone: 0; a waterlogged BOTTOM slab, feet at 0.5 inside its cell: 0); water inside a
// block whose top the body lands on does not (top slab 4 / 8, stairs 5 / 8, fence 5 / 8, leaves, panes,
// copper grate 5 / 8: the full damage). Picking the water up: click_block on the cell that holds the water
// (the source above, or the waterlogged block itself), face 1, with the empty bucket: the water is gone
// and the slot holds a water bucket again.
import { isInteractive } from '../place/place.ts';

/** Bedrock blocks that take water into their own cell (layer 1) when a water bucket is used on them. */
const WATERLOG_EXACT = new Set([
  'iron_bars',
  'glass_pane',
  'scaffolding',
  'lantern',
  'soul_lantern',
  'copper_grate',
  'mangrove_roots',
  'ladder',
  'campfire',
  'soul_campfire',
  'chain',
  'iron_chain',
  'lightning_rod',
  'hopper',
  'conduit',
  'sea_pickle',
  'pointed_dripstone',
  'big_dripleaf',
  'small_dripleaf_block',
  'amethyst_cluster',
  'large_amethyst_bud',
  'medium_amethyst_bud',
  'small_amethyst_bud',
  'decorated_pot',
  'heavy_core',
  'barrier',
  'chest',
  'trapped_chest',
  'ender_chest',
  'standing_sign',
  'wall_sign',
  'mob_spawner',
  'trial_spawner',
  'vault',
  'sculk_sensor',
  'calibrated_sculk_sensor',
  'sculk_shrieker',
  'light_block',
]);
const WATERLOG_SUFFIXES = ['_slab', '_stairs', '_fence', '_wall', '_pane', 'leaves', '_grate', '_lantern', '_trapdoor', 'trapdoor', '_sign', '_hanging_sign', '_fence_gate', '_candle', 'candle', '_coral', '_coral_fan', '_coral_wall_fan', '_chain', '_lightning_rod', '_shelf', '_bars'];

/** True when a water bucket used on `name` (without namespace) waterlogs it instead of placing water above. */
export function isWaterloggable(name: string): boolean {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  if (n.endsWith('_double_slab')) return false;
  return WATERLOG_EXACT.has(n) || WATERLOG_SUFFIXES.some((s) => n.endsWith(s));
}

/** What the clutch needs to know about a landing block (TerrainClass satisfies it). */
export interface ClutchBlock {
  name: string;
  /** Highest box top in the block (0 without boxes). */
  top: number;
  /** A full solid cube. */
  fullCube: boolean;
  floor: boolean;
  liquid?: 'water' | 'lava' | undefined;
}

/** Where the clutch puts the water for a landing on `floor` (the block the feet land on) at (x, y, z). */
export type ClutchTarget =
  | { ok: true; /** The cell that will hold the water (the feet end in it). */ water: { x: number; y: number; z: number }; /** The block clicked (top face). */ click: { x: number; y: number; z: number }; layer: 0 | 1 }
  | { ok: false; reason: string };

/**
 * The clutch target for a body landing on block `floor` at (x, y, z) with `above` the block in the cell over
 * it: a full cube that does not take water (the source goes into the cell above, which must be air), or a
 * bottom slab (it is waterlogged and the feet end inside its cell). Anything else is refused: no full
 * solid top face, a waterloggable block whose top the body stands on (the water would be inside it),
 * an interactive block (the click would use it), or something in the cell above.
 */
export function clutchTarget(x: number, y: number, z: number, floor: ClutchBlock | undefined, above: ClutchBlock | undefined): ClutchTarget {
  if (!floor) return { ok: false, reason: 'unknown landing block' };
  if (floor.liquid) return { ok: false, reason: `lands in ${floor.liquid}` };
  if (isInteractive(floor.name)) return { ok: false, reason: `${floor.name} would be used, not filled` };
  const n = floor.name;
  if (n.endsWith('_slab') && !n.endsWith('_double_slab') && Math.abs(floor.top - 0.5) < 1e-6 && floor.floor) {
    return { ok: true, water: { x, y, z }, click: { x, y, z }, layer: 1 };
  }
  if (isWaterloggable(n)) return { ok: false, reason: `${n} would take the water inside (waterlogged), not above` };
  if (!floor.fullCube || !floor.floor || Math.abs(floor.top - 1) > 1e-6) return { ok: false, reason: `${n} has no full solid top face` };
  if (!above) return { ok: false, reason: 'unknown cell above the landing block' };
  if (above.name !== 'air' && above.name !== 'cave_air') return { ok: false, reason: `${above.name} above the landing block` };
  return { ok: true, water: { x, y: y + 1, z }, click: { x, y, z }, layer: 0 };
}
