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

// ---- Navigation v2 (tasks 7.1 / 7.2): every run builds in its own random area ----------------------
//
// `privateOrigin()` picks a chunk-aligned origin far from the fixed layouts above (x 2000..10000, z
// -8000..8000) so two runs on one server never share terrain. MOVE_AREA="x,z" pins it (reproduce a run).

export interface Origin {
  x: number;
  z: number;
}

export function privateOrigin(): Origin {
  const pinned = process.env.MOVE_AREA?.split(',').map(Number);
  if (pinned?.length === 2 && pinned.every(Number.isFinite)) return { x: pinned[0]!, z: pinned[1]! };
  return { x: 2048 + 16 * Math.floor(Math.random() * 500), z: -8000 + 16 * Math.floor(Math.random() * 1000) };
}

/** Deterministic PRNG (mulberry32) for the course layouts (MOVE_SEED). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stepped hill across +z (`layers` 1-block terraces) with a 1-wide, 2-high tunnel through it at x = cx. */
function caveHill(cx: number, z0: number, halfWidth: number, length: number, layers: number): Fill[] {
  const out: Fill[] = [];
  for (let k = 0; k < layers; k++) out.push(f(cx - halfWidth + k, -60 + k, z0 + k, cx + halfWidth - k, -60 + k, z0 + length - k, 'stone'));
  out.push(f(cx, -60, z0, cx, -59, z0 + length, 'air'));
  return out;
}

/** Surface suite: a cave hill on the straight line, and a 3-deep pit on the line (separate rows). */
export function surfaceLayout(o: Origin) {
  const cave = {
    start: { x: o.x + 0.5, y: -60, z: o.z - 14.5 },
    goal: { x: o.x, y: -60, z: o.z + 36 },
    /** The tunnel cells (x, z range) at feet -60. */
    tunnel: { x: o.x, z0: o.z, z1: o.z + 20 },
  };
  const px = o.x + 40;
  const pit = {
    start: { x: px + 0.5, y: -60, z: o.z + 0.5 },
    goal: { x: px, y: -60, z: o.z + 20 },
    /** The 3 x 3 pit, 3 deep (feet -63 at the bottom). */
    from: { x: px - 1, z: o.z + 8 },
    to: { x: px + 1, z: o.z + 10 },
  };
  const fills: Fill[] = [...clear(o.x - 32, o.z - 24, o.x + 64, o.z + 44, -50)];
  fills.push(...caveHill(o.x, o.z, 26, 20, 4)); // wide: over the top is cheaper than around
  fills.push(f(pit.from.x, -63, pit.from.z, pit.to.x, -61, pit.to.z, 'air'));
  const layout: Layout = { name: 'surface', anchor: { x: o.x + 20.5, y: -60, z: o.z + 10.5 }, fills };
  return { layout, cave, pit };
}

/** Dig-through suite: a 41-wide, 3-high dirt wall across the line (going around is a long detour). */
export function digLayout(o: Origin) {
  const wall = f(o.x - 20, -60, o.z + 10, o.x + 20, -58, o.z + 10, 'dirt');
  const layout: Layout = { name: 'dig', anchor: { x: o.x + 0.5, y: -60, z: o.z + 4.5 }, fills: [...clear(o.x - 30, o.z - 6, o.x + 30, o.z + 30, -50), wall] };
  return { layout, wall, start: { x: o.x + 0.5, y: -60, z: o.z + 2.5 }, goal: { x: o.x, y: -60, z: o.z + 18 } };
}

