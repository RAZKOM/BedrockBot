// Runtime settings (PLAN.md 7.9, Track Q; config/settings.ts): parsing, bounds, persistence,
// precedence (default < settings.json < config.json < CLI at start-up, then !set), the settings file
// location, and the !set chat command.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Chat, CommandDef } from '../../src/chat/chat.ts';
import { chunkLine, registerSettingsCommands } from '../../src/chat/commands.ts';
import { PLAIN_MODE } from '../../src/chat/style.ts';
import { parseConfig } from '../../src/config/config.ts';
import {
  applyStartupSettings,
  describeSetting,
  parseSettingValue,
  resolveSettingsFile,
  RuntimeSettings,
  SETTING_DEFS,
  SETTING_KEYS,
  SettingError,
  settingKey,
  settingsFromValues,
  SETTINGS_VALUE_KEY,
} from '../../src/config/settings.ts';
import type { CommandDeps } from '../../src/tasks/process/deps.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bot-settings-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parsing and bounds', () => {
  it('parses booleans and numbers, rejects out-of-bounds and non-integers', () => {
    expect(parseSettingValue('allowBreak', 'on')).toBe(true);
    expect(parseSettingValue('allowBreak', 'OFF')).toBe(false);
    expect(parseSettingValue('allowBreak', true)).toBe(true);
    expect(parseSettingValue('sprint', '0')).toBe(false);
    expect(() => parseSettingValue('sprint', 'maybe')).toThrow(SettingError);
    expect(parseSettingValue('guardRadius', '8')).toBe(8);
    expect(parseSettingValue('guardRadius', 64)).toBe(64);
    expect(() => parseSettingValue('guardRadius', '1')).toThrow('guardRadius must be a whole number 2..64, got "1"');
    expect(() => parseSettingValue('guardRadius', '8.5')).toThrow(/whole number/);
    expect(() => parseSettingValue('guardRadius', '')).toThrow(SettingError);
    expect(parseSettingValue('fleeHealth', '6.5')).toBe(6.5);
    expect(() => parseSettingValue('fleeHealth', '21')).toThrow('fleeHealth must be 0..20, got "21"');
    expect(parseSettingValue('nudgeInterval', '0')).toBe(0);
    expect(settingKey('GUARDRADIUS')).toBe('guardRadius');
    expect(settingKey('nope')).toBeUndefined();
  });

  it('has every setting with a default inside its bounds and a description, including the placeholders', () => {
    for (const k of SETTING_KEYS) {
      const d = SETTING_DEFS[k] as { kind: string; default: number | boolean; min?: number; max?: number; description: string };
      expect(d.description.length).toBeGreaterThan(10);
      if (d.kind === 'number') expect(d.default as number).toBeGreaterThanOrEqual(d.min!);
      if (d.kind === 'number') expect(d.default as number).toBeLessThanOrEqual(d.max!);
      expect(parseSettingValue(k, d.default)).toBe(d.default);
    }
    const s = new RuntimeSettings();
    expect(s.snapshot()).toMatchObject({ avoidMobRadius: 4, avoidSpawnerRadius: 8, toolWearLimit: 10, throwawayMin: 16, useBoneMeal: true, mineTunnelLen: 32, guardRadius: 16, fleeHealth: 8, nudgeInterval: 240, followDistance: 3, sprint: true, allowBreak: false, allowPlace: false, closeDoors: false });
    expect(describeSetting('guardRadius', 16)).toBe('guardRadius 16 (2..64 blocks, default 16): guard: fight hostiles within this radius of home');
    expect(describeSetting('allowBreak', true)).toMatch(/^allowBreak on \(on\|off, default off\): /);
  });
});

