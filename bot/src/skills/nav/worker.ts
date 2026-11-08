// Track AB (docs/pathfinding.md "Compute", decisions/0023): A* in a `worker_threads` Worker.
//
//   main thread   PlannerClient: forwards the world model to the worker as it changes (chunk store
//                 events: columns that finish loading, re-sent sections, unloads, single block
//                 changes; cached column summaries along a plan's corridor; the BlockInfo of every
//                 state id once), batched per event-loop turn (setImmediate); answers the navigator's
//                 searches with `WorkerSearch` handles (step() like PathSearch.step, plus an interim
//                 answer for main plans).
//   worker        this same file, started with `workerData.bedrockbotPlanner`: a MirrorWorld
//                 (worker-grid.ts) under a NavGrid, one PathSearch at a time in 25 ms slices (messages
//                 are applied between slices), the best partial path posted once `interimMs` of search
//                 has passed, the result at the end.
//
// The navigator falls back to the in-thread planner while the worker is not ready (start-up, the
// initial snapshot of the loaded columns, a restart after a crash) and for options the worker cannot
// rebuild (a custom breakTicks or cellCost function).
import { isMainThread, parentPort, Worker, workerData, type MessagePort } from 'node:worker_threads';
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import { breakTicksWith } from './baritone/helper.ts'; // Track BB: the shared break-time lookup
import { PathSearch, handBreakTicks, type PathOptions, type PathResult } from './astar.ts';
import { costFunction, type AvoidanceCosts, type AvoidanceSource } from './avoidance.ts';
import { threatsOf, type NavGoal } from './goals.ts';
import { NavGrid } from './grid.ts';
import { classify } from '../terrain/classify.ts';
import { MirrorWorld, sectionBytes, sectionData, type CacheColumnData, type ColumnData, type MirrorOp, type SectionData } from './worker-grid.ts';

/** Search budgets in the worker (`path.maxNodes` / `path.maxMs` override both kinds, as in-thread). */
export interface PlannerBudgets {
  /** Main plan (from the body's node). Default 500 000 nodes, 2000 ms. */
  mainNodes: number;
  mainMs: number;
  /** Plan-ahead segment. Default 60 000 nodes, 300 ms. */
  segmentNodes: number;
  segmentMs: number;
}

export const DEFAULT_PLANNER_BUDGETS: Readonly<PlannerBudgets> = Object.freeze({ mainNodes: 500_000, mainMs: 2000, segmentNodes: 60_000, segmentMs: 300 });

/** Planner options that cross the thread boundary (no functions: break times and avoidance are rebuilt in the worker). */
export interface WorkerPlanOptions {
  costs?: PathOptions['costs'];
  maxNodes: number;
  maxMs: number;
  allowBreak: boolean;
  allowPlace: boolean;
  allowOpen: boolean;
  /** Track AJ: movement-variety moves (PathOptions.moves). */
  moves?: PathOptions['moves'];
  /** Track BC: Baritone's way with a gravity block over a dug cell (PathOptions.allowGravityAbove). */
  allowGravityAbove?: boolean;
  /** Track BC: throwaway blocks in the hotbar (PathOptions.throwaway: the dig-down move's depth budget). */
  throwaway?: number;
  protectedBlocks?: string[];
  protectedArea?: { x: number; y: number; z: number; r: number };
  noBreak?: number[];
  noAction?: number[];
  /** Break times with the best hotbar tool (chooseTool), else the empty hand. */
  inventory?: { slots: ({ name: string; count: number } | null)[]; selected: number };
  /** Mob / spawner avoidance snapshot (nav/avoidance.ts costFunction). */
  avoidance?: { sources: AvoidanceSource[]; costs: AvoidanceCosts };
  /** Track BI: long falls (PathOptions.falls, a plain object). */
  falls?: PathOptions['falls'];
  /** PathOptions.farmlandDropCost (the farmer's trampling rule). */
  farmlandDropCost?: number;
  /** Track W1: the air supply at the plan's start (PathOptions.air). */
  air?: number;
  /** Track W2: dig out of water (PathOptions.digOut) and the start's dig-out stair step (PathOptions.startCut). */
  digOut?: boolean;
  startCut?: number;
  /** Track W3: the dig way budget (PathOptions.digWay). */
  digWay?: { left: number };
}

