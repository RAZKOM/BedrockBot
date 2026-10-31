// Task 1.1: reconnect policy details and leak checks across many reconnects.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionGateError } from '../../src/connection/connection.ts';
import { DisconnectLog, parseDisconnectLog } from '../../src/connection/disconnectLog.ts';
import { PacketRecorder, parseRecording } from '../../src/connection/recorder.ts';
import type { CloseInfo } from '../../src/connection/types.ts';
import { connectAndSpawn, flush, setup, TARGET } from './connection-fakes.ts';

describe('Connection reconnect policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not reconnect when the server says outdated_client, and rejects with VersionGateError', async () => {
    const { conn, clients, ping } = setup({ reconnect: { baseMs: 100, jitter: 0 } });
    const closes: CloseInfo[] = [];
    conn.onClose((c) => closes.push(c));
    const p = conn.connect(TARGET);
    const rejected = expect(p).rejects.toBeInstanceOf(VersionGateError);
    await flush();
    clients[0]!.kick('outdated_client', 'disconnectionScreen.outdatedClient');
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(clients).toHaveLength(1);
    expect(conn.state).toBe('closed');
    expect(closes).toEqual([
      expect.objectContaining({ kind: 'kick', willReconnect: false, versionMismatch: true, kick: { reason: 'outdated_client', message: 'disconnectionScreen.outdatedClient' } }),
    ]);
  });

  it('does not reconnect on play_status failed_client (older BDS answer to an outdated client)', async () => {
    const { conn, clients } = setup({ reconnect: { baseMs: 100, jitter: 0 } });
    const p = conn.connect(TARGET);
    const rejected = expect(p).rejects.toThrow(/play_status failed_client/);
    await flush();
    clients[0]!.receive('play_status', { status: 'failed_client' });
    clients[0]!.close();
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
    expect(conn.state).toBe('closed');
  });

  it('a version mismatch after a successful session also stops reconnecting', async () => {
    const { conn, clients } = setup({ reconnect: { baseMs: 100, jitter: 0 } });
    const closes: CloseInfo[] = [];
    conn.onClose((c) => closes.push(c));
    await connectAndSpawn(conn, clients);
    clients[0]!.kick('outdated_client');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
    expect(closes.at(-1)).toMatchObject({ willReconnect: false, versionMismatch: true });
  });

  it('keeps reconnecting after ordinary kicks (kicked, kicked_for_idle, server shutdown)', async () => {
    const { conn, clients } = setup({ reconnect: { baseMs: 100, jitter: 0 } });
    const closes: CloseInfo[] = [];
    conn.onClose((c) => closes.push(c));
    await connectAndSpawn(conn, clients);
    for (const [i, reason] of ['kicked', 'kicked_for_idle', 'server_shutdown'].entries()) {
      clients[i]!.kick(reason);
      await vi.advanceTimersByTimeAsync(100);
      clients[i + 1]!.spawn();
      expect(conn.state).toBe('spawned');
    }
    expect(closes.map((c) => [c.kick?.reason, c.willReconnect])).toEqual([
      ['kicked', true],
      ['kicked_for_idle', true],
      ['server_shutdown', true],
    ]);
  });

  it('link (the panel banner): state and since when, the scheduled retry and the attempt, back to 0 on spawn', async () => {
    const { conn, clients } = setup({ reconnect: { baseMs: 100, jitter: 0 } });
    expect(conn.link).toMatchObject({ state: 'idle', attempt: 0 });
    await connectAndSpawn(conn, clients);
    const spawned = conn.link;
    expect(spawned).toMatchObject({ state: 'spawned', attempt: 0 });
    expect(spawned.retryAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    clients[0]!.kick('kicked');
    const waiting = conn.link;
    expect(waiting).toMatchObject({ state: 'connecting', attempt: 1, retryAt: Date.now() + 100 });
    expect(waiting.since).toBe(Date.now());
    expect(waiting.since).toBeGreaterThanOrEqual(spawned.since + 5_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(conn.link.retryAt).toBeUndefined(); // the attempt runs
    expect(conn.link.attempt).toBe(1);
    clients[1]!.spawn();
    expect(conn.link).toMatchObject({ state: 'spawned', attempt: 0 });
    expect(conn.link.signIn).toBeUndefined();
  });

  it('a silent close (server restart, RakNet timeout) is kind "closed" and reconnects', async () => {
    const { conn, clients } = setup({ reconnect: { baseMs: 100, jitter: 0 } });
    const closes: CloseInfo[] = [];
    conn.onClose((c) => closes.push(c));
    await connectAndSpawn(conn, clients);
    await vi.advanceTimersByTimeAsync(5_000);
    clients[0]!.close();
    expect(closes[0]).toMatchObject({ reason: 'connection closed', kind: 'closed', willReconnect: true, retryInMs: 100 });
    expect(closes[0]!.spawnedMs).toBeGreaterThanOrEqual(5_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(clients).toHaveLength(2);
  });
});

describe('Connection survives reconnects without leaks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('handlers, tick driver and recorder fire exactly once per event after 5 reconnects', async () => {
    const lines: string[] = [];
    const recorder = new PacketRecorder((l) => lines.push(l));
    const { conn, clients } = setup({ recorder, reconnect: { baseMs: 100, jitter: 0 } });
    let texts = 0;
    let ticks = 0;
    let spawns = 0;
    let closes = 0;
    conn.on('text', () => texts++);
    conn.onTick(() => ticks++);
    conn.onSpawn(() => spawns++);
    conn.onClose(() => closes++);
    await connectAndSpawn(conn, clients);

    for (let i = 0; i < 5; i++) {
      clients[i]!.kick('kicked', `round ${i}`);
      await vi.advanceTimersByTimeAsync(100);
      clients[i + 1]!.spawn();
    }
    expect(clients).toHaveLength(6);
    expect(spawns).toBe(6);
    expect(closes).toBe(5);
    // Only the newest client has listeners; old ones were closed (removeAllListeners).
    for (const old of clients.slice(0, 5)) expect(old.listenerCount('text')).toBe(0);
    const current = clients[5]!;
    expect(current.listenerCount('text')).toBe(1);
    expect(current.listenerCount('close')).toBe(1);
    expect(current.listenerCount('packet')).toBe(1);

    // One packet -> one handler call and one recorder line.
    lines.length = 0;
    current.receive('text', { type: 'chat', message: 'after-reconnects' });
    expect(texts).toBe(1);
    const recs = parseRecording(lines.join('')).filter((r) => r.name === 'text');
    expect(recs).toHaveLength(1);

    // Exactly one 20 Hz driver: ~20 tick callbacks per second, not 20 x sessions.
    ticks = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBeGreaterThanOrEqual(19);
    expect(ticks).toBeLessThanOrEqual(21);
    // The tick counter restarted at the last spawn.
    expect(conn.tick).toBeLessThanOrEqual(21n);

    // Queued packets go out once, on the current client only.
    conn.queue('text', { needs_translation: false, type: 'chat', message: 'x' });
    await vi.advanceTimersByTimeAsync(50);
    expect(current.sentOf('text')).toHaveLength(1);
    for (const old of clients.slice(0, 5)) expect(old.sentOf('text')).toHaveLength(0);
  });

  it('a packet from an old client after reconnect is ignored', async () => {
    const { conn, clients } = setup({ reconnect: { baseMs: 100, jitter: 0 } });
    let texts = 0;
    conn.on('text', () => texts++);
    await connectAndSpawn(conn, clients);
    const old = clients[0]!;
    // Simulate a client whose close did not remove its listeners.
    old.removeAllListeners = () => old;
    old.kick('kicked');
    await vi.advanceTimersByTimeAsync(100);
    clients[1]!.spawn();
    old.receive('text', { type: 'chat', message: 'stale' });
    expect(texts).toBe(0);
    clients[1]!.receive('text', { type: 'chat', message: 'fresh' });
    expect(texts).toBe(1);
  });
});

