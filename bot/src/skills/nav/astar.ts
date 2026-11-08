// A* over the block grid (PLAN.md tasks 3.5, 7.1, 7.2). Nodes are feet cells (see grid.ts); every
// move costs ticks (costs.ts). Moves:
//   walk   - 4 cardinal neighbours, feet height change within the 0.5625 auto-step (slabs, carpets).
//            Through a doorway when the door / gate is out of the way, or can be toggled (`allowOpen`).
//            With `allowBreak`: through 1 or 2 blocks that are broken first (dig-through).
//   diag   - 4 diagonal neighbours on exactly the same feet height, both side cells standable at it.
//   jump   - cardinal, up by more than the step height and at most 1.25, head room above the start.
//   drop   - cardinal, walk off an edge and fall up to `maxDrop` (3) blocks.
//   pillar - straight up one block: jump and place a throwaway block under the feet (`allowPlace`).
// Track BC, the moves that dig (`allowBreak`; baritone/moves.ts, Baritone's movements, LGPL-3.0):
//   walk + dig   - MovementTraverse: the 1 or 2 body cells ahead are broken first (dig-through, as before).
//   jump + dig   - MovementAscend: the head room over the start and the target's body cells are broken.
//   drop + dig   - MovementDescend: the three body cells of the column one lower are broken, a full floor
//                  under it (never into liquid).
//   downward     - MovementDownward: the block under the feet is dug and the body drops one; only under the
//                  shaft rules (mine/tunnel.ts `shaftRule`) and with pillar-up planned as the way back.
//   pillar + dig - MovementPillar: the cell above the head is broken before the jump.
// Track AJ, movement variety (`moves`, docs/pathfinding.md "Movement variety"):
//   swim     - into still water (walk in, or drop up to 3 onto the surface), between surface cells
//              (8 neighbours), never under water.
//   swimOut  - from the surface onto a bank at the water level up to 1 block higher; Track W1: from under
//              water onto a floor beside at the feet level or 1 higher. Never over a 1-block lip (a bank 2
//              above the top water cell): BDS does not lift a swimming body that high (measured, the model agrees).
//              Track W2 (`digOut`, nav/digout.ts): from a surface node onto the block at the water's level after
//              breaking the lip (and the head room over it), then up a taller bank by jumps with breaks (`ascend`)
//              from the cut's nodes only, even without `allowBreak`; priced so a swim exit wins unless far longer.
// Track W1, under water (`moves.dive`, docs/pathfinding.md "Water (Track W1)", nav/water.ts):
//   dive     - into a dive node (NavGrid.dive: the body's cells water, not a surface node): down from the
//              surface or a dive node (sneak), up a column or a waterfall (jump), across under water (8
//              neighbours), in from a floor at the feet level or a drop. Up from a dive node onto the
//              surface is a `swim` move. Each stretch with the head under water stays within the air
//              budget (PathOptions.air, water.ts airBudget); a partial path never ends under water.
//   climb    - up / down a ladder or vine column, onto it from its foot, its side or its top.
//   climbOut - off a climber column onto a floor beside it, from its level up to 1 higher.
//   parkour  - over a 1-block gap (walking) or a 2-block gap (2-block sprinted run-up behind the
//              takeoff), landing at the same height or 1 lower; water or a floor within 3 below, no lava.
// Cost of a move into node B = base ticks x B's floor factor (leaves, soul sand, ice) + `underground`
// when B has a roof above the head + `irreversibleDrop` for a drop higher than a jump + break / place
// / door ticks. Heuristic: costs.walk x (octile distance + the levels to the goal's height, priced like a
// staircase: goals.ts `columnH`, Baritone's GoalBlock; not admissible, as Baritone's is not).
//
// `PathSearch` runs in slices (`step(ms)`) so the navigator never blocks a tick for long;
// `findPath` runs one to the end.
import type { Vec3 } from '../../world/types.ts';
import { breakTicks as tableBreakTicks } from '../dig/breakTime.ts';
import { PHYSICS } from '../input/physics.ts';
import { halfTop, type TerrainClass } from '../terrain/classify.ts';
import type { BreakRules, NavBlockFace } from './actions.ts';
import { BestSoFar, FAILURE_NODES_FACTOR, MIN_DIST_PATH } from './baritone/bestSoFar.ts'; // Track BA: partial-path selection (ported, LGPL-3.0)
import { ascend, createBreakMoveContext, descend, downward, pillar, sneakFits, traverse, type BreakMoveContext } from './baritone/moves.ts'; // Track BC: the moves that dig (ported, LGPL-3.0) and sneak-through
import { DEFAULT_COSTS, dropCost, type PathCosts } from './costs.ts';
import { goalTest, levelWeights, type NavGoal, type GoalTest } from './goals.ts'; // Track R: NavGoal (task 7.10 goal types)
import { longDrops, type LongDrop } from '../fall/plan.ts'; // Track BI: long falls
import type { FallPolicy } from '../fall/policy.ts';
import { CROSS_BLOCKED, CROSS_CLEAR, CROSS_TOGGLE, VARIETY_CLIMBER, VARIETY_LADDER, VARIETY_TRAPDOOR, VARIETY_WATER, cellKey, type NavGrid } from './grid.ts';
import { airBudget, diveGoalBudget, underSurface } from './water.ts'; // Track W1
import { DIG_OUT_MAX_STEPS, DIG_OUT_PENALTY, DigOutRefusals, digOutStep, type DigOutReport } from './digout.ts'; // Track W2
import { DIG_WAY_PENALTY, digWayBreakTicks, type DigWay } from './digway.ts'; // Track W3

export type { PathCosts } from './costs.ts';
export { DEFAULT_COSTS } from './costs.ts';

export type MoveKind = 'start' | 'walk' | 'diag' | 'jump' | 'drop' | 'pillar' | 'swim' | 'swimOut' | 'climb' | 'climbOut' | 'parkour' | 'downward' | 'sneak' | 'dive'; // Track AJ: swim .. parkour; Track BC: downward, sneak; Track W1: dive

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
  /**
   * Track W2: the node is on a dig-out staircase (PathSearch `F_CUT`): its step count from the water, + CUT_UNPAID
   * while no step of it has been dug yet (a plain swimOut: the first dug stair step pays DIG_OUT_PENALTY). A re-plan
   * from it (PathOptions.startCut) goes on up the stair.
   */
  cut?: number;
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
  // Track BC: the moves that dig (under `allowBreak`; dig-through itself is always on with it)
  /** Jump up one block after breaking the head room (MovementAscend). */
  digAscend?: boolean;
  /** Step down one block after breaking into the lower column (MovementDescend). */
  digDescend?: boolean;
  /** Dig the block under the feet and drop one (MovementDownward; needs `allowPlace` for the way back). */
  digDownward?: boolean;
  /** Track BC: walk sneaking through cells the body only fits sneaking (a 1.5-high gap under a top slab). */
  sneak?: boolean;
  /**
   * Track BG: through trapdoors in floors and ceilings (hatches): down onto the ladder under one or through
   * it onto a floor / into water, up a ladder through one above (a closed one is opened first: `allowOpen`).
   */
  trapdoor?: boolean;
  /**
   * Track W1: under water: down from the surface, through flooded passages, up water columns and waterfalls,
   * out onto a floor beside (needs `swim`: the surface moves). Within the air budget (PathOptions.air).
   */
  dive?: boolean;
}

