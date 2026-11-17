// Track U2 step 3: the game version is picked per session (Connection `versions`, `sessionVersion`; versionGate.ts
// pickVersion; config/resolve.ts autoVersions). Fakes only.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientOptions } from 'bedrock-protocol';
import { Connection, VERSION_RETRY_MS, VersionGateError } from '../../src/connection/connection.ts';
import { supportedVersions } from '../../src/connection/protocol.ts';
import type { CloseInfo, RealmTarget } from '../../src/connection/types.ts';
import { checkVersion, pickVersion } from '../../src/connection/versionGate.ts';
import { AUTO_VERSION, autoVersions, resolveSettings } from '../../src/config/resolve.ts';
import { DEFAULT_VERSION } from '../../src/config/defaults.ts';
import { SHIMS, shimFor } from '../../src/world/version-shims/index.ts';
import { silentLogger } from '../../src/log.ts';
import { FakeClient, flush, INFO, TARGET } from './connection-fakes.ts';

const FAKE = { '1.0.2': 3, '1.0.1': 2, '1.0.0': 1 };

describe('pickVersion', () => {
  it('a single candidate behaves exactly as checkVersion (a pinned version)', () => {
    expect(pickVersion(['1.0.1'], { protocol: 2 }, FAKE)).toEqual({ ...checkVersion('1.0.1', 2, FAKE), fromPing: true });
    expect(pickVersion(['1.0.1'], { protocol: 3 }, FAKE)).toEqual(checkVersion('1.0.1', 3, FAKE));
    expect(pickVersion(['1.0.1'], {}, FAKE)).toEqual({ ...checkVersion('1.0.1', undefined, FAKE), fromPing: false });
    expect(pickVersion(['9.9.9'], {}, FAKE)).toEqual(checkVersion('9.9.9', undefined, FAKE));
  });

  it('the advertised protocol picks its candidate', () => {
    const c = ['1.0.1', '1.0.2', '1.0.0'];
    expect(pickVersion(c, { protocol: 3 }, FAKE)).toEqual({ ok: true, version: '1.0.2', protocol: 3, fromPing: true });
    expect(pickVersion(c, { protocol: 1 }, FAKE)).toMatchObject({ ok: true, version: '1.0.0' });
    // the ping wins over the last spawn and the refusals
    expect(pickVersion(c, { protocol: 2, spawned: '1.0.2', refused: new Set(['1.0.1']) }, FAKE)).toMatchObject({ ok: true, version: '1.0.1', fromPing: true });
  });

  it('a protocol none of the candidates speaks is refused, naming them all', () => {
    const r = pickVersion(['1.0.1', '1.0.0'], { protocol: 3 }, FAKE);
    expect(r).toMatchObject({ ok: false, reason: 'protocol_mismatch' });
    if (!r.ok) expect(r.message).toBe('server speaks protocol 3 (1.0.2) but the bot speaks 1.0.1 (2), 1.0.0 (1)');
    const u = pickVersion(['1.0.1', '1.0.0'], { protocol: 77 }, FAKE);
    if (!u.ok) expect(u.message).toContain('(unknown to bedrock-protocol)');
  });

  it('with no protocol (a Realm): the last spawn, else the first not refused, else the preferred', () => {
    const c = ['1.0.1', '1.0.2'];
    expect(pickVersion(c, {}, FAKE)).toMatchObject({ version: '1.0.1', fromPing: false });
    expect(pickVersion(c, { protocol: Number.NaN }, FAKE)).toMatchObject({ version: '1.0.1', fromPing: false });
    expect(pickVersion(c, { refused: new Set(['1.0.1']) }, FAKE)).toMatchObject({ version: '1.0.2' });
    expect(pickVersion(c, { spawned: '1.0.2' }, FAKE)).toMatchObject({ version: '1.0.2' });
    expect(pickVersion(c, { spawned: '1.0.2', refused: new Set(['1.0.2']) }, FAKE)).toMatchObject({ version: '1.0.1' });
    expect(pickVersion(c, { refused: new Set(c) }, FAKE)).toMatchObject({ version: '1.0.1' });
    // a spawned version that is not a candidate (another configuration) is ignored
    expect(pickVersion(c, { spawned: '1.0.0' }, FAKE)).toMatchObject({ version: '1.0.1' });
    expect(pickVersion([], {}, FAKE)).toMatchObject({ ok: false, reason: 'unsupported_version' });
  });
});

