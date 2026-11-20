/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Track F20 (docs/flight.md "A flight never outlasts its elytra (Track F20)"; decisions/0107). The Realm's fall of
// 2026-11-18 first, offline, as it was: an elytra with 58 uses, a goal 141 km away, the fixed worn limit and the forced
// landing's circle; then the three rules that end it (the takeoff asks, the way down is covered, the cruise's cap), the
// second Realm case (a trip that needs what is left, a hold over a goal whose ground loads late), the server's word on
// the wear (player_armor_damage), and that a flight whose elytra is nowhere near its limit is tick for tick what it was.
import { describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { CRUISE_OVER, KIT_USE_OVER } from '../../../src/skills/fly/brain.ts';
import { FlightController, type FlightLoop, type FlightReport } from '../../../src/skills/fly/controller.ts';
import type { InputLoopEvent, InputLoopState } from '../../../src/skills/input/inputLoop.ts';
import { simulateFlight, type SimResult } from '../../../src/skills/fly/glide.ts';
import { elytraWornLimit, readKit } from '../../../src/skills/fly/kit.ts';
import { APPROACH_DISTANCE, cruiseHeight, flightSeconds, hdist, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { ARRIVE_TOP_UP, arrivalOver, cruiseKeep, cruiseOver, descentUses, HOLD_AT, diveTicks, isTripCoverLine, tripCover, tripCoverLine, tripReach, tripUses, useShare, UsesCount, WEAR, wornLimitAt } from '../../../src/skills/fly/wear.ts';
import { ENCH_UNBREAKING, unbreakingLevel } from '../../../src/skills/survival/tools.ts';
import { flatWorld, withBoxes, type BlockQuery } from '../../../src/skills/input/index.ts';
import { planKit } from '../../../src/skills/test/kit.ts';
import { FlyProcess, plannedArrival, plannedCruise, RETARGET_WITHIN, type FlyDeps, type FlyTarget } from '../../../src/tasks/process/fly.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import { armourIndex, Inventory } from '../../../src/world/inventory.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const FEET = -60;
const LIMIT = elytraWornLimit(10); // 30: the tool wear limit and the landing's reserve

/** The simulator's world: flat ground (feet -60), with boxes of solids on it. */
function sim(boxes: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; solid: boolean }[] = []) {
  const world: BlockQuery = boxes.length ? withBoxes(flatWorld(), boxes) : flatWorld();
  const top = (x: number, z: number): number => {
    if (!boxes.length) return FEET - 1;
    for (let y = 330; y >= FEET; y--) if (world.solidAt(x, y, z)) return y;
    return FEET - 1;
  };
  return { world, skyTop: top, groundAt: (x: number, z: number) => top(x, z) + 1, terrain: (x: number, z: number) => ({ top: top(x, z), src: 'live' as const }) };
}

/** A crafted rocket's burn (19 to 31 ticks), drawn by a seeded generator. */
function burns(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return 19 + (s % 13);
  };
}

/** The owner's command of 2026-11-18: from the ground to a goal 141 km away, 435 over the start; the cruise is the goal's entry and 2. */
const FAR: LandingTarget = { x: 100000.5, z: 100000.5, top: FEET + 435, half: 1, hold: true };
const FAR_CRUISE = FAR.top + 12;
function farFlight(o: { wornCover?: boolean; cruiseCap?: boolean }, left: number, seed = 1, maxTicks = 4000): Promise<SimResult> {
  const b = burns(seed);
  return simulateFlight(sim(), { x: 0.5, y: FEET, z: 0.5 }, FAR, { cruiseY: FAR_CRUISE, highCruise: true, elytraWornAt: LIMIT, ...o }, { rockets: 62, maxTicks, endLag: 2, burn: () => b(), elytra: { left } });
}

describe('the Realm\'s fall of 2026-11-18, offline (the reproduction: the rules off)', () => {
  it('58 uses, a goal 141 km away at the high cruise: the cruise climbs 150 over its height, the worn landing begins at 30 uses and circles, the glide is lost some 480 over the ground and the body falls at a deadly speed', async () => {
    for (const seed of [1, 2, 3]) {
      const r = await farFlight({ wornCover: false, cruiseCap: false }, 58, seed);
      expect(r.glideLost).toBeDefined();
      expect(r.glideLost!.phase).toBe('land');
      expect(r.glideLost!.y - FEET).toBeGreaterThan(400);
      // (a fall's end at 3.8 a tick is a fall of hundreds of blocks: 23 blocks kill)
      expect(r.glideLost!.fallVy ?? 0).toBeLessThan(-3);
      expect(r.usesLeft).toBe(1);
      expect(r.stats.maxY).toBeGreaterThan(FAR_CRUISE + 120);
      expect(r.stats.rocketsBy.cruise).toBeGreaterThanOrEqual(5);
      expect(r.stats.descents.some((d) => d.startsWith('spiral'))).toBe(true);
    }
  });

  it('the forced landing\'s circle from the fixed limit: a body that begins it 150 or more over the ground loses the glide in the air (from 120: 6 over the ground)', async () => {
    for (const up of [150, 250, 400, 600]) {
      const r = await simulateFlight(sim(), { x: 0.5, y: FEET + up, z: 0.5 }, { x: 0.5, z: 30000.5, top: FEET, half: 1, hold: true }, { cruiseY: FEET + up, elytraWornAt: LIMIT, wornCover: false }, { rockets: 20, maxTicks: 6000, airborne: { x: 0, y: -0.15, z: 1.5 }, yaw: 0, elytra: { left: LIMIT } });
      expect(r.glideLost, `from ${up}`).toBeDefined();
      expect(r.glideLost!.y - FEET).toBeGreaterThan(up - 120);
    }
  });
});

