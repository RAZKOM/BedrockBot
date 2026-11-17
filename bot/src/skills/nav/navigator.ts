// goto (PLAN.md tasks 3.5, 3.6, 7.1, 7.2): plans with A* in segments, drives the InputLoop with a
// PathFollower, and runs the world-changing moves (dig-through, pillar-up, doors) through injected
// actions. See docs/pathfinding.md.
//
//   segments    A search stops at a node / time budget and returns the best partial path; while the
//               body walks it, the next segment is planned from its end (plan-ahead) and spliced on.
//               Searches run in slices of `sliceMs` per tick, so a tick never waits long for the planner.
//               A segment that ends at unloaded world waits for the chunks (not a failure).
//   legs        The path is walked in legs that end before a node with an action: the body stops,
//               the action runs (dig the cells, toggle the door, jump and place), then the next leg.
//   re-plans    on corrections, knockback, teleports, block updates near the remaining path, the end
//               of a partial path, a per-move timeout (2 x the move's estimate + 10 ticks), no progress
//               for `stuckTicks`, a failed action. After `maxFailures` stuck / failed plans:
//               'unreachable'. A failure while not standing safely first retreats to the last safe node.
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import { breakTicksWith } from './baritone/helper.ts'; // Track BB: the shared break-time lookup
import { sneakFits } from './baritone/moves.ts'; // Track BC: a goal cell the body fits sneaking
import type { InputLoop, InputLoopState } from '../input/inputLoop.ts';
import { restsOn } from '../input/physics.ts'; // Track R7: a body the teleport's answer calls grounded that rests on nothing
import { classify, type TerrainClass } from '../terrain/classify.ts';
import type { TerrainSource } from '../terrain/query.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { DEFAULT_THROWAWAY, DIG_REPEATS, DIG_SETTLE_TICKS, type BreakRules, type NavActions } from './actions.ts'; // Track BC: DIG_REPEATS, DIG_SETTLE_TICKS
import { MAX_JUMP_RISE, PathSearch, explainStart, findPath, goalUnloaded, handBreakTicks, locateNode, locateStart, perchGoal, type LocatedNode, type PathNode, type PathOptions, type PathResult } from './astar.ts';
import { DEFAULT_COSTS, TICKS, type PathCosts } from './costs.ts'; // Track BI: DEFAULT_COSTS, PathCosts (dropCheck)
import { PathFollower, PressGuard, yawTowards } from './follower.ts';
import { goalTest, type NavGoal } from './goals.ts'; // Track R: NavGoal (task 7.10 goal types)
import { CROSS_CLEAR, NavGrid, cellKey } from './grid.ts';
import { NavBlacklist, actionKey, goalKey } from './blacklist.ts'; // Track R
import type { AvoidanceCostFn } from './avoidance.ts';
import { DEFAULT_PLANNER_BUDGETS, PlannerClient, WorkerSearch, plainGoal, type PlannerBudgets, type PlannerWorld, type WorkerPlanOptions } from './worker.ts'; // Track AB
import { MOVEMENT_TIMEOUT_TICKS, OFF_PATH_GRACE_TICKS, PATH_WINDOW_AHEAD, PATH_WINDOW_BACK, distanceFromPath, nodeAt, nodeOverrun, offPathState, skipAhead } from './baritone/executor.ts'; // Track BE
import { corridorState, fineTarget, touches, waypointGoal, type CorridorState } from './corridor.ts'; // Track CB: following a coarse corridor
import type { CoarseLayer, CoarseMode, CorridorStatus } from '../coarse/types.ts'; // Track CB
import { AirClock, bodyInWater, headUnderWater } from './water.ts'; // Track W1
import { trappedWhy, waterDigConditions } from './digout.ts'; // Track W2
import { RESUME_KEEP_MS, REJOIN_MAX, REJOIN_MS, REJOIN_NODES, WAY_AHEAD, WAY_BACK, clearlyShorter, nearestOnWay, nodeOnWay, wayActions, wayBlocks, wayBroken, wayFrom } from './way.ts'; // Track W2 way
import { DIG_WAY_MAX_BLOCKS, DIG_WAY_PRICE, LONG_DIG_PRICE, LONG_DIG_WEIGHT, fallsHurt, harmlessFalls, lastResortFalls, longDigOptions, type DigWayLevel } from './digway.ts'; // Track W3; Track R3: the long dig search
import { isNaturalTerrain } from '../place/scaffold.ts'; // Track R1
import { REACH_RULES, causeTag, causeWords, fallOnPath, fallWords, relaxOptions, rulesOnPath, sealedPocket, type ReachCause, type ReachRule, type RefusedFall } from './reach.ts'; // Track R1; Track R2: fallOnPath; Track R4: fallWords

/** Track R: goto options of the navigator. `blacklist`: consult and feed the failure blacklist (default: `any` and `getToBlock` goals). */
export type NavGotoOptions = GotoOptions & { blacklist?: boolean };

/**
 * Track R7: why a `block` goal's cell cannot be stood on, when the walk ends next to it (GotoOptions.beside). Track R8:
 * `no entry`, a cell no move ever enters (a portal, fire, a cobweb, a berry bush, powder snow: a hazard with no box).
 */
export type BesideKind = 'solid' | 'no head room' | 'in the air' | 'no entry';
/** Track R7: an open goal cell is ended under (its own column's node) when that node is at most this many cells below it (the eye 3.9 from the cell's centre at 5: in reach). */
export const BESIDE_AIR_MAX = 5;
/**
 * Track R8: a `beside` goto whose search from where the body stands goes nowhere with the feet within this of the goal
 * cell's floor centre ends there soon (Navigator.nearNoWay), with a truthful answer (finishShort), not after the ladder.
 */
export const NEAR_END = 8;
/** Track R8: an end short of the goal's cell with the eye within this of the cell's centre is in reach of it: `ok` with a note (R7's air rule: 5 over a floor). */
export const NEAR_REACH = 3.9;
/** Track R8: a near end's single-rule "why" searches run with this share of the main budget (they only name the rule). */
const NEAR_SINGLE = 0.25;
/** Track R8: an open goal cell whose own column's node has its feet less than this under the cell's floor is that node's cell (a path block's top 0.94). */
const BESIDE_LOW_TOP = 0.5;

/** Track R8: a cell no move enters: a hazard with no box (portal, end portal, end gateway, fire, cobweb, berry bush, powder snow, wither rose); liquids are not. */
function noEntry(c: TerrainClass): boolean {
  return c.boxes.length === 0 && !c.liquid && c.danger;
}

/** Track R8: the rule a near end's way on would break, as what it needs (`a block placed (a goto places no blocks)`). */
const NEED_WORDS: Readonly<Record<ReachRule, string>> = {
  protected_area: 'digging in the base (protectRadius)',
  built: 'a built block broken (no breaking built blocks)',
  liquid: 'digging beside water or lava',
  gravity: 'digging under sand or gravel',
  falls: 'a fall below fallMargin',
  dig_budget: `more than ${DIG_WAY_MAX_BLOCKS} dug blocks or a slow one`,
  place: 'a block placed (a goto places no blocks)',
};

/** Track R8: why a near end stopped, in words: what the rest of the way needs, or that nothing gets nearer. */
export function shortWhy(c: ReachCause | undefined, fallback?: string): string {
  if (!c) return fallback ?? 'no way nearer';
  switch (c.cls) {
    case 'rule':
      return `the rest needs ${c.rules.map((r) => (r === 'falls' && c.fall ? fallWords(c.fall) : NEED_WORDS[r])).join(' and ')}`;
    case 'world':
      return 'no walk, swim or dig gets nearer';
    case 'unloaded':
      return 'the world past here is not loaded';
    case 'budget':
      return 'no way nearer found within the searches\' budget';
  }
}

/** What the navigator needs from the world model. `World` + `worldSource()` provide it. */
export interface NavWorld {
  source: TerrainSource;
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
  /**
   * Track BC: a section was (re)placed by a chunk packet (`ChunkStore.onSection`); `reloaded` is true when
   * its column was already loaded, and also once when a column is dropped (`ChunkStore.onColumnUnloaded`:
   * a chunk re-sent after a teleport replaces its column with a fresh unloaded one, and a server-side fill
   * carries changes that never came as block updates). The navigator then drops its grid caches once, on
   * its next tick. A first load has nothing cached. Optional (fakes).
   */
  onSection?(fn: (reloaded: boolean) => void): () => void;
}

/** The inventory as the navigator reads it (break times with the best tool, throwaway blocks). */
export interface NavInventory {
  readonly slots: readonly ({ name: string; count: number } | null | undefined)[];
  readonly selected: number;
}

export interface NavigatorOptions {
  logger?: Logger;
  /** Ticks without progress before a re-plan (the fallback behind per-move timeouts). Default 40. */
  stuckTicks?: number;
  /** Stuck events / failed plans / failed actions before giving up. Default 3. */
  maxFailures?: number;
  /** Planner options (costs, limits); per-goto flags come from GotoOptions. */
  path?: PathOptions;
  /** Max yaw change per tick while walking. Default 30. */
  maxTurnDeg?: number;
  /** World-changing actions for dig-through, pillar-up and door moves (all optional). */
  actions?: NavActions;
  /** The inventory, for break times with the best hotbar tool and for throwaway blocks. */
  inventory?: () => NavInventory | undefined;
  /** Search time per tick, ms. Default 8. */
  sliceMs?: number;
  /** Node budget of one segment (unless `path.maxNodes`). Default 20 000. */
  segmentNodes?: number;
  /** Search-time budget of one segment in ms (unless `path.maxMs`). Default 100. */
  segmentMs?: number;
  /** Search-time budget of a main plan in ms (the body waits for it; the plan-ahead extends it). Default 40. */
  mainMs?: number;
  /** Plan the next segment once fewer than this many nodes of the current one are left. Default 64. */
  aheadNodes?: number;
  /** Ticks to wait for unloaded chunks at the end of a segment before it counts as a failure. Default 200. */
  unloadedWaitTicks?: number;
  /** Per-move timeout: `factor` x the move's estimated ticks + `margin`. Default 2 and 10. */
  moveTimeout?: { factor: number; margin: number };
  /** Track S: extra cost per feet cell, built afresh for every plan (mob / spawner avoidance, nav/avoidance.ts). */
  cellCost?: () => PathOptions['cellCost'];
  /** The base around home: nothing is broken inside (read live each plan; setProtect replaces it). */
  protect?: () => BreakRules['protectedArea'] | undefined;
  /** Ticks added per dug block on top of the break time (read live each plan; setDigPenalty replaces it). */
  digPenalty?: () => number | undefined;
  /** Track R: the failure blacklist (default: a new one on this navigator's tick clock, 3 failures, 6000 ticks). */
  blacklist?: NavBlacklist;
  blacklistFailures?: number;
  blacklistTicks?: number;
  /** Track AB: search budgets in the planner worker (default 500 000 nodes / 2 s main, 60 000 / 300 ms segment). */
  workerBudgets?: Partial<PlannerBudgets>;
  /** Track AJ: the follower sneaks near deep edges (docs/pathfinding.md "Edge sneaking"). Default true. */
  edgeSneak?: boolean;
  // Track BE: the executor's off-path checks (nav/baritone/executor.ts, docs/pathfinding.md "Off the path")
  /**
   * Track BE: off-path re-plans, skip-ahead, the snap to the path after a correction / knock / teleport,
   * action overruns. Default true; false is main's behaviour (every such event re-plans).
   */
  offPath?: boolean;
  /** Track BE: ticks a body 2 to 3 blocks off the path gets to come back before a re-plan. Default 20 (Baritone: 200). */
  offPathGraceTicks?: number;
  /** Track BE: an action fails once it runs longer than `factor` x its node's cost + `margin` ticks. Default 1 and 100 (Baritone's movementTimeoutTicks). */
  overrun?: { factor: number; margin: number };
  /** Track BE: abort a running dig (the Digger's cancel) when the navigator gives up on it (dig timeout). */
  cancelDig?: () => void;
  /** Track BE: the tool filter the Digger uses (Track S worn tools count as an empty hand), so the planned break times match the dig. */
  toolOk?: () => ((item: { name: string; count: number }) => boolean) | undefined;
  // Track BE end
  /**
   * Track W2 (nav/digout.ts): a body in a pool with no swim exit (or a far longer one) digs a step into the lip
   * and cuts a staircase up a taller bank, under the break rules, on every goto (PathOptions.digOut; needs the
   * dig action). Default true.
   */
  digOut?: boolean;
  /**
   * Track W3 (nav/digway.ts): a goto whose plain search finds no way digs one through natural blocks (at most
   * DIG_WAY_MAX_BLOCKS a goto) before it takes a fall that hurts. Needs the dig action. Default false (the session
   * reads the `digWay` setting, default on). Whatever this says, no planned fall hurts while a harmless way exists.
   */
  digWay?: boolean;
}

export type ReplanReason = 'start' | 'correction' | 'block' | 'partial' | 'stuck' | 'timeout' | 'action' | 'retry' | 'ahead' | 'upgrade' | 'off_path' | 'overrun' | 'corridor'; // Track BE: off_path, overrun; Track CB: corridor

/** Track CB: what the coarse layer did for a goto (docs/coarse.md). */
export interface CorridorReport {
  /** Corridor requests made (the start, a change near the corridor, a failed waypoint, the end of a partial one). */
  requests: number;
  /** Waypoints the fine planner could not reach (their portals marked failed). */
  failed: number;
  /** The last corridor: status, legs, blocks, waypoints, search time (ms). */
  status?: CorridorStatus;
  legs?: number;
  blocks?: number;
  waypoints?: number;
  ms?: number;
  /** Waypoints reached. */
  passed: number;
}

export interface PlanRecord {
  reason: ReplanReason;
  tick: number;
  status: PathResult['status'];
  nodes: number;
  expanded: number;
  /** Search time, ms. */
  ms: number;
  /** Ticks the search was sliced over. */
  slices: number;
  /** Track AB: planned in the worker or in-thread. */
  via?: 'worker' | 'thread';
  /** The search stopped at its node / time budget. */
  limited?: boolean;
  /** Track AB: the worker's interim answer of a main plan (the body walks it while the search goes on). */
  interim?: boolean;
  /** Track AB: the final answer of a main plan whose interim answer was walked (spliced in where the two meet). */
  upgrade?: boolean;
  /** Track BA: a `no_progress` answer (no partial end 5+ blocks from the start). */
  noProgress?: boolean;
  /** The search touched unloaded world. */
  unknown?: boolean;
  /**
   * Track W2 way: no search, the kept way walked on from the node the body stands on (`on`), or a rejoin search's way
   * back onto it (`rejoin`). `kept` on a fresh plan searched beside a kept way: `way` the way stayed, `fresh` it replaced it.
   */
  way?: 'on' | 'rejoin';
  kept?: 'way' | 'fresh';
  /** Track W2 way: blocks of the path this plan left the goto walking (the plan line's number). */
  blocks?: number;
}

/** What happened during one goto (for tests, metrics and logs). */
export interface GotoReport {
  goal: NavGoal;
  result: SkillResult | undefined;
  /** Track R: `any` goal: the member reached (index into `goal.goals`). */
  reached?: { index: number; goal: NavGoal };
  /** Track R: blacklist keys skipped when planning (the goal or `any` members). */
  skipped?: string[];
  /** Track R: keys this goto's failure put on the blacklist. */
  blacklisted?: string[];
  ticks: number;
  /** Distance the body moved (sum of per-tick displacements), blocks. */
  distance: number;
  corrections: number;
  motions: number;
  plans: PlanRecord[];
  /** Segments walked (main plans + spliced plan-aheads). */
  segments: number;
  stuck: number;
  /** Per-move timeouts (part of `stuck`). */
  moveTimeouts: number;
  failures: number;
  /** Track AJ: ticks the follower sneaked (edge sneaking, holding on a ladder). */
  sneakTicks?: number;
  /** Ticks spent sprinting. */
  sprintTicks: number;
  /** Longest time one tick spent in the navigator (planning slices included), ms. */
  maxTickMs: number;
  /** Total search time, ms. */
  planMs: number;
  /** Actions run (and failed). */
  actions: { dig: number; use: number; place: number; close: number; failed: number };
  /** Retreats to the last safe node. */
  retreats: number;
  /** Ticks spent waiting for unloaded chunks. */
  unloadedWait: number;
  /** Track R4: ticks the goto held for a block on its only fall to pass (startHold). */
  held?: number;
  /** Track R5: main plans started from a perch (a fence's top: astar `locatePerch`). */
  perchStarts?: number;
  /** Track R5: ticks waited with no start node while the body was still in the air (SETTLE_TICKS at most). */
  settleTicks?: number;
  /** Track R7: of `perchStarts`, those from a low perch (NavGrid.lowPerch: the body held crouched under an eave). */
  lowStarts?: number;
  /**
   * Track R6: the goal's cell is a perch (a fence's top): `on` the walk ended on it, `beside` next to it (`perchRing`: no
   * way onto it), with the distance from the body's feet to the top's centre at the end.
   */
  perchGoal?: { end: 'on' | 'beside'; on: string; dist?: number };
  /**
   * Track R7: a `block` goal nobody stands in, walked to next to it (GotoOptions.beside): the kind (`solid`, `no head
   * room`, `in the air`), what is in the cell, and the distance from the body's feet to the cell's floor centre at the end.
   */
  beside?: { kind: BesideKind; what: string; dist?: number };
  /**
   * Track R8: a `beside` goto that ended short of the goal's cell (finishShort): the feet's distance from the cell's floor
   * centre, the eye's from its centre, `within` (the eye within NEAR_REACH: an `ok` with a note), and why it stopped.
   */
  short?: { dist: number; eye: number; within: boolean; why: string };
  /** Track R8: the ticks from the first near end (nearNoWay: the body stood where no search got it nearer) to the answer. */
  nearTicks?: number;
  /** Track AB: worker answers spliced into the path being walked, and answers dropped as stale (blocks changed near them). */
  upgrades?: number;
  stale?: number;
  /** Track BE: off-path re-plans, legs restarted at the node the body stands in (skip-ahead; after a correction / knock / teleport), action overruns. */
  offPath?: number;
  skips?: number;
  snaps?: number;
  overruns?: number;
  /** Track R3: ways the long dig search found and the goto walked (a partial one only towards a corridor waypoint). */
  longDigPlans?: number;
  /** Track BH: why a failed goto failed (the planner's own words: `no path (exhaustive search, 1708 nodes expanded)`), for the glide-down line. */
  why?: string;
  /** Track BG2: doors / hatches that stayed open behind the body (two close clicks failed; not a goto failure). */
  closeFailed?: number;
  /** Track CB: the coarse corridor followed, when the goal was far enough to ask for one. */
  corridor?: CorridorReport;
}

interface Search {
  s: PathSearch | WorkerSearch;
  /** Track CB: the goal searched: a corridor waypoint (`wp` its index) or the goto's plan goal. */
  goal: NavGoal;
  wp?: number;
  /** Track AB: 'upgrade' = a worker main plan whose interim answer is being walked. */
  kind: 'main' | 'ahead' | 'upgrade';
  via: 'worker' | 'thread';
  reason: ReplanReason;
  tick: number;
  slices: number;
  /** Track R3: the long dig search (digway.ts LONG_DIG_WEIGHT). */
  long?: boolean;
  /** Track R3: the body waits for the final answer (no interim walked: the last two finals did not meet their interim paths, or the long dig search). */
  noInterim?: boolean;
  /** Track R8: a near end's search (PathOptions.nearEnd). */
  near?: boolean;
  /** Track W2 way: a rejoin search back onto a kept way (any of its nodes `lo` to `hi`); its way and the kept way's rest are walked. */
  rejoin?: { way: KeptWay; lo: number; hi: number };
  /** Track W2 way: a fresh plan searched while a kept way is walked: it replaces the way only when clearly shorter (way.ts clearlyShorter). */
  keep?: true;
}

/** Track W2 way: where the kept way came from. */
type WaySource = 'handed' | 'resumed' | 'own';

/** Track W2 way: a whole way kept (the path, whether it ends at the goal, where it came from, the node to look from). */
interface KeptWay {
  path: PathNode[];
  whole: boolean;
  source: WaySource;
  from: number;
}

/** Track R1: the "why unreachable" searches of a goto about to give up (nav/reach.ts). */
interface ExplainRun {
  /** The options the goto planned with at its last level (the owner's rules). */
  owner: PathOptions;
  start: LocatedNode;
  /** 'all': every rule lifted; 'single': the rules in `queue` lifted one at a time. */
  stage: 'all' | 'single';
  /** The rules the running search lifts. */
  cur: readonly ReachRule[];
  queue: ReachRule[];
  /** The rules the path found with every rule lifted breaks (`rulesOnPath`). */
  used: ReachRule[];
  /** Track R2: the worst fall the owner's policy refuses on a path found with `falls` lifted (`fallOnPath`), for the reply. */
  fall?: RefusedFall;
  search: Search;
  searches: number;
  /** The searches run with BIG_SEARCH x the main budget (the one with every rule lifted was cut by its budget). */
  big: boolean;
  /** The goal is in unloaded world and the owner's rules closed the loaded world round the body: a way to the frontier is the way. */
  frontier: boolean;
  /** Track R8: a near end's single-rule search: NEAR_SINGLE x the main budget. */
  small?: boolean;
}

/** What one "why" search asks (ExplainRun's fields it reads). */
type ExplainAsk = Pick<ExplainRun, 'owner' | 'start' | 'cur' | 'big' | 'frontier' | 'small'>;

interface ActionRun {
  kind: 'dig' | 'use' | 'place' | 'close';
  /** Path index of the node the action is for (close: the node the body stopped on). */
  node: number;
  queue: Vec3[];
  axis: 0 | 2;
  /** The running action call, if any. */
  pending: boolean;
  result: SkillResult | undefined;
  /** Waiting for the door state after a use. */
  waitClear: { p: Vec3; want: boolean; since: number } | undefined;
  placed: boolean;
  started: number;
  timeout: number;
  // Track BC: a dig action keeps its whole break list in `queue` (a falling stack refills a dug cell)
  /** The cell being dug. */
  current: Vec3 | undefined;
  /** No dig before this tick (a gravity block above the last dug cell is landing). */
  settleUntil: number;
  /** The final settle wait (allowGravityAbove: a stack already in the air lands after the last dig) has run. */
  settled: boolean;
  /** Dig calls made. */
  digs: number;
  /** Track BG2: a failed close was clicked again once. */
  retried?: boolean;
  /** Track W2: a dig from water waits for the head to come out of the water since this tick. */
  headSince?: number;
}

interface DoorToClose {
  p: Vec3;
  axis: 0 | 2;
  /** Path index of the first node out of the door cell. */
  closeAt: number;
}

