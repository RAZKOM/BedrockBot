// Shared setup for the wood e2e tests (PLAN.md tasks 4.3 to 4.6): the full bot stack
// (Connection -> World -> InputLoop -> Hotbar / Containers -> BotSkills) on the bds-wood container
// (udp/19150, flat world, truth pack with the wood commands; docker/compose.wood.yml).
// Env: WOOD_BDS_HOST (127.0.0.1), WOOD_BDS_PORT (19150), WOOD_BDS_CONTAINER (bds-wood),
// WOOD_VERBOSE=1 (skill logs); game version and transport from env.ts.
//
// Isolation as in dig-truth.ts: every run works in its own random area (`WoodArea`, a cell of a
// 128-block grid from x, z = 2048), truth request ids carry a per-run tag (DigTruth), and drops are
// only killed inside the run's own area.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplyParser, textOf, type Reply } from '../../../packs/truth/src/protocol.ts';
import { Connection } from '../../src/connection/connection.ts';
import type { ConnectTarget } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import { BotSkills } from '../../src/skills/index.ts';
import { InputLoop, flatWorld, type CorrectionEvent } from '../../src/skills/input/index.ts';
import { Containers } from '../../src/world/containers.ts';
import { Hotbar, World } from '../../src/world/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { DigTruth } from './dig-truth.ts';
import { bdsTarget, CLI_TARGET_ARGS, E2E_VERSION } from './env.ts';
import { FEET_Y, type WoodLayout } from './wood-worlds.ts';
import { consoleCommand, sleep, uniqueName } from './world-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const WOOD_HOST = process.env.WOOD_BDS_HOST ?? '127.0.0.1';
export const WOOD_PORT = Number(process.env.WOOD_BDS_PORT ?? 19150);
export const WOOD_CONTAINER = process.env.WOOD_BDS_CONTAINER ?? 'bds-wood';
export const WOOD_TARGET: ConnectTarget = bdsTarget(WOOD_HOST, WOOD_PORT);
export const VERBOSE = process.env.WOOD_VERBOSE === '1';
/** bot/ (the CLI runs from there). */
export const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

export interface BreakEvent {
  player: string;
  x: number;
  y: number;
  z: number;
  typeId: string;
  tool: string | null;
}

/** This run's private area: a cell of a 128-block grid (8 x 8 cells from x, z = 2048). */
export class WoodArea {
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  constructor(cell = randomInt(64)) {
    this.cell = cell;
    this.x0 = 2048 + 128 * (cell % 8) + 64;
    this.z0 = 2048 + 128 * Math.floor(cell / 8) + 64;
  }
}

export interface WoodBot {
  name: string;
  conn: Connection;
  world: World;
  loop: InputLoop;
  hotbar: Hotbar;
  containers: Containers;
  skills: BotSkills;
  truth: DigTruth;
  breaks: BreakEvent[];
  corrections: CorrectionEvent[];
  teleport(feet: Vec3, yaw?: number): Promise<void>;
  close(): Promise<void>;
}

