import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection, VersionGateError, type ConnectionOptions, type ProtocolClient, type ServerInfo } from '../../src/connection/connection.ts';
import { PacketRecorder, parseRecording } from '../../src/connection/recorder.ts';
import type { CloseInfo, ConnectTarget } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';

class FakeClient extends EventEmitter implements ProtocolClient {
  sent: { via: 'queue' | 'write'; name: string; params: Record<string, unknown> }[] = [];
  closed = false;
  queue(name: string, params: object): void {
    this.sent.push({ via: 'queue', name, params: params as Record<string, unknown> });
  }
  write(name: string, params: object): void {
    this.sent.push({ via: 'write', name, params: params as Record<string, unknown> });
  }
  disconnect(reason = 'Client leaving'): void {
    this.write('disconnect', { hide_disconnect_screen: false, message: reason, filtered_message: '' });
    this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    this.removeAllListeners();
  }
  /** Server -> client packet, the way bedrock-protocol emits it. */
  receive(name: string, params: Record<string, unknown>): void {
    this.emit('packet', { data: { name, params } });
    this.emit(name, params);
  }
  /** Drive a full spawn like BDS 1.26.51 does. */
  spawn(runtimeId = 7n): void {
    this.receive('start_game', { runtime_entity_id: runtimeId, player_position: { x: 0, y: 32769, z: 0 } });
    this.receive('respawn', { position: { x: 0.5, y: -58.38, z: 0.5 }, state: 1, runtime_entity_id: 0n });
    this.receive('play_status', { status: 'player_spawn' });
    this.emit('spawn');
  }
  names(): string[] {
    return this.sent.map((s) => s.name);
  }
}

const TARGET: ConnectTarget = { kind: 'bds', host: '127.0.0.1', port: 19132, transport: 'raknet', offline: true };
const INFO: ServerInfo = { transport: 'raknet', protocol: 2193, version: '1.26.51', motd: 'bds-dev', levelName: 'dev' };

function setup(opts: Partial<ConnectionOptions> = {}, info: ServerInfo = INFO) {
  const clients: FakeClient[] = [];
  const ping = vi.fn(() => Promise.resolve(info));
  const conn = new Connection({
    version: '1.26.51',
    username: 'UnitBot',
    logger: silentLogger,
    createClient: () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    ping,
    ...opts,
  });
  return { conn, clients, ping };
}

