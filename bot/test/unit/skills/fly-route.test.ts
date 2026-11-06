// Track F2 (docs/flight.md "Route planner"; decisions/0058): the kinodynamic flight planner offline: the swept
// collision, the primitives against stepBody, the heuristic's energy bound, the search on tunnels, the burn
// robustness, the tracker on stepBody with random burns and newly loaded chunks, the worker, the benchmark set.
import { afterAll, describe, expect, it } from 'vitest';
import { flatWorld, withBoxes } from '../../../src/skills/input/world.ts';
import { IDLE_COMMAND, initialBody, type BodyState } from '../../../src/skills/input/types.ts';
import { GLIDE, stepBody } from '../../../src/skills/input/physics.ts';
import { benchLine, flyCourse } from '../../../src/skills/fly/route/bench.ts';
import { field, standardCourses, tunnel } from '../../../src/skills/fly/route/courses.ts';
import { boxClear, gridOf, gridOfCells, sweep } from '../../../src/skills/fly/route/grid.ts';
import { edgeOf, glide, libraryFor, replay, rocket, stepState, takeoff } from '../../../src/skills/fly/route/primitives.ts';
import { checkRobust } from '../../../src/skills/fly/route/robust.ts';
import { energyHeight, heuristic, planRoute } from '../../../src/skills/fly/route/search.ts';
import { RouteTracker } from '../../../src/skills/fly/route/tracker.ts';
import { BURN, NO_BOOST, RISK_RANGE, freshBurn, waypointAt, type RouteRequest, type RouteState } from '../../../src/skills/fly/route/types.ts';
import { RoutePlannerClient, gridOfSnapshot, snapshotFor } from '../../../src/skills/fly/route/worker.ts';

