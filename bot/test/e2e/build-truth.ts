// Helpers for the builder e2e tests (wave 9, Track AL; docs/build.md) against bds-build (udp/19200,
// flat world, DIFFICULTY peaceful, truth pack with truth:blocksdiff; docker/compose.build.yml). Each
// test file runs the real afk task (tasks/registry.ts, wired by tasks/context.ts like the CLI) on its
// own connection with a unique name, waypoints and settings in memory (--no-config), structure files
// from its own temporary folder, in its own random area, and removes what it built at the end.
//
// Env: BUILD_BDS_HOST (127.0.0.1), BUILD_BDS_PORT (19200), BUILD_BDS_CONTAINER (bds-build); game version
// and transport from env.ts (BOT_VERSION, BDS_TRANSPORT); BUILD_VERBOSE=1 logs the bot's lines.
import { randomInt } from 'node:crypto';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { buildControllerOf, type BuildController } from '../../src/chat/commands-build.ts';
import { RuntimeSettings, SETTINGS_VALUE_KEY } from '../../src/config/settings.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import type { CommonTaskOptions } from '../../src/tasks/base.ts';
import { buildTaskContext, type BuiltContext } from '../../src/tasks/context.ts';
import type { ProcessManager } from '../../src/tasks/process/manager.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { PveTruth } from './pve-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const BUILD_HOST = process.env.BUILD_BDS_HOST ?? '127.0.0.1';
export const BUILD_PORT = Number(process.env.BUILD_BDS_PORT ?? 19200);
export const BUILD_CONTAINER = process.env.BUILD_BDS_CONTAINER ?? 'bds-build';
export const BUILD_TARGET: ConnectTarget = bdsTarget(BUILD_HOST, BUILD_PORT);
export const VERBOSE = process.env.BUILD_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const hdist = (a: Vec3, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** This run's private area: a cell of a 256-block grid starting at x, z = 36864 (8 x 8 cells). */
export function privateArea(): { x: number; z: number; cell: number } {
  const cell = randomInt(64);
  return { cell, x: 36864 + 256 * (cell % 8) + 128, z: 36864 + 256 * Math.floor(cell / 8) + 128 };
}

export function buildCmd(...words: string[]): Promise<void> {
  return consoleCommand(BUILD_CONTAINER, ...words);
}

/** Peaceful, frozen clock at noon, no weather, no natural spawns, block drops on. */
export async function prepareServer(): Promise<void> {
  for (const c of [
    ['difficulty', 'peaceful'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'dotiledrops', 'true'],
    ['time', 'set', 'noon'],
    ['weather', 'clear'],
  ]) {
    await buildCmd(...c);
  }
}

export interface Diff {
  count: number;
  diffs: number;
  first: { x: number; y: number; z: number; expected: string; actual: string }[];
  actual: Record<string, number>;
}

/** truth:* for the builder (packs/truth/src/build.ts) on top of the PvE commands. */
export class BuildTruth extends PveTruth {
  /**
   * truth:blocksdiff over the box min..max against `expected(cell)` (a block id, `air`, or `*` for any),
   * sent as palette + runs in the canonical order (y, then z, then x innermost).
   */
  blocksDiff(min: Vec3, max: Vec3, expected: (c: Vec3) => string): Promise<Diff> {
    const palette: string[] = [];
    const runs: [number, number][] = [];
    for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) {
        for (let x = min.x; x <= max.x; x++) {
          const n = expected({ x, y, z });
          let i = palette.indexOf(n);
          if (i < 0) i = palette.push(n) - 1;
          const last = runs[runs.length - 1];
          if (last?.[0] === i) last[1]++;
          else runs.push([i, 1]);
        }
      }
    }
    return this.ok<Diff>('blocksdiff', [min.x, min.y, min.z, max.x, max.y, max.z, palette.join(','), runs.map(([i, n]) => `${i}*${n}`).join(',')], 20_000);
  }

  async counts(name: string): Promise<Record<string, number>> {
    const inv = await this.ok<{ counts: Record<string, number> }>('inv', [name]);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(inv.counts)) out[k.replace(/^minecraft:/, '')] = v;
    return out;
  }
}

export interface BuildBot {
  name: string;
  conn: Connection;
  chat: Chat;
  task: WalkingTask;
  processes: ProcessManager;
  settings: RuntimeSettings;
  built: BuiltContext;
  truth: BuildTruth;
  build: BuildController;
  /** The bot's chat lines (its replies), newest last. */
  said: string[];
  /** Log lines of the build scope, newest last. */
  logs: string[];
  /** Send a command as the console (an owner): `tell <bot> !...`. */
  command(text: string): Promise<void>;
  /** Wait for a reply (after `from` lines) that matches. */
  reply(match: (s: string) => boolean, from: number, timeoutMs?: number): Promise<string>;
  stop(): Promise<void>;
}

