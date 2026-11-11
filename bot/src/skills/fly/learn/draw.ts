// Track F9d (docs/flight.md "Drawn lines (Track F9d)"; decisions/0081-drawn-lines.md): a way out of a cave nobody recorded.
// Track F9b flies out along a recorded flight's line with the guide follower; where there is no recording the bot had only
// the searched way out (route/takeoff.ts waysOut: waypoints cut from a flood of unit steps, a search in pieces, the route
// tracker), which its own proof refuses in the owner's cave every time. This file DRAWS the line a recording would have
// given, from the world alone:
//
//   1 the flood     from the body's cell through the air that stays under the roof, to the cells under the real sky
//                   (`floodOut`). It is a search by cost, not by steps: a step beside a wall or over the floor costs more
//                   than one in the middle of a passage, and a step may go diagonally in all three directions, so the way
//                   found runs where a body has room and rises with the passage instead of along its floor.
//   2 the line      the way's points put on one slope from the takeoff's height to the exit's, each inside its own
//                   passage (`rise`: a flight out of a cave climbs all the way; the flood's cells follow the floor; the
//                   heights that keep a berth from what is beside the line, and as a second line the heights between
//                   the floor and the roof alone, which is the line out from under a lip beside a takeoff); then
//                   pulled straight (`pull`): from each point the farthest point ahead the gliding box
//                   reaches on a straight line with a berth (a block, where the cave gives one; less in a narrow place),
//                   then every corner rounded as wide as the air round it allows (`round`), then carried on past the roof
//                   into the open air, rising. Points a block apart, as a recording's are.
//   3 the roll      the guide follower flown along it on the physics, from standing, at the nominal burn (`rollLine`): its
//                   ticks become the line's (a drawn line has no recorder's clock) and the roll is its first test: a line
//                   the follower loses or that meets a block is no line.
//
// What comes out is a `Guide` (guide.ts) with `drawn` set: the takeoff proves it as it proves a recorded line (glide.ts
// routeTakeoff: every burn from 9 to 21, the mixes, a first rocket that fires nothing) and the same follower flies it
// (brain.ts guideTakeoff). Several exits and several berths are several candidates; the proof picks (route/takeoff.ts).
// A drawn line carries one rocket, the takeoff's (DRAW_ROCKET_TICK after the jump, where the owner's seven takes fired
// theirs: 6 to 10 ticks); every later one is the follower's own rule (slower than FOLLOW_SPEED with line ahead), at
// whatever burn the flight happens to get.
import type { Vec3 } from '../../../connection/types.ts';
import { GLIDE, stepBody } from '../../input/physics.ts';
import { IDLE_COMMAND, initialBody, type BlockQuery, type MoveCommand } from '../../input/types.ts';
import { boxClear, type RouteGrid } from '../route/grid.ts';
import { FOLLOW_MARGIN, GuideFollower } from './follow.ts';
import type { BurnRange } from '../burn.ts';
import { GUIDE_STEP, guideLength, type Guide } from './guide.ts';
import { OPEN_POINTS, OUT_AFTER } from './match.ts';

/** The flood's reach (blocks from the start, straight) and cells. */
export const DRAW_RADIUS = 128;
export const DRAW_FLOOD_MAX = 80_000;
/** The first steps from the start need no room round them (the body stands in its cell and jumps); after them a cell needs DRAW_ROOM cells free each side, two high. */
export const DRAW_THIN = 3;
/** Track F9e: a way between two places under one roof passes a cell under the sky only where a roof lies within this many cells of it (`floodTo`). */
export const DRAW_SKY_NEAR = 8;
export const DRAW_ROOM = 1;
/** Track F9e round 2: in a search for a cell under the same roof (`floodTo`) a cell is under a roof when this many solid cells or more lie over it (a tree's canopy and a thin ledge are no cave). */
export const DRAW_ROOF_THICK = 8;
/** A step into a cell with a solid within one cell of it (the floor, a wall, the roof) costs this much more a block, one with a solid within two this much. */
export const DRAW_NEAR_COST = 2.5;
export const DRAW_CLOSE_COST = 0.6;
/** Exits tried at most, at least this far apart (blocks). */
export const DRAW_EXITS = 3;
export const DRAW_APART = 12;
/** The berths the line is pulled with, the widest first; a stretch that has none of the first keeps the next. The last is the follower's own. */
export const DRAW_BERTHS: readonly number[] = Object.freeze([0.9, 0.6, FOLLOW_MARGIN + 0.05]);
/** A pulled piece looks at most this many cells of the flood's way ahead (a piece on a narrower berth DRAW_PULL_NARROW). */
export const DRAW_PULL_AHEAD = 96;
export const DRAW_PULL_NARROW = 6;
/** The straight piece between two points is tested with the gliding box every this many blocks. */
export const DRAW_SAMPLE = 0.4;
/** A corner is rounded with this radius where the air allows (a rocket turns a body 90 degrees within 4 blocks, a glide within 6 to 15), down to DRAW_ROUND_MIN of tangent. */
export const DRAW_ROUND = 8;
export const DRAW_ROUND_MIN = 0.75;
/** Track F9e: a corner whose slope falls by this much (radians: 5 degrees) is a top, rounded with this radius where the air allows: nothing but gravity bends a glide downwards (0.03 to 0.05 a tick a tick: at a block a tick a curve of 20 to 30 blocks, at a rocket's speed of 50 and more). */
export const DRAW_OVER_TURN = (5 * Math.PI) / 180;
export const DRAW_ROUND_OVER = 40;
/** The body's first point on the line lies this far over its feet (the jump rises 1.25). */
export const DRAW_LIFT = 1;
/** The start needs this many cells of air over the feet for the jump to take a glide (under two the server refuses it: Track F0). */
export const DRAW_HEADROOM = 3;
/** Past the roof the line goes on this far (blocks, match.ts OUT_AFTER) rising this much a block, at least DRAW_OUT_MIN of it free. */
export const DRAW_OUT_RISE = 0.3;
export const DRAW_OUT_MIN = 6;
/** The takeoff's rocket: this many ticks off the ground (the owner's recorded exits: 6 to 10). */
export const DRAW_ROCKET_TICK = 8;
/** The roll gives up after this many ticks, and so many more for every block of line. */
export const DRAW_ROLL_TICKS = 60;
export const DRAW_ROLL_PER_BLOCK = 3;

/** A cell under the real sky the flood reached, with the flood's way to it (cells, the start's first). */
export interface DrawnWay {
  x: number;
  y: number;
  z: number;
  /** Cells of the way. */
  steps: number;
  /** The way's cost (blocks, the cells beside a solid counted dearer). */
  cost: number;
  way: { x: number; y: number; z: number }[];
}

/** A drawn way out: the line as a guide, the blocks along it to its first point under open sky, and what the roll measured. */
export interface DrawnLine {
  guide: Guide;
  open: number;
  /** The cell under open sky the flood's way ended in. */
  exit: { x: number; y: number; z: number };
  steps: number;
  /** The berth the line was pulled with first, and the least it keeps anywhere (blocks from the gliding box to a solid, capped at a block). */
  berth: number;
  room: number;
  /** The roll at the nominal burn: the ticks to the line's first open sky and to its end, the rockets fired. */
  ticks: number;
  rockets: number;
}

