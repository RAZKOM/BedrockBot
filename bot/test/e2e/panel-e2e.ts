// The panel e2e's shared parts (docs/panel.md "Tests"): a token, the panel client (state, the
// rate-limited `cmd()` poster, health), the bot CLI started with the panel on and every file it writes in
// a temporary directory (a config file, the world cache, the event store; never the user's), and the
// observer connection the truth commands go through. Used by panel-core, panel-actions, panel-stream,
// panel-map and panel-storage.
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import type { ConnectTarget } from '../../src/connection/types.ts';
import type { PanelState } from '../../src/health/panel/state.ts';
import { silentLogger } from '../../src/log.ts';
import { sleep, startCli, until, waitOnline, type CoreCli } from './core-truth.ts';
import { E2E_VERSION } from './env.ts';
import { PveTruth } from './pve-truth.ts';

/** A panel token (24 characters, the alphabet the config generates). */
export function panelToken(): string {
  return Array.from({ length: 24 }, () => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(57)]).join('');
}

/** A random port in [from, from + 10): each e2e file has its own block of ten. */
export const panelPort = (env: string | undefined, from: number): number => Number(env ?? from + randomInt(10));

export interface CmdAnswer {
  status: number;
  /** Round trip of the POST. */
  ms: number;
  body: { ok: boolean; command: string; replies: string[]; error?: string };
}

export interface PanelClient {
  port: number;
  token: string;
  base: string;
  auth: { authorization: string };
  /** GET /api/state (expects 200). */
  state(): Promise<PanelState>;
  /** POST /api/cmd, at most one every 220 ms (the panel allows 5 per second); `raw` skips the wait (the rate-limit test). */
  cmd(text: string, raw?: boolean): Promise<CmdAnswer>;
  /** GET a JSON path behind the token. */
  get<T>(path: string): Promise<T>;
  /** Wait for /healthz 200. */
  healthy(ms?: number): Promise<void>;
}

export function panelClient(port: number, token = panelToken()): PanelClient {
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${token}` };
  let lastCmdAt = 0;
  return {
    port,
    token,
    base,
    auth,
    async state() {
      const r = await fetch(`${base}/api/state`, { headers: auth });
      expect(r.status).toBe(200);
      return (await r.json()) as PanelState;
    },
    async cmd(text, raw = false) {
      if (!raw) {
        const wait = 220 - (Date.now() - lastCmdAt); // stay well under 5 per second
        if (wait > 0) await sleep(wait);
        lastCmdAt = Date.now();
      }
      const t0 = performance.now();
      const r = await fetch(`${base}/api/cmd`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      return { status: r.status, ms: performance.now() - t0, body: (await r.json()) as CmdAnswer['body'] };
    },
    async get<T>(path: string) {
      const r = await fetch(`${base}${path}`, { headers: auth });
      expect(r.status, `GET ${path}`).toBe(200);
      return (await r.json()) as T;
    },
    async healthy(ms = 20_000) {
      await until(async () => ((await fetch(`${base}/healthz`).catch(() => undefined))?.status === 200 ? true : undefined), ms, 'panel /healthz 200', 250);
    },
  };
}

export interface PanelCli {
  cli: CoreCli;
  /** The temporary directory: config.json, the world cache, `events/` when asked. */
  dir: string;
  /** Remove the directory (after the bot exited). */
  cleanup(): void;
}

export interface PanelCliOptions {
  /** The temporary directory's prefix (`bot-e2e-panel-...`). */
  prefix: string;
  /** More CLI arguments (`--walk` ...). */
  args?: string[];
  name?: string;
  target?: { host: string; port: number };
  /** The event store in `<dir>/events` (else the CLI's default, which the e2e should not use for files it reads). */
  events?: boolean;
  /** The config file's content (default `{}`). */
  config?: Record<string, unknown>;
}

/**
 * The bot CLI with the panel on `panel.port` and its token, every file in a temporary directory: a config
 * file (so `!wp set` writes `<dir>/waypoints/`, not the user's), the world cache (`BEDROCKBOT_CACHE_DIR`),
 * the event store when asked. The env is set only while the child starts.
 */
export function startPanelCli(panel: PanelClient, o: PanelCliOptions): PanelCli {
  const dir = mkdtempSync(join(tmpdir(), o.prefix));
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(o.config ?? {})}\n`);
  const keep = { token: process.env.BEDROCKBOT_PANEL_TOKEN, cache: process.env.BEDROCKBOT_CACHE_DIR, events: process.env.BEDROCKBOT_EVENTS_DIR, on: process.env.BEDROCKBOT_CACHE };
  process.env.BEDROCKBOT_PANEL_TOKEN = panel.token;
  process.env.BEDROCKBOT_CACHE_DIR = dir;
  if (o.events) process.env.BEDROCKBOT_EVENTS_DIR = join(dir, 'events');
  delete process.env.BEDROCKBOT_CACHE;
  let cli: CoreCli;
  try {
    cli = startCli([...(o.args ?? []), '--health-port', String(panel.port), '--config', join(dir, 'config.json')], o.name, o.target);
  } finally {
    const put = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    put('BEDROCKBOT_PANEL_TOKEN', keep.token);
    put('BEDROCKBOT_CACHE_DIR', keep.cache);
    put('BEDROCKBOT_EVENTS_DIR', keep.events);
    put('BEDROCKBOT_CACHE', keep.on);
  }
  return { cli, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `!quit` from the panel, then wait for the exit (kill after 10 s). */
export async function quitPanelCli(panel: PanelClient, cli: CoreCli | undefined): Promise<void> {
  if (!cli) return;
  await sleep(300);
  await panel.cmd('!quit').catch(() => undefined);
  await Promise.race([cli.exit, sleep(10_000)]);
  cli.kill();
}

export interface Observer<T extends PveTruth = PveTruth> {
  name: string;
  conn: Connection;
  truth: T;
  close(): Promise<void>;
}

/**
 * A player connection that sends the truth commands (`container` is the BDS container the pack runs in);
 * `make` builds a richer truth class on it (HomeTruth for bds-home).
 */
export async function connectObserver<T extends PveTruth = PveTruth>(name: string, target: ConnectTarget, container: string, make?: (conn: Connection, container: string) => T): Promise<Observer<T>> {
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
  await conn.connect(target);
  const truth = make ? make(conn, container) : (new PveTruth(conn, container) as T);
  await waitOnline(truth, name);
  return { name, conn, truth, close: () => conn.disconnectAndFlush('test done') };
}
