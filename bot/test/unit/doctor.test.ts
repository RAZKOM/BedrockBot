// Track REL1: `pnpm bot:check`, the first-run check (bot/src/doctor). The Node-only half (Node, pnpm, the dependencies,
// the patches), the config half on temporary folders (config, settings, owners, walking, the server ping, the Realm
// cache, the panel, the secret files), the report, and the CLI end to end with --no-config.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_CONFIG } from '../../src/config/init.ts';
import { basicChecks, checkDependencies, checkNode, checkPatches, checkPnpm, exitCode, formatReport, minMajor, type BasicInput, type Check } from '../../src/doctor/basic.ts';
import { BOT_TOKEN_FILE, EXAMPLE_OWNER, EXAMPLE_REALM, setupChecks, tokenCachePrefix, WEBHOOK_FILE, type SetupInput } from '../../src/doctor/setup.ts';
import { BOT_TOKEN_FILE as BOT_TOKEN_FILE_USED } from '../../src/health/notify/discord-access.ts';
import { DISCORD_FILE } from '../../src/health/notify/discord.ts';

const tmp = mkdtempSync(join(tmpdir(), 'bedrockbot-doctor-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(BOT_DIR, 'src', 'doctor', 'cli.ts');

function files(map: Record<string, string>): (p: string) => string | undefined {
  const norm = (p: string) => p.replace(/\\/g, '/');
  return (p) => map[norm(p)];
}

const goodFiles: Record<string, string> = {
  '/bot/node_modules/zod/package.json': '{"version":"4.6.7"}',
  '/bot/node_modules/bedrock-protocol/package.json': '{"version":"3.61.0"}',
  '/bot/node_modules/minecraft-data/minecraft-data/data/dataPaths.json': '{"bedrock":{"1.26.60":{},"1.26.70":{}}}',
  '/bot/node_modules/bedrock-protocol/src/nethernet/signalling.js': 'if (!this._triedDefaultHost) {}',
};
const basic = (over: Partial<BasicInput> = {}): BasicInput => ({
  nodeVersion: '24.22.1',
  engines: '>=24',
  packageManager: 'pnpm@12.16.1',
  userAgent: 'pnpm/12.16.1 npm/? node/v24.22.1 win32 x64',
  dependencies: { zod: '4.6.7', 'bedrock-protocol': '3.61.0' },
  optional: {},
  botDir: '/bot',
  readText: files(goodFiles),
  ...over,
});

describe('bot:check, the Node-only checks', () => {
  it('reads the lowest major of an engines range', () => {
    expect(minMajor('>=24')).toBe(24);
    expect(minMajor('^24.1.0')).toBe(24);
    expect(minMajor(undefined)).toBeUndefined();
  });

  it('passes Node 24 and newer, fails older with the install hint', () => {
    expect(checkNode({ nodeVersion: '24.0.0', engines: '>=24' }).level).toBe('ok');
    expect(checkNode({ nodeVersion: '25.1.0', engines: '>=24' }).level).toBe('ok');
    const old = checkNode({ nodeVersion: '22.11.0', engines: '>=24' });
    expect(old.level).toBe('fail');
    expect(old.fix).toContain('nvm install 24');
  });

  it('knows the pinned pnpm, another pnpm, npm and plain node', () => {
    expect(checkPnpm(basic()).level).toBe('ok');
    const other = checkPnpm(basic({ userAgent: 'pnpm/10.2.0 npm/? node/v24' }));
    expect(other.level).toBe('warn');
    expect(other.fix).toContain('corepack enable');
    expect(checkPnpm(basic({ userAgent: 'npm/10.9.0 node/v24' })).level).toBe('warn');
    expect(checkPnpm(basic({ userAgent: undefined })).level).toBe('info');
  });

  it('fails on a missing or unpinned dependency, says pnpm install, and reports an optional one as info', () => {
    expect(checkDependencies(basic())).toEqual([{ name: 'dependencies', level: 'ok', text: '2 installed at their pins' }]);
    const missing = checkDependencies(basic({ readText: files({}) }));
    expectCheck(missing[0], 'fail', '2 of 2 not installed', 'pnpm install');
    const wrong = checkDependencies(basic({ readText: files({ ...goodFiles, '/bot/node_modules/zod/package.json': '{"version":"4.0.0"}' }) }));
    expectCheck(wrong[0], 'fail', 'not the pinned versions: zod 4.0.0 (pinned 4.6.7)');
    const optional = checkDependencies(basic({ optional: { 'minecraft-assets': '1.19.0' } }));
    expectCheck(optional[1], 'info', 'glyphs');
  });

  it('sees the patches applied or not', () => {
    expect(checkPatches(basic()).level).toBe('ok');
    const npm = checkPatches(basic({ readText: files({ ...goodFiles, '/bot/node_modules/minecraft-data/minecraft-data/data/dataPaths.json': '{"bedrock":{"1.26.60":{}}}', '/bot/node_modules/bedrock-protocol/src/nethernet/signalling.js': '' }) }));
    expectCheck(npm, 'fail', 'not applied: minecraft-data (1.26.70), bedrock-protocol (signalling fallback)');
    expect(checkPatches(basic({ readText: files({}) })).level).toBe('fail');
  });

  it('runs on this checkout: everything installed and patched', () => {
    const checks = basicChecks({ ...basic(), botDir: BOT_DIR, readText: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined), dependencies: { 'bedrock-protocol': '3.61.0', 'minecraft-data': '3.119.0', zod: '4.6.7' } });
    expect(checks.filter((c) => c.level === 'fail')).toEqual([]);
  });

  it('formats one line a check, the fix under a warn or fail, and the counts', () => {
    const checks: Check[] = [
      { name: 'node', level: 'ok', text: 'v24' },
      { name: 'owners', level: 'warn', text: 'none', fix: 'add yours' },
      { name: 'config', level: 'fail', text: 'bad', fix: 'edit it' },
      { name: 'nl', level: 'info', text: 'off', fix: 'never shown' },
    ];
    const r = formatReport(checks);
    expect(r).toContain('  ok    node');
    expect(r).toContain('  WARN  owners');
    expect(r).toMatch(/\n {18}fix: add yours\n/);
    expect(r).toContain('fix: edit it');
    expect(r).not.toContain('never shown');
    expect(r.split('\n').at(-1)).toBe('1 problem, 1 warning: fix the FAIL lines, then run `pnpm bot:check` again');
    expect(exitCode(checks)).toBe(1);
    expect(exitCode(checks.slice(0, 2))).toBe(0);
    expect(formatReport([checks[0]!]).split('\n').at(-1)).toContain('ready');
  });
});

let n = 0;
function home(config?: string, extra: Record<string, string> = {}): { dir: string; config: string } {
  const dir = join(tmp, `h${++n}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  if (config !== undefined) writeFileSync(path, config);
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(dir, f), text);
  return { dir, config: path };
}
const repo = join(tmp, 'repo');
mkdirSync(repo, { recursive: true });
const input = (config: string | undefined, over: Partial<SetupInput> = {}, opts: SetupInput['opts'] = {}): SetupInput => ({
  opts: { config, ...opts },
  env: {},
  cwd: tmp,
  repoRoot: repo,
  defaultLogDir: join(tmp, 'logs'),
  exists: existsSync,
  list: (d) => (existsSync(d) ? readdirSync(d) : []),
  speaks: { '1.26.60': 2225, '1.26.70': 2259 },
  ...over,
});
const by = (checks: Check[], name: string) => checks.filter((c) => c.name === name);
/** The check is there, at this level, and its text (and fix) contain these parts. */
function expectCheck(c: Check | undefined, level: Check['level'], text?: string, fix?: string): void {
  expect(c?.level).toBe(level);
  if (text !== undefined) expect(c?.text).toContain(text);
  if (fix !== undefined) expect(c?.fix).toContain(fix);
}

describe('bot:check, the config checks', () => {
  it('the example config: ok except its placeholders, walking on, the realm block harmless', async () => {
    const h = home(EXAMPLE_CONFIG.replace('replaced-by-config-init-', 'abcdefghijklmnopqrstuvwx'));
    const c = await setupChecks(input(h.config));
    expectCheck(by(c, 'config')[0], 'ok', 'from --config');
    expectCheck(by(c, 'owners')[0], 'warn', `still the example's "${EXAMPLE_OWNER}"`);
    expect(by(c, 'walking')[0]!.level).toBe('ok');
    expect(by(c, 'realm')).toHaveLength(1);
    expectCheck(by(c, 'realm')[0], 'info', EXAMPLE_REALM);
    expect(by(c, 'panel')[0]!.text).toContain('off');
    expect(exitCode(c)).toBe(0);
  });

  it('no config: nobody may command it, walking off; says how to fix each', async () => {
    const c = await setupChecks(input(undefined, { env: { BEDROCKBOT_CONFIG: join(tmp, 'none', 'config.json') } }));
    expect(by(c, 'config')[0]!.level).toBe('fail'); // a file named by the env must exist
    const d = await setupChecks(input(undefined, {}, { noConfig: true }));
    expect(by(d, 'config')[0]!.level).toBe('info');
    expectCheck(by(d, 'owners')[0], 'warn', undefined, '--owner <gamertag>');
    expectCheck(by(d, 'walking')[0], 'warn', undefined, '"walk": true');
  });

  // the default place is under LOCALAPPDATA on Windows only (elsewhere the home folder, which a test must not read)
  it.skipIf(process.platform !== 'win32')('no file at the default place: defaults, and config:init named', async () => {
    const d = await setupChecks(input(undefined, { env: { LOCALAPPDATA: join(tmp, 'empty-lad') } }));
    expectCheck(by(d, 'config')[0], 'info', undefined, 'config:init');
  });

  it('a bad config stops the config checks with the field named', async () => {
    const h = home('{ "port": 70000, "bogus": 1 }');
    const c = await setupChecks(input(h.config));
    expect(c).toHaveLength(1);
    expectCheck(c[0], 'fail', 'port');
    expect(c[0]!.fix).toContain(h.config);
  });

  it('a config inside the repository is a warning; owners from the env count', async () => {
    const path = join(repo, 'config.json');
    writeFileSync(path, '{ "walk": true }');
    const c = await setupChecks(input(path, { env: { BOT_OWNERS: 'Alex' } }));
    expect(by(c, 'config')[0]!.level).toBe('warn');
    expect(by(c, 'owners')[0]!.level).toBe('ok');
  });

  it('settings: a bad key in the config fails, a bad value in settings.json warns, broken JSON fails', async () => {
    const a = await setupChecks(input(home('{ "settings": { "noSuchKey": 1 } }').config));
    expectCheck(by(a, 'settings')[0], 'fail', 'noSuchKey');
    const b = await setupChecks(input(home('{ "owners": ["Alex"] }', { 'settings.json': '{ "guardRadius": 9999 }' }).config));
    expectCheck(by(b, 'settings')[0], 'warn', '1 value ignored');
    const c = await setupChecks(input(home('{ "owners": ["Alex"] }', { 'settings.json': '{ nope' }).config));
    expectCheck(by(c, 'settings')[0], 'fail', 'not valid JSON');
  });

  it('pings only with --ping, the configured server, and reads the answer against what the bot speaks', async () => {
    const ping = vi.fn(() => Promise.resolve({ protocol: 2225, version: '1.26.60', motd: 'test' }));
    const h = home('{ "owners": ["Alex"], "walk": true, "port": 19212 }');
    const quiet = await setupChecks(input(h.config, { ping }));
    expect(ping).not.toHaveBeenCalled();
    expect(by(quiet, 'server')[0]!.text).toContain('not checked');
    const ok = await setupChecks(input(h.config, { ping }, { ping: true }));
    expect(ping).toHaveBeenCalledWith({ host: '127.0.0.1', port: 19212, transport: 'raknet' });
    expectCheck(by(ok, 'server')[0], 'ok', 'the bot speaks it as 1.26.60');
    const other = await setupChecks(input(h.config, { ping: () => Promise.resolve({ protocol: 1000, version: '1.21.0' }) }, { ping: true }));
    expectCheck(by(other, 'server')[0], 'fail', undefined, 'docs/versions.md');
    const none = await setupChecks(input(h.config, { ping: () => Promise.reject(new Error('Ping timed out')) }, { ping: true, host: '127.0.0.1', port: '19999' }));
    expectCheck(by(none, 'server')[0], 'fail', '127.0.0.1:19999', 'UDP 19999');
  });

  it('a server off this machine: says it must be offline-mode and that names are not checked there', async () => {
    const c = await setupChecks(input(home('{ "owners": ["Alex"], "walk": true, "host": "192.0.2.10" }').config));
    expect(by(c, 'server')[0]!.text).toContain('online-mode=false');
  });

  it('the Realm cache: counted by file name for the account label, never opened; a folder in the repository fails', async () => {
    const profiles = join(tmp, 'profiles');
    mkdirSync(profiles, { recursive: true });
    const pre = tokenCachePrefix('mybot');
    for (const kind of ['live', 'xbl', 'bed']) writeFileSync(join(profiles, `${pre}${kind}-cache.json`), 'SECRET-TOKEN-TEXT');
    writeFileSync(join(profiles, `${tokenCachePrefix('other')}live-cache.json`), 'x');
    const realm = (folder: string) => `{ "owners": ["Alex"], "walk": true, "realm": { "realmName": "Home", "accountName": "mybot", "profilesFolder": ${JSON.stringify(folder)} } }`;
    const c = await setupChecks(input(home(realm(profiles)).config));
    expectCheck(by(c, 'realm')[0], 'ok', '3 token cache files');
    expect(formatReport(c)).not.toContain('SECRET-TOKEN-TEXT');
    const fresh = await setupChecks(input(home(realm(join(tmp, 'no-profiles'))).config));
    expectCheck(by(fresh, 'realm')[0], 'info', 'not signed in yet');
    const inside = await setupChecks(input(home(realm(join(repo, 'profiles'))).config));
    expectCheck(by(inside, 'realm')[0], 'fail', 'inside the repository');
  });

  it("prismarine-auth's cache names: the same 6-character sha1 prefix", () => {
    const auth = createRequire(createRequire(import.meta.url).resolve('bedrock-protocol'))('prismarine-auth/src/common/Util.js') as { createHash(s: string): string };
    expect(tokenCachePrefix('bot')).toBe(`${auth.createHash('bot')}_`);
  });

  it('the panel: a LAN host without a token fails, the token is named by where it is, a busy port warns', async () => {
    const lan = await setupChecks(input(home('{ "owners": ["Alex"], "walk": true, "healthPort": 9464, "panel": { "host": "0.0.0.0" } }').config));
    expect(by(lan, 'panel')[0]!.level).toBe('fail');
    const tok = await setupChecks(input(home('{ "owners": ["Alex"], "walk": true, "healthPort": 9464, "panel": { "token": "abcdefghijklmnopqrstuvwx" } }').config, { portFree: () => Promise.resolve(false) }));
    expect(by(tok, 'panel')[0]!.text).toContain('token set (config panel.token)');
    expect(formatReport(tok)).not.toContain('abcdefghijklmnopqrstuvwx');
    expectCheck(by(tok, 'panel')[1], 'warn', 'port 9464 is in use (another bot, or another program)');
  });

  it('Discord: the secret files present or not (never their contents), and the switches that need them', async () => {
    const off = await setupChecks(input(home('{ "owners": ["Alex"], "walk": true }').config));
    expect(by(off, 'discord')).toHaveLength(1);
    expectCheck(by(off, 'discord')[0], 'info', 'webhook not set, bot token not set');
    const h = home('{ "owners": ["Alex"], "walk": true, "settings": { "notifyDiscord": true, "discordBot": true } }', { [WEBHOOK_FILE]: 'https://example.invalid/SECRET-HOOK' });
    const exists = vi.fn(existsSync);
    const c = await setupChecks(input(h.config, { exists }));
    const d = by(c, 'discord');
    expect(d.map((x) => x.level)).toEqual(['warn', 'warn', 'info']); // the bot token missing, nobody allowed; the summary
    expect(d.at(-1)!.text).toContain(`webhook set (${WEBHOOK_FILE}), bot token not set`);
    expect(formatReport(c)).not.toContain('SECRET-HOOK');
    expect(exists).toHaveBeenCalledWith(join(h.dir, WEBHOOK_FILE));
    const env = await setupChecks(input(home('{ "owners": ["Alex"], "walk": true }').config, { env: { BEDROCKBOT_DISCORD_TOKEN: 'SECRET-TOKEN' } }));
    expect(by(env, 'discord')[0]!.text).toContain('bot token set (BEDROCKBOT_DISCORD_TOKEN)');
    expect(formatReport(env)).not.toContain('SECRET-TOKEN');
  });

  it('names the same secret files and placeholders the bot and config:init use', () => {
    expect(WEBHOOK_FILE).toBe(DISCORD_FILE);
    expect(BOT_TOKEN_FILE).toBe(BOT_TOKEN_FILE_USED);
    expect(EXAMPLE_CONFIG).toContain(`"${EXAMPLE_OWNER}"`);
    expect(EXAMPLE_CONFIG).toContain(`"${EXAMPLE_REALM}"`);
  });
});

describe('bot:check, the command', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: BOT_DIR, env: { ...process.env, BEDROCKBOT_CONFIG: undefined, BOT_OWNERS: undefined, INIT_CWD: tmp }, encoding: 'utf8', timeout: 60_000 });

  it('--no-config: the report with its warnings, exit 0', () => {
    const r = run(['--no-config']);
    expect(r.stdout).toContain('BedrockBot doctor');
    expect(r.stdout).toMatch(/ok {4}node/);
    expect(r.stdout).toMatch(/WARN {2}owners/);
    expect(r.status).toBe(0);
  });

  it('a missing --config file: FAIL and exit 1; a bad flag: usage and exit 2', () => {
    const r = run(['--config', join(tmp, 'missing.json')]);
    expect(r.stdout).toMatch(/FAIL {2}config/);
    expect(r.status).toBe(1);
    const bad = run(['--bogus']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('usage: pnpm bot:check');
  });
});