describe('the way down is always covered (brain.ts wornAt, the worn dive)', () => {
  it('the same flight, the rules on: the worn landing begins while the uses cover the way down, dives, pulls out over the ground and stands with the tool wear limit\'s uses and more', async () => {
    for (const seed of [1, 2, 3]) {
      const r = await farFlight({}, 58, seed);
      expect(r.glideLost).toBeUndefined();
      expect(r.end && !r.end.ok && r.end.reason).toBe('elytra_worn');
      expect(r.end!.landedAt.y).toBeCloseTo(FEET, 0);
      expect(r.usesLeft).toBeGreaterThanOrEqual(15);
      const w = r.stats.worn!;
      expect(w.dive).toBeDefined();
      // (it began before the fixed limit: the height's part of the limit, or a rocket held back)
      expect(w.left).toBeGreaterThan(LIMIT);
      // (out of the pull over the ground, slow: the landing takes it from there)
      expect(w.dive!.out! - FEET).toBeGreaterThan(12);
      expect(w.dive!.out! - FEET).toBeLessThan(WEAR.pullOver);
      // (the dive's blocks a use: over 30 from this height, where the circle's are 3.8)
      expect(((w.dive!.from - w.dive!.out!) / w.dive!.ticks!) * WEAR.useTicks).toBeGreaterThan(30);
      expect(Math.abs(r.body.vel.y)).toBeLessThan(0.5);
    }
  });

  it('over a grid of heights (70 to 1000 over the ground) and uses (the limit for the height, and 2 under it: a count that is late): every worn landing stands with 10 uses or more, none loses the glide', async () => {
    for (const up of [70, 100, 150, 250, 400, 600, 800, 1000]) {
      const limit = wornLimitAt(LIMIT, up);
      for (const left of [limit, limit - 2]) {
        const r = await simulateFlight(sim(), { x: 0.5, y: FEET + up, z: 0.5 }, { x: 0.5, z: 30000.5, top: FEET, half: 1, hold: true }, { cruiseY: FEET + up, elytraWornAt: LIMIT }, { rockets: 20, maxTicks: 6000, airborne: { x: 0, y: -0.15, z: 1.5 }, yaw: 0, elytra: { left } });
        expect(r.glideLost, `from ${up} with ${left}`).toBeUndefined();
        expect(r.end && !r.end.ok && r.end.reason, `from ${up} with ${left}`).toBe('elytra_worn');
        expect(r.usesLeft, `from ${up} with ${left}`).toBeGreaterThanOrEqual(10);
        expect(r.stats.worn?.dive, `from ${up} with ${left}`).toBeDefined();
        expect(r.hits).toBe(0);
      }
    }
  });

  it('low over the ground (10 to 60) the forced landing is flown as before, begun early enough for its circle', async () => {
    for (const up of [10, 30, 50, 60]) {
      const left = wornLimitAt(LIMIT, up);
      const r = await simulateFlight(sim(), { x: 0.5, y: FEET + up, z: 0.5 }, { x: 0.5, z: 30000.5, top: FEET, half: 1, hold: true }, { cruiseY: FEET + up, elytraWornAt: LIMIT }, { rockets: 0, maxTicks: 6000, airborne: { x: 0, y: -0.15, z: 1.5 }, yaw: 0, elytra: { left } });
      expect(r.glideLost, `from ${up}`).toBeUndefined();
      expect(r.usesLeft, `from ${up}`).toBeGreaterThanOrEqual(10);
      expect(r.stats.worn?.dive, `from ${up}`).toBeUndefined();
    }
  });

  it('the server\'s word never comes (the count the brain is told stays what it was at the takeoff): the brain\'s own count lands it all the same', async () => {
    const b = burns(4);
    const r = await simulateFlight(sim(), { x: 0.5, y: FEET, z: 0.5 }, FAR, { cruiseY: FAR_CRUISE, highCruise: true, elytraWornAt: LIMIT }, { rockets: 62, maxTicks: 4000, endLag: 2, burn: () => b(), elytra: { left: 58, said: () => 58 } });
    expect(r.glideLost).toBeUndefined();
    expect(r.end && !r.end.ok && r.end.reason).toBe('elytra_worn');
    expect(r.usesLeft).toBeGreaterThanOrEqual(10);
    expect(r.stats.worn!.said).toBe(58);
    expect(r.stats.worn!.left).toBeLessThan(50);
    // before the track the same stale count flew the elytra to its end without a landing at all
    const old = await simulateFlight(sim(), { x: 0.5, y: FEET, z: 0.5 }, FAR, { cruiseY: FAR_CRUISE, highCruise: true, elytraWornAt: LIMIT, wornCover: false, cruiseCap: false }, { rockets: 62, maxTicks: 4000, endLag: 2, burn: () => burns(4)(), elytra: { left: 58, said: () => 58 } });
    expect(old.glideLost).toBeDefined();
    expect(old.glideLost!.phase).not.toBe('land');
  });

  it('the second Realm case (2026-11-20): a hold over a goal under a hill, the uses running out in it: before, the landing begins at 30 and the glide is lost in the air; now it leaves the hold in time and stands', async () => {
    // a hill 150 high 20 blocks beside the goal: the hold is flown over it (7 over the highest column within 30), 157 over the ground
    const hill = [{ from: { x: 14, y: FEET, z: 596 }, to: { x: 26, y: FEET + 149, z: 606 }, solid: true }];
    const goal: LandingTarget = { x: 0.5, z: 600.5, top: FEET, half: 1, hold: true };
    const fly = (o: { wornCover?: boolean }, said?: (left: number) => number) => {
      const w = sim(hill);
      const cz = cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, goal, w.skyTop, {});
      return simulateFlight(w, { x: 0.5, y: FEET, z: 0.5 }, goal, { cruiseY: cz.y, elytraWornAt: LIMIT, ...o }, { rockets: 40, maxTicks: 6000, endLag: 2, elytra: { left: 75, ...(said ? { said } : {}) } });
    };
    const before = await fly({ wornCover: false });
    expect(before.stats.holdTicks).toBeGreaterThan(100);
    expect(before.glideLost).toBeDefined();
    expect(before.glideLost!.y - FEET).toBeGreaterThan(20);
    const now = await fly({});
    expect(now.stats.holdTicks).toBeGreaterThan(20);
    expect(now.glideLost).toBeUndefined();
    expect(now.end && !now.end.ok && now.end.reason).toBe('elytra_worn');
    expect(now.usesLeft).toBeGreaterThanOrEqual(10);
    expect(now.hits).toBe(0);
    // and with the count 8 behind the server's, as the Realm's was that day
    const late = await fly({}, (left) => left + 8);
    expect(late.glideLost).toBeUndefined();
    expect(late.usesLeft).toBeGreaterThanOrEqual(5);
  });

  it('a landing forced for another reason (`!land`) 400 over the ground with 45 uses: before, its circle outlasts the elytra; now it goes on by the dive once the uses no longer cover the circle, and its reason stays its own', async () => {
    const fly = (o: { wornCover?: boolean }) => {
      let asked = false;
      return simulateFlight(sim(), { x: 0.5, y: FEET + 400, z: 0.5 }, { x: 0.5, z: 30000.5, top: FEET, half: 1, hold: true }, { cruiseY: FEET + 400, elytraWornAt: LIMIT, ...o }, {
        rockets: 0,
        maxTicks: 6000,
        airborne: { x: 0, y: -0.15, z: 1.5 },
        yaw: 0,
        elytra: { left: 45 },
        until: (brain, body) => {
          if (!asked && brain.stats.ticks >= 5) {
            asked = true;
            brain.landNow('stopped', { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: 0 });
          }
          return false;
        },
      });
    };
    const before = await fly({ wornCover: false });
    expect(before.glideLost).toBeDefined();
    expect(before.glideLost!.y - FEET).toBeGreaterThan(150);
    const now = await fly({});
    expect(now.glideLost).toBeUndefined();
    expect(now.end && !now.end.ok && now.end.reason).toBe('stopped');
    expect(now.stats.worn?.dive).toBeDefined();
    expect(now.usesLeft).toBeGreaterThanOrEqual(10);
  });

  it('wornLimitAt: the fixed limit near the ground, more with the height, never under it; the dive keeps the way down from 1000 blocks under 25 uses over it', () => {
    expect(wornLimitAt(30, 0)).toBe(30);
    expect(wornLimitAt(30, 20)).toBeLessThanOrEqual(33);
    for (const base of [30, 44]) {
      let last = 0;
      for (const up of [70, 100, 150, 250, 400, 600, 800, 1000, 2000]) {
        const l = wornLimitAt(base, up);
        expect(l).toBeGreaterThanOrEqual(base);
        expect(l).toBeGreaterThanOrEqual(last);
        last = l;
      }
      expect(wornLimitAt(base, 1000)).toBeLessThanOrEqual(base + 25);
    }
    // rough ground under the body (the highest column 60 over the lowest): the landing after the pull has that much more to come down
    expect(wornLimitAt(30, 300, undefined, 60)).toBeGreaterThan(wornLimitAt(30, 300) + 10);
    // the dive's ticks on the formula: 84 ticks for the first 147 blocks, then 2.78 a tick
    expect(diveTicks(147)).toBeGreaterThan(70);
    expect(diveTicks(147)).toBeLessThan(95);
    expect(diveTicks(700) - diveTicks(422)).toBeCloseTo(100, -1);
    expect(descentUses(600)).toBeLessThan(descentUses(60) + 10);
  });

  it('UsesCount: the server\'s word, less a use for every 20 gliding ticks since it last changed', () => {
    const u = new UsesCount();
    expect(u.step(undefined, true)).toBeUndefined();
    expect(u.step(100, true)).toBe(100);
    for (let t = 0; t < 19; t++) expect(u.step(100, true)).toBe(100);
    expect(u.step(100, true)).toBe(99);
    for (let t = 0; t < 40; t++) u.step(100, true);
    expect(u.step(100, true)).toBe(97);
    // not while the body stands
    for (let t = 0; t < 60; t++) u.step(100, false);
    expect(u.step(100, false)).toBe(97);
    // the server says: the count is the server's again
    expect(u.step(97, true)).toBe(97);
    for (let t = 0; t < 20; t++) u.step(97, true);
    expect(u.step(97, true)).toBe(96);
  });
});

