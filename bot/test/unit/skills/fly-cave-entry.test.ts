// Track F8 (docs/flight.md "Cave entry (Track F8)", decisions/0074): the guard tests of the entry from above. A partial
// corridor is searched again from its end and the two joined (executor.ts joinCorridors); a corridor cruise whose landing
// cell lies under a wide, deep opening in a cave's roof lands inside it (the brake over the rim the executor names, the
// elevator down), not on the surface beside it (landing.ts LandingOptions.rim, brake.ts brakeMaxTicks).
import { describe, expect, it } from 'vitest';
import { corridorOf, legOf, portalOf, type Corridor } from '../../../src/skills/fly/corridor/coarse-port.ts';
import { CorridorExecutor, joinCorridors, type CorridorPorts, type SkyHint } from '../../../src/skills/fly/corridor/executor.ts';
import { brakeMaxTicks, BRAKE_MAX_TICKS } from '../../../src/skills/fly/brake.ts';
import { findLanding, type LandingOptions } from '../../../src/skills/fly/landing.ts';
import { onTarget } from '../../../src/skills/fly/plan.ts';
import { edgeOf, rocket, stepState } from '../../../src/skills/fly/route/primitives.ts';
import { BURN, MID_BURNS, NO_BOOST, type RouteState } from '../../../src/skills/fly/route/types.ts';
import type { BlockBox } from '../../../src/skills/input/index.ts';
import { FEET, trip, world } from './fly-worlds.ts';

const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 12, probes: 16, budgetMs: 60_000 };
const T = 300;

/** A mesa `depth` high on the flat ground with an `across` x `across` pit through it down to the ground (the owner's cave: 11 across, 46 deep). */
const pit = (across: number, depth: number): BlockBox[] => [
  { from: { x: -40, y: FEET, z: T - 40 }, to: { x: 40, y: FEET + depth - 1, z: T + 40 }, solid: true },
  { from: { x: 0, y: FEET, z: T }, to: { x: across - 1, y: FEET + depth - 1, z: T + across - 1 }, solid: false },
];

