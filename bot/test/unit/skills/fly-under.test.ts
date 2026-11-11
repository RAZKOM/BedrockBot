// Track F9e round 2 (docs/flight.md "What the Realm showed (Track F9e, round 2)", decisions/0082 addendum): the burn of
// the rockets at hand (skills/fly/burn.ts), and a flight under a roof decided on the bot's two layers (learn/under.ts):
// the live model and the world cache behind it. Guarded on a synthetic tunnel (nothing of anybody's world): the whole way
// when it lies in the live model, a piece of it when the live model ends on the way (standing short of where it ends,
// every point of its line in the live model), nothing with no live model at all, a block that only the live model has,
// and the flood that does not take a tree's canopy for a cave's roof.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/connection/types.ts';
import { BURN_PLAIN, burnOfHotbar, burnRange, burnSaid, proofBurns, proofDuds, proofMixes } from '../../../src/skills/fly/burn.ts';
import { LEARNED_PROOF_BURNS, routeTakeoffOptions, simulateFlight, type SimDeps } from '../../../src/skills/fly/glide.ts';
import { floodTo } from '../../../src/skills/fly/learn/draw.ts';
import { ENTRY_AIR, ENTRY_SOLID } from '../../../src/skills/fly/learn/entry.ts';
import { HOP_LAST_FROM, HOP_LAST_TO, HOP_MIN, hopLast } from '../../../src/skills/fly/learn/hop.ts';
import { hopTarget, liveGrid, liveReach, pickHop, standNear, UNDER_STOP, type UnderWorld } from '../../../src/skills/fly/learn/under.ts';
import { gridOf } from '../../../src/skills/fly/route/grid.ts';
import { flatWorld, withBoxes, type BlockBox, type BlockQuery } from '../../../src/skills/input/index.ts';

const FEET = -60;
const air = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ from: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) }, to: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) }, solid: false });
const rock = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ ...air(x0, y0, z0, x1, y1, z1), solid: true });
const noPlan = (): never => {
  throw new Error('a line under a roof asks no planner');
};

/** A tunnel 9 wide and 8 high from x 0 to 300 through a slab 60 thick; `extra` boxes after it. The live model: the columns up to `liveTo` in x. */
function tunnel(liveTo: number, extra: BlockBox[] = [], liveOnly: BlockBox[] = []) {
  const boxes = [rock(-30, FEET, -40, 330, FEET + 59, 40), air(0, FEET, -4, 300, FEET + 7, 4), ...extra];
  const cache: BlockQuery = withBoxes(flatWorld(), boxes);
  const now: BlockQuery = withBoxes(flatWorld(), [...boxes, ...liveOnly]);
  const state = { liveTo };
  const cls = (q: BlockQuery, x: number, y: number, z: number): number => (q.solidAt(x, y, z) ? ENTRY_SOLID : ENTRY_AIR);
  const w: UnderWorld = { live: (x, y, z) => (x <= state.liveTo ? cls(now, x, y, z) : undefined), cached: (x, y, z) => cls(cache, x, y, z) };
  const sim: SimDeps = { world: { solidAt: (x, y, z) => (x <= state.liveTo ? now.solidAt(x, y, z) === true : true) } };
  const o = { rockets: 64, burn: burnRange(1), margin: 15, top: FEET + 100, plan: noPlan };
  return { w, sim, o, state, cache };
}
const from: Vec3 = { x: 0.5, y: FEET, z: 0.5 };
const goal = { x: 296, y: FEET, z: 0 };

