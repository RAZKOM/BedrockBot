// Track BB (wave 11; docs/pathfinding.md "Rules"): the shared movement rule set, Baritone's MovementHelper
// ported over TerrainClass (nav/baritone/helper.ts). One test per rule: walking through (air, plants,
// doors open / closed, carpets, snow layers, water still / flowing, lava, fire, cobweb, ladders), standing
// (full blocks, slabs and stairs top / bottom, fences and panes 1.5 high, ice, soul sand, magma with and
// without the sneak setting, farmland, mud, honey, leaves, unknown blocks), walking into (lava, fire,
// cactus, berry bush, powder snow, wither rose, magma, end portal), breaking (water and lava neighbours,
// a gravity block on top and beside, under the feet, the protected area, built blocks, unknown, ice,
// infested, unbreakable, doors), placing (replaceable, place against), the falling-block cost and the
// break time with each tool tier and the Infinity cases; and that the planner's dig-through pays exactly
// `getMiningDurationTicks` per cell, and that the grid's stand rules equal the helper's.
import { describe, expect, it } from 'vitest';
import { findPath, handBreakTicks } from '../../../src/skills/nav/astar.ts';
import { breakBlocker } from '../../../src/skills/nav/actions.ts';
import { DEFAULT_COSTS } from '../../../src/skills/nav/costs.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import {
  ASSUME_WALK_ON_WATER,
  MAYBE,
  NO,
  WALK_ON_BOTTOM_SLAB,
  WALK_ON_MAGMA,
  YES,
  avoidBreaking,
  avoidWalkingInto,
  bestTool,
  breakTicksWith,
  canPlaceAgainst,
  canWalkOn,
  canWalkThrough,
  canWalkThroughClass,
  cellReaderOf,
  fullFloor,
  getMiningDurationTicks,
  isBottomSlab,
  isClimbable,
  isFlowing,
  isNormalCube,
  isReplaceable,
  isSlab,
  isStairs,
  isStillWater,
  mustBeSolidToWalkOn,
  ruleCell,
  type CellReader,
  type MiningContext,
} from '../../../src/skills/nav/baritone/helper.ts';
import { classify, type TerrainClass } from '../../../src/skills/terrain/classify.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import type { BlockInfo } from '../../../src/world/types.ts';
import { flatGen } from './genworld.ts';

const cls = (name: string, states?: Record<string, unknown>): TerrainClass => classify(blockInfoOf(name, states));
/** An unresolved runtime id as the world model reports it: a solid full cube named `unknown`. */
const UNKNOWN: BlockInfo = Object.freeze({ name: 'unknown', stateId: -1, states: Object.freeze({ runtime_id: 777 }), hardness: -1, solid: true, boxes: Object.freeze([[0, 0, 0, 1, 1, 1] as const]) });

/** A small voxel world: stone below y 0, air above, overrides by cell; cells named `?` are not loaded. */
class Voxels implements CellReader {
  private readonly cells = new Map<string, TerrainClass | null>();
  set(x: number, y: number, z: number, name: string, states?: Record<string, unknown>): this {
    this.cells.set(`${x},${y},${z}`, name === '?' ? null : name === 'unknown' ? classify(UNKNOWN) : cls(name, states));
    return this;
  }
  cls(x: number, y: number, z: number): TerrainClass | undefined {
    const c = this.cells.get(`${x},${y},${z}`);
    if (c === null) return undefined;
    return c ?? cls(y < 0 ? 'stone' : 'air');
  }
}

