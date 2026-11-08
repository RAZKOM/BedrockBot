// Track W1 (docs/pathfinding.md "Water (Track W1)", decisions/0070-water-travel.md): the water course of the
// walking and following tests as pure data. No @minecraft/server imports: the pack builds a station with
// `truth:water` (water.ts), the bot's unit tests build the very same geometry in a generated world
// (bot/test/unit/skills/nav-water.test.ts) and the e2e walks it on the server (bot/test/e2e/nav-water.test.ts).
//
// A station is deterministic in (name, origin): its ops clear the footprint first (air from the feet height up,
// the flat world's dirt and grass under it), then build it. The origin is the feet height of the ground at the
// station's start (y -60 on the flat world); every station runs along +z from it, within x -4..4, z -2..22.
//
//   pool2      a 2-deep pool (5 x 9, flush banks) across an enclosure 3 high: the only way to the goal swims it
//   pool6      a 6-deep pool on a 6-high platform, the same enclosure on top (also the "on the bottom" start)
//   column     a 1 x 1 water column 8 high in a stone block, entered under water from a sunken basin through a
//              2-high inlet under the block; the goal on the block's top
//   waterfall  falling water in front of a 12-high wall (a source in a notch at its top), from a 2-deep pool
//              to a shelf beside the fall's top; the server forms the fall from a `kick`
//   lip        a 5 x 5 pit 3 deep, water 2 deep: the rim 2 above the water's top cell (a 1-block lip, which a
//              swimming body cannot climb on BDS) all round but for one step cut into it at the far corner
//   tunnel     a sump: two dry rooms joined by a 1-wide water passage 3 blocks long under a roof, a well at each
//              end (the only way through dives under the roof)
//
// Track W2 (docs/pathfinding.md "Digging out of water (Track W2)"): pools with no swim exit, the start in the water,
// the goal on dry ground (DIG_OUT_STATIONS):
//   lipDirt    the lip pit without its step: the rim is the ground's grass (dug by hand)
//   lipStone   the same pit in a stone block 7 x 7 x 3: the rim is stone (a pickaxe; with none the bot is trapped)
//   bank3      the pit in a dirt mound 2 high on the ground: the bank 3 blocks above the water's top cell (a stair cut)
//   lipBuilt   the lip pit with a stone-brick rim (a built block: never dug; the bot reports it is trapped)
//
// Track W3 (docs/pathfinding.md "Water (Track W1)", its W3 part): a walk through waypoints a player set, where the
// plain walk finds no way (W3_STATIONS; the bot starts on dry ground):
//   step2      a stone block 2 high (7 x 9): the goal on its top (a step too high to jump: one block dug)
//   step3      the same block of dirt 3 high (a stair cut into its face: three blocks dug)
//   drop6      the start on a stone plateau 6 high (7 x 9), the goal on the ground beyond it: every way down is a
//              6-block fall that hurts (3 HP); the bot digs down instead
//   wetGoal    a 1-deep water floor (5 x 9) flush with the ground: the goal cell is a water cell on that floor (a
//              waypoint set standing in shallow water)
//
// Track R1 (docs/pathfinding.md "Reachability (Track R1)"): a station for each failure class the reachability bench
// (bot/scripts/reach-bench.ts) found and fixed, and for the "why unreachable" answers (R1_STATIONS; not in
// WATER_STATIONS: the water e2e builds those, bot/test/e2e/nav-reach.test.ts these):
//   lavaRun    a 1-wide grass path through a lava floor (flush with the ground) with two corners: the follower cut a
//              corner over a lava cell (bench lava:1:12, a death); it centres on the nodes beside a hazard now
//   tower3     a 2 x 2 stone column 3 high, the goal on its top: the dig way's stair dug the goal's own floor (bench
//              pits:1:13); the goal's floor is never dug now
//   vault      a room sealed in bedrock, the goal inside: unreachable, the world closes it (cause `world`)
//   brickRoom  a closed stone-brick room (walls, roof and a floor 3 deep, the bedrock under it), the goal inside:
//              unreachable, the owner's rule on built blocks closes it (cause `rule:built`)
//
// Water placed by a fill may or may not flow on BDS 1.26.60 (measured: a lone source over air stayed put for 160
// ticks, a source with a side open to air beside other fresh water flowed out at once), so no station has a water
// face towards air but at the top of its water: the pools and the column are sources, level, and stay put. The
// waterfall needs its flow: `kicks` are console setblocks run after the fills (`setblock ... flowing_water`
// starts a flow at once), `flows` the cells the server's flow ends up with (what the unit tests put there).
import type { Vec3 } from './protocol.js';