const FEET = -60;
const state = (p: Partial<RouteState> & { pos: RouteState['pos'] }): RouteState => ({ vel: { x: 0, y: -0.1, z: 1.2 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 4, wp: 0, ...p });

describe('route grid: the swept box', () => {
  const wall = gridOfCells((x, y, z) => z === 10 && y >= FEET - 1 && y <= FEET + 5 && Math.abs(x) <= 3);

  it('hits a one-block wall inside a tick even when both ends are clear, and reports the clearance before it', () => {
    const from = { x: 0.5, y: FEET + 2, z: 8.6 };
    const to = { x: 0.5, y: FEET + 2, z: 11.6 };
    expect(sweep(wall, from, to, 0).hit).toBe(true);
    const near = sweep(wall, { x: 0.5, y: FEET + 2, z: 8.5 }, { x: 0.5, y: FEET + 2, z: 9.2 }, 0.3);
    expect(near.hit).toBe(false);
    expect(near.clearance).toBeCloseTo(0.5, 5);
    expect(sweep(wall, { x: 0.5, y: FEET + 2, z: 2 }, { x: 0.5, y: FEET + 2, z: 4 }, 0.3).clearance).toBe(RISK_RANGE);
  });

  it('treats unknown cells as solid and follows moveBody: y first, then x, then z', () => {
    expect(gridOf({ solidAt: () => undefined }).solid(0, 0, 0)).toBe(true);
    expect(gridOf({ solidAt: () => undefined }, false).solid(0, 0, 0)).toBe(false);
    // a step: solid at z >= 10 up to y 0, air above; the straight line from (9.5, 1.2) to (10.8, 2.5) clears the step's edge,
    // the L path rises first (clear) then moves z at the top (clear): both fine; but a move that rises only after z would hit
    const step = gridOfCells((_x, y, z) => z >= 10 && y <= 0);
    expect(sweep(step, { x: 0.5, y: 1.0, z: 9.3 }, { x: 0.5, y: 1.8, z: 10.6 }, 0).hit).toBe(false);
    // the mirror: descending onto a step from above: y first drops INTO the step at the old z (clear: z < 10), then z moves into the solid
    expect(sweep(step, { x: 0.5, y: 1.8, z: 9.3 }, { x: 0.5, y: 0.5, z: 10.6 }, 0).hit).toBe(true);
    // (a touch counts as a hit, as moveBody stops at a touch)
    expect(boxClear(step, { x: 0.5, y: 1.01, z: 11 }, 0).hit).toBe(false);
    expect(boxClear(step, { x: 0.5, y: 1.0, z: 11 }, 0).hit).toBe(true);
    expect(boxClear(step, { x: 0.5, y: 0.9, z: 11 }, 0).hit).toBe(true);
  });
});

describe('route primitives against stepBody', () => {
  const world = flatWorld();
  it('a glide tick of stepState is stepBody’s gliding tick (position, velocity, the boost count)', () => {
    let body: BodyState = { ...initialBody({ x: 0.5, y: FEET + 20, z: 0.5 }), gliding: true, vel: { x: 0, y: -0.1, z: 1.2 } };
    let s = state({ pos: { x: 0.5, y: FEET + 20, z: 0.5 } });
    for (let t = 0; t < 12; t++) {
      const fire = t === 2;
      const c = { yaw: 20, pitch: -15, fire };
      const r = stepBody(body, { ...IDLE_COMMAND, yaw: 20, pitch: -15, glide: true, ...(fire ? { boostStart: BURN.nominal } : {}) }, world);
      body = r.state;
      s = stepState(s, c, false).next;
      expect(s.pos.x).toBeCloseTo(body.pos.x, 5);
      expect(s.pos.y).toBeCloseTo(body.pos.y, 5);
      expect(s.pos.z).toBeCloseTo(body.pos.z, 5);
      expect(s.vel.y).toBeCloseTo(body.vel.y, 6);
      expect(s.boost.nom).toBe(body.boostTicks ?? 0);
    }
    expect(s.rockets).toBe(3);
  });

  it('the jump tick of a takeoff is stepBody’s jump; under a 2-high ceiling the rise is clipped as moveBody clips it', () => {
    const start = { x: 0.5, y: FEET, z: 0.5 };
    const r = stepBody(initialBody(start, true), { ...IDLE_COMMAND, jump: true, glide: true }, world);
    const s = stepState(state({ pos: start, gliding: false, vel: { x: 0, y: 0, z: 0 } }), { yaw: 0, pitch: 0, fire: false, jump: true, glide: true }, false, BURN.nominal, gridOf(world)).next;
    expect(s.pos.y).toBeCloseTo(r.state.pos.y, 6);
    expect(s.vel.y).toBeCloseTo(r.state.vel.y, 6);
    expect(s.gliding).toBe(true);
    // the next tick glides in both
    const r2 = stepBody(r.state, { ...IDLE_COMMAND, jump: true, glide: true }, world);
    expect(r2.state.gliding).toBe(true);
    // under a 2-high ceiling moveBody clips the rise to 0.2; the planner knows no glide ever starts from such a jump (Track F0:
    // two airborne inputs, the first refused) and leaves the body standing
    const low = withBoxes(world, [{ from: { x: -2, y: FEET + 2, z: -2 }, to: { x: 2, y: FEET + 2, z: 2 }, solid: true }]);
    const rl = stepBody(initialBody(start, true), { ...IDLE_COMMAND, jump: true, glide: true }, low);
    const sl = stepState(state({ pos: start, gliding: false, vel: { x: 0, y: 0, z: 0 } }), { yaw: 0, pitch: 0, fire: false, jump: true, glide: true }, false, BURN.nominal, gridOf(low)).next;
    expect(rl.state.pos.y).toBeCloseTo(FEET + 0.2, 3);
    expect(sl.pos.y).toBe(start.y);
    expect(sl.gliding).toBe(false);
  });

  it('an edge sweeps every tick and advances the waypoints it passes; a wall in the way makes none', () => {
    const grid = gridOf(world);
    const goals = [waypointAt({ x: 0.5, y: FEET + 18, z: 10 }, 2, 4)];
    const e = edgeOf(glide(0), state({ pos: { x: 0.5, y: FEET + 20, z: 0.5 } }), { grid, margin: 0.4, goals, stackRockets: false });
    expect(e?.ticks).toBe(3);
    expect(e?.out.wp).toBe(0);
    expect(e?.robust).toBe(true);
    // the edge that passes the waypoint ends there
    let cur = e!.out;
    let passedAt = 0;
    for (let i = 0; i < 4 && cur.wp === 0; i++) {
      const n = edgeOf(glide(0), cur, { grid, margin: 0.4, goals, stackRockets: false })!;
      cur = n.out;
      passedAt = n.ticks;
    }
    expect(cur.wp).toBe(1);
    expect(passedAt).toBeLessThanOrEqual(3);
    const walled = gridOf(withBoxes(world, [{ from: { x: -3, y: FEET, z: 2 }, to: { x: 3, y: FEET + 30, z: 2 }, solid: true }]));
    expect(edgeOf(glide(0), state({ pos: { x: 0.5, y: FEET + 20, z: 0.5 } }), { grid: walled, margin: 0.4, goals, stackRockets: false })).toBeUndefined();
    const far = [waypointAt({ x: 0.5, y: FEET + 20, z: 200 }, 2, 4)];
    const re = edgeOf(rocket(0, -20), state({ pos: { x: 0.5, y: FEET + 20, z: 0.5 } }), { grid, margin: 0.4, goals: far, stackRockets: false });
    expect(re?.rockets).toBe(1);
    expect(re?.out.boost.nom).toBe(BURN.nominal - 3);
    expect(re?.out.early).toBeDefined();
    expect(re?.robust).toBe(true);
    // a replay of an edge's controls gives its end state
    const st = replay(state({ pos: { x: 0.5, y: FEET + 20, z: 0.5 } }), re!.controls, [], false);
    expect(st[2]!.pos.z).toBeCloseTo(re!.out.pos.z, 9);
    expect(libraryFor(undefined, 3, [0]).length).toBeGreaterThan(30);
    expect(libraryFor(['glide']).every((m) => m.family === 'glide')).toBe(true);
    expect(takeoff(0, -20, true).applies(state({ pos: { x: 0, y: 0, z: 0 }, gliding: false }))).toBe(true);
  });
});

describe('route search', () => {
  it('the heuristic is finite only when the rockets in the hand can buy the climb, and counts the energy height', () => {
    const s = state({ pos: { x: 0.5, y: FEET + 5, z: 0.5 }, rockets: 0 });
    const high = { start: s, goals: [waypointAt({ x: 0.5, y: FEET + 60, z: 20 }, 2, 4)], margin: 0.4, maxNodes: 10, maxMs: 10 } satisfies RouteRequest;
    expect(heuristic(s, high)).toBe(Infinity);
    expect(heuristic({ ...s, rockets: 2 }, high)).toBeGreaterThan(20);
    expect(energyHeight(state({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0.8, z: 1.5 } }))).toBeGreaterThan(8 + 11 * 2.25 - 1);
    const low = { ...high, goals: [waypointAt({ x: 0.5, y: FEET + 5, z: 20 }, 2, 4)] };
    expect(heuristic(s, low)).toBeCloseTo(Math.hypot(19.5, 2) / (GLIDE.boostTarget + GLIDE.boostPush * 2), 3);
    const r = planRoute(high, gridOf(flatWorld()));
    expect(r.complete).toBe(false);
    expect(r.why).toMatch(/rockets in the hand/);
  });

  it('plans a 3 x 3 corner and a 2 x 2 S-bend, robust to the burn by construction, and the budget gives a partial plan', () => {
    const c = standardCourses().find((x) => x.name === 'corner-3x3')!;
    const grid = gridOf(c.world);
    const start = state({ pos: c.start.pos, vel: { x: 0, y: -0.1, z: c.start.speed }, rockets: c.start.rockets });
    const req: RouteRequest = { start, goals: c.goals, margin: c.margin, maxNodes: 40_000, maxMs: 2000 };
    const p = planRoute(req, grid);
    expect(p.complete).toBe(true);
    expect(p.rockets).toBeGreaterThanOrEqual(1);
    expect(p.robust).toBe(true);
    expect(p.states.length).toBe(p.controls.length);
    const rob = checkRobust(start, p, grid, c.margin, c.goals);
    expect(rob.branches.length).toBe((BURN.max - BURN.min) * p.rockets + (p.rockets > 1 ? 2 : 0));
    expect(rob.robust).toBe(true);
    const tiny = planRoute({ ...req, maxNodes: 20 }, grid);
    expect(tiny.complete).toBe(false);
    expect(tiny.budget).toBe('nodes');
    expect(tiny.why).toMatch(/budget/);
    const s = standardCourses().find((x) => x.name === 'sbend-2x2')!;
    const ps = planRoute({ start: state({ pos: s.start.pos, vel: { x: 0, y: -0.1, z: s.start.speed }, rockets: 8 }), goals: s.goals, margin: s.margin, maxNodes: 40_000, maxMs: 2000 }, gridOf(s.world));
    expect(ps.reached).toBeGreaterThanOrEqual(2);
  });

  it('a landing goal: a glide to a cell on the ground ends with the body on it under the touchdown speed', () => {
    const world = flatWorld();
    const cell = { x: 0, z: 24 };
    const req: RouteRequest = {
      start: state({ pos: { x: 0.5, y: FEET + 6, z: 0.5 }, vel: { x: 0, y: -0.1, z: 1.0 }, rockets: 2 }),
      goals: [{ kind: 'landing', cell, top: FEET, maxSpeed: 0.35 }],
      margin: 0.3,
      maxNodes: 60_000,
      maxMs: 4000,
    };
    const p = planRoute(req, gridOf(world));
    expect(p.complete).toBe(true);
    const last = p.states[p.states.length - 1]!;
    expect(last.gliding).toBe(false);
    expect(Math.floor(last.pos.x)).toBe(cell.x);
    expect(Math.floor(last.pos.z)).toBe(cell.z);
    expect(Math.hypot(last.vel.x, last.vel.z)).toBeLessThanOrEqual(0.35);
  });
});

