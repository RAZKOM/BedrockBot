// `!explore [radius]` (wave 9, Track AI; docs/explore.md): a frontier walk that fills the world cache.
//
//   loop      pick the next cell (frontier.ts pickCell: nearest cell inside the radius whose view
//             would load columns the cache does not know, next to visited ones first), find a dry
//             surface spot in it (standSpot; over water / lava: skipped), walk there (near goal, r 4),
//             look around (wait for the chunks around to load), mark it visited, count what the cache
//             learnt, repeat; no cell left: done
//   pause     (a pre-emption: guard, flee, night, a newer command, `!pause`) cancels the walk and
//             holds the loop; resume walks to the same cell again
//   stop      stop() cancels at once
//   summary   cells visited (skipped: water / lava, unreachable), new chunk columns cached, and in
//             them the marks the cache keeps: ores, forests (log clusters of 3+), containers; herds
//             recorded meanwhile (Track AF's herd marks); time
import { classify, logClusters } from '../../world/find.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { Vec3 } from '../../world/types.ts';
import type { Goal } from '../nav/goals.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { cellCentre, cellKey, cellOf, cellsWithin, countMarks, pickCell, standSpot, type ExploreCache, type FrontierState, type MarkCounts } from './frontier.ts';

export type ExploreState = 'idle' | 'pick' | 'walk' | 'look' | 'waiting' | 'paused' | 'done' | 'stopped' | 'failed';

export interface ExploreOptions {
  /** Centre of the area (home, else the bot's position at the start). */
  centre: Vec3;
  /** Blocks. */
  radius: number;
}

export interface ExploreDeps {
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  cancel(): void;
  position(): Vec3 | undefined;
  ready(): boolean;
  waitTicks(n: number): Promise<void>;
  /** The world cache (World.cache), read at call time. */
  cache(): ExploreCache | undefined;
  /** The view radius in chunks (the server's chunk publisher radius). */
  viewRadius(): number;
  /** Resolve once the columns within `radius` chunks of `centre` are loaded (World.waitForChunks). */
  waitChunks?(radius: number, centre: Vec3, timeoutMs: number): Promise<void>;
  log?: Logger;
  now?: () => number;
}

export interface ExploreStats {
  startedAt: number | undefined;
  finishedAt: number | undefined;
  cells: number;
  visited: number;
  /** Cells left out: over water / lava, unreachable, covered (nothing new to see from there). */
  water: number;
  lava: number;
  unreachable: number;
  covered: number;
  walks: number;
  /** Blocks walked (straight line between the cells). */
  distance: number;
  /** Chunk columns the cache learnt during the run (within the area and its view). */
  newColumns: number;
  ores: number;
  containers: number;
  logs: number;
  forests: number;
  /** Herd marks gained (Track AF). */
  herds: number;
  /** Cells in visiting order (cx, cz) and the ms from the start each was reached. */
  path: { cx: number; cz: number; ms: number; gain: number }[];
}

/** Ticks spent looking around in a cell at most (the chunks around load meanwhile). */
export const LOOK_TICKS = 20;
/** Consecutive failed walks that end the run. */
export const MAX_FAILED_WALKS = 10;

export class Explorer {
  state: ExploreState = 'idle';
  readonly stats: ExploreStats = newStats();
  opts: ExploreOptions | undefined;
  lastError: string | undefined;
  /** The cell being walked to. */
  target: { cx: number; cz: number; p: Vec3 | undefined; gain: number } | undefined;
  private readonly d: ExploreDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private gen = 0;
  private paused = false;
  private frontier: FrontierState = { visited: new Set(), skipped: new Set() };
  private cells: { cx: number; cz: number }[] = [];
  private knownAtStart = new Set<number>();
  private counted = new Set<number>();
  private marks: MarkCounts = { ores: 0, containers: 0, logs: [] };
  private herdsAtStart = 0;
  private failedWalks = 0;
  private readonly doneFns = new Set<(s: ExploreState) => void>();