function capture(scope: string, into: string[]) {
  const base = VERBOSE ? createLogger('info', scope) : silentLogger;
  const keep = (lvl: string) => (msg: string) => {
    into.push(`${scope} ${lvl} ${msg}`);
  };
  return {
    ...base,
    debug: (m: string) => base.debug(m),
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

/** Connect a bot running the afk task (walking on), wired like the CLI (index.ts). */
export async function startBuildBot(prefix: string, builds: string, options: Partial<CommonTaskOptions> = {}): Promise<BuildBot> {
  const name = uniqueName(prefix);
  const log = VERBOSE ? createLogger('info', name) : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: log, reconnect: false });
  const metrics = new Metrics();
  metrics.attach(conn);
  const chat = new Chat(conn, { log, owners: parseOwners([]), maxReplies: 50 });
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
    // --no-config: waypoints and settings in memory only; structure files from the test's own folder
    values: { 'no-config': true, builds, [SETTINGS_VALUE_KEY]: settings },
    logger: (scope) => capture(`${name}:${scope}`, logs),
    position: () => ref.task?.position(),
  });
  const t = afkTask.create(built.ctx) as WalkingTask;
  ref.task = t;
  if (!t.pve || !t.processes) throw new Error('afk task without walking');
  const build = buildControllerOf(t);
  if (!build) throw new Error('no !build on the afk task');
  registerBuiltinCommands(chat, {
    conn,
    metrics,
    position: () => t.position(),
    extraStatus: () => t.statusLine?.() ?? { task: 'afk' },
    extraLines: () => t.processLines?.() ?? [],
    quit: () => undefined,
  });
  metrics.provide(() => ({ taskStatus: t.status() }));
  const truth = new BuildTruth(conn, BUILD_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(BUILD_TARGET);
  const mob = built.mobility!;
  await mob.world.waitForChunks(4, { timeoutMs: 30_000 });
  await mob.loop.waitTicks(10);
  return {
    name,
    conn,
    chat,
    task: t,
    processes: t.processes,
    settings,
    built,
    truth,
    build,
    said,
    logs,
    command: (text) => buildCmd('tell', name, ...text.split(' ')),
    reply: (match, from, timeoutMs = 10_000) => until(() => said.slice(from).find(match), timeoutMs, `reply after line ${from} (said: ${said.slice(from).join(' | ')})`, 50),
    stop: async () => {
      t.stop();
      built.stop();
      chat.stop();
      await conn.disconnectAndFlush('test done');
    },
  };
}

/** Teleport the bot (truth:tp) and wait until its input loop adopted the position and chunks loaded. */
export async function teleport(bot: BuildBot, feet: Vec3): Promise<void> {
  const mob = bot.built.mobility!;
  await bot.truth.tp(bot.name, feet, 0, 0);
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const p = bot.task.position();
    if (p && hdist(p, feet) < 0.05) break;
    await sleep(50);
  }
  await mob.loop.waitTicks(20);
  await mob.world.waitForChunks(3, { center: feet, timeoutMs: 20_000 });
}

/** A truth command, retried while its chunks are not loaded yet. */
export async function truthLoaded<T = Record<string, unknown>>(truth: PveTruth, cmd: string, args: (string | number)[], timeoutMs = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const r = await truth.cmd<T>(cmd, args, 30_000);
    if (r.ok) return r.data;
    if (r.reason !== 'unloaded_chunk' || Date.now() - t0 > timeoutMs) throw new Error(`truth:${cmd} ${args.join(' ')} failed: ${r.reason} ${JSON.stringify(r.data)}`);
    await sleep(300);
  }
}

/** Flat floor (dirt below, grass on top) and air above in a box around `c` (radius r, height h). */
export async function clearArea(truth: PveTruth, c: { x: number; z: number }, r: number, h = 10): Promise<void> {
  await truthLoaded(truth, 'fill', [c.x - r, FEET_Y - 3, c.z - r, c.x + r, FEET_Y - 2, c.z + r, 'dirt']);
  await truthLoaded(truth, 'fill', [c.x - r, FEET_Y - 1, c.z - r, c.x + r, FEET_Y - 1, c.z + r, 'grass_block']);
  await truthLoaded(truth, 'fill', [c.x - r, FEET_Y, c.z - r, c.x + r, FEET_Y + h, c.z + r, 'air']);
}

/** Wait until the bot stands still on the ground, then its feet. */
export async function settled(bot: BuildBot): Promise<Vec3> {
  const mob = bot.built.mobility!;
  for (let i = 0; i < 60 && !mob.loop.state.onGround; i++) await mob.loop.waitTicks(1);
  return { ...mob.loop.state.pos };
}

/** Poll `fn` until it returns a value or `timeoutMs` passes. */
export async function until<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs: number, what: string, everyMs = 250): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}
