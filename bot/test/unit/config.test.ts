// Task 5.5: config file (JSON with comments, zod-validated), its location, and the merge with CLI flags.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, defaultConfigPath, loadConfig, locateConfig, parseConfig, parseVec3, stripJsonComments } from '../../src/config/config.ts';
import { EXAMPLE_CONFIG } from '../../src/config/init.ts';
import { resolveSettings, SettingsError, type ResolveEnv } from '../../src/config/resolve.ts';
import { REPO_ROOT } from '../../src/connection/realm.ts';

const tmp = mkdtempSync(join(tmpdir(), 'bedrockbot-config-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ENV: ResolveEnv = { cwd: tmp, defaultLogDir: join(tmp, 'logs'), defaultProfilesFolder: join(tmp, 'profiles'), now: new Date('2026-10-29T00:00:00Z') };

describe('config file', () => {
  it('strips // and /* */ comments and trailing commas, but not inside strings', () => {
    const text = '{\n  // a comment\n  "host": "a//b", /* block */ "port": 19132,\n  "owners": ["x/*y*/z",],\n}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ host: 'a//b', port: 19132, owners: ['x/*y*/z'] });
    expect(JSON.parse(stripJsonComments('{"s": "quote \\" // still string"}'))).toEqual({ s: 'quote " // still string' });
  });

  it('validates fields and reports every problem with its path', () => {
    expect(() => parseConfig('{"port": 70000, "transport": "udp", "home": [1, 2]}', tmp)).toThrow(ConfigError);
    try {
      parseConfig('{"port": 70000, "transport": "udp", "home": [1, 2], "bogus": 1}', tmp);
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('port');
      expect(m).toContain('transport');
      expect(m).toContain('home');
      expect(m).toContain('bogus');
    }
    expect(() => parseConfig('{ not json', tmp)).toThrow(/not valid JSON/);
  });

  it('refuses target "realm" in the file: going online is a command-line decision', () => {
    expect(() => parseConfig('{"target": "realm"}', tmp)).toThrow(/--target realm on the command line/);
    expect(parseConfig('{"target": "bds"}', tmp).target).toBe('bds');
  });

  it('resolves relative paths against the config file directory', () => {
    const c = parseConfig('{"logDir": "logs", "realm": {"profilesFolder": "tokens", "accountName": "bot", "realmName": "R"}}', tmp);
    expect(c.logDir).toBe(join(tmp, 'logs'));
    expect(c.realm?.profilesFolder).toBe(join(tmp, 'tokens'));
  });

  it('the example written by config:init parses (after stripping its comments)', () => {
    const c = parseConfig(EXAMPLE_CONFIG, tmp);
    expect(c.task).toBe('afk');
    expect(c.realm?.accountName).toBe('bot');
    expect(c.port).toBe(19132);
  });

  it('locates the file: --config > BEDROCKBOT_CONFIG > default; a missing default is fine, a missing named file is not', () => {
    expect(locateConfig('my.json', {}, tmp)).toEqual({ path: join(tmp, 'my.json'), source: 'flag' });
    expect(locateConfig(undefined, { BEDROCKBOT_CONFIG: 'env.json' }, tmp)).toEqual({ path: join(tmp, 'env.json'), source: 'env' });
    expect(defaultConfigPath({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\Users\\x')).toBe(join('C:\\Users\\x\\AppData\\Local', 'bedrockbot', 'config.json'));
    expect(defaultConfigPath({}, 'linux', '/home/x')).toBe(join('/home/x', '.bedrockbot', 'config.json'));
    expect(loadConfig({ path: join(tmp, 'nope.json'), source: 'default' }).config).toEqual({});
    expect(() => loadConfig({ path: join(tmp, 'nope.json'), source: 'flag' })).toThrow(/does not exist/);
    const f = join(tmp, 'c.json');
    writeFileSync(f, '\uFEFF{ // BOM and a comment\n "port": 19152 }');
    expect(loadConfig({ path: f, source: 'flag' }).config.port).toBe(19152);
  });

  it('parses x,y,z vectors', () => {
    expect(parseVec3('1,-60,2')).toEqual([1, -60, 2]);
    expect(parseVec3('1 -60 2')).toEqual([1, -60, 2]);
    expect(parseVec3('1,2')).toBeUndefined();
    expect(parseVec3('1,a,2')).toBeUndefined();
  });
});

describe('resolveSettings', () => {
  it('defaults: echo on 127.0.0.1:19132 raknet, 1.26.60, logs in the default dir, no health port', () => {
    const s = resolveSettings({}, {}, ENV);
    expect(s.task).toBe('echo');
    expect(s.target).toEqual({ kind: 'bds', host: '127.0.0.1', port: 19132, transport: 'raknet', offline: true });
    expect(s.version).toBe('1.26.60');
    expect(s.metricsFile).toBe(join(tmp, 'logs', 'metrics.json'));
    expect(s.healthPort).toBeUndefined();
    expect(s.updateCheckHours).toBe(0);
    expect(s.common).toEqual({ nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: false, respawnDelayMs: 2000 });
  });

  it('CLI flag > config file > default', () => {
    const cfg = parseConfig('{"task": "afk", "port": 19152, "host": "10.0.0.2", "healthPort": 9464, "nudgeInterval": 60, "home": [1, -60, 2], "owners": ["Cfg"], "logDir": "cfglogs"}', tmp);
    const fromCfg = resolveSettings({}, cfg, ENV);
    expect(fromCfg.task).toBe('afk');
    expect(fromCfg.target).toMatchObject({ host: '10.0.0.2', port: 19152 });
    expect(fromCfg.healthPort).toBe(9464);
    expect(fromCfg.common.nudgeIntervalS).toBe(60);
    expect(fromCfg.common.home).toEqual({ x: 1, y: -60, z: 2 });
    expect(fromCfg.owners).toEqual(['Cfg']);
    expect(fromCfg.logDir).toBe(join(tmp, 'cfglogs'));
    const s = resolveSettings({ port: '19154', 'health-port': '0', 'nudge-interval': '0', home: '5,-60,5', owner: ['Cli'], 'log-dir': 'clilogs' }, cfg, { ...ENV, botOwners: 'Env' });
    expect(s.target).toMatchObject({ host: '10.0.0.2', port: 19154 });
    expect(s.healthPort).toBeUndefined();
    expect(s.common.nudgeIntervalS).toBe(0);
    expect(s.common.home).toEqual({ x: 5, y: -60, z: 5 });
    expect(s.owners).toEqual(['Cli', 'Env']);
    expect(s.logDir).toBe(join(tmp, 'clilogs'));
    expect(resolveSettings({ version: '1.26.51' }, { version: '1.26.60' }, { ...ENV, botVersion: '1.26.70' }).version).toBe('1.26.51');
    expect(resolveSettings({}, { version: '1.26.60' }, { ...ENV, botVersion: '1.26.51' }).version).toBe('1.26.51');
  });

  it('rejects bad values with SettingsError', () => {
    expect(() => resolveSettings({ port: '0' }, {}, ENV)).toThrow(SettingsError);
    expect(() => resolveSettings({ home: '1,2' }, {}, ENV)).toThrow(/--home/);
    expect(() => resolveSettings({ 'metrics-interval': '0' }, {}, ENV)).toThrow(/metrics-interval/);
    expect(() => resolveSettings({ target: 'lan' }, {}, ENV)).toThrow(/unknown target/);
    expect(() => resolveSettings({ 'realm-name': 'x' }, {}, ENV)).toThrow(/only valid with --target realm/);
  });

  it('realm: details come from the config file, the target from the CLI; guard rails stay', () => {
    const cfg = parseConfig(`{"host": "1.2.3.4", "port": 19133, "username": "Local", "realm": {"realmName": "Our Realm", "accountName": "bot", "profilesFolder": ${JSON.stringify(join(tmp, 'tok'))}}}`, tmp);
    // Without --target realm the config's realm block is not used.
    expect(resolveSettings({}, cfg, ENV).target.kind).toBe('bds');
    const s = resolveSettings({ target: 'realm' }, cfg, ENV);
    expect(s.target).toMatchObject({ kind: 'realm', realmName: 'Our Realm', accountName: 'bot' });
    expect(s.username).toBe('bot');
    expect(s.updateCheckHours).toBe(24);
    expect(s.record).toMatch(/realm-2026-10-29T00-00-00-000Z\.jsonl\.gz$/);
    expect(resolveSettings({ target: 'realm', 'no-record': true }, cfg, ENV).record).toBeUndefined();
    // A CLI selector replaces the file's selector.
    expect(resolveSettings({ target: 'realm', 'realm-id': '42' }, cfg, ENV).target).toMatchObject({ realmId: '42' });
    expect(resolveSettings({ target: 'realm', 'realm-id': '42' }, cfg, ENV).target).not.toHaveProperty('realmName');
    // Offline flags are refused on the CLI.
    expect(() => resolveSettings({ target: 'realm', port: '19132' }, cfg, ENV)).toThrow(/does not take --port/);
    expect(() => resolveSettings({ target: 'realm', username: 'x' }, cfg, ENV)).toThrow(/--username/);
    // No account anywhere.
    expect(() => resolveSettings({ target: 'realm', 'realm-name': 'R' }, {}, ENV)).toThrow(/accountName/);
  });

  it('realm: a profilesFolder inside the repository is refused, from the CLI or the config file', () => {
    const inRepo = join(REPO_ROOT, 'tokens');
    expect(() => resolveSettings({ target: 'realm', 'realm-name': 'R', account: 'bot', 'profiles-folder': inRepo }, {}, ENV)).toThrow(/inside the repository|repo/i);
    const cfg = parseConfig(`{"realm": {"realmName": "R", "accountName": "bot", "profilesFolder": ${JSON.stringify(inRepo)}}}`, tmp);
    expect(() => resolveSettings({ target: 'realm' }, cfg, ENV)).toThrow(/inside the repository|repo/i);
  });
});
