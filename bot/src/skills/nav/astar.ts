// A* over the block grid (PLAN.md tasks 3.5, 7.1, 7.2). Nodes are feet cells (see grid.ts); every
// move costs ticks (costs.ts). Moves:
//   walk   - 4 cardinal neighbours, feet height change within the 0.5625 auto-step (slabs, carpets).
//            Through a doorway when the door / gate is out of the way, or can be toggled (`allowOpen`).
//            With `allowBreak`: through 1 or 2 blocks that are broken first (dig-through).
//   diag   - 4 diagonal neighbours on exactly the same feet height, both side cells standable at it.
//   jump   - cardinal, up by more than the step height and at most 1.25, head room above the start.
//   drop   - cardinal, walk off an edge and fall up to `maxDrop` (3) blocks.
//   pillar - straight up one block: jump and place a throwaway block under the feet (`allowPlace`).
// Cost of a move into node B = base ticks x B's floor factor (leaves, soul sand, ice) + `underground`
// when B has a roof above the head + `irreversibleDrop` for a drop higher than a jump + break / place
// / door ticks. Heuristic: costs.walk x octile distance (admissible: no move is cheaper per block).
//
// `PathSearch` runs in slices (`step(ms)`) so the navigator never blocks a tick for long;
// `findPath` runs one to the end.
import type { Vec3 } from '../../world/types.ts';
import { breakTicks as tableBreakTicks } from '../dig/breakTime.ts';
import { PHYSICS } from '../input/physics.ts';
import type { TerrainClass } from '../terrain/classify.ts';
import { breakBlocker, type BreakRules, type NavBlockFace } from './actions.ts';
import { DEFAULT_COSTS, dropCost, type PathCosts } from './costs.ts';
import { goalTest, type NavGoal, type GoalTest } from './goals.ts'; // Track R: NavGoal (task 7.10 goal types)
import { CROSS_BLOCKED, CROSS_TOGGLE, cellKey, type NavGrid } from './grid.ts';

export type { PathCosts } from './costs.ts';
export { DEFAULT_COSTS } from './costs.ts';

export type MoveKind = 'start' | 'walk' | 'diag' | 'jump' | 'drop' | 'pillar';

/** World changes a move needs before (dig, use) or while (place) it is walked. */
export interface NodeActions {
  /** Cells to break before the move, in order (the higher one first). */
  dig?: Vec3[];
  /** Doors / gates (lower half) to toggle before the move, if still in the way when it starts. */
  use?: Vec3[];
  /** Pillar-up: the block placed in cell `p` while jumping (clicking the neighbour across `face`). */
  place?: { p: Vec3; face: NavBlockFace };
}

export interface PathNode {
  x: number;
  y: number;
  z: number;
  /** Feet height when standing in this node. */
  feet: number;
  /** How this node is entered from the previous one. */
  move: MoveKind;
  /** Estimated ticks of the move into this node (0 for the start). */
  cost: number;
  act?: NodeActions;
}

export interface PathOptions {
  costs?: Partial<PathCosts>;
  /** Give up after expanding this many nodes and return the best partial path. Default 40 000. */
  maxNodes?: number;
  /** Search-time budget in ms (summed over slices; checked every 64 expansions). Default 250. */
  maxMs?: number;
  /** Plan dig-through moves (needs a dig action). Default false. */
  allowBreak?: boolean;
  /** Plan pillar-up moves (needs a place action and throwaway blocks). Default false. */
  allowPlace?: boolean;
  /** Plan through closed doors and gates (needs a use action). Default false. */
  allowOpen?: boolean;
  /** Ticks to break a block with the best tool at hand (Infinity = cannot). Default: the break-time table with an empty hand. */
  breakTicks?: (c: TerrainClass) => number;
  /** Extra blocks never to break (containers, beds and the like never are). */
  protectedBlocks?: BreakRules['protectedBlocks'];
  /** Cells (cellKey) not to break (a dig there failed). */
  noBreak?: ReadonlySet<number>;
  /** Track S: extra ticks (>= 0) for a move that ends in feet cell (x, y, z): mob / spawner avoidance (nav/avoidance.ts). */
  cellCost?: (x: number, y: number, z: number) => number;
  /** Track R: cells (cellKey) not to pillar in / doors (lower half) not to open (blacklisted place / use failures). */
  noAction?: ReadonlySet<number>;
}

