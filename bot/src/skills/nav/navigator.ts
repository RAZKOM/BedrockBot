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
import { chooseTool } from '../dig/tools.ts';
import type { InputLoop, InputLoopState } from '../input/inputLoop.ts';
import { classify, type TerrainClass } from '../terrain/classify.ts';
import type { TerrainSource } from '../terrain/query.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { DEFAULT_THROWAWAY, type NavActions } from './actions.ts';
import { PathSearch, findPath, handBreakTicks, locateNode, type LocatedNode, type PathNode, type PathOptions, type PathResult } from './astar.ts';
import { TICKS } from './costs.ts';
import { PathFollower, PressGuard, yawTowards } from './follower.ts';
import { goalTest, type NavGoal } from './goals.ts'; // Track R: NavGoal (task 7.10 goal types)
import { CROSS_CLEAR, NavGrid, cellKey } from './grid.ts';
import { NavBlacklist, actionKey, goalKey } from './blacklist.ts'; // Track R
import type { AvoidanceCostFn } from './avoidance.ts';
import { DEFAULT_PLANNER_BUDGETS, PlannerClient, WorkerSearch, plainGoal, type PlannerBudgets, type PlannerWorld, type WorkerPlanOptions } from './worker.ts'; // Track AB

/** Track R: goto options of the navigator. `blacklist`: consult and feed the failure blacklist (default: `any` and `getToBlock` goals). */
export type NavGotoOptions = GotoOptions & { blacklist?: boolean };

/** What the navigator needs from the world model. `World` + `worldSource()` provide it. */
export interface NavWorld {
  source: TerrainSource;
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
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
  /** Track R: the failure blacklist (default: a new one on this navigator's tick clock, 3 failures, 6000 ticks). */
  blacklist?: NavBlacklist;
  blacklistFailures?: number;
  blacklistTicks?: number;
  /** Track AB: search budgets in the planner worker (default 500 000 nodes / 2 s main, 60 000 / 300 ms segment). */
  workerBudgets?: Partial<PlannerBudgets>;
  /** Track AJ: the follower sneaks near deep edges (docs/pathfinding.md "Edge sneaking"). Default true. */
  edgeSneak?: boolean;
}

export type ReplanReason = 'start' | 'correction' | 'block' | 'partial' | 'stuck' | 'timeout' | 'action' | 'retry' | 'ahead' | 'upgrade';

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
  /** Track AB: worker answers spliced into the path being walked, and answers dropped as stale (blocks changed near them). */
  upgrades?: number;
  stale?: number;
}

interface Search {
  s: PathSearch | WorkerSearch;
  /** Track AB: 'upgrade' = a worker main plan whose interim answer is being walked. */
  kind: 'main' | 'ahead' | 'upgrade';
  via: 'worker' | 'thread';
  reason: ReplanReason;
  tick: number;
  slices: number;
}

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
  opts: Required<GotoOptions>;
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
  noBreak: Set<number>;
  /** Pillar / door cells (cellKey) whose action failed during this goto: not planned again. */
  noAction: Set<number>;
  /** Failed pillar places during this goto (2: no more pillaring in this goto). */
  placeFailures: number;
  /** Cells our own actions change: their block updates do not trigger re-plans. */
  ownCells: Set<number>;
  doors: DoorToClose[];
  /** Path index up to which the nodes' actions have run (their moves are plain walks now). */
  actedUpTo: number;
  unloadedTicks: number;
  bestProgress: number;
  lastProgressTick: number;
  lastPos: Vec3 | undefined;
  /** Why the last plan / failure went wrong (for the "unreachable without a segment" WARN line). */
  why: string | undefined;
  report: GotoReport;
  finish: (r: SkillResult) => void;
}

