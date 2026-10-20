// A* over the block grid (PLAN.md task 3.5). Nodes are feet cells (see grid.ts). Moves:
//   walk  - 4 cardinal neighbours, feet height change within the 0.5625 auto-step (slabs, carpets).
//           Cost 1.
//   diag  - 4 diagonal neighbours on exactly the same feet height, both side cells standable at it
//           (no corner clipping, no drops at corners). Cost sqrt 2.
//   jump  - cardinal, up by more than the step height and at most 1.25 (jump apex 1.2522), with
//           head room for the jump above the start. Cost 2.
//   drop  - cardinal, walk off an edge and fall up to 3 blocks (no fall damage up to 3). Cost = blocks
//           fallen (1..3), at least the walk cost.
// Water, lava and hazards are never entered; standing on leaves / slow blocks costs extra
// (TerrainClass.penalty). Digging is off: `digCost` is the hook for a later "dig through" move.
import { PHYSICS } from '../input/physics.ts';
import { goalTest, type Goal } from './goals.ts';
import { cellKey, type NavGrid } from './grid.ts';

export type MoveKind = 'start' | 'walk' | 'diag' | 'jump' | 'drop';

export interface PathNode {
  x: number;
  y: number;
  z: number;
  /** Feet height when standing in this node. */
  feet: number;
  /** How this node is entered from the previous one. */
  move: MoveKind;
}

export interface PathCosts {
  walk: number;
  diag: number;
  jump: number;
  /** Cost per block fallen (a drop of n blocks costs n * drop, at least `walk`). */
  drop: number;
  /** Highest fall the planner takes (blocks). */
  maxDrop: number;
  /** Cost of breaking a block in the way; Infinity = digging off (the default). Hook only, not used yet. */
  digCost: number;
}

export const DEFAULT_COSTS: Readonly<PathCosts> = Object.freeze({ walk: 1, diag: Math.SQRT2, jump: 2, drop: 1, maxDrop: 3, digCost: Infinity });

export interface PathOptions {
  costs?: Partial<PathCosts>;
  /** Give up after expanding this many nodes and return the best partial path. Default 40 000. */
  maxNodes?: number;
  /** Wall-clock budget in ms (checked every 256 expansions). Default 250. */
  maxMs?: number;
}

export interface PathResult {
  /**
   * found: ends at the goal. partial: ends at the node closest to the goal (search limit hit, or the
   * search touched unloaded world). none: the goal cannot be reached from the start (exhaustive), or
   * the start is not standable.
   */
  status: 'found' | 'partial' | 'none';
  /** Start node first. Empty when the start is not standable. */
  path: PathNode[];
  cost: number;
  expanded: number;
  ms: number;
}

/** Highest feet rise a jump can take (apex of a standing jump is 1.2522). */
export const MAX_JUMP_RISE = 1.25;
const STEP = PHYSICS.stepHeight + 1e-6;
const FLAT = 1e-6;

const CARDINAL: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIAGONAL: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const M_WALK = 1;
const M_DIAG = 2;
const M_JUMP = 3;
const M_DROP = 4;
const MOVE_CODES: readonly MoveKind[] = ['start', 'walk', 'diag', 'jump', 'drop'];

/** Binary min-heap of node indices keyed by f. */
class Heap {
  private items = new Int32Array(1024);
  private keys = new Float64Array(1024);
  size = 0;

  push(i: number, f: number): void {
    if (this.size === this.items.length) {
      const items = new Int32Array(this.size * 2);
      items.set(this.items);
      this.items = items;
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
    }
    let n = this.size++;
    while (n > 0) {
      const parent = (n - 1) >> 1;
      if (this.keys[parent]! <= f) break;
      this.items[n] = this.items[parent]!;
      this.keys[n] = this.keys[parent]!;
      n = parent;
    }
    this.items[n] = i;
    this.keys[n] = f;
  }

  pop(): number {
    const top = this.items[0]!;
    const last = --this.size;
    const item = this.items[last]!;
    const key = this.keys[last]!;
    let n = 0;
    for (;;) {
      let c = 2 * n + 1;
      if (c >= last) break;
      if (c + 1 < last && this.keys[c + 1]! < this.keys[c]!) c++;
      if (this.keys[c]! >= key) break;
      this.items[n] = this.items[c]!;
      this.keys[n] = this.keys[c]!;
      n = c;
    }
    this.items[n] = item;
    this.keys[n] = key;
    return top;
  }
}

