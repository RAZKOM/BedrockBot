// Block states for the builder (Track B1, decision 0124; docs/build.md "Block states"). Which states of a block a
// player's click chooses and how (the face clicked, the point on it, the view's direction, where the eye is,
// clicks after placing), which follow the neighbours (verified at the end of the build), which nothing a builder
// does chooses (not verified), and which blocks stay refused. Every rule was measured on BDS 1.26.60.6 (bds-build,
// e2e build-measure); Bedrock differs from Java in several (a piston faces the way the player looks, a door's
// facing is a quarter turn from the view, the click point never chooses a door's hinge).
//
//   placementOf(block)      the item, the click it needs (ClickNeed), the states to verify, the cells it fills
//   chooseClick(...)        the click that gives a placement its states from one eye position, a natural look first
//   rotateStates(...)       a structure's states turned with it (placeStructure)
//   statesMatch(...)        the verification (true / 1 and false / 0 alike)
import { closestDistance, cornerDistance, DEFAULT_CLICK_REACH, SERVER_CLICK_REACH } from '../place/place.ts';
import { faceVisibleFrom, type BlockFace } from '../place/face.ts';
import { lookAngles } from '../dig/look.ts';
import type { Vec3 } from '../../world/types.ts';
import { blockId, type BuildBlock, type Cell } from './types.ts';

export type Cardinal = 'south' | 'west' | 'north' | 'east';
export type Dir6 = Cardinal | 'up' | 'down';
export type StateValue = string | number | boolean;
export type States = Readonly<Record<string, StateValue>>;

/** Bedrock yaw order: 0 south (+z), 90 west (-x), 180 north (-z), -90 east (+x). */
export const CARDINALS: readonly Cardinal[] = ['south', 'west', 'north', 'east'];
export const OPPOSITE: Readonly<Record<Dir6, Dir6>> = { south: 'north', north: 'south', east: 'west', west: 'east', up: 'down', down: 'up' };
const opp = (c: Cardinal): Cardinal => OPPOSITE[c] as Cardinal;
/** A quarter turn clockwise seen from above (north -> east -> south -> west). */
export const CLOCKWISE: Readonly<Record<Cardinal, Cardinal>> = { north: 'east', east: 'south', south: 'west', west: 'north' };
const ccw = (c: Cardinal): Cardinal => CLOCKWISE[CLOCKWISE[CLOCKWISE[c]]];
export const DIR_VEC: Readonly<Record<Dir6, Cell>> = {
  south: { x: 0, y: 0, z: 1 },
  north: { x: 0, y: 0, z: -1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
};
const SIDES: readonly BlockFace[] = ['north', 'south', 'west', 'east'];
const ALL_FACES: readonly BlockFace[] = ['up', 'down', 'north', 'south', 'west', 'east'];
const isCardinal = (s: unknown): s is Cardinal => s === 'south' || s === 'west' || s === 'north' || s === 'east';
const isDir6 = (s: unknown): s is Dir6 => isCardinal(s) || s === 'up' || s === 'down';
const plus = (a: Cell, d: Cell): Cell => ({ x: a.x + d.x, y: a.y + d.y, z: a.z + d.z });

/** The cardinal a Bedrock yaw faces (quadrants split at 45 degrees, measured on stairs). */
export function viewCardinal(yaw: number): Cardinal {
  const y = (((yaw % 360) + 360) % 360) + 45;
  return CARDINALS[Math.floor(y / 90) % 4]!;
}

/** The yaw of a cardinal's centre. */
export function cardinalYaw(c: Cardinal): number {
  return { south: 0, west: 90, north: 180, east: -90 }[c];
}

/** Degrees between a yaw and the nearest edge of its quadrant (45 at the centre, 0 on an edge). */
export function quadrantMargin(yaw: number): number {
  const y = ((((yaw + 45) % 90) + 90) % 90);
  return Math.min(y, 90 - y);
}

/** The smallest angle between two yaws, degrees. */
export function yawGap(a: number, b: number): number {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return Math.abs(d);
}

// ---- encodings (measured, docs/build.md "Block states")

/** `direction` (int): 0 south, 1 west, 2 north, 3 east (beds, looms, beehives, bells, grindstones, tripwire hooks ...). */
export const DIRECTION: Readonly<Record<Cardinal, number>> = { south: 0, west: 1, north: 2, east: 3 };
/** A trapdoor's `direction` by the view's cardinal at the click: west 0, east 1, north 2, south 3. */
export const TRAPDOOR_DIRECTION: Readonly<Record<Cardinal, number>> = { west: 0, east: 1, north: 2, south: 3 };
/** `facing_direction` (int): 0 down, 1 up, 2 north, 3 south, 4 west, 5 east. */
export const FACING: Readonly<Record<Dir6, number>> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
/** Stairs' `weirdo_direction` by the view's cardinal: 0 east, 1 west, 2 south, 3 north. */
export const WEIRDO: Readonly<Record<Cardinal, number>> = { east: 0, west: 1, south: 2, north: 3 };

const invert = <K extends string>(m: Readonly<Record<K, number>>): Map<number, K> => new Map(Object.entries(m).map(([k, v]) => [v as number, k as K]));
const DIRECTION_OF = invert(DIRECTION);
const TRAPDOOR_OF = invert(TRAPDOOR_DIRECTION);
const FACING_OF = invert(FACING);
const WEIRDO_OF = invert(WEIRDO);

// ---- state values

/** A state value as text for comparing: true / 1 and false / 0 alike. */
export function stateText(v: unknown): string {
  if (v === true || v === 'true') return '1';
  if (v === false || v === 'false') return '0';
  return String(v);
}

/** `want`'s states all hold in `have` (missing in `have` = differs). */
export function statesMatch(want: Readonly<Record<string, unknown>>, have: Readonly<Record<string, unknown>> | undefined): boolean {
  for (const [k, v] of Object.entries(want)) if (stateText(have?.[k]) !== stateText(v)) return false;
  return true;
}

/** The states of `want` that differ in `have`: `delay=2 not 0`. */
export function stateDiff(want: Readonly<Record<string, unknown>>, have: Readonly<Record<string, unknown>> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(want)) if (stateText(have?.[k]) !== stateText(v)) out.push(`${k.replace(/^minecraft:/, '')}=${stateText(v)} not ${have?.[k] === undefined ? '-' : stateText(have[k])}`);
  return out;
}

const bit = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : typeof v === 'boolean' ? Number(v) : undefined);
const pick = (st: States, keys: readonly string[]): Record<string, StateValue> => {
  const o: Record<string, StateValue> = {};
  for (const k of keys) if (st[k] !== undefined) o[k] = st[k]!;
  return o;
};

// ---- what a placement needs