/** What the client reads from the world model (`World` satisfies it). */
export interface PlannerWorld {
  chunks: {
    readonly dimension: number;
    readonly minY: number;
    readonly maxY: number;
    onColumnLoaded(fn: (cx: number, cz: number) => void): () => void;
    onColumnUnloaded(fn: (cx: number, cz: number) => void): () => void;
    onSection(fn: (col: PlannerColumn, rel: number) => void): () => void;
    onBlockSet(fn: (col: PlannerColumn, rel: number, i: number, before: number, after: number) => void): () => void;
    allColumns(): Iterable<PlannerColumn>;
    column(cx: number, cz: number): PlannerColumn | undefined;
  };
  registry: {
    readonly ready: boolean;
    readonly airStateId: number;
    runtimeIdOf(stateId: number): number;
    blockInfo(stateId: number, runtimeId?: number): BlockInfo;
    stateIdOf(name: string, states?: Record<string, unknown>): number | undefined;
    onReady(fn: () => void): void;
  };
  /** The persistent world cache (World.cache); summaries are read through `cachedSummary` when it has one (WorldCache). */
  readonly cache?: unknown;
}

/** The parts of a chunk store column the client copies (world/chunks.ts Column). */
export interface PlannerColumn {
  readonly cx: number;
  readonly cz: number;
  readonly minCY: number;
  readonly count: number;
  readonly loaded: boolean;
  readonly sections: readonly ({ layers: readonly { palette: Int32Array; runtimeIds: Int32Array; size: number; index: Uint8Array | Uint16Array | null; runtimeIdAt(i: number): number }[] } | null | undefined)[];
}

interface CacheReader {
  cachedSummary(cx: number, cz: number): CacheColumnData | undefined;
  blockAt(x: number, y: number, z: number): unknown;
  columnTop(x: number, z: number): unknown;
}

/** The Worker as the client uses it (tests inject a fake). */
export interface PlannerWorker {
  postMessage(m: unknown): void;
  on(event: 'message' | 'error' | 'exit', fn: (v: unknown) => void): unknown;
  terminate(): unknown;
  unref?(): void;
}

export interface PlannerStats {
  /** Worker starts (1 + restarts) and crashes. */
  starts: number;
  crashes: number;
  /** Ops and messages posted, bytes of section / cache arrays copied. */
  ops: number;
  messages: number;
  bytes: number;
  columns: number;
  sections: number;
  blocks: number;
  infos: number;
  cacheColumns: number;
  /** Main-thread time building and posting ops (ms): total and the longest single flush. */
  forwardMs: number;
  maxForwardMs: number;
  /** Ms from start() to the worker's ready + the initial snapshot. */
  readyMs: number | undefined;
  plans: number;
  interims: number;
  results: number;
  failed: number;
}

type ToWorker = { t: 'ops'; ops: MirrorOp[] } | { t: 'plan'; id: number; start: Vec3; goal: NavGoal; opts: WorkerPlanOptions; interimMs?: number } | { t: 'cancel'; id: number };
type FromWorker = { t: 'ready' } | { t: 'interim' | 'result'; id: number; result: PathResult } | { t: 'error'; id: number; message: string };

const key = (cx: number, cz: number): number => (cx + 2097152) * 4194304 + (cz + 2097152);
const SNAPSHOT_SLICE_MS = 5;
/** Ticks a request waits for its corridor's cached columns before it is sent anyway. */
const CORRIDOR_WAIT_TICKS = 10;
const CACHE_SLICE_MS = 6;
const MAX_CORRIDOR = 900;

/**
 * A goal without functions (a runAway from a moving threat becomes the threat's position now, as the
 * in-thread search reads it once per plan). undefined when it cannot cross the thread boundary.
 */