function grown<T extends Int32Array | Float64Array | Uint8Array>(a: T, make: (n: number) => T): T {
  const b = make(a.length * 2);
  b.set(a);
  return b;
}

/** Node arrays (struct of arrays) that grow on demand. */
class Nodes {
  n = 0;
  x = new Int32Array(4096);
  y = new Int32Array(4096);
  z = new Int32Array(4096);
  feet = new Float64Array(4096);
  g = new Float64Array(4096);
  parent = new Int32Array(4096);
  move = new Uint8Array(4096);
  closed = new Uint8Array(4096);

  add(x: number, y: number, z: number, feet: number): number {
    if (this.n === this.x.length) {
      this.x = grown(this.x, (k) => new Int32Array(k));
      this.y = grown(this.y, (k) => new Int32Array(k));
      this.z = grown(this.z, (k) => new Int32Array(k));
      this.feet = grown(this.feet, (k) => new Float64Array(k));
      this.g = grown(this.g, (k) => new Float64Array(k));
      this.parent = grown(this.parent, (k) => new Int32Array(k));
      this.move = grown(this.move, (k) => new Uint8Array(k));
      this.closed = grown(this.closed, (k) => new Uint8Array(k));
    }
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.feet[i] = feet;
    this.g[i] = Infinity;
    this.parent[i] = -1;
    this.closed[i] = 0;
    return i;
  }
}

const isFeet = (f: number | undefined): f is number => f !== undefined && !Number.isNaN(f);

/**
 * Finds a path from the start node to the goal. The start must be a standable node (see
 * `locateNode`); otherwise the result is `none` with an empty path.
 */
