// Track F6 (docs/flight.md "Tight cave flight (Track F6)", ADR 0071): the geodesic distance field the route search's
// heuristic reads in a cave. Track F2's heuristic is the straight-line distance through the remaining goals; in a
// winding passage the straight line runs through rock, so the search climbs towards the wall between it and the
// goal, exhausts the lattice there and comes back partial (F5b: the proof of a window in a 3 to 5 block passage
// almost never completed in 2 s, and the windows were walked). The field is a breadth-first search over the air
// cells of the request's box from every goal (6-connected, one block a step): the distance it gives follows the
// passage round its bends, so the search is pulled along the cave instead of into its walls. One field per goal,
// so the chained heuristic (the way to the next goal, then from goal to goal) keeps its order. Built once per
// request (in the worker, over its snapshot) and dropped with it.
import type { Vec3 } from '../../../connection/types.ts';
import type { RouteGrid } from './grid.ts';
import { goalPoint, landingCells, type RouteGoal } from './types.ts';

/** Blocks round the start and the goals the field covers (outside it the heuristic falls back to the straight line). */
export const FIELD_PAD = 10;
/** The field's largest side (blocks): a request beyond it is clipped to the box round its points. */
export const FIELD_MAX = 192;
/** An unreachable cell's distance. */
const FAR = 0xffff;

export interface DistanceField {
  min: Vec3;
  size: Vec3;
  /** Per goal: the 6-connected block distance of every cell of the box to the goal's cells (FAR: unreachable or solid). */
  dist: Uint16Array[];
  /** Per goal i: the geodesic blocks from goal i on through every later goal (the chained rest; 0 for the last). */
  rest: number[];
  /** The cells reached by all the searches (the effort). */
  cells: number;
  ms: number;
}

/** The field's box for a request: the start and the goals padded by FIELD_PAD, clipped to the grid's bounds when it has them and to FIELD_MAX a side. */
export function fieldBox(grid: RouteGrid, start: Vec3, goals: readonly RouteGoal[]): { min: Vec3; size: Vec3 } {
  const lo = { x: start.x, y: start.y, z: start.z };
  const hi = { x: start.x, y: start.y, z: start.z };
  const take = (p: Vec3): void => {
    lo.x = Math.min(lo.x, p.x);
    lo.y = Math.min(lo.y, p.y);
    lo.z = Math.min(lo.z, p.z);
    hi.x = Math.max(hi.x, p.x);
    hi.y = Math.max(hi.y, p.y);
    hi.z = Math.max(hi.z, p.z);
  };
  for (const g of goals) {
    if (g.kind === 'waypoint') {
      take(g.box.min);
      take(g.box.max);
    } else {
      take(goalPoint(g));
      if (g.via) take(g.via.pos);
    }
  }
  let min = { x: Math.floor(lo.x - FIELD_PAD), y: Math.floor(lo.y - FIELD_PAD), z: Math.floor(lo.z - FIELD_PAD) };
  let max = { x: Math.ceil(hi.x + FIELD_PAD), y: Math.ceil(hi.y + FIELD_PAD), z: Math.ceil(hi.z + FIELD_PAD) };
  const b = grid.bounds;
  if (b) {
    min = { x: Math.max(min.x, b.min.x), y: Math.max(min.y, b.min.y), z: Math.max(min.z, b.min.z) };
    max = { x: Math.min(max.x, b.min.x + b.size.x - 1), y: Math.min(max.y, b.min.y + b.size.y - 1), z: Math.min(max.z, b.min.z + b.size.z - 1) };
  }
  const size = { x: Math.max(1, Math.min(FIELD_MAX, max.x - min.x + 1)), y: Math.max(1, Math.min(FIELD_MAX, max.y - min.y + 1)), z: Math.max(1, Math.min(FIELD_MAX, max.z - min.z + 1)) };
  return { min, size };
}

/** The cells a goal is reached in: a waypoint's box (the cells whose centre lies in it), a landing's air cells over its floor cells. */
function seedsOf(g: RouteGoal): Vec3[] {
  if (g.kind === 'waypoint') {
    const out: Vec3[] = [];
    const x0 = Math.floor(g.box.min.x + 0.5);
    const x1 = Math.ceil(g.box.max.x - 0.5) - 1;
    const y0 = Math.floor(g.box.min.y + 0.5);
    const y1 = Math.ceil(g.box.max.y - 0.5) - 1;
    const z0 = Math.floor(g.box.min.z + 0.5);
    const z1 = Math.ceil(g.box.max.z - 0.5) - 1;
    for (let y = y0; y <= Math.max(y0, y1); y++) for (let z = z0; z <= Math.max(z0, z1); z++) for (let x = x0; x <= Math.max(x0, x1); x++) out.push({ x, y, z });
    return out;
  }
  return landingCells(g).map((c) => ({ x: c.x, y: g.top, z: c.z }));
}

/** The box's half width (physics.ts PHYSICS.width / 2) the field's passability is judged with. */
const HALF = 0.3;

