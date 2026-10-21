// Task 5.3: update notifier. Parsers run on JSON captured live on 2026-10-29 (test/unit/fixtures/update):
// npm registry /latest for bedrock-protocol and minecraft-data, minecraft-data master
// protocolVersions.json, and the BDS links API. "Newer" cases use clearly synthetic copies.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Metrics } from '../../src/connection/metrics.ts';
import {
  chatSummary,
  cmpVersion,
  currentPins,
  evaluate,
  fetchSources,
  formatReport,
  parseBdsLinks,
  parseNpmLatest,
  parseProtocolVersions,
  pinnedBdsBuild,
  SOURCES,
  type Pins,
  type SourceData,
} from '../../src/update/check.ts';
import { UpdateNotifier } from '../../src/update/notifier.ts';

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/update/${name}`, import.meta.url), 'utf8'));
const LIVE: SourceData = {
  bedrockProtocol: fx('npm-bedrock-protocol-latest.json'),
  minecraftData: fx('npm-minecraft-data-latest.json'),
  protocolVersions: fx('mcdata-protocolVersions.json'),
  bdsLinks: fx('bds-links.json'),
};
const PINS: Pins = { gameVersion: '1.26.60', bds: '1.26.60.6', bedrockProtocol: '3.60.1', minecraftData: '3.117.0' };

describe('update check parsers (captured fixtures)', () => {
  it('npm /latest', () => {
    expect(parseNpmLatest(LIVE.bedrockProtocol)).toEqual({ name: 'bedrock-protocol', version: '3.60.1' });
    expect(parseNpmLatest(LIVE.minecraftData)).toEqual({ name: 'minecraft-data', version: '3.117.0' });
  });

  it('minecraft-data protocolVersions: newest release 1.26.60 (protocol 2225)', () => {
    expect(parseProtocolVersions(LIVE.protocolVersions).release).toEqual({ version: '1.26.60', protocol: 2225 });
  });

  it('BDS links API: release 1.26.60.6, preview 1.26.70.22', () => {
    expect(parseBdsLinks(LIVE.bdsLinks)).toEqual({ release: '1.26.60.6', preview: '1.26.70.22' });
  });

  it('compares versions numerically', () => {
    expect(cmpVersion('1.26.100', '1.26.60')).toBeGreaterThan(0);
    expect(cmpVersion('1.26.60.6', '1.26.60')).toBeGreaterThan(0);
    expect(cmpVersion('3.60.1', '3.60.1')).toBe(0);
    expect(cmpVersion('3.61.0', '3.60.9')).toBeGreaterThan(0);
  });

  it('pins come from the installed packages and docker/compose.dev.yml', () => {
    const p = currentPins();
    expect(p.gameVersion).toBe('1.26.60');
    expect(p.bds).toBe('1.26.60.6');
    expect(p.bedrockProtocol).toBe('3.60.1');
    expect(p.minecraftData).toBe('3.117.0');
    expect(pinnedBdsBuild('does/not/exist.yml')).toBe('1.26.60.6');
  });
});

describe('evaluate', () => {
  it('the live data of 2026-10-29: nothing newer than the pins (the 1.26.70 preview is info only)', () => {
    const r = evaluate(PINS, LIVE, new Date('2026-10-29T00:00:00Z'));
    expect(r.newer).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.findings.find((f) => f.what === 'bds_preview')).toMatchObject({ latest: '1.26.70.22', newer: true, info: true });
    expect(chatSummary(r)).toBeUndefined();
    expect(formatReport(r).at(-1)).toBe('no newer release than the pins');
  });

  it('a synthetic new release (game 1.26.70, BDS 1.26.70.3, bedrock-protocol 3.61.0) is reported', () => {
    const pv = [{ version: 2250, minecraftVersion: '1.26.70', majorVersion: '1.26', releaseType: 'release' }, ...(LIVE.protocolVersions as object[])];
    const links = JSON.parse(JSON.stringify(LIVE.bdsLinks).replace('bin-linux/bedrock-server-1.26.60.6.zip', 'bin-linux/bedrock-server-1.26.70.3.zip')) as unknown;
    const r = evaluate(PINS, { ...LIVE, protocolVersions: pv, bdsLinks: links, bedrockProtocol: { name: 'bedrock-protocol', version: '3.61.0' } });
    expect(r.newer.map((f) => [f.what, f.latest])).toEqual([
      ['game_version', '1.26.70'],
      ['bds_release', '1.26.70.3'],
      ['bedrock_protocol', '3.61.0'],
    ]);
    expect(chatSummary(r)).toBe('update available: game version 1.26.70, bds release 1.26.70.3, bedrock protocol 3.61.0 (pinned 1.26.60 / BDS 1.26.60.6)');
    expect(formatReport(r).filter((l) => l.startsWith('NEWER'))).toHaveLength(3);
  });

  it('fetch errors and unexpected JSON are reported, not thrown', () => {
    const r = evaluate(PINS, { ...LIVE, bdsLinks: { nope: true }, errors: { bedrockProtocol: 'HTTP 503' } });
    expect(r.errors).toEqual(expect.arrayContaining(['bedrockProtocol: HTTP 503', expect.stringContaining('bdsLinks: unexpected JSON (result:')]));
    expect(r.errors).toHaveLength(2);
    expect(r.findings.find((f) => f.what === 'bedrock_protocol')).toMatchObject({ latest: null, newer: false, error: 'HTTP 503' });
    expect(r.newer).toEqual([]);
  });

  it('fetchSources asks the four documented URLs and keeps going when one fails', async () => {
    const seen: string[] = [];
    const data = await fetchSources((url) => {
      seen.push(url);
      if (url === SOURCES.bdsLinks) return Promise.reject(new Error('offline'));
      return Promise.resolve({ name: 'x', version: '1.0.0' });
    });
    expect(seen.sort()).toEqual([SOURCES.bdsLinks, SOURCES.npm('bedrock-protocol'), SOURCES.npm('minecraft-data'), SOURCES.protocolVersions].sort());
    expect(data.errors).toEqual({ bdsLinks: 'offline' });
  });
});

describe('UpdateNotifier', () => {
  it('notifies once per new finding and publishes a metrics line', async () => {
    const metrics = new Metrics();
    const notify = vi.fn();
    let data: SourceData = LIVE;
    const n = new UpdateNotifier({ intervalHours: 24, metrics, notify, check: () => Promise.resolve(evaluate(PINS, data)) });
    await n.runOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(metrics.snapshot().updateCheck).toMatchObject({ newer: [], runs: 1 });
    data = { ...LIVE, bedrockProtocol: { name: 'bedrock-protocol', version: '3.61.0' } };
    await n.runOnce();
    await n.runOnce();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain('bedrock protocol 3.61.0');
    expect(metrics.snapshot().updateCheck).toMatchObject({ newer: ['bedrock_protocol 3.60.1 -> 3.61.0'], runs: 3 });
    expect(metrics.counters['update.notified']).toBe(1);
  });

  it('a failing check is logged in the summary', async () => {
    const n = new UpdateNotifier({ intervalHours: 24, check: () => Promise.reject(new Error('no network')) });
    expect(await n.runOnce()).toBeUndefined();
    expect(n.summary()).toMatchObject({ lastError: 'no network' });
  });

  it('intervalHours 0 never schedules', () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(() => Promise.resolve(evaluate(PINS, LIVE)));
      const n = new UpdateNotifier({ intervalHours: 0, check });
      n.start();
      vi.advanceTimersByTime(48 * 3_600_000);
      expect(check).not.toHaveBeenCalled();
      const m = new UpdateNotifier({ intervalHours: 1, firstDelayMs: 1000, check });
      m.start();
      vi.advanceTimersByTime(1000 + 2 * 3_600_000);
      expect(check).toHaveBeenCalledTimes(3);
      m.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
