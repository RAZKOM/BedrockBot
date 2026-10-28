// Item icons of the panel (decision 0046): the rules that turn a Bedrock item name into Java art.
// Since the 1.20 / 1.26 releases most names are the same on both editions; this file holds the
// exceptions (renamed items and blocks, and names that mean something else on the other edition),
// the models that are drawn as a block or as a flat sprite, and the colours of tinted textures
// (grass, leaves, leather, potions).

/** Bedrock name -> Java name, for the ones that differ. */
export const ALIASES: Readonly<Record<string, string>> = {
  // blocks
  brick_block: 'bricks',
  hardened_clay: 'terracotta',
  grass_path: 'dirt_path',
  mob_spawner: 'spawner',
  web: 'cobweb',
  deadbush: 'dead_bush',
  tallgrass: 'short_grass',
  waterlily: 'lily_pad',
  slime: 'slime_block',
  melon_block: 'melon',
  lit_pumpkin: 'jack_o_lantern',
  noteblock: 'note_block',
  nether_brick: 'nether_bricks',
  red_nether_brick: 'red_nether_bricks',
  end_bricks: 'end_stone_bricks',
  quartz_ore: 'nether_quartz_ore',
  stonecutter_block: 'stonecutter',
  dirt_with_roots: 'rooted_dirt',
  azalea_leaves_flowered: 'flowering_azalea_leaves',
  small_dripleaf_block: 'small_dripleaf',
  silver_glazed_terracotta: 'light_gray_glazed_terracotta',
  golden_rail: 'powered_rail',
  // stone stairs and slabs: Bedrock's `stone_stairs` are cobblestone, the stone ones are `normal_stone_*`
  stone_stairs: 'cobblestone_stairs',
  normal_stone_stairs: 'stone_stairs',
  normal_stone_slab: 'stone_slab',
  end_brick_stairs: 'end_stone_brick_stairs',
  prismarine_bricks_stairs: 'prismarine_brick_stairs',
  // snow: the block is `snow` on Bedrock, the layer is `snow_layer`
  snow: 'snow_block',
  snow_layer: 'snow',
  // oak is the plain wood
  fence_gate: 'oak_fence_gate',
  wooden_door: 'oak_door',
  trapdoor: 'oak_trapdoor',
  wooden_button: 'oak_button',
  wooden_pressure_plate: 'oak_pressure_plate',
  // items
  reeds: 'sugar_cane',
  netherbrick: 'nether_brick',
  fireworks: 'firework_rocket',
  fish: 'cod',
  cooked_fish: 'cooked_cod',
  clownfish: 'tropical_fish',
  map: 'filled_map',
  empty_map: 'map',
  frame: 'item_frame',
  glow_frame: 'glow_item_frame',
  zombie_pigman_spawn_egg: 'zombified_piglin_spawn_egg',
};

/** The Java name an item is looked up by. */
export const javaName = (bedrock: string): string => ALIASES[bedrock] ?? bedrock;

/** Model parents whose items the game draws as the block (boxes in the inventory view); the rest is a sprite. */
export const SOLID_PARENTS: ReadonlySet<string> = new Set([
  'cube',
  'slab',
  'stairs',
  'leaves',
  'wall_inventory',
  'carpet',
  'thin_block',
  'fence_inventory',
  'template_fence_gate',
  'template_custom_fence_gate',
  'template_trapdoor_bottom',
  'button_inventory',
  'pressure_plate_up',
  'template_glazed_terracotta',
  'template_anvil',
  'template_farmland',
  'template_shelf_inventory',
  'template_daylight_detector',
]);

/** Block models that only inherit from `block` but are a flat sprite in the inventory. */
export const SPRITE_BLOCKS: ReadonlySet<string> = new Set(['sea_pickle', 'spore_blossom', 'big_dripleaf', 'end_rod', 'chorus_plant', 'dried_ghast']);

/** Drawn by the game's entity renderer, so there is no texture to show (the panel keeps its glyph). */
export const NO_ICON = /(^|_)(bed|banner|skull|head|shield)$/;

export const GRASS = 0x79c05a;
export const FOLIAGE = 0x48b518;
export const LEATHER = 0xa06540;
export const WATER_BOTTLE = 0x385dc6;

/** Colour of `tintindex` 0 for a block drawn from its model (grass block top, leaves). */
export function blockTint(name: string): number | undefined {
  if (name === 'grass_block') return GRASS;
  if (name === 'spruce_leaves') return 0x619961;
  if (name === 'birch_leaves') return 0x80a755;
  if (/^(oak|jungle|acacia|dark_oak|mangrove)_leaves$/.test(name)) return FOLIAGE;
  return undefined;
}

export interface SpriteLayer {
  /** Texture path without extension, bottom layer first. */
  path: string;
  tint?: number;
}

/** Items the game draws from two textures (the bottle over its liquid, leather over its dye). */
export function layered(name: string): SpriteLayer[] | undefined {
  if (/^leather_(helmet|chestplate|leggings|boots)$/.test(name)) return [{ path: `items/${name}`, tint: LEATHER }, { path: `items/${name}_overlay` }];
  if (name === 'leather_horse_armor') return [{ path: 'items/leather_horse_armor', tint: LEATHER }];
  if (name === 'potion' || name === 'splash_potion' || name === 'lingering_potion') return [{ path: 'items/potion_overlay', tint: WATER_BOTTLE }, { path: `items/${name}` }];
  return undefined;
}

/** Flat sprites that are gray in the file and green in the game. */
export function spriteTint(name: string): number | undefined {
  if (name === 'short_grass' || name === 'tall_grass' || name === 'fern' || name === 'large_fern') return GRASS;
  if (name === 'vine') return FOLIAGE;
  if (name === 'lily_pad') return 0x208030;
  return undefined;
}

/** Where a sprite may be, best first: the index's texture, then the item's own file, a block file, and the frame an animated item (compass, clock) shows. */
export function spritePaths(name: string, indexed: string | undefined): string[] {
  return [...(indexed ? [indexed] : []), `items/${name}`, `blocks/${name}`, `items/${name}_16`, `items/${name}_00`];
}