/** How the click must be made for a block's states. */
export interface ClickNeed {
  /** Faces of the support that may be clicked (the direction from the support to the cell). */
  faces: readonly BlockFace[];
  /** On a side face: the click's height on it, `low` under the middle, `high` over it (slabs, stairs, trapdoors). */
  half?: 'low' | 'high';
  /** The view's cardinal (quadrants split at 45 degrees). */
  cardinal?: Cardinal;
  /** The view's axis only (a lever on a floor or a ceiling: north-south is z). */
  axis?: 'x' | 'z';
  /** An exact yaw (a standing sign's 16 directions), degrees; a view within YAW_SLACK of it. */
  yaw?: number;
  /** Six-way blocks: where the eye must be against the cell (`above`: facing up, `below`: down, `level`: the view's cardinal). */
  eye?: 'above' | 'below' | 'level';
  /** The support must be soil (plants). */
  soil?: boolean;
  /** Never a scaffold block as the support (the block hangs on it and falls when it goes). */
  realSupport?: boolean;
}

/** A cell the placement fills besides its own (a door's upper half, a bed's head, a tall plant's top). */
export interface ExtraCell {
  offset: Cell;
  name: string;
  /** States verified on it right after the click. */
  check: States;
}

export interface Placement {
  /** The family for logs and the docs (`stairs`, `door`, ...). */
  family: string;
  /** The block when the step is done (a double slab: the double). */
  name: string;
  /** The block right after the first click (a double slab: the single slab). */
  placed: string;
  item: string;
  need: ClickNeed;
  /** States the click chooses, verified right after it (on `placed`). */
  check: States;
  /** States the step ends with, verified after the merges and taps (on `name`). */
  final: States;
  /** States that follow the neighbours (fences, walls, rails, a stair's corner): verified at the end of the build. */
  derived: States;
  /** Clicks on the placed block itself with the same item (a double slab, more candles, pickles, snow layers). */
  merges: number;
  /** Clicks on the placed block after placing (a repeater's delay, a comparator's mode, open). */
  taps: number;
  /** A tap's view must not face this way (a fence gate opened from its front turns round). */
  tapAvoid?: Cardinal;
  extra: ExtraCell[];
  /** A power source: placed after the rest of the build (decision 0124, "ordered redstone"). */
  source: boolean;
  /** Doors: the hinge the build wants (it follows the neighbours at the click; plan.ts arranges them). */
  hinge?: boolean;
  /** States in the build that the builder neither chooses nor verifies (power, age, contents): their names. */
  ignored: string[];
}

export type PlacementResult = Placement | { refuse: string } | { companion: Cell };

// ---- families

const LIQUID = /(^|_)(water|lava)$/;
const NOT_PLACEABLE = new Set([
  'fire', 'soul_fire', 'portal', 'end_portal', 'end_gateway', 'bedrock', 'barrier', 'structure_block', 'structure_void', 'command_block', 'chain_command_block', 'repeating_command_block',
  'jigsaw', 'piston_arm_collision', 'sticky_piston_arm_collision', 'moving_block', 'light_block', 'end_portal_frame', 'mob_spawner', 'trial_spawner', 'vault', 'reinforced_deepslate',
  'budding_amethyst', 'bubble_column', 'frosted_ice', 'chorus_plant', 'farmland', 'grass_path', 'dirt_path', 'border_block', 'allow', 'deny', 'unknown', 'info_update', 'info_update2',
  'invisible_bedrock', 'netherreactor', 'camera', 'trip_wire', 'cocoa', 'fire_coral', 'powder_snow', 'kelp', 'seagrass', 'tall_seagrass', 'bamboo', 'cave_vines', 'cave_vines_body_with_berries',
  'cave_vines_head_with_berries', 'weeping_vines', 'twisting_vines', 'big_dripleaf', 'small_dripleaf_block', 'pitcher_crop', 'pale_moss_carpet', 'pointed_dripstone', 'scaffolding',
]);
const CROPS = /^(wheat|carrots|potatoes|beetroot|melon_stem|pumpkin_stem|nether_wart|torchflower_crop|sweet_berry_bush|reeds)$/;
/** Power sources (decision 0124): placed after the rest of the build. */
const SOURCES = /^(redstone_torch|unlit_redstone_torch|redstone_block|daylight_detector|daylight_detector_inverted|observer|sculk_sensor|calibrated_sculk_sensor)$/;
/** Blocks whose stack of copies is chosen by more clicks on the same cell: the count state. */
const COUNTED: Readonly<Record<string, { state: string; max: number }>> = {
  sea_pickle: { state: 'cluster_count', max: 3 },
  snow_layer: { state: 'height', max: 7 },
};
const SOIL = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|moss_block|mycelium|mud|muddy_mangrove_roots|farmland|pale_moss_block)$/;
const TALL_PLANT = /^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony)$/;
const PLANT = /(_sapling|_tulip|_flower)$|^(dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|short_grass|fern|deadbush|dead_bush|wither_rose|closed_eyeblossom|open_eyeblossom|cactus_flower|bush|firefly_bush|short_dry_grass|tall_dry_grass)$/;
/** States the builder never chooses (power, age, contents, ...): not verified. */
const IGNORED = new Set([
  'powered_bit', 'redstone_signal', 'button_pressed_bit', 'output_lit_bit', 'toggle_bit', 'triggered_bit', 'crafting', 'update_bit', 'persistent_bit', 'age', 'age_bit', 'growth', 'lit',
  'extinguished', 'dead_bit', 'stability', 'stability_check', 'occupied_bit', 'honey_level', 'cracked_state', 'item_frame_map_bit', 'item_frame_photo_bit', 'explode_bit', 'deprecated',
  'sculk_sensor_phase', 'covered_bit', 'rail_data_bit', 'brewing_stand_slot_a_bit', 'brewing_stand_slot_b_bit', 'brewing_stand_slot_c_bit', 'composter_fill_level', 'respawn_anchor_charge',
  'bite_counter', 'moisturized_amount', 'books_stored', 'powered_shelf_type', 'bloom', 'can_summon', 'active', 'natural', 'creaking_heart_state', 'potent_sulfur_state', 'ominous',
  'vault_state', 'trial_spawner_state', 'rehydration_level', 'infiniburn_bit', 'brushed_progress', 'suspended_bit', 'disarmed_bit',
]);
/** States that follow the neighbours (verified at the end). */
const DERIVED = /^(minecraft:connection_(east|north|south|west|up|down)|wall_connection_type_(east|north|south|west)|wall_post_bit|redstone_(east|north|south|west)|minecraft:corner|in_wall_bit|rail_direction|pale_moss_carpet_side_(east|north|south|west)|dripstone_thickness|attached_bit)$/;

/** The single slab of a double slab name (`oak_double_slab` -> `oak_slab`, `double_cut_copper_slab` -> `cut_copper_slab`). */
export function singleSlab(name: string): string | undefined {
  const n = blockId(name);
  if (/(^|_)double_cut_copper_slab$/.test(n)) return n.replace(/double_cut_copper_slab$/, 'cut_copper_slab');
  if (n.endsWith('_double_slab')) return n.replace(/_double_slab$/, '_slab');
  return undefined;
}