/** The cells of the box (2r + 1) cubed round a cell that are solid: none. */
function free(grid: RouteGrid, x: number, y: number, z: number, r: number): boolean {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (grid.solid(x + dx, y + dy, z + dz)) return false;
  return true;
}

/**
 * The flood: the cheapest ways from the body's cell through the air under the roof to cells under the real sky (no solid
 * over them up to `top`; an unknown cell is a roof, the grid's rule). A cell under the sky is a way out and is not flooded
 * past, so the flood is the cave's own size. Steps go to the 26 neighbours; past the first DRAW_THIN steps a cell needs
 * DRAW_ROOM free each side and two high (a passage a gliding body has a berth in). The ways out at least `apart` from each
 * other, the cheapest first.
 */
export function floodOut(grid: RouteGrid, from: Vec3, top: number, o: { radius?: number; max?: number; apart?: number; exits?: number } = {}): { ways: DrawnWay[]; cells: number } {
  return flood(grid, from, { ...o, top });
}

/**
 * Track F9e: the cheapest way from the body's cell through the air to another cell under the same roof (`to`: a feet cell,
 * the touchdown of a flight that never leaves the cave), by the same steps and costs as `floodOut`. The search is aimed
 * (the cost so far and the straight distance still to go). A cell under the sky (up to `top`) is passed where a roof lies
 * within DRAW_SKY_NEAR cells of it on one of eight headings at its height (a hole in the roof over the way, a pit, the
 * stretch before a mouth: no end of the way), and is no way on farther out than that: the search stays the cave's size
 * and never floods the open air. The last `thin` cells before `to` (DRAW_THIN) need no room round them, as the first (the
 * body comes down into its cell there). Undefined way: none within reach.
 */
export function floodTo(grid: RouteGrid, from: Vec3, to: { x: number; y: number; z: number }, o: { radius?: number; max?: number; thin?: number; top?: number; aim?: number } = {}): { way: DrawnWay | undefined; cells: number } {
  const f = flood(grid, from, { ...o, to });
  return { way: f.ways[0], cells: f.cells };
}

interface FloodOptions {
  radius?: number;
  max?: number;
  apart?: number;
  exits?: number;
  top?: number;
  to?: { x: number; y: number; z: number };
  thin?: number;
  /** Track F9e round 2: how much the straight distance still to go counts in a search for a cell (1: the cheapest way; more: the search is drawn to the goal and looks at fewer cells, for a way a little dearer). */
  aim?: number;
}

function flood(grid: RouteGrid, from: Vec3, o: FloodOptions): { ways: DrawnWay[]; cells: number } {
  const steps = floodSteps(grid, from, o);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Track F9e: `floodOut` in slices: it yields every DRAW_FLOOD_SLICE cells, so a flood that runs while the bot flies (a way in is drawn in the air) gives the input loop its turn between them. */
export function floodOutSteps(grid: RouteGrid, from: Vec3, top: number, o: { radius?: number; max?: number; apart?: number; exits?: number } = {}): Generator<undefined, { ways: DrawnWay[]; cells: number }, undefined> {
  return floodSteps(grid, from, { ...o, top });
}

/** The cells a flood looks at between two pauses (`floodOutSteps`): a few thousandths of a second of work. */
export const DRAW_FLOOD_SLICE = 1500;

function* floodSteps(grid: RouteGrid, from: Vec3, o: FloodOptions): Generator<undefined, { ways: DrawnWay[]; cells: number }, undefined> {
  const top = o.top ?? 319;
  const to = o.to;
  const radius = o.radius ?? DRAW_RADIUS;
  const max = o.max ?? DRAW_FLOOD_MAX;
  const apart = o.apart ?? DRAW_APART;
  const exits = o.exits ?? DRAW_EXITS;
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y + 1e-6);
  const sz = Math.floor(from.z);
  // (Track F9e: a cell's key is a number, within 2048 blocks of the start; a text key a cell was most of the flood's time)
  const key = (x: number, y: number, z: number): number => ((x - sx + 2048) * 4096 + (z - sz + 2048)) * 1024 + (y - sy + 512);
  // the highest solid of a column up to `top` (one scan a column): a cell over it is under the sky
  const roofs = new Map<number, number>();
  const roofOf = (x: number, z: number): number => {
    const k = (x - sx + 2048) * 4096 + (z - sz + 2048);
    let y = roofs.get(k);
    if (y === undefined) {
      y = Math.floor(top);
      while (y > sy - radius && !grid.solid(x, y, z)) y--;
      roofs.set(k, y);
    }
    return y;
  };
  const room = (x: number, y: number, z: number): boolean => {
    for (let dx = -DRAW_ROOM; dx <= DRAW_ROOM; dx++) for (let dz = -DRAW_ROOM; dz <= DRAW_ROOM; dz++) for (let dy = 0; dy <= 1; dy++) if (grid.solid(x + dx, y + dy, z + dz)) return false;
    return true;
  };
  // (a search for a cell: a cell under the sky with no roof within DRAW_SKY_NEAR of it on any of eight headings is the open
  // air, not a hole over the way)
  // (Track F9e round 2: for that search a roof is a THICK one: DRAW_ROOF_THICK solid cells or more over the cell up to
  // `top`. On the fixture's box a canopy never came into it; on the real ground round the cave's mouth every cell under a
  // tree was "under a roof", the search ran across the forest floor and ended at its cap of cells with no way found)
  const deeps = new Map<number, number>();
  const deepOf = (x: number, z: number): number => {
    const k = (x - sx + 2048) * 4096 + (z - sz + 2048);
    let y = deeps.get(k);
    if (y === undefined) {
      y = Math.floor(top);
      for (let n = 0; y > sy - radius; y--) if (grid.solid(x, y, z) && ++n >= DRAW_ROOF_THICK) break;
      deeps.set(k, y);
    }
    return y;
  };
  const outdoors = (x: number, y: number, z: number): boolean => {
    if (y <= deepOf(x, z)) return false;
    // (a roof: air at this height with a thick solid over it; a hillside beside the cell is none)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) for (let s = 1; s <= DRAW_SKY_NEAR; s++) if (y < deepOf(x + dx * s, z + dz * s) && !grid.solid(x + dx * s, y, z + dz * s)) return false;
    return true;
  };
  // the cells: their place, cost so far, steps, parent; a binary heap of (cost, cell)
  const xs: number[] = [sx];
  const ys: number[] = [sy];
  const zs: number[] = [sz];
  const cost: number[] = [0];
  // (the heap's order: the cost so far, and in a search for a cell the straight distance still to go)
  const aim = o.aim ?? 1;
  const left = (x: number, y: number, z: number): number => (to ? aim * Math.hypot(to.x - x, to.y - y, to.z - z) : 0);
  const prio: number[] = [left(sx, sy, sz)];
  const steps: number[] = [0];
  const parent: number[] = [-1];
  const done: boolean[] = [false];
  // (what a step into the cell costs more a block, looked at once a cell)
  const dears: number[] = [0];
  const index = new Map<number, number>([[key(sx, sy, sz), 0]]);
  const heap: number[] = [0];
  const push = (i: number): void => {
    heap.push(i);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (prio[heap[p]!]! <= prio[heap[k]!]!) break;
      [heap[p], heap[k]] = [heap[k]!, heap[p]!];
      k = p;
    }
  };
  const pop = (): number => {
    const head = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && prio[heap[l]!]! < prio[heap[m]!]!) m = l;
        if (r < heap.length && prio[heap[r]!]! < prio[heap[m]!]!) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return head;
  };
  const ways: DrawnWay[] = [];
  let pops = 0;
  while (heap.length && xs.length < max && ways.length < exits) {
    if (++pops % DRAW_FLOOD_SLICE === 0) yield undefined;
    const i = pop();
    if (done[i]) continue;
    done[i] = true;
    const x = xs[i]!;
    const y = ys[i]!;
    const z = zs[i]!;
    if (to) {
      if (x === to.x && y === to.y && z === to.z) {
        const way: DrawnWay['way'] = [];
        for (let k = i; k >= 0; k = parent[k]!) way.push({ x: xs[k]!, y: ys[k]!, z: zs[k]! });
        ways.push({ x, y, z, steps: steps[i]!, cost: cost[i]!, way: way.reverse() });
        break;
      }
    } else if (i > 0 && y > roofOf(x, z)) {
      if (ways.every((w) => Math.hypot(w.x - x, w.y - y, w.z - z) >= apart)) {
        const way: DrawnWay['way'] = [];
        for (let k = i; k >= 0; k = parent[k]!) way.push({ x: xs[k]!, y: ys[k]!, z: zs[k]! });
        ways.push({ x, y, z, steps: steps[i]!, cost: cost[i]!, way: way.reverse() });
      }
      continue; // under the sky: a way out, not a way on
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (Math.hypot(nx - sx, ny - sy, nz - sz) > radius) continue;
          const k = key(nx, ny, nz);
          const seen = index.get(k);
          if (seen !== undefined && done[seen]) continue;
          if (seen === undefined) {
            if (grid.solid(nx, ny, nz)) continue;
            // (a diagonal step passes the cells between: free as well, or the box clips their corner)
            if (dx !== 0 && grid.solid(nx, y, z)) continue;
            if (dz !== 0 && grid.solid(x, y, nz)) continue;
            if (dy !== 0 && grid.solid(x, ny, z)) continue;
            if (steps[i]! >= DRAW_THIN && !(to && Math.max(Math.abs(nx - to.x), Math.abs(ny - to.y), Math.abs(nz - to.z)) <= (o.thin ?? DRAW_THIN)) && !room(nx, ny, nz)) continue;
            if (to && outdoors(nx, ny, nz)) continue;
          }
          const len = Math.hypot(dx, dy, dz);
          const dear = seen !== undefined ? dears[seen]! : free(grid, nx, ny, nz, 1) ? (free(grid, nx, ny, nz, 2) ? 0 : DRAW_CLOSE_COST) : DRAW_NEAR_COST;
          const c = cost[i]! + len * (1 + dear);
          if (seen === undefined) {
            const n = xs.length;
            xs.push(nx);
            ys.push(ny);
            zs.push(nz);
            dears.push(dear);
            cost.push(c);
            prio.push(c + left(nx, ny, nz));
            steps.push(steps[i]! + 1);
            parent.push(i);
            done.push(false);
            index.set(k, n);
            push(n);
          } else if (c < cost[seen]! - 1e-9) {
            cost[seen] = c;
            prio[seen] = c + left(nx, ny, nz);
            steps[seen] = steps[i]! + 1;
            parent[seen] = i;
            push(seen);
          }
        }
      }
    }
  }
  return { ways, cells: xs.length };
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const lerp = (a: Vec3, b: Vec3, f: number): Vec3 => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });

