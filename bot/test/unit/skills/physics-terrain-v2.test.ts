// Navigation v2 terrain (PLAN.md 7.1 / 7.3 planner side): door shapes from the block state, fence and
// pane arms towards their neighbours, door / gate / trapdoor classification, crossing a doorway, the
// sky column cache, and the physics against connected fences.
import { describe, expect, it } from 'vitest';
import { IDLE_COMMAND, initialBody, stepBody, type BodyState, type MoveCommand } from '../../../src/skills/input/index.ts';
import { CROSS_BLOCKED, CROSS_CLEAR, CROSS_TOGGLE, NavGrid } from '../../../src/skills/nav/index.ts';
import { blockInfoOf, blockQueryOf, boxesOf, classify, CONNECT_EAST, CONNECT_WEST, connectedBoxes, DOOR_THICKNESS } from '../../../src/skills/terrain/index.ts';
import { flatGen } from './genworld.ts';

const T = DOOR_THICKNESS;

describe('door shapes (minecraft-data has one shape for every door state)', () => {
  it('derives the panel from direction, open bit and hinge', () => {
    const door = (dir: string, open: number, hinge = 0) => boxesOf(blockInfoOf('wooden_door', { 'minecraft:cardinal_direction': dir, open_bit: open, door_hinge_bit: hinge }));
    // the default (south, closed) is minecraft-data's shape: panel at x 0..0.1825
    expect(door('south', 0)).toEqual([[0, 0, 0, T, 1, 1]]);
    expect(door('north', 0)).toEqual([[1 - T, 0, 0, 1, 1, 1]]);
    expect(door('east', 0)).toEqual([[0, 0, 1 - T, 1, 1, 1]]);
    expect(door('west', 0)).toEqual([[0, 0, 0, 1, 1, T]]);
    // open: the panel swings to an edge perpendicular to the closed one
    for (const dir of ['south', 'north', 'east', 'west']) {
      for (const hinge of [0, 1]) {
        const closed = door(dir, 0, hinge)[0]!;
        const open = door(dir, 1, hinge)[0]!;
        const thinX = (b: readonly number[]) => b[3]! - b[0]! < 0.5;
        expect(thinX(open), `${dir} hinge ${hinge}`).toBe(!thinX(closed));
      }
    }
  });

  it("matches Track O's measured panels: closed = the edge clockwise of the direction; open = the opposite edge (hinge 0) or the direction's own edge (hinge 1)", () => {
    const edgeOf = (b: readonly number[]): string => (b[3]! - b[0]! < 0.5 ? (b[0] === 0 ? 'west' : 'east') : b[2] === 0 ? 'north' : 'south');
    const cw: Record<string, string> = { north: 'east', east: 'south', south: 'west', west: 'north' };
    const opp: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };
    for (const dir of ['north', 'east', 'south', 'west']) {
      const box = (open: number, hinge: number) => edgeOf(boxesOf(blockInfoOf('wooden_door', { 'minecraft:cardinal_direction': dir, open_bit: open, door_hinge_bit: hinge }))[0]!);
      expect(box(0, 0), dir).toBe(cw[dir]);
      expect(box(1, 0), dir).toBe(opp[dir]);
      expect(box(1, 1), dir).toBe(dir);
    }
  });

  it('classifies doors, trapdoors and gates with their open state', () => {
    expect(classify(blockInfoOf('wooden_door'))).toMatchObject({ openable: 'door', open: false, doorUpper: false });
    expect(classify(blockInfoOf('spruce_door', { upper_block_bit: 1 }))).toMatchObject({ openable: 'door', doorUpper: true });
    expect(classify(blockInfoOf('fence_gate', { open_bit: 1 }))).toMatchObject({ openable: 'gate', open: true, boxes: [] });
    expect(classify(blockInfoOf('trapdoor'))).toMatchObject({ openable: 'trapdoor', open: false });
    expect(classify(blockInfoOf('oak_fence'))).toMatchObject({ openable: undefined, connect: 'fence' });
    expect(classify(blockInfoOf('glass_pane'))).toMatchObject({ connect: 'pane' });
    expect(classify(blockInfoOf('chest'))).toMatchObject({ protect: true });
    expect(classify(blockInfoOf('gravel'))).toMatchObject({ gravity: true });
    expect(classify(blockInfoOf('oak_leaves'))).toMatchObject({ roof: false, costFactor: 5 });
    expect(classify(blockInfoOf('stone'))).toMatchObject({ roof: true, fullCube: true, costFactor: 1 });
  });
});