/**
 * The item that places a block where the names differ (signs, banners, beds, repeaters ...); most are the same.
 * The world model reports the placed block under the block name, which is what the runner verifies.
 */
const ITEM_OF: Readonly<Record<string, string>> = {
  standing_sign: 'oak_sign', wall_sign: 'oak_sign', unpowered_repeater: 'repeater', powered_repeater: 'repeater',
  unpowered_comparator: 'comparator', powered_comparator: 'comparator', redstone_wire: 'redstone', unlit_redstone_torch: 'redstone_torch', lit_redstone_lamp: 'redstone_lamp',
  lit_furnace: 'furnace', lit_smoker: 'smoker', lit_blast_furnace: 'blast_furnace', lit_redstone_ore: 'redstone_ore', lit_deepslate_redstone_ore: 'deepslate_redstone_ore',
  daylight_detector_inverted: 'daylight_detector', powered_comparator_off: 'comparator', tripwire: 'string', trip_wire: 'string',
  // Track B2: blocks a Java file maps to whose item has another name
  standing_banner: 'banner', wall_banner: 'banner',
};

export function itemOf(block: string): string {
  const n = blockId(block);
  const hit = ITEM_OF[n];
  if (hit) return hit;
  // Track B2: a wood's sign block (`spruce_standing_sign`, `darkoak_wall_sign`) is placed from its sign item
  const sign = /^(.+?)_(standing|wall)_sign$/.exec(n);
  if (sign) return `${sign[1] === 'darkoak' ? 'dark_oak' : sign[1]}_sign`;
  const slab = singleSlab(n);
  if (slab) return slab;
  return n;
}

/** The item that places a block (an alias of itemOf for the builder's older callers). */
export const itemFor = itemOf;

/**
 * Why the builder refuses a block typed by name (`!build fill ... <block>`, a replace's target), or undefined;
 * docs/build.md "Limits". A structure file's blocks are judged with their states (placementOf).
 */
export function unsupportedBlock(name: string): string | undefined {
  const p = placementOf({ name });
  return 'refuse' in p ? p.refuse : undefined;
}

/** Names that differ only by power or light (a lit furnace, a powered repeater): the same block for the builder. */
export function sameBlock(want: string, have: string): boolean {
  const a = blockId(want);
  const b = blockId(have);
  if (a === b) return true;
  const norm = (n: string) =>
    n
      .replace(/^lit_(furnace|smoker|blast_furnace|redstone_lamp|redstone_ore|deepslate_redstone_ore)$/, '$1')
      .replace(/^unlit_redstone_torch$/, 'redstone_torch')
      .replace(/^powered_(repeater|comparator)$/, 'unpowered_$1')
      .replace(/^daylight_detector_inverted$/, 'daylight_detector');
  return norm(a) === norm(b);
}

const empty = (): Omit<Placement, 'family' | 'name' | 'placed' | 'item' | 'need'> => ({ check: {}, final: {}, derived: {}, merges: 0, taps: 0, extra: [], source: false, ignored: [] });

function ignoredOf(st: States, used: readonly string[]): string[] {
  return Object.keys(st).filter((k) => !used.includes(k) && (IGNORED.has(k) || !DERIVED.test(k)));
}

function derivedOf(st: States): Record<string, StateValue> {
  const o: Record<string, StateValue> = {};
  for (const [k, v] of Object.entries(st)) if (DERIVED.test(k)) o[k] = v;
  return o;
}

/** Faces and click half for a block whose top / bottom half the click chooses (slabs, stairs, trapdoors). */
function halfNeed(top: boolean): Pick<ClickNeed, 'faces' | 'half'>[] {
  return top ? [{ faces: ['down'] }, { faces: SIDES, half: 'high' }] : [{ faces: ['up'] }, { faces: SIDES, half: 'low' }];
}

/**
 * How the builder places `b` (see the header), or why it does not, or that `b` is the second cell of a
 * two-cell block (`companion`: the main cell's offset from `b`).
 */