describe('persistence and precedence', () => {
  it('!set persists to the file and survives a restart; start-up values win but are not written', () => {
    const file = join(tmp(), 'settings.json');
    const a = RuntimeSettings.open(file);
    expect(a.get('guardRadius')).toBe(16);
    const changes: string[] = [];
    a.onChange((k, v, old) => changes.push(`${k} ${String(old)}->${String(v)}`));
    expect(a.set('guardRadius', '8')).toBe(8);
    expect(a.get('guardRadius')).toBe(8);
    expect(changes).toEqual(['guardRadius 16->8']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ guardRadius: 8 });
    expect(() => a.set('guardRadius', '100')).toThrow(SettingError);
    expect(a.get('guardRadius')).toBe(8);

    // restart: the file value
    const b = RuntimeSettings.open(file);
    expect(b.get('guardRadius')).toBe(8);
    expect(b.source('guardRadius')).toBe('file');
    // restart with a config value and a CLI flag: config < CLI, both over the file, neither written
    const c = RuntimeSettings.open(file);
    applyStartupSettings(c, { config: { guardRadius: 24, allowBreak: true }, cliSet: ['guardRadius=32'], configNudge: 120, cliNudge: '60' });
    expect(c.get('guardRadius')).toBe(32);
    expect(c.get('allowBreak')).toBe(true);
    expect(c.get('nudgeInterval')).toBe(60);
    expect(c.source('guardRadius')).toBe('startup');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ guardRadius: 8 });
    // !set afterwards wins and is written
    c.set('allowBreak', 'off');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ guardRadius: 8, allowBreak: false });
    // default: removed from the file
    c.reset('guardRadius');
    expect(c.get('guardRadius')).toBe(16);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ allowBreak: false });
  });

  it('a bad file: invalid JSON is an error; unknown keys and bad values are ignored and kept', () => {
    const dir = tmp();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ nope');
    expect(() => RuntimeSettings.open(bad)).toThrow(/not valid JSON/);
    const odd = join(dir, 'odd.json');
    writeFileSync(odd, JSON.stringify({ $comment: 'x', guardRadius: 500, futureKey: 1, sprint: false }));
    const warnings: string[] = [];
    const s = RuntimeSettings.open(odd, { log: { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} } });
    expect(s.get('guardRadius')).toBe(16);
    expect(s.get('sprint')).toBe(false);
    expect(warnings.join(' | ')).toMatch(/guardRadius must be .* using 16 \| .*unknown setting "futureKey" ignored/);
    s.set('fleeHealth', 4);
    expect(JSON.parse(readFileSync(odd, 'utf8'))).toEqual({ $comment: 'x', guardRadius: 500, futureKey: 1, sprint: false, fleeHealth: 4 });
  });

  it('start-up errors name the key; in-memory settings write nothing', () => {
    const s = new RuntimeSettings();
    expect(() => applyStartupSettings(s, { config: { nope: 1 } })).toThrow(/config settings.nope: unknown setting/);
    expect(() => applyStartupSettings(s, { cliSet: ['guardRadius'] })).toThrow(/--set expects key=value/);
    expect(() => applyStartupSettings(s, { cliSet: ['fleeHealth=99'] })).toThrow(/fleeHealth must be 0..20/);
    s.set('guardRadius', 9);
    expect(s.file).toBeUndefined();
    expect(s.get('guardRadius')).toBe(9);
  });

  it('config.json accepts a settings block', () => {
    const cfg = parseConfig('{ "settings": { "allowBreak": true, "guardRadius": 24 } }', tmp());
    expect(cfg.settings).toEqual({ allowBreak: true, guardRadius: 24 });
  });

  it('the task gets the CLI instance through values.$settings, else a fresh one', () => {
    const s = new RuntimeSettings();
    expect(settingsFromValues({ [SETTINGS_VALUE_KEY]: s })).toEqual({ settings: s, own: false });
    const own = settingsFromValues({});
    expect(own.own).toBe(true);
    expect(own.settings).toBeInstanceOf(RuntimeSettings);
  });
});

describe('settings file location', () => {
  it('flag > env > next to the config file; none with --no-config; never inside the repository', () => {
    const repo = tmp();
    const outside = tmp();
    expect(resolveSettingsFile({ flag: 'a/s.json', env: join(outside, 'e.json'), configPath: join(outside, 'config.json'), cwd: outside, repoRoot: repo }).file).toBe(join(outside, 'a', 's.json'));
    expect(resolveSettingsFile({ env: join(outside, 'e.json'), configPath: join(outside, 'config.json'), cwd: outside, repoRoot: repo }).file).toBe(join(outside, 'e.json'));
    expect(resolveSettingsFile({ configPath: join(outside, 'config.json'), cwd: outside, repoRoot: repo }).file).toBe(join(outside, 'settings.json'));
    expect(resolveSettingsFile({ cwd: outside, repoRoot: repo }).file).toBeUndefined();
    expect(() => resolveSettingsFile({ flag: join(repo, 's.json'), cwd: outside, repoRoot: repo })).toThrow(/inside the repository/);
    const derived = resolveSettingsFile({ configPath: join(repo, 'cfg', 'config.json'), cwd: outside, repoRoot: repo });
    expect(derived.file).toBeUndefined();
    expect(derived.warning).toMatch(/not persisted/);
  });
});

describe('!set', () => {
  function setup(file?: string) {
    const defs = new Map<string, CommandDef>();
    const chat = { register: (d: CommandDef) => defs.set(d.name, d), styleMode: () => PLAIN_MODE, prefix: '!' } as unknown as Chat;
    const settings = RuntimeSettings.open(file);
    registerSettingsCommands({ chat, settings } as unknown as CommandDeps);
    const run = (...args: string[]) => {
      const out: string[] = [];
      defs.get('set')!.run({ line: {} as never, sender: { kind: 'console' }, args, reply: (m) => out.push(m) });
      return out;
    };
    return { run, settings };
  }

  it('lists, describes, validates, applies and persists', () => {
    const file = join(tmp(), 'settings.json');
    const { run, settings } = setup(file);
    const list = run();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((l) => l.length <= 240 && l.startsWith('settings: '))).toBe(true);
    expect(list.join(' ')).toContain('guardRadius 16');
    expect(list.join(' ')).toContain('mineTunnelLen 32');
    expect(run('guardradius')).toEqual(['guardRadius 16 (2..64 blocks, default 16): guard: fight hostiles within this radius of home']);
    expect(run('guardRadius', '8')).toEqual(['guardRadius = 8 (was 16)']);
    expect(settings.get('guardRadius')).toBe(8);
    expect(existsSync(file)).toBe(true);
    expect(run('guardRadius', '1')).toEqual(['guardRadius must be a whole number 2..64, got "1"']);
    expect(run('allowBreak', 'yes')).toEqual(['allowBreak = on (was off)']);
    expect(run('allowBreak', 'default')).toEqual(['allowBreak = off (was on)']);
    expect(run('bogus', '1')).toEqual(['unknown setting bogus; !set lists them']);
    expect(setup().run('sprint', 'off')).toEqual(['sprint = off (was on), not saved (no settings file)']);
  });

  it('chunks long lists into reply lines', () => {
    expect(chunkLine('p: ', ['aaaa', 'bbbb', 'cccc'], 12)).toEqual(['p: aaaa', 'p: bbbb', 'p: cccc']);
    expect(chunkLine('p: ', ['a', 'b'], 100)).toEqual(['p: a, b']);
    expect(chunkLine('p: ', [], 100)).toEqual(['p: ']);
  });
});