describe('auto versions (config)', () => {
  const ENV = { cwd: tmpdir(), defaultLogDir: join(tmpdir(), 'bedrockbot-unit-logs') };

  it('lists every shim version bedrock-protocol speaks, the default first, then newest first', () => {
    expect(supportedVersions['1.26.70']).toBe(2259);
    expect(shimFor('1.26.70')?.blockPalette).toBe('1.26.70');
    expect(SHIMS[0]?.gameVersions).toEqual(['1.26.70']);
    expect(autoVersions()).toEqual(['1.26.60', '1.26.70', '1.26.51']);
    expect(autoVersions('1.26.70')).toEqual(['1.26.70', '1.26.60', '1.26.51']);
    // a shim bedrock-protocol does not speak is left out
    expect(autoVersions('1.26.60', { '1.26.60': 2225, '1.26.51': 2193 })).toEqual(['1.26.60', '1.26.51']);
  });

  it('no version, or auto: the default preferred and every auto version; a pin: that version alone', () => {
    const none = resolveSettings({}, {}, ENV);
    expect(none.version).toBe(DEFAULT_VERSION);
    expect(none.versions).toEqual(autoVersions());
    expect(resolveSettings({ version: AUTO_VERSION }, { version: '1.26.51' }, ENV).versions).toEqual(autoVersions());
    expect(resolveSettings({}, { version: 'auto' }, ENV).versions).toEqual(autoVersions());
    expect(resolveSettings({}, {}, { ...ENV, botVersion: 'auto' }).versions).toEqual(autoVersions());
    for (const s of [resolveSettings({ version: '1.26.70' }, {}, ENV), resolveSettings({}, { version: '1.26.70' }, ENV), resolveSettings({}, {}, { ...ENV, botVersion: '1.26.70' })]) {
      expect(s.version).toBe('1.26.70');
      expect(s.versions).toEqual(['1.26.70']);
    }
  });
});