describe('Baritone MovementHelper: canWalkThrough', () => {
  it('air, plants, torches, signs, an open gate, a one-layer snow layer and a ladder are walked through', () => {
    for (const n of ['air', 'short_grass', 'tall_grass', 'torch', 'standing_sign', 'oak_sapling', 'wheat', 'poppy']) expect(canWalkThroughClass(cls(n)), n).toBe(YES);
    expect(canWalkThroughClass(cls('fence_gate', { open_bit: 1 }))).toBe(YES);
    expect(canWalkThroughClass(cls('snow_layer', { height: 0 }))).toBe(YES);
    expect(canWalkThroughClass(cls('ladder', { facing_direction: 2 }))).toBe(YES); // Track AJ: the thin box is no obstacle
  });

  it('doors: open or closed, a door cell is not walked through by the class rule (the grid plans it with crossing / standThrough)', () => {
    expect(canWalkThroughClass(cls('wooden_door', { open_bit: 0 }))).toBe(NO);
    expect(canWalkThroughClass(cls('wooden_door', { open_bit: 1 }))).toBe(NO); // the open panel still has a box along one edge
    expect(canWalkThroughClass(cls('fence_gate', { open_bit: 0 }))).toBe(NO);
    expect(canWalkThroughClass(cls('iron_door'))).toBe(NO);
  });

  it('carpets, snow layers from 2 layers, slabs, trapdoors and full blocks are not walked through (they are floors or walls)', () => {
    for (const n of ['white_carpet', 'oak_slab', 'trapdoor', 'stone', 'glass', 'oak_fence', 'glass_pane']) expect(canWalkThroughClass(cls(n)), n).toBe(NO);
    expect(canWalkThroughClass(cls('snow_layer', { height: 2 }))).toBe(NO);
  });

  it('never lava, fire, cobweb, berry bushes, powder snow, dripstone, end portals, bubble columns, scaffolding or unknown blocks', () => {
    for (const n of ['lava', 'flowing_lava', 'fire', 'soul_fire', 'web', 'sweet_berry_bush', 'powder_snow', 'pointed_dripstone', 'end_portal', 'bubble_column', 'scaffolding', 'cactus', 'magma']) expect(canWalkThroughClass(cls(n)), n).toBe(NO);
    expect(canWalkThroughClass(classify(UNKNOWN))).toBe(NO);
  });

  it('water: a still source is MAYBE (walked through when nothing flows and nothing is above), flowing water is NO', () => {
    expect(canWalkThroughClass(cls('water'))).toBe(MAYBE);
    expect(canWalkThroughClass(cls('water', { liquid_depth: 3 }))).toBe(NO);
    expect(canWalkThroughClass(cls('flowing_water', { liquid_depth: 1 }))).toBe(NO);
    const v = new Voxels().set(0, 0, 0, 'water');
    expect(ASSUME_WALK_ON_WATER).toBe(false);
    expect(canWalkThrough(v, 0, 0, 0)).toBe(true);
    expect(isFlowing(v, 0, 0, 0)).toBe(false);
    expect(isStillWater(v.cls(0, 0, 0)!)).toBe(true);
    // a flowing neighbour makes it flowing
    v.set(1, 0, 0, 'water', { liquid_depth: 2 });
    expect(isFlowing(v, 0, 0, 0)).toBe(true);
    expect(canWalkThrough(v, 0, 0, 0)).toBe(false);
    // water above: no
    const w = new Voxels().set(0, 0, 0, 'water').set(0, 1, 0, 'water');
    expect(canWalkThrough(w, 0, 0, 0)).toBe(false);
    // a lily pad above: no
    const l = new Voxels().set(0, 0, 0, 'water').set(0, 1, 0, 'waterlily');
    expect(canWalkThrough(l, 0, 0, 0)).toBe(false);
    // not loaded
    expect(canWalkThrough(new Voxels().set(0, 0, 0, '?'), 0, 0, 0)).toBeUndefined();
    expect(canWalkThrough(new Voxels().set(0, 0, 0, 'water').set(0, 1, 0, '?'), 0, 0, 0)).toBeUndefined();
  });
});