export function placementOf(b: Pick<BuildBlock, 'name' | 'states'>): PlacementResult {
  const name = blockId(b.name);
  const st: States = (b.states ?? {}) as States;
  if (LIQUID.test(name) || name.includes('flowing_')) return { refuse: 'no liquids' };
  if (NOT_PLACEABLE.has(name)) return { refuse: 'not placeable by the builder' };
  if (CROPS.test(name)) return { refuse: 'crops grow from seeds (!farm)' };
  if (/^(glow_lichen|sculk_vein|resin_clump|vine)$/.test(name)) return { refuse: 'one face per click (not measured)' };
  if (/coral_(wall_)?fan$/.test(name)) return { refuse: 'coral fans (not measured)' };
  // no candle_cake item exists: the block is a candle placed on a cake (two items, not measured)
  if (/(^|_)candle_cake$/.test(name)) return { refuse: 'a candle on a cake (not measured)' };
  if (/^(standing|wall)_banner$/.test(name)) return { refuse: "a banner's colour and pattern are block entity data" };
  if (name === 'tnt' || name === 'underwater_tnt') return mk('plain', name, { faces: ALL_FACES }, st, []);

  // second cells of two-cell blocks
  if ('upper_block_bit' in st && bit(st.upper_block_bit)) return { companion: { x: 0, y: -1, z: 0 } };
  if (name === 'bed' && bit(st.head_piece_bit)) {
    const d = DIRECTION_OF.get(num(st.direction) ?? -1);
    return d ? { companion: DIR_VEC[opp(d)] } : { refuse: 'a bed head without a direction' };
  }

  // slabs and double slabs: a bottom slab, then a click on its own top
  const single = singleSlab(name);
  if (single) {
    return { ...mk('double slab', name, { faces: ['up', ...SIDES], half: 'low' }, {}, []), placed: single, item: single, check: { 'minecraft:vertical_half': 'bottom' }, merges: 1, ignored: [] };
  }
  // a block typed by name (fill, wall ...): no states to give; two-cell blocks need their states
  if (Object.keys(st).length === 0) {
    if (/_door$|^wooden_door$|^bed$/.test(name) || TALL_PLANT.test(name)) return { refuse: 'two-cell blocks need a structure file (their states)' };
    if (PLANT.test(name)) return mk('plant', name, { faces: ['up'], soil: true }, st, []);
    if (FLOOR.test(name) || /^(unpowered|powered)_(repeater|comparator)$/.test(name)) return mk('floor', name, { faces: ['up'] }, st, []);
    return mk('plain', name, { faces: ALL_FACES }, st, []);
  }
  if (name.endsWith('_slab') && 'minecraft:vertical_half' in st) {
    const top = st['minecraft:vertical_half'] === 'top';
    return alt('slab', name, halfNeed(top), st, ['minecraft:vertical_half']);
  }
  // stairs
  if (name.endsWith('_stairs')) {
    const c = WEIRDO_OF.get(num(st.weirdo_direction) ?? -1);
    if (!c) return { refuse: 'stairs without weirdo_direction' };
    return alt('stairs', name, halfNeed(bit(st.upside_down_bit)).map((n) => ({ ...n, cardinal: c })), st, ['weirdo_direction', 'upside_down_bit']);
  }
  // pillars
  if ('pillar_axis' in st) {
    const ax = st.pillar_axis;
    const faces: BlockFace[] = ax === 'x' ? ['east', 'west'] : ax === 'z' ? ['north', 'south'] : ['up', 'down'];
    return mk('pillar', name, { faces }, st, ['pillar_axis']);
  }
  // doors
  if (/_door$|^wooden_door$/.test(name) && 'upper_block_bit' in st) {
    const c = st['minecraft:cardinal_direction'];
    if (!isCardinal(c)) return { refuse: 'a door without a direction' };
    const iron = /^iron_door$/.test(name);
    const open = bit(st.open_bit) && !iron;
    const p = mk('door', name, { faces: ['up'], cardinal: ccw(c) }, st, ['minecraft:cardinal_direction', 'upper_block_bit', 'open_bit', 'door_hinge_bit']);
    return {
      ...p,
      check: { 'minecraft:cardinal_direction': c, upper_block_bit: false, ...(iron ? {} : { open_bit: false }) },
      final: { 'minecraft:cardinal_direction': c, ...(iron ? {} : { open_bit: open }) },
      taps: open ? 1 : 0,
      hinge: bit(st.door_hinge_bit),
      extra: [{ offset: { x: 0, y: 1, z: 0 }, name, check: { upper_block_bit: true, door_hinge_bit: bit(st.door_hinge_bit) } }],
      ignored: iron ? ['open_bit'] : [],
    };
  }
  // trapdoors
  if (name.endsWith("trapdoor") && 'upside_down_bit' in st) {
    const c = TRAPDOOR_OF.get(num(st.direction) ?? -1);
    if (!c) return { refuse: 'a trapdoor without a direction' };
    const iron = name === 'iron_trapdoor';
    const open = bit(st.open_bit) && !iron;
    const p = alt('trapdoor', name, halfNeed(bit(st.upside_down_bit)).map((n) => ({ ...n, cardinal: c })), st, ['direction', 'upside_down_bit', 'open_bit']);
    if ('refuse' in p || 'companion' in p) return p;
    const base = { direction: st.direction!, upside_down_bit: st.upside_down_bit ?? false };
    return { ...p, check: { ...base, ...(iron ? {} : { open_bit: false }) }, final: { ...base, ...(iron ? {} : { open_bit: open }) }, taps: open ? 1 : 0, ignored: iron ? ['open_bit'] : [] };
  }
  // fence gates
  if (name.endsWith("fence_gate")) {
    const c = st['minecraft:cardinal_direction'];
    if (!isCardinal(c)) return { refuse: 'a fence gate without a direction' };
    const open = bit(st.open_bit);
    const p = mk('fence gate', name, { faces: ALL_FACES, cardinal: opp(c) }, st, ['minecraft:cardinal_direction', 'open_bit']);
    return { ...p, check: { 'minecraft:cardinal_direction': c, open_bit: false }, final: { 'minecraft:cardinal_direction': c, open_bit: open }, taps: open ? 1 : 0, tapAvoid: opp(c) };
  }
  // beds: the foot cell; the head follows the view
  if (name === 'bed') {
    const d = DIRECTION_OF.get(num(st.direction) ?? -1);
    if (!d) return { refuse: 'a bed without a direction' };
    // measured: the head goes the way the player looks, direction = that way
    const p = mk('bed', name, { faces: ['up'], cardinal: d }, st, ['direction', 'head_piece_bit']);
    return { ...p, check: { direction: st.direction!, head_piece_bit: false }, final: { direction: st.direction! }, extra: [{ offset: DIR_VEC[d], name, check: { direction: st.direction!, head_piece_bit: true } }] };
  }
  // tall plants: the lower cell on soil; the upper comes with it
  if (TALL_PLANT.test(name)) {
    const p = mk('tall plant', name, { faces: ['up'], soil: true }, st, ['upper_block_bit']);
    return { ...p, check: { upper_block_bit: false }, final: {}, extra: [{ offset: { x: 0, y: 1, z: 0 }, name, check: { upper_block_bit: true } }] };
  }
  if (PLANT.test(name)) return mk('plant', name, { faces: ['up'], soil: true }, st, []);
  // standing signs: 16 directions from the yaw; wall signs: the face
  if (name.endsWith("standing_sign")) {
    const g = num(st.ground_sign_direction);
    if (g === undefined || g < 0 || g > 15) return { refuse: 'a sign without a direction' };
    return mk('standing sign', name, { faces: ['up'], yaw: g * 22.5 - 180, realSupport: true }, st, ['ground_sign_direction']);
  }
  if (name.endsWith("wall_sign")) return faceAttached('wall sign', name, st, 'facing_direction', (f) => FACING[f], SIDES);
  if (name.endsWith("hanging_sign")) {
    if (bit(st.attached_bit)) return { refuse: 'a hanging sign on a chain or a thin block (not measured)' };
    const f = FACING_OF.get(num(st.facing_direction) ?? -1);
    if (!f || !isCardinal(f)) return { refuse: 'a hanging sign without a direction' };
    // ground_sign_direction counts only on a chain (attached_bit, refused above): a click leaves it 0 (measured), and a
    // structure turned by the game turns it anyway, so it is neither chosen nor verified (left in `ignored`)
    const keys = ['hanging', 'facing_direction', 'attached_bit'];
    if (bit(st.hanging)) return mk('hanging sign', name, { faces: ['down'], cardinal: opp(f), realSupport: true }, st, keys);
    // on a wall: a side face across the sign's facing, the view back at it
    const across: BlockFace[] = f === 'north' || f === 'south' ? ['east', 'west'] : ['north', 'south'];
    return mk('hanging sign', name, { faces: across, cardinal: opp(f), realSupport: true }, st, keys);
  }
  // torches, lanterns, ladders, buttons, levers, tripwire hooks
  if ('torch_facing_direction' in st) {
    const t = st.torch_facing_direction;
    if (t === 'top') return mk('torch', name, { faces: ['up'], realSupport: true }, st, ['torch_facing_direction']);
    if (!isCardinal(t)) return { refuse: `a torch facing ${String(t)}` };
    return mk('torch', name, { faces: [opp(t)], realSupport: true }, st, ['torch_facing_direction']);
  }
  if (name.endsWith("lantern") && 'hanging' in st) return mk('lantern', name, { faces: [bit(st.hanging) ? 'down' : 'up'], realSupport: true }, st, ['hanging']);
  if (name === 'ladder') return faceAttached('ladder', name, st, 'facing_direction', (f) => FACING[f], SIDES);
  if (name.endsWith("_button")) return faceAttached('button', name, st, 'facing_direction', (f) => FACING[f], ALL_FACES);
  if (name === 'lever') {
    const d = String(st.lever_direction ?? '');
    const open = bit(st.open_bit);
    let p: PlacementResult;
    if (isCardinal(d)) p = mk('lever', name, { faces: [d], realSupport: true }, st, ['lever_direction', 'open_bit']);
    else {
      const m = /^(up|down)_(north_south|east_west)$/.exec(d);
      if (!m) return { refuse: `a lever ${d}` };
      p = mk('lever', name, { faces: [m[1] === 'up' ? 'up' : 'down'], axis: m[2] === 'north_south' ? 'z' : 'x', realSupport: true }, st, ['lever_direction', 'open_bit']);
    }
    return { ...p, check: { lever_direction: d, open_bit: false }, final: { lever_direction: d, open_bit: open }, taps: open ? 1 : 0, source: open };
  }
  if (name === 'tripwire_hook') {
    const d = DIRECTION_OF.get(num(st.direction) ?? -1);
    if (!d) return { refuse: 'a tripwire hook without a direction' };
    return mk('tripwire hook', name, { faces: [d], realSupport: true }, st, ['direction']);
  }
  // bells and grindstones: standing, on a side, hanging
  if (name === 'bell' || name === 'grindstone') {
    const d = DIRECTION_OF.get(num(st.direction) ?? -1);
    const a = st.attachment;
    if (!d) return { refuse: `a ${name} without a direction` };
    if (a === 'standing') return mk(name, name, { faces: ['up'], cardinal: opp(d) }, st, ['attachment', 'direction']);
    if (a === 'hanging') return mk(name, name, { faces: ['down'], cardinal: opp(d), realSupport: true }, st, ['attachment', 'direction']);
    if (a === 'side') return mk(name, name, { faces: [d], realSupport: true }, st, ['attachment', 'direction']);
    return { refuse: `a ${name} between two blocks (not measured)` };
  }
  // repeaters and comparators: the facing from the view, the delay or the mode by taps
  if (/^(unpowered|powered)_repeater$/.test(name)) {
    const c = st['minecraft:cardinal_direction'];
    if (!isCardinal(c)) return { refuse: 'a repeater without a direction' };
    const delay = num(st.repeater_delay) ?? 0;
    const p = mk('repeater', name, { faces: ['up'], cardinal: opp(c) }, st, ['minecraft:cardinal_direction', 'repeater_delay']);
    return { ...p, name: 'unpowered_repeater', placed: 'unpowered_repeater', check: { 'minecraft:cardinal_direction': c, repeater_delay: 0 }, final: { 'minecraft:cardinal_direction': c, repeater_delay: delay }, taps: delay };
  }
  if (/^(unpowered|powered)_comparator$/.test(name)) {
    const c = st['minecraft:cardinal_direction'];
    if (!isCardinal(c)) return { refuse: 'a comparator without a direction' };
    const sub = bit(st.output_subtract_bit);
    const p = mk('comparator', name, { faces: ['up'], cardinal: opp(c) }, st, ['minecraft:cardinal_direction', 'output_subtract_bit']);
    return { ...p, name: 'unpowered_comparator', placed: 'unpowered_comparator', check: { 'minecraft:cardinal_direction': c, output_subtract_bit: false }, final: { 'minecraft:cardinal_direction': c, output_subtract_bit: sub }, taps: sub ? 1 : 0 };
  }
  // six-way blocks by the view and the eye; blocks attached by their face
  if (name === 'observer') {
    const f = st['minecraft:facing_direction'];
    if (!isDir6(f)) return { refuse: 'an observer without a direction' };
    // the way the player looks: up from below, down from above
    const need: ClickNeed = f === 'up' ? { faces: ALL_FACES, eye: 'below' } : f === 'down' ? { faces: ALL_FACES, eye: 'above' } : { faces: ALL_FACES, cardinal: f, eye: 'level' };
    return mk('six-way', name, need, st, ['minecraft:facing_direction']);
  }
  if (name === 'crafter') {
    const o = String(st.orientation ?? '');
    const level = /^(north|south|east|west)_up$/.exec(o);
    const vert = /^(down|up)_(north|south|east|west)$/.exec(o);
    if (level) return mk('six-way', name, { faces: ALL_FACES, cardinal: opp(level[1] as Cardinal), eye: 'level' }, st, ['orientation']);
    if (vert) return mk('six-way', name, { faces: ALL_FACES, cardinal: opp(vert[2] as Cardinal), eye: vert[1] === 'down' ? 'below' : 'above' }, st, ['orientation']);
    return { refuse: `a crafter facing ${o}` };
  }
  // pistons: the view's way on the level, down from below; barrels, dispensers, droppers: back at the player
  if (/^(piston|sticky_piston)$/.test(name)) return sixInt(name, st, (f) => f);
  if (/^(barrel|dispenser|dropper)$/.test(name)) return sixInt(name, st, (f) => OPPOSITE[f]);
  if (name === 'hopper') {
    const f = FACING_OF.get(num(st.facing_direction) ?? -1);
    if (!f || f === 'up') return { refuse: 'a hopper facing up' };
    return mk('hopper', name, { faces: f === 'down' ? ['up', 'down'] : [OPPOSITE[f]] }, st, ['facing_direction']);
  }
  if (name === 'end_rod') return faceAttached('end rod', name, st, 'facing_direction', (f) => (f === 'up' || f === 'down' ? FACING[f] : FACING[OPPOSITE[f]]), ALL_FACES);
  if (name.endsWith("lightning_rod")) return faceAttached('lightning rod', name, st, 'facing_direction', (f) => FACING[f], ALL_FACES);
  if ('minecraft:block_face' in st) {
    const f = st['minecraft:block_face'];
    if (!isDir6(f)) return { refuse: 'no block face' };
    return mk('amethyst', name, { faces: [f], realSupport: true }, st, ['minecraft:block_face']);
  }
  // blocks facing by the view (furnaces, chests, pumpkins, gates ...): the block faces the player, with exceptions
  if ('minecraft:cardinal_direction' in st) {
    const c = st['minecraft:cardinal_direction'];
    if (!isCardinal(c)) return { refuse: 'no direction' };
    const view = name.endsWith("campfire") ? c : name.endsWith("anvil") ? CLOCKWISE[c] : opp(c);
    // petals and litter lie on the block under them (measured on grass: the view's way back, as a furnace)
    if (/^(pink_petals|wildflowers|leaf_litter)$/.test(name)) return mk('facing', name, { faces: ['up'], cardinal: view }, st, ['minecraft:cardinal_direction']);
    return mk('facing', name, { faces: ALL_FACES, cardinal: view }, st, ['minecraft:cardinal_direction']);
  }
  if ('direction' in st && /^(loom|beehive|bee_nest|decorated_pot|chiseled_bookshelf|lectern)$/.test(name)) {
    const d = DIRECTION_OF.get(num(st.direction) ?? -1);
    if (!d) return { refuse: 'no direction' };
    return mk('facing', name, { faces: ALL_FACES, cardinal: opp(d) }, st, ['direction']);
  }
  // more of the same in one cell
  if (/(^|_)candle$/.test(name)) {
    const n = Math.max(0, Math.min(3, num(st.candles) ?? 0));
    const p = mk('candles', name, { faces: ['up'] }, st, ['candles']);
    return { ...p, check: { candles: 0 }, final: { candles: n }, merges: n };
  }
  const counted = COUNTED[name];
  if (counted) {
    const n = Math.max(0, Math.min(counted.max, num(st[counted.state]) ?? 0));
    const p = mk(name.replace('_', ' '), name, { faces: ['up'] }, st, [counted.state]);
    return { ...p, check: { [counted.state]: 0 }, final: { [counted.state]: n }, merges: n };
  }
  if (name === 'turtle_egg' && st.turtle_egg_count !== undefined && st.turtle_egg_count !== 'one_egg') return { refuse: 'more than one turtle egg (not measured)' };
  if (/(mushroom_block|mushroom_stem)$/.test(name) && num(st.huge_mushroom_bits) !== undefined && num(st.huge_mushroom_bits) !== 14 && num(st.huge_mushroom_bits) !== 15) return { refuse: 'a mushroom block side (chosen by its neighbours in the wild)' };
  if (/_head$|_skull$/.test(name)) {
    const f = FACING_OF.get(num(st.facing_direction) ?? -1);
    if (!f || f === 'down') return { refuse: 'a head without a direction' };
    return mk('head', name, { faces: [f], realSupport: f !== 'up' }, st, ['facing_direction']);
  }
  if (name.endsWith("glazed_terracotta")) {
    const f = FACING_OF.get(num(st.facing_direction) ?? -1);
    if (!f || !isCardinal(f)) return { refuse: 'glazed terracotta without a direction' };
    return mk('glazed terracotta', name, { faces: ALL_FACES, cardinal: opp(f) }, st, ['facing_direction']);
  }
  if (/^(glow_)?frame$/.test(name)) return faceAttached('frame', name, st, 'facing_direction', (f) => FACING[f], ALL_FACES);
  // floor blocks: rails, carpets, plates, dust (their shape follows the neighbours); everything else: any face
  const floor = FLOOR.test(name);
  return mk(name.endsWith("rail") ? 'rail' : name === 'redstone_wire' ? 'dust' : floor ? 'floor' : 'plain', name, { faces: floor ? ['up'] : ALL_FACES }, st, []);
}

