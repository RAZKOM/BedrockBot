// Helpers for the survival-kit e2e tests (PLAN.md task 7.11, Track S, docs/survival.md) against
// bds-surv (udp/19182, flat world, DIFFICULTY normal, truth pack; docker/compose.surv.yml). Each test
// file runs the real afk task (tasks/registry.ts, wired by tasks/context.ts like the CLI, so the
// survival kit is built exactly as `--task afk --walk` builds it) on its own connection with a unique
// name, in its own random area, with random truth request ids and a per-run summon tag; mobs and
// drops are removed at the end.
//
// Env: SURV_BDS_HOST (127.0.0.1), SURV_BDS_PORT (19182), SURV_BDS_CONTAINER (bds-surv); game version
// and transport from env.ts; SURV_VERBOSE=1 logs the bot's lines.
import { randomInt } from 'node:crypto';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { survivalKitOf } from '../../src/chat/commands-survival.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import type { SurvivalKit } from '../../src/skills/survival/index.ts';
import type { CommonTaskOptions } from '../../src/tasks/base.ts';
import { buildTaskContext } from '../../src/tasks/context.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { PveTruth, hdist, sleep, uniqueName, until, type PveBot } from './pve-truth.ts';
import { consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const SURV_HOST = process.env.SURV_BDS_HOST ?? '127.0.0.1';
export const SURV_PORT = Number(process.env.SURV_BDS_PORT ?? 19182);
export const SURV_CONTAINER = process.env.SURV_BDS_CONTAINER ?? 'bds-surv';
export const SURV_TARGET: ConnectTarget = bdsTarget(SURV_HOST, SURV_PORT);
export const VERBOSE = process.env.SURV_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

export { sleep, until, hdist, uniqueName };

/** This run's private area: a cell of a 256-block grid starting at x, z = 12288 (8 x 8 cells). */
export function privateArea(): { x: number; z: number; cell: number } {
  const cell = randomInt(64);
  return { cell, x: 12288 + 256 * (cell % 8) + 128, z: 12288 + 256 * Math.floor(cell / 8) + 128 };
}

export function survCmd(...words: string[]): Promise<void> {
  return consoleCommand(SURV_CONTAINER, ...words);
}

/** Normal difficulty, frozen clock at noon, no weather, no natural spawns, keep inventory. */
export async function prepareServer(opts: { time?: string } = {}): Promise<void> {
  for (const c of [
    ['difficulty', 'normal'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'doimmediaterespawn', 'false'],
    ['gamerule', 'keepinventory', 'true'],
    ['gamerule', 'naturalregeneration', 'true'],
    ['time', 'set', opts.time ?? 'noon'],
    ['weather', 'clear'],
  ]) {
    await survCmd(...c);
  }
}

export interface FoodState {
  food: number;
  saturation: number;
  exhaustion: number;
  health: number;
  tick: number;
}

export interface UseEvent {
  tick: number;
  kind: 'start' | 'complete' | 'stop' | 'release';
  player: string;
  typeId: string | null;
  useDuration: number;
}

export interface TruthInv {
  slots: ({ slot: number; typeId: string; amount: number } | null)[];
  counts: Record<string, number>;
  equipment: Record<string, { typeId: string; amount: number }>;
  selectedSlot: number;
}

/** truth:* survival commands (packs/truth/src/surv.ts) on top of the PvE ones. */
export class SurvTruth extends PveTruth {
  food(name: string): Promise<FoodState> {
    return this.ok<FoodState>('food', [name]);
  }
  setFood(name: string, food: number, saturation = 0, exhaustion = 0): Promise<FoodState> {
    return this.ok<FoodState>('setfood', [name, food, saturation, exhaustion]);
  }
  setSlot(name: string, slot: number, typeId: string, amount = 1, damage?: number): Promise<unknown> {
    return this.ok('setslot', damage === undefined ? [name, slot, typeId, amount] : [name, slot, typeId, amount, damage]);
  }
  durability(name: string): Promise<{ slots: { slot: number; typeId: string; damage: number; maxDurability: number }[]; equipment: Record<string, { typeId: string; damage: number | null }> }> {
    return this.ok('durability', [name]);
  }
  unequip(name: string): Promise<unknown> {
    return this.ok('unequip', [name]);
  }
  inv(name: string): Promise<TruthInv> {
    return this.ok<TruthInv>('inv', [name]);
  }
  async items(at: Vec3, r: number, typeId?: string): Promise<{ entityId: string; typeId: string; amount: number; location: Vec3 }[]> {
    return (await this.ok<{ items: { entityId: string; typeId: string; amount: number; location: Vec3 }[] }>('items', typeId ? [at.x, at.y, at.z, r, typeId] : [at.x, at.y, at.z, r])).items;
  }
  async uselog(since: number, name: string): Promise<UseEvent[]> {
    return (await this.ok<{ events: UseEvent[] }>('uselog', [since, name])).events;
  }
}

export interface SurvBot extends PveBot {
  truth: SurvTruth;
  kit: SurvivalKit;
}

/** Connect a bot running the afk task (walking on) on bds-surv; `owners` may use commands (the console always can). */
export async function startSurvBot(prefix: string, options: Partial<CommonTaskOptions> = {}, extra: { owners?: string[] } = {}): Promise<SurvBot> {
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
    values: {},
    logger: VERBOSE ? (scope) => createLogger('info', `${name}:${scope}`) : () => silentLogger,
    position: () => ref.task?.position(),
  });
  const t = afkTask.create(built.ctx) as WalkingTask;
  ref.task = t;
  if (!t.pve) throw new Error('afk task without the PvE controller (walking off?)');
  const kit = survivalKitOf(t);
  if (!kit) throw new Error('afk task without the survival kit');
  registerBuiltinCommands(chat, { conn, metrics, position: () => t.position(), extraStatus: () => t.statusLine?.() ?? { task: 'afk' }, quit: () => undefined });
  metrics.provide(() => ({ taskStatus: t.status() }));
  const truth = new SurvTruth(conn, SURV_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(name)) said.push(p.message);
  });
  await t.start();
  chat.start();
  await conn.connect(SURV_TARGET);
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
    kit,
    said,
    stop: async () => {
      t.stop();
      built.stop();
      chat.stop();
      await conn.disconnectAndFlush('test done');
    },
  };
}

