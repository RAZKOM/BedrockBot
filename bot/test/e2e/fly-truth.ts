// Helpers for the Elytra flight e2e tests (wave 11, Track AU; docs/flight.md) against bds-fly
// (udp/19204, FLAT world, difficulty peaceful, fall damage ON, truth pack with the flight commands
// of packs/truth/src/fly.ts: glide, glidelog, equip, boxdrop; docker/compose.fly.yml). Each test file
// runs the real afk task (tasks/registry.ts, wired by tasks/context.ts like the CLI) on its own
// connection with a unique name and in-memory settings, in a random private area far from spawn, and
// gives the bot its flight kit with the truth pack: an elytra, a chestplate, firework rockets (flight
// duration 1) and a shulker box of rockets (truth:boxdrop drops it as an item, the bot picks it up).
//
// Env: FLY_BDS_HOST (127.0.0.1), FLY_BDS_PORT (19204), FLY_BDS_CONTAINER (bds-fly); game version and
// transport from env.ts (BOT_VERSION, BDS_TRANSPORT); FLY_AREA="x,z" pins the area; FLY_VERBOSE=1 logs
// the bot's lines.
import { randomInt } from 'node:crypto';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { flyControlOf, type FlyControl } from '../../src/chat/commands-fly.ts';
import { RuntimeSettings, SETTINGS_VALUE_KEY } from '../../src/config/settings.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import type { CommonTaskOptions } from '../../src/tasks/base.ts';
import { buildTaskContext, type BuiltContext } from '../../src/tasks/context.ts';
import type { ProcessManager } from '../../src/tasks/process/manager.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { PveTruth, type HurtRecord } from './pve-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const FLY_HOST = process.env.FLY_BDS_HOST ?? '127.0.0.1';
export const FLY_PORT = Number(process.env.FLY_BDS_PORT ?? 19204);
export const FLY_CONTAINER = process.env.FLY_BDS_CONTAINER ?? 'bds-fly';
export const FLY_TARGET: ConnectTarget = bdsTarget(FLY_HOST, FLY_PORT);
export const VERBOSE = process.env.FLY_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const hdist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** This run's private area: a cell of a 1024-block grid from x, z = 60 000 (16 x 16 cells); FLY_AREA="x,z" pins it. */
export function privateArea(): { x: number; z: number; cell: number } {
  const pinned = process.env.FLY_AREA?.split(',').map(Number);
  if (pinned?.length === 2 && pinned.every(Number.isFinite)) return { x: pinned[0]!, z: pinned[1]!, cell: -1 };
  const cell = randomInt(256);
  return { cell, x: 60000 + 1024 * (cell % 16) + 256, z: 60000 + 1024 * Math.floor(cell / 16) + 256 };
}

export function flyCmd(...words: string[]): Promise<void> {
  return consoleCommand(FLY_CONTAINER, ...words);
}

/** Peaceful, frozen clock at noon, no weather, no natural spawns; fall damage stays ON (the landings are measured). */
export async function prepareServer(): Promise<void> {
  for (const c of [
    ['difficulty', 'peaceful'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'falldamage', 'true'],
    ['gamerule', 'keepinventory', 'true'],
    ['time', 'set', 'noon'],
    ['weather', 'clear'],
  ]) {
    await flyCmd(...c);
  }
}

export interface GlideState {
  name: string;
  isGliding: boolean;
  isFalling: boolean;
  isOnGround: boolean;
  location: Vec3;
  velocity: Vec3;
  health: number | null;
  tick: number;
}

/** truth:* for the flight tests (packs/truth/src/fly.ts, surv.ts, get.ts) on top of the PvE commands. */
export class FlyTruth extends PveTruth {
  glide(name: string): Promise<GlideState> {
    return this.ok<GlideState>('glide', [name]);
  }

  equip(name: string, slot: 'Head' | 'Chest' | 'Legs' | 'Feet' | 'Offhand', typeId: string, amount = 1, damage?: number): Promise<unknown> {
    return this.ok('equip', damage === undefined ? [name, slot, typeId, amount] : [name, slot, typeId, amount, damage]);
  }

  setslot(name: string, slot: number, typeId: string, amount = 1, damage?: number): Promise<unknown> {
    return this.ok('setslot', damage === undefined ? [name, slot, typeId, amount] : [name, slot, typeId, amount, damage]);
  }