/** Blocks that stand only on the block under them. */
const FLOOR = /(^rail|_rail|carpet|pressure_plate|^redstone_wire|^flower_pot|^cake|candle_cake)$/;

/** A placement with one need: `chosen` states checked, the rest derived or not verified. */
function mk(family: string, name: string, need: ClickNeed, st: States, chosen: readonly string[]): Placement {
  const check = pick(st, chosen);
  return {
    ...empty(),
    family,
    name,
    placed: name,
    item: itemOf(name),
    need,
    check,
    final: check,
    derived: derivedOf(st),
    ignored: ignoredOf(st, chosen),
    source: SOURCES.test(name),
  };
}

/** A placement with several ways (the first of `needs` whose faces exist is used): needs merged into one face list. */
function alt(family: string, name: string, needs: readonly Pick<ClickNeed, 'faces' | 'half' | 'cardinal'>[], st: States, chosen: readonly string[]): Placement {
  const p = mk(family, name, { faces: [] }, st, chosen);
  return { ...p, need: { faces: needs.flatMap((n) => n.faces), ...(needs.find((n) => n.half)?.half ? { half: needs.find((n) => n.half)!.half } : {}), ...(needs[0]!.cardinal ? { cardinal: needs[0]!.cardinal } : {}) } };
}

function faceAttached(family: string, name: string, st: States, key: string, value: (f: Dir6) => number, faces: readonly BlockFace[]): PlacementResult {
  const v = num(st[key]);
  const f = faces.find((x) => value(x) === v);
  if (!f) return { refuse: `${family}: ${key}=${String(st[key])} cannot be clicked` };
  return mk(family, name, { faces: [f], realSupport: true }, st, [key]);
}