/** Teleport the bot (truth:tp) and wait until its input loop adopted the position and chunks loaded. */
export async function teleport(bot: SurvBot, feet: Vec3, yaw = 0): Promise<void> {
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
}

/** truth:fill with retries while the chunk is not loaded yet. */
export async function fill(bot: SurvBot, from: Vec3, to: Vec3, block: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const r = await bot.truth.cmd('fill', [from.x, from.y, from.z, to.x, to.y, to.z, block], 30_000);
    if (r.ok) return;
    if (r.reason !== 'unloaded_chunk' || attempt >= 10) throw new Error(`truth:fill failed: ${r.reason} ${JSON.stringify(r.data)}`);
    await sleep(500);
  }
}

/** Flat floor (grass at -61) with air above in a box around (cx, cz). */
export async function flatten(bot: SurvBot, cx: number, cz: number, rx: number, rz = rx, height = 6): Promise<void> {
  await fill(bot, { x: cx - rx, y: FEET_Y - 1, z: cz - rz }, { x: cx + rx, y: FEET_Y - 1, z: cz + rz }, 'grass_block');
  await fill(bot, { x: cx - rx, y: FEET_Y, z: cz - rz }, { x: cx + rx, y: FEET_Y + height, z: cz + rz }, 'air');
}

/** Clear the inventory and the armour, then set the given slots (truth:setslot), and wait for the model. */
export async function loadout(bot: SurvBot, slots: Record<number, [string, number?, number?]>): Promise<void> {
  await bot.truth.ok('clear', [bot.name]);
  for (const [slot, [typeId, amount, damage]] of Object.entries(slots)) await bot.truth.setSlot(bot.name, Number(slot), typeId, amount ?? 1, damage);
  const inv = bot.built.mobility!.world.inventory;
  await until(
    () => (Object.entries(slots).every(([slot, [typeId, amount]]) => inv.slots[Number(slot)]?.name === typeId && inv.slots[Number(slot)]?.count === (amount ?? 1)) ? true : undefined),
    5_000,
    `loadout in the inventory model (${JSON.stringify(slots)})`,
    50,
  );
}

/** A console command to the bot as `tell` (an owner); resolves with the bot's next reply. */
export async function command(bot: SurvBot, line: string, timeoutMs = 15_000): Promise<string> {
  const n0 = bot.said.length;
  await survCmd('tell', bot.name, ...line.split(' '));
  return until(() => bot.said[n0], timeoutMs, `reply to ${line}`, 50);
}

/** Where the bot's feet were every tick while `fn` runs (the input loop's own position). */
export async function track<T>(bot: SurvBot, fn: () => Promise<T>): Promise<{ result: T; path: Vec3[] }> {
  const path: Vec3[] = [];
  const off = bot.built.mobility!.loop.onBeforeStep((_t, s) => {
    if (s.ready) path.push({ ...s.pos });
  });
  try {
    const result = await fn();
    return { result, path };
  } finally {
    off();
  }
}