/** Fence suite: a connected oak fence line along +z at x + 1 with a gap, and an L corner at its end. */
export function fenceLayout(o: Origin) {
  const fills: Fill[] = [...clear(o.x - 12, o.z - 6, o.x + 12, o.z + 40, -50)];
  fills.push(f(o.x + 1, -60, o.z, o.x + 1, -60, o.z + 30, 'oak_fence'));
  fills.push(f(o.x - 6, -60, o.z + 31, o.x + 1, -60, o.z + 31, 'oak_fence')); // the corner
  // the gap last: buildLayout waits for the last fill's block, and fences are unknown runtime ids on
  // 1.26.60 (the world model shows them as 'unknown')
  fills.push(f(o.x + 1, -60, o.z + 15, o.x + 1, -60, o.z + 15, 'air'));
  const layout: Layout = { name: 'fence', anchor: { x: o.x + 0.5, y: -60, z: o.z + 15.5 }, fills };
  return {
    layout,
    start: { x: o.x + 0.5, y: -60, z: o.z + 0.5 },
    /** Along the fence (row x), to just before the corner. */
    along: { x: o.x, y: -60, z: o.z + 30 },
    /** Back, through the gap, to the other side. */
    across: { x: o.x + 3, y: -60, z: o.z + 5 },
  };
}

/**
 * The 200-block cross-country course along +x (z band -12..12 around o.z): seeded stepped mounds,
 * a 3-high wall with a gap, a water ditch with a 1-wide bridge, trees, a cave hill with its tunnel on
 * the line, a 3-deep pit on the line, a slab ramp up a 2-high plateau with a 2-block drop off it.
 */
export function crossLayout(o: Origin, seed: number) {
  const r = rng(seed);
  const x0 = o.x - 100;
  const z = o.z;
  const fills: Fill[] = [...clear(x0 - 6, z - 14, o.x + 106, z + 14, -45)];
  const at = (k: number) => x0 + k; // course position -> x
  // slab ramp up a 2-high plateau, 2-block drop off it (k 12..24)
  fills.push(f(at(12), -60, z - 12, at(12), -60, z + 12, 'smooth_stone_slab'));
  fills.push(f(at(13), -60, z - 12, at(24), -60, z + 12, 'stone'));
  fills.push(f(at(14), -59, z - 12, at(14), -59, z + 12, 'smooth_stone_slab'));
  fills.push(f(at(15), -59, z - 12, at(24), -59, z + 12, 'stone'));
  // seeded stepped mounds (k 30..60)
  for (let i = 0; i < 3; i++) {
    const k = 30 + i * 11 + Math.floor(r() * 3);
    const zc = z - 6 + Math.floor(r() * 12);
    const layers = 2 + Math.floor(r() * 3);
    for (let l = 0; l < layers; l++) fills.push(f(at(k + l), -60 + l, zc - 5 + l, at(k + 8 - l), -60 + l, zc + 5 - l, 'stone'));
  }
  // 3-high wall across with a gap (k 66)
  const gap = z - 8 + Math.floor(r() * 16);
  fills.push(f(at(66), -60, z - 12, at(66), -58, z + 12, 'stone'));
  fills.push(f(at(66), -60, gap, at(66), -58, gap + 1, 'air'));
  // water ditch 2 wide, 2 deep (k 76..77) with a 1-wide bridge
  const bridge = z - 8 + Math.floor(r() * 16);
  fills.push(f(at(76), -62, z - 12, at(77), -61, z + 12, 'water'));
  fills.push(f(at(76), -62, bridge, at(77), -61, bridge, 'stone'));
  // cave hill across the line (k 90..110), tunnel at z
  for (let k = 0; k < 4; k++) fills.push(f(at(90) + k, -60 + k, z - 10 + k, at(110) - k, -60 + k, z + 10 - k, 'stone'));
  fills.push(f(at(90), -60, z, at(110), -59, z, 'air'));
  // 3-deep pit on the line (k 125..127)
  fills.push(f(at(125), -63, z - 1, at(127), -61, z + 1, 'air'));
  // trees (k 140..175)
  for (let i = 0; i < 4; i++) {
    const tx = at(140 + i * 9 + Math.floor(r() * 4));
    const tz = z - 9 + Math.floor(r() * 18);
    fills.push(f(tx - 2, -57, tz - 2, tx + 2, -55, tz + 2, 'oak_leaves'));
    fills.push(f(tx, -60, tz, tx, -55, tz, 'oak_log'));
  }
  // a last 1-block step and a short slab staircase (k 185..192)
  fills.push(f(at(185), -60, z - 12, at(192), -60, z + 12, 'stone'));
  fills.push(f(at(188), -59, z - 12, at(188), -59, z + 12, 'smooth_stone_slab'));
  fills.push(f(at(189), -59, z - 12, at(192), -59, z + 12, 'stone'));
  const layout: Layout = { name: 'cross', anchor: { x: o.x + 0.5, y: -60, z: z + 0.5 }, fills };
  return { layout, start: { x: x0 + 0.5, y: -60, z: z + 0.5 }, goal: { x: x0 + 200, y: -60, z }, pit: { x0: at(125), x1: at(127), z0: z - 1, z1: z + 1 } };
}