describe('Baritone MovementHelper: canWalkOn', () => {
  it('full blocks, glass, leaves, ice variants, soul sand, farmland, dirt paths, mud, chests and snow layers are floors', () => {
    for (const n of ['stone', 'grass_block', 'glass', 'white_stained_glass', 'oak_leaves', 'ice', 'packed_ice', 'blue_ice', 'frosted_ice', 'soul_sand', 'farmland', 'grass_path', 'mud', 'chest', 'gravel', 'sand']) {
      expect(canWalkOn(cls(n)), n).toBe(true);
    }
    expect(canWalkOn(cls('snow_layer', { height: 3 }))).toBe(true);
    expect(canWalkOn(cls('white_carpet'))).toBe(true);
    // a node's floor in the cell below needs a top of exactly 1
    expect(fullFloor(cls('stone'))).toBe(true);
    expect(fullFloor(cls('soul_sand'))).toBe(false);
    expect(fullFloor(cls('farmland'))).toBe(false);
  });

  it('slabs and stairs: bottom and top halves are floors (allowWalkOnBottomSlab), upside-down stairs too', () => {
    expect(WALK_ON_BOTTOM_SLAB).toBe(true);
    const bottom = cls('oak_slab');
    const top = cls('oak_slab', { 'minecraft:vertical_half': 'top' });
    expect([canWalkOn(bottom), bottom.top, isBottomSlab(bottom), isSlab(bottom)]).toEqual([true, 0.5, true, true]);
    expect([canWalkOn(top), top.top, isBottomSlab(top), isSlab(top)]).toEqual([true, 1, false, true]);
    expect([isSlab(cls('oak_double_slab')), isBottomSlab(cls('oak_double_slab')), canWalkOn(cls('oak_double_slab'))]).toEqual([false, false, true]);
    const stairs = cls('oak_stairs', { weirdo_direction: 2 });
    expect([canWalkOn(stairs), stairs.top, isStairs(stairs)]).toEqual([true, 1, true]);
    expect(canWalkOn(cls('oak_stairs', { weirdo_direction: 2, upside_down_bit: 1 }))).toBe(true);
    expect(isStairs(cls('stone'))).toBe(false);
  });

  it('fences and walls (1.5 high), unknown blocks, scaffolding and ladders are never floors; panes and bars (a 1-high post) are, by shape', () => {
    expect(cls('oak_fence').top).toBe(1.5);
    expect(cls('cobblestone_wall').top).toBe(1.5);
    for (const n of ['oak_fence', 'cobblestone_wall', 'scaffolding']) expect(canWalkOn(cls(n)), n).toBe(false);
    // Baritone: not a normal cube, so NO; Bedrock: the body stands on the 1-high post (measured shape), so the node above a pane is standable
    for (const n of ['glass_pane', 'iron_bars']) expect([canWalkOn(cls(n)), cls(n).top], n).toEqual([true, 1]);
    for (const n of ['glass_pane', 'iron_bars']) expect(canWalkThroughClass(cls(n)), n).toBe(NO);
    expect(canWalkOn(cls('ladder', { facing_direction: 2 }))).toBe(false);
    expect(canWalkOn(classify(UNKNOWN))).toBe(false);
    expect(classify(UNKNOWN).top).toBe(1.5);
  });

  it('magma: never a floor without the sneak setting (allowWalkOnMagmaBlocks off), a floor with it; honey a (penalised) floor', () => {
    expect(WALK_ON_MAGMA).toBe(false);
    const magma = cls('magma');
    expect(canWalkOn(magma)).toBe(false);
    expect(magma.floorShape).toBe(true);
    expect(canWalkOn(magma, { allowMagma: true })).toBe(true);
    expect(fullFloor(magma, { allowMagma: true })).toBe(true);
    // Baritone refuses honey; ours keeps it a floor (a bot standing on one needs a start node) with the slow penalty
    const honey = cls('honey_block');
    expect([honey.floorShape, canWalkOn(honey), fullFloor(honey)]).toEqual([true, true, true]);
    expect(honey.costFactor).toBe(5);
  });

  it('water, lava, bubble columns, hazards and air are never floors', () => {
    for (const n of ['water', 'lava', 'bubble_column', 'cactus', 'fire', 'powder_snow', 'sweet_berry_bush', 'air', 'campfire']) expect(canWalkOn(cls(n)), n).toBe(false);
  });

  it('mustBeSolidToWalkOn: false for climbers only; isClimbable: ladders and vines, not scaffolding', () => {
    expect(isClimbable(cls('ladder', { facing_direction: 2 }))).toBe(true);
    expect(isClimbable(cls('vine'))).toBe(true);
    expect(isClimbable(cls('scaffolding'))).toBe(false);
    expect(mustBeSolidToWalkOn(cls('ladder', { facing_direction: 2 }))).toBe(false);
    expect(mustBeSolidToWalkOn(cls('stone'))).toBe(true);
    expect(mustBeSolidToWalkOn(cls('oak_slab'))).toBe(true);
  });
});

