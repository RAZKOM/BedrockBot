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

/** A fill with Bedrock block states for the console `fill` (`["weirdo_direction"=2]`). */
export interface StateFill extends Fill {
  states?: string;
}

/**
 * Stairs suite (docs/pathfinding.md "Stairs and partial blocks"), lanes along +z:
 *   x + 1..3   6 oak stairs up (weirdo_direction 2: low half north, the walker comes from -z), landing feet -54
 *   x + 7..9   the same, facing away (weirdo_direction 3: the walker meets the high half first)
 *   x + 13..15 6 full-block steps (the jump comparison)
 *   x + 20     a 1-wide lane between 2-high walls: carpet, farmland, dirt path, 3 snow layers, slab, 2 snow layers, slab
 * Stairs and snow layers go through the console (`stateFills`, after `layout`).
 */
export function stairsLayout(o: Origin) {
  const fills: Fill[] = [...clear(o.x - 4, o.z - 4, o.x + 30, o.z + 30, -45)];
  const stateFills: StateFill[] = [];
  const sf = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string, states?: string): StateFill => ({ ...f(x1, y1, z1, x2, y2, z2, block), ...(states ? { states } : {}) });
  for (const [x0, dir] of [
    [o.x + 1, 2],
    [o.x + 7, 3],
  ] as const) {
    for (let i = 0; i < 6; i++) {
      if (i > 0) fills.push(f(x0, -60, o.z + 4 + i, x0 + 2, -61 + i, o.z + 4 + i, 'stone'));
      stateFills.push(sf(x0, -60 + i, o.z + 4 + i, x0 + 2, -60 + i, o.z + 4 + i, 'oak_stairs', `["weirdo_direction"=${dir}]`));
    }
    fills.push(f(x0, -60, o.z + 10, x0 + 2, -55, o.z + 13, 'stone'));
  }
  for (let i = 0; i < 6; i++) fills.push(f(o.x + 13, -60, o.z + 4 + i, o.x + 15, -60 + i, o.z + 4 + i, 'stone'));
  fills.push(f(o.x + 13, -60, o.z + 10, o.x + 15, -55, o.z + 13, 'stone'));
  // partial blocks lane at x + 20, walls at x + 19 and x + 21 (z + 2 .. z + 12)
  const lx = o.x + 20;
  fills.push(f(lx - 1, -60, o.z + 2, lx - 1, -59, o.z + 12, 'stone'));
  fills.push(f(lx + 1, -60, o.z + 2, lx + 1, -59, o.z + 12, 'stone'));
  fills.push(f(lx, -60, o.z + 3, lx, -60, o.z + 3, 'white_carpet'));
  fills.push(f(lx, -61, o.z + 4, lx, -61, o.z + 4, 'farmland'));
  fills.push(f(lx, -61, o.z + 5, lx, -61, o.z + 5, 'grass_path'));
  fills.push(f(lx, -60, o.z + 7, lx, -60, o.z + 7, 'smooth_stone_slab'));
  fills.push(f(lx, -60, o.z + 9, lx, -60, o.z + 9, 'smooth_stone_slab'));
  stateFills.push(sf(lx, -60, o.z + 6, lx, -60, o.z + 6, 'snow_layer', '["height"=3]'));
  stateFills.push(sf(lx, -60, o.z + 8, lx, -60, o.z + 8, 'snow_layer', '["height"=1]'));
  // Realm shape (2026-10-29 home return): 3 oak stairs up to a 3-high platform (x + 24..28), feet -57
  fills.push(f(o.x + 24, -60, o.z + 7, o.x + 28, -58, o.z + 12, 'stone'));
  for (let i = 0; i < 3; i++) {
    if (i > 0) fills.push(f(o.x + 25, -60, o.z + 4 + i, o.x + 27, -61 + i, o.z + 4 + i, 'stone'));
    stateFills.unshift(sf(o.x + 25, -60 + i, o.z + 4 + i, o.x + 27, -60 + i, o.z + 4 + i, 'oak_stairs', '["weirdo_direction"=2]'));
  }
  // The owner's house (Realm home return, 2026-10-29): a staircase along +x at z + 20 rising 2 levels
  // over 4 cells (stairs, 1-high landing, stairs on a block, the platform), a room on the platform
  // (2-high walls) with a wooden door in its west wall around the corner from the top of the stairs,
  // the goal 4 cells past the door, the start east of a 2-high wall (the way is around it).
  const hx = o.x + 6;
  const hz = o.z + 20;
  fills.push(f(hx + 1, -60, hz, hx + 2, -60, hz, 'stone')); // landing (feet -59) and the block under the second stairs
  fills.push(f(hx + 3, -60, hz, hx + 9, -59, hz + 5, 'stone')); // platform, feet -58
  fills.push(f(hx + 4, -58, hz, hx + 9, -57, hz, 'stone'));
  fills.push(f(hx + 4, -58, hz + 5, hx + 9, -57, hz + 5, 'stone'));
  fills.push(f(hx + 4, -58, hz, hx + 4, -57, hz + 5, 'stone'));
  fills.push(f(hx + 9, -58, hz, hx + 9, -57, hz + 5, 'stone'));
  fills.push(f(hx + 4, -58, hz + 2, hx + 4, -57, hz + 2, 'air')); // the doorway
  fills.push(f(hx + 11, -60, hz - 3, hx + 11, -59, hz + 8, 'stone')); // the wall east of the house
  stateFills.unshift(
    sf(hx, -60, hz, hx, -60, hz, 'oak_stairs', '["weirdo_direction"=0]'),
    sf(hx + 2, -59, hz, hx + 2, -59, hz, 'oak_stairs', '["weirdo_direction"=0]'),
    sf(hx + 4, -58, hz + 2, hx + 4, -58, hz + 2, 'wooden_door', '["minecraft:cardinal_direction"="south","upper_block_bit"=false,"open_bit"=false]'),
    sf(hx + 4, -57, hz + 2, hx + 4, -57, hz + 2, 'wooden_door', '["minecraft:cardinal_direction"="south","upper_block_bit"=true]'),
  );
  const layout: Layout = { name: 'stairs', anchor: { x: o.x + 12.5, y: -60, z: o.z + 8.5 }, fills };
  const lane = (x: number) => ({ bottom: { x: x + 0.5, y: -60, z: o.z + 0.5 }, top: { x, y: -54, z: o.z + 11 } });
  return {
    layout,
    stateFills,
    /** Restores the flat world (grass at -61, air above). */
    cleanup: clear(o.x - 4, o.z - 4, o.x + 30, o.z + 30, -45),
    stairs: { ...lane(o.x + 2), topStart: { x: o.x + 2.5, y: -54, z: o.z + 11.5 }, bottomGoal: { x: o.x + 2, y: -60, z: o.z + 1 } },
    away: lane(o.x + 8),
    blocks: lane(o.x + 14),
    /** 3 stairs to a platform: start on the low side, goal on the platform (feet -57). */
    realm: { start: { x: o.x + 26.5, y: -60, z: o.z + 0.5 }, goal: { x: o.x + 26, y: -57, z: o.z + 10 } },
    /** The owner's house: start east of the wall, goal inside the room 4 cells past the door. */
    house: { start: { x: hx + 14.5, y: -60, z: hz + 2.5 }, goal: { x: hx + 8, y: -58, z: hz + 2 }, door: { x: hx + 4, y: -58, z: hz + 2 } },
    partial: { start: { x: lx + 0.5, y: -60, z: o.z + 0.5 }, goal: { x: lx, y: -60, z: o.z + 13 } },
    starts: {
      /** On the low half of the third stairs block (cell y -58, low half top -57.5 at z + 6.0 .. 6.5). */
      stairLow: { x: o.x + 2.5, y: -57.5, z: o.z + 6.25 },
      stairGoal: { x: o.x + 5, y: -60, z: o.z },
      slab: { x: lx + 0.5, y: -59.5, z: o.z + 7.5 },
      slabGoal: { x: o.x + 26, y: -60, z: o.z + 20 },
    },
    probe: {
      stairs: { x: o.x + 2, y: -58, z: o.z + 6 },
      stairsAway: { x: o.x + 8, y: -58, z: o.z + 6 },
      farmland: { x: lx, y: -61, z: o.z + 4 },
      dirtPath: { x: lx, y: -61, z: o.z + 5 },
      snow3: { x: lx, y: -60, z: o.z + 6 },
      slab: { x: lx, y: -60, z: o.z + 7 },
      snow2: { x: lx, y: -60, z: o.z + 8 },
    },
  };
}