/** The gliding box keeps `berth` from every solid at each sample of the straight piece from a to b. */
function straight(grid: RouteGrid, a: Vec3, b: Vec3, berth: number): boolean {
  const n = Math.max(1, Math.ceil(dist(a, b) / DRAW_SAMPLE));
  for (let k = 0; k <= n; k++) if (boxClear(grid, lerp(a, b, k / n), berth).hit) return false;
  return true;
}

/**
 * The flood's way pulled straight: from each point the farthest point of the way ahead (within DRAW_PULL_AHEAD cells) that
 * the gliding box reaches on a straight piece with `berth`; where even the next cell is not reached so, the narrower
 * berths of DRAW_BERTHS in turn, and the bare step if none (the proof decides what a body makes of it). The corners
 * left are where the cave turns.
 */
export function pull(grid: RouteGrid, pts: readonly Vec3[], berth: number): Vec3[] {
  const out: Vec3[] = [pts[0]!];
  const berths = DRAW_BERTHS.filter((b) => b <= berth + 1e-9);
  let i = 0;
  while (i < pts.length - 1) {
    let next = -1;
    // (a point that itself has less room than the berth, the takeoff beside a block, keeps half of what it has, as the
    // follower and the search's first edges do: follow.ts, search.ts startMarginFor)
    const here = boxClear(grid, pts[i]!, 0).clearance;
    for (const wide of berths) {
      const b = here < wide ? here * 0.5 : wide;
      if (!straight(grid, pts[i]!, pts[i + 1]!, b)) continue;
      // the farthest point reached with this berth: the far end, else by halving between a point that is reached and one
      // that is not (the reach is not monotone round a pillar: what is found is reached, not proven the farthest of all).
      // A piece on a narrower berth than the widest is kept short, so the wide berth is taken up again beyond the narrow place
      let lo = i + 1;
      let hi = Math.min(pts.length - 1, i + (b === berths[0] ? DRAW_PULL_AHEAD : DRAW_PULL_NARROW));
      // (the farthest point of a narrow piece is one that has the wide berth again, when there is one in reach)
      if (b !== berths[0]) for (let k = i + 2; k <= hi; k++) if (!boxClear(grid, pts[k]!, berths[0]!).hit && straight(grid, pts[i]!, pts[k]!, b)) hi = k;
      if (hi > lo && straight(grid, pts[i]!, pts[hi]!, b)) lo = hi;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (straight(grid, pts[i]!, pts[mid]!, b)) lo = mid;
        else hi = mid;
      }
      next = lo;
      break;
    }
    if (next < 0) next = i + 1;
    out.push(pts[next]!);
    i = next;
  }
  return out;
}

/**
 * The corners rounded: each inner point replaced by a curve from `d` before it to `d` after it (a quadratic through the
 * corner's control point), `d` the tangent of a turn of DRAW_ROUND radius, at most 0.45 of either piece, halved until
 * every sample of the curve keeps `berth` (down to DRAW_ROUND_MIN: then the corner stays as it is).
 */