interface Active {
  goal: NavGoal;
  /** Track R: the goal the searches use (an `any` without its blacklisted members) and its members' indices in `goal.goals`. */
  planGoal: NavGoal;
  members: number[] | undefined;
  useBlacklist: boolean;
  lastMain: PathResult['status'] | undefined;
  /** Track R1: the goto's partial plans led back and forth (no way on in the loaded world, as an exhaustive `none`). */
  looped: boolean;
  opts: Required<Omit<GotoOptions, 'way' | 'resume'>>;
  pathOpts: PathOptions;
  path: PathNode[];
  status: PathResult['status'] | undefined;
  legFrom: number;
  legTo: number;
  follower: PathFollower | undefined;
  guard: PressGuard;
  replan: ReplanReason | undefined;
  waitUntil: number;
  t: number;
  /** Progress timeout (2026-10-30): the best straight-line distance to the goal point so far and the tick it was set. */
  bestGoalDist: number;
  goalProgressTick: number;
  search: Search | undefined;
  /** No plan-ahead until the next main plan (the last one made no progress). */
  aheadBlocked: boolean;
  action: ActionRun | undefined;
  passedAbs: number;
  passTick: number;
  /** Path index of the node the follower aims at (pure pursuit), for the per-move timeout. */
  aimAbs: number;
  lastSafe: LocatedNode | undefined;
  retreat: { until: number } | undefined;
  /** Track R5: ticks waited with no start node while the body was in the air (SETTLE_TICKS at most a goto). */
  settled: number;
  /**
   * Track R6: the `block` goal's cell is a perch (a fence's top: astar `perchGoal`), looked at once at the first plan
   * (null: it is not). `ring`: the walk ends next to it (`perchRing`), no step or jump onto it being there or found.
   */
  perchGoal?: { x: number; y: number; z: number; feet: number; on: string; enter: boolean; ring: boolean; block: Vec3; low?: true } | null;
  /**
   * Track R7: the `block` goal's cell cannot be stood on and the walk ends next to it (GotoOptions.beside), looked at once
   * before the first plan (null: not such a goal, or the goto has no `beside`; undefined: not looked at yet).
   */
  beside?: { x: number; y: number; z: number; kind: BesideKind; what: string; why: string; ring?: true } | null;
  /**
   * Track R8 (nearNoWay): the tick a search from where the body stands first went nowhere near the goal's cell; from then
   * on no bigger search, one search with the last level's options, then the answer.
   */
  near?: number;
  /** Track R8: the next main plan is the near end's search (PathOptions.nearEnd at the last level). */
  nearSearch?: boolean;
  /** Track R8: the main budget's share of the next worker search (a near end's single-rule "why" searches). */
  scale?: number;
  noBreak: Set<number>;
  /** Pillar / door cells (cellKey) whose action failed during this goto: not planned again. */
  noAction: Set<number>;
  /** Failed pillar places during this goto (2: no more pillaring in this goto). */
  placeFailures: number;
  /** Cells our own actions change: their block updates do not trigger re-plans. */
  ownCells: Set<number>;
  doors: DoorToClose[];
  /** Track BG: hatches (trapdoors in floors / ceilings) this goto opened, to close behind (closeTrapdoors). */
  hatches: Vec3[];
  /** Path index up to which the nodes' actions have run (their moves are plain walks now). */
  actedUpTo: number;
  unloadedTicks: number;
  bestProgress: number;
  lastProgressTick: number;
  lastPos: Vec3 | undefined;
  /** Why the last plan / failure went wrong (for the "unreachable without a segment" WARN line). */
  why: string | undefined;
  /**
   * The start node (cellKey), world generation and planner (worker / in-thread) of the last plan that went
   * nowhere (no_progress, all loaded, its full budget): not searched again unchanged by the same planner.
   */
  noProgress: { key: number; gen: number; via: Search['via']; wp: number | undefined; level: DigWayLevel } | undefined;
  /**
   * Track W3 (nav/digway.ts): 0 the plain walk with no fall that hurts; 1 the dig way (natural blocks dug, still no
   * fall that hurts); 2 the falls that hurt (and the dig way when it is on). A level is planned only after the one
   * before it found no way.
   */
  level: DigWayLevel;
  /** Track W3: blocks the dig way has dug in this goto. */
  dug: number;
  /**
   * Track R1 (nav/reach.ts): the next main plan runs with BIG_SEARCH x the worker's budgets (a search cut by its budget
   * with no progress is no answer: it is asked again, bigger, before it counts); the (node, level, waypoint) keys
   * that had their bigger search.
   */
  big: boolean;
  bigTried: Set<string>;
  /**
   * Track R3 (digway.ts LONG_DIG_WEIGHT): the next main plan is the long dig search (weighted, digs at their time); the
   * (node, level, waypoint) keys that had theirs.
   */
  long: boolean;
  longTried: Set<string>;
  /** Track R3: the next main plan walks no interim answer (two final answers in a row did not meet their interim paths). */
  noInterim: boolean;
  /** Track R3: found final answers in a row that did not meet their interim path (from 2: `noInterim`). */
  unmetFinals: number;
  /** Track R3: chunk columns (cx * 65536 + cz, low 16 bits) with a block change the goto's own actions made, by tick. */
  ownChunks: Map<number, number>;
  /** Track R1: the "why unreachable" searches under way (GotoOptions.explain, nav/reach.ts); `explained` once they ran; `cause` their answer. */
  explain: ExplainRun | undefined;
  explained: boolean;
  /** Track R2: ways the "why" search found that break no rule, walked instead of answering `budget` (OPEN_WALKS a goto). */
  openWalks: number;
  /** Track R2: the last open way, walked when the weighted search after it goes nowhere (adoptOpenWay). */
  openPath?: PathNode[];
  cause: ReachCause | undefined;
  /** Track R4: the goto holds for a block on its only fall to pass (startHold); `heldTicks` the ticks held so far. */
  hold: FallHold | undefined;
  heldTicks: number;
  /** Track R1: partial plans this goto walked to a frontier end (PathOptions.frontier). */
  frontierLegs: number;
  /** Track R1: the start cells of the partial main plans this goto walked (cell:level): a partial plan that ends on one is a loop. */
  partialFrom: Set<string>;
  /** Track R1: ticks this goto waited for chunks on such a loop at unloaded world (never reset: at most `unloadedWaitTicks` a goto). */
  loopWaited: number;
  /** Track R1: partial off-path re-plans this goto made from each start cell (cell:level): `OFF_PATH_LOOP` from one cell is a loop. */
  offPathFrom: Map<string, number>;
  /** Track BE: ticks in a row the body was 2 to 3 blocks off the path; the tick of a correction / knock / teleport whose path check is pending. */
  ticksAway: number;
  recheck: number | undefined;
  /** Track CB: the coarse corridor being followed (undefined: none asked for, none found, or dropped: the raw goal as before). */
  corridor: CorridorState | undefined;
  /** Track CB: a corridor request is in flight (asked at tick `corridorAt`); chunks near the corridor changed since. */
  corridorPending: boolean;
  corridorAt: number;
  corridorDirty: boolean;
  /** Track CB: waypoints the fine planner failed to reach; past CORRIDOR_MAX_FAILURES no corridor is asked for again. */
  corridorFailures: number;
  /**
   * Track W2 way (way.ts): `a.path` is a whole way kept (it ends at the goal, or is a handed way that ends near it): a
   * re-plan after a correction or off the path walks on along it or rejoins it. Undefined: the path is a partial plan.
   */
  way: { whole: boolean; source: WaySource } | undefined;
  /** Track W2 way: a handed way (GotoOptions.way, or a resume's kept way) the first plan looks at. */
  handed: KeptWay | undefined;
  report: GotoReport;
  finish: (r: SkillResult) => void;
}

/** GotoOptions.avoidFarmlandDrops: a fall onto farmland costs this many ticks (about a 40-block detour). */
export const FARMLAND_DROP_COST = 200;
const DIG_TIMEOUT = 600;
/** Track W2: ticks a dig from water waits for the head to come out of the water before the step is given up. */
const DIG_HEAD_WAIT = 40;
const ACTION_TIMEOUT = 100;
const DOOR_WAIT = 40;
/** Track BG: a hatch is closed behind only from a node whose eye (feet + 1.62) is within this of its centre (UseSkill reach: 5 to its closest point). */
const HATCH_CLOSE_REACH = 4.5;
const EYE = 1.62;
const BODY_HEIGHT = 1.8;
/** Track CB: the first main plan waits this long for the corridor asked at the start (the search runs in slices; 500 ms is its default budget). */
const CORRIDOR_WAIT_TICKS = 12;
/** Track CB: a corridor is re-planned after a change near it at most this often (ticks). */
const CORRIDOR_REPLAN_TICKS = 60;
/**
 * Track W2 way: ticks a drop into a node beside lava adds to its move's estimate for the move timeout: the follower creeps
 * off that edge at 0.05 a tick with one forward press every 8 ticks (follower.ts creepsInto), up to 1.2 blocks, about 60
 * ticks, and the timeout (2 x the estimate + 10) gave the 1-block drop 34: it timed out while the body was going over
 * the edge, and the retreat took it back up (the cave fixture, the landing probe's way down a stair of drops by lava).
 */
export const DROP_CREEP_TICKS = 30;
/** Track R1: the bigger search's budget, x the worker's main budget (2 s, 500 000 nodes: 8 s, 2 000 000). */
export const BIG_SEARCH = 4;
/** Track R1: "why unreachable" searches a goto runs at most (every rule lifted, then single rules). */
export const EXPLAIN_MAX_SEARCHES = 5;
/** Track R2: ways a goto walks that its "why" search found breaking no rule (walkOpenWay). */
export const OPEN_WALKS = 2;
/**
 * Track R4: ticks a goto holds at most (all its holds together) for a block on its only fall to pass (a hostile near,
 * burning, the health not sent yet, a landing refused lately) before it reports unreachable: 30 s.
 */
export const FALL_HOLD_TICKS = 600;
/** Track R4: ticks the block must stay away before the hold ends and the goto plans again (a hostile on the 16-block line). */
export const FALL_HOLD_CLEAR = 20;
/**
 * Track R5: ticks a goto waits at most (in all) with no start node while the body is in the air, before a failure counts:
 * 2 s, the time the three failures took before. A free fall from rest lands from 1.5 blocks in 7 ticks, from 3 in 10, from
 * 16 in 23 and from 48 in 40 (physics.ts: gravity 0.08, drag 0.98); a body that is in the air longer than that is in a
 * fall the FallGuard handles, not settling. The look is repeated every SETTLE_STEP ticks.
 */
export const SETTLE_TICKS = 40;
/** Track R5: ticks between two looks for the start node while the body settles. */
const SETTLE_STEP = 2;
/** Track R4: the hold reads the live fall policy every this many ticks. */
const FALL_HOLD_EVERY = 5;

/** Track R4: a goto holding for a block on its only fall to pass (Navigator.startHold). */
interface FallHold {
  /** Tick the hold began and the last tick it may last. */
  since: number;
  until: number;
  /** The cause it would have ended with (rule falls and its fall). */
  cause: ReachCause;
  fall: RefusedFall;
  /** Ticks the block has been away in a row. */
  clear: number;
  /** The block it waits for, in words (the first one seen). */
  why: string;
}
/** Track R2: the heuristic's weight of a goto's searches after an open way (walkOpenWay). */
export const OPEN_WEIGHT = 3;
/**
 * Track R6: the goal a walk to a perch goal ends at when no move goes onto it: next to it, as a dig or a chest is
 * walked to (getToBlock: one of the 8 columns round it with the block at the feet or the head, in
 * reach, a face of it turned to the eye). Not a radius: a cauldron's inside is 0.31 over the floor, and a radius that
 * takes a fence's corner (2.06 from its top) took a column two blocks from the cauldron.
 */
function perchRing(pg: { x: number; y: number; z: number; block: Vec3 }): NavGoal {
  // a top in the goal's own cell (a cauldron's inside): next to that block. A top over the block below (a fence's):
  // next to the goal's cell, the air over the fence, with no face asked (it has none). That takes a side cell at the
  // fence's level (the ground beside a post) and one at the goal's level (a deck the post stands in: on the block's
  // own goal, a side cell over the block is never done, and a walk switched there by a failure had no end at all)
  if (pg.block.y === pg.y) return { type: 'getToBlock', p: { ...pg.block } };
  return { type: 'getToBlock', p: { x: pg.x, y: pg.y, z: pg.z }, face: false };
}

/** The coarse modes a goto's corridors plan in (Track CB; Track R2: the modes a failed waypoint's portal is marked for). */
function corridorModes(o: GotoOptions): CoarseMode[] {
  return o.allowBreak ? ['walk', 'mine'] : ['walk'];
}
/** Track R2: the body is between the pillar moves of its path (the next node is one, or the one it stands on is and more follow). */
function midPillar(a: Active): boolean {
  const next = a.path[a.passedAbs + 1];
  return next?.move === 'pillar' || (a.path[a.passedAbs]?.move === 'pillar' && next !== undefined && next.y > a.path[a.passedAbs]!.y);
}

/** Track R3: the path ahead of the body still has blocks to dig (a dug way under way). */
function midDig(a: Active): boolean {
  for (let i = Math.max(0, a.passedAbs + 1); i < a.path.length; i++) if (a.path[i]!.act?.dig?.length) return true;
  return false;
}

/** Track R3: a chunk column's key for Active.ownChunks. */
function chunkColumnKey(cx: number, cz: number): number {
  return cx * 65536 + (cz & 0xffff);
}

/** Track R3: a coarse change in a chunk whose own block change is at most this many ticks old is the goto's own. */
const OWN_CHANGE_TICKS = 2;

/** Track R1: frontier legs a goto walks at most (PathOptions.frontier). */
export const FRONTIER_MAX_LEGS = 6;
/** Track R1: partial off-path re-plans from one start cell (one level) after which the goto counts it as no progress. */
export const OFF_PATH_LOOP = 6;
/** Track CB: failed waypoints before the goto stops asking for corridors (the raw goal as before). */
const CORRIDOR_MAX_FAILURES = 3;

export class Navigator {
  readonly grid: NavGrid;
  /** The world-changing actions this navigator can run (tests check e.g. `nav.actions.place`). */
  readonly actions: NavActions;
  private readonly loop: InputLoop;
  private readonly log: Logger;
  private readonly stuckTicks: number;
  private readonly maxFailures: number;
  private readonly pathOpts: PathOptions;
  private readonly maxTurn: number;
  private readonly inventory: (() => NavInventory | undefined) | undefined;
  private readonly sliceMs: number;
  private readonly segmentNodes: number;
  private readonly segmentMs: number;
  private readonly mainMs: number;
  private readonly aheadNodes: number;
  private readonly unloadedWaitTicks: number;
  private readonly moveTimeout: { factor: number; margin: number };
  /** Track BE: the executor's off-path checks (NavigatorOptions.offPath), settable for measurements. */
  offPath: boolean;
  private readonly offPathGrace: number;
  private readonly overrun: { factor: number; margin: number };
  private readonly cancelDig: (() => void) | undefined;
  private readonly toolOk: NavigatorOptions['toolOk'];
  private active: Active | undefined;
  private readonly unsubs: (() => void)[] = [];
  /** Track CB: the coarse layer (attachCoarse) and the distance from which a goto asks it for a corridor. */
  private coarse: { layer: CoarseLayer; minBlocks: () => number; off: () => void } | undefined;
  /** Report of the last goto (also while it runs). */
  lastReport: GotoReport | undefined;
  /** Track W2 way: the way the last interrupted goto was walking (its goal as JSON), for its resume (GotoOptions.resume). */
  private lastWay: { goal: string; path: PathNode[]; whole: boolean; at: number } | undefined;
  /** Track S: the `cellCost` option, settable after construction (the survival kit installs avoidance). */
  cellCost: NavigatorOptions['cellCost'];
  /** Track AT: planner cost overrides read live each plan (the End: `maxDrop` 1, no irreversible drops; world/dimension.ts). */
  costsOverride: (() => Partial<NonNullable<PathOptions['costs']>> | undefined) | undefined;
  /** Track BI: the long-fall policy read live each plan (skills/fall: health, armour, the water bucket, settings); undefined = no drops deeper than maxDrop. */
  fallPolicy: (() => PathOptions['falls']) | undefined;
  /** Track R1: health + absorption now (the "why unreachable" search with the fall rule lifted lets a fall cost all but 1 HP); undefined: 20. */
  health: (() => number) | undefined;
  /** Track BI: re-plans wait while this is true (a clutch's water and its flow around the landing are not gone yet). */
  holdPlans: (() => boolean) | undefined;
  /**
   * Track W1: the server's air supply (0..300 ticks; MobTracker.selfAir), read at each plan; undefined (or a getter
   * returning undefined) = the navigator's own clock (`airClock`: down 1 a tick with the head under water).
   */
  air: (() => number | undefined) | undefined;
  /** Track W1: the local air estimate, stepped every tick (nav/water.ts). */
  readonly airClock = new AirClock();
  /** Track BI: the follower holds still while this is true (a clutch's water is being picked up). */
  pauseFollow: (() => boolean) | undefined;
  /** Track BI: a planned drop deeper than 3 still holds (the live fall policy); false stops the body and re-plans. */
  dropCheck: ((from: PathNode, to: PathNode, costs: PathCosts) => boolean) | undefined;
  /** Track R4: ticks a goto may hold for a block on its only fall to pass (0: never, the behaviour before). */
  fallHoldTicks = FALL_HOLD_TICKS;
  /** Track R5: ticks a goto waits for an airborne body to settle before "no standable node" counts (0: the behaviour before). */
  settleTicks = SETTLE_TICKS;
  /** Track R5: a body on a perch (a fence's top) plans from it (false: the behaviour before, for the tests' before and after). */
  perch = true;
  /** Track R6: a goal on a perch (a fence's top) is walked onto or next to (false: the behaviour before, for the tests). */
  perchGoals = true;
  /**
   * Track R7: a body held crouched on a top under less than 1.8 of head room (a fence under an eave) plans from it, and
   * such a top as a goal ends next to it (false: the behaviour before, for the tests).
   */
  lowPerch = true;
  /**
   * Track R8: a `beside` goto ends near its goal soon with a truthful answer (nearNoWay, finishShort), a cell no move enters
   * ends next to it, R7's node under an air cell falls back to next to it, a cell over a top just under its floor is that
   * top's node (false: the behaviour before, for the tests).
   */
  nearEnds = true;
  /** Track W2 way (nav/way.ts): a handed way is walked, a kept way rejoined, a resume walks on along its way (false: the behaviour before, for the bench). */
  keepWays = true;
  private protect: NavigatorOptions['protect'];
  /** Track BK: cells (cellKey) no goto may dig while a job holds them (a quarry's stair treads); every goto's noBreak starts with them. */
  readonly keptCells = new Set<number>();
  private digPenalty: NavigatorOptions['digPenalty'];
  /** Track R: failed goals / `any` members / action cells, skipped for a while (nav/blacklist.ts). */
  readonly blacklist: NavBlacklist;
  /** Track R: ticks seen by this navigator (the blacklist's clock). */
  private clock = 0;
  /** Track AB: the planner worker (attachPlanner), its thread count setting and budgets. */
  planner: PlannerClient | undefined;
  plannerThreads: () => number = () => 0;
  readonly workerBudgets: PlannerBudgets;
  /** Track AJ: edge sneaking (NavigatorOptions.edgeSneak), settable for measurements. */
  edgeSneak: boolean;
  /** Track BC: Baritone's way with a gravity block over a dug cell (PathOptions.allowGravityAbove; also `path.allowGravityAbove`). Default off: the owner's rule. */
  allowGravityAbove = false;
  /** Track W2: dig out of water when no swim exit is worth it (NavigatorOptions.digOut), settable. */
  digOut: boolean;
  /** Track W3: the dig way when no plain way exists (NavigatorOptions.digWay), read at every plan; settable (the session: setting `digWay`). */
  digWay: () => boolean;
  /** Track BC: a loaded column's section was re-sent since the last tick: the grid caches are dropped at the top of the next tick. */
  private gridDirty = false;
  /** Track AB: block changes the planner reads (movement signature changed), numbered; worker answers older than a change near their path are dropped. */
  private worldGen = 0;
  private readonly changes: { gen: number; x: number; y: number; z: number }[] = [];

  constructor(loop: InputLoop, world: NavWorld, opts: NavigatorOptions = {}) {
    this.cellCost = opts.cellCost; // Track S
    this.protect = opts.protect;
    this.digPenalty = opts.digPenalty;
    this.loop = loop;
    this.blacklist = opts.blacklist ?? new NavBlacklist({ failures: opts.blacklistFailures, ticks: opts.blacklistTicks, now: () => this.clock }); // Track R
    this.grid = new NavGrid(world.source);
    this.log = opts.logger ?? silentLogger;
    this.stuckTicks = opts.stuckTicks ?? 40;
    this.maxFailures = opts.maxFailures ?? 3;
    this.pathOpts = opts.path ?? {};
    this.maxTurn = opts.maxTurnDeg ?? 30;
    this.actions = opts.actions ?? {};
    this.inventory = opts.inventory;
    this.sliceMs = opts.sliceMs ?? 8;
    this.segmentNodes = opts.segmentNodes ?? 20_000;
    this.segmentMs = opts.segmentMs ?? 100;
    this.mainMs = opts.mainMs ?? 40;
    this.aheadNodes = opts.aheadNodes ?? 64;
    this.unloadedWaitTicks = opts.unloadedWaitTicks ?? 200;
    this.moveTimeout = opts.moveTimeout ?? { factor: 2, margin: 10 };
    this.workerBudgets = { ...DEFAULT_PLANNER_BUDGETS, ...opts.workerBudgets }; // Track AB
    this.edgeSneak = opts.edgeSneak ?? true; // Track AJ
    this.offPath = opts.offPath ?? true; // Track BE
    this.offPathGrace = opts.offPathGraceTicks ?? OFF_PATH_GRACE_TICKS; // Track BE
    this.overrun = opts.overrun ?? { factor: 1, margin: MOVEMENT_TIMEOUT_TICKS }; // Track BE
    this.cancelDig = opts.cancelDig; // Track BE
    this.toolOk = opts.toolOk; // Track BE
    this.digOut = opts.digOut ?? true; // Track W2
    const digWay = opts.digWay ?? false; // Track W3
    this.digWay = () => digWay;
    // Track BC: a re-sent section of a loaded column may carry changes the grid cached the old way (a chunk re-sent
    // after a teleport, a server-side fill): the caches are dropped once, at the top of the next tick (a section
    // event fires per subchunk of every new column too: those have nothing cached)
    if (world.onSection)
      this.unsubs.push(
        world.onSection((reloaded) => {
          if (!reloaded) return;
          this.gridDirty = true;
          this.worldGen++; // a re-sent section can carry changes that never came as block updates (the no-progress retry skip)
        }),
      );
    this.unsubs.push(
      world.onBlockUpdate((p, before, after) => {
        this.onBlock(p, before, after);
      }),
      loop.onEvent((e) => {
        const a = this.active;
        if (!a) return;
        // Track BE: while a leg is walked, a correction / knock / teleport first checks whether the body still stands on the path
        if (e.kind === 'correction') {
          a.report.corrections++;
          if (a.opts.replanOnCorrection && !this.deferToPathCheck(a)) a.replan ??= 'correction';
        } else if (e.kind === 'motion') {
          a.report.motions++;
          if (!this.deferToPathCheck(a, e.velocity)) a.replan ??= 'correction';
        } else if (e.kind === 'teleport') {
          if (!this.deferToPathCheck(a)) a.replan = 'correction';
        }
      }),
      loop.onBeforeStep((_tick, state) => {
        this.clock++; // Track R
        if (state.ready) this.airClock.step(headUnderWater(this.cellOf, state.pos)); // Track W1
        if (this.planner) this.plannerFor(); // Track AB: start / stop the worker as plannerThreads changes
        const rep = this.active?.report;
        const t0 = performance.now();
        this.onTick(state);
        const ms = performance.now() - t0;
        if (rep && ms > rep.maxTickMs) rep.maxTickMs = +ms.toFixed(2);
      }),
    );
  }

  get busy(): boolean {
    return this.active !== undefined || this.queued !== undefined; // decision 0051: a goto waiting for the dig-down off a scaffold
  }

  /**
   * Track R1: a worker search of the goto is under way with nothing new to hand over yet (no result, no interim
   * answer waiting): the reachability bench (nav/bench) paces its ticks at the server's rate while this holds.
   */
  get awaitingWorker(): boolean {
    const search = this.active?.explain?.search ?? this.active?.search; // Track R1: the "why" searches too
    const s = search?.s;
    // (Track R3: an interim answer the navigator will not walk is nothing new either)
    return s instanceof WorkerSearch && (s.state === 'waiting' || s.state === 'sent') && (!s.interimReady || search!.noInterim === true);
  }

  /** Track W1: the grid's cell classes (water.ts reads them). */
  private readonly cellOf = (x: number, y: number, z: number): TerrainClass | undefined => this.grid.cls(x, y, z);

  /** Track W1: the air supply now: the server's value when wired and known, else the local clock. */
  airNow(): number {
    return this.air?.() ?? this.airClock.air;
  }

  /** Decision 0051: a goto waiting to start (BotSkills: behind the dig-down off a scaffold); `cancel()` drops it. */
  private queued: (() => void) | undefined;

  /**
   * Decision 0051: count a goto that waits to start as busy (callers `if (nav.busy) cancel()` take it back). `cancel()`
   * (or the next `queue`) calls `drop`; the returned function releases the slot when the goto starts. Not used by the
   * navigator itself.
   */
  queue(drop: () => void): () => void {
    const prev = this.queued;
    this.queued = undefined;
    prev?.();
    this.queued = drop;
    return () => {
      if (this.queued === drop) this.queued = undefined;
    };
  }

  dispose(): void {
    this.cancel();
    this.coarse?.off(); // Track CB
    this.coarse = undefined;
    for (const u of this.unsubs.splice(0)) u();
    this.planner?.dispose(); // Track AB
    this.planner = undefined;
  }

  /**
   * Track AB: plan in a worker thread (docs/pathfinding.md "Compute"). The worker mirrors `world`
   * (World: chunk store, registry, cache) and starts at once when `threads()` > 0; `threads()` is read
   * before every plan (the `plannerThreads` setting: 0 = in-thread). Returns a function that detaches it.
   */
  attachPlanner(world: PlannerWorld, opts: { threads?: () => number } = {}): () => void {
    this.planner?.dispose();
    const client = new PlannerClient(world, { logger: this.log });
    this.planner = client;
    this.plannerThreads = opts.threads ?? (() => 1);
    if (this.plannerThreads() > 0) client.start();
    return () => {
      client.dispose();
      if (this.planner === client) this.planner = undefined;
    };
  }

  /** Planner options for a goto with these options (defaults: sprint on, no break / place). */
  planOptions(options: GotoOptions = {}, noBreak?: ReadonlySet<number>): PathOptions {
    const sprint = options.sprint ?? true;
    const inv = this.inventory;
    const throwaway = this.actions.throwawayItems ?? DEFAULT_THROWAWAY;
    // Track BC: the count too (the dig-down move's depth budget: depth + 4 blocks for the pillar back up)
    const throwawayCount = (): number => {
      const slots = inv?.()?.slots;
      if (!slots) return 0;
      let n = 0;
      for (const s of slots) if (s && s.count > 0 && throwaway.includes(s.name)) n += s.count;
      return n;
    };
    const haveThrowaway = (): boolean => throwawayCount() > 0;
    let viewOf: NavInventory | undefined; // Track BE
    let filtered: NavInventory | undefined;
    return {
      ...this.pathOpts,
      costs: { walk: sprint ? TICKS.sprint : TICKS.walk, ...(this.digPenalty?.() !== undefined ? { dig: this.digPenalty()! } : {}), ...this.pathOpts.costs, ...this.costsOverride?.() }, // Track AT: costsOverride
      ...(this.protect?.() ? { protectedArea: this.protect()! } : {}),
      allowBreak: (options.allowBreak ?? false) && this.actions.dig !== undefined,
      allowPlace: (options.allowPlace ?? false) && this.actions.place !== undefined && haveThrowaway(),
      allowOpen: this.actions.useBlock !== undefined,
      allowGravityAbove: this.allowGravityAbove || (this.pathOpts.allowGravityAbove ?? false), // Track BC
      throwaway: throwawayCount(), // Track BC
      breakTicks:
        this.pathOpts.breakTicks ??
        (inv
          ? (c) => {
              // Track BE: the Digger's tool filter, built once per plan (per inventory object)
              const raw = inv();
              if (raw !== viewOf) {
                viewOf = raw;
                filtered = this.toolView(raw);
              }
              const v = filtered;
              return v ? breakTicksWith(c, v) : handBreakTicks(c); // Track BB
            }
          : handBreakTicks),
      ...(noBreak ? { noBreak } : {}),
      cellCost: this.cellCost?.() ?? this.pathOpts.cellCost, // Track S: avoidance, read live each plan
      ...(this.fallPolicy ? { falls: this.fallPolicy() } : {}), // Track BI: long falls, read live each plan
      ...(options.avoidFarmlandDrops ? { farmlandDropCost: FARMLAND_DROP_COST } : {}),
      air: this.airNow(), // Track W1: read live each plan (a start under water plans its way up within it)
      digOut: this.digOut && this.actions.dig !== undefined, // Track W2
    };
  }