/**
 * Piston-like blocks (facing_direction int): on the level the view's cardinal gives `viewOf(f)` = the view for
 * facing f; facing down (0) with the eye below the cell, up (1) with the eye above it (measured for all four).
 */
function sixInt(name: string, st: States, viewOf: (f: Dir6) => Dir6): PlacementResult {
  const f = FACING_OF.get(num(st.facing_direction) ?? -1);
  if (!f) return { refuse: `${name} without a direction` };
  const need: ClickNeed = f === 'down' ? { faces: ALL_FACES, eye: 'below' } : f === 'up' ? { faces: ALL_FACES, eye: 'above' } : { faces: ALL_FACES, cardinal: viewOf(f) as Cardinal, eye: 'level' };
  return mk('six-way', name, need, st, ['facing_direction']);
}

// ---- six-way blocks: the eye against the cell (measured: a block faces up or down only with the eye near it)

/**
 * The eye counts as over or under a six-way block's cell within this horizontal distance of the cell's centre on
 * both axes (measured: 1.0 and 1.0 counts, 2.0 and 1.0 does not).
 */
export const SIX_NEAR = 2;
/** `above`: the eye more than this over the cell's bottom (`below`: under the cell's bottom; measured at -0.38 and 0.62). */
export const SIX_ABOVE = 2;
/** Kept off both limits by this much, so a body a little off its cell's centre is still on the planned side. */
export const SIX_MARGIN = 0.3;

/** Where the eye is for a six-way block at `t` (`edge`: too close to a limit to be sure). */
export function eyeSide(eye: Vec3, t: Cell, margin = 0): 'above' | 'below' | 'level' | 'edge' {
  const h = Math.max(Math.abs(eye.x - t.x - 0.5), Math.abs(eye.z - t.z - 0.5));
  const up = eye.y - t.y;
  if (h >= SIX_NEAR + margin) return 'level';
  const near = h < SIX_NEAR - margin;
  if (up > SIX_ABOVE + margin) return near ? 'above' : 'edge';
  if (up < -margin) return near ? 'below' : 'edge';
  if (up > margin && up < SIX_ABOVE - margin) return 'level';
  return 'edge';
}

// ---- the click

export interface ClickChoice {
  face: BlockFace;
  support: Cell;
  /** Block-relative point on the clicked face (undefined: its centre). */
  click?: Vec3;
  /** The view sent with the click. */
  view?: { yaw: number; pitch: number };
  /** The view is the look at the click point (else turned to the needed direction: the server does not check it). */
  natural: boolean;
}

/** A natural look this many degrees inside its quadrant counts (the body may stand a little off the cell's centre). */
export const VIEW_MARGIN = 12;
/** A standing sign's yaw: a view within this of its direction. */
export const YAW_SLACK = 5;

export interface ClickReader {
  blockAt(p: Cell): { name: string; boxes: readonly (readonly number[])[] } | undefined;
}

