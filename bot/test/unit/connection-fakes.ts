// Shared unit-test doubles for the Connection layer: a fake bedrock-protocol client and a setup()
// that wires a Connection to it with a fake ping.
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { Connection, type ConnectionOptions, type ProtocolClient, type ServerInfo } from '../../src/connection/connection.ts';
import type { BdsTarget } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';

export class FakeClient extends EventEmitter implements ProtocolClient {
  sent: { via: 'queue' | 'write'; name: string; params: Record<string, unknown> }[] = [];
  closed = false;
  viewDistance?: number;
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
  receive(name: string, params: object): void {
    this.emit('packet', { data: { name, params } });
    this.emit(name, params);
  }
  /** Drive a full spawn like BDS 1.26.51 does. */
  spawn(runtimeId = 7n, eye = { x: 0.5, y: -58.38, z: 0.5 }): void {
    this.receive('start_game', { runtime_entity_id: runtimeId, player_position: { x: 0, y: 32769, z: 0 } });
    this.receive('respawn', { position: eye, state: 1, runtime_entity_id: 0n });
    this.receive('play_status', { status: 'player_spawn' });
    this.emit('spawn');
  }
  /** Server disconnect packet, the way bedrock-protocol handles it (disconnect, kick, close). */
  kick(reason: string, message = ''): void {
    const p = { reason, hide_disconnect_reason: false, message, filtered_message: '' };
    this.emit('packet', { data: { name: 'disconnect', params: p } });
    this.emit('disconnect', p);
    this.emit('kick', p);
    this.close();
  }
  names(): string[] {
    return this.sent.map((s) => s.name);
  }
  sentOf(name: string): Record<string, unknown>[] {
    return this.sent.filter((s) => s.name === name).map((s) => s.params);
  }
}

export const TARGET: BdsTarget = { kind: 'bds', host: '127.0.0.1', port: 19132, transport: 'raknet', offline: true };
export const INFO: ServerInfo = { transport: 'raknet', protocol: 2193, version: '1.26.51', motd: 'bds-dev', levelName: 'dev' };

export function setup(opts: Partial<ConnectionOptions> = {}, info: ServerInfo = INFO) {
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
export const flush = () => vi.advanceTimersByTimeAsync(0);

/** connect() and complete the first spawn on the first fake client. Needs fake timers. */
export async function connectAndSpawn(conn: Connection, clients: FakeClient[], runtimeId = 7n): Promise<FakeClient> {
  const p = conn.connect(TARGET);
  await flush();
  const c = clients.at(-1);
  if (!c) throw new Error('no client created');
  c.spawn(runtimeId);
  await p;
  return c;
}
