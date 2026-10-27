import { describe, expect, it } from 'vitest';
import { blockInfoOf, blockQueryOf, boxesOf, classify } from '../../../src/skills/terrain/index.ts';
import { flatGen } from './genworld.ts';

describe('block shapes (minecraft-data blockCollisionShapes)', () => {
  it('has real boxes for partial blocks where the registry reports a full cube', () => {
    expect(boxesOf(blockInfoOf('stone'))).toEqual([[0, 0, 0, 1, 1, 1]]);
    expect(boxesOf(blockInfoOf('oak_slab'))).toEqual([[0, 0, 0, 1, 0.5, 1]]);
    expect(boxesOf(blockInfoOf('oak_slab', { 'minecraft:vertical_half': 'top' }))).toEqual([[0, 0.5, 0, 1, 1, 1]]);
    expect(boxesOf(blockInfoOf('oak_stairs'))).toHaveLength(2);
    expect(boxesOf(blockInfoOf('oak_fence'))[0]![4]).toBe(1.5);
    expect(boxesOf(blockInfoOf('white_carpet'))).toEqual([[0, 0, 0, 1, 0.0625, 1]]);
    expect(boxesOf(blockInfoOf('soul_sand'))[0]![4]).toBe(0.875);
    expect(boxesOf(blockInfoOf('water'))).toEqual([]);
    expect(boxesOf(blockInfoOf('short_grass'))).toEqual([]);
  });

  it('treats unknown blocks (newer than the block data) as full cubes; the planner and physics as 1.5-high obstacles', () => {
    const unknown = { name: 'unknown', stateId: -1, states: {}, hardness: -1, solid: true, boxes: [[0, 0, 0, 1, 1, 1] as const] };
    expect(boxesOf(unknown)).toEqual([[0, 0, 0, 1, 1, 1]]);
    // fences, panes and bars are unknown runtime ids on BDS 1.26.60 (1.26.30 block data): never a floor
    expect(classify(unknown)).toMatchObject({ floor: false, top: 1.5, boxes: [[0, 0, 0, 1, 1.5, 1]], unknown: true });
  });
});

describe('classify', () => {
  it('floors, liquids, hazards, leaves, friction', () => {
    expect(classify(blockInfoOf('grass_block'))).toMatchObject({ floor: true, top: 1, liquid: undefined, danger: false, friction: 0.6, penalty: 0 });
    expect(classify(blockInfoOf('oak_slab'))).toMatchObject({ floor: true, top: 0.5 });
    expect(classify(blockInfoOf('oak_fence'))).toMatchObject({ floor: false, top: 1.5 });
    expect(classify(blockInfoOf('ladder', { facing_direction: 2 }))).toMatchObject({ floor: false, climbable: true });
    expect(classify(blockInfoOf('water'))).toMatchObject({ liquid: 'water', danger: false });
    expect(classify(blockInfoOf('water')).liquidHeight).toBeCloseTo(8 / 9, 6);
    expect(classify(blockInfoOf('water', { liquid_depth: 8 })).liquidHeight).toBe(1);
    expect(classify(blockInfoOf('lava'))).toMatchObject({ liquid: 'lava', danger: true });
    expect(classify(blockInfoOf('magma'))).toMatchObject({ danger: true, floor: false });
    expect(classify(blockInfoOf('cactus'))).toMatchObject({ danger: true });
    expect(classify(blockInfoOf('web'))).toMatchObject({ danger: true });
    // a lit campfire burns; an extinguished one is a low walkable block (user report, Realm 2026-10-29)
    expect(classify(blockInfoOf('campfire'))).toMatchObject({ danger: true, floor: false });
    expect(classify(blockInfoOf('campfire', { extinguished: 1 }))).toMatchObject({ danger: false, floor: true, top: 0.4375 });
    expect(classify(blockInfoOf('soul_campfire', { extinguished: 1 }))).toMatchObject({ danger: false, floor: true });
    // item frames (labels hung on chest fronts) are walked through: no box, nothing to stand on (Realm 2026-10-30: the bot stood "in frame" and the planner saw a wall)
    expect(classify(blockInfoOf('frame'))).toMatchObject({ floor: false, top: 0, danger: false });
    expect(boxesOf(blockInfoOf('frame'))).toEqual([]);
    // built blocks are never dug by a route (2026-10-30: !mine went through the owner's bookshelves and stone bricks)
    for (const n of ['bookshelf', 'stone_bricks', 'deepslate_brick_stairs', 'oak_planks', 'glass', 'spruce_door', 'cobblestone_wall', 'white_concrete', 'crafting_table']) expect(classify(blockInfoOf(n)).protect, n).toBe(true);
    for (const n of ['stone', 'dirt', 'cobblestone', 'sand', 'gravel', 'oak_log', 'coal_ore', 'deepslate', 'sandstone', 'grass_block']) expect(classify(blockInfoOf(n)).protect, n).toBe(false);
    expect(classify(blockInfoOf('oak_leaves'))).toMatchObject({ leaves: true, floor: true });
    expect(classify(blockInfoOf('oak_leaves')).penalty).toBeGreaterThan(0);
    expect(classify(blockInfoOf('ice')).friction).toBe(0.98);
    expect(classify(blockInfoOf('blue_ice')).friction).toBe(0.989);
    expect(classify(blockInfoOf('slime')).friction).toBe(0.8);
  });

  it('blockQueryOf exposes boxes, friction and liquids to the physics', () => {
    const w = flatGen();
    w.put(0, -60, 0, 'oak_slab');
    w.put(1, -61, 0, 'ice');
    w.put(2, -60, 0, 'water');
    const q = blockQueryOf(w);
    expect(q.boxesAt!(0, -60, 0)).toEqual([[0, 0, 0, 1, 0.5, 1]]);
    expect(q.solidAt(0, -60, 0)).toBe(true);
    expect(q.solidAt(0, -59, 0)).toBe(false);
    expect(q.frictionAt!(1, -61, 0)).toBe(0.98);
    expect(q.liquidAt!(2, -60, 0)).toEqual({ liquid: 'water', height: 8 / 9 });
    expect(q.liquidAt!(3, -60, 0)).toBeNull();
    expect(q.boxesAt!(0, 500, 0)).toBeUndefined();
  });
});