/** Track R1: the owner's rules a "why unreachable" search lifts (PathOptions.relax, nav/reach.ts). */
export interface PathRelax {
  built?: boolean;
  liquid?: boolean;
  gravity?: boolean;
  slow?: boolean;
  /** The heuristic's weight (weighted A*: a "why" search asks whether a way exists, not for the best one). Default 1. */
  weight?: number;
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
  /**
   * Track BC: Baritone's way with a gravity block over a dug cell (the falling stack is dug too and its
   * break times are paid: `BreakRules.allowGravityAbove`). Default false: the owner's rule, refused.
   */
  allowGravityAbove?: boolean;
  /** Track BC: throwaway blocks in the hotbar (the dig-down move needs the depth + 4 for the pillar back up). Default 0. */
  throwaway?: number;
  /** Track S: extra ticks (>= 0) for a move that ends in feet cell (x, y, z): mob / spawner avoidance (nav/avoidance.ts). */
  cellCost?: (x: number, y: number, z: number) => number;
  /** Track R: cells (cellKey) not to pillar in / doors (lower half) not to open (blacklisted place / use failures). */
  noAction?: ReadonlySet<number>;
  /** Track BI: drops deeper than `maxDrop` (damage within the health budget, water-bucket clutches; skills/fall/plan.ts). Default none. */
  falls?: FallPolicy;
  /**
   * Extra ticks for a move that falls more than FARMLAND_SAFE_FALL onto farmland (it can trample it;
   * docs/farming.md "Trampling"): the farmer's routes take the paths and steps around a terraced field
   * instead of dropping a terrace onto the crops. Default 0 (off).
   */
  farmlandDropCost?: number;
  /**
   * Track W1: the body's air (0..300 ticks; the server's `air`, else the navigator's clock) when the plan
   * starts. Read only for a start with the head under water: its stretch to air may take (air - 20) / 1.5
   * ticks (at least 60); a breathing start allows (300 - 110) / 1.5 per stretch (water.ts airBudget). The
   * stretch counts the moves' own ticks (not `underground` / `underwater` / avoidance prices).
   * Default: a full supply.
   */
  air?: number;
  /**
   * Track W2 (nav/digout.ts): a way out of water by digging: a step broken into a lip beside a surface swim node,
   * a staircase cut up a taller bank from there (jumps with breaks from the cut's nodes only), under the break
   * rules, even without `allowBreak`. Needs a dig action. Default false (the navigator turns it on: `digOut`).
   */
  digOut?: boolean;
  /** Track W2: the start node is on a dig-out staircase (its PathNode.cut in the path walked so far). */
  startCut?: number;
  /**
   * Track W3 (nav/digway.ts): the dig way (level 1) of a goto whose plain search found no way: the moves that dig (needs
   * `allowBreak` too), natural terrain only, at most `left` blocks in this plan, each priced DIG_WAY_PENALTY more.
   */
  /**
   * Track R1 (nav/reach.ts): the owner's rules a "why unreachable" search lifts (never a plan that is walked):
   * `built` breaks built blocks (break rules and the dig way's natural-only rule), `liquid` digs beside a liquid,
   * `gravity` digs under or beside a gravity block, `slow` lifts the dig way's DIG_WAY_MAX_TICKS.
   */
  relax?: PathRelax;
  /**
   * Track R1: a goal in unloaded world with no partial end worth walking: end at the most promising node that touched
   * unloaded world instead (the frontier end, PathSearch `frontier`). The navigator sets it at a goto's last level.
   */
  frontier?: boolean;
  digWay?: DigWay;
}

/** Falls up to this height onto farmland never trampled it (measured, docs/farming.md). */
export const FARMLAND_SAFE_FALL = 0.75;

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
  /** Track R1: a partial path that ends at the frontier end (PathOptions.frontier). */
  frontier?: boolean;
  /**
   * Track W2: a search from water that did not reach the goal (none, or a partial that went nowhere): the dig-out
   * steps it refused, by reason (nav/digout.ts `trappedWhy` says it in words). Only with `digOut` on.
   */
  digOut?: DigOutReport;
}