export function round(grid: RouteGrid, pts: readonly Vec3[], berth: number): Vec3[] {
  if (pts.length < 3) return [...pts];
  const out: Vec3[] = [pts[0]!];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1]!;
    const v = pts[k]!;
    const b = pts[k + 1]!;
    const la = dist(a, v);
    const lb = dist(v, b);
    if (la < 1e-6 || lb < 1e-6) continue;
    const ua = { x: (v.x - a.x) / la, y: (v.y - a.y) / la, z: (v.z - a.z) / la };
    const ub = { x: (b.x - v.x) / lb, y: (b.y - v.y) / lb, z: (b.z - v.z) / lb };
    const turn = Math.acos(Math.max(-1, Math.min(1, ua.x * ub.x + ua.y * ub.y + ua.z * ub.z)));
    // (Track F9e: a corner the line goes over, its slope falling by DRAW_OVER_TURN or more, is rounded DRAW_ROUND_OVER wide
    // where the air allows: gravity alone bends a glide downwards, so a body follows a top only on a wide curve)
    const over = Math.asin(Math.max(-1, Math.min(1, ua.y))) - Math.asin(Math.max(-1, Math.min(1, ub.y))) >= DRAW_OVER_TURN;
    let d = Math.min((over ? DRAW_ROUND_OVER : DRAW_ROUND) * Math.tan(turn / 2), 0.45 * la, 0.45 * lb);
    let curve: Vec3[] | undefined;
    while (d >= DRAW_ROUND_MIN) {
      const p0 = { x: v.x - ua.x * d, y: v.y - ua.y * d, z: v.z - ua.z * d };
      const p2 = { x: v.x + ub.x * d, y: v.y + ub.y * d, z: v.z + ub.z * d };
      const n = Math.max(2, Math.ceil((2 * d) / DRAW_SAMPLE));
      const c: Vec3[] = [];
      let clear = true;
      for (let j = 0; j <= n && clear; j++) {
        const t = j / n;
        const q = { x: (1 - t) * (1 - t) * p0.x + 2 * t * (1 - t) * v.x + t * t * p2.x, y: (1 - t) * (1 - t) * p0.y + 2 * t * (1 - t) * v.y + t * t * p2.y, z: (1 - t) * (1 - t) * p0.z + 2 * t * (1 - t) * v.z + t * t * p2.z };
        if (boxClear(grid, q, berth).hit) clear = false;
        c.push(q);
      }
      if (clear) {
        curve = c;
        break;
      }
      d /= 2;
    }
    if (curve) out.push(...curve);
    else out.push(v);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** A polyline as points GUIDE_STEP apart along it (the last one its end). */
export function resample(pts: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [{ ...pts[0]! }];
  let walked = 0;
  let next: number = GUIDE_STEP;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!;
    const b = pts[k]!;
    const d = dist(a, b);
    while (d > 0 && walked + d >= next) {
      out.push(lerp(a, b, (next - walked) / d));
      next += GUIDE_STEP;
    }
    walked += d;
  }
  const last = pts[pts.length - 1]!;
  if (dist(out[out.length - 1]!, last) > 0.25) out.push({ ...last });
  return out;
}

/**
 * Track F9e: the shortest line through a tube of heights: at `xs[k]` (blocks along the way, rising) the height must lie
 * in [lo[k], hi[k]]; it begins at `y0` (x = 0) and ends at `yEnd` (brought into the last band). The line is straight
 * wherever the bands let it be and bends only where it touches one (the funnel of a path in a corridor, in one
 * dimension): at a floor it bends down over it, at a roof up under it.
 */
export function taut(xs: readonly number[], lo: readonly number[], hi: readonly number[], y0: number, yEnd: number): number[] {
  const n = xs.length;
  const out = new Array<number>(n).fill(y0);
  if (!n) return out;
  const lows = [...lo];
  const highs = [...hi];
  const end = Math.max(lows[n - 1]!, Math.min(highs[n - 1]!, yEnd));
  lows[n - 1] = end;
  highs[n - 1] = end;
  let apex = -1;
  let ax = 0;
  let ay = y0;
  const fill = (to: number, y: number): void => {
    const dx = xs[to]! - ax || 1;
    for (let k = apex + 1; k <= to; k++) out[k] = ay + ((y - ay) * (xs[k]! - ax)) / dx;
    apex = to;
    ax = xs[to]!;
    ay = y;
  };
  while (apex < n - 1) {
    let sLo = -Infinity;
    let sHi = Infinity;
    let jLo = -1;
    let jHi = -1;
    let bend = -1;
    let at = 0;
    for (let k = apex + 1; k < n; k++) {
      const dx = Math.max(1e-6, xs[k]! - ax);
      const a = (lows[k]! - ay) / dx;
      const b = (highs[k]! - ay) / dx;
      // the band here lies over everything the roofs before it allow: the line bends up under the roof that binds; under
      // everything the floors allow: it bends down over that floor
      if (a > sHi + 1e-12 && jHi >= 0) {
        bend = jHi;
        at = highs[jHi]!;
        break;
      }
      if (b < sLo - 1e-12 && jLo >= 0) {
        bend = jLo;
        at = lows[jLo]!;
        break;
      }
      if (a > sLo) {
        sLo = a;
        jLo = k;
      }
      if (b < sHi) {
        sHi = b;
        jHi = k;
      }
    }
    if (bend >= 0) fill(bend, at);
    else fill(n - 1, end);
  }
  return out;
}

/** A way's cells are looked at this far down and up for their passage's floor and roof (cells), the heights between tried every DRAW_BAND_STEP. */
export const DRAW_BAND = 24;
export const DRAW_BAND_STEP = 0.25;
/** The line's height changes at most this much a block of way from one point to the next where the passage allows (a climb of 40 degrees). */
export const DRAW_SLOPE = 0.84;

/**
 * The heights of a way's points. The flood's cells say where the passage runs, not how high a body should be in it: its
 * cheapest cells lie a block or two over the floor and follow every step of it. A flight out of a cave climbs from where
 * it left the ground to where it comes out (the owner's seven recorded exits climb 12 to 19 degrees all the way), so each
 * point is put on the straight slope from the first height to the exit's, by the way's length, and kept inside its own
 * passage: the run of heights of its column, between the floor under its cell and the roof over it, at which the gliding
 * box keeps `berth` from every solid (the floor, the roof, and what juts out beside it at that height; the run nearest
 * the slope when there are several; a place with no such height keeps the follower's berth, or its cell's own height). Then no steeper from point to point than DRAW_SLOPE where those heights allow. The points for
 * `pull`, the way's first cell left out (the body's own).
 */