const DIG_TIMEOUT = 600;
const ACTION_TIMEOUT = 100;
const DOOR_WAIT = 40;

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
  private active: Active | undefined;
  private readonly unsubs: (() => void)[] = [];
  /** Report of the last goto (also while it runs). */
  lastReport: GotoReport | undefined;
  /** Track S: the `cellCost` option, settable after construction (the survival kit installs avoidance). */
  cellCost: NavigatorOptions['cellCost'];
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
  /** Track AB: block changes the planner reads (movement signature changed), numbered; worker answers older than a change near their path are dropped. */
  private worldGen = 0;
  private readonly changes: { gen: number; x: number; y: number; z: number }[] = [];

  constructor(loop: InputLoop, world: NavWorld, opts: NavigatorOptions = {}) {
    this.cellCost = opts.cellCost; // Track S
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
    this.unsubs.push(
      world.onBlockUpdate((p, before, after) => {
        this.onBlock(p, before, after);
      }),
      loop.onEvent((e) => {
        const a = this.active;
        if (!a) return;
        if (e.kind === 'correction') {
          a.report.corrections++;
          if (a.opts.replanOnCorrection) a.replan ??= 'correction';
        } else if (e.kind === 'motion') {
          a.report.motions++;
          a.replan ??= 'correction';
        } else if (e.kind === 'teleport') {
          a.replan = 'correction';
        }
      }),
      loop.onBeforeStep((_tick, state) => {
        this.clock++; // Track R
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
    return this.active !== undefined;
  }

  dispose(): void {
    this.cancel();
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
    const haveThrowaway = (): boolean => {
      const slots = inv?.()?.slots;
      if (!slots) return false;
      return slots.some((s) => s && s.count > 0 && throwaway.includes(s.name));
    };
    return {
      ...this.pathOpts,
      costs: { walk: sprint ? TICKS.sprint : TICKS.walk, ...this.pathOpts.costs },
      allowBreak: (options.allowBreak ?? false) && this.actions.dig !== undefined,
      allowPlace: (options.allowPlace ?? false) && this.actions.place !== undefined && haveThrowaway(),
      allowOpen: this.actions.useBlock !== undefined,
      breakTicks:
        this.pathOpts.breakTicks ??
        (inv
          ? (c) => {
              const v = inv();
              return v ? (chooseTool(c.name, v.slots, v.selected)?.ticks ?? Infinity) : handBreakTicks(c);
            }
          : handBreakTicks),
      ...(noBreak ? { noBreak } : {}),
      cellCost: this.cellCost?.() ?? this.pathOpts.cellCost, // Track S: avoidance, read live each plan
    };
  }

  /** Plan only (no movement, one search to the end): from the body's current node to the goal. */
  plan(goal: NavGoal, from?: Vec3, options?: GotoOptions): PathResult | undefined {
    const s = this.loop.state;
    const start = locateNode(this.grid, from ?? s.pos, from ? undefined : this.preferNode(s)); // Track AJ
    return start && findPath(this.grid, start, goal, this.planOptions(options));
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
    const opts: Required<GotoOptions> = {
      timeoutTicks: options.timeoutTicks ?? 6000,
      replanOnCorrection: options.replanOnCorrection ?? true,
      sprint: options.sprint ?? true,
      allowBreak: options.allowBreak ?? false,
      allowPlace: options.allowPlace ?? false,
      closeDoors: options.closeDoors ?? false,
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
        skipped,
        blacklisted: [],
      };
      this.lastReport = report;
      const noBreak = new Set<number>();
      const a: Active = {
        goal,
        planGoal,
        members,
        useBlacklist,
        lastMain: undefined,
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
        search: undefined,
        aheadBlocked: false,
        action: undefined,
        passedAbs: 0,
        passTick: 0,
        aimAbs: 0,
        lastSafe: undefined,
        retreat: undefined,
        noBreak,
        noAction: new Set(),
        placeFailures: 0,
        ownCells: new Set(),
        doors: [],
        actedUpTo: -1,
        unloadedTicks: 0,
        bestProgress: -Infinity,
        lastProgressTick: 0,
        lastPos: undefined,
        why: undefined,
        report,
        finish: (r) => {
          if (this.active !== a) return;
          this.active = undefined;
          dropSearch(a); // Track AB
          report.result = r;
          this.loop.release();
          if (!r.ok && r.reason === 'unreachable' && report.segments === 0) this.log.warn(this.noSegmentLine(a));
          this.settleBlacklist(a, r); // Track R
          this.log.info(
            `goto ${JSON.stringify(goal)}: ${r.ok ? 'ok' : r.reason} after ${report.ticks} ticks, ${report.distance.toFixed(1)} blocks, ` +
              `${report.plans.length} plan(s)${report.plans.some((p) => p.via === 'worker') ? ' (worker)' : ''}, ${report.segments} segment(s), ${report.corrections} correction(s), ${report.stuck} stuck, max tick ${report.maxTickMs} ms` +
              `${report.reached ? `, reached member ${report.reached.index}` : ''}${skipped.length ? `, skipped ${skipped.join(' ')}` : ''}${report.blacklisted?.length ? `, blacklisted ${report.blacklisted.join(' ')}` : ''}`,
          );
          resolve(r);
        },
      };
      this.active = a;
      if (nothingLeft) a.finish({ ok: false, reason: members && skipped.length === 0 ? 'unreachable' : 'blacklisted' }); // Track R
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
    if (a.ownCells.has(cellKey(p.x, p.y, p.z))) return;
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
    const start = locateNode(this.grid, p);
    const plans = a.report.plans.map((r) => `${r.reason}:${r.status}/${r.nodes}n/${r.expanded}e/${r.ms}ms`).join(' ');
    return (
      `goto unreachable without a segment: feet ${fmt(p)}${s.onGround ? '' : ' airborne'}, in ${block(y)}, on ${block(y - 1)}, ` +
      `start node ${start ? `${start.x},${start.y},${start.z} feet ${start.feet}` : 'none'}, goal ${JSON.stringify(a.planGoal)}, ` +
      `why ${a.why ?? '?'}, plans ${plans || 'none'}`
    );
  }

  private fail(a: Active, why: string): boolean {
    a.why = why;
    a.report.failures++;
    this.log.info(`goto: failure ${a.report.failures}/${this.maxFailures} (${why})`);
    if (a.report.failures >= this.maxFailures) {
      a.finish({ ok: false, reason: 'unreachable' });
      return true;
    }
    return false;
  }

  /** Standing on a standable node, on the ground, out of liquids. */
  private safeHere(s: InputLoopState): LocatedNode | undefined {
    if (!s.onGround || s.inWater || s.inLava) return undefined;
    return locateNode(this.grid, s.pos);
  }

  /** Track AJ: the node kind a plan starts from: a swim node in water, a climb node off the ground on a climber. */
  private preferNode(s: Pick<InputLoopState, 'pos' | 'onGround' | 'inWater'>): 'swim' | 'climb' | undefined {
    if (s.inWater) return 'swim';
    if (!s.onGround && this.grid.climbable(Math.floor(s.pos.x), Math.floor(s.pos.y + 1e-3), Math.floor(s.pos.z))) return 'climb';
    return undefined;
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
    const a = this.active;
    if (!a || !s.ready) return;
    a.t++;
    a.report.ticks = a.t;
    if (a.lastPos) a.report.distance += Math.hypot(s.pos.x - a.lastPos.x, s.pos.y - a.lastPos.y, s.pos.z - a.lastPos.z);
    a.lastPos = { ...s.pos };
    if (this.loop.command.sprint && s.onGround) a.report.sprintTicks++;
    if (this.loop.command.sneak && a.follower) a.report.sneakTicks = (a.report.sneakTicks ?? 0) + 1; // Track AJ
    if (a.t > a.opts.timeoutTicks) {
      a.finish({ ok: false, reason: 'timeout' });
      return;
    }
    if (s.onGround && !s.inWater && !s.inLava && !a.action) {
      const here = locateNode(this.grid, s.pos);
      if (here) a.lastSafe = here;
    }

    if (a.retreat) {
      this.stepRetreat(a, s);
      return;
    }

    // a re-plan replaces the current plan and any search
    if (a.replan && a.t >= a.waitUntil && !a.action) {
      // plan from solid ground (an airborne body has no node yet), but do not wait forever
      if (s.onGround || s.inWater || this.preferNode(s) === 'climb' || a.t - a.lastProgressTick > 20 || !a.follower) { // Track AJ: in water, on a ladder
        if (!this.startMain(a, s)) {
          a.guard.idle();
          return;
        }
      }
    }

    if (a.search && !this.stepSearch(a)) {
      a.guard.idle();
      return;
    }

    if (a.action) {
      this.stepAction(a, s);
      return;
    }

    const f = a.follower;
    if (!f) {
      this.loop.release();
      a.guard.idle();
      return;
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
      for (let i = passed + 1; i <= aim; i++) est += a.path[i]!.cost;
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
      search = a.search = { ...search, s: new PathSearch(this.grid, search.s.start, a.planGoal, this.segmentOptions(a, search.kind === 'main')), via: 'thread' };
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
      if (search.kind === 'main') {
        if (!this.onMainResult(a, res, search)) return false;
      } else if (search.kind === 'upgrade') {
        if (!this.onUpgradeResult(a, res, search)) return false;
      } else {
        this.onAheadResult(a, res, search);
      }
      return true;
    }
    if (search.kind !== 'main') return true;
    // a main plan in the worker: walk its interim answer (the best partial path after mainMs) while it goes on
    const early = search.s instanceof WorkerSearch ? search.s.takeInterim() : undefined;
    if (early && early.path.length > 1 && !this.stale(search, early)) {
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
  private newSearch(a: Active, start: { x: number; y: number; z: number }, kind: 'main' | 'ahead', reason: ReplanReason): Search {
    const client = this.plannerFor();
    const main = kind === 'main';
    if (client) {
      const goal = plainGoal(a.planGoal);
      const spec = goal && this.workerSpec(a, main);
      if (goal && spec) return { s: client.search(kind, start, goal, spec, this.worldGen, main ? this.mainMs : undefined), kind, via: 'worker', reason, tick: a.t, slices: 0 };
    }
    return { s: new PathSearch(this.grid, start, a.planGoal, this.segmentOptions(a, main)), kind, via: 'thread', reason, tick: a.t, slices: 0 };
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
    const inv = this.inventory?.();
    const prot = o.protectedBlocks;
    return {
      ...(o.costs ? { costs: { ...o.costs } } : {}),
      maxNodes: this.pathOpts.maxNodes ?? (main ? b.mainNodes : b.segmentNodes),
      maxMs: this.pathOpts.maxMs ?? (main ? b.mainMs : b.segmentMs),
      allowBreak: o.allowBreak ?? false,
      allowPlace: o.allowPlace ?? false,
      allowOpen: o.allowOpen ?? false,
      ...(o.moves ? { moves: { ...o.moves } } : {}), // Track AJ
      ...(prot ? { protectedBlocks: [...prot] } : {}),
      ...(o.noBreak?.size ? { noBreak: [...o.noBreak] } : {}),
      ...(o.noAction?.size ? { noAction: [...o.noAction] } : {}),
      ...(inv ? { inventory: { slots: inv.slots.map((s) => (s ? { name: s.name, count: s.count } : null)), selected: inv.selected } } : {}),
      ...(cc?.avoidance ? { avoidance: cc.avoidance } : {}),
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
      a.why = `no path (exhaustive search, ${res.expanded} nodes expanded)`;
      a.finish({ ok: false, reason: 'unreachable' });
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
      a.status = res.status;
      a.aheadBlocked = false;
      a.doors = a.doors.filter((d) => d.closeAt <= k);
      a.actedUpTo = Math.min(a.actedUpTo, k);
      a.report.upgrades = (a.report.upgrades ?? 0) + 1;
      if (!a.action) this.startLeg(a, a.follower ? a.legFrom + a.follower.passedIndex : a.passedAbs);
      return true;
    }
    this.log.debug(`goto: the worker's ${res.status} plan does not meet the rest of the interim path; ${res.status === 'found' ? 're-planning from here' : 'walking on'}`);
    if (res.status === 'found' && !a.action) a.replan ??= 'upgrade';
    return true;
  }

  /** Budgets of an in-thread segment search: a main plan (the body waits for it) gets `mainMs`, a plan-ahead `segmentMs`. */
  private segmentOptions(a: Active, main: boolean): PathOptions {
    return { ...a.pathOpts, maxNodes: this.pathOpts.maxNodes ?? this.segmentNodes, maxMs: this.pathOpts.maxMs ?? (main ? this.mainMs : this.segmentMs) };
  }

  /** Starts a main search from the body's node. Returns false when the goto finished or must wait. */
  private startMain(a: Active, s: InputLoopState): boolean {
    const reason = a.replan ?? 'retry';
    a.replan = undefined;
    dropSearch(a); // Track AB
    a.follower = undefined;
    const start = locateNode(this.grid, s.pos, this.preferNode(s)); // Track AJ: swimming / on a ladder
    if (!start) {
      this.loop.release();
      if (this.fail(a, `no standable node at ${fmt(s.pos)}`)) return false;
      a.replan = 'retry';
      a.waitUntil = a.t + 20;
      if (a.lastSafe && (s.inWater || s.inLava || !s.onGround)) {
        a.retreat = { until: a.t + 60 };
        a.report.retreats++;
      }
      return false;
    }
    if (a.goal.type === 'block') {
      // a block goal nobody can stand in (water, a wall, mid-air) is unreachable, whatever the search says
      const g = a.goal.p;
      const gx = Math.floor(g.x);
      const gy = Math.floor(g.y);
      const gz = Math.floor(g.z);
      if (Number.isNaN(this.grid.stand(gx, gy, gz)) && Number.isNaN(this.grid.standThrough(gx, gy, gz))) {
        // feet on a stairs block's low half (y + 0.5) floor to the stairs cell: the node is the one above
        const c = this.grid.cls(gx, gy, gz);
        if (c?.floor && c.top === 1 && !c.fullCube && this.grid.stand(gx, gy + 1, gz) === gy + 1) {
          a.planGoal = { type: 'block', p: { x: gx, y: gy + 1, z: gz } };
        } else if (!(a.pathOpts.allowBreak || a.pathOpts.allowPlace)) {
          a.why = `goal cell ${gx},${gy},${gz} (${c?.name ?? 'unloaded'}) is not standable`;
          a.finish({ ok: false, reason: 'unreachable' });
          return false;
        }
      }
    }
    for (const k of this.blacklist.cells('dig')) a.noBreak.add(k); // Track R: blacklisted action cells
    a.pathOpts = this.planOptions(a.opts, a.noBreak);
    // two failed pillar places in one goto: something systematic (reach, the server refusing); plan without pillaring
    if (a.placeFailures >= 2) a.pathOpts.allowPlace = false;
    const noAction = new Set([...this.blacklist.cells('place'), ...this.blacklist.cells('use'), ...a.noAction]);
    if (noAction.size) a.pathOpts.noAction = noAction;
    a.search = this.newSearch(a, start, 'main', reason); // Track AB: in the worker when it is ready
    this.loop.release();
    return true;
  }

  private record(a: Active, res: PathResult, search: Search, flags: { interim?: boolean; upgrade?: boolean } = {}): void {
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
      ...flags,
    });
    const tag = flags.interim ? ' interim' : flags.upgrade ? ' final' : '';
    this.log.debug(`goto: plan (${search.reason}${tag}, ${search.via}) ${res.status}, ${res.path.length} nodes, ${res.expanded} expanded, ${res.ms.toFixed(1)} ms over ${search.slices} tick(s)`);
  }

  /** Returns false when the goto finished or must wait. */
  private onMainResult(a: Active, res: PathResult, search: Search, flags: { interim?: boolean } = {}): boolean {
    this.record(a, res, search, flags);
    a.lastMain = res.status; // Track R
    if (res.status === 'none') {
      a.why = res.path.length ? `no path (exhaustive search, ${res.expanded} nodes expanded)` : 'the start node is not standable';
      a.finish({ ok: false, reason: 'unreachable' });
      return false;
    }
    if (res.path.length === 1 && res.status !== 'found') {
      this.loop.release();
      if (res.unknown && !res.limited && a.unloadedTicks < this.unloadedWaitTicks) {
        // the segment ends at unloaded world: wait for the chunks
        a.unloadedTicks += 10;
        a.report.unloadedWait += 10;
        a.replan = 'retry';
        a.waitUntil = a.t + 10;
        return false;
      }
      // the closest reachable node is where we stand: nothing to do but wait for the world to change
      const lim = `${res.limited ? ', search limit hit' : ''}${res.unknown ? ', touched unloaded world' : ''}`;
      if (this.fail(a, `no progress possible (no node closer to the goal than the start; ${res.expanded} expanded${lim})`)) return false;
      a.replan = 'retry';
      a.waitUntil = a.t + 20;
      return false;
    }
    if (res.path.length > 1) a.unloadedTicks = 0;
    a.path = res.path;
    a.status = res.status;
    a.aheadBlocked = false;
    a.doors = [];
    a.actedUpTo = -1;
    a.report.segments++;
    this.startLeg(a, 0);
    return true;
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
    const oldLast = a.path.length - 1;
    a.path = a.path.concat(res.path.slice(1));
    a.status = res.status;
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
    for (let i = from + 1; i <= last; i++) {
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
    a.follower = new PathFollower(a.path.slice(from, to + 1), this.grid, { sprint: a.opts.sprint, stopAtEnd, maxTurnDeg: this.maxTurn, guard: a.guard, cellCost: a.pathOpts.cellCost, edgeSneak: this.edgeSneak }); // Track S: cellCost, Track AJ: edgeSneak
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
      a.finish({ ok: true });
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
    };
    for (const p of run.queue) {
      a.ownCells.add(cellKey(p.x, p.y, p.z));
      if (run.kind === 'use' || run.kind === 'close') a.ownCells.add(cellKey(p.x, p.y + 1, p.z));
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

  private actionFailed(a: Active, s: InputLoopState, run: ActionRun, why: string): void {
    a.report.actions.failed++;
    this.log.info(`goto: ${run.kind} failed (${why})`);
    const cellP = run.queue[0]; // Track R: count the failure against the action cell
    if (cellP && run.kind !== 'close' && this.blacklist.fail(actionKey(run.kind, cellP), why)) a.report.blacklisted?.push(actionKey(run.kind, cellP));
    // a pillar / door cell that failed is not planned again during this goto (like a failed dig cell):
    // the re-plan looks for another way instead of spending the whole failure budget on one cell
    if (cellP && (run.kind === 'place' || run.kind === 'use')) a.noAction.add(cellKey(cellP.x, cellP.y, cellP.z));
    if (run.kind === 'place') a.placeFailures++;
    a.action = undefined;
    this.loop.setCommand({ jump: false, pitch: 0 });
    a.lastProgressTick = a.t;
    this.failAndReplan(a, s, 'action', `${run.kind} failed: ${why}`);
  }

  private actionDone(a: Active, run: ActionRun): void {
    a.action = undefined;
    this.loop.setCommand({ jump: false, pitch: 0 });
    if (run.kind !== 'close') a.actedUpTo = Math.max(a.actedUpTo, run.node);
    // the leg that contains the move into the action's node (pillar: the leg from the new node)
    this.startLeg(a, run.kind === 'place' || run.kind === 'close' ? run.node : run.node - 1);
  }

  private stepAction(a: Active, s: InputLoopState): void {
    const run = a.action!;
    a.guard.idle();
    // a running place action (Track O's PlaceSkill) drives the jump itself
    if (!(run.kind === 'place' && run.pending)) this.loop.setCommand({ forward: 0, strafe: 0, sprint: false, sneak: false, jump: false });
    if (a.t - run.started > run.timeout) {
      this.actionFailed(a, s, run, 'timeout');
      return;
    }
    if (run.pending) return;
    const res = run.result;
    if (res && !res.ok) {
      if (run.kind === 'dig') {
        const p = run.queue[0];
        if (p) a.noBreak.add(cellKey(p.x, p.y, p.z));
      }
      this.actionFailed(a, s, run, String(res.reason));
      return;
    }
    switch (run.kind) {
      case 'dig': {
        if (res) run.queue.shift();
        run.result = undefined;
        while (run.queue.length && this.grid.free(run.queue[0]!.x, run.queue[0]!.y, run.queue[0]!.z) === true) run.queue.shift();
        const p = run.queue[0];
        if (!p) {
          this.actionDone(a, run);
          return;
        }
        a.report.actions.dig++;
        this.call(run, this.actions.dig && (() => this.actions.dig!(p)));
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
        const clear = this.grid.crossing(p.x, p.y, p.z, run.axis) === CROSS_CLEAR;
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
        if (want && a.opts.closeDoors) this.scheduleClose(a, p, run.axis, run.node);
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

/** Track AB: ends the goto's search (a worker search is cancelled there). */
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
