// A* over the block grid (PLAN.md tasks 3.5, 7.1, 7.2). Nodes are feet cells (see grid.ts); every
// move costs ticks (costs.ts). Moves:
//   walk   - 4 cardinal neighbours, feet height change within the 0.5625 auto-step (slabs, carpets).
//            Through a doorway when the door / gate is out of the way, or can be toggled (`allowOpen`).
//            With `allowBreak`: through 1 or 2 blocks that are broken first (dig-through).
//   diag   - 4 diagonal neighbours on exactly the same feet height, both side cells standable at it.
//   jump   - cardinal, up by more than the step height and at most 1.25, head room above the start.
//   drop   - cardinal, walk off an edge and fall up to `maxDrop` (3) blocks.
//   pillar - straight up one block: jump and place a throwaway block under the feet (`allowPlace`).
// Track AJ, movement variety (`moves`, docs/pathfinding.md "Movement variety"):
//   swim     - into still water (walk in, or drop up to 3 onto the surface), between surface cells
//              (8 neighbours), never under water.
//   swimOut  - from the surface onto a bank at the water level up to 1 block higher.
//   climb    - up / down a ladder or vine column, onto it from its foot, its side or its top.
//   climbOut - off a climber column onto a floor beside it, from its level up to 1 higher.
//   parkour  - over a 1-block gap (walking) or a 2-block gap (2-block sprinted run-up behind the
//              takeoff), landing at the same height or 1 lower; water or a floor within 3 below, no lava.
// Cost of a move into node B = base ticks x B's floor factor (leaves, soul sand, ice) + `underground`
// when B has a roof above the head + `irreversibleDrop` for a drop higher than a jump + break / place
// / door ticks. Heuristic: costs.walk x octile distance (admissible: no move is cheaper per block).
//
// `PathSearch` runs in slices (`step(ms)`) so the navigator never blocks a tick for long;
// `findPath` runs one to the end.
import type { Vec3 } from '../../world/types.ts';
import { breakTicks as tableBreakTicks } from '../dig/breakTime.ts';
import { PHYSICS } from '../input/physics.ts';
import { halfTop, type TerrainClass } from '../terrain/classify.ts';
import { breakBlocker, type BreakRules, type NavBlockFace } from './actions.ts';
import { BestSoFar, FAILURE_NODES_FACTOR } from './baritone/bestSoFar.ts'; // Track BA: partial-path selection (ported, LGPL-3.0)
import { DEFAULT_COSTS, dropCost, type PathCosts } from './costs.ts';
import { goalTest, type NavGoal, type GoalTest } from './goals.ts'; // Track R: NavGoal (task 7.10 goal types)
import { CROSS_BLOCKED, CROSS_TOGGLE, VARIETY_CLIMBER, VARIETY_LADDER, VARIETY_WATER, cellKey, type NavGrid } from './grid.ts';

export type { PathCosts } from './costs.ts';
export { DEFAULT_COSTS } from './costs.ts';

export type MoveKind = 'start' | 'walk' | 'diag' | 'jump' | 'drop' | 'pillar' | 'swim' | 'swimOut' | 'climb' | 'climbOut' | 'parkour'; // Track AJ: swim .. parkour

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
  /**
   * Track AJ: a parkour move: the takeoff node (the last floor before the gap), the gap's length (1
   * or 2 blocks) and whether the run-up is sprinted.
   */
  gap?: { x: number; y: number; z: number; length: number; sprint: boolean };
}

/** Track AJ: the movement-variety moves a search may use (all default true). */
export interface MoveSet {
  /** Swim on the surface of still water (enter, cross, climb out). */
  swim?: boolean;
  /** Climb ladders and vines up and down, mount and leave them. */
  climb?: boolean;
  /** Jump 1-block gaps at walking speed. */
  parkour1?: boolean;
  /** Jump 2-block gaps with a 2-block sprint run-up. */
  parkour2?: boolean;
}

