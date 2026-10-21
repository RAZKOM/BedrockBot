// Test terrain for the wood e2e tests (PLAN.md tasks 4.3 to 4.6) on the bds-wood flat world (grass
// top y = -61, feet -60), built with truth:fill / truth:tree / truth:set inside a private run area,
// so every run starts from identical blocks and concurrent runs never share terrain.
//
// Trees are woodShapes.treeShape (packs/truth/src/woodShapes.ts): a log column 4..6 high with a leaf
// canopy from y + h - 2 up to y + h + 1; trunks 4 apart have touching canopies.
import { treeShape } from '../../../packs/truth/src/woodShapes.ts';
import type { Vec3 } from '../../src/world/types.ts';

export const GROUND_Y = -61;
export const FEET_Y = -60;

export interface TreeSpec {
  x: number;
  z: number;
  /** Logs (trunk height). */
  h: number;
  kind: 'oak' | 'birch';
}

export interface WoodLayout {
  name: string;
  /** Clear box: air from FEET_Y to `top`, grass floor, dirt below. */
  from: Vec3;
  to: Vec3;
  trees: TreeSpec[];
  /** Chest block, if any. */
  chest?: Vec3;
  /** Where the bot starts (feet). */
  start: Vec3;
  /** Extra blocks (walls of the chest room). */
  blocks?: { from: Vec3; to: Vec3; block: string }[];
}

/** Deterministic PRNG (mulberry32). */
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

/** Logs of a tree spec (bottom up). */
export function treeLogs(t: TreeSpec): Vec3[] {
  return treeShape(t.x, FEET_Y, t.z, t.h).logs;
}

export function totalLogs(trees: readonly TreeSpec[]): number {
  return trees.reduce((a, t) => a + t.h, 0);
}

/**
 * 4.3 / 4.4: five oak trees (heights 4, 5, 6, 5, 4) around (x0, z0); the 2nd and 3rd stand 4 apart
 * so their canopies touch; the bot starts 6 blocks south of the first.
 */
export function fellForest(x0: number, z0: number): WoodLayout {
  const trees: TreeSpec[] = [
    { x: x0, z: z0, h: 4, kind: 'oak' },
    { x: x0 + 7, z: z0 + 1, h: 5, kind: 'oak' },
    { x: x0 + 11, z: z0 + 1, h: 6, kind: 'oak' }, // canopy touches the previous one
    { x: x0 + 3, z: z0 + 8, h: 5, kind: 'oak' },
    { x: x0 + 10, z: z0 + 9, h: 4, kind: 'oak' },
  ];
  return {
    name: 'fell-forest',
    from: { x: x0 - 8, y: FEET_Y, z: z0 - 10 },
    to: { x: x0 + 19, y: FEET_Y + 10, z: z0 + 17 },
    trees,
    start: { x: x0 + 0.5, y: FEET_Y, z: z0 - 6 + 0.5 },
  };
}

/**
 * 4.5: a 7 x 4 x 7 oak-plank room with an open doorway on the south side and a chest against the
 * north wall; the bot starts in the doorway.
 */
export function chestRoom(x0: number, z0: number): WoodLayout {
  const y = FEET_Y;
  return {
    name: 'chest-room',
    from: { x: x0 - 6, y, z: z0 - 6 },
    to: { x: x0 + 6, y: y + 6, z: z0 + 8 },
    trees: [],
    chest: { x: x0, y, z: z0 - 2 },
    start: { x: x0 + 0.5, y, z: z0 + 3.5 },
    blocks: [
      // walls x0-3..x0+3, z0-3..z0+3, 3 high, roof at y+3
      { from: { x: x0 - 3, y, z: z0 - 3 }, to: { x: x0 + 3, y: y + 3, z: z0 + 3 }, block: 'oak_planks' },
      { from: { x: x0 - 2, y, z: z0 - 2 }, to: { x: x0 + 2, y: y + 2, z: z0 + 2 }, block: 'air' },
      // doorway (2 high) in the south wall
      { from: { x: x0, y, z: z0 + 3 }, to: { x: x0, y: y + 1, z: z0 + 3 }, block: 'air' },
    ],
  };
}

/**
 * 4.6: a forest of `n` trees (mostly oak, every 5th birch, heights 4..6) scattered on a jittered
 * grid around a chest at (x0, z0); a 5 x 5 clearing around the chest. Spacing 5..7 blocks, so some
 * canopies touch. Total logs = sum of the heights (printed by the test).
 */
export function gatherForest(x0: number, z0: number, seed: number, n = 24): WoodLayout {
  const r = rng(seed);
  const trees: TreeSpec[] = [];
  const cells: [number, number][] = [];
  for (let gx = -3; gx <= 3; gx++) for (let gz = -3; gz <= 3; gz++) if (Math.max(Math.abs(gx), Math.abs(gz)) >= 1) cells.push([gx, gz]);
  // closest cells first, so the forest is dense around the chest
  cells.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
  for (const [gx, gz] of cells.slice(0, n)) {
    const x = x0 + gx * 6 + Math.floor(r() * 3) - 1;
    const z = z0 + gz * 6 + Math.floor(r() * 3) - 1;
    trees.push({ x, z, h: 4 + Math.floor(r() * 3), kind: trees.length % 5 === 4 ? 'birch' : 'oak' });
  }
  return {
    name: 'gather-forest',
    from: { x: x0 - 24, y: FEET_Y, z: z0 - 24 },
    to: { x: x0 + 24, y: FEET_Y + 10, z: z0 + 24 },
    trees,
    chest: { x: x0, y: FEET_Y, z: z0 },
    start: { x: x0 + 2.5, y: FEET_Y, z: z0 + 0.5 },
  };
}
