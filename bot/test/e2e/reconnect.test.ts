// e2e (tag @bds), task 1.1: reconnect across a real `docker restart bds-dev` and a console kick,
// with every disconnect reason in a jsonl log and no duplicated handlers afterwards.
// Runs only with BDS_E2E=1:  BDS_E2E=1 pnpm --filter bot test:e2e
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Connection, VersionGateError } from '../../src/connection/connection.ts';
import { DisconnectLog, parseDisconnectLog } from '../../src/connection/disconnectLog.ts';
import { supportedVersions } from '../../src/connection/protocol.ts';
import { PacketRecorder, parseRecording } from '../../src/connection/recorder.ts';
import type { CloseInfo } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { bdsCmd, bdsScript, E2E, HOST, PORT, sleep, TARGET, VERSION, waitFor } from './chat-helpers.ts';
import { E2E_TRANSPORT } from './env.ts';

describe.skipIf(!E2E)('@bds reconnect against bds-dev', () => {
  let dir: string;
  let conn: Connection | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bot-e2e-reconnect-'));
  });
  afterEach(async () => {
    await conn?.disconnectAndFlush('test done');
    conn = undefined;
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeBot(username: string, logFile: string) {
    const lines: string[] = [];
    const recorder = new PacketRecorder((l) => lines.push(l));
    const c = new Connection({
      version: VERSION,
      username,
      logger: silentLogger,
      recorder,
      // Tight cap so the bot polls often while BDS restarts (~16 s).
      reconnect: { baseMs: 1_000, capMs: 4_000, jitter: 0.2 },
      pingTimeoutMs: 2_000,
    });
    const log = new DisconnectLog(logFile);
    log.attach(c, `${HOST}:${PORT} (${E2E_TRANSPORT})`);
    const closes: CloseInfo[] = [];
    c.onClose((i) => closes.push(i));
    let spawns = 0;
    c.onSpawn(() => spawns++);
    return { conn: c, lines, closes, spawns: () => spawns };
  }

  /** After a reconnect: one console say -> exactly one handler call and one recorded packet; ~20 ticks/s. */
  async function assertNoDuplicates(c: Connection, lines: string[]): Promise<void> {
    const token = `e2e-dup-${Math.random().toString(36).slice(2, 8)}`;
    let calls = 0;
    const off = c.on('text', (p) => {
      if (p.message.includes(token)) calls++;
    });
    let ticks = 0;
    const offTick = c.onTick(() => ticks++);
    bdsCmd('say', token);
    await sleep(2_000);
    off();
    offTick();
    expect(calls).toBe(1);
    const recorded = parseRecording(lines.join('')).filter((r) => r.dir === 'in' && r.name === 'text' && JSON.stringify(r.params).includes(token));
    expect(recorded).toHaveLength(1);
    expect(ticks).toBeGreaterThanOrEqual(36);
    expect(ticks).toBeLessThanOrEqual(42);
  }

  it('comes back within 60 s after `docker restart bds-dev` and logs the disconnect reason', async () => {
    const logFile = join(dir, 'restart', 'disconnects.jsonl');
    const bot = makeBot('E2ERestart', logFile);
    conn = bot.conn;
    await conn.connect(TARGET);
    expect(conn.state).toBe('spawned');

    const t0 = Date.now();
    const restarted = bdsScript(['restart']); // resolves once BDS logs "Server started." again
    const back = waitFor<void>((done) => bot.conn.onSpawn(() => { done(); }), 60_000, 'respawn after docker restart');
    await back;
    const elapsed = Date.now() - t0;
    await restarted;
    console.log(`[reconnect] back after docker restart in ${(elapsed / 1000).toFixed(1)} s; closes: ${JSON.stringify(bot.closes.map((c) => c.reason))}`);
    expect(elapsed).toBeLessThan(60_000);
    expect(conn.state).toBe('spawned');
    expect(bot.spawns()).toBe(2);

    const recs = parseDisconnectLog(readFileSync(logFile, 'utf8'));
    expect(recs.length).toBeGreaterThanOrEqual(1);
    const first = recs[0]!;
    expect(first).toMatchObject({ username: 'E2ERestart', gameVersion: VERSION, willReconnect: true });
    expect(first.reason.length).toBeGreaterThan(0);
    expect(first.spawnedMs).toBeGreaterThan(0);
    // Later lines are failed attempts while BDS was down (ping timeouts), all retried.
    for (const r of recs) expect(r.willReconnect).toBe(true);

    await assertNoDuplicates(conn, bot.lines);
  }, 120_000);

  it('reconnects after a console kick and logs the kick reason', async () => {
    const logFile = join(dir, 'kick', 'disconnects.jsonl');
    const bot = makeBot('E2EKick', logFile);
    conn = bot.conn;
    await conn.connect(TARGET);
    await sleep(500);
    const t0 = Date.now();
    const back = waitFor<void>((done) => bot.conn.onSpawn(() => { done(); }), 20_000, 'respawn after kick');
    bdsCmd('kick', 'E2EKick', 'e2e kick test');
    await back;
    console.log(`[reconnect] back after kick in ${((Date.now() - t0) / 1000).toFixed(1)} s; close: ${JSON.stringify(bot.closes[0])}`);
    expect(bot.closes[0]).toMatchObject({ kind: 'kick', willReconnect: true });
    expect(bot.closes[0]!.kick?.message ?? '').toContain('e2e kick test');
    const recs = parseDisconnectLog(readFileSync(logFile, 'utf8'));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: 'kick', kick: bot.closes[0]!.kick, willReconnect: true });
    await assertNoDuplicates(conn, bot.lines);
  }, 60_000);

  it('refuses a game version the server does not speak, without retrying', async () => {
    const other = Object.entries(supportedVersions).find(([v, p]) => v !== VERSION && p !== supportedVersions[VERSION]);
    expect(other).toBeDefined();
    const c = new Connection({ version: other![0], username: 'E2EGate', logger: silentLogger, reconnect: { baseMs: 100 } });
    const closes: CloseInfo[] = [];
    c.onClose((i) => closes.push(i));
    await expect(c.connect(TARGET)).rejects.toBeInstanceOf(VersionGateError);
    await sleep(1_000);
    expect(c.state).toBe('closed');
    expect(closes).toEqual([expect.objectContaining({ kind: 'version', willReconnect: false, versionMismatch: true })]);
  });
});