  /** Track BE: the inventory as the Digger sees it: tools `toolOk` rejects (worn) are an empty hand. */
  private toolView(v: NavInventory | undefined): NavInventory | undefined {
    const ok = this.toolOk?.();
    if (!v || !ok) return v;
    return { slots: v.slots.map((s) => (s && !ok(s) ? null : s)), selected: v.selected };
  }

  /** Replace the protected-area getter (the base around home; registry wiring). */
  setProtect(fn: NavigatorOptions['protect']): void {
    this.protect = fn;
  }

  /** Replace the dig-penalty getter (ticks per dug block; registry wiring). */
  setDigPenalty(fn: NavigatorOptions['digPenalty']): void {
    this.digPenalty = fn;
  }

  /**
   * Track CB (docs/coarse.md): plan long walks over the coarse layer. A goto whose goal is farther than
   * `minBlocks()` (straight line; 0 = off) asks `layer` for a corridor and feeds the fine planner its
   * waypoints a window at a time; a corridor is re-planned when chunks near it change or a waypoint cannot
   * be reached (its portal marked failed), and dropped (the raw goal, as before) when none is found.
   * Returns the function that detaches the layer.
   */
  attachCoarse(layer: CoarseLayer, opts: { minBlocks: () => number }): () => void {
    this.coarse?.off();
    const off = layer.onChange((chunks) => {
      const a = this.active;
      if (!a?.corridor || a.corridorPending) return;
      // Track R3: not for the goto's own digs (a long dug way changes its chunks at every block: each new corridor
      // re-planned the walk away from the dug way it was on)
      const others = chunks.filter((c) => !(a.t - (a.ownChunks.get(chunkColumnKey(c.cx, c.cz)) ?? -Infinity) <= OWN_CHANGE_TICKS));
      if (touches(a.corridor, others, a.corridor.corridor.dim)) a.corridorDirty = true;
    });
    const c = { layer, minBlocks: opts.minBlocks, off };
    this.coarse = c;
    return () => {
      if (this.coarse === c) {
        off();
        this.coarse = undefined;
      }
    };
  }

  /** Track CB: the coarse layer attached, if any (flight registers its cost on it). */
  get coarseLayer(): CoarseLayer | undefined {
    return this.coarse?.layer;
  }

  /** The break rules every direct dig must respect too (the miner's sight line, the farmer): the protected area. */
  breakRules(): BreakRules {
    const area = this.protect?.();
    return area ? { protectedArea: area } : {};
  }

  /** Plan only (no movement, one search to the end): from the body's current node to the goal. */
  plan(goal: NavGoal, from?: Vec3, options?: GotoOptions): PathResult | undefined {
    const s = this.loop.state;
    // Track AJ; Track R5: from the body, a perch too (a fence's top). Track R6: an explicit `from` is a cell the caller
    // names, not where a body stands: locateNode only (no caller in the bot passes one: the farm and the mine plan from the body)
    const start = from ? locateNode(this.grid, from) : this.startOf(s.pos, this.preferNode(s));
    return start && findPath(this.grid, start, goal, start.perch ? { ...this.planOptions(options), startFeet: start.feet } : this.planOptions(options));
  }

  goto(goal: NavGoal, options: NavGotoOptions = {}): Promise<SkillResult> {
    this.cancel();
    // Track R: the blacklist drops failed goals / `any` members before planning
    const useBlacklist = options.blacklist ?? (goal.type === 'any' || goal.type === 'getToBlock');
    const skipped: string[] = [];
    let planGoal: NavGoal = goal;
    let members: number[] | undefined;
    if (goal.type === 'any') {
      members = [];
      const kept: NavGoal[] = [];
      goal.goals.forEach((g, i) => {
        const k = useBlacklist ? goalKey(g) : undefined;
        if (k !== undefined && this.blacklist.has(k)) skipped.push(k);
        else {
          kept.push(g);
          members!.push(i);
        }
      });
      planGoal = { type: 'any', goals: kept };
    } else if (useBlacklist) {
      const k = goalKey(goal);
      if (k !== undefined && this.blacklist.has(k)) skipped.push(k);
    }
    const nothingLeft = members ? members.length === 0 : skipped.length > 0;
    const opts: Required<Omit<GotoOptions, 'way' | 'resume'>> = {
      timeoutTicks: options.timeoutTicks ?? 6000,
      replanOnCorrection: options.replanOnCorrection ?? true,
      sprint: options.sprint ?? true,
      sprintJump: options.sprintJump ?? false, // Track M9
      allowBreak: options.allowBreak ?? false,
      allowPlace: options.allowPlace ?? false,
      closeDoors: options.closeDoors ?? false,
      closeTrapdoors: options.closeTrapdoors ?? true, // Track BG
      avoidFarmlandDrops: options.avoidFarmlandDrops ?? false, // the farmer: plan around falls onto farmland
      explain: options.explain ?? false, // Track R1
      beside: options.beside ?? false, // Track R7
    };
    return new Promise((resolve) => {
      const report: GotoReport = {
        goal,
        result: undefined,
        ticks: 0,
        distance: 0,
        corrections: 0,
        motions: 0,
        plans: [],
        segments: 0,
        stuck: 0,
        moveTimeouts: 0,
        failures: 0,
        sprintTicks: 0,
        sneakTicks: 0,
        maxTickMs: 0,
        planMs: 0,
        actions: { dig: 0, use: 0, place: 0, close: 0, failed: 0 },
        retreats: 0,
        unloadedWait: 0,
        upgrades: 0,
        stale: 0,
        offPath: 0, // Track BE
        skips: 0,
        snaps: 0,
        overruns: 0,
        skipped,
        blacklisted: [],
      };
      this.lastReport = report;
      const noBreak = new Set<number>(this.keptCells); // Track BK: the kept cells
      // Track R1: never the goal's own floor (a stair dug up a tower took the block the goal stands on: the goal was gone)
      if (goal.type === 'block') noBreak.add(cellKey(Math.floor(goal.p.x), Math.floor(goal.p.y) - 1, Math.floor(goal.p.z)));
      const a: Active = {
        goal,
        planGoal,
        members,
        useBlacklist,
        lastMain: undefined,
        looped: false,
        opts,
        pathOpts: this.planOptions(opts, noBreak),
        path: [],
        status: undefined,
        legFrom: 0,
        legTo: 0,
        follower: undefined,
        guard: new PressGuard(),
        replan: 'start',
        waitUntil: 0,
        t: 0,
        bestGoalDist: Infinity,
        goalProgressTick: 0,
        search: undefined,
        aheadBlocked: false,
        action: undefined,
        passedAbs: 0,
        passTick: 0,
        aimAbs: 0,
        lastSafe: undefined,
        retreat: undefined,
        settled: 0, // Track R5
        noBreak,
        noAction: new Set(),
        placeFailures: 0,
        ownCells: new Set(),
        doors: [],
        hatches: [], // Track BG
        actedUpTo: -1,
        unloadedTicks: 0,
        bestProgress: -Infinity,
        lastProgressTick: 0,
        lastPos: undefined,
        why: undefined,
        noProgress: undefined,
        level: 0, // Track W3
        dug: 0,
        big: false, // Track R1
        bigTried: new Set(),
        long: false, // Track R3
        longTried: new Set(),
        noInterim: false,
        unmetFinals: 0,
        ownChunks: new Map(),
        explain: undefined,
        explained: false,
        openWalks: 0,
        cause: undefined,
        hold: undefined, // Track R4
        heldTicks: 0,
        frontierLegs: 0,
        partialFrom: new Set(),
        loopWaited: 0,
        offPathFrom: new Map(),
        ticksAway: 0, // Track BE
        recheck: undefined,
        corridor: undefined, // Track CB
        corridorPending: false,
        corridorAt: 0,
        corridorDirty: false,
        corridorFailures: 0,
        way: undefined, // Track W2 way
        handed: this.keepWays ? this.handedWay(goal, options) : undefined,
        report,
        finish: (r) => {
          if (this.active !== a) return;
          this.active = undefined;
          dropSearch(a); // Track AB
          report.result = r;
          if (!r.ok && a.why) report.why = a.why; // Track BH
          a.explain = undefined; // Track R1
          this.loop.release();
          if (!r.ok && r.reason === 'unreachable' && report.segments === 0) this.log.warn(this.noSegmentLine(a));
          this.settleBlacklist(a, r); // Track R
          this.rememberWay(a, r); // Track W2 way
          this.log.info(
            `goto ${JSON.stringify(goal)}: ${r.ok ? 'ok' : r.reason} after ${report.ticks} ticks, ${report.distance.toFixed(1)} blocks, ` +
              `${report.plans.length} plan(s)${report.plans.some((p) => p.via === 'worker') ? ' (worker)' : ''}, ${report.segments} segment(s), ${report.corrections} correction(s), ${report.stuck} stuck, max tick ${report.maxTickMs} ms` +
              `${report.held ? `, held ${report.held} ticks for a fall` : ''}` + // Track R4
              `${report.perchStarts ? `, ${report.perchStarts} plan(s) from a perch` : ''}${report.settleTicks ? `, ${report.settleTicks} ticks settling` : ''}` + // Track R5
              `${report.reached ? `, reached member ${report.reached.index}` : ''}${skipped.length ? `, skipped ${skipped.join(' ')}` : ''}${report.blacklisted?.length ? `, blacklisted ${report.blacklisted.join(' ')}` : ''}` +
              `${report.corridor ? `, corridor ${report.corridor.status ?? 'pending'} (${report.corridor.requests} request(s), ${report.corridor.passed} waypoint(s) passed, ${report.corridor.failed} failed)` : ''}`, // Track CB
          );
          resolve(r);
        },
      };
      this.active = a;
      if (nothingLeft) a.finish({ ok: false, reason: members && skipped.length === 0 ? 'unreachable' : 'blacklisted' }); // Track R
      else if (!a.handed) this.requestCorridor(a, 'start'); // Track CB (Track W2 way: not while a handed way may be walked)
    });
  }

  /** Track R: blacklist bookkeeping when a goto ends: the reached `any` member, success clears, unreachable / timeout counts. */
  private settleBlacklist(a: Active, r: SkillResult): void {
    const rep = a.report;
    const node = a.path.at(-1);
    if (r.ok && a.planGoal.type === 'any' && node) {
      const i = goalTest(a.planGoal, this.grid).member?.(node.x, node.y, node.z, node.feet) ?? -1;
      const index = i >= 0 ? (a.members?.[i] ?? i) : -1;
      const g = a.goal.type === 'any' ? a.goal.goals[index] : undefined;
      if (g) rep.reached = { index, goal: g };
    }
    if (!a.useBlacklist || (rep.skipped?.length && !r.ok && r.reason === 'blacklisted')) return;
    if (r.ok) {
      const k = goalKey(rep.reached?.goal ?? a.goal);
      if (k !== undefined) this.blacklist.succeed(k);
      return;
    }
    if (r.reason !== 'unreachable' && r.reason !== 'timeout') return;
    let blame: NavGoal[];
    if (a.planGoal.type !== 'any') blame = [a.planGoal];
    else if (a.lastMain === 'none') blame = [...a.planGoal.goals]; // exhaustive: none of them is reachable
    else {
      // the member the body was heading for (lowest estimate from where it stands)
      const p = this.loop.state.pos;
      const [x, y, z] = [Math.floor(p.x), Math.floor(p.y + 1e-3), Math.floor(p.z)];
      let best: NavGoal | undefined;
      let bestH = Infinity;
      for (const g of a.planGoal.goals) {
        const h = goalTest(g, this.grid).h(x, y, z);
        if (h < bestH) {
          bestH = h;
          best = g;
        }
      }
      blame = best ? [best] : [];
    }
    for (const g of blame) {
      const k = goalKey(g);
      if (k !== undefined && this.blacklist.fail(k, r.reason)) rep.blacklisted?.push(k);
    }
  }

  cancel(): void {
    this.active?.finish({ ok: false, reason: 'interrupted' });
    const q = this.queued; // decision 0051: a goto waiting to start is dropped too
    this.queued = undefined;
    q?.();
  }

  // ---- internals ---------------------------------------------------------------------------------

  private onBlock(p: Vec3, before: BlockInfo | undefined, after: BlockInfo): void {
    this.grid.invalidate(p.x, p.y, p.z);
    const a = this.active;
    if (!a) return;
    // dirt -> grass, leaves decaying states, crops growing ...: nothing the planner sees changed
    if (before && movementSignature(classify(before)) === movementSignature(classify(after))) return;
    this.noteChange(p); // Track AB
    if (a.search?.kind === 'ahead') dropSearch(a); // restarted on the next tick, on the new blocks
    if (a.ownCells.has(cellKey(p.x, p.y, p.z))) {
      a.ownChunks.set(chunkColumnKey(p.x >> 4, p.z >> 4), a.t); // Track R3: no corridor re-plan for it
      return;
    }
    if (!a.path.length || a.status === undefined) return;
    for (let i = Math.max(0, a.passedAbs); i < a.path.length; i++) {
      const n = a.path[i]!;
      if (Math.abs(p.x - n.x) <= 1 && Math.abs(p.z - n.z) <= 1 && p.y >= n.y - 1 && p.y <= n.y + 2) {
        a.replan ??= 'block';
        return;
      }
    }
  }

  /**
   * One line for a goto that ended `unreachable` before walking a single segment: where the body
   * stands (feet, the block it is in and the one under it), the node the planner starts from, the
   * goal, the last reason and the plans.
   */
  private noSegmentLine(a: Active): string {
    const s = this.loop.state;
    const p = s.pos;
    const [x, y, z] = [Math.floor(p.x), Math.floor(p.y + 1e-3), Math.floor(p.z)];
    const block = (by: number): string => {
      const b = this.grid.source.blockAt(x, by, z);
      if (!b) return 'unloaded';
      const st = Object.entries(b.states)
        .map(([k, v]) => `${k.replace('minecraft:', '')}=${String(v)}`)
        .join(',');
      return st ? `${b.name}[${st}]` : b.name;
    };
    const start = this.startOf(p, this.preferNode(s)); // Track W1: the swim / dive node in water; Track R5: a perch
    const plans = a.report.plans.map((r) => `${r.reason}:${r.status}/${r.nodes}n/${r.expanded}e/${r.ms}ms`).join(' ');
    return (
      `goto unreachable without a segment: feet ${fmt(p)}${s.onGround ? '' : ' airborne'}, in ${block(y)}, on ${block(y - 1)}, ` +
      `start node ${start ? `${start.x},${start.y},${start.z} feet ${start.feet}` : 'none'}, goal ${JSON.stringify(a.planGoal)}, ` +
      `why ${a.why ?? '?'}, plans ${plans || 'none'}`
    );
  }

  /**
   * Track AX: the reason of an exhaustive `none`; a search that expanded only its start node also
   * says what each cardinal move out of it found (`explainStart`: the refused rise, the missing head room).
   */
  private noPathWhy(res: PathResult): string {
    if (res.digOut) return trappedWhy(res.digOut, res.expanded); // Track W2: in water, no swim exit, no step to dig
    const why = `no path (exhaustive search, ${res.expanded} nodes expanded)`;
    const s = res.path[0];
    return res.expanded <= 1 && s ? `${why}: no move from the ${explainStart(this.grid, s)}` : why;
  }

  private fail(a: Active, why: string): boolean {
    a.why = why;
    // Track R6: the way onto the goal's perch failed (the step or the jump did not take, no plan reaches it): beside it
    // instead, no failure counted (the caller plans again)
    if (this.perchBeside(a, why)) return false;
    a.report.failures++;
    this.log.info(`goto: failure ${a.report.failures}/${this.maxFailures} (${why})`);
    if (a.report.failures >= this.maxFailures) {
      this.giveUp(a);
      return true;
    }
    return false;
  }

  // ---- Track R1: why a goto is unreachable (nav/reach.ts) ------------------------------------------------------

  /**
   * The goto found no way and gives up: with `explain` (the `!goto` command), the "why" searches first (the goto ends
   * when they answered, `stepExplain`), else now; `unreachable` with the cause class and its words when there is one.
   */
  private giveUp(a: Active): void {
    if (a.opts.explain && !a.explained && this.startExplain(a)) return;
    this.finishUnreachable(a);
  }

  private finishUnreachable(a: Active): void {
    const c = a.cause;
    // Track R2: a `falls` cause names the fall (its height, its damage, the budget or why no fall that hurts is taken)
    if (c?.cls === 'rule' && c.rules.includes('falls') && !c.fall && a.explain?.fall) c.fall = a.explain.fall;
    if (c && this.startHold(a, c)) return; // Track R4: the only fall is closed for a moment: hold, then ask again
    if (this.finishShort(a, c)) return; // Track R8: a `beside` goto near its goal: where it stopped and why
    a.finish(c ? { ok: false, reason: 'unreachable', cause: causeTag(c), note: causeWords(c) + this.heldWords(a) } : { ok: false, reason: 'unreachable' });
  }

  // ---- Track R4: a fall closed for a moment (decisions/0072-reachability.md "R4") ------------------------------

  /**
   * The cause names one rule, `falls`, and its fall is closed only by something that passes by itself within seconds
   * (FallPolicy.afterBlock: a hostile near, burning, the health not sent yet; or the step-off check refused its landing
   * lately, `RefusedFall.lately`), and the fall fits the budget once it has passed: the goto holds where it stands (the
   * reflex strikes what comes within reach) for at most FALL_HOLD_TICKS a goto, and plans again when the block has
   * been away FALL_HOLD_CLEAR ticks. True when it holds.
   */
  private startHold(a: Active, c: ReachCause): boolean {
    if (c.cls !== 'rule' || c.rules.length !== 1 || c.rules[0] !== 'falls' || !c.fall) return false;
    const left = this.fallHoldTicks - a.heldTicks;
    if (left <= 0) return false;
    const why = this.holdBlock(c.fall);
    if (why === undefined) return false;
    a.explain = undefined;
    a.follower = undefined;
    a.action = undefined;
    a.replan = undefined;
    this.loop.release();
    a.hold = { since: a.t, until: a.t + left, cause: c, fall: c.fall, clear: 0, why };
    this.log.info(`goto: the only way is ${fallWords(c.fall)}; holding up to ${(left / 20).toFixed(0)} s for it to pass (${why})`);
    return true;
  }

  /**
   * What the hold for `f` waits for now, in words; undefined when nothing that passes by itself closes it any more (the
   * health fell under what the fall needs, the margin closed it, long falls were turned off) or it is open ('').
   */
  private holdBlock(f: RefusedFall): string | undefined {
    const p = this.fallPolicy?.();
    if (!p) return undefined;
    if (f.lately && f.cell !== undefined && p.refused?.includes(f.cell)) return 'its landing refused at the step-off lately';
    return this.passing(p, f);
  }

  /** The policy's block on fall `f` when it passes by itself and `f` fits the budget then; '' when `f` is open now. */
  private passing(p: NonNullable<PathOptions['falls']>, f: RefusedFall): string | undefined {
    if (!p.blocked && f.damage <= Math.max(0, p.hpBudget) + 1e-9) return '';
    if (p.afterBlock === undefined || f.damage > p.afterBlock + 1e-9) return undefined;
    return p.blocked ?? `a hostile near (the fall is over its cap of ${+(p.hostileCap ?? 0).toFixed(1)} HP)`;
  }

  /** One tick of a hold: the body stands; the block gone FALL_HOLD_CLEAR ticks: plan again; past its end: unreachable. */
  private stepHold(a: Active, s: InputLoopState): void {
    const h = a.hold!;
    this.idleBody(s);
    a.guard.idle();
    a.lastProgressTick = a.t;
    a.passTick = a.t;
    if ((a.t - h.since) % FALL_HOLD_EVERY !== 0 && a.t < h.until) return;
    const why = this.holdBlock(h.fall);
    if (why === '') h.clear += FALL_HOLD_EVERY;
    else h.clear = 0;
    if (why === '' && h.clear >= FALL_HOLD_CLEAR) {
      a.heldTicks += a.t - h.since;
      a.report.held = a.heldTicks;
      a.hold = undefined;
      a.explained = false;
      a.cause = undefined;
      a.report.failures = 0;
      a.noProgress = undefined;
      a.replan = 'retry';
      a.waitUntil = a.t + 1;
      // the "why" search showed the fall is the only rule in the way: the level that takes it at once
      if (a.level < 2 && fallsHurt(this.fallPolicy?.())) a.level = 2;
      this.log.info(`goto: ${h.why} has passed after ${((a.t - h.since) / 20).toFixed(1)} s; planning again`);
      return;
    }
    if (why === undefined || a.t >= h.until) {
      a.heldTicks += a.t - h.since;
      a.report.held = a.heldTicks;
      a.hold = undefined;
      this.log.info(`goto: held ${((a.t - h.since) / 20).toFixed(1)} s for ${h.why}; ${why === undefined ? 'it no longer passes by itself' : 'it did not pass'}`);
      a.finish({ ok: false, reason: 'unreachable', cause: causeTag(h.cause), note: causeWords(h.cause) + this.heldWords(a, h.why) });
    }
  }

  /** The hold in the reply (`; held 30 s for a hostile 9 blocks away`), '' when the goto never held. */
  private heldWords(a: Active, why?: string): string {
    return a.heldTicks > 0 ? `; held ${Math.round(a.heldTicks / 20)} s${why ? ` for ${why}` : ''}` : '';
  }

  // ---- Track R6: a goal on a top the stand rule has no node for (decisions/0072-reachability.md "R6") ------------

