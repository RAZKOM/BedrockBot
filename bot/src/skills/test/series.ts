// Track T1 (ADR 0075): a series of test runs. Each run:
//   restore     recovery.ts Harness.restore: health, food and the kit back, /tp to the run's start, settle
//   the trip    the owner's own command fed to the chat handler as the owner typed it (`fly cave_end`, `fly route r1`,
//               `goto base`), exactly what the owner would type: the harness adds nothing to the trip
//   watch       every POLL_MS: the path length and the part of it flown (the gliding flag), the damage taken, a heal below
//               TEST_LIMITS.healBelow, a death, no progress for TEST_LIMITS.stuckMs (stuck), the time limit, `!test stop`
//   the end     the trip's own end line (TERMINAL below) and then the bot idle for SETTLE_MS (no user process, not gliding,
//               no corridor trip open); without an end line, idle for QUIET_MS; arrived = the feet within ARRIVE_RADIUS of
//               the goal cell when there is one
//   record      one RunRecord per run (a JSONL line), a short chat line per run and a summary at the end
// A death ends the run (`died`) and waits for the recovery (recovery.ts) before the next one; stuck and timeout stop the
// trip and /tp back to the start. The series knows nothing of flight internals: the bail-outs and rockets come from the
// corridor trip's end line (chat/commands-corridor.ts corridorEndLine), the flown share from the gliding flag.
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { ELYTRA_MIN_DEFAULT } from './kit.ts';
import { fmtCell, type RestoreResult } from './recovery.ts';

export type RunKind = 'cavestart' | 'cave' | 'route' | 'goto';

export interface RunSpec {
  kind: RunKind;
  /** The series' name for the file and the chat lines: `cave`, `route r1`, `goto base`. */
  name: string;
  /** Where every run starts (a feet cell): the /tp target. */
  start: Vec3;
  /** The goal cell (arrival is measured against it); undefined: the trip's own end line decides. */
  goal?: Vec3;
  /** The chat command of the trip without the prefix: `fly cave_end`, `fly route r1 noshortcut`, `goto base`. */
  command: string;
}

export type RunEnd = 'arrived' | 'failed' | 'died' | 'stuck' | 'timeout' | 'stopped' | 'setup' | 'quiet';

export interface RunRecord {
  type: 'run';
  series: string;
  kind: RunKind;
  run: number;
  of: number;
  command: string;
  start: Vec3;
  goal: Vec3 | null;
  startedAt: string;
  seconds: number;
  arrived: boolean;
  end: RunEnd;
  /** The trip's last end line (or why the harness ended it). */
  reason: string;
  /** Feet distance from the goal cell's centre at the end. */
  endDistance: number | null;
  endAt: Vec3 | null;
  damage: number;
  deaths: number;
  heals: number;
  /** Path length (blocks) and the part of it flown (gliding). */
  pathBlocks: number;
  flownBlocks: number;
  flownShare: number;
  bailouts: number;
  rockets: number | null;
  restore: string[];
  /** The bot's replies during the run (the last 12). */
  replies: string[];
}

export interface SeriesSummary {
  type: 'summary';
  series: string;
  kind: RunKind;
  runs: number;
  planned: number;
  arrived: number;
  meanSeconds: number;
  damage: number;
  deaths: number;
  meanFlownShare: number;
  bailouts: number;
  ends: Partial<Record<RunEnd, number>>;
  stopped: boolean;
}

