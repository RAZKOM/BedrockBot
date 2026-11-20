// Track E7 (docs/early-game.md "Dusk", ADR 0104): the obtain job at dusk: when the night is, the refill window before it,
// how far the step came, where the night is spent (shelterPlan) and the enclosed spot (night-shell.ts enclosedSpot).
import { describe, expect, it } from 'vitest';
import { beforeDusk, DUSK_STOPS, herePlan, nightNow, REFILL_LEAD, shelterPlan, stepProgress, type ShelterInputs } from '../../../src/chat/kit-night.ts';
import { DAWN, DUSK } from '../../../src/tasks/night.ts';
import { ENCLOSED_OPEN_MAX, enclosedSpot } from '../../../src/tasks/night-shell.ts';
import type { ObtainAction } from '../../../src/skills/items/obtain.ts';
import type { Vec3 } from '../../../src/world/types.ts';

const clock = (t: number | undefined) => ({ time: () => t, dusk: DUSK, dawn: DAWN });

describe('nightNow / beforeDusk', () => {
  it('the night task window, any day; unknown time: no', () => {
    expect(nightNow(clock(11_999))).toBe(false);
    expect(nightNow(clock(12_000))).toBe(true);
    expect(nightNow(clock(22_999))).toBe(true);
    expect(nightNow(clock(23_000))).toBe(false);
    expect(nightNow(clock(24_000 * 5 + 13_000))).toBe(true);
    expect(nightNow(clock(undefined))).toBe(false);
  });

  it(`the refill window: ${REFILL_LEAD} ticks before dusk up to dusk`, () => {
    expect(beforeDusk(clock(DUSK - REFILL_LEAD - 1))).toBe(false);
    expect(beforeDusk(clock(DUSK - REFILL_LEAD))).toBe(true);
    expect(beforeDusk(clock(DUSK - 1))).toBe(true);
    expect(beforeDusk(clock(DUSK))).toBe(false);
    expect(beforeDusk(clock(24_000 * 3 + DUSK - 100))).toBe(true);
    expect(beforeDusk(clock(undefined))).toBe(false);
    expect(beforeDusk({ time: () => 23_900, dusk: 500 }, 1200)).toBe(true); // across midnight
  });
});

describe('stepProgress and the steps a dusk ends', () => {
  const m = (a: [string, number][]) => new Map(a);
  it('a mine counts its item, a smelt what went into the furnace, a gather what was gained', () => {
    const mine = { kind: 'mine', item: 'raw_iron', n: 33, block: 'iron_ore', command: 'mine iron_ore 33' } as unknown as ObtainAction;
    expect(stepProgress(mine, m([['raw_iron', 2]]), m([['raw_iron', 17]]), 20)).toBe('15 of 33');
    const smelt = { kind: 'smelt', input: 'raw_iron', output: 'iron_ingot', n: 8, command: 'smelt raw_iron 8' } as unknown as ObtainAction;
    expect(stepProgress(smelt, m([['raw_iron', 8]]), m([['raw_iron', 0]]), 0)).toBe('8 of 8 in the furnace');
    const gather = { kind: 'gather', n: 8, command: 'gather 8' } as unknown as ObtainAction;
    expect(stepProgress(gather, m([]), m([]), 5)).toBe('5 of 8');
  });

  it('the steps that walk or wait end at dusk; crafts, the furnace and the bed run on', () => {
    for (const k of ['gather', 'mine', 'hunt', 'food', 'smelt', 'cook', 'goto']) expect(DUSK_STOPS.has(k), k).toBe(true);
    for (const k of ['craft', 'furnace', 'bed']) expect(DUSK_STOPS.has(k), k).toBe(false);
  });
});

describe('shelterPlan: where the night is spent', () => {
  const P = (x: number): Vec3 => ({ x, y: 64, z: 0 });
  const base = (o: Partial<ShelterInputs>): ShelterInputs => ({ bed: undefined, shelter: undefined, home: undefined, feet: { x: 50.5, y: 64, z: 0.5 }, shellOn: true, openSky: () => true, enclosed: () => undefined, ...o });

  it('a bed first (the shelter still set for a refused bed)', () => {
    const p = shelterPlan(base({ bed: P(1), home: P(2) }));
    expect(p.kind).toBe('bed');
    expect(p.set).toEqual(P(2));
    expect(p.text).toBe('in the bed at 1 64 0');
  });

  it('the shelter as it is; home when no shelter is set', () => {
    expect(shelterPlan(base({ shelter: P(3), home: P(2) }))).toEqual({ kind: 'shelter', set: undefined, text: 'at the shelter 3 64 0' });
    expect(shelterPlan(base({ home: P(2) }))).toEqual({ kind: 'home', set: P(2), text: 'at home 2 64 0' });
  });

  it('the owner\'s shelter or home is taken as it is, under the open sky and with no shell too (an enclosed spot does not replace it)', () => {
    const e = P(7);
    expect(shelterPlan(base({ shelter: P(3), shellOn: false, enclosed: () => e })).kind).toBe('shelter');
    expect(shelterPlan(base({ home: P(2), shellOn: false, enclosed: () => e })).kind).toBe('home');
    expect(shelterPlan(base({ shelter: P(3), shellOn: false, openSky: () => false })).kind).toBe('shelter');
  });

  it('no shelter and no home: an enclosed spot near the bot; else where it stands when the shell walls in there', () => {
    expect(shelterPlan(base({ enclosed: () => P(9) })).set).toEqual(P(9));
    const here = shelterPlan(base({}));
    expect(here).toEqual({ kind: 'here', set: { x: 50, y: 64, z: 0 }, text: 'walled in where it stands (50 64 0)' });
  });

  it('nowhere: no shell tonight, or a roof over the bot that is no enclosed spot (a cave): the job works on', () => {
    expect(shelterPlan(base({ shellOn: false })).kind).toBe('none');
    expect(shelterPlan(base({ shellOn: true, openSky: () => false })).kind).toBe('none'); // the shell does not build under a roof
    expect(shelterPlan(base({ feet: undefined })).kind).toBe('none');
    expect(shelterPlan(base({ shellOn: false })).set).toBeUndefined();
  });

  it('a bed with nowhere else to stand is still a plan (no shelter set for it)', () => {
    expect(shelterPlan(base({ bed: P(1), shellOn: false }))).toEqual({ kind: 'bed', set: undefined, text: 'in the bed at 1 64 0' });
  });

  it('herePlan (the shelter out of reach): the shelter and home are left out', () => {
    expect(herePlan({ feet: { x: 5.5, y: 40, z: 5.5 }, shellOn: false, openSky: () => false, enclosed: () => ({ x: 6, y: 40, z: 5 }) })).toEqual({ kind: 'enclosed', set: { x: 6, y: 40, z: 5 }, text: 'in the roofed spot at 6 40 5' });
    expect(herePlan({ feet: { x: 5.5, y: 40, z: 5.5 }, shellOn: false, openSky: () => true, enclosed: () => undefined }).kind).toBe('none');
    expect(herePlan({ feet: { x: 5.5, y: 70, z: 5.5 }, shellOn: true, openSky: () => true, enclosed: () => undefined }).kind).toBe('here');
  });
});