/** Peaceful, noon, no mobs, no daylight or weather cycle. */
export async function prepareServer(container = WOOD_CONTAINER): Promise<void> {
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

export async function connectWoodBot(prefix = 'Wood'): Promise<WoodBot> {
  const name = uniqueName(prefix);
  const logger = VERBOSE ? createLogger('debug', 'wood') : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
  const world = new World(conn, { version: E2E_VERSION, logger: silentLogger });
  const loop = new InputLoop(conn, { world: flatWorld(), logger: silentLogger });
  const hotbar = new Hotbar(conn, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
  const containers = new Containers(conn, world.inventory, { logger });
  const skills = new BotSkills({ loop, world, hotbar, containers, source: conn, logger });
  const truth = new DigTruth(WOOD_CONTAINER);
  const breaks: BreakEvent[] = [];
  const corrections: CorrectionEvent[] = [];
  const parser = new ReplyParser();
  conn.on('text', (p) => {
    let r: Reply | null;
    try {
      r = parser.feed(textOf(p));
    } catch {
      return;
    }
    if (!r) return;
    const d = r.data as Record<string, unknown> | undefined;
    if (r.cmd === 'event') {
      if (d?.type === 'playerBreakBlock' && d.player === name) breaks.push(d as unknown as BreakEvent);
    } else {
      truth.receive(r);
    }
  });
  loop.onEvent((e) => {
    if (e.kind === 'correction') corrections.push(e);
  });
  loop.start();
  await conn.connect(WOOD_TARGET);
  await world.waitForChunks(2, { timeoutMs: 30_000 });
  await loop.waitTicks(10);

  const teleport = async (feet: Vec3, yaw = 0): Promise<void> => {
    const seen = new Promise<void>((resolve) => {
      const off = loop.onEvent((e) => {
        if (e.kind === 'teleport' && Math.hypot(e.to.x - feet.x, e.to.y - feet.y, e.to.z - feet.z) < 0.01) {
          off();
          resolve();
        }
      });
    });
    skills.cancel();
    loop.release();
    await truth.ok('tp', [name, feet.x, feet.y, feet.z, yaw, 0]);
    await seen;
    loop.setCommand({ yaw, pitch: 0 });
    await world.waitForChunks(3, { center: feet, timeoutMs: 30_000 });
    await loop.waitTicks(20);
  };

  const close = async (): Promise<void> => {
    skills.cancel();
    if (conn.state === 'spawned') await loop.waitTicks(2);
    skills.dispose();
    containers.dispose();
    hotbar.dispose();
    loop.stop();
    world.dispose();
    await conn.disconnectAndFlush('test done');
  };

  return { name, conn, world, loop, hotbar, containers, skills, truth, breaks, corrections, teleport, close };
}

/** Run a truth command, retrying while its chunks are not loaded yet. */
export async function truthLoaded<T = Record<string, unknown>>(truth: DigTruth, cmd: string, args: (string | number)[], timeoutMs = 20_000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const r = await truth.cmd(cmd, args, 30_000);
    if (r.ok) return r.data as T;
    if (r.reason !== 'unloaded_chunk' || performance.now() - t0 > timeoutMs) throw new Error(`truth:${cmd} ${args.join(' ')} failed: ${r.reason} ${JSON.stringify(r.data)}`);
    await sleep(300);
  }
}

/**
 * Build a layout: clear the box (dirt, grass floor, air above), kill old drops in it, then the extra
 * blocks, the trees (truth:tree) and the chest (emptied). The caller stands inside the box.
 */
export async function buildLayout(truth: DigTruth, l: WoodLayout, container = WOOD_CONTAINER): Promise<void> {
  const { from, to } = l;
  await truthLoaded(truth, 'fill', [from.x, FEET_Y - 3, from.z, to.x, FEET_Y - 2, to.z, 'dirt']);
  await truthLoaded(truth, 'fill', [from.x, FEET_Y - 1, from.z, to.x, FEET_Y - 1, to.z, 'grass_block']);
  await truthLoaded(truth, 'fill', [from.x, FEET_Y, from.z, to.x, to.y, to.z, 'air']);
  await killItemsIn(l, container);
  for (const b of l.blocks ?? []) await truthLoaded(truth, 'fill', [b.from.x, b.from.y, b.from.z, b.to.x, b.to.y, b.to.z, b.block]);
  for (const t of l.trees) await truthLoaded(truth, 'tree', [t.x, FEET_Y, t.z, t.h, t.kind]);
  if (l.chest) {
    await truthLoaded(truth, 'set', [l.chest.x, l.chest.y, l.chest.z, 'chest']);
    await truthLoaded(truth, 'container', [l.chest.x, l.chest.y, l.chest.z, 'clear']);
  }
}

/** Kill item entities inside a layout's box (only this run's area). */
export function killItemsIn(l: WoodLayout, container = WOOD_CONTAINER): Promise<string> {
  const { from, to } = l;
  return consoleCommand(container, 'kill', `@e[type=item,x=${from.x},y=${FEET_Y - 2},z=${from.z},dx=${to.x - from.x},dy=${to.y - FEET_Y + 4},dz=${to.z - from.z}]`);
}

/** Logs (any `_log` block) inside a box, from the truth pack. */
export async function logsInBox(truth: DigTruth, from: Vec3, to: Vec3): Promise<{ count: number; positions: number[][]; byType: Record<string, number> }> {
  return truthLoaded(truth, 'find', [from.x, from.y, from.z, to.x, to.y, to.z, '_log']);
}

export interface TruthContainer {
  typeId: string;
  size: number;
  total: number;
  counts: Record<string, number>;
  slots: ({ slot: number; typeId: string; amount: number } | null)[];
}

export interface TruthInv {
  counts: Record<string, number>;
  slots: ({ slot: number; typeId: string; amount: number } | null)[];
}

/** Sum of every `*_log` count in a truth counts map. */
export function logCount(counts: Record<string, number>): number {
  let n = 0;
  for (const [k, v] of Object.entries(counts)) if (k.endsWith('_log') && !k.includes('stripped')) n += v;
  return n;
}

export { consoleCommand, sleep, uniqueName, pollUntil } from './world-truth.ts';

// ---- the gather CLI (task 4.6) ------------------------------------------------------------------

export interface GatherCli {
  name: string;
  child: ChildProcess;
  /** Everything the CLI logged so far (stderr + stdout). */
  output(): string;
  /** Exit code (null when killed). */
  exit: Promise<number | null>;
  startedAt: number;
  kill(): void;
}

/** `node src/index.ts --task gather ...` against bds-wood, with a fresh log dir and no config file. */
export function startGatherCli(args: string[], prefix = 'Gath'): GatherCli {
  const name = uniqueName(prefix);
  const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-gather-'));
  const child = spawn(
    process.execPath,
    ['src/index.ts', '--task', 'gather', '--no-config', '--host', WOOD_HOST, '--port', String(WOOD_PORT), ...CLI_TARGET_ARGS, '--username', name, '--no-reconnect', '--log-dir', dir, ...args],
    { cwd: BOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => {
    out += d.toString();
    if (VERBOSE) process.stderr.write(d);
  });
  const exit = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve(code);
    }),
  );
  return {
    name,
    child,
    output: () => out,
    exit,
    startedAt: performance.now(),
    kill: () => {
      if (child.exitCode === null) child.kill();
    },
  };
}

/** Waits until `name` is online (truth:ping players). */
export async function waitOnline(truth: DigTruth, name: string, timeoutMs = 30_000): Promise<void> {
  const t0 = performance.now();
  for (;;) {
    const players = (await truth.ok<{ players: string[] }>('ping')).players;
    if (players.includes(name)) return;
    if (performance.now() - t0 > timeoutMs) throw new Error(`${name} not online after ${timeoutMs} ms (online: ${players.join(', ')})`);
    await sleep(250);
  }
}