export function rise(grid: RouteGrid, way: DrawnWay, y0: number, berth: number, beside = true, o: { end?: number } = {}): Vec3[] {
  const cells = way.way;
  const along: number[] = [0];
  for (let k = 1; k < cells.length; k++) along.push(along[k - 1]! + Math.hypot(cells[k]!.x - cells[k - 1]!.x, cells[k]!.y - cells[k - 1]!.y, cells[k]!.z - cells[k - 1]!.z));
  const total = along[cells.length - 1]! || 1;
  const y1 = Math.max(y0, cells[cells.length - 1]!.y + 0.2);
  const least = DRAW_BERTHS[DRAW_BERTHS.length - 1]!;
  // each cell's band: the run of heights round its own at which the box has the berth
  const lo: number[] = [];
  const hi: number[] = [];
  for (let k = 1; k < cells.length; k++) {
    const c = cells[k]!;
    const own = c.y + 0.2;
    const at = (y: number): Vec3 => ({ x: c.x + 0.5, y, z: c.z + 0.5 });
    // the cavity of the cell's column: from the floor under it to the roof over it
    let floor = c.y - 1;
    while (floor > c.y - DRAW_BAND && !grid.solid(c.x, floor, c.z)) floor--;
    let roof = c.y + 1;
    while (roof < c.y + DRAW_BAND && !grid.solid(c.x, roof, c.z)) roof++;
    let band: [number, number] | undefined;
    const want = y0 + ((y1 - y0) * along[k]!) / total;
    // (`beside` off: the floor and the roof alone, whatever juts out beside the column: the follower's own look, which
    // keeps half the room a tight place has, is then the judge of what is beside the line. Beside a takeoff under a lip
    // the heights with a whole berth all lie under the lip, and a body that has just jumped is over it)
    if (!beside) band = floor + 1 + berth <= roof - GLIDE.height - berth ? [floor + 1 + berth, roof - GLIDE.height - berth] : [(floor + 1 + roof - GLIDE.height) / 2, (floor + 1 + roof - GLIDE.height) / 2];
    for (const b of !beside ? [] : berth > least ? [berth, least] : [least]) {
      // the runs of heights in it at which the box has the berth; the one the slope's height lies in, else the nearest to it
      let run: [number, number] | undefined;
      let gap = Infinity;
      const take = (r: [number, number]): void => {
        const d = want < r[0] ? r[0] - want : want > r[1] ? want - r[1] : 0;
        if (d < gap) {
          gap = d;
          band = r;
        }
      };
      for (let y = floor + 1; y <= roof - GLIDE.height + 1e-9; y += DRAW_BAND_STEP) {
        if (!boxClear(grid, at(y), b).hit) {
          run = run ? [run[0], y] : [y, y];
          continue;
        }
        if (run) take(run);
        run = undefined;
      }
      if (run) take(run);
      if (band) break;
    }
    lo.push(band ? band[0] : own);
    hi.push(band ? band[1] : own);
  }
  const n = lo.length;
  // Track F9e: the heights are the TAUT line through those bands from the takeoff's height to the exit's (`taut`). Where
  // nothing is in its way that is the one slope as before; where the passage goes over a sill or under a low roof the
  // line bends there and nowhere else, so it climbs to a sill and comes down from it on two slopes instead of hugging
  // the floor up one side and down the other (a body at a rocket's speed cannot follow a line that falls away behind a
  // top: the deep cave's lines were lost there at a short burn). An exit under the start is ended at its own height
  const last = cells[cells.length - 1]!.y + 0.2;
  const ys = taut(along.slice(1), lo, hi, y0, o.end ?? (last >= y0 ? y1 : last));
  // no steeper than DRAW_SLOPE from point to point, forwards and backwards; the band has the last word
  const fit = (k: number, prev: number, d: number): void => {
    ys[k] = Math.max(lo[k]!, Math.min(hi[k]!, Math.max(prev - DRAW_SLOPE * d, Math.min(prev + DRAW_SLOPE * d, ys[k]!))));
  };
  for (let k = 0; k < n; k++) fit(k, k === 0 ? y0 : ys[k - 1]!, along[k + 1]! - along[k]!);
  for (let k = n - 2; k >= 0; k--) fit(k, ys[k + 1]!, along[k + 2]! - along[k + 1]!);
  return cells.slice(1).map((c, k) => ({ x: c.x + 0.5, y: ys[k]!, z: c.z + 0.5 }));
}

/** A way's last cell is moved to the roomiest cell under the sky within this many cells of it (a pit's middle), a cell's room counted up to DRAW_MIDDLE_ROOM cells each side. */
export const DRAW_MIDDLE = 6;
export const DRAW_MIDDLE_ROOM = 5;

/**
 * The cells from a way's exit to the middle of the open air it came out into: the flood's first cell under the sky is the
 * one nearest the roof's edge, a cell beside a pit's wall. Of the cells under the sky at the exit's height within
 * DRAW_MIDDLE of it, the one with the most room round it (the largest free square, two cells high), the nearest of
 * equals; the straight run of cells to it when every one is free. Empty when the exit is as roomy as any.
 */
export function middle(grid: RouteGrid, way: DrawnWay, top: number): { x: number; y: number; z: number }[] {
  const roomAt = (x: number, z: number): number => {
    let k = 0;
    while (k < DRAW_MIDDLE_ROOM) {
      const r = k + 1;
      let clear = true;
      for (let dx = -r; dx <= r && clear; dx++) for (let dz = -r; dz <= r && clear; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r && (grid.solid(x + dx, way.y, z + dz) || grid.solid(x + dx, way.y + 1, z + dz))) clear = false;
      if (!clear) break;
      k = r;
    }
    return k;
  };
  const sky = (x: number, z: number): boolean => {
    for (let y = way.y + 1; y <= top; y++) if (grid.solid(x, y, z)) return false;
    return true;
  };
  let best = { x: way.x, z: way.z, room: roomAt(way.x, way.z), d: 0 };
  for (let dx = -DRAW_MIDDLE; dx <= DRAW_MIDDLE; dx++) {
    for (let dz = -DRAW_MIDDLE; dz <= DRAW_MIDDLE; dz++) {
      const d = Math.hypot(dx, dz);
      if (d === 0 || d > DRAW_MIDDLE || grid.solid(way.x + dx, way.y, way.z + dz) || !sky(way.x + dx, way.z + dz)) continue;
      const room = roomAt(way.x + dx, way.z + dz);
      if (room > best.room || (room === best.room && d < best.d)) best = { x: way.x + dx, z: way.z + dz, room, d };
    }
  }
  if (best.d === 0) return [];
  const out: { x: number; y: number; z: number }[] = [];
  const n = Math.ceil(best.d);
  for (let k = 1; k <= n; k++) {
    const c = { x: Math.round(way.x + ((best.x - way.x) * k) / n), y: way.y, z: Math.round(way.z + ((best.z - way.z) * k) / n) };
    if (grid.solid(c.x, c.y, c.z) || grid.solid(c.x, c.y + 1, c.z)) return [];
    if (!out.length || out[out.length - 1]!.x !== c.x || out[out.length - 1]!.z !== c.z) out.push(c);
  }
  return out;
}

/** The yaw of a direction (Bedrock: 0 = +z, 90 = -x). */
const yawOf = (dx: number, dz: number): number => (Math.atan2(-dx, dz) * 180) / Math.PI;

/**
 * One line for a way out: the body's feet, the point DRAW_LIFT over them, the flood's way pulled straight with `berth`
 * and rounded, then on past the roof: OUT_AFTER blocks from the way's last cell along the heading the line leaves the
 * roof on, or (that one blocked within DRAW_OUT_MIN) the heading of twelve with the longest free run, rising DRAW_OUT_RISE
 * a block. Undefined with the reason when the start has no room to jump.
 */