export function plainGoal(goal: NavGoal): NavGoal | undefined {
  switch (goal.type) {
    case 'any': {
      const goals: NavGoal[] = [];
      for (const g of goal.goals) {
        const p = plainGoal(g);
        if (!p) return undefined;
        goals.push(p);
      }
      return { type: 'any', goals };
    }
    case 'runAway':
      return typeof goal.from === 'function' ? { type: 'runAway', from: threatsOf(goal), r: goal.r } : goal;
    default:
      return goal;
  }
}

/** Points a goal leads to (for the cached-column corridor); empty for goals without a place (yLevel, surface, runAway). */
function goalPoints(goal: NavGoal, out: { x: number; z: number }[] = []): { x: number; z: number }[] {
  switch (goal.type) {
    case 'block':
    case 'near':
    case 'getToBlock':
    case 'twoBlocks': // Track BD
    case 'threeBlocks':
      out.push({ x: goal.p.x, z: goal.p.z });
      break;
    case 'xz':
      out.push({ x: goal.x, z: goal.z });
      break;
    case 'any':
      for (const g of goal.goals) if (out.length < 64) goalPoints(g, out);
      break;
    default:
      break;
  }
  return out;
}

/** Chunk columns within 1 chunk of the lines from `start` to each goal point (radius 4 around the start without points). */
export function corridor(start: { x: number; z: number }, goal: NavGoal): number[][] {
  const pts = goalPoints(goal);
  const seen = new Set<number>();
  const out: number[][] = [];
  const add = (cx: number, cz: number) => {
    const k = key(cx, cz);
    if (seen.has(k) || out.length >= MAX_CORRIDOR) return;
    seen.add(k);
    out.push([cx, cz]);
  };
  const sx = Math.floor(start.x) >> 4;
  const sz = Math.floor(start.z) >> 4;
  if (!pts.length) {
    for (let r = 0; r <= 4; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) add(sx + dx, sz + dz);
    return out;
  }
  for (const p of pts) {
    const gx = Math.floor(p.x) >> 4;
    const gz = Math.floor(p.z) >> 4;
    const n = Math.max(Math.abs(gx - sx), Math.abs(gz - sz), 1);
    for (let i = 0; i <= n; i++) {
      const cx = Math.round(sx + ((gx - sx) * i) / n);
      const cz = Math.round(sz + ((gz - sz) * i) / n);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) add(cx + dx, cz + dz);
    }
  }
  return out;
}

/** A search running in the worker; the navigator drives it like a PathSearch (`step` every tick). */
export class WorkerSearch {
  readonly id: number;
  readonly kind: 'main' | 'ahead';
  /** The navigator's world generation when the search was asked for (stale answers are dropped). */
  readonly generation: number;
  readonly start: Vec3;
  readonly goal: NavGoal;
  readonly opts: WorkerPlanOptions;
  readonly interimMs: number | undefined;
  /** Cached columns to send before the request (corridor), front first. */
  readonly corridor: number[][];
  state: 'waiting' | 'sent' | 'done' | 'failed' | 'cancelled' = 'waiting';
  result: PathResult | undefined;
  private interim: PathResult | undefined;
  /** Ticks stepped while waiting for the corridor. */
  waited = 0;
  sentAt = 0;
  readonly createdAt = performance.now();
  private readonly client: PlannerClient;

  constructor(client: PlannerClient, id: number, kind: 'main' | 'ahead', start: Vec3, goal: NavGoal, opts: WorkerPlanOptions, generation: number, interimMs: number | undefined) {
    this.client = client;
    this.id = id;
    this.kind = kind;
    this.start = start;
    this.goal = goal;
    this.opts = opts;
    this.generation = generation;
    this.interimMs = interimMs;
    this.corridor = corridor(start, goal);
  }

  /** The worker crashed or did not answer: the navigator plans in-thread instead. */
  get failed(): boolean {
    return this.state === 'failed';
  }

  /** The result once the worker sent it (the slice argument is ignored: the worker searches on its own clock). */
  step(_sliceMs?: number): PathResult | undefined {
    if (this.state === 'waiting' || this.state === 'sent') this.client.service(this);
    return this.result;
  }

  /** The interim answer of a main plan (once). */
  takeInterim(): PathResult | undefined {
    const r = this.interim;
    this.interim = undefined;
    return r;
  }