describe('Baritone MovementHelper: avoidWalkingInto', () => {
  it('liquids, fire, cactus, berry bushes, powder snow, wither roses, cobweb, bubble columns, end portals and magma are avoided', () => {
    for (const n of ['water', 'flowing_water', 'lava', 'fire', 'soul_fire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'wither_rose', 'web', 'bubble_column', 'end_portal', 'magma', 'pointed_dripstone', 'campfire']) {
      expect(avoidWalkingInto(cls(n)), n).toBe(true);
    }
  });

  it('magma is walked into only with the sneak setting; air, grass, stone, an extinguished campfire are fine', () => {
    expect(avoidWalkingInto(cls('magma'), { allowMagma: true })).toBe(false);
    expect(avoidWalkingInto(cls('cactus'), { allowMagma: true })).toBe(true);
    for (const n of ['air', 'short_grass', 'stone', 'oak_slab']) expect(avoidWalkingInto(cls(n)), n).toBe(false);
    expect(avoidWalkingInto(cls('campfire', { extinguished: 1 }))).toBe(false);
  });
});

describe('Baritone MovementHelper: avoidBreaking (the break rules)', () => {
  const stoneAt = (): Voxels => new Voxels(); // stone below y 0: the block at (0, -1, 0) is the one to dig
  const P = [0, -1, 0] as const;

  it('a plain buried stone block may be broken; air, liquids and unknown blocks never', () => {
    expect(avoidBreaking(stoneAt(), ...P)).toBeUndefined();
    expect(avoidBreaking(stoneAt(), 0, 3, 0)).toBe('air');
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'water'), ...P)).toBe('liquid');
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'lava'), ...P)).toBe('liquid');
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'unknown'), ...P)).toBe('unknown_block');
    expect(avoidBreaking(stoneAt().set(0, -1, 0, '?'), ...P)).toBe('unknown');
    // a not loaded neighbour
    expect(avoidBreaking(stoneAt().set(1, -1, 0, '?'), ...P)).toBe('unknown');
  });

  it('water or lava in any of the 6 neighbours (ours: also below and flowing water; Baritone: above and source sides)', () => {
    for (const [dx, dy, dz] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      expect(avoidBreaking(stoneAt().set(dx, -1 + dy, dz, 'water'), ...P), `water at ${dx},${dy},${dz}`).toBe('next_to_liquid');
      expect(avoidBreaking(stoneAt().set(dx, -1 + dy, dz, 'lava'), ...P), `lava at ${dx},${dy},${dz}`).toBe('next_to_liquid');
    }
    expect(avoidBreaking(stoneAt().set(1, -1, 0, 'flowing_water', { liquid_depth: 2 }), ...P)).toBe('next_to_liquid');
    // a diagonal neighbour is not adjacent
    expect(avoidBreaking(stoneAt().set(1, -1, 1, 'lava'), ...P)).toBeUndefined();
  });

  it('a gravity block on top is refused (the owner rule); with allowGravityAbove it is allowed (Baritone pays its break time)', () => {
    for (const n of ['sand', 'gravel', 'red_sand', 'white_concrete_powder', 'anvil', 'suspicious_gravel']) {
      const v = stoneAt().set(0, 0, 0, n);
      expect(avoidBreaking(v, ...P), n).toBe('gravity_above');
      expect(avoidBreaking(v, 0, -1, 0, { allowGravityAbove: true }), n).toBeUndefined();
    }
  });

  it('an unsupported gravity block beside the cell is refused (Baritone avoidUpdatingFallingBlocks); a supported one is fine', () => {
    // gravel beside at the same level with air under it
    const v = stoneAt().set(1, -1, 0, 'gravel').set(1, -2, 0, 'air');
    expect(avoidBreaking(v, ...P)).toBe('gravity_beside');
    // the same gravel on stone
    expect(avoidBreaking(stoneAt().set(1, -1, 0, 'gravel'), ...P)).toBeUndefined();
    // over water it would fall too
    const w = stoneAt().set(0, 0, 1, 'sand').set(0, -1, 1, 'air');
    expect(avoidBreaking(w, 0, 0, 0)).toBe('air'); // the cell itself is air
    const s = stoneAt().set(0, 0, 0, 'stone').set(0, 0, 1, 'sand').set(0, -1, 1, 'air');
    expect(avoidBreaking(s, 0, 0, 0)).toBe('gravity_beside');
  });

  it('never the block under the feet', () => {
    expect(avoidBreaking(stoneAt(), 0, -1, 0, {}, [{ x: 0, y: -1, z: 0 }])).toBe('under_feet');
    expect(avoidBreaking(stoneAt(), 0, -1, 0, {}, [{ x: 1, y: -1, z: 0 }])).toBeUndefined();
  });

  it('the protected area around home (protectRadius) and protectedBlocks by name', () => {
    expect(avoidBreaking(stoneAt(), 0, -1, 0, { protectedArea: { x: 10, y: 0, z: 0, r: 12 } })).toBe('protected_area');
    expect(avoidBreaking(stoneAt(), 0, -1, 0, { protectedArea: { x: 10, y: 0, z: 0, r: 9 } })).toBeUndefined();
    expect(avoidBreaking(stoneAt(), 0, -1, 0, { protectedBlocks: ['stone'] })).toBe('protected');
    expect(avoidBreaking(stoneAt(), 0, -1, 0, { protectedBlocks: new Set(['stone']) })).toBe('protected');
    expect(avoidBreaking(stoneAt(), 0, -1, 0, { protectedBlocks: ['dirt'] })).toBeUndefined();
  });

  it('built blocks, containers, beds, spawners are protected; doors and gates are used, not dug', () => {
    for (const n of ['chest', 'furnace', 'bed', 'mob_spawner', 'stone_bricks', 'oak_planks', 'bookshelf', 'glass', 'white_wool', 'crafting_table', 'cobblestone_wall']) {
      expect(avoidBreaking(stoneAt().set(0, -1, 0, n), ...P), n).toBe('protected');
    }
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'wooden_door'), ...P)).toBe('protected'); // `_door`: a built block first
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'iron_door'), ...P)).toBe('protected');
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'fence_gate'), ...P)).toBe('openable');
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'trapdoor'), ...P)).toBe('openable');
    // natural blocks are not protected
    for (const n of ['dirt', 'cobblestone', 'oak_log', 'coal_ore', 'deepslate', 'sandstone', 'oak_leaves', 'netherrack']) expect(avoidBreaking(stoneAt().set(0, -1, 0, n), ...P), n).toBeUndefined();
  });

  it('ice and frosted ice (they become water), infested blocks and unbreakable blocks are never broken', () => {
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'ice'), ...P)).toBe('ice');
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'frosted_ice'), ...P)).toBe('ice');
    // packed and blue ice do not melt: breakable
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'packed_ice'), ...P)).toBeUndefined();
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'blue_ice'), ...P)).toBeUndefined();
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'infested_stone'), ...P)).toBe('infested');
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'infested_deepslate'), ...P)).toBe('infested');
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'bedrock'), ...P)).toBe('unbreakable');
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'barrier'), ...P)).toBe('unbreakable');
    // the ice-over-water case of the brief: refused for two reasons, ice first after the liquid neighbour? no: the liquid neighbour rule comes later, the ice rule names the block
    expect(avoidBreaking(stoneAt().set(0, -1, 0, 'ice').set(0, -2, 0, 'water'), ...P)).toBe('ice');
  });

  it('breakBlocker (nav/actions.ts) is the same function over a NavGrid', () => {
    const gen = flatGen();
    gen.put(0, -60, 10, 'dirt');
    gen.put(0, -59, 10, 'gravel');
    gen.put(2, -60, 10, 'dirt');
    gen.put(3, -60, 10, 'water');
    gen.put(6, -60, 10, 'dirt');
    gen.put(6, -60, 11, 'chest');
    const grid = new NavGrid(gen);
    expect(breakBlocker(grid, 0, -60, 10)).toBe('gravity_above');
    expect(breakBlocker(grid, 2, -60, 10)).toBe('next_to_liquid');
    expect(breakBlocker(grid, 6, -60, 11)).toBe('protected');
    expect(breakBlocker(grid, 6, -60, 10)).toBeUndefined();
    expect(breakBlocker(grid, 6, -61, 10, {}, [{ x: 6, y: -61, z: 10 }])).toBe('under_feet');
    expect(breakBlocker(grid, 0, -60, 20)).toBe('air');
    expect(breakBlocker(grid, 0, -60, 500)).toBe('unknown');
    for (let x = -3; x <= 6; x++) expect(breakBlocker(grid, x, -60, 10)).toBe(avoidBreaking(cellReaderOf(gen), x, -60, 10));
  });
});