// ---- Track BB: the shared movement rules (docs/pathfinding.md "Rules") ------------------------------

/**
 * Rules suite (bds-bari): six 3-wide corridors along +z (2-high walls, caps at both ends, 20 long), one per
 * rule, 10 blocks apart in x. The closed lanes (2, 3) have stone brick walls: a built block the rules never
 * dig, so the only way through is the barrier (plain stone walls were dug through: 4 x 162 ticks beat a
 * refused barrier in the first run):
 *   lane 0  a magma strip across two of the three floor columns (the third keeps grass): walked around
 *   lane 1  a line of sweet berry bushes across two columns: walked around
 *   lane 2  a 2-high ice barrier over a lava pool (stone between: ice next to lava melts on BDS, light 15)
 *           closing the corridor: never dug (unreachable with allowBreak)
 *   lane 3  a 2-high dirt barrier with gravel on top closing the corridor: not dug; without the gravel dug
 *   lane 4  a 3-long soul sand floor across the corridor (`soul.fill`, placed by the test after a plain walk)
 *   lane 5  bottom slabs, then a stairs step up onto a stone floor (walls 3 high there): walked, no jump
 * The stairs go through the console (`stateFills`).
 */
export function rulesLayout(o: Origin) {
  const L = 20;
  const fills: Fill[] = [...clear(o.x - 4, o.z - 4, o.x + 56, o.z + L + 4, -45)];
  const stateFills: StateFill[] = [];
  const lane = (i: number, wallTop = -59, wall = 'stone') => {
    const lx = o.x + 10 * i;
    fills.push(f(lx - 2, -60, o.z, lx - 2, wallTop, o.z + L, wall));
    fills.push(f(lx + 2, -60, o.z, lx + 2, wallTop, o.z + L, wall));
    fills.push(f(lx - 2, -60, o.z - 1, lx + 2, wallTop, o.z - 1, wall));
    fills.push(f(lx - 2, -60, o.z + L + 1, lx + 2, wallTop, o.z + L + 1, wall));
    return { x: lx, start: { x: lx + 0.5, y: -60, z: o.z + 1.5 }, goal: { x: lx, y: -60, z: o.z + L - 2 } };
  };
  const magma = lane(0);
  fills.push(f(magma.x - 1, -61, o.z + 10, magma.x, -61, o.z + 10, 'magma'));
  const bush = lane(1);
  fills.push(f(bush.x, -60, o.z + 10, bush.x + 1, -60, o.z + 10, 'sweet_berry_bush'));
  const ice = lane(2, -59, 'stone_bricks');
  fills.push(f(ice.x - 1, -62, o.z + 10, ice.x + 1, -62, o.z + 10, 'lava'));
  fills.push(f(ice.x - 1, -61, o.z + 10, ice.x + 1, -61, o.z + 10, 'stone'));
  fills.push(f(ice.x - 1, -60, o.z + 10, ice.x + 1, -59, o.z + 10, 'ice'));
  const gravel = lane(3, -59, 'stone_bricks');
  fills.push(f(gravel.x - 1, -60, o.z + 10, gravel.x + 1, -59, o.z + 10, 'dirt'));
  fills.push(f(gravel.x - 1, -58, o.z + 10, gravel.x + 1, -58, o.z + 10, 'gravel'));
  const soul = lane(4);
  const soulFill = f(soul.x - 1, -61, o.z + 8, soul.x + 1, -61, o.z + 10, 'soul_sand');
  const slabs = lane(5, -58);
  fills.push(f(slabs.x - 1, -60, o.z + 4, slabs.x + 1, -60, o.z + 7, 'smooth_stone_slab'));
  fills.push(f(slabs.x - 1, -60, o.z + 10, slabs.x + 1, -60, o.z + 16, 'stone'));
  stateFills.push({ ...f(slabs.x - 1, -60, o.z + 9, slabs.x + 1, -60, o.z + 9, 'oak_stairs'), states: '["weirdo_direction"=2]' });
  const layout: Layout = { name: 'rules', anchor: { x: o.x + 25.5, y: -60, z: o.z + 10.5 }, fills };
  return {
    layout,
    stateFills,
    cleanup: clear(o.x - 4, o.z - 4, o.x + 56, o.z + L + 4, -45),
    magma: { ...magma, strip: { from: { x: magma.x - 1, y: -61, z: o.z + 10 }, to: { x: magma.x, y: -61, z: o.z + 10 } } },
    bush: { ...bush, line: { from: { x: bush.x, y: -60, z: o.z + 10 }, to: { x: bush.x + 1, y: -60, z: o.z + 10 } } },
    ice: { ...ice, barrier: { from: { x: ice.x - 1, y: -60, z: o.z + 10 }, to: { x: ice.x + 1, y: -59, z: o.z + 10 } }, lava: { from: { x: ice.x - 1, y: -62, z: o.z + 10 }, to: { x: ice.x + 1, y: -62, z: o.z + 10 } } },
    gravel: { ...gravel, barrier: { from: { x: gravel.x - 1, y: -60, z: o.z + 10 }, to: { x: gravel.x + 1, y: -59, z: o.z + 10 } }, top: { from: { x: gravel.x - 1, y: -58, z: o.z + 10 }, to: { x: gravel.x + 1, y: -58, z: o.z + 10 } } },
    soul: { ...soul, fill: soulFill },
    slabs: { ...slabs, goal: { x: slabs.x, y: -59, z: o.z + 15 }, stairsZ: o.z + 9 },
  };
}
