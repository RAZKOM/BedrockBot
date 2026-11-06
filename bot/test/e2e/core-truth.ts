// Helpers for the process manager / runtime settings e2e tests (PLAN.md 7.8 and 7.9, Track Q;
// docs/processes.md) against bds-core (udp/19180, flat world, DIFFICULTY normal, truth pack;
// docker/compose.core.yml). Each test file runs the real afk task (tasks/registry.ts, wired by
// tasks/context.ts like the CLI, with the CLI's !status / !pos / !help) on its own connection with a
// unique name, in its own random area, and summons its mobs with a per-run tag removed at the end.
// The CLI runs (`node src/index.ts`) use a temporary log dir and settings file outside the repo.
//
// Env: CORE_BDS_HOST (127.0.0.1), CORE_BDS_PORT (19180), CORE_BDS_CONTAINER (bds-core), CORE_FEET_Y (-60); game version
// and transport from env.ts (BOT_VERSION, BDS_TRANSPORT); CORE_VERBOSE=1 logs the bot's lines.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chat, chatPacket, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands, registerHardeningCommands } from '../../src/chat/commands.ts';
import { RuntimeSettings, SETTINGS_VALUE_KEY } from '../../src/config/settings.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import type { CommonTaskOptions } from '../../src/tasks/base.ts';
import { buildTaskContext, type BuiltContext } from '../../src/tasks/context.ts';
import type { ProcessManager } from '../../src/tasks/process/manager.ts';
import type { PveController } from '../../src/tasks/pve.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { bdsTarget, CLI_TARGET_ARGS, E2E_VERSION } from './env.ts';
import { PveTruth } from './pve-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const CORE_HOST = process.env.CORE_BDS_HOST ?? '127.0.0.1';
export const CORE_PORT = Number(process.env.CORE_BDS_PORT ?? 19180);
export const CORE_CONTAINER = process.env.CORE_BDS_CONTAINER ?? 'bds-core';
export const CORE_TARGET: ConnectTarget = bdsTarget(CORE_HOST, CORE_PORT);
export const VERBOSE = process.env.CORE_VERBOSE === '1';
/**
 * Flat world: grass top at y = -61, feet at -60. CORE_FEET_Y moves it (decision 0062: the panel e2e on
 * a generated world such as bds-cache, `CORE_FEET_Y=240`: clearArea then builds a floating floor).
 */
export const FEET_Y = Number(process.env.CORE_FEET_Y ?? -60);
const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const hdist = (a: Vec3, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
export const fmt = (v: Vec3): string => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
export const centre = (p: Vec3): Vec3 => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y), z: Math.floor(p.z) + 0.5 });

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** This run's private area: a cell of a 256-block grid starting at x, z = 16384 (8 x 8 cells). */
export function privateArea(): { x: number; z: number; cell: number } {
  const cell = randomInt(64);
  return { cell, x: 16384 + 256 * (cell % 8) + 128, z: 16384 + 256 * Math.floor(cell / 8) + 128 };
}

export function coreCmd(...words: string[]): Promise<void> {
  return consoleCommand(CORE_CONTAINER, ...words);
}

/** Normal difficulty, frozen clock (midnight: no burning zombies), no weather, no natural spawns. */
export async function prepareServer(opts: { time?: string } = {}): Promise<void> {
  for (const c of [
    ['difficulty', 'normal'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'doimmediaterespawn', 'false'],
    ['gamerule', 'keepinventory', 'true'],
    ['gamerule', 'naturalregeneration', 'true'],
    ['time', 'set', opts.time ?? 'midnight'],
    ['weather', 'clear'],
  ]) {
    await coreCmd(...c);
  }
}

export interface CoreBot {
  name: string;
  conn: Connection;
  metrics: Metrics;
  chat: Chat;
  task: WalkingTask;
  pve: PveController;
  processes: ProcessManager;
  settings: RuntimeSettings;
  built: BuiltContext;
  truth: PveTruth;
  /** The bot's chat lines (its replies), newest last. */
  said: string[];
  /** Send a command as the console (an owner): `tell <bot> !...`. */
  command(text: string): Promise<void>;
  /** Wait for a reply (after `from` lines) that matches. */
  reply(match: (s: string) => boolean, from: number, timeoutMs?: number): Promise<string>;
  stop(): Promise<void>;
}

