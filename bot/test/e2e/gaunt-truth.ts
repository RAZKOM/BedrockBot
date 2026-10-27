// Helpers for the survival-policy e2e tests (wave 7, Track W: flee v2, trip readiness, sleeping;
// docs/pve.md "Flee" / "Trip readiness", docs/survival.md "Sleep") against bds-gaunt (udp/19188, flat
// world, DIFFICULTY normal, truth pack; docker/compose.gaunt.yml). Each test file runs the real afk
// task (tasks/registry.ts with every command registration, wired like the CLI) on its own connection
// with a unique name, in its own random area, and summons its mobs with a per-run tag that is removed
// again at the end.
//
// Env: GAUNT_BDS_HOST (127.0.0.1), GAUNT_BDS_PORT (19188), GAUNT_BDS_CONTAINER (bds-gaunt); game version
// and transport from env.ts; GAUNT_VERBOSE=1 logs the bot's lines.
import { randomInt } from 'node:crypto';
import { Chat, chatPacket, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import type { CommonTaskOptions } from '../../src/tasks/base.ts';
import { buildTaskContext } from '../../src/tasks/context.ts';
import { NightProcess } from '../../src/tasks/process/night.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { hdist, PveTruth, sleep, uniqueName, type PveBot } from './pve-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export { botDamage, centre, dist3, fill, fmt, hdist, sleep, teleport, tracked, uniqueName, until, type HurtRecord, type MobInfo } from './pve-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const GAUNT_HOST = process.env.GAUNT_BDS_HOST ?? '127.0.0.1';
export const GAUNT_PORT = Number(process.env.GAUNT_BDS_PORT ?? 19188);
export const GAUNT_CONTAINER = process.env.GAUNT_BDS_CONTAINER ?? 'bds-gaunt';
export const GAUNT_TARGET: ConnectTarget = bdsTarget(GAUNT_HOST, GAUNT_PORT);
export const VERBOSE = process.env.GAUNT_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

/** This run's private area: a cell of a 256-block grid starting at x, z = 24576 (8 x 8 cells). */
export function privateArea(): { x: number; z: number; cell: number } {
  const cell = randomInt(64);
  return { cell, x: 24576 + 256 * (cell % 8) + 128, z: 24576 + 256 * Math.floor(cell / 8) + 128 };
}

export function gauntCmd(...words: string[]): Promise<void> {
  return consoleCommand(GAUNT_CONTAINER, ...words);
}

/** Normal difficulty, frozen clock, no weather, no natural spawns, keep inventory. */
export async function prepareServer(opts: { time?: string; cycle?: boolean } = {}): Promise<void> {
  for (const c of [
    ['difficulty', 'normal'],
    ['gamerule', 'dodaylightcycle', opts.cycle ? 'true' : 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'doimmediaterespawn', 'false'],
    ['gamerule', 'keepinventory', 'true'],
    ['gamerule', 'naturalregeneration', 'true'],
    ['time', 'set', opts.time ?? 'midnight'],
    ['weather', 'clear'],
  ]) {
    await gauntCmd(...c);
  }
}

/** truth:* for these suites: the PvE commands plus food (surv.ts) and beds (gaunt.ts). */
export class GauntTruth extends PveTruth {
  food(name: string): Promise<{ food: number; saturation: number; health: number }> {
    return this.ok('food', [name]);
  }

  setFood(name: string, food: number, sat = 0): Promise<unknown> {
    return this.ok('setfood', [name, food, sat]);
  }

  bed(foot: Vec3, direction: number): Promise<{ foot: Vec3; head: Vec3 }> {
    return this.ok('bed', [foot.x, foot.y, foot.z, direction]);
  }

  sleeping(name: string): Promise<{ sleeping: boolean; location: Vec3; timeOfDay: number; day: number }> {
    return this.ok('sleeping', [name]);
  }

  time(t?: number | string): Promise<{ timeOfDay: number }> {
    return this.ok('time', t === undefined ? [] : [t]);
  }

  give(name: string, item: string, n = 1): Promise<unknown> {
    return this.ok('give', [name, item, n]);
  }

  uselog(since: number, who = '*'): Promise<{ now: number; events: { tick: number; kind: string; player: string; typeId: string | null }[] }> {
    return this.ok('uselog', [since, who]);
  }
}

export type GauntBot = Omit<PveBot, 'truth'> & { truth: GauntTruth; night: NightProcess | undefined };

/** Connect a bot running the afk task (walking on); `values` are the CLI values (`guard`, ...). */
export async function startGauntBot(prefix: string, options: Partial<CommonTaskOptions> = {}, extra: { owners?: string[]; values?: Record<string, unknown>; viewDistance?: number } = {}): Promise<GauntBot> {
  const name = uniqueName(prefix);
  const log = VERBOSE ? createLogger('info', name) : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: log, reconnect: false, ...(extra.viewDistance ? { viewDistance: extra.viewDistance } : {}) });
  const metrics = new Metrics();
  metrics.attach(conn);
  const chat = new Chat(conn, { log, owners: parseOwners(extra.owners ?? []), maxReplies: 50 });
  const common: CommonTaskOptions = { nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: true, respawnDelayMs: 1000, ...options };
  const ref: { task?: WalkingTask } = {};
  const built = buildTaskContext({
    name: 'afk',
    conn,
    metrics,
    chat,
    version: E2E_VERSION,
    options: common,
    // --no-config: waypoints and settings in memory only (never the user's config dir)
    values: { 'no-config': true, ...extra.values },
    logger: VERBOSE ? (scope) => createLogger('info', `${name}:${scope}`) : () => silentLogger,
    position: () => ref.task?.position(),
  });
  const t = afkTask.create(built.ctx) as WalkingTask;
  ref.task = t;
  if (!t.pve) throw new Error('afk task without the PvE controller (walking off?)');
  registerBuiltinCommands(chat, { conn, metrics, position: () => t.position(), extraStatus: () => t.statusLine?.() ?? { task: 'afk' }, quit: () => undefined });
  metrics.provide(() => ({ taskStatus: t.status() }));
  const truth = new GauntTruth(conn, GAUNT_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(GAUNT_TARGET);
  const mob = built.mobility!;
  await mob.world.waitForChunks(4, { timeoutMs: 30_000 });
  await mob.loop.waitTicks(10);
  const night = t.processes?.find('night').find((p): p is NightProcess => p instanceof NightProcess);
  return {
    name,
    conn,
    metrics,
    chat,
    task: t,
    pve: t.pve,
    built,
    truth,
    said,
    night,
    stop: async () => {
      t.stop();
      built.stop();
      chat.stop();
      await conn.disconnectAndFlush('test done');
    },
  };
}

/** A second, plain client (the "player"); tests move it with truth:tp. */
export async function connectPlayer(name: string, viewDistance?: number): Promise<{ name: string; conn: Connection; say(msg: string): void; close(): Promise<void> }> {
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: VERBOSE ? createLogger('info', name) : silentLogger, reconnect: false, ...(viewDistance ? { viewDistance } : {}) });
  await conn.connect(GAUNT_TARGET);
  return {
    name,
    conn,
    say: (msg) => {
      conn.queue('text', chatPacket(name, msg));
    },
    close: () => conn.disconnectAndFlush('test done'),
  };
}

/** Bot replies since index `from` that contain `s`. */
export function saidSince(bot: GauntBot, from: number, s: string): string | undefined {
  return bot.said.slice(from).find((m) => m.includes(s));
}

/** Truth position sampler: distance of the bot to a point / an entity every `everyMs`. */
export async function sampleUntil<T>(fn: () => Promise<T | undefined>, timeoutMs: number, everyMs = 250): Promise<{ value: T | undefined; ms: number }> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return { value: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { value: undefined, ms: Date.now() - t0 };
    await sleep(everyMs);
  }
}

export const horiz = hdist;
