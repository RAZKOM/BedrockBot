// Helpers for the explore and branch-mining e2e tests (wave 9, Track AI; docs/explore.md) against
// bds-explore (udp/19198, a generated DEFAULT world, seed 7, peaceful, truth pack; docker/compose.explore.yml).
// Each test file runs the real afk task (tasks/registry.ts, wired by tasks/context.ts like the CLI)
// on its own connection with a unique name and in-memory settings, with a world cache of its own in a
// temp directory (removed at the end), in a random far-away area of the generated world.
//
// Env: EXPLORE_BDS_HOST (127.0.0.1), EXPLORE_BDS_PORT (19198), EXPLORE_BDS_CONTAINER (bds-explore);
// game version and transport from env.ts; EXPLORE_AREA="x,z" pins the area; EXPLORE_VERBOSE=1 logs
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
import { classify } from '../../src/skills/terrain/classify.ts';
import type { CommonTaskOptions } from '../../src/tasks/base.ts';
import { buildTaskContext, type BuiltContext } from '../../src/tasks/context.ts';
import type { ProcessManager } from '../../src/tasks/process/manager.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { WorldCache } from '../../src/world/cache/index.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { PveTruth } from './pve-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const EXPLORE_HOST = process.env.EXPLORE_BDS_HOST ?? '127.0.0.1';
export const EXPLORE_PORT = Number(process.env.EXPLORE_BDS_PORT ?? 19198);
export const EXPLORE_CONTAINER = process.env.EXPLORE_BDS_CONTAINER ?? 'bds-explore';
export const EXPLORE_TARGET: ConnectTarget = bdsTarget(EXPLORE_HOST, EXPLORE_PORT);
export const VERBOSE = process.env.EXPLORE_VERBOSE === '1';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const hdist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A random area far from spawn and from other runs (x, z in +-2 000 .. 9 000, chunk-aligned); EXPLORE_AREA="x,z" pins it. */
export function privateArea(): { x: number; z: number } {
  const pinned = process.env.EXPLORE_AREA?.split(',').map(Number);
  if (pinned?.length === 2 && pinned.every(Number.isFinite)) return { x: pinned[0]!, z: pinned[1]! };
  const one = () => (Math.random() < 0.5 ? -1 : 1) * 16 * Math.floor(125 + Math.random() * 437);
  return { x: one(), z: one() };
}

export function exploreCmd(...words: string[]): Promise<void> {
  return consoleCommand(EXPLORE_CONTAINER, ...words);
}

/** Peaceful, frozen clock at noon, no weather, no natural spawns, no fall damage (the hops drop the bot from y 320). */
export async function prepareServer(): Promise<void> {
  for (const c of [
    ['difficulty', 'peaceful'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'falldamage', 'false'],
    ['gamerule', 'dotiledrops', 'true'],
    ['time', 'set', 'noon'],
    ['weather', 'clear'],
  ]) {
    await exploreCmd(...c);
  }
}

export interface ExploreBot {
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
  /** The bot's chat lines (its replies), newest last. */
  said: string[];
  /** Log lines of every scope, newest last. */
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
export async function startExploreBot(prefix: string, options: Partial<CommonTaskOptions> = {}, extra: { settings?: Record<string, string> } = {}): Promise<ExploreBot> {
  const name = uniqueName(prefix);
  const log = VERBOSE ? createLogger('info', name) : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: log, reconnect: false });
  const metrics = new Metrics();
  metrics.attach(conn);
  const chat = new Chat(conn, { log, owners: parseOwners([]), maxReplies: 50 });
  const common: CommonTaskOptions = { nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: true, respawnDelayMs: 1000, ...options };
  const settings = new RuntimeSettings();
  for (const [k, v] of Object.entries(extra.settings ?? {})) settings.set(k as Parameters<RuntimeSettings['set']>[0], v);
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
  const cacheDir = mkdtempSync(join(tmpdir(), 'bb-explore-e2e-'));
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
  const truth = new PveTruth(conn, EXPLORE_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(EXPLORE_TARGET);
  await mob.world.waitForChunks(4, { timeoutMs: 60_000 });
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
    command: (text) => exploreCmd('tell', name, ...text.split(' ')),
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

/** Teleport (truth:tp) and wait until the input loop adopted the position; then the chunks around. */
export async function teleport(bot: ExploreBot, feet: Vec3, yaw = 0, radius = 3): Promise<void> {
  const mob = bot.built.mobility!;
  bot.built.mobility!.skills.cancel();
  await bot.truth.tp(bot.name, feet, yaw, 0);
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const p = bot.task.position();
    if (p && hdist(p, feet) < 0.05 && Math.abs(p.y - feet.y) < 1) break;
    await sleep(50);
  }
  await mob.loop.waitTicks(20);
  await mob.world.waitForChunks(radius, { center: feet, timeoutMs: 60_000 });
}

/** The feet cell on top of column (x, z) when it is dry land (not water, leaves or a hazard), from loaded blocks. */
export function landFeet(bot: ExploreBot, x: number, z: number): number | undefined {
  const mob = bot.built.mobility!;
  const grid = mob.skills.nav.grid;
  const top = grid.source.columnTop?.(x, z);
  if (top === undefined) return undefined;
  for (let y = top; y > -64; y--) {
    const b = mob.world.blockAt({ x, y, z });
    if (!b) return undefined;
    const c = classify(b);
    if (c.boxes.length === 0 && !c.liquid && !c.danger) continue;
    if (c.liquid || c.leaves || c.danger) return undefined;
    for (const cy of [y, y + 1]) {
      const f = grid.stand(x, cy, z);
      if (f !== undefined && !Number.isNaN(f)) return cy;
    }
    return undefined;
  }
  return undefined;
}

/** Teleport high over (x, z), wait for the chunks, then onto the nearest dry land within 12 blocks. */
export async function standNear(bot: ExploreBot, x: number, z: number, yaw = 0): Promise<Vec3 | undefined> {
  await teleport(bot, { x: x + 0.5, y: 320, z: z + 0.5 }, yaw, 4);
  for (let d = 0; d <= 12; d++) {
    for (let dx = -d; dx <= d; dx++) {
      for (let dz = -d; dz <= d; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
        const y = landFeet(bot, x + dx, z + dz);
        if (y === undefined) continue;
        const feet = { x: x + dx, y, z: z + dz };
        await teleport(bot, { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }, yaw, 4);
        return feet;
      }
    }
  }
  return undefined;
}

/** truth:find over a box (the pack's job scan), e.g. `iron_ore` (matches the deepslate one too), `water`, `lava`. */
export async function truthFind(truth: PveTruth, a: Vec3, b: Vec3, pattern: string, max = 4096): Promise<{ count: number; positions: number[][]; byType: Record<string, number> }> {
  const t0 = Date.now();
  for (;;) {
    const r = await truth.cmd<{ count: number; positions: number[][]; byType: Record<string, number> }>('find', [a.x, a.y, a.z, b.x, b.y, b.z, pattern, max], 60_000);
    if (r.ok) return r.data;
    if (r.reason !== 'unloaded_chunk' || Date.now() - t0 > 30_000) throw new Error(`truth:find ${pattern} failed: ${r.reason}`);
    await sleep(500);
  }
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

/** The player's inventory item counts (truth:inv), names without the namespace. */
export async function invCounts(truth: PveTruth, name: string): Promise<Record<string, number>> {
  const inv = await truth.ok<{ counts: Record<string, number> }>('inv', [name]);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(inv.counts)) out[k.replace(/^minecraft:/, '')] = v;
  return out;
}