export interface PathOptions {
  /** Track AJ: movement-variety moves (default: all on). */
  moves?: MoveSet;
  costs?: Partial<PathCosts>;
  /**
   * Give up after expanding this many nodes and return the best partial path. Default 40 000. Track
   * BA: up to 4 x this while no partial end 5+ blocks from the start is known (baritone/bestSoFar.ts).
   */
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
  /** The base around home: nothing is broken inside (BreakRules.protectedArea). */
  protectedArea?: BreakRules['protectedArea'];
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
   * the search touched unloaded world; Track BA: the first of Baritone's coefficient bests 5+ blocks
   * from the start, else the start alone with reason `no_progress`). none: the goal cannot be reached from the start
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
  /**
   * Track BA: `no_progress`: a partial search whose bests (baritone/bestSoFar.ts) are all within
   * MIN_DIST_PATH (5 blocks) of the start: the path is the start node alone (a failed plan, not a
   * path to follow).
   */
  reason?: 'no_progress';
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
const M_SWIM = 6; // Track AJ: movement variety
const M_SWIM_OUT = 7;
const M_CLIMB = 8;
const M_CLIMB_OUT = 9;
const M_PARKOUR = 10;
const MOVE_CODES: readonly MoveKind[] = ['start', 'walk', 'diag', 'jump', 'drop', 'pillar', 'swim', 'swimOut', 'climb', 'climbOut', 'parkour'];
/** Node flag: the node stands in a doorway (only cardinal walks leave it). */
const F_PASSAGE = 1;
/** Track AJ: node flags: swimming on the surface; climbing (feet in a climber cell, no floor). */
const F_SWIM = 2;
const F_CLIMB = 4;

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
  /** Track AJ: parkour takeoff of the move into the node (sparse). */
  gap: (PathNode['gap'] | undefined)[] = [];

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
  /** Track BA: the partial-path ends (Baritone's 7 coefficient bests, baritone/bestSoFar.ts). */
  private readonly bests = new BestSoFar();
  /** Track BA: the start node's index (the path of a `no_progress` result). */
  private startNode = -1;
  private found = -1;
  private expanded = 0;
  private limited = false;
  private sawUnknown = false;
  private ms = 0;
  private done: PathResult | undefined;
  /** Track AJ: the parkour takeoff the next relax() records (set around a parkour relax only). */
  private pendingGap: PathNode['gap'] = undefined;
  /** Track AJ: per cardinal direction of the node being expanded: a gap starts next to it. */
  private readonly holes = new Uint8Array(4);

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
    // Track AJ: a body on a ladder or swimming starts from a climb / swim node
    if (!isFeet(startFeet) && this.moveOn('climb')) {
      const c = grid.climb(start.x, start.y, start.z);
      if (isFeet(c)) {
        startFeet = c;
        flags = F_CLIMB;
      }
    }
    if (!isFeet(startFeet) && this.moveOn('swim')) {
      const w = grid.swim(start.x, start.y, start.z);
      if (isFeet(w)) {
        startFeet = w;
        flags = F_SWIM;
      }
    }
    if (!isFeet(startFeet)) {
      this.done = { status: 'none', path: [], cost: 0, expanded: 0, ms: performance.now() - t0, unknown: false, limited: false };
      return;
    }
    const s = this.nodes.add(start.x, start.y, start.z, startFeet);
    this.startNode = s; // Track BA
    this.nodes.g[s] = 0;
    this.nodes.flags[s] = flags;
    this.index.set(cellKey(start.x, start.y, start.z), s);
    this.open.push(s, this.h(start.x, start.y, start.z));
    this.bests.reset(s, start.x, start.y, start.z, this.h(start.x, start.y, start.z)); // Track BA
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

  /** Track AJ: the movement-variety move is enabled (PathOptions.moves, default on). */
  private moveOn(m: keyof MoveSet): boolean {
    return this.opts.moves?.[m] ?? true;
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
      // Track AJ: a goal is never reached swimming or hanging on a ladder (the body stops standing)
      if ((nodes.flags[cur]! & (F_SWIM | F_CLIMB)) === 0 && this.test.done(cx, cy, cz, f0)) {
        this.found = cur;
        break;
      }
      // Track BA: h + g / k + trap for Baritone's 7 coefficients (was: the lowest h + trap)
      this.bests.consider(cur, cx, cy, cz, this.h(cx, cy, cz), nodes.g[cur]!, nodes.trap[cur]!);
      // Track BA: while no best is 5+ blocks from the start (Baritone `failing`), on up to 4 x maxNodes
      if (++this.expanded >= this.maxNodes && (!this.bests.failing || this.expanded >= this.maxNodes * FAILURE_NODES_FACTOR)) {
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

  /**
   * Track AB: the best path so far without ending the search (partial unless the goal was reached);
   * the planner worker sends it as the interim answer of a long main plan.
   */
  peek(): PathResult {
    return this.done ?? this.build(true);
  }

  private finish(): PathResult {
    this.done = this.build(false);
    return this.done;
  }

  private build(interim: boolean): PathResult {
    const nodes = this.nodes;
    // Track BA: a partial path ends at the first coefficient best 5+ blocks from the start; with none,
    // the start alone (reason no_progress)
    const best = this.found >= 0 ? this.found : this.bests.best();
    const end = best >= 0 ? best : this.startNode;
    const path: PathNode[] = [];
    for (let i = end; i >= 0; i = nodes.parent[i]!) {
      const node: PathNode = { x: nodes.x[i]!, y: nodes.y[i]!, z: nodes.z[i]!, feet: nodes.feet[i]!, move: MOVE_CODES[nodes.move[i]!]!, cost: nodes.mc[i]! };
      const act = nodes.act[i];
      if (act) node.act = act;
      const gap = nodes.gap[i]; // Track AJ
      if (gap && node.move === 'parkour') node.gap = gap;
      path.push(node);
    }
    path.reverse();
    path[0]!.move = 'start';
    path[0]!.cost = 0;
    delete path[0]!.act;
    delete path[0]!.gap;
    const status = this.found >= 0 ? 'found' : interim || this.limited || this.sawUnknown ? 'partial' : 'none';
    const res: PathResult = { status, path, cost: nodes.g[end]!, expanded: this.expanded, ms: this.ms, unknown: this.sawUnknown, limited: interim || this.limited };
    if (status === 'partial' && best < 0) res.reason = 'no_progress'; // Track BA
    return res;
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
    if (this.pendingGap !== undefined || nodes.gap[i] !== undefined) nodes.gap[i] = this.pendingGap; // Track AJ
    this.open.push(i, g + this.h(x, y, z));
  }

  private expand(cur: number, cx: number, cy: number, cz: number, f0: number): void {
    const grid = this.grid;
    const costs = this.costs;
    const opts = this.opts;
    const flags0 = this.nodes.flags[cur]!;
    // Track AJ: swim and climb nodes have their own moves
    if (flags0 & F_SWIM) return this.expandSwim(cur, cx, cy, cz);
    if (flags0 & F_CLIMB) return this.expandClimb(cur, cx, cy, cz, f0);
    const inPassage = (flags0 & F_PASSAGE) !== 0;
    const headCell = Math.floor(f0 + PHYSICS.height - 1e-6);
    const diag = costs.walk * Math.SQRT2;
    // Track AJ: movement-variety checks only once the grid has classified water / climbers / ladders at
    // all (NavGrid.variety, read after the cells in question have been looked at, so the answer does not
    // depend on what an earlier search cached)
    const flat = Math.abs(f0 - cy) < FLAT;
    const holes = this.holes;
    holes.fill(0);

    for (let di = 0; di < 4; di++) {
      const [dx, dz] = CARDINAL[di]!;
      const nx = cx + dx;
      const nz = cz + dz;
      const axis: 0 | 2 = dx !== 0 ? 0 : 2;
      // Same cell level or one up: walking, auto-steps (slabs), jumps. Track AX: from a partial floor
      // high in its cell (a chest 0.95, a dirt path 0.9375: feet above cy + 0.75) a jump reaches the
      // floor two cells up (a full block in cy + 1), and a doorway one cell up is a step.
      let took = false;
      let levelBlocked = false;
      const topNy = Math.floor(f0 + MAX_JUMP_RISE + 1e-6); // Track AX: cy + 1 on a full block or a slab
      for (let ny = cy; ny <= topNy && !took; ny++) {
        const f1 = grid.stand(nx, ny, nz);
        if (f1 === undefined) {
          this.sawUnknown = true;
          continue;
        }
        if (Number.isNaN(f1)) {
          if (ny === cy) levelBlocked = true;
          // Track AX: a doorway at the feet level, or one cell up from a partial floor (a step of <= 0.5625)
          if ((ny === cy || (ny === cy + 1 && !flat)) && this.doorway(cur, cx, cy, cz, f0, nx, ny, nz, axis)) took = true;
          continue;
        }
        const rise = f1 - f0;
        if (rise <= STEP) {
          if (inPassage && !this.crossOut(cx, cy, cz, f0, axis)) {
            took = true;
            continue;
          }
          const down = rise < -STEP;
          if (this.ladderPass(cx, cy, cz, nx, nz, dx, dz, rise > FLAT)) this.relax(cur, nx, ny, nz, f1, down ? dropCost(costs, -rise) : costs.walk, down ? M_DROP : M_WALK);
          took = true;
        } else if (rise <= MAX_JUMP_RISE + 1e-6) {
          if (!inPassage && this.ladderPass(cx, cy, cz, nx, nz, dx, dz, true)) {
            // head room above the start: the body must rise to the target's feet height (a stairs
            // walk: the body is at the low half's height, at most 0.5625 lower, while it still
            // overlaps the start column)
            const apexHead = Math.floor(f1 + PHYSICS.height - 1e-6);
            const room = grid.freeColumn(cx, headCell + 1, apexHead, cz);
            if (room === true) {
              if (this.stepsUp(f0, nx, ny, nz, f1, dx, dz)) this.relax(cur, nx, ny, nz, f1, costs.walk + costs.stairs, M_WALK);
              else this.relax(cur, nx, ny, nz, f1, costs.jump, M_JUMP);
            } else if (room === undefined) this.sawUnknown = true;
          }
          took = true;
        } else {
          took = true; // a wall: no drop either
        }
      }
      if (levelBlocked && opts.allowBreak) this.digThrough(cur, cx, cy, cz, f0, nx, nz);
      if (inPassage && !took) {
        // Track AX: out of a doorway onto a floor a step lower in the cell below (a dirt path, farmland)
        const f1 = grid.stand(nx, cy - 1, nz);
        if (f1 === undefined) this.sawUnknown = true;
        else if (isFeet(f1) && f0 - f1 <= STEP && this.crossOut(cx, cy, cz, f0, axis)) this.relax(cur, nx, cy - 1, nz, f1, costs.walk, M_WALK);
      }
      if (took || inPassage) continue;
      // Track AJ: into water at the feet level, onto a ladder from its side
      if (levelBlocked) {
        if (this.varietyOn(VARIETY_CLIMBER, 'climb') && flat) {
          const c = grid.climb(nx, cy, nz);
          if (c === undefined) this.sawUnknown = true;
          else if (isFeet(c) && this.ladderPass(cx, cy, cz, nx, nz, dx, dz, false)) this.relax(cur, nx, cy, nz, c, costs.walk, M_CLIMB, costs.climbEnter, 0, undefined, F_CLIMB);
        }
      }
      // Drop: the target column must be free from the current feet cell up to the head.
      const free0 = grid.freeColumn(nx, cy, Math.max(headCell, cy + 1), nz);
      if (free0 !== true) {
        if (free0 === undefined) this.sawUnknown = true;
        // Track AJ: into water at the feet level (a water cell is not free)
        else if (levelBlocked && this.varietyOn(VARIETY_WATER, 'swim') && this.ladderPass(cx, cy, cz, nx, nz, dx, dz, false)) this.swimEntry(cur, nx, cy, nz, cy, headCell, 0);
        continue;
      }
      if (!this.ladderPass(cx, cy, cz, nx, nz, dx, dz, false)) continue;
      let landing = false; // Track AJ: a floor or water within the drop scan (a gap worth a parkour check)
      for (let d = 1; d <= costs.maxDrop; d++) {
        const ny = cy - d;
        const f1 = grid.stand(nx, ny, nz);
        if (f1 === undefined) {
          this.sawUnknown = true;
          break;
        }
        if (d === 1 && Number.isNaN(f1)) {
          holes[di] = 1; // Track AJ: no floor at or one below the feet level: a gap to jump
          // Track AJ: onto a ladder from its top (the slide stops on it)
          if (this.varietyOn(VARIETY_CLIMBER, 'climb') && flat) {
            const top = grid.climb(nx, ny, nz);
            if (isFeet(top)) this.relax(cur, nx, ny, nz, top, costs.walk + costs.climbDown, M_CLIMB, costs.climbEnter, 0, undefined, F_CLIMB);
          }
        }
        if (!Number.isNaN(f1)) {
          landing = true;
          const fall = f0 - f1;
          if (fall <= STEP) {
            // a step down into a lower cell (onto farmland, a dirt path, soul sand): a walk
            this.relax(cur, nx, ny, nz, f1, costs.walk, M_WALK);
          } else if (fall <= MAX_JUMP_RISE + 1e-6 && this.stepsDown(cx, cy, cz, f0, f1, dx, dz)) {
            // down a stairs block's low half: two steps of 0.5, a walk
            this.relax(cur, nx, ny, nz, f1, costs.walk + costs.stairs, M_WALK);
          } else if (fall <= costs.maxDrop + 1e-6) {
            const trap = fall > MAX_JUMP_RISE + 1e-6 ? costs.irreversibleDrop : 0;
            this.relax(cur, nx, ny, nz, f1, dropCost(costs, fall), M_DROP, 0, trap);
          }
          break;
        }
        if (grid.free(nx, ny, nz) !== true) {
          if (grid.cls(nx, ny, nz)?.liquid === 'water') landing = true;
          if (this.varietyOn(VARIETY_WATER, 'swim')) this.swimEntry(cur, nx, ny, nz, cy, headCell, d); // Track AJ: drop into water
          break; // only fall through free cells
        }
      }
      // Track AJ: nothing to land on within 3 (mid-air, a deep pit) and no water right below that: no
      // parkour (the scan above found the cells down to cy - 3 free when it ran to the end)
      if (holes[di] && !landing) holes[di] = (grid.variety & VARIETY_WATER) !== 0 && grid.cls(nx, cy - costs.maxDrop - 1, nz)?.liquid === 'water' ? 1 : 0;
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
      // Track AJ: no diagonal across a ladder's thin box
      if ((grid.variety & VARIETY_LADDER) !== 0 && (this.anyLadder(cx, cy, cz) || this.anyLadder(nx, cy, nz) || this.anyLadder(nx, cy, cz) || this.anyLadder(cx, cy, nz))) continue;
      this.relax(cur, nx, cy, nz, f1, diag, M_DIAG);
    }

    // Track AJ: climb up from the foot of a ladder (the feet cell is a climber, the floor below it)
    if (this.varietyOn(VARIETY_CLIMBER, 'climb') && grid.climbable(cx, cy, cz)) {
      const up = grid.climb(cx, cy + 1, cz);
      if (up === undefined) this.sawUnknown = true;
      else if (isFeet(up) && this.climbRoom(cx, cy + 1, cz)) this.relax(cur, cx, cy + 1, cz, up, costs.climbUp, M_CLIMB, 0, 0, undefined, F_CLIMB);
    }
    // Track AJ: parkour over the gaps found above
    if (flat) {
      for (let di = 0; di < 4; di++) {
        if (!holes[di]) continue;
        if (this.moveOn('parkour1')) this.parkour(cur, cx, cy, cz, f0, 1, di);
        if (this.moveOn('parkour2')) this.parkour(cur, cx, cy, cz, f0, 2, di);
      }
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

  // ---- Track AJ: movement variety (docs/pathfinding.md "Movement variety") -------------------------

  /** The grid has classified a cell of kind `bit` (NavGrid.variety) and the move is enabled. */
  private varietyOn(bit: number, move: keyof MoveSet): boolean {
    return (this.grid.variety & bit) !== 0 && this.moveOn(move);
  }

  /**
   * A cardinal walk from column (cx, cz) into (nx, nz) along (dx, dz) at cell level cy is not stopped
   * by a ladder's thin box in either column. Asked right before a relax, once the cells involved have
   * been classified (so NavGrid.variety is current); `high`: a rise, the body also passes cy + 2.
   */
  private ladderPass(cx: number, cy: number, cz: number, nx: number, nz: number, dx: number, dz: number, high: boolean): boolean {
    if (high) this.grid.cls(cx, cy + 2, cz);
    if ((this.grid.variety & VARIETY_LADDER) === 0) return true;
    return this.ladderLets(cx, cy, cz, dx, dz, false, high) && this.ladderLets(nx, cy, nz, dx, dz, true, high);
  }

  /** The body cells y .. y + 1 (y + 2 with `high`: a rise) of column (x, z) let a cardinal walk along (dx, dz) enter / leave past any ladder box. */
  private ladderLets(x: number, y: number, z: number, dx: number, dz: number, enter: boolean, high = true): boolean {
    for (let cy = y; cy <= y + (high ? 2 : 1); cy++) if (!this.grid.climberLets(x, cy, z, dx, dz, enter)) return false;
    return true;
  }

  /** A ladder (a climber with a box) in the body cells y, y + 1 of column (x, z). */
  private anyLadder(x: number, y: number, z: number): boolean {
    if ((this.grid.variety & VARIETY_LADDER) === 0) return false; // (the cells asked about have been classified)
    return this.grid.thinClimber(x, y, z) || this.grid.thinClimber(x, y + 1, z);
  }

  /**
   * Into water: from a standing node at cell level `cy` to the swim node (nx, ny, nz), `d` blocks
   * below (0: at the feet level). The column above the water up to the head must be free.
   */
  private swimEntry(cur: number, nx: number, ny: number, nz: number, cy: number, headCell: number, d: number): void {
    const grid = this.grid;
    const w = grid.swim(nx, ny, nz);
    if (w === undefined) {
      this.sawUnknown = true;
      return;
    }
    if (!isFeet(w)) return;
    const room = grid.freeColumn(nx, ny + 1, Math.max(headCell, cy + 1), nz);
    if (room === undefined) this.sawUnknown = true;
    if (room !== true) return;
    const costs = this.costs;
    this.relax(cur, nx, ny, nz, w, costs.walk + (d > 0 ? (costs.fall[d] ?? 0) : 0), M_SWIM, costs.swimEnter, 0, undefined, F_SWIM);
  }

  /** A climb into node (x, y, z) has head room: the cell above the body (y + 2) is passable. */
  private climbRoom(x: number, y: number, z: number): boolean {
    const f = this.grid.free(x, y + 2, z);
    if (f === undefined) this.sawUnknown = true;
    return f === true;
  }

  /** Moves of a swim node: swim to the 8 neighbours on the same surface, climb out onto a bank up to 1 higher. */
  private expandSwim(cur: number, cx: number, cy: number, cz: number): void {
    const grid = this.grid;
    const costs = this.costs;
    const swimAt = (x: number, z: number): boolean => {
      const w = grid.swim(x, cy, z);
      if (w === undefined) this.sawUnknown = true;
      return isFeet(w);
    };
    for (const [dx, dz] of CARDINAL) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (swimAt(nx, nz)) {
        this.relax(cur, nx, cy, nz, cy, costs.swim, M_SWIM, 0, 0, undefined, F_SWIM);
        continue;
      }
      // out: a bank from the water level up to 1 block higher
      for (let ny = cy; ny <= cy + 1; ny++) {
        const f1 = grid.stand(nx, ny, nz);
        if (f1 === undefined) {
          this.sawUnknown = true;
          break;
        }
        if (isFeet(f1)) {
          if (f1 >= cy - FLAT && f1 <= cy + 1 + FLAT) this.relax(cur, nx, ny, nz, f1, costs.swimOut, M_SWIM_OUT);
          break;
        }
      }
    }
    for (const [dx, dz] of DIAGONAL) {
      if (swimAt(cx + dx, cz + dz) && swimAt(cx + dx, cz) && swimAt(cx, cz + dz)) this.relax(cur, cx + dx, cy, cz + dz, cy, costs.swim * Math.SQRT2, M_SWIM, 0, 0, undefined, F_SWIM);
    }
  }

  /** Moves of a climb node: up and down the column, off it onto a floor beside it from its level up to 1 higher. */
  private expandClimb(cur: number, cx: number, cy: number, cz: number, f0: number): void {
    const grid = this.grid;
    const costs = this.costs;
    // up (the feet cell is a climber: the body is lifted while its feet are in it)
    const up = grid.climb(cx, cy + 1, cz);
    if (up === undefined) this.sawUnknown = true;
    else if (isFeet(up) && this.climbRoom(cx, cy + 1, cz)) this.relax(cur, cx, cy + 1, cz, up, costs.climbUp, M_CLIMB, 0, 0, undefined, F_CLIMB);
    // down: onto the floor at the foot of the ladder, or the next climber cell
    const foot = grid.stand(cx, cy - 1, cz);
    if (foot === undefined) this.sawUnknown = true;
    else if (isFeet(foot)) {
      if (foot <= f0 - 1 + STEP) this.relax(cur, cx, cy - 1, cz, foot, costs.climbDown, M_CLIMB);
    } else {
      const down = grid.climb(cx, cy - 1, cz);
      if (down === undefined) this.sawUnknown = true;
      else if (isFeet(down)) this.relax(cur, cx, cy - 1, cz, down, costs.climbDown, M_CLIMB, 0, 0, undefined, F_CLIMB);
    }
    // off: a floor beside the column from the feet level up to 1 higher
    for (const [dx, dz] of CARDINAL) {
      const nx = cx + dx;
      const nz = cz + dz;
      for (let ny = cy; ny <= cy + 1; ny++) {
        const f1 = grid.stand(nx, ny, nz);
        if (f1 === undefined) {
          this.sawUnknown = true;
          break;
        }
        if (!isFeet(f1)) continue;
        if (f1 < cy - FLAT || f1 > cy + 1 + FLAT) break;
        const lvl = Math.floor(f1 + 1e-6);
        if (!this.ladderLets(cx, lvl, cz, dx, dz, false) || !this.ladderLets(nx, lvl, nz, dx, dz, true)) break;
        if (f1 > cy + STEP && !this.climbRoom(cx, cy, cz)) break;
        this.relax(cur, nx, ny, nz, f1, costs.climbUp * Math.max(0, f1 - cy) + costs.walk, M_CLIMB_OUT, costs.climbExit);
        break;
      }
    }
  }

  /**
   * Parkour from the takeoff node (cx, cy, cz) along CARDINAL[di] over a gap of `g` blocks, landing on
   * a full block at the same height or 1 lower. g = 1 is jumped at walking speed; g = 2 needs 2
   * standable cells straight behind the takeoff (the follower backs up onto them for a sprinted
   * run-up when it arrives without speed). The gap must be clear up to the jump's head height, with
   * water or a floor at most 3 blocks below (no lava, no hazard, nothing reaching above the takeoff
   * level); the cell after the landing must stop an overshoot (a floor or a wall).
   */
  private parkour(cur: number, cx: number, cy: number, cz: number, f0: number, g: 1 | 2, di: number): void {
    const grid = this.grid;
    const costs = this.costs;
    const [dx, dz] = CARDINAL[di]!;
    // cheap first: a floor to land on, g + 1 blocks out, at the takeoff level or 1 below
    const lx0 = cx + (g + 1) * dx;
    const lz0 = cz + (g + 1) * dz;
    if (!isFeet(grid.stand(lx0, cy, lz0)) && !isFeet(grid.stand(lx0, cy - 1, lz0))) return;
    if (this.anyLadder(cx, cy, cz)) return;
    // the gap cells: no floor at the takeoff level (the first was found by the caller)
    if (g === 2) {
      const second = grid.stand(cx + 2 * dx, cy, cz + 2 * dz);
      if (second === undefined) this.sawUnknown = true;
      if (!(second !== undefined && Number.isNaN(second))) return;
      // the run-up behind the takeoff
      for (let k = 1; k <= 2; k++) {
        const f = grid.stand(cx - k * dx, cy, cz - k * dz);
        if (f === undefined) this.sawUnknown = true;
        if (!isFeet(f) || Math.abs(f - f0) >= FLAT || this.anyLadder(cx - k * dx, cy, cz - k * dz)) return;
      }
    }
    // head room over the takeoff
    const room = grid.freeColumn(cx, cy + 2, cy + 3, cz);
    if (room !== true) {
      if (room === undefined) this.sawUnknown = true;
      return;
    }
    for (let k = 1; k <= g; k++) {
      const gx = cx + k * dx;
      const gz = cz + k * dz;
      const col = grid.freeColumn(gx, cy, cy + 3, gz);
      if (col !== true) {
        if (col === undefined) this.sawUnknown = true;
        return;
      }
      const below = grid.cls(gx, cy - 1, gz);
      if (!below || below.top > 1 || !this.safeBelow(gx, cy - 1, gz)) return;
      if ((grid.variety & VARIETY_CLIMBER) !== 0 && (grid.climbable(gx, cy - 1, gz) || grid.climbable(gx, cy, gz) || grid.climbable(gx, cy + 1, gz))) return; // no ladder shaft under the flight
    }
    const lx = cx + (g + 1) * dx;
    const lz = cz + (g + 1) * dz;
    for (let ny = cy; ny >= cy - 1; ny--) {
      const f1 = grid.stand(lx, ny, lz);
      if (f1 === undefined) {
        this.sawUnknown = true;
        return;
      }
      if (!isFeet(f1)) continue;
      if (Math.abs(f1 - ny) >= FLAT || this.anyLadder(lx, ny, lz)) return;
      if (grid.freeColumn(lx, ny + 2, cy + 3, lz) !== true) return;
      if (!this.stopsOvershoot(lx + dx, ny, lz + dz, f1)) return;
      const air = ny === cy ? costs.parkourAir : costs.parkourAirDown;
      this.pendingGap = { x: cx, y: cy, z: cz, length: g, sprint: g === 2 };
      this.relax(cur, lx, ny, lz, f1, (g === 2 ? costs.parkourRunUp : 0) + g * costs.walk + air, M_PARKOUR, costs.parkourRisk);
      this.pendingGap = undefined;
      return;
    }
  }

  /** Below a gap column from y down: water, or a floor at most 3 blocks under the takeoff feet; never lava or a hazard. */
  private safeBelow(x: number, y: number, z: number): boolean {
    for (let d = 0; d <= 4; d++) {
      const c = this.grid.cls(x, y - d, z);
      if (!c) {
        this.sawUnknown = true;
        return false;
      }
      if (c.liquid === 'lava' || c.danger) return false;
      if (c.liquid === 'water') return true;
      if (c.boxes.length) return d <= 3; // a floor d + 1 blocks under the takeoff level: a fall of d blocks
    }
    return false;
  }

  /** The cell after a parkour landing stops an overshoot: standable at the landing height, or a wall at body height. */
  private stopsOvershoot(x: number, y: number, z: number, feet: number): boolean {
    const f = this.grid.stand(x, y, z);
    if (isFeet(f) && Math.abs(f - feet) < FLAT) return true;
    const c = this.grid.cls(x, y, z);
    const h = this.grid.cls(x, y + 1, z);
    return !!c && !!h && c.boxes.length > 0 && h.boxes.length > 0 && !c.danger && !h.danger;
  }

  /**
   * A rise from feet f0 into node (nx, ny, nz) standing at f1, moving along (dx, dz), the body climbs
   * by auto-steps alone: the floor block's half facing the mover (a stairs block's low half) is within
   * a step of f0, and the floor's top within a step of that half. False for full blocks, slabs on
   * blocks, upside-down stairs and stairs met from their high side or from the side.
   */
  private stepsUp(f0: number, nx: number, ny: number, nz: number, f1: number, dx: number, dz: number): boolean {
    const floorY = f1 > ny + FLAT ? ny : ny - 1;
    const c = this.grid.cls(nx, floorY, nz);
    if (!c?.floor) return false;
    const low = floorY + halfTop(c, -dx, -dz);
    return low - f0 <= STEP && f1 - low <= STEP;
  }

  /**
   * A fall from feet f0 in node (cx, cy, cz) to feet f1, moving along (dx, dz), that the body takes as
   * steps down: the start's floor half towards the move (a stairs block's low half) is within a step
   * of both feet heights.
   */
  private stepsDown(cx: number, cy: number, cz: number, f0: number, f1: number, dx: number, dz: number): boolean {
    const floorY = f0 > cy + FLAT ? cy : cy - 1;
    const c = this.grid.cls(cx, floorY, cz);
    if (!c?.floor) return false;
    const low = floorY + halfTop(c, dx, dz);
    return f0 - low <= STEP && low - f1 <= STEP;
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

  /**
   * A cardinal walk into (or through) a door / gate cell (node level `ny`: the feet level, or one cell
   * up from a partial floor, Track AX) within a step of the feet. Returns true when it was one.
   */
  private doorway(cur: number, cx: number, cy: number, cz: number, f0: number, nx: number, ny: number, nz: number, axis: 0 | 2): boolean {
    const grid = this.grid;
    const f1 = grid.standThrough(nx, ny, nz);
    if (!isFeet(f1) || Math.abs(f1 - f0) > STEP) return false;
    if (!grid.hasPassage(nx, ny, f1, nz)) return false;
    const use: Vec3[] = [];
    const cells: [number, number, number, number][] = [];
    // Track AX: the body's cells from its feet up; a partial floor in the node's own cell (a dirt path
    // in front of the door, a carpet) is under the feet, not in the corridor
    const topA = Math.floor(f0 + PHYSICS.height - 1e-6);
    for (let y = f0 > cy + FLAT ? cy + 1 : cy; y <= topA; y++) cells.push([cx, y, cz, 0]);
    const topB = Math.floor(f1 + PHYSICS.height - 1e-6);
    for (let y = f1 > ny + FLAT ? ny + 1 : ny; y <= topB; y++) cells.push([nx, y, nz, 1]);
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
    this.relax(cur, nx, ny, nz, f1, this.costs.walk, M_WALK, use.length * this.costs.door, 0, use.length ? { use } : undefined, F_PASSAGE);
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
      if (breakBlocker(grid, nx, y, nz, { protectedBlocks: this.opts.protectedBlocks, protectedArea: this.opts.protectedArea }, floors) !== undefined) return;
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
 * when none. Track AJ: `prefer` 'swim' / 'climb' (a body in water, hanging on a ladder) first looks for
 * the swim / climb node of the body's column.
 */
export function locateNode(grid: NavGrid, pos: { x: number; y: number; z: number }, prefer?: 'swim' | 'climb'): LocatedNode | undefined {
  const y0 = Math.floor(pos.y + 1e-3);
  const bx = Math.floor(pos.x);
  const bz = Math.floor(pos.z);
  if (prefer === 'climb' && isFeet(grid.climb(bx, y0, bz))) return { x: bx, y: y0, z: bz, feet: y0 };
  if (prefer === 'swim') {
    for (const y of [y0, y0 - 1, y0 + 1]) if (isFeet(grid.swim(bx, y, bz))) return { x: bx, y, z: bz, feet: y };
  }
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

/**
 * Track AX: one line on what the cardinal moves out of a standing node find, for the "why" of a plan
 * that expanded nothing but its start: per direction the cells from one below to two above the node's
 * level (`blocked (<block in it>)`, `doorway`, `unloaded`, or the feet height with the rise and, for a
 * jump, the head room above the start), e.g. `+x: -61 blocked (dirt), -60 feet -60 rise 1.50 > 1.25`.
 */
export function explainStart(grid: NavGrid, n: LocatedNode): string {
  const head = Math.floor(n.feet + PHYSICS.height - 1e-6);
  const fmt = (v: number) => String(+v.toFixed(4));
  const labels = ['+x', '-x', '+z', '-z'];
  const parts: string[] = [];
  CARDINAL.forEach(([dx, dz], i) => {
    const nx = n.x + dx;
    const nz = n.z + dz;
    const cells: string[] = [];
    for (let ny = n.y - 1; ny <= n.y + 2; ny++) {
      const f = grid.stand(nx, ny, nz);
      if (f === undefined) {
        cells.push(`${ny} unloaded`);
        continue;
      }
      if (Number.isNaN(f)) {
        const t = grid.standThrough(nx, ny, nz);
        cells.push(isFeet(t) ? `${ny} doorway feet ${fmt(t)}` : `${ny} blocked (${grid.cls(nx, ny, nz)?.name ?? 'unloaded'})`);
        continue;
      }
      const rise = f - n.feet;
      let note = rise >= 0 ? ` rise ${rise.toFixed(2)}` : ` fall ${(-rise).toFixed(2)}`;
      if (rise > MAX_JUMP_RISE + 1e-6) note += ` > ${MAX_JUMP_RISE}`;
      else if (rise > STEP) {
        const apex = Math.floor(f + PHYSICS.height - 1e-6);
        const room = apex > head ? grid.freeColumn(n.x, head + 1, apex, n.z) : true;
        note += room === true ? ' (jump)' : ` (no head room in ${head + 1}..${apex})`;
      }
      cells.push(`${ny} feet ${fmt(f)}${note}`);
    }
    parts.push(`${labels[i]}: ${cells.join(', ')}`);
  });
  return `start ${n.x},${n.y},${n.z} feet ${fmt(n.feet)}: ${parts.join('; ')}`;
}
