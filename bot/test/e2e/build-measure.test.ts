// e2e (tag @bds), Track B1 (docs/build.md "Block states", decision 0124): measures how BDS sets a placed block's
// states from a player's click: the face clicked, the point on it, the view (yaw, pitch). One skills-level bot
// (build-probe.ts) stands still; for every trial a target cell is cleared, its one support set, the block placed
// with a chosen face / point / view, and the server's states read back (truth:block). The raw table goes to
// .work/b1/measure-<stamp>.json (and .txt). Gated by BUILD_MEASURE=1 on top of BDS_E2E=1 (not part of the gate).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { BlockFace } from '../../src/skills/place/face.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, FEET_Y, prepareServer, privateArea } from './build-truth.ts';
import { connectProbeBot, truthOk, type ProbeBot } from './build-probe.ts';

const MEASURE = E2E && process.env.BUILD_MEASURE === '1';
const OUT = fileURLToPath(new URL('../../../.work/b1/', import.meta.url));
const ONLY = process.env.BUILD_MEASURE_ONLY ? new RegExp(process.env.BUILD_MEASURE_ONLY) : undefined;

interface View { yaw: number; pitch: number }
interface Trial {
  group: string;
  item: string;
  face: BlockFace;
  at?: Vec3;
  view: View;
  /** Support block (default cobblestone). */
  support?: string;
  /** Extra blocks around the target before the click (relative to T): [dx, dy, dz, name, states?]. */
  pre?: [number, number, number, string, Record<string, unknown>?][];
  /** A raw click instead of the PlaceSkill: on block T + rel, face. */
  raw?: { rel: Vec3; face: BlockFace; at?: Vec3; times?: number };
  /** Raw clicks after placing (use): on T, face up, n times, with what the hand holds. */
  use?: number;
  /** The view of those clicks (default the placing view). */
  useView?: View;
  /** Blocks set after placing, before reading (relative to T): [dx, dy, dz, name]. */
  post?: [number, number, number, string][];
  /** Cells to read besides T (relative). */
  read?: Vec3[];
  /** A wooden door set first by truth:door at T + (dx, 0, dz): direction, hinge. */
  preDoor?: [number, number, string, number];
}

const OFF: Record<BlockFace, Vec3> = { up: { x: 0, y: -1, z: 0 }, down: { x: 0, y: 1, z: 0 }, east: { x: -1, y: 0, z: 0 }, west: { x: 1, y: 0, z: 0 }, south: { x: 0, y: 0, z: -1 }, north: { x: 0, y: 0, z: 1 } };
const YAWS = [0, 90, 180, -90];
const SIDES: BlockFace[] = ['east', 'west', 'north', 'south'];
const ALL6: BlockFace[] = ['up', 'down', ...SIDES];
const v = (yaw: number, pitch = 30): View => ({ yaw, pitch });
const H = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }];

