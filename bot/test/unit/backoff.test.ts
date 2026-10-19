import { describe, expect, it } from 'vitest';
import { backoffDelay, defaultBackoff } from '../../src/connection/backoff.ts';

describe('backoffDelay', () => {
  it('doubles from 1 s and caps at 60 s without jitter', () => {
    const noJitter = () => 0;
    const schedule = Array.from({ length: 9 }, (_, i) => backoffDelay(i, defaultBackoff, noJitter));
    expect(schedule).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it('jitter only shortens the delay, by at most the jitter fraction', () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const max = Math.min(60_000, 1_000 * 2 ** attempt);
      for (const r of [0, 0.25, 0.5, 0.999, 1]) {
        const d = backoffDelay(attempt, defaultBackoff, () => r);
        expect(d).toBeLessThanOrEqual(max);
        expect(d).toBeGreaterThanOrEqual(Math.floor(max * 0.8));
      }
    }
  });

  it('never exceeds the cap, even for huge attempt counts', () => {
    expect(backoffDelay(1_000)).toBeLessThanOrEqual(60_000);
    expect(backoffDelay(1_000, defaultBackoff, () => 0)).toBe(60_000);
  });

  it('treats negative or fractional attempts sanely', () => {
    expect(backoffDelay(-3, defaultBackoff, () => 0)).toBe(1_000);
    expect(backoffDelay(1.7, defaultBackoff, () => 0)).toBe(2_000);
  });

  it('honours a custom policy', () => {
    const p = { baseMs: 100, capMs: 500, factor: 3, jitter: 0.5 };
    expect([0, 1, 2, 3].map((n) => backoffDelay(n, p, () => 0))).toEqual([100, 300, 500, 500]);
    expect(backoffDelay(0, p, () => 1)).toBe(50);
  });
});
