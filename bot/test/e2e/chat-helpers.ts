// Shared helpers for the Phase 1 e2e suites (reconnect, chat, keepalive) against bds-dev.
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseTruthReply, rawTextToPlain, stripFormatting, type TruthReply } from '../../src/chat/text.ts';
import type { Connection } from '../../src/connection/connection.ts';
import type { BdsTarget, TextPacket } from '../../src/connection/types.ts';
import { bdsTarget, E2E_VERSION, rawClientTransport } from './env.ts';

export const E2E = process.env.BDS_E2E === '1';
export const SOAK = process.env.BDS_SOAK === '1';
export const CONTAINER = process.env.BDS_CONTAINER ?? 'bds-dev';
export const HOST = process.env.BDS_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.BDS_PORT ?? 19132);
/** Game version (env BOT_VERSION, default 1.26.60) and transport (BDS_TRANSPORT) live in env.ts. */
export const VERSION = E2E_VERSION;
export const TARGET: BdsTarget = bdsTarget(HOST, PORT);
export const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const REPO_DIR = fileURLToPath(new URL('../../..', import.meta.url));
export const BDS_SCRIPT = fileURLToPath(new URL('../../../scripts/bds.mjs', import.meta.url));

/** Server console command through `docker exec <container> send-command`. */
export function bdsCmd(...args: string[]): void {
  execFileSync('docker', ['exec', CONTAINER, 'send-command', ...args], { stdio: 'ignore' });
}

/** `node scripts/bds.mjs <args>` (touches only BDS_CONTAINER, default bds-dev). Resolves with its stdout. */
export function bdsScript(args: string[], env: Record<string, string | undefined> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BDS_SCRIPT, ...args], { cwd: REPO_DIR, env: { ...process.env, ...env }, timeout: 240_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`bds.mjs ${args.join(' ')} failed: ${err.message}\n${stdout}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function waitFor<T>(subscribe: (done: (v: T) => void) => () => void, timeoutMs: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
    }, timeoutMs);
    unsubscribe = subscribe((v) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(v);
    });
  });
}

let truthSeq = 0;

/**
 * Run `scriptevent truth:<cmd> #<id> args` from the console and resolve with the reply, read from
 * the `text` packets `conn` receives (replies are broadcast to every player).
 */
export function truthQuery(conn: Connection, cmd: string, args: string[] = [], timeoutMs = 5_000): Promise<TruthReply> {
  const id = `e2e${process.pid}x${++truthSeq}`;
  const reply = waitFor<TruthReply>(
    (done) =>
      conn.on('text', (p) => {
        const r = parseTruthReply(rawTextToPlain(p.message));
        if (r?.id === id) done(r);
      }),
    timeoutMs,
    `truth:${cmd} #${id}`,
  );
  bdsCmd('scriptevent', `truth:${cmd}`, `#${id}`, ...args);
  return reply;
}

interface RawClient {
  on(event: string, fn: (p: never) => void): void;
  queue(name: string, params: object): void;
  disconnect(reason?: string): void;
  close(): void;
}

export interface Observer {
  username: string;
  texts: TextPacket[];
  /** The server's disconnect packet, if it kicked this client. */
  kick: { reason: string; message?: string } | undefined;
  closed: boolean;
  /** Send a player chat line (authored category, as the vanilla client does). */
  chat(message: string): void;
  /** Resolve with the first text packet from `source` (ignoring § codes) whose message matches. */
  waitText(match: (p: TextPacket) => boolean, timeoutMs: number, what: string): Promise<TextPacket>;
  close(): void;
}

/**
 * A throwaway second player: plain bedrock-protocol createClient (offline, VERSION, same transport) with the
 * spawn handshake copied from src/connection, independent of the code under test.
 */
export function connectObserver(username: string, timeoutMs = 20_000): Promise<Observer> {
  const require = createRequire(import.meta.url);
  const bedrock = require('bedrock-protocol') as { createClient(o: object): RawClient };
  return new Promise((resolve, reject) => {
    const client = bedrock.createClient({ host: HOST, port: PORT, username, offline: true, version: VERSION, ...rawClientTransport() });
    const texts: TextPacket[] = [];
    const state: { kick: Observer['kick']; closed: boolean } = { kick: undefined, closed: false };
    const waiters = new Set<(p: TextPacket) => void>();
    let rid = 0n;
    const timer = setTimeout(() => {
      client.close();
      reject(new Error(`observer ${username}: no spawn within ${timeoutMs} ms`));
    }, timeoutMs);
    client.on('start_game', (p: { runtime_entity_id: bigint }) => {
      rid = p.runtime_entity_id;
    });
    client.on('respawn', (p: { state: number; position: object }) => {
      if (p.state === 1) client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: rid });
    });
    client.on('play_status', (p: { status: string }) => {
      if (p.status === 'player_spawn') {
        client.queue('serverbound_loading_screen', { type: 1 });
        client.queue('serverbound_loading_screen', { type: 2 });
      }
    });
    client.on('text', (p: TextPacket) => {
      texts.push(p);
      for (const w of [...waiters]) w(p);
    });
    client.on('kick', (p: { reason: string; message?: string }) => {
      state.kick = { reason: p.reason, message: p.message };
    });
    client.on('close', () => {
      state.closed = true;
    });
    client.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    client.on('spawn', () => {
      clearTimeout(timer);
      resolve({
        username,
        texts,
        get kick() {
          return state.kick;
        },
        get closed() {
          return state.closed;
        },
        chat: (message) => {
          client.queue('text', { needs_translation: false, category: 'authored', type: 'chat', source_name: username, message, xuid: '', platform_chat_id: '', has_filtered_message: false });
        },
        waitText: (match, ms, what) => {
          const seen = texts.find(match);
          if (seen) return Promise.resolve(seen);
          return waitFor<TextPacket>(
            (done) => {
              const w = (p: TextPacket) => {
                if (match(p)) done(p);
              };
              waiters.add(w);
              return () => waiters.delete(w);
            },
            ms,
            what,
          );
        },
        close: () => {
          client.disconnect('observer done');
        },
      });
    });
  });
}

/** True for a chat packet sent by `username` (BDS appends §r to relayed names). */
export function isChatFrom(p: TextPacket, username: string): boolean {
  return p.type === 'chat' && stripFormatting(p.source_name ?? '') === username;
}
