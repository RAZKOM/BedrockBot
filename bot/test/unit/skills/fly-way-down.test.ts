// Flight v2 Track F14 (docs/flight.md "The way down to the landing", decisions/0085): a landing lies under the sky and has
// a way down to it. Offline on synthetic worlds and the physics engine (stepBody): what `open` means with and without the
// rule (a cavern's floor with 21 of room over it), the corridor that must end under the sky, the walk flood that goes on
// to a cave's mouth, the search that takes a far mouth and never a cell it did not simulate, the rim of a landing with
// something standing round it and the way in over it, whole trips with the setting on and off, the missed approach that
// gets its rim, the go-around's own chance, the line of a landing no flight comes down onto, and the setting itself.
import { describe, expect, it } from 'vitest';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { FlightBrain } from '../../../src/skills/fly/brain.ts';
import { APPROACH_SIMS, APPROACH_SIMS_SKY, cellsAround, ColumnView, corridorsOf, ELEVATOR_S_PER_BLOCK, findLanding, FLOOD_FAR, overLands, solidOver, viewTops, walkFlood, walkFloodFar, walkTarget, type LandingOptions, type ProbeOutcome } from '../../../src/skills/fly/landing.ts';
import { decideGoAround, GOAROUND_COST_S, GOAROUND_P, GOAROUND_P_OVER, GOAROUND_P_REPEAT, goAroundChance } from '../../../src/skills/fly/landprice.ts';
import { columnKey, landingRim, OVER, rimReach, wayIn, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import type { BlockBox } from '../../../src/skills/input/index.ts';
import { FEET, trip, world } from './fly-worlds.ts';

const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 10, probes: 16, budgetMs: 60_000, style: 'auto' };
const solid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ from: { x: x0, y: y0, z: z0 }, to: { x: x1, y: y1, z: z1 }, solid: true });
const hollow = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ from: { x: x0, y: y0, z: z0 }, to: { x: x1, y: y1, z: z1 }, solid: false });

/**
 * A goal under a mountain: the mountain 60 high over x -40..90, z -40..40; the goal in a room 3 high at its heart; beside
 * the room a cavern 10 x 9 with its roof 25 over the floor; from the cavern a tunnel 2 high and 3 wide out to the east
 * side, where it comes out on a terrace at its own height, 30 wide and under the open sky (its first cells 91 blocks from
 * the goal). The floor of all of it is 5 over the flat ground.
 */
