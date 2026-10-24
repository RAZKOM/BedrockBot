// Helpers for the food-gathering e2e tests (PLAN.md 7.16, Track X; docs/food.md) against bds-food
// (udp/19190, flat world, DIFFICULTY easy, truth pack; docker/compose.food.yml). Each test file runs
// the real afk task (tasks/registry.ts, wired by tasks/context.ts like the CLI, with the CLI's
// !status / !goto / !home) on its own connection with a unique name, in its own random area, and
// summons its mobs with a per-run tag that is removed at the end.
//
// Env: FOOD_BDS_HOST (127.0.0.1), FOOD_BDS_PORT (19190), FOOD_BDS_CONTAINER (bds-food); game version
// and transport from env.ts (BOT_VERSION, BDS_TRANSPORT); FOOD_VERBOSE=1 logs the bot's lines.
import { randomInt } from 'node:crypto';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
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
import { bdsTarget, E2E_VERSION } from './env.ts';
import { PveTruth } from './pve-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const FOOD_HOST = process.env.FOOD_BDS_HOST ?? '127.0.0.1';
export const FOOD_PORT = Number(process.env.FOOD_BDS_PORT ?? 19190);
export const FOOD_CONTAINER = process.env.FOOD_BDS_CONTAINER ?? 'bds-food';
export const FOOD_TARGET: ConnectTarget = bdsTarget(FOOD_HOST, FOOD_PORT);
export const VERBOSE = process.env.FOOD_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const hdist = (a: Vec3, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
export const centre = (p: Vec3): Vec3 => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y), z: Math.floor(p.z) + 0.5 });

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** This run's private area: a cell of a 256-block grid starting at x, z = 20480 (8 x 8 cells). */
export function privateArea(): { x: number; z: number; cell: number } {
  const cell = randomInt(64);
  return { cell, x: 20480 + 256 * (cell % 8) + 128, z: 20480 + 256 * Math.floor(cell / 8) + 128 };
}

export function foodCmd(...words: string[]): Promise<void> {
  return consoleCommand(FOOD_CONTAINER, ...words);
}

/** Easy difficulty, frozen clock at noon (the auto trigger runs by day), no weather, no natural spawns. */
export async function prepareServer(opts: { time?: string } = {}): Promise<void> {
  for (const c of [
    ['difficulty', 'easy'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'doimmediaterespawn', 'false'],
    ['gamerule', 'keepinventory', 'true'],
    ['time', 'set', opts.time ?? 'noon'],
    ['weather', 'clear'],
  ]) {
    await foodCmd(...c);
  }
}

export interface FurnaceSlot {
  slot: number;
  typeId: string;
  amount: number;
}

export interface HerdMob {
  entityId: string;
  typeId: string;
  baby: boolean;
  location: Vec3;
  tags: string[];
}

/** truth:* for food (packs/truth/src/food.ts) on top of the PvE commands (summon with a run tag, cleanup). */
export class FoodTruth extends PveTruth {
  furnace(p: Vec3): Promise<{ typeId: string; lit: boolean; size: number; slots: (FurnaceSlot | null)[] }> {
    return this.ok('furnace', [p.x, p.y, p.z]);
  }

  setFurnace(p: Vec3, slot: number, typeId: string, n = 1): Promise<unknown> {
    return this.ok('setfurnace', [p.x, p.y, p.z, slot, typeId, n]);
  }

  /** This run's food mobs within r (summoned with the run tag). */
  async herd(at: Vec3, r: number): Promise<HerdMob[]> {
    return (await this.ok<{ mobs: HerdMob[] }>('herd', [at.x, at.y, at.z, r, this.runTag])).mobs;
  }

  pen(p: Vec3, w: number, d: number): Promise<{ from: Vec3; to: Vec3; gate: Vec3 }> {
    return this.ok('pen', [p.x, p.y, p.z, w, d]);
  }

  async counts(name: string): Promise<Record<string, number>> {
    const inv = await this.ok<{ counts: Record<string, number> }>('inv', [name]);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(inv.counts)) out[k.replace(/^minecraft:/, '')] = v;
    return out;
  }
}

export interface FoodBot {
  name: string;
  conn: Connection;
  metrics: Metrics;
  chat: Chat;
  task: WalkingTask;
  pve: PveController;
  processes: ProcessManager;
  settings: RuntimeSettings;
  built: BuiltContext;
  truth: FoodTruth;
  /** The bot's chat lines (its replies), newest last. */
  said: string[];
  /** Send a command as the console (an owner): `tell <bot> !...`. */
  command(text: string): Promise<void>;
  /** Wait for a reply (after `from` lines) that matches. */
  reply(match: (s: string) => boolean, from: number, timeoutMs?: number): Promise<string>;
  stop(): Promise<void>;
}

/** Connect a bot running the afk task (walking on), wired like the CLI (index.ts). */
export async function startFoodBot(prefix: string, options: Partial<CommonTaskOptions> = {}, extra: { values?: Record<string, unknown>; settings?: RuntimeSettings } = {}): Promise<FoodBot> {
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
  registerHardeningCommands(chat, {
    health: () => ({ health: built.respawn?.health ?? null, deaths: built.respawn?.deaths ?? 0, dead: built.respawn?.dead ?? false, healthy: true }),
    shelter: t.shelter,
    home: t.home,
    goto: t.goto ? (p) => t.goto!(p) : undefined,
    position: () => t.position(),
  });
  metrics.provide(() => ({ taskStatus: t.status() }));
  const truth = new FoodTruth(conn, FOOD_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(FOOD_TARGET);
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
    command: (text) => foodCmd('tell', name, ...text.split(' ')),
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
export async function teleport(bot: FoodBot, feet: Vec3): Promise<void> {
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
export async function clearArea(truth: PveTruth, c: Vec3, r: number, h = 6): Promise<void> {
  await truthLoaded(truth, 'fill', [c.x - r, FEET_Y - 2, c.z - r, c.x + r, FEET_Y - 2, c.z + r, 'dirt']);
  await truthLoaded(truth, 'fill', [c.x - r, FEET_Y - 1, c.z - r, c.x + r, FEET_Y - 1, c.z + r, 'grass_block']);
  await truthLoaded(truth, 'fill', [c.x - r, FEET_Y, c.z - r, c.x + r, FEET_Y + h, c.z + r, 'air']);
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
