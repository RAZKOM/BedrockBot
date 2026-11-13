// Track F10 (docs/flight.md "The open-air flight on the burn of the rockets at hand", decisions/0083): the flight in the
// open planned with the burn of the rockets at hand (`flyKitBurn`). Guarded on synthetic ground (nothing of anybody's
// world): the setting is off by default; what a rocket buys by its burn; the kit's range in the route planner's states,
// branches and robust check, and in the tracker's belief; whole flights with crafted burns (19 to 31 ticks, drawn by a
// seeded generator) with the brain told and not told: the climb and the top-ups end near the height they were flown for
// whatever the burn, on no more rockets; a takeoff's proof flies the kit's burns; and with nothing told every number is
// the plain rocket's.
import { describe, expect, it } from 'vitest';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { BURN_PLAIN, burnRange, gainPitch, kitBurnOf, openBurnOf, proofBurns, rocketGain, searchProofBurns, wholeGain, type BurnRange } from '../../../src/skills/fly/burn.ts';
import { PROOF_BURNS, routeTakeoff, routeTakeoffOptions, simulateFlight } from '../../../src/skills/fly/glide.ts';
import { cruiseHeight, ROCKET_CRUISE_CLIMB, rocketPitchFor, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { gridOf } from '../../../src/skills/fly/route/grid.ts';
import { stepState } from '../../../src/skills/fly/route/primitives.ts';
import { checkRobust } from '../../../src/skills/fly/route/robust.ts';
import { planRoute } from '../../../src/skills/fly/route/search.ts';
import { planTakeoffRoute, takeoffStart } from '../../../src/skills/fly/route/takeoff.ts';
import { RouteTracker } from '../../../src/skills/fly/route/tracker.ts';
import { BURN, freshBurn, MID_BURNS, midBurnsOf, NO_BOOST, waypointAt, type RouteState } from '../../../src/skills/fly/route/types.ts';
import type { TerrainQuery } from '../../../src/skills/fly/terrain.ts';
import type { BlockBox } from '../../../src/skills/input/index.ts';
import { FEET, world } from './fly-worlds.ts';

const CRAFTED = burnRange(1);
const SLOW = 120_000;

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A whole flight over `boxes` to a ground cell `dist` out, each rocket's burn drawn from `kit` by the seed; the brain told `told`. */
async function trip(o: { dist: number; boxes?: BlockBox[]; kit: BurnRange; told?: BurnRange; seed: number; maxClimb?: number; retarget?: number }) {
  const w = world(o.boxes ?? []);
  const terrain: TerrainQuery = (x, z) => ({ top: w.skyTop(x, z), src: 'live' });
  const start = { x: 0.5, y: FEET, z: 0.5 };
  const target: LandingTarget = { x: 0.5, z: o.dist + 0.5, top: FEET, half: 3, ground: FEET };
  const cz = cruiseHeight(start, target, w.skyTop, { clearance: 12, margin: 15, maxClimb: o.maxClimb ?? 120 });
  const r = rng(o.seed);
  const burns = Array.from({ length: 64 }, () => o.kit.min + Math.floor(r() * (o.kit.max - o.kit.min + 1)));
  let retargeted = false;
  let aimTop = -Infinity;
  const sim = await simulateFlight({ world: w.solid, groundAt: w.dryGround, skyTop: w.skyTop, terrain }, start, target, { cruiseY: cz.y, margin: 15, clearance: 12, descent: 'auto', ...(o.told ? { burn: o.told } : {}) }, {
    rockets: 64,
    yaw: 0,
    maxTicks: 6000,
    burn: (i) => burns[i] ?? o.kit.nominal,
    endLag: 2,
    until: (brain, body) => {
      if (o.retarget !== undefined && !retargeted && brain.stats.ticks >= 120) {
        retargeted = true;
        brain.retarget({ x: target.x, z: target.z - 60, top: target.top + o.retarget, half: 2 }, { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 });
      }
      if (retargeted) aimTop = Math.max(aimTop, body.pos.y);
      return o.retarget !== undefined && brain.phase === 'approach';
    },
  });
  return { sim, cruise: cz.y, top: sim.stats.maxY - cz.y, aimTop };
}

describe('fly: the open-air flight on the burn of the rockets at hand (Track F10)', () => {
  it('the setting flyKitBurn is off by default and listed with the flight settings', () => {
    expect(SETTING_DEFS.flyKitBurn.default).toBe(false);
    expect(SETTING_DEFS.flyKitBurn.kind).toBe('boolean');
    expect(SETTING_GROUPS.find(([g]) => g === 'flight')?.[1]).toContain('flyKitBurn');
  });

  it('what the open-air flight is told: nothing with the setting off, nothing with plain rockets, the hotbar\'s range with crafted or mixed ones', () => {
    const is = (n: string): boolean => n === 'firework_rocket';
    const plain = [{ name: 'firework_rocket', count: 64 }];
    const crafted = [{ name: 'firework_rocket', count: 40, flight: 1 }, { name: 'dirt', count: 64 }];
    const mixed = [{ name: 'firework_rocket', count: 40, flight: 1 }, { name: 'firework_rocket', count: 3 }];
    expect(kitBurnOf(plain, is)).toBeUndefined();
    expect(kitBurnOf([], is)).toBeUndefined();
    expect(kitBurnOf(crafted, is)).toEqual(CRAFTED);
    for (const slots of [plain, crafted, mixed, []]) expect(openBurnOf(false, slots, is)).toBeUndefined();
    expect(openBurnOf(true, plain, is)).toBeUndefined();
    expect(openBurnOf(true, [], is)).toBeUndefined();
    expect(openBurnOf(true, crafted, is)).toEqual({ min: 19, max: 31, nominal: 25 });
    expect(openBurnOf(true, mixed, is)).toEqual({ min: 9, max: 31, nominal: 25 });
  });

  it('what a rocket buys by its burn: at 15 ticks the table the cruise has flown with, ten ticks more buy a third more', () => {
    // plan.ts rocketPitchFor: -10 buys 6, -20 14, -30 24, -38 31
    expect([-10, -20, -30, -38].map((p) => Math.round(rocketGain(p, 15)))).toEqual([6, 14, 24, 31]);
    expect([-10, -20, -30, -38].map((p) => Math.round(rocketGain(p, 25)))).toEqual([9, 20, 33, 42]);
    expect([-10, -20, -30, -38].map((p) => Math.round(rocketGain(p, 19)))).toEqual([7, 17, 27, 35]);
    expect([-10, -20, -30, -38].map((p) => Math.round(rocketGain(p, 31)))).toEqual([11, 24, 38, 48]);
    expect(wholeGain(BURN_PLAIN)).toBe(ROCKET_CRUISE_CLIMB);
    expect(wholeGain(CRAFTED)).toBe(42);
    // the pitch for a gain: for 15 ticks within 3 degrees of the cruise's own (which rounds to 5), shallower the longer the burn
    for (const g of [6, 10, 14, 20, 24, 31]) expect(Math.abs(gainPitch(g, 15) - rocketPitchFor(g)), `gain ${g}`).toBeLessThanOrEqual(3);
    expect(gainPitch(31, 19)).toBeGreaterThan(gainPitch(31, 15));
    expect(gainPitch(31, 25)).toBeGreaterThan(gainPitch(31, 19));
    expect(gainPitch(100, 25)).toBe(-38);
    expect(gainPitch(1, 25)).toBe(-10);
    // a searched takeoff's proof burns: the plain rocket's as they were, a crafted one's the same four places of its range
    expect(searchProofBurns(BURN_PLAIN)).toEqual([...PROOF_BURNS]);
    expect(searchProofBurns(CRAFTED)).toEqual([19, 31, 22, 28]);
    expect(proofBurns(CRAFTED).slice(0, 4)).toEqual(searchProofBurns(CRAFTED));
  });

  it("the route planner's states carry the kit: a rocket's range, its branches' burns and the robust check are the kit's; with none they are 9 to 21", () => {
    expect(freshBurn()).toEqual({ min: 9, max: 21, nom: 15 });
    expect(freshBurn(CRAFTED)).toEqual({ min: 19, max: 31, nom: 25 });
    expect(midBurnsOf()).toBe(MID_BURNS);
    expect(midBurnsOf(CRAFTED)).toEqual([22, 28]);
    expect(midBurnsOf({ min: 9, max: 31, nominal: 25 })).toEqual([12, 28]);
    const gliding = (kit?: BurnRange): RouteState => ({ pos: { x: 0.5, y: 100, z: 0.5 }, vel: { x: 0, y: -0.1, z: 1.4 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 4, ...(kit ? { kit } : {}), wp: 0 });
    const fire = { yaw: 0, pitch: -10, fire: true };
    // (the range one tick after the rocket: a tick of it is burnt)
    const plain = stepState(gliding(), fire, false, undefined, undefined, true, true).next;
    expect(plain.boost).toEqual({ min: 8, max: 20, nom: 14 });
    expect(plain.mids?.map((m) => m.left)).toEqual([11, 17]);
    const kit = stepState(gliding(CRAFTED), fire, false, undefined, undefined, true, true).next;
    expect(kit.boost).toEqual({ min: 18, max: 30, nom: 24 });
    expect(kit.mids?.map((m) => m.left)).toEqual([21, 27]);
    expect(kit.kit).toEqual(CRAFTED);
    // a plan from a state with the kit: every state of it carries the kit, its rocket burns 25 ticks, and the robust check
    // flies every other burn of 19 to 31 (12 branches a rocket), where the plain rocket's flies 9 to 21
    const grid = gridOf({ solidAt: () => false });
    for (const k of [undefined, CRAFTED]) {
      const start = takeoffStart({ x: 0.5, y: FEET, z: 0.5 }, 0, 4, k);
      const p = planRoute({ start, goals: [waypointAt({ x: 0.5, y: FEET + 12, z: 30.5 }, 3, 8)], margin: 0.3, maxNodes: 40_000, maxMs: SLOW }, grid);
      expect(p.complete, p.why).toBe(true);
      expect(p.rockets).toBeGreaterThan(0);
      expect(p.states.every((s) => (k ? s.kit?.nominal === 25 : s.kit === undefined))).toBe(true);
      const rep = checkRobust(start, p, grid, 0.3, [waypointAt({ x: 0.5, y: FEET + 12, z: 30.5 }, 3, 8)]);
      const range = k ?? BURN;
      const single = rep.branches.filter((b) => b.burns.filter((x) => x !== range.nominal).length <= 1 || rep.fireTicks.length === 1);
      expect(Math.min(...rep.branches.flatMap((b) => b.burns))).toBe(range.min);
      expect(Math.max(...rep.branches.flatMap((b) => b.burns))).toBe(range.max);
      expect(single.length).toBeGreaterThanOrEqual(12);
    }
  });

  it("the tracker's states and its belief after a rocket are the kit's", () => {
    const grid = gridOf({ solidAt: () => false });
    const body = { pos: { x: 0.5, y: 100, z: 0.5 }, vel: { x: 0, y: -0.1, z: 1.4 }, gliding: true, onGround: false, rockets: 4 };
    const goals = [waypointAt({ x: 0.5, y: 100, z: 80.5 }, 4, 12)];
    const plain = new RouteTracker({ grid, margin: 0.3, goals, plan: (req) => planRoute(req, grid), maxNodes: 20_000, maxMs: SLOW });
    expect(plain.stateOf(body).kit).toBeUndefined();
    const kit = new RouteTracker({ grid, margin: 0.3, goals, plan: (req) => planRoute(req, grid), maxNodes: 20_000, maxMs: SLOW, kit: CRAFTED });
    expect(kit.stateOf(body).kit).toEqual(CRAFTED);
    // a burn already running when the tracker takes the body: what the loop expects of it, six ticks more at the most, either way
    kit.seedBoost(20);
    expect(kit.stateOf(body).boost).toEqual({ min: 17, max: 26, nom: 20 });
  });

  it('flat ground, crafted rockets: told their burn the flight tops within 16 of its cruise height in every flight, untold up to 30 and more; on no more rockets, all landed', async () => {
    let toldRockets = 0;
    let untoldRockets = 0;
    let untoldMax = -Infinity;
    for (let seed = 1000; seed < 1008; seed++) {
      const a = await trip({ dist: 650, kit: CRAFTED, told: CRAFTED, seed });
      const b = await trip({ dist: 650, kit: CRAFTED, seed });
      const line = `seed ${seed}: told top +${a.top.toFixed(1)} on ${a.sim.stats.rockets}, untold +${b.top.toFixed(1)} on ${b.sim.stats.rockets}`;
      expect(a.sim.end?.ok, line).toBe(true);
      expect(b.sim.end?.ok, line).toBe(true);
      expect(a.sim.hits, line).toBe(0);
      expect(a.top, line).toBeLessThanOrEqual(16);
      expect(a.top, line).toBeGreaterThanOrEqual(-5);
      toldRockets += a.sim.stats.rockets;
      untoldRockets += b.sim.stats.rockets;
      untoldMax = Math.max(untoldMax, b.top);
    }
    expect(untoldMax).toBeGreaterThan(25);
    expect(toldRockets).toBeLessThanOrEqual(untoldRockets);
  }, 120_000);

  it('a hill across the way: told the burn, a top-up buys what the terrain will ask over the glide a whole rocket covers: no more rockets than untold', async () => {
    const hill: BlockBox[] = [{ from: { x: -40, y: FEET, z: 300 }, to: { x: 40, y: FEET + 46, z: 360 }, solid: true }];
    let told = 0;
    let untold = 0;
    for (let seed = 1000; seed < 1006; seed++) {
      const a = await trip({ dist: 650, boxes: hill, kit: CRAFTED, told: CRAFTED, seed });
      const b = await trip({ dist: 650, boxes: hill, kit: CRAFTED, seed });
      expect(a.sim.end?.ok, `seed ${seed}`).toBe(true);
      expect(a.sim.hits, `seed ${seed}`).toBe(0);
      told += a.sim.stats.rockets;
      untold += b.sim.stats.rockets;
    }
    expect(told).toBeLessThanOrEqual(untold);
  }, 120_000);

  it('a target moved up in flight (as a line into a cave takes a flight over): told the burn, the top-up buys what the glide can use, not a whole rocket', async () => {
    let toldMax = -Infinity;
    let toldMin = Infinity;
    let untoldMax = -Infinity;
    for (let seed = 1000; seed < 1005; seed++) {
      const a = await trip({ dist: 650, kit: CRAFTED, told: CRAFTED, seed, retarget: 42 });
      const b = await trip({ dist: 650, kit: CRAFTED, seed, retarget: 42 });
      expect(a.sim.phase, `seed ${seed}`).toBe('approach');
      toldMax = Math.max(toldMax, a.top);
      toldMin = Math.min(toldMin, a.top);
      untoldMax = Math.max(untoldMax, b.top);
    }
    // (the aim is 42 over the ground 60 before the goal: the glide to it needs about 30 over the first cruise height and the
    // top-up aims 8 over that; told, the flights top within 10 of each other; untold, a whole rocket's 47 goes on top)
    expect(toldMax).toBeLessThanOrEqual(42);
    expect(toldMax - toldMin).toBeLessThanOrEqual(10);
    expect(untoldMax).toBeGreaterThan(toldMax + 10);
  }, 120_000);

  it('plain rockets: a flight told nothing is the same flight every time it is flown, and its first top and what the climb went for are recorded', async () => {
    // the same flight twice: the same ticks, the same top (the brain has no state outside the flight)
    const a = await trip({ dist: 650, kit: BURN_PLAIN, seed: 1003 });
    const b = await trip({ dist: 650, kit: BURN_PLAIN, seed: 1003 });
    expect(a.sim.ticks).toBe(b.sim.ticks);
    expect(a.sim.stats.maxY).toBe(b.sim.stats.maxY);
    expect(a.sim.end?.ok).toBe(true);
    expect(a.sim.stats.climbTop).toBeDefined();
    expect(a.sim.stats.climbGoal).toBeGreaterThanOrEqual(a.cruise);
  }, 60_000);

  it("a takeoff's simulation flies the nominal burn it is told; a searched way out is planned on the kit's range and proven at its nominal, its ends and three ticks in from each", async () => {
    // (the first rocket's burn in a simulation with no burn given: the plain 15, or the kit's 25)
    const first = async (told?: BurnRange): Promise<number> => {
      const w = world([]);
      let burning = 0;
      let seen = false;
      await simulateFlight({ world: w.solid, groundAt: w.dryGround, skyTop: w.skyTop }, { x: 0.5, y: FEET, z: 0.5 }, { x: 0.5, z: 400.5, top: FEET, half: 3 }, { cruiseY: FEET + 60, ...(told ? { burn: told } : {}) }, {
        rockets: 1,
        yaw: 0,
        maxTicks: 80,
        until: (_brain, body) => {
          if ((body.boostTicks ?? 0) > 0) {
            seen = true;
            burning++;
          }
          return seen && (body.boostTicks ?? 0) === 0;
        },
      });
      // (the body's counter is read after each step: the tick that fired it has already burnt one)
      return burning + 1;
    };
    expect(await first()).toBe(15);
    expect(await first(CRAFTED)).toBe(25);
    // a slab over the start and a cliff across the goal's heading (fly-cave-exit.test.ts's hill case): the way out is searched
    const boxes: BlockBox[] = [
      { from: { x: -3, y: FEET + 3, z: -3 }, to: { x: 3, y: FEET + 3, z: 3 }, solid: true },
      { from: { x: -30, y: FEET, z: 10 }, to: { x: 30, y: FEET + 49, z: 50 }, solid: true },
    ];
    const w = world(boxes);
    const grid = gridOf(w.solid);
    const from = { x: 0.5, y: FEET, z: 0.5 };
    const target: LandingTarget = { x: 0.5, z: 600.5, top: FEET, half: 1 };
    const cz = cruiseHeight(from, target, w.skyTop, {});
    const deps = { world: w.solid, groundAt: w.dryGround, skyTop: w.skyTop };
    for (const told of [undefined, CRAFTED]) {
      const lines: string[] = [];
      const got = await planTakeoffRoute(grid, from, target, {
        rockets: 4,
        maxMs: SLOW,
        ...(told ? { kit: told } : {}),
        prove: async (route) => {
          const p = await routeTakeoff(deps, from, target, { cruiseY: cz.y, ...(told ? { burn: told } : {}) }, 64, { route: { grid, plan: (req) => planRoute(req, grid), maxMs: SLOW }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks });
          lines.push(p.line);
          return p;
        },
      });
      const said = `${got.tried.join('; ')} | ${lines.join(' | ')}`;
      expect(got.route?.proven, said).toBe(true);
      expect(lines.some((l) => l.startsWith(told ? 'clear at burns of 25, 19, 31, 22, 28 ticks' : 'clear at burns of 15, 9, 21, 12, 18 ticks')), said).toBe(true);
    }
  }, 240_000);
});
