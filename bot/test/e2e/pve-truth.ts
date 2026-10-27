// Helpers for the PvE / follow e2e tests (PLAN.md tasks 7.4 to 7.6, docs/pve.md) against bds-pve
// (udp/19144, flat world, DIFFICULTY normal, truth pack; docker/compose.pve.yml). Each test file runs
// the real afk task (tasks/registry.ts, wired by tasks/context.ts like the CLI) on its own connection
// with a unique name, in its own random area far from other runs, and summons its mobs with a per-run
// tag that is removed again at the end.
//
// Env: PVE_BDS_HOST (127.0.0.1), PVE_BDS_PORT (19144), PVE_BDS_CONTAINER (bds-pve); game version and
// transport from env.ts (BOT_VERSION, BDS_TRANSPORT); PVE_VERBOSE=1 logs the bot's lines.
import { randomInt } from 'node:crypto';
import { Chat, chatPacket, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import type { CommonTaskOptions } from '../../src/tasks/base.ts';
import { buildTaskContext, type BuiltContext } from '../../src/tasks/context.ts';
import type { PveController } from '../../src/tasks/pve.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { Truth, consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const PVE_HOST = process.env.PVE_BDS_HOST ?? '127.0.0.1';
export const PVE_PORT = Number(process.env.PVE_BDS_PORT ?? 19144);
export const PVE_CONTAINER = process.env.PVE_BDS_CONTAINER ?? 'bds-pve';
export const PVE_TARGET: ConnectTarget = bdsTarget(PVE_HOST, PVE_PORT);
export const VERBOSE = process.env.PVE_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const hdist = (a: Vec3, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
export const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const fmt = (v: Vec3): string => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
export const centre = (p: Vec3): Vec3 => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y), z: Math.floor(p.z) + 0.5 });

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** This run's private area: a cell of a 256-block grid starting at x, z = 8192 (8 x 8 cells). */
export function privateArea(): { x: number; z: number; cell: number } {
  const cell = randomInt(64);
  return { cell, x: 8192 + 256 * (cell % 8) + 128, z: 8192 + 256 * Math.floor(cell / 8) + 128 };
}

export function pveCmd(...words: string[]): Promise<void> {
  return consoleCommand(PVE_CONTAINER, ...words);
}

/** Normal difficulty, frozen clock at midnight (no burning zombies), no weather, no natural spawns. */
export async function prepareServer(opts: { time?: string; spawning?: boolean } = {}): Promise<void> {
  for (const c of [
    ['difficulty', 'normal'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', opts.spawning ? 'true' : 'false'],
    ['gamerule', 'doimmediaterespawn', 'false'],
    ['gamerule', 'keepinventory', 'true'],
    ['gamerule', 'naturalregeneration', 'true'],
    ['time', 'set', opts.time ?? 'midnight'],
    ['weather', 'clear'],
  ]) {
    await pveCmd(...c);
  }
}

export interface MobInfo {
  entityId: string;
  typeId: string;
  name: string | null;
  location: Vec3;
  health: number | null;
  tags: string[];
  valid?: boolean;
}

export interface HurtRecord {
  tick: number;
  victimId: string;
  victimType: string;
  victimName: string | null;
  damage: number;
  cause: string;
  damagerId: string | null;
  damagerType: string | null;
  damagerName: string | null;
  healthAfter: number | null;
}

/** truth:* PvE commands (packs/truth/src/pve.ts). */
export class PveTruth extends Truth {
  /** Tag on every mob this run summons. */
  readonly runTag = `pve${Math.random().toString(36).slice(2, 8)}`;

  summon(type: string, at: Vec3): Promise<MobInfo> {
    return this.ok<MobInfo>('summon', [type, at.x, at.y, at.z, this.runTag]);
  }

  entity(id: string): Promise<MobInfo> {
    return this.ok<MobInfo>('entity', [id]);
  }

  async mobs(type?: string): Promise<MobInfo[]> {
    return (await this.ok<{ mobs: MobInfo[] }>('mobs', type ? [this.runTag, type] : [this.runTag])).mobs;
  }

  async near(at: Vec3, r: number): Promise<MobInfo[]> {
    return (await this.ok<{ mobs: MobInfo[] }>('near', [at.x, at.y, at.z, r])).mobs;
  }

  async hurtlog(since: number, who = '*'): Promise<{ now: number; events: HurtRecord[] }> {
    return this.ok<{ now: number; events: HurtRecord[] }>('hurtlog', [since, who], 20_000);
  }

  async now(): Promise<number> {
    return (await this.hurtlog(Number.MAX_SAFE_INTEGER)).now;
  }

  setHealth(ref: string, value: number): Promise<unknown> {
    return this.ok('sethealth', [ref, value]);
  }

  moveMob(id: string, to: Vec3): Promise<unknown> {
    return this.ok('movemob', [id, to.x, to.y, to.z]);
  }

  effect(ref: string, effect: string, seconds: number, amplifier = 0): Promise<unknown> {
    return this.ok('effect', [ref, effect, seconds, amplifier]);
  }

  /** Remove this run's summoned mobs (no drops). */
  async cleanup(): Promise<number> {
    return (await this.ok<{ removed: number }>('killmobs', [this.runTag])).removed;
  }

  /** Remove every non-player entity (mobs, drops, arrows) within r of `at`. */
  async clearAround(at: Vec3, r: number): Promise<number> {
    return (await this.ok<{ removed: number }>('clearmobs', [at.x, at.y, at.z, r])).removed;
  }
}

export interface PveBot {
  name: string;
  conn: Connection;
  metrics: Metrics;
  chat: Chat;
  task: WalkingTask;
  pve: PveController;
  built: BuiltContext;
  truth: PveTruth;
  /** Bot chat lines (its replies), newest last. */
  said: string[];
  stop(): Promise<void>;
}

/** Connect a bot running the afk task (walking on) with the given options; `owners` may use commands. */
export async function startPveBot(prefix: string, options: Partial<CommonTaskOptions> = {}, extra: { owners?: string[]; values?: Record<string, unknown> } = {}): Promise<PveBot> {
  const name = uniqueName(prefix);
  const log = VERBOSE ? createLogger('info', name) : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: log, reconnect: false });
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
    values: { 'no-config': true, ...(extra.values ?? {}) }, // waypoints and settings in memory only (never the user's config dir)
    logger: VERBOSE ? (scope) => createLogger('info', `${name}:${scope}`) : () => silentLogger,
    position: () => ref.task?.position(),
  });
  const t = afkTask.create(built.ctx) as WalkingTask;
  ref.task = t;
  if (!t.pve) throw new Error('afk task without the PvE controller (walking off?)');
  // !status / !pos / !help as the CLI registers them (bot/src/index.ts)
  registerBuiltinCommands(chat, { conn, metrics, position: () => t.position(), extraStatus: () => t.statusLine?.() ?? { task: 'afk' }, quit: () => undefined });
  metrics.provide(() => ({ taskStatus: t.status() }));
  const truth = new PveTruth(conn, PVE_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(PVE_TARGET);
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
    built,
    truth,
    said,
    stop: async () => {
      t.stop();
      built.stop();
      chat.stop();
      await conn.disconnectAndFlush('test done');
    },
  };
}