/** The blocks a station is built of (the namespace is minecraft:). */
export type WaterBlock = 'air' | 'stone' | 'dirt' | 'grass_block' | 'water' | 'stone_bricks' | 'lava' | 'bedrock'; // Track R1: lava, bedrock

export interface WaterOp {
  from: Vec3;
  to: Vec3;
  block: WaterBlock;
}

/** A console `setblock x y z <block>` after the fills (starts a flow). */
export interface WaterKick {
  p: Vec3;
  block: 'flowing_water';
}

/** A cell the server's flow fills after the kicks: water with this `liquid_depth` (0 a source, 1..7 flowing, + 8 falling). */
export interface WaterFlow {
  p: Vec3;
  depth: number;
}

export interface WaterStation {
  name: WaterStationName;
  origin: Vec3;
  /** Inclusive block corners of the footprint (everything the ops touch). */
  bounds: { min: Vec3; max: Vec3 };
  ops: WaterOp[];
  kicks: WaterKick[];
  flows: WaterFlow[];
  /** Feet of the body at the start (block centre). */
  start: Vec3;
  /** Track W1: a second start where the station has one (pool6: on the pool's floor, 6 under the surface). */
  deepStart?: Vec3;
  /** The goal: the feet cell to stand in. */
  goal: Vec3;
  /** The surface cells' y (the water's top cell) of the station's main water. */
  surfaceY: number;
}

/** Track W1: stations with a way through the water (no dig). */
export const W1_STATIONS = ['pool2', 'pool6', 'column', 'waterfall', 'lip', 'tunnel'] as const;
/** Track W2: pools with no swim exit, the start in the water (out by a dug step or a stair, or trapped: `lipBuilt`). */
export const DIG_OUT_STATIONS = ['lipDirt', 'lipStone', 'bank3', 'lipBuilt'] as const;
/** Track W3: a walk with no plain way (dug through or down), and a goal cell in water. */
export const W3_STATIONS = ['step2', 'step3', 'drop6', 'wetGoal'] as const;
export const WATER_STATIONS = [...W1_STATIONS, ...DIG_OUT_STATIONS, ...W3_STATIONS] as const;
/** Track R1: the reachability stations (built by the same `truth:water build`, walked by the nav-reach e2e). */
export const R1_STATIONS = ['lavaRun', 'tower3', 'vault', 'brickRoom'] as const;
/** Every station `truth:water` builds. */
export const ALL_STATIONS = [...WATER_STATIONS, ...R1_STATIONS] as const;
export type WaterStationName = (typeof ALL_STATIONS)[number];

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** The footprint, relative to the origin. */
const FOOT = { x0: -4, x1: 4, z0: -2, z1: 22, up: 12 };