/** Per-tick body statistics while a goto runs (the nav v2 suites). */
export interface BodyTrack {
  ticks: number;
  minFeet: number;
  /** Ticks on the ground with a roof block above the head (the world model's sky columns). */
  underground: number;
  /** Ticks with a horizontal collision. */
  collided: number;
  wet: number;
  /** Positions, one per tick. */
  path: Vec3[];
  stop(): void;
}

/** Starts tracking the body of `bot` (a MoveBot from move-truth.ts) until `stop()`. */
export function trackBody(bot: {
  loop: { onBeforeStep(fn: (t: bigint, s: { pos: Vec3; onGround: boolean; collidedHorizontally: boolean; inWater: boolean; inLava: boolean }) => void): () => void };
  skills: { nav: { grid: { underground(x: number, z: number, feet: number): boolean } } };
}): BodyTrack {
  const tr: BodyTrack = {
    ticks: 0,
    minFeet: Infinity,
    underground: 0,
    collided: 0,
    wet: 0,
    path: [],
    stop: () => off(),
  };
  const off = bot.loop.onBeforeStep((_t, s) => {
    tr.ticks++;
    tr.minFeet = Math.min(tr.minFeet, s.pos.y);
    if (s.onGround && bot.skills.nav.grid.underground(Math.floor(s.pos.x), Math.floor(s.pos.z), s.pos.y)) tr.underground++;
    if (s.collidedHorizontally) tr.collided++;
    if (s.inWater || s.inLava) tr.wet++;
    tr.path.push({ ...s.pos });
  });
  return tr;
}

/** Pillar / door suite (skipped until Track O's place / use skills are wired). */
export function placeLayout(o: Origin) {
  const fills: Fill[] = [...clear(o.x - 12, o.z - 6, o.x + 12, o.z + 30, -45)];
  // a 4-high plateau (x -2..2, z 8..12)
  fills.push(f(o.x - 2, -60, o.z + 8, o.x + 2, -57, o.z + 12, 'stone'));
  // a 3-deep pit (x 8..10, z 0..2)
  fills.push(f(o.x + 8, -63, o.z, o.x + 10, -61, o.z + 2, 'air'));
  // a closed room x -10..-4, z 16..24 (3-high walls) with the door / gate cell at (x -7, z 24)
  fills.push(f(o.x - 10, -60, o.z + 16, o.x - 4, -58, o.z + 16, 'stone'));
  fills.push(f(o.x - 10, -60, o.z + 24, o.x - 4, -58, o.z + 24, 'stone'));
  fills.push(f(o.x - 10, -60, o.z + 16, o.x - 10, -58, o.z + 24, 'stone'));
  fills.push(f(o.x - 4, -60, o.z + 16, o.x - 4, -58, o.z + 24, 'stone'));
  fills.push(f(o.x - 7, -60, o.z + 24, o.x - 7, -59, o.z + 24, 'air'));
  const layout: Layout = { name: 'place', anchor: { x: o.x + 0.5, y: -60, z: o.z + 10.5 }, fills };
  return {
    layout,
    cliffStart: { x: o.x + 0.5, y: -60, z: o.z + 2.5 },
    cliffTop: { x: o.x, y: -56, z: o.z + 10 },
    pitBottom: { x: o.x + 9.5, y: -63, z: o.z + 1.5 },
    pitOut: { x: o.x + 9, y: -60, z: o.z + 6 },
    roomInside: { x: o.x - 6.5, y: -60, z: o.z + 20.5 },
    roomOutside: { x: o.x - 7, y: -60, z: o.z + 28 },
    door: { x: o.x - 7, y: -60, z: o.z + 24 },
  };
}
