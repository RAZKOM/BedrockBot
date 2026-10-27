// Shared setup for the farming and mining e2e tests (PLAN.md tasks 7.13 and 7.14, Track U): the full
// bot stack (Connection -> World -> InputLoop -> Hotbar / Containers -> BotSkills) on the bds-farm
// container (udp/19186, flat world, peaceful, truth pack with truth:field / truth:crops;
// docker/compose.farm.yml).
// Env: FARM_BDS_HOST (127.0.0.1), FARM_BDS_PORT (19186), FARM_BDS_CONTAINER (bds-farm),
// FARM_VERBOSE=1 (skill logs); game version and transport from env.ts.
//
// Isolation as in act-truth.ts: every run works in its own random area (`FarmArea`, a cell of a
// 64-block grid from x, z = 6144), truth request ids carry a per-run tag (DigTruth), events are
// filtered by the bot's own name, and every suite removes what it built at the end.
import { randomInt } from 'node:crypto';
import { ReplyParser, textOf, type Reply } from '../../../packs/truth/src/protocol.ts';
import { Connection } from '../../src/connection/connection.ts';
import type { ConnectTarget } from '../../src/connection/types.ts';
import { createLogger, silentLogger, type Logger } from '../../src/log.ts';
import { BotSkills } from '../../src/skills/index.ts';
import { InputLoop, flatWorld, type CorrectionEvent } from '../../src/skills/input/index.ts';
import { Containers } from '../../src/world/containers.ts';
import { Hotbar, World } from '../../src/world/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { DigTruth } from './dig-truth.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { consoleCommand, pollUntil, sleep, uniqueName } from './world-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const FARM_HOST = process.env.FARM_BDS_HOST ?? '127.0.0.1';
export const FARM_PORT = Number(process.env.FARM_BDS_PORT ?? 19186);
export const FARM_CONTAINER = process.env.FARM_BDS_CONTAINER ?? 'bds-farm';
export const FARM_TARGET: ConnectTarget = bdsTarget(FARM_HOST, FARM_PORT);
export const VERBOSE = process.env.FARM_VERBOSE === '1';
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;
/** The grass / farmland layer. */
export const SOIL_Y = FEET_Y - 1;

export interface BlockEvent {
  player: string;
  x: number;
  y: number;
  z: number;
  typeId: string;
  states?: Record<string, unknown>;
  tool?: string | null;
  face?: string;
  item?: string | null;
  /** performance.now() when it arrived. */
  at: number;
}

export interface TruthBlock {
  x: number;
  y: number;
  z: number;
  typeId: string;
  states: Record<string, unknown>;
}

export interface TruthCrops {
  w: number;
  d: number;
  soil: string[];
  crop: (string | null)[];
  growth: number[];
  soilCounts: Record<string, number>;
  cropCounts: Record<string, number>;
}

export interface TruthInv {
  counts: Record<string, number>;
  slots: ({ slot: number; typeId: string; amount: number } | null)[];
}

export interface TruthContainer {
  typeId: string;
  size: number;
  total: number;
  counts: Record<string, number>;
}

/** This run's private area: a cell of a 64-block grid (16 x 16 cells from x, z = 6144). */
export class FarmArea {
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  constructor(cell = randomInt(256)) {
    this.cell = cell;
    this.x0 = 6144 + 64 * (cell % 16) + 32;
    this.z0 = 6144 + 64 * Math.floor(cell / 16) + 32;
  }
}

export interface FarmBot {
  name: string;
  logger: Logger;
  conn: Connection;
  world: World;
  loop: InputLoop;
  hotbar: Hotbar;
  containers: Containers;
  skills: BotSkills;
  truth: DigTruth;
  breaks: BlockEvent[];
  places: BlockEvent[];
  interacts: BlockEvent[];
  corrections: CorrectionEvent[];
  /** inventory_transaction packets the bot sent (count). */
  clicks(): number;
  teleport(feet: Vec3, yaw?: number): Promise<void>;
  /** Empty inventory, then the items in order (truth:give fills the first free slot). */
  loadout(items: [string, number][]): Promise<void>;
  block(p: Vec3): Promise<TruthBlock>;
  close(): Promise<void>;
}