function trials(): { items: [string, number][]; list: Trial[] }[] {
  const g: { items: [string, number][]; list: Trial[] }[] = [];
  // stairs: yaw, the half from the point, the bottom face
  {
    const list: Trial[] = [];
    for (const yaw of [...YAWS, 40, 50, 130, 140, -40, -50, -130, -140]) list.push({ group: 'stairs-yaw', item: 'oak_stairs', face: 'up', view: v(yaw) });
    for (const y of [0.25, 0.75]) for (const yaw of [0, -90]) list.push({ group: 'stairs-half', item: 'oak_stairs', face: 'east', at: { x: 1, y, z: 0.5 }, view: v(yaw, 0) });
    for (const yaw of [0, -90]) list.push({ group: 'stairs-down', item: 'oak_stairs', face: 'down', view: v(yaw, -30) });
    for (const y of [0.25, 0.75]) list.push({ group: 'stairs-half', item: 'stone_brick_stairs', face: 'north', at: { x: 0.5, y, z: 0 }, view: v(180, 0) });
    g.push({ items: [['oak_stairs', 64], ['stone_brick_stairs', 64], ['cobblestone', 64]], list });
  }
  // slabs and double slabs
  {
    const list: Trial[] = [];
    for (const it of ['oak_slab', 'smooth_stone_slab']) {
      list.push({ group: 'slab', item: it, face: 'up', view: v(0) });
      list.push({ group: 'slab', item: it, face: 'down', view: v(0, -30) });
      for (const y of [0.25, 0.49, 0.51, 0.75]) list.push({ group: 'slab-side', item: it, face: 'east', at: { x: 1, y, z: 0.5 }, view: v(-90, 0) });
    }
    // a bottom slab in T, then a click on its top / a click into it from the block above / from the side at the top half
    const bottom: Trial['pre'] = [[0, 0, 0, 'oak_slab', { 'minecraft:vertical_half': 'bottom' }]];
    const top: Trial['pre'] = [[0, 0, 0, 'oak_slab', { 'minecraft:vertical_half': 'top' }]];
    list.push({ group: 'double', item: 'oak_slab', face: 'up', view: v(0), pre: bottom, raw: { rel: { x: 0, y: 0, z: 0 }, face: 'up', at: { x: 0.5, y: 0.5, z: 0.5 } } });
    list.push({ group: 'double', item: 'oak_slab', face: 'up', view: v(0), pre: [...bottom, [0, 1, 0, 'cobblestone']], raw: { rel: { x: 0, y: 1, z: 0 }, face: 'down' } });
    list.push({ group: 'double', item: 'oak_slab', face: 'up', view: v(0), pre: [...bottom, [-1, 0, 0, 'cobblestone']], raw: { rel: { x: -1, y: 0, z: 0 }, face: 'east', at: { x: 1, y: 0.75, z: 0.5 } } });
    list.push({ group: 'double', item: 'oak_slab', face: 'up', view: v(0), pre: top, raw: { rel: { x: 0, y: 0, z: 0 }, face: 'down', at: { x: 0.5, y: 0.5, z: 0.5 } } });
    list.push({ group: 'double', item: 'oak_slab', face: 'up', view: v(0), pre: [...top, [0, -1, 0, 'cobblestone']], raw: { rel: { x: 0, y: -1, z: 0 }, face: 'up' } });
    list.push({ group: 'double', item: 'smooth_stone_slab', face: 'up', view: v(0), pre: bottom, raw: { rel: { x: 0, y: 0, z: 0 }, face: 'up', at: { x: 0.5, y: 0.5, z: 0.5 } } });
    g.push({ items: [['oak_slab', 64], ['smooth_stone_slab', 64], ['cobblestone', 64]], list });
  }
  // pillars: the axis from the face
  {
    const list: Trial[] = [];
    for (const it of ['oak_log', 'quartz_pillar', 'iron_chain', 'basalt', 'hay_block', 'deepslate']) for (const f of ALL6) list.push({ group: 'pillar', item: it, face: f, view: v(-90, 0) });
    list.push({ group: 'pillar-yaw', item: 'oak_log', face: 'up', view: v(0, 0) });
    list.push({ group: 'pillar-yaw', item: 'oak_log', face: 'east', view: v(0, 89) });
    g.push({ items: [['oak_log', 64], ['quartz_pillar', 64], ['iron_chain', 64], ['basalt', 64], ['hay_block', 64], ['deepslate', 64], ['cobblestone', 64]], list });
  }
  // blocks with a cardinal facing from the yaw
  for (const set of [
    ['furnace', 'chest', 'carved_pumpkin', 'anvil', 'loom', 'lectern', 'repeater', 'comparator'],
    ['fence_gate', 'campfire', 'stonecutter_block', 'beehive', 'smoker', 'blast_furnace', 'grindstone', 'bell'],
  ]) {
    const list: Trial[] = [];
    for (const it of set) for (const yaw of YAWS) list.push({ group: 'cardinal', item: it, face: 'up', view: v(yaw) });
    for (const it of ['grindstone', 'bell']) for (const f of ['east', 'down'] as BlockFace[]) list.push({ group: 'cardinal-face', item: it, face: f, view: v(0, 0) });
    g.push({ items: [...set.map((s) => [s, 16] as [string, number]), ['cobblestone', 64]], list });
  }
  // six-way facing: the pitch, the yaw, the face
  {
    const set = ['barrel', 'dispenser', 'dropper', 'observer', 'piston', 'sticky_piston', 'hopper', 'end_rod'];
    const list: Trial[] = [];
    for (const it of set) {
      for (const pitch of [-89, -60, -45.5, -44.5, 0, 44.5, 45.5, 60, 89]) list.push({ group: 'six-pitch', item: it, face: 'up', view: v(90, pitch) });
      for (const yaw of [0, 180, -90]) list.push({ group: 'six-yaw', item: it, face: 'up', view: v(yaw, 0) });
      for (const f of ['east', 'down'] as BlockFace[]) list.push({ group: 'six-face', item: it, face: f, view: v(90, 0) });
    }
    g.push({ items: [...set.map((s) => [s, 32] as [string, number]), ['cobblestone', 64]], list });
  }
  {
    const set = ['lightning_rod', 'crafter', 'tripwire_hook', 'target'];
    const list: Trial[] = [];
    for (const it of set) {
      for (const pitch of [-89, 0, 89]) list.push({ group: 'six-pitch', item: it, face: 'up', view: v(90, pitch) });
      for (const yaw of [0, 180, -90]) list.push({ group: 'six-yaw', item: it, face: 'up', view: v(yaw, 0) });
      for (const f of ['east', 'down', 'north'] as BlockFace[]) list.push({ group: 'six-face', item: it, face: f, view: v(90, 0) });
    }
    g.push({ items: [...set.map((s) => [s, 32] as [string, number]), ['cobblestone', 64]], list });
  }
  // doors: the yaw, the hinge from the point and the neighbours
  {
    const list: Trial[] = [];
    const up = { x: 0, y: 1, z: 0 };
    for (const it of ['wooden_door', 'iron_door']) for (const yaw of YAWS) list.push({ group: 'door', item: it, face: 'up', view: v(yaw), read: [up] });
    for (const x of [0.2, 0.8]) list.push({ group: 'door-point', item: 'wooden_door', face: 'up', at: { x, y: 1, z: 0.5 }, view: v(0), read: [up] });
    for (const z of [0.2, 0.8]) list.push({ group: 'door-point', item: 'wooden_door', face: 'up', at: { x: 0.5, y: 1, z }, view: v(-90), read: [up] });
    // a wall on one side / a door already on one side (facing south: left is +x, right is -x seen from the north)
    for (const dx of [1, -1]) {
      list.push({ group: 'door-wall', item: 'wooden_door', face: 'up', view: v(0), pre: [[dx, 0, 0, 'cobblestone'], [dx, 1, 0, 'cobblestone']], read: [up] });
      for (const hinge of [0, 1]) list.push({ group: 'door-pair', item: 'wooden_door', face: 'up', view: v(0), pre: [[dx, -1, 0, 'cobblestone']], preDoor: [dx, 0, 'south', hinge], read: [up, { x: dx, y: 0, z: 0 }, { x: dx, y: 1, z: 0 }] });
    }
    g.push({ items: [['wooden_door', 32], ['iron_door', 16], ['cobblestone', 64]], list });
  }
  // beds: the head from the yaw
  {
    const list: Trial[] = [];
    for (const yaw of YAWS) list.push({ group: 'bed', item: 'bed', face: 'up', view: v(yaw), read: H });
    g.push({ items: [['bed', 1], ['bed', 1], ['bed', 1], ['bed', 1], ['cobblestone', 64]], list });
  }
  // trapdoors: top / bottom half, the yaw, the face
  {
    const list: Trial[] = [];
    for (const it of ['trapdoor', 'iron_trapdoor']) {
      for (const yaw of YAWS) list.push({ group: 'trapdoor-up', item: it, face: 'up', view: v(yaw) });
      list.push({ group: 'trapdoor-down', item: it, face: 'down', view: v(0, -30) });
      for (const f of SIDES) for (const y of [0.25, 0.75]) list.push({ group: 'trapdoor-side', item: it, face: f, at: undefined, view: v(0, 0), ...(y ? { at: atFor(f, y) } : {}) });
      for (const yaw of YAWS) list.push({ group: 'trapdoor-side-yaw', item: it, face: 'east', at: { x: 1, y: 0.25, z: 0.5 }, view: v(yaw, 0) });
    }
    g.push({ items: [['trapdoor', 32], ['iron_trapdoor', 32], ['cobblestone', 64]], list });
  }
  // attached blocks: torches, lanterns, ladders, buttons, levers, signs
  {
    const list: Trial[] = [];
    for (const it of ['torch', 'soul_torch', 'redstone_torch', 'lantern', 'soul_lantern', 'ladder']) for (const f of ALL6) list.push({ group: 'attached', item: it, face: f, view: v(-90, 0) });
    for (const it of ['stone_button', 'wooden_button']) for (const f of ALL6) list.push({ group: 'button', item: it, face: f, view: v(-90, 0) });
    g.push({ items: [['torch', 64], ['soul_torch', 64], ['redstone_torch', 64], ['lantern', 64], ['soul_lantern', 64], ['ladder', 64], ['stone_button', 64], ['wooden_button', 64], ['cobblestone', 64]], list });
  }
  {
    const list: Trial[] = [];
    for (const f of SIDES) list.push({ group: 'lever', item: 'lever', face: f, view: v(-90, 0) });
    for (const f of ['up', 'down'] as BlockFace[]) for (const yaw of [...YAWS, 40, 50]) list.push({ group: 'lever', item: 'lever', face: f, view: v(yaw, f === 'up' ? 30 : -30) });
    for (const yaw of [0, 11, 12, 22.5, 34, 45, 90, 135, 180, -45, -90, -135]) list.push({ group: 'sign', item: 'oak_sign', face: 'up', view: v(yaw) });
    for (const f of SIDES) list.push({ group: 'sign-wall', item: 'oak_sign', face: f, view: v(0, 0) });
    for (const yaw of [0, 45, 90]) list.push({ group: 'hanging-sign', item: 'oak_hanging_sign', face: 'down', view: v(yaw, -30) });
    for (const f of ['east', 'north'] as BlockFace[]) list.push({ group: 'hanging-sign', item: 'oak_hanging_sign', face: f, view: v(0, 0) });
    list.push({ group: 'hanging-sign', item: 'oak_hanging_sign', face: 'up', view: v(0) });
    for (const it of ['spruce_sign', 'dark_oak_sign']) {
      list.push({ group: 'sign-kind', item: it, face: 'up', view: v(0) });
      list.push({ group: 'sign-kind', item: it, face: 'east', view: v(0, 0) });
    }
    g.push({ items: [['lever', 64], ['oak_sign', 16], ['oak_sign', 16], ['oak_hanging_sign', 16], ['spruce_sign', 16], ['dark_oak_sign', 16], ['cobblestone', 64]], list });
  }
  // connected blocks next to one solid neighbour; floor blocks; rails
  {
    const list: Trial[] = [];
    for (const it of ['oak_fence', 'glass_pane', 'iron_bars', 'cobblestone_wall']) {
      list.push({ group: 'connected', item: it, face: 'up', view: v(0) });
      list.push({ group: 'connected', item: it, face: 'up', view: v(0), pre: [[1, 0, 0, 'cobblestone']] });
      list.push({ group: 'connected', item: it, face: 'up', view: v(0), pre: [[1, 0, 0, it === 'cobblestone_wall' ? 'cobblestone_wall' : it], [0, 0, 1, 'glass']] });
    }
    for (const it of ['white_carpet', 'stone_pressure_plate', 'wooden_pressure_plate', 'redstone']) list.push({ group: 'floor', item: it, face: 'up', view: v(0) });
    g.push({ items: [['oak_fence', 64], ['glass_pane', 64], ['iron_bars', 64], ['cobblestone_wall', 64], ['white_carpet', 64], ['stone_pressure_plate', 64], ['wooden_pressure_plate', 64], ['redstone', 64], ['cobblestone', 64]], list });
  }
  {
    const list: Trial[] = [];
    for (const it of ['rail', 'golden_rail', 'detector_rail', 'activator_rail']) for (const yaw of YAWS) list.push({ group: 'rail', item: it, face: 'up', view: v(yaw) });
    // a rail next to a rail: the shape follows
    list.push({ group: 'rail-next', item: 'rail', face: 'up', view: v(0), pre: [[0, -1, 1, 'cobblestone'], [0, 0, 1, 'rail', { rail_direction: 0 }], [1, -1, 0, 'cobblestone'], [1, 0, 0, 'rail', { rail_direction: 1 }]] });
    g.push({ items: [['rail', 64], ['golden_rail', 64], ['detector_rail', 64], ['activator_rail', 64], ['cobblestone', 64]], list });
  }
  // two-cell plants on grass
  {
    const list: Trial[] = [];
    for (const it of ['sunflower', 'lilac', 'rose_bush', 'peony', 'tall_grass', 'large_fern']) list.push({ group: 'plant', item: it, face: 'up', view: v(0), support: 'grass_block', read: [{ x: 0, y: 1, z: 0 }] });
    list.push({ group: 'plant-stone', item: 'sunflower', face: 'up', view: v(0), read: [{ x: 0, y: 1, z: 0 }] });
    g.push({ items: [['sunflower', 16], ['lilac', 16], ['rose_bush', 16], ['peony', 16], ['tall_grass', 16], ['large_fern', 16], ['cobblestone', 64]], list });
  }
  // clicks after placing (use) and clicks onto the same cell
  {
    const list: Trial[] = [];
    for (const n of [1, 2, 3, 4]) list.push({ group: 'use-repeater', item: 'repeater', face: 'up', view: v(0), use: n });
    for (const n of [1, 2]) list.push({ group: 'use-comparator', item: 'comparator', face: 'up', view: v(0), use: n });
    list.push({ group: 'use-trapdoor', item: 'trapdoor', face: 'up', view: v(0), use: 1 });
    list.push({ group: 'use-gate', item: 'fence_gate', face: 'up', view: v(0), use: 1 });
    list.push({ group: 'use-door', item: 'wooden_door', face: 'up', view: v(0), use: 1, read: [{ x: 0, y: 1, z: 0 }] });
    for (const n of [1, 3]) {
      list.push({ group: 'more-candle', item: 'candle', face: 'up', view: v(0), raw: { rel: { x: 0, y: 0, z: 0 }, face: 'up', times: n } });
      list.push({ group: 'more-pickle', item: 'sea_pickle', face: 'up', view: v(0), raw: { rel: { x: 0, y: 0, z: 0 }, face: 'up', times: n } });
      list.push({ group: 'more-snow', item: 'snow_layer', face: 'up', view: v(0), raw: { rel: { x: 0, y: 0, z: 0 }, face: 'up', times: n } });
    }
    g.push({ items: [['repeater', 16], ['comparator', 16], ['trapdoor', 16], ['fence_gate', 16], ['wooden_door', 16], ['candle', 16], ['sea_pickle', 16], ['snow_layer', 16], ['cobblestone', 64]], list });
  }
  // round C: beds on a floor, end rods' and wall hanging signs' sides, a gate's tap view, a door's hinge after its
  // neighbour goes, a stair's corner, a lever's tap, amethyst
  {
    const list: Trial[] = [];
    const floor: Trial['pre'] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) floor.push([dx, -1, dz, 'cobblestone']);
    for (const yaw of YAWS) list.push({ group: 'xbed', item: 'bed', face: 'up', view: v(yaw), pre: floor, read: H });
    for (const f of ['north', 'south', 'west'] as BlockFace[]) list.push({ group: 'xend-rod', item: 'end_rod', face: f, view: v(90, 0) });
    for (const yaw of [0, 180, 90]) list.push({ group: 'xhanging-wall', item: 'oak_hanging_sign', face: 'east', view: v(yaw, 0) });
    for (const yaw of [90, -90, 0]) list.push({ group: 'xhanging-wall', item: 'oak_hanging_sign', face: 'north', view: v(yaw, 0) });
    // a gate placed looking south (it faces north), opened looking north / east / south
    for (const yaw of [180, -90, 0, 90]) list.push({ group: 'xgate-tap', item: 'fence_gate', face: 'up', view: v(0), use: 1, useView: v(yaw) });
    list.push({ group: 'xlever-tap', item: 'lever', face: 'up', view: v(0), use: 1 });
    // the hinge from a wall to the west, then the wall goes
    list.push({ group: 'xdoor-after', item: 'wooden_door', face: 'up', view: v(0), pre: [[-1, 0, 0, 'cobblestone'], [-1, 1, 0, 'cobblestone']], post: [[-1, 0, 0, 'air'], [-1, 1, 0, 'air']], read: [{ x: 0, y: 1, z: 0 }] });
    // a door between two walls, and with glass to the west
    list.push({ group: 'xdoor-wall2', item: 'wooden_door', face: 'up', view: v(0), pre: [[-1, 0, 0, 'cobblestone'], [-1, 1, 0, 'cobblestone'], [1, 0, 0, 'cobblestone'], [1, 1, 0, 'cobblestone']], read: [{ x: 0, y: 1, z: 0 }] });
    list.push({ group: 'xdoor-glass', item: 'wooden_door', face: 'up', view: v(0), pre: [[-1, 0, 0, 'glass'], [-1, 1, 0, 'glass']], read: [{ x: 0, y: 1, z: 0 }] });
    list.push({ group: 'xdoor-upper', item: 'wooden_door', face: 'up', view: v(0), pre: [[-1, 1, 0, 'cobblestone']], read: [{ x: 0, y: 1, z: 0 }] });
    // stairs: one facing east to the south of T, T's stair looking south / north
    for (const yaw of [0, 180]) list.push({ group: 'xstairs-corner', item: 'oak_stairs', face: 'up', view: v(yaw), pre: [[0, 0, 1, 'oak_stairs', { weirdo_direction: 0 }]], read: [{ x: 0, y: 0, z: 1 }] });
    for (const f of ['up', 'east', 'down'] as BlockFace[]) list.push({ group: 'xamethyst', item: 'amethyst_cluster', face: f, view: v(90, 0) });
    for (const f of ['up', 'east'] as BlockFace[]) list.push({ group: 'xskull', item: 'skeleton_skull', face: f, view: v(90, 30) });
    g.push({ items: [['bed', 1], ['bed', 1], ['bed', 1], ['bed', 1], ['end_rod', 16], ['oak_hanging_sign', 16], ['fence_gate', 16], ['lever', 16], ['wooden_door', 16], ['oak_stairs', 16], ['amethyst_cluster', 16], ['skeleton_skull', 4], ['cobblestone', 64]], list });
  }
  // round D: more blocks of the measured families
  {
    const list: Trial[] = [];
    for (const it of ['white_glazed_terracotta', 'decorated_pot', 'chiseled_bookshelf', 'oak_shelf', 'trapped_chest', 'pumpkin']) for (const yaw of [0, 90]) list.push({ group: 'yfacing', item: it, face: 'up', view: v(yaw) });
    for (const f of ['up', 'east', 'north'] as BlockFace[]) list.push({ group: 'yframe', item: 'frame', face: f, view: v(90, 0) });
    list.push({ group: 'yhead', item: 'skeleton_skull', face: 'north', view: v(90, 0) });
    for (const f of ['up', 'east'] as BlockFace[]) list.push({ group: 'ycopper', item: 'copper_torch', face: f, view: v(90, 0) });
    list.push({ group: 'ycopper', item: 'copper_lantern', face: 'down', view: v(90, 0) });
    for (const yaw of [0, 90]) list.push({ group: 'ypetals', item: 'pink_petals', face: 'up', view: v(yaw), support: 'grass_block' });
    g.push({ items: [['white_glazed_terracotta', 8], ['decorated_pot', 8], ['chiseled_bookshelf', 8], ['oak_shelf', 8], ['trapped_chest', 8], ['pumpkin', 8], ['frame', 8], ['skeleton_skull', 4], ['copper_torch', 8], ['copper_lantern', 8], ['pink_petals', 8], ['cobblestone', 64]], list });
  }
  return g;
}

