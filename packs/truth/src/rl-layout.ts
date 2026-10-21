// Pure arena generator for `rl:reset` (PLAN.md task 6.1 and section 9 "Reset"). No @minecraft/server
// imports: the pack executes the ops (rl.ts), the unit tests simulate them.
//
// An arena is a square of grass on the flat world (floor y -61, feet y -60) around an origin column,
// fenced by a 4-high barrier ring, with seeded oak trees (persistent leaves, so nothing decays and
// the block checksum of a seed never changes). The same (scenario, seed) always yields the same ops,
// hence the same blocks; `planChecksum` is the truth:checksum of the arena box after building.
import { Fnv1a, type Vec3 } from './protocol.js';

/** Grass top of the flat world. */
export const FLOOR_Y = -61;
/** Feet height on the floor. */
export const FEET_Y = FLOOR_Y + 1;
/** Lowest y of the arena box (two dirt layers under the grass; bedrock at -64 stays untouched). */
export const BOX_MIN_Y = FLOOR_Y - 2;
/** Air above the floor up to and including FEET_Y + AIR_HEIGHT - 1. */
export const AIR_HEIGHT = 12;
/** Height of the barrier ring. */
export const WALL_HEIGHT = 4;

export const LEAVES = 'minecraft:oak_leaves';
export const LOG = 'minecraft:oak_log';

export interface ScenarioDef {
  name: string;
  /** Interior is x in [ox - half, ox + half - 1] (same for z); the wall ring sits just outside. */
  half: number;
  /** Tree count range (inclusive). */
  trees: [number, number];
  /** Trunk height range (inclusive). */
  trunk: [number, number];
  /** Min Chebyshev distance between two trunks. */
  spacing: number;
  /** Min Chebyshev distance of a trunk from the start column. */
  startClear: number;
  /** Max Chebyshev distance of a trunk from the start column (single_tree); default unlimited. */
  startMax?: number;
  /** Item given into hotbar slot 0. */
  tool: string;
}

export const SCENARIOS: Readonly<Record<string, ScenarioDef>> = {
  forest_small: { name: 'forest_small', half: 12, trees: [6, 9], trunk: [4, 6], spacing: 4, startClear: 3, tool: 'minecraft:stone_axe' },
  forest: { name: 'forest', half: 20, trees: [14, 20], trunk: [4, 6], spacing: 4, startClear: 3, tool: 'minecraft:stone_axe' },
  single_tree: { name: 'single_tree', half: 8, trees: [1, 1], trunk: [4, 6], spacing: 4, startClear: 2, startMax: 4, tool: 'minecraft:stone_axe' },
};

export type Op = { kind: 'fill'; from: Vec3; to: Vec3; block: string } | { kind: 'set'; p: Vec3; block: string };

export interface Tree {
  x: number;
  z: number;
  height: number;
}

export interface ArenaPlan {
  scenario: string;
  seed: number;
  origin: { x: number; z: number };
  /** Box covered by the plan (inclusive): checksum this with truth:checksum. */
  box: { min: Vec3; max: Vec3 };
  /** Feet position of the player at the start, and the yaw it faces (0 = +z). */
  start: Vec3;
  yaw: number;
  tool: string;
  trees: Tree[];
  /** Number of log blocks placed. */
  logs: number;
  ops: Op[];
}

/** mulberry32: small, fast, deterministic PRNG (same as the bot's e2e helpers). */
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

