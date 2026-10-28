// Helpers for the crafting e2e tests (wave 11, Track AW; docs/crafting.md) against bds-craft
// (udp/19208, flat world, DIFFICULTY peaceful, truth pack with truth:kit / craftinv / table / chestput /
// container; docker/compose.craft.yml). Each test file runs the real afk task (tasks/registry.ts, wired
// by tasks/context.ts like the CLI, settings in memory) on its own connection with a unique name, in
// its own random area, and clears what it built at the end.
//
// Env: CRAFT_BDS_HOST (127.0.0.1), CRAFT_BDS_PORT (19208), CRAFT_BDS_CONTAINER (bds-craft); game version
// and transport from env.ts (BOT_VERSION, BDS_TRANSPORT); CRAFT_VERBOSE=1 logs the bot's lines.
import { randomInt } from 'node:crypto';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { craftControlOf, type CraftControl } from '../../src/chat/commands-craft.ts';
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
export const CRAFT_HOST = process.env.CRAFT_BDS_HOST ?? '127.0.0.1';
export const CRAFT_PORT = Number(process.env.CRAFT_BDS_PORT ?? 19208);
export const CRAFT_CONTAINER = process.env.CRAFT_BDS_CONTAINER ?? 'bds-craft';
export const CRAFT_TARGET: ConnectTarget = bdsTarget(CRAFT_HOST, CRAFT_PORT);
export const VERBOSE = process.env.CRAFT_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** This run's private area: a cell of a 128-block grid starting at x, z = 12288 (8 x 8 cells). */
export function privateArea(): { x: number; z: number; cell: number } {
  const cell = randomInt(64);
  return { cell, x: 12288 + 128 * (cell % 8) + 64, z: 12288 + 128 * Math.floor(cell / 8) + 64 };
}

export function craftCmd(...words: string[]): Promise<void> {
  return consoleCommand(CRAFT_CONTAINER, ...words);
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
    await craftCmd(...c);
  }
}

/** truth:* for crafting (packs/truth/src/craft.ts, home.ts) on top of the `!get` ones. */
export class CraftTruth extends GetTruth {
  /** Clear the inventory and give these items (`[name, count]`, any count: several stacks when needed). */
  kit(name: string, items: readonly (readonly [string, number])[]): Promise<{ given: Record<string, number> }> {
    return this.ok('kit', [name, ...items.map(([n, c]) => `${n}:${c}`)], 20_000);
  }

  /** Counts by item (no namespace), stacks used, free slots. */
  craftinv(name: string): Promise<{ counts: Record<string, number>; stacks: number; free: number }> {
    return this.ok('craftinv', [name]);
  }

  table(p: Vec3, remove = false): Promise<{ typeId: string }> {
    return truthLoaded(this, 'table', remove ? [p.x, p.y, p.z, 'remove'] : [p.x, p.y, p.z]);
  }

  chestPut(p: Vec3, typeId: string, amount: number, stacks: number | 'all' = 1): Promise<{ typeId: string; size: number; slots: number[]; free: number }> {
    return truthLoaded(this, 'chestput', [p.x, p.y, p.z, typeId, amount, stacks]);
  }

  /** A container's contents (truth:container), item names without the namespace. */
  async box(p: Vec3): Promise<{ typeId: string; size: number; total: number; counts: Record<string, number>; free: number }> {
    const r = await truthLoaded<{ typeId: string; size: number; total: number; counts: Record<string, number>; slots: unknown[] }>(this, 'container', [p.x, p.y, p.z]);
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.counts)) counts[k.replace(/^minecraft:/, '')] = v;
    return { typeId: r.typeId, size: r.size, total: r.total, counts, free: r.slots.filter((s) => s === null).length };
  }

  block(p: Vec3): Promise<{ typeId: string }> {
    return truthLoaded(this, 'block', [p.x, p.y, p.z]);
  }
}

export interface CraftBot {
  name: string;
  conn: Connection;
  chat: Chat;
  task: WalkingTask;
  processes: ProcessManager;
  settings: RuntimeSettings;
  built: BuiltContext;
  truth: CraftTruth;
  craft: CraftControl;
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
export async function startCraftBot(prefix: string, options: Partial<CommonTaskOptions> = {}): Promise<CraftBot> {
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
  registerBuiltinCommands(chat, {
    conn,
    metrics,
    position: () => t.position(),
    extraStatus: () => t.statusLine?.() ?? { task: 'afk' },
    extraLines: () => t.processLines?.() ?? [],
    quit: () => undefined,
  });
  const craft = craftControlOf(t);
  if (!craft) throw new Error('no crafting control on the afk task');
  const home = homeControlOf(t);
  if (!home) throw new Error('no home logistics on the afk task');
  const truth = new CraftTruth(conn, CRAFT_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(CRAFT_TARGET);
  const mob = built.mobility!;
  await mob.world.waitForChunks(4, { timeoutMs: 30_000 });
  await mob.loop.waitTicks(10);
  await until(() => (craft.recipes.size > 0 ? true : undefined), 20_000, 'the crafting_data packet');
  return {
    name,
    conn,
    chat,
    task: t,
    processes: t.processes,
    settings,
    built,
    truth,
    craft,
    home,
    said,
    logs,
    command: (text) => craftCmd('tell', name, ...text.split(' ')),
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
export async function teleport(bot: CraftBot, feet: Vec3): Promise<void> {
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

/** Give a kit and wait until the inventory model agrees with it. */
export async function loadKit(bot: CraftBot, items: readonly (readonly [string, number])[]): Promise<void> {
  await bot.truth.kit(bot.name, items);
  const inv = bot.built.mobility!.world.inventory;
  const total = items.reduce((a, [, c]) => a + c, 0);
  await until(() => (items.every(([n, c]) => inv.count(n) === c) && inv.slots.reduce((a, s) => a + (s?.count ?? 0), 0) === total ? true : undefined), 10_000, `the kit in the model (${items.map(([n, c]) => `${c} ${n}`).join(', ')})`);
  await sleep(200);
}

/** Crafting tables standing within `r` blocks (x, z) of `c` at the feet level and one above (truth). */
export async function tablesAround(truth: CraftTruth, c: Vec3, r: number): Promise<Vec3[]> {
  const out: Vec3[] = [];
  for (let dx = -r; dx <= r; dx++)
    for (let dz = -r; dz <= r; dz++)
      for (const dy of [0, 1]) {
        const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        const b = await truth.block(p);
        if (b.typeId === 'minecraft:crafting_table') out.push(p);
      }
  return out;
}
