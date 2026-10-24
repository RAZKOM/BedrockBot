// Shared helpers for the world cache and debug map e2e tests (PLAN.md tasks 7.12 and 7.15, Track T)
// against bds-cache (udp/19184, docker/compose.cache.yml): a generated DEFAULT world, seed 7, peaceful.
// Each test connects a bot with the real stack (Connection -> World + WorldCache -> InputLoop ->
// BotSkills), a cache directory of its own under the OS temp dir (removed at the end), and works in a
// random far-away area of the generated world (`privateArea()`), so runs never share terrain.
//
// Env: CACHE_BDS_HOST (127.0.0.1), CACHE_BDS_PORT (19184), CACHE_BDS_CONTAINER (bds-cache); game version
// and transport from env.ts; CACHE_AREA="x,z" pins the area (reproduce a run); CACHE_VERBOSE=1 logs the
// navigator and the cache.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection } from '../../src/connection/connection.ts';
import type { ConnectTarget } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import { BotSkills, type NavigatorOptions } from '../../src/skills/index.ts';
import { InputLoop, flatWorld, type CorrectionEvent } from '../../src/skills/input/index.ts';
import { WorldCache } from '../../src/world/cache/index.ts';
import { World } from '../../src/world/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { classify } from '../../src/skills/terrain/classify.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { Truth, consoleCommand } from './skills-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const CACHE_HOST = process.env.CACHE_BDS_HOST ?? '127.0.0.1';
export const CACHE_PORT = Number(process.env.CACHE_BDS_PORT ?? 19184);
export const CACHE_CONTAINER = process.env.CACHE_BDS_CONTAINER ?? 'bds-cache';
export const CACHE_TARGET: ConnectTarget = bdsTarget(CACHE_HOST, CACHE_PORT);
export const VERBOSE = process.env.CACHE_VERBOSE === '1';

export const fmt = (v: Vec3): string => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
export const hdist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 9)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A temp directory for one test's cache; `removeDirs()` deletes them. */
const dirs: string[] = [];
export function cacheDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `bb-cache-e2e-${tag}-`));
  dirs.push(d);
  return d;
}
export function removeDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/**
 * A random area of the generated world, far from spawn and from other runs: x and z in 1 500 .. 9 500
 * or -9 500 .. -1 500, chunk-aligned. CACHE_AREA="x,z" pins it.
 */
export function privateArea(): { x: number; z: number } {
  const pinned = process.env.CACHE_AREA?.split(',').map(Number);
  if (pinned?.length === 2 && pinned.every(Number.isFinite)) return { x: pinned[0]!, z: pinned[1]! };
  const one = () => (Math.random() < 0.5 ? -1 : 1) * 16 * Math.floor(94 + Math.random() * 500);
  return { x: one(), z: one() };
}

export interface CacheBot {
  name: string;
  conn: Connection;
  world: World;
  cache: WorldCache;
  loop: InputLoop;
  skills: BotSkills;
  truth: Truth;
  corrections: CorrectionEvent[];
  /** Columns loaded so far (counter). */
  loads: { n: number };
}

