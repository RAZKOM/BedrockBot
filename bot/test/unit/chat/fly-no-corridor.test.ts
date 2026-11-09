import { describe, expect, it } from 'vitest';
import { noCorridorAtAll } from '../../../src/chat/commands-fly.ts';

const base = { ok: false, legs: [], cruises: 0, walks: 0, windows: 0 };

describe('noCorridorAtAll: the fly command falls back to the plain flight', () => {
  it('when the first plan found no corridor and nothing moved', () => {
    expect(noCorridorAtAll({ ...base, reason: 'no corridor to 1,2,3 in walk / fly (17 volumes expanded)' })).toBe(true);
  });
  it('not when the trip moved or failed for another reason', () => {
    expect(noCorridorAtAll({ ...base, reason: 'no corridor to 1,2,3', cruises: 1 })).toBe(false);
    expect(noCorridorAtAll({ ...base, reason: 'interrupted' })).toBe(false);
    expect(noCorridorAtAll({ ...base, ok: true })).toBe(false);
    expect(noCorridorAtAll({ ...base, reason: 'no corridor', legs: [{ mode: 'walk', how: 'walk', ok: false, blocks: 3 }] as never })).toBe(false);
  });
});
