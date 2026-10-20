// Test terrain for the movement / pathfinding e2e tests, built on the bds-move flat world (grass top
// y = -61, feet -60) with truth:fill, so every run starts from identical blocks. Each layout has its
// own area; `build*` first clears the area (air above the ground, grass floor), then places blocks.
// The truth pack can only edit chunks near a player, so callers teleport the bot into the area first
// (bds-move runs with tick-distance 10, about 160 blocks).
import type { Vec3 } from '../../src/world/types.ts';

export interface Fill {
  from: Vec3;
  to: Vec3;
  block: string;
}

export interface Layout {
  name: string;
  /** Where to stand while building (inside the truth pack's loaded area). */
  anchor: Vec3;
  fills: Fill[];
}

const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({
  from: { x: x1, y: y1, z: z1 },
  to: { x: x2, y: y2, z: z2 },
  block,
});

/** Air from feet level up to `top`, grass at y -61, dirt below the grass (repairs dug pools). */
function clear(x1: number, z1: number, x2: number, z2: number, top = -40): Fill[] {
  return [f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, top, z2, 'air')];
}

// ---- flat (task 3.3) ---------------------------------------------------------------------------

/** 73 x 73 flat area centred on (0, 0). Random goals within 30 blocks of the centre. */
export const FLAT: Layout = { name: 'flat', anchor: { x: 0.5, y: -60, z: 0.5 }, fills: clear(-36, -36, 36, 36, -50) };

// ---- hill (task 3.4) ---------------------------------------------------------------------------

/** Hill area: x 60..100, z -20..30. */
export const HILL = {
  /** Start in front of the staircase, facing +z. */
  stairsStart: { x: 71.5, y: -60, z: 1.5 },
  /** On the top platform (feet -50). */
  top: { x: 71, y: -50, z: 16 },
  /** Ledge 1 (feet -53, a 3-block drop east of the platform), ledge 2 (feet -56), ledge 3 (feet -59). */
  ledge1: { x: 74, y: -53, z: 16 },
  ledge2: { x: 77, y: -56, z: 16 },
  ledge3: { x: 80, y: -59, z: 16 },
  /** Water pool x 85..89, z 0..4 (2 deep); lava pool x 85..89, z 8..10. */
  poolStart: { x: 87.5, y: -60, z: -3.5 },
  poolGoal: { x: 87, y: -60, z: 13 },
  inWater: { x: 87, y: -61, z: 2 },
  /** Bottom-slab staircase along +z at x 93..95: feet -60 -> -59.5 -> -59 -> -58.5 -> -58. */
  slabStart: { x: 94.5, y: -60, z: 1.5 },
  slabTop: { x: 94, y: -58, z: 10 },
};

function hillFills(): Fill[] {
  const out = clear(60, -20, 100, 30);
  for (let i = 0; i < 10; i++) out.push(f(70, -60, 5 + i, 72, -60 + i, 5 + i, 'stone'));
  out.push(f(70, -60, 15, 72, -51, 18, 'stone')); // top platform, feet -50
  out.push(f(73, -60, 15, 75, -54, 18, 'stone')); // ledge 1, feet -53
  out.push(f(76, -60, 15, 78, -57, 18, 'stone')); // ledge 2, feet -56
  out.push(f(79, -60, 15, 81, -60, 18, 'stone')); // ledge 3, feet -59
  out.push(f(85, -62, 0, 89, -61, 4, 'water'));
  out.push(f(85, -61, 8, 89, -61, 10, 'lava'));
  // slab staircase
  out.push(f(93, -60, 5, 95, -60, 5, 'smooth_stone_slab'));
  out.push(f(93, -60, 6, 95, -60, 12, 'stone'));
  out.push(f(93, -59, 7, 95, -59, 7, 'smooth_stone_slab'));
  out.push(f(93, -59, 8, 95, -59, 12, 'stone'));
  return out;
}

export const HILL_LAYOUT: Layout = { name: 'hill', anchor: { x: 80.5, y: -60, z: 5.5 }, fills: hillFills() };

// ---- long hills course (task 3.5 e2e: a 100-block goal over hills) -----------------------------

export const LONG = { start: { x: -50.5, y: -60, z: 76.5 }, goal: { x: 50, y: -60, z: 76 } };

function longFills(): Fill[] {
  const out = clear(-56, 66, 56, 86);
  const z1 = 70;
  const z2 = 82;
  // hill A: 1-block steps up to feet -56, plateau, then 3-block drop to a 1-high ledge
  for (let i = 0; i < 4; i++) out.push(f(-40 + i, -60, z1, -40 + i, -60 + i, z2, 'stone'));
  out.push(f(-36, -60, z1, -30, -57, z2, 'stone'));
  out.push(f(-29, -60, z1, -28, -60, z2, 'stone'));
  // hill B: slab staircase up to feet -57, plateau, 3-block drop to the ground
  out.push(f(-20, -60, z1, -20, -60, z2, 'smooth_stone_slab'));
  out.push(f(-19, -60, z1, -10, -60, z2, 'stone'));
  out.push(f(-18, -59, z1, -18, -59, z2, 'smooth_stone_slab'));
  out.push(f(-17, -59, z1, -10, -59, z2, 'stone'));
  out.push(f(-16, -58, z1, -16, -58, z2, 'smooth_stone_slab'));
  out.push(f(-15, -58, z1, -10, -58, z2, 'stone'));
  // water ditch across the course, a 1-wide bridge at z 82
  out.push(f(0, -62, z1 - 4, 1, -61, z2 - 1, 'water'));
  // 3-high wall across, a gap at z 81..82
  out.push(f(10, -60, z1 - 4, 10, -58, 80, 'stone'));
  // stepped mound, 4 layers
  for (let k = 0; k < 4; k++) out.push(f(20 + k, -60 + k, z1 + k, 35 - k, -60 + k, z2 - k, 'stone'));
  // two trees
  for (const [tx, tz] of [
    [40, 74],
    [45, 79],
  ] as const) {
    out.push(f(tx - 2, -57, tz - 2, tx + 2, -55, tz + 2, 'oak_leaves'));
    out.push(f(tx, -60, tz, tx, -55, tz, 'oak_log'));
  }
  return out;
}

export const LONG_LAYOUT: Layout = { name: 'long', anchor: { x: 0.5, y: -60, z: 76.5 }, fills: longFills() };

// ---- wall (task 3.6) ----------------------------------------------------------------------------

export const WALL = {
  start: { x: 0.5, y: -60, z: -99.5 },
  goal: { x: 0, y: -60, z: -64 },
  /** The wall placed mid-path once the bot has passed z -92: x -5..5, z -80, 3 high. */
  wall: f(-5, -60, -80, 5, -58, -80, 'stone'),
};

export const WALL_LAYOUT: Layout = { name: 'wall', anchor: { x: 0.5, y: -60, z: -82.5 }, fills: clear(-20, -106, 20, -58) };
