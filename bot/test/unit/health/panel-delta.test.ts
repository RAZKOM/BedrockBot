// Decision 0061: the state deltas of the push channel (client/delta.ts): only what changed, one op per
// changed inventory cell, one op for a log that scrolled, a replacement when that is shorter, and
// apply(prev, diff(prev, next)) == next for every case and for random edits of the real panel state.
import { describe, expect, it } from 'vitest';
import { applyDelta, diffJson, jsonEqual, type Json } from '../../../src/health/panel/client/delta.ts';
import { liteState } from '../../../src/health/panel/state.ts';
import { fullInventory, fullState, stack } from './panel-fixtures.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const roundTrip = (a: Json, b: Json): Json => applyDelta(clone(a), diffJson(a, b));

describe('state deltas', () => {
  it('equal values: no ops; scalars and keys: set and delete', () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
    expect(diffJson({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 5 } })).toEqual([
      ['d', ['b', 'd']],
      ['s', ['b', 'c'], 5],
    ]);
    expect(diffJson({ a: null }, { a: 0 })).toEqual([['s', ['a'], 0]]);
    expect(diffJson(1, 'x')).toEqual([['s', [], 'x']]);
    expect(diffJson(undefined, { a: 1 })).toEqual([['s', [], { a: 1 }]]);
    expect(roundTrip({ a: 1 }, [1, 2])).toEqual([1, 2]);
  });

  it('an inventory cell that changed is one op; a log that scrolled is one op', () => {
    const slots: Json = Array.from({ length: 36 }, (_, i) => (i % 3 ? { name: 'cobblestone', count: 64 } : null));
    const next = clone(slots);
    next[4] = { name: 'cobblestone', count: 63 };
    expect(diffJson(slots, next)).toEqual([['s', [4, 'count'], 63]]);
    const logs = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const scrolled = [...logs.slice(2), 'line 50', 'line 51'];
    expect(diffJson(logs, scrolled)).toEqual([['a', [], 2, ['line 50', 'line 51']]]);
    expect(diffJson(['a'], ['a', 'b'])).toEqual([['a', [], 0, ['b']]]); // a ring still filling up
    expect(roundTrip({ l: logs }, { l: scrolled })).toEqual({ l: scrolled });
  });

  it('many changed elements: one replacement instead of an op per element', () => {
    const a = Array.from({ length: 10 }, (_, i) => i);
    const b = a.map((x) => x + 100);
    expect(diffJson(a, b)).toEqual([['s', [], b]]);
    expect(diffJson([1, 2, 3], [4, 5])).toEqual([['s', [], [4, 5]]]); // shorter, not a scroll
  });

  it('jsonEqual is deep and order-insensitive for keys', () => {
    expect(jsonEqual({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined as unknown as Json })).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
  });

  it('apply refuses a path that is not there (the page reopens the stream for a snapshot)', () => {
    expect(() => applyDelta({ a: 1 }, [['s', ['x', 'y'], 1]])).toThrow(/no container at x/);
    expect(() => applyDelta({ a: 1 }, [['a', ['a'], 1, []]])).toThrow(/no array at a/);
  });

  it('the real panel state: a busy second is a small delta; random edits round-trip', () => {
    const before = clone(liteState(fullState())) as unknown as Json;
    const inv = fullInventory();
    (inv.slots as (ItemStack | null)[])[9] = stack('cobblestone', 63);
    const after = clone(liteState(fullState({ inventory: () => inv, vitals: () => ({ health: 16, food: 18 }), logs: () => [...Array.from({ length: 49 }, (_, i) => `2026-10-29T18:52:00.000Z INFO  [move] plan ${i + 1}`), 'new line'] }))) as unknown as Json;
    const ops = diffJson(before, after);
    expect(applyDelta(clone(before), ops)).toEqual(after);
    expect(ops.some((o) => o[0] === 's' && o[1].join('.') === 'inventory.slots.9.count')).toBe(true);
    // a deterministic PRNG: 300 random edits of the state, each round-trips
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let cur = clone(before);
    for (let i = 0; i < 300; i++) {
      const next = clone(cur) as Record<string, Json>;
      const self = next.self as Record<string, Json>;
      const invj = next.inventory as Record<string, Json[]>;
      switch (rnd(6)) {
        case 0:
          self.health = rnd(21);
          break;
        case 1:
          invj.slots![rnd(36)] = rnd(2) ? null : { name: `item_${rnd(5)}`, count: rnd(64) + 1, icon: 'item', colour: '#808080', abbr: 'It' };
          break;
        case 2:
          next.logs = [...(next.logs as Json[]).slice(rnd(3)), ...Array.from({ length: rnd(3) }, () => `log ${rnd(1000)}`)];
          break;
        case 3:
          delete next.memory;
          break;
        case 4:
          next.memory = { chests: { known: rnd(9) } };
          break;
        default:
          next.stack = (next.stack as Json[]).slice(0, rnd(4));
      }
      expect(roundTrip(cur, next)).toEqual(next);
      cur = next;
    }
  });
});
