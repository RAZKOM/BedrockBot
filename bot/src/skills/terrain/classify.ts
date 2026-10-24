// Block classification for movement and pathfinding: collision shape, how high its top is, whether
// the player can stand on it, liquids, hazards, leaves, climbables, ground friction, doors / gates /
// trapdoors (open or closed), fence-like blocks that connect to their neighbours, and what the
// planner may break (gravity blocks, protected blocks). Cached per state id. See docs/pathfinding.md.
import type { BlockInfo, Box } from '../../world/types.ts';
import { boxesOf, connectKindOf, isDoorName, type ConnectKind } from './shapes.ts';

export type Liquid = 'water' | 'lava';
/** Blocks with an open / closed state the body interacts with. */
export type Openable = 'door' | 'trapdoor' | 'gate';

export interface TerrainClass {
  name: string;
  /** Block states (plain values). */
  states: Readonly<Record<string, unknown>>;
  /** Collision boxes, block-local (fences and walls reach y 1.5). Empty = the body passes through. */
  boxes: readonly Box[];
  /** Highest box top (0 without boxes). */
  top: number;
  /**
   * The body can stand on the top: some box with that top covers the block's centre column and
   * the top is at most 1 (fences, walls and closed gates are 1.5 high and count as obstacles).
   */
  floor: boolean;
  liquid: Liquid | undefined;
  /** Liquid surface height inside the block (source 8/9, falling 1); 0 without liquid. */
  liquidHeight: number;
  /** Hurts, traps or slows the body: never path through or onto it. */
  danger: boolean;
  leaves: boolean;
  climbable: boolean;
  /** Ground slipperiness when standing on it (vanilla default 0.6). */
  friction: number;
  /** Extra path cost, in blocks of walking, for standing on it (leaves, soul sand, honey, ice ...). */
  penalty: number;
  /** Multiplier on the tick cost of a move that ends standing on it: 1 + penalty. */
  costFactor: number;
  /** The world model did not know the block (newer than the registry data): a solid cube. */
  unknown: boolean;
  /** Door, trapdoor or fence gate. */
  openable: Openable | undefined;
  /** Its `open_bit` (doors: meaningful on the lower half, see `doorUpper`). */
  open: boolean;
  /** The upper half of a door (Bedrock keeps direction and open state on the lower half). */
  doorUpper: boolean;
  /** Fence / pane / bars: collision arms towards the neighbours (terrain/query.ts adds them). */
  connect: ConnectKind | undefined;
  /** A full solid cube (fences and panes connect to it). */
  fullCube: boolean;
  /** Falls when the block under it is removed (sand, gravel, concrete powder, anvils ...). */
  gravity: boolean;
  /** Never broken by the planner: containers, beds, spawners and the like. */
  protect: boolean;
  /** Blocks the sky for the planner's surface preference: any block with a box except leaves, and liquids. */
  roof: boolean;
}

const WATER_NAMES = new Set(['water', 'flowing_water', 'seagrass', 'kelp', 'bubble_column']);
const LAVA_NAMES = new Set(['lava', 'flowing_lava']);
const DANGER_NAMES = new Set([
  'fire',
  'soul_fire',
  'magma',
  'cactus',
  'campfire',
  'soul_campfire',
  'sweet_berry_bush',
  'wither_rose',
  'web',
  'powder_snow',
  'pointed_dripstone',
  'end_portal',
  'portal',
  'end_gateway',
  'lava_cauldron',
]);
/** Bedrock ground friction (vanilla values; blue ice per bedboo's measurements). */
const FRICTION: Record<string, number> = { ice: 0.98, packed_ice: 0.98, frosted_ice: 0.98, blue_ice: 0.989, slime: 0.8 };
/** Blocks that slow or bounce the body (not modelled by the physics yet): avoid standing on them. */
const SLOW_NAMES = new Set(['soul_sand', 'honey_block', 'slime', 'mud', 'ice', 'packed_ice', 'frosted_ice', 'blue_ice']);
const CLIMB_NAMES = new Set(['ladder', 'vine', 'twisting_vines', 'weeping_vines', 'cave_vines', 'cave_vines_body_with_berries', 'cave_vines_head_with_berries', 'scaffolding']);
const GRAVITY_NAMES = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'scaffolding', 'pointed_dripstone']);
const PROTECT_NAMES = new Set([
  'chest',
  'trapped_chest',
  'ender_chest',
  'barrel',
  'furnace',
  'lit_furnace',
  'blast_furnace',
  'lit_blast_furnace',
  'smoker',
  'lit_smoker',
  'hopper',
  'dispenser',
  'dropper',
  'crafter',
  'brewing_stand',
  'lectern',
  'jukebox',
  'beacon',
  'beehive',
  'bee_nest',
  'decorated_pot',
  'chiseled_bookshelf',
  'mob_spawner',
  'trial_spawner',
  'vault',
  'end_portal_frame',
  'respawn_anchor',
  'enchanting_table',
  'bed',
]);