describe('route tracker on stepBody', () => {
  it('flies the straight 3 x 3 with random burns, and with the world loading 12 blocks ahead (replans on the loaded chunks)', () => {
    const c = standardCourses().find((x) => x.name === 'straight-3x3')!;
    const r = flyCourse(c, { seed: 7, robust: true });
    expect(r.success).toBe(true);
    expect(r.hits).toBe(0);
    expect(r.robust?.robust).toBe(true);
    const v = flyCourse(c, { seed: 7, view: 12 });
    expect(v.success).toBe(true);
    expect(v.hits).toBe(0);
    expect(v.stats.replans).toBeGreaterThan(0);
  });

  it('a burn read off the body: the tracker learns an early end before the notice, and a long burn as it goes on', () => {
    const c = standardCourses().find((x) => x.name === 'curve-r8-3x3')!;
    const short = flyCourse(c, { seed: 1, burn: BURN.min });
    const long = flyCourse(c, { seed: 1, burn: BURN.max });
    expect(short.success && long.success).toBe(true);
    expect(short.stats.burnsRead + long.stats.burnsRead).toBeGreaterThan(0);
  });

  it('the tracker holds a level glide while a planner is pending and adopts the plan when it comes', async () => {
    const c = standardCourses().find((x) => x.name === 'straight-2x2')!;
    const grid = gridOf(c.world);
    let resolve: ((p: ReturnType<typeof planRoute>) => void) | undefined;
    const t = new RouteTracker({
      grid,
      margin: c.margin,
      goals: c.goals,
      plan: (req) => new Promise((res) => {
        resolve = () => res(planRoute(req, grid));
      }),
      maxNodes: 20_000,
      maxMs: 500,
      yaw: 0,
    });
    const b = { pos: { ...c.start.pos }, vel: { x: 0, y: -0.1, z: 1.2 }, gliding: true, onGround: false, rockets: 4 };
    const o1 = t.tick(b, 1);
    expect(o1.status).toBe('planning');
    expect(o1.control.fire).toBe(false);
    // (Track F4a: the level hold, or the evade rule where the level glide would reach the bore's floor within HORIZON)
    expect(t.stats.holdTicks + t.stats.evadeTicks).toBe(1);
    resolve!(undefined as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.current).toBeDefined();
    const o2 = t.tick(b, 2);
    expect(o2.status).toBe('tracking');
  });
});