/** Connect a bot running the afk task (walking on), wired like the CLI (index.ts) incl. the process stack on !status. */
export async function startCoreBot(prefix: string, options: Partial<CommonTaskOptions> = {}, extra: { values?: Record<string, unknown>; settings?: RuntimeSettings } = {}): Promise<CoreBot> {
  const name = uniqueName(prefix);
  const log = VERBOSE ? createLogger('info', name) : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: log, reconnect: false });
  const metrics = new Metrics();
  metrics.attach(conn);
  const chat = new Chat(conn, { log, owners: parseOwners([]), maxReplies: 50 });
  const common: CommonTaskOptions = { nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: true, respawnDelayMs: 1000, ...options };
  const settings = extra.settings ?? new RuntimeSettings();
  const ref: { task?: WalkingTask } = {};
  const built = buildTaskContext({
    name: 'afk',
    conn,
    metrics,
    chat,
    version: E2E_VERSION,
    options: common,
    values: { ...(extra.values ?? {}), [SETTINGS_VALUE_KEY]: settings },
    logger: VERBOSE ? (scope) => createLogger('info', `${name}:${scope}`) : () => silentLogger,
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
  // !goto / !home / !shelter / !health as index.ts registers them
  registerHardeningCommands(chat, {
    health: () => ({ health: built.respawn?.health ?? null, deaths: built.respawn?.deaths ?? 0, dead: built.respawn?.dead ?? false, healthy: true }),
    shelter: t.shelter,
    home: t.home,
    goto: t.goto ? (p) => t.goto!(p) : undefined,
    position: () => t.position(),
  });
  metrics.provide(() => ({ taskStatus: t.status() }));
  const truth = new PveTruth(conn, CORE_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(CORE_TARGET);
  const mob = built.mobility!;
  await mob.world.waitForChunks(4, { timeoutMs: 30_000 });
  await mob.loop.waitTicks(10);
  return {
    name,
    conn,
    metrics,
    chat,
    task: t,
    pve: t.pve,
    processes: t.processes,
    settings,
    built,
    truth,
    said,
    command: (text) => coreCmd('tell', name, ...text.split(' ')),
    reply: (match, from, timeoutMs = 10_000) => until(() => said.slice(from).find(match), timeoutMs, `reply after line ${from}`, 50),
    stop: async () => {
      t.stop();
      built.stop();
      chat.stop();
      await conn.disconnectAndFlush('test done');
    },
  };
}

/** Teleport the bot (truth:tp) and wait until its input loop adopted the position and chunks loaded. */
export async function teleport(bot: CoreBot, feet: Vec3): Promise<void> {
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

/** Flat floor (grass on dirt) and air above in a box around `c` (radius r, height h). */
export async function clearArea(truth: PveTruth, c: Vec3, r: number, h = 8): Promise<void> {
  await truthLoaded(truth, 'fill', [c.x - r, FEET_Y - 2, c.z - r, c.x + r, FEET_Y - 2, c.z + r, 'dirt']);
  await truthLoaded(truth, 'fill', [c.x - r, FEET_Y - 1, c.z - r, c.x + r, FEET_Y - 1, c.z + r, 'grass_block']);
  await truthLoaded(truth, 'fill', [c.x - r, FEET_Y, c.z - r, c.x + r, FEET_Y + h, c.z + r, 'air']);
}

/** Give the bot exactly one iron sword (inventory cleared first). */
export async function armWithIronSword(bot: CoreBot): Promise<void> {
  await bot.truth.ok('clear', [bot.name]);
  await bot.truth.ok('give', [bot.name, 'iron_sword', 1]);
  const inv = bot.built.mobility!.world.inventory;
  await until(() => (inv.slots.some((s) => s?.name === 'iron_sword') ? true : undefined), 5_000, 'iron sword in the inventory model');
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

/** A plain client (an observer / player); its own chat goes out with say(). */
export async function connectPlayer(name: string): Promise<{ name: string; conn: Connection; heard: { from: string; message: string }[]; say(msg: string): void; close(): Promise<void> }> {
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: VERBOSE ? createLogger('info', name) : silentLogger, reconnect: false });
  const heard: { from: string; message: string }[] = [];
  conn.on('text', (p) => {
    heard.push({ from: (p.source_name ?? '').replace(/§./g, ''), message: p.message });
  });
  await conn.connect(CORE_TARGET);
  return {
    name,
    conn,
    heard,
    say: (msg) => {
      conn.queue('text', chatPacket(name, msg));
    },
    close: () => conn.disconnectAndFlush('test done'),
  };
}

// ---- the CLI ----------------------------------------------------------------------------------------

export interface CoreCli {
  name: string;
  child: ChildProcess;
  /** Everything the CLI logged so far (stderr + stdout). */
  output(): string;
  exit: Promise<number | null>;
  kill(): void;
}

/** `node src/index.ts --task afk ...` against bds-core (or `target`, decision 0059's e2e on bds-pve) with no config file and a temporary log dir. */
export function startCli(args: string[], name = uniqueName('CoreCli'), target: { host: string; port: number } = { host: CORE_HOST, port: CORE_PORT }): CoreCli {
  const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-core-'));
  const child = spawn(
    process.execPath,
    ['src/index.ts', '--task', 'afk', '--host', target.host, '--port', String(target.port), ...CLI_TARGET_ARGS, '--username', name, '--no-reconnect', '--log-dir', dir, ...args],
    { cwd: BOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  const take = (d: Buffer) => {
    out += d.toString();
    if (VERBOSE) process.stderr.write(d);
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);
  const exit = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve(code);
    }),
  );
  return {
    name,
    child,
    output: () => out,
    exit,
    kill: () => {
      if (child.exitCode === null) child.kill();
    },
  };
}

/** Wait until `name` is online (truth:ping players). */
export async function waitOnline(truth: PveTruth, name: string, timeoutMs = 30_000): Promise<void> {
  await until(async () => ((await truth.ok<{ players: string[] }>('ping')).players.includes(name) ? true : undefined), timeoutMs, `${name} online`, 250);
}