export function findPath(grid: NavGrid, start: { x: number; y: number; z: number }, goal: Goal, opts: PathOptions = {}): PathResult {
  const t0 = performance.now();
  const costs: PathCosts = { ...DEFAULT_COSTS, ...opts.costs };
  const maxNodes = opts.maxNodes ?? 40_000;
  const maxMs = opts.maxMs ?? 250;
  const test = goalTest(goal);
  const nodes = new Nodes();
  const index = new Map<number, number>();
  const open = new Heap();

  const startFeet = grid.stand(start.x, start.y, start.z);
  if (!isFeet(startFeet)) return { status: 'none', path: [], cost: 0, expanded: 0, ms: performance.now() - t0 };
  const s = nodes.add(start.x, start.y, start.z, startFeet);
  nodes.g[s] = 0;
  index.set(cellKey(start.x, start.y, start.z), s);
  open.push(s, test.h(start.x, start.y, start.z));
  let best = s;
  let bestH = Infinity;
  let found = -1;
  let expanded = 0;
  let limited = false;
  let sawUnknown = false;

  const relax = (from: number, x: number, y: number, z: number, feet: number, cost: number, move: number): void => {
    const k = cellKey(x, y, z);
    let i = index.get(k);
    if (i === undefined) {
      i = nodes.add(x, y, z, feet);
      index.set(k, i);
    } else if (nodes.closed[i]) {
      return;
    }
    const g = nodes.g[from]! + cost + grid.penalty(x, y, z, feet);
    if (g >= nodes.g[i]!) return;
    nodes.g[i] = g;
    nodes.parent[i] = from;
    nodes.move[i] = move;
    open.push(i, g + test.h(x, y, z));
  };

  while (open.size > 0) {
    const cur = open.pop();
    if (nodes.closed[cur]) continue;
    nodes.closed[cur] = 1;
    const cx = nodes.x[cur]!;
    const cy = nodes.y[cur]!;
    const cz = nodes.z[cur]!;
    const f0 = nodes.feet[cur]!;
    if (test.done(cx, cy, cz, f0)) {
      found = cur;
      break;
    }
    const h = test.h(cx, cy, cz);
    if (h < bestH || (h === bestH && nodes.g[cur]! < nodes.g[best]!)) {
      bestH = h;
      best = cur;
    }
    if (++expanded >= maxNodes || ((expanded & 255) === 0 && performance.now() - t0 > maxMs)) {
      limited = true;
      break;
    }
    const headCell = Math.floor(f0 + PHYSICS.height - 1e-6);

    for (const [dx, dz] of CARDINAL) {
      const nx = cx + dx;
      const nz = cz + dz;
      // Same cell level or one up: walking, auto-steps (slabs), jumps.
      let took = false;
      for (let ny = cy; ny <= cy + 1 && !took; ny++) {
        const f1 = grid.stand(nx, ny, nz);
        if (f1 === undefined) {
          sawUnknown = true;
          continue;
        }
        if (Number.isNaN(f1)) continue;
        const rise = f1 - f0;
        if (rise <= STEP) {
          relax(cur, nx, ny, nz, f1, costs.walk, rise < -STEP ? M_DROP : M_WALK);
          took = true;
        } else if (rise <= MAX_JUMP_RISE + 1e-6) {
          // head room above the start: the body must rise to the target's feet height
          const apexHead = Math.floor(f1 + PHYSICS.height - 1e-6);
          const room = grid.freeColumn(cx, headCell + 1, apexHead, cz);
          if (room === true) relax(cur, nx, ny, nz, f1, costs.jump, M_JUMP);
          else if (room === undefined) sawUnknown = true;
          took = true;
        } else {
          took = true; // a wall: no drop either
        }
      }
      if (took) continue;
      // Drop: the target column must be free from the current feet cell up to the head.
      const free0 = grid.freeColumn(nx, cy, Math.max(headCell, cy + 1), nz);
      if (free0 !== true) {
        if (free0 === undefined) sawUnknown = true;
        continue;
      }
      for (let d = 1; d <= costs.maxDrop; d++) {
        const ny = cy - d;
        const f1 = grid.stand(nx, ny, nz);
        if (f1 === undefined) {
          sawUnknown = true;
          break;
        }
        if (!Number.isNaN(f1)) {
          const fall = f0 - f1;
          if (fall <= costs.maxDrop + 1e-6) relax(cur, nx, ny, nz, f1, Math.max(costs.walk, Math.ceil(fall - 1e-6) * costs.drop), M_DROP);
          break;
        }
        if (grid.free(nx, ny, nz) !== true) break; // only fall through free cells
      }
    }

    for (const [dx, dz] of DIAGONAL) {
      const nx = cx + dx;
      const nz = cz + dz;
      const f1 = grid.stand(nx, cy, nz);
      if (f1 === undefined) {
        sawUnknown = true;
        continue;
      }
      if (Number.isNaN(f1) || Math.abs(f1 - f0) > FLAT) continue;
      const a = grid.stand(nx, cy, cz);
      if (!isFeet(a) || Math.abs(a - f0) > FLAT) continue;
      const b = grid.stand(cx, cy, nz);
      if (!isFeet(b) || Math.abs(b - f0) > FLAT) continue;
      relax(cur, nx, cy, nz, f1, costs.diag, M_DIAG);
    }
  }

  const end = found >= 0 ? found : best;
  const path: PathNode[] = [];
  for (let i = end; i >= 0; i = nodes.parent[i]!) {
    path.push({ x: nodes.x[i]!, y: nodes.y[i]!, z: nodes.z[i]!, feet: nodes.feet[i]!, move: MOVE_CODES[nodes.move[i]!]! });
  }
  path.reverse();
  path[0]!.move = 'start';
  const status = found >= 0 ? 'found' : limited || sawUnknown ? 'partial' : 'none';
  return { status, path, cost: nodes.g[end]!, expanded, ms: performance.now() - t0 };
}

export interface LocatedNode {
  x: number;
  y: number;
  z: number;
  feet: number;
}

/**
 * The node a body with feet `pos` stands in: its own cell if standable at about that height, else the
 * nearest standable cell under its footprint (the body hangs over an edge). undefined when none.
 */
export function locateNode(grid: NavGrid, pos: { x: number; y: number; z: number }): LocatedNode | undefined {
  const y0 = Math.floor(pos.y + 1e-3);
  const bx = Math.floor(pos.x);
  const bz = Math.floor(pos.z);
  let bestNode: LocatedNode | undefined;
  let bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const y of [y0, y0 - 1, y0 + 1]) {
        const x = bx + dx;
        const z = bz + dz;
        const f = grid.stand(x, y, z);
        if (!isFeet(f) || Math.abs(f - pos.y) > 0.6) continue;
        // horizontal distance from the body centre to the cell (0 inside it)
        const ddx = Math.max(x - pos.x, 0, pos.x - (x + 1));
        const ddz = Math.max(z - pos.z, 0, pos.z - (z + 1));
        const d = Math.hypot(ddx, ddz) + Math.abs(f - pos.y) * 0.01;
        if (d < bestD) {
          bestD = d;
          bestNode = { x, y, z, feet: f };
        }
      }
    }
  }
  return bestD < 0.75 ? bestNode : undefined;
}
