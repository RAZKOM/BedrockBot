// Block classification for movement and pathfinding: collision shape, how high its top is, whether
// the player can stand on it, liquids, hazards, leaves, climbables and ground friction. Cached per
// state id. See docs/pathfinding.md.
import type { BlockInfo, Box } from '../../world/types.ts';
import { boxesOf } from './shapes.ts';

export type Liquid = 'water' | 'lava';

export interface TerrainClass {
  name: string;
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
  /** Extra path cost for standing on it (leaves, soul sand, honey ...). */
  penalty: number;
  /** The world model did not know the block (newer than the registry data): a solid cube. */
  unknown: boolean;
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

export const LEAVES_PENALTY = 4;
export const SLOW_PENALTY = 4;

function make(info: BlockInfo): TerrainClass {
  const name = info.name;
  const boxes = boxesOf(info);
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
  const danger = DANGER_NAMES.has(name) || liquid === 'lava';
  return {
    name,
    boxes,
    top,
    floor: boxes.length > 0 && covers && top <= 1 && !danger,
    liquid,
    liquidHeight,
    danger,
    leaves,
    climbable: CLIMB_NAMES.has(name),
    friction: FRICTION[name] ?? 0.6,
    penalty: leaves ? LEAVES_PENALTY : SLOW_NAMES.has(name) ? SLOW_PENALTY : 0,
    unknown: info.stateId < 0,
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
