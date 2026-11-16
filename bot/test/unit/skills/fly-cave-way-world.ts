// Track F17: the hook cave of the windows beside the walk (docs/flight.md "Windows beside the walk (Track F17)"), built
// from the same boxes offline (withBoxes over the flat ground: scripts/way-window-bench.ts --hook) and on the server
// (truth:fill, the stone hull then the air: test/e2e/fly-cave-way.test.ts). Shaped as the owner's cave was found to be
// round a trip's landing at its mouth, with no coordinate of it: a start on the flat ground, a stone mesa 7 high to its
// +x (no landing on it: its edge is a fall that hurts) with its mouth MOUTH_OUT blocks out on the mesa's far (+x) side,
// a passage 2 high LOW long in (towards -x: no takeoff, and the drawn way in stops there as it does in the corridor
// world's low section), a 3 x 3 bore LEG long, a bend to +z, SEP blocks of 3 x 3 across, a bend back to +x, a 3 x 3 bore
// back to a 9 x 9 x 5 chamber round the goal. The goal is about 34 blocks from the mouth in a straight line and about
// 160 on foot (the owner's: 38 to 78 and 76 to 166), and about 230 from the start (past `flyMin` 200), so a `!goto` from
// the start flies over the mesa to the mouth, lands, and walks the rest. (The cave winds back towards the start: a body
// holding over the goal on its way in has the whole cave in its loaded chunks, which the landing search's walk flood
// needs to find the mouth; turned the other way the flood stopped in the bore back.)
import { flatWorld, withBoxes, type BlockBox } from '../../../src/skills/input/index.ts';
import type { Vec3 } from '../../../src/world/types.ts';

export const F = -60;
export const MOUTH_OUT = 260;
export const LOW = 16;
export const LEG = 72;
export const SEP = 14;
/** The chamber's centre, blocks in from the mouth along x. */
export const CHAMBER_IN = 30;

export interface HookWorld {
  /** The start's feet cell (on the flat ground), the mouth's plane (the first column of the low passage), the goal. */
  start: Vec3;
  mouthX: number;
  goal: Vec3;
  /** The chamber's air (feet cells x and z, inclusive). */
  chamber: { x0: number; x1: number; z0: number; z1: number };
  /** The mesa (x and z, inclusive). */
  mesa: { x0: number; x1: number; z0: number; z1: number };
  /** The fills in order (the stone hull, then the air); `solidAt` is the same world offline. */
  fills: { from: Vec3; to: Vec3; block: 'stone' | 'air' }[];
  solidAt(x: number, y: number, z: number): boolean;
  /** The walk's centre line from the cell before the mouth to the goal (feet cells, one a block). */
  line: Vec3[];
  /** The line along the hook's inner side (the bores' side rows nearer the chamber), as the e2e's landing probe walked it. */
  inner: Vec3[];
}

/** The hook cave at `origin` (the start's feet cell, feet y F). */
export function hookWorld(origin: { x: number; z: number }): HookWorld {
  const ox = Math.floor(origin.x);
  const oz = Math.floor(origin.z);
  const M = ox + MOUTH_OUT; // the mouth's column (the low passage's first, from outside)
  const a0 = M - LOW; // the bore in's first column
  const a1 = a0 - LEG + 1; // its last (the far end)
  const zb = oz + SEP; // the bore back's centre row
  const cx = M - CHAMBER_IN;
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({ from: { x: Math.min(x0, x1), y: y0, z: z0 }, to: { x: Math.max(x0, x1), y: y1, z: z1 } });
  const mesa = { x0: a1 - 2, x1: M, z0: oz - 3, z1: zb + 6 };
  const hull = box(mesa.x0, F, mesa.z0, mesa.x1, F + 6, mesa.z1);
  const air = [
    box(M, F, oz - 1, a0 + 1, F + 1, oz + 1), // the low passage
    box(a0, F, oz - 1, a1, F + 2, oz + 1), // the bore in
    box(a1, F, oz - 1, a1 + 2, F + 2, zb + 1), // across
    box(a1, F, zb - 1, cx - 5, F + 2, zb + 1), // the bore back
    box(cx - 4, F, zb - 4, cx + 4, F + 4, zb + 4), // the chamber
  ];
  const fills = [{ ...hull, block: 'stone' as const }, ...air.map((b) => ({ ...b, block: 'air' as const }))];
  const boxes: BlockBox[] = fills.map((f) => ({ from: f.from, to: f.to, solid: f.block === 'stone' }));
  const world = withBoxes(flatWorld(), boxes);
  const solidAt = (x: number, y: number, z: number): boolean => world.solidAt(x, y, z) === true;
  const line: Vec3[] = [];
  for (let x = M + 1; x >= a1 + 1; x--) line.push({ x, y: F, z: oz });
  for (let z = oz + 1; z <= zb; z++) line.push({ x: a1 + 1, y: F, z });
  for (let x = a1 + 2; x <= cx; x++) line.push({ x, y: F, z: zb });
  const inner: Vec3[] = [];
  for (let x = M + 1; x >= a1 + 2; x--) inner.push({ x, y: F, z: oz + 1 });
  for (let z = oz + 2; z <= zb - 1; z++) inner.push({ x: a1 + 2, y: F, z });
  for (let x = a1 + 3; x < cx; x++) inner.push({ x, y: F, z: zb - 1 });
  inner.push({ x: cx, y: F, z: zb });
  return { start: { x: ox, y: F, z: oz }, mouthX: M, goal: { x: cx, y: F, z: zb }, chamber: { x0: cx - 4, x1: cx + 4, z0: zb - 4, z1: zb + 4 }, mesa, fills, solidAt, line, inner };
}
