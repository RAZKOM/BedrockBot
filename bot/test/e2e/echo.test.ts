// e2e (tag @bds): needs the dev BDS from `pnpm bds:up` (container bds-dev, udp/19132).
// Runs only with BDS_E2E=1:  BDS_E2E=1 pnpm --filter bot test:e2e
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { EchoTask, type EchoEvent } from '../../src/tasks/echo.ts';

const E2E = process.env.BDS_E2E === '1';
const CONTAINER = process.env.BDS_CONTAINER ?? 'bds-dev';
const HOST = process.env.BDS_HOST ?? '127.0.0.1';
const PORT = Number(process.env.BDS_PORT ?? 19132);
const TARGET: ConnectTarget = { kind: 'bds', host: HOST, port: PORT, transport: 'raknet', offline: true };
const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Flat world: grass top at y = -61, so a standing player's feet are at y = -60 (eye -58.38). */
const FLAT_FEET_Y = -60;

function bdsCmd(...args: string[]): void {
  execFileSync('docker', ['exec', CONTAINER, 'send-command', ...args], { stdio: 'ignore' });
}

function waitFor<T>(subscribe: (done: (v: T) => void) => () => void, timeoutMs: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
    }, timeoutMs);
    const unsubscribe = subscribe((v) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(v);
    });
  });
}

describe.skipIf(!E2E)('@bds echo task against bds-dev', () => {
  let conn: Connection | undefined;
  afterEach(() => {
    conn?.disconnect('test done');
    conn = undefined;
  });

  it('spawns on the flat world at feet y -60 and receives a console say within 10 s', async () => {
    conn = new Connection({ version: '1.26.51', username: 'E2EEcho', logger: silentLogger, reconnect: false });
    const task = new EchoTask(conn, { print: () => {} });
    const events: EchoEvent[] = [];
    task.onEvent((e) => events.push(e));
    task.start();

    const t0 = Date.now();
    await conn.connect(TARGET);
    expect(conn.state).toBe('spawned');
    expect(conn.serverInfo?.protocol).toBe(2193);
    expect(conn.runtimeId).toBeGreaterThan(0n);

    // The respawn (state 1) packet carries the real spawn; start_game's y is a placeholder.
    const feet: Vec3 =
      task.feet ??
      (await waitFor<Vec3>((done) => task.onEvent((e) => { if (e.kind === 'position') done(e.feet); }), 5_000, 'own position'));
    expect(Math.abs(feet.y - FLAT_FEET_Y)).toBeLessThanOrEqual(1);
    expect(conn.spawnPosition?.y).toBeCloseTo(FLAT_FEET_Y + 1.62, 1);

    const token = `e2e-ping-${Math.random().toString(36).slice(2, 8)}`;
    const heard = waitFor<string>(
      (done) => task.onEvent((e) => { if (e.kind === 'chat' && e.text.includes(token)) done(e.text); }),
      10_000,
      `"${token}" in chat`,
    );
    const sentAt = Date.now();
    bdsCmd('say', token);
    const text = await heard;
    expect(text).toBe(`[Server] ${token}`);
    expect(Date.now() - sentAt).toBeLessThan(10_000);
    expect(Date.now() - t0).toBeLessThan(20_000);
    // The tick driver runs while spawned.
    expect(conn.tick).toBeGreaterThan(0n);
  });

  it('CLI `bot --task echo` prints the say and exits 0 within 10 s', async () => {
    const token = `e2e-cli-${Math.random().toString(36).slice(2, 8)}`;
    const t0 = Date.now();
    const child = spawn(
      process.execPath,
      ['src/index.ts', '--task', 'echo', '--host', HOST, '--port', String(PORT), '--version', '1.26.51', '--username', 'E2ECli', '--no-reconnect', '--exit-on-chat', token],
      { cwd: BOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    let said = false;
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => { resolve(code); }));
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (!said && out.includes('[spawn]')) {
        said = true;
        bdsCmd('say', token);
      }
    });
    const timeout = setTimeout(() => child.kill(), 15_000);
    const code = await exit;
    clearTimeout(timeout);
    const elapsed = Date.now() - t0;
    expect(code, `stdout:\n${out}\nstderr:\n${err}`).toBe(0);
    expect(out).toContain(`[chat:announcement] [Server] ${token}`);
    expect(out).toMatch(/\[pos:respawn\] feet [-\d.]+ -60\.00 /);
    expect(elapsed).toBeLessThan(10_000);
  });
});