function atFor(f: BlockFace, y: number): Vec3 {
  switch (f) {
    case 'east':
      return { x: 1, y, z: 0.5 };
    case 'west':
      return { x: 0, y, z: 0.5 };
    case 'south':
      return { x: 0.5, y, z: 1 };
    default:
      return { x: 0.5, y, z: 0 };
  }
}

describe.skipIf(!MEASURE)('@bds build: measure the click rules of block states (Track B1)', () => {
  const area = privateArea();
  let bot: ProbeBot | undefined;
  const rows: Record<string, unknown>[] = [];
  const stand: Vec3 = { x: area.x + 0.5, y: FEET_Y, z: area.z + 0.5 };
  const T: Vec3 = { x: area.x + 2, y: FEET_Y + 1, z: area.z };

  beforeAll(async () => {
    await prepareServer();
    bot = await connectProbeBot('Rule');
    await bot.teleport(stand, -90);
    await truthOk(bot.truth, 'fill', [area.x - 4, FEET_Y - 3, area.z - 4, area.x + 6, FEET_Y - 2, area.z + 4, 'dirt']);
    await truthOk(bot.truth, 'fill', [area.x - 4, FEET_Y - 1, area.z - 4, area.x + 6, FEET_Y - 1, area.z + 4, 'grass_block']);
    await truthOk(bot.truth, 'fill', [area.x - 4, FEET_Y, area.z - 4, area.x + 6, FEET_Y + 6, area.z + 4, 'air']);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await truthOk(bot.truth, 'fill', [area.x - 4, FEET_Y, area.z - 4, area.x + 6, FEET_Y + 6, area.z + 4, 'air']).catch(() => undefined);
      await bot.close();
    }
    mkdirSync(OUT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(`${OUT}measure-${stamp}.json`, JSON.stringify(rows, null, 1));
    writeFileSync(
      `${OUT}measure-${stamp}.txt`,
      rows.map((r) => `${String(r.group).padEnd(18)} ${String(r.item).padEnd(20)} ${String(r.face).padEnd(5)} at ${JSON.stringify(r.at ?? '-')} view ${String(r.view)}${r.stand ? ` stand ${JSON.stringify(r.stand)}` : ''} -> ${String(r.result)}`).join('\n') + '\n',
    );
    console.log(`[build-measure] ${rows.length} trials -> ${OUT}measure-${stamp}.txt`);
  }, 60_000);

  it('runs every trial', async () => {
    const b = bot!;
    const rel = (d: Vec3): Vec3 => ({ x: T.x + d.x, y: T.y + d.y, z: T.z + d.z });
    for (const grp of trials()) {
      const list = grp.list.filter((t) => !ONLY || ONLY.test(t.group) || ONLY.test(t.item));
      if (list.length === 0) continue;
      await b.loadout(grp.items);
      for (const t of list) {
        await truthOk(b.truth, 'fill', [T.x - 1, FEET_Y, T.z - 2, T.x + 2, FEET_Y + 4, T.z + 2, 'air']);
        const s = rel(OFF[t.face]);
        if (!t.raw) await truthOk(b.truth, 'setblock', [s.x, s.y, s.z, t.support ?? 'cobblestone']);
        for (const [dx, dy, dz, name, states] of t.pre ?? []) {
          const p = rel({ x: dx, y: dy, z: dz });
          await truthOk(b.truth, 'setblock', [p.x, p.y, p.z, name, ...Object.entries(states ?? {}).map(([k, val]) => `${k}=${String(val)}`)]);
        }
        if (t.preDoor) {
          const [dx, dz, dir, hinge] = t.preDoor;
          const p = rel({ x: dx, y: 0, z: dz });
          await truthOk(b.truth, 'door', [p.x, p.y, p.z, 'wooden_door', dir, hinge, 0]);
        }
        await b.loop.waitTicks(4);
        let result = '';
        if (t.raw) {
          const times = t.raw.times ?? 1;
          if (times > 1 || t.raw.rel.y !== 0 || t.raw.rel.x !== 0 || t.raw.rel.z !== 0 || !t.pre) {
            // place the first one with the skill when the target starts empty (more-* trials)
            if (!t.pre) {
              await truthOk(b.truth, 'setblock', [s.x, s.y, s.z, t.support ?? 'cobblestone']);
              await b.loop.waitTicks(4);
              const r0 = await b.skills.place(T, { item: t.item, face: t.face, view: t.view });
              result += `first ${r0.ok ? 'ok' : r0.reason}; `;
            }
          }
          const n = t.pre ? times : times - 1;
          for (let k = 0; k < n; k++) await b.click(rel(t.raw.rel), t.raw.face, { item: t.item, view: t.view, ...(t.raw.at ? { at: t.raw.at } : {}) });
        } else {
          const r = await b.skills.place(T, { item: t.item, face: t.face, view: t.view, ...(t.at ? { click: t.at } : {}) });
          result += r.ok ? 'ok' : `failed ${r.reason}`;
          for (let k = 0; k < (t.use ?? 0); k++) await b.click(T, 'up', { view: t.useView ?? t.view });
        }
        for (const [dx, dy, dz, name] of t.post ?? []) {
          const p = rel({ x: dx, y: dy, z: dz });
          await b.loop.waitTicks(2);
          await truthOk(b.truth, 'setblock', [p.x, p.y, p.z, name]);
        }
        await b.loop.waitTicks(4);
        const cells = [{ x: 0, y: 0, z: 0 }, ...(t.read ?? [])];
        const got: string[] = [];
        for (const c of cells) {
          const blk = await b.block(rel(c));
          const st = Object.entries(blk.states)
            .map(([k, val]) => `${k.replace(/^minecraft:/, 'mc:')}=${String(val)}`)
            .join(',');
          got.push(`${c.x || c.y || c.z ? `[${c.x},${c.y},${c.z}] ` : ''}${blk.typeId.replace(/^minecraft:/, '')}{${st}}`);
        }
        result += ` | ${got.join(' | ')}`;
        rows.push({ group: t.group, item: t.item, face: t.face, at: t.at ? `${t.at.x},${t.at.y},${t.at.z}` : undefined, view: `${t.view.yaw}/${t.view.pitch}`, pre: t.pre, raw: t.raw, use: t.use, result });
      }
    }
  }, 1_800_000);

  // six-way blocks: the stand's height and distance (the pitch alone did nothing), natural look at the top face
  it.skipIf(!!ONLY && !ONLY.test('six-pos'))('six-pos: the facing from where the bot stands', async () => {
    const b = bot!;
    const items = ['piston', 'observer', 'dispenser', 'barrel', 'crafter', 'sticky_piston'];
    // round 1 (-3..-1 below, three distances) ran out of items above; round 2: the eye above and the edges
    const dys = (process.env.BUILD_SIX_DY ?? '-1,0,1,2').split(',').map(Number);
    const dxs = (process.env.BUILD_SIX_DX ?? '-1,-2').split(',').map(Number);
    const views: (View | undefined)[] = [undefined, v(90, 0)];
    const t = { x: T.x, y: FEET_Y + 3, z: T.z }; // support below at FEET_Y + 2
    for (const dy of dys) {
      for (const dx of dxs) {
        await b.loadout([...items.map((s) => [s, 16] as [string, number]), ['cobblestone', 64]]);
        const feet = { x: t.x + dx, y: t.y + dy, z: t.z + 1 };
        await truthOk(b.truth, 'fill', [T.x - 4, FEET_Y, T.z - 2, T.x + 2, FEET_Y + 8, T.z + 2, 'air']);
        if (feet.y > FEET_Y) await truthOk(b.truth, 'fill', [feet.x, FEET_Y, feet.z, feet.x, feet.y - 1, feet.z, 'cobblestone']);
        await b.teleport({ x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }, -90);
        for (const it of items) {
          for (const view of views) {
            await truthOk(b.truth, 'fill', [t.x, t.y, t.z, t.x, t.y + 1, t.z, 'air']);
            await truthOk(b.truth, 'setblock', [t.x, t.y - 1, t.z, 'cobblestone']);
            await b.loop.waitTicks(3);
            const r = await b.skills.place(t, { item: it, face: 'up', ...(view ? { view } : {}) });
            await b.loop.waitTicks(3);
            const blk = await b.block(t);
            const eye = b.loop.state.pos.y + 1.62;
            const st = Object.entries(blk.states)
              .map(([k, val]) => `${k.replace(/^minecraft:/, 'mc:')}=${String(val)}`)
              .join(',');
            rows.push({ group: 'six-pos', item: it, face: 'up', view: view ? `${view.yaw}/${view.pitch}` : 'look', stand: `dx ${dx} dz 1 dy ${dy} (eye ${(eye - t.y).toFixed(2)} over the cell bottom)`, result: `${r.ok ? 'ok' : r.reason} | ${blk.typeId.replace(/^minecraft:/, '')}{${st}}` });
          }
        }
      }
    }
  }, 1_800_000);
});
