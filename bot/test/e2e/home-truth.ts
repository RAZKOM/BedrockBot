// Helpers for the home logistics e2e tests (wave 9, Track AG; docs/home.md) against bds-home
// (udp/19196, flat world, DIFFICULTY peaceful, truth pack with truth:chestput / container / stuff;
// docker/compose.home.yml). Each test file runs the real afk task (tasks/registry.ts, wired by
// tasks/context.ts like the CLI, `--no-config` style: settings and waypoints in memory, no world cache
// directory) on its own connection with a unique name, in its own random area, and removes what it
// built at the end.
//
// Env: HOME_BDS_HOST (127.0.0.1), HOME_BDS_PORT (19196), HOME_BDS_CONTAINER (bds-home); game version
// and transport from env.ts (BOT_VERSION, BDS_TRANSPORT); HOME_VERBOSE=1 logs the bot's lines.
import { randomInt } from 'node:crypto';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { homeControlOf, type HomeControl } from '../../src/chat/commands-home.ts';
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
import { GetTruth, hdist, sleep, truthLoaded, until } from './get-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export { clearArea, sleep, truthLoaded, until, hdist } from './get-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const HOME_HOST = process.env.HOME_BDS_HOST ?? '127.0.0.1';
export const HOME_PORT = Number(process.env.HOME_BDS_PORT ?? 19196);
export const HOME_CONTAINER = process.env.HOME_BDS_CONTAINER ?? 'bds-home';
export const HOME_TARGET: ConnectTarget = bdsTarget(HOME_HOST, HOME_PORT);
export const VERBOSE = process.env.HOME_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** This run's private area: a cell of a 256-block grid starting at x, z = -30720 (8 x 8 cells). */
export function privateArea(): { x: number; z: number; cell: number } {
  const cell = randomInt(64);
  return { cell, x: -30720 + 256 * (cell % 8) + 128, z: -30720 + 256 * Math.floor(cell / 8) + 128 };
}

export function homeCmd(...words: string[]): Promise<void> {
  return consoleCommand(HOME_CONTAINER, ...words);
}

/** Peaceful, frozen clock at noon, no weather, no natural spawns. */
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
    await homeCmd(...c);
  }
}

/** truth:* for home logistics (packs/truth/src/home.ts) on top of the `!get` ones. */
export class HomeTruth extends GetTruth {
  /** `stacks` stacks of `amount` items into the first free slots of the container at p (`all`: every free slot). */
  chestPut(p: Vec3, typeId: string, amount: number, stacks: number | 'all' = 1): Promise<{ typeId: string; size: number; slots: number[]; free: number }> {
    return truthLoaded(this, 'chestput', [p.x, p.y, p.z, typeId, amount, stacks]);
  }

  /** Track AV: give the item in `which` (a slot, or `boxes`: every shulker box) of the container at p the custom name `name` (truth:namebox). */
  nameBox(p: Vec3, which: number | 'boxes', name: string): Promise<{ named: { slot: number; typeId: string }[] }> {
    return truthLoaded(this, 'namebox', [p.x, p.y, p.z, which, name]);
  }

  /** Track AV: the same in a player's inventory (truth:nameinv). */
  nameInv(player: string, which: number | 'boxes', name: string): Promise<{ named: { slot: number; typeId: string }[] }> {
    return this.ok('nameinv', [player, which, name]);
  }

  /** A container's contents (truth:container), item names without the namespace. */
  async box(p: Vec3): Promise<{ typeId: string; size: number; total: number; counts: Record<string, number>; free: number }> {
    const r = await truthLoaded<{ typeId: string; size: number; total: number; counts: Record<string, number>; slots: unknown[] }>(this, 'container', [p.x, p.y, p.z]);
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.counts)) counts[k.replace(/^minecraft:/, '')] = v;
    return { typeId: r.typeId, size: r.size, total: r.total, counts, free: r.slots.filter((s) => s === null).length };
  }
}