/** The station `name` at `origin` (feet height of the ground), or undefined for an unknown name. */
export function waterStation(name: string, origin: Vec3): WaterStation | undefined {
  if (!(ALL_STATIONS as readonly string[]).includes(name)) return undefined;
  const o = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
  const { x, y, z } = o;
  const ops: WaterOp[] = [];
  const kicks: WaterKick[] = [];
  const flows: WaterFlow[] = [];
  const put = (a: Vec3, b: Vec3, block: WaterBlock): void => {
    ops.push({ from: v(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)), to: v(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)), block });
  };
  // the ground back: air from the feet height up, dirt and grass under it
  put(v(x + FOOT.x0, y, z + FOOT.z0), v(x + FOOT.x1, y + FOOT.up, z + FOOT.z1), 'air');
  put(v(x + FOOT.x0, y - 3, z + FOOT.z0), v(x + FOOT.x1, y - 2, z + FOOT.z1), 'dirt');
  put(v(x + FOOT.x0, y - 1, z + FOOT.z0), v(x + FOOT.x1, y - 1, z + FOOT.z1), 'grass_block');
  /** An enclosure 3 high on the floor whose top is at `top` - 1 (feet `top`): walls at x +-3, z -1 and z 17. */
  const enclosure = (top: number): void => {
    put(v(x - 3, top, z - 1), v(x - 3, top + 2, z + 17), 'stone');
    put(v(x + 3, top, z - 1), v(x + 3, top + 2, z + 17), 'stone');
    put(v(x - 3, top, z - 1), v(x + 3, top + 2, z - 1), 'stone');
    put(v(x - 3, top, z + 17), v(x + 3, top + 2, z + 17), 'stone');
  };
  let start = v(x + 0.5, y, z + 1.5);
  let deepStart: Vec3 | undefined;
  let goal = v(x, y, z + 15);
  let surfaceY = y - 1;
  switch (name as WaterStationName) {
    case 'pool2':
      enclosure(y);
      put(v(x - 2, y - 2, z + 4), v(x + 2, y - 1, z + 12), 'water');
      break;
    case 'pool6':
      put(v(x - 3, y, z - 1), v(x + 3, y + 5, z + 17), 'stone');
      enclosure(y + 6);
      put(v(x - 2, y, z + 4), v(x + 2, y + 5, z + 12), 'water');
      start = v(x + 0.5, y + 6, z + 1.5);
      deepStart = v(x + 0.5, y, z + 8.5);
      goal = v(x, y + 6, z + 15);
      surfaceY = y + 5;
      break;
    case 'column':
      // no water face towards air (a fill flows out there: measured), so the way in is under water: from a sunken
      // basin through a 2-high inlet under the block into the column's foot
      put(v(x - 1, y - 2, z + 1), v(x + 1, y - 1, z + 2), 'water'); // the basin
      put(v(x - 1, y - 2, z + 3), v(x + 1, y + 5, z + 5), 'stone'); // the block, its top at y + 5
      put(v(x, y - 2, z + 3), v(x, y - 1, z + 3), 'water'); // the inlet
      put(v(x, y - 2, z + 4), v(x, y + 5, z + 4), 'water'); // the column, 8 high
      goal = v(x + 1, y + 6, z + 4);
      start = v(x + 0.5, y, z - 0.5);
      surfaceY = y + 5;
      break;
    case 'waterfall':
      put(v(x - 2, y - 2, z + 2), v(x + 2, y - 1, z + 5), 'water');
      put(v(x - 3, y - 2, z + 6), v(x + 3, y + 9, z + 6), 'stone'); // the wall, its top block at y + 9
      put(v(x - 1, y + 8, z + 7), v(x + 1, y + 10, z + 7), 'stone'); // behind the notch
      put(v(x, y + 9, z + 6), v(x, y + 9, z + 6), 'water'); // the notch's source
      put(v(x + 1, y + 8, z + 5), v(x + 3, y + 8, z + 5), 'stone'); // the shelf (feet y + 9) beside the column's top
      put(v(x - 3, y + 8, z + 5), v(x - 1, y + 8, z + 5), 'stone');
      // what bds-fly's flow makes of it (measured): the kicked cell stays a source and falls (depth 8) to the pool;
      // it also spreads one cell forward (depth 1, the nearest drop), which falls as well (depth 9): a fall 2 wide
      kicks.push({ p: v(x, y + 9, z + 5), block: 'flowing_water' });
      flows.push({ p: v(x, y + 9, z + 5), depth: 0 }, { p: v(x, y + 9, z + 4), depth: 1 });
      for (let fy = y; fy <= y + 8; fy++) flows.push({ p: v(x, fy, z + 5), depth: 8 }, { p: v(x, fy, z + 4), depth: 9 });
      start = v(x + 0.5, y, z + 0.5);
      goal = v(x + 3, y + 9, z + 5);
      surfaceY = y + 9;
      break;
    case 'lip':
      put(v(x - 2, y - 3, z + 2), v(x + 2, y - 1, z + 6), 'air');
      put(v(x - 2, y - 3, z + 2), v(x + 2, y - 2, z + 6), 'water');
      put(v(x - 3, y - 1, z + 2), v(x - 3, y - 1, z + 2), 'air'); // the one way out: a step cut into the lip
      start = v(x + 0.5, y - 2, z + 5.5);
      goal = v(x, y, z + 8);
      surfaceY = y - 2;
      break;
    case 'lipDirt':
    case 'lipStone':
    case 'bank3':
    case 'lipBuilt': {
      // Track W2: the lip's pit (5 x 5, 3 deep, water 2 deep) with no step: the rim 2 above the water's top cell
      if (name === 'lipStone') put(v(x - 3, y - 3, z + 1), v(x + 3, y - 1, z + 7), 'stone');
      if (name === 'lipBuilt') put(v(x - 3, y - 1, z + 1), v(x + 3, y - 1, z + 7), 'stone_bricks');
      if (name === 'bank3') put(v(x - 4, y, z), v(x + 4, y + 1, z + 12), 'dirt'); // the mound: its top at y + 1 (feet y + 2)
      put(v(x - 2, y - 3, z + 2), v(x + 2, name === 'bank3' ? y + 1 : y - 1, z + 6), 'air');
      put(v(x - 2, y - 3, z + 2), v(x + 2, y - 2, z + 6), 'water');
      start = v(x + 0.5, y - 2, z + 4.5);
      goal = name === 'bank3' ? v(x, y + 2, z + 10) : v(x, y, z + 10);
      surfaceY = y - 2;
      break;
    }
    case 'step2':
    case 'step3': {
      const h = name === 'step2' ? 2 : 3;
      put(v(x - 3, y, z + 6), v(x + 3, y + h - 1, z + 14), name === 'step2' ? 'stone' : 'dirt');
      goal = v(x, y + h, z + 10);
      break;
    }
    case 'drop6':
      put(v(x - 3, y, z), v(x + 3, y + 5, z + 8), 'stone'); // the plateau, its top block at y + 5 (feet y + 6)
      start = v(x + 0.5, y + 6, z + 4.5);
      goal = v(x, y, z + 15);
      break;
    case 'wetGoal':
      put(v(x - 2, y - 1, z + 4), v(x + 2, y - 1, z + 12), 'water'); // in place of the grass: the floor is the dirt under it
      goal = v(x, y - 1, z + 8);
      break;
    case 'lavaRun': {
      // Track R1: lava in place of the grass (flush, sources, level: it stays put), a path of grass through it:
      // along x from z + 3 to z + 10, along z + 10 to x + 3, along x + 3 to z + 17; the goal on the grass beyond
      put(v(x - 3, y - 1, z + 3), v(x + 3, y - 1, z + 17), 'lava');
      put(v(x, y - 1, z + 3), v(x, y - 1, z + 10), 'grass_block');
      put(v(x, y - 1, z + 10), v(x + 3, y - 1, z + 10), 'grass_block');
      put(v(x + 3, y - 1, z + 10), v(x + 3, y - 1, z + 17), 'grass_block');
      goal = v(x + 3, y, z + 19);
      break;
    }
    case 'tower3':
      put(v(x, y, z + 8), v(x + 1, y + 2, z + 9), 'stone'); // its top block at y + 2 (feet y + 3)
      goal = v(x, y + 3, z + 9);
      break;
    case 'vault':
      put(v(x - 2, y, z + 8), v(x + 2, y + 4, z + 12), 'bedrock');
      put(v(x - 1, y + 1, z + 9), v(x + 1, y + 2, z + 11), 'air'); // the room: its floor the bedrock at y
      goal = v(x, y + 1, z + 10);
      break;
    case 'brickRoom':
      put(v(x - 2, y - 3, z + 8), v(x + 2, y + 3, z + 12), 'stone_bricks'); // the floor 3 deep down to the bedrock, walls, roof
      put(v(x - 1, y, z + 9), v(x + 1, y + 2, z + 11), 'air');
      goal = v(x, y, z + 10);
      break;
    case 'tunnel':
      put(v(x - 2, y - 3, z), v(x + 2, y + 3, z + 19), 'stone'); // the hull
      put(v(x - 1, y, z + 1), v(x + 1, y + 2, z + 6), 'air'); // room A
      put(v(x, y - 2, z + 7), v(x, y - 1, z + 11), 'water'); // well A, the sump under the roof (z + 8 .. z + 10), well B
      put(v(x, y, z + 7), v(x, y + 2, z + 7), 'air');
      put(v(x, y, z + 11), v(x, y + 2, z + 11), 'air');
      put(v(x - 1, y, z + 12), v(x + 1, y + 2, z + 18), 'air'); // room B
      start = v(x + 0.5, y, z + 2.5);
      goal = v(x, y, z + 16);
      surfaceY = y - 1;
      break;
  }
  const bounds = { min: v(x + FOOT.x0, y - 3, z + FOOT.z0), max: v(x + FOOT.x1, y + FOOT.up, z + FOOT.z1) };
  return { name: name as WaterStationName, origin: o, bounds, ops, kicks, flows, start, ...(deepStart ? { deepStart } : {}), goal, surfaceY };
}