function setup(versions: readonly string[] | undefined, ping: () => Promise<typeof INFO>, extra: Partial<ConstructorParameters<typeof Connection>[0]> = {}) {
  const clients: FakeClient[] = [];
  const seen: { opts: ClientOptions; sessionVersion: string }[] = [];
  const conn: Connection = new Connection({
    version: '1.26.60',
    ...(versions ? { versions } : {}),
    username: 'UnitBot',
    logger: silentLogger,
    reconnect: { baseMs: 5_000, jitter: 0 },
    ping: vi.fn(ping),
    createClient: (opts) => {
      // the session version is final before the client (and so any packet of the session) exists
      seen.push({ opts, sessionVersion: conn.sessionVersion });
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    ...extra,
  });
  const closes: CloseInfo[] = [];
  conn.onClose((i) => closes.push(i));
  return { conn, clients, seen, closes };
}

const AUTO = ['1.26.60', '1.26.70', '1.26.51'];
const pong = (protocol: number | undefined, version = '1.26.70') => () => Promise.resolve({ ...INFO, protocol, version });

describe('Connection: the session version', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a pinned version behaves as before: 2225 speaks it, 2259 is refused before login', async () => {
    const a = setup(undefined, pong(2225, '1.26.65'));
    const p = a.conn.connect(TARGET);
    await flush();
    expect(a.seen.map((s) => [s.opts.version, s.sessionVersion])).toEqual([['1.26.60', '1.26.60']]);
    a.clients[0]!.spawn();
    await p;
    expect(a.conn.versions).toEqual(['1.26.60']);
    a.conn.disconnect();

    const b = setup(undefined, pong(2259));
    const q = b.conn.connect(TARGET);
    const rejected = expect(q).rejects.toThrow(new VersionGateError('server speaks protocol 2259 (1.26.70) but 1.26.60 is protocol 2225'));
    await flush();
    await rejected;
    expect(b.clients).toHaveLength(0);
  });

  it('auto: the ping protocol picks the version of each attempt', async () => {
    let protocol = 2259;
    const { conn, clients, seen } = setup(AUTO, () => Promise.resolve({ ...INFO, protocol, version: protocol === 2259 ? '1.26.70' : '1.26.65' }));
    expect(conn.sessionVersion).toBe('1.26.60');
    const p = conn.connect(TARGET);
    await flush();
    expect(seen[0]).toMatchObject({ opts: { version: '1.26.70' }, sessionVersion: '1.26.70' });
    clients[0]!.spawn();
    await p;
    expect(conn.sessionVersion).toBe('1.26.70');
    // the server is swapped for a 2225 one: the reconnect speaks 1.26.60
    protocol = 2225;
    clients[0]!.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen[1]).toMatchObject({ opts: { version: '1.26.60' }, sessionVersion: '1.26.60' });
    clients[1]!.spawn();
    expect(conn.state).toBe('spawned');
    expect(conn.sessionVersion).toBe('1.26.60');
    conn.disconnect();
  });

  it('auto: a protocol the bot does not speak is refused before login', async () => {
    const { conn, clients } = setup(AUTO, pong(2300, '1.26.80'));
    const p = conn.connect(TARGET);
    const rejected = expect(p).rejects.toThrow(/server speaks protocol 2300 \(unknown to bedrock-protocol\) but the bot speaks 1.26.60 \(2225\), 1.26.70 \(2259\), 1.26.51 \(2193\)/);
    await flush();
    await rejected;
    expect(clients).toHaveLength(0);
  });

  it('a version chosen by the ping that is still refused ends the connect (no other version tried)', async () => {
    const { conn, clients } = setup(AUTO, pong(2259));
    const p = conn.connect(TARGET);
    const rejected = expect(p).rejects.toThrow(/server refused game version 1.26.70: kicked: outdated_client/);
    await flush();
    clients[0]!.kick('outdated_client');
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
  });

  it('no ping protocol: after a terminal refusal the next version is tried once, then the spawn sticks', async () => {
    const { conn, clients, seen, closes } = setup(AUTO, pong(undefined));
    const p = conn.connect(TARGET);
    await flush();
    expect(seen[0]?.sessionVersion).toBe('1.26.60');
    clients[0]!.kick('outdated_client', 'disconnectionScreen.outdatedClient');
    expect(conn.state).toBe('connecting');
    expect(closes[0]).toMatchObject({ kind: 'kick', willReconnect: true, versionMismatch: true, retryInMs: VERSION_RETRY_MS });
    expect(conn.link.retryAt).toBeDefined();
    await vi.advanceTimersByTimeAsync(VERSION_RETRY_MS);
    expect(seen[1]).toMatchObject({ opts: { version: '1.26.70' }, sessionVersion: '1.26.70' });
    clients[1]!.spawn();
    await p;
    // a later reconnect starts with the version that spawned
    clients[1]!.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen[2]?.sessionVersion).toBe('1.26.70');
    conn.disconnect();
  });

  it('no ping protocol: play_status failed_client counts as a refusal too; every version refused fails the connect', async () => {
    const { conn, clients, seen } = setup(['1.26.60', '1.26.70'], pong(undefined));
    const p = conn.connect(TARGET);
    const rejected = expect(p).rejects.toThrow(new VersionGateError('server refused game version 1.26.70: kicked: outdated_server'));
    await flush();
    clients[0]!.receive('play_status', { status: 'failed_client' });
    clients[0]!.close();
    await vi.advanceTimersByTimeAsync(VERSION_RETRY_MS);
    expect(seen[1]?.sessionVersion).toBe('1.26.70');
    clients[1]!.kick('outdated_server');
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(2);
  });

  it('the version retry does not need reconnects (a tool with reconnect off) and stops on disconnect()', async () => {
    const { conn, clients } = setup(['1.26.60', '1.26.70'], pong(undefined), { reconnect: false });
    const p = conn.connect(TARGET);
    await flush();
    clients[0]!.kick('outdated_client');
    await vi.advanceTimersByTimeAsync(VERSION_RETRY_MS);
    expect(clients).toHaveLength(2);
    clients[1]!.kick('outdated_client');
    await expect(p).rejects.toBeInstanceOf(VersionGateError);

    const b = setup(['1.26.60', '1.26.70'], pong(undefined));
    const q = b.conn.connect(TARGET).catch((e: unknown) => e);
    await flush();
    b.clients[0]!.kick('outdated_client');
    b.conn.disconnect('bye');
    await vi.advanceTimersByTimeAsync(VERSION_RETRY_MS * 3);
    expect(b.clients).toHaveLength(1);
    expect(b.conn.state).toBe('closed');
    await q;
  });

  it('a Realm (services signalling, no ping) gets the same fallback', async () => {
    const realm: RealmTarget = { kind: 'realm', realmName: 'Our Realm', accountName: 'bot', profilesFolder: join(tmpdir(), 'bedrockbot-unit-profiles') };
    const { conn, clients, seen } = setup(['1.26.60', '1.26.70'], () => Promise.reject(new Error('must not ping a Realm')));
    const p = conn.connect(realm);
    await flush();
    expect(seen[0]).toMatchObject({ opts: { version: '1.26.60' }, sessionVersion: '1.26.60' });
    expect(seen[0]?.opts.realms).toBeDefined();
    expect(conn.gameVersion).toBe('1.26.60');
    clients[0]!.emit('connect_allowed');
    clients[0]!.kick('outdated_client');
    await vi.advanceTimersByTimeAsync(VERSION_RETRY_MS);
    expect(seen[1]).toMatchObject({ opts: { version: '1.26.70' }, sessionVersion: '1.26.70' });
    expect(conn.gameVersion).toBe('1.26.70');
    clients[1]!.emit('connect_allowed');
    clients[1]!.spawn();
    await p;
    conn.disconnect();
  });

  it('connect() refuses a configured version bedrock-protocol does not speak', async () => {
    const { conn } = setup(['1.26.60', '1.99.0'], pong(2225));
    await expect(conn.connect(TARGET)).rejects.toThrow(/game version 1.99.0 is not supported/);
  });
});