export interface PathResult {
  /**
   * found: ends at the goal. partial: ends at the best node towards the goal (search limit hit, or
   * the search touched unloaded world). none: the goal cannot be reached from the start
   * (exhaustive), or the start is not standable.
   */
  status: 'found' | 'partial' | 'none';
  /** Start node first. Empty when the start is not standable. */
  path: PathNode[];
  /** Ticks (estimate). */
  cost: number;
  expanded: number;
  /** Search time in ms (the sum of the slices). */
  ms: number;
  /** The search touched unloaded cells. */
  unknown: boolean;
  /** The search stopped at maxNodes / maxMs. */
  limited: boolean;
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
const M_PILLAR = 5;
const MOVE_CODES: readonly MoveKind[] = ['start', 'walk', 'diag', 'jump', 'drop', 'pillar'];
/** Node flag: the node stands in a doorway (only cardinal walks leave it). */
const F_PASSAGE = 1;

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
  /** Cost of the move into the node. */
  mc = new Float64Array(4096);
  /** Accumulated irreversible-drop penalty (partial path choice). */
  trap = new Float64Array(4096);
  parent = new Int32Array(4096);
  move = new Uint8Array(4096);
  flags = new Uint8Array(4096);
  closed = new Uint8Array(4096);
  /** Actions of the move into the node (sparse). */
  act: (NodeActions | undefined)[] = [];

  add(x: number, y: number, z: number, feet: number): number {
    if (this.n === this.x.length) {
      this.x = grown(this.x, (k) => new Int32Array(k));
      this.y = grown(this.y, (k) => new Int32Array(k));
      this.z = grown(this.z, (k) => new Int32Array(k));
      this.feet = grown(this.feet, (k) => new Float64Array(k));
      this.g = grown(this.g, (k) => new Float64Array(k));
      this.mc = grown(this.mc, (k) => new Float64Array(k));
      this.trap = grown(this.trap, (k) => new Float64Array(k));
      this.parent = grown(this.parent, (k) => new Int32Array(k));
      this.move = grown(this.move, (k) => new Uint8Array(k));
      this.flags = grown(this.flags, (k) => new Uint8Array(k));
      this.closed = grown(this.closed, (k) => new Uint8Array(k));
    }
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.feet[i] = feet;
    this.g[i] = Infinity;
    this.mc[i] = 0;
    this.trap[i] = 0;
    this.parent[i] = -1;
    this.flags[i] = 0;
    this.closed[i] = 0;
    return i;
  }
}

const isFeet = (f: number | undefined): f is number => f !== undefined && !Number.isNaN(f);

/** Break ticks from the break-time table with an empty hand. */
export function handBreakTicks(c: TerrainClass): number {
  return tableBreakTicks(c.name, null) ?? Infinity;
}

/** A resumable A* search (run it with `step` until it returns a result). */
export class PathSearch {
  readonly grid: NavGrid;
  readonly goal: NavGoal;
  private readonly costs: PathCosts;
  private readonly opts: PathOptions;
  private readonly test: GoalTest;
  private readonly maxNodes: number;
  private readonly maxMs: number;
  private readonly breakTicksOf: (c: TerrainClass) => number;
  private readonly nodes = new Nodes();
  private readonly index = new Map<number, number>();
  private readonly open = new Heap();
  private best = -1;
  private bestScore = Infinity;
  private found = -1;
  private expanded = 0;
  private limited = false;
  private sawUnknown = false;
  private ms = 0;
  private done: PathResult | undefined;

  constructor(grid: NavGrid, start: { x: number; y: number; z: number }, goal: NavGoal, opts: PathOptions = {}) {
    this.grid = grid;
    this.goal = goal;
    this.opts = opts;
    this.costs = { ...DEFAULT_COSTS, ...opts.costs };
    this.test = goalTest(goal, grid); // Track R: getToBlock / surface read the grid
    this.maxNodes = opts.maxNodes ?? 40_000;
    this.maxMs = opts.maxMs ?? 250;
    this.breakTicksOf = opts.breakTicks ?? handBreakTicks;
    const t0 = performance.now();
    let startFeet = grid.stand(start.x, start.y, start.z);
    let flags = 0;
    if (!isFeet(startFeet)) {
      const through = grid.standThrough(start.x, start.y, start.z);
      if (isFeet(through)) {
        startFeet = through;
        flags = F_PASSAGE;
      }
    }
    if (!isFeet(startFeet)) {
      this.done = { status: 'none', path: [], cost: 0, expanded: 0, ms: performance.now() - t0, unknown: false, limited: false };
      return;
    }
    const s = this.nodes.add(start.x, start.y, start.z, startFeet);
    this.nodes.g[s] = 0;
    this.nodes.flags[s] = flags;
    this.index.set(cellKey(start.x, start.y, start.z), s);
    this.open.push(s, this.h(start.x, start.y, start.z));
    this.best = s;
    this.ms = performance.now() - t0;
  }