  cancel(): void {
    if (this.state === 'done' || this.state === 'failed' || this.state === 'cancelled') return;
    const sent = this.state === 'sent';
    this.state = 'cancelled';
    this.client.cancel(this, sent);
  }

  /** Client side: an answer arrived. */
  receive(kind: 'interim' | 'result', r: PathResult): void {
    if (this.state !== 'sent') return;
    if (kind === 'interim') this.interim = r;
    else {
      this.result = r;
      this.state = 'done';
    }
  }

  fail(): void {
    if (this.state === 'waiting' || this.state === 'sent') this.state = 'failed';
  }
}

/**
 * The main-thread side of the planner worker (see the file comment). `start()` spawns the worker and
 * forwards the loaded columns; `ready` turns true once the worker runs and has them.
 */
export class PlannerClient {
  readonly stats: PlannerStats = {
    starts: 0,
    crashes: 0,
    ops: 0,
    messages: 0,
    bytes: 0,
    columns: 0,
    sections: 0,
    blocks: 0,
    infos: 0,
    cacheColumns: 0,
    forwardMs: 0,
    maxForwardMs: 0,
    readyMs: undefined,
    plans: 0,
    interims: 0,
    results: 0,
    failed: 0,
  };
  private readonly world: PlannerWorld;
  private readonly log: Logger;
  private worker: PlannerWorker | undefined;
  private readonly spawnWorker: () => PlannerWorker;
  private workerUp = false;
  private startedAt = 0;
  private ops: MirrorOp[] = [];
  private flushScheduled = false;
  /** Columns of the initial snapshot still to send. */
  private pending = new Set<number>();
  private snapshotTimer: NodeJS.Timeout | undefined;
  private sentInfos = new Set<number>();
  private cacheSent = new Set<number>();
  private cacheMissing = new Set<number>();
  private searches = new Map<number, WorkerSearch>();
  private nextId = 1;
  private dimension: number | undefined;
  private unsubs: (() => void)[] = [];
  private running = false;
  private disposed = false;
  private restartTimer: NodeJS.Timeout | undefined;
  /** Restarts after crashes (stops after 5). */
  private restarts = 0;

  constructor(world: PlannerWorld, opts: { logger?: Logger; spawn?: () => PlannerWorker } = {}) {
    this.world = world;
    this.log = opts.logger ?? silentLogger;
    this.spawnWorker = opts.spawn ?? (() => new Worker(new URL(import.meta.url), { workerData: { bedrockbotPlanner: true }, name: 'planner' }));
  }

  /** The worker runs and has the initial snapshot. */
  get ready(): boolean {
    return this.running && this.workerUp && this.pending.size === 0 && this.dimension !== undefined;
  }

  get started(): boolean {
    return this.running;
  }

