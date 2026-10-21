import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionGateError } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { CloseInfo } from '../../src/connection/types.ts';
import { flush, setup, TARGET } from './connection-fakes.ts';
import { supportedVersions } from '../../src/connection/protocol.ts';
import { checkVersion } from '../../src/connection/versionGate.ts';

describe('checkVersion', () => {
  it('accepts 1.26.51 (protocol 2193) from the installed bedrock-protocol', () => {
    expect(supportedVersions['1.26.51']).toBe(2193);
    expect(checkVersion('1.26.51')).toEqual({ ok: true, version: '1.26.51', protocol: 2193 });
    expect(checkVersion('1.26.51', 2193)).toEqual({ ok: true, version: '1.26.51', protocol: 2193 });
  });

  it('accepts 1.26.60 (protocol 2225) through patches/minecraft-data@3.117.0.patch', () => {
    expect(supportedVersions['1.26.60']).toBe(2225);
    expect(checkVersion('1.26.60', 2225)).toEqual({ ok: true, version: '1.26.60', protocol: 2225 });
    const r = checkVersion('1.26.60', 2193);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('(1.26.51)');
  });

  it('refuses a version bedrock-protocol does not know', () => {
    const r = checkVersion('1.99.0');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unsupported_version');
      expect(r.message).toContain('1.99.0');
    }
  });

  it('refuses when the server advertises another protocol (e.g. BDS 1.26.60 = 2225)', () => {
    const r = checkVersion('1.26.51', 2225);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('protocol_mismatch');
      expect(r.message).toContain('2225');
      expect(r.message).toContain('2193');
    }
  });

  it('names the server version when the mismatching protocol is known', () => {
    const fake = { '1.0.0': 1, '1.0.1': 2 };
    const r = checkVersion('1.0.0', 2, fake);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('(1.0.1)');
  });

  it('ignores a missing or non-numeric server protocol', () => {
    expect(checkVersion('1.26.51', undefined).ok).toBe(true);
    expect(checkVersion('1.26.51', Number.NaN).ok).toBe(true);
  });
});

// Task 5.3: the gate against fake servers (the outdated_client kick itself is covered in
// connection-reconnect.test.ts: no reconnect, VersionGateError, versionMismatch in the close info).
describe('version gate against a fake server (task 5.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a server advertising a newer protocol (fake 1.26.70 = 2250) is refused before login and never retried', async () => {
    const { conn, clients, ping } = setup({ version: '1.26.60', reconnect: { baseMs: 100, jitter: 0 } }, { transport: 'raknet', protocol: 2250, version: '1.26.70', motd: 'fake', levelName: 'fake' });
    const metrics = new Metrics();
    metrics.attach(conn);
    const closes: CloseInfo[] = [];
    conn.onClose((c) => closes.push(c));
    const p = conn.connect(TARGET);
    const rejected = expect(p).rejects.toBeInstanceOf(VersionGateError);
    await flush();
    await rejected;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(clients).toHaveLength(0); // no login was attempted
    expect(ping).toHaveBeenCalledTimes(1);
    expect(closes).toEqual([expect.objectContaining({ kind: 'version', willReconnect: false, versionMismatch: true })]);
    expect(closes[0]!.reason).toContain('2250');
    expect(metrics.snapshot().closesByKind).toEqual({ version: 1 });
  });

  it('outdated_client from a fake server after login: VersionGateError, counted as a kick by reason', async () => {
    const { conn, clients } = setup({ version: '1.26.60', reconnect: { baseMs: 100, jitter: 0 } }, { transport: 'raknet', protocol: 2225, version: '1.26.60', motd: 'fake', levelName: 'fake' });
    const metrics = new Metrics();
    metrics.attach(conn);
    const p = conn.connect(TARGET);
    const rejected = expect(p).rejects.toThrow(/server refused game version 1.26.60: kicked: outdated_client/);
    await flush();
    clients[0]!.kick('outdated_client', 'disconnectionScreen.outdatedClient');
    await rejected;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(clients).toHaveLength(1);
    expect(metrics.snapshot().kicks.byReason).toEqual({ 'outdated_client: disconnectionScreen.outdatedClient': 1 });
  });
});
