// Track AE: the `panel` config block, BEDROCKBOT_PANEL_TOKEN and the token config:init writes.
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/config.ts';
import { EXAMPLE_CONFIG, PANEL_TOKEN_PLACEHOLDER, panelToken } from '../../../src/config/init.ts';
import { resolveSettings, SettingsError } from '../../../src/config/resolve.ts';

const env = { cwd: process.cwd(), defaultLogDir: 'logs' };

describe('panel config', () => {
  it('defaults: 127.0.0.1, port from healthPort, no token', () => {
    expect(resolveSettings({}, {}, env).panel).toEqual({ host: '127.0.0.1', port: undefined, token: undefined });
  });

  it('reads the block; the env token wins', () => {
    const cfg = parseConfig('{ "healthPort": 9464, "panel": { "host": "0.0.0.0", "port": 9466, "token": "aaaaaaaaaaaaaaaaaaaaaaaa" } }', '.');
    expect(resolveSettings({}, cfg, env).panel).toEqual({ host: '0.0.0.0', port: 9466, token: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(resolveSettings({}, cfg, { ...env, panelToken: 'bbbbbbbbbbbbbbbbbbbbbbbb' }).panel.token).toBe('bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(() => resolveSettings({}, cfg, { ...env, panelToken: 'short' })).toThrow(SettingsError);
  });

  it('rejects bad tokens and unknown keys', () => {
    expect(() => parseConfig('{ "panel": { "token": "has space in it 123456" } }', '.')).toThrow(/panel\.token/);
    expect(() => parseConfig('{ "panel": { "token": "short" } }', '.')).toThrow(/panel\.token/);
    expect(() => parseConfig('{ "panel": { "open": true } }', '.')).toThrow(/panel/);
  });

  it('config:init writes a fresh 24-character token in place of the placeholder', () => {
    const t = panelToken();
    expect(t).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(panelToken()).not.toBe(t);
    expect(EXAMPLE_CONFIG).toContain(PANEL_TOKEN_PLACEHOLDER);
    const cfg = parseConfig(EXAMPLE_CONFIG.replace(PANEL_TOKEN_PLACEHOLDER, t), '.');
    expect(cfg.panel).toEqual({ host: '127.0.0.1', token: t });
  });
});
