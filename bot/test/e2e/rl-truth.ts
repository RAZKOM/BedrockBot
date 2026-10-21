// Shared setup for the RL e2e tests (PLAN.md tasks 6.1 and 6.2) against bds-rl (udp/19156, flat world,
// truth pack with rl:*; docker/compose.rl.yml). Env: RL_BDS_HOST (127.0.0.1), RL_BDS_PORT (19156),
// RL_BDS_CONTAINER (bds-rl); game version and transport from env.ts. RL_VERBOSE=1 logs the task.
//
// Isolation: every run uses its own arena origin (a random cell far from spawn), so a leftover bot
// from a killed run or the Python contract test (origin 0,0) never shares blocks with it, and truth
// request ids carry a random per-run tag (CommandClient / RunTruth).
import { randomInt } from 'node:crypto';
import { ReplyParser, textOf } from '../../../packs/truth/src/protocol.ts';
import { Connection } from '../../src/connection/connection.ts';
import type { ConnectTarget } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import type { Outbound } from '../../src/bridge/schema.ts';
import { RlAgentTask, type RlAgentOptions } from '../../src/tasks/rlAgent.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { DigTruth } from './dig-truth.ts';
import { consoleCommand, uniqueName } from './world-truth.ts';

export const E2E = process.env.BDS_E2E === '1';
export const RL_HOST = process.env.RL_BDS_HOST ?? '127.0.0.1';
export const RL_PORT = Number(process.env.RL_BDS_PORT ?? 19156);
export const RL_CONTAINER = process.env.RL_BDS_CONTAINER ?? 'bds-rl';
export const RL_TARGET: ConnectTarget = bdsTarget(RL_HOST, RL_PORT);
export const VERBOSE = process.env.RL_VERBOSE === '1';

/** A random arena origin on a 128-block grid, 1024+ blocks from spawn (one per run). */
export function runOrigin(): [number, number] {
  const cell = randomInt(64);
  return [1024 + 128 * (cell % 8), 1024 + 128 * Math.floor(cell / 8)];
}

export async function prepareServer(container = RL_CONTAINER): Promise<void> {
  for (const c of [
    ['difficulty', 'peaceful'],
    ['gamerule', 'domobspawning', 'false'],
    ['gamerule', 'dodaylightcycle', 'false'],
    ['gamerule', 'doweathercycle', 'false'],
  ]) {
    await consoleCommand(container, ...c);
  }
}

export interface RlBot {
  name: string;
  conn: Connection;
  task: RlAgentTask;
  /** Truth commands through `docker exec` (independent of the bot's own command path). */
  truth: DigTruth;
  port: number;
  close(): Promise<void>;
}

/** Connects a bot running the RL task (in process) with the bridge on a free loopback port. */
export async function connectRlBot(prefix: string, opts: Partial<RlAgentOptions> = {}): Promise<RlBot> {
  await prepareServer();
  const name = uniqueName(prefix);
  const log = VERBOSE ? createLogger('debug', 'rl') : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
  const task = RlAgentTask.create(conn, { version: E2E_VERSION, bridgePort: 0, log, ...opts });
  const truth = new DigTruth(RL_CONTAINER);
  await task.start();
  // DigTruth needs the replies: reuse the bot's text stream.
  const parser = new ReplyParser();
  conn.on('text', (p) => {
    try {
      const r = parser.feed(textOf(p));
      if (r && r.cmd !== 'event') truth.receive(r);
    } catch {
      // not a truth line
    }
  });
  await conn.connect(RL_TARGET);
  await task.ready();
  const port = Number(/:(\d+)$/.exec(task.bridge.address)![1]);
  return {
    name,
    conn,
    task,
    truth,
    port,
    close: async () => {
      task.stop();
      await conn.disconnectAndFlush('test done');
    },
  };
}

/** Promise-based WebSocket client over Node's global WebSocket (one env, request/response by id). */
export class BridgeClient {
  readonly ws: WebSocket;
  readonly hello: Promise<Outbound>;
  private readonly queue: Outbound[] = [];
  private readonly waiters: ((m: Outbound) => void)[] = [];
  private nextId = 1;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data)) as Outbound;
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
    this.hello = this.recv();
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
    });
  }

  recv(timeoutMs = 30_000): Promise<Outbound> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bridge reply timeout')), timeoutMs);
      this.waiters.push((x) => {
        clearTimeout(t);
        resolve(x);
      });
    });
  }

  async request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Outbound> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ ...msg, id }));
    const r = await this.recv(timeoutMs);
    if ('id' in r && r.id !== id && r.id !== null) throw new Error(`reply id ${String(r.id)} != ${id}`);
    return r;
  }

  close(): void {
    this.ws.close();
  }
}

export { consoleCommand, sleep } from './world-truth.ts';
