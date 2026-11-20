/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Track F20 (docs/flight.md "A flight never outlasts its elytra (Track F20)"; decisions/0107). The Realm's fall of
// 2026-11-18 first, offline, as it was: an elytra with 58 uses, a goal 141 km away, the fixed worn limit and the forced
// landing's circle; then the three rules that end it (the takeoff asks, the way down is covered, the cruise's cap), the
// second Realm case (a trip that needs what is left, a hold over a goal whose ground loads late), the server's word on
// the wear (player_armor_damage), and that a flight whose elytra is nowhere near its limit is tick for tick what it was.
import { describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { CRUISE_OVER } from '../../../src/skills/fly/brain.ts';
import { FlightController, type FlightLoop, type FlightReport } from '../../../src/skills/fly/controller.ts';
import type { InputLoopEvent, InputLoopState } from '../../../src/skills/input/inputLoop.ts';
import { simulateFlight, type SimResult } from '../../../src/skills/fly/glide.ts';
import { elytraWornLimit } from '../../../src/skills/fly/kit.ts';
import { cruiseHeight, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { descentUses, diveTicks, isTripCoverLine, tripCover, tripCoverLine, tripReach, tripUses, UsesCount, WEAR, wornLimitAt } from '../../../src/skills/fly/wear.ts';
import { flatWorld, withBoxes, type BlockQuery } from '../../../src/skills/input/index.ts';
import { planKit } from '../../../src/skills/test/kit.ts';
import { FlyProcess, type FlyDeps, type FlyTarget } from '../../../src/tasks/process/fly.ts';
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
    expect(r.reason).toBe('fly: the elytra has 170 uses left (30 kept for the landing) and the trip of 2252 blocks needs about 147: not flying');
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

describe('the test kit\'s line for a replaced elytra (skills/test/kit.ts)', () => {
  it('says whose count it is: the one that was replaced', () => {
    const worn: ItemStack = { name: 'elytra', count: 1, networkId: 1, metadata: 0, damage: 431 };
    const p = planKit([], { slots: Array.from({ length: 36 }, () => null), worn: { head: null, chest: worn, legs: null, feet: null, offhand: null } }, { elytraMin: 100 });
    expect(p.notes).toEqual(['elytra on the back: a fresh one (it had 1 use left)']);
    const q = planKit([], { slots: [...Array.from({ length: 9 }, () => null), { ...worn, damage: 400 }, ...Array.from({ length: 26 }, () => null)], worn: { head: null, chest: null, legs: null, feet: null, offhand: null } }, { elytraMin: 100 });
    expect(q.notes).toEqual(['elytra in slot 9: a fresh one (it had 32 uses left)']);
  });
});