describe('Baritone MovementHelper: placing', () => {
  it('isReplaceable: air, liquids, a one-layer snow layer, grass, ferns, fire; not torches, carpets, two snow layers or blocks', () => {
    for (const n of ['air', 'water', 'lava', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'deadbush', 'fire', 'seagrass', 'vine']) expect(isReplaceable(cls(n)), n).toBe(true);
    expect(isReplaceable(cls('snow_layer', { height: 0 }))).toBe(true);
    expect(isReplaceable(cls('snow_layer', { height: 1 }))).toBe(false);
    for (const n of ['torch', 'white_carpet', 'stone', 'oak_sapling', 'wheat', 'standing_sign', 'oak_slab']) expect(isReplaceable(cls(n)), n).toBe(false);
  });

  it('canPlaceAgainst: normal cubes and glass; not slabs, carpets, fences, leaves-less partials, shulker boxes, scaffolding, unknown blocks, liquids', () => {
    for (const n of ['stone', 'dirt', 'oak_log', 'glass', 'white_stained_glass', 'tinted_glass', 'oak_leaves', 'oak_double_slab', 'ice']) expect(canPlaceAgainst(cls(n)), n).toBe(true);
    for (const n of ['oak_slab', 'white_carpet', 'oak_fence', 'glass_pane', 'undyed_shulker_box', 'scaffolding', 'bamboo', 'pointed_dripstone', 'water', 'air', 'oak_stairs', 'soul_sand', 'farmland']) expect(canPlaceAgainst(cls(n)), n).toBe(false);
    expect(canPlaceAgainst(classify(UNKNOWN))).toBe(false);
    expect(isNormalCube(cls('glass'))).toBe(true);
    expect(isNormalCube(cls('undyed_shulker_box'))).toBe(false);
  });
});