export interface HomeBot {
  name: string;
  conn: Connection;
  chat: Chat;
  task: WalkingTask;
  processes: ProcessManager;
  settings: RuntimeSettings;
  built: BuiltContext;
  truth: HomeTruth;
  home: HomeControl;
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

/** Connect a bot running the afk task (walking on), wired like the CLI (index.ts), settings in memory. */
export async function startHomeBot(prefix: string, options: Partial<CommonTaskOptions> = {}, extra: { settings?: RuntimeSettings } = {}): Promise<HomeBot> {
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
    values: { 'no-config': true, [SETTINGS_VALUE_KEY]: settings },
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
  const home = homeControlOf(t);
  if (!home) throw new Error('no home logistics on the afk task');
  const truth = new HomeTruth(conn, HOME_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(HOME_TARGET);
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
    home,
    said,
    logs,
    command: (text) => homeCmd('tell', name, ...text.split(' ')),
    reply: (match, from, timeoutMs = 10_000) => until(() => said.slice(from).find(match), timeoutMs, `reply after line ${from} (said: ${said.slice(from).join(' | ')})`, 50),
    stop: async () => {
      t.stop();
      built.stop();
      chat.stop();
      await conn.disconnectAndFlush('test done');
    },
  };
}

export interface HomeLayout {
  /** Home (feet block). */
  home: Vec3;
  /** Chest holding 20 coal and 10 iron ingots. */
  coal: Vec3;
  /** Chest holding 32 oak logs (the test labels it `wood`). */
  wood: Vec3;
  /** Empty double chest (two halves placed by the bot: they pair); `empty` is the half the bot opens first. */
  empty: Vec3;
  emptyOther: Vec3;
  /** Chest holding 3 empty shulker boxes. */
  boxes: Vec3;
  /** Barrel holding 5 dirt. */
  barrel: Vec3;
}

/**
 * A home in the area around `c` (flat floor, feet at FEET_Y): 4 chests and a barrel (see HomeLayout).
 * The double chest is placed by the bot (two chests placed by truth:set do not pair; two placed by a
 * player facing the same way do: 54 slots). The bot ends standing at the home point.
 */
export async function buildHome(bot: HomeBot, c: { x: number; z: number }): Promise<HomeLayout> {
  const F = FEET_Y;
  const L: HomeLayout = {
    home: { x: c.x, y: F, z: c.z },
    coal: { x: c.x + 3, y: F, z: c.z - 2 },
    wood: { x: c.x + 3, y: F, z: c.z + 2 },
    empty: { x: c.x - 3, y: F, z: c.z - 1 },
    emptyOther: { x: c.x - 3, y: F, z: c.z },
    boxes: { x: c.x - 3, y: F, z: c.z + 3 },
    barrel: { x: c.x, y: F, z: c.z - 4 },
  };
  const t = bot.truth;
  const mob = bot.built.mobility!;
  await teleport(bot, { x: c.x + 0.5, y: F, z: c.z + 0.5 });
  await clearAreaHome(t, c, 14, 6);
  for (const p of [L.coal, L.wood, L.boxes]) await truthLoaded(t, 'set', [p.x, p.y, p.z, 'chest']);
  await truthLoaded(t, 'set', [L.barrel.x, L.barrel.y, L.barrel.z, 'barrel']);
  await t.chestPut(L.coal, 'coal', 20);
  await t.chestPut(L.coal, 'iron_ingot', 10);
  await t.chestPut(L.wood, 'oak_log', 32);
  await t.chestPut(L.boxes, 'undyed_shulker_box', 1, 3);
  await t.chestPut(L.barrel, 'dirt', 5);
  // the double chest: two chests placed by the bot from the same side (same facing: they pair)
  await t.ok('give', [bot.name, 'chest', 2]);
  await until(() => (mob.world.inventory.count('chest') >= 2 ? true : undefined), 10_000, '2 chests in the inventory');
  for (const p of [L.empty, L.emptyOther]) {
    const r = await mob.skills.place(p, { item: 'chest', face: 'up' });
    if (!r.ok) throw new Error(`placing the double chest half at ${p.x} ${p.y} ${p.z}: ${r.reason}`);
  }
  const d = await t.box(L.empty);
  if (d.size !== 54) throw new Error(`the two chests did not pair (size ${d.size})`);
  await t.ok('clear', [bot.name]);
  return L;
}

/** clearArea with a stone floor 2 deep (a home on solid ground). */
export async function clearAreaHome(t: HomeTruth, c: { x: number; z: number }, r: number, h: number): Promise<void> {
  const F = FEET_Y;
  await truthLoaded(t, 'fill', [c.x - r, F - 3, c.z - r, c.x + r, F - 2, c.z + r, 'stone']);
  await truthLoaded(t, 'fill', [c.x - r, F - 1, c.z - r, c.x + r, F - 1, c.z + r, 'grass_block']);
  await truthLoaded(t, 'fill', [c.x - r, F, c.z - r, c.x + r, F + h, c.z + r, 'air']);
}

/** Remove a home: empty its containers (no drops) and clear the area. */
export async function removeHome(bot: HomeBot, L: HomeLayout | undefined, c: { x: number; z: number }): Promise<void> {
  const t = bot.truth;
  if (L) for (const p of [L.coal, L.wood, L.empty, L.emptyOther, L.boxes, L.barrel]) await truthLoaded(t, 'container', [p.x, p.y, p.z, 'clear']).catch(() => undefined);
  await clearAreaHome(t, c, 14, 6).catch(() => undefined);
  await t.clearAround({ x: c.x + 0.5, y: FEET_Y, z: c.z + 0.5 }, 24).catch(() => undefined);
}

/** Teleport the bot (truth:tp) and wait until its input loop adopted the position and chunks loaded. */
export async function teleport(bot: HomeBot, feet: Vec3): Promise<void> {
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