  /** Spawn the worker and start forwarding (no-op when running). */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.subscribe();
    this.spawn();
  }

  /** Stop the worker and the forwarding (plannerThreads 0). Searches in flight fail (the navigator plans in-thread). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const u of this.unsubs.splice(0)) u();
    this.kill();
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  /** A search in the worker (sent once the corridor's cached columns are in the mirror). */
  search(kind: 'main' | 'ahead', start: Vec3, goal: NavGoal, opts: WorkerPlanOptions, generation: number, interimMs?: number): WorkerSearch {
    const s = new WorkerSearch(this, this.nextId++, kind, { x: start.x, y: start.y, z: start.z }, goal, opts, generation, interimMs);
    this.searches.set(s.id, s);
    return s;
  }

  /** Called by WorkerSearch.step every tick: sends the request when the corridor is in; times out a silent worker. */
  service(s: WorkerSearch): void {
    if (!this.worker || !this.workerUp) {
      s.fail();
      this.searches.delete(s.id);
      return;
    }
    if (s.state === 'waiting') {
      const done = this.pumpCache(s.corridor);
      s.waited++;
      if (!done && s.waited < CORRIDOR_WAIT_TICKS) return;
      this.flush();
      this.post({ t: 'plan', id: s.id, start: s.start, goal: s.goal, opts: s.opts, ...(s.interimMs !== undefined ? { interimMs: s.interimMs } : {}) });
      s.state = 'sent';
      s.sentAt = performance.now();
      this.stats.plans++;
      return;
    }
    // no answer far beyond the budget: the worker is stuck (or swamped); plan in-thread
    const limit = (s.interimMs ?? s.opts.maxMs) + 2000;
    if (s.state === 'sent' && !s.result && performance.now() - s.sentAt > Math.max(limit, s.opts.maxMs + 2000)) {
      this.log.warn(`planner worker: no answer to search ${s.id} after ${Math.round(performance.now() - s.sentAt)} ms; planning in-thread`);
      s.fail();
      this.stats.failed++;
      this.searches.delete(s.id);
      this.post({ t: 'cancel', id: s.id });
    }
  }

  cancel(s: WorkerSearch, sent: boolean): void {
    this.searches.delete(s.id);
    if (sent) this.post({ t: 'cancel', id: s.id });
  }

  /**
   * The main thread's cache records which cells the planner read from cached columns (a column that
   * loads later announces the ones that differ as block updates, and a goto re-plans): the worker read
   * them from its copy, so the cells around a path from the worker are read here once.
   */
  touchCached(path: readonly { x: number; y: number; z: number }[]): void {
    const cache = this.cacheReader();
    if (!cache) return;
    const ch = this.world.chunks;
    for (const n of path) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const x = n.x + dx;
          const z = n.z + dz;
          if (ch.column(x >> 4, z >> 4)?.loaded) continue;
          cache.columnTop(x, z);
          for (let dy = -1; dy <= 2; dy++) cache.blockAt(x, n.y + dy, z);
        }
      }
    }
  }

  // ---- worker lifecycle ---------------------------------------------------------------------------

  private spawn(): void {
    this.stats.starts++;
    this.startedAt = performance.now();
    this.workerUp = false;
    this.ops = [];
    this.sentInfos = new Set();
    this.cacheSent = new Set();
    this.cacheMissing = new Set();
    this.dimension = undefined;
    const w = this.spawnWorker();
    w.unref?.();
    this.worker = w;
    w.on('message', (m: unknown) => {
      if (this.worker === w) this.onMessage(m as FromWorker);
    });
    w.on('error', (e: unknown) => {
      if (this.worker === w) this.crashed(e instanceof Error ? e.message : String(e));
    });
    w.on('exit', (code: unknown) => {
      if (this.worker === w) this.crashed(`exit code ${String(code)}`);
    });
    this.world.registry.onReady(() => {
      if (this.worker !== w) return;
      this.checkWorld();
      for (const col of this.world.chunks.allColumns()) if (col.loaded) this.pending.add(key(col.cx, col.cz));
      this.scheduleSnapshot();
    });
  }

  private kill(): void {
    const w = this.worker;
    this.worker = undefined;
    this.workerUp = false;
    this.pending.clear();
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    for (const s of this.searches.values()) s.fail();
    this.searches.clear();
    if (w) void w.terminate();
  }

  private crashed(why: string): void {
    this.stats.crashes++;
    if (this.stats.crashes === 1) this.log.warn(`planner worker crashed (${why}); restarting it, planning in-thread meanwhile`);
    else this.log.debug(`planner worker crashed again (${why})`);
    this.kill();
    if (!this.running || this.disposed) return;
    if (++this.restarts > 5) {
      this.log.warn('planner worker crashed 6 times; planning in-thread from now on');
      this.stop();
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.running && !this.worker) this.spawn();
    }, 1000);
    this.restartTimer.unref();
  }

  private onMessage(m: FromWorker): void {
    if (m.t === 'ready') {
      this.workerUp = true;
      this.markReady();
      return;
    }
    const s = this.searches.get(m.id);
    if (!s) return;
    if (m.t === 'error') {
      this.log.warn(`planner worker: search ${m.id} failed: ${m.message}`);
      this.stats.failed++;
      s.fail();
      this.searches.delete(m.id);
      return;
    }
    if (m.t === 'interim') this.stats.interims++;
    else {
      this.stats.results++;
      this.searches.delete(m.id);
    }
    s.receive(m.t, m.result);
  }

  private markReady(): void {
    if (this.ready && this.stats.readyMs === undefined) this.stats.readyMs = +(performance.now() - this.startedAt).toFixed(1);
  }

  private post(m: ToWorker): void {
    this.stats.messages++;
    this.worker?.postMessage(m);
  }

  // ---- forwarding ---------------------------------------------------------------------------------

  private subscribe(): void {
    const ch = this.world.chunks;
    this.unsubs.push(
      ch.onColumnLoaded((cx, cz) => {
        if (!this.worker || this.dimension === undefined) return;
        const col = ch.column(cx, cz);
        if (!col?.loaded) return;
        this.checkWorld();
        this.pending.delete(key(cx, cz));
        this.cacheSent.delete(key(cx, cz));
        this.cacheMissing.delete(key(cx, cz));
        this.pushColumn(col);
      }),
      ch.onColumnUnloaded((cx, cz) => {
        const k = key(cx, cz);
        this.pending.delete(k);
        this.cacheSent.delete(k);
        this.cacheMissing.delete(k);
        if (!this.worker || this.dimension === undefined) return;
        this.push({ op: 'unload', cx, cz });
      }),
      ch.onSection((col, rel) => {
        if (!this.worker || this.dimension === undefined || !col.loaded || this.pending.has(key(col.cx, col.cz))) return;
        this.checkWorld();
        const sec = this.copySection(col.sections[rel]);
        this.stats.sections++;
        this.push({ op: 'section', cx: col.cx, cz: col.cz, rel, sec });
      }),
      ch.onBlockSet((col, rel, i, _before, after) => {
        if (!this.worker || this.dimension === undefined || !col.loaded || this.pending.has(key(col.cx, col.cz))) return;
        const runtimeId = col.sections[rel]?.layers[0]?.runtimeIdAt(i) ?? 0;
        this.infosFor([after]);
        this.stats.blocks++;
        this.push({ op: 'block', x: col.cx * 16 + (i >> 8), y: (col.minCY + rel) * 16 + (i & 15), z: col.cz * 16 + ((i >> 4) & 15), stateId: after, runtimeId });
      }),
    );
  }

  /** A 'world' op first, and again whenever the dimension changed (the worker drops everything). */
  private checkWorld(): void {
    const ch = this.world.chunks;
    const reg = this.world.registry;
    if (!reg.ready || this.dimension === ch.dimension) return;
    this.dimension = ch.dimension;
    this.cacheSent.clear();
    this.cacheMissing.clear();
    const air = reg.airStateId;
    this.push({ op: 'world', dimension: ch.dimension, minY: ch.minY, maxY: ch.maxY, air, airRid: reg.runtimeIdOf(air) });
    if (this.sentInfos.size === 0) {
      const by = (name: string, fallback: number) => reg.blockInfo(reg.stateIdOf(name) ?? fallback);
      // the cache stand-ins, as world/cache/classes.ts StateTable.synthetic()
      this.push({ op: 'infos', infos: [], synthetic: [reg.blockInfo(air), by('stone', -1), by('water', air), by('lava', -1), by('oak_leaves', -1)] });
    }
  }

  private copySection(sec: PlannerColumn['sections'][number]): SectionData | null {
    if (!sec) return null;
    const reg = this.world.registry;
    const l = sec.layers[0];
    const d = sectionData(l, reg.airStateId, l ? 0 : reg.runtimeIdOf(reg.airStateId));
    this.infosFor(d.palette);
    this.stats.bytes += sectionBytes(d);
    return d;
  }

  private infosFor(ids: Iterable<number>): void {
    let fresh: BlockInfo[] | undefined;
    for (const s of ids) {
      if (s < 0 || this.sentInfos.has(s)) continue;
      this.sentInfos.add(s);
      (fresh ??= []).push(this.world.registry.blockInfo(s));
    }
    if (fresh) {
      this.stats.infos += fresh.length;
      this.push({ op: 'infos', infos: fresh });
    }
  }

  private pushColumn(col: PlannerColumn): void {
    const t0 = performance.now();
    const sections: ColumnData['sections'] = col.sections.map((s) => (s === undefined ? undefined : this.copySection(s)));
    this.stats.columns++;
    this.push({ op: 'column', col: { cx: col.cx, cz: col.cz, minCY: col.minCY, count: col.count, sections } });
    this.addForward(performance.now() - t0);
  }

  private push(op: MirrorOp): void {
    this.ops.push(op);
    this.stats.ops++;
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => {
        this.flushScheduled = false;
        this.flush();
      });
    }
  }

  /** Posts the queued ops now (a request flushes first, so the worker plans on the latest blocks). */
  flush(): void {
    if (!this.ops.length || !this.worker) {
      this.ops = [];
      return;
    }
    const t0 = performance.now();
    const ops = this.ops;
    this.ops = [];
    this.post({ t: 'ops', ops });
    this.addForward(performance.now() - t0);
  }

  private addForward(ms: number): void {
    this.stats.forwardMs += ms;
    if (ms > this.stats.maxForwardMs) this.stats.maxForwardMs = +ms.toFixed(2);
  }

  /** The initial snapshot (all loaded columns), a few ms per turn so no tick waits for it. */
  private scheduleSnapshot(): void {
    if (this.snapshotTimer || !this.worker) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      const t0 = performance.now();
      const ch = this.world.chunks;
      for (const k of this.pending) {
        if (performance.now() - t0 > SNAPSHOT_SLICE_MS) break;
        this.pending.delete(k);
        const cx = Math.floor(k / 4194304) - 2097152;
        const cz = (k % 4194304) - 2097152;
        const col = ch.column(cx, cz);
        if (col?.loaded) this.pushColumn(col);
      }
      this.flush();
      if (this.pending.size) this.scheduleSnapshot();
      else this.markReady();
    }, 5);
    this.snapshotTimer.unref();
  }

  private cacheReader(): CacheReader | undefined {
    const c = this.world.cache as Partial<CacheReader> | undefined;
    return c && typeof c.cachedSummary === 'function' && typeof c.blockAt === 'function' && typeof c.columnTop === 'function' ? (c as CacheReader) : undefined;
  }

  /** Sends cached summaries of `cols` that are not loaded and not sent yet, for at most CACHE_SLICE_MS. True when all are in. */
  pumpCache(cols: readonly number[][]): boolean {
    const cache = this.cacheReader();
    if (!cache || this.dimension === undefined) return true;
    const ch = this.world.chunks;
    const t0 = performance.now();
    for (const [cx, cz] of cols) {
      const k = key(cx!, cz!);
      if (this.cacheSent.has(k) || this.cacheMissing.has(k)) continue;
      if (ch.column(cx!, cz!)?.loaded) continue;
      if (performance.now() - t0 > CACHE_SLICE_MS) return false;
      const s = cache.cachedSummary(cx!, cz!);
      if (!s) {
        this.cacheMissing.add(k);
        continue;
      }
      this.cacheSent.add(k);
      this.stats.cacheColumns++;
      this.stats.bytes += s.cells.byteLength + s.roof.byteLength;
      this.push({ op: 'cache', col: { cx: s.cx, cz: s.cz, y0: s.y0, rows: s.rows, cells: s.cells, roof: s.roof } });
    }
    this.addForward(performance.now() - t0);
    return true;
  }
}