describe('route worker', () => {
  const client = new RoutePlannerClient();
  afterAll(() => client.stop());

  it('the snapshot answers like the grid, and the worker returns the in-thread plan', async () => {
    const c = standardCourses().find((x) => x.name === 'corner-3x3')!;
    const grid = gridOf(c.world);
    const start = state({ pos: c.start.pos, vel: { x: 0, y: -0.1, z: c.start.speed }, rockets: c.start.rockets });
    const req: RouteRequest = { start, goals: c.goals, margin: c.margin, maxNodes: 40_000, maxMs: 2000 };
    const snap = snapshotFor(grid, req);
    const sg = gridOfSnapshot(snap);
    for (let i = 0; i < 500; i++) {
      const x = snap.min.x + Math.floor(Math.random() * snap.size.x);
      const y = snap.min.y + Math.floor(Math.random() * snap.size.y);
      const z = snap.min.z + Math.floor(Math.random() * snap.size.z);
      expect(sg.solid(x, y, z)).toBe(grid.solid(x, y, z));
    }
    expect(sg.solid(snap.min.x - 1, snap.min.y, snap.min.z)).toBe(true);
    const local = planRoute(req, grid);
    const remote = await client.plan(req, snapshotFor(grid, req));
    expect(remote.complete).toBe(true);
    expect(remote.controls.map((k) => `${k.yaw.toFixed(3)}/${k.pitch}/${k.fire}`)).toEqual(local.controls.map((k) => `${k.yaw.toFixed(3)}/${k.pitch}/${k.fire}`));
    // the tracker over the worker's planner
    const t = new RouteTracker({ grid, margin: c.margin, goals: c.goals, plan: client.plannerOver(grid), maxNodes: 40_000, maxMs: 2000, yaw: 0 });
    t.tick({ pos: { ...c.start.pos }, vel: { x: 0, y: -0.1, z: 1.2 }, gliding: true, onGround: false, rockets: 4 }, 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.current?.complete).toBe(true);
  }, 20_000);
});

