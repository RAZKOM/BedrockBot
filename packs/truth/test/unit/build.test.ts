// Track AL: blocksdiff's expected-list parser and comparison (packs/truth/src/build.ts).
import { describe, expect, it } from 'vitest';
import { diffBlocks, parseExpected } from '../../src/build.js';
import { box, iterateBox } from '../../src/protocol.js';

describe('blocksdiff', () => {
  it('expands palette + runs into namespaced ids', () => {
    expect(parseExpected('air,cobblestone,*', '0*2,1,2*2', 5)).toEqual(['minecraft:air', 'minecraft:air', 'minecraft:cobblestone', '*', '*']);
  });

  it('refuses runs that do not cover the box or point outside the palette', () => {
    expect(() => parseExpected('air', '0*3', 4)).toThrow(/cover 3/);
    expect(() => parseExpected('air', '0*5', 4)).toThrow(/more than the box/);
    expect(() => parseExpected('air', '1*4', 4)).toThrow(/outside the palette/);
    expect(() => parseExpected('air', 'x', 4)).toThrow(/bad run/);
    expect(() => parseExpected(undefined, '0', 1)).toThrow(/usage/);
  });

  it('counts the differences in canonical order, * matches anything', () => {
    const cells = [...iterateBox(box({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }))];
    const exp = ['minecraft:stone', '*', 'minecraft:air', 'minecraft:air'];
    const act = ['minecraft:stone', 'minecraft:dirt', 'minecraft:cobblestone', 'minecraft:air'];
    const r = diffBlocks(cells, exp, act);
    expect(r.diffs).toBe(1);
    expect(r.first).toEqual([{ x: 0, y: 0, z: 1, expected: 'minecraft:air', actual: 'minecraft:cobblestone' }]);
  });
});