function randInt(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

/** Arena box for a scenario at an origin (walls and floor included). */
export function arenaBox(def: ScenarioDef, ox: number, oz: number): { min: Vec3; max: Vec3 } {
  return {
    min: { x: ox - def.half - 1, y: BOX_MIN_Y, z: oz - def.half - 1 },
    max: { x: ox + def.half, y: FEET_Y + AIR_HEIGHT - 1, z: oz + def.half },
  };
}

export function planArena(scenario: string, seed: number, ox = 0, oz = 0, tool?: string): ArenaPlan {
  const def = SCENARIOS[scenario];
  if (!def) throw new Error(`unknown scenario ${scenario} (${Object.keys(SCENARIOS).join(', ')})`);
  if (!Number.isInteger(seed)) throw new Error(`seed must be an integer: ${seed}`);
  // Mix scenario name into the seed so two scenarios with one seed differ.
  let mixed = seed >>> 0;
  for (let i = 0; i < scenario.length; i++) mixed = Math.imul(mixed ^ scenario.charCodeAt(i), 0x01000193) >>> 0;
  const r = rng(mixed);
  const box = arenaBox(def, ox, oz);
  const h = def.half;
  const ops: Op[] = [];
  // Ground and air.
  ops.push({ kind: 'fill', from: { x: box.min.x, y: BOX_MIN_Y, z: box.min.z }, to: { x: box.max.x, y: FLOOR_Y - 1, z: box.max.z }, block: 'minecraft:dirt' });
  ops.push({ kind: 'fill', from: { x: box.min.x, y: FLOOR_Y, z: box.min.z }, to: { x: box.max.x, y: FLOOR_Y, z: box.max.z }, block: 'minecraft:grass_block' });
  ops.push({ kind: 'fill', from: { x: box.min.x, y: FEET_Y, z: box.min.z }, to: { x: box.max.x, y: box.max.y, z: box.max.z }, block: 'minecraft:air' });
  // Barrier ring (4 sides).
  const wy0 = FEET_Y;
  const wy1 = FEET_Y + WALL_HEIGHT - 1;
  const bar = 'minecraft:barrier';
  ops.push({ kind: 'fill', from: { x: box.min.x, y: wy0, z: box.min.z }, to: { x: box.max.x, y: wy1, z: box.min.z }, block: bar });
  ops.push({ kind: 'fill', from: { x: box.min.x, y: wy0, z: box.max.z }, to: { x: box.max.x, y: wy1, z: box.max.z }, block: bar });
  ops.push({ kind: 'fill', from: { x: box.min.x, y: wy0, z: box.min.z }, to: { x: box.min.x, y: wy1, z: box.max.z }, block: bar });
  ops.push({ kind: 'fill', from: { x: box.max.x, y: wy0, z: box.min.z }, to: { x: box.max.x, y: wy1, z: box.max.z }, block: bar });

  // Trees: rejection sampling inside the interior, 3 blocks off the walls (canopy radius 2).
  const margin = 3;
  const lo = { x: ox - h + margin, z: oz - h + margin };
  const hi = { x: ox + h - 1 - margin, z: oz + h - 1 - margin };
  const want = randInt(r, def.trees[0], def.trees[1]);
  const trees: Tree[] = [];
  for (let attempt = 0; attempt < 500 && trees.length < want; attempt++) {
    const x = randInt(r, lo.x, hi.x);
    const z = randInt(r, lo.z, hi.z);
    const dStart = Math.max(Math.abs(x - ox), Math.abs(z - oz));
    if (dStart < def.startClear) continue;
    if (def.startMax !== undefined && dStart > def.startMax) continue;
    if (trees.some((t) => Math.max(Math.abs(t.x - x), Math.abs(t.z - z)) < def.spacing)) continue;
    trees.push({ x, z, height: randInt(r, def.trunk[0], def.trunk[1]) });
  }
  let logs = 0;
  for (const t of trees) {
    const top = FEET_Y + t.height - 1;
    // Canopy: two 5x5 layers (corners trimmed at random), one 3x3 layer at the top log, a plus above.
    for (const dy of [-2, -1]) {
      const y = top + dy;
      ops.push({ kind: 'fill', from: { x: t.x - 2, y, z: t.z - 2 }, to: { x: t.x + 2, y, z: t.z + 2 }, block: LEAVES });
      for (const [cx, cz] of [
        [-2, -2],
        [-2, 2],
        [2, -2],
        [2, 2],
      ] as const) {
        if (r() < 0.5) ops.push({ kind: 'set', p: { x: t.x + cx, y, z: t.z + cz }, block: 'minecraft:air' });
      }
    }
    ops.push({ kind: 'fill', from: { x: t.x - 1, y: top, z: t.z - 1 }, to: { x: t.x + 1, y: top, z: t.z + 1 }, block: LEAVES });
    for (const [dx, dz] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      ops.push({ kind: 'set', p: { x: t.x + dx, y: top + 1, z: t.z + dz }, block: LEAVES });
    }
    ops.push({ kind: 'fill', from: { x: t.x, y: FEET_Y, z: t.z }, to: { x: t.x, y: top, z: t.z }, block: LOG });
    // Dirt under the trunk, as vanilla trees have: grass under an opaque block turns into dirt on a
    // random tick, which would change the arena's checksum a while after the reset.
    ops.push({ kind: 'set', p: { x: t.x, y: FLOOR_Y, z: t.z }, block: 'minecraft:dirt' });
    logs += t.height;
  }
  return {
    scenario,
    seed,
    origin: { x: ox, z: oz },
    box,
    start: { x: ox + 0.5, y: FEET_Y, z: oz + 0.5 },
    yaw: 0,
    tool: tool ?? def.tool,
    trees,
    logs,
    ops,
  };
}

/** Runs the ops on an in-memory copy of the box and returns its blocks in canonical y, z, x order. */
export function simulate(plan: ArenaPlan, outside: (p: Vec3) => string = () => 'minecraft:air'): string[] {
  const { min, max } = plan.box;
  const sx = max.x - min.x + 1;
  const sy = max.y - min.y + 1;
  const sz = max.z - min.z + 1;
  const grid: string[] = new Array<string>(sx * sy * sz);
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) grid[(y * sz + z) * sx + x] = outside({ x: min.x + x, y: min.y + y, z: min.z + z });
  const put = (x: number, y: number, z: number, b: string) => {
    if (x < min.x || x > max.x || y < min.y || y > max.y || z < min.z || z > max.z) return;
    grid[((y - min.y) * sz + (z - min.z)) * sx + (x - min.x)] = b;
  };
  for (const op of plan.ops) {
    if (op.kind === 'set') {
      put(op.p.x, op.p.y, op.p.z, op.block);
    } else {
      for (let y = op.from.y; y <= op.to.y; y++) for (let z = op.from.z; z <= op.to.z; z++) for (let x = op.from.x; x <= op.to.x; x++) put(x, y, z, op.block);
    }
  }
  return grid;
}

/** truth:checksum of the arena box once the plan is built (FNV-1a over typeIds, canonical order). */
export function planChecksum(plan: ArenaPlan): string {
  const f = new Fnv1a();
  for (const id of simulate(plan)) f.update(id);
  return f.hex();
}

/** Parses `key=value` tokens after the positional args (`origin=x,z`, `tool=id`, `player=name`). */
export function parseOptions(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq <= 0) throw new Error(`expected key=value, got ${t}`);
    out[t.slice(0, eq).toLowerCase()] = t.slice(eq + 1);
  }
  return out;
}
