// Task 1.3: metrics counters and the metrics.json writer.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDuration, kickKey, Metrics, type MetricsSnapshot } from '../../src/connection/metrics.ts';
import { connectAndSpawn, setup } from './connection-fakes.ts';

describe('Metrics', () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    dir = mkdtempSync(join(tmpdir(), 'bot-metrics-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts spawns, reconnects, kicks by reason and custom counters', async () => {
    const { conn, clients } = setup({ reconnect: { baseMs: 1000, jitter: 0 } });
    const m = new Metrics();
    m.attach(conn);
    m.provide(() => ({ position: { x: 1, y: 2, z: 3 } }));
    await connectAndSpawn(conn, clients);
    await vi.advanceTimersByTimeAsync(60_000);
    clients[0]!.kick('kicked_for_idle');
    await vi.advanceTimersByTimeAsync(1000);
    clients[1]!.spawn();
    clients[1]!.kick('kicked', 'Kicked by an operator');
    await vi.advanceTimersByTimeAsync(2000);
    clients[2]!.spawn();
    clients[2]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    clients[3]!.spawn();
    m.inc('nudges');
    m.inc('nudges');
    await vi.advanceTimersByTimeAsync(5_000);

    const s = m.snapshot();
    expect(s).toMatchObject({
      startedAt: '2026-10-28T12:00:00.000Z',
      uptimeS: 69,
      state: 'spawned',
      username: 'UnitBot',
      gameVersion: '1.26.51',
      session: { uptimeS: 5 },
      spawns: 4,
      reconnects: 3,
      disconnects: 3,
      closesByKind: { kick: 2, closed: 1 },
      kicks: { total: 2, byReason: { kicked_for_idle: 1, 'kicked: Kicked by an operator': 1 } },
      lastDisconnect: { reason: 'connection closed', kind: 'closed' },
      counters: { nudges: 2 },
      position: { x: 1, y: 2, z: 3 },
    });
    expect(s.tick).toBeGreaterThan(90);
  });

  it('writes metrics.json now and every interval, atomically', () => {
    const m = new Metrics();
    const path = join(dir, 'sub', 'metrics.json');
    m.startWriter(path, 60_000);
    const read = () => JSON.parse(readFileSync(path, 'utf8')) as MetricsSnapshot;
    expect(read().uptimeS).toBe(0);
    m.inc('nudges');
    vi.advanceTimersByTime(59_000);
    expect(read().counters).toEqual({});
    vi.advanceTimersByTime(1_000);
    expect(read()).toMatchObject({ uptimeS: 60, counters: { nudges: 1 }, session: null, state: 'idle' });
    vi.advanceTimersByTime(60_000);
    expect(read().uptimeS).toBe(120);
    m.inc('nudges');
    m.stopWriter();
    expect(read().counters).toEqual({ nudges: 2 });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    vi.advanceTimersByTime(600_000);
    expect(read().uptimeS).toBe(120); // stopped
  });

  it('kickKey and formatDuration', () => {
    expect(kickKey({ reason: 'kicked: kicked_for_idle', kind: 'kick', kick: { reason: 'kicked_for_idle' }, willReconnect: true })).toBe('kicked_for_idle');
    expect(kickKey({ reason: 'x', kind: 'kick', kick: { reason: 'kicked', message: 'bye' }, willReconnect: true })).toBe('kicked: bye');
    expect(kickKey({ reason: 'play_status failed_server_full', kind: 'kick', willReconnect: true })).toBe('play_status failed_server_full');
    expect([0, 59, 60, 61, 3599, 3600, 86_399, 86_400, 90_061].map(formatDuration)).toEqual(['0s', '59s', '1m00s', '1m01s', '59m59s', '1h00m', '23h59m', '1d00h', '1d01h']);
  });
});