describe('enclosedSpot', () => {
  // a tunnel end: stone everywhere, a 1 x 2 tunnel from x = 0 to x = 6 at y 64-65 (z = 0), open to the sky at x > 6
  const solid = (x: number, y: number, z: number): boolean => {
    if (x > 6) return y < 64;
    if (y < 64) return true;
    if (z === 0 && x >= 0 && (y === 64 || y === 65)) return false;
    return true;
  };
  const name = (x: number, y: number, z: number): string | undefined => (solid(x, y, z) ? 'stone' : 'air');

  it('the tunnel cell nearest the start with a roof and the sides solid but the way in', () => {
    const p = enclosedSpot({ x: 6.5, y: 64, z: 0.5 }, solid, name);
    expect(p).toBeDefined();
    expect(p!.y).toBe(64);
    expect(p!.z).toBe(0);
    expect(p!.x).toBeLessThanOrEqual(6);
  });

  it('only a spot the body can walk to: a pocket behind rock is not chosen, the tunnel reached by steps is', () => {
    // open ground at y 64; a closed pocket in the rock under it (x 2, y 60-61), no way in
    const pocket = (x: number, y: number, z: number): boolean => !(y >= 64 || (x === 2 && z === 0 && (y === 60 || y === 61)));
    expect(enclosedSpot({ x: 0.5, y: 64, z: 0.5 }, pocket, () => 'stone')).toBeUndefined();
    // a staircase down from the surface (a step a block: x 1..4, y 63..60, two free cells over each floor and the cell the
    // body passes through), ending in a dead end at x 4: reached by steps, and the dead end is the enclosed spot
    const stair = (x: number, y: number, z: number): boolean => {
      if (y >= 64) return false;
      if (z !== 0 || x < 1 || x > 4) return true;
      const feet = 64 - x; // the feet cell of the step at x
      return !(y >= feet && y <= feet + 2);
    };
    const p = enclosedSpot({ x: 0.5, y: 64, z: 0.5 }, stair, (x, y, z) => (stair(x, y, z) ? 'stone' : 'air'));
    expect(p).toEqual({ x: 4, y: 60, z: 0 });
  });

  it('a start in the air takes the floor under it; with no floor within 3 there is none', () => {
    expect(enclosedSpot({ x: 0.5, y: 65.2, z: 0.5 }, solid, name)).toEqual({ x: 0, y: 64, z: 0 });
    expect(enclosedSpot({ x: 0.5, y: 80, z: 0.5 }, (x, y) => y < 64, () => 'stone')).toBeUndefined();
  });

  it('open ground has none; unknown cells count as open', () => {
    expect(enclosedSpot({ x: 20.5, y: 64, z: 0.5 }, (x, y) => y < 64, () => 'grass_block', 6)).toBeUndefined();
    expect(enclosedSpot({ x: 3.5, y: 64, z: 0.5 }, () => undefined, () => undefined, 4)).toBeUndefined();
    expect(ENCLOSED_OPEN_MAX).toBe(2);
  });

  it('a canopy is no roof', () => {
    const leafy = (x: number, y: number, z: number): boolean => y < 64 || y === 67 || ((y === 64 || y === 65) && !(x === 0 && z === 0) && Math.abs(x) <= 1 && Math.abs(z) <= 1 && (x === 0 || z === 0));
    const leafName = (x: number, y: number, z: number): string | undefined => (y === 67 ? 'oak_leaves' : leafy(x, y, z) ? 'dirt' : 'air');
    expect(enclosedSpot({ x: 0.5, y: 64, z: 0.5 }, leafy, leafName, 2)).toBeUndefined();
    const roofed = (x: number, y: number, z: number): boolean => leafy(x, y, z);
    const roofName = (x: number, y: number, z: number): string | undefined => (y === 67 ? 'stone' : leafy(x, y, z) ? 'dirt' : 'air');
    expect(enclosedSpot({ x: 0.5, y: 64, z: 0.5 }, roofed, roofName, 2)).toEqual({ x: 0, y: 64, z: 0 });
  });
});
