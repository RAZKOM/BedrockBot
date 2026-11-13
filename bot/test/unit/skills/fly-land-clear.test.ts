// Flight v2 Track F11 (docs/flight.md "The flight comes down where it planned to", decisions/0084): a flight that arrives
// high over a landing ringed by taller things comes down ON the landing. Offline on synthetic worlds and the physics
// engine (stepBody): the descent circle's floor (plan.ts spiralTops / spiralFloor), the landing flown in over what stands
// round it (the rim's reach, touchdownCheck), whole trips onto a yard between roofs with the descent as it is and as it
// was, the flights the track does not touch flown tick for tick the same, the line of a flight that ends off its landing,
// and what the nearest safe ground may be (ground.ts).
import { describe, expect, it } from 'vitest';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { landedOn, simulateFlight } from '../../../src/skills/fly/glide.ts';
import { perched, standsOn } from '../../../src/skills/fly/ground.ts';
import { cellsAround, ColumnView, floorsOf, walkTarget, type BlockLookup } from '../../../src/skills/fly/landing.ts';
import { columnKey, cruiseHeight, discTop, LAND_SWITCH, RIM_OVER, rimReach, SPIRAL_CLEAR, spiralFit, spiralFloor, spiralTops, touchdownCheck, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import type { BlockBox } from '../../../src/skills/input/index.ts';
import type { Box } from '../../../src/world/types.ts';
import { FEET, trip, world } from './fly-worlds.ts';

const box = (x0: number, z0: number, x1: number, z1: number, height: number): BlockBox => ({ from: { x: x0, y: FEET, z: z0 }, to: { x: x1, y: FEET + height - 1, z: z1 }, solid: true });

/**
 * A yard 13 wide on the flat ground, 150 blocks north of the start: a house with a roof 8 high along its west side, one
 * 6 high along its east side with a part 11 high, a shed 5 high north of it and a tower 25 high 15 blocks out (the
 * descent circle fits at radius 10). The start: a 3 x 3 pillar 70 high.
 */
function yard() {
  const Z = 150;
  const boxes: BlockBox[] = [
    box(-1, -1, 1, 1, 70),
    box(-15, Z - 6, -7, Z + 5, 8),
    box(7, Z - 5, 13, Z + 5, 6),
    box(11, Z - 1, 12, Z, 11),
    box(-3, Z - 12, 2, Z - 8, 5),
    box(-15, Z - 4, -14, Z - 3, 25),
  ];
  const w = world(boxes);
  const view = new ColumnView(w.look, FEET);
  const cell = { x: 0, z: Z, feet: FEET, kind: 'open' as const };
  const target = walkTarget(cell, cellsAround(view, cell, 'open', 5, 4), { walkS: 10, walkKnown: true });
  return { w, Z, target, start: { x: 0.5, y: FEET + 70, z: 0.5 } };
}

describe('fly: the descent circle and what stands under it (flight v2, Track F11)', () => {
  it('the tops under a circle and inside it: the ring the body flies in, and the whole disc', () => {
    // a wall 5 high 10 out on one side, a post 9 high 3 out
    const top = (x: number, z: number): number => (x === 10 && Math.abs(z) <= 4 ? 4 : x === 3 && z === 0 ? 8 : -1);
    const fit = { centre: { x: 0.5, z: 0.5 }, radius: 10 };
    expect(spiralTops(fit, top)).toEqual({ ring: 5, top: 9 });
    expect(discTop(fit.centre, 2, top)).toBe(0);
    expect(discTop(fit.centre, 14, top, 6)).toBe(5);
    // unknown columns say nothing (spiralFit has refused a circle over them before this is asked)
    expect(spiralTops(fit, () => undefined)).toEqual({ ring: undefined, top: undefined });
  });

  it('the floor of a circle: nothing over 2 under it changes nothing; else 3 over the highest column, and round the target the way in more', () => {
    // open ground, and a fence on it: the circle's own rule alone
    expect(spiralFloor({ ring: 0, top: 0 }, 24, true, 0)).toBeUndefined();
    expect(spiralFloor({ ring: SPIRAL_CLEAR.rim, top: SPIRAL_CLEAR.rim }, 24, true, 0)).toBeUndefined();
    // a wall inside the circle but not under it (6 out of a circle of 24): as before as well
    expect(spiralFloor({ ring: 0, top: 10 }, 24, true, 0)).toBeUndefined();
    // roofs 8 over the floor under a circle of 10 round the target: 3 over them, the quarter turn and the glide in
    expect(spiralFloor({ ring: 8, top: 8 }, 10, true, 0)).toBeCloseTo(8 + 3 + 2.5 + 2.6, 6);
    // ... and over what stands inside it, when that is higher
    expect(spiralFloor({ ring: 8, top: 11 }, 10, true, 0)).toBeCloseTo(11 + 3 + 2.5 + 2.6, 6);
    // a circle beside the approach line: 3 over what stands under it, whatever its height
    expect(spiralFloor({ ring: 8, top: 30 }, 12, false, 0)).toBe(11);
    expect(spiralFloor({ ring: undefined, top: undefined }, 12, false, 0)).toBeUndefined();
    // the fit itself is what it was: only the columns lower than where the circle begins
    expect(spiralFit({ x: 0.5, z: 0.5 }, 20, () => 0)).toEqual({ centre: { x: 0.5, z: 0.5 }, radius: 24 });
  });

  it("a landing flown in over what stands round it: under the rim only within its cells' reach", () => {
    const cells = new Set<number>();
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) cells.add(columnKey(x, z));
    const t: LandingTarget = { x: 0.5, z: 0.5, top: 0, half: 3.3, cells, walk: true };
    // the nearest column that is no cell is 2.5 from the centre; the body is 0.3 wide each way
    expect(rimReach(t)).toBeCloseTo(2.2, 6);
    // the centre one block from a wall: the least reach
    const edge = new Set<number>([columnKey(0, 0), columnKey(-1, 0), columnKey(0, 1), columnKey(0, -1)]);
    expect(rimReach({ x: 0.5, z: 0.5, half: 1.5, cells: edge })).toBe(0.8);
    // an exact landing has no cells: its half width less the body's, at least the least reach
    expect(rimReach({ x: 0.5, z: 0.5, half: 1 })).toBe(0.8);
    expect(rimReach({ x: 0.5, z: 0.5, half: 3 })).toBeCloseTo(2.7, 6);
    const over: LandingTarget = { ...t, rim: 8, rimWithin: rimReach(t) };
    const check = touchdownCheck(over, undefined, false);
    const tick = (x: number, y: number) => check({ t: 1, pos: { x: x + 0.3, y: y + 0.2, z: 0.5 }, next: { x, y, z: 0.5 }, vel: { x: -0.3, y: -0.2, z: 0 }, yaw: 90, pitch: 0, boosting: false });
    // 6 out and under the rim plus RIM_OVER: a wall, whatever the cells say of the way
    expect(tick(6.5, 8 + RIM_OVER - 0.2)?.kind).toBe('wall');
    // 6 out and over it: flown
    expect(tick(6.5, 8 + RIM_OVER + 0.2)).toBeUndefined();
    // over its own cells: down
    expect(tick(1.5, 4)).toBeUndefined();
    // without a reach (a shaft's floor, a pit's: the cells decide) nothing is added
    expect(touchdownCheck({ ...t, rim: 8 }, undefined, false)({ t: 1, pos: { x: 6.8, y: 5.2, z: 0.5 }, next: { x: 6.5, y: 5, z: 0.5 }, vel: { x: -0.3, y: -0.2, z: 0 }, yaw: 90, pitch: 0, boosting: false })).toBeUndefined();
  });
});