describe('the cruise\'s cap (brain.ts CRUISE_OVER)', () => {
  it('a fresh elytra and the far goal: without the cap the economy buys a rocket every time a burn ends (the glide line of a goal 141 km away is 14 000 blocks up); with it the cruise stays under its height and 64', async () => {
    const free = await farFlight({ wornCover: false, cruiseCap: false }, 400, 1, 1500);
    const capped = await farFlight({ wornCover: false }, 400, 1, 1500);
    expect(free.stats.maxY).toBeGreaterThan(FAR_CRUISE + 400);
    // (a capped burn's look goes level, never down: the rise it still has carries the body up to 7 blocks past the cap)
    expect(capped.stats.maxY).toBeLessThanOrEqual(FAR_CRUISE + CRUISE_OVER + 8);
    expect(capped.stats.maxY).toBeGreaterThan(FAR_CRUISE);
    // (and it costs no ground: the body is as far along)
    expect(capped.body.pos.z).toBeGreaterThan(free.body.pos.z * 0.95);
    expect(capped.stats.rockets).toBeLessThan(free.stats.rockets);
  });
});

describe('a flight whose elytra is nowhere near its limit is what it was', () => {
  for (const [dist, up] of [
    [300, 0],
    [650, 0],
    [1200, 0],
    [2300, 0],
    [400, 40],
  ] as const) {
    it(`${dist} blocks${up ? `, the goal ${up} up` : ''}: the same ticks, rockets, top and touchdown with the rules on and off`, async () => {
      const target: LandingTarget = { x: 0.5, z: dist + 0.5, top: FEET + up, half: 2 };
      const boxes = up ? [{ from: { x: -2, y: FEET + up - 1, z: dist - 2 }, to: { x: 2, y: FEET + up - 1, z: dist + 2 }, solid: true }] : [];
      const run = (o: { wornCover?: boolean; cruiseCap?: boolean }) => {
        const w = sim(boxes);
        const cz = cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, target, w.skyTop, {});
        const b = burns(7);
        return simulateFlight(w, { x: 0.5, y: FEET, z: 0.5 }, target, { cruiseY: cz.y, elytraWornAt: LIMIT, seed: 5, ...o }, { rockets: 64, maxTicks: 6000, endLag: 2, burn: () => b(), elytra: { left: 432 } });
      };
      const off = await run({ wornCover: false, cruiseCap: false });
      const on = await run({});
      expect(on.end?.ok).toBe(true);
      expect(on.ticks).toBe(off.ticks);
      expect(on.stats.rockets).toBe(off.stats.rockets);
      expect(on.stats.maxY).toBe(off.stats.maxY);
      expect(on.end!.landedAt).toEqual(off.end!.landedAt);
      expect(on.usesLeft).toBe(off.usesLeft);
    });
  }
});

describe('the takeoff asks (wear.ts tripCover)', () => {
  it('the trip\'s uses: its seconds with the slack, a go-around, a hold where the ground is not loaded, a high climb, at 1.2 a second, and 4', () => {
    // 150 blocks: 14 s x 1.15 + 6 = 22.1 s -> 27 + 4
    expect(tripUses(150)).toBe(31);
    // the Realm's 2 252-block trip (it took 102 s and 119 uses on 2026-11-18): 91 s x 1.15 + 6 + 8 = 119 s -> 143 + 4
    expect(tripUses(2252, { hold: true })).toBe(147);
    expect(tripUses(2252, { hold: true })).toBeGreaterThan(119);
    expect(tripUses(1500, { hold: true })).toBeGreaterThan(tripUses(1500));
    expect(tripUses(400, { climb: 572 })).toBeGreaterThan(tripUses(400) + 25);
    expect(tripUses(400, { climb: 100 })).toBe(tripUses(400));
  });

  it('the owner\'s trips of 2026-11-18: the four that were flown are covered, the fifth (58 uses, 141 km) is not, and no elytra covers it', () => {
    expect(tripCover(323, 30, 2252, { hold: true }).ok).toBe(true);
    expect(tripCover(204, 30, 2285, { hold: true }).ok).toBe(true);
    expect(tripCover(90, 30, 168).ok).toBe(true);
    expect(tripCover(75, 30, 144).ok).toBe(true);
    const far = tripCover(58, 30, 141358, { hold: true });
    expect(far.ok).toBe(false);
    expect(far.never).toBe(true);
    expect(far.need).toBeGreaterThan(5000);
    const line = tripCoverLine(far, 141358);
    expect(line).toMatch(/^the elytra has 58 uses left \(30 kept for the landing\) and the trip of 141358 blocks needs about \d+, more than a new elytra has \(432; one flies about \d+ blocks\): not flying$/);
    expect(isTripCoverLine(`fly: ${line}`)).toBe(true);
    expect(isTripCoverLine('fly: no open sky here')).toBe(false);
    // a new elytra flies some 7 000 blocks to a held goal, and a trip that long is covered by it
    expect(tripReach(432 - 30)).toBeGreaterThan(6000);
    expect(tripCover(432, 30, tripReach(432 - 30) - 30, { hold: true }).ok).toBe(true);
    expect(tripCover(432, 30, tripReach(432 - 30) + 60, { hold: true }).ok).toBe(false);
  });

  it('the Realm\'s trip of 2026-11-20: 100 uses for 2 252 blocks (it needed about 110 and held over the goal): refused, with the numbers; a Mending elytra keeps its mending reserve', () => {
    const c = tripCover(100, 30, 2252, { hold: true });
    expect(c.ok).toBe(false);
    expect(c.never).toBe(false);
    expect(tripCoverLine(c, 2252)).toBe('the elytra has 100 uses left (30 kept for the landing) and the trip of 2252 blocks needs about 147: not flying');
    expect(tripCover(177, 30, 2252, { hold: true }).ok).toBe(true);
    expect(tripCover(176, 30, 2252, { hold: true }).ok).toBe(false);
    expect(tripCover(190, elytraWornLimit(10, { elytraMending: true }), 2252, { hold: true }).ok).toBe(false);
    // an unknown count flies as before
    expect(tripCover(undefined, 30, 99999).ok).toBe(true);
  });

  /** A FlyProcess on fakes: an elytra with `left` uses in slot 9 (worn once `wear` ran: the server then says `leftWorn`). */
  function rig(left: number, target: FlyTarget, leftWorn = left) {
    const el = (l: number): ItemStack => ({ name: 'elytra', count: 1, networkId: 1, metadata: 0, damage: 432 - l });
    const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
    slots[0] = { name: 'firework_rocket', count: 64, networkId: 2, metadata: 0 };
    slots[9] = el(left);
    let worn: ItemStack | null = null;
    const calls: string[] = [];
    const deps: FlyDeps = {
      controller: { active: false, flyTo: () => (calls.push('flyTo'), new Promise(() => undefined)), status: () => ({ active: false }) } as unknown as FlightController,
      kitOps: {
        refillFromBox: async () => ({ ok: true, taken: 0, pickedUp: true }),
        rocketsToHotbar: async () => ({ ok: true }),
        wearElytra: async () => {
          calls.push('wear');
          slots[9] = null;
          worn = el(leftWorn);
          return { ok: true };
        },
        wearChestplate: async () => (calls.push('chestplate'), { ok: true }),
      } as unknown as FlyDeps['kitOps'],
      inventory: { slots, window: (id: number) => (id === 120 ? { slots: [null, worn, null, null] } : undefined) },
      memory: () => ({}),
      settings: new RuntimeSettings(),
      position: () => ({ x: 0.5, y: FEET, z: 0.5 }),
      skyTop: () => FEET - 1,
      cell: () => false,
      say: () => undefined,
      waitTicks: async () => undefined,
    };
    const p = new FlyProcess(target, deps);
    const pm = new ProcessManager();
    pm.add(p);
    pm.tick();
    return { p, calls };
  }

  it('FlyProcess.prepare: a trip the elytra does not cover ends with the line before anything is moved; one it covers goes on to the takeoff', async () => {
    const far = rig(58, { x: 0.5, z: 99000.5, top: FEET + 435, half: 1, label: 'the far goal', hold: true });
    const r = await far.p.result;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^fly: the elytra has 58 uses left \(30 kept for the landing\) and the trip of 99000 blocks needs about \d+, more than a new elytra has/);
    expect(far.calls).toEqual([]);
    const near = rig(70, { x: 0.5, z: 150.5, top: FEET, half: 1, label: 'the near goal' });
    await new Promise((res) => setTimeout(res, 20));
    expect(near.calls).toEqual(['wear', 'flyTo']);
  });

  it('FlyProcess.prepare: the count with the elytra on the back is the one that decides (the model\'s was 28 too high on the Realm): refused then, and the chestplate goes back on', async () => {
    const t = rig(232, { x: 0.5, z: 2252.5, top: FEET, half: 1, label: 'the goal', hold: true }, 170);
    const r = await t.p.result;
    expect(r.ok).toBe(false);
    // (Track F21: the need with the cruise known: the hold's spiral down from the cruise and the flight's worn limit there)
    expect(r.reason).toBe(`fly: the elytra has 170 uses left (30 kept for the landing) and the trip of 2252 blocks needs about ${secondNeed(2252, true)}: not flying`);
    expect(t.calls).toEqual(['wear', 'chestplate']);
  });
});