/**
 * A second, plain client (a "player" the bot can follow or come to; `name` from uniqueName). It never
 * moves by itself: tests move it with truth:tp.
 */
export async function connectPlayer(name: string): Promise<{ name: string; conn: Connection; say(msg: string): void; close(): Promise<void> }> {
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: VERBOSE ? createLogger('info', name) : silentLogger, reconnect: false });
  await conn.connect(PVE_TARGET);
  return {
    name,
    conn,
    say: (msg) => {
      conn.queue('text', chatPacket(name, msg));
    },
    close: () => conn.disconnectAndFlush('test done'),
  };
}

/** Teleport the bot (truth:tp) and wait until its input loop adopted the position and chunks loaded. */
export async function teleport(bot: PveBot, feet: Vec3): Promise<void> {
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

/** truth:fill with retries while the chunk is not loaded yet. */
export async function fill(bot: PveBot, from: Vec3, to: Vec3, block: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const r = await bot.truth.cmd('fill', [from.x, from.y, from.z, to.x, to.y, to.z, block], 30_000);
    if (r.ok) return;
    if (r.reason !== 'unloaded_chunk' || attempt >= 10) throw new Error(`truth:fill failed: ${r.reason} ${JSON.stringify(r.data)}`);
    await sleep(500);
  }
}

/** Give the bot exactly one iron sword in slot 0 (inventory cleared first). */
export async function armWithIronSword(bot: PveBot): Promise<void> {
  await bot.truth.ok('clear', [bot.name]);
  await bot.truth.ok('give', [bot.name, 'iron_sword', 1]);
  const inv = bot.built.mobility!.world.inventory;
  await until(() => (inv.slots.some((s) => s?.name === 'iron_sword') ? true : undefined), 5_000, 'iron sword in the inventory model');
}

/** Wait until the bot's world model tracks the summoned mob (by unique id = the Script API entity id). */
export async function tracked(bot: PveBot, mob: MobInfo): Promise<bigint> {
  const uid = BigInt(mob.entityId);
  return until(() => {
    for (const e of bot.built.mobility!.world.entities.values()) if (e.uniqueId === uid) return e.runtimeId;
    return undefined;
  }, 10_000, `tracked ${mob.typeId} ${mob.entityId}`, 50);
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

/** Server-side hurt events of `victimId` caused by the bot (melee, `entityAttack`) since `since`. */
export function botHits(events: HurtRecord[], botName: string, victimId?: string): HurtRecord[] {
  return events.filter((h) => h.damagerName === botName && h.cause === 'entityAttack' && (victimId === undefined || h.victimId === victimId));
}

/** Damage the bot itself took since `since`, by cause. */
export function botDamage(events: HurtRecord[], botName: string): { total: number; byCause: Record<string, number>; byDamager: Record<string, number> } {
  const byCause: Record<string, number> = {};
  const byDamager: Record<string, number> = {};
  let total = 0;
  for (const h of events) {
    if (h.victimName !== botName) continue;
    total += h.damage;
    byCause[h.cause] = (byCause[h.cause] ?? 0) + h.damage;
    const k = h.damagerType ?? '-';
    byDamager[k] = (byDamager[k] ?? 0) + h.damage;
  }
  return { total: +total.toFixed(2), byCause, byDamager };
}