describe('Baritone ToolSet / getMiningDurationTicks: break times', () => {
  const inv = (...names: (string | null)[]) => ({ slots: names.map((n) => (n ? { name: n } : null)), selected: 0 });

  it('breakTicksWith: the best hotbar tool per tier (our measured BDS table), the empty hand without an inventory, Infinity when nothing breaks it', () => {
    expect(breakTicksWith('stone', undefined)).toBe(150);
    expect(breakTicksWith(cls('stone'), inv(null, 'wooden_pickaxe'))).toBe(23);
    expect(breakTicksWith('stone', inv('stone_pickaxe'))).toBe(12);
    expect(breakTicksWith('stone', inv('copper_pickaxe'))).toBe(9);
    expect(breakTicksWith('stone', inv('iron_pickaxe'))).toBe(8);
    expect(breakTicksWith('stone', inv('diamond_pickaxe'))).toBe(6);
    expect(breakTicksWith('stone', inv('netherite_pickaxe'))).toBe(5);
    expect(breakTicksWith('stone', inv('golden_pickaxe'))).toBe(4);
    expect(breakTicksWith('stone', inv('diamond_axe', 'stone_pickaxe', 'iron_pickaxe'))).toBe(8); // the best of the hotbar
    expect(breakTicksWith('oak_log', inv('stone_pickaxe'))).toBe(60); // the wrong tool: hand speed
    expect(breakTicksWith('dirt', inv())).toBe(15);
    expect(breakTicksWith('short_grass', inv())).toBe(0);
    expect(breakTicksWith('bedrock', inv('netherite_pickaxe'))).toBe(Infinity);
    expect(breakTicksWith('bedrock', undefined)).toBe(Infinity);
    expect(breakTicksWith('unknown', inv('netherite_pickaxe'))).toBe(Infinity);
    expect(breakTicksWith('no_such_block', undefined)).toBe(Infinity);
    expect(breakTicksWith(cls('stone'), inv())).toBe(handBreakTicks(cls('stone')));
  });

  it('bestTool: the Digger\'s slot choice (fewest ticks, worn tools skipped)', () => {
    const slots = [{ name: 'dirt' }, { name: 'stone_pickaxe' }, { name: 'iron_pickaxe' }, null];
    expect(bestTool('stone', slots, 0)?.slot).toBe(2);
    expect(bestTool('stone', slots, 0, undefined, (s) => s.name !== 'iron_pickaxe')?.slot).toBe(1);
    expect(bestTool('stone', slots, 0)?.ticks).toBe(8);
    expect(bestTool('no_such_block', slots, 0)).toBeUndefined();
  });

  const ctx = (extra: Partial<MiningContext> = {}): MiningContext => ({ breakTicks: handBreakTicks, dig: 12, ...extra });

  it('getMiningDurationTicks: 0 through air, Infinity for liquids / refused / unbreakable, break time + dig otherwise', () => {
    const v = new Voxels();
    expect(getMiningDurationTicks(v, 0, 2, 0, ctx(), false)).toBe(0);
    expect(getMiningDurationTicks(v, 0, -1, 0, ctx(), false)).toBe(150 + 12);
    expect(getMiningDurationTicks(v.set(0, -1, 0, 'dirt'), 0, -1, 0, ctx({ breakTicks: (c) => breakTicksWith(c, inv('iron_shovel')) }), false)).toBe(3 + 12);
    expect(getMiningDurationTicks(new Voxels().set(0, -1, 0, 'water'), 0, -1, 0, ctx(), false)).toBe(Infinity);
    expect(getMiningDurationTicks(new Voxels().set(1, -1, 0, 'lava'), 0, -1, 0, ctx(), false)).toBe(Infinity);
    expect(getMiningDurationTicks(new Voxels().set(0, -1, 0, 'bedrock'), 0, -1, 0, ctx(), false)).toBe(Infinity);
    expect(getMiningDurationTicks(new Voxels().set(0, -1, 0, 'chest'), 0, -1, 0, ctx(), false)).toBe(Infinity);
    expect(getMiningDurationTicks(new Voxels().set(0, -1, 0, '?'), 0, -1, 0, ctx(), false)).toBe(Infinity);
    expect(getMiningDurationTicks(new Voxels(), 0, -1, 0, ctx({ rules: { protectedArea: { x: 0, y: 0, z: 0, r: 5 } } }), false)).toBe(Infinity);
    expect(getMiningDurationTicks(new Voxels(), 0, -1, 0, ctx({ feetFloors: [{ x: 0, y: -1, z: 0 }] }), false)).toBe(Infinity);
    expect(getMiningDurationTicks(new Voxels(), 0, -1, 0, ctx({ noBreak: (x, y, z) => x === 0 && y === -1 && z === 0 }), false)).toBe(Infinity);
    // hazards without a box are never walked into and never "dug" (astar.ts digThrough refuses them too); a vine is walked through
    expect(getMiningDurationTicks(new Voxels().set(0, 0, 0, 'fire'), 0, 0, 0, ctx(), false)).toBe(Infinity);
    expect(getMiningDurationTicks(new Voxels().set(0, 0, 0, 'sweet_berry_bush'), 0, 0, 0, ctx(), false)).toBe(Infinity);
    expect(getMiningDurationTicks(new Voxels().set(0, 0, 0, 'vine'), 0, 0, 0, ctx(), false)).toBe(0);
    // a ladder's thin box is a built block: never dug
    expect(getMiningDurationTicks(new Voxels().set(0, 0, 0, 'ladder', { facing_direction: 2 }), 0, 0, 0, ctx(), false)).toBe(Infinity);
  });

  it('the falling-block cost: a gravity block above is refused by default; with allowGravityAbove its break time is counted again (recursively)', () => {
    const v = new Voxels().set(0, 0, 0, 'gravel').set(0, 1, 0, 'gravel');
    expect(getMiningDurationTicks(v, 0, -1, 0, ctx(), true)).toBe(Infinity);
    const allow = ctx({ rules: { allowGravityAbove: true } });
    // stone 150 + 12, gravel by hand 18 + 12 twice
    expect(getMiningDurationTicks(v, 0, -1, 0, allow, false)).toBe(150 + 12);
    expect(getMiningDurationTicks(v, 0, -1, 0, allow, true)).toBe(150 + 12 + (18 + 12) + (18 + 12));
    // sand with a liquid above the stack: the top block is refused, so the whole dig is
    const w = new Voxels().set(0, 0, 0, 'sand').set(0, 1, 0, 'water');
    expect(getMiningDurationTicks(w, 0, -1, 0, allow, true)).toBe(Infinity);
  });

  it('the planner pays exactly getMiningDurationTicks per dug cell (nav/astar.ts digThrough composes the same rules); fire and ladder cells are refused by both', () => {
    const gen = flatGen();
    for (let x = -24; x <= 24; x++) for (let y = -60; y <= -58; y++) gen.put(x, y, 10, 'dirt');
    // the straight column (x 0): fire in the head cell; x 1: a ladder in the feet cell: neither is dug
    gen.put(0, -59, 10, 'fire');
    gen.put(1, -60, 10, 'ladder', { facing_direction: 2 });
    const grid = new NavGrid(gen);
    const r = findPath(grid, { x: 0, y: -60, z: 2 }, { type: 'block', p: { x: 0, y: -60, z: 18 } }, { allowBreak: true });
    const digNode = r.path.find((n) => n.act?.dig);
    expect(digNode?.act?.dig).toHaveLength(2);
    expect(digNode!.x).not.toBe(0);
    expect(digNode!.x).not.toBe(1);
    const hand = ctx({ dig: DEFAULT_COSTS.dig });
    expect(getMiningDurationTicks(grid, 0, -59, 10, hand, false)).toBe(Infinity);
    expect(getMiningDurationTicks(grid, 1, -60, 10, hand, false)).toBe(Infinity);
    const c = ctx({ dig: DEFAULT_COSTS.dig, feetFloors: [{ x: digNode!.x, y: digNode!.y - 1, z: digNode!.z }] });
    const expected = digNode!.act!.dig!.reduce((a, p) => a + getMiningDurationTicks(grid, p.x, p.y, p.z, c, false), 0);
    expect(expected).toBe(2 * (15 + DEFAULT_COSTS.dig));
    // the node's cost: the walk, the dig ticks, and the surface preference (the wall's top row stays over the head)
    const roof = grid.underground(digNode!.x, digNode!.z, digNode!.feet) ? DEFAULT_COSTS.underground : 0;
    expect(digNode!.cost - DEFAULT_COSTS.walk - roof).toBeCloseTo(expected, 6);
  });
});