  constructor(deps: ExploreDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => Date.now());
  }

  get running(): boolean {
    return ['pick', 'walk', 'look', 'waiting', 'paused'].includes(this.state);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Cancel the walk and hold the loop until resume(). */
  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.state = 'paused';
    this.d.cancel();
    this.log.info('explore: paused');
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.log.info('explore: resumed');
  }

  stop(): void {
    if (!this.running) return;
    this.gen++;
    this.paused = false;
    this.d.cancel();
    this.end(this.gen, 'stopped');
  }

  onDone(fn: (s: ExploreState) => void): () => void {
    this.doneFns.add(fn);
    return () => this.doneFns.delete(fn);
  }

  start(opts: ExploreOptions): Promise<ExploreState> {
    if (!Number.isFinite(opts.radius) || opts.radius < 1) throw new Error(`radius must be positive, got ${opts.radius}`);
    this.gen++;
    this.d.cancel();
    this.opts = { centre: { ...opts.centre }, radius: opts.radius };
    Object.assign(this.stats, newStats());
    this.stats.startedAt = this.now();
    this.lastError = undefined;
    this.paused = false;
    this.failedWalks = 0;
    this.target = undefined;
    this.frontier = { visited: new Set(), skipped: new Set() };
    this.cells = cellsWithin(opts.centre, opts.radius);
    this.stats.cells = this.cells.length;
    this.counted = new Set();
    this.marks = { ores: 0, containers: 0, logs: [] };
    const cache = this.d.cache();
    this.knownAtStart = new Set();
    this.forBox((cx, cz) => {
      if (cache?.known(cx, cz)) this.knownAtStart.add(cellKey(cx, cz));
    });
    this.herdsAtStart = cache?.herds?.size ?? 0;
    this.state = 'pick';
    this.log.info(`explore: r=${opts.radius} around ${fmt(opts.centre)}: ${this.cells.length} cells, view ${this.d.viewRadius()} chunks, ${this.knownAtStart.size} columns cached already`);
    const gen = this.gen;
    return this.run(gen).catch((e: unknown) => {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log.error(`explore: ${this.lastError}`);
      return this.end(gen, 'failed');
    });
  }

  /** Every column of the area plus its view (what the run can make the cache learn). */
  private forBox(fn: (cx: number, cz: number) => void): void {
    if (!this.opts) return;
    const r = Math.ceil(this.opts.radius / 16) + this.d.viewRadius() + 1;
    const c = cellOf(this.opts.centre);
    for (let cx = c.cx - r; cx <= c.cx + r; cx++) for (let cz = c.cz - r; cz <= c.cz + r; cz++) fn(cx, cz);
  }

  /** Count the columns the cache learnt since the last call and the marks in them. */
  tally(): void {
    const cache = this.d.cache();
    if (!cache) return;
    this.forBox((cx, cz) => {
      const k = cellKey(cx, cz);
      if (this.knownAtStart.has(k) || this.counted.has(k) || !cache.known(cx, cz)) return;
      this.counted.add(k);
      const s = cache.summary(cx, cz);
      if (s) countMarks(s.markList(), this.marks, (n) => classify(n) === 'log');
    });
    const st = this.stats;
    st.newColumns = this.counted.size;
    st.ores = this.marks.ores;
    st.containers = this.marks.containers;
    st.logs = this.marks.logs.length;
    st.herds = Math.max(0, (cache.herds?.size ?? 0) - this.herdsAtStart);
  }

  summary(): string {
    const s = this.stats;
    const ms = (s.finishedAt ?? this.now()) - (s.startedAt ?? this.now());
    const skipped = [s.water ? `${s.water} over water` : '', s.lava ? `${s.lava} over lava` : '', s.unreachable ? `${s.unreachable} unreachable` : ''].filter(Boolean).join(', ');
    return `explore r=${this.opts?.radius ?? '?'}: ${s.visited} cells visited${skipped ? ` (${skipped})` : ''}, ${s.newColumns} new chunks cached; remembered there: ${s.ores} ores, ${s.forests} forests, ${s.herds} herds, ${s.containers} containers; ${fmtTime(ms)}`;
  }

  status(): Record<string, unknown> {
    return { state: this.state, radius: this.opts?.radius ?? null, centre: this.opts?.centre ?? null, target: this.target ?? null, lastError: this.lastError ?? null, ...this.stats, path: this.stats.path.length };
  }

  private alive(gen: number): boolean {
    return gen === this.gen && !this.paused;
  }

  private end(gen: number, state: ExploreState): ExploreState {
    if (gen !== this.gen && state !== 'stopped') return this.state;
    this.tally();
    this.stats.forests = logClusters(this.marks.logs, this.opts?.centre ?? { x: 0, y: 0, z: 0 }).filter((c) => c.logs.length >= 3).length;
    this.state = state;
    this.stats.finishedAt = this.now();
    this.log.info(`${this.summary()} (${state}${this.lastError ? `: ${this.lastError}` : ''})`);
    for (const fn of [...this.doneFns]) fn(state);
    return state;
  }

  private async run(gen: number): Promise<ExploreState> {
    const o = this.opts!;
    const startCell = cellOf(o.centre);
    const here = this.d.position();
    // where the bot stands is seen already
    const hc = here ? cellOf(here) : startCell;
    this.frontier.visited.add(cellKey(hc.cx, hc.cz));
    while (gen === this.gen) {
      if (this.paused) {
        this.state = 'paused';
        await this.d.waitTicks(5);
        continue;
      }
      if (!this.d.ready()) {
        this.state = 'waiting';
        await this.d.waitTicks(20);
        continue;
      }
      const pos = this.d.position();
      const cache = this.d.cache();
      if (!pos || !cache) {
        if (!cache) {
          this.lastError = 'no world cache';
          return this.end(gen, 'failed');
        }
        await this.d.waitTicks(10);
        continue;
      }
      if (!this.target) {
        this.state = 'pick';
        const view = this.d.viewRadius();
        const skippedBefore = this.frontier.skipped.size;
        const c = pickCell(this.frontier, this.cells, pos, (x, z) => cache.known(x, z), view);
        this.stats.covered += this.frontier.skipped.size - skippedBefore;
        if (!c) return this.end(gen, 'done');
        const spot = standSpot(cache.summary(c.cx, c.cz), c.cx, c.cz);
        if ('skip' in spot) {
          this.frontier.skipped.add(cellKey(c.cx, c.cz));
          this.stats[spot.skip]++;
          this.log.info(`explore: cell ${c.cx},${c.cz} skipped: over ${spot.skip}`);
          continue;
        }
        this.target = { cx: c.cx, cz: c.cz, p: 'p' in spot ? spot.p : undefined, gain: c.gain };
      }
      const t = this.target;
      const m = cellCentre(t.cx, t.cz);
      const goal: Goal = t.p ? { type: 'near', p: { x: t.p.x + 0.5, y: t.p.y, z: t.p.z + 0.5 }, r: 4 } : { type: 'xz', x: m.x, z: m.z };
      const dist = Math.hypot((t.p?.x ?? m.x) - pos.x, (t.p?.z ?? m.z) - pos.z);
      this.state = 'walk';
      this.stats.walks++;
      this.log.info(`explore: to cell ${t.cx},${t.cz} (${t.p ? fmt(t.p) : `${m.x} ? ${m.z}`}, ${dist.toFixed(0)} blocks, ${t.gain} new columns in view)`);
      const r = await this.d.goto(goal, { timeoutTicks: 1200 + Math.round(20 * dist) });
      if (gen !== this.gen) return this.state;
      if (this.paused) continue; // pre-empted: the same cell again after the resume
      if (!r.ok) {
        if (r.reason === 'interrupted') continue;
        this.log.info(`explore: cell ${t.cx},${t.cz} unreachable (${r.reason})`);
        this.frontier.skipped.add(cellKey(t.cx, t.cz));
        this.stats.unreachable++;
        this.target = undefined;
        if (++this.failedWalks >= MAX_FAILED_WALKS) {
          this.lastError = `${this.failedWalks} walks in a row failed`;
          return this.end(gen, 'failed');
        }
        continue;
      }
      this.failedWalks = 0;
      // look around: the columns of the view load meanwhile
      this.state = 'look';
      const at = this.d.position() ?? pos;
      await this.d.waitTicks(LOOK_TICKS);
      if (this.d.waitChunks) await this.d.waitChunks(Math.min(4, this.d.viewRadius()), at, 5000).catch(() => undefined);
      if (!this.alive(gen)) {
        if (gen !== this.gen) return this.state;
        continue;
      }
      this.stats.distance += dist;
      this.frontier.visited.add(cellKey(t.cx, t.cz));
      this.stats.visited++;
      this.stats.path.push({ cx: t.cx, cz: t.cz, ms: this.now() - (this.stats.startedAt ?? this.now()), gain: t.gain });
      this.target = undefined;
      this.tally();
    }
    return this.state;
  }
}

function newStats(): ExploreStats {
  return {
    startedAt: undefined,
    finishedAt: undefined,
    cells: 0,
    visited: 0,
    water: 0,
    lava: 0,
    unreachable: 0,
    covered: 0,
    walks: 0,
    distance: 0,
    newColumns: 0,
    ores: 0,
    containers: 0,
    logs: 0,
    forests: 0,
    herds: 0,
    path: [],
  };
}

function fmt(p: Vec3): string {
  return `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
}

/** `45 s`, `3 min 5 s` */
export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