/** Highest feet rise a jump can take (apex of a standing jump is 1.2522). */
export const MAX_JUMP_RISE = 1.25;
/** Track BG: deepest fall (blocks below the feet) through a hatch into still water (Baritone's MovementFall takes any height). */
export const HATCH_WATER_FALL = 16;
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
const M_DOWNWARD = 11; // Track BC
const M_SNEAK = 12; // Track BC
const M_DIVE = 13; // Track W1
/** Track W1: a dive goal's way up to air is looked for this many cells over its feet. */
const RISE_SCAN = 48;
const MOVE_CODES: readonly MoveKind[] = ['start', 'walk', 'diag', 'jump', 'drop', 'pillar', 'swim', 'swimOut', 'climb', 'climbOut', 'parkour', 'downward', 'sneak', 'dive'];
/** Node flag: the node stands in a doorway (only cardinal walks leave it). */
const F_PASSAGE = 1;
/** Track AJ: node flags: swimming on the surface; climbing (feet in a climber cell, no floor). */
const F_SWIM = 2;
const F_CLIMB = 4;
/** Track BC: the body only fits sneaking (a low ceiling: baritone/moves.ts `sneakFits`); only sneak moves leave it. */
const F_SNEAK = 8;
/** Track W1: the body under water in a dive node (NavGrid.dive); only dive moves leave it. */
const F_DIVE = 16;
/** Track W2: a node of a dig-out staircase (nav/digout.ts): jumps with breaks are planned from it without `allowBreak`. */
const F_CUT = 32;
/** Track W2: PathNode.cut bit: no step of this staircase is dug yet (entered by a plain swimOut). */
export const CUT_UNPAID = 0x80;

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
  /** Track W1: planned ticks with the head under water since the last breath (0 at a breathing node). */
  wet = new Float64Array(4096);
  /** Track W2: the steps of a dig-out staircase up to the node (0 off the cut). */
  cut = new Uint8Array(4096);
  /** Track W3: blocks the dig way (PathOptions.digWay) has dug up to the node. */
  dug = new Uint8Array(4096);
  /** Track R1: cells dug on the way to the node, every move that digs counted (0: nothing on the way was dug). */
  digs = new Int32Array(4096);
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
      this.wet = grown(this.wet, (k) => new Float64Array(k));
      this.cut = grown(this.cut, (k) => new Uint8Array(k));
      this.dug = grown(this.dug, (k) => new Uint8Array(k));
      this.digs = grown(this.digs, (k) => new Int32Array(k));
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
    this.wet[i] = 0;
    this.cut[i] = 0;
    this.dug[i] = 0;
    this.digs[i] = 0;
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
  /** The heuristic's ticks per block (costs.walk, times PathRelax.weight). */
  private readonly hFactor: number;
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
  /**
   * Track R1: the frontier end, for a goal in unloaded world: of the nodes whose moves touched unloaded world, MIN_DIST_PATH+ blocks from the start
   * and not under water, the one with the lowest g + h (A* with the unloaded world taken as open). The partial end
   * when no best is worth walking: the body heads into the unloaded world the way that promises most, and plans again
   * as it loads (was: no progress, and the goto ended at a cliff whose way round lay past the loaded world).
   */
  private frontier = -1;
  private frontierScore = Infinity;
  private ms = 0;
  private done: PathResult | undefined;
  /** Track AJ: the parkour takeoff the next relax() records (set around a parkour relax only). */
  private pendingGap: PathNode['gap'] = undefined;
  /** Track AJ: per cardinal direction of the node being expanded: a gap starts next to it. */
  private readonly holes = new Uint8Array(4);
  /** Track BC: per cardinal direction: the same-level cell is blocked (1), a move one level down was taken (2). */
  private readonly digFlags = new Uint8Array(4);
  /** Track BC: the moves that dig (baritone/moves.ts), built when `allowBreak` is on. */
  private readonly breaks: BreakMoveContext | undefined;
  /** Track BC: the start's y (the dig-down move's depth budget counts from it). */
  private readonly startY: number;
  /**
   * Track BC: the lowest y a goal point lies at (-Infinity for goals without one: xz): digging down into open
   * ground (a staircase, a shaft) is only planned from nodes above it. Without the gate A* digs the whole area
   * under the search layer by layer, because every open floor ahead is one cheap dig away.
   */
  private readonly goalMinY: number;
  /** Track W1: the most planned ticks with the head under water in one stretch (water.ts airBudget). */
  private airLimit: number;
  /**
   * Track W1: a `near` goal around a point in water (the followed player swimming): a surface swim node within
   * its radius reaches it (the body treads water there); Track W3: a `block` goal whose cell holds water too (and a
   * dive node in that cell); other goals are reached standing only.
   */
  private readonly waterGoal: boolean;
  /**
   * Track W1: a `near` goal around a point under the water surface (a waypoint on a pool's floor, a player
   * diving): a dive node within its radius reaches it too, while the stretch there plus the way straight up to
   * air fits `diveGoalLimit` (water.ts diveGoalBudget).
   */
  private readonly diveGoal: boolean;
  private diveGoalLimit: number;
  /** Track W2: the dig-out steps refused so far (the trapped report); undefined without `digOut`. */
  private readonly digOutRefused: DigOutRefusals | undefined;
  /** Track W2: the start is in water (a swim or dive node): a failed search reports the refused dig-out steps. */
  private startWet = false;

  constructor(grid: NavGrid, start: { x: number; y: number; z: number }, goal: NavGoal, opts: PathOptions = {}) {
    this.grid = grid;
    this.goal = goal;
    this.opts = opts;
    this.costs = { ...DEFAULT_COSTS, ...opts.costs };
    this.hFactor = this.costs.walk * (opts.relax?.weight ?? 1); // Track R1: weighted for a "why" search
    this.test = goalTest(goal, grid, levelWeights(this.costs)); // Track R: getToBlock / surface read the grid; levels priced by the costs
    this.maxNodes = opts.maxNodes ?? 40_000;
    this.maxMs = opts.maxMs ?? 250;
    this.breakTicksOf = opts.breakTicks ?? handBreakTicks;
    if (opts.digWay) this.breakTicksOf = digWayBreakTicks(this.breakTicksOf, opts.relax); // Track W3: natural terrain only, no slow blocks (Track R1: unless relaxed)
    this.startY = start.y;
    this.goalMinY = goalMinY(goal);
    this.airLimit = airBudget(opts.air, false); // Track W1 (a start under water: below)
    const blockWet = goal.type === 'block' && waterBlockGoal(grid, goal.p); // Track W3: a waypoint on a water floor
    this.waterGoal = this.moveOn('swim') && ((goal.type === 'near' && waterNear(grid, goal.p)) || blockWet);
    this.diveGoal = this.waterGoal && this.diveOn() && (blockWet || (goal.type === 'near' && underSurface((x, y, z) => grid.cls(x, y, z), goal.p)));
    this.diveGoalLimit = diveGoalBudget(opts.air, false);
    // Track BC: the break rules and costs every move that digs applies (baritone/moves.ts). Track W2: also for the
    // dig-out moves alone (`digOut` without `allowBreak`)
    this.digOutRefused = opts.digOut ? new DigOutRefusals() : undefined;
    if (opts.allowBreak || opts.digOut) {
      const noBreak = opts.noBreak;
      const rules: BreakRules = { protectedBlocks: opts.protectedBlocks, protectedArea: opts.protectedArea, allowGravityAbove: opts.allowGravityAbove ?? false, ...(opts.relax ? { relax: opts.relax } : {}) };
      this.breaks = createBreakMoveContext({
        grid,
        costs: this.costs,
        mining: { breakTicks: this.breakTicksOf, dig: this.costs.dig, rules, noBreak: noBreak?.size ? (x, y, z) => noBreak.has(cellKey(x, y, z)) : undefined },
        allowPlace: opts.allowPlace ?? false,
        throwaway: opts.throwaway ?? 0,
        minY: grid.source.minY ?? -64,
      });
    }
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
    // Track W1: a body under water starts from a dive node (its stretch to air within what air it has left)
    if (!isFeet(startFeet) && this.diveOn()) {
      const d = grid.dive(start.x, start.y, start.z);
      if (isFeet(d)) {
        startFeet = d;
        flags = F_DIVE;
        if (grid.submerged(start.x, start.y, start.z)) {
          this.airLimit = airBudget(opts.air, true);
          this.diveGoalLimit = diveGoalBudget(opts.air, true);
        }
      }
    }
    // Track BC: a body under a low ceiling starts from a sneak node
    if (!isFeet(startFeet) && this.moveOn('sneak') && sneakFits(grid, start.x, start.y, start.z) === true) {
      startFeet = start.y;
      flags = F_SNEAK;
    }
    if (!isFeet(startFeet)) {
      this.done = { status: 'none', path: [], cost: 0, expanded: 0, ms: performance.now() - t0, unknown: false, limited: false };
      return;
    }
    this.startWet = (flags & (F_SWIM | F_DIVE)) !== 0; // Track W2
    // Track W2: a start on a dig-out staircase (the path walked so far said so) goes on up it
    const startCut = opts.digOut && flags === 0 ? (opts.startCut ?? 0) : 0;
    if (startCut) flags |= F_CUT;
    const s = this.nodes.add(start.x, start.y, start.z, startFeet);
    this.startNode = s; // Track BA
    this.nodes.g[s] = 0;
    this.nodes.flags[s] = flags;
    this.nodes.cut[s] = startCut;
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
    return this.test.h(x, y, z) * this.hFactor;
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
      // Track AJ: a goal is never reached swimming or hanging on a ladder (the body stops standing). Track W1: nor
      // under water; a `near` goal around a point in water at a surface node (waterGoal), around a point under the
      // surface at a dive node too (diveGoal) when the air allows the way back up
      const fl = nodes.flags[cur]!;
      const reaches = (fl & F_CLIMB) === 0 && ((fl & F_DIVE) !== 0 ? this.diveGoal : (fl & F_SWIM) === 0 || this.waterGoal);
      if (reaches && this.test.done(cx, cy, cz, f0) && ((fl & F_DIVE) === 0 || nodes.wet[cur]! + this.riseTicks(cx, cy, cz) <= this.diveGoalLimit)) {
        this.found = cur;
        break;
      }
      // Track BA: h + g / k + trap for Baritone's 7 coefficients (was: the lowest h + trap). Track W1: a partial
      // path never ends with the head under water (the next segment would start its air budget afresh)
      if (nodes.wet[cur] === 0) this.bests.consider(cur, cx, cy, cz, this.h(cx, cy, cz), nodes.g[cur]!, nodes.trap[cur]!);
      // Track BA: while no best is 5+ blocks from the start (Baritone `failing`), on up to 4 x maxNodes
      if (++this.expanded >= this.maxNodes && (!this.bests.failing || this.expanded >= this.maxNodes * FAILURE_NODES_FACTOR)) {
        this.limited = true;
        break;
      }
      const saw = this.sawUnknown;
      this.sawUnknown = false;
      this.expand(cur, cx, cy, cz, f0);
      if (this.sawUnknown && this.opts.frontier && nodes.wet[cur] === 0 && cur !== this.startNode) this.considerFrontier(cur, cx, cy, cz);
      this.sawUnknown ||= saw;
    }
    this.ms += performance.now() - t0;
    return this.finish();
  }

  /** Track R1: node `i` touched unloaded world: the frontier end when it promises most (see `frontier`). */
  private considerFrontier(i: number, x: number, y: number, z: number): void {
    const nodes = this.nodes;
    const s = this.startNode;
    const dx = x - nodes.x[s]!;
    const dy = y - nodes.y[s]!;
    const dz = z - nodes.z[s]!;
    if (dx * dx + dy * dy + dz * dz <= MIN_DIST_PATH * MIN_DIST_PATH) return;
    const score = nodes.g[i]! + this.h(x, y, z) + nodes.trap[i]!;
    if (score < this.frontierScore) {
      this.frontierScore = score;
      this.frontier = i;
    }
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
    let best = this.found >= 0 ? this.found : this.bests.best();
    let viaFrontier = false;
    // (a "why" search, `relax`, asks whether the unloaded world can be reached at all: the frontier before any best)
    if (this.found < 0 && (best < 0 || this.opts.relax) && this.frontier >= 0 && goalUnloaded(this.goal, this.grid)) {
      best = this.frontier; // Track R1: towards an unloaded goal the most promising way
      viaFrontier = true;
    }
    const end = best >= 0 ? best : this.startNode;
    const path: PathNode[] = [];
    for (let i = end; i >= 0; i = nodes.parent[i]!) {
      const node: PathNode = { x: nodes.x[i]!, y: nodes.y[i]!, z: nodes.z[i]!, feet: nodes.feet[i]!, move: MOVE_CODES[nodes.move[i]!]!, cost: nodes.mc[i]! };
      const act = nodes.act[i];
      if (act) node.act = act;
      const gap = nodes.gap[i]; // Track AJ
      if (gap && node.move === 'parkour') node.gap = gap;
      if (nodes.cut[i]) node.cut = nodes.cut[i]; // Track W2
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
    if (viaFrontier) res.frontier = true; // Track R1
    // Track W2: from water and nowhere: which dig-out steps the rules refused
    if (this.digOutRefused && this.startWet && (status === 'none' || res.reason === 'no_progress')) res.digOut = this.digOutRefused.report();
    return res;
  }

  /** Track R1: cell (x, y, z) is dug by a move on the way to node `from` (its own move included). */
  private dugOnTheWay(from: number, x: number, y: number, z: number): boolean {
    const nodes = this.nodes;
    for (let i = from; i >= 0 && nodes.digs[i]! > 0; i = nodes.parent[i]!) {
      const d = nodes.act[i]?.dig;
      if (d) for (const c of d) if (c.x === x && c.y === y && c.z === z) return true;
    }
    return false;
  }

  private relax(from: number, x: number, y: number, z: number, feet: number, base: number, move: number, extra = 0, trap = 0, act?: NodeActions, flags = 0, cut = 0): void {
    const nodes = this.nodes;
    const grid = this.grid;
    const k = cellKey(x, y, z);
    let i = this.index.get(k);
    if (i !== undefined && nodes.closed[i]) return;
    // Track W3: the dig way digs at most its budget of blocks, each priced DIG_WAY_PENALTY more (not the W2 dig-out
    // steps: they have their own price)
    let dug = nodes.dug[from]!;
    if (this.opts.digWay && act?.dig && (flags & F_CUT) === 0) {
      dug += act.dig.length;
      if (dug > this.opts.digWay.left) return;
      if (!this.opts.relax) extra += DIG_WAY_PENALTY * act.dig.length; // (Track R1: not in a "why" search: it asks whether, not how well)
    }
    // Track R1: a cell dug earlier on this path is air when the body gets here: never the floor it stands on (a stair cut
    // up a 1-wide staircase took a step's top block, then planned to stand on it: three move timeouts, unreachable)
    const digs = nodes.digs[from]! + (act?.dig?.length ?? 0);
    if (nodes.digs[from]! > 0 && (flags & (F_SWIM | F_DIVE)) === 0 && this.dugOnTheWay(from, x, Math.floor(feet + 1e-6) - (feet - Math.floor(feet + 1e-6) > FLAT ? 0 : 1), z)) return;
    const ticks = base * grid.factor(x, y, z, feet);
    let cost = ticks + extra + trap;
    if (this.costs.underground > 0 && grid.underground(x, z, feet)) cost += this.costs.underground;
    if (this.opts.cellCost) cost += this.opts.cellCost(x, y, z); // Track S: avoidance
    if (this.opts.farmlandDropCost && nodes.feet[from]! - feet > FARMLAND_SAFE_FALL && grid.cls(x, feet - y > 1e-6 ? y : y - 1, z)?.name === 'farmland') cost += this.opts.farmlandDropCost;
    // Track W1: the head under water in the new node: the stretch since the last breath (the moves' own ticks, not
    // the preference prices) stays within the air budget
    let wet = 0;
    if ((flags & F_DIVE) !== 0 && grid.submerged(x, y, z)) {
      cost += this.costs.underwater;
      wet = nodes.wet[from]! + ticks + extra;
      if (wet > this.airLimit) return;
    }
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
    nodes.wet[i] = wet; // Track W1
    nodes.cut[i] = cut; // Track W2
    nodes.dug[i] = dug; // Track W3
    nodes.digs[i] = digs; // Track R1
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
    if (flags0 & F_DIVE) return this.expandDive(cur, cx, cy, cz); // Track W1
    if (flags0 & F_CLIMB) return this.expandClimb(cur, cx, cy, cz, f0);
    if (flags0 & F_SNEAK) return this.expandSneak(cur, cx, cy, cz); // Track BC
    const inPassage = (flags0 & F_PASSAGE) !== 0;
    const headCell = Math.floor(f0 + PHYSICS.height - 1e-6);
    const diag = costs.walk * Math.SQRT2;
    // Track AJ: movement-variety checks only once the grid has classified water / climbers / ladders at
    // all (NavGrid.variety, read after the cells in question have been looked at, so the answer does not
    // depend on what an earlier search cached)
    const flat = Math.abs(f0 - cy) < FLAT;
    const holes = this.holes;
    holes.fill(0);
    const digFlags = this.digFlags; // Track BC
    digFlags.fill(0);

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
              else if ((flags0 & F_CUT) !== 0 && Math.abs(f1 - ny) < FLAT) {
                // Track W2: up a dig-out staircase cut before (its next step still to dig): the jump stays on the stair
                const cut = this.nodes.cut[cur]!;
                if ((cut & ~CUT_UNPAID) < DIG_OUT_MAX_STEPS) this.relax(cur, nx, ny, nz, f1, costs.jump, M_JUMP, 0, 0, undefined, F_CUT, cut + 1);
                else this.relax(cur, nx, ny, nz, f1, costs.jump, M_JUMP);
              } else this.relax(cur, nx, ny, nz, f1, costs.jump, M_JUMP);
            } else if (room === undefined) this.sawUnknown = true;
            else if (ny === cy + 1) digFlags[di] = digFlags[di]! | 4; // Track BC: the jump exists but for the start's head room: an ascend with breaks
          }
          took = true;
        } else {
          took = true; // a wall: no drop either
        }
      }
      if (levelBlocked) {
        digFlags[di] = digFlags[di]! | 1; // Track BC: the dig moves run after this loop (bit 4 may be set already)
        // Track BC: into a cell the body only fits sneaking (a low ceiling): a sneak move
        if (flat && !inPassage && this.moveOn('sneak')) {
          const fits = sneakFits(grid, nx, cy, nz);
          if (fits === undefined) this.sawUnknown = true;
          else if (fits && this.ladderPass(cx, cy, cz, nx, nz, dx, dz, false)) this.relax(cur, nx, cy, nz, cy, costs.sneakWalk, M_SNEAK, 0, 0, undefined, F_SNEAK);
        }
      }
      // Track BG: down through a trapdoor in the walking layer or in the floor ahead (closed: opened first)
      if (flat && !inPassage && (grid.variety & VARIETY_TRAPDOOR) !== 0 && this.moveOn('trapdoor')) this.hatchDown(cur, cx, cy, cz, f0, headCell, nx, nz, dx, dz);
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
          if (d === 1) digFlags[di] = digFlags[di]! | 2; // Track BC: a move one level down exists (no descend with breaks)
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
      if (opts.falls && !landing && costs.maxDrop >= 3) this.longDrops(cur, cy, f0, nx, nz); // Track BI: deeper drops (skills/fall/plan.ts)
      // Track AJ: nothing to land on within 3 (mid-air, a deep pit) and no water right below that: no
      // parkour (the scan above found the cells down to cy - 3 free when it ran to the end)
      if (holes[di] && !landing) holes[di] = (grid.variety & VARIETY_WATER) !== 0 && grid.cls(nx, cy - costs.maxDrop - 1, nz)?.liquid === 'water' ? 1 : 0;
    }

    // Track BC: the moves that dig (baritone/moves.ts), from a node standing on a full block. Track W2: without
    // `allowBreak`, a dig-out staircase's node goes on up by jumps with breaks only
    if (this.breaks && flat) {
      if (opts.allowBreak) this.digMoves(cur, cx, cy, cz, inPassage);
      else if ((flags0 & F_CUT) !== 0 && !inPassage) this.cutMoves(cur, cx, cy, cz);
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
    if (this.varietyOn(VARIETY_CLIMBER, 'climb') && grid.climbable(cx, cy, cz)) this.climbUpInto(cur, cx, cy + 1, cz); // Track BG: through a hatch above too
    // Track AJ: parkour over the gaps found above
    if (flat) {
      for (let di = 0; di < 4; di++) {
        if (!holes[di]) continue;
        if (this.moveOn('parkour1')) this.parkour(cur, cx, cy, cz, f0, 1, di);
        if (this.moveOn('parkour2')) this.parkour(cur, cx, cy, cz, f0, 2, di);
      }
    }

    // Pillar-up: jump and place a block in the feet cell (full-block floors only).
    // Track BD review: no block is placed inside the base either (`protectedArea`, the owner's protectRadius:
    // the break rules only refused digs there; the mine process' composite gotos plan with allowPlace)
    if (opts.allowPlace && Math.abs(f0 - cy) < FLAT && !opts.noAction?.has(cellKey(cx, cy, cz)) && !inArea(opts.protectedArea, cx, cy, cz)) {
      // Track BG2: the jump needs the cell over that free as well (Track O's PlaceSkill refuses with no_headroom
      // otherwise: on the Realm a pillar in a 3-high room under the farm's platform failed twice)
      const room = grid.freeColumn(cx, headCell + 1, headCell + 2, cz);
      if (room === true) {
        this.relax(cur, cx, cy + 1, cz, cy + 1, costs.jump, M_PILLAR, costs.place, 0, { place: { p: { x: cx, y: cy, z: cz }, face: 'down' } });
      } else if (room === undefined) {
        this.sawUnknown = true;
      } else if (this.breaks && opts.allowBreak) {
        // Track BC: Baritone MovementPillar: break the cell above the head first
        const m = pillar(this.breaks, cx, cy, cz);
        this.takeUnknown();
        if (m) this.relax(cur, cx, cy + 1, cz, cy + 1, m.base, M_PILLAR, m.extra, 0, { dig: m.dig, place: { p: { x: cx, y: cy, z: cz }, face: 'down' } });
      }
    }
  }

  /**
   * Track BC: moves of a sneak node (the body under a low ceiling): sneaking on into the next low cell, or
   * out onto a node standing at the same level (both `sneak` moves at the sneak walking cost). No jumps,
   * drops, diagonals or digs from here.
   */
  private expandSneak(cur: number, cx: number, cy: number, cz: number): void {
    const grid = this.grid;
    const costs = this.costs;
    for (const [dx, dz] of CARDINAL) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (!this.ladderPass(cx, cy, cz, nx, nz, dx, dz, false)) continue;
      const f1 = grid.stand(nx, cy, nz);
      if (f1 === undefined) {
        this.sawUnknown = true;
        continue;
      }
      if (isFeet(f1)) {
        if (Math.abs(f1 - cy) < FLAT) this.relax(cur, nx, cy, nz, cy, costs.sneakWalk, M_SNEAK);
        continue;
      }
      const fits = sneakFits(grid, nx, cy, nz);
      if (fits === undefined) this.sawUnknown = true;
      else if (fits) this.relax(cur, nx, cy, nz, cy, costs.sneakWalk, M_SNEAK, 0, 0, undefined, F_SNEAK);
    }
  }

  // ---- Track BC: the moves that dig (baritone/moves.ts; docs/pathfinding.md "Nodes and moves") -------

  /** Records a move's unloaded-cell flag as `sawUnknown`. */
  private takeUnknown(): void {
    const b = this.breaks!;
    if (b.unknown) {
      this.sawUnknown = true;
      b.unknown = false;
    }
  }

  /**
   * From a node standing on a full block at cell level cy: per cardinal direction the dig-through walk when
   * the same level is blocked (MovementTraverse), the jump with head-room breaks when the node one up is
   * blocked or the plain jump failed only for the start's head room (MovementAscend), the step down with
   * breaks when no move one level down was taken (MovementDescend); and the dig-down move in the node's own
   * column (MovementDownward, shaft rules). A doorway node takes the traverse in every direction like a plain
   * walk out of it, and none of the other moves.
   */
  private digMoves(cur: number, cx: number, cy: number, cz: number, inPassage: boolean): void {
    const b = this.breaks!;
    const grid = this.grid;
    const flags = this.digFlags;
    const goalBelow = cy > this.goalMinY;
    for (let di = 0; di < 4; di++) {
      const [dx, dz] = CARDINAL[di]!;
      const nx = cx + dx;
      const nz = cz + dz;
      const blocked = (flags[di]! & 1) !== 0;
      if (blocked) {
        const t = traverse(b, cx, cy, cz, nx, nz);
        this.takeUnknown();
        if (t) this.relax(cur, nx, cy, nz, cy, t.base, M_WALK, t.extra, 0, { dig: t.dig });
      }
      if (inPassage) continue;
      if (this.moveOn('digAscend') && ((blocked && Number.isNaN(grid.stand(nx, cy + 1, nz))) || (flags[di]! & 4) !== 0) && this.ladderPass(cx, cy, cz, nx, nz, dx, dz, true)) {
        const a = ascend(b, cx, cy, cz, nx, nz);
        this.takeUnknown();
        if (a) this.relax(cur, nx, cy + 1, nz, cy + 1, a.base, M_JUMP, a.extra, 0, { dig: a.dig });
      }
      if ((flags[di]! & 2) === 0 && this.moveOn('digDescend') && this.ladderPass(cx, cy, cz, nx, nz, dx, dz, false)) {
        // into open ground (the two cells over the floor ahead are free: a staircase down) only towards a goal below;
        // into rock or under a lintel whenever the step is blocked
        if (goalBelow || grid.free(nx, cy, nz) !== true || grid.free(nx, cy + 1, nz) !== true) {
          const d = descend(b, cx, cy, cz, nx, nz);
          this.takeUnknown();
          if (d) this.relax(cur, nx, cy - 1, nz, cy - 1, d.base, M_DROP, d.extra, 0, { dig: d.dig });
        }
      }
    }
    if (!inPassage && goalBelow && this.moveOn('digDownward')) {
      const m = downward(b, cx, cy, cz, this.startY - (cy - 1));
      this.takeUnknown();
      if (m) this.relax(cur, cx, cy - 1, cz, cy - 1, m.base, M_DOWNWARD, m.extra, 0, { dig: m.dig });
    }
  }

  /**
   * Track W2 (nav/digout.ts): from a node of a dig-out staircase (`F_CUT`), on up the bank by a jump with breaks
   * (Baritone MovementAscend, `digAscend`) where the plain jump did not go: the target one up is blocked, or the
   * jump lacked only the head room over the start. The new node is on the cut too, up to DIG_OUT_MAX_STEPS steps
   * from the water. No other move digs without `allowBreak`.
   */
  private cutMoves(cur: number, cx: number, cy: number, cz: number): void {
    const cut = this.nodes.cut[cur]!;
    const steps = cut & ~CUT_UNPAID;
    if (steps >= DIG_OUT_MAX_STEPS || !this.moveOn('digAscend')) return;
    const unpaid = (cut & CUT_UNPAID) !== 0 ? DIG_OUT_PENALTY : 0;
    const b = this.breaks!;
    const flags = this.digFlags;
    for (let di = 0; di < 4; di++) {
      const [dx, dz] = CARDINAL[di]!;
      const nx = cx + dx;
      const nz = cz + dz;
      const blocked = (flags[di]! & 1) !== 0;
      if (!((blocked && Number.isNaN(this.grid.stand(nx, cy + 1, nz))) || (flags[di]! & 4) !== 0)) continue;
      if (!this.ladderPass(cx, cy, cz, nx, nz, dx, dz, true)) continue;
      const a = ascend(b, cx, cy, cz, nx, nz);
      this.takeUnknown();
      if (a) this.relax(cur, nx, cy + 1, nz, cy + 1, a.base, M_JUMP, a.extra + unpaid, 0, { dig: a.dig }, F_CUT, steps + 1);
    }
  }

  /**
   * Track W2 (nav/digout.ts `digOutStep`): from surface swim node (cx, cy, cz) out over the lip into column (nx, nz):
   * the lip and the head room over it broken, the body climbs out onto the block at the water's level (`swimOut`,
   * feet cy + 1). The new node starts a dig-out staircase (`F_CUT`). A refusal is counted for the trapped report.
   */
  private digOut(cur: number, cx: number, cy: number, cz: number, nx: number, nz: number, dx: number, dz: number): void {
    const b = this.breaks!;
    const refused = this.digOutRefused!;
    const step = digOutStep(this.grid, b.mining, cy, nx, nz, (why, c) => refused.add(why, c));
    if (!step || !this.ladderPass(cx, cy, cz, nx, nz, dx, dz, true)) return;
    this.relax(cur, nx, cy + 1, nz, cy + 1, this.costs.swimOut, M_SWIM_OUT, step.extra, 0, { dig: step.dig }, F_CUT, 1);
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
    const costs = this.costs;
    const w = grid.swim(nx, ny, nz);
    if (w === undefined) {
      this.sawUnknown = true;
      return;
    }
    if (isFeet(w)) {
      const room = grid.freeColumn(nx, ny + 1, Math.max(headCell, cy + 1), nz);
      if (room === undefined) this.sawUnknown = true;
      if (room !== true) return;
      this.relax(cur, nx, ny, nz, w, costs.walk + (d > 0 ? (costs.fall[d] ?? 0) : 0), M_SWIM, costs.swimEnter, 0, undefined, F_SWIM);
      return;
    }
    // Track W1: water that is no surface node (a flooded passage, flowing or falling water): a dive node; the
    // cells the body passes on its way in (above the node up to the head) free or water
    if (!this.diveOn()) return;
    const dv = grid.dive(nx, ny, nz);
    if (dv === undefined) this.sawUnknown = true;
    if (!isFeet(dv)) return;
    for (let y = ny + 1; y <= Math.max(headCell, cy + 1); y++) if (!this.waterRoom(nx, y, nz)) return;
    this.relax(cur, nx, ny, nz, dv, costs.walk + (d > 0 ? (costs.fall[d] ?? 0) : 0), M_DIVE, costs.swimEnter + costs.diveEnter, 0, undefined, F_DIVE);
  }

  /**
   * Track W1: planned ticks from a dive node straight up until the head is out of the water (every water cell
   * over the feet cell at `diveUp`; Infinity when the column ends in anything but air, or is not loaded).
   */
  private riseTicks(x: number, y: number, z: number): number {
    for (let k = 1; k <= RISE_SCAN; k++) {
      const w = this.grid.water(x, y + k, z);
      if (w === undefined) return Infinity;
      if (w) continue;
      return this.grid.free(x, y + k, z) === true && this.grid.cls(x, y + k, z)?.liquid === undefined ? (k - 1) * this.costs.diveUp : Infinity;
    }
    return Infinity;
  }

  /** Track W1: dive moves are on (they need the surface moves too). */
  private diveOn(): boolean {
    return this.moveOn('dive') && this.moveOn('swim');
  }

  /** Track W1: the body may pass through cell (x, y, z) in or out of the water: passable or water (no box). */
  private waterRoom(x: number, y: number, z: number): boolean {
    const f = this.grid.free(x, y, z);
    if (f === undefined) {
      this.sawUnknown = true;
      return false;
    }
    return f || this.grid.water(x, y, z) === true;
  }

  /**
   * Track W1: moves of a dive node (the body under water, docs/pathfinding.md "Water (Track W1)"): up into the
   * surface node or the dive node above (jump held), down into the dive node below (sneak), across into the 8
   * neighbouring water nodes at the same level (diagonals with both side cells water), out onto a floor beside
   * at the feet level or 1 higher (`swimOut`; the cell over the body water or free for the rise).
   */
  private expandDive(cur: number, cx: number, cy: number, cz: number): void {
    const grid = this.grid;
    const costs = this.costs;
    // up
    const up = grid.swim(cx, cy + 1, cz);
    if (up === undefined) this.sawUnknown = true;
    else if (isFeet(up)) this.relax(cur, cx, cy + 1, cz, up, costs.diveUp, M_SWIM, 0, 0, undefined, F_SWIM);
    else {
      const d = grid.dive(cx, cy + 1, cz);
      if (d === undefined) this.sawUnknown = true;
      else if (isFeet(d)) this.relax(cur, cx, cy + 1, cz, d, costs.diveUp, M_DIVE, 0, 0, undefined, F_DIVE);
    }
    // down
    const down = grid.dive(cx, cy - 1, cz);
    if (down === undefined) this.sawUnknown = true;
    else if (isFeet(down)) this.relax(cur, cx, cy - 1, cz, down, costs.diveDown, M_DIVE, 0, 0, undefined, F_DIVE);
    // across, and out onto a floor beside
    for (const [dx, dz] of CARDINAL) {
      const nx = cx + dx;
      const nz = cz + dz;
      const kind = this.waterNode(nx, cy, nz);
      if (kind === F_SWIM) {
        this.relax(cur, nx, cy, nz, cy, costs.dive, M_SWIM, 0, 0, undefined, F_SWIM);
        continue;
      }
      if (kind === F_DIVE) {
        this.relax(cur, nx, cy, nz, cy, costs.dive, M_DIVE, 0, 0, undefined, F_DIVE);
        continue;
      }
      for (let ny = cy; ny <= cy + 1; ny++) {
        const f1 = grid.stand(nx, ny, nz);
        if (f1 === undefined) {
          this.sawUnknown = true;
          break;
        }
        if (!isFeet(f1)) continue;
        if (f1 < cy - FLAT || f1 > cy + 1 + FLAT) break;
        if (f1 > cy + STEP && !this.waterRoom(cx, cy + 2, cz)) break; // the rise needs the cell over the head
        if (!this.ladderPass(cx, cy, cz, nx, nz, dx, dz, f1 > cy + STEP)) break;
        this.relax(cur, nx, ny, nz, f1, costs.swimOut + (f1 > cy + STEP ? costs.diveUp : 0), M_SWIM_OUT);
        break;
      }
    }
    for (const [dx, dz] of DIAGONAL) {
      const nx = cx + dx;
      const nz = cz + dz;
      const kind = this.waterNode(nx, cy, nz);
      if (kind === 0 || this.waterNode(nx, cy, cz) === 0 || this.waterNode(cx, cy, nz) === 0) continue;
      this.relax(cur, nx, cy, nz, cy, costs.dive * Math.SQRT2, kind === F_SWIM ? M_SWIM : M_DIVE, 0, 0, undefined, kind);
    }
  }

  /** Track W1: the water node at (x, y, z): F_SWIM (a surface node), F_DIVE (under water), 0 (none or not loaded). */
  private waterNode(x: number, y: number, z: number): number {
    const s = this.grid.swim(x, y, z);
    if (s === undefined) {
      this.sawUnknown = true;
      return 0;
    }
    if (isFeet(s)) return F_SWIM;
    const d = this.grid.dive(x, y, z);
    if (d === undefined) this.sawUnknown = true;
    return isFeet(d) ? F_DIVE : 0;
  }

  /** Track BI: drops deeper than maxDrop into column (nx, nz) (skills/fall/plan.ts), relaxed as drop moves. */
  private longDrops(cur: number, cy: number, f0: number, nx: number, nz: number): void {
    const out: LongDrop[] = [];
    if (longDrops(this.grid, this.costs, this.opts.falls!, nx, cy, nz, f0, out)) this.sawUnknown = true;
    for (const o of out) this.relax(cur, nx, o.y, nz, o.feet, o.base, M_DROP, o.extra, o.trap);
  }

  /** A climb into node (x, y, z) has head room: the cell above the body (y + 2) is passable. */
  private climbRoom(x: number, y: number, z: number): boolean {
    const f = this.grid.free(x, y + 2, z);
    if (f === undefined) this.sawUnknown = true;
    return f === true;
  }

  // ---- Track BG: trapdoors in floors and ceilings (hatches; decisions/0048-trapdoor-moves.md) ------------

  /**
   * Track AJ: up the column into climb node (x, y, z) (a climber with the cell above passable, head room
   * over that). Track BG: a closed trapdoor right above the climber is opened from below first (`allowOpen`):
   * the node's move carries the use.
   */
  private climbUpInto(cur: number, x: number, y: number, z: number): void {
    const grid = this.grid;
    const costs = this.costs;
    const up = grid.climb(x, y, z);
    if (up === undefined) {
      this.sawUnknown = true;
      return;
    }
    if (isFeet(up)) {
      // Track BG: under a hatch (y + 2) the body stops 0.2 below it, to open it from there
      if (this.climbRoom(x, y, z) || ((grid.variety & VARIETY_TRAPDOOR) !== 0 && grid.cls(x, y + 2, z)?.openable === 'trapdoor')) this.relax(cur, x, y, z, up, costs.climbUp, M_CLIMB, 0, 0, undefined, F_CLIMB);
      return;
    }
    if ((grid.variety & VARIETY_TRAPDOOR) === 0 || !this.moveOn('trapdoor')) return;
    const c = grid.cls(x, y, z);
    if (!c || !grid.climbable(x, y, z) || c.liquid || c.danger || grid.cls(x, y + 1, z)?.openable !== 'trapdoor') return;
    const use = this.hatchUse(x, y + 1, z);
    if (!use || !this.climbRoom(x, y, z)) return;
    this.relax(cur, x, y, z, y, costs.climbUp, M_CLIMB, use.length * costs.door, 0, use.length ? { use } : undefined, F_CLIMB);
  }

  /**
   * Track BG: what passing vertically through trapdoor cell (x, y, z) needs: [] (open, room beside its
   * panel), [cell] (closed: toggle it first; `allowOpen`, not blacklisted), undefined (cannot).
   */
  private hatchUse(x: number, y: number, z: number): Vec3[] | undefined {
    const h = this.grid.hatch(x, y, z);
    if (h === undefined) {
      this.sawUnknown = true;
      return undefined;
    }
    if (h === CROSS_CLEAR) return [];
    if (h !== CROSS_TOGGLE || !this.opts.allowOpen || this.opts.noAction?.has(cellKey(x, y, z))) return undefined;
    return [{ x, y, z }];
  }

  /**
   * Track BG: from a node standing on a full block at level cy, along (dx, dz) down through a trapdoor in
   * column (nx, nz): in the walking layer (cy: the walk enters past its panel) or in the floor ahead (cy - 1:
   * the walking layer above it free). Under it: a ladder right below (a climb node: the body drops onto it
   * and slides), else a fall through free cells onto a floor at most `maxDrop` below the feet, or into still
   * water at most HATCH_WATER_FALL below (Baritone's MovementFall: no fall damage into water). A closed
   * trapdoor is opened first (the move's `use`).
   */
  private hatchDown(cur: number, cx: number, cy: number, cz: number, f0: number, headCell: number, nx: number, nz: number, dx: number, dz: number): void {
    const grid = this.grid;
    const costs = this.costs;
    for (let hy = cy; hy >= cy - 1; hy--) {
      if (grid.cls(nx, hy, nz)?.openable !== 'trapdoor') continue;
      const use = this.hatchUse(nx, hy, nz);
      if (!use) continue;
      // into the column above the hatch (the hatch in the walking layer: its panel lets the walk in)
      let ok = true;
      for (let y = cy; y <= Math.max(headCell, cy + 1) && ok; y++) {
        if (y === hy) {
          ok = grid.hatchLets(nx, y, nz, dx, dz, true);
          continue;
        }
        const f = grid.free(nx, y, nz);
        if (f === undefined) this.sawUnknown = true;
        ok = f === true;
      }
      if (!ok || !this.ladderPass(cx, cy, cz, nx, nz, dx, dz, false)) continue;
      const extra = use.length * costs.door;
      const act = use.length ? { use } : undefined;
      const lc = grid.cls(nx, hy - 1, nz);
      if (!lc) {
        this.sawUnknown = true;
        continue;
      }
      if (grid.climbable(nx, hy - 1, nz) && !lc.liquid && !lc.danger) {
        if (this.moveOn('climb')) this.relax(cur, nx, hy - 1, nz, hy - 1, costs.walk + costs.climbDown * (cy - hy + 1), M_CLIMB, costs.climbEnter + extra, 0, act, F_CLIMB);
        continue;
      }
      for (let ny = hy - 1; cy - ny <= HATCH_WATER_FALL; ny--) {
        const w = grid.cls(nx, ny, nz);
        if (!w) {
          this.sawUnknown = true;
          break;
        }
        if (w.liquid === 'water') {
          const s = this.moveOn('swim') ? grid.swim(nx, ny, nz) : Number.NaN;
          if (s === undefined) this.sawUnknown = true;
          else if (isFeet(s) && ny + 2 < hy) this.relax(cur, nx, ny, nz, s, costs.walk + (costs.fall[Math.min(cy - ny, costs.fall.length - 1)] ?? 0), M_SWIM, costs.swimEnter + extra, 0, act, F_SWIM);
          break;
        }
        if (cy - ny <= costs.maxDrop + 1) {
          const f1 = grid.stand(nx, ny, nz);
          if (f1 === undefined) {
            this.sawUnknown = true;
            break;
          }
          if (isFeet(f1)) {
            const fall = f0 - f1;
            if (Math.floor(f1 + PHYSICS.height - 1e-6) < hy && fall <= costs.maxDrop + 1e-6) {
              this.relax(cur, nx, ny, nz, f1, dropCost(costs, fall), M_DROP, extra, fall > MAX_JUMP_RISE + 1e-6 ? costs.irreversibleDrop : 0, act);
            }
            break;
          }
        }
        const fr = grid.free(nx, ny, nz);
        if (fr === undefined) this.sawUnknown = true;
        if (fr !== true) break;
      }
    }
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
    const dive = this.diveOn(); // Track W1
    for (const [dx, dz] of CARDINAL) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (swimAt(nx, nz)) {
        this.relax(cur, nx, cy, nz, cy, costs.swim, M_SWIM, 0, 0, undefined, F_SWIM);
        continue;
      }
      // Track W1: on into water at the same level that is no surface node (under a low roof, flowing water)
      if (dive) {
        const d = grid.dive(nx, cy, nz);
        if (d === undefined) this.sawUnknown = true;
        else if (isFeet(d)) {
          this.relax(cur, nx, cy, nz, d, costs.dive, M_DIVE, costs.diveEnter, 0, undefined, F_DIVE);
          continue;
        }
      }
      // out: a bank from the water level up to 1 block higher. Track W1: never over a 1-block lip (a bank 2 above the
      // top water cell): on BDS 1.26.60 forward + jump against it only bobs the body (docs/pathfinding.md "Water")
      let bank = false; // Track W2: a floor to climb out onto (or not loaded): no step to dig
      for (let ny = cy; ny <= cy + 1; ny++) {
        const f1 = grid.stand(nx, ny, nz);
        if (f1 === undefined) {
          this.sawUnknown = true;
          bank = true;
          break;
        }
        if (isFeet(f1)) {
          // Track W2: the bank's node may start a dig-out staircase (its first dug step pays the dig-out price)
          const cutting = this.digOutRefused && Math.abs(f1 - ny) < FLAT ? F_CUT : 0;
          if (f1 >= cy - FLAT && f1 <= cy + 1 + FLAT) this.relax(cur, nx, ny, nz, f1, costs.swimOut, M_SWIM_OUT, 0, 0, undefined, cutting, cutting ? 1 | CUT_UNPAID : 0);
          bank = true;
          break;
        }
      }
      // Track W2: no way out here: dig a step into the lip (nav/digout.ts), from the surface only (breathing)
      if (!bank && this.digOutRefused) this.digOut(cur, cx, cy, cz, nx, nz, dx, dz);
    }
    for (const [dx, dz] of DIAGONAL) {
      if (swimAt(cx + dx, cz + dz) && swimAt(cx + dx, cz) && swimAt(cx, cz + dz)) this.relax(cur, cx + dx, cy, cz + dz, cy, costs.swim * Math.SQRT2, M_SWIM, 0, 0, undefined, F_SWIM);
    }
    // Track W1: down under the surface (sneak)
    if (dive) {
      const d = grid.dive(cx, cy - 1, cz);
      if (d === undefined) this.sawUnknown = true;
      else if (isFeet(d)) this.relax(cur, cx, cy - 1, cz, d, costs.diveDown, M_DIVE, costs.diveEnter, 0, undefined, F_DIVE);
    }
  }

  /** Moves of a climb node: up and down the column, off it onto a floor beside it from its level up to 1 higher. */
  private expandClimb(cur: number, cx: number, cy: number, cz: number, f0: number): void {
    const grid = this.grid;
    const costs = this.costs;
    // up (the feet cell is a climber: the body is lifted while its feet are in it); Track BG: through a hatch above too
    this.climbUpInto(cur, cx, cy + 1, cz);
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
        // Track BG: a hatch in the column opened by this plan (still closed in the grid): its panel once open
        if ((grid.variety & VARIETY_TRAPDOOR) !== 0 && (!grid.hatchLets(cx, lvl, cz, dx, dz, false) || !grid.hatchLets(cx, lvl + 1, cz, dx, dz, false))) break;
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

}