// ---- the worker side ------------------------------------------------------------------------------

/** Search slice between message checks, ms. */
const WORKER_SLICE_MS = 25;

interface Running {
  id: number;
  search: PathSearch | undefined;
  interimMs: number | undefined;
  interimSent: boolean;
  cancelled: boolean;
}

function workerOptions(o: WorkerPlanOptions): PathOptions {
  const inv = o.inventory;
  return {
    ...(o.costs ? { costs: o.costs } : {}),
    maxNodes: o.maxNodes,
    maxMs: o.maxMs,
    allowBreak: o.allowBreak,
    allowPlace: o.allowPlace,
    allowOpen: o.allowOpen,
    ...(o.moves ? { moves: o.moves } : {}), // Track AJ
    ...(o.allowGravityAbove !== undefined ? { allowGravityAbove: o.allowGravityAbove } : {}), // Track BC
    ...(o.throwaway !== undefined ? { throwaway: o.throwaway } : {}), // Track BC
    ...(o.protectedBlocks ? { protectedBlocks: o.protectedBlocks } : {}),
    ...(o.protectedArea ? { protectedArea: o.protectedArea } : {}),
    ...(o.noBreak ? { noBreak: new Set(o.noBreak) } : {}),
    ...(o.noAction ? { noAction: new Set(o.noAction) } : {}),
    breakTicks: inv ? (c) => breakTicksWith(c, inv) : handBreakTicks, // Track BB
    ...(o.avoidance ? { cellCost: costFunction(o.avoidance.sources, o.avoidance.costs) } : {}),
    ...(o.falls ? { falls: o.falls } : {}), // Track BI
    ...(o.farmlandDropCost ? { farmlandDropCost: o.farmlandDropCost } : {}),
    ...(o.air !== undefined ? { air: o.air } : {}), // Track W1
    ...(o.digOut ? { digOut: true } : {}), // Track W2
    ...(o.startCut ? { startCut: o.startCut } : {}),
    ...(o.digWay ? { digWay: { left: o.digWay.left } } : {}), // Track W3
  };
}