/**
 * The field for a request: one breadth-first search per goal over the cells the body fits in, from the goal's cells,
 * 6-connected. A cell the body fits in is air with air over it (the box is 0.6 high: the cell above is within the
 * margin) and, when the box with its margin is wider than the cell (`margin` + 0.3 over 0.5), air on its four sides
 * too: measured first over every air cell, the field ran through the one-cell cracks and slits of a real cave's walls
 * and pulled the search into them (the proofs came back partial where the straight line completed). The chained rest
 * of goal i is the least distance from any of its cells to goal i + 1 (FAR when none reaches), plus the rest of i + 1.
 */
export function buildField(grid: RouteGrid, start: Vec3, goals: readonly RouteGoal[], margin = 0): DistanceField {
  const t0 = performance.now();
  const { min, size } = fieldBox(grid, start, goals);
  const n = size.x * size.y * size.z;
  const sx = size.x;
  const sxz = size.x * size.z;
  // the air mask once (the grid is read n times, not n times per goal), then the cells the body fits in
  const air = new Uint8Array(n);
  let i = 0;
  for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) air[i++] = grid.solid(min.x + x, min.y + y, min.z + z) ? 0 : 1;
  const idx = (x: number, y: number, z: number): number => (y * size.z + z) * sx + x;
  const wide = margin + HALF > 0.5;
  const open = new Uint8Array(n);
  i = 0;
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++, i++) {
        if (!air[i]) continue;
        if (y + 1 < size.y && !air[i + sxz]) continue;
        if (wide && ((x > 0 && !air[i - 1]) || (x + 1 < sx && !air[i + 1]) || (z > 0 && !air[i - sx]) || (z + 1 < size.z && !air[i + sx]))) continue;
        open[i] = 1;
      }
    }
  }
  const queue = new Int32Array(n);
  let cells = 0;
  const dist: Uint16Array[] = [];
  for (const g of goals) {
    const d = new Uint16Array(n).fill(FAR);
    let head = 0;
    let tail = 0;
    for (const s of seedsOf(g)) {
      const lx = s.x - min.x;
      const ly = s.y - min.y;
      const lz = s.z - min.z;
      if (lx < 0 || ly < 0 || lz < 0 || lx >= size.x || ly >= size.y || lz >= size.z) continue;
      const k = idx(lx, ly, lz);
      if (!open[k] || d[k] !== FAR) continue;
      d[k] = 0;
      queue[tail++] = k;
    }
    while (head < tail) {
      const k = queue[head++]!;
      const dk = d[k]! + 1;
      const x = k % sx;
      const rest = (k - x) / sx;
      const z = rest % size.z;
      const y = (rest - z) / size.z;
      // the six neighbours (inside the box, passable, not yet reached)
      if (x > 0 && open[k - 1] && d[k - 1] === FAR) {
        d[k - 1] = dk;
        queue[tail++] = k - 1;
      }
      if (x < sx - 1 && open[k + 1] && d[k + 1] === FAR) {
        d[k + 1] = dk;
        queue[tail++] = k + 1;
      }
      if (z > 0 && open[k - sx] && d[k - sx] === FAR) {
        d[k - sx] = dk;
        queue[tail++] = k - sx;
      }
      if (z < size.z - 1 && open[k + sx] && d[k + sx] === FAR) {
        d[k + sx] = dk;
        queue[tail++] = k + sx;
      }
      if (y > 0 && open[k - sxz] && d[k - sxz] === FAR) {
        d[k - sxz] = dk;
        queue[tail++] = k - sxz;
      }
      if (y < size.y - 1 && open[k + sxz] && d[k + sxz] === FAR) {
        d[k + sxz] = dk;
        queue[tail++] = k + sxz;
      }
    }
    cells += tail;
    dist.push(d);
  }
  // the chained rest: from goal i's cells to goal i + 1 along the field of i + 1
  const rest = new Array<number>(goals.length).fill(0);
  for (let g = goals.length - 2; g >= 0; g--) {
    let link = FAR;
    const next = dist[g + 1]!;
    for (const s of seedsOf(goals[g]!)) {
      const lx = s.x - min.x;
      const ly = s.y - min.y;
      const lz = s.z - min.z;
      if (lx < 0 || ly < 0 || lz < 0 || lx >= size.x || ly >= size.y || lz >= size.z) continue;
      const v = next[idx(lx, ly, lz)]!;
      if (v < link) link = v;
    }
    rest[g] = link === FAR ? FAR : link + rest[g + 1]!;
  }
  return { min, size, dist, rest, cells, ms: performance.now() - t0 };
}

/** The geodesic blocks from the cell of `p` to goal `g` and on through the rest, or undefined when the cell is outside the field, solid or cut off from the goal. */
export function fieldDistance(f: DistanceField, g: number, p: Vec3): number | undefined {
  const d = f.dist[g];
  if (!d) return undefined;
  const lx = Math.floor(p.x) - f.min.x;
  const ly = Math.floor(p.y + 1e-6) - f.min.y;
  const lz = Math.floor(p.z) - f.min.z;
  if (lx < 0 || ly < 0 || lz < 0 || lx >= f.size.x || ly >= f.size.y || lz >= f.size.z) return undefined;
  const v = d[(ly * f.size.z + lz) * f.size.x + lx]!;
  if (v === FAR) return undefined;
  const r = f.rest[g] ?? 0;
  return r === FAR ? undefined : v + r;
}