describe('the grid uses the shared rules', () => {
  it('stand: floors and passable cells answer like canWalkOn / canWalkThrough; magma, berry bushes and powder snow block a node, honey is a floor', () => {
    const gen = flatGen();
    gen.put(0, -61, 0, 'magma');
    gen.put(1, -60, 0, 'sweet_berry_bush');
    gen.put(2, -60, 0, 'powder_snow');
    gen.put(3, -61, 0, 'honey_block');
    gen.put(4, -60, 0, 'soul_sand');
    gen.put(5, -60, 0, 'oak_slab');
    gen.put(6, -61, 0, 'farmland');
    gen.put(7, -60, 0, 'white_carpet');
    gen.put(8, -61, 0, 'ice');
    gen.put(9, -60, 0, 'oak_fence');
    gen.put(10, -60, 0, 'oak_slab', { 'minecraft:vertical_half': 'top' });
    const grid = new NavGrid(gen);
    const feet = (x: number) => grid.stand(x, -60, 0);
    expect(feet(0)).toBeNaN(); // magma under the feet
    expect(feet(1)).toBeNaN();
    expect(feet(2)).toBeNaN();
    expect(feet(3)).toBe(-60); // honey: a floor (penalised), see canWalkOn
    expect(feet(4)).toBe(-60 + 0.875);
    expect(feet(5)).toBe(-59.5);
    expect(feet(6)).toBeNaN(); // farmland is not a full floor: the node is the farmland's own cell (a step down the walk rule takes, decision 0022)
    expect(grid.stand(6, -61, 0)).toBe(-61 + 0.9375);
    expect(feet(7)).toBe(-60 + 0.0625);
    expect(feet(8)).toBe(-60);
    expect(feet(9)).toBeNaN();
    expect(feet(10)).toBeNaN(); // a top slab fills the cell: the node is the one above
    expect(grid.stand(10, -59, 0)).toBe(-59);
    expect(grid.free(1, -60, 0)).toBe(false);
    expect(grid.free(11, -60, 0)).toBe(true);
  });

  it('ruleCell (the miner\'s TunnelCell): open / solid / liquid / gravity / dripstone from the same rules', () => {
    expect(ruleCell(cls('air'))).toEqual({ open: true, solid: false, liquid: false, gravity: false, dripstone: false, hazard: false });
    expect(ruleCell(cls('stone'))).toEqual({ open: false, solid: true, liquid: false, gravity: false, dripstone: false, hazard: false });
    expect(ruleCell(cls('fire'))).toMatchObject({ open: false, solid: false, hazard: true });
    expect(ruleCell(cls('ladder', { facing_direction: 2 }))).toMatchObject({ open: true, solid: false, hazard: false });
    expect(ruleCell(cls('water'))).toMatchObject({ open: false, solid: false, liquid: true });
    expect(ruleCell(cls('gravel'))).toMatchObject({ solid: true, gravity: true });
    expect(ruleCell(cls('pointed_dripstone'))).toMatchObject({ open: false, solid: false, dripstone: true });
    expect(ruleCell(cls('magma'))).toMatchObject({ open: false, solid: false });
    expect(ruleCell(cls('oak_slab'))).toMatchObject({ open: false, solid: true });
  });
});
