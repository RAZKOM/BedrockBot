// Helpers for the Phase 5 hardening e2e tests (PLAN.md tasks 5.1 and 5.2) against bds-hard
// (udp/19154, flat world, truth pack; docker/compose.hard.yml). Each test file runs the real afk task
// (tasks/registry.ts afkTask, wired by tasks/context.ts exactly like the CLI) on its own connection
// with a unique name, and asks the truth pack (packs/truth) for ground truth.
//
// Env: HARD_BDS_HOST (127.0.0.1), HARD_BDS_PORT (19154), HARD_BDS_CONTAINER (bds-hard); game version
// and transport from env.ts (BOT_VERSION, BDS_TRANSPORT); HARD_VERBOSE=1 logs the bot's lines.
import { Chat } from '../../src/chat/chat.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import type { CommonTaskOptions } from '../../src/tasks/base.ts';
import { buildTaskContext, type BuiltContext } from '../../src/tasks/context.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { Truth, consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const HARD_HOST = process.env.HARD_BDS_HOST ?? '127.0.0.1';
export const HARD_PORT = Number(process.env.HARD_BDS_PORT ?? 19154);
export const HARD_CONTAINER = process.env.HARD_BDS_CONTAINER ?? 'bds-hard';
export const HARD_TARGET: ConnectTarget = bdsTarget(HARD_HOST, HARD_PORT);
export const VERBOSE = process.env.HARD_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const hdist = (a: Vec3, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
export const fmt = (v: Vec3): string => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
/** Centre of a feet block. */
export const centre = (p: Vec3): Vec3 => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y), z: Math.floor(p.z) + 0.5 });

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

export function hardCmd(...words: string[]): Promise<void> {
  return consoleCommand(HARD_CONTAINER, ...words);
}

/** Noon, frozen clock, no weather; difficulty peaceful unless given. */
export async function prepareServer(difficulty = 'peaceful'): Promise<void> {
  for (const c of [
    ['difficulty', difficulty],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', difficulty === 'peaceful' ? 'false' : 'true'],
    ['gamerule', 'doimmediaterespawn', 'false'],
    ['gamerule', 'keepinventory', 'true'],
    ['time', 'set', 'noon'],
    ['weather', 'clear'],
    ['kill', '@e[type=!player]'],
  ]) {
    await hardCmd(...c);
  }
}

export interface HardBot {
  name: string;
  conn: Connection;
  metrics: Metrics;
  chat: Chat;
  task: WalkingTask;
  built: BuiltContext;
  truth: Truth;
  stop(): Promise<void>;
}

/** Connect a bot running the afk task with the given options (home, shelter, walk, ...). */
export async function startAfkBot(prefix: string, options: Partial<CommonTaskOptions>): Promise<HardBot> {
  const name = uniqueName(prefix);
  const log = VERBOSE ? createLogger('info', name) : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: log, reconnect: false });
  const metrics = new Metrics();
  metrics.attach(conn);
  const chat = new Chat(conn, { log });
  const common: CommonTaskOptions = { nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: true, respawnDelayMs: 1000, ...options };
  const ref: { task?: WalkingTask } = {};
  const built = buildTaskContext({
    name: 'afk',
    conn,
    metrics,
    chat,
    version: E2E_VERSION,
    options: common,
    logger: VERBOSE ? (scope) => createLogger('info', `${name}:${scope}`) : () => silentLogger,
    position: () => ref.task?.position(),
  });
  const t = afkTask.create(built.ctx) as WalkingTask;
  ref.task = t;
  metrics.provide(() => ({ taskStatus: t.status() }));
  const truth = new Truth(conn, HARD_CONTAINER);
  await t.start();
  chat.start();
  await conn.connect(HARD_TARGET);
  const mob = built.mobility;
  if (mob) {
    await mob.world.waitForChunks(4, { timeoutMs: 30_000 });
    await mob.loop.waitTicks(10);
  }
  return {
    name,
    conn,
    metrics,
    chat,
    task: t,
    built,
    truth,
    stop: async () => {
      t.stop();
      built.stop();
      chat.stop();
      await conn.disconnectAndFlush('test done');
    },
  };
}

/** Teleport the bot (truth:tp) and wait until its input loop adopted the position. */
export async function teleport(bot: HardBot, feet: Vec3): Promise<void> {
  const mob = bot.built.mobility;
  await bot.truth.tp(bot.name, feet, 0, 0);
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const p = bot.task.position();
    if (p && hdist(p, feet) < 0.05) break;
    await sleep(50);
  }
  if (mob) {
    await mob.loop.waitTicks(20);
    await mob.world.waitForChunks(3, { center: feet, timeoutMs: 20_000 });
  }
}

/** truth:fill with retries while the chunk is not loaded yet. */
export async function fill(bot: HardBot, from: Vec3, to: Vec3, block: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const r = await bot.truth.cmd('fill', [from.x, from.y, from.z, to.x, to.y, to.z, block], 30_000);
    if (r.ok) return;
    if (r.reason !== 'unloaded_chunk' || attempt >= 10) throw new Error(`truth:fill failed: ${r.reason} ${JSON.stringify(r.data)}`);
    await sleep(500);
  }
}

/**
 * A 3 x 3 hut of oak planks (walls and roof) whose inside is the 1-block column at `inside`, open on
 * the -z side (a 1 x 2 door), or sealed when `sealed`. Returns when the world model shows the roof.
 */
export async function buildHut(bot: HardBot, inside: Vec3, sealed = false): Promise<void> {
  const { x, y, z } = inside;
  await fill(bot, { x: x - 1, y, z: z - 1 }, { x: x + 1, y: y + 2, z: z + 1 }, 'oak_planks');
  await fill(bot, { x, y, z }, { x, y: y + 1, z }, 'air');
  if (!sealed) await fill(bot, { x, y, z: z - 1 }, { x, y: y + 1, z: z - 1 }, 'air');
  const world = bot.built.mobility?.world;
  const t0 = Date.now();
  while (world && world.blockAt({ x, y: y + 2, z })?.name !== 'oak_planks' && Date.now() - t0 < 5000) await sleep(50);
  await sleep(200);
}

export async function clearArea(bot: HardBot, from: Vec3, to: Vec3): Promise<void> {
  await fill(bot, from, to, 'air');
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
