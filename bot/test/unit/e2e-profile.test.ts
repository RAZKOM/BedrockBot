// scripts/e2e-profile.ts points every e2e suite at one container. A suite that reads a server variable the profile
// does not set falls back to its own default server, which may be another track's (Track U2, 2026-11-16: a profile
// run of nav-water joined bds-fly). This test reads the e2e sources and fails on any such variable.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BOT = fileURLToPath(new URL('../..', import.meta.url));
const E2E = join(BOT, 'test', 'e2e');
/** A BDS server's port or container (not the bot's own HTTP ports: CACHE_HEALTH_PORT, PANEL_*_E2E_PORT, ...). */
const SERVER_VAR = /process\.env\.([A-Z0-9_]*BDS[A-Z0-9_]*_(?:PORT|CONTAINER))\b/g;

describe('e2e-profile sets every server variable the e2e suites read', () => {
  it('no suite falls back to a default server under a profile', () => {
    const profile = readFileSync(join(BOT, 'scripts', 'e2e-profile.ts'), 'utf8');
    const missing = new Map<string, string[]>();
    let seen = 0;
    for (const f of readdirSync(E2E).filter((n) => n.endsWith('.ts'))) {
      for (const m of readFileSync(join(E2E, f), 'utf8').matchAll(SERVER_VAR)) {
        seen++;
        const v = m[1]!;
        if (new RegExp(`\\b${v}\\b`).test(profile)) continue;
        missing.set(v, [...(missing.get(v) ?? []), f]);
      }
    }
    expect(seen).toBeGreaterThan(40);
    expect(Object.fromEntries(missing)).toEqual({});
  });
});