export function drawLine(grid: RouteGrid, from: Vec3, way: DrawnWay, top: number, berth: number, beside = true, o: { out?: number; rise?: number; min?: number; up?: boolean; headroom?: number; over?: number; lead?: number } = {}): { points: Vec3[]; open: number } | string {
  // (Track F9e: a way in's line goes on farther into the open and steeper than a way out's, and never straight up: `o`)
  const outAfter = o.out ?? OUT_AFTER;
  const outRise = o.rise ?? DRAW_OUT_RISE;
  const outMin = o.min ?? DRAW_OUT_MIN;
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y + 1e-6);
  const sz = Math.floor(from.z);
  for (let k = 1; k < (o.headroom ?? DRAW_HEADROOM); k++) if (grid.solid(sx, sy + k, sz)) return `only ${k} of air over the start (a jump needs ${DRAW_HEADROOM} to take a glide)`;
  const lifted = { x: from.x, y: from.y + DRAW_LIFT, z: from.z };
  // (the way's first cells are the jump's: the body is over them before it flies, and the line begins beyond them)
  const risen = rise(grid, { ...way, way: [...way.way, ...middle(grid, way, top)] }, lifted.y, berth, beside);
  const pulled = pull(grid, [lifted, ...risen.slice(beside ? Math.min(DRAW_THIN - 1, Math.max(0, risen.length - 2)) : 0)], berth);
  // past the roof: straight on where that is free, else the freest heading
  const end = pulled[pulled.length - 1]!;
  const before = pulled[pulled.length - 2] ?? lifted;
  const sky = (p: Vec3): boolean => {
    for (let y = Math.floor(p.y) + 1; y <= top; y++) if (grid.solid(Math.floor(p.x), y, Math.floor(p.z))) return false;
    return true;
  };
  const run = (yaw: number): number => {
    const r = (yaw * Math.PI) / 180;
    const d = { x: -Math.sin(r), z: Math.cos(r) };
    let n = 0;
    for (let s = 1; s <= outAfter; s++) {
      const p = { x: end.x + d.x * s, y: end.y + s * outRise, z: end.z + d.z * s };
      if (boxClear(grid, p, 1).hit || !sky(p)) break;
      n = s;
    }
    return n;
  };
  const h = Math.hypot(end.x - before.x, end.z - before.z);
  let outYaw = h > 0.5 ? yawOf(end.x - before.x, end.z - before.z) : 0;
  let outRun = h > 0.5 ? run(outYaw) : 0;
  if (o.over !== undefined) {
    // Track F9e, a way in: of the headings with the whole run free, the one whose line lies highest over the ground under
    // it, the lead-in to come included (the cruise comes down onto the line from its clearance over that ground: a line
    // low over a hillside is come to too high, and a circle beside it costs seconds), counted up to `o.over`; straight
    // on from the roof wins a tie
    const over = (yaw: number, n: number): number => {
      const r = (yaw * Math.PI) / 180;
      const d = { x: -Math.sin(r), z: Math.cos(r) };
      let least = o.over!;
      for (let s = 2; s <= n + (o.lead ?? 0); s += 2) {
        const p = { x: end.x + d.x * s, y: end.y + s * outRise, z: end.z + d.z * s };
        let g = Math.floor(p.y) - 1;
        while (g > p.y - least - 1 && !grid.solid(Math.floor(p.x), g, Math.floor(p.z))) g--;
        least = Math.min(least, p.y - (g + 1));
      }
      return least;
    };
    let best = outRun >= outAfter ? over(outYaw, outRun) + 0.01 : -1;
    for (let k = 0; k < 12; k++) {
      const n = run(k * 30);
      if (n < outAfter && n <= outRun) continue;
      const c = n >= outAfter ? over(k * 30, n) : -1;
      if (c > best || (best < 0 && n > outRun)) {
        best = c;
        outRun = n;
        outYaw = k * 30;
      }
    }
  } else if (outRun < outAfter) {
    for (let k = 0; k < 12; k++) {
      const n = run(k * 30);
      if (n > outRun) {
        outRun = n;
        outYaw = k * 30;
      }
    }
  }
  const tail: Vec3[] = [];
  // no heading has OUT_AFTER of open air: the way out is the bottom of a pit or a shaft, and the sky is straight up (the
  // owner: "even if the way out of the cave is straight up"). The line then goes on up the open column when that is
  // freer than any heading; the climb after it goes on straight up until a heading clears (brain.ts climbUp)
  let up = 0;
  if (outRun < outAfter && o.up !== false) {
    for (let s = 1; s <= outAfter; s++) {
      if (boxClear(grid, { x: end.x, y: end.y + s, z: end.z }, DRAW_BERTHS[DRAW_BERTHS.length - 1]!).hit) break;
      up = s;
    }
  }
  if (up > outRun && up >= outMin) tail.push({ x: end.x, y: end.y + up, z: end.z });
  else if (outRun >= outMin) {
    const r = (outYaw * Math.PI) / 180;
    tail.push({ x: end.x - Math.sin(r) * outRun, y: end.y + outRun * outRise, z: end.z + Math.cos(r) * outRun });
  }
  const line = resample(round(grid, [...pulled, ...tail], Math.min(berth, DRAW_BERTHS[DRAW_BERTHS.length - 1]!)));
  const points = [{ ...from }, ...line];
  // the first point from which OPEN_POINTS in a row are under open sky (match.ts firstOpen)
  let open = -1;
  let inRow = 0;
  for (let i = 0; i < points.length; i++) {
    inRow = sky(points[i]!) ? inRow + 1 : 0;
    if (inRow >= OPEN_POINTS) {
      open = i - OPEN_POINTS + 1;
      break;
    }
  }
  if (open <= 0) return `the line has no ${OPEN_POINTS} blocks of open sky at its end (the exit's air is blocked within ${outMin} blocks on every heading${o.up === false ? '' : ' and straight up'})`;
  return { points, open: open * GUIDE_STEP };
}

/**
 * Track F9e, a speed for every point. The bend at a point is taken over DRAW_CAP_WINDOW blocks either side of it. Over a
 * top (the slope falling) nothing but gravity bends a glide's path, about DRAW_CAP_OVER of a block a tick a tick, so a
 * top of radius R is followed no faster than the root of DRAW_CAP_OVER times R; round a corner a glide with no rocket
 * turns on a radius of about DRAW_CAP_TURN times its speed (Track F0's envelope: 14.5 blocks from 1.5 a tick with the
 * look 45 degrees off, 6 with it 90 off; the passage is wider than the line and the follower cuts the corner, so the
 * low end). Never under DRAW_CAP_MIN (a glide slower than that sinks more than it flies) and never over DRAW_CAP_MAX (a
 * rocket's own speed and a little: a dive is not flown faster than a burn). Before a slow place the speed comes down
 * DRAW_CAP_SLOW a block (a tick of looking back takes a fifth, every other tick).
 */
