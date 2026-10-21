// Shared setup for the digging e2e tests (PLAN.md 4.1 / 4.2): a bot with World, InputLoop, Hotbar
// and Digger on the bds-dig container (udp/19148, flat world, truth pack; docker/compose.dig.yml).
// Override with DIG_BDS_HOST / DIG_BDS_PORT / DIG_BDS_CONTAINER; game version and transport follow
// env.ts (BOT_VERSION, BDS_TRANSPORT).
//
// Isolation (several dig suites may run on bds-dig at once: every track's e2e gate runs the whole
// e2e project; and a killed run leaves its player online for a while):
// - each run works in its own area (`RunArea`, a random cell of a 48-block grid far from spawn) and
//   never digs a position twice, so another run's blocks, fills, drops or server-side break timers
//   (BDS keeps mining a position until abort_break, see docs/digging.md) cannot reach it;
// - truth request ids carry a random per-run tag (`DigTruth`): replies are broadcast to every player,
//   so plain sequence ids of two concurrent runs would answer each other's requests;
// - `close()` cancels a running dig and lets the abort_break go out before disconnecting.
import { randomInt } from 'node:crypto';
import { ReplyParser, textOf, type Reply } from '../../../packs/truth/src/protocol.ts';
import { Connection } from '../../src/connection/connection.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import { Digger } from '../../src/skills/dig/index.ts';
import { InputLoop } from '../../src/skills/input/index.ts';
import { Hotbar, World } from '../../src/world/index.ts';
import type { EntityInfo } from '../../src/world/types.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { consoleCommand, sleep, uniqueName } from './world-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const DIG_HOST = process.env.DIG_BDS_HOST ?? '127.0.0.1';
export const DIG_PORT = Number(process.env.DIG_BDS_PORT ?? 19148);
export const DIG_CONTAINER = process.env.DIG_BDS_CONTAINER ?? 'bds-dig';
export const DIG_TARGET: ConnectTarget = bdsTarget(DIG_HOST, DIG_PORT);
/** Flat world: grass top at y = -61, feet at -60. */
export const FEET_Y = -60;

export interface BreakEvent {
  player: string;
  x: number;
  y: number;
  z: number;
  typeId: string;
  tool: string | null;
  /** performance.now() when it arrived. */
  at: number;
}

/** Truth-pack client whose request ids are unique per run (`#<tag><n>`), so concurrent runs never cross replies. */
export class DigTruth {
  readonly container: string;
  readonly tag = `d${randomInt(36 ** 5).toString(36)}`;
  private readonly pending = new Map<string, (r: Reply) => void>();
  private seq = 0;

  constructor(container = DIG_CONTAINER) {
    this.container = container;
  }

  /** Feed a reply (from the bot's text listener). */
  receive(r: Reply): void {
    if (r.id == null) return;
    const fn = this.pending.get(r.id);
    if (fn) {
      this.pending.delete(r.id);
      fn(r);
    }
  }

  cmd(name: string, args: (string | number)[] = [], timeoutMs = 15_000): Promise<Reply> {
    const id = `${this.tag}x${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for truth:${name} #${id}`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      consoleCommand(this.container, 'scriptevent', `truth:${name}`, `#${id}`, ...args.map(String)).catch((e: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  async ok<T = Record<string, unknown>>(name: string, args: (string | number)[] = [], timeoutMs?: number): Promise<T> {
    const r = await this.cmd(name, args, timeoutMs);
    if (!r.ok) throw new Error(`truth:${name} ${args.join(' ')} failed: ${r.reason} ${JSON.stringify(r.data)}`);
    return r.data as T;
  }

  /** Retries while the target chunks are not loaded yet (right after a long teleport). */
  async okLoaded<T = Record<string, unknown>>(name: string, args: (string | number)[], timeoutMs = 15_000): Promise<T> {
    const t0 = performance.now();
    for (;;) {
      const r = await this.cmd(name, args);
      if (r.ok) return r.data as T;
      if (r.reason !== 'unloaded_chunk' || performance.now() - t0 > timeoutMs) {
        throw new Error(`truth:${name} ${args.join(' ')} failed: ${r.reason} ${JSON.stringify(r.data)}`);
      }
      await sleep(250);
    }
  }
}

/**
 * This run's private piece of the flat world: a home cell on a 48-block grid (16 x 16 cells from
 * x, z = 512; picked at random per run) and fresh dig positions around it.
 */
export class RunArea {
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  /** Feet position of the bot at home. */
  readonly home: Vec3;
  private readonly ring: Vec3[] = [];
  private used = 0;

  constructor(cell = randomInt(256)) {
    this.cell = cell;
    this.x0 = 512 + 48 * (cell % 16);
    this.z0 = 512 + 48 * Math.floor(cell / 16);
    this.home = { x: this.x0 + 0.5, y: FEET_Y, z: this.z0 + 0.5 };
    // Blocks 2 cells from home (16 columns) at feet and head height: 32 positions within reach.
    for (const dy of [0, 1]) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) === 2) this.ring.push({ x: this.x0 + dx, y: FEET_Y + dy, z: this.z0 + dz });
        }
      }
    }
  }

  /** A position next to home that no case of this run has used. */
  next(): Vec3 {
    const p = this.ring[this.used++];
    if (!p) throw new Error('RunArea: out of fresh dig positions');
    return { ...p };
  }

  /** The cleared box: x0-14..x0+8, z0-6..z0+6, from the grass floor (y -61) to y -52. */
  get box(): { from: Vec3; to: Vec3 } {
    return { from: { x: this.x0 - 14, y: FEET_Y - 1, z: this.z0 - 6 }, to: { x: this.x0 + 8, y: FEET_Y + 8, z: this.z0 + 6 } };
  }
}

