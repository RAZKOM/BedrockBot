// Helpers for the job benchmark (Track EF1, docs/benchmarks.md): one afk-task bot wired like the CLI (index.ts: the
// world cache in a fresh directory of its own, the coarse layer over it, the planner worker by `plannerThreads`), on a
// test server with a generated world (bds-world by default), and the sampler that puts every tick of a run into one
// bucket (walk, plan, act, dig, pickup, chest, job, idle) from the bot's own state.
//
// Env: BENCH_BDS_HOST (127.0.0.1), BENCH_BDS_PORT (19142), BENCH_BDS_CONTAINER (bds-world); game version and transport
// from env.ts; BENCH_VERBOSE=1 logs the bot's lines.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { craftControlOf } from '../../src/chat/commands-craft.ts';
import { RuntimeSettings, SETTINGS_VALUE_KEY } from '../../src/config/settings.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import { attachCoarseLayer } from '../../src/skills/coarse/index.ts';
import type { GotoReport } from '../../src/skills/nav/navigator.ts';
import type { CommonTaskOptions } from '../../src/tasks/base.ts';
import { buildTaskContext, type BuiltContext } from '../../src/tasks/context.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { openWorldCache } from '../../src/world/cache/index.ts';
import type { WorldCache } from '../../src/world/cache/cache.ts';
import { CraftTruth } from './craft-truth.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { hdist, sleep, until } from './get-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export { sleep, until, hdist } from './get-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const BENCH_HOST = process.env.BENCH_BDS_HOST ?? '127.0.0.1';
export const BENCH_PORT = Number(process.env.BENCH_BDS_PORT ?? 19142);
export const BENCH_CONTAINER = process.env.BENCH_BDS_CONTAINER ?? 'bds-world';
export const BENCH_TARGET: ConnectTarget = bdsTarget(BENCH_HOST, BENCH_PORT);
export const VERBOSE = process.env.BENCH_VERBOSE === '1';
/** BENCH_DEBUG=1: the run's log keeps the debug lines too (a diagnosis run; the rows are the same). */
const DEBUG = process.env.BENCH_DEBUG === '1';

export function benchCmd(...words: string[]): Promise<void> {
  return consoleCommand(BENCH_CONTAINER, ...words);
}

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Peaceful, the clock frozen at noon, clear weather, no natural spawns, fall damage on (the runs meet real ground). */
export async function prepareServer(): Promise<void> {
  for (const c of [
    ['difficulty', 'peaceful'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'dotiledrops', 'true'],
    ['gamerule', 'doimmediaterespawn', 'true'],
    ['gamerule', 'keepinventory', 'false'],
    ['gamerule', 'falldamage', 'true'],
    ['time', 'set', 'noon'],
    ['weather', 'clear'],
  ]) {
    await benchCmd(...c);
  }
}

export interface BenchBot {
  name: string;
  conn: Connection;
  chat: Chat;
  task: WalkingTask;
  settings: RuntimeSettings;
  built: BuiltContext;
  truth: CraftTruth;
  cache: WorldCache;
  said: string[];
  logs: string[];
  command(text: string): Promise<void>;
  stop(): Promise<void>;
}

function capture(scope: string, into: string[]) {
  const base = VERBOSE ? createLogger('info', scope) : silentLogger;
  const keep = (lvl: string) => (msg: string) => {
    into.push(`${new Date().toISOString().slice(11, 23)} ${scope} ${lvl} ${msg}`);
  };
  return {
    ...base,
    debug: (m: string) => {
      if (DEBUG) keep('debug')(m);
      base.debug(m);
    },
    info: (m: string) => {
      keep('info')(m);
      base.info(m);
    },
    warn: (m: string) => {
      keep('warn')(m);
      base.warn(m);
    },
    error: (m: string) => {
      keep('error')(m);
      base.error(m);
    },
  };
}

/**
 * Connect a bot running the afk task (walking on), wired like the CLI (index.ts): settings in memory, the world cache in
 * a fresh temporary directory (a bot that has seen nothing of this world), the coarse layer over it.
 */