export const DRAW_CAP_WINDOW = 4;
export const DRAW_CAP_OVER = 0.045;
export const DRAW_CAP_TURN = 5;
export const DRAW_CAP_MIN = 0.8;
export const DRAW_CAP_MAX = 1.7;
export const DRAW_CAP_SLOW = 0.07;
/** Track F9e: a line falling steeper than this (radians: 12 degrees) is flown no faster than DRAW_CAP_DIVE. */
export const DRAW_CAP_DIVE_SLOPE = (12 * Math.PI) / 180;
export const DRAW_CAP_DIVE = 1.05;

/** Track F9e: the speed for every point of a line (blocks a tick; see DRAW_CAP_WINDOW). */
export function lineSpeeds(points: readonly Vec3[]): number[] {
  const n = points.length;
  const cap = new Array<number>(n).fill(DRAW_CAP_MAX);
  const w = DRAW_CAP_WINDOW;
  for (let i = w; i < n - w; i++) {
    const a = points[i - w]!;
    const p = points[i]!;
    const b = points[i + w]!;
    const la = dist(a, p);
    const lb = dist(p, b);
    if (la < 1e-6 || lb < 1e-6) continue;
    const span = (la + lb) / 2;
    const pa = Math.asin(Math.max(-1, Math.min(1, (p.y - a.y) / la)));
    const pb = Math.asin(Math.max(-1, Math.min(1, (b.y - p.y) / lb)));
    const over = (pa - pb) / span;
    // (a piece straight up or down has no heading: no corner there)
    const ha = Math.hypot(p.x - a.x, p.z - a.z);
    const hb = Math.hypot(b.x - p.x, b.z - p.z);
    let turn = 0;
    if (ha > 0.2 * la && hb > 0.2 * lb) {
      const d = Math.abs(Math.atan2((p.x - a.x) * (b.z - p.z) - (p.z - a.z) * (b.x - p.x), (p.x - a.x) * (b.x - p.x) + (p.z - a.z) * (b.z - p.z)));
      turn = (d * Math.cos((pa + pb) / 2)) / span;
    }
    let c: number = DRAW_CAP_MAX;
    // (a line that falls is followed by a glide whose own fall is the line's: the fall a tick depends on the look alone,
    // 0.34 at 30 degrees down and about 0.5 at 40, so on a slope of 20 to 35 degrees that is a body at about a block a
    // tick; a faster one flies flatter than the line whatever it looks at, and leaves it upwards)
    if ((pa + pb) / 2 < -DRAW_CAP_DIVE_SLOPE) c = Math.min(c, DRAW_CAP_DIVE);
    if (over > 1e-3) c = Math.min(c, Math.sqrt(DRAW_CAP_OVER / over));
    if (turn > 1e-3) c = Math.min(c, 1 / (DRAW_CAP_TURN * turn));
    cap[i] = Math.max(DRAW_CAP_MIN, c);
  }
  for (let i = n - 2; i >= 0; i--) cap[i] = Math.min(cap[i]!, cap[i + 1]! + DRAW_CAP_SLOW * dist(points[i]!, points[i + 1]!));
  return cap;
}

/** No solid in the 3 x 3 columns over a body up to `top` (plan.ts takeoffSky's first test: open sky over the body). */
function skyOver(grid: RouteGrid, p: Vec3, top: number): boolean {
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let y = Math.floor(p.y) + 1; y <= top; y++) if (grid.solid(Math.floor(p.x) + dx, y, Math.floor(p.z) + dz)) return false;
  return true;
}

/** What a roll of the follower along a line gave. */
export interface Roll {
  ok: boolean;
  why?: string;
  /** The tick each point of the line was passed (the last known tick for a point the roll did not reach). */
  ticks: number[];
  /** The rockets fired: ticks after the jump and blocks along the line. */
  rockets: { tick: number; at: number }[];
  /** The tick the body was `open` blocks along the line, and the roll's last. */
  openTick: number;
  endTick: number;
  /** The least room the gliding box kept from a solid once past the line's first 3 blocks (capped at a block). */
  room: number;
}

/**
 * The follower flown along a line on the physics from standing at its first point, at the nominal burn, as brain.ts
 * guideTakeoff flies it (the jump, the glide asked from the first tick in the air, no rocket before the glide's third
 * tick): the ticks at which each point is passed, the rockets, and whether it gets out (with `top`: past the line's first
 * open sky with open sky over the body; else to the line's end) without losing the line or meeting a block.
 */
export function rollLine(grid: RouteGrid, guide: Guide, open: number, o: { burn?: number; top?: number } = {}): Roll {
  const world: BlockQuery = { solidAt: (x, y, z) => grid.solid(x, y, z) };
  const follower = new GuideFollower({ grid, guide });
  const n = guide.points.length;
  const ticks = new Array<number>(n).fill(-1);
  ticks[0] = 0;
  const rockets: Roll['rockets'] = [];
  let body = initialBody(guide.points[0]!, true);
  let cmd: MoveCommand = { ...IDLE_COMMAND, yaw: guide.yaw };
  let gliding = 0;
  let lastFire = -100;
  let openTick = -1;
  let jumpAt = -1;
  let room = 1;
  const maxTicks = DRAW_ROLL_TICKS + DRAW_ROLL_PER_BLOCK * guideLength(guide);
  const fill = (upTo: number, t: number): void => {
    for (let i = 0; i <= Math.min(n - 1, Math.floor(upTo)); i++) if (ticks[i]! < 0) ticks[i] = t;
  };
  const finish = (ok: boolean, t: number, why?: string): Roll => {
    let last = 0;
    for (let i = 0; i < n; i++) {
      if (ticks[i]! < 0) ticks[i] = last;
      last = ticks[i]!;
    }
    return { ok, ...(why !== undefined ? { why } : {}), ticks, rockets, openTick: openTick < 0 ? t : openTick, endTick: t, room };
  };
  for (let t = 1; t <= maxTicks; t++) {
    const out = follower.tick({ pos: body.pos, vel: body.vel, gliding: body.gliding ?? false, onGround: body.onGround, boostTicks: body.boostTicks ?? 0, rockets: 64 }, t);
    const sinceJump = jumpAt < 0 ? 0 : t - jumpAt;
    fill(out.at, sinceJump);
    if (openTick < 0 && out.at >= open) openTick = sinceJump;
    // out, as the flight is (brain.ts guideTakeoff): past the line's first open sky with the 3 x 3 over the body open up to `top`
    if (o.top !== undefined && out.at >= open && body.gliding && skyOver(grid, body.pos, o.top)) return finish(true, sinceJump);
    if (out.status === 'lost') return finish(false, sinceJump, out.why ?? 'the line lost');
    if (out.status === 'done') return finish(true, sinceJump);
    const c = out.control;
    const jump = c.jump === true && body.onGround;
    if (jump && jumpAt < 0) jumpAt = t;
    gliding = body.gliding ? gliding + 1 : 0;
    const fire = c.fire && body.gliding === true && gliding >= 3 && (body.boostTicks ?? 0) === 0 && t - lastFire >= 4;
    cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump, glide: body.gliding === true || !body.onGround };
    if (fire) {
      lastFire = t;
      rockets.push({ tick: sinceJump, at: out.at });
    }
    const before = body;
    const r = stepBody(body, { ...cmd, ...(fire ? { boostStart: o.burn ?? guide.burn?.nominal ?? GLIDE.boostTicks } : {}) }, world);
    if (!r.simulated) return finish(false, sinceJump, 'the world is not known where the line runs');
    body = r.state;
    // (a wall met is the end of it; a roof touched while rising is not, as in the proof: glide.ts simulateFlight's head bump)
    if (before.gliding && body.pos.y > Math.floor(body.pos.y) + 0.05 && body.collidedHorizontally) return finish(false, sinceJump, `the roll meets a block ${out.at.toFixed(0)} blocks along the line`);
    if (body.gliding && out.at >= 3) room = Math.min(room, boxClear(grid, body.pos, 0).clearance);
  }
  return finish(false, maxTicks, `the roll is not at the line's end after ${Math.round(maxTicks)} ticks`);
}