describe('Connection client options', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies viewDistance to the client object (bedrock-protocol ignores the option); the target overrides', async () => {
    const a = setup({ viewDistance: 4 });
    await connectAndSpawn(a.conn, a.clients);
    expect(a.clients[0]!.viewDistance).toBe(4);
    a.conn.disconnect();
    const b = setup({ viewDistance: 4 });
    const p = b.conn.connect({ kind: 'bds', host: '127.0.0.1', port: 19132, transport: 'raknet', offline: true, viewDistance: 6 });
    await flush();
    expect(b.clients[0]!.viewDistance).toBe(6);
    b.clients[0]!.spawn();
    await p;
    const c = setup();
    await connectAndSpawn(c.conn, c.clients);
    expect(c.clients[0]!.viewDistance).toBe(10);
  });

  it('disconnectAndFlush resolves after the flush delay, with the disconnect packet written first', async () => {
    const { conn, clients } = setup();
    await connectAndSpawn(conn, clients);
    let done = false;
    const p = conn.disconnectAndFlush('bye', 250).then(() => { done = true; });
    expect(clients[0]!.names()).toContain('disconnect');
    expect(conn.state).toBe('closed');
    await vi.advanceTimersByTimeAsync(249);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    // Not connected: resolves at once.
    await conn.disconnectAndFlush();
  });
});

describe('DisconnectLog', () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'bot-disc-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one jsonl line per close with the kick reason', async () => {
    const path = join(dir, 'nested', 'disconnects.jsonl');
    const log = new DisconnectLog(path, { now: () => new Date('2026-10-28T12:00:00Z') });
    const { conn, clients } = setup({ reconnect: { baseMs: 100, jitter: 0 } });
    log.attach(conn, '127.0.0.1:19132 (raknet)');
    await connectAndSpawn(conn, clients);
    clients[0]!.kick('kicked_for_idle');
    await vi.advanceTimersByTimeAsync(100);
    clients[1]!.spawn();
    conn.disconnect('test over');
    const recs = parseDisconnectLog(readFileSync(path, 'utf8'));
    expect(recs).toEqual([
      {
        ts: '2026-10-28T12:00:00.000Z',
        username: 'UnitBot',
        server: '127.0.0.1:19132 (raknet)',
        gameVersion: '1.26.51',
        reason: 'kicked: kicked_for_idle',
        kind: 'kick',
        kick: { reason: 'kicked_for_idle' },
        willReconnect: true,
        retryInMs: 100,
        spawnedMs: 0,
      },
      expect.objectContaining({ reason: 'client: test over', kind: 'client', willReconnect: false }),
    ]);
    expect(log.count).toBe(2);
  });
});
