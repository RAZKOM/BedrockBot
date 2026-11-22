// The survival kit's `queued` wait (Realm death 2026-11-05): the stash step's drop / box-to-hotbar wait out a
// running keeper pass instead of failing `busy` at once.
import { describe, expect, it, vi } from 'vitest';
import { awaitIdle } from '../../../src/skills/survival/index.ts';

describe('awaitIdle', () => {
  it('is true at once with no op, after the op settles (even rejected), false on the timeout', async () => {
    expect(await awaitIdle(() => undefined, 10)).toBe(true);
    let op: Promise<unknown> | undefined = new Promise((r) => setTimeout(r, 20)).then(() => { op = undefined; });
    expect(await awaitIdle(() => op, 1000)).toBe(true);
    let bad: Promise<unknown> | undefined = new Promise((_, j) => setTimeout(() => { bad = undefined; j(new Error('x')); }, 10));
    expect(await awaitIdle(() => bad, 1000)).toBe(true);
    // a stuck op: false when its 30 ms are up, not before (Track REL3: on fake timers, not a wall-clock bound)
    const stuck = new Promise(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      let out: boolean | undefined;
      void awaitIdle(() => stuck, 30).then((v) => (out = v));
      await vi.advanceTimersByTimeAsync(29);
      expect(out).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(out).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
