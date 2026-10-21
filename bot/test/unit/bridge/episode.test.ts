import { describe, expect, it } from 'vitest';
import { Episode } from '../../../src/bridge/episode.ts';

describe('episode bookkeeping', () => {
  it('pays logs entering the inventory once (high-water mark)', () => {
    const e = new Episode();
    e.start(1000n, 0);
    expect(e.step(1010n, 2, false)).toMatchObject({ logsDelta: 2, ticksUsed: 10, done: false });
    expect(e.step(1020n, 1, false).logsDelta).toBe(0); // one log left the inventory
    expect(e.step(1030n, 2, false).logsDelta).toBe(0); // and was picked up again: no pay
    expect(e.step(1040n, 3, false).logsDelta).toBe(1);
    expect(e.logs).toBe(3);
  });

  it('counts from the reset baseline', () => {
    const e = new Episode();
    e.start(0n, 5);
    expect(e.step(1n, 5, false).logsDelta).toBe(0);
    expect(e.step(2n, 6, false).logsDelta).toBe(1);
    expect(e.logs).toBe(1);
  });

  it('terminates on target logs and death, truncates on steps and ticks', () => {
    const a = new Episode({ targetLogs: 4 });
    a.start(0n, 0);
    expect(a.step(10n, 4, false)).toMatchObject({ done: true, terminated: true, truncated: false, reason: 'logs' });
    expect(() => a.step(20n, 4, false)).toThrow(/done/);

    const b = new Episode();
    b.start(0n, 0);
    expect(b.step(10n, 0, true)).toMatchObject({ done: true, terminated: true, died: true, reason: 'died' });

    const c = new Episode({ maxSteps: 3 });
    c.start(0n, 0);
    c.step(1n, 0, false);
    c.step(2n, 0, false);
    expect(c.step(3n, 0, false)).toMatchObject({ done: true, terminated: false, truncated: true, reason: 'steps' });

    const d = new Episode();
    d.start(100n, 0);
    expect(d.step(2499n, 0, false).done).toBe(false);
    expect(d.step(2500n, 0, false)).toMatchObject({ truncated: true, reason: 'ticks' });
  });

  it('needs a reset first; defaults are PLAN section 9', () => {
    const e = new Episode();
    expect(e.limits).toEqual({ maxSteps: 200, maxTicks: 2400, targetLogs: 16 });
    expect(() => e.step(1n, 0, false)).toThrow(/reset/);
  });
});
