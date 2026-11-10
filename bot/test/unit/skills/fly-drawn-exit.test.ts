// Track F9d (docs/flight.md "Drawn lines (Track F9d)", decisions/0081-drawn-lines.md): the way out of a cave nobody
// recorded. Guarded here on synthetic caves (nothing of anybody's world): the flood to the sky and the line drawn from it
// (learn/draw.ts), proven as a recorded line is and flown by the same follower (route/takeoff.ts, glide.ts routeTakeoff,
// brain.ts guideTakeoff): a straight passage, a passage with a bend, a shaft straight up, a hall with two exits (the
// proof picks), caves with no line (the takeoff goes on as before), and a wall set on a line after it was drawn.
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import type { Vec3 } from '../../../src/connection/types.ts';
import { LEARNED_PROOF_BURNS, LEARNED_PROOF_DUDS, LEARNED_PROOF_MIXES, routeTakeoff, routeTakeoffOptions, simulateFlight, type SimDeps } from '../../../src/skills/fly/glide.ts';
import { DRAW_HEADROOM, DRAW_ROCKET_TICK, drawExits, drawLine, floodOut, pull, resample, rise } from '../../../src/skills/fly/learn/draw.ts';
import { guideLength, guideSaid } from '../../../src/skills/fly/learn/guide.ts';
import { cruiseHeight, type CellQuery, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { gridOf } from '../../../src/skills/fly/route/grid.ts';
import { planRoute } from '../../../src/skills/fly/route/search.ts';
import { DRAWN_TRIES, planTakeoffRoute, type TakeoffProof, type TakeoffRoute } from '../../../src/skills/fly/route/takeoff.ts';
import { flatWorld, withBoxes, type BlockBox, type BlockQuery } from '../../../src/skills/input/index.ts';

const FEET = -60;
const SLOW = 120_000;

function rig(boxes: BlockBox[]) {
  const world: BlockQuery = withBoxes(flatWorld(), boxes);
  const cell: CellQuery = (x, y, z) => world.solidAt(x, y, z);
  const skyTop = (x: number, z: number): number => {
    for (let y = 200; y >= -64; y--) if (world.solidAt(x, y, z)) return y;
    return -64;
  };
  const groundAt = (x: number, z: number, fromY = 200): number => {
    for (let y = Math.floor(fromY); y >= -64; y--) if (world.solidAt(x, y, z)) return y + 1;
    return -63;
  };
  const deps: SimDeps & { cell: CellQuery } = { world, cell, skyTop, groundAt };
  return { world, deps, grid: gridOf(world), skyTop };
}

/** A mesa 46 high with a hall 17 x 17 and 20 high in its middle. */
const mesa: BlockBox[] = [
  { from: { x: -40, y: FEET, z: -40 }, to: { x: 40, y: FEET + 45, z: 40 }, solid: true },
  { from: { x: -8, y: FEET, z: -8 }, to: { x: 8, y: FEET + 19, z: 8 }, solid: false },
];
/** A passage 9 wide and 10 high from the hall's west wall out to the open air, and the same to the east. */
const west: BlockBox = { from: { x: -40, y: FEET, z: -4 }, to: { x: -9, y: FEET + 9, z: 4 }, solid: false };
const east: BlockBox = { from: { x: 9, y: FEET, z: -4 }, to: { x: 40, y: FEET + 9, z: 4 }, solid: false };
/** A shaft 9 x 9 from the hall's roof up through the mesa's top. */
const shaft: BlockBox = { from: { x: -4, y: FEET + 20, z: -4 }, to: { x: 4, y: FEET + 45, z: 4 }, solid: false };
const HALL: Vec3 = { x: 4.5, y: FEET, z: 4.5 };
const target: LandingTarget = { x: 0.5, z: 600.5, top: FEET, half: 1 };

function prover(r: ReturnType<typeof rig>, from: Vec3, cruiseY: number, count?: { sims: number }): TakeoffProof {
  return async (route: TakeoffRoute) => {
    const p = await routeTakeoff(r.deps, from, target, { cruiseY }, 64, { route: { grid: r.grid, plan: (req) => planRoute(req, r.grid), maxMs: SLOW }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks });
    if (count) count.sims += p.sims;
    return p;
  };
}

async function fly(r: ReturnType<typeof rig>, from: Vec3, cruiseY: number, route: TakeoffRoute, burn: number) {
  const notes: string[] = [];
  const sim = await simulateFlight(r.deps, from, target, { cruiseY, takeoffYaw: route.yaw, route: { grid: r.grid, plan: (req) => planRoute(req, r.grid), maxMs: SLOW }, routeTakeoff: routeTakeoffOptions(route, true), note: (m) => notes.push(m) }, { rockets: 64, yaw: route.yaw, maxTicks: 400, burn, endLag: 2, until: (b) => b.phase === 'approach' });
  return { sim, notes, hits: sim.hits - (sim.bumps ?? 0) };
}

const cruise = (r: ReturnType<typeof rig>, from: Vec3): number => cruiseHeight(from, target, r.skyTop, {}).y;

describe('fly: a line drawn from the flood (Track F9d)', () => {
  it('the flood finds the way to the sky by cost: under the roof only, through cells with room, the cheapest way out first', () => {
    const r = rig([...mesa, west]);
    const f = floodOut(r.grid, HALL, FEET + 80);
    expect(f.ways.length).toBe(1);
    const w = f.ways[0]!;
    // out at the passage's mouth, west of the mesa
    expect(w.x).toBeLessThan(-40);
    expect(w.way[0]).toEqual({ x: 4, y: FEET, z: 4 });
    expect(w.way[w.way.length - 1]).toEqual({ x: w.x, y: w.y, z: w.z });
    // steps go diagonally too: fewer cells than blocks of taxicab way
    expect(w.steps).toBeLessThan(Math.abs(w.x - 4) + 4);
    // a sealed hall: nothing
    expect(floodOut(rig(mesa).grid, HALL, FEET + 80).ways.length).toBe(0);
    // a crack one cell wide is no way for a gliding body
    const crack: BlockBox = { from: { x: -40, y: FEET, z: 0 }, to: { x: -9, y: FEET + 9, z: 0 }, solid: false };
    expect(floodOut(rig([...mesa, crack]).grid, HALL, FEET + 80).ways.length).toBe(0);
  });

  it('the line: a slope from the takeoff to the exit inside the passage, pulled straight, a block apart, one rocket, open sky at its end', () => {
    const r = rig([...mesa, west]);
    const top = FEET + 80;
    const way = floodOut(r.grid, HALL, top).ways[0]!;
    const heights = rise(r.grid, way, HALL.y + 1, 0.9);
    expect(heights.length).toBe(way.way.length - 1);
    // every point inside its passage with the berth, none under the takeoff's height (the exit is no lower)
    for (const p of heights) {
      expect(p.y).toBeGreaterThanOrEqual(HALL.y + 1 - 1e-9);
      expect(r.grid.solid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))).toBe(false);
    }
    // pulled straight: far fewer corners than cells
    const pulled = pull(r.grid, [{ x: HALL.x, y: HALL.y + 1, z: HALL.z }, ...heights], 0.9);
    expect(pulled.length).toBeLessThan(heights.length / 3);
    const line = resample(pulled);
    for (let i = 1; i < line.length - 1; i++) expect(Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y, line[i]!.z - line[i - 1]!.z)).toBeCloseTo(1, 1);
    const d = drawExits(r.grid, HALL, top);
    expect(d.ways).toBe(1);
    expect(d.lines.length).toBeGreaterThan(0);
    const l = d.lines[0]!;
    expect(l.guide.drawn).toBe(true);
    expect(l.guide.grounded).toBe(true);
    expect(l.guide.points[0]).toEqual(HALL);
    expect(l.guide.rockets).toEqual([{ tick: DRAW_ROCKET_TICK, at: 1 }]);
    expect(guideSaid(l.guide)).toBe(`the drawn line ${l.guide.path}`);
    expect(l.open).toBeGreaterThan(30);
    expect(guideLength(l.guide)).toBeGreaterThan(l.open + 6);
    // the roll's ticks: the line's own clock
    for (let i = 1; i < l.guide.ticks.length; i++) expect(l.guide.ticks[i]!).toBeGreaterThanOrEqual(l.guide.ticks[i - 1]!);
    expect(l.ticks).toBeGreaterThan(15);
    expect(l.ticks).toBeLessThan(80);
  });

  it('a straight passage: drawn, proven at every burn, the mixes and a first rocket that fires nothing, and flown out with no hit', async () => {
    const r = rig([...mesa, west]);
    const from: Vec3 = { x: -12.5, y: FEET, z: 0.5 };
    const cz = cruise(r, from);
    const count = { sims: 0 };
    const got = await planTakeoffRoute(r.grid, from, target, { rockets: 4, maxMs: SLOW, prove: prover(r, from, cz, count), drawn: { top: Math.ceil(cz) }, tries: 0, budgetMs: SLOW });
    expect(got.route?.guide, got.tried.join(' | ')).toBeDefined();
    expect(got.route!.proven).toBe(true);
    expect(got.route!.drawn).toBeDefined();
    expect(got.drawn!.ways).toBe(1);
    expect(count.sims % (1 + LEARNED_PROOF_BURNS.length + LEARNED_PROOF_MIXES.length + LEARNED_PROOF_DUDS.length)).toBe(0);
    expect(got.tried[got.tried.length - 1]).toMatch(/^the drawn way out drawn \d+ \(to .*: clear at burns of 15, 9, 21, 12, 18, 10, 11, 13, 14, 16, 17, 19, 20 ticks and of 21 then 9, 9 then 21 and with a first rocket that fires nothing/);
    for (const burn of [9, 15, 21]) {
      const f = await fly(r, from, cz, got.route!, burn);
      expect(f.sim.stats.routeTakeoffEnd, f.notes.join(' | ')).toBe('out');
      expect(f.hits, f.notes.join(' | ')).toBe(0);
      expect(f.sim.end, f.notes.join(' | ')).toBeUndefined();
      expect(f.notes.some((n) => n.startsWith('route takeoff: out along the drawn line'))).toBe(true);
      expect(f.notes.some((n) => n.startsWith("drawn line: rocket 1 asked for") && n.includes("the takeoff's"))).toBe(true);
    }
  }, 240_000);

  it('a passage with a bend: from the hall, round into the passage and out', async () => {
    const r = rig([...mesa, west]);
    const cz = cruise(r, HALL);
    const got = await planTakeoffRoute(r.grid, HALL, target, { rockets: 4, maxMs: SLOW, prove: prover(r, HALL, cz), drawn: { top: Math.ceil(cz) }, tries: 0, budgetMs: SLOW });
    expect(got.route?.guide, got.tried.join(' | ')).toBeDefined();
    for (const burn of [9, 12, 15, 18, 21]) {
      const f = await fly(r, HALL, cz, got.route!, burn);
      expect(f.sim.stats.routeTakeoffEnd, f.notes.join(' | ')).toBe('out');
      expect(f.hits, f.notes.join(' | ')).toBe(0);
      expect(f.sim.end).toBeUndefined();
    }
  }, 240_000);

  it('a shaft straight up to the sky: the line goes under it and up, and the climb goes on straight up until a heading clears', async () => {
    const r = rig([...mesa, shaft]);
    // (from the hall's corner: the shaft is over its middle)
    const from: Vec3 = { x: 7.5, y: FEET, z: 7.5 };
    const cz = cruise(r, from);
    const got = await planTakeoffRoute(r.grid, from, target, { rockets: 4, maxMs: SLOW, prove: prover(r, from, cz), drawn: { top: Math.ceil(cz) }, tries: 0, budgetMs: SLOW });
    expect(got.route?.guide, got.tried.join(' | ')).toBeDefined();
    const g = got.route!.guide!.line;
    // the line's end is under the shaft and goes up
    const end = g.points[g.points.length - 1]!;
    expect(Math.abs(end.x)).toBeLessThan(5);
    expect(Math.abs(end.z)).toBeLessThan(5);
    expect(end.y).toBeGreaterThan(g.points[Math.round(got.route!.guide!.open)]!.y + 3);
    for (const burn of [9, 15, 21]) {
      const f = await fly(r, from, cz, got.route!, burn);
      expect(f.sim.stats.routeTakeoffEnd, f.notes.join(' | ')).toBe('out');
      expect(f.hits, f.notes.join(' | ')).toBe(0);
      expect(f.sim.end, f.notes.join(' | ')).toBeUndefined();
      expect(f.notes.some((n) => n.includes('straight up until the path ahead clears')), f.notes.join(' | ')).toBe(true);
      // up through the shaft and over the mesa's top
      expect(f.sim.stats.maxY).toBeGreaterThan(FEET + 46);
      expect(f.notes.some((n) => n.startsWith('route takeoff: up out of the pit')), f.notes.join(' | ')).toBe(true);
    }
  }, 240_000);

  it('a hall with two exits: both are drawn, and the proof picks', async () => {
    const r = rig([...mesa, west, east]);
    const from: Vec3 = { x: 0.5, y: FEET, z: 0.5 };
    const cz = cruise(r, from);
    const d = drawExits(r.grid, from, Math.ceil(cz));
    expect(d.ways).toBe(2);
    expect(d.lines.some((l) => l.exit.x < -40)).toBe(true);
    expect(d.lines.some((l) => l.exit.x > 40)).toBe(true);
    const real = prover(r, from, cz);
    // the first line drawn is refused by its proof (here: said so): the next exit's is taken
    const first = d.lines[0]!.exit.x < 0 ? 'west' : 'east';
    const picky: TakeoffProof = async (route) => ((route.exit.x < 0 ? 'west' : 'east') === first ? { ok: false, line: 'hits a solid 1 time', sims: 1 } : real(route));
    const got = await planTakeoffRoute(r.grid, from, target, { rockets: 4, maxMs: SLOW, prove: picky, drawn: { top: Math.ceil(cz), tries: 12 }, tries: 0, budgetMs: SLOW });
    expect(got.route?.guide, got.tried.join(' | ')).toBeDefined();
    expect(got.route!.exit.x < 0 ? 'west' : 'east').not.toBe(first);
    expect(got.tried.some((t) => t.endsWith('hits a solid 1 time: refused'))).toBe(true);
    // unhindered, the quickest line that proves clear is the one flown
    const plain = await planTakeoffRoute(r.grid, from, target, { rockets: 4, maxMs: SLOW, prove: real, drawn: { top: Math.ceil(cz) }, tries: 0, budgetMs: SLOW });
    expect(plain.route?.guide).toBeDefined();
    expect(DRAWN_TRIES).toBe(3);
  }, 240_000);

  it('no line: a sealed cave, a start too low to jump, nothing drawn without the option; the takeoff then goes on as before', async () => {
    const sealed = rig(mesa);
    const cz = cruise(sealed, HALL);
    const none = await planTakeoffRoute(sealed.grid, HALL, target, { rockets: 4, maxMs: SLOW, prove: prover(sealed, HALL, cz), drawn: { top: Math.ceil(cz) } });
    const plain = await planTakeoffRoute(sealed.grid, HALL, target, { rockets: 4, maxMs: SLOW, prove: prover(sealed, HALL, cz) });
    expect(none.route).toBeUndefined();
    expect(none.tried[0]).toMatch(/^no way under the roof to the open sky \(a flood of \d+ cells, within \d+\)$/);
    expect(none.drawn).toMatchObject({ lines: 0, ways: 0 });
    // the same exits and lines after it as without the option
    expect(none.exits).toBe(plain.exits);
    const timeless = (t: string[]): string[] => t.map((x) => x.replace(/[\d.]+ ms/g, 'N ms'));
    expect(timeless(none.tried.slice(1))).toEqual(timeless(plain.tried));
    expect(plain.drawn).toBeUndefined();
    // a start under a roof two above: a jump takes no glide there
    const low = rig([...mesa, west, { from: { x: 4, y: FEET + 2, z: 4 }, to: { x: 4, y: FEET + 2, z: 4 }, solid: true }]);
    const way = floodOut(low.grid, HALL, FEET + 80).ways[0]!;
    expect(drawLine(low.grid, HALL, way, FEET + 80, 0.9)).toBe(`only 2 of air over the start (a jump needs ${DRAW_HEADROOM} to take a glide)`);
    // nothing drawn is taken unproven
    const r = rig([...mesa, west]);
    const unproven = await planTakeoffRoute(r.grid, HALL, target, { rockets: 4, maxMs: SLOW, drawn: { top: Math.ceil(cz) }, tries: 0 });
    expect(unproven.route).toBeUndefined();
    expect(unproven.drawn).toBeUndefined();
    expect(SETTING_DEFS.flyCaveExit.default).toBe(false);
  }, 240_000);

  it('a wall set across the line after it was drawn: the proof refuses it, and a flight along it stops and lands under the roof', async () => {
    const then = rig([...mesa, west]);
    const cz = cruise(then, HALL);
    const route = (await planTakeoffRoute(then.grid, HALL, target, { rockets: 4, maxMs: SLOW, prove: prover(then, HALL, cz), drawn: { top: Math.ceil(cz) }, tries: 0, budgetMs: SLOW })).route!;
    expect(route.guide).toBeDefined();
    const now = rig([...mesa, west, { from: { x: -25, y: FEET, z: -4 }, to: { x: -25, y: FEET + 9, z: 4 }, solid: true }]);
    const proof = await prover(now, HALL, cz)(route);
    expect(proof.ok).toBe(false);
    expect(proof.line).toMatch(/the way out ended off the line|hits a solid/);
    const f = await fly(now, HALL, cz, route, 15);
    expect(f.sim.stats.routeTakeoffEnd).toBe('off the line');
    expect(f.notes.some((n) => /^route takeoff: the drawn line .* lost after \d+ ticks .*: no climb without the line here, landing$/.test(n)), f.notes.join(' | ')).toBe(true);
    // it does not fly into the wall and never climbs blind: it brakes short of it and lands under the roof
    expect(f.sim.end && !f.sim.end.ok ? f.sim.end.reason : undefined, f.notes.join(' | ')).toBe('roof');
    expect(f.sim.stats.routeSkyAt).toBeUndefined();
    expect(f.sim.body.pos.x, f.notes.join(' | ')).toBeGreaterThan(-24.5);
    // and drawn again in the cave as it is now: there is no way out any more
    const again = await planTakeoffRoute(now.grid, HALL, target, { rockets: 4, maxMs: SLOW, prove: prover(now, HALL, cz), drawn: { top: Math.ceil(cz) }, tries: 0 });
    expect(again.route).toBeUndefined();
    expect(again.tried[0]).toMatch(/^no way under the roof to the open sky/);
  }, 240_000);
});