export interface ChooseOptions {
  /** A block a placement may click (sim.ts clickable). */
  clickable(p: Cell): boolean;
  /** Cells holding a scaffold block (never the support of an attached block). */
  isScaffold?(p: Cell): boolean;
  /** Allow a turned view (default true). */
  turned?: boolean;
  /** A six-way block's eye kept this far off the limits (default SIX_MARGIN; the runner's real eye: less). */
  margin?: number;
}

const FACE_POINT: Readonly<Record<BlockFace, Vec3>> = {
  up: { x: 0.5, y: 1, z: 0.5 },
  down: { x: 0.5, y: 0, z: 0.5 },
  north: { x: 0.5, y: 0.5, z: 0 },
  south: { x: 0.5, y: 0.5, z: 1 },
  west: { x: 0, y: 0.5, z: 0.5 },
  east: { x: 1, y: 0.5, z: 0.5 },
};

/**
 * The best click from `eye` that places `need` into `t` (undefined: none in reach): a support of an allowed face
 * within the click reach, the point on its face, and the view. A natural view first (the look at the click point
 * already in the needed direction), then a visible face, then the nearest point.
 */
export function chooseClick(w: ClickReader, eye: Vec3, t: Cell, need: ClickNeed, o: ChooseOptions): ClickChoice | undefined {
  if (need.eye && eyeSide(eye, t, o.margin ?? SIX_MARGIN) !== need.eye) return undefined;
  let best: { c: ClickChoice; score: number } | undefined;
  for (const face of need.faces) {
    const s = plus(t, { x: -DIR_VEC[face].x, y: -DIR_VEC[face].y, z: -DIR_VEC[face].z });
    if (!o.clickable(s)) continue;
    if (need.realSupport && o.isScaffold?.(s)) continue;
    if (need.soil && !SOIL.test(blockId(w.blockAt(s)?.name ?? ''))) continue;
    if (closestDistance(eye, s) > DEFAULT_CLICK_REACH || cornerDistance(eye, s) > SERVER_CLICK_REACH) continue;
    const at = { ...FACE_POINT[face] };
    if (need.half && face !== 'up' && face !== 'down') at.y = need.half === 'high' ? 0.75 : 0.25;
    const point = { x: s.x + at.x, y: s.y + at.y, z: s.z + at.z };
    const look = lookAngles(eye, point);
    let view: { yaw: number; pitch: number } | undefined;
    let natural = true;
    if (need.cardinal) {
      if (viewCardinal(look.yaw) !== need.cardinal || quadrantMargin(look.yaw) < VIEW_MARGIN) {
        natural = false;
        view = { yaw: cardinalYaw(need.cardinal), pitch: look.pitch };
      } else view = look;
    } else if (need.axis) {
      const c = viewCardinal(look.yaw);
      const ax = c === 'north' || c === 'south' ? 'z' : 'x';
      if (ax !== need.axis || quadrantMargin(look.yaw) < VIEW_MARGIN) {
        natural = false;
        view = { yaw: need.axis === 'z' ? 0 : 90, pitch: look.pitch };
      } else view = look;
    } else if (need.yaw !== undefined) {
      if (yawGap(look.yaw, need.yaw) > YAW_SLACK) {
        natural = false;
        view = { yaw: need.yaw, pitch: look.pitch };
      } else view = look;
    }
    if (!natural && o.turned === false) continue;
    const visible = faceVisibleFrom(eye, s, face);
    const d = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
    const score = (natural ? 0 : 100) + (visible ? 0 : 10) + d;
    const c: ClickChoice = { face, support: s, natural, ...(need.half && face !== 'up' && face !== 'down' ? { click: at } : {}), ...(view ? { view } : {}) };
    if (!best || score < best.score) best = { c, score };
  }
  return best?.c;
}

// ---- doors' hinges (measured: the neighbours at the click decide, never the click point; kept after they change)

/** A block a door's hinge rule counts as solid: a full cube that is not glass-like (measured: cobblestone counts, glass and doors do not). */
export function hingeSolid(b: { name: string; boxes: readonly (readonly number[])[] } | undefined): boolean {
  if (!b || b.boxes.length === 0) return false;
  const n = blockId(b.name);
  if (/glass|leaves|ice$|_door$|trapdoor|fence|wall$|pane|bars|slab$|stairs$/.test(n)) return false;
  return b.boxes.some((x) => (x[0] ?? 1) <= 0.001 && (x[1] ?? 1) <= 0.001 && (x[2] ?? 1) <= 0.001 && (x[3] ?? 0) >= 0.999 && (x[4] ?? 0) >= 0.999 && (x[5] ?? 0) >= 0.999);
}

const isDoorName = (n: string | undefined) => !!n && /_door$|^wooden_door$/.test(blockId(n));

/**
 * The cells a door at `t` placed with view cardinal `view` reads: `next` (a quarter turn anticlockwise from the
 * view, both levels) and `next2` (clockwise).
 */
export function hingeCells(t: Cell, view: Cardinal): { next: Cell; next2: Cell } {
  return { next: plus(t, DIR_VEC[ccw(view)]), next2: plus(t, DIR_VEC[CLOCKWISE[view]]) };
}

/**
 * The hinge a door at `t` gets from its neighbours now (true: door_hinge_bit 1 on the upper half). Measured: a door
 * on the `next` side gives 1, one on the `next2` side 0; else 1 when `next2` has more solid cells (lower and upper
 * level) than `next`.
 */
export function doorHinge(w: ClickReader, t: Cell, view: Cardinal): boolean {
  const { next, next2 } = hingeCells(t, view);
  const up = (c: Cell) => ({ x: c.x, y: c.y + 1, z: c.z });
  const a = w.blockAt(next);
  const b = w.blockAt(next2);
  if (isDoorName(a?.name)) return true;
  if (isDoorName(b?.name)) return false;
  const count = (c: Cell) => Number(hingeSolid(w.blockAt(c))) + Number(hingeSolid(w.blockAt(up(c))));
  return count(next2) > count(next);
}

// ---- rotation (placeStructure)

const turnCardinal = (c: Cardinal, k: number): Cardinal => {
  let r = c;
  for (let i = 0; i < k; i++) r = CLOCKWISE[r];
  return r;
};
const turnDir6 = (d: Dir6, k: number): Dir6 => (isCardinal(d) ? turnCardinal(d, k) : d);
/** rail_direction under a quarter turn clockwise. */
const RAIL_TURN: Readonly<Record<number, number>> = { 0: 1, 1: 0, 2: 5, 5: 3, 3: 4, 4: 2, 6: 7, 7: 8, 8: 9, 9: 6 };
const KEYED = /^(minecraft:connection_|wall_connection_type_|redstone_|pale_moss_carpet_side_)(east|north|south|west)$/;

/**
 * `states` of block `name` turned `rot` degrees clockwise seen from above (the structure's cells turn the same way
 * in placeStructure). States without a direction are kept, and so are vertical ones and a stair's corner (left
 * stays left). The one turner for every format: Track B2's Java readers hand over unturned Bedrock states and
 * placeStructure turns them here, once (Track B2's formats/rotate.ts folded in: vines, portal axis).
 */