export async function prepareServer(container = CACHE_CONTAINER): Promise<void> {
  for (const c of [
    ['difficulty', 'peaceful'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
    ['gamerule', 'falldamage', 'false'],
    ['time', 'set', 'noon'],
    ['weather', 'clear'],
  ]) {
    await consoleCommand(container, ...c);
  }
}

export interface ConnectOptions {
  /** Cache directory (one server's directory, as `<root>/<server id>` would be). */
  dir: string;
  /** Flush interval of the cache, ms. Default 5000. */
  flushIntervalMs?: number;
  nav?: NavigatorOptions;
}

export async function connectCacheBot(prefix: string, o: ConnectOptions): Promise<CacheBot> {
  await prepareServer();
  const name = uniqueName(prefix);
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
  const world = new World(conn, { version: E2E_VERSION, logger: silentLogger });
  const cache = new WorldCache({ dir: o.dir, flushIntervalMs: o.flushIntervalMs ?? 5000, logger: VERBOSE ? createLogger('info', 'cache') : silentLogger });
  cache.attach(world);
  const loads = { n: 0 };
  world.chunks.onColumnLoaded(() => {
    loads.n++;
  });
  const loop = new InputLoop(conn, { world: flatWorld(), logger: silentLogger });
  const skills = new BotSkills({ loop, world, logger: VERBOSE ? createLogger('debug', 'nav') : silentLogger, ...o.nav });
  const truth = new Truth(conn, CACHE_CONTAINER);
  const corrections: CorrectionEvent[] = [];
  loop.onEvent((e) => {
    if (e.kind === 'correction') corrections.push(e);
  });
  loop.start();
  await conn.connect(CACHE_TARGET);
  await world.waitForChunks(2, { timeoutMs: 60_000 });
  await loop.waitTicks(10);
  return { name, conn, world, cache, loop, skills, truth, corrections, loads };
}

/** Disconnects; closes the cache (writes every remembered chunk). */
export async function disconnectCacheBot(bot: CacheBot | undefined): Promise<void> {
  if (!bot) return;
  bot.skills.dispose();
  bot.loop.stop();
  bot.cache.close();
  bot.world.dispose();
  await bot.conn.disconnectAndFlush('test done');
}

/** Teleports to (x, 300, z) (fall damage is off on bds-cache) and waits for the columns within `radius` chunks. */
export async function hop(bot: CacheBot, x: number, z: number, radius = 4): Promise<void> {
  bot.skills.cancel();
  bot.loop.release();
  const seen = waitTeleport(bot, x, z);
  await bot.truth.tp(bot.name, { x: x + 0.5, y: 300, z: z + 0.5 });
  await seen;
  await bot.world.waitForChunks(radius, { center: { x, y: 0, z }, timeoutMs: 60_000 });
}

function waitTeleport(bot: CacheBot, x: number, z: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = bot.loop.onEvent((e) => {
      if (e.kind === 'teleport' && hdist(e.to, { x: x + 0.5, z: z + 0.5 }) < 0.01) {
        off();
        resolve();
      }
    });
  });
}

/** The standable feet cell on top of column (x, z) when it is land (not water, leaves or a hazard), else undefined. */
export function landFeet(bot: CacheBot, x: number, z: number): number | undefined {
  const grid = bot.skills.nav.grid;
  const top = grid.source.columnTop?.(x, z);
  if (top === undefined) return undefined;
  for (let y = top; y > -64; y--) {
    const b = bot.world.blockAt({ x, y, z });
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

/** The nearest land cell (spiral, up to `r` blocks) around (x, z), from loaded blocks. */
export function nearestLand(bot: CacheBot, x: number, z: number, r = 12): Vec3 | undefined {
  for (let d = 0; d <= r; d++) {
    for (let dx = -d; dx <= d; dx++) {
      for (let dz = -d; dz <= d; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
        const y = landFeet(bot, x + dx, z + dz);
        if (y !== undefined) return { x: x + dx, y, z: z + dz };
      }
    }
  }
  return undefined;
}

/** Hops to (x, z), finds land nearby, teleports onto it and settles. Undefined when no land. */
export async function standNear(bot: CacheBot, x: number, z: number): Promise<Vec3 | undefined> {
  await hop(bot, x, z, 4);
  const land = nearestLand(bot, x, z);
  if (!land) return undefined;
  const seen = waitTeleport(bot, land.x, land.z);
  await bot.truth.tp(bot.name, { x: land.x + 0.5, y: land.y, z: land.z + 0.5 });
  await seen;
  await bot.loop.waitTicks(20);
  await bot.world.waitForChunks(4, { center: land, timeoutMs: 60_000 });
  return land;
}

/** Waits until no column is awaited (every column the server sent is loaded). */
export async function settleChunks(bot: CacheBot, timeoutMs = 30_000): Promise<void> {
  const t0 = performance.now();
  while (bot.world.chunks.pendingCount > 0 && performance.now() - t0 < timeoutMs) await sleep(100);
  await sleep(300);
}