/**
 * The drawn ways out from where the body stands (feet `from`), under the roof up to `top` (the cruise height): the
 * flood's ways to the sky, each drawn with the berths of DRAW_BERTHS that give different lines, each rolled; the lines
 * whose roll gets out, the quickest to open sky first. `tried` says in a line each what the others failed on; `why` when
 * there is nothing at all (no flood to the sky within reach).
 */
export function drawExits(grid: RouteGrid, from: Vec3, top: number, o: { radius?: number; max?: number; exits?: number; apart?: number; burn?: BurnRange } = {}): { lines: DrawnLine[]; cells: number; ways: number; tried: string[]; why?: string } {
  const d = drawWays(grid, from, top, o);
  const tried = [...d.tried];
  const lines: DrawnLine[] = [];
  for (const c of d.drafts) {
    const l = rollDraft(d.grid, c, top);
    if (typeof l === 'string') tried.push(l);
    else lines.push(l);
  }
  lines.sort((a, b) => a.ticks - b.ticks);
  lines.forEach((l, i) => (l.guide = { ...l.guide, path: `drawn ${i + 1}` }));
  return { lines, cells: d.cells, ways: d.ways, tried, ...(d.why !== undefined ? { why: d.why } : {}) };
}

/** Track F9e: a line drawn and not rolled yet: its guide with the points' own numbers for ticks, and what `DrawnLine` says of it but the roll's. */
export interface DrawnDraft {
  guide: Guide;
  open: number;
  exit: { x: number; y: number; z: number };
  steps: number;
  berth: number;
  /** The log's words for it (the way's end from the start, its cells, the berth). */
  at: string;
}

/** A grid that remembers its answers (one draw, its rolls and its proofs ask the same cells many times over), keyed by a number within 2048 blocks of `from`. */
export function rememberedGrid(grid: RouteGrid, from: Vec3): RouteGrid {
  const ox = Math.floor(from.x) - 2048;
  const oz = Math.floor(from.z) - 2048;
  const memo = new Map<number, boolean>();
  return {
    solid: (x, y, z) => {
      const dx = x - ox;
      const dz = z - oz;
      const dy = y + 512;
      if (dx < 0 || dx > 4095 || dz < 0 || dz > 4095 || dy < 0 || dy > 1023) return grid.solid(x, y, z);
      const k = (dx * 4096 + dz) * 1024 + dy;
      let s = memo.get(k);
      if (s === undefined) {
        s = grid.solid(x, y, z);
        memo.set(k, s);
      }
      return s;
    },
  };
}

/**
 * Track F9e: the first half of `drawExits`: the flood and the lines drawn from it, not rolled (a roll of a long line
 * costs as much as a proof's simulation; the takeoff rolls and proves them one after another and stops at the first that
 * clears: route/takeoff.ts). In the order they are tried: the flood's cheapest way first, of its lines the widest berth
 * first. `grid` is the remembering grid they were drawn on, for the rolls.
 */
export function drawWays(grid: RouteGrid, from: Vec3, top: number, o: { radius?: number; max?: number; exits?: number; apart?: number; burn?: BurnRange } = {}): { drafts: DrawnDraft[]; grid: RouteGrid; cells: number; ways: number; tried: string[]; why?: string } {
  const g = rememberedGrid(grid, from);
  const flood = floodOut(g, from, top, o);
  const tried: string[] = [];
  if (!flood.ways.length) return { drafts: [], grid: g, cells: flood.cells, ways: 0, tried, why: `no way under the roof to the open sky (a flood of ${flood.cells} cells, within ${o.radius ?? DRAW_RADIUS})` };
  const drafts: DrawnDraft[] = [];
  for (const way of flood.ways) {
    const seen: string[] = [];
    let none = false;
    // (each berth twice: the heights kept clear of what is beside the line, and by the floor and the roof alone)
    for (const [berth, beside] of DRAW_BERTHS.flatMap((b) => [[b, true], [b, false]] as const)) {
      if (none) break;
      const at = `the way to ${way.x - Math.floor(from.x)} ${way.y - Math.floor(from.y + 1e-6)} ${way.z - Math.floor(from.z)} from here (${way.steps} cells), a berth of ${berth}${beside ? '' : ' over the floor and under the roof'}`;
      const drawn = drawLine(g, from, way, top, berth, beside);
      if (typeof drawn === 'string') {
        tried.push(`${at}: ${drawn}`);
        none = true;
        continue;
      }
      // (a narrower berth that pulls the same line is no other candidate)
      const sig = drawn.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`).join(';');
      if (seen.includes(sig)) continue;
      seen.push(sig);
      const p1 = drawn.points[Math.min(drawn.points.length - 1, 4)]!;
      const guide: Guide = { path: `drawn ${drafts.length + 1}`, flight: 0, points: drawn.points, ticks: drawn.points.map((_p, i) => i), rockets: [{ tick: DRAW_ROCKET_TICK, at: 1 }], yaw: yawOf(p1.x - from.x, p1.z - from.z), grounded: true, landed: false, drawn: true, speeds: lineSpeeds(drawn.points), ...(o.burn ? { burn: o.burn } : {}) };
      drafts.push({ guide, open: drawn.open, exit: { x: way.x, y: way.y, z: way.z }, steps: way.steps, berth, at });
    }
  }
  return { drafts, grid: g, cells: flood.cells, ways: flood.ways.length, tried };
}

/** Track F9e: a drawn line rolled (`rollLine` at the nominal burn): the line with the roll's ticks, or the words for why it is no line a glide can fly. */
export function rollDraft(grid: RouteGrid, d: DrawnDraft, top: number): DrawnLine | string {
  const roll = rollLine(grid, d.guide, d.open, { top });
  if (!roll.ok) return `${d.at}: ${guideLength(d.guide).toFixed(0)} blocks drawn, no line a glide can fly (${roll.why ?? '?'})`;
  return { guide: { ...d.guide, ticks: roll.ticks }, open: d.open, exit: d.exit, steps: d.steps, berth: d.berth, room: roll.room, ticks: roll.openTick, rockets: roll.rockets.filter((r) => r.at <= d.open).length };
}