describe('route benchmark (the standard set, docs/flight.md "Benchmark")', () => {
  const lines: string[] = [];
  afterAll(() => {
    console.log(`[fly-route benchmark]\n  ${lines.join('\n  ')}`);
  });

  it('flies the tunnels and fields the planner can do, with 0 hits, and reports the rest', () => {
    const results = standardCourses().map((c) => flyCourse(c, { seed: 3, robust: true }));
    for (const r of results) lines.push(benchLine(r));
    const byName = new Map(results.map((r) => [r.name, r]));
    const must = ['straight-3x3', 'straight-2x2', 'straight-1x2', 'curve-r16-3x3', 'curve-r8-3x3', 'curve-r4-3x3', 'curve-r8-2x2', 'corner-3x3', 'corner-2x2', 'sbend-2x2', 'climb-3x3', 'drop-3x3', 'stair45-3high', 'slot-1high-6', 'slot-1high-12', 'random-3x3-a', 'random-3x3-b', 'field1', 'field2', 'field3'];
    for (const n of must) {
      const r = byName.get(n)!;
      expect(r.success, `${n}: ${benchLine(r)}`).toBe(true);
      expect(r.hits, n).toBe(0);
    }
    // the 2-high staircase does not fit (the envelope: 2.2 needed); its result is reported, not asserted
    expect(byName.get('stair45-2high')).toBeDefined();
    const ok = results.filter((r) => r.success).length;
    expect(ok).toBeGreaterThanOrEqual(must.length);
  }, 60_000);

  it('a custom tunnel and a field build the same way for the e2e: the fills carve what the world says', () => {
    const t = tunnel({ name: 't', w: 3, h: 3, segments: [{ kind: 'straight', len: 10 }, { kind: 'corner', deg: 90 }, { kind: 'straight', len: 10 }], origin: { x: 10, y: FEET + 1, z: 10 }, yaw: 0 });
    expect(t.fills.filter((f) => f.block === 'stone').length).toBeGreaterThan(0);
    expect(t.fills.filter((f) => f.block === 'air').length).toBeGreaterThan(0);
    // every air fill is air in the world, every stone slab solid where no air fill covers it
    for (const f of t.fills.filter((x) => x.block === 'air')) expect(t.world.solidAt(f.from.x, f.from.y, f.from.z)).toBe(false);
    expect(t.world.solidAt(t.bounds.min.x, t.bounds.min.y, t.bounds.min.z)).toBe(true);
    const f = field(5);
    expect(f.goals.length).toBe(1);
    expect(f.fills.length).toBeGreaterThan(5);
  });
});

/** (kept for the tables: the first plan's effort per course is in the benchmark lines) */
export const BENCH_FRESH = freshBurn();