describe('fly: whole trips onto a yard between roofs (flight v2, Track F11)', () => {
  it('from 70 over it: the circle is left over the roofs, the brake comes in over them and the elevator goes down: on the centre, no hit, nearly still', () => {
    const { w, target, start } = yard();
    const lines: string[] = [];
    for (const seed of [5, 6, 7]) {
      const r = trip(w, start, target, { seed });
      lines.push(`seed ${seed}: ${r.end.ok ? 'landed' : r.end.reason} ${r.end.off.toFixed(2)} off, ${r.ticks} ticks, ${r.rockets} rockets, ${r.goArounds} go-arounds, ${r.hits} hits, touchdown vy ${r.lastAir.vy.toFixed(2)} h ${r.lastAir.h.toFixed(2)}, ${r.stats.landStyle}; ${r.descents.join('; ')}`);
      expect(r.end.ok, lines.join('\n')).toBe(true);
      expect(r.end.off).toBeLessThan(0.5);
      expect(r.end.landedAt.y).toBeCloseTo(FEET, 3);
      expect(r.hits).toBe(0);
      expect(r.goArounds).toBe(0);
      expect(r.descents[0]).toMatch(/^spiral r10 at 0 out/);
      expect(r.stats.landStyle).toBe('brake');
      expect(-r.lastAir.vy).toBeLessThan(0.36);
      expect(r.lastAir.h).toBeLessThan(0.1);
      // the note says what the circle was left for
      expect(r.notes.some((n) => /descent circle r10 left \d+ over the landing's floor: what stands under it reaches 11 over that floor: in over that/.test(n)), r.notes.join(' | ')).toBe(true);
    }
    console.log(lines.join('\n'));
  }, 60_000);

  it('the descent as it was (LAND_SWITCH.clear off): the same trips end on the roofs round the yard, and the end says where and why', () => {
    const { w, target, start } = yard();
    LAND_SWITCH.clear = false;
    try {
      const lines: string[] = [];
      let off = 0;
      for (const seed of [5, 6, 7]) {
        const r = trip(w, start, target, { seed });
        const why = r.end.ok ? '' : (r.end.why ?? '');
        lines.push(`seed ${seed}: ${r.end.ok ? 'landed' : r.end.reason} ${r.end.off.toFixed(2)} off, ${(r.end.landedAt.y - FEET).toFixed(1)} over the floor; ${why}`);
        if (!r.end.ok && r.end.reason === 'landed_off' && r.end.landedAt.y > FEET + 3) {
          off++;
          expect(why).toMatch(/^the glide ended in the (descent circle \(r10 round the landing, flown down to 6 over the floor\)|approach)/);
          expect(why).toMatch(/from the landing's centre, \d+\.\d over its floor/);
        }
      }
      console.log(lines.join('\n'));
      expect(off, lines.join('\n')).toBeGreaterThanOrEqual(2);
    } finally {
      LAND_SWITCH.clear = true;
    }
  }, 60_000);

  it('the setting flyLandOver is on by default and listed with the flight settings; off, or with flyLandStyle flare, the circle is flown as it was', async () => {
    expect(SETTING_DEFS.flyLandOver.default).toBe(true);
    expect(SETTING_DEFS.flyLandOver.kind).toBe('boolean');
    expect(SETTING_GROUPS.find(([g]) => g === 'flight')?.[1]).toContain('flyLandOver');
    const { w, target, start } = yard();
    const cz = cruiseHeight(start, target, w.skyTop, {});
    const fly = async (o: { landOver?: boolean; landStyle?: 'auto' | 'flare' | 'brake' }) => {
      const notes: string[] = [];
      const r = await simulateFlight({ world: w.solid, groundAt: (x, z, fromY) => w.dryGround(x, z, fromY), skyTop: w.skyTop }, start, target, { cruiseY: cz.y, seed: 5, note: (m) => notes.push(m), ...o }, { rockets: 64, maxTicks: 4000 });
      return { r, left: notes.some((n) => n.startsWith('descent circle r10 left')) };
    };
    const on = await fly({});
    expect(on.left).toBe(true);
    expect(landedOn(target, on.r), JSON.stringify(on.r.end)).toBe(true);
    const off = await fly({ landOver: false });
    expect(off.left).toBe(false);
    expect(landedOn(target, off.r)).toBe(false);
    const flare = await fly({ landStyle: 'flare' });
    expect(flare.left).toBe(false);
  }, 60_000);

  it('flights the track does not touch are the same tick for tick: open ground, a platform in the air, a wall behind the cell', () => {
    const cases: { name: string; boxes: BlockBox[]; start: { x: number; y: number; z: number }; target: LandingTarget }[] = [
      { name: 'open ground from a pillar 70 high', boxes: [box(-1, -1, 1, 1, 70)], start: { x: 0.5, y: FEET + 70, z: 0.5 }, target: { x: 0.5, z: 150.5, top: FEET, half: 3, ground: FEET } },
      { name: 'a 3 x 3 platform 40 up, 300 out', boxes: [{ from: { x: -1, y: FEET + 39, z: 299 }, to: { x: 1, y: FEET + 39, z: 301 }, solid: true }], start: { x: 0.5, y: FEET, z: 0.5 }, target: { x: 0.5, z: 300.5, top: FEET + 40, half: 1 } },
      { name: 'a wall 10 high 6 behind the cell, from a pillar', boxes: [box(-1, -1, 1, 1, 70), box(-4, 156, 4, 156, 10)], start: { x: 0.5, y: FEET + 70, z: 0.5 }, target: { x: 0.5, z: 150.5, top: FEET, half: 1, ground: FEET - 24 } },
    ];
    for (const c of cases) {
      const fly = () => {
        const r = trip(world(c.boxes), c.start, c.target, { seed: 5 });
        return `${r.ticks} ${r.rockets} ${r.goArounds} ${r.end.landedAt.x.toFixed(5)} ${r.end.landedAt.y.toFixed(5)} ${r.end.landedAt.z.toFixed(5)} ${r.descents.join(';')}`;
      };
      const now = fly();
      LAND_SWITCH.clear = false;
      try {
        expect(fly(), c.name).toBe(now);
      } finally {
        LAND_SWITCH.clear = true;
      }
    }
  }, 60_000);
});

describe('fly: the nearest safe ground (flight v2, Track F11)', () => {
  it('what a body stands on as on a floor: not a fence, a wall or a gate (1.5 high), not a pane or a post', () => {
    const cube: Box[] = [[0, 0, 0, 1, 1, 1]];
    const slab: Box[] = [[0, 0, 0, 1, 0.5, 1]];
    const stairs: Box[] = [
      [0, 0, 0, 1, 0.5, 1],
      [0.5, 0.5, 0, 1, 1, 1],
    ];
    const fence: Box[] = [[0.375, 0, 0.375, 0.625, 1.5, 0.625]];
    const wall: Box[] = [[0.25, 0, 0.25, 0.75, 1.5, 0.75]];
    const pane: Box[] = [[0.4375, 0, 0, 0.5625, 1, 1]];
    const trapdoor: Box[] = [[0, 0, 0, 1, 0.1875, 1]];
    expect(standsOn(cube)).toBe('floor');
    expect(standsOn(slab)).toBe('floor');
    expect(standsOn(stairs)).toBe('floor');
    expect(standsOn(trapdoor)).toBe('floor');
    expect(standsOn(fence)).toBe('tall');
    expect(standsOn(wall)).toBe('tall');
    expect(standsOn(pane)).toBe('thin');
    expect(standsOn([])).toBe('none');
  });

  it('the landing search: a floor on a fence is a way for a walk and never a landing cell; the cells beside the fence stay what they were', () => {
    // flat ground at y -1, a fence patch 3 x 3 on it (a fence line alone is no level cell anyway: the patch is)
    const fence: Box[] = [[0.375, 0, 0.375, 0.625, 1.5, 0.625]];
    const cube: Box[] = [[0, 0, 0, 1, 1, 1]];
    const look = (boxes: boolean): BlockLookup => (x, y, z) => {
      if (y < 0) return { name: 'stone', solid: true, ...(boxes ? { boxes: cube } : {}) };
      if (y === 0 && Math.abs(x) <= 1 && Math.abs(z) <= 1) return { name: 'oak_fence', solid: true, ...(boxes ? { boxes: fence } : {}) };
      return { name: 'air', solid: false };
    };
    const shaped = new ColumnView(look(true), 0);
    const plain = new ColumnView(look(false), 0);
    const top = floorsOf(look(true), 0, 0, 40, -8)![0]!;
    expect(top).toMatchObject({ feet: 1, post: true });
    expect(shaped.sound(0, 0, top)).toBe(false);
    // without the boxes (the test worlds, the cache's stand-ins) nothing is known of the shape: as before
    expect(plain.sound(0, 0, plain.floorNear(0, 0, 1, 0)!)).toBe(true);
    // the ground beside the patch: a cell as before, with the boxes or without
    expect(shaped.sound(3, 0, shaped.floorNear(3, 0, 0, 0)!)).toBe(true);
    expect(shaped.sound(2, 0, shaped.floorNear(2, 0, 0, 0)!)).toBe(true);
    expect(shaped.floorNear(3, 0, 0, 0)!.post).toBeUndefined();
  });

  it('a perch: a roof, a wall top and a pillar with a floor in reach under them; not a hillside, flat ground, or a platform over the sea', () => {
    // a house 9 x 9 with a stepped roof 5 to 8 over the ground
    const roof = (x: number, z: number): number => (Math.abs(x) <= 4 && Math.abs(z) <= 4 ? 8 - Math.abs(x) + (Math.abs(x) === 4 ? 1 : 0) : 0);
    expect(perched(roof, 0, 0, 8)).toBe(true);
    expect(perched(roof, 4, 0, roof(4, 0))).toBe(true);
    expect(perched(roof, 9, 0, 0)).toBe(false);
    // a wall 2 wide and 6 high
    const wall = (x: number, _z: number): number => (x === 0 || x === 1 ? 6 : 0);
    expect(perched(wall, 0, 5, 6)).toBe(true);
    // a hillside: a block a step
    const hill = (x: number, _z: number): number => Math.max(0, Math.min(20, x));
    expect(perched(hill, 12, 0, 12)).toBe(false);
    // steps of 3: still walked down without a fall that hurts
    const terraces = (x: number, _z: number): number => 3 * Math.max(0, Math.min(4, Math.floor(x / 3)));
    expect(perched(terraces, 12, 0, 12)).toBe(false);
    // a cliff 12 high: its edge is a perch, 12 blocks back from it is not (no floor in reach)
    const cliff = (x: number, _z: number): number => (x >= 0 ? 12 : 0);
    expect(perched(cliff, 2, 0, 12)).toBe(true);
    expect(perched(cliff, 12, 0, 12)).toBe(false);
    // a platform 30 over the sea: the sea floor is no floor
    const platform = (x: number, z: number): number => (Math.abs(x) <= 4 && Math.abs(z) <= 3 ? 30 : -5);
    expect(perched(platform, 0, 0, 30, (x, z) => Math.abs(x) <= 4 && Math.abs(z) <= 3)).toBe(false);
    expect(perched(platform, 0, 0, 30)).toBe(true);
    // unknown columns are neither floor nor way
    expect(perched((x, z) => (Math.abs(x) <= 2 && Math.abs(z) <= 2 ? 9 : undefined), 0, 0, 9)).toBe(false);
  });
});
