// Track AL: blocksdiff's expected-list parser and comparison (packs/truth/src/build.ts).
import { describe, expect, it } from 'vitest';
import { diffBlocks, parseEntry, parseExpected, parseExpectedStates, stateText, type Actual } from '../../src/build.js';
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

  it('Track B1: palette entries with states; only the listed states are compared, true and 1 alike', () => {
    expect(parseEntry('oak_stairs[weirdo_direction=1;upside_down_bit=true]')).toEqual({ id: 'minecraft:oak_stairs', states: { weirdo_direction: '1', upside_down_bit: 'true' } });
    expect(parseEntry('minecraft:stone')).toEqual({ id: 'minecraft:stone' });
    expect(() => parseEntry('oak_stairs[weirdo_direction]')).toThrow(/k=v/);
    const ex = parseExpectedStates('air,oak_stairs[weirdo_direction=1;upside_down_bit=1],oak_log[pillar_axis=x]', '0,1*2,2', 4);
    expect(ex[1]).toEqual({ id: 'minecraft:oak_stairs', states: { weirdo_direction: '1', upside_down_bit: '1' } });
    const cells = [...iterateBox(box({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }))];
    const act: Actual[] = [
      { typeId: 'minecraft:air', states: {} },
      { typeId: 'minecraft:oak_stairs', states: { weirdo_direction: 1, upside_down_bit: true, 'minecraft:corner': 'none' } },
      { typeId: 'minecraft:oak_stairs', states: { weirdo_direction: 2, upside_down_bit: true } },
      { typeId: 'minecraft:oak_log', states: { pillar_axis: 'x' } },
    ];
    const r = diffBlocks(cells, ex, act);
    expect(r.diffs).toBe(1);
    expect(r.first).toEqual([{ x: 2, y: 0, z: 0, expected: 'minecraft:oak_stairs[weirdo_direction=1;upside_down_bit=1]', actual: 'minecraft:oak_stairs[weirdo_direction=2;upside_down_bit=1]' }]);
    // the old form still compares ids only
    expect(parseExpected('air,oak_log', '0,1', 2)).toEqual(['minecraft:air', 'minecraft:oak_log']);
    expect(stateText(true)).toBe('1');
    expect(stateText('false')).toBe('0');
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