describe('fly: the burn of the rockets at hand (Track F9e round 2)', () => {
  it('a rocket with no flight duration burns 9 to 21 ticks, a crafted one ten more a step; the proof flies every burn of the range', () => {
    expect(burnRange()).toEqual({ min: 9, max: 21, nominal: 15 });
    expect(burnRange(1)).toEqual({ min: 19, max: 31, nominal: 25 });
    expect(burnRange(3)).toEqual({ min: 39, max: 51, nominal: 45 });
    // the plain rocket's proof is what it was
    expect(proofBurns(BURN_PLAIN)).toEqual([...LEARNED_PROOF_BURNS]);
    expect(proofMixes(BURN_PLAIN)).toEqual([[21, 9], [9, 21]]);
    expect(proofDuds(BURN_PLAIN)).toEqual([15, 9, 21]);
    const crafted = proofBurns(burnRange(1));
    expect(crafted.slice(0, 4)).toEqual([19, 31, 22, 28]);
    expect([...crafted, 25].sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_v, i) => 19 + i));
    expect(burnSaid(BURN_PLAIN)).toBe('9 to 21');
    expect(burnSaid(burnRange(1))).toBe('19 to 31 (flight duration 1)');
  });

  it('the hotbar: the rockets there are; of two kinds, from the shortest burn to the longest; and the last rocket of a hop goes farther before the touchdown', () => {
    const is = (n: string): boolean => n === 'firework_rocket';
    expect(burnOfHotbar([null, { name: 'firework_rocket', count: 12 }], is)).toEqual({ min: 9, max: 21, nominal: 15 });
    expect(burnOfHotbar([{ name: 'firework_rocket', count: 40, flight: 1 }, { name: 'dirt', count: 64 }], is)).toEqual({ min: 19, max: 31, nominal: 25 });
    expect(burnOfHotbar([{ name: 'firework_rocket', count: 40, flight: 1 }, { name: 'firework_rocket', count: 3 }], is)).toEqual({ min: 9, max: 31, nominal: 25 });
    expect(burnOfHotbar([], is)).toEqual(BURN_PLAIN);
    expect(hopLast()).toEqual({ from: HOP_LAST_FROM, to: HOP_LAST_TO, min: HOP_MIN });
    expect(hopLast(burnRange(1))).toEqual({ from: 73, to: 61, min: 65 });
  });
});