  get finished(): boolean {
    return this.done !== undefined;
  }

  /** Nodes expanded so far. */
  get expandedCount(): number {
    return this.expanded;
  }

  /** Search time used so far (ms). */
  get elapsedMs(): number {
    return this.ms;
  }

  private h(x: number, y: number, z: number): number {
    return this.test.h(x, y, z) * this.costs.walk;
  }

  /**
   * Run for at most `sliceMs` (checked every 64 expansions). Returns the result once the search is
   * over (goal found, exhausted, or a limit hit), else undefined.
   */
  step(sliceMs = Infinity): PathResult | undefined {
    if (this.done) return this.done;
    const t0 = performance.now();
    const nodes = this.nodes;
    let n = 0;
    while (this.open.size > 0) {
      if ((++n & 63) === 0) {
        const now = performance.now();
        if (this.ms + (now - t0) > this.maxMs) {
          this.limited = true;
          break;
        }
        if (now - t0 >= sliceMs) {
          this.ms += now - t0;
          return undefined;
        }
      }
      const cur = this.open.pop();
      if (nodes.closed[cur]) continue;
      nodes.closed[cur] = 1;
      const cx = nodes.x[cur]!;
      const cy = nodes.y[cur]!;
      const cz = nodes.z[cur]!;
      const f0 = nodes.feet[cur]!;
      if (this.test.done(cx, cy, cz, f0)) {
        this.found = cur;
        break;
      }
      const score = this.h(cx, cy, cz) + nodes.trap[cur]!;
      if (score < this.bestScore || (score === this.bestScore && nodes.g[cur]! < nodes.g[this.best]!)) {
        this.bestScore = score;
        this.best = cur;
      }
      if (++this.expanded >= this.maxNodes) {
        this.limited = true;
        break;
      }
      this.expand(cur, cx, cy, cz, f0);
    }
    this.ms += performance.now() - t0;
    return this.finish();
  }

  /** Stop now and return the best path so far (partial unless the goal was reached). */
  stop(): PathResult {
    if (this.done) return this.done;
    this.limited = true;
    return this.finish();
  }

  private finish(): PathResult {
    const nodes = this.nodes;
    const end = this.found >= 0 ? this.found : this.best;
    const path: PathNode[] = [];
    for (let i = end; i >= 0; i = nodes.parent[i]!) {
      const node: PathNode = { x: nodes.x[i]!, y: nodes.y[i]!, z: nodes.z[i]!, feet: nodes.feet[i]!, move: MOVE_CODES[nodes.move[i]!]!, cost: nodes.mc[i]! };
      const act = nodes.act[i];
      if (act) node.act = act;
      path.push(node);
    }
    path.reverse();
    path[0]!.move = 'start';
    path[0]!.cost = 0;
    delete path[0]!.act;
    const status = this.found >= 0 ? 'found' : this.limited || this.sawUnknown ? 'partial' : 'none';
    this.done = { status, path, cost: nodes.g[end]!, expanded: this.expanded, ms: this.ms, unknown: this.sawUnknown, limited: this.limited };
    return this.done;
  }

  private relax(from: number, x: number, y: number, z: number, feet: number, base: number, move: number, extra = 0, trap = 0, act?: NodeActions, flags = 0): void {
    const nodes = this.nodes;
    const grid = this.grid;
    const k = cellKey(x, y, z);
    let i = this.index.get(k);
    if (i !== undefined && nodes.closed[i]) return;
    let cost = base * grid.factor(x, y, z, feet) + extra + trap;
    if (this.costs.underground > 0 && grid.underground(x, z, feet)) cost += this.costs.underground;
    if (this.opts.cellCost) cost += this.opts.cellCost(x, y, z); // Track S: avoidance
    const g = nodes.g[from]! + cost;
    if (i === undefined) {
      i = nodes.add(x, y, z, feet);
      this.index.set(k, i);
    } else if (g >= nodes.g[i]!) {
      return;
    }
    nodes.g[i] = g;
    nodes.mc[i] = cost;
    nodes.trap[i] = nodes.trap[from]! + trap;
    nodes.parent[i] = from;
    nodes.move[i] = move;
    nodes.flags[i] = flags;
    nodes.act[i] = act;
    this.open.push(i, g + this.h(x, y, z));
  }