function mountain() {
  const F = FEET + 5;
  const w = world([
    solid(-40, FEET, -40, 90, FEET + 59, 40),
    hollow(-1, F, -1, 1, F + 2, 1),
    hollow(2, F, 0, 2, F + 1, 0),
    hollow(3, F, -4, 12, F + 24, 4),
    hollow(13, F, -1, 90, F + 1, 1),
    solid(91, FEET, -15, 120, F - 1, 15),
  ]);
  const obstacle = (x: number, y: number, z: number): boolean => w.solid.solidAt(x, y, z) === true;
  const goal = { x: 0, y: F, z: 0 };
  // the walk: along the tunnel (its length from the cell, a step sideways counted)
  const probe = (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> => Promise.resolve(from.y === F ? { status: 'found', blocks: Math.abs(from.x - 0.5) + Math.abs(from.z - 0.5) } : { status: 'limited' });
  return { w, F, goal, obstacle, probe };
}

describe('fly: open sky is the sky (flight v2, Track F14)', () => {
  it('a floor with 21 of room over it under a mountain is open without the rule and an overhang cell with it; a floor under the sky is open either way', () => {
    const { w, F, goal } = mountain();
    const old = new ColumnView(w.look, goal.y);
    const sky = new ColumnView(w.look, goal.y, { sky: true });
    // the cavern's floor: its roof 25 over it
    const cav = old.floorNear(6, 0, F, 0)!;
    expect(cav.ceiling! - cav.feet).toBe(25);
    expect(old.kindOf(cav, 4)).toBe('open');
    expect(sky.kindOf(sky.floorNear(6, 0, F, 0)!, 4)).toBe('roof');
    // the room (3 high) and the tunnel (2 high): no landing either way
    expect(old.kindOf(old.floorNear(0, 0, F, 0)!, 4)).toBeUndefined();
    expect(sky.kindOf(sky.floorNear(40, 0, F, 0)!, 4)).toBeUndefined();
    // the terrace: nothing over it
    expect(old.kindOf(old.floorNear(100, 0, F, 0)!, 4)).toBe('open');
    expect(sky.kindOf(sky.floorNear(100, 0, F, 0)!, 4)).toBe('open');
  });

  it('what stands over the window of the search is a ceiling too: a ledge with 80 of air over it and a roof over that', () => {
    // a floor at the flat ground, a slab 80 over it (the view looks 72 over the goal)
    const w = world([solid(-5, FEET + 80, -5, 5, FEET + 80, 5)]);
    expect(solidOver(w.look, 0, 0, FEET + 73)).toBe(FEET + 80);
    expect(solidOver(w.look, 9, 0, FEET + 73)).toBeUndefined();
    const old = new ColumnView(w.look, FEET);
    const sky = new ColumnView(w.look, FEET, { sky: true });
    expect(old.floorNear(0, 0, FEET, 0)!.ceiling).toBeUndefined();
    expect(old.kindOf(old.floorNear(0, 0, FEET, 0)!, 4)).toBe('open');
    expect(sky.floorNear(0, 0, FEET, 0)!.ceiling).toBe(FEET + 80);
    expect(sky.kindOf(sky.floorNear(0, 0, FEET, 0)!, 4)).toBe('roof');
    expect(sky.kindOf(sky.floorNear(9, 0, FEET, 0)!, 4)).toBe('open');
    // the look ends at the column's highest y that may hold a block, where the caller knows it (world/chunks.ts topY)
    let looks = 0;
    const counted = (x: number, y: number, z: number) => (looks++, w.look(x, y, z));
    expect(solidOver(counted, 9, 0, FEET + 73, FEET + 75)).toBeUndefined();
    expect(looks).toBe(3);
    expect(solidOver(w.look, 0, 0, FEET + 73, FEET + 79)).toBeUndefined();
    expect(new ColumnView(w.look, FEET, { sky: true, maxY: () => FEET + 80 }).floorNear(0, 0, FEET, 0)!.ceiling).toBe(FEET + 80);
    // a cell that is not loaded ends the look up (the sub-chunks over a column's top are never sent)
    expect(solidOver((x, y, z) => (y > FEET + 75 ? undefined : w.look(x, y, z)), 0, 0, FEET + 73)).toBeUndefined();
  });

  it('a corridor in under a roof ends under the sky: a column with 20 of room and a roof over that is no end of it', () => {
    // a cell under a roof 5 over it; 3 blocks east the roof is 30 over the floor; 12 blocks east the sky
    const w = world([solid(-6, FEET + 5, -6, 2, FEET + 5, 6), solid(3, FEET + 30, -6, 11, FEET + 30, 6)]);
    // (bearing 270 is east; the corridors kept are 45 degrees apart, so the east one may be a little off it)
    const east = (c: { bearing: number }): boolean => c.bearing >= 240 && c.bearing <= 300;
    const old = corridorsOf(w.look, 0, 0, FEET, 10);
    expect(old.some((c) => east(c) && c.under === 2), JSON.stringify(old)).toBe(true);
    const sky = corridorsOf(w.look, 0, 0, FEET, 10, 4, true);
    expect(sky.some(east), JSON.stringify(sky)).toBe(false);
    // (the other sides, where the low roof ends under the sky, are corridors either way)
    expect(sky.length).toBeGreaterThan(0);
    // with the sky within reach (the high roof ends 6 blocks east) there is one again, and it is longer
    const w2 = world([solid(-6, FEET + 5, -6, 2, FEET + 5, 6), solid(3, FEET + 30, -6, 5, FEET + 30, 6)]);
    const sky2 = corridorsOf(w2.look, 0, 0, FEET, 10, 4, true);
    expect(sky2.find(east)?.under, JSON.stringify(sky2)).toBeGreaterThanOrEqual(5);
  });
});

describe("fly: a covered goal's landing is where its walk comes out under the sky (flight v2, Track F14)", () => {
  it('the walk flood: without the rule its open sky is the cavern beside the goal; with it the mouth 91 steps out, and the cells there', async () => {
    const { w, F, goal } = mountain();
    const old = walkFlood(new ColumnView(w.look, goal.y), { x: 0, z: 0, feet: F }, 48);
    expect(old.entrance).toMatchObject({ x: 3, feet: F, steps: 3 });
    const view = new ColumnView(w.look, goal.y, { sky: true });
    const far = await walkFloodFar(view, { x: 0, z: 0, feet: F }, 48, 4, () => Promise.resolve());
    expect(far.entrance).toMatchObject({ x: 91, z: 0, feet: F, steps: 91 });
    // landing cells beyond the window of 48, nearest by the walk first, none farther than FLOOD_FAR.more past the mouth
    expect(far.open.length).toBeGreaterThan(20);
    expect(far.open.length).toBeLessThanOrEqual(FLOOD_FAR.cells);
    expect(far.open[0]!.steps).toBeLessThanOrEqual(93);
    for (const c of far.open) {
      expect(c.x).toBeGreaterThanOrEqual(91);
      expect(c.steps).toBeLessThanOrEqual(91 + FLOOD_FAR.more + 1);
    }
    expect(far.last).toBeGreaterThan(91 + FLOOD_FAR.more);
    // the plain flood is what it was
    expect(walkFlood(view, { x: 0, z: 0, feet: F }, 48).floors).toBeLessThan(far.floors);
  });

  it('the search: without the rule a cell of the cavern, taken when the simulations ran out; with it a cell at the mouth, simulated, 91 blocks out', async () => {
    const { w, F, goal, obstacle, probe } = mountain();
    const old = await findLanding(goal, 'goal', { look: w.look, obstacle, probe }, { ...OPTS, from: { x: -300, z: 0 } });
    expect(old.kind, old.line).toBe('cell');
    if (old.kind !== 'cell') return;
    // (the fault of 2026-11-14: three cells refused by their simulations, the fourth taken without one, under the mountain)
    expect(old.line).toMatch(/no approach \(wall/);
    expect(old.line).toMatch(/approach(es)? not simulated: budget/);
    expect(old.cell.x).toBeLessThanOrEqual(12);
    expect(landingRim(old.target, w.skyTop).why).toBe('roof');

    const plan = await findLanding(goal, 'goal', { look: w.look, obstacle, probe, skyTop: w.skyTop }, { ...OPTS, sky: true, from: { x: -300, z: 0 } });
    expect(plan.kind, plan.line).toBe('cell');
    if (plan.kind !== 'cell') return;
    expect(plan.cell.x).toBeGreaterThanOrEqual(91);
    expect(plan.cell.feet).toBe(F);
    expect(plan.line).toMatch(/open sky 91 steps from the goal at 91 -55 0, \d+ cells there beyond the window/);
    // (no cell is offered because the simulations ran out: the answer's own way down was simulated)
    expect(plan.line).not.toMatch(/not simulated/);
    expect(APPROACH_SIMS_SKY).toBeGreaterThan(APPROACH_SIMS);
    expect(landingRim(plan.target, w.skyTop).why).not.toBe('roof');
    expect(plan.target.walkKnown).toBe(true);
    expect(plan.walk).toBeGreaterThan(90);
    // without the flight's column tops the search reads them from its own floors: the same answer
    const own = await findLanding(goal, 'goal', { look: w.look, obstacle, probe }, { ...OPTS, sky: true, from: { x: -300, z: 0 } });
    expect(own.kind === 'cell' && own.cell.x).toBe(plan.cell.x);
  }, 60_000);
});

/** Open ground with a wood round a clearing: trunks 16 high every 3 blocks from 4 to 13 out, the clearing 7 x 7; 150 blocks north of the start. */
function clearing(height = 16) {
  const Z = 150;
  const boxes: BlockBox[] = [solid(-1, FEET, -1, 1, FEET + 69, 1)];
  for (let dx = -13; dx <= 13; dx += 3) for (let dz = -13; dz <= 13; dz += 3) if (Math.max(Math.abs(dx), Math.abs(dz)) >= 5) boxes.push(solid(dx, FEET, Z + dz, dx, FEET + height - 1, Z + dz));
  const w = world(boxes);
  const view = new ColumnView(w.look, FEET);
  const cell = { x: 0, z: Z, feet: FEET, kind: 'open' as const };
  const target = walkTarget(cell, cellsAround(view, cell, 'open', 3, 4), { walkS: 10, walkKnown: true });
  return { w, Z, target, view, start: { x: 0.5, y: FEET + 70, z: 0.5 }, obstacle: (x: number, y: number, z: number): boolean => w.solid.solidAt(x, y, z) === true };
}

describe('fly: the rim of a landing with something standing round it (flight v2, Track F14)', () => {
  it('the way in from a circle: over the rim (and over what stands under the circle) by 3, the quarter turn and 0.26 a block of radius', () => {
    expect(wayIn(10, undefined, 10)).toBeCloseTo(10 + 3 + 2.5 + 2.6, 6);
    expect(wayIn(10, 14, 24)).toBeCloseTo(14 + 3 + 2.5 + 6.24, 6);
    expect(wayIn(10, 8, 6)).toBeCloseTo(10 + 3 + 2.5 + 1.56, 6);
    expect(OVER.circle).toBe(10);
  });

  it('landingRim: the highest column within 14 blocks; none on open ground, under a roof, too high, or with a column unknown', () => {
    const t = { x: 0.5, z: 0.5, top: 0 };
    const flat = (): number => -1;
    expect(landingRim(t, flat)).toEqual({ why: 'low', over: 0 });
    // a fence line 2 over the floor: none (SPIRAL_CLEAR.rim)
    expect(landingRim(t, (x) => (x === 5 ? 1 : -1))).toEqual({ why: 'low', over: 2 });
    // a wall 9 high 10 out: the rim; 15 out: out of reach
    expect(landingRim(t, (x) => (x === 10 ? 8 : -1))).toEqual({ rim: 9 });
    expect(landingRim(t, (x) => (x === 15 ? 8 : -1))).toEqual({ why: 'low', over: 0 });
    // ... and within a wider reach it counts (the missed approach's wall)
    expect(landingRim(t, (x) => (x === 30 ? 8 : -1), 34)).toEqual({ rim: 9 });
    // a cliff 60 high beside it: no way straight down
    expect(landingRim(t, (x) => (x >= 8 ? 59 : -1))).toEqual({ why: 'high', over: 60 });
    expect(OVER.max).toBe(48);
    // a roof over the landing itself, however high
    expect(landingRim(t, (x, z) => (x === 0 && z === 0 ? 40 : -1))).toEqual({ why: 'roof', over: 41 });
    // an unknown column in reach: not yet
    expect(landingRim(t, (x) => (x === 12 ? undefined : -1)).why).toBe('unknown');
    expect(landingRim(t, () => undefined).why).toBe('unknown');
  });

  it('the way in over it is simulated as it is flown: lands in a clearing between trunks 16 high, not under bars over the clearing', () => {
    const { w, target, obstacle, view } = clearing();
    const rim = landingRim(target, w.skyTop);
    expect(rim.rim).toBe(FEET + 16);
    const budget = { sims: 0, max: 8 };
    const sim = overLands(target, rim.rim!, obstacle, budget);
    expect(sim.ok, sim.why).toBe(true);
    expect(sim.downS).toBeCloseTo(16 * ELEVATOR_S_PER_BLOCK);
    expect(budget.sims).toBe(sim.tried);
    // the view's own tops read the same rim where the flight's are not given
    expect(landingRim(target, viewTops(view)).rim).toBe(FEET + 16);
    // a lid across the clearing 8 over its floor: the elevator's way is closed, from every side
    const Z = clearing().Z;
    const lid = world([solid(-3, FEET + 8, Z - 3, 3, FEET + 8, Z + 3)]);
    const no = overLands(target, FEET + 16, (x, y, z) => (y > FEET && lid.solid.solidAt(x, y, z) === true) || obstacle(x, y, z), { sims: 0, max: 8 });
    expect(no.ok).toBe(false);
    expect(no.tried).toBe(4);
    // the budget spent: nothing is tried and nothing is known
    expect(overLands(target, rim.rim!, obstacle, { sims: 8, max: 8 })).toMatchObject({ ok: false, tried: 0, why: 'budget' });
  }, 60_000);

  it('the search offers such a cell by its way in over what stands round it, priced with the seconds straight down', async () => {
    const { w, Z, obstacle } = clearing();
    // the goal: a cell under a little roof in the clearing (no landing itself)
    const w2 = world([solid(-1, FEET, -1, 1, FEET + 69, 1), solid(2, FEET + 3, Z + 2, 3, FEET + 3, Z + 3)]);
    const look = (x: number, y: number, z: number) => (w2.solid.solidAt(x, y, z) ? { name: 'stone', solid: true } : w.look(x, y, z));
    const obs = (x: number, y: number, z: number): boolean => obstacle(x, y, z) || w2.solid.solidAt(x, y, z) === true;
    const skyTop = (x: number, z: number): number => Math.max(w.skyTop(x, z), w2.skyTop(x, z));
    const goal = { x: 2, y: FEET, z: Z + 2 };
    const probe = (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> => Promise.resolve({ status: 'found', blocks: Math.hypot(from.x - 2.5, from.z - Z - 2.5) + 1 });
    const plan = await findLanding(goal, 'goal', { look, obstacle: obs, probe, skyTop }, { ...OPTS, sky: true, from: { x: 0, z: 0 } });
    expect(plan.kind, plan.line).toBe('cell');
    if (plan.kind !== 'cell') return;
    expect(Math.max(Math.abs(plan.cell.x), Math.abs(plan.cell.z - Z))).toBeLessThanOrEqual(4);
    expect(plan.line).toMatch(/in over what stands round it \(4\.0 s down\)/);
  }, 60_000);
});

describe('fly: whole trips onto a landing with something standing round it (flight v2, Track F14)', () => {
  it('a clearing between trunks 16 high, from 70 over it: with the setting the rim is given before the descent, the brake comes in over the trunks and the elevator goes down', () => {
    const { w, target, start } = clearing();
    const lines: string[] = [];
    for (const seed of [5, 6, 7]) {
      const r = trip(w, start, target, { seed, wayDown: true });
      lines.push(`seed ${seed}: ${r.end.ok ? 'landed' : r.end.reason} ${r.end.off.toFixed(2)} off, ${r.ticks} ticks, ${r.rockets} rockets, ${r.goArounds} go-arounds, ${r.hits} hits, touchdown vy ${r.lastAir.vy.toFixed(2)} h ${r.lastAir.h.toFixed(2)}, ${r.descents.join('; ')}`);
      expect(r.end.ok, lines.join('\n')).toBe(true);
      expect(r.end.off).toBeLessThan(0.5);
      expect(r.end.landedAt.y).toBeCloseTo(FEET, 3);
      expect(r.hits).toBe(0);
      expect(r.goArounds).toBe(0);
      expect(r.stats.landStyle).toBe('brake');
      expect(r.stats.rims).toBe(1);
      expect(-r.lastAir.vy).toBeLessThan(0.36);
      expect(r.lastAir.h).toBeLessThan(0.1);
      // the circle is the one the search simulates the way in from (radius 10 at the widest), left at that way in's height
      expect(r.descents[0]).toMatch(/^spiral r10 at 0 out/);
      expect(r.notes.some((n) => n.startsWith("descent circle r10 left 24 over the landing's floor: what stands under it reaches 16 over that floor")), r.notes.join(' | ')).toBe(true);
      expect(r.notes.some((n) => n.startsWith("way down: what stands within 14 blocks of the landing reaches 16 over its floor: in over that")), r.notes.join(' | ')).toBe(true);
    }
    console.log(lines.join('\n'));
  }, 120_000);

  it('the same trips without it are flown as they were (no rim, no line of this track)', () => {
    const { w, target, start } = clearing();
    const r = trip(w, start, target, { seed: 5 });
    expect(r.stats.rims).toBeUndefined();
    expect(r.notes.some((n) => n.startsWith('way down:'))).toBe(false);
  }, 120_000);

  it('a circle round a landing on open ground, come to from 80 over it: with the setting its first part is flown steeply, the flight is shorter and lands the same', () => {
    // a pillar 80 high 100 blocks before a landing on the flat ground: the flight arrives far over it and circles down
    // (a wall 4 high 16 blocks behind the landing: out of the rim's reach, and with it the descent is a circle, not a dive)
    const w = world([solid(-1, FEET, -1, 1, FEET + 79, 1), solid(-20, FEET, 116, 20, FEET + 3, 116)]);
    const target: LandingTarget = { x: 0.5, z: 100.5, top: FEET, half: 2 };
    const start = { x: 0.5, y: FEET + 80, z: 0.5 };
    const off = trip(w, start, target, { seed: 5 });
    const on = trip(w, start, target, { seed: 5, wayDown: true });
    for (const r of [off, on]) {
      expect(r.end.ok, r.notes.join(' | ')).toBe(true);
      expect(r.hits).toBe(0);
      expect(r.goArounds).toBe(0);
      expect(r.descents[0]).toMatch(/^spiral r24 at 0 out from \d+ above/);
      expect(-r.lastAir.vy).toBeLessThan(0.36);
    }
    // nothing stands round it: no rim; the circle alone is flown faster
    expect(on.stats.rims).toBeUndefined();
    expect(on.ticks).toBeLessThan(off.ticks - 40);
  }, 120_000);

  it('flights the track does not touch are the same tick for tick with the setting on: open ground, a platform in the air, a fence line on the ground', () => {
    const cases: { boxes: BlockBox[]; target: LandingTarget }[] = [
      { boxes: [solid(-1, FEET, -1, 1, FEET + 39, 1)], target: { x: 0.5, z: 200.5, top: FEET, half: 2 } },
      { boxes: [solid(-1, FEET, -1, 1, FEET + 39, 1), solid(-2, FEET + 20, 198, 2, FEET + 20, 202)], target: { x: 0.5, z: 200.5, top: FEET + 21, half: 2 } },
      { boxes: [solid(-1, FEET, -1, 1, FEET + 39, 1), solid(-8, FEET, 206, 8, FEET + 1, 206)], target: { x: 0.5, z: 200.5, top: FEET, half: 2 } },
    ];
    for (const c of cases) {
      const w = world(c.boxes);
      const start = { x: 0.5, y: FEET + 40, z: 0.5 };
      const off = trip(w, start, c.target, { seed: 9 });
      const on = trip(w, start, c.target, { seed: 9, wayDown: true });
      expect(on.ticks).toBe(off.ticks);
      expect(on.end.landedAt).toEqual(off.end.landedAt);
      expect(on.rockets).toBe(off.rockets);
      expect(on.stats.rims).toBeUndefined();
    }
  }, 120_000);

  it('a missed approach whose plan met a wall beyond the landing\'s own reach: the columns out to that wall are its rim, the go-around is flown over them and the body comes back in over them', () => {
    // a ridge 9 high across the way in, 24 to 26 blocks before the landing: nothing stands within 14 of it
    const Z = 200;
    const w = world([solid(-1, FEET, -1, 1, FEET + 39, 1), solid(-40, FEET, Z - 26, 40, FEET + 8, Z - 24)]);
    const target: LandingTarget = { x: 0.5, z: Z + 0.5, top: FEET, half: 2, walk: true, cells: new Set([-2, -1, 0, 1, 2].flatMap((dx) => [-2, -1, 0, 1, 2].map((dz) => columnKey(dx, Z + dz)))), walkS: 5, walkKnown: true };
    expect(landingRim(target, w.skyTop).why).toBe('low');
    const brain = new FlightBrain(target, { cruiseY: FEET + 40, skyTop: w.skyTop, obstacle: (x, y, z) => w.solid.solidAt(x, y, z) === true, wayDown: true });
    // the miss, as the approach meets it: the body low before the ridge, its plans into the ridge
    const lookRim = (brain as unknown as { lookRim(b: object, reach: number, said: string): boolean }).lookRim.bind(brain);
    const body = { pos: { x: 0.5, y: FEET + 6, z: Z - 40 }, vel: { x: 0, y: -0.1, z: 0.6 }, onGround: false, gliding: true, boostTicks: 0 };
    expect(lookRim(body, Math.min(OVER.far, 25 + 4), 'no approach along the ground (flare wall 25 from the centre)')).toBe(true);
    expect(brain.target.rim).toBe(FEET + 9);
    expect(brain.target.rimWithin).toBeCloseTo(rimReach(target), 6);
    expect(brain.targetWhy).toBe('the same landing, flown in over what stands round it');
    // a second look gives nothing more
    expect(lookRim(body, OVER.far, 'again')).toBe(false);
    // the whole trip: low over the ridge's far side the flight ends on the landing, with at most one go-around
    const r = trip(w, { x: 0.5, y: FEET + 40, z: 0.5 }, target, { seed: 5, wayDown: true });
    expect(r.end.ok, `${r.end.ok ? '' : r.end.reason} ${r.notes.join(' | ')}`).toBe(true);
    expect(r.goArounds).toBeLessThanOrEqual(1);
    expect(r.hits).toBe(0);
  }, 120_000);

  it("the landing stays the one its rim was given to when its circle is left: the go-around's own chance goes with it", () => {
    const { w, target, Z } = clearing();
    const brain = new FlightBrain(target, { cruiseY: FEET + 70, skyTop: w.skyTop, obstacle: (x, y, z) => w.solid.solidAt(x, y, z) === true, wayDown: true });
    const priv = brain as unknown as { lookRim(b: object): boolean; leftOver(fit: object, tops: object, inward: boolean, aim: LandingTarget, b: object): void; rimGiven: LandingTarget | undefined };
    const body = { pos: { x: 0.5, y: FEET + 60, z: Z - 100 }, vel: { x: 0, y: -0.1, z: 1.2 }, onGround: false, gliding: true, boostTicks: 0 };
    expect(priv.lookRim(body)).toBe(true);
    const given = brain.target;
    expect(given.rim).toBe(FEET + 16);
    expect(priv.rimGiven).toBe(given);
    // (looked at once: the same look again gives nothing)
    expect(priv.lookRim(body)).toBe(false);
    priv.leftOver({ centre: { x: target.x, z: target.z }, radius: 10 }, { ring: FEET + 16, top: FEET + 16 }, true, given, { ...body, pos: { x: 10.5, y: FEET + 24, z: Z } });
    expect(brain.target).not.toBe(given);
    expect(brain.target.rim).toBe(FEET + 16);
    expect(priv.rimGiven).toBe(brain.target);
    expect(priv.lookRim(body)).toBe(false);
  });

  it('a landing under a roof that a flight was sent to: the nearest safe ground, and the line says that nothing comes down onto it', () => {
    // a cavern under a mesa 40 high: its floor has 22 of room; the flight holds over it and is given that floor
    const Z = 200;
    const w = world([solid(-1, FEET, -1, 1, FEET + 69, 1), solid(-30, FEET, Z - 30, 30, FEET + 39, Z + 30), hollow(-4, FEET, Z - 4, 4, FEET + 21, Z + 4)]);
    const cells = new Set<number>();
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) cells.add(columnKey(dx, Z + dz));
    const site: LandingTarget = { x: 0.5, z: Z + 0.5, top: FEET, half: 3, cells, walk: true, walkS: 4, walkKnown: true };
    for (const wayDown of [false, true]) {
      const held: LandingTarget = { x: 30.5, z: Z + 0.5, top: FEET, half: 1, hold: true };
      let given = false;
      const r = trip(w, { x: 0.5, y: FEET + 70, z: 0.5 }, held, {
        seed: 5,
        wayDown,
        retarget: (t, pos) => {
          if (given || Math.hypot(pos.x - 30.5, pos.z - Z - 0.5) > 40) return undefined;
          given = true;
          return site;
        },
      });
      expect(r.end.ok).toBe(false);
      if (r.end.ok) return;
      expect(r.end.reason).toBe('landed_off');
      expect(r.end.why ?? '', r.notes.join(' | ')).toMatch(/^the landing lies under a roof 22 over its floor, the ground over it reaches 40 over that floor: no flight comes down onto it/);
      expect(r.notes.some((n) => /^land now: the nearest safe ground instead of a go-around; .*the landing lies under a roof 22 over its floor/.test(n) || /^no go-around left .*the landing lies under a roof/.test(n)), r.notes.join(' | ')).toBe(true);
      expect(r.hits).toBe(0);
    }
  }, 120_000);
});

describe('fly: the price of a go-around flown back in over a rim, and the setting (flight v2, Track F14)', () => {
  it("the first go-around of a landing with a given rim has its own chance; a repeat the measured repeat's", () => {
    expect(GOAROUND_P_OVER).toBeGreaterThan(GOAROUND_P.wall);
    expect(goAroundChance('wall')).toBe(GOAROUND_P.wall);
    expect(goAroundChance('wall', undefined, GOAROUND_P_OVER)).toBe(GOAROUND_P_OVER);
    expect(goAroundChance('wall', 'wall', GOAROUND_P_OVER)).toBe(GOAROUND_P_REPEAT);
    expect(goAroundChance('none', 'wall', GOAROUND_P_OVER)).toBeCloseTo(GOAROUND_P_OVER / 2);
    // 20 s of walk saved: at the wall's chance no go-around (3.8 s), at the rim's one (18 s)
    const q = { kind: 'wall' as const, targetWalkS: 5, offers: [{ what: 'the nearest safe ground', walkS: 25, extraS: 0 }], canGoAround: true };
    expect(decideGoAround(q).goAround).toBe(false);
    const over = decideGoAround({ ...q, chance: GOAROUND_P_OVER });
    expect(over.goAround).toBe(true);
    expect(over.line).toMatch(new RegExp(`P ${GOAROUND_P_OVER.toFixed(2)} to land 5\\.0 s of walk from the goal\\): saves 18\\.0 s > ${GOAROUND_COST_S.toFixed(1)} s: going round`));
    // 5 s saved is not worth it at any chance
    expect(decideGoAround({ ...q, offers: [{ what: 'the nearest safe ground', walkS: 10, extraS: 0 }], chance: GOAROUND_P_OVER }).goAround).toBe(false);
  });

  it('the setting flyWayDown is off by default and listed with the flight settings', () => {
    expect(SETTING_DEFS.flyWayDown.default).toBe(false);
    expect(SETTING_DEFS.flyWayDown.kind).toBe('boolean');
    expect(SETTING_GROUPS.find(([g]) => g === 'flight')?.[1]).toContain('flyWayDown');
  });
});