/** Let pending promise callbacks run (ping resolution, connect continuation). */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('Connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses unsupported versions before touching the network', async () => {
    const { conn, ping } = setup({ version: '1.99.0' });
    await expect(conn.connect(TARGET)).rejects.toBeInstanceOf(VersionGateError);
    expect(ping).not.toHaveBeenCalled();
    expect(conn.state).toBe('closed');
  });

  it('refuses a server that advertises another protocol, without reconnecting', async () => {
    const { conn, clients } = setup({}, { ...INFO, protocol: 2225, version: '1.26.60' });
    const closes: CloseInfo[] = [];
    conn.onClose((c) => closes.push(c));
    const p = conn.connect(TARGET);
    await expect(p).rejects.toThrow(/2225/);
    expect(clients).toHaveLength(0);
    expect(closes).toEqual([expect.objectContaining({ willReconnect: false })]);
  });

  it('rejects realm targets (not implemented yet)', async () => {
    const { conn } = setup();
    await expect(conn.connect({ kind: 'realm', profilesFolder: '/tmp/x' })).rejects.toThrow(/not implemented/);
  });

  it('performs the spawn handshake and resolves on spawn', async () => {
    const { conn, clients } = setup();
    const p = conn.connect(TARGET);
    await flush();
    const c = clients[0];
    expect(c).toBeDefined();
    if (!c) return;
    c.spawn(42n);
    await p;
    expect(conn.state).toBe('spawned');
    expect(conn.runtimeId).toBe(42n);
    expect(conn.gameVersion).toBe('1.26.51');
    expect(conn.spawnPosition).toEqual({ x: 0.5, y: -58.38, z: 0.5 });
    expect(c.sent).toEqual([
      { via: 'queue', name: 'respawn', params: { position: { x: 0.5, y: -58.38, z: 0.5 }, state: 2, runtime_entity_id: 42n } },
      { via: 'queue', name: 'serverbound_loading_screen', params: { type: 1 } },
      { via: 'queue', name: 'serverbound_loading_screen', params: { type: 2 } },
    ]);
  });

  it('dispatches typed packet handlers, also ones registered after spawn', async () => {
    const { conn, clients } = setup();
    const early: string[] = [];
    conn.on('text', (p) => early.push(p.message));
    const p = conn.connect(TARGET);
    await flush();
    const c = clients[0]!;
    c.spawn();
    await p;
    const late: unknown[] = [];
    const off = conn.on('some_future_packet', (pk) => late.push(pk.value));
    c.receive('text', { type: 'chat', message: 'one' });
    c.receive('some_future_packet', { value: 1 });
    off();
    c.receive('some_future_packet', { value: 2 });
    expect(early).toEqual(['one']);
    expect(late).toEqual([1]);
  });

  it('runs a 20 Hz tick driver and batches queued packets per tick', async () => {
    const { conn, clients } = setup();
    const p = conn.connect(TARGET);
    await flush();
    const c = clients[0]!;
    c.spawn();
    await p;
    const ticks: bigint[] = [];
    conn.onTick((t) => {
      ticks.push(t);
      conn.queue('text', { needs_translation: false, type: 'chat', message: `t${t}` });
    });
    const before = c.sent.length;
    conn.queue('subchunk_request', { dimension: 0, origin: { x: 0, y: -4, z: 0 }, requests: [{ x: 0, y: 0, z: 0 }] });
    expect(c.sent.length).toBe(before); // held until the next tick
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks.length).toBeGreaterThanOrEqual(19);
    expect(ticks.length).toBeLessThanOrEqual(21);
    expect(ticks.slice(0, 3)).toEqual([1n, 2n, 3n]);
    // Packets queued between ticks go out first, then whatever the tick handlers queued.
    expect(c.names().slice(before, before + 3)).toEqual(['subchunk_request', 'text', 'text']);
    expect(conn.tick).toBe(ticks.at(-1));
  });

  it('reconnects with backoff after a kick and logs the reason', async () => {
    const { conn, clients, ping } = setup({ reconnect: { baseMs: 1000, jitter: 0 } });
    const closes: CloseInfo[] = [];
    conn.onClose((ci) => closes.push(ci));
    let spawns = 0;
    conn.onSpawn(() => spawns++);
    const p = conn.connect(TARGET);
    await flush();
    clients[0]!.spawn();
    await p;

    clients[0]!.emit('kick', { reason: 'kicked', hide_disconnect_reason: false, message: 'bye' });
    clients[0]!.close();
    expect(conn.state).toBe('connecting');
    expect(closes.at(-1)).toEqual({ reason: 'kicked: kicked "bye"', willReconnect: true, retryInMs: 1000 });

    await vi.advanceTimersByTimeAsync(999);
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(clients).toHaveLength(2);
    clients[1]!.spawn();
    expect(conn.state).toBe('spawned');
    expect(spawns).toBe(2);
  });

  it('backs off exponentially while the server is down', async () => {
    const ping = vi.fn(() => Promise.reject(new Error('timeout')));
    const { conn } = setup({ ping, reconnect: { baseMs: 1000, jitter: 0, maxAttempts: 4 } });
    const closes: CloseInfo[] = [];
    conn.onClose((ci) => closes.push(ci));
    const p = conn.connect(TARGET);
    const rejected = expect(p).rejects.toThrow(/ping failed/);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 10);
    await rejected;
    expect(closes.map((c) => c.retryInMs)).toEqual([1000, 2000, 4000, 8000, undefined]);
    expect(ping).toHaveBeenCalledTimes(5);
    expect(conn.state).toBe('closed');
  });

  it('retries when spawn does not happen in time', async () => {
    const { conn, clients } = setup({ spawnTimeoutMs: 5000, reconnect: { baseMs: 100, jitter: 0 } });
    const closes: CloseInfo[] = [];
    conn.onClose((ci) => closes.push(ci));
    const p = conn.connect(TARGET).catch((e: unknown) => e);
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients[0]!.closed).toBe(true);
    expect(closes[0]).toMatchObject({ reason: 'no spawn within 5000 ms', willReconnect: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(clients).toHaveLength(2);
    conn.disconnect();
    expect(await p).toBeInstanceOf(Error);
  });

  it('disconnect() stops everything and does not reconnect', async () => {
    const { conn, clients } = setup();
    const closes: CloseInfo[] = [];
    conn.onClose((ci) => closes.push(ci));
    const p = conn.connect(TARGET);
    await flush();
    clients[0]!.spawn();
    await p;
    conn.disconnect('bye');
    expect(conn.state).toBe('closed');
    expect(clients[0]!.names()).toContain('disconnect');
    expect(closes).toEqual([{ reason: 'client: bye', willReconnect: false }]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(clients).toHaveLength(1);
  });

  it('records inbound and outbound packets with the current tick', async () => {
    const lines: string[] = [];
    const recorder = new PacketRecorder((l) => lines.push(l));
    const { conn, clients } = setup({ recorder });
    const p = conn.connect(TARGET);
    await flush();
    const c = clients[0]!;
    c.spawn(5n);
    await p;
    await vi.advanceTimersByTimeAsync(100);
    c.receive('text', { type: 'chat', message: 'x' });
    conn.disconnect();
    const recs = parseRecording(lines.join(''));
    const summary = recs.map((r) => `${r.dir}:${r.name}`);
    expect(summary).toEqual([
      'meta:connect',
      'in:start_game',
      'in:respawn',
      'out:respawn',
      'in:play_status',
      'out:serverbound_loading_screen',
      'out:serverbound_loading_screen',
      'in:text',
      'out:disconnect',
      'meta:close',
    ]);
    expect(recs.find((r) => r.name === 'start_game')?.params).toMatchObject({ runtime_entity_id: '5' });
    expect(recs.find((r) => r.name === 'text')?.tick).toBe(2);
  });
});