  /** A shulker box with `stacks` stacks of `amount` items, dropped as an item at `at`. */
  boxdrop(at: Vec3, typeId: string, amount: number, stacks = 1): Promise<unknown> {
    return this.ok('boxdrop', [Math.floor(at.x), Math.floor(at.y), Math.floor(at.z), typeId, amount, stacks]);
  }

  /** Item counts by name (without namespace) in the player's inventory (truth:inv). */
  async counts(name: string): Promise<Record<string, number>> {
    const inv = await this.ok<{ counts: Record<string, number> }>('inv', [name]);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(inv.counts)) out[k.replace(/^minecraft:/, '')] = v;
    return out;
  }

  /** The inventory with shulker box contents (truth:getinv, packs/truth/src/get.ts). */
  getinv(name: string): Promise<{ slots: ({ slot: number; typeId: string; amount: number } | null)[]; counts: Record<string, number>; boxes: { slot: number; typeId: string; total: number; counts: Record<string, number> }[] }> {
    return this.ok('getinv', [name], 20_000);
  }

  /** The player's equipment (truth:durability): the chest slot's item and damage. */
  async chestSlot(name: string): Promise<{ typeId: string; damage: number } | null> {
    const d = await this.ok<{ equipment: Record<string, { typeId: string; damage: number } | null> }>('durability', [name]);
    return d.equipment.Chest ?? null;
  }

  blockInv(p: Vec3): Promise<{ typeId: string; total: number; counts: Record<string, number> }> {
    return this.ok('container', [p.x, p.y, p.z]);
  }

  /** Damage the player took since `since` (hurtlog), with the causes. */
  async damageSince(since: number, name: string): Promise<{ total: number; causes: string[]; events: HurtRecord[] }> {
    const { events } = await this.hurtlog(since, name);
    const mine = events.filter((e) => e.victimName === name);
    return { total: mine.reduce((a, e) => a + e.damage, 0), causes: mine.map((e) => e.cause), events: mine };
  }
}

