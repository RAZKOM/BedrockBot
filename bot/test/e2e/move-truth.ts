// Shared helpers for the movement / pathfinding e2e tests (PLAN.md tasks 3.3 to 3.6) against the
// Track D server bds-move (udp/19146, flat world, truth pack; docker/compose.move.yml). Each test
// file connects one bot with a unique name and drives it through the real stack:
// Connection -> World (chunks, block updates) -> InputLoop (physics on real block shapes) -> BotSkills.
//
// Env: MOVE_BDS_HOST (127.0.0.1), MOVE_BDS_PORT (19146), MOVE_BDS_CONTAINER (bds-move); game version
// and transport from env.ts (BOT_VERSION, BDS_TRANSPORT);
// MOVE_VERBOSE=1 logs corrections, teleports and navigator decisions.
import { Connection } from '../../src/connection/connection.ts';
import type { ConnectTarget } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import { BotSkills } from '../../src/skills/index.ts';
import { InputLoop, flatWorld, type CorrectionEvent, type InputLoopEvent } from '../../src/skills/input/index.ts';
import { World } from '../../src/world/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import type { Layout } from './nav-worlds.ts';
import { Truth, consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const MOVE_HOST = process.env.MOVE_BDS_HOST ?? '127.0.0.1';
export const MOVE_PORT = Number(process.env.MOVE_BDS_PORT ?? 19146);
export const MOVE_CONTAINER = process.env.MOVE_BDS_CONTAINER ?? 'bds-move';
export const MOVE_TARGET: ConnectTarget = bdsTarget(MOVE_HOST, MOVE_PORT);
export const VERBOSE = process.env.MOVE_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const hdist = (a: Vec3, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
export const fmt = (v: Vec3): string => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Offline username unique per run (max 16 chars), so a lingering session never conflicts. */
export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface MoveBot {
  name: string;
  conn: Connection;
  world: World;
  loop: InputLoop;
  skills: BotSkills;
  truth: Truth;
  corrections: CorrectionEvent[];
  events: InputLoopEvent[];
}

/** Peaceful, noon, no mobs, no daylight cycle (mob knockback shows up as corrections). */
export async function prepareServer(container = MOVE_CONTAINER): Promise<void> {
  for (const c of [
    ['difficulty', 'peaceful'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['time', 'set', 'noon'],
    ['weather', 'clear'],
  ]) {
    await consoleCommand(container, ...c);
  }
}

export async function connectBot(prefix: string): Promise<MoveBot> {
  await prepareServer();
  const name = uniqueName(prefix);
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
  const world = new World(conn, { version: E2E_VERSION, logger: silentLogger });
  const loop = new InputLoop(conn, { world: flatWorld(), logger: VERBOSE ? createLogger('info', 'input') : silentLogger });
  const skills = new BotSkills({ loop, world, logger: VERBOSE ? createLogger('debug', 'nav') : silentLogger });
  const truth = new Truth(conn, MOVE_CONTAINER);
  const corrections: CorrectionEvent[] = [];
  const events: InputLoopEvent[] = [];
  loop.onEvent((e) => {
    events.push(e);
    if (e.kind === 'correction') corrections.push(e);
  });
  loop.start();
  await conn.connect(MOVE_TARGET);
  await world.waitForChunks(4, { timeoutMs: 30_000 });
  await loop.waitTicks(10);
  return { name, conn, world, loop, skills, truth, corrections, events };
}

export async function disconnectBot(bot: MoveBot | undefined): Promise<void> {
  if (!bot) return;
  bot.skills.dispose();
  bot.world.dispose();
  await bot.conn.disconnectAndFlush('test done');
}

/** Teleport to `feet` facing `yaw`; resolves once the loop has adopted it and the body has settled. */
export async function teleport(bot: MoveBot, feet: Vec3, yaw = 0): Promise<void> {
  const seen = new Promise<void>((resolve) => {
    const off = bot.loop.onEvent((e) => {
      if (e.kind === 'teleport' && dist(e.to, feet) < 0.01) {
        off();
        resolve();
      }
    });
  });
  bot.loop.release();
  await bot.truth.tp(bot.name, feet, yaw, 0);
  await seen;
  bot.loop.setCommand({ yaw, pitch: 0 });
  await bot.loop.waitTicks(20);
  await bot.world.waitForChunks(3, { center: feet, timeoutMs: 20_000 });
}

/** Waits until the model shows `name` at `p` (block updates from a truth:fill have arrived). */
export async function waitForBlock(bot: MoveBot, p: Vec3, name: string, timeoutMs = 3000): Promise<void> {
  const t0 = performance.now();
  while (bot.world.blockAt(p)?.name !== name) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`block at ${fmt(p)} is ${bot.world.blockAt(p)?.name}, expected ${name}`);
    await sleep(25);
  }
}

/** Local vs truth position. */
export async function truthDiff(bot: MoveBot): Promise<{ local: Vec3; truth: Vec3; diff: number }> {
  const t = await bot.truth.pos(bot.name);
  const local = bot.loop.state.pos;
  return { local, truth: t.location, diff: dist(local, t.location) };
}

/** Corrections that arrived after `since` (count) plus the 10 ticks after a goto. */
export function correctionsSince(bot: MoveBot, since: number): CorrectionEvent[] {
  return bot.corrections.slice(since);
}

export function describeCorrections(cs: CorrectionEvent[]): string {
  return cs.map((c) => ` [tick ${c.tick}: local ${c.local ? fmt(c.local) : '?'} server ${fmt(c.server)} err ${c.error?.toFixed(4) ?? '?'}]`).join('');
}

/** Builds a layout (nav-worlds.ts): teleport to its anchor, run its fills, wait until the model has the last one. */
export async function buildLayout(bot: MoveBot, layout: Layout): Promise<void> {
  await teleport(bot, layout.anchor);
  for (const fill of layout.fills) {
    for (let attempt = 0; ; attempt++) {
      const r = await bot.truth.cmd('fill', [fill.from.x, fill.from.y, fill.from.z, fill.to.x, fill.to.y, fill.to.z, fill.block], 30_000);
      if (r.ok) break;
      if (r.reason !== 'unloaded_chunk' || attempt >= 10) throw new Error(`truth:fill ${JSON.stringify(fill)} failed: ${r.reason} ${JSON.stringify(r.data)}`);
      await sleep(500);
    }
  }
  const last = layout.fills.at(-1);
  if (last) {
    const p = { x: last.to.x, y: last.to.y, z: last.to.z };
    await waitForBlock(bot, p, last.block === 'air' ? 'air' : last.block);
  }
  await bot.loop.waitTicks(10);
}