export async function startBenchBot(prefix: string, options: Partial<CommonTaskOptions> = {}): Promise<BenchBot> {
  const name = uniqueName(prefix);
  const log = VERBOSE ? createLogger('info', name) : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: log, reconnect: false });
  const metrics = new Metrics();
  metrics.attach(conn);
  const chat = new Chat(conn, { log, owners: parseOwners([]), maxReplies: 200 });
  const common: CommonTaskOptions = { nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: true, respawnDelayMs: 1000, ...options };
  const settings = new RuntimeSettings();
  const logs: string[] = [];
  const ref: { task?: WalkingTask } = {};
  const built = buildTaskContext({
    name: 'afk',
    conn,
    metrics,
    chat,
    version: E2E_VERSION,
    options: common,
    values: { 'no-config': true, [SETTINGS_VALUE_KEY]: settings },
    logger: (scope) => capture(`${scope}`, logs),
    position: () => ref.task?.position(),
  });
  const t = afkTask.create(built.ctx) as WalkingTask;
  ref.task = t;
  if (!t.pve || !t.processes) throw new Error('afk task without walking');
  registerBuiltinCommands(chat, {
    conn,
    metrics,
    position: () => t.position(),
    extraStatus: () => t.statusLine?.() ?? { task: 'afk' },
    extraLines: () => t.processLines?.() ?? [],
    quit: () => undefined,
  });
  const mob = built.mobility!;
  const root = mkdtempSync(join(tmpdir(), 'bench-cache-'));
  const cache = openWorldCache(mob.world, { root, server: `${BENCH_HOST}:${BENCH_PORT}`, logger: capture('cache', logs) });
  const coarse = attachCoarseLayer(mob.world, { logger: capture('coarse', logs) });
  if (coarse) mob.skills.nav.attachCoarse(coarse.layer, { minBlocks: () => Number(settings.get('coarseMin')) });
  const truth = new CraftTruth(conn, BENCH_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(BENCH_TARGET);
  await mob.world.waitForChunks(3, { timeoutMs: 60_000 });
  await mob.loop.waitTicks(10);
  const craft = craftControlOf(t);
  if (craft) await until(() => (craft.recipes.size > 0 ? true : undefined), 20_000, 'the crafting_data packet').catch(() => undefined);
  return {
    name,
    conn,
    chat,
    task: t,
    settings,
    built,
    truth,
    cache,
    said,
    logs,
    command: (text) => benchCmd('tell', name, ...text.split(' ')),
    stop: async () => {
      t.stop();
      built.stop();
      chat.stop();
      coarse?.detach();
      try {
        cache.close();
      } catch {
        // a cache that cannot write is no fault of the run
      }
      await conn.disconnectAndFlush('bench done');
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Teleport the bot (truth:tp) and wait until its input loop adopted the position and the chunks round it loaded. */
export async function teleport(bot: BenchBot, feet: Vec3, chunks = 3): Promise<void> {
  const mob = bot.built.mobility!;
  await bot.truth.tp(bot.name, feet, 0, 0);
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const p = bot.task.position();
    if (p && hdist(p, feet) < 0.05) break;
    await sleep(50);
  }
  await mob.loop.waitTicks(20);
  await mob.world.waitForChunks(chunks, { center: feet, timeoutMs: 60_000 });
}

/** Give a kit (truth:kit clears the inventory first) and wait until the inventory model agrees with it. */
export async function loadKit(bot: BenchBot, items: readonly (readonly [string, number])[]): Promise<void> {
  await bot.truth.kit(bot.name, items);
  const inv = bot.built.mobility!.world.inventory;
  await until(() => (items.every(([n, c]) => inv.count(n) >= Math.min(c, 1)) ? true : undefined), 15_000, `the kit in the model (${items.map(([n, c]) => `${c} ${n}`).join(', ')})`);
  await sleep(300);
}

export type Bucket = 'walk' | 'plan' | 'act' | 'wait' | 'dig' | 'pickup' | 'chest' | 'job' | 'idle';
export const BUCKETS: readonly Bucket[] = ['walk', 'plan', 'act', 'wait', 'dig', 'pickup', 'chest', 'job', 'idle'];

/**
 * Every tick of a run into one bucket, read from the bot's own state after the tick's step: `dig` while the Digger has
 * a job (the path's digs too), else the navigator's phase while a goto runs (walk, plan, act: a place / use / door,
 * wait: a hold or no leg), else the public skill running (`collect` -> pickup, `container` -> chest, any other -> job),
 * else `job` while a process holds the bot, else `idle`. Also the job's items over time and every goto report.
 */
export class Sampler {
  readonly ticks: Record<Bucket, number> = { walk: 0, plan: 0, act: 0, wait: 0, dig: 0, pickup: 0, chest: 0, job: 0, idle: 0 };
  /** Ticks counted. */
  total = 0;
  /** The tick (of this sampler) the item count first rose over its start, and the count each tick. */
  firstItem: number | undefined;
  items = 0;
  private start0 = 0;
  readonly reports = new Set<GotoReport>();
  /** Process names seen running (with the ticks each held), and `name:state` of a process whose task has a state. */
  readonly processes: Record<string, number> = {};
  readonly states: Record<string, number> = {};
  /** The last process task seen of each process name (the miner's MineTask: its stats at the end). */
  readonly tasks = new Map<string, unknown>();
  private off: (() => void) | undefined;

  private readonly bot: BenchBot;
  private readonly count: () => number;

  constructor(bot: BenchBot, count: () => number) {
    this.bot = bot;
    this.count = count;
  }

  begin(): void {
    const mob = this.bot.built.mobility!;
    const skills = mob.skills;
    const procs = this.bot.task.processes!;
    this.start0 = this.count();
    this.items = this.start0;
    this.off = mob.loop.onBeforeStep(() => {
      // (registered after the navigator's own hook: the phase read is the one this tick's step left)
      this.total++;
      const ph = skills.nav.phase;
      const running = skills.status().running;
      const active = procs.active;
      let k: Bucket;
      if (skills.digger?.busy) k = 'dig';
      else if (ph) k = ph;
      else if (running === 'collect') k = 'pickup';
      else if (running === 'container') k = 'chest';
      else if (running) k = 'job';
      else if (active) k = 'job';
      else k = 'idle';
      this.ticks[k]++;
      if (active) {
        this.processes[active.name] = (this.processes[active.name] ?? 0) + 1;
        const task = (active as unknown as { task?: { state?: unknown } }).task;
        if (task && typeof task === 'object') {
          this.tasks.set(active.name, task);
          if (typeof task.state === 'string') {
            const key = `${active.name}:${task.state}`;
            this.states[key] = (this.states[key] ?? 0) + 1;
          }
        }
      }
      const r = skills.nav.lastReport;
      if (r) this.reports.add(r);
      const n = this.count();
      this.items = n;
      if (this.firstItem === undefined && n > this.start0) this.firstItem = this.total;
    });
  }

  end(): void {
    this.off?.();
    this.off = undefined;
  }

  get gained(): number {
    return this.items - this.start0;
  }

  /** The counts when the job went quiet (the run's end, if it stays quiet): the shares leave out the wait that follows. */
  private frozen: { ticks: Record<Bucket, number>; total: number } | undefined;

  /** Freeze (the job is quiet from now on, unless `thaw` comes first) or thaw the counts the shares read. */
  freeze(on: boolean): void {
    if (on) this.frozen ??= { ticks: { ...this.ticks }, total: this.total };
    else this.frozen = undefined;
  }

  shares(): Record<Bucket, number> {
    const out = {} as Record<Bucket, number>;
    const f = this.frozen ?? { ticks: this.ticks, total: this.total };
    for (const b of BUCKETS) out[b] = f.total ? +(f.ticks[b] / f.total).toFixed(3) : 0;
    return out;
  }
}
