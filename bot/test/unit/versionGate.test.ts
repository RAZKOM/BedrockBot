import { describe, expect, it } from 'vitest';
import { supportedVersions } from '../../src/connection/protocol.ts';
import { checkVersion } from '../../src/connection/versionGate.ts';

describe('checkVersion', () => {
  it('accepts 1.26.51 (protocol 2193) from the installed bedrock-protocol', () => {
    expect(supportedVersions['1.26.51']).toBe(2193);
    expect(checkVersion('1.26.51')).toEqual({ ok: true, version: '1.26.51', protocol: 2193 });
    expect(checkVersion('1.26.51', 2193)).toEqual({ ok: true, version: '1.26.51', protocol: 2193 });
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