describe('fence and pane arms', () => {
  it('connects a fence to fences, full blocks and in-line gates; not to air or leaves', () => {
    const w = flatGen();
    w.put(0, -60, 0, 'oak_fence');
    const q = blockQueryOf(w);
    expect(q.boxesAt!(0, -60, 0)).toEqual(connectedBoxes('fence', 0));
    w.put(1, -60, 0, 'spruce_fence');
    w.put(-1, -60, 0, 'stone');
    expect(q.boxesAt!(0, -60, 0)).toEqual(connectedBoxes('fence', CONNECT_EAST | CONNECT_WEST));
    w.put(-1, -60, 0, 'oak_leaves');
    expect(q.boxesAt!(0, -60, 0)).toEqual(connectedBoxes('fence', CONNECT_EAST));
    // a nether brick fence does not join a wooden one
    w.put(1, -60, 0, 'nether_brick_fence');
    expect(q.boxesAt!(0, -60, 0)).toEqual(connectedBoxes('fence', 0));
    // a gate facing south spans x: it joins fences east and west of it, not north / south
    w.put(1, -60, 0, 'fence_gate', { 'minecraft:cardinal_direction': 'south' });
    expect(q.boxesAt!(0, -60, 0)).toEqual(connectedBoxes('fence', CONNECT_EAST));
    w.put(0, -60, 1, 'oak_fence');
    w.put(1, -60, 1, 'fence_gate', { 'minecraft:cardinal_direction': 'east' });
    expect(q.boxesAt!(0, -60, 1)).toHaveLength(2); // post + north arm (the fence at z 0); not the east gate
  });

  it('the arms reach the cell edges (1.5 high for fences, 1 for panes)', () => {
    expect(connectedBoxes('fence', CONNECT_EAST)).toEqual([
      [0.375, 0, 0.375, 0.625, 1.5, 0.625],
      [0.625, 0, 0.375, 1, 1.5, 0.625],
    ]);
    expect(connectedBoxes('pane', CONNECT_WEST)[1]).toEqual([0, 0, 0.4375, 0.4375, 1, 0.5625]);
  });

  it('a body walking along a connected fence line (one cell off) never touches it; walking into an arm stops at the arm', () => {
    const w = flatGen();
    w.fill({ x: -5, y: -60, z: 2 }, { x: 5, y: -60, z: 2 }, 'oak_fence');
    const q = blockQueryOf(w);
    const run = (s: BodyState, cmd: Partial<MoveCommand>, ticks: number) => {
      let touched = 0;
      for (let i = 0; i < ticks; i++) {
        s = stepBody(s, { ...IDLE_COMMAND, ...cmd }, q).state;
        if (s.collidedHorizontally) touched++;
      }
      return { s, touched };
    };
    // along the line in the row z 1 (body z 1.5 +- 0.3, the arms end at z 2.375)
    const along = run(initialBody({ x: -4.5, y: -60, z: 1.5 }, true), { forward: 1, yaw: -90 }, 40);
    expect(along.touched).toBe(0);
    expect(along.s.pos.x).toBeGreaterThan(3);
    // between two posts (x 0.5 -> the arm between x 0 and 1 is at z 2.375..2.625): blocked at z 2.375 - 0.3
    const into = run(initialBody({ x: 0, y: -60, z: 0.5 }, true), { forward: 1, yaw: 0 }, 30);
    expect(into.s.pos.z).toBeCloseTo(2.375 - 0.3, 3);
  });
});

describe('crossing doorways (NavGrid.crossing)', () => {
  function doorWorld(dir: string, open: number) {
    const w = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 32 });
    w.put(0, -60, 0, 'wooden_door', { 'minecraft:cardinal_direction': dir, open_bit: open, upper_block_bit: 0 });
    w.put(0, -59, 0, 'wooden_door', { 'minecraft:cardinal_direction': dir, upper_block_bit: 1 });
    return w;
  }

  it('a closed door blocks the axis across its panel (toggle) and not the one along it', () => {
    // south (Bedrock) closed = panel at x 0..t: crossing along x needs it open; along z is clear
    const g = new NavGrid(doorWorld('south', 0));
    expect(g.crossing(0, -60, 0, 0)).toBe(CROSS_TOGGLE);
    expect(g.crossing(0, -59, 0, 0)).toBe(CROSS_TOGGLE); // the upper half follows the lower one
    expect(g.crossing(0, -60, 0, 2)).toBe(CROSS_CLEAR);
    const open = new NavGrid(doorWorld('south', 1));
    expect(open.crossing(0, -60, 0, 0)).toBe(CROSS_CLEAR);
    expect(open.crossing(0, -59, 0, 0)).toBe(CROSS_CLEAR);
    expect(open.crossing(0, -60, 0, 2)).toBe(CROSS_TOGGLE);
    expect(g.stand(0, -60, 0)).toBeNaN();
    expect(g.standThrough(0, -60, 0)).toBe(-60);
  });

  it('a closed gate needs a toggle along both axes, an open one is clear; walls and fences are blocked', () => {
    const w = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 32 });
    w.put(0, -60, 0, 'fence_gate', { 'minecraft:cardinal_direction': 'south' });
    w.put(1, -60, 0, 'fence_gate', { 'minecraft:cardinal_direction': 'south', open_bit: 1 });
    w.put(2, -60, 0, 'oak_fence');
    const g = new NavGrid(w);
    expect(g.crossing(0, -60, 0, 2)).toBe(CROSS_TOGGLE);
    expect(g.crossing(1, -60, 0, 2)).toBe(CROSS_CLEAR);
    expect(g.crossing(2, -60, 0, 2)).toBe(CROSS_BLOCKED);
  });
});

describe('sky column cache (NavGrid.skyTop)', () => {
  it('finds the highest roof block, ignores leaves, and resets the column on a block update', () => {
    const w = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 32 });
    const g = new NavGrid(w);
    expect(g.skyTop(0, 0)).toBe(-61); // the grass
    expect(g.underground(0, 0, -60)).toBe(false);
    w.put(0, -50, 0, 'oak_leaves');
    g.invalidate(0, -50, 0);
    expect(g.underground(0, 0, -60)).toBe(false);
    w.put(0, -55, 0, 'stone');
    expect(g.skyTop(0, 0)).toBe(-61); // cached until the update
    g.invalidate(0, -55, 0);
    expect(g.skyTop(0, 0)).toBe(-55);
    expect(g.underground(0, 0, -60)).toBe(true);
    expect(g.underground(0, 0, -54)).toBe(false); // standing on it
  });
});

