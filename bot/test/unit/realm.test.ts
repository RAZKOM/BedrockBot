// Realm target (PLAN.md task 1.6): option assembly and guard rails, with fakes only. Nothing here
// signs in or touches the network: bedrock-protocol's realmAuthenticate runs against a stubbed
// Realms API and a fake authflow.
import dns from 'node:dns';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientOptions } from 'bedrock-protocol';
import { Connection } from '../../src/connection/connection.ts';
import { PacketRecorder, parseRecording } from '../../src/connection/recorder.ts';
import {
  buildRealmClientOptions,
  defaultProfilesFolder,
  isInside,
  pickRealmByName,
  RealmGuardError,
  REPO_ROOT,
  validateRealmTarget,
  type RealmSummary,
} from '../../src/connection/realm.ts';
import type { RealmTarget } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { FakeClient, flush } from './connection-fakes.ts';

const OUTSIDE = join(tmpdir(), 'bedrockbot-unit-profiles');
const base: RealmTarget = { kind: 'realm', realmName: 'Our Realm', accountName: 'bot', profilesFolder: OUTSIDE };
const input = { version: '1.26.51', viewDistance: 10 };

describe('defaultProfilesFolder', () => {
  it('uses %LOCALAPPDATA%\\bedrockbot\\profiles on Windows and ~/.bedrockbot/profiles elsewhere', () => {
    expect(defaultProfilesFolder({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u')).toBe(join('C:\\Users\\u\\AppData\\Local', 'bedrockbot', 'profiles'));
    expect(defaultProfilesFolder({}, 'linux', '/home/u')).toBe(join('/home/u', '.bedrockbot', 'profiles'));
    expect(defaultProfilesFolder({}, 'win32', 'C:\\Users\\u')).toBe(join('C:\\Users\\u', '.bedrockbot', 'profiles'));
  });

  it('is outside the repository on this machine', () => {
    expect(isInside(defaultProfilesFolder(), REPO_ROOT)).toBe(false);
  });
});

describe('isInside', () => {
  it('detects the repo itself, sub folders and (on Windows) case variants', () => {
    expect(isInside(REPO_ROOT, REPO_ROOT)).toBe(true);
    expect(isInside(join(REPO_ROOT, 'bot', 'profiles-that-do-not-exist', 'x'), REPO_ROOT)).toBe(true);
    expect(isInside(join(REPO_ROOT, '..', 'elsewhere'), REPO_ROOT)).toBe(false);
    expect(isInside(REPO_ROOT.toUpperCase(), REPO_ROOT.toLowerCase(), 'win32')).toBe(true);
  });
});

describe('validateRealmTarget', () => {
  it('accepts one selector, a plain account label and a folder outside the repo', () => {
    expect(validateRealmTarget(base)).toBe(resolve(OUTSIDE));
  });

  it('refuses a token cache inside the repository (relative, absolute, nested)', () => {
    for (const p of ['.', REPO_ROOT, join(REPO_ROOT, 'bot', 'logs', 'profiles'), join(REPO_ROOT, 'profiles')]) {
      expect(() => validateRealmTarget({ ...base, profilesFolder: p }), p).toThrow(RealmGuardError);
      expect(() => validateRealmTarget({ ...base, profilesFolder: p }), p).toThrow(/inside the repository/);
    }
  });

  it('needs exactly one of realmName, realmInvite, realmId', () => {
    const { realmName: _drop, ...none } = base;
    expect(() => validateRealmTarget(none)).toThrow(/exactly one/);
    expect(() => validateRealmTarget({ ...base, realmInvite: 'abc' })).toThrow(/exactly one/);
  });

  it('rejects an account label that is not a plain name, and any offline flag', () => {
    expect(() => validateRealmTarget({ ...base, accountName: '' })).toThrow(/accountName/);
    expect(() => validateRealmTarget({ ...base, accountName: '../x' })).toThrow(/accountName/);
    expect(() => validateRealmTarget({ ...base, offline: true } as RealmTarget)).toThrow(/offline/);
    expect(() => validateRealmTarget({ ...base, offline: false } as RealmTarget)).toThrow(/offline/);
  });

  it('lists every problem at once', () => {
    expect(() => validateRealmTarget({ kind: 'realm', accountName: '', profilesFolder: REPO_ROOT })).toThrow(/exactly one.*accountName.*inside the repository/);
  });
});

describe('pickRealmByName', () => {
  const realms: RealmSummary[] = [
    { id: 1, name: 'Our Realm' },
    { id: 2, name: 'Other' },
    { id: 3, name: 'twin' },
    { id: 4, name: 'Twin' },
  ];
  it('prefers an exact match, then a unique case-insensitive one', () => {
    expect(pickRealmByName('Our Realm')(realms).id).toBe(1);
    expect(pickRealmByName('our realm')(realms).id).toBe(1);
    expect(pickRealmByName('Twin')(realms).id).toBe(4);
  });
  it('refuses missing and ambiguous names and lists the Realms it saw', () => {
    expect(() => pickRealmByName('Nope')(realms)).toThrow(/no Realm called "Nope".*"Our Realm", "Other"/);
    expect(() => pickRealmByName('TWIN')(realms)).toThrow(/more than one Realm/);
  });
});

describe('buildRealmClientOptions', () => {
  it('assembles a NetherNet services-signalling, device-code (live flow) client with the cache outside the repo', () => {
    const o = buildRealmClientOptions(base, input);
    expect(o).toMatchObject({
      username: 'bot',
      offline: false,
      version: '1.26.51',
      profilesFolder: resolve(OUTSIDE),
      authTitle: '00000000441cc96b', // prismarine-auth Titles.MinecraftNintendoSwitch
      deviceType: 'Nintendo',
      flow: 'live',
      transport: 'nethernet',
      nethernet: { signalling: 'services' },
      skipPing: true,
      viewDistance: 10,
    });
    expect(o).not.toHaveProperty('host');
    expect(o).not.toHaveProperty('port');
    expect(o).not.toHaveProperty('password');
    expect(typeof o.realms.pickRealm).toBe('function');
    expect(o.realms).not.toHaveProperty('realmId');
  });

  it('passes realmInvite and realmId through, and the target view distance wins', () => {
    const { realmName: _a, ...noName } = base;
    expect(buildRealmClientOptions({ ...noName, realmInvite: 'AbCdEf' }, input).realms).toEqual({ realmInvite: 'AbCdEf' });
    expect(buildRealmClientOptions({ ...noName, realmId: '1234', viewDistance: 4 }, input)).toMatchObject({ realms: { realmId: '1234' }, viewDistance: 4 });
  });

  it('wires conLog and onMsaCode only when given', () => {
    const shown: unknown[] = [];
    const o = buildRealmClientOptions(base, { ...input, onMsaCode: (p) => shown.push(p.user_code), conLog: () => {} });
    o.onMsaCode?.({ user_code: 'ABCD1234' } as never);
    expect(shown).toEqual(['ABCD1234']);
    expect(buildRealmClientOptions(base, input)).not.toHaveProperty('onMsaCode');
  });

  it('refuses before building anything when the guard rails fail', () => {
    expect(() => buildRealmClientOptions({ ...base, profilesFolder: REPO_ROOT }, input)).toThrow(RealmGuardError);
  });

  // The real code path that consumes our option names: src/client/auth.js realmAuthenticate(), with
  // the Realms API and DNS stubbed (no network at all).
  async function realmAuthenticate(resolves: boolean): Promise<{ o: Record<string, unknown> & { nethernet: Record<string, unknown> }; calls: string[] }> {
    const bpRequire = createRequire(createRequire(import.meta.url).resolve('bedrock-protocol'));
    const auth = bpRequire('./src/client/auth') as { realmAuthenticate(o: object): Promise<void> };
    const { RealmAPI } = bpRequire('prismarine-realms') as { RealmAPI: { from: (...a: unknown[]) => unknown } };
    const calls: string[] = [];
    const dnsSpy = vi.spyOn(dns.promises, 'lookup').mockImplementation((host: string) => {
      calls.push(`DNS ${host}`);
      return resolves ? Promise.resolve({ address: '192.0.2.1', family: 4 }) : Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
    });
    const spy = vi.spyOn(RealmAPI, 'from').mockImplementation((_flow: unknown, platform: unknown, opts: unknown) => {
      calls.push(`from ${String(platform)} ${JSON.stringify(opts)}`);
      return {
        getRealms: () => Promise.resolve([{ id: 7, name: 'Other' }, { id: 42, name: 'Our Realm' }]),
        rest: {
          get: (path: string) => {
            calls.push(`GET ${path}`);
            return Promise.resolve({ address: '123456789', networkProtocol: 'NETHERNET_JSONRPC', sessionRegionData: { regionName: 'WestEurope' } });
          },
        },
      };
    });
    try {
      const o = { ...buildRealmClientOptions(base, input), authflow: {} } as unknown as Record<string, unknown> & { nethernet: Record<string, unknown> };
      await auth.realmAuthenticate(o);
      return { o, calls };
    } finally {
      spy.mockRestore();
      dnsSpy.mockRestore();
    }
  }

  it('is accepted by the installed bedrock-protocol realmAuthenticate (stubbed Realms API, fake authflow)', async () => {
    const { o, calls } = await realmAuthenticate(true);
    expect(calls).toEqual(['from bedrock {"minecraftVersion":"1.26.51"}', 'GET /worlds/42/join', 'DNS signal-westeurope.franchise.minecraft-services.net']);
    expect(o.transport).toBe('nethernet');
    expect(o.nethernet).toMatchObject({ networkId: '123456789', signalling: 'services', _signallingProtocol: 'jsonrpc', _signallingHost: 'signal-westeurope.franchise.minecraft-services.net' });
    // bedrock-protocol derives DeviceOS 12 (Nintendo) from the Switch title.
    expect(o.deviceOS).toBe(12);
    expect(o.profilesFolder).toBe(resolve(OUTSIDE));
  });

  it('falls back to the default signalling host when the regional one does not resolve (PR #839, the reason for the git pin)', async () => {
    const { o } = await realmAuthenticate(false);
    expect(o.nethernet).toMatchObject({ networkId: '123456789', signalling: 'services' });
    expect(o.nethernet._signallingHost).toBeUndefined();
  });
});

describe('Connection with a Realm target (fake client)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setupRealm(extra: Partial<ConstructorParameters<typeof Connection>[0]> = {}) {
    const clients: FakeClient[] = [];
    const seen: ClientOptions[] = [];
    const ping = vi.fn(() => Promise.reject(new Error('must not ping a Realm')));
    const lines: string[] = [];
    const recorder = new PacketRecorder((l) => lines.push(l));
    const conn = new Connection({
      version: '1.26.51',
      username: 'bot',
      logger: silentLogger,
      recorder,
      ping,
      createClient: (o) => {
        seen.push(o);
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      ...extra,
    });
    return { conn, clients, seen, ping, lines };
  }

  it('builds realm options, never pings, starts the spawn timeout only after connect_allowed, records with login redacted', async () => {
    const { conn, clients, seen, ping, lines } = setupRealm({ spawnTimeoutMs: 5_000 });
    const p = conn.connect(base);
    await flush();
    expect(ping).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ offline: false, transport: 'nethernet', nethernet: { signalling: 'services' }, username: 'bot', flow: 'live' });
    // Sign-in may take minutes (a human types the device code): the spawn timeout must not fire yet.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients[0]!.closed).toBe(false);
    const c = clients[0]!;
    c.emit('connect_allowed');
    c.write('login', { tokens: { identity: 'secret-chain', client: 'secret' } });
    c.spawn();
    await p;
    expect(conn.state).toBe('spawned');
    const recs = parseRecording(lines.join(''));
    expect(recs[0]).toMatchObject({ dir: 'meta', name: 'connect', params: { target: 'realm "Our Realm" (nethernet/services)', transport: 'nethernet', signalling: 'services' } });
    expect(recs.find((r) => r.name === 'login')).toMatchObject({ dir: 'out', params: '[redacted]' });
    expect(lines.join('')).not.toContain('secret');
    conn.disconnect('done');
  });

  it('gives up an attempt when sign-in/join takes longer than authTimeoutMs, then retries', async () => {
    const { conn, clients } = setupRealm({ authTimeoutMs: 10_000, reconnect: { baseMs: 1_000, jitter: 0 } });
    const closes: string[] = [];
    conn.onClose((i) => closes.push(i.reason));
    void conn.connect(base).catch(() => {});
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clients[0]!.closed).toBe(true);
    expect(closes[0]).toBe('no Realm sign-in/join within 10000 ms');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clients).toHaveLength(2);
    conn.disconnect('done');
  });

  it('routes the device-code prompt to onDeviceCode', async () => {
    const prompts: string[] = [];
    const { conn, seen } = setupRealm({ onDeviceCode: (p) => prompts.push(p.message ?? '') });
    void conn.connect(base).catch(() => {});
    await flush();
    seen[0]!.onMsaCode?.({ message: 'open https://www.microsoft.com/link and enter ABCD' } as never);
    expect(prompts).toEqual(['open https://www.microsoft.com/link and enter ABCD']);
    conn.disconnect('done');
  });
});