export function rotateStates(name: string, states: Readonly<Record<string, unknown>> | undefined, rot: 0 | 90 | 180 | 270): Record<string, unknown> | undefined {
  if (!states || rot === 0) return states ? { ...states } : states;
  const k = rot / 90;
  const n = blockId(name);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(states)) {
    const m = KEYED.exec(key);
    if (m) {
      out[`${m[1]}${turnCardinal(m[2] as Cardinal, k)}`] = v;
      continue;
    }
    out[key] = v;
  }
  const c = out['minecraft:cardinal_direction'];
  if (isCardinal(c)) out['minecraft:cardinal_direction'] = turnCardinal(c, k);
  const f6 = out['minecraft:facing_direction'];
  if (isDir6(f6)) out['minecraft:facing_direction'] = turnDir6(f6, k);
  const bf = out['minecraft:block_face'];
  if (isDir6(bf)) out['minecraft:block_face'] = turnDir6(bf, k);
  if (out.weirdo_direction !== undefined) {
    const w = WEIRDO_OF.get(num(out.weirdo_direction) ?? -1);
    if (w) out.weirdo_direction = WEIRDO[turnCardinal(w, k)];
  }
  if (out.direction !== undefined) {
    const map = n.endsWith("trapdoor") ? TRAPDOOR_DIRECTION : DIRECTION;
    const back = n.endsWith("trapdoor") ? TRAPDOOR_OF : DIRECTION_OF;
    const d = back.get(num(out.direction) ?? -1);
    if (d) out.direction = map[turnCardinal(d, k)];
  }
  if (out.facing_direction !== undefined) {
    const f = FACING_OF.get(num(out.facing_direction) ?? -1);
    if (f) out.facing_direction = FACING[turnDir6(f, k)];
  }
  if (out.coral_direction !== undefined) {
    // coral wall fans are refused; kept turned for completeness (0 west? not measured): unchanged
  }
  for (const ax of ['pillar_axis', 'portal_axis']) {
    if ((out[ax] === 'x' || out[ax] === 'z') && k % 2 === 1) out[ax] = out[ax] === 'x' ? 'z' : 'x';
  }
  if (typeof out.vine_direction_bits === 'number') {
    // Track B2: a vine's sides as bits (south 1, west 2, north 4, east 8)
    const bits: Readonly<Record<Cardinal, number>> = { south: 1, west: 2, north: 4, east: 8 };
    let v = 0;
    for (const c of CARDINALS) if (out.vine_direction_bits & bits[c]) v |= bits[turnCardinal(c, k)];
    out.vine_direction_bits = v;
  }
  if (typeof out.lever_direction === 'string') {
    const l = out.lever_direction;
    if (isCardinal(l)) out.lever_direction = turnCardinal(l, k);
    else if (k % 2 === 1) out.lever_direction = l.replace(/north_south|east_west/, (s) => (s === 'north_south' ? 'east_west' : 'north_south'));
  }
  if (isCardinal(out.torch_facing_direction)) out.torch_facing_direction = turnCardinal(out.torch_facing_direction, k);
  if (out.ground_sign_direction !== undefined) {
    const g = num(out.ground_sign_direction);
    if (g !== undefined) out.ground_sign_direction = (g + 4 * k) % 16;
  }
  if (out.rail_direction !== undefined) {
    let r = num(out.rail_direction);
    if (r !== undefined && r in RAIL_TURN) {
      for (let i = 0; i < k; i++) r = /^(golden|detector|activator)_rail$/.test(n) && r > 5 ? r : RAIL_TURN[r]!;
      out.rail_direction = r;
    }
  }
  if (typeof out.orientation === 'string') {
    out.orientation = out.orientation.replace(/north|south|east|west/, (s) => turnCardinal(s as Cardinal, k));
  }
  return out;
}

/**
 * What is left of a placement's merges and taps on the block `have` in its cell (an earlier attempt placed it and
 * stopped part way): more slabs, candles, pickles or layers; taps for a repeater's delay, a comparator's mode, open.
 */
export function remaining(pl: Placement, have: { name: string; states?: Readonly<Record<string, unknown>> | undefined }): { merges: number; taps: number } {
  let merges = 0;
  let taps = 0;
  if (pl.merges > 0) {
    if (pl.placed !== pl.name) merges = sameBlock(pl.name, have.name) ? 0 : 1;
    else {
      const k = Object.keys(pl.final).find((x) => stateText(pl.final[x]) !== stateText(pl.check[x]));
      merges = k ? Math.max(0, (num(pl.final[k]) ?? 0) - (num(have.states?.[k]) ?? 0)) : 0;
    }
  }
  if (pl.taps > 0) {
    if ('repeater_delay' in pl.final) taps = ((((num(pl.final.repeater_delay) ?? 0) - (num(have.states?.repeater_delay) ?? 0)) % 4) + 4) % 4;
    else taps = statesMatch(pl.final, have.states) ? 0 : 1;
  }
  return { merges, taps };
}

/** Every refusal and placement for a build's blocks, with the companion cells resolved. */
export interface Resolved {
  /** Main cells with their placement (the companions' cells are in `extra`). */
  cells: { block: BuildBlock; placement: Placement }[];
  refused: { block: BuildBlock; reason: string }[];
}

/**
 * Resolve a build's blocks: placements, refusals per block, second cells of two-cell blocks matched to their main
 * cell (a second cell without its main cell is refused; a main cell's extra cell missing in the build is filled
 * anyway). TNT is refused in a build that has a power source.
 */
export function resolveBlocks(blocks: readonly BuildBlock[]): Resolved {
  const out: Resolved = { cells: [], refused: [] };
  const at = new Map<string, BuildBlock>();
  for (const b of blocks) at.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, b);
  const covered = new Set<string>();
  const pending: { block: BuildBlock; companion: Cell }[] = [];
  for (const b of blocks) {
    const p = placementOf(b);
    if ('refuse' in p) out.refused.push({ block: b, reason: p.refuse });
    else if ('companion' in p) pending.push({ block: b, companion: p.companion });
    else {
      out.cells.push({ block: b, placement: p });
      for (const e of p.extra) covered.add(`${b.pos.x + e.offset.x},${b.pos.y + e.offset.y},${b.pos.z + e.offset.z}`);
    }
  }
  for (const c of pending) {
    const k = `${c.block.pos.x},${c.block.pos.y},${c.block.pos.z}`;
    if (covered.has(k)) continue;
    out.refused.push({ block: c.block, reason: 'the second cell of a two-cell block without its first' });
  }
  if (out.cells.some((c) => c.placement.source)) {
    for (let i = out.cells.length - 1; i >= 0; i--) {
      const c = out.cells[i]!;
      if (/^(tnt|underwater_tnt)$/.test(blockId(c.block.name))) {
        out.refused.push({ block: c.block, reason: 'TNT in a build with a power source' });
        out.cells.splice(i, 1);
      }
    }
  }
  return out;
}

export { ALL_FACES, SIDES as SIDE_FACES };
