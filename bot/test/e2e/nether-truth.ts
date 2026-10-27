// Helpers for the Nether / End e2e tests (wave 10, Track AT; docs/nether.md) against bds-nether
// (udp/19202, a generated DEFAULT world, seed 7, difficulty normal, truth pack with the dimension
// commands of packs/truth/src/nether.ts; docker/compose.nether.yml). Each test file runs the real afk
// task (tasks/registry.ts, wired by tasks/context.ts like the CLI) on its own connection with a unique
// name and in-memory settings and waypoints, a world cache of its own in a temp directory (removed at
// the end), in a random far-away area of each dimension.
//
// Env: NETHER_BDS_HOST (127.0.0.1), NETHER_BDS_PORT (19202), NETHER_BDS_CONTAINER (bds-nether); game
// version and transport from env.ts; NETHER_AREA="x,z" pins the overworld area; NETHER_VERBOSE=1 logs
// the bot's lines.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { RuntimeSettings, SETTINGS_VALUE_KEY } from '../../src/config/settings.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import type { CommonTaskOptions } from '../../src/tasks/base.ts';
import { buildTaskContext, type BuiltContext } from '../../src/tasks/context.ts';
import type { ProcessManager } from '../../src/tasks/process/manager.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { WorldCache } from '../../src/world/cache/index.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { PveTruth } from './pve-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const NETHER_HOST = process.env.NETHER_BDS_HOST ?? '127.0.0.1';
export const NETHER_PORT = Number(process.env.NETHER_BDS_PORT ?? 19202);
export const NETHER_CONTAINER = process.env.NETHER_BDS_CONTAINER ?? 'bds-nether';
export const NETHER_TARGET: ConnectTarget = bdsTarget(NETHER_HOST, NETHER_PORT);
export const VERBOSE = process.env.NETHER_VERBOSE === '1';

export type Dim = 'overworld' | 'nether' | 'the_end';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const hdist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A random overworld area far from spawn and from other runs (x, z in +-4 000 .. 20 000, 16-aligned); NETHER_AREA="x,z" pins it. Its Nether side is x / 8, z / 8. */
export function privateArea(): { x: number; z: number } {
  const pinned = process.env.NETHER_AREA?.split(',').map(Number);
  if (pinned?.length === 2 && pinned.every(Number.isFinite)) return { x: pinned[0]!, z: pinned[1]! };
  const one = () => (Math.random() < 0.5 ? -1 : 1) * 16 * Math.floor(250 + Math.random() * 1000);
  return { x: one(), z: one() };
}

export function netherCmd(...words: string[]): Promise<void> {
  return consoleCommand(NETHER_CONTAINER, ...words);
}

/** Normal difficulty, frozen clock at noon, no weather, no natural spawns, no fire spread, no fall damage (the teleports drop the bot). */
export async function prepareServer(): Promise<void> {
  for (const c of [
    ['difficulty', 'normal'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'dofiretick', 'false'],
    ['gamerule', 'falldamage', 'false'],
    ['gamerule', 'keepinventory', 'true'],
    ['gamerule', 'doimmediaterespawn', 'false'],
    ['time', 'set', 'noon'],
    ['weather', 'clear'],
  ]) {
    await netherCmd(...c);
  }
}

export interface NetherBot {
  name: string;
  conn: Connection;
  chat: Chat;
  task: WalkingTask;
  processes: ProcessManager;
  settings: RuntimeSettings;
  built: BuiltContext;
  cache: WorldCache;
  cacheDir: string;
  truth: PveTruth;
  said: string[];
  logs: string[];
  command(text: string): Promise<void>;
  reply(match: (s: string) => boolean, from: number, timeoutMs?: number): Promise<string>;
  stop(): Promise<void>;
}