export interface DigBot {
  name: string;
  conn: Connection;
  world: World;
  loop: InputLoop;
  hotbar: Hotbar;
  digger: Digger;
  truth: DigTruth;
  /** truth playerBreakBlock events in arrival order. */
  breaks: BreakEvent[];
  /** Item entities added (the drop shows up before the pickup removes it). */
  itemsAdded: { e: EntityInfo; tick: bigint }[];
  kicks: string[];
  teleport(feet: Vec3, yaw?: number): Promise<void>;
  /** Cancel a running dig and let its abort_break go out (safe to call any time). */
  release(): Promise<void>;
  close(): Promise<void>;
}

export async function connectDigBot(prefix = 'Dig'): Promise<DigBot> {
  const name = uniqueName(prefix);
  const verbose = process.env.DIG_VERBOSE ? createLogger('debug', 'dig') : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
  const world = new World(conn, { version: E2E_VERSION, logger: silentLogger });
  const loop = new InputLoop(conn, { world: { solidAt: (x, y, z) => world.blockAt({ x, y, z })?.solid }, logger: silentLogger });
  const hotbar = new Hotbar(conn, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
  const digger = new Digger({ loop, world, hotbar, logger: verbose });
  const truth = new DigTruth();
  const breaks: BreakEvent[] = [];
  const itemsAdded: { e: EntityInfo; tick: bigint }[] = [];
  const kicks: string[] = [];
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
      if (d?.type === 'playerBreakBlock') breaks.push({ ...(d as unknown as BreakEvent), at: performance.now() });
    } else {
      truth.receive(r);
    }
  });
  conn.on('disconnect', (p) => kicks.push(p.reason));
  world.entityTracker.onAdd((e) => {
    if (e.type === 'minecraft:item') itemsAdded.push({ e: { ...e, pos: { ...e.pos } }, tick: conn.tick });
  });
  loop.start();
  await conn.connect(DIG_TARGET);
  await world.waitForChunks(1, { timeoutMs: 30_000 });

  const teleport = async (feet: Vec3, yaw = 0): Promise<void> => {
    const seen = new Promise<void>((resolve) => {
      const off = loop.onEvent((e) => {
        if (e.kind === 'teleport' && Math.hypot(e.to.x - feet.x, e.to.y - feet.y, e.to.z - feet.z) < 0.01) {
          off();
          resolve();
        }
      });
    });
    await truth.ok('tp', [name, feet.x, feet.y, feet.z, yaw, 0]);
    await seen;
    loop.setCommand({ yaw, pitch: 0 });
    await world.waitForChunks(1, { center: feet, timeoutMs: 30_000 });
    await loop.waitTicks(10);
  };

  const release = async (): Promise<void> => {
    digger.cancel();
    if (conn.state === 'spawned') await loop.waitTicks(2);
  };

  const close = async (): Promise<void> => {
    await release();
    hotbar.dispose();
    loop.stop();
    world.dispose();
    await conn.disconnectAndFlush('test done');
  };

  return { name, conn, world, loop, hotbar, digger, truth, breaks, itemsAdded, kicks, teleport, release, close };
}

/** Quiet test world: no mobs, fixed noon. */
export async function prepareServer(): Promise<void> {
  for (const c of [['difficulty', 'peaceful'], ['gamerule', 'domobspawning', 'false'], ['gamerule', 'dodaylightcycle', 'false'], ['time', 'set', 'noon']]) {
    await consoleCommand(DIG_CONTAINER, ...c);
  }
}

/** Item entities within `r` blocks of `p` (only this run's area). */
export function killItemsNear(p: Vec3, r = 24): Promise<string> {
  return consoleCommand(DIG_CONTAINER, 'kill', `@e[type=item,x=${Math.floor(p.x)},y=${Math.floor(p.y)},z=${Math.floor(p.z)},r=${r}]`);
}

export { consoleCommand, sleep, pollUntil } from './world-truth.ts';
