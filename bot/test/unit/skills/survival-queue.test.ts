// The survival kit's `queued` wait (Realm death 2026-11-05): the stash step's drop / box-to-hotbar wait out a
// running keeper pass instead of failing `busy` at once.
import { describe, expect, it } from 'vitest';
import { awaitIdle } from '../../../src/skills/survival/index.ts';

describe('awaitIdle', () => {
  it('is true at once with no op, after the op settles (even rejected), false on the timeout', async () => {
    expect(await awaitIdle(() => undefined, 10)).toBe(true);
    let op: Promise<unknown> | undefined = new Promise((r) => setTimeout(r, 20)).then(() => { op = undefined; });
    expect(await awaitIdle(() => op, 1000)).toBe(true);
    let bad: Promise<unknown> | undefined = new Promise((_, j) => setTimeout(() => { bad = undefined; j(new Error('x')); }, 10));
    expect(await awaitIdle(() => bad, 1000)).toBe(true);
    const stuck = new Promise(() => {});
    const t = performance.now();
    expect(await awaitIdle(() => stuck, 30)).toBe(false);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