describe('fly: a hop decided on the live model and the world cache (Track F9e round 2)', () => {
  it('the whole way in the live model: one hop to the goal, drawn and proven with the kit\'s burn', async () => {
    const t = tunnel(400);
    const pick = await pickHop(t.w, t.sim, from, goal, 'the goal', t.o);
    expect(pick.hop, pick.said).toBeDefined();
    expect(pick.hop!.piece).toBeUndefined();
    expect(pick.hop!.length).toBeGreaterThan(280);
    expect(pick.hop!.drawn.guide.burn).toEqual(burnRange(1));
    expect(pick.said).toContain('standing within');
    expect(pick.said).toContain('at burns of 25, 19, 31, 22, 28,');
    // the last rocket's place is the crafted rocket's
    expect(pick.hop!.drawn.guide.hop!.to).toBeCloseTo(pick.hop!.length - 61, 0);
  }, 120_000);

  it('the live model ends on the way: a piece of it, standing short of where it ends, every point of its line in the live model; then the rest from there', async () => {
    const t = tunnel(150);
    const pick = await pickHop(t.w, t.sim, from, goal, 'the goal', t.o);
    const h = pick.hop;
    expect(h, pick.said).toBeDefined();
    expect(h!.piece, pick.said).toBeDefined();
    expect(h!.cell.x).toBeLessThanOrEqual(150 - UNDER_STOP + 3);
    expect(h!.cell.x).toBeGreaterThan(60);
    for (const p of h!.drawn.guide.points) expect(t.w.live(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))).toBe(ENTRY_AIR);
    expect(pick.said).toContain('a piece');
    // flown at the two ends of the burn: standing by the piece's cell with no hard hit
    let stood: Vec3 | undefined;
    for (const ticks of [19, 31]) {
      const sim = await simulateFlight(t.sim, from, hopTarget(h!.drawn, h!.cell), { cruiseY: from.y + 24, margin: 15, goArounds: 0, takeoffYaw: h!.drawn.guide.yaw, route: { grid: liveGrid(t.w), plan: noPlan }, routeTakeoff: routeTakeoffOptions(h!.route, true) }, { rockets: 64, yaw: h!.drawn.guide.yaw, maxTicks: 800, burn: ticks, endLag: 2 });
      expect(sim.end?.ok, `burn ${ticks}`).toBe(true);
      expect(Math.hypot(sim.end!.landedAt.x - h!.cell.x - 0.5, sim.end!.landedAt.z - h!.cell.z - 0.5)).toBeLessThanOrEqual(2);
      expect(sim.hard ?? 0).toBe(0);
      stood = sim.end!.landedAt;
    }
    // the body stands there, the chunks ahead have come: the rest of the way as one hop
    t.state.liveTo = 400;
    const next = await pickHop(t.w, t.sim, stood!, goal, 'the goal', t.o);
    expect(next.hop, next.said).toBeDefined();
    expect(next.hop!.piece).toBeUndefined();
  }, 180_000);

  it('no live model at all (a body that has just arrived): nothing is flown, and the line says where the live model ends', async () => {
    const t = tunnel(-1000);
    const pick = await pickHop(t.w, t.sim, from, goal, 'the goal', t.o);
    expect(pick.hop).toBeUndefined();
    expect(pick.sims).toBe(0);
    expect(pick.said).toContain('the live model ends 0 cells along a way of');
    expect(pick.said).toContain('-> no hop');
  });

  it('a block only the live model has: across the whole passage there is no way; beside it the line goes round, through no cell of it', async () => {
    const shut = tunnel(400, [], [rock(120, FEET, -4, 122, FEET + 7, 4)]);
    const wall = await pickHop(shut.w, shut.sim, from, goal, 'the goal', shut.o);
    expect(wall.hop).toBeUndefined();
    expect(wall.said).toContain('no way under the roof');
    const t = tunnel(400, [], [rock(120, FEET, -4, 122, FEET + 7, -1)]);
    const round = await pickHop(t.w, t.sim, from, goal, 'the goal', t.o);
    expect(round.hop, round.said).toBeDefined();
    for (const p of round.hop!.drawn.guide.points) expect(t.w.live(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))).toBe(ENTRY_AIR);
  }, 120_000);

  it('where the live model ends, and a floor to stand on under the way', () => {
    const t = tunnel(100);
    const way = Array.from({ length: 200 }, (_v, i) => ({ x: i, y: FEET + 4, z: 0 }));
    expect(liveReach(t.w, way)).toBe(98);
    expect(liveReach(tunnel(400).w, way)).toBe(200);
    const s = standNear(t.w, { x: 50, y: FEET + 4, z: 0 });
    expect(s?.cell).toEqual({ x: 50, y: FEET, z: 0 });
    expect(s?.down.length).toBe(4);
    // over a pit: no floor within reach under the way
    const pool = tunnel(400, [], [air(40, FEET - 14, -4, 60, FEET - 1, 4)]);
    expect(standNear(pool.w, { x: 50, y: FEET + 4, z: 0 })).toBeUndefined();
  });
});

describe('fly: the flood to a cell and a canopy (Track F9e round 2)', () => {
  it('a thin roof beside the cave\'s mouth (a forest\'s canopy) is no cave: the search does not run under it', () => {
    // the tunnel opens at x 0 onto open ground under a canopy one block thick, 200 by 200
    const boxes = [rock(-30, FEET, -40, 330, FEET + 59, 40), air(-30, FEET, -4, 300, FEET + 7, 4), rock(-230, FEET + 6, -100, -31, FEET + 6, 100)];
    const grid = gridOf(withBoxes(flatWorld(), boxes));
    const f = floodTo(grid, { x: 20.5, y: FEET, z: 0.5 }, goal, { top: FEET + 100, radius: 320, max: 150_000 });
    expect(f.way).toBeDefined();
    expect(f.cells).toBeLessThan(30_000);
  });
});