describe('the server\'s word on the wear (world/inventory.ts handleArmorDamage)', () => {
  const toItem = (i: ItemV4): ItemStack | null => (i.network_id === 0 ? null : { name: ['', 'iron_helmet', 'elytra', 'iron_leggings', 'iron_boots'][i.network_id] ?? 'stone', count: i.count, networkId: i.network_id, metadata: 0, damage: (i as unknown as { d?: number }).d ?? 0 });
  const raw = (id: number, d: number): ItemV4 => ({ network_id: id, count: 1, metadata: 0, has_stack_id: true, stack_id: 100 + id, block_runtime_id: 0, d }) as unknown as ItemV4;

  it('armourIndex: the slot is half the byte the entry carries (BDS 1.26.60.6: helmet 0, chest 2, legs 4, feet 6, as minecraft-data names or leaves them)', () => {
    expect(armourIndex('helmet')).toBe(0);
    expect(armourIndex('leggings')).toBe(1);
    expect(armourIndex('body')).toBe(2);
    expect(armourIndex(6)).toBe(3);
    expect(armourIndex('chestplate')).toBeUndefined();
    expect(armourIndex('boots')).toBeUndefined();
    expect(armourIndex(8)).toBeUndefined();
    expect(armourIndex('nonsense')).toBeUndefined();
  });

  it('an entry sets the worn piece\'s damage to the value it names (not a difference), keeps the piece and tells the listeners', () => {
    const inv = new Inventory(toItem, () => 1n);
    inv.handleInventoryContent({ window_id: 'armor', input: [raw(1, 10), raw(2, 100), raw(3, 30), raw(4, 40)] });
    const seen: string[] = [];
    inv.onChange((w, s) => seen.push(`${w}:${s}`));
    // the elytra after a second of gliding, as the server sent it on bds-fly
    inv.handleArmorDamage({ entries: [{ armor_slot: 'leggings', damage: 101 }] });
    expect(inv.window(120)!.slots.map((s) => s?.damage)).toEqual([10, 101, 30, 40]);
    expect(inv.window(120)!.slots[1]!.name).toBe('elytra');
    expect(seen).toEqual(['120:1']);
    // a hit on four pieces
    inv.handleArmorDamage({ entries: [{ armor_slot: 'helmet', damage: 11 }, { armor_slot: 'leggings', damage: 102 }, { armor_slot: 'body', damage: 31 }, { armor_slot: 6, damage: 41 }] });
    expect(inv.window(120)!.slots.map((s) => s?.damage)).toEqual([11, 102, 31, 41]);
    // the same value again, an empty slot, a byte that is no slot, a bad value: nothing
    const n = seen.length;
    inv.handleArmorDamage({ entries: [{ armor_slot: 'leggings', damage: 102 }, { armor_slot: 'boots', damage: 7 }, { armor_slot: 'helmet', damage: -1 }] });
    inv.handleArmorDamage({});
    expect(seen.length).toBe(n);
    expect(inv.window(120)!.slots.map((s) => s?.damage)).toEqual([11, 102, 31, 41]);
    // no armour window yet: nothing to set, no throw
    new Inventory(toItem, () => 1n).handleArmorDamage({ entries: [{ armor_slot: 'leggings', damage: 5 }] });
  });
});