const UNKNOWN_BOXES: readonly Box[] = Object.freeze([Object.freeze([0, 0, 0, 1, 1.5, 1] as const)]);

export const LEAVES_PENALTY = 4;
export const SLOW_PENALTY = 4;

function isProtected(name: string): boolean {
  return PROTECT_NAMES.has(name) || name.endsWith('_bed') || name.endsWith('shulker_box') || name.endsWith('_chest');
}

function make(info: BlockInfo): TerrainClass {
  const name = info.name;
  // Unknown runtime ids (block data older than the server) are 1.5-high obstacles: on BDS 1.26.60
  // with the 1.26.30 data every fence, glass pane and iron bars block is unknown, and a 1-high cube
  // would let the planner jump onto a fence.
  const boxes = info.stateId < 0 && info.solid ? UNKNOWN_BOXES : boxesOf(info);
  let top = 0;
  for (const b of boxes) top = Math.max(top, b[4]);
  const covers = boxes.some((b) => b[4] === top && b[0] <= 0.5 && b[3] >= 0.5 && b[2] <= 0.5 && b[5] >= 0.5);
  const liquid: Liquid | undefined = WATER_NAMES.has(name) ? 'water' : LAVA_NAMES.has(name) ? 'lava' : undefined;
  let liquidHeight = 0;
  if (liquid) {
    const depth = Number(info.states.liquid_depth ?? 0);
    liquidHeight = depth >= 8 ? 1 : (8 - depth) / 9;
  }
  const leaves = name.endsWith('_leaves') || name === 'leaves' || name === 'leaves2';
  // Campfires only burn while lit: an extinguished one (`extinguished` 1, e.g. after a water bottle
  // or shovel) is a harmless 7/16-high block the body walks over.
  const extinguished = name.endsWith('campfire') && Number(info.states.extinguished ?? 0) === 1;
  const danger = (DANGER_NAMES.has(name) && !extinguished) || liquid === 'lava';
  const openable: Openable | undefined = isDoorName(name) ? 'door' : name.endsWith('trapdoor') ? 'trapdoor' : name.endsWith('fence_gate') ? 'gate' : undefined;
  const penalty = leaves ? LEAVES_PENALTY : SLOW_NAMES.has(name) ? SLOW_PENALTY : 0;
  const b0 = boxes[0];
  const fullCube = boxes.length === 1 && b0?.[0] === 0 && b0[1] === 0 && b0[2] === 0 && b0[3] === 1 && b0[4] === 1 && b0[5] === 1;
  return {
    name,
    states: info.states,
    boxes,
    top,
    floor: boxes.length > 0 && covers && top <= 1 && !danger,
    liquid,
    liquidHeight,
    danger,
    leaves,
    climbable: CLIMB_NAMES.has(name),
    friction: FRICTION[name] ?? 0.6,
    penalty,
    costFactor: 1 + penalty,
    unknown: info.stateId < 0,
    openable,
    open: Number(info.states.open_bit ?? 0) === 1,
    doorUpper: openable === 'door' && Number(info.states.upper_block_bit ?? 0) === 1,
    connect: connectKindOf(name),
    fullCube,
    gravity: GRAVITY_NAMES.has(name) || name.endsWith('concrete_powder'),
    protect: isProtected(name),
    roof: (boxes.length > 0 && !leaves) || liquid !== undefined,
  };
}

const byState: (TerrainClass | undefined)[] = [];
const byName = new Map<string, TerrainClass>();

/** The (cached) classification of a block. */
export function classify(info: BlockInfo): TerrainClass {
  if (info.stateId >= 0) {
    let c = byState[info.stateId];
    if (!c) byState[info.stateId] = c = make(info);
    return c;
  }
  let c = byName.get(info.name);
  if (!c) byName.set(info.name, (c = make(info)));
  return c;
}
