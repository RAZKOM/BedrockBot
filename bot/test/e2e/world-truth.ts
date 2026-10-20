// Shared helpers for the world e2e tests: a typed truth-pack client that sends `/scriptevent truth:*`
// through `docker exec <container> send-command` and matches '@truth' replies (received by the bot
// as text packets) by request id. Targets the bds-world container on udp/19142 by default.
import { execFile } from 'node:child_process';
import { ReplyParser, rleDecode, textOf, type Reply } from '../../../packs/truth/src/protocol.ts';
import type { BdsTarget } from '../../src/connection/types.ts';
import { bdsTarget } from './env.ts';

export const E2E = process.env.BDS_E2E === '1';
export const WORLD_CONTAINER = process.env.BDS_WORLD_CONTAINER ?? 'bds-world';
export const WORLD_HOST = process.env.BDS_WORLD_HOST ?? '127.0.0.1';
export const WORLD_PORT = Number(process.env.BDS_WORLD_PORT ?? 19142);
/** Transport from env BDS_TRANSPORT (env.ts). */
export const WORLD_TARGET: BdsTarget = bdsTarget(WORLD_HOST, WORLD_PORT);

export interface TextSource {
  on(name: 'text', fn: (p: { type?: string; message?: string }) => void): () => void;
}

export function consoleCommand(container: string, ...words: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', container, 'send-command', ...words], (err, stdout, stderr) => {
      if (err) reject(new Error(`send-command failed: ${err.message} ${stderr}`));
      else resolve(stdout);
    });
  });
}

export interface BlocksData {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  palette: string[];
  runs: [number, number][];
}

export class Truth {
  readonly container: string;
  private readonly parser = new ReplyParser();
  private readonly pending = new Map<string, (r: Reply) => void>();
  private seq = 0;
  private readonly unsub: () => void;

  constructor(source: TextSource, container = WORLD_CONTAINER) {
    this.container = container;
    this.unsub = source.on('text', (p) => {
      let reply: Reply | null;
      try {
        reply = this.parser.feed(textOf(p));
      } catch {
        return;
      }
      if (reply?.id == null) return;
      const fn = this.pending.get(reply.id);
      if (fn) {
        this.pending.delete(reply.id);
        fn(reply);
      }
    });
  }

  dispose(): void {
    this.unsub();
  }

  cmd(name: string, args: (string | number)[] = [], timeoutMs = 15_000): Promise<Reply> {
    const id = `w${++this.seq}`;
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

  /** typeIds of a box in canonical y, z, x order. */
  async blocks(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): Promise<{ data: BlocksData; ids: string[] }> {
    return decodeBlocks(await this.ok<BlocksData>('blocks', [a.x, a.y, a.z, b.x, b.y, b.z]));
  }
}

/** Expands a truth:blocks reply into typeIds in canonical y, z, x order. */
export function decodeBlocks(raw: unknown): { data: BlocksData; ids: string[] } {
  const data = raw as BlocksData;
  return { data, ids: rleDecode(data.palette, data.runs) };
}

/** Position of canonical index i in a box. */
export function boxPos(from: { x: number; y: number; z: number }, size: { x: number; y: number; z: number }, i: number) {
  const x = i % size.x;
  const z = Math.floor(i / size.x) % size.z;
  const y = Math.floor(i / (size.x * size.z));
  return { x: from.x + x, y: from.y + y, z: from.z + z };
}

/** Deterministic PRNG (mulberry32) so failures are reproducible from the logged seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls `check` every 10 ms until it returns true or `timeoutMs` passes; resolves with the elapsed ms or -1. */
export async function pollUntil(check: () => boolean, timeoutMs: number): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    if (check()) return performance.now() - t0;
    if (performance.now() - t0 > timeoutMs) return -1;
    await sleep(10);
  }
}

/** Offline username unique per run (max 16 chars), so a lingering session never conflicts (server_id_conflict). */
export function uniqueName(prefix: string): string {
  return `${prefix.slice(0, 10)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Disconnect and give RakNet a moment to deliver it before the test process moves on or exits. */
export async function leave(conn: { disconnect(reason?: string): void; state: string } | undefined): Promise<void> {
  if (!conn || conn.state === 'closed') return;
  conn.disconnect('test done');
  await sleep(300);
}

/**
 * Sends a stand-still `player_auth_input` every tick so the server ticks the player (inventory
 * sync, item pickup and other per-player work only happen while it does). Track C owns the real
 * input loop; this is a test-only stand-in. Returns a stop function.
 */
export function standStill(
  conn: { onTick(fn: (tick: bigint) => void): () => void; queue(name: string, params: Record<string, unknown>): void },
  feet: () => { x: number; y: number; z: number },
): () => void {
  return conn.onTick((tick) => {
    const f = feet();
    const zero = { x: 0, z: 0 };
    conn.queue('player_auth_input', {
      pitch: 0,
      yaw: 0,
      position: { x: f.x, y: f.y + 1.62, z: f.z },
      move_vector: zero,
      head_yaw: 0,
      input_data: ['vertical_collision'],
      input_mode: 'mouse',
      play_mode: 'normal',
      interaction_model: 'crosshair',
      interact_rotation: zero,
      tick,
      delta: { x: 0, y: 0, z: 0 },
      analogue_move_vector: zero,
      camera_orientation: { x: 0, y: 0, z: 1 },
      raw_move_vector: zero,
    });
  });
}