/** Peaceful, noon, no mobs, no daylight or weather cycle. */
export async function prepareServer(container = FARM_CONTAINER): Promise<void> {
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

/** Flat floor (dirt, grass top at y -61) with air above, in a box around (cx, cz); `height` blocks of air. */
export async function clearArea(truth: DigTruth, cx: number, cz: number, r: number, height = 8): Promise<void> {
  await truthLoaded(truth, 'fill', [cx - r, FEET_Y - 3, cz - r, cx + r, FEET_Y - 2, cz + r, 'dirt']);
  await truthLoaded(truth, 'fill', [cx - r, SOIL_Y, cz - r, cx + r, SOIL_Y, cz + r, 'grass_block']);
  await truthLoaded(truth, 'fill', [cx - r, FEET_Y, cz - r, cx + r, FEET_Y + height, cz + r, 'air']);
}

/** Kill item entities within a box around (cx, cz) (only this run's area). */
export function killItemsNear(cx: number, cz: number, r: number, container = FARM_CONTAINER): Promise<string> {
  return consoleCommand(container, 'kill', `@e[type=item,x=${cx - r},y=${FEET_Y - 4},z=${cz - r},dx=${2 * r},dy=24,dz=${2 * r}]`);
}

export async function connectFarmBot(prefix = 'Farm', at: { target?: ConnectTarget; container?: string } = {}): Promise<FarmBot> { // Track AQ: `at` (mine-tunnel / mine-vein on bds-dig)
  const name = uniqueName(prefix);
  const logger = VERBOSE ? createLogger('debug', 'farm') : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
  const world = new World(conn, { version: E2E_VERSION, logger: silentLogger });
  const loop = new InputLoop(conn, { world: flatWorld(), logger: silentLogger });
  const hotbar = new Hotbar(conn, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
  const containers = new Containers(conn, world.inventory, { logger });
  const skills = new BotSkills({ loop, world, hotbar, containers, source: conn, logger });
  const truth = new DigTruth(at.container ?? FARM_CONTAINER);
  const breaks: BlockEvent[] = [];
  const places: BlockEvent[] = [];
  const interacts: BlockEvent[] = [];
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
      if (d?.player !== name) return;
      const e = { ...(d as unknown as BlockEvent), at: performance.now() };
      if (d.type === 'playerBreakBlock') breaks.push(e);
      else if (d.type === 'playerPlaceBlock') places.push(e);
      else if (d.type === 'playerInteractWithBlock') interacts.push(e);
    } else {
      truth.receive(r);
    }
  });
  loop.onEvent((e) => {
    if (e.kind === 'correction') corrections.push(e);
  });
  let clicks = 0;
  const queue: (n: string, p: object) => void = conn.queue.bind(conn);
  (conn as unknown as { queue: (n: string, p: object) => void }).queue = (n: string, p: object) => {
    if (n === 'inventory_transaction') clicks++;
    queue(n, p);
  };
  loop.start();
  await conn.connect(at.target ?? FARM_TARGET);
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

  const loadout = async (items: [string, number][]): Promise<void> => {
    await truth.ok('clear', [name]);
    for (const [n, c] of items) await truth.ok('give', [name, n, c]);
    const want = items.reduce((a, [, c]) => a + c, 0);
    const ok = await pollUntil(() => world.inventory.slots.slice(0, 36).reduce((a, s) => a + (s?.count ?? 0), 0) === want, 5_000);
    if (ok < 0) throw new Error(`inventory model never showed ${want} items: ${JSON.stringify(world.inventory.slots.filter(Boolean))}`);
    await loop.waitTicks(2);
  };

  const block = (p: Vec3) => truthLoaded<TruthBlock>(truth, 'block', [p.x, p.y, p.z]);

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

  return { name, logger, conn, world, loop, hotbar, containers, skills, truth, breaks, places, interacts, corrections, clicks: () => clicks, teleport, loadout, block, close };
}

/** Wait until the world model shows `name` at `p` (block updates may trail the truth reply). */
export function waitBlock(bot: FarmBot, p: Vec3, name: string, timeoutMs = 3_000): Promise<number> {
  return pollUntil(() => bot.world.blockAt(p)?.name === name, timeoutMs);
}

export function stats(xs: number[]): string {
  if (xs.length === 0) return 'n/a';
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `min ${s[0]} median ${s[Math.floor(s.length / 2)]} max ${s[s.length - 1]} mean ${mean.toFixed(2)} (n=${s.length})`;
}

export { consoleCommand, sleep, uniqueName, pollUntil } from './world-truth.ts';