/** End lines of the trips (the start of a reply). `done` ends a run that reached its end, `fail` one that did not. */
export const TERMINAL: Readonly<Record<'goto' | 'fly' | 'route', { done: RegExp; fail: RegExp }>> = {
  goto: { done: /^arrived at /, fail: /^(goto: |no waypoint |usage: |waypoint \S+ is in the )/ },
  fly: { done: /^(landed at |arrived at .+ along a corridor|walked to )/, fail: /^(fly: (?!proving |the shortcut )|landed \(|usage: |elytra worn)/ },
  route: { done: /^arrived at .+ along a corridor/, fail: /^(fly: (?!proving |the shortcut )|usage: )/ },
};

export function terminalOf(kind: RunKind): { done: RegExp; fail: RegExp } {
  return kind === 'goto' ? TERMINAL.goto : kind === 'route' ? TERMINAL.route : TERMINAL.fly;
}

/** A corridor trip has started (its steps leave gaps with no process: the proofs, the waits for chunks). */
export const CORRIDOR_OPEN = /^flying (via |route |to .+ along a corridor)/;
/** ... and ended (corridorEndLine). */
export const CORRIDOR_CLOSE = /^(arrived at .+ along a corridor|fly: the corridor to )/;

/** `(2 bailed out)` and `4 rockets` from a corridor end line; undefined when the line has none. */
export function parseTripStats(line: string): { bailouts?: number; rockets?: number } {
  const b = /\((\d+) bailed out\)/.exec(line);
  const r = /(?:^|[;(,]\s*)(\d+) rockets?\b/.exec(line);
  return { ...(b ? { bailouts: Number(b[1]) } : {}), ...(r ? { rockets: Number(r[1]) } : {}) };
}

/**
 * The run limits (constants, not settings: the panel budgets leave no room for more rows). healBelow: /effect
 * instant_health below this health in a run; elytraMin: a fresh elytra replaces one with fewer uses left (432 is new);
 * stuckMs: less than PROGRESS_BLOCKS of progress this long ends the run (stuck) and teleports back; runMs: one run's limit.
 */
export const TEST_LIMITS = { healBelow: 14, elytraMin: ELYTRA_MIN_DEFAULT, stuckMs: 60_000, runMs: 600_000 } as const;

export const POLL_MS = 100;
/** After the end line: the bot idle this long ends the run (the walk after a landing starts in this gap). */
export const SETTLE_MS = 2000;
/** After the end line: at most this long more for the rest of the trip (a walk to the goal). */
export const AFTER_END_MS = 120_000;
/** Without an end line: idle this long ends the run (`quiet`). */
export const QUIET_MS = 15_000;
/** Moved at least this far (blocks) counts as progress. */
export const PROGRESS_BLOCKS = 2;
/** Feet within this distance (blocks) of the goal cell's centre: arrived. */
export const ARRIVE_RADIUS = 2.5;
/** After stopping a trip, wait this long at most for it to land and end. */
export const STOP_WAIT_MS = 20_000;

export interface SeriesPorts {
  restore(start: Vec3): Promise<RestoreResult>;
  heal(): Promise<boolean>;
  /** Feed `command` (no prefix) to the chat handler as the owner who started the series. */
  dispatch(command: string): void;
  /** Every reply the bot sends while the series runs. */
  onReply(fn: (m: string) => void): () => void;
  /** A user process runs, the flight controller is active or the body glides. */
  busy(): boolean;
  position(): Vec3 | undefined;
  gliding(): boolean;
  health(): number | undefined;
  deaths(): number;
  /** The death path (recovery.ts Recovery): resolves when a death is recovered. */
  recovered(): Promise<void>;
  /** End the trip now (the corridor trip, the flight, every user process). */
  stopTrip(): Promise<void> | void;
  healBelow(): number;
  write(rec: RunRecord | SeriesSummary): void;
  say(line: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  log?: Logger;
}

export interface SeriesOptions {
  runs: number;
  timeoutMs: number;
  stuckMs: number;
  settleMs?: number;
  quietMs?: number;
  afterEndMs?: number;
  pollMs?: number;
}

const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const centre = (c: Vec3): Vec3 => ({ x: Math.floor(c.x) + 0.5, y: Math.floor(c.y), z: Math.floor(c.z) + 0.5 });
const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d;

/** `test cave 2/3: arrived in 41 s; damage 2.5, flown 82%, 1 bail-out` */
export function runLine(r: RunRecord): string {
  const what = r.end === 'arrived' ? `arrived in ${Math.round(r.seconds)} s` : `${r.end} after ${Math.round(r.seconds)} s`;
  const stats = [`damage ${round(r.damage)}`, `flown ${Math.round(r.flownShare * 100)}%`];
  if (r.bailouts) stats.push(`${r.bailouts} bail-out${r.bailouts === 1 ? '' : 's'}`);
  if (r.heals) stats.push(`${r.heals} heal${r.heals === 1 ? '' : 's'}`);
  const why = r.end === 'arrived' ? '' : ` (${r.reason.length > 90 ? `${r.reason.slice(0, 87)}...` : r.reason})`;
  return `test ${r.series} ${r.run}/${r.of}: ${what}${why}; ${stats.join(', ')}`;
}

export function summarize(spec: RunSpec, planned: number, records: readonly RunRecord[], stopped: boolean): SeriesSummary {
  const ends: Partial<Record<RunEnd, number>> = {};
  for (const r of records) ends[r.end] = (ends[r.end] ?? 0) + 1;
  const n = records.length;
  const sum = (f: (r: RunRecord) => number): number => records.reduce((a, r) => a + f(r), 0);
  return {
    type: 'summary',
    series: spec.name,
    kind: spec.kind,
    runs: n,
    planned,
    arrived: records.filter((r) => r.arrived).length,
    meanSeconds: n ? round(sum((r) => r.seconds) / n) : 0,
    damage: round(sum((r) => r.damage)),
    deaths: sum((r) => r.deaths),
    meanFlownShare: n ? round(sum((r) => r.flownShare) / n, 2) : 0,
    bailouts: sum((r) => r.bailouts),
    ends,
    stopped,
  };
}

/** `test cave: 2/3 arrived, 41 s a run, damage 6.5, 1 death, flown 78%, 2 bail-outs; ends arrived 2, died 1` */
export function summaryLine(s: SeriesSummary): string {
  const ends = Object.entries(s.ends).map(([k, v]) => `${k} ${v}`).join(', ');
  const head = `test ${s.series}: ${s.arrived}/${s.runs} arrived${s.runs < s.planned ? ` (${s.runs} of ${s.planned} runs${s.stopped ? ', stopped' : ''})` : ''}`;
  return `${head}, ${s.meanSeconds} s a run, damage ${s.damage}, ${s.deaths} death${s.deaths === 1 ? '' : 's'}, flown ${Math.round(s.meanFlownShare * 100)}%, ${s.bailouts} bail-out${s.bailouts === 1 ? '' : 's'}; ends ${ends || 'none'}`;
}

export class TestSeries {
  readonly spec: RunSpec;
  readonly records: RunRecord[] = [];
  private readonly p: SeriesPorts;
  private readonly o: Required<SeriesOptions>;
  private readonly log: Logger;
  private stopped = false;
  /** The run in progress (1-based), 0 before the first. */
  current = 0;

  constructor(spec: RunSpec, p: SeriesPorts, o: SeriesOptions) {
    this.spec = spec;
    this.p = p;
    this.o = { settleMs: SETTLE_MS, quietMs: QUIET_MS, afterEndMs: AFTER_END_MS, pollMs: POLL_MS, ...o };
    this.log = p.log ?? silentLogger;
  }

  /** `!test stop`: the run in progress ends (its trip stopped), no further run starts. */
  stop(): void {
    this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  status(): string {
    return `test ${this.spec.name}: run ${this.current}/${this.o.runs}, ${this.records.filter((r) => r.arrived).length} arrived so far`;
  }

  async run(): Promise<SeriesSummary> {
    for (let i = 1; i <= this.o.runs && !this.stopped; i++) {
      this.current = i;
      const rec = await this.runOne(i);
      this.records.push(rec);
      this.p.write(rec);
      this.p.say(runLine(rec));
      this.log.info(`${runLine(rec)}; ${rec.restore.join('; ')}`);
      if (rec.end === 'setup') break; // the start cannot be restored: every later run would fail the same way
    }
    const s = summarize(this.spec, this.o.runs, this.records, this.stopped);
    this.p.write(s);
    return s;
  }

  private async runOne(i: number): Promise<RunRecord> {
    const spec = this.spec;
    const startedAt = new Date().toISOString();
    await this.p.recovered();
    const base = { type: 'run' as const, series: spec.name, kind: spec.kind, run: i, of: this.o.runs, command: spec.command, start: spec.start, goal: spec.goal ?? null, startedAt };
    const restored = await this.p.restore(spec.start);
    if (!restored.ok) {
      return { ...base, seconds: 0, arrived: false, end: 'setup', reason: `restore failed: ${restored.why ?? '?'}`, endDistance: null, endAt: this.p.position() ?? null, damage: 0, deaths: 0, heals: 0, pathBlocks: 0, flownBlocks: 0, flownShare: 0, bailouts: 0, rockets: null, restore: restored.steps, replies: [] };
    }
    const term = terminalOf(spec.kind);
    const replies: string[] = [];
    let doneLine: string | undefined;
    let failLine: string | undefined;
    let endLineAt: number | undefined;
    let corridorOpen = false;
    let lastReplyAt = this.p.now();
    const off = this.p.onReply((m) => {
      replies.push(m);
      if (replies.length > 12) replies.shift();
      lastReplyAt = this.p.now();
      if (CORRIDOR_OPEN.test(m)) corridorOpen = true;
      if (CORRIDOR_CLOSE.test(m)) corridorOpen = false;
      if (term.done.test(m)) {
        doneLine = m;
        endLineAt = this.p.now();
      } else if (term.fail.test(m)) {
        failLine = m;
        endLineAt = this.p.now();
      }
    });
    const t0 = this.p.now();
    const deaths0 = this.p.deaths();
    let last = this.p.position();
    let lastHealth = this.p.health();
    let path = 0;
    let flown = 0;
    let damage = 0;
    let heals = 0;
    let anchor = last;
    let anchorAt = t0;
    let idleSince: number | undefined;
    let forced: RunEnd | undefined;
    let forcedWhy = '';
    try {
      this.log.info(`test ${spec.name} ${i}/${this.o.runs}: !${spec.command} from ${fmtCell(spec.start)}`);
      this.p.dispatch(spec.command);
      for (;;) {
        await this.p.sleep(this.o.pollMs);
        const now = this.p.now();
        const here = this.p.position();
        if (here && last) {
          const step = dist3(here, last);
          if (step < 20) {
            // a jump of 20 blocks in 100 ms is a teleport (a respawn), not travel
            path += step;
            if (this.p.gliding()) flown += step;
          }
        }
        if (here) last = here;
        if (here && (!anchor || dist3(here, anchor) >= PROGRESS_BLOCKS)) {
          anchor = here;
          anchorAt = now;
        }
        const h = this.p.health();
        if (h !== undefined && lastHealth !== undefined && h < lastHealth) damage += lastHealth - h;
        if (h !== undefined) lastHealth = h;
        if (this.p.deaths() > deaths0) {
          forced = 'died';
          forcedWhy = 'died';
          break;
        }
        if (h !== undefined && h > 0 && h < this.p.healBelow() && (await this.p.heal())) heals++;
        if (this.stopped) {
          forced = 'stopped';
          forcedWhy = '!test stop';
          break;
        }
        if (now - t0 > this.o.timeoutMs) {
          forced = 'timeout';
          forcedWhy = `no end within ${Math.round(this.o.timeoutMs / 1000)} s`;
          break;
        }
        const busy = this.p.busy() || corridorOpen;
        if (busy) idleSince = undefined;
        else idleSince ??= now;
        const idleFor = idleSince === undefined ? 0 : now - idleSince;
        if (endLineAt !== undefined) {
          if (idleFor >= this.o.settleMs || now - endLineAt > this.o.afterEndMs) break;
          continue;
        }
        if (busy && now - anchorAt > this.o.stuckMs) {
          forced = 'stuck';
          forcedWhy = `moved less than ${PROGRESS_BLOCKS} blocks in ${Math.round(this.o.stuckMs / 1000)} s`;
          break;
        }
        if (idleFor >= this.o.quietMs && now - lastReplyAt >= this.o.quietMs) break;
      }
    } finally {
      off();
    }
    const seconds = round((this.p.now() - t0) / 1000);
    if (forced && forced !== 'died') await this.stopTrip();
    const deaths = this.p.deaths() - deaths0;
    const restore = [...restored.steps];
    const diedAt = last;
    if (forced === 'died') {
      await this.p.stopTrip();
      await this.p.recovered(); // respawn, kit and /tp back (recovery.ts)
    }
    const endAt = forced === 'died' ? diedAt : this.p.position();
    // stuck or out of time: back to the start now (the next run would anyway; the last one leaves the bot there too)
    if (forced === 'stuck' || forced === 'timeout') {
      const back = await this.p.restore(spec.start);
      restore.push(...back.steps.map((s) => `after: ${s}`));
    }
    const goal = spec.goal ? centre(spec.goal) : undefined;
    const endDistance = goal && endAt && forced !== 'died' ? round(dist3(endAt, goal), 2) : null;
    const arrived = forced === undefined && (endDistance !== null ? endDistance <= ARRIVE_RADIUS : doneLine !== undefined && failLine === undefined);
    const end: RunEnd = forced ?? (arrived ? 'arrived' : failLine || doneLine ? 'failed' : 'quiet');
    const endLine = failLine ?? doneLine;
    const stats = parseTripStats(endLine ?? '');
    const reason = forced ? `${forcedWhy}${endLine ? ` (last: ${endLine})` : ''}` : (endLine ?? replies[replies.length - 1] ?? 'no reply');
    return {
      ...base,
      seconds,
      arrived,
      end,
      reason,
      endDistance,
      endAt: endAt ? { x: round(endAt.x, 2), y: round(endAt.y, 2), z: round(endAt.z, 2) } : null,
      damage: round(damage),
      deaths,
      heals,
      pathBlocks: round(path),
      flownBlocks: round(flown),
      flownShare: path > 0 ? round(flown / path, 3) : 0,
      bailouts: stats.bailouts ?? 0,
      rockets: stats.rockets ?? null,
      restore,
      replies: [...replies],
    };
  }

  private async stopTrip(): Promise<void> {
    await this.p.stopTrip();
    const t0 = this.p.now();
    while (this.p.busy() && this.p.now() - t0 < STOP_WAIT_MS) await this.p.sleep(this.o.pollMs);
  }
}