/** The worker's message loop (exported for tests that run it on a MessageChannel in one thread). */
export function runPlannerWorker(port: Pick<MessagePort, 'on' | 'postMessage'>): void {
  const mirror = new MirrorWorld();
  const grid = new NavGrid(mirror.source);
  const queue: { id: number; start: Vec3; goal: NavGoal; opts: WorkerPlanOptions; interimMs?: number }[] = [];
  let cur: Running | undefined;
  let looping = false;

  const loop = (): void => {
    if (!cur) {
      const m = queue.shift();
      if (!m) {
        looping = false;
        return;
      }
      cur = { id: m.id, search: undefined, interimMs: m.interimMs, interimSent: false, cancelled: false };
      try {
        cur.search = new PathSearch(grid, m.start, m.goal, workerOptions(m.opts));
      } catch (e) {
        port.postMessage({ t: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) } satisfies FromWorker);
        cur = undefined;
      }
    }
    const run = cur;
    if (run?.search && !run.cancelled) {
      const s = run.search;
      const toInterim = run.interimMs !== undefined && !run.interimSent ? run.interimMs - s.elapsedMs : Infinity;
      try {
        const res = s.step(Math.max(1, Math.min(WORKER_SLICE_MS, toInterim)));
        if (res) {
          port.postMessage({ t: 'result', id: run.id, result: res } satisfies FromWorker);
          cur = undefined;
        } else if (run.interimMs !== undefined && !run.interimSent && s.elapsedMs >= run.interimMs) {
          run.interimSent = true;
          port.postMessage({ t: 'interim', id: run.id, result: s.peek() } satisfies FromWorker);
        }
      } catch (e) {
        port.postMessage({ t: 'error', id: run.id, message: e instanceof Error ? e.message : String(e) } satisfies FromWorker);
        cur = undefined;
      }
    } else {
      cur = undefined;
    }
    setImmediate(loop);
  };

  port.on('message', (m: ToWorker) => {
    switch (m.t) {
      case 'ops': {
        for (const op of m.ops) {
          mirror.apply(op);
          // classify new states now (the first one loads the shape tables), not during the first search
          if (op.op === 'infos') for (const info of op.infos) classify(info);
        }
        const ch = mirror.takeChanges();
        if (ch.structural) grid.clear();
        else for (const b of ch.blocks) grid.invalidate(b.x, b.y, b.z);
        return;
      }
      case 'plan':
        queue.push(m);
        if (!looping) {
          looping = true;
          setImmediate(loop);
        }
        return;
      case 'cancel': {
        if (cur?.id === m.id) cur.cancelled = true;
        const i = queue.findIndex((q) => q.id === m.id);
        if (i >= 0) queue.splice(i, 1);
        return;
      }
    }
  });
  port.postMessage({ t: 'ready' } satisfies FromWorker);
}

if (!isMainThread && parentPort && (workerData as { bedrockbotPlanner?: boolean } | null)?.bedrockbotPlanner) runPlannerWorker(parentPort);