  private expand(cur: number, cx: number, cy: number, cz: number, f0: number): void {
    const grid = this.grid;
    const costs = this.costs;
    const opts = this.opts;
    const inPassage = (this.nodes.flags[cur]! & F_PASSAGE) !== 0;
    const headCell = Math.floor(f0 + PHYSICS.height - 1e-6);
    const diag = costs.walk * Math.SQRT2;

    for (const [dx, dz] of CARDINAL) {
      const nx = cx + dx;
      const nz = cz + dz;
      const axis: 0 | 2 = dx !== 0 ? 0 : 2;
      // Same cell level or one up: walking, auto-steps (slabs), jumps.
      let took = false;
      let levelBlocked = false;
      for (let ny = cy; ny <= cy + 1 && !took; ny++) {
        const f1 = grid.stand(nx, ny, nz);
        if (f1 === undefined) {
          this.sawUnknown = true;
          continue;
        }
        if (Number.isNaN(f1)) {
          if (ny === cy) {
            levelBlocked = true;
            if (this.doorway(cur, cx, cy, cz, f0, nx, nz, axis)) took = true;
          }
          continue;
        }
        const rise = f1 - f0;
        if (rise <= STEP) {
          if (inPassage && !this.crossOut(cx, cy, cz, f0, axis)) {
            took = true;
            continue;
          }
          const down = rise < -STEP;
          this.relax(cur, nx, ny, nz, f1, down ? dropCost(costs, -rise) : costs.walk, down ? M_DROP : M_WALK);
          took = true;
        } else if (rise <= MAX_JUMP_RISE + 1e-6) {
          if (!inPassage) {
            // head room above the start: the body must rise to the target's feet height
            const apexHead = Math.floor(f1 + PHYSICS.height - 1e-6);
            const room = grid.freeColumn(cx, headCell + 1, apexHead, cz);
            if (room === true) this.relax(cur, nx, ny, nz, f1, costs.jump, M_JUMP);
            else if (room === undefined) this.sawUnknown = true;
          }
          took = true;
        } else {
          took = true; // a wall: no drop either
        }
      }
      if (levelBlocked && opts.allowBreak) this.digThrough(cur, cx, cy, cz, f0, nx, nz);
      if (took || inPassage) continue;
      // Drop: the target column must be free from the current feet cell up to the head.
      const free0 = grid.freeColumn(nx, cy, Math.max(headCell, cy + 1), nz);
      if (free0 !== true) {
        if (free0 === undefined) this.sawUnknown = true;
        continue;
      }
      for (let d = 1; d <= costs.maxDrop; d++) {
        const ny = cy - d;
        const f1 = grid.stand(nx, ny, nz);
        if (f1 === undefined) {
          this.sawUnknown = true;
          break;
        }
        if (!Number.isNaN(f1)) {
          const fall = f0 - f1;
          if (fall <= costs.maxDrop + 1e-6) {
            const trap = fall > MAX_JUMP_RISE + 1e-6 ? costs.irreversibleDrop : 0;
            this.relax(cur, nx, ny, nz, f1, dropCost(costs, fall), M_DROP, 0, trap);
          }
          break;
        }
        if (grid.free(nx, ny, nz) !== true) break; // only fall through free cells
      }
    }

    if (inPassage) return;

    for (const [dx, dz] of DIAGONAL) {
      const nx = cx + dx;
      const nz = cz + dz;
      const f1 = grid.stand(nx, cy, nz);
      if (f1 === undefined) {
        this.sawUnknown = true;
        continue;
      }
      if (Number.isNaN(f1) || Math.abs(f1 - f0) > FLAT) continue;
      const a = grid.stand(nx, cy, cz);
      if (!isFeet(a) || Math.abs(a - f0) > FLAT) continue;
      const b = grid.stand(cx, cy, nz);
      if (!isFeet(b) || Math.abs(b - f0) > FLAT) continue;
      this.relax(cur, nx, cy, nz, f1, diag, M_DIAG);
    }

    // Pillar-up: jump and place a block in the feet cell (full-block floors only).
    if (opts.allowPlace && Math.abs(f0 - cy) < FLAT && !opts.noAction?.has(cellKey(cx, cy, cz))) {
      const room = grid.freeColumn(cx, headCell + 1, headCell + 1, cz);
      if (room === true) {
        this.relax(cur, cx, cy + 1, cz, cy + 1, costs.jump, M_PILLAR, costs.place, 0, { place: { p: { x: cx, y: cy, z: cz }, face: 'down' } });
      } else if (room === undefined) {
        this.sawUnknown = true;
      }
    }
  }