describe('fly: the entry from above (Track F8)', () => {
  it('joinCorridors: a partial fly leg and the found corridor from its end become one fly leg (the waypoints and portals in order, the totals summed, the status found)', () => {
    const q1 = portalOf({ a: 'A', b: 'B', axis: 'x', center: { x: 100, y: 70, z: 0 }, height: 16, width: 16 });
    const q2 = portalOf({ a: 'B', b: 'C', axis: 'y', center: { x: 160, y: 80, z: 0 }, height: 12, width: 12 });
    const q3 = portalOf({ a: 'C', b: 'D', axis: 'z', center: { x: 170, y: 50, z: 10 }, height: 5, width: 4, floorY: 50 });
    const end = { x: 160, y: 80, z: 0 };
    const a = corridorOf([legOf('fly', { x: 0, y: 64, z: 0 }, end, [q1, q2], ['A', 'B'], { cost: 300 })], { status: 'partial', reason: 'search limit hit (4000 ms): corridor ends 40 blocks from the goal' });
    const b = corridorOf([legOf('fly', end, { x: 170, y: 50, z: 12 }, [q2, q3], ['B', 'C'], { cost: 120 }), legOf('walk', { x: 170, y: 50, z: 12 }, { x: 172, y: 50, z: 20 }, [q3], ['D'], { entry: q3, cost: 40 })], { status: 'found' });
    const j = joinCorridors(a, b);
    expect(j.status).toBe('found');
    expect(j.reason).toBeUndefined();
    expect(j.legs.map((l) => l.mode)).toEqual(['fly', 'walk']);
    const fly = j.legs[0]!;
    expect(fly.from).toEqual({ x: 0, y: 64, z: 0 });
    expect(fly.to).toEqual({ x: 170, y: 50, z: 12 });
    expect(fly.portals.map((p) => p.id)).toEqual([q1.id, q2.id, q3.id]);
    expect(fly.waypoints.map((w) => `${w.x},${w.y},${w.z}`)).toEqual(['0,64,0', '100,70,0', '160,80,0', '170,50,10', '170,50,12']);
    expect(fly.cost).toBe(420);
    expect(fly.blocks).toBeCloseTo(a.legs[0]!.blocks + b.legs[0]!.blocks, 6);
    expect(j.blocks).toBeCloseTo(a.blocks + b.blocks, 6);
    expect(j.cost).toBe(a.cost + b.cost);
    // different modes at the seam: the legs are appended as they are
    const c = joinCorridors(a, corridorOf([legOf('walk', end, { x: 165, y: 80, z: 0 }, [], ['B'])], { status: 'found' }));
    expect(c.legs.map((l) => l.mode)).toEqual(['fly', 'walk']);
    expect(c.legs[0]!.to).toEqual(end);
  });

  it('the executor asks a second search from a partial end and follows the joined corridor; a partial second search leaves the first as it was', async () => {
    const q = portalOf({ a: 'A', b: 'B', axis: 'y', center: { x: 60, y: 80, z: 0 }, height: 12, width: 12 });
    const goal = { x: 70, y: 50, z: 0 };
    const partial = corridorOf([legOf('fly', { x: 0, y: 64, z: 0 }, { x: 60, y: 80, z: 0 }, [q], ['A'], { cost: 100 })], { status: 'partial', reason: 'search limit hit' });
    const rest = corridorOf([legOf('fly', { x: 60, y: 80, z: 0 }, goal, [q], ['B'], { cost: 50 })], { status: 'found' });
    const asked: { start: { x: number; y: number; z: number }; mode: string | undefined; ms: number | undefined }[] = [];
    const run = async (second: Corridor): Promise<{ plans: typeof asked; flown: string[] }> => {
      asked.length = 0;
      const flown: string[] = [];
      let pos = { x: 0.5, y: 64, z: 0.5 };
      const ports: CorridorPorts = {
        provider: {
          plan: (req) => {
            asked.push({ start: req.start, mode: req.startMode, ms: req.maxMs });
            return Promise.resolve(asked.length === 1 ? partial : second);
          },
          markPortal: () => undefined,
          volumeAt: () => undefined,
        },
        position: () => pos,
        dim: () => 0,
        solid: () => false,
        loaded: () => true,
        waitLoaded: () => Promise.resolve(true),
        flySky: (cell, label) => {
          flown.push(`sky ${label}`);
          pos = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
          return Promise.resolve({ ok: true, at: pos });
        },
        flyUnder: () => Promise.resolve({ ok: false, reason: 'not here' }),
        walk: (cell) => {
          pos = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
          return Promise.resolve({ ok: true, at: pos });
        },
        stopped: () => false,
      };
      const ex = new CorridorExecutor(ports, { maxReplans: 0, underFly: false });
      await ex.run(goal);
      return { plans: [...asked], flown };
    };
    const r = await run(rest);
    expect(r.plans.length).toBe(2);
    expect(r.plans[1]!.start).toEqual({ x: 60, y: 80, z: 0 });
    expect(r.plans[1]!.mode).toBe('fly');
    expect(r.plans[1]!.ms).toBeGreaterThan(0);
    const r2 = await run(corridorOf([legOf('fly', { x: 60, y: 80, z: 0 }, { x: 65, y: 80, z: 0 }, [], ['B'])], { status: 'partial', reason: 'still partial' }));
    expect(r2.plans.length).toBe(2); // the first corridor is followed as it was (its end is the trip's re-plan point)
  });

  it('the dry floor 46 under an 11 x 11 opening: without the rim the landing search sees a precision cell under open sky and nothing lands; with the rim it is a pit floor landed by the brake over the rim and the elevator down', async () => {
    const w = world(pit(11, 46));
    const goal = { x: 2, y: FEET, z: T + 5 }; // the floor cell nearest the way on, two cells from the wall
    const deps = { look: w.look, obstacle: (x: number, y: number, z: number) => w.solid.solidAt(x, y, z) === true, probe: () => Promise.resolve({ status: 'found' as const, blocks: 3 }) };
    const bare = await findLanding(goal, 'the pit', deps, { ...OPTS, exact: 1 });
    expect(bare.kind, bare.line).toBe('goal'); // a plain open cell to the search: the flare's glide line meets the mesa's wall
    if (bare.kind === 'goal') expect(bare.target.rim).toBeUndefined();
    const hinted = await findLanding(goal, 'the pit', deps, { ...OPTS, exact: 1, rim: FEET + 46 });
    expect(hinted.kind, hinted.line).toBe('goal');
    if (hinted.kind !== 'goal') return;
    expect(hinted.target.rim).toBe(FEET + 46);
    expect(hinted.target.precise).toBe(true);
    expect(hinted.line).toMatch(/a pit floor 46 deep/);
    expect(brakeMaxTicks(hinted.target)).toBeGreaterThan(BRAKE_MAX_TICKS + 150);
    // the whole trip from 300 blocks south: down inside the pit onto the cell, no hit, no go-around
    for (const seed of [5, 11]) {
      const r = trip(w, { x: 0.5, y: FEET, z: 0.5 }, hinted.target, { seed });
      const line = `seed ${seed}: ${r.end.ok ? 'ok' : r.end.reason} at ${r.body.pos.x.toFixed(2)} ${r.body.pos.y.toFixed(2)} ${r.body.pos.z.toFixed(2)}, ${r.end.off.toFixed(2)} off, touchdown vy ${r.lastAir.vy.toFixed(2)} h ${r.lastAir.h.toFixed(2)}, ${r.ticks} ticks, ${r.rockets} rockets, ${r.goArounds} go-arounds, ${r.stats.landStyle} (${r.stats.brakeTicks} in K), hits ${r.hits}`;
      expect(r.end.ok, line).toBe(true);
      expect(r.stats.landStyle, line).toBe('brake');
      expect(onTarget(hinted.target, r.body.pos), line).toBe(true);
      expect(r.body.pos.y, line).toBeCloseTo(FEET, 3);
      expect(r.hits, line).toBe(0);
      expect(r.goArounds, line).toBe(0);
      expect(r.lastAir.vy, line).toBeGreaterThan(-0.36);
    }
  });

  it('the planner sweeps the burns between the extremes (MID_BURNS 12 and 18): a rocket starts them, they boost for their own burn, converge and go; a snap turn past a wall only a mid burn meets is refused', () => {
    const start: RouteState = { pos: { x: 0.5, y: 70, z: 0.5 }, vel: { x: 0, y: -0.05, z: 1.0 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 4, wp: 0 };
    let s = stepState(start, { yaw: 0, pitch: 0, fire: true }, false, undefined, undefined, true, true).next;
    expect(s.early && s.late && s.mids).toBeTruthy();
    expect(s.mids!.map((m) => m.left)).toEqual(MID_BURNS.map((b) => b - 1)); // boosted on the fire's tick, one less left
    expect(s.boost.min).toBe(BURN.min - 1);
    for (let t = 1; t < 40; t++) s = stepState(s, { yaw: 0, pitch: 0, fire: false }, false, undefined, undefined, true, true).next;
    // every burn over: the mids ride on with the extremes (a straight flight leaves the branch bodies blocks apart along the
    // track, so none of them drops; the extremes never did either), between the shortest and the longest burn's body
    expect(s.mids!.every((m) => m.left === 0)).toBe(true);
    expect(s.early && s.late).toBeTruthy();
    for (const m of s.mids!) {
      expect(m.pos.z).toBeGreaterThan(s.early!.pos.z);
      expect(m.pos.z).toBeLessThan(s.late!.pos.z);
    }
    // a straight bore 3 wide with a wall niche only a body boosted 12 ticks and then turning reaches: the extremes clear it,
    // the mid does not. The grid: air between x 0 and 2 (the bore), everything else solid, and a pocket at x 3..4 for z 24..30
    // (so a body drifting out at x 2.7 meets x 3's wall at z 31)
    const grid = { solid: (x: number, y: number, _z: number) => y < 69 || y > 72 || x < 0 || x > 2 };
    const ctx = { grid, margin: 0.1, goals: [{ kind: 'waypoint' as const, box: { min: { x: 0, y: 69, z: 60 }, max: { x: 3, y: 73, z: 64 } } }], stackRockets: false, midBurns: true };
    // without the flag no mids at all (the open-air drivers)
    expect(stepState(start, { yaw: 0, pitch: 0, fire: true }, false).next.mids).toBeUndefined();
    const flying: RouteState = { ...start, pos: { x: 1.5, y: 70.5, z: 0.5 }, vel: { x: 0, y: 0, z: 1.2 } };
    // the rocket straight on: every branch stays in the bore
    expect(edgeOf(rocket(0, 0, 3), flying, ctx)).toBeDefined();
    const e = edgeOf(rocket(45, 0, 30), flying, ctx);
    expect(e).toBeUndefined(); // a snap 45 off in a 3-wide bore hits for every burn
  });

  it('the executor names the rim of a y opening to the cruise (the portal plane over a cell 2 or more under it), nothing for a mouth', async () => {
    const hints: (SkyHint | undefined)[] = [];
    const opening = portalOf({ a: 'SKY', b: 'CAVE', axis: 'y', center: { x: 10.5, y: 100, z: 10.5 }, height: 11, width: 11 });
    const mouth = portalOf({ a: 'OUT', b: 'IN', axis: 'z', center: { x: 50, y: 60, z: 200 }, height: 4, width: 3, floorY: 60 });
    const legs = [legOf('fly', { x: 0, y: 100, z: 0 }, { x: 10, y: 54, z: 10 }, [opening], ['SKY', 'CAVE']), legOf('fly', { x: 10, y: 54, z: 10 }, { x: 50, y: 60, z: 203 }, [mouth], ['CAVE2', 'IN'])];
    // a world: solid under y 100 outside the opening's column, the pit's floor at 54, the mouth's floor at 60
    const solid = (x: number, y: number, z: number): boolean => (y < 54 ? true : x >= 5 && x <= 15 && z >= 5 && z <= 15 ? false : y < 100 && !(z >= 190 && y >= 60 && y <= 63));
    let pos = { x: 0.5, y: 100, z: 0.5 };
    let step = 0;
    const ports: CorridorPorts = {
      provider: {
        plan: () => Promise.resolve(corridorOf([legs[step++]!], { status: 'found' })),
        markPortal: () => undefined,
        volumeAt: (p) => (p.y >= 100 ? { id: 'SKY', kind: 'sky', dim: 0, min: { x: 0, y: 100, z: 0 }, max: { x: 15, y: 319, z: 15 }, cells: 1, floorCells: 1, minSpan: 16, known: 'known' } : { id: 'CAVE', kind: 'cave', dim: 0, min: { x: 5, y: 54, z: 5 }, max: { x: 15, y: 99, z: 15 }, cells: 1, floorCells: 1, minSpan: 11, known: 'known' }),
      },
      position: () => pos,
      dim: () => 0,
      solid,
      loaded: () => true,
      waitLoaded: () => Promise.resolve(true),
      flySky: (cell, _label, hint) => {
        hints.push(hint);
        pos = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
        return Promise.resolve({ ok: true, at: pos });
      },
      flyUnder: () => Promise.resolve({ ok: true }),
      walk: (cell) => {
        pos = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
        return Promise.resolve({ ok: true, at: pos });
      },
      stopped: () => false,
    };
    const ex = new CorridorExecutor(ports, { maxReplans: 0, underFly: false, joinMs: 0 });
    await ex.run({ x: 10, y: 54, z: 10 });
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints[0]).toEqual({ rim: 100 });
  });
});