export interface FlyBot {
  name: string;
  conn: Connection;
  chat: Chat;
  task: WalkingTask;
  processes: ProcessManager;
  settings: RuntimeSettings;
  built: BuiltContext;
  truth: FlyTruth;
  fly: FlyControl;
  /** The bot's chat lines (its replies), newest last. */
  said: string[];
  /** Log lines of the fly, flight, survival and stash scopes, newest last. */
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

/** Connect a bot running the afk task (walking on), wired like the CLI (index.ts), with in-memory settings. */
export async function startFlyBot(prefix: string, options: Partial<CommonTaskOptions> = {}, extra: { values?: Record<string, unknown>; settings?: RuntimeSettings } = {}): Promise<FlyBot> {
  const name = uniqueName(prefix);
  const log = VERBOSE ? createLogger('info', name) : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: log, reconnect: false });
  const metrics = new Metrics();
  metrics.attach(conn);
  const chat = new Chat(conn, { log, owners: parseOwners([]), maxReplies: 50 });
  const common: CommonTaskOptions = { nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: true, respawnDelayMs: 1000, ...options };
  const settings = extra.settings ?? new RuntimeSettings();
  const logs: string[] = [];
  const ref: { task?: WalkingTask } = {};
  const built = buildTaskContext({
    name: 'afk',
    conn,
    metrics,
    chat,
    version: E2E_VERSION,
    options: common,
    values: { 'no-config': true, ...(extra.values ?? {}), [SETTINGS_VALUE_KEY]: settings },
    logger: (scope) => capture(`${name}:${scope}`, logs),
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
  metrics.provide(() => ({ taskStatus: t.status() }));
  const fly = flyControlOf(t);
  if (!fly) throw new Error('the fly commands were not registered');
  const truth = new FlyTruth(conn, FLY_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(FLY_TARGET);
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
    fly,
    said,
    logs,
    command: (text) => flyCmd('tell', name, ...text.split(' ')),
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
export async function teleport(bot: FlyBot, feet: Vec3, yaw = 0): Promise<void> {
  const mob = bot.built.mobility!;
  await bot.truth.tp(bot.name, feet, yaw, 0);
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const p = bot.task.position();
    if (p && hdist(p, feet) < 0.05) break;
    await sleep(50);
  }
  await mob.loop.waitTicks(20);
  await mob.world.waitForChunks(3, { center: feet, timeoutMs: 20_000 });
  mob.loop.setCommand({ yaw, pitch: 0 });
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

/**
 * A platform of `block` whose top is at `top - 1` (a body standing on it has its feet at `top`),
 * `half` blocks each way around (x, z); built while the bot stands on it (the chunk must be loaded),
 * then the bot is teleported back to `back`. Returns the landing target's centre.
 */
export async function buildPlatform(bot: FlyBot, c: { x: number; z: number }, top: number, half: number, back: Vec3, block = 'stone'): Promise<Vec3> {
  await teleport(bot, { x: c.x + 0.5, y: top, z: c.z + 0.5 });
  await truthLoaded(bot.truth, 'fill', [c.x - half, top - 1, c.z - half, c.x + half, top - 1, c.z + half, block]);
  await teleport(bot, back);
  return { x: c.x + 0.5, y: top, z: c.z + 0.5 };
}

/** Removes a platform built by buildPlatform (while standing near it). */
export async function removePlatform(bot: FlyBot, c: { x: number; z: number }, top: number, half: number): Promise<void> {
  await teleport(bot, { x: c.x + 0.5, y: top, z: c.z + 0.5 });
  await truthLoaded(bot.truth, 'fill', [c.x - half - 4, top - 1, c.z - half - 12, c.x + half + 4, top + 8, c.z + half + 4, 'air']).catch(() => undefined);
}

/**
 * The flight kit: the inventory cleared, an elytra in slot 9, an iron chestplate worn, `rockets`
 * firework rockets in hotbar slot 0 and a shulker box holding `boxRockets` rockets (dropped at the
 * feet and picked up: it lands in the first free slot). `elytraDamage`: uses already spent.
 */
export async function giveFlightKit(bot: FlyBot, o: { rockets?: number; boxRockets?: number; elytraDamage?: number; chestplate?: boolean } = {}): Promise<void> {
  const { truth, name } = bot;
  const inv = bot.built.mobility!.world.inventory;
  await truth.setHealth(name, 20);
  await truth.ok('clear', [name]);
  if (o.chestplate ?? true) await truth.equip(name, 'Chest', 'iron_chestplate');
  if ((o.rockets ?? 64) > 0) await truth.setslot(name, 0, 'firework_rocket', o.rockets ?? 64);
  await truth.setslot(name, 9, 'elytra', 1, o.elytraDamage ?? 0);
  if (o.boxRockets !== undefined && o.boxRockets > 0) {
    const feet = bot.task.position()!;
    const stacks = Math.ceil(o.boxRockets / 64);
    const at = { x: Math.floor(feet.x) + 1, y: Math.floor(feet.y), z: Math.floor(feet.z) };
    await truth.boxdrop(at, 'firework_rocket', Math.min(64, o.boxRockets), stacks);
    const hasBox = () => (inv.slots.slice(0, 36).some((s) => s?.name.endsWith('shulker_box')) ? true : undefined);
    await sleep(1200);
    if (!hasBox()) await bot.built.mobility!.skills.collect(4, 160, { origin: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, filter: (i) => isShulkerBox(i.name) });
    await until(hasBox, 10_000, 'the fireworks box in the inventory');
  }
  await until(() => (inv.slots[9]?.name === 'elytra' && (o.rockets === 0 || inv.slots[0]?.name === 'firework_rocket') ? true : undefined), 10_000, 'the flight kit in the inventory model');
  await bot.built.mobility!.loop.waitTicks(5);
}

/** The carried shulker boxes with their contents, read from the inventory model's wire items (the Script API cannot read a box item's NBT). */
export function carriedBoxes(bot: FlyBot): { slot: number; name: string; contents: Record<string, number> }[] {
  const inv = bot.built.mobility!.world.inventory;
  const out: { slot: number; name: string; contents: Record<string, number> }[] = [];
  inv.slots.slice(0, 36).forEach((s, i) => {
    if (s && isShulkerBox(s.name)) out.push({ slot: i, name: s.name, contents: shulkerContents(inv.rawItem(0, i)) });
  });
  return out;
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
