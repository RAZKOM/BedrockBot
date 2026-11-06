// The flee caught rule (Realm death 2026-11-05): a threat in reach that keeps hitting through a flight ends it cornered.
import { describe, expect, it } from 'vitest';
import { FLEE_CAUGHT_MS, fleeCaught } from '../../../src/tasks/pve.ts';

describe('fleeCaught', () => {
  it('fires after FLEE_CAUGHT_MS within range with a hit in that time; resets when the threat falls back', () => {
    const ep = { caughtSince: undefined as number | undefined };
    expect(fleeCaught(ep, 0, 1, undefined)).toBe(false);
    expect(fleeCaught(ep, 1000, 1, 900)).toBe(false);
    expect(fleeCaught(ep, FLEE_CAUGHT_MS, 1.2, 2500)).toBe(true);
    // fell back: the clock starts again
    expect(fleeCaught(ep, FLEE_CAUGHT_MS + 100, 6, 2500)).toBe(false);
    expect(ep.caughtSince).toBeUndefined();
    expect(fleeCaught(ep, 5000, 1, 2500)).toBe(false);
    // close for long enough but no hit since: not caught (it follows, it does not hurt)
    expect(fleeCaught(ep, 5000 + FLEE_CAUGHT_MS, 1, 2500)).toBe(false);
    expect(fleeCaught(ep, 5000 + FLEE_CAUGHT_MS + 100, 1, 7000)).toBe(true);
  });
});
