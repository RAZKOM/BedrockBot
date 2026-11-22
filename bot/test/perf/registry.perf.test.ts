// The opt-in perf project (`pnpm test:perf`, Track REL3, docs/testing.md "The perf project"): registry-palette.test.ts's
// former time bound (decision 0024: the 1.26.60 runtime-id table from the BDS palette dump built in under 2 s), as it was.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/log.ts';
import { BlockRegistry } from '../../src/world/registry.ts';
import { recordedLogin } from '../unit/world/helpers.ts';

describe('block registry build, wall clock', () => {
  it('builds the table in well under a tick-sized budget per state', () => {
    const t0 = performance.now();
    const { startGame, itemRegistry } = recordedLogin();
    const reg = new BlockRegistry({ version: '1.26.60', logger: silentLogger });
    reg.handleStartGame(startGame);
    reg.handleItemRegistry(itemRegistry);
    const ms = performance.now() - t0;
    console.log(`[palette] registry build (prismarine + palette): ${ms.toFixed(0)} ms`);
    expect(reg.unknownRuntimeIds.size).toBe(0);
    expect(ms).toBeLessThan(2000);
  });
});