function capture(scope: string, into: string[]) {
  const base = VERBOSE ? createLogger('info', scope) : silentLogger;
  const keep = (lvl: string) => (msg: string) => {
    into.push(`${scope} ${lvl} ${msg}`);
    if (into.length > 20_000) into.splice(0, 5_000);
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

/** Connect a bot running the afk task (walking on, wired like the CLI) with a world cache in a temp directory. */
export async function startNetherBot(prefix: string, options: Partial<CommonTaskOptions> = {}): Promise<NetherBot> {
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
    values: { 'no-config': true, [SETTINGS_VALUE_KEY]: settings },
    logger: (scope) => capture(`${name}:${scope}`, logs),
    position: () => ref.task?.position(),
  });
  const t = afkTask.create(built.ctx) as WalkingTask;
  ref.task = t;
  if (!t.pve || !t.processes) throw new Error('afk task without walking');
  const mob = built.mobility!;
  const cacheDir = mkdtempSync(join(tmpdir(), 'bb-nether-e2e-'));
  const cache = new WorldCache({ dir: cacheDir, flushIntervalMs: 30_000, logger: VERBOSE ? createLogger('info', 'cache') : silentLogger });
  cache.attach(mob.world);
  registerBuiltinCommands(chat, {
    conn,
    metrics,
    position: () => t.position(),
    extraStatus: () => t.statusLine?.() ?? { task: 'afk' },
    extraLines: () => t.processLines?.() ?? [],
    quit: () => undefined,
  });
  const truth = new PveTruth(conn, NETHER_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(NETHER_TARGET);
  await mob.world.waitForChunks(3, { timeoutMs: 60_000 });
  await mob.loop.waitTicks(10);
  return {
    name,
    conn,
    chat,
    task: t,
    processes: t.processes,
    settings,
    built,
    cache,
    cacheDir,
    truth,
    said,
    logs,
    command: (text) => netherCmd('tell', name, ...text.split(' ')),
    reply: (match, from, timeoutMs = 10_000) => until(() => said.slice(from).find(match), timeoutMs, `reply after line ${from} (said: ${said.slice(from).join(' | ')})`, 50),
    stop: async () => {
      t.stop();
      built.stop();
      chat.stop();
      cache.close();
      await conn.disconnectAndFlush('test done');
      rmSync(cacheDir, { recursive: true, force: true });
    },
  };
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

/** The bot's dimension by the server (truth:dimension). */
export async function truthDimension(bot: NetherBot): Promise<{ dimension: Dim; location: Vec3 }> {
  return bot.truth.ok<{ dimension: Dim; location: Vec3 }>('dimension', [bot.name]);
}

/** A truth command in a dimension that needs loaded chunks: retried while they are not loaded yet (30 s). */
export async function truthRetry<T>(bot: NetherBot, cmd: string, args: (string | number)[], timeoutMs = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const r = await bot.truth.cmd<T>(cmd, args, 30_000);
    if (r.ok) return r.data;
    if (r.reason !== 'unloaded_chunk' || Date.now() - t0 > timeoutMs) throw new Error(`truth:${cmd} ${args.join(' ')} failed: ${r.reason ?? '?'} ${JSON.stringify(r.data)}`);
    await sleep(500);
  }
}

/** Fill a box in a dimension (several dfill calls of at most 32 768 blocks, y slabs). */
export async function dfill(bot: NetherBot, dim: Dim, a: Vec3, b: Vec3, block: string): Promise<void> {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const z0 = Math.min(a.z, b.z);
  const z1 = Math.max(a.z, b.z);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const layer = (x1 - x0 + 1) * (z1 - z0 + 1);
  const slab = Math.max(1, Math.floor(32768 / layer));
  for (let y = y0; y <= y1; y += slab) await truthRetry(bot, 'dfill', [dim, x0, y, z0, x1, Math.min(y1, y + slab - 1), z1, block]);
}

/** Teleport across dimensions (truth:dimtp) and wait until the world model and the input loop are there, then the chunks around. */
export async function dimTeleport(bot: NetherBot, dim: Dim, feet: Vec3, yaw = 0): Promise<void> {
  const mob = bot.built.mobility!;
  mob.skills.cancel();
  const id = dim === 'overworld' ? 0 : dim === 'nether' ? 1 : 2;
  await bot.truth.ok('dimtp', [bot.name, dim, feet.x, feet.y, feet.z, yaw]);
  await until(() => (mob.world.self.dimension === id && !mob.world.dimensions.changing ? true : undefined), 30_000, `dimension ${dim}`);
  await until(() => {
    const p = bot.task.position();
    return p && hdist(p, feet) < 0.6 && Math.abs(p.y - feet.y) < 2 ? true : undefined;
  }, 20_000, `position ${feet.x} ${feet.y} ${feet.z} in the ${dim}`);
  await mob.loop.waitTicks(10);
  await mob.world.waitForChunks(2, { center: feet, timeoutMs: 60_000 });
}

/** Teleport within the current dimension (truth:tp) and wait for the input loop and the chunks. */
export async function teleport(bot: NetherBot, feet: Vec3, yaw = 0): Promise<void> {
  const mob = bot.built.mobility!;
  mob.skills.cancel();
  await bot.truth.tp(bot.name, feet, yaw, 0);
  await until(() => {
    const p = bot.task.position();
    return p && hdist(p, feet) < 0.1 && Math.abs(p.y - feet.y) < 1 ? true : undefined;
  }, 20_000, `position ${feet.x} ${feet.y} ${feet.z}`);
  await mob.loop.waitTicks(10);
  await mob.world.waitForChunks(2, { center: feet, timeoutMs: 60_000 });
}

/** Hurt events of the bot since a server tick (truth:hurtlog). */
export async function hurtsSince(bot: NetherBot, tick: number): Promise<{ damage: number; cause: string }[]> {
  const r = await bot.truth.ok<{ events: { damage: number; cause: string }[] }>('hurtlog', [tick, bot.name]);
  return r.events;
}

/** The server tick now (truth:ping). */
export async function serverTick(bot: NetherBot): Promise<number> {
  return (await bot.truth.ok<{ tick: number }>('ping', [])).tick;
}