describe('the glide lost in the air on an elytra at its last use (controller.ts)', () => {
  /** A FlightLoop stand-in: the local model takes the glide when asked; `end()` is the server ending it (its flag off). */
  function fakeLoop() {
    const state = { pos: { x: 0.5, y: 60, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: true, collidedHorizontally: false, collidedVertically: false, corrections: 0, motions: 0, sprinting: false, inWater: false, inLava: false, gliding: false, boostTicks: 0, teleports: 0 } as unknown as InputLoopState;
    const steps = new Set<(t: bigint, s: InputLoopState) => void>();
    const events = new Set<(e: InputLoopEvent) => void>();
    const cmd = { yaw: 0, pitch: 0, jump: false, glide: false };
    let t = 0n;
    let refuse = false;
    const loop: FlightLoop = {
      state,
      world: { solidAt: (_x, y) => y < 60 },
      command: cmd,
      setCommand: (c) => Object.assign(cmd, c),
      onBeforeStep: (fn) => (steps.add(fn), () => steps.delete(fn)),
      onEvent: (fn) => (events.add(fn), () => events.delete(fn)),
      boost: () => undefined,
      endBoost: () => undefined,
      waitTicks: () => Promise.resolve(),
    };
    const tick = (): void => {
      t++;
      for (const fn of [...steps]) fn(t, state);
      if (cmd.jump && state.onGround) {
        state.onGround = false;
        state.vel = { x: 0, y: 0.42, z: 0 };
      } else if (!state.onGround) {
        state.vel = { x: 0, y: state.gliding ? 0.5 : state.vel.y - 0.08, z: 0 };
        if (cmd.glide && state.vel.y < 0.3 && !state.gliding && !refuse) {
          state.gliding = true;
          for (const fn of [...events]) fn({ kind: 'glide', gliding: true, tick: t, replayed: 0 });
        }
      }
      state.pos = { x: state.pos.x, y: state.pos.y + state.vel.y, z: state.pos.z };
    };
    const end = (): void => {
      refuse = true;
      state.gliding = false;
      for (const fn of [...events]) fn({ kind: 'glide', gliding: false, tick: t, replayed: 0 });
    };
    return { loop, tick, end, cmd, state };
  }
  const fly = (leftAtTheEnd: number) => {
    const f = fakeLoop();
    let left = 60;
    const warns: string[] = [];
    const log = { debug: () => undefined, info: () => undefined, warn: (m: string) => void warns.push(m), error: () => undefined };
    const c = new FlightController({
      loop: f.loop,
      queue: () => undefined,
      inventory: { slots: [{ name: 'firework_rocket', count: 64, networkId: 1000 }, ...Array.from({ length: 35 }, () => null)], selected: 0, rawItem: () => undefined } as never,
      hotbar: { select: () => true, rawItem: () => undefined },
      entities: { onAdd: () => () => undefined, onRemove: () => () => undefined },
      health: () => 20,
      elytraLeft: () => left,
      log: log,
    });
    let report: FlightReport | undefined;
    void c.flyTo({ x: 3000.5, z: 0.5, top: 60, half: 1 }, { cruiseY: 400, vertical: { top: 30 } }).then((r) => (report = r));
    for (let i = 0; i < 40; i++) f.tick();
    expect(f.state.gliding).toBe(true);
    left = leftAtTheEnd;
    f.end();
    for (let i = 0; i < 5; i++) f.tick();
    return { c, f, warns, report: () => report };
  };

  it('the server ends the glide in the air and the elytra is at one use: the flight is over (`glide_lost`) and nothing asks for the glide any more, so the fall guard can arm', async () => {
    const r = fly(1);
    await Promise.resolve();
    expect(r.c.active).toBe(false);
    expect(r.report()?.reason).toBe('glide_lost');
    expect(r.f.cmd.glide).toBe(false);
    expect(r.warns.some((w) => w.includes('the glide is lost in the air'))).toBe(true);
  });

  it('a glide ended in the air on an elytra with uses left (a contact, a server that took it back): the flight goes on asking, as before', async () => {
    const r = fly(50);
    await Promise.resolve();
    expect(r.c.active).toBe(true);
    expect(r.f.cmd.glide).toBe(true);
    expect(r.report()).toBeUndefined();
    r.c.dispose();
  });
});

/** Track F21: the need the flight's preparation asks on the rigs' flat ground (the cruise it plans from the start at FEET to a goal at FEET dist blocks north). */
function secondNeed(dist: number, hold: boolean, unbreaking = 0): number {
  const from = { x: 0.5, y: FEET, z: 0.5 };
  const target: LandingTarget = { x: 0.5, z: dist + 0.5, top: FEET, half: 1, ...(hold ? { hold: true } : {}) };
  const s = new RuntimeSettings();
  const { cruiseY } = plannedCruise(from, target, () => FEET - 1, s);
  return tripUses(dist, { hold, climb: cruiseY - FEET, over: cruiseOver(cruiseY, FEET, FEET), arrive: plannedArrival(from, target, cruiseY, () => FEET - 1, s) }, unbreaking);
}

/** Track F21: a FlyProcess on fakes (as the `rig` of "the takeoff asks"): the elytra in slot 9 (`ench` its enchantments); worn once `wear` ran (the server then says `leftWorn`); `spare`: the K4 hook's answer to the ask with the climb known (it puts an elytra with that many uses on the back). */
function rigSecond(left: number, target: FlyTarget, o: { leftWorn?: number; ench?: { id: number; lvl: number }[]; spare?: number; tail?: string } = {}) {
  const el = (l: number, ench?: { id: number; lvl: number }[]): ItemStack => ({ name: 'elytra', count: 1, networkId: 1, metadata: 0, damage: 432 - l, ...(ench ? { enchants: ench } : {}) });
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  slots[0] = { name: 'firework_rocket', count: 64, networkId: 2, metadata: 0 };
  slots[9] = el(left, o.ench);
  let worn: ItemStack | null = null;
  const calls: string[] = [];
  const deps: FlyDeps = {
    controller: { active: false, flyTo: () => (calls.push('flyTo'), new Promise(() => undefined)), status: () => ({ active: false }) } as unknown as FlightController,
    kitOps: {
      refillFromBox: async () => ({ ok: true, taken: 0, pickedUp: true }),
      rocketsToHotbar: async () => ({ ok: true }),
      wearElytra: async () => {
        calls.push('wear');
        slots[9] = null;
        worn = el(o.leftWorn ?? left, o.ench);
        return { ok: true };
      },
      wearChestplate: async () => (calls.push('chestplate'), { ok: true }),
    } as unknown as FlyDeps['kitOps'],
    inventory: { slots, window: (id: number) => (id === 120 ? { slots: [null, worn, null, null] } : undefined) },
    memory: () => ({}),
    settings: new RuntimeSettings(),
    position: () => ({ x: 0.5, y: FEET, z: 0.5 }),
    skyTop: () => FEET - 1,
    cell: () => false,
    say: () => undefined,
    waitTicks: async () => undefined,
    elytra: async (_distance, _hold, climb) => {
      calls.push(climb === undefined ? 'ask' : 'ask with the climb');
      if (climb !== undefined && o.spare !== undefined) {
        // (the armour swap: the spare onto the back, the worn one into the spare's slot)
        slots[12] = worn;
        worn = el(o.spare);
      }
      return climb !== undefined && o.spare === undefined ? (o.tail ?? '') : '';
    },
  };
  const p = new FlyProcess(target, deps);
  const pm = new ProcessManager();
  pm.add(p);
  pm.tick();
  return { p, calls };
}

describe('Unbreaking at the takeoff (Track F21: wear.ts useShare, tripCover with a level, kit.ts readKit)', () => {
  const ub = (lvl: number) => [{ id: ENCH_UNBREAKING, lvl }];
  it('the share of the gliding seconds that cost a use: 1 bare, then never under 1 / (level + 1) and at least what was measured; over III as III', () => {
    expect(useShare(0)).toBe(1);
    for (const l of [1, 2, 3]) expect(useShare(l)).toBeGreaterThanOrEqual(1 / (l + 1));
    // the most measured on bds-fly (docs/flight.md "Unbreaking at the takeoff"): I 0.546, II 0.338, III 0.26
    expect(useShare(1)).toBeGreaterThanOrEqual(0.546);
    expect(useShare(2)).toBeGreaterThanOrEqual(0.338);
    expect(useShare(3)).toBeGreaterThanOrEqual(0.26);
    expect(useShare(1)).toBeGreaterThan(useShare(2));
    expect(useShare(2)).toBeGreaterThan(useShare(3));
    expect(useShare(5)).toBe(useShare(3));
    expect(unbreakingLevel({ enchants: ub(2) })).toBe(2);
    expect(unbreakingLevel({ enchants: [{ id: 26, lvl: 1 }] })).toBe(0);
    expect(unbreakingLevel({})).toBe(0);
  });

  it('a trip of 600 blocks with 60 uses (30 over the limit): refused bare (53) and with Unbreaking I (31), flown with II (21) and III (17); the slack, the rate\'s margin and the 4 kept', () => {
    expect(tripUses(600)).toBe(53);
    expect(tripUses(600, {}, 1)).toBe(31);
    expect(tripUses(600, {}, 2)).toBe(21);
    expect(tripUses(600, {}, 3)).toBe(17);
    expect(tripCover(60, 30, 600).ok).toBe(false);
    expect(tripCover(60, 30, 600, {}, 1).ok).toBe(false);
    expect(tripCover(60, 30, 600, {}, 2).ok).toBe(true);
    expect(tripCover(60, 30, 600, {}, 3).ok).toBe(true);
    // (the 4 on top is not shared: a trip of 0 blocks needs the same 4 plus its seconds' share)
    expect(tripUses(0, {}, 3) - WEAR.tripMargin).toBe(Math.ceil((8 * WEAR.tripSlack + WEAR.goAroundS) * WEAR.perSecond * useShare(3)));
  });

  it('the Realm\'s trip of 2026-11-20 (2 252 blocks, a hold): 100 uses refused bare, flown with Unbreaking III; a new Unbreaking III elytra flies about four times as far; the line names the level', () => {
    expect(tripCover(100, 30, 2252, { hold: true }).ok).toBe(false);
    const c = tripCover(100, 30, 2252, { hold: true }, 3);
    expect(c.ok).toBe(true);
    expect(c.need).toBeLessThan(50);
    expect(tripReach(432 - 30, 3)).toBeGreaterThan(3.5 * tripReach(432 - 30));
    const far = tripCover(58, 30, 141358, { hold: true }, 3);
    expect(far.never).toBe(true);
    const line = tripCoverLine(far, 141358);
    expect(line).toMatch(/^the elytra \(Unbreaking III\) has 58 uses left \(30 kept for the landing\) and the trip of 141358 blocks needs about \d+, more than a new one with Unbreaking III has \(432; one flies about \d+ blocks\): not flying$/);
    expect(isTripCoverLine(`fly: ${line}; walking`)).toBe(true);
    expect(tripCoverLine(tripCover(40, 30, 600, {}, 1), 600)).toBe('the elytra (Unbreaking I) has 40 uses left (30 kept for the landing) and the trip of 600 blocks needs about 31: not flying');
  });

  it('readKit reads the level of the elytra at hand (on the back first)', () => {
    const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
    slots[9] = { name: 'elytra', count: 1, networkId: 1, metadata: 0, damage: 372, enchants: ub(3) };
    expect(readKit({ slots }).elytraUnbreaking).toBe(3);
    const bare: ItemStack = { name: 'elytra', count: 1, networkId: 1, metadata: 0, damage: 0 };
    expect(readKit({ slots, window: (id) => (id === 120 ? { slots: [null, bare, null, null] } : undefined) }).elytraUnbreaking).toBeUndefined();
  });

  it('FlyProcess.prepare: an Unbreaking III elytra with 60 uses flies a trip of 600 blocks that a bare one with 60 is refused', async () => {
    const goal: FlyTarget = { x: 0.5, z: 600.5, top: FEET, half: 1, label: 'the goal' };
    const bare = rigSecond(60, goal);
    const r = await bare.p.result;
    expect(r.reason).toBe('fly: the elytra has 60 uses left (30 kept for the landing) and the trip of 600 blocks needs about 53: not flying');
    expect(bare.calls).toEqual(['ask']);
    const u3 = rigSecond(60, goal, { ench: ub(3) });
    await new Promise((res) => setTimeout(res, 20));
    expect(u3.calls).toEqual(['ask', 'wear', 'flyTo']);
  });
});

describe('the second cover check asks for a spare (Track F21: FlyProcess.prepare with the elytra on the back)', () => {
  it('the model said 232 and the server says 170 once it is on the back (the Realm, 2026-11-18): K4\'s rule is asked with the climb, a carried spare of 432 is put on, the trip is flown', async () => {
    const goal: FlyTarget = { x: 0.5, z: 2252.5, top: FEET, half: 1, label: 'the goal', hold: true };
    const t = rigSecond(232, goal, { leftWorn: 170, spare: 432 });
    await new Promise((res) => setTimeout(res, 20));
    expect(t.calls).toEqual(['ask', 'wear', 'ask with the climb', 'flyTo']);
  });

  it('no spare covers it: refused with the K4 tail, the chestplate back on (as before the track, with the tail)', async () => {
    const goal: FlyTarget = { x: 0.5, z: 2252.5, top: FEET, half: 1, label: 'the goal', hold: true };
    const t = rigSecond(232, goal, { leftWorn: 170, tail: '; no spare that covers it (carried, in the boxes or at home in reach)' });
    const r = await t.p.result;
    expect(r.reason).toBe(`fly: the elytra has 170 uses left (30 kept for the landing) and the trip of 2252 blocks needs about ${secondNeed(2252, true)}: not flying; no spare that covers it (carried, in the boxes or at home in reach)`);
    expect(t.calls).toEqual(['ask', 'wear', 'ask with the climb', 'chestplate']);
  });
});

describe('the test kit\'s line for a replaced elytra (skills/test/kit.ts)', () => {
  it('says whose count it is: the one that was replaced', () => {
    const worn: ItemStack = { name: 'elytra', count: 1, networkId: 1, metadata: 0, damage: 431 };
    const p = planKit([], { slots: Array.from({ length: 36 }, () => null), worn: { head: null, chest: worn, legs: null, feet: null, offhand: null } }, { elytraMin: 100 });
    expect(p.notes).toEqual(['elytra on the back: a fresh one (it had 1 use left)']);
    const q = planKit([], { slots: [...Array.from({ length: 9 }, () => null), { ...worn, damage: 400 }, ...Array.from({ length: 26 }, () => null)], worn: { head: null, chest: null, legs: null, feet: null, offhand: null } }, { elytraMin: 100 });
    expect(q.notes).toEqual(['elytra in slot 9: a fresh one (it had 32 uses left)']);
  });
});

// ---- Track F21, the follow-up (docs/flight.md "The takeoff and the flight count the same"; decisions/0107, 2026-11-20) --
/** The gliding ticks a use at each level's most measured rate (bare: the Realm's 1.17 a second; I 0.546, II 0.339, III 0.257). */
const USE_TICKS = [17, 36, 59, 77] as const;
/**
 * The calibration (docs/flight.md "Where a held flight is when its hold ends"): a held goal's ground loads as a server
 * loads it, VIEW blocks out (the Realm: not loaded 152 to 157 out, confirmed before 116), and the trip's next look takes
 * the landing LOOK_LAG ticks after (a look every 40 ticks, LOOK_EVERY, and a look of up to 1.2 s).
 */
const VIEW = 150;
const LOOK_LAG = 64;
/** How a held goal's ground comes: as a server loads it (`view`), only when the trip ends the hold at flyHoldS (30 s), or never. */
type HoldMode = false | 'view' | 'flyHoldS' | 'never';
const HOLD_S = new RuntimeSettings().get('flyHoldS');
/** A flight over flat ground from FEET at a cruise `over` blocks up to a goal `dist` blocks north. */
function edgeFlight(o: { level: number; dist: number; over: number; hold: HoldMode; left: number; tell?: boolean; walls?: number }): Promise<SimResult> {
  const goal: LandingTarget = { x: 0.5, z: o.dist + 0.5, top: FEET, half: 1, ...(o.hold ? { hold: true } : {}) };
  let released = false;
  let seenAt: number | undefined;
  // (`walls`: two walls that high 24 blocks either side of the way, from 40 blocks out to 40 short of the goal: the relief round the body)
  const w = o.walls ? sim([-24, 24].map((x) => ({ from: { x, y: FEET, z: 40 }, to: { x, y: FEET + o.walls! - 1, z: o.dist - 40 }, solid: true }))) : sim();
  return simulateFlight(w, { x: 0.5, y: FEET, z: 0.5 }, goal, { cruiseY: FEET + o.over, elytraWornAt: LIMIT, ...(o.tell !== false && o.level > 0 ? { elytraUnbreaking: o.level } : {}) }, {
    rockets: 64,
    maxTicks: o.hold === 'never' || o.hold === 'flyHoldS' ? 14000 : 9000,
    endLag: 2,
    elytra: { left: o.left, useTicks: USE_TICKS[o.level] },
    until: (brain, body) => {
      if (!o.hold || released || o.hold === 'never') return false;
      if (o.hold === 'view' && seenAt === undefined && hdist(body.pos, goal) <= VIEW) seenAt = brain.stats.ticks;
      const now = o.hold === 'view' ? seenAt !== undefined && brain.stats.ticks - seenAt >= LOOK_LAG : brain.stats.holdTicks >= HOLD_S * 20;
      if (now) {
        released = true;
        brain.retarget({ x: goal.x, z: goal.z, top: goal.top, half: 1 }, { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: 0 });
      }
      return false;
    },
  });
}
/** What the takeoff asks for that flight with the cruise known (FlyProcess.prepare's shape: the climb, the cruise over the ground, the arrival). */
function edgeShape(dist: number, over: number, hold: boolean): { climb: number; hold: boolean; over: number; arrive: number } {
  const goal: LandingTarget = { x: 0.5, z: dist + 0.5, top: FEET, half: 1, ...(hold ? { hold: true } : {}) };
  return { climb: over, hold, over: cruiseOver(FEET + over, FEET, FEET), arrive: plannedArrival({ x: 0.5, y: FEET, z: 0.5 }, goal, FEET + over, () => FEET - 1, new RuntimeSettings()) };
}
const edgeNeed = (level: number, dist: number, over: number, hold: boolean): number => tripUses(dist, edgeShape(dist, over, hold), level);
const endSaid = (r: SimResult): string => `${r.end ? (r.end.ok ? 'landed' : r.end.reason) : 'no end'}${r.stats.worn ? ` (worn at ${r.stats.worn.left}, ${r.stats.worn.over.toFixed(0)} over)` : ''}${r.glideLost ? ' GLIDE LOST' : ''}`;

describe('the takeoff and the flight count the same (Track F21, the follow-up)', () => {
  it('the Realm\'s hop (2026-11-20): Unbreaking III with 60 uses, 883 blocks, a cruise 89 over the ground with ridges 75 high beside the way (no room for the dive: the way down is the circle, about 32 uses bare, as the Realm\'s line said): the takeoff lets it go; before, the flight was landed as worn seconds after the takeoff; now it is flown to its landing', async () => {
    const shape = edgeShape(883, 89, false);
    expect(tripCover(60, LIMIT, 883, {}, 3).ok).toBe(true); // the first ask, as on the Realm
    expect(tripCover(60, LIMIT, 883, shape, 3).ok).toBe(true); // and the second, with the cruise known
    const before = await edgeFlight({ level: 3, dist: 883, over: 89, hold: false, left: 60, tell: false, walls: 75 });
    expect(before.end && !before.end.ok && before.end.reason).toBe('elytra_worn');
    expect(before.stats.worn).toBeDefined();
    expect(before.stats.worn!.left).toBeGreaterThan(50); // landed with 50 uses and more: the bare way down counted
    expect(before.body.pos.z).toBeLessThan(400); // far short of the goal
    const now = await edgeFlight({ level: 3, dist: 883, over: 89, hold: false, left: 60, walls: 75 });
    expect(now.end?.ok).toBe(true);
    expect(now.stats.worn).toBeUndefined();
    expect(now.glideLost).toBeUndefined();
  });

  it('the bare elytra at the edge: exactly what Track F20\'s takeoff asked, a cruise 250 over the ground forced over the glide\'s need, a hold that ends as the ground loads: the flight reaches the goal some 240 over it and spirals down from there; before, the worn landing short of the goal; asked with the arrival now, flown to the goal', async () => {
    const old = tripUses(600, { hold: true, climb: 250 });
    const before = await edgeFlight({ level: 0, dist: 600, over: 250, hold: 'view', left: LIMIT + old });
    expect(before.end && !before.end.ok && before.end.reason).toBe('elytra_worn');
    const shape = edgeShape(600, 250, true);
    expect(shape.arrive).toBeGreaterThan(220);
    const need = tripUses(600, shape);
    expect(need).toBeGreaterThan(old + 40); // the circle from about 240 over the goal: 75 s
    const now = await edgeFlight({ level: 0, dist: 600, over: 250, hold: 'view', left: LIMIT + need });
    expect(now.end?.ok).toBe(true);
    expect(now.stats.worn).toBeUndefined();
  });

  for (const level of [0, 1, 2, 3]) {
    it(`(a) the invariant, Unbreaking ${level}: every trip the takeoff allows (150 to 3 000 blocks, a cruise 20 to 300 over the ground, held as a server holds a goal (its ground loads ${VIEW} out) and not, the uses just what it asks) is flown to its landing with no worn landing and no glide lost`, async () => {
      const bad: string[] = [];
      for (const dist of [150, 300, 600, 1500, 3000])
        for (const over of [20, 60, 100, 200, 300])
          for (const hold of [false, 'view'] as const) {
            const r = await edgeFlight({ level, dist, over, hold, left: LIMIT + edgeNeed(level, dist, over, hold !== false) });
            if (!r.end?.ok || r.stats.worn || r.glideLost) bad.push(`${dist} blocks, ${over} over${hold ? ', held' : ''}: ${endSaid(r)}`);
          }
      expect(bad).toEqual([]);
    }, 60_000);
    it(`(b) safety, Unbreaking ${level}: the same trips held until flyHoldS or never released (the body circling down from the height it came at, up to the full cruise), the uses what the takeoff asks: no flight loses its glide (the covered worn landing may end it short: Track F20's rule for a long hold, then the walk)`, async () => {
      const bad: string[] = [];
      for (const dist of [150, 300, 600, 1500, 3000])
        for (const over of [20, 60, 100, 200, 300])
          for (const hold of ['flyHoldS', 'never'] as const) {
            const r = await edgeFlight({ level, dist, over, hold, left: LIMIT + edgeNeed(level, dist, over, true) });
            if (r.glideLost || !r.end || (!r.end.ok && r.end.reason !== 'elytra_worn')) bad.push(`${dist} blocks, ${over} over, ${hold}: ${endSaid(r)}`);
          }
      expect(bad).toEqual([]);
    }, 120_000);
  }

  it('the safe side at every level: a worn landing begun at the limit for its height (70 to 1 000 over the ground), the elytra wearing at its level\'s most measured rate, stands with 10 uses or more; the limit with Unbreaking is the fixed one up to 600 over', async () => {
    for (const level of [1, 2, 3]) {
      const share = useShare(level);
      for (const up of [70, 150, 300, 600, 1000]) {
        const left = wornLimitAt(LIMIT, up, undefined, 0, share);
        const r = await simulateFlight(sim(), { x: 0.5, y: FEET + up, z: 0.5 }, { x: 0.5, z: 30000.5, top: FEET, half: 1, hold: true }, { cruiseY: FEET + up, elytraWornAt: LIMIT, elytraUnbreaking: level }, { rockets: 20, maxTicks: 8000, airborne: { x: 0, y: -0.15, z: 1.5 }, yaw: 0, elytra: { left, useTicks: USE_TICKS[level] } });
        expect(r.glideLost, `level ${level} from ${up}`).toBeUndefined();
        expect(r.end && !r.end.ok && r.end.reason, `level ${level} from ${up}`).toBe('elytra_worn');
        expect(r.usesLeft, `level ${level} from ${up}`).toBeGreaterThanOrEqual(10);
        if (up <= 600) expect(left, `level ${level} from ${up}`).toBeLessThanOrEqual(LIMIT + (level === 1 ? 6 : 0));
      }
    }
  });

  it('UsesCount at a share: a use for every 20 / share gliding ticks (Unbreaking III: 77); bare as before', () => {
    const u = new UsesCount(useShare(3));
    expect(u.step(60, true)).toBe(60);
    for (let t = 0; t < 75; t++) u.step(60, true);
    expect(u.step(60, true)).toBe(60);
    expect(u.step(60, true)).toBe(59);
    expect(u.step(58, true)).toBe(58); // the server's word
    const bare = new UsesCount();
    bare.step(60, true);
    for (let t = 0; t < 19; t++) bare.step(60, true);
    expect(bare.step(60, true)).toBe(59);
  });

  it('the trip\'s need with the cruise known: the flight\'s worn limit there, the circle from the arrival after a hold (never under Track F20\'s ask), the climb and the spiral of a trip short for its height', () => {
    expect(cruiseKeep(undefined)).toBe(0);
    expect(cruiseKeep(0)).toBe(0);
    expect(cruiseKeep(250)).toBe(wornLimitAt(0, 250 + 48) + 2);
    expect(cruiseKeep(250, useShare(3))).toBe(wornLimitAt(0, 250 + 48, undefined, 0, useShare(3)) + 1);
    expect(cruiseOver(100, -60, -40)).toBe(160);
    expect(cruiseOver(-70, -60, -60)).toBe(0);
    // a long trip low over the ground: the trip and the limit's part (no spiral)
    expect(tripUses(1500, { over: 40 })).toBe(tripUses(1500) + cruiseKeep(40));
    // held, arriving on the glide line (49 over the goal): Track F20's ask and the limit's part; the hold as recorded is under F20's 8 s
    expect(tripUses(2261, { hold: true, over: 40, arrive: 49 })).toBe(tripUses(2261, { hold: true }) + cruiseKeep(40));
    expect(WEAR.holdKnown).toBeLessThan(WEAR.holdS);
    // held, arriving 250 over the goal: the circle from there at 0.15 a tick (78 s), less the cruise's last stretch it replaces
    const from250 = tripUses(600, { hold: true, over: 250, arrive: 250 }) - cruiseKeep(250) - WEAR.tripMargin;
    expect(from250).toBe(Math.ceil((flightSeconds(600) + (250 - WEAR.spiralFrom) / WEAR.spiralSink / 20 - WEAR.spiralCredit + WEAR.goAroundS + WEAR.holdKnown) * WEAR.perSecond));
    // the arrival not given: the cruise's height (the most it can be)
    expect(tripUses(600, { hold: true, over: 250 })).toBe(tripUses(600, { hold: true, over: 250, arrive: 250 }));
    // 300 blocks at 200 over: the climb and the spiral (72 s), not the 31 s the distance alone says
    expect(tripUses(300, { over: 200 })).toBeGreaterThan(tripUses(300) + 50);
  });

  it('where a held flight is when its hold ends (arrivalOver): on the glide line for a cruise the glide needs, the climb\'s top glided down for one over it, held over the hill before the goal; the guard on the brain\'s constants', () => {
    // offline, released at the hold's start (1 500 blocks; .work: hold-descent): 300 over -> 203, 200 -> 81, 100 -> 40; 600: 300 -> 295, 200 -> 171, 100 -> 69
    const at = (dist: number, over: number): number => arrivalOver({ distance: dist, fromY: FEET, cruiseY: FEET + over, goalTop: FEET, nearTop: FEET - 1 });
    const seen: [number, number, number][] = [[1500, 300, 203], [1500, 200, 81], [1500, 100, 40], [1500, 20, 37], [600, 300, 295], [600, 200, 171], [600, 150, 130], [600, 100, 69], [600, 20, 45]];
    for (const [dist, over, h] of seen) {
      expect(at(dist, over), `${dist} at ${over}`).toBeGreaterThanOrEqual(h);
      expect(at(dist, over), `${dist} at ${over}`).toBeLessThanOrEqual(h + 20);
    }
    expect(at(600, 300)).toBeLessThanOrEqual(300 + WEAR.arriveOver);
    // the Realm's trip home (2 261 blocks from a ledge 78 over home, a cruise 226 over it, a hill 90 over it within 160 of home): 112 and 119 over home
    expect(arrivalOver({ distance: 2261, fromY: 78, cruiseY: 226.1, goalTop: 0, nearTop: 90 })).toBeGreaterThanOrEqual(119);
    expect(arrivalOver({ distance: 2261, fromY: 78, cruiseY: 226.1, goalTop: 0 })).toBeLessThan(60); // without the hill: the glide line
    // plannedArrival reads the last 200 blocks before the goal: a hill there counts, one farther out does not; unknown there is the highest known plus 24
    const goal: LandingTarget = { x: 0.5, z: 2000.5, top: FEET, half: 1, hold: true };
    const s = new RuntimeSettings();
    const hillAt = (z0: number, top: number) => (x: number, z: number): number | undefined => (z >= z0 && z < z0 + 10 && x === 0 ? top : FEET - 1);
    const flat = plannedArrival({ x: 0.5, y: FEET, z: 0.5 }, goal, FEET + 150, () => FEET - 1, s);
    expect(plannedArrival({ x: 0.5, y: FEET, z: 0.5 }, goal, FEET + 150, hillAt(1850, FEET + 60), s)).toBe(Math.min(150 + WEAR.arriveOver, 60 + 1 + s.get('flyClearance') + 20));
    expect(plannedArrival({ x: 0.5, y: FEET, z: 0.5 }, goal, FEET + 150, hillAt(1000, FEET + 60), s)).toBe(flat);
    expect(plannedArrival({ x: 0.5, y: FEET, z: 0.5 }, goal, FEET + 150, (x, z) => (z > 1900 ? undefined : FEET - 1), s)).toBe(Math.min(150 + WEAR.arriveOver, -1 + 24 + 1 + s.get('flyClearance') + 20));
    expect(plannedArrival({ x: 0.5, y: FEET, z: 0.5 }, goal, FEET + 150, () => undefined, s)).toBe(150 + WEAR.arriveOver);
    // the guards: the brain's top-up over the glide line, the hold's start, the records' longest hold and a look's lag under the hold counted
    expect(ARRIVE_TOP_UP).toBe(KIT_USE_OVER);
    expect(HOLD_AT).toBe(APPROACH_DISTANCE + 60);
    expect(WEAR.holdKnown * 20).toBeGreaterThanOrEqual(Math.max(25, LOOK_LAG));
    expect(VIEW).toBeLessThan(RETARGET_WITHIN);
  });

  // The Realm's recorded flights (2026-11-18 to 20, read from the live bot's log): the distance, the start's and the cruise's heights over the goal, held or not, the highest column
  // the logs name within 200 of the goal (over it), the flight's ticks and the uses the server's count says it took.
  const RECORDED: { what: string; d: number; fromY: number; goalTop: number; cruiseY: number; hold: boolean; nearTop: number; ticks: number; uses: number; arrived?: number; under?: boolean }[] = [
    { what: 'to the gunpowder room, 2026-11-20 (one go-around)', d: 2228, fromY: -74, goalTop: 0, cruiseY: 187, hold: true, nearTop: 44, ticks: 1931, uses: 99, arrived: 27 },
    { what: 'to the gunpowder room, 2026-11-20 (one go-around)', d: 2255, fromY: -67, goalTop: 0, cruiseY: 183, hold: true, nearTop: 44, ticks: 1901, uses: 85, arrived: 30 },
    { what: 'to the gunpowder room, 2026-11-18 (held 25 ticks)', d: 2252, fromY: -74, goalTop: 0, cruiseY: 183, hold: true, nearTop: 44, ticks: 2026, uses: 119, arrived: 75 },
    { what: 'home, 2026-11-20 (held 19 ticks)', d: 2261, fromY: 78, goalTop: 0, cruiseY: 226.1, hold: true, nearTop: 90, ticks: 2097, uses: 104, arrived: 112 },
    { what: 'home, 2026-11-20 (held 18 ticks)', d: 2261, fromY: 78, goalTop: 0, cruiseY: 226.1, hold: true, nearTop: 90, ticks: 2126, uses: 104, arrived: 119 },
    { what: 'to the mine, 2026-11-18 (held 15 ticks; the goal 127 under the ground the landing took)', d: 2285, fromY: 189, goalTop: 0, cruiseY: 242.1, hold: true, nearTop: 170, ticks: 2104, uses: 114, under: true },
    { what: 'to the xp farm, 2026-11-18 (168 blocks)', d: 168, fromY: -9, goalTop: 0, cruiseY: 46, hold: false, nearTop: 33, ticks: 335, uses: 15 },
    { what: 'home, 2026-11-18 (144 blocks)', d: 144, fromY: 9, goalTop: 0, cruiseY: 54, hold: false, nearTop: 41, ticks: 373, uses: 17 },
  ];
  const askOf = (r: (typeof RECORDED)[number]): number => tripUses(r.d, { climb: Math.max(0, r.cruiseY - r.fromY), hold: r.hold, over: cruiseOver(r.cruiseY, r.fromY, r.goalTop), arrive: arrivalOver({ distance: r.d, fromY: r.fromY, cruiseY: r.cruiseY, goalTop: r.goalTop, nearTop: r.nearTop }) });
  it('the calibration on the Realm\'s recorded flights: the ask is at or over what each flight took and not more than 2 times it (long trips 1.36 to 1.92: the circle priced at 0.15 a tick, the rate at the most seen; short ones 2.1 to 2.2: the go-around and the margin), never more than 25 over Track F20\'s but for a goal under the ground; the arrival at or over the height each held flight came in at', () => {
    for (const r of RECORDED) {
      const ask = askOf(r);
      expect(ask, r.what).toBeGreaterThanOrEqual(r.uses);
      expect(ask / r.uses, r.what).toBeLessThanOrEqual(r.d >= 1000 ? 2 : 2.3);
      // (a goal under the ground: the takeoff counts the way down to the goal's own height; the landing came down on the ground 127 over it)
      if (!r.under) expect(ask - tripUses(r.d, { climb: Math.max(0, r.cruiseY - r.fromY), hold: r.hold }), r.what).toBeLessThanOrEqual(25);
      if (r.arrived !== undefined) expect(arrivalOver({ distance: r.d, fromY: r.fromY, cruiseY: r.cruiseY, goalTop: r.goalTop, nearTop: r.nearTop }), r.what).toBeGreaterThanOrEqual(r.arrived);
    }
    // a new elytra flies the three trips the Realm flew on one (to the room, home, to the room again: 99, 104 and 85 uses); the fourth is walked
    let left = 432;
    const order = [RECORDED[0]!, RECORDED[3]!, RECORDED[1]!, RECORDED[4]!];
    const flown: boolean[] = [];
    for (const r of order) {
      const ok = tripCover(left, LIMIT, r.d, { climb: Math.max(0, r.cruiseY - r.fromY), hold: r.hold, over: cruiseOver(r.cruiseY, r.fromY, r.goalTop), arrive: arrivalOver({ distance: r.d, fromY: r.fromY, cruiseY: r.cruiseY, goalTop: r.goalTop, nearTop: r.nearTop }) }).ok;
      flown.push(ok);
      if (ok) left -= r.uses;
    }
    expect(flown).toEqual([true, true, true, false]);
  });

  it('no hop loop: after a worn landing (at the limit for any height up to the cruise\'s cap, the count up to 2 behind bare and 8 with Unbreaking), the walk\'s re-check flies no trip of flyMin (200) blocks or more with that elytra, asked with the cruise and the arrival or without', () => {
    for (const level of [0, 1, 2, 3]) {
      const share = useShare(level);
      const gap = level === 0 ? 2 : 8;
      for (let h = 0; h <= 450; h += 10) {
        const left = wornLimitAt(LIMIT, h, undefined, 0, share) + gap;
        for (const dist of [200, 300, 600, 1500, 5000])
          for (const over of [undefined, 0, 20, 100, 300])
            for (const hold of [false, true]) {
              const shapes = over === undefined ? [{ hold }] : [{ climb: over, over, hold }, { climb: over, over, hold, arrive: 0 }, { ...edgeShape(dist, over, hold) }];
              for (const shape of shapes) {
                const c = tripCover(left, LIMIT, dist, shape, level);
                expect(c.ok, `level ${level}, landed from ${h} with ${left}, ${dist} blocks, ${JSON.stringify(shape)}`).toBe(false);
              }
            }
      }
    }
  });
});
