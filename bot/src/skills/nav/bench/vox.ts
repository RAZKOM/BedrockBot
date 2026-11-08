// Track R1 (docs/pathfinding.md "Reachability (Track R1)"; decisions/0072-reachability.md): the reachability
// bench's world: a dense voxel grid over a small fixed palette. The generators (worlds.ts) write it, the oracle
// (oracle.ts) reads it by palette id, and the closed-loop harness (test/unit/skills/reach-sim.ts) turns it into
// the chunks a real World receives. Nothing here knows the navigator.
import type { Vec3 } from '../../../world/types.ts';

/** Palette ids. A door "X" lets the body pass along x (its plate across x when closed), a door "Z" along z. */
export const V = {
  air: 0,
  stone: 1,
  dirt: 2,
  grass: 3,
  sand: 4,
  gravel: 5,
  bedrock: 6,
  obsidian: 7,
  cobble: 8,
  planks: 9,
  bricks: 10,
  glass: 11,
  water: 12,
  lava: 13,
  fence: 14,
  deepslate: 15,
  doorXLo: 16,
  doorXHi: 17,
  doorZLo: 18,
  doorZHi: 19,
  doorXLoOpen: 20,
  doorXHiOpen: 21,
  doorZLoOpen: 22,
  doorZHiOpen: 23,
} as const;
export type VoxId = (typeof V)[keyof typeof V];

const door = (dir: string, upper: number, open: number): readonly [string, Record<string, unknown>] => ['wooden_door', { 'minecraft:cardinal_direction': dir, upper_block_bit: upper, open_bit: open, door_hinge_bit: 0 }];

/**
 * The block (name, states) of each palette id. A closed door facing south has its plate across the x axis
 * (the body walking along x has to open it); one facing east, across z (NavGrid `crossing`, measured).
 */
export const VOX_BLOCKS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['air', {}],
  ['stone', {}],
  ['dirt', {}],
  ['grass_block', {}],
  ['sand', {}],
  ['gravel', {}],
  ['bedrock', {}],
  ['obsidian', {}],
  ['cobblestone', {}],
  ['oak_planks', {}],
  ['stone_bricks', {}],
  ['glass', {}],
  ['water', { liquid_depth: 0 }],
  ['lava', { liquid_depth: 0 }],
  ['oak_fence', {}],
  ['deepslate', { pillar_axis: 'y' }],
  door('south', 0, 0),
  door('south', 1, 0),
  door('east', 0, 0),
  door('east', 1, 0),
  door('south', 0, 1),
  door('south', 1, 1),
  door('east', 0, 1),
  door('east', 1, 1),
];

export const isDoor = (id: number): boolean => id >= V.doorXLo && id <= V.doorZHiOpen;
export const isDoorLower = (id: number): boolean => id === V.doorXLo || id === V.doorZLo || id === V.doorXLoOpen || id === V.doorZLoOpen;
/** The axis a door lets the body through (0 = x, 2 = z). */
export const doorAxis = (id: number): 0 | 2 => (id === V.doorXLo || id === V.doorXHi || id === V.doorXLoOpen || id === V.doorXHiOpen ? 0 : 2);
/** The same door toggled (open <-> closed). */
export const toggledDoor = (id: number): number => (id >= V.doorXLoOpen ? id - 4 : id + 4);

/** Full cubes (a floor, nothing passes). */
export const isSolid = (id: number): boolean => id >= V.stone && id <= V.glass || id === V.deepslate;
export const isLiquid = (id: number): boolean => id === V.water || id === V.lava;
/** Natural terrain (the dig way's blocks: place/scaffold.ts NATURAL), in this palette. */
export const isNaturalVox = (id: number): boolean => id === V.stone || id === V.dirt || id === V.grass || id === V.sand || id === V.gravel || id === V.deepslate;
/** Built blocks (never dug: terrain/classify.ts isBuiltBlock), in this palette. */
export const isBuiltVox = (id: number): boolean => id === V.cobble || id === V.planks || id === V.bricks || id === V.glass || id === V.fence || isDoor(id);
export const isGravityVox = (id: number): boolean => id === V.sand || id === V.gravel;

export const MIN_Y = -64;
export const HEIGHT = 128;

/** A world of sx x HEIGHT x sz cells from (0, MIN_Y, 0). Outside it: nothing (never loaded, never passable). */
export class Vox {
  readonly sx: number;
  readonly sz: number;
  readonly data: Uint8Array;

  constructor(sx: number, sz: number) {
    this.sx = sx;
    this.sz = sz;
    this.data = new Uint8Array(sx * sz * HEIGHT);
  }

  inside(x: number, y: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.sx && z < this.sz && y >= MIN_Y && y < MIN_Y + HEIGHT;
  }

  index(x: number, y: number, z: number): number {
    return ((y - MIN_Y) * this.sz + z) * this.sx + x;
  }

  /** The palette id at (x, y, z); -1 outside. */
  get(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? this.data[this.index(x, y, z)]! : -1;
  }

  set(x: number, y: number, z: number, id: number): void {
    if (this.inside(x, y, z)) this.data[this.index(x, y, z)] = id;
  }

  fill(a: Vec3, b: Vec3, id: number): void {
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++)
      for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++) for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) this.set(x, y, z, id);
  }

  /** The highest non-air cell of column (x, z) (MIN_Y - 1 when empty or outside). */
  top(x: number, z: number): number {
    for (let y = MIN_Y + HEIGHT - 1; y >= MIN_Y; y--) {
      const v = this.get(x, y, z);
      if (v > 0) return y;
      if (v < 0) return MIN_Y - 1;
    }
    return MIN_Y - 1;
  }

  clone(): Vox {
    const v = new Vox(this.sx, this.sz);
    v.data.set(this.data);
    return v;
  }
}
