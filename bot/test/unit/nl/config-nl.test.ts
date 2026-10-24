// PLAN.md 7.18 (Track Y): the `nl` config block reaches the task values.
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../../src/config/config.ts';
import { resolveSettings, type CliValues } from '../../../src/config/resolve.ts';
import { NL_VALUE_KEY } from '../../../src/nl/provider.ts';

const env = { cwd: '/tmp', defaultLogDir: '/tmp/logs' };

describe('nl config', () => {
  it('parses the block and hands it to the task values', () => {
    const cfg = parseConfig('{ "nl": { "provider": "ollama", "model": "qwen2.5:7b", "timeoutMs": 90000 } }', '/tmp');
    const cli: CliValues = {};
    const s = resolveSettings(cli, cfg, env);
    expect(s.nl).toEqual({ provider: 'ollama', url: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', timeoutMs: 90000 });
    expect(cli[NL_VALUE_KEY]).toBe(s.nl);
  });

  it('defaults to off and rejects unknown keys', () => {
    expect(resolveSettings({}, {}, env).nl.provider).toBe('none');
    expect(() => parseConfig('{ "nl": { "provider": "ollama", "apiKey": "x" } }', '/tmp')).toThrow(ConfigError);
  });
});
