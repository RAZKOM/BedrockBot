// The large-build generator of the e2e (Track B3's castle, build-large.test.ts; Track B4's smaller fort fed from
// shulker boxes, build-boxes.test.ts): a curtain wall with crenellations and a gate, a house under a gable roof of oak
// stairs with a ridge of slabs, an optional tower, a staircase up the inside of the wall. As Java cells (the header of a
// Sponge .schem written by Track B2's writer). The defaults are Track B3's castle, cell for cell.
import type { JavaCell } from '../../src/skills/build/formats/schem.ts';

export interface CastleOptions {
  /** Size x and z (51, 41) and the height of the box (25: the tower's). */
  w?: number;
  d?: number;
  h?: number;
  /** The curtain wall's height below the crenellations (7) and its thickness (3). */
  wallH?: number;
  thick?: number;
  /** Glass windows in the curtain wall (true). */
  wallGlass?: boolean;
  /** The house's corners x0, x1, z0, z1 ([6, 26, 6, 20]) and its wall height (8). */
  house?: [number, number, number, number];
  houseH?: number;
  /** The house floor's block (stone_bricks). */
  houseFloor?: string;
  /** The tower 9 x 9 at x 34..42, z 8..16, `h` high (true). */
  tower?: boolean;
  /** The staircase's stairs (stone_brick_stairs). */
  stair?: string;
}

/** The box a castle of these options fills. */
export function castleSize(o: CastleOptions = {}): { x: number; y: number; z: number } {
  return { x: o.w ?? 51, y: o.h ?? 25, z: o.d ?? 41 };
}

/** The structure as Java cells. */
export function castle(o: CastleOptions = {}): JavaCell[] {
  const { x: W, y: H, z: D } = castleSize(o);
  const WH = o.wallH ?? 7;
  const T = o.thick ?? 3;
  const wallGlass = o.wallGlass ?? true;
  const stair = o.stair ?? 'stone_brick_stairs';
  const cells = new Map<string, string>();
  const put = (x: number, y: number, z: number, java: string) => cells.set(`${x},${y},${z}`, java);
  const gate = Math.floor(W / 2);
  // the curtain wall
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < D; z++) {
      if (!(x < T || x >= W - T || z < T || z >= D - T)) continue;
      for (let y = 0; y < WH; y++) {
        if (z >= D - T && x >= gate - 1 && x <= gate + 1 && y <= 2) continue; // the gate
        const ns = (z < T || z >= D - T) && x >= T && x <= W - T - 1 && x % 8 === 4;
        const ew = (x < T || x >= W - T) && z >= T && z <= D - T - 1 && z % 8 === 4;
        put(x, y, z, wallGlass && (ns || ew) && (y === 3 || y === 4) ? 'glass' : 'stone_bricks');
      }
      if ((x === 0 || x === W - 1 || z === 0 || z === D - 1) && (x + z) % 2 === 0) put(x, WH, z, 'stone_bricks');
    }
  }
  // the house
  const [x0, x1, z0, z1] = o.house ?? [6, 26, 6, 20];
  const hh = o.houseH ?? 8;
  const door = Math.floor((x0 + x1) / 2);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) put(x, 0, z, o.houseFloor ?? 'stone_bricks');
  for (let y = 1; y <= hh; y++) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const ring = x === x0 || x === x1 || z === z0 || z === z1;
        if (!ring) continue;
        const corner = (x === x0 || x === x1) && (z === z0 || z === z1);
        if (z === z1 && x === door && y <= 2) continue; // the doorway
        const win = y >= 3 && y <= 5 && !corner && (((z === z0 || z === z1) && (x - x0) % 4 === 2) || ((x === x0 || x === x1) && (z - z0) % 4 === 2));
        put(x, y, z, corner ? 'oak_log[axis=y]' : win ? 'glass' : 'oak_planks');
      }
    }
  }
  // the roof: stairs climbing from both long sides, the gables of planks, a ridge of slabs
  const steps = Math.floor((z1 - z0) / 2);
  for (let k = 0; k < steps; k++) {
    const y = hh + 1 + k;
    for (let x = x0; x <= x1; x++) {
      put(x, y, z0 + k, 'oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]');
      put(x, y, z1 - k, 'oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]');
    }
    for (let z = z0 + k + 1; z <= z1 - k - 1; z++) {
      put(x0, y, z, 'oak_planks');
      put(x1, y, z, 'oak_planks');
    }
  }
  if ((z1 - z0) % 2 === 0) for (let x = x0; x <= x1; x++) put(x, hh + 1 + steps, z0 + steps, 'oak_slab[type=bottom,waterlogged=false]');
  // the tower
  if (o.tower ?? true) {
    for (let y = 0; y < H; y++) {
      for (let x = 34; x <= 42; x++) {
        for (let z = 8; z <= 16; z++) {
          if (!(x === 34 || x === 42 || z === 8 || z === 16)) continue;
          const win = y % 5 === 2 && (x === 38 || z === 12);
          put(x, y, z, win ? 'glass' : 'stone_bricks');
        }
      }
    }
  }
  // the staircase up the inside of the west wall, climbing north to its top
  for (let i = 0; i < WH; i++) {
    for (const x of [T, T + 1]) {
      for (let y = 0; y < i; y++) put(x, y, D - T - 2 - i, 'stone_bricks');
      put(x, i, D - T - 2 - i, `${stair}[facing=north,half=bottom,shape=straight,waterlogged=false]`);
    }
  }
  return [...cells].map(([k, java]) => {
    const [x, y, z] = k.split(',').map(Number) as [number, number, number];
    return { pos: { x, y, z }, java: `minecraft:${java}` };
  });
}