  /** Leaving a doorway node along `axis`: its door / gate cells must let the body pass (or be toggled). */
  private crossOut(cx: number, cy: number, cz: number, f0: number, axis: 0 | 2): boolean {
    const top = Math.floor(f0 + PHYSICS.height - 1e-6);
    for (let y = cy; y <= top; y++) {
      const c = this.grid.crossing(cx, y, cz, axis);
      if (c === undefined || c === CROSS_BLOCKED) return false;
      if (c === CROSS_TOGGLE && !this.opts.allowOpen) return false;
    }
    return true;
  }

  /** A cardinal walk into (or through) a door / gate cell at the same level. Returns true when it was one. */
  private doorway(cur: number, cx: number, cy: number, cz: number, f0: number, nx: number, nz: number, axis: 0 | 2): boolean {
    const grid = this.grid;
    const f1 = grid.standThrough(nx, cy, nz);
    if (!isFeet(f1) || Math.abs(f1 - f0) > STEP) return false;
    if (!grid.hasPassage(nx, cy, f1, nz)) return false;
    const use: Vec3[] = [];
    const cells: [number, number, number, number][] = [];
    const topA = Math.floor(f0 + PHYSICS.height - 1e-6);
    for (let y = cy; y <= topA; y++) cells.push([cx, y, cz, 0]);
    const topB = Math.floor(f1 + PHYSICS.height - 1e-6);
    for (let y = cy; y <= topB; y++) cells.push([nx, y, nz, 1]);
    for (const [x, y, z] of cells) {
      const c = grid.crossing(x, y, z, axis);
      if (c === undefined) {
        this.sawUnknown = true;
        return true;
      }
      if (c === CROSS_BLOCKED) return true;
      if (c === CROSS_TOGGLE) {
        if (!this.opts.allowOpen) return true;
        const base = grid.passageBase(x, y, z);
        if (this.opts.noAction?.has(cellKey(base.x, base.y, base.z))) return true; // Track R: blacklisted door
        if (!use.some((u) => u.x === base.x && u.y === base.y && u.z === base.z)) use.push(base);
      }
    }
    this.relax(cur, nx, cy, nz, f1, this.costs.walk, M_WALK, use.length * this.costs.door, 0, use.length ? { use } : undefined, F_PASSAGE);
    return true;
  }

  /** Dig-through: walk into (nx, cy, nz) after breaking what fills its two body cells (full-block floors). */
  private digThrough(cur: number, cx: number, cy: number, cz: number, f0: number, nx: number, nz: number): void {
    if (Math.abs(f0 - cy) > FLAT) return; // the start stands on a full block: its body is cells cy, cy + 1
    const grid = this.grid;
    const below = grid.cls(nx, cy - 1, nz);
    if (!below) {
      this.sawUnknown = true;
      return;
    }
    if (!below.floor || below.top !== 1 || below.danger) return;
    const dig: Vec3[] = [];
    let ticks = 0;
    const floors = [
      { x: cx, y: cy - 1, z: cz },
      { x: nx, y: cy - 1, z: nz },
    ];
    for (const y of [cy + 1, cy]) {
      const c = grid.cls(nx, y, nz);
      if (!c) {
        this.sawUnknown = true;
        return;
      }
      if (c.boxes.length === 0 && !c.liquid && !c.danger) continue;
      if (this.opts.noBreak?.has(cellKey(nx, y, nz))) return;
      if (breakBlocker(grid, nx, y, nz, { protectedBlocks: this.opts.protectedBlocks }, floors) !== undefined) return;
      const t = this.breakTicksOf(c);
      if (!Number.isFinite(t)) return;
      ticks += t + this.costs.dig;
      dig.push({ x: nx, y, z: nz });
    }
    if (!dig.length) return;
    this.relax(cur, nx, cy, nz, cy, this.costs.walk, M_WALK, ticks, 0, { dig });
  }
}

/**
 * Finds a path from the start node to the goal in one go. The start must be a standable node (see
 * `locateNode`); otherwise the result is `none` with an empty path.
 */
export function findPath(grid: NavGrid, start: { x: number; y: number; z: number }, goal: NavGoal, opts: PathOptions = {}): PathResult {
  return new PathSearch(grid, start, goal, opts).step()!;
}

export interface LocatedNode {
  x: number;
  y: number;
  z: number;
  feet: number;
}

/**
 * The node a body with feet `pos` stands in: its own cell if standable at about that height, else the
 * nearest standable cell under its footprint (the body hangs over an edge). Doorways count. undefined
 * when none.
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
        let f = grid.stand(x, y, z);
        if (!isFeet(f) && f !== undefined) f = grid.standThrough(x, y, z);
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