  /**
   * Looks once (when the goal's cell and the one under it are loaded) whether the `block` goal's cell is a perch
   * (astar `perchGoal`: a fence's, a wall's or a closed gate's top; the inside of a cauldron). When it is and a step or
   * a jump onto it may start beside it (a cardinal neighbour node no higher than its top and at most MAX_JUMP_RISE
   * under it), the search may end on it (PathOptions.perchGoal); else the walk ends beside it (`perchRing`).
   */
  private lookPerchGoal(a: Active, gx: number, gy: number, gz: number, column = false): void {
    if (this.grid.cls(gx, gy, gz) === undefined || this.grid.cls(gx, gy - 1, gz) === undefined) return; // asked again once loaded
    const pg = this.perchGoals ? perchGoal(this.grid, gx, gy, gz, this.lowPerch) : undefined; // Track R7: a low top too
    if (!pg) {
      a.perchGoal = null;
      return;
    }
    let from = false;
    if (pg.enter) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        for (const y of [gy, gy - 1]) {
          let f = this.grid.stand(gx + dx, y, gz + dz);
          if (f !== undefined && Number.isNaN(f)) f = this.grid.standThrough(gx + dx, y, gz + dz);
          if (f !== undefined && !Number.isNaN(f) && pg.feet - f >= -1e-6 && pg.feet - f <= MAX_JUMP_RISE + 1e-6) from = true;
        }
      }
    }
    a.perchGoal = { x: gx, y: gy, z: gz, feet: pg.feet, on: pg.on, enter: pg.enter, ring: !from, block: pg.block, ...(pg.low ? { low: true as const } : {}) };
    if (from && column) a.planGoal = { type: 'block', p: { x: gx, y: gy, z: gz } }; // (the column's top: PathOptions.perchGoal takes a block goal)
    if (from) this.log.info(`goto: the goal ${gx},${gy},${gz} is on ${pg.on} (feet ${+pg.feet.toFixed(4)}), no node: planned onto it by a step or a jump from beside it`);
    else {
      a.planGoal = perchRing(a.perchGoal);
      this.log.info(`goto: the goal ${gx},${gy},${gz} is on ${pg.on} (feet ${+pg.feet.toFixed(4)}), no node${pg.low ? ' and under 1.8 of head room (a body is held crouched there)' : pg.enter ? ' and no block beside it to step or jump onto it from' : ' and no move goes onto it'}: the walk ends next to it`);
    }
  }

  /**
   * Track R6: the highest cell of column (x, z) holding a box (not a liquid); null when the column has none or its top is
   * a liquid, undefined while some of it is not loaded.
   */
  private columnTopCell(x: number, z: number): number | null | undefined {
    const src = this.grid.source;
    const start = src.columnTop ? src.columnTop(x, z) : (src.maxY ?? 319);
    if (start === undefined) return undefined;
    const minY = src.minY ?? -64;
    for (let y = start; y >= minY; y--) {
      const c = this.grid.cls(x, y, z);
      if (!c) return undefined;
      if (c.liquid) return null;
      if (c.boxes.length > 0) return y;
    }
    return null;
  }

  /**
   * Track R6: whether some cell of column (x, z) is a node (stand or a doorway), from the cell over its top down to the
   * world's floor: one pass, once a goto. Undefined while a cell of it is not loaded (not decided yet).
   */
  private columnHasNode(x: number, z: number): boolean | undefined {
    const src = this.grid.source;
    const top = src.columnTop ? src.columnTop(x, z) : (src.maxY ?? 319);
    if (top === undefined) return undefined;
    const minY = src.minY ?? -64;
    for (let y = top + 1; y >= minY; y--) {
      const f = this.grid.stand(x, y, z);
      if (f === undefined) return undefined;
      if (!Number.isNaN(f)) return true;
      const t = this.grid.standThrough(x, y, z);
      if (t === undefined) return undefined;
      if (!Number.isNaN(t)) return true;
    }
    return false;
  }

  /** Track R6: no way onto the goal's perch: the walk ends beside it from now on, no failure counted. True when it switched. */
  private perchBeside(a: Active, why: string): boolean {
    const pg = a.perchGoal;
    if (!pg || pg.ring) return false;
    pg.ring = true;
    a.planGoal = perchRing(pg);
    a.noProgress = undefined;
    a.partialFrom.clear();
    a.offPathFrom.clear();
    this.log.info(`goto: no way onto ${pg.on} at ${pg.x},${pg.y},${pg.z} (${why}): the walk ends next to it`);
    return true;
  }

  /** Track R6: the end of a walk to a perch goal: the report's `perchGoal` and, beside it, the reply's note. */
  private perchArrival(a: Active): string | undefined {
    const pg = a.perchGoal;
    if (!pg) return undefined;
    const p = this.loop.state.pos;
    const dist = +Math.hypot(p.x - (pg.x + 0.5), p.y - pg.feet, p.z - (pg.z + 0.5)).toFixed(2);
    a.report.perchGoal = { end: pg.ring ? 'beside' : 'on', on: pg.on, dist };
    if (!pg.ring) {
      this.log.info(`goto: on ${pg.on} at ${pg.x},${pg.y},${pg.z}, ${dist} from its centre`);
      return undefined;
    }
    const why = pg.low ? 'under 1.8 of head room: a body gets onto it only crouching' : pg.enter ? 'no step or jump leads onto it' : 'no move goes onto it'; // Track R7
    const note = `the goal's cell ${pg.x},${pg.y},${pg.z} (on ${pg.on}) cannot be stood on (${why}): stopped ${dist} blocks from it`;
    this.log.info(`goto: ${note}`);
    return note;
  }

  /**
   * Track R7: a `block` goal whose cell cannot be stood on, for a goto with `beside` (the `!goto` command): looked at once
   * before the first plan, when the cell and its neighbours above and below are loaded. A player walks up to it, so the
   * walk ends next to it with a note, at once, where before it ended `unreachable` (in 1 tick with no plan, or after
   * about 330 ticks and 28 plans with allowBreak on):
   * - a solid that is not natural terrain, or natural with no dig to open it (allowBreak off and the dig way off): next to
   *   it (getToBlock: the 8 columns round it with the cell at the feet or the head, in reach, a face turned to the eye
   *   when it is a full cube; a fence, a wall or a pane has no face to ask for). A natural block the goto may dig is dug
   *   into as before (the body then stands in the cell itself, which is what was asked);
   * - an open cell on a floor with a block where the head goes (no head room): next to it, unless that block is natural
   *   and allowBreak is on (dug out as before);
   * - an open cell with its own column's node at most BESIDE_AIR_MAX under it and nothing between: under it (the eye 3.9
   *   at most from the cell's centre, in reach). With allowPlace on the pillar's search as before;
   * - nothing else changes: a cell the body fits sneaking (Track BC) and water (Track W3) were goals already; lava stays
   *   unreachable (a body is never walked up to a lava cell to end there: the survival layer's hazard rules decide how near
   *   lava a walk goes, not the goal); a perch is Track R6's; open air with no floor within 5 under it stays unreachable.
   */
  private lookBeside(a: Active, gx: number, gy: number, gz: number): void {
    const c = this.grid.cls(gx, gy, gz);
    const head = this.grid.cls(gx, gy + 1, gz);
    const under = this.grid.cls(gx, gy - 1, gz);
    if (!c || !head || !under) return; // asked again once loaded
    if (c.liquid || sneakFits(this.grid, gx, gy, gz) === true || waterGoalCell(this.grid, gx, gy, gz)) {
      a.beside = null;
      return;
    }
    const p = { x: gx, y: gy, z: gz };
    let kind: BesideKind;
    let why: string;
    let what = c.name;
    let goal: NavGoal;
    // Track R8: a cell no move enters (NavGrid's stand and crossing refuse every hazard with no box: avoidWalkingInto),
    // at the feet or where the head goes: next to it, as a block is walked to (before: the walk stood a block from a
    // portal's cell and searched for a minute)
    const shut = !this.nearEnds ? undefined : noEntry(c) ? c : c.boxes.length === 0 && noEntry(head) ? head : undefined;
    if (shut) {
      kind = 'no entry';
      what = shut.name;
      why = `${shut.name}: a cell the walk never enters`;
      goal = { type: 'getToBlock', p, face: false };
    } else if (c.boxes.length > 0) {
      if (isNaturalTerrain(c.name) && (a.opts.allowBreak || this.digWayOn(a))) {
        a.beside = null; // dug into, as before
        return;
      }
      kind = 'solid';
      why = c.fullCube ? `inside ${c.name}` : `inside ${c.name}, no room for a body in it`;
      goal = c.fullCube ? { type: 'getToBlock', p } : { type: 'getToBlock', p, face: false };
    } else if (head.boxes.length > 0 && !head.liquid && under.boxes.length > 0) {
      if (a.opts.allowBreak && isNaturalTerrain(head.name)) {
        a.beside = null; // its head block dug out, as before
        return;
      }
      kind = 'no head room';
      why = `no head room: ${head.name} over it`;
      goal = { type: 'getToBlock', p, face: false };
    } else {
      if (a.opts.allowPlace) {
        a.beside = null; // the pillar's search, as before
        return;
      }
      let node: number | undefined;
      let feet = 0;
      for (let y = gy - 1; y >= gy - BESIDE_AIR_MAX; y--) {
        const f = this.grid.stand(gx, y, gz);
        if (f === undefined) return; // asked again once loaded
        if (!Number.isNaN(f)) {
          node = y;
          feet = f;
          what = `air, ${+(gy - f).toFixed(2)} over the floor`;
          break;
        }
        if ((this.grid.cls(gx, y, gz)?.boxes.length ?? 1) > 0) break; // a block under it that is no floor to stand on
      }
      if (node === undefined) {
        a.beside = null;
        return;
      }
      if (this.nearEnds && gy - feet < BESIDE_LOW_TOP) {
        // Track R8: a top just under the cell's floor (a path block's 0.94, farmland, soul sand, a chest): the body on it
        // stands where it was asked, its feet under half a block below the cell (the stairs rule's other side): that node,
        // no note (before: `in the air: the walk ends under it: stopped 0.07 blocks from it`)
        a.beside = null;
        a.planGoal = { type: 'block', p: { x: gx, y: node, z: gz } };
        this.log.info(`goto: the goal's cell ${gx},${gy},${gz} is over ${this.grid.cls(gx, node, gz)?.name ?? '?'} (feet ${+feet.toFixed(4)}): its node`);
        return;
      }
      kind = 'in the air';
      why = 'in the air: the walk ends under it';
      goal = { type: 'block', p: { x: gx, y: node, z: gz } };
    }
    a.beside = { x: gx, y: gy, z: gz, kind, what, why };
    a.planGoal = goal;
    this.log.info(`goto: the goal's cell ${gx},${gy},${gz} (${what}) cannot be stood on (${why}): the walk ends ${kind === 'in the air' ? 'under' : 'next to'} it`);
  }

  /** Track R7: the end of a walk next to a goal nobody stands in: the report's `beside` and the reply's note. */
  private besideArrival(a: Active): string | undefined {
    const b = a.beside;
    if (!b) return undefined;
    const p = this.loop.state.pos;
    const dist = +Math.hypot(p.x - (b.x + 0.5), p.y - b.y, p.z - (b.z + 0.5)).toFixed(2);
    a.report.beside = { kind: b.kind, what: b.what, dist };
    const note = `the goal's cell ${b.x},${b.y},${b.z} (${b.what}) cannot be stood on (${b.why}): stopped ${dist} blocks from it`;
    this.log.info(`goto: ${note}`);
    return note;
  }

  // ---- Track R8: a `!goto` that stands as near as it gets (decisions/0072-reachability.md "R8") -------------------

  /**
   * The goal cell of a `beside` block goto, with the feet's distance from its floor centre and the eye's from its
   * centre, when the feet are within NEAR_END of it and the body stands safely (safeHere: on the ground on a node, out
   * of liquids); undefined otherwise. Not for a lava cell (R7: a walk is never sent up to lava to end there).
   */
  private nearGoal(a: Active): { x: number; y: number; z: number; dist: number; eye: number } | undefined {
    if (!this.nearEnds || !a.opts.beside || a.goal.type !== 'block') return undefined;
    const x = Math.floor(a.goal.p.x);
    const y = Math.floor(a.goal.p.y);
    const z = Math.floor(a.goal.p.z);
    const c = this.grid.cls(x, y, z);
    if (!c || c.liquid === 'lava') return undefined;
    const s = this.loop.state;
    const p = s.pos;
    const dist = Math.hypot(p.x - (x + 0.5), p.y - y, p.z - (z + 0.5));
    if (dist > NEAR_END || !this.safeHere(s)) return undefined;
    return { x, y, z, dist, eye: Math.hypot(p.x - (x + 0.5), p.y + EYE - (y + 0.5), p.z - (z + 0.5)) };
  }

  /** The chunk columns round a block goal's cell (its own and the 8 beside it, at the cell's height) are loaded. */
  private loadedRound(a: Active): boolean {
    if (a.goal.type !== 'block') return false;
    const { x, y, z } = a.goal.p;
    for (const dx of [-16, 0, 16]) for (const dz of [-16, 0, 16]) if (this.grid.cls(Math.floor(x) + dx, Math.floor(y), Math.floor(z) + dz) === undefined) return false;
    return true;
  }

  /** The goto's last level (Active.level): the one after which nextLevel has none. */
  private lastLevel(a: Active): DigWayLevel {
    const saved = a.level;
    for (let n = this.nextLevel(a); n !== undefined; n = this.nextLevel(a)) a.level = n;
    const last = a.level;
    a.level = saved;
    return last;
  }

  /**
   * R7's `in the air` end (the node under the cell) was no way: next to the cell instead (getToBlock, no face: one of the 8
   * columns round it with the cell at the feet or the head, in reach) when one of those columns has a node at all; once
   * a goto, no failure counted. True when it switched.
   */
  private besideRing(a: Active, why: string): boolean {
    const b = a.beside;
    if (!this.nearEnds || b?.kind !== 'in the air' || b.ring) return false;
    let any = false;
    for (let dx = -1; dx <= 1 && !any; dx++)
      for (let dz = -1; dz <= 1 && !any; dz++) {
        if (dx === 0 && dz === 0) continue;
        for (const y of [b.y, b.y - 1]) {
          const f = this.grid.stand(b.x + dx, y, b.z + dz);
          if (f !== undefined && !Number.isNaN(f)) any = true;
        }
      }
    b.ring = true;
    if (!any) return false;
    b.why = 'in the air: the walk ends next to it';
    a.planGoal = { type: 'getToBlock', p: { x: b.x, y: b.y, z: b.z }, face: false };
    a.noProgress = undefined;
    a.partialFrom.clear();
    a.offPathFrom.clear();
    this.log.info(`goto: no way onto the node under ${b.x},${b.y},${b.z} (${why}): the walk ends next to the cell`);
    return true;
  }

  /**
   * A full main search from where the body stands went nowhere (no partial end 5+ blocks off) with the feet within
   * NEAR_END of a `beside` goal's cell (nearGoal). The walk is as near as its searches get it. R6's way onto a perch and
   * R7's node under an air cell switch to next to it first. Then what can still say something new from this node:
   * - the search was exhaustive (not cut by its budget): a bigger budget or the long dig search finds nothing it did not,
   *   only the levels can; one search at the last level (the dig way, the falls that hurt), then the answer;
   * - it was cut by its budget: no proof either way; each level above this one with its own search (as the ladder, the
   *   level's search at the main budget: a 2 x 2 tower's stair is found at the dig way's level and missed at the falls'
   *   within the same budget), then at the last level the ladder's bigger and long dig searches once, then the answer.
   * Skipped either way: the bigger and long dig searches at every level but the last, the failures' rounds and the
   * "why" searches' bigger retries. The answer is giveUp (the "why" searches, then finishShort). True when it handled the
   * result; false when the ladder's own retry below (`retry`: the bigger or the long dig search) is to run.
   */
  private nearNoWay(a: Active, why: string, limited = false, retry?: () => boolean): boolean {
    const n = this.nearGoal(a);
    if (!n) return false;
    this.loop.release();
    a.why = why;
    if (this.perchBeside(a, why) || this.besideRing(a, why)) {
      a.replan = 'retry';
      a.waitUntil = a.t + 1;
      return true;
    }
    a.near ??= a.t;
    const last = this.lastLevel(a);
    const next = limited ? this.nextLevel(a) : a.level !== last ? last : undefined;
    if (next !== undefined) {
      a.level = next;
      a.long = false;
      a.nearSearch = true;
      a.noProgress = undefined;
      a.replan = 'retry';
      a.waitUntil = a.t + 1;
      this.log.info(`goto: no way nearer from here (${why}), ${n.dist.toFixed(1)} blocks from the goal's cell: ${limited ? 'the next' : 'the last'} level's search (level ${next}) to the goal or the node nearest it${limited ? '' : ', then the answer'}`);
      return true;
    }
    if (limited && retry?.()) {
      a.nearSearch = true; // the ladder's bigger or long dig search at the last level, towards the node nearest the goal too
      return false;
    }
    this.log.info(`goto: no way nearer from here (${why}), ${n.dist.toFixed(1)} blocks from the goal's cell: the answer now`);
    this.giveUp(a);
    return true;
  }

  /**
   * A `beside` goto that ends without a way to its goal while the body stands near it (nearGoal): within reach of the
   * cell (the eye within NEAR_REACH of its centre) `ok` with a note, farther a failure `stopped short`; both say how far
   * the body stopped and why (the "why" searches' cause). True when it finished the goto.
   */
  private finishShort(a: Active, c: ReachCause | undefined): boolean {
    const n = this.nearGoal(a);
    if (!n) return false;
    const dist = +n.dist.toFixed(2);
    const eye = +n.eye.toFixed(2);
    const within = n.eye <= NEAR_REACH + 1e-9;
    const why = shortWhy(c, a.why);
    const what = a.beside?.what ?? (a.perchGoal ? `on ${a.perchGoal.on}` : (this.grid.cls(n.x, n.y, n.z)?.name ?? '?'));
    a.report.short = { dist, eye, within, why };
    if (a.near !== undefined) a.report.nearTicks = a.t - a.near;
    const cell = `the goal's cell ${n.x},${n.y},${n.z} (${what})`;
    if (within) {
      const note = `${cell} cannot be reached (${why}): stopped ${dist} blocks from it`;
      this.log.info(`goto: ${note}`);
      a.finish({ ok: true, note });
      return true;
    }
    const note = `${dist.toFixed(1)} blocks from ${cell}: ${why}`;
    this.log.info(`goto: stopped short, ${note}`);
    a.finish({ ok: false, reason: 'stopped short', ...(c ? { cause: causeTag(c) } : {}), note: note + this.heldWords(a) });
    return true;
  }

  /**
   * Why a block goal nobody stands in is unreachable: unloaded; an open cell over nothing to stand on (mid-air) is a
   * block placed under it away (`place`) unless the cell is sealed; anything else (a wall, lava) the world.
   */
  private unstandableCause(x: number, y: number, z: number, start: LocatedNode): ReachCause {
    const c = this.grid.cls(x, y, z);
    if (!c) return { cls: 'unloaded', rules: [] };
    if (c.boxes.length === 0 && !c.liquid && !sealedPocket(this.grid, { x, y, z }, start)) return { cls: 'rule', rules: ['place'] };
    return { cls: 'world', rules: [] };
  }

  /** Track R1: cell (x, y, z) is a dive node whose water column ends in anything but air (astar `riseTicks` Infinity). */
  private diveGoalUnderRoof(x: number, y: number, z: number): boolean {
    if (this.grid.dive(x, y, z) !== y) return false;
    for (let k = 1; k <= 48; k++) {
      const w = this.grid.water(x, y + k, z);
      if (w === undefined) return false;
      if (w) continue;
      return !(this.grid.free(x, y + k, z) === true && this.grid.cls(x, y + k, z)?.liquid === undefined);
    }
    return false;
  }

  /** The options the goto's last level plans with: the owner's rules the "why" searches lift. */
  private ownerOptions(a: Active): PathOptions {
    const o = this.planOptions(a.opts, a.noBreak);
    const dig = this.digWayOn(a);
    if (dig && !a.opts.allowBreak) {
      o.allowBreak = true;
      o.digWay = { left: DIG_WAY_MAX_BLOCKS - a.dug };
    }
    if (o.falls) o.falls = lastResortFalls(o.falls, dig);
    return o;
  }

  /**
   * Starts the "why" searches; false when the cause needs none (an unloaded goal the body can still head for, a
   * sealed goal) or none can run (no start node).
   */
  private startExplain(a: Active): boolean {
    a.explained = true;
    const gp = goalPoint(a.goal);
    if (gp?.y === undefined) return false;
    const st = this.loop.state;
    const start = this.startOf(st.pos, this.preferNode(st)); // Track R5: a perch too
    let frontier = false;
    if (this.grid.cls(Math.floor(gp.x), Math.floor(gp.y), Math.floor(gp.z)) === undefined) {
      a.cause = { cls: 'unloaded', rules: [] };
      // the owner's rules closed the loaded world round the body (an exhaustive search touching no unloaded cell):
      // not (c), whatever opens the way to the unloaded world is the answer
      if (!start || (a.lastMain !== 'none' && !a.looped) || a.frontierLegs >= FRONTIER_MAX_LEGS) return false;
      frontier = true;
    }
    if (!start) return false;
    // a goal under water with no air straight over it (a flooded cave's roof): no plan ends there (a dive goal needs
    // its way up), whatever rule is lifted
    if (!frontier && this.diveGoalUnderRoof(Math.floor(gp.x), Math.floor(gp.y), Math.floor(gp.z))) {
      a.cause = { cls: 'world', rules: [] };
      return false;
    }
    if (!frontier && sealedPocket(this.grid, { x: Math.floor(gp.x), y: Math.floor(gp.y), z: Math.floor(gp.z) }, start)) {
      a.cause = { cls: 'world', rules: [] }; // the goal is sealed in bedrock (or lava): no search needed
      return false;
    }
    dropSearch(a);
    a.follower = undefined;
    a.action = undefined;
    a.replan = undefined;
    this.loop.release();
    const owner = this.ownerOptions(a);
    const ask = { owner, start, cur: REACH_RULES, big: false, frontier };
    a.explain = { ...ask, stage: 'all', queue: [], used: [], search: this.explainSearch(a, ask), searches: 1 };
    this.log.info(`goto: no way under the rules (${a.why ?? 'no path'}); asking why, with every rule lifted${frontier ? ' (towards the unloaded world)' : ''}`);
    return true;
  }

  /** The options of a "why" search: `run.cur` lifted, the frontier end when the way to the unloaded world is asked. */
  private explainOptions(a: Active, run: ExplainAsk): PathOptions {
    const o = relaxOptions(run.owner, run.cur, { hp: this.health?.(), dug: a.dug });
    if (run.frontier) o.frontier = true;
    else delete o.frontier;
    if (run.start.perch) o.startFeet = run.start.feet; // Track R5: from the perch the body is on
    else delete o.startFeet;
    return o;
  }

  /**
   * A "why" search from the run's start to the goto's goal with `run.cur` lifted: in the worker with the main budget
   * (BIG_SEARCH x when `run.big`) when it can, else in-thread in slices.
   */
  private explainSearch(a: Active, run: ExplainAsk): Search {
    const o = this.explainOptions(a, run);
    const client = this.plannerFor();
    const goal = plainGoal(a.planGoal);
    if (client && goal) {
      const saved = a.pathOpts;
      const big = a.big;
      a.pathOpts = o;
      a.big = run.big;
      if (run.small) a.scale = NEAR_SINGLE; // Track R8
      const spec = this.workerSpec(a, true);
      a.pathOpts = saved;
      a.big = big;
      a.scale = undefined;
      if (spec) return { s: client.search('main', run.start, goal, spec, this.worldGen), kind: 'main', via: 'worker', reason: 'retry', tick: a.t, slices: 0, goal: a.planGoal };
    }
    const b = this.workerBudgets;
    const k = (run.big ? BIG_SEARCH : 1) * (run.small ? NEAR_SINGLE : 1);
    return { s: new PathSearch(this.grid, run.start, a.planGoal, { ...o, maxNodes: this.pathOpts.maxNodes ?? b.mainNodes * k, maxMs: this.pathOpts.maxMs ?? b.mainMs * k }), kind: 'main', via: 'thread', reason: 'retry', tick: a.t, slices: 0, goal: a.planGoal };
  }

  /** One tick of the "why" searches: the body holds still; an answer ends the goto with its cause. */
  private stepExplain(a: Active, s: InputLoopState): void {
    const run = a.explain!;
    this.idleBody(s);
    a.guard.idle();
    let res = run.search.s.step(this.sliceMs);
    if (!res && run.search.s instanceof WorkerSearch && run.search.s.failed) {
      // the worker went away: the same search in-thread
      const o = this.explainOptions(a, run);
      const k = (run.big ? BIG_SEARCH : 1) * (run.small ? NEAR_SINGLE : 1);
      run.search = { ...run.search, s: new PathSearch(this.grid, run.start, a.planGoal, { ...o, maxNodes: this.workerBudgets.mainNodes * k, maxMs: this.workerBudgets.mainMs * k }), via: 'thread' };
      res = run.search.s.step(this.sliceMs);
    }
    if (!res) return;
    this.record(a, res, run.search);
    a.report.planMs += res.ms;
    // towards an unloaded goal from a closed loaded world: a way to the frontier is a way
    const found = res.status === 'found' || (run.frontier && res.frontier === true);
    const cut = !found && res.limited;
    this.log.info(`goto: why search (${run.cur.length === REACH_RULES.length ? 'every rule lifted' : `${run.cur.join(' + ')} lifted`}${run.big ? `, ${BIG_SEARCH} x the budget` : ''}): ${found && res.status !== 'found' ? 'a way to the unloaded world' : res.status}${cut ? ' (cut by its budget)' : ''}, ${res.expanded} expanded`);
    if (run.stage === 'all') {
      // (Track R8: not at a near end: the answer comes now, a cut search is the budget's answer)
      if (cut && !run.big && run.searches < EXPLAIN_MAX_SEARCHES && a.near === undefined) {
        // a search cut by its budget is no answer: once more with BIG_SEARCH x the budget (the rest of the run too)
        run.big = true;
        run.searches++;
        run.search = this.explainSearch(a, run);
        return;
      }
      if (!found) {
        a.cause = { cls: cut ? 'budget' : 'world', rules: [] };
        this.finishUnreachable(a);
        return;
      }
      run.used = rulesOnPath(this.grid, res.path, run.owner);
      run.fall = fallOnPath(this.grid, res.path, run.owner); // Track R2
      if (run.used.length === 0) {
        // Track R2: the way breaks no rule: walk it (the goto's own searches price each dug block at the owner's
        // digPenalty, which puts a dug way of a few blocks past their budget; the "why" search, weighted and without
        // the dig price, found it in a few hundred nodes). Once or twice a goto; then, or for a way to the unloaded
        // world, the answer: the owner's way is open and the goto did not make it (cut searches, a walk that stuck): (d)
        if (res.status === 'found' && res.path.length > 1 && a.openWalks < OPEN_WALKS) {
          this.walkOpenWay(a, res.path);
          return;
        }
        a.cause = { cls: 'budget', rules: [] };
        this.finishUnreachable(a);
        return;
      }
      // Track R2: a goto that digs anyway, whose searches were cut, plans on weighted once before a rule is the answer:
      // the way the rule opens may have a dug twin its searches did not reach (allowPlace off: a stair dug up a ravine's
      // wall or a tower, where the "why" way pillars). Track R3: and one whose walk stuck (move timeouts): its plans
      // were ways under the owner's rules, so the rule is no answer yet (lava:1:10: three drops timed out on a dug way,
      // the "why" way digs beside lava, the owner's way existed)
      // (Track R8: at a near end too: from a node where every search was cut, the weighted open way is what found the
      // stair up the bench's pits:3:9 tower)
      const stuck = /^(move timeout|stuck)$/.test(a.why ?? '');
      if (a.opts.allowBreak && a.openWalks === 0 && (stuck || /search limit hit|cut by its budget/.test(a.why ?? ''))) {
        this.walkOpenWay(a, undefined, stuck);
        return;
      }
      // Track R4: falls closed for a moment (a hostile near ...): a way over a fall may stand beside the one this search
      // took (its digs cost nothing, a fall its HP: a tower of planks is dug through, not dropped from); the fall rule
      // alone is asked first, so a goto that can hold for it does
      const passing = run.owner.falls?.afterBlock !== undefined && !run.used.includes('falls');
      if (run.used.length === 1 && !passing) {
        a.cause = { cls: 'rule', rules: run.used };
        this.finishUnreachable(a);
        return;
      }
      // several rules on that path: each alone, the ones it broke first
      run.stage = 'single';
      run.queue = run.used.length === 1 ? ['falls'] : [...(passing ? (['falls'] as ReachRule[]) : []), ...run.used, ...REACH_RULES.filter((r) => !run.used.includes(r) && !(passing && r === 'falls'))];
      // Track R8: at a near end only the rules the open way broke, each with NEAR_SINGLE x the budget (they only name it)
      if (a.near !== undefined) {
        run.queue = run.queue.filter((r) => run.used.includes(r) || (passing && r === 'falls'));
        run.small = true;
      }
    } else if (found) {
      if (run.cur.includes('falls')) run.fall = fallOnPath(this.grid, res.path, run.owner) ?? run.fall; // Track R2
      a.cause = { cls: 'rule', rules: [...run.cur] };
      this.finishUnreachable(a);
      return;
    }
    const next = run.queue.shift();
    if (next === undefined || run.searches >= EXPLAIN_MAX_SEARCHES) {
      // no rule alone opens the way: the ones the open path broke, together
      a.cause = { cls: 'rule', rules: run.used };
      this.finishUnreachable(a);
      return;
    }
    run.cur = [next];
    run.searches++;
    run.search = this.explainSearch(a, run);
  }

  /**
   * Track R2: a way the "why" search found breaks none of the owner's rules (stepExplain): the goto plans on, its
   * searches weighted (OPEN_WEIGHT x the heuristic) and, when it digs anyway, each dug block at DIG_WAY_PRICE, so they
   * reach a dug way their plain budget did not; the found way itself is walked when that search goes nowhere (it digs
   * freely: its digs cost it nothing). The failures start one short of the limit again; the "why" searches may run
   * once more when the goto fails after all.
   */
  private walkOpenWay(a: Active, path?: PathNode[], stuck = false): void {
    a.openWalks++;
    a.openPath = path;
    a.explain = undefined;
    a.explained = false;
    a.cause = undefined;
    a.report.failures = Math.max(0, this.maxFailures - 2);
    a.noProgress = undefined;
    a.replan = 'retry';
    a.waitUntil = a.t + 1;
    this.loop.release();
    this.log.info(path ? `goto: the way the "why" search found breaks no rule (${path.length} nodes): planning on with the searches weighted (open walk ${a.openWalks}/${OPEN_WALKS})` : `goto: ${stuck ? 'the walk stuck' : 'the searches were cut'}: planning on with them weighted before the answer (open walk ${a.openWalks}/${OPEN_WALKS})`);
  }

  /** Track R2: the open way (walkOpenWay) adopted as the goto's path when the weighted search went nowhere. */
  private adoptOpenWay(a: Active): boolean {
    const p = a.openPath;
    a.openPath = undefined;
    if (!p || p.length < 2) return false;
    // (only from where the body is: the weighted plans moved it since the "why" search, and a way from where it was
    // is "off the path" at once, caves:2:6; from the node nearest the body when it stands within a step of one)
    const pos = this.loop.state.pos;
    let from = -1;
    let best = 1.5;
    for (let i = 0; i < p.length - 1; i++) {
      const n = p[i]!;
      const d = Math.hypot(n.x + 0.5 - pos.x, n.z + 0.5 - pos.z);
      if (d < best && Math.abs(n.feet - pos.y) < 1.1) {
        best = d;
        from = i;
      }
    }
    if (from < 0) {
      this.log.info(`goto: the way the "why" search found starts away from the body; not walked`);
      return false;
    }
    this.log.info(`goto: walking the way the "why" search found (${p.length - from} nodes)`);
    a.path = from === 0 ? p : [{ ...p[from]!, move: 'start' }, ...p.slice(from + 1)];
    a.status = 'found';
    a.way = undefined; // Track W2 way
    a.aheadBlocked = false;
    a.doors = [];
    a.actedUpTo = -1;
    a.report.segments++;
    this.startLeg(a, 0);
    return true;
  }

  // ---- Track W2 way: a walk keeps to its way (nav/way.ts; docs/pathfinding.md "A walk keeps to its way") ------------

  /** A walk to a place (a `block` or an `xz` goal): its plans are logged at INFO. */
  private walkGoal(a: Active): boolean {
    return a.goal.type === 'block' || a.goal.type === 'xz';
  }

  /** The way the first plan looks at: a resume's kept way to the same goal (RESUME_KEEP_MS at most), else GotoOptions.way. */
  private handedWay(goal: NavGoal, o: NavGotoOptions): KeptWay | undefined {
    const last = this.lastWay;
    if (o.resume && last?.goal === JSON.stringify(goal) && Date.now() - last.at <= RESUME_KEEP_MS) {
      this.lastWay = undefined;
      return { path: last.path, whole: last.whole, source: 'resumed', from: 0 };
    }
    const w = o.way;
    if (!w || w.length < 2) return undefined;
    const end = w[w.length - 1]!;
    return { path: [...w], whole: goalTest(goal, this.grid).done(end.x, end.y, end.z, end.feet), source: 'handed', from: 0 };
  }

  /** A goto interrupted while it walked a kept way leaves it for its resume; an arrival forgets it. */
  private rememberWay(a: Active, r: SkillResult): void {
    const goal = JSON.stringify(a.goal);
    if (r.ok) {
      if (this.lastWay?.goal === goal) this.lastWay = undefined;
      return;
    }
    if (r.reason !== 'interrupted' || !a.way || a.path.length - 1 - Math.max(0, a.passedAbs) < 1) return;
    this.lastWay = { goal, path: wayFrom(a.path, Math.max(0, a.passedAbs)), whole: a.way.whole, at: Date.now() };
  }

  /**
   * The first plan with a handed way, or a re-plan after a correction or a step off the path while a kept way is walked:
   * the way is walked on from the node the body stands on (no search), or rejoined a few nodes on (a small search to any
   * of them); the body far off it (REJOIN_MAX), a node of it no longer standable, any other re-plan (a block changed on
   * it, a move timed out, an action failed, the body stuck): the way is dropped and the goto plans afresh. Returns true
   * when the way was taken (walked or its rejoin search started).
   */
  private keepWay(a: Active, s: InputLoopState, start: LocatedNode, reason: ReplanReason): boolean {
    let k: KeptWay | undefined;
    if (!this.keepWays) {
      a.way = undefined;
      return false;
    }
    if (a.handed) {
      k = a.handed;
      a.handed = undefined;
    } else if (a.way && (reason === 'correction' || reason === 'off_path')) {
      k = { path: a.path, whole: a.way.whole, source: a.way.source, from: Math.max(0, a.passedAbs) };
    }
    if (a.way && !k && reason !== 'start') this.log.debug(`goto: the way kept is dropped (a ${reason} re-plan)`);
    a.way = undefined;
    if (!k || a.big || a.long || a.nearSearch || a.corridor) return this.wayDropped(a, k);
    // a handed way is looked at whole (a resume finds the body anywhere along it); the goto's own from the node last passed
    const all = k.source !== 'own';
    const lo = all ? 0 : Math.max(0, k.from - WAY_BACK);
    const hi = Math.min(k.path.length - 2, all ? k.path.length - 2 : k.from + WAY_AHEAD);
    if (hi < lo) return this.wayDropped(a, k);
    // the node the body stands on: the start node itself when the way has it, else the nearest within WAY_ON_H / WAY_ON_V
    let on = -1;
    for (let i = lo; i <= hi; i++) {
      const n = k.path[i]!;
      if (n.x === start.x && n.y === start.y && n.z === start.z) on = i;
    }
    if (on < 0) on = nodeOnWay(k.path, s.pos, lo, hi);
    // (the goto's own way is rejoined only from a node of it: a body off it plans afresh, as before. In the open a fresh plan
    // from where the body is takes the straight line on, and a rejoin's kink made the pure pursuit cut across it and go off
    // the path a second time; the turn back this guards against comes from handed ways left by the guard)
    if (on < 0 && k.source === 'own') return this.wayDropped(a, k);
    const near = on >= 0 ? undefined : nearestOnWay(k.path, s.pos, all ? lo : k.from, hi);
    const from = on >= 0 ? on : near?.i;
    if (from === undefined) {
      this.log.info(`goto: off its way by more than ${REJOIN_MAX} blocks at ${fmt(s.pos)}: planning afresh`);
      return this.wayDropped(a, k);
    }
    const broken = wayBroken(this.grid, k.path, from);
    if (broken >= 0) {
      const n = k.path[broken]!;
      this.log.info(`goto: node ${broken} of its way (${n.move} ${n.x} ${n.feet.toFixed(1)} ${n.z}) can no longer be stood on: planning afresh`);
      return this.wayDropped(a, k);
    }
    if (on >= 0) {
      const path = wayFrom(k.path, on);
      a.report.plans.push({ reason, tick: a.t, status: k.whole ? 'found' : 'partial', nodes: path.length, expanded: 0, ms: 0, slices: 0, way: 'on', blocks: +wayBlocks(path).toFixed(1) });
      this.log.info(`goto: walking ${k.source === 'own' ? 'on along its way' : `the ${k.source} way`} from node ${on} of ${k.path.length - 1} (${reason}): ${path.length} nodes, ${wayBlocks(path).toFixed(1)} blocks${k.whole ? '' : ', to its end near the goal'}`);
      this.walkPath(a, path, k.whole ? 'found' : 'partial');
      a.way = { whole: k.whole, source: k.source };
      if (k.source !== 'own' && reason === 'start') this.startKeep(a, path[0]!, reason);
      return true;
    }
    // off it by up to REJOIN_MAX: a small search back onto it, to any of its nodes from the nearest on
    // (joined from as many nodes on as the body is off it: from the nearest node itself the way back is square to the way, and
    // the pure pursuit cut the corner across it; a member farther on is still reached through the nearer ones when that is cheaper)
    const rlo = Math.min(k.path.length - 1, near!.i + Math.ceil(near!.d));
    const rhi = Math.min(k.path.length - 1, rlo + WAY_AHEAD);
    const goal: NavGoal = { type: 'any', goals: k.path.slice(rlo, rhi + 1).map((n) => ({ type: 'block' as const, p: { x: n.x, y: n.y, z: n.z } })) };
    const o: PathOptions = { ...a.pathOpts, maxNodes: REJOIN_NODES, maxMs: REJOIN_MS };
    delete o.frontier;
    delete o.nearEnd;
    delete o.perchGoal;
    if (start.perch && start.feet !== undefined) o.startFeet = start.feet;
    else delete o.startFeet;
    delete o.startCut;
    this.log.info(`goto: ${near!.d.toFixed(1)} blocks off its way at ${fmt(s.pos)} (${reason}): rejoining it (nodes ${rlo} to ${rhi} of ${k.path.length - 1})`);
    a.search = { s: new PathSearch(this.grid, start, goal, o), kind: 'main', via: 'thread', reason, tick: a.t, slices: 0, goal, rejoin: { way: k, lo: rlo, hi: rhi } };
    this.idleBody(s);
    return true;
  }

  /** No way kept: the goto plans afresh (and asks for the corridor a handed way had made it skip). Returns false. */
  private wayDropped(a: Active, k: KeptWay | undefined): false {
    if (k && k.source !== 'own' && !a.report.corridor) this.requestCorridor(a, 'start');
    return false;
  }

  /** The rejoin search's answer: its way and the kept way's rest after the node it reached; none: the goto plans afresh. */
  private onRejoinResult(a: Active, res: PathResult, search: Search): boolean {
    this.record(a, res, search, { way: 'rejoin' });
    const r = search.rejoin!;
    const end = res.path.at(-1);
    let j = -1;
    if (res.status === 'found' && end) {
      for (let i = r.lo; i <= r.hi && i < r.way.path.length; i++) {
        const n = r.way.path[i]!;
        if (n.x === end.x && n.y === end.y && n.z === end.z) j = i;
      }
    }
    if (j < 0) {
      this.log.info(`goto: no way back onto its way (${res.status}, ${res.expanded} expanded): planning afresh`);
      this.wayDropped(a, r.way);
      a.replan = search.reason;
      a.waitUntil = a.t;
      this.loop.release();
      return false;
    }
    const path = res.path.concat(r.way.path.slice(j + 1));
    this.log.info(`goto: back onto its way at node ${j} by ${res.path.length} nodes (${wayBlocks(res.path).toFixed(1)} blocks): ${path.length} nodes, ${wayBlocks(path).toFixed(1)} blocks`);
    this.walkPath(a, path, r.way.whole ? 'found' : 'partial');
    a.way = { whole: r.way.whole, source: r.way.source };
    if (r.way.source !== 'own' && search.reason === 'start') this.startKeep(a, path[0]!, search.reason);
    return true;
  }

  /** A fresh plan from where the body took a handed way, searched while it walks the way (onKeepResult compares them). */
  private startKeep(a: Active, start: PathNode, reason: ReplanReason): void {
    const search = this.newSearch(a, start, 'main', reason);
    search.kind = 'upgrade';
    search.keep = true;
    search.noInterim = true;
    a.search = search;
  }

  /**
   * The fresh plan searched beside a handed way: it replaces the way only when it reaches the goal and is clearly shorter
   * (way.ts clearlyShorter) with no more digs, places or doors; from where the two meet (spliced there), or, when they do
   * not meet, counting the walk back to where the fresh plan starts (a re-plan from where the body is). Else the way is
   * walked on; a way that ends near the goal takes the fresh plan's last steps from its end when the fresh plan passes it.
   */
  private onKeepResult(a: Active, res: PathResult, search: Search): void {
    this.record(a, res, search, { upgrade: true });
    const rec = a.report.plans[a.report.plans.length - 1]!;
    if (!a.way) return; // the way was dropped meanwhile: the walk planned afresh
    rec.kept = 'way';
    if (res.status !== 'found' || res.path.length < 2) {
      this.log.info(`goto: the fresh plan beside the way is ${res.status} (${res.expanded} expanded): walking on along the way`);
      return;
    }
    const gp = goalPoint(a.goal);
    const last = a.path[a.path.length - 1]!;
    const toGoal = a.way.whole || !gp ? 0 : Math.hypot(gp.x - (last.x + 0.5), gp.y === undefined ? 0 : gp.y - last.feet, gp.z - (last.z + 0.5));
    const at = new Map<number, number>();
    res.path.forEach((n, j) => at.set(cellKey(n.x, n.y, n.z), j));
    const from = a.action ? a.action.node : Math.max(0, a.passedAbs);
    let k = -1;
    let j = -1;
    for (let i = from; i < a.path.length; i++) {
      const n = a.path[i]!;
      const m = at.get(cellKey(n.x, n.y, n.z));
      if (m !== undefined) {
        k = i;
        j = m;
        break;
      }
    }
    // they meet: the rests from there; they do not: the fresh plan from where it starts plus the walk back to it
    const keptRest = (k >= 0 ? wayBlocks(a.path, k) : wayBlocks(a.path, from)) + toGoal;
    const fresh = k >= 0 ? wayBlocks(res.path, j) : wayBlocks(a.path, 0, from) + wayBlocks(res.path);
    const fewer = k >= 0 ? wayActions(res.path, j) <= wayActions(a.path, k) : wayActions(res.path) <= wayActions(a.path, from);
    const verdict = `the fresh plan ${fresh.toFixed(1)} blocks against the way's ${keptRest.toFixed(1)}${k >= 0 ? ` from node ${k}, where they meet` : ', which it does not meet'}`;
    if (clearlyShorter(fresh, keptRest) && fewer) {
      rec.kept = 'fresh';
      if (k >= 0) {
        a.path = a.path.slice(0, k + 1).concat(res.path.slice(j + 1));
        a.status = 'found';
        a.aheadBlocked = false;
        a.doors = a.doors.filter((d) => d.closeAt <= k);
        a.actedUpTo = Math.min(a.actedUpTo, k);
        a.report.upgrades = (a.report.upgrades ?? 0) + 1;
        a.way = { whole: true, source: 'own' };
        if (!a.action) this.startLeg(a, a.follower ? a.legFrom + a.follower.passedIndex : a.passedAbs);
        this.log.info(`goto: ${verdict}: the fresh plan is clearly shorter, taken from there`);
      } else {
        a.way = undefined;
        if (!a.action && a.replan === undefined) a.replan = 'upgrade';
        this.log.info(`goto: ${verdict}: the fresh plan is clearly shorter, re-planning from here`);
      }
      return;
    }
    this.log.info(`goto: ${verdict}: walking on along the way`);
    // a way that ends near the goal: the fresh plan's last steps from the way's end, when it passes there
    if (!a.way.whole) {
      const e = at.get(cellKey(last.x, last.y, last.z));
      if (e !== undefined && e < res.path.length - 1) {
        const oldLast = a.path.length - 1;
        a.path = a.path.concat(res.path.slice(e + 1));
        a.status = 'found';
        a.way = { whole: true, source: a.way.source };
        if (a.legTo === oldLast && !a.action) this.startLeg(a, a.follower ? a.legFrom + a.follower.passedIndex : oldLast);
      }
    }
  }

  /**
   * Track W1: no keys while the body waits for a plan or a corridor; in water it holds its depth instead (jump
   * while it sinks: about level, the head stays where it was), so a body under water does not sink to the
   * bottom between plans (the Realm, 2026-11-06: following through a cave pool).
   */
  private idleBody(s: InputLoopState): void {
    if (bodyInWater(this.cellOf, s)) this.loop.setCommand({ forward: 0, strafe: 0, sprint: false, sneak: false, jump: s.vel.y < 0 });
    else this.loop.release();
  }

  /**
   * Track R5: the node a plan from feet `pos` starts at: `locateNode`'s, else the perch the body rests on (astar
   * `locateStart`: a fence's top, which the stand rule has no node for). Not a safe node: `lastSafe` stays locateNode's.
   */
  private startOf(pos: Vec3, prefer: 'swim' | 'climb' | undefined): LocatedNode | undefined {
    return this.perch ? locateStart(this.grid, pos, prefer, this.lowPerch) : locateNode(this.grid, pos, prefer);
  }

  /**
   * Standing on a standable node, on the ground, out of liquids. Track R6: locateNode only, never the perch: the safe
   * node is where a retreat walks back to, and no move goes into a perch (decision 39).
   */
  private safeHere(s: InputLoopState): LocatedNode | undefined {
    if (!s.onGround || s.inWater || s.inLava) return undefined;
    return locateNode(this.grid, s.pos);
  }

  /**
   * Track AJ: the node kind a plan starts from: a swim node in water, a climb node off the ground on a climber.
   * Track W1: "in water" as water.ts `bodyInWater` says (a body bobbing at the surface leaves the physics test for
   * a tick); locateNode then finds the surface node or, under water, the dive node.
   */
  private preferNode(s: Pick<InputLoopState, 'pos' | 'onGround' | 'inWater'>): 'swim' | 'climb' | undefined {
    if (bodyInWater(this.cellOf, s)) return 'swim';
    if (!s.onGround && this.grid.climbable(Math.floor(s.pos.x), Math.floor(s.pos.y + 1e-3), Math.floor(s.pos.z))) return 'climb';
    return undefined;
  }

  // ---- Track W3: the levels and the dig way (nav/digway.ts) -------------------------------------------------------

  /**
   * The dig way is open: on, the dig action is wired, and the goto does not dig anyway with its budget not spent, or
   * (Track R2) it digs anyway at a price above DIG_WAY_PRICE (digway.ts).
   */
  private digWayOn(a: Active): boolean {
    if (!this.digWay() || this.actions.dig === undefined) return false;
    if (a.opts.allowBreak) return (this.digPenalty?.() ?? 0) > DIG_WAY_PRICE;
    return a.dug < DIG_WAY_MAX_BLOCKS;
  }

  /** Track R3: the long dig search can run: the goto digs anyway and the dig action is wired. */
  private longDigOn(a: Active): boolean {
    return a.opts.allowBreak && this.actions.dig !== undefined;
  }

  /** The plan options of the goto's level (Active.level). */
  private applyLevel(a: Active): void {
    const o = a.pathOpts;
    const dig = a.level > 0 && this.digWayOn(a);
    if (a.openWalks > 0) {
      // Track R2: after an open way (walkOpenWay): weighted, and a goto that digs anyway digs at the dig way's price
      o.relax = { ...o.relax, weight: OPEN_WEIGHT };
      if (a.opts.allowBreak) o.costs = { ...o.costs, dig: Math.min(o.costs?.dig ?? DIG_WAY_PRICE, DIG_WAY_PRICE) };
    }
    if (dig && a.opts.allowBreak) {
      // Track R2: the goto's own moves at the dig way's price, no block budget (the owner allows breaking)
      o.costs = { ...o.costs, dig: Math.min(o.costs?.dig ?? DIG_WAY_PRICE, DIG_WAY_PRICE) };
    } else if (dig) {
      o.allowBreak = true;
      o.digWay = { left: DIG_WAY_MAX_BLOCKS - a.dug };
      // Track R2: the dig way's blocks at the dig way's price at most (with `digPenalty` 500 and allowPlace on, allowBreak
      // off, a dug way of 8 blocks at 600 a block went past every search's budget: `dig_budget` on 22 of 553 pairs)
      o.costs = { ...o.costs, dig: Math.min(o.costs?.dig ?? DIG_WAY_PRICE, DIG_WAY_PRICE) };
    }
    if (o.falls) o.falls = a.level < 2 ? harmlessFalls(o.falls) : lastResortFalls(o.falls, dig);
    // Track R1: at the last level, a goal in unloaded world with no partial end worth walking is headed for by the
    // frontier end (a few legs a goto: the loaded world moves with the body and the next one may lead back)
    if (this.nextLevel(a) === undefined && a.frontierLegs < FRONTIER_MAX_LEGS) o.frontier = true;
    else delete o.frontier;
  }

  /** Track W3: the level after the goto's own, undefined at the last one. */
  private nextLevel(a: Active): DigWayLevel | undefined {
    return a.level === 0 && this.digWayOn(a) ? 1 : a.level < 2 && fallsHurt(this.fallPolicy?.()) ? 2 : undefined;
  }

  /**
   * The goto's level found no way (`why`): plan the next level that can do more (no failure counted): the dig way
   * when it is open, then the falls that hurt when the long-fall policy has damage to give. Returns true when it will.
   */
  private escalate(a: Active, why: string): boolean {
    const next = this.nextLevel(a);
    if (next === undefined) return false;
    a.level = next;
    a.noProgress = undefined;
    a.replan = 'retry';
    a.waitUntil = a.t + 1;
    const what = next === 1 ? (a.opts.allowBreak ? `digging at the dig way's price (${DIG_WAY_PRICE} a block)` : `digging up to ${DIG_WAY_MAX_BLOCKS - a.dug} natural blocks`) : 'a fall that hurts';
    this.log.info(`goto: no way without ${what} (${why}); planning with it`);
    return true;
  }

  /** A failure that re-plans; retreats to the last safe node first when the body is not safe. Returns true when the goto finished. */
  private failAndReplan(a: Active, s: InputLoopState, reason: ReplanReason, why: string): boolean {
    if (this.fail(a, why)) return true;
    a.replan = reason;
    a.action = undefined;
    if (!this.safeHere(s) && a.lastSafe) {
      a.retreat = { until: a.t + 60 };
      a.report.retreats++;
      a.follower = undefined;
      this.log.info(`goto: retreating to the last safe node ${fmt(a.lastSafe)}`);
    }
    return false;
  }

  private onTick(s: InputLoopState): void {
    if (this.gridDirty) {
      // Track BC: re-sent sections (hundreds per chunk crossing arrive per subchunk): one clear per tick
      this.gridDirty = false;
      this.grid.clear();
    }
    const a = this.active;
    if (!a || !s.ready) return;
    a.t++;
    a.report.ticks = a.t;
    if (a.lastPos) a.report.distance += Math.hypot(s.pos.x - a.lastPos.x, s.pos.y - a.lastPos.y, s.pos.z - a.lastPos.z);
    a.lastPos = { ...s.pos };
    if (this.loop.command.sprint && s.onGround) a.report.sprintTicks++;
    if (this.loop.command.sneak && a.follower) a.report.sneakTicks = (a.report.sneakTicks ?? 0) + 1; // Track AJ
    // timeoutTicks is a budget without progress, not a wall clock: a 1400-block walk timed out on the Realm after
    // 1120 blocks. Progress = the straight-line distance to the goal point improves by a block; the budget
    // restarts then. Goals without a point (surface, runAway, yLevel) keep the plain limit. Hard cap: 20 budgets.
    const gp = goalPoint(a.goal);
    if (gp) {
      const d = Math.hypot(s.pos.x - gp.x, gp.y === undefined ? 0 : s.pos.y - gp.y, s.pos.z - gp.z);
      if (d < a.bestGoalDist - 1) {
        a.bestGoalDist = d;
        a.goalProgressTick = a.t;
      }
    }
    // Track R1: the "why unreachable" searches run to their answer (a few seconds at most: the timeout waits)
    if (a.explain) {
      this.stepExplain(a, s);
      return;
    }
    // Track R4: holding for a block on the only fall to pass (its own bound, FALL_HOLD_TICKS)
    if (a.hold) {
      this.stepHold(a, s);
      return;
    }
    if ((gp ? a.t - a.goalProgressTick : a.t) > a.opts.timeoutTicks || a.t > a.opts.timeoutTicks * 20) {
      a.finish({ ok: false, reason: 'timeout' });
      return;
    }
    if (s.onGround && !s.inWater && !s.inLava && !a.action) {
      const here = locateNode(this.grid, s.pos); // (Track R6: the retreat's target: a node, never a perch, as safeHere)
      if (here) a.lastSafe = here;
    }

    if (a.retreat) {
      this.stepRetreat(a, s);
      return;
    }

    this.resolveRecheck(a, s); // Track BE: the path check after a correction / knock / teleport (before the re-plan below)

    // Track CB: chunks near the corridor changed: ask for a fresh one (throttled); the first plan waits briefly for the corridor
    // Track R2: never in the middle of a pillar (its own blocks are the change; a new corridor's re-plan from the
    // air aimed elsewhere and left the pillar's top a dead end: Realm 2026-11-08)
    if (a.corridorDirty && !a.corridorPending && a.t - a.corridorAt >= CORRIDOR_REPLAN_TICKS && !midPillar(a)) {
      a.corridorDirty = false;
      this.requestCorridor(a, 'change');
    }
    if (a.replan === 'start' && a.corridorPending && a.t < a.corridorAt + CORRIDOR_WAIT_TICKS) {
      this.idleBody(s); // Track W1: in water, held at its depth
      a.guard.idle();
      return;
    }

    // a re-plan replaces the current plan and any search
    if (a.replan && a.t >= a.waitUntil && !a.action && !this.holdPlans?.()) { // Track BI: holdPlans (a clutch's water is still there)
      // plan from solid ground (an airborne body has no node yet), but do not wait forever
      if (s.onGround || s.inWater || this.preferNode(s) === 'climb' || a.t - a.lastProgressTick > 20 || !a.follower) { // Track AJ: in water, on a ladder
        if (!this.startMain(a, s)) {
          a.guard.idle();
          return;
        }
      }
    }

    if (a.search && !this.stepSearch(a)) {
      if (!a.follower) this.idleBody(s); // Track W1: waiting for the plan in water: held at its depth, not sinking
      a.guard.idle();
      return;
    }

    if (a.action) {
      this.stepAction(a, s);
      return;
    }

    let f = a.follower; // Track BE: let (a skip / snap restarts the leg)
    if (!f) {
      this.idleBody(s); // Track W1
      a.guard.idle();
      return;
    }

    // Track BC: a dug cell of the node ahead is a block again (a falling stack landed, something was placed):
    // back to digging it before the body walks in (Baritone re-checks its positionsToBreak every tick); an action
    // pre-empts the off-path check below
    if (a.actedUpTo > a.passedAbs && a.actedUpTo <= a.legTo + 1) {
      const node = a.path[a.actedUpTo];
      const cells = node?.act?.dig;
      if (cells?.some((c) => this.grid.free(c.x, c.y, c.z) === false)) {
        this.log.debug(`goto: a dug cell of node ${a.actedUpTo} is filled again; digging it`);
        a.actedUpTo--;
        this.beginAction(a, { kind: 'dig', node: a.actedUpTo + 1, queue: [...cells], axis: node!.x !== a.path[a.actedUpTo]!.x ? 0 : 2 });
        return;
      }
    }

    if (this.pathChecks(a, s, f)) return; // Track BE: off the path, skip-ahead, the snap after a knock
    f = a.follower ?? f; // Track BE: the leg a skip / snap restarted

    // Track BI: the follower holds still while a clutch's water is picked up; a long drop ahead is checked against
    // the live fall policy every tick the body still stands before it (health, hostiles, the bucket, the landing)
    if (this.pauseFollow?.()) {
      this.loop.release();
      a.guard.idle();
      a.lastProgressTick = a.t;
      a.passTick = a.t;
      return;
    }
    if (this.dropCheck && s.onGround) {
      const ni = a.legFrom + f.passedIndex + 1;
      const to = a.path[ni];
      const from = a.path[ni - 1];
      if (to?.move === 'drop' && from && from.feet - to.feet > 3 + 1e-6 && !this.dropCheck(from, to, { ...DEFAULT_COSTS, ...a.pathOpts.costs })) {
        this.log.info(`goto: the ${(from.feet - to.feet).toFixed(1)}-block drop ahead is no longer safe; re-planning`);
        this.loop.release();
        a.guard.idle();
        a.replan ??= 'block';
        return;
      }
    }
    const step = f.step(s, this.loop.command.yaw);
    this.loop.setCommand(step.cmd);
    if (step.done) {
      this.onLegDone(a);
      return;
    }

    // per-move timeout: the move under way is the straight line from the last node passed to the
    // node the follower aims at (pure pursuit may skip cells); its estimate is the sum of their costs
    const passed = a.legFrom + f.passedIndex;
    const aim = Math.min(Math.max(a.legFrom + f.index, passed + 1), a.legTo);
    if (passed !== a.passedAbs || aim !== a.aimAbs) {
      a.passedAbs = passed;
      a.aimAbs = aim;
      a.passTick = a.t;
    }
    if (passed + 1 <= a.legTo) {
      let est = 0;
      for (let i = passed + 1; i <= aim; i++) est += a.path[i]!.cost + (f.creepsInto(a.path[i]!) ? DROP_CREEP_TICKS : 0); // Track W2 way: the creep off a drop beside lava
      if (a.t - a.passTick > this.moveTimeout.factor * est + this.moveTimeout.margin) {
        a.report.stuck++;
        a.report.moveTimeouts++;
        const n = a.path[passed + 1]!;
        this.log.info(`goto: move to ${fmt(n)} (${n.move}, est ${est.toFixed(1)} ticks) timed out after ${a.t - a.passTick} ticks at ${fmt(s.pos)}`);
        a.passTick = a.t;
        a.lastProgressTick = a.t;
        this.failAndReplan(a, s, 'timeout', 'move timeout');
        return;
      }
    }

    const prog = f.progress(s.pos);
    if (prog > a.bestProgress + 0.05) {
      a.bestProgress = prog;
      a.lastProgressTick = a.t;
    } else if (a.t - a.lastProgressTick >= this.stuckTicks) {
      a.report.stuck++;
      this.log.info(`goto: no progress for ${this.stuckTicks} ticks at ${fmt(s.pos)} (node ${f.index}/${f.path.length - 1})`);
      a.lastProgressTick = a.t;
      if (this.failAndReplan(a, s, 'stuck', 'stuck')) return;
    }

    // plan-ahead: the next segment, from the end of this one
    if (!a.search && a.status === 'partial' && !a.aheadBlocked && !a.replan && a.path.length - 1 - a.passedAbs < this.aheadNodes) {
      const end = a.path.at(-1)!;
      a.search = this.newSearch(a, end, 'ahead', 'ahead');
    }
  }

  // ---- Track BE: the executor's off-path checks (nav/baritone/executor.ts) ------------------------------

  /**
   * A correction / knock / teleport while a leg is walked on the ground: check the body against the
   * path on the next standing tick instead of re-planning. Not while the follower's move is one main
   * re-plans from at once (in water, a swim / climb / parkour / pillar target, a parkour run-up): those
   * re-plan as before.
   */
  private deferToPathCheck(a: Active, knock?: Vec3): boolean {
    if (!this.offPath || !a.follower || a.action || a.retreat || a.replan || a.search?.kind === 'main') return false;
    const s = this.loop.state;
    // Track W1: a correction while swimming or diving (the server's flow push, a waterfall's lift): the water
    // controllers steer from wherever the body is; the check after it re-plans only once it is off the path
    if (!knock && s.inWater && !s.gliding && waterMove(a.follower.path[a.follower.index]?.move)) {
      a.recheck ??= a.t;
      return true;
    }
    if (s.gliding || a.follower.checksPaused({ onGround: true, inWater: s.inWater })) return false;
    if (knock) {
      // a knock: where it will land is not known yet; only one expected to land on the leg waits for the landing
      const land = knockLanding(s.pos, knock);
      const f = a.follower;
      if (distanceFromPath(land, f.path, 0, f.path.length - 1) > KNOCK_ON_PATH) return false;
      if (this.grid.cls(Math.floor(land.x), Math.floor(land.y + 0.01), Math.floor(land.z))?.liquid) return false;
    }
    a.recheck ??= a.t;
    return true;
  }

  /**
   * The pending path check after a correction / knock / teleport, before the tick's re-plan: once the
   * body stands (or is in water, or after 20 ticks in the air: main's re-plan condition), restart the
   * leg at the node of the leg the body stands in when it is behind the last node passed or past the
   * aim (one between them walks on), else re-plan (`correction`) this very tick.
   */
  private resolveRecheck(a: Active, s: InputLoopState): void {
    if (a.recheck === undefined) return;
    const f = a.follower;
    if (!f || a.action || a.retreat) {
      a.recheck = undefined;
      return;
    }
    if (a.t <= a.recheck) return; // the event's own tick: the body has not moved yet (a knock moves it from this tick on)
    if (!s.onGround && !s.inWater && a.t - a.recheck <= 20) return; // in the air: wait for the landing
    a.recheck = undefined;
    // Track W1: in water on a swim / dive move: walk on while the body is within WATER_ON_PATH of the leg around it
    if (s.inWater && !s.gliding && waterMove(f.path[f.index]?.move)) {
      if (distanceFromPath(s.pos, f.path, f.passedIndex - 1, f.index + 1) > WATER_ON_PATH) a.replan ??= 'correction';
      return;
    }
    if (s.inWater || !s.onGround || s.gliding) {
      a.replan ??= 'correction';
      return;
    }
    const k = nodeAt(s.pos, f.path, 0, f.path.length - 1);
    if (k < 0) {
      a.replan ??= 'correction';
      return;
    }
    if (k < f.passedIndex || k > f.index) {
      a.report.snaps = (a.report.snaps ?? 0) + 1;
      this.log.debug(`goto: back on the path at node ${a.legFrom + k} after a correction / knock (was ${a.legFrom + f.passedIndex})`);
      this.startLeg(a, a.legFrom + k);
    }
  }

  /**
   * Per tick, before the follower steers (Baritone PathExecutor.onTick): skip ahead when the body
   * stands in a node past the aim; re-plan (`off_path`) when the body is more than 3 blocks from the
   * path, or more than 2 for longer than the grace. Not while the follower's move is paused (airborne,
   * in water, a swim, a climb, a parkour, a pillar) or the body glides. Returns true when the tick ends here.
   */
  private pathChecks(a: Active, s: InputLoopState, f: PathFollower): boolean {
    if (!this.offPath || s.gliding || f.checksPaused(s)) return false;
    const nodes = f.path;
    const passed = f.passedIndex;
    const k = skipAhead(s.pos, nodes, f.index);
    if (k >= 0) {
      a.report.skips = (a.report.skips ?? 0) + 1;
      this.log.debug(`goto: skipping ahead from node ${a.legFrom + f.index} to ${a.legFrom + k}`);
      this.startLeg(a, a.legFrom + k);
      a.ticksAway = 0;
      return false;
    }
    // the window: from PATH_WINDOW_BACK behind the last node passed to PATH_WINDOW_AHEAD past the aim
    const d = distanceFromPath(s.pos, a.path, a.legFrom + passed - PATH_WINDOW_BACK, a.legFrom + f.index + PATH_WINDOW_AHEAD);
    const st = offPathState(d, a.ticksAway + 1, this.offPathGrace);
    if (st === 'fine') {
      a.ticksAway = 0;
      return false;
    }
    a.ticksAway++;
    if (st === 'possibly_off') return false;
    a.ticksAway = 0;
    a.report.offPath = (a.report.offPath ?? 0) + 1;
    this.log.info(`goto: off the path (${d.toFixed(2)} blocks) at ${fmt(s.pos)}: re-planning`);
    this.log.debug(`goto: the path there: ${a.path.slice(Math.max(0, a.legFrom + passed - 3), a.legFrom + f.index + 4).map((n) => `${n.move} ${n.x} ${n.feet.toFixed(1)} ${n.z}`).join(', ')} (passed ${a.legFrom + passed}, aim ${a.legFrom + f.index})`); // Track R3
    a.replan ??= 'off_path';
    this.loop.release();
    a.guard.idle();
    return true;
  }
  // Track BE end

  // ---- Track AB: searches in the worker or in-thread ------------------------------------------------

  /**
   * One tick of the running search. Returns false when the tick ends here (the goto finished, or the
   * body waits for a main plan).
   */
  private stepSearch(a: Active): boolean {
    let search = a.search!;
    let res = search.s.step(this.sliceMs);
    if (!res && search.s instanceof WorkerSearch && search.s.failed) {
      if (search.kind === 'upgrade') {
        // the interim path stays; its end plans ahead as usual
        a.search = undefined;
        return true;
      }
      // the worker crashed or went silent: the same search in-thread, with the in-thread budgets
      search = a.search = { ...search, s: new PathSearch(this.grid, search.s.start, search.goal, this.segmentOptions(a, search.kind === 'main')), via: 'thread' };
      res = search.s.step(this.sliceMs);
    }
    search.slices++;
    if (res) {
      a.search = undefined;
      if (search.via === 'worker') {
        if (this.stale(search, res)) {
          a.report.stale = (a.report.stale ?? 0) + 1;
          this.log.debug(`goto: worker plan (${search.reason}) dropped: blocks changed near its path while it was searched`);
          if (search.kind === 'main') {
            a.replan ??= 'block';
            this.loop.release();
            return false;
          }
          return true;
        }
        this.planner?.touchCached(res.path);
      }
      a.report.planMs += res.ms;
      if (search.rejoin) {
        if (!this.onRejoinResult(a, res, search)) return false; // Track W2 way
      } else if (search.kind === 'main') {
        if (!this.onMainResult(a, res, search)) return false;
      } else if (search.keep) {
        this.onKeepResult(a, res, search); // Track W2 way
      } else if (search.kind === 'upgrade') {
        if (!this.onUpgradeResult(a, res, search)) return false;
      } else {
        this.onAheadResult(a, res, search);
      }
      return true;
    }
    if (search.kind !== 'main' || search.rejoin) return true;
    // a main plan in the worker: walk its interim answer (the best partial path after mainMs) while it goes on
    const early = search.s instanceof WorkerSearch ? search.s.takeInterim() : undefined;
    if (early && early.path.length > 1 && !search.noInterim && !this.stale(search, early)) {
      this.planner?.touchCached(early.path);
      if (!this.onMainResult(a, early, search, { interim: true })) {
        dropSearch(a);
        return false;
      }
      search.kind = 'upgrade';
      a.search = search;
      return true;
    }
    this.loop.release();
    return false;
  }

  /** A main plan (or a plan-ahead from `start`) in the worker when it is ready and the options cross threads, else in-thread. */
  private newSearch(a: Active, start: { x: number; y: number; z: number; feet?: number; perch?: true }, kind: 'main' | 'ahead', reason: ReplanReason): Search {
    const client = this.plannerFor();
    const main = kind === 'main';
    // Track R5: a main plan from a perch starts at the body's feet on it (a plan-ahead starts at a path's end: a node)
    if (start.perch && start.feet !== undefined) a.pathOpts.startFeet = start.feet;
    else delete a.pathOpts.startFeet;
    // Track CB: towards the corridor's next window when one is followed, else the goto's goal
    const target = this.corridorTarget(a, start);
    const navGoal = target ? waypointGoal(target.p) : a.planGoal;
    const wp = target?.index;
    // Track W2: a search from a node of a dig-out staircase on the path so far goes on up the stair
    const cut = a.pathOpts.digOut ? a.path.find((n) => n.cut && n.x === start.x && n.y === start.y && n.z === start.z)?.cut : undefined;
    if (cut) a.pathOpts.startCut = cut;
    else delete a.pathOpts.startCut;
    // Track R1: a plan-ahead from the path's end digs what the dig way's budget leaves after the digs still ahead on the
    // path (the body has not dug them yet: a.dug does not count them; the owner's cave bench dug 14 of 12 that way)
    const dw = a.pathOpts.digWay;
    if (dw) dw.left = Math.max(0, DIG_WAY_MAX_BLOCKS - a.dug - (kind === 'ahead' ? this.digsAhead(a) : 0));
    if (client) {
      const goal = plainGoal(navGoal);
      const spec = goal && this.workerSpec(a, main);
      if (goal && spec) return { s: client.search(kind, start, goal, spec, this.worldGen, main ? this.mainMs : undefined), kind, via: 'worker', reason, tick: a.t, slices: 0, goal: navGoal, wp };
    }
    return { s: new PathSearch(this.grid, start, navGoal, this.segmentOptions(a, main)), kind, via: 'thread', reason, tick: a.t, slices: 0, goal: navGoal, wp };
  }

  // ---- Track CB: the coarse corridor (docs/coarse.md "Following a corridor on foot") ------------------------

  /** The corridor waypoint the next search from `from` should aim at, or undefined for the goto's own goal. */
  private corridorTarget(a: Active, from: { x: number; y: number; z: number }): { index: number; p: Vec3 } | undefined {
    const st = a.corridor;
    if (!st) return undefined;
    const before = st.next;
    const t = fineTarget(st, { x: from.x + 0.5, y: from.y, z: from.z + 0.5 });
    if (st.next > before && a.report.corridor) a.report.corridor.passed += st.next - before;
    // a partial corridor walked to its end: ask for the next stretch from here, the raw goal meanwhile
    if (!t && !st.toGoal && st.next >= st.wps.length) {
      a.corridor = undefined;
      this.requestCorridor(a, 'extend');
    }
    return t;
  }

  /** Ask the coarse layer for a corridor from the body to the goal (when one is attached, the goal has a point and is far enough). */
  private requestCorridor(a: Active, why: 'start' | 'change' | 'failed' | 'extend'): void {
    const co = this.coarse;
    if (!co || a.corridorPending || a.corridorFailures >= CORRIDOR_MAX_FAILURES) return;
    const min = co.minBlocks();
    const gp = goalPoint(a.goal);
    if (!(min > 0) || !gp) return;
    const pos = this.loop.state.pos;
    if (why === 'start' && Math.hypot(gp.x - pos.x, gp.z - pos.z) < min) return;
    const gy = gp.y ?? (this.grid.source.columnTop?.(Math.floor(gp.x), Math.floor(gp.z)) ?? Math.floor(pos.y)) + 1;
    const modes = corridorModes(a.opts);
    const rep = (a.report.corridor ??= { requests: 0, failed: 0, passed: 0 });
    rep.requests++;
    a.corridorPending = true;
    a.corridorAt = a.t;
    a.corridorDirty = false;
    co.layer.plan({ start: { x: pos.x, y: Math.floor(pos.y + 1e-3), z: pos.z }, goal: { x: gp.x, y: gy, z: gp.z }, modes, goalStanding: true }).then(
      (c) => {
        if (this.active !== a) return;
        a.corridorPending = false;
        rep.status = c.status;
        rep.legs = c.legs.length;
        rep.blocks = Math.round(c.blocks);
        rep.ms = +c.ms.toFixed(1);
        const st = corridorState(c);
        rep.waypoints = st?.wps.length ?? 0;
        this.log.info(`goto: corridor (${why}) ${c.status}: ${c.legs.length} leg(s), ${Math.round(c.blocks)} blocks, ${st?.wps.length ?? 0} waypoint(s), ${c.expanded} expanded, ${c.ms.toFixed(0)} ms${c.reason ? ` (${c.reason})` : ''}`);
        a.corridor = st;
        if (!st) return;
        // the plan under way aims at the raw goal (or an old corridor): re-plan towards the corridor
        // (Track R3: not while the path ahead still digs: the dug way is walked out first, the next plan follows it)
        if (!a.action && a.replan === undefined && !midPillar(a) && !midDig(a)) a.replan = 'corridor';
      },
      (e: unknown) => {
        if (this.active !== a) return;
        a.corridorPending = false;
        this.log.warn(`goto: corridor request failed: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  }

  /** The fine planner could not reach corridor waypoint `wp`: its portal is marked failed and a fresh corridor asked for; the raw goal meanwhile. */
  private corridorFailed(a: Active, wp: number, why: string): void {
    const st = a.corridor;
    if (!st) return;
    const portal = st.portals[wp];
    const mode = st.modes[wp] ?? 'walk';
    // Track R2: failed for every mode the goto's corridors plan in, not the leg's alone: the fine planner walks it under
    // the goto's own rules whatever the mode, and a portal marked for `walk` was crossed in `mine` by the next corridor
    // (the Realm, 2026-11-09: the same waypoint unreachable three times over)
    if (portal) for (const m of new Set<CoarseMode>([mode, ...corridorModes(a.opts)])) this.coarse?.layer.markPortal(portal.id, m, 'failed');
    a.corridorFailures++;
    if (a.report.corridor) a.report.corridor.failed++;
    this.log.info(`goto: corridor waypoint ${wp} ${fmt(st.wps[wp]!)} unreachable (${why})${portal ? `; portal ${portal.id} marked failed for ${mode}` : ''}`);
    a.corridor = undefined;
    a.noProgress = undefined;
    this.requestCorridor(a, 'failed');
  }

  /** The planner worker when `plannerThreads` > 0 and it is ready (started / stopped here as the setting changes). */
  private plannerFor(): PlannerClient | undefined {
    const p = this.planner;
    if (!p) return undefined;
    if (this.plannerThreads() <= 0) {
      if (p.started) p.stop();
      return undefined;
    }
    if (!p.started) p.start();
    return p.ready ? p : undefined;
  }

  /** The goto's planner options without functions, or undefined when the worker cannot rebuild them (custom breakTicks / cellCost). */
  private workerSpec(a: Active, main: boolean): WorkerPlanOptions | undefined {
    const o = a.pathOpts;
    if (this.pathOpts.breakTicks) return undefined;
    const cc: AvoidanceCostFn | undefined = o.cellCost;
    if (cc && !cc.avoidance) return undefined;
    const b = this.workerBudgets;
    const inv = this.toolView(this.inventory?.()); // Track BE: the Digger's tool filter (worker break times match too)
    const prot = o.protectedBlocks;
    return {
      ...(o.costs ? { costs: { ...o.costs } } : {}),
      maxNodes: this.pathOpts.maxNodes ?? (main ? Math.round(b.mainNodes * (a.big ? BIG_SEARCH : 1) * (a.scale ?? 1)) : b.segmentNodes),
      maxMs: this.pathOpts.maxMs ?? (main ? Math.round(b.mainMs * (a.big ? BIG_SEARCH : 1) * (a.scale ?? 1)) : b.segmentMs),
      allowBreak: o.allowBreak ?? false,
      allowPlace: o.allowPlace ?? false,
      allowOpen: o.allowOpen ?? false,
      ...(o.moves ? { moves: { ...o.moves } } : {}), // Track AJ
      allowGravityAbove: o.allowGravityAbove ?? false, // Track BC
      throwaway: o.throwaway ?? 0, // Track BC
      ...(prot ? { protectedBlocks: [...prot] } : {}),
      ...(o.protectedArea ? { protectedArea: { ...o.protectedArea } } : {}),
      ...(o.noBreak?.size ? { noBreak: [...o.noBreak] } : {}),
      ...(o.noAction?.size ? { noAction: [...o.noAction] } : {}),
      ...(inv ? { inventory: { slots: inv.slots.map((s) => (s ? { name: s.name, count: s.count } : null)), selected: inv.selected } } : {}),
      ...(cc?.avoidance ? { avoidance: cc.avoidance } : {}),
      ...(o.falls ? { falls: { ...o.falls } } : {}), // Track BI
      ...(o.farmlandDropCost ? { farmlandDropCost: o.farmlandDropCost } : {}),
      ...(o.air !== undefined ? { air: o.air } : {}), // Track W1
      ...(o.digOut ? { digOut: true } : {}), // Track W2
      ...(o.startCut ? { startCut: o.startCut } : {}),
      ...(o.digWay ? { digWay: { left: o.digWay.left } } : {}), // Track W3
      ...(o.relax ? { relax: { ...o.relax } } : {}), // Track R1
      ...(o.frontier ? { frontier: true } : {}),
      ...(o.nearEnd ? { nearEnd: { x: o.nearEnd.x, y: o.nearEnd.y, z: o.nearEnd.z } } : {}), // Track R8: a near end's search
      ...(o.startFeet !== undefined ? { startFeet: o.startFeet } : {}), // Track R5: a perch start
      ...(o.perchGoal ? { perchGoal: true } : {}), // Track R6: onto the goal's perch
    };
  }

  /** Records a block change the planner reads (for the stale check of worker answers). */
  private noteChange(p: Vec3): void {
    this.worldGen++;
    this.changes.push({ gen: this.worldGen, x: p.x, y: p.y, z: p.z });
    if (this.changes.length > 4096) this.changes.splice(0, this.changes.length - 2048);
  }

  /** A worker answer asked for before a block changed next to its path (the same rule as a re-plan on a block update). */
  private stale(search: Search, res: PathResult): boolean {
    if (!(search.s instanceof WorkerSearch)) return false;
    const since = search.s.generation;
    if (this.worldGen === since) return false;
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const c = this.changes[i]!;
      if (c.gen <= since) break;
      for (const n of res.path) if (Math.abs(c.x - n.x) <= 1 && Math.abs(c.z - n.z) <= 1 && c.y >= n.y - 1 && c.y <= n.y + 2) return true;
    }
    return false;
  }

  /**
   * The final answer of a main plan whose interim path is being walked: spliced in at the first node
   * of the remaining interim path (from the last node passed, or the action's node) that the final path
   * also visits. Without a common node, a final path that reaches the goal makes the body re-plan from
   * where it is (reason 'upgrade'); a partial one leaves the interim path (its end plans ahead).
   * Returns false when the goto finished.
   */
  private onUpgradeResult(a: Active, res: PathResult, search: Search): boolean {
    this.record(a, res, search, { upgrade: true });
    a.lastMain = res.status;
    if (res.status === 'none') {
      a.why = this.noPathWhy(res);
      if (search.wp === undefined && this.escalate(a, a.why)) return true; // Track W3: the interim path is walked until the re-plan
      this.giveUp(a);
      return false;
    }
    const at = new Map<number, number>();
    res.path.forEach((n, j) => at.set(cellKey(n.x, n.y, n.z), j));
    const from = a.action ? a.action.node : a.passedAbs;
    for (let k = from; k < a.path.length; k++) {
      const n = a.path[k]!;
      const j = at.get(cellKey(n.x, n.y, n.z));
      if (j === undefined) continue;
      a.path = a.path.slice(0, k + 1).concat(res.path.slice(j + 1));
      a.status = search.wp !== undefined && res.status === 'found' ? 'partial' : res.status; // Track CB
      a.aheadBlocked = false;
      a.doors = a.doors.filter((d) => d.closeAt <= k);
      a.actedUpTo = Math.min(a.actedUpTo, k);
      a.report.upgrades = (a.report.upgrades ?? 0) + 1;
      a.unmetFinals = 0; // Track R3
      a.way = res.status === 'found' && search.wp === undefined ? { whole: true, source: 'own' } : undefined; // Track W2 way
      if (!a.action) this.startLeg(a, a.follower ? a.legFrom + a.follower.passedIndex : a.passedAbs);
      return true;
    }
    this.log.debug(`goto: the worker's ${res.status} plan does not meet the rest of the interim path; ${res.status === 'found' ? 're-planning from here' : 'walking on'}`);
    // (Track R3: from the second in a row the re-plan waits for its final answer: its interim, the best partial path
    // after 40 ms, led the body the other way round again, the final went round the other side, and the two took turns
    // until the cap, lava:20:5)
    if (res.status === 'found' && !a.action && a.replan === undefined) {
      a.replan = 'upgrade';
      if (++a.unmetFinals >= 2) a.noInterim = true;
    }
    return true;
  }

  /** Budgets of an in-thread segment search: a main plan (the body waits for it) gets `mainMs`, a plan-ahead `segmentMs`. */
  private segmentOptions(a: Active, main: boolean): PathOptions {
    return { ...a.pathOpts, maxNodes: this.pathOpts.maxNodes ?? this.segmentNodes, maxMs: this.pathOpts.maxMs ?? (main ? this.mainMs : this.segmentMs) };
  }

  /** Track R1: dig way cells still to be dug on the path ahead of the body (its cells not free yet). */
  private digsAhead(a: Active): number {
    let n = 0;
    for (let i = a.passedAbs + 1; i < a.path.length; i++) {
      const node = a.path[i]!;
      if (!node.act?.dig || node.move === 'swimOut' || node.cut !== undefined) continue;
      for (const c of node.act.dig) if (this.grid.free(c.x, c.y, c.z) === false) n++;
    }
    return n;
  }

  /** Starts a main search from the body's node. Returns false when the goto finished or must wait. */
  private startMain(a: Active, s: InputLoopState): boolean {
    const reason = a.replan ?? 'retry';
    a.replan = undefined;
    dropSearch(a); // Track AB
    a.follower = undefined;
    // Track AJ: swimming / on a ladder; Track W1: under water; Track R5: on a fence's top (a perch)
    const start = this.startOf(s.pos, this.preferNode(s));
    if (!start) {
      this.idleBody(s); // Track W1
      // Track R5: a body still in the air (just off a glide, falling onto something) has its node within ticks: wait for
      // it with no failure, SETTLE_TICKS at most a goto (the Realm, 2026-11-13: three failures 20 ticks apart ended a walk
      // 0.6 s after a landing)
      // Track R7: also a body the state calls grounded with nothing under its feet (the server's teleport answer says
      // "on the ground" for a body set 0.5 over a fence's top; the Realm, 2026-11-14: a failure counted there)
      const airborne = !s.onGround || (this.lowPerch && restsOn(this.loop.world, s.pos) === false);
      if (airborne && !s.inWater && !s.inLava && a.settled < this.settleTicks) {
        if (a.settled === 0) this.log.info(`goto: no start node at ${fmt(s.pos)} while the body is in the air: waiting for it to settle (up to ${this.settleTicks} ticks)`);
        a.settled += SETTLE_STEP;
        a.report.settleTicks = a.settled;
        a.replan = reason;
        a.waitUntil = a.t + SETTLE_STEP;
        return false;
      }
      if (this.fail(a, `no standable node at ${fmt(s.pos)}`)) return false;
      a.replan = 'retry';
      a.waitUntil = a.t + 20;
      if (a.lastSafe && (s.inWater || s.inLava || !s.onGround)) {
        a.retreat = { until: a.t + 60 };
        a.report.retreats++;
      }
      return false;
    }
    // the search that went nowhere from this node, nothing the planner reads changed since: it would go nowhere
    // again (Realm 2026-10-31: three identical 2-second searches per goto, every 8 s for 15 minutes)
    // (never for a goal that moves: a runAway threat read again at every plan)
    const np = a.noProgress;
    const wp = this.corridorTarget(a, start)?.index; // Track CB: the same search means the same goal (a corridor waypoint or the raw goal)
    if (reason === 'retry' && np?.key === cellKey(start.x, start.y, start.z) && np.gen === this.worldGen && np.via === (this.plannerFor() ? 'worker' : 'thread') && np.wp === wp && np.level === a.level && !movingGoal(a.planGoal)) {
      this.loop.release();
      this.log.info('goto: no retry: the same search from the same node, nothing changed since it went nowhere');
      this.giveUp(a);
      return false;
    }
    // Track R6: a column goal (a waypoint with no height, a flight's walk-out leg) with no node in any cell of the column and a
    // perch (a fence's top) as its top: the top as a block goal, onto it or next to it as below (before: unreachable
    // after 27 plans). A column with a node anywhere (a room under a roof with a fence on it, a path under a bridge's
    // rail) keeps the plain column goal: it arrived before at the column's cheapest node and must arrive there still.
    if (a.goal.type === 'xz' && a.perchGoal === undefined) {
      const gx = Math.floor(a.goal.x);
      const gz = Math.floor(a.goal.z);
      const top = this.columnTopCell(gx, gz);
      const node = top === undefined ? undefined : this.columnHasNode(gx, gz);
      if (top === null || node === true) a.perchGoal = null;
      else if (top !== undefined && node === false) {
        // the cell over the top block (a fence's 1.5), else the top block's own cell (a cauldron's inside)
        this.lookPerchGoal(a, gx, top + 1, gz, true);
        if (a.perchGoal === null) {
          a.perchGoal = undefined;
          this.lookPerchGoal(a, gx, top, gz, true);
        }
      }
      // (still undefined: part of the column is not loaded yet; asked again at the next plan, the goal left as it is)
    }
    if (a.goal.type === 'block') {
      // a block goal nobody can stand in (water, a wall, mid-air) is unreachable, whatever the search says
      // (Track R1: not a natural block the dig way may open: the dig way's level digs it out, flyC's walk down)
      const g = a.goal.p;
      const gx = Math.floor(g.x);
      const gy = Math.floor(g.y);
      const gz = Math.floor(g.z);
      // Track R6: a goal on a top the stand rule has no node for (a fence's): onto it by a step or a jump, else beside it
      if (a.perchGoal === undefined) this.lookPerchGoal(a, gx, gy, gz);
      if (!a.perchGoal && Number.isNaN(this.grid.stand(gx, gy, gz)) && Number.isNaN(this.grid.standThrough(gx, gy, gz))) {
        // feet on a stairs block's low half (y + 0.5) floor to the stairs cell: the node is the one above
        const c = this.grid.cls(gx, gy, gz);
        const stairs = c?.floor && c.top === 1 && !c.fullCube && this.grid.stand(gx, gy + 1, gz) === gy + 1;
        // Track R7: next to it (planGoal set) when a player could walk up to it: decided before the first plan, no failure counted
        if (!stairs && a.opts.beside && a.beside === undefined) this.lookBeside(a, gx, gy, gz);
        if (stairs) {
          a.planGoal = { type: 'block', p: { x: gx, y: gy + 1, z: gz } };
        } else if (a.beside || a.planGoal !== a.goal) {
          // (Track R7: the walk ends next to it; Track R8: or on the node just under the cell, a path block's top)
        } else if (!(a.pathOpts.allowBreak || a.pathOpts.allowPlace) && !(c && c.boxes.length > 0 && isNaturalTerrain(c.name) && this.digWayOn(a)) && sneakFits(this.grid, gx, gy, gz) !== true && !waterGoalCell(this.grid, gx, gy, gz)) { // Track BC: a cell the body fits sneaking is a goal; Track W3: a water cell is reached swimming or diving there
          a.why = `goal cell ${gx},${gy},${gz} (${c?.name ?? 'unloaded'}) is not standable`;
          if (a.opts.explain) a.cause = this.unstandableCause(gx, gy, gz, start); // Track R1: no search can stand there
          this.finishUnreachable(a);
          return false;
        }
      }
    }
    for (const k of this.blacklist.cells('dig')) a.noBreak.add(k); // Track R: blacklisted action cells
    a.pathOpts = this.planOptions(a.opts, a.noBreak);
    if (a.perchGoal && !a.perchGoal.ring) a.pathOpts.perchGoal = true; // Track R6: the last move onto the goal's top
    this.applyLevel(a); // Track W3: no fall that hurts before level 2; the dig way from level 1
    // two failed pillar places in one goto: something systematic (reach, the server refusing); plan without pillaring
    if (a.placeFailures >= 2) a.pathOpts.allowPlace = false;
    const noAction = new Set([...this.blacklist.cells('place'), ...this.blacklist.cells('use'), ...a.noAction]);
    if (noAction.size) a.pathOpts.noAction = noAction;
    // Track W2 way: a handed way, or the kept way after a correction or a step off it: walked on, or rejoined, with no fresh plan
    if (this.keepWay(a, s, start, reason)) return true;
    // Track R3: the long dig search plans this one search with its options; the plan-aheads from its end plan as the
    // level does (they walk on where the dug way comes out, and dig no more than the level would)
    const levelOpts = a.pathOpts;
    if (a.long) a.pathOpts = longDigOptions(levelOpts);
    const nearSearch = a.nearSearch === true; // Track R8: a partial end at any distance (the node nearest the goal)
    a.nearSearch = false;
    if (nearSearch && a.goal.type === 'block') a.pathOpts = { ...a.pathOpts, nearEnd: { x: Math.floor(a.goal.p.x) + 0.5, y: Math.floor(a.goal.p.y) + 0.5, z: Math.floor(a.goal.p.z) + 0.5 } };
    if (start.perch) {
      a.report.perchStarts = (a.report.perchStarts ?? 0) + 1;
      const own = this.grid.cls(start.x, start.y, start.z);
      const on = own?.boxes.length ? own : this.grid.cls(start.x, start.y - 1, start.z);
      if (start.low) a.report.lowStarts = (a.report.lowStarts ?? 0) + 1; // Track R7
      this.log.info(`goto: starting from a perch at ${start.x},${start.y},${start.z} feet ${+start.feet.toFixed(4)} (on ${on?.name ?? '?'}: no standable node there${start.low ? '; under 1.8 of head room, the body held crouched' : ''})`);
    }
    a.search = this.newSearch(a, start, 'main', reason); // Track AB: in the worker when it is ready
    // (the long dig search's interim, its best partial path after 40 ms, is not walked: weighted and digging cheaply,
    // it led the body into a tower's foot, where the level's plans found nothing more, pits:12:10)
    if (a.long) a.search.long = true;
    if (nearSearch) a.search.near = true;
    if (a.noInterim || a.long) a.search.noInterim = true;
    a.noInterim = false;
    a.pathOpts = levelOpts;
    a.big = false; // Track R1: one bigger search per ask
    a.long = false; // Track R3: one long dig search per ask
    this.idleBody(s); // Track W1: in water, held at its depth while the plan is searched
    return true;
  }

  private record(a: Active, res: PathResult, search: Search, flags: { interim?: boolean; upgrade?: boolean; way?: 'rejoin' } = {}): void {
    a.report.plans.push({
      reason: search.reason,
      tick: search.tick,
      status: res.status,
      nodes: res.path.length,
      expanded: res.expanded,
      ms: +res.ms.toFixed(2),
      slices: search.slices,
      via: search.via,
      limited: res.limited,
      ...(res.reason === 'no_progress' ? { noProgress: true } : {}),
      ...(res.unknown ? { unknown: true } : {}),
      ...flags,
      blocks: +wayBlocks(res.path).toFixed(1), // Track W2 way
    });
    const tag = flags.interim ? ' interim' : flags.upgrade ? (search.keep ? ' beside the way' : ' final') : search.rejoin ? ' rejoin' : search.kind === 'ahead' ? ' ahead' : '';
    // Track W2 way: one line a plan at INFO for a walk to a place (a `block` or `xz` goal: the walks a Realm series asks
    // about), with the blocks of its path; the other goals' plans (a follow, a pickup, a flee) stay at debug
    const line = this.walkGoal(a) ? this.log.info.bind(this.log) : this.log.debug.bind(this.log);
    line(`goto: plan (${search.reason}${tag}, ${search.via}) ${res.status}, ${res.path.length} nodes, ${wayBlocks(res.path).toFixed(1)} blocks, ${res.expanded} expanded, ${res.ms.toFixed(1)} ms over ${search.slices} tick(s)${res.frontier ? ', to the frontier' : ''}${res.unknown ? ', unknown touched' : ''}${res.path.length > 1 ? `, ends ${res.path.slice(-3).map((n) => `${n.move} ${n.x} ${n.feet.toFixed(1)} ${n.z}`).join(', ')}` : ''}`); // Track R2: where it ends
  }

  /** Returns false when the goto finished or must wait. */
  private onMainResult(a: Active, res: PathResult, search: Search, flags: { interim?: boolean } = {}): boolean {
    this.record(a, res, search, flags);
    a.lastMain = res.status; // Track R
    // Track R3: the long dig search's partial answer is walked only towards a corridor waypoint (the corridor's next
    // window re-aims it; on a loaded machine the long trips' crossings came as partial ways of 30 to 50 nodes, and
    // the waypoints failed without them). Towards the goal itself only a whole way: weighted and digging cheaply,
    // its partial ends dig into the way, and pits:12:10's dug into the 2 x 2 tower the stair up had to be cut from;
    // from inside the holes no stair was left (the next plans and the "why" answer: `rule place`)
    // (Track R8: a near end's partial way that digs nothing is walked: it is the walk to the node nearest the goal)
    if (search.long && !flags.interim && res.status !== 'found' && res.path.length > 1 && search.wp === undefined && !(search.near && !res.path.some((p) => p.act?.dig?.length))) {
      this.log.info(`goto: the long dig search found no whole way (a partial way of ${res.path.length} nodes, ${res.expanded} expanded): not walked`);
      res = { ...res, path: res.path.slice(0, 1), reason: 'no_progress' };
    }
    // Track R2: after an open way (walkOpenWay) the weighted search found nothing to walk: the open way itself
    if (a.openPath && !flags.interim) {
      if ((res.status === 'none' || res.path.length <= 1) && this.adoptOpenWay(a)) return true;
      a.openPath = undefined;
    }
    if (res.status === 'none' && res.path.length === 0) {
      // Track R5: the search found no start where the navigator found one (the worker's copy of the world a tick behind
      // the body's chunks, a perch the search's grid reads otherwise): a failure that plans again, never the answer (it
      // ended the goto at once, or failed a corridor waypoint the body never left for)
      this.loop.release();
      if (this.fail(a, 'the start node is not standable in the planner')) return false;
      a.replan = 'retry';
      a.waitUntil = a.t + 10;
      return false;
    }
    if (res.status === 'none') {
      // Track CB: a corridor waypoint with no path is the corridor's failure, not the goto's: re-plan towards the raw goal
      if (search.wp !== undefined && a.corridor) {
        this.loop.release();
        this.corridorFailed(a, search.wp, this.noPathWhy(res));
        a.replan = 'retry';
        a.waitUntil = a.t + 1;
        return false;
      }
      a.why = this.noPathWhy(res);
      if (this.perchBeside(a, a.why) || this.besideRing(a, a.why)) {
        // Track R6: no way onto the goal's top: beside it, at the same level (Track R8: or next to an air cell)
        this.loop.release();
        a.replan = 'retry';
        a.waitUntil = a.t + 1;
        return false;
      }
      if (this.escalate(a, a.why)) {
        // Track W3: the next level before giving up
        this.loop.release();
        return false;
      }
      this.giveUp(a);
      return false;
    }
    if (res.path.length === 1 && res.status !== 'found') {
      this.loop.release();
      // the closest reachable node is where we stand: nothing to do but wait for the world to change
      const lim = `${res.limited ? ', search limit hit' : ''}${res.unknown ? ', touched unloaded world' : ''}`;
      const what = res.reason === 'no_progress' ? 'no partial end 5+ blocks from the start' : 'no node closer to the goal than the start'; // Track BA
      const why = res.digOut && !res.unknown && !res.limited ? trappedWhy(res.digOut, res.expanded) : `no progress possible (${what}; ${res.expanded} expanded${lim})`; // Track W2; Track R1: not "trapped" on a search cut short
      // a worker search, or in-thread with no worker at all (not the 40 ms in-thread stand-in while the worker starts:
      // its retry runs in the worker with 50 x the budget)
      const full = search.via === 'worker' || !this.planner || this.plannerThreads() <= 0;
      // Track R1: a worker search the budget cut short is no answer: once per node, level and waypoint it is asked
      // again with BIG_SEARCH x the budget before it may escalate the level, count as a failure or be skipped
      const s0 = res.path[0];
      const bigKey = s0 ? `${cellKey(s0.x, s0.y, s0.z)}:${a.level}:${search.wp ?? '-'}` : undefined;
      // Track R8: a `beside` goto standing near its goal's cell: no ladder of bigger searches from here (nearNoWay). Not
      // towards a corridor waypoint, not on the stand-in's cut search, not while the chunks round the goal may still come
      // (unloaded world farther off is no reason to wait: a way through it is a detour of the view distance for a goal 8 off)
      // A search the budget cut is no proof: at the last level its bigger search and the long dig search still run, once
      // for the node (the bench's 2 x 2 towers: the stair up is found by one of them), then the answer
      const retry = (): boolean => res.limited && search.via === 'worker' && bigKey !== undefined && (!a.bigTried.has(bigKey) || (!search.long && this.longDigOn(a) && !a.longTried.has(bigKey) && !goalUnloaded(search.goal, this.grid)));
      if (search.wp === undefined && full && !(res.unknown && !res.limited && a.unloadedTicks < this.unloadedWaitTicks && !this.loadedRound(a)) && this.nearNoWay(a, why, res.limited, retry)) return false;
      if (res.limited && search.via === 'worker' && bigKey !== undefined && !a.bigTried.has(bigKey)) {
        a.bigTried.add(bigKey);
        a.big = true;
        a.replan = 'retry';
        a.waitUntil = a.t + 1;
        this.log.info(`goto: the plan was cut by its budget with no progress (${res.expanded} expanded): planning again with ${BIG_SEARCH} x the budget`);
        return false;
      }
      // Track R3: a goto that digs anyway, whose search and its bigger one were cut with no progress: once per node, level
      // and waypoint the long dig search (digs priced at their time, the heuristic weighted: a dug way of tens of blocks,
      // a ravine's walls, is past any search at the level's price) before the corridor fails, the level goes up or a
      // failure counts. Not towards a goal in unloaded world: that search went nowhere for the unknown, not for a dug
      // way (R1's frontier legs walk towards it), and the long dig search tunnelled there where a walk existed
      if (res.limited && search.via === 'worker' && bigKey !== undefined && !search.long && this.longDigOn(a) && !a.longTried.has(bigKey) && !goalUnloaded(search.goal, this.grid)) {
        a.longTried.add(bigKey);
        a.long = true;
        a.replan = 'retry';
        a.waitUntil = a.t + 1;
        this.log.info(`goto: the bigger plan was cut with no progress too (${res.expanded} expanded): the long dig search (digs at ${LONG_DIG_PRICE} a block, the heuristic x ${LONG_DIG_WEIGHT})`);
        return false;
      }
      // Track CB: no progress towards a corridor waypoint is the corridor's failure. Track R1: whatever the search
      // touched (unloaded world lies past the server's view at the edge of every big search: waiting for it never
      // ended a no-progress search towards a waypoint on a cliff's edge, and the levels never came), unless the
      // waypoint's own cell is not loaded yet; and no failure counted: the raw goal is planned next, with its levels
      if (search.wp !== undefined && a.corridor) {
        const wpCell = a.corridor.wps[search.wp];
        const wpUnloaded = wpCell !== undefined && this.grid.cls(Math.floor(wpCell.x), Math.floor(wpCell.y), Math.floor(wpCell.z)) === undefined;
        if (!(wpUnloaded && a.unloadedTicks < this.unloadedWaitTicks)) {
          this.corridorFailed(a, search.wp, res.reason === 'no_progress' ? 'no progress towards it' : 'no node closer to it');
          a.replan = 'retry';
          a.waitUntil = a.t + 1;
          return false;
        }
      }
      if (res.unknown && !res.limited && a.unloadedTicks < this.unloadedWaitTicks) {
        // the segment ends at unloaded world: wait for the chunks
        a.unloadedTicks += 10;
        a.report.unloadedWait += 10;
        a.replan = 'retry';
        a.waitUntil = a.t + 10;
        return false;
      }
      // Track W3: the next level before a failure counts (after the wait for unloaded world; never on the stand-in's
      // cut-off search: the worker's retry may find the way at this level)
      if (search.wp === undefined && (full || !res.limited) && this.perchBeside(a, why)) {
        a.replan = 'retry'; // Track R6: no way onto the goal's top: beside it, at the same level
        a.waitUntil = a.t + 1;
        return false;
      }
      if (search.wp === undefined && (full || !res.limited) && this.escalate(a, why)) return false;
      if (this.fail(a, why)) return false;
      // recorded for the retry skip (a full search only; Track R1: a worker search cut by its budget only once it was
      // asked with BIG_SEARCH x the budget: before that its retry is no repeat)
      const repeat = !res.limited || search.via !== 'worker' || (bigKey !== undefined && a.bigTried.has(bigKey));
      a.noProgress = s0 && res.reason === 'no_progress' && !res.unknown && repeat && full ? { key: cellKey(s0.x, s0.y, s0.z), gen: this.worldGen, via: search.via, wp: search.wp, level: a.level } : undefined;
      a.replan = 'retry';
      a.waitUntil = a.t + 20;
      return false;
    }
    // Track R1: a partial plan that ends where an earlier partial plan of this goto began (the same level) goes
    // nowhere: from either end the other was the best end of a closed search, and the body walked
    // between them until the goto's cap (lava:14:10, 1247 blocks). No progress: the corridor's failure, the next
    // level, or a failure counted
    if (res.status !== 'found' && res.path.length > 1) {
      const at = (n: PathNode): string => `${cellKey(n.x, n.y, n.z)}:${a.level}`; // (towards a corridor waypoint or the raw goal alike: they took turns, lava:14:10)
      // (and the body sent back off the path to the same cell again and again: a dead end whose plan-ahead led back
      // along the path, the skip-ahead onto the copy coming back, the off-path check, the same plans: hills:20:13
      // timed out after 240 plans from one cell)
      const from = at(res.path[0]!);
      const offs = search.reason === 'off_path' ? (a.offPathFrom.get(from) ?? 0) + 1 : 0;
      if (offs) a.offPathFrom.set(from, offs);
      const loop = a.partialFrom.has(at(res.path.at(-1)!)) || offs >= OFF_PATH_LOOP;
      if (loop && res.unknown && a.loopWaited < this.unloadedWaitTicks) {
        // the plans end at unloaded world: the chunks may come (nav-v2's strip). Once a goto, never reset by the plans
        // in between (a goal far in unloaded world kept waiting until the goto's cap, unknown:16:0)
        this.loop.release();
        a.loopWaited += 10;
        a.report.unloadedWait += 10;
        a.replan = 'retry';
        a.waitUntil = a.t + 10;
        return false;
      }
      if (loop) {
        this.loop.release();
        const why = 'no progress possible (the partial plans lead back and forth between two ends)';
        a.looped = true;
        this.log.info(`goto: ${why}`);
        if (search.wp !== undefined && a.corridor) {
          this.corridorFailed(a, search.wp, 'no progress towards it (the partial plans loop)');
          a.replan = 'retry';
          a.waitUntil = a.t + 1;
          return false;
        }
        if (this.nearNoWay(a, why)) return false; // Track R8
        if (this.perchBeside(a, why)) {
          a.replan = 'retry'; // Track R6
          a.waitUntil = a.t + 1;
          return false;
        }
        if (this.escalate(a, why)) return false;
        if (this.fail(a, why)) return false;
        a.replan = 'retry';
        a.waitUntil = a.t + 20;
        return false;
      }
      a.partialFrom.add(at(res.path[0]!));
    }
    if (res.path.length > 1) {
      a.unloadedTicks = 0;
      a.noProgress = undefined; // a plan went somewhere: a later failure from the same node is searched again
      if (search.long && !flags.interim) {
        a.report.longDigPlans = (a.report.longDigPlans ?? 0) + 1; // Track R3
        let digs = 0;
        for (const n of res.path) digs += n.act?.dig?.length ?? 0;
        this.log.info(`goto: the long dig search found ${res.status === 'found' ? 'a way' : 'a partial way'} (${res.path.length} nodes, ${digs} block(s) to dig, ${res.expanded} expanded)${search.wp !== undefined ? ` towards corridor waypoint ${search.wp}` : ''}`);
      }
      if (res.frontier && !flags.interim) {
        a.frontierLegs++; // Track R1
        this.log.info(`goto: no way in the loaded world: heading into the unloaded world towards the goal (frontier leg ${a.frontierLegs}/${FRONTIER_MAX_LEGS}, ${res.path.length} nodes)`);
      }
    }
    this.walkPath(a, res.path, search.wp !== undefined && res.status === 'found' ? 'partial' : res.status); // Track CB: a reached waypoint is not the goal: the leg's end plans on
    // Track W2 way: a plan that reaches the goal is the way kept (a correction or a step off it walks on along it)
    a.way = res.status === 'found' && search.wp === undefined && !flags.interim ? { whole: true, source: 'own' } : undefined;
    return true;
  }

  /** The goto walks the path from its start (a plan's answer, a kept way): the doors and hatches it closes behind, the first leg. */
  private walkPath(a: Active, path: PathNode[], status: PathResult['status']): void {
    a.path = path;
    a.status = status;
    a.aheadBlocked = false;
    a.doors = [];
    // Track BG: a hatch this goto opened is closed behind on the new path as well. Track BG2: after the LAST node
    // whose body is in the hatch cell (a re-plan while the body climbs through it, e.g. after a small correction,
    // used to drop the close: the new path starts in the hatch cell)
    for (const h of a.hatches) {
      if (!this.grid.cls(h.x, h.y, h.z)?.open) continue;
      let last = 0;
      for (let i = 0; i < path.length; i++) {
        const n = path[i]!;
        if (n.x === h.x && n.z === h.z && n.feet < h.y + 1 && n.feet + BODY_HEIGHT > h.y) last = i;
      }
      this.scheduleHatchClose(a, h, last);
    }
    a.actedUpTo = -1;
    a.report.segments++;
    this.startLeg(a, 0);
  }

  private onAheadResult(a: Active, res: PathResult, search: Search): void {
    this.record(a, res, search);
    const end = a.path.at(-1);
    const first = res.path[0];
    const sameStart = !!end && first?.x === end.x && first.y === end.y && first.z === end.z;
    if (res.status === 'none' || res.path.length <= 1 || !sameStart) {
      a.aheadBlocked = true;
      return;
    }
    // Track R1: a partial segment that ends on a cell the path already went through adds no ground: the plan-ahead
    // from there led back again (segments ping-ponging between two partial ends, the body held where it stood by the
    // skip-ahead into each new copy of its node, lava:14:10). The body walks to the end first; the re-plan from there
    // runs as a main search
    const tail = res.path.at(-1)!;
    if (res.status !== 'found' && a.path.some((n) => n.x === tail.x && n.y === tail.y && n.z === tail.z)) {
      a.aheadBlocked = true;
      return;
    }
    const oldLast = a.path.length - 1;
    a.path = a.path.concat(res.path.slice(1));
    a.status = search.wp !== undefined && res.status === 'found' ? 'partial' : res.status; // Track CB
    a.way = a.status === 'found' ? { whole: true, source: 'own' } : undefined; // Track W2 way
    a.report.segments++;
    // the leg that ran to the old end now runs on into the new segment
    if (a.legTo === oldLast && !a.action) {
      const from = a.follower ? a.legFrom + a.follower.passedIndex : oldLast;
      this.startLeg(a, from);
    }
  }

  /** The leg from `from`: up to the node before the next action, a door to close, or the end. */
  private startLeg(a: Active, from: number): void {
    const last = a.path.length - 1;
    let to = last;
    // Track BG2: a close due at the leg's first node (a re-plan from a node already out of the hatch cell) runs first
    if (a.doors.some((d) => d.closeAt === from)) to = from;
    else for (let i = from + 1; i <= last; i++) {
      if (i > a.actedUpTo && a.path[i]!.act) {
        to = i - 1;
        break;
      }
      if (a.doors.some((d) => d.closeAt === i)) {
        to = i;
        break;
      }
    }
    if (to < from) to = from;
    a.legFrom = from;
    a.legTo = to;
    const stopAtEnd = to < last || a.status === 'found';
    a.follower = new PathFollower(a.path.slice(from, to + 1), this.grid, { sprint: a.opts.sprint, sprintJump: a.opts.sprintJump, stopAtEnd, maxTurnDeg: this.maxTurn, guard: a.guard, cellCost: a.pathOpts.cellCost, edgeSneak: this.edgeSneak }); // Track S: cellCost, Track AJ: edgeSneak, Track M9: sprintJump
    a.passedAbs = from;
    a.aimAbs = from;
    a.passTick = a.t;
    a.bestProgress = -Infinity;
    a.lastProgressTick = a.t;
  }

  private onLegDone(a: Active): void {
    const last = a.path.length - 1;
    a.passedAbs = a.legTo;
    if (a.legTo < last || a.doors.some((d) => d.closeAt === a.legTo)) {
      const door = a.doors.find((d) => d.closeAt === a.legTo);
      if (door) {
        a.doors = a.doors.filter((d) => d !== door);
        this.beginAction(a, { kind: 'close', node: a.legTo, queue: [door.p], axis: door.axis });
        return;
      }
      const k = a.legTo + 1;
      const act = k > a.actedUpTo ? a.path[k]?.act : undefined;
      if (!act) {
        this.startLeg(a, a.legTo);
        return;
      }
      const prev = a.path[k - 1]!;
      const node = a.path[k]!;
      const axis: 0 | 2 = node.x !== prev.x ? 0 : 2;
      if (act.dig) this.beginAction(a, { kind: 'dig', node: k, queue: [...act.dig], axis });
      else if (act.use) this.beginAction(a, { kind: 'use', node: k, queue: [...act.use], axis });
      else if (act.place) this.beginAction(a, { kind: 'place', node: k, queue: [act.place.p], axis });
      else this.startLeg(a, k - 1);
      return;
    }
    if (a.status === 'found') {
      // Track R: a runAway from a moving threat (a function) is checked again where the threat is now
      const g = a.planGoal;
      const end = a.path.at(-1);
      if (g.type === 'runAway' && typeof g.from === 'function' && end && !goalTest(g, this.grid).done(end.x, end.y, end.z, end.feet)) {
        a.replan ??= 'partial';
        return;
      }
      const note = this.perchArrival(a) ?? this.besideArrival(a); // Track R6: beside a goal on a top no move goes onto; Track R7: a cell nobody stands in
      a.finish(note ? { ok: true, note } : { ok: true });
      return;
    }
    // the end of a partial segment: wait for the plan-ahead (or the worker's final answer), else re-plan from here
    if (a.search?.kind === 'ahead' || a.search?.kind === 'upgrade') {
      this.loop.release();
      return;
    }
    a.replan ??= 'partial';
  }

  private beginAction(a: Active, run: Pick<ActionRun, 'kind' | 'node' | 'queue' | 'axis'>): void {
    a.follower = undefined;
    if (a.search?.kind === 'main') dropSearch(a); // Track AB: plan-aheads and worker upgrades go on
    this.loop.release();
    a.action = {
      ...run,
      pending: false,
      result: undefined,
      waitClear: undefined,
      placed: false,
      started: a.t,
      timeout: run.kind === 'dig' ? DIG_TIMEOUT * Math.max(1, run.queue.length) : ACTION_TIMEOUT,
      current: undefined, // Track BC
      settleUntil: 0,
      settled: false,
      digs: 0,
    };
    for (const p of run.queue) {
      a.ownCells.add(cellKey(p.x, p.y, p.z));
      if (run.kind === 'dig') this.grid.invalidate(p.x, p.y, p.z); // Track BC: the "already free" check reads the live block, never a cached class
      if (run.kind === 'use' || run.kind === 'close') a.ownCells.add(cellKey(p.x, p.y + 1, p.z));
      // Track BC: with Baritone's gravity rule the stack over a dug cell falls into it: our own doing, no re-plan
      if (run.kind === 'dig' && a.pathOpts.allowGravityAbove) for (let dy = 1; dy <= 3; dy++) a.ownCells.add(cellKey(p.x, p.y + dy, p.z));
    }
    this.log.debug(`goto: ${run.kind} ${run.queue.map(fmt).join(' ')} before node ${run.node}`);
  }

  /** Runs `fn` as the action's pending call; its result lands in `run.result`. */
  private call(run: ActionRun, fn: (() => Promise<SkillResult>) | undefined): void {
    run.pending = true;
    run.result = undefined;
    if (!fn) {
      run.pending = false;
      run.result = { ok: false, reason: 'no_action' };
      return;
    }
    fn().then(
      (r) => {
        run.pending = false;
        run.result = r;
      },
      (e: unknown) => {
        run.pending = false;
        run.result = { ok: false, reason: e instanceof Error ? e.message : String(e) };
      },
    );
  }

  private actionFailed(a: Active, s: InputLoopState, run: ActionRun, why: string, reason: ReplanReason = 'action'): void { // Track BE: reason
    if (run.kind === 'close') {
      // Track BG2: a door / hatch left open behind the body is no reason to stop the goto: no failure count, no
      // retreat, no re-plan (on the Realm a rejected close from the ladder made the bot climb back out of the shaft)
      a.report.closeFailed = (a.report.closeFailed ?? 0) + 1;
      this.log.info(`goto: close failed (${why}), left open`);
      a.action = undefined;
      this.loop.setCommand({ jump: false, pitch: 0 });
      a.lastProgressTick = a.t;
      this.startLeg(a, run.node);
      return;
    }
    a.report.actions.failed++;
    this.log.info(`goto: ${run.kind} failed (${why})`);
    const cellP = run.kind === 'dig' ? (run.current ?? run.queue[0]) : run.queue[0]; // Track R: count the failure against the action cell (Track BC: the cell being dug)
    if (cellP && this.blacklist.fail(actionKey(run.kind, cellP), why)) a.report.blacklisted?.push(actionKey(run.kind, cellP));
    // a pillar / door cell that failed is not planned again during this goto (like a failed dig cell):
    // the re-plan looks for another way instead of spending the whole failure budget on one cell
    if (cellP && (run.kind === 'place' || run.kind === 'use')) a.noAction.add(cellKey(cellP.x, cellP.y, cellP.z));
    if (run.kind === 'place') a.placeFailures++;
    a.action = undefined;
    this.loop.setCommand({ jump: false, pitch: 0 });
    a.lastProgressTick = a.t;
    this.failAndReplan(a, s, reason, `${run.kind} failed: ${why}`); // Track BE: reason
  }

  private actionDone(a: Active, run: ActionRun): void {
    a.action = undefined;
    this.loop.setCommand({ jump: false, pitch: 0 });
    if (run.kind !== 'close') a.actedUpTo = Math.max(a.actedUpTo, run.node);
    // Track BC: a pillar-up under a low ceiling digs the cell above the head first, then places (not again when the
    // block is already there: a re-dig of the head room after the pillar)
    const place = run.kind === 'dig' ? a.path[run.node]?.act?.place : undefined;
    if (place && this.grid.free(place.p.x, place.p.y, place.p.z) === true) {
      this.beginAction(a, { kind: 'place', node: run.node, queue: [place.p], axis: run.axis });
      return;
    }
    // the leg that contains the move into the action's node (pillar: the leg from the new node)
    this.startLeg(a, run.kind === 'place' || run.kind === 'close' ? run.node : run.node - 1);
  }

  private stepAction(a: Active, s: InputLoopState): void {
    const run = a.action!;
    a.guard.idle();
    // a running place action (Track O's PlaceSkill) drives the jump itself
    // Track BG: on a ladder (a hatch opened from below, closed behind) sneak holds the body where it is
    const onLadder = !s.onGround && this.grid.climbable(Math.floor(s.pos.x), Math.floor(s.pos.y + 1e-3), Math.floor(s.pos.z)) === true;
    // Track BG2: a running use / close owns sneak (UseSkill releases it for the click: sneaking with an item in the
    // hand uses the item, not the trapdoor)
    const useOwnsSneak = run.pending && (run.kind === 'use' || run.kind === 'close');
    // Track W2: a dig from water (a step into a lip) treads water: jump while sinking keeps the head out of it
    const wet = run.kind === 'dig' && bodyInWater(this.cellOf, s);
    if (!(run.kind === 'place' && run.pending)) this.loop.setCommand(useOwnsSneak ? { forward: 0, strafe: 0, sprint: false, jump: false } : { forward: 0, strafe: 0, sprint: false, sneak: onLadder, jump: wet && s.vel.y < 0 });
    // Track BE: Baritone PathExecutor's movement timeout: the action ran longer than its node's cost + 100 ticks
    // (not while a call is pending: the Digger times out on its own estimate; not when the last dig just succeeded)
    const node = a.path[run.node];
    const justDone = run.kind === 'dig' && run.result?.ok === true;
    // Track BC: a dig action keeps its whole list in `queue`; the cell not dug yet is the first one that is not free
    const undug = run.kind === 'dig' ? run.queue.find((c) => this.grid.free(c.x, c.y, c.z) !== true) : run.queue[0];
    if (this.offPath && node && run.kind !== 'close' && !run.pending && !(justDone && !undug) && nodeOverrun(a.t - run.started, node.cost, this.overrun.factor, this.overrun.margin)) {
      a.report.overruns = (a.report.overruns ?? 0) + 1;
      const p = undug; // the cell not dug yet
      if (run.kind === 'dig' && p) a.noBreak.add(cellKey(p.x, p.y, p.z)); // like a failed dig: not planned again this goto
      this.actionFailed(a, s, run, `overrun (${a.t - run.started} ticks, cost ${node.cost.toFixed(1)})`, 'overrun');
      return;
    }
    // Track BE end
    if (a.t - run.started > run.timeout) {
      if (run.kind === 'dig' && run.pending) this.cancelDig?.(); // Track BE: abort the Digger's job (the next dig would get 'busy')
      this.actionFailed(a, s, run, 'timeout');
      return;
    }
    if (run.pending) return;
    let res = run.result;
    if (res && !res.ok && run.kind === 'close' && !run.retried) {
      // Track BG2: a failed close is clicked once more (then actionFailed lets the walk go on with it open)
      this.log.info(`goto: close failed (${String(res.reason)}), clicking once more`);
      run.retried = true;
      run.result = undefined;
      res = undefined;
    }
    if (res && !res.ok) {
      if (run.kind === 'dig') {
        const p = run.current ?? run.queue[0];
        if (p) a.noBreak.add(cellKey(p.x, p.y, p.z));
      }
      this.actionFailed(a, s, run, String(res.reason));
      return;
    }
    switch (run.kind) {
      case 'dig': {
        // Track BC: the break order (nav/actions.ts): the whole list stays; the first cell that is not free
        // is dug next, so a cell a falling stack refilled (allowGravityAbove) is dug again after it settles
        if (res) {
          run.result = undefined;
          if (a.pathOpts.digWay && node?.move !== 'swimOut' && node?.cut === undefined) a.dug++; // Track W3: the dig way budget
          const p = run.current;
          if (p && this.grid.cls(p.x, p.y + 1, p.z)?.gravity) run.settleUntil = a.t + DIG_SETTLE_TICKS;
          run.current = undefined;
          // Track W2: a step dug out of the water: plan again after every break (water may have flowed into the cut)
          if (node?.move === 'swimOut') {
            this.log.debug(`goto: dug ${p ? fmt(p) : '?'} out of the water; re-planning`);
            a.action = undefined;
            this.loop.setCommand({ jump: false, pitch: 0 });
            a.lastProgressTick = a.t;
            a.replan = 'block';
            return;
          }
        }
        if (a.t < run.settleUntil) return;
        const p = run.queue.find((c) => this.grid.free(c.x, c.y, c.z) !== true);
        if (!p) {
          if (run.digs === 0) this.log.debug(`goto: dig cells ${run.queue.map((c) => `${fmt(c)} ${this.grid.cls(c.x, c.y, c.z)?.name ?? '?'}`).join(' ')} already free`);
          if (a.pathOpts.allowGravityAbove && run.digs > 0 && !run.settled) {
            // a stack already in the air reads as free cells: wait once more before the body walks in
            run.settled = true;
            run.settleUntil = a.t + DIG_SETTLE_TICKS;
            return;
          }
          this.actionDone(a, run);
          return;
        }
        run.settled = false;
        if (++run.digs > run.queue.length + DIG_REPEATS) {
          run.current = p;
          this.actionFailed(a, s, run, 'cell refilled too often');
          return;
        }
        // Track W2: never start a dig from water with the head under it (the air runs down and the server breaks 5 x
        // slower again): tread water until it is out, else give up on the step
        const under = wet && headUnderWater(this.cellOf, s.pos);
        if (under) {
          run.headSince ??= a.t;
          if (a.t - run.headSince > DIG_HEAD_WAIT) this.actionFailed(a, s, run, 'head under water');
          return;
        }
        run.headSince = undefined;
        run.current = p;
        a.report.actions.dig++;
        const opts = wet ? { conditions: waterDigConditions(s, false) } : undefined; // Track W2: the server's in-water break time
        this.call(run, this.actions.dig && (() => this.actions.dig!(p, opts)));
        return;
      }
      case 'use':
      case 'close': {
        const p = run.queue[0];
        if (!p) {
          this.actionDone(a, run);
          return;
        }
        // use: wait until the door / gate lets the body pass; close: until it is in the way again
        const want = run.kind === 'use';
        const clear = this.passageOpen(p, run.axis); // Track BG: a trapdoor by its state
        if (run.waitClear) {
          if (clear === want) {
            run.waitClear = undefined;
            run.queue.shift();
          } else if (a.t - run.waitClear.since > DOOR_WAIT) {
            this.actionFailed(a, s, run, 'door state did not change');
          }
          return;
        }
        if (res) {
          run.result = undefined;
          run.waitClear = { p, want, since: a.t };
          return;
        }
        if (clear === want) {
          run.queue.shift();
          return;
        }
        if (want && this.grid.cls(p.x, p.y, p.z)?.openable === 'trapdoor') {
          if (a.opts.closeTrapdoors) {
            a.hatches.push(p); // Track BG: closed behind, also after a re-plan
            this.scheduleHatchClose(a, p, run.node);
          }
        } else if (want && a.opts.closeDoors) this.scheduleClose(a, p, run.axis, run.node);
        if (want) a.report.actions.use++;
        else a.report.actions.close++;
        this.call(run, this.actions.useBlock && (() => this.actions.useBlock!(p)));
        return;
      }
      case 'place': {
        const p = run.queue[0]!;
        if (!run.placed) {
          // the place action jumps and clicks the top of the block below once the feet are above the
          // cell (Track O's PlaceSkill: jump tick 4, feet +1.17), so it starts from standing
          if (!s.onGround) return;
          run.placed = true;
          a.report.actions.place++;
          const face = a.path[run.node]?.act?.place?.face ?? 'down';
          this.call(run, this.actions.place && (() => this.actions.place!(p, face)));
          return;
        }
        if (!res) return;
        if (s.onGround && s.pos.y >= p.y + 1 - 0.01) {
          this.actionDone(a, run);
          return;
        }
        if (s.onGround && s.pos.y < p.y + 0.5) {
          // landed back where we started: the block is not there
          this.actionFailed(a, s, run, 'landed without the block');
        }
        return;
      }
    }
  }

  /**
   * Track BG: the door / gate at `p` lets the body pass along `axis` (CROSS_CLEAR); a trapdoor (a hatch in a
   * floor or ceiling, passed vertically) by its state: open.
   */
  private passageOpen(p: Vec3, axis: 0 | 2): boolean {
    const c = this.grid.cls(p.x, p.y, p.z);
    if (c?.openable === 'trapdoor') return c.open;
    return this.grid.crossing(p.x, p.y, p.z, axis) === CROSS_CLEAR;
  }

  /**
   * Track BG: close the hatch at `p` (opened for node `node`) once the body is clear of its cell: the first
   * later node in another column, or whose body (feet + 1.8) is below it. Not when that node is a swim node (the
   * leg could not stop there) or out of reach (the eye more than HATCH_CLOSE_REACH from the hatch's centre).
   */
  private scheduleHatchClose(a: Active, p: Vec3, node: number): void {
    let j = node;
    for (; j < a.path.length; j++) {
      const n = a.path[j]!;
      if (n.x !== p.x || n.z !== p.z || n.feet + BODY_HEIGHT <= p.y + 1e-6) break;
    }
    const n = a.path[j];
    if (!n || n.move === 'swim' || n.move === 'swimOut') return;
    if (Math.hypot(n.x + 0.5 - (p.x + 0.5), n.feet + EYE - (p.y + 0.5), n.z + 0.5 - (p.z + 0.5)) > HATCH_CLOSE_REACH) return;
    a.doors.push({ p, axis: 0, closeAt: j });
  }

  /** Close the door at `p` once the body has left its cells (the first node after `node` outside them). */
  private scheduleClose(a: Active, p: Vec3, axis: 0 | 2, node: number): void {
    let j = node;
    while (j < a.path.length && a.path[j]!.x === p.x && a.path[j]!.z === p.z) j++;
    if (j >= a.path.length) return;
    a.doors.push({ p, axis, closeAt: j });
  }

  private stepRetreat(a: Active, s: InputLoopState): void {
    const r = a.retreat!;
    const target = a.lastSafe;
    const here = this.safeHere(s);
    if (!target || here || a.t > r.until) {
      a.retreat = undefined;
      this.loop.release();
      a.guard.idle();
      a.replan ??= 'retry';
      return;
    }
    const dx = target.x + 0.5 - s.pos.x;
    const dz = target.z + 0.5 - s.pos.z;
    const yaw = Math.hypot(dx, dz) > 0.05 ? yawTowards(dx, dz) : this.loop.command.yaw;
    const cmd = a.guard.apply({ forward: 1, strafe: 0, yaw, jump: s.inWater || s.inLava || s.collidedHorizontally, sprint: false, sneak: false });
    this.loop.setCommand(cmd);
  }
}

/** Track BE: a knock expected to land farther than this (blocks) from the leg re-plans at once, as main did. */
const KNOCK_ON_PATH = 1;
/** Track W1: a correction in water re-plans only when it leaves the body farther than this (blocks) from the leg. */
const WATER_ON_PATH = 1.5;

/** Track W1: the swimming and diving moves (their controllers steer from wherever the body is). */
function waterMove(m: PathNode['move'] | undefined): boolean {
  return m === 'swim' || m === 'dive' || m === 'swimOut';
}

/**
 * Track BE: where a knock (`set_entity_motion` velocity v) will roughly leave the body: the air
 * flight (horizontal x 0.91 per tick, vertical - 0.08 then x 0.98, until back at the start height,
 * at most 40 ticks), then the ground slide (x 0.546 per tick). Flat ground assumed: an estimate.
 */
function knockLanding(p: Vec3, v: Vec3): Vec3 {
  let x = p.x;
  let y = 0;
  let z = p.z;
  let vx = v.x;
  let vy = v.y;
  let vz = v.z;
  for (let i = 0; i < 40; i++) {
    x += vx;
    z += vz;
    y += vy;
    vx *= 0.91;
    vz *= 0.91;
    vy = (vy - 0.08) * 0.98;
    if (y <= 0) break;
  }
  const slide = 0.546 / (1 - 0.546);
  return { x: x + vx * slide, y: p.y, z: z + vz * slide };
}

/** Track W3: a `block` goal in a water cell is reached swimming at its surface or diving in it (a waypoint on a water floor). */
function waterGoalCell(grid: NavGrid, x: number, y: number, z: number): boolean {
  const w = grid.swim(x, y, z);
  if (w !== undefined && Number.isFinite(w)) return true;
  const d = grid.dive(x, y, z);
  return d !== undefined && Number.isFinite(d);
}

/** Track AB: ends the goto's search (a worker search is cancelled there). */
/** A goal read again at every plan (a runAway from a moving threat, also as an `any` member): no retry is the same search. */
function movingGoal(g: NavGoal): boolean {
  if (g.type === 'runAway') return typeof g.from === 'function';
  return g.type === 'any' && g.goals.some(movingGoal);
}

function dropSearch(a: Active): void {
  if (a.search?.s instanceof WorkerSearch) a.search.s.cancel();
  a.search = undefined;
}

const signatures = new WeakMap<TerrainClass, string>();

/** What the planner and the physics read from a block class (two blocks with the same one are interchangeable). */
function movementSignature(c: TerrainClass): string {
  let s = signatures.get(c);
  if (s === undefined) {
    s = JSON.stringify([c.boxes, c.floor, c.liquid, c.liquidHeight, c.danger, c.costFactor, c.friction, c.roof, c.openable, c.open, c.connect, c.fullCube, c.gravity, c.protect, c.climbable]);
    signatures.set(c, s);
  }
  return s;
}

function fmt(v: { x: number; y: number; z: number }): string {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}

/** The point a goal is about (block centres), for the progress timeout; undefined for goals without one. */
export function goalPoint(g: NavGoal): { x: number; y: number | undefined; z: number } | undefined {
  switch (g.type) {
    case 'block':
    case 'getToBlock':
    case 'twoBlocks': // Track BD
    case 'threeBlocks':
      return { x: g.p.x + 0.5, y: g.p.y, z: g.p.z + 0.5 };
    case 'near':
      return { x: g.p.x, y: g.p.y, z: g.p.z };
    case 'xz':
      return { x: g.x + 0.5, y: undefined, z: g.z + 0.5 };
    case 'any': {
      const pts = g.goals.map(goalPoint).filter((p): p is { x: number; y: number | undefined; z: number } => p !== undefined);
      return pts[0];
    }
    default:
      return undefined;
  }
}