/**
 * Track BC: the lowest y among a goal's points: block / near / getToBlock (the block's y), yLevel, the
 * members of an `any`; +Infinity for goals without one (xz, surface, runAway: never dig down for a column,
 * to flee or to get out).
 */
/** Track BD review: the cell (x, y, z) lies inside the base (`protectedArea`, the break rules' same distance test, helper.ts). */
function inArea(area: PathOptions['protectedArea'], x: number, y: number, z: number): boolean {
  return !!area && Math.hypot(x + 0.5 - area.x, y + 0.5 - area.y, z + 0.5 - area.z) <= area.r;
}

/** Track W3: the cell of a `block` goal holds water (a waypoint on a water floor or in a pool): reached swimming or diving there. */
function waterBlockGoal(grid: NavGrid, p: Vec3): boolean {
  return grid.cls(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))?.liquid === 'water';
}

/** Track W1: water in the cell of point p or the one under it (a `near` goal around a swimming player). */
function waterNear(grid: NavGrid, p: Vec3): boolean {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  const z = Math.floor(p.z);
  return grid.cls(x, y, z)?.liquid === 'water' || grid.cls(x, y - 1, z)?.liquid === 'water';
}

function goalMinY(goal: NavGoal): number {
  switch (goal.type) {
    case 'block':
    case 'near':
    case 'getToBlock':
      return goal.p.y;
    case 'twoBlocks': // Track BD: the lowest feet cell of the mine process' column goals
      return goal.p.y - 1;
    case 'threeBlocks':
      return goal.p.y - 2;
    case 'yLevel':
      return goal.y;
    case 'any': {
      let m = Infinity;
      for (const g of goal.goals) m = Math.min(m, goalMinY(g));
      return m;
    }
    case 'xz':
      return Infinity; // a column, any height: never dig down for it (a bold `goto x z` would evaluate staircases at every node)
    default:
      return Infinity;
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
    // Track W1: under water (on a pool's floor, mid-depth, in a flooded passage): the dive node of the feet cell
    for (const y of [y0, y0 + 1, y0 - 1]) if (isFeet(grid.dive(bx, y, bz))) return { x: bx, y, z: bz, feet: y };
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
  // Track BC: a body under a low ceiling (not in a standable cell) is in a sneak node: its own cell, sneaking
  if (bestD > 1e-9 && Math.abs(pos.y - y0) < 0.6 && sneakFits(grid, bx, y0, bz) === true) return { x: bx, y: y0, z: bz, feet: y0 };
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

/** Track R1: the goal's point lies in unloaded world (the frontier end's condition; goals without one: false). */
function goalUnloaded(goal: NavGoal, grid: NavGrid): boolean {
  switch (goal.type) {
    case 'block':
    case 'near':
    case 'getToBlock':
    case 'twoBlocks':
    case 'threeBlocks':
      return grid.cls(Math.floor(goal.p.x), Math.floor(goal.p.y), Math.floor(goal.p.z)) === undefined;
    case 'xz':
      return grid.cls(goal.x, grid.source.minY ?? -64, goal.z) === undefined;
    default:
      return false;
  }
}
