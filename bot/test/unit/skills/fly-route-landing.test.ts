// Flight v2, Track F3 (docs/flight.md "Route landings and takeoffs (Track F3)", decisions/0064): the route
// landings and takeoffs offline. The planner's additions (multi-cell landing goals, the `via` hint, the
// heuristic weight, the named library), planLandingRoute on the cases the flare and the brake refuse (the
// owner's stacked platforms 2 and 3 high, the 1 x 1 shaft 10 deep the search missed before, a cell under a roof
// at ground level, a pocket in a cliff face), findLanding handing such a goal to the route, whole trips of the
// brain on stepBody that hand over to the RouteTracker and land on the cells, and the route takeoff out of the
// 3-high stack, a hole and a low room.
import { describe, expect, it } from 'vitest';
import { findLanding, ROUTE_HEADROOM, stillLandable, type LandingOptions } from '../../../src/skills/fly/landing.ts';
import { onTarget } from '../../../src/skills/fly/plan.ts';
import { flyCourse } from '../../../src/skills/fly/route/bench.ts';
import { gridOf } from '../../../src/skills/fly/route/grid.ts';
import { cellsWidth, landingGoalFor, planLandingRoute, ROUTE_ENTRY_OUT, ROUTE_ENTRY_SPEED, ROUTE_ENTRY_UP, ROUTE_WEIGHT, routeEntry, routeMargin, specMargin, type LandingRouteSpec } from '../../../src/skills/fly/route/landing.ts';
import { landsOn, LOW_CEILING_RISE, stepState } from '../../../src/skills/fly/route/primitives.ts';
import { heuristic, planRoute } from '../../../src/skills/fly/route/search.ts';
import { exitsFrom, planTakeoffRoute } from '../../../src/skills/fly/route/takeoff.ts';
import { BURN, GLIDE_DELAY, landingCells, NO_BOOST, type RouteGoal, type RouteState } from '../../../src/skills/fly/route/types.ts';
import type { BlockBox } from '../../../src/skills/input/index.ts';
import { FEET, trip, world } from './fly-worlds.ts';

const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 12, probes: 16, budgetMs: 60_000, exact: 1, style: 'auto' };
const T = 300;
/** The owner's stacked platforms: a 3 x 3 at `top - 1`, another `gap` over the inner floor (2: feet at top, air at top and top + 1). */
const stack = (gap: number, up = 21): BlockBox[] => [
  { from: { x: -1, y: FEET + up - 1, z: T - 1 }, to: { x: 1, y: FEET + up - 1, z: T + 1 }, solid: true },
  { from: { x: -1, y: FEET + up + gap, z: T - 1 }, to: { x: 1, y: FEET + up + gap, z: T + 1 }, solid: true },
];
const b = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, solid = true): BlockBox => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, solid });
const nine = [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dz) => ({ x: dx, z: T + dz })));
const shaft1: BlockBox[] = [b(-3, FEET, T - 3, 3, FEET + 9, T + 3), b(0, FEET, T, 0, FEET + 9, T, false)];
/** A room on the ground 3 high, walled on three sides, open towards -z. */
const room3: BlockBox[] = [b(-3, FEET + 3, T - 3, 3, FEET + 3, T + 3), b(-3, FEET, T - 3, -3, FEET + 2, T + 3), b(3, FEET, T - 3, 3, FEET + 2, T + 3), b(-3, FEET, T + 3, 3, FEET + 2, T + 3)];
/** A pocket 3 x 3 x 3 in a cliff face 30 high, 10 up its foot (the cell one in). */
const pocket: BlockBox[] = [b(-40, FEET, T + 1, 40, FEET + 29, T + 40), b(-1, FEET + 10, T + 1, 1, FEET + 12, T + 3, false)];

const state = (pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }, rockets = 2): RouteState => ({ pos, vel, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets, wp: 0 });

describe('fly: the route planner for landings (Track F3)', () => {
  it('a landing goal with cells lands in any of them; the via hint and the weight shape the heuristic; the margin follows the narrower side', () => {
    const g: RouteGoal = { kind: 'landing', cell: { x: 0, z: 0 }, top: 10, cells: [{ x: 0, z: 0 }, { x: 1, z: 0 }] };
    expect(landingCells(g).length).toBe(2);
    expect(landsOn(g, { x: 1.5, y: 10.2, z: 0.5 }, { x: 1.5, y: 9.9, z: 0.5 }, { x: 0, y: -0.15, z: 0 })).toBe(true);
    expect(landsOn(g, { x: 2.5, y: 10.2, z: 0.5 }, { x: 2.5, y: 9.9, z: 0.5 }, { x: 0, y: -0.15, z: 0 })).toBe(false);
    expect(landsOn({ ...g, cells: undefined }, { x: 1.5, y: 10.2, z: 0.5 }, { x: 1.5, y: 9.9, z: 0.5 }, { x: 0, y: -0.15, z: 0 })).toBe(false);
    // the via hint: the body must pass the point first (the heuristic grows), unless it is past it (inside the shaft)
    const spec: LandingRouteSpec = { cells: [{ x: 0, z: 0 }], top: 0, rim: 10 };
    const goal = landingGoalFor(spec, 0);
    expect(goal.kind === 'landing' && goal.via?.pos).toEqual({ x: 0.5, y: 11, z: 0.5 });
    const req = { start: state({ x: 0.5, y: 16, z: 24.5 }, { x: 0, y: -0.1, z: -1 }), goals: [goal], margin: 0.1, maxNodes: 1, maxMs: 1 };
    const plain = { ...req, goals: [{ ...goal, via: undefined } as RouteGoal] };
    expect(heuristic(req.start, req)).toBeGreaterThan(heuristic(req.start, plain));
    const inside = state({ x: 0.5, y: 5, z: 0.5 }, { x: 0, y: -0.15, z: 0 });
    expect(heuristic(inside, req)).toBeCloseTo(heuristic(inside, plain), 6);
    // the weight: f = g + weight x h; weight 1 is the A* of Track F2; both land the open cell (the greedy search is for the
    // shafts and slots, where the plain A* drowns: the case table below; in the open it explores more, not less)
    const open = { start: state({ x: 0.5, y: FEET + 6, z: 0.5 }, { x: 0, y: -0.1, z: 1.0 }), goals: [{ kind: 'landing', cell: { x: 0, z: 24 }, top: FEET, maxSpeed: 0.35 } as RouteGoal], margin: 0.3, maxNodes: 60_000, maxMs: 4000, library: 'landing' as const };
    const w1 = planRoute(open, gridOf(world([]).solid));
    const w2 = planRoute({ ...open, weight: ROUTE_WEIGHT }, gridOf(world([]).solid));
    expect(w1.complete && w2.complete).toBe(true);
    // the margin: a 1-wide shaft 0.1, a 2-high slot 0.12, a 3-high room 0.2, the open 0.4
    expect(routeMargin(Infinity, 1)).toBe(0.1);
    expect(routeMargin(2)).toBe(0.12);
    expect(routeMargin(3)).toBe(0.2);
    expect(routeMargin(Infinity)).toBe(0.4);
    expect(specMargin(spec)).toBe(0.1);
    expect(cellsWidth([{ x: 0, z: 0 }, { x: 1, z: 0 }])).toBe(1);
    expect(specMargin({ cells: nine, top: 0, ceiling: 2 })).toBe(0.12);
    // the entry: ROUTE_ENTRY_OUT out along the bearing, over the rim, heading in
    const e = routeEntry(spec, 90, 2);
    expect(e.pos.x).toBeCloseTo(0.5 - ROUTE_ENTRY_OUT, 6);
    expect(e.pos.y).toBe(10 + ROUTE_ENTRY_UP);
    expect(e.vel.x).toBeCloseTo(ROUTE_ENTRY_SPEED, 6);
    expect(e.yaw).toBe(270);
  });

  it('Track F0 in the planner: the burn is 9 to 21, the glide takes on the second airborne input, a jump under a 2-high ceiling never glides', () => {
    expect(BURN).toEqual({ min: 9, max: 21, nominal: 15 });
    expect(GLIDE_DELAY).toBe(1);
    const low = gridOf(world(stack(2)).solid);
    const s: RouteState = { pos: { x: 0.5, y: FEET + 21, z: T + 0.5 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, boost: { ...NO_BOOST }, gliding: false, rockets: 2, wp: 0 };
    const r = stepState(s, { yaw: 0, pitch: 0, fire: false, jump: true, glide: true }, false, BURN.nominal, low);
    expect(r.next.gliding).toBe(false);
    expect(r.next.pos.y).toBe(s.pos.y);
    expect(LOW_CEILING_RISE).toBe(0.25);
    const high = gridOf(world(stack(3)).solid);
    const r3 = stepState(s, { yaw: 0, pitch: 0, fire: false, jump: true, glide: true }, false, BURN.nominal, high);
    expect(r3.next.gliding).toBe(true);
    expect(r3.next.glideIn).toBe(GLIDE_DELAY);
  });

  const CASES: { name: string; boxes: BlockBox[]; spec: LandingRouteSpec; goal: { x: number; y: number; z: number }; maxNodes: number; walls?: boolean }[] = [
    { name: 'the stacked platforms, 2 high', boxes: stack(2), spec: { cells: nine, top: FEET + 21, ceiling: FEET + 23 }, goal: { x: 0, y: FEET + 21, z: T }, maxNodes: 4000 },
    { name: 'the stacked platforms, 3 high', boxes: stack(3), spec: { cells: nine, top: FEET + 21, ceiling: FEET + 24 }, goal: { x: 0, y: FEET + 21, z: T }, maxNodes: 4000 },
    { name: 'the 1 x 1 shaft 10 deep', boxes: shaft1, spec: { cells: [{ x: 0, z: T }], top: FEET, rim: FEET + 10 }, goal: { x: 0, y: FEET, z: T }, maxNodes: 1000 },
    { name: 'a cell under a roof 3 above at ground level', boxes: room3, spec: { cells: [{ x: 0, z: T }], top: FEET, ceiling: FEET + 3 }, goal: { x: 0, y: FEET, z: T }, maxNodes: 40_000 },
    { name: 'a pocket in a cliff face', boxes: pocket, spec: { cells: [{ x: 0, z: T + 2 }], top: FEET + 10, ceiling: FEET + 13 }, goal: { x: 0, y: FEET + 10, z: T + 2 }, maxNodes: 40_000 },
  ];

  it('planLandingRoute finds a plan onto each case from an entry 24 out and 6 up, and the tracker flies it on stepBody with 0 hits', async () => {
    const lines: string[] = [];
    for (const c of CASES) {
      const w = world(c.boxes);
      const grid = gridOf(w.solid);
      const r = await planLandingRoute(grid, c.spec, { rockets: 2 });
      const line = `${c.name}: ${r.tried.join(' | ')}`;
      lines.push(line);
      expect(r.route, line).toBeDefined();
      const rt = r.route!;
      expect(rt.nodes, line).toBeLessThanOrEqual(c.maxNodes);
      const course = { name: c.name, kind: 'field' as const, world: w.solid, fills: [], start: { pos: rt.entry, yaw: rt.yaw, speed: rt.speed, rockets: 2 }, goals: rt.goals, margin: rt.margin, bounds: { min: rt.entry, max: rt.entry }, cells: 0 };
      for (const seed of [1, 2]) {
        const res = flyCourse(course, { seed, maxTicks: 600, maxMs: 600, maxNodes: 40_000, weight: rt.weight, library: 'landing' });
        const fl = `${c.name} seed ${seed}: ${res.success ? 'ok' : res.end}, ${res.hits} hits, ${res.ticks} ticks, ${res.rockets} rockets, plans ${res.stats.plans} (${res.stats.partial} partial), max error ${res.stats.maxError.toFixed(2)}`;
        lines.push(fl);
        expect(res.success, fl).toBe(true);
        expect(res.hits, fl).toBe(0);
      }
    }
    console.log(`[fly-route-landing] plans and tracker flights\n  ${lines.join('\n  ')}`);
  }, 120_000);

  it('findLanding: a 2-high cell is a precision goal with a route (the F1 search alone refuses it); stillLandable asks the route headroom of it; a plain floor keeps the F1 answer', async () => {
    const w = world(stack(2));
    const goal = { x: 0, y: FEET + 21, z: T };
    const deps = { look: w.look, obstacle: (x: number, y: number, z: number) => w.solid.solidAt(x, y, z) === true, probe: () => Promise.resolve({ status: 'found' as const, blocks: 3 }) };
    const without = await findLanding(goal, 'stack', deps, OPTS);
    expect(without.kind).not.toBe('goal');
    const plan = await findLanding(goal, 'stack', { ...deps, route: { grid: gridOf(w.solid), rockets: 2 } }, OPTS);
    expect(plan.kind, plan.line).toBe('goal');
    if (plan.kind !== 'goal') throw new Error(plan.line);
    expect(plan.target.precise).toBe(true);
    expect(plan.target.route).toBeDefined();
    expect(plan.target.bearing).toBe(plan.target.route!.bearing);
    expect(plan.target.cells?.size).toBe(9);
    expect(plan.cell.route).toBe(true);
    expect(plan.line).toMatch(/a route landing in from/);
    expect(ROUTE_HEADROOM).toBe(2);
    expect(stillLandable(w.look, { x: 0, z: T, feet: FEET + 21, precise: true, route: true }, 4)).toBe(true);
    expect(stillLandable(w.look, { x: 0, z: T, feet: FEET + 21, precise: true }, 4)).toBe(false);
    // the 1 x 1 shaft: the brake family (Track F1) still lands it first; no route needed
    const s = world(shaft1);
    const sp = await findLanding({ x: 0, y: FEET, z: T }, 'shaft', { look: s.look, obstacle: (x, y, z) => s.solid.solidAt(x, y, z) === true, probe: () => Promise.resolve({ status: 'found', blocks: 3 }), route: { grid: gridOf(s.solid), rockets: 2 } }, OPTS);
    expect(sp.kind).toBe('goal');
    if (sp.kind === 'goal') expect(sp.target.route).toBeUndefined();
  }, 60_000);

  it('whole trips: the brain cruises in along the bearing, hands over to the tracker and lands on the inner platform of the 2-high stack, 0 hits; the 3-high stack and the room at ground level are still the brake family’s corridor landings (Track F1)', async () => {
    const lines: string[] = [];
    for (const c of CASES.filter((x) => /stacked|roof 3/.test(x.name))) {
      const w = world(c.boxes);
      const grid = gridOf(w.solid);
      const plan = await findLanding(c.goal, c.name, { look: w.look, obstacle: (x, y, z) => w.solid.solidAt(x, y, z) === true, probe: () => Promise.resolve({ status: 'found', blocks: 3 }), route: { grid, rockets: 2 } }, { ...OPTS, from: { x: 0.5, z: 0.5 } });
      expect(plan.kind, plan.line).toBe('goal');
      if (plan.kind !== 'goal') throw new Error(plan.line);
      const routed = c.name.includes('2 high');
      expect(plan.target.route !== undefined, plan.line).toBe(routed);
      for (const seed of [5, 11]) {
        const r = trip(w, { x: 0.5, y: FEET, z: 0.5 }, plan.target, { seed, route: { grid, plan: (req) => planRoute(req, grid), maxMs: 600 } });
        const line = `${c.name} seed ${seed}: ${r.end.ok ? 'ok' : r.end.reason} at ${r.body.pos.x.toFixed(2)} ${r.body.pos.y.toFixed(2)} ${r.body.pos.z.toFixed(2)}, ${r.end.off.toFixed(2)} off, touchdown vy ${r.lastAir.vy.toFixed(2)} h ${r.lastAir.h.toFixed(2)}, ${r.ticks} ticks, ${r.rockets} rockets, ${r.goArounds} go-arounds, route ${r.stats.routeTicks} ticks (${r.stats.routePlans} plans, ${r.stats.routeReplans} re-plans, max error ${r.stats.routeMaxError.toFixed(2)}), hits ${r.hits}; ${r.notes.filter((n) => n.includes('route landing')).join(' ; ')}`;
        lines.push(line);
        expect(r.end.ok, line).toBe(true);
        expect(onTarget(plan.target, r.body.pos), line).toBe(true);
        expect(r.body.pos.y, line).toBeCloseTo(plan.target.top, 2);
        expect(r.hits, line).toBe(0);
        if (routed) expect(r.stats.routeTicks, line).toBeGreaterThan(0);
        expect(r.lastAir.vy, line).toBeGreaterThan(-0.5);
      }
    }
    console.log(`[fly-route-landing] whole trips\n  ${lines.join('\n  ')}`);
  }, 240_000);
});

describe('fly: the route takeoff (Track F3)', () => {
  const TAKEOFFS: { name: string; boxes: BlockBox[]; from: { x: number; y: number; z: number } }[] = [
    { name: 'out of the 3-high stack', boxes: stack(3), from: { x: 0.5, y: FEET + 21, z: T + 0.5 } },
    { name: 'out of a 1 x 1 hole 2 deep', boxes: [b(0, FEET - 2, T, 0, FEET - 1, T, false)], from: { x: 0.5, y: FEET - 2, z: T + 0.5 } },
    { name: 'from under a roof 3 above', boxes: room3, from: { x: 0.5, y: FEET, z: T + 0.5 } },
  ];

  it('exitsFrom floods the air for cells under open sky; planTakeoffRoute plans the jump, the glide and a rocket out, and the tracker flies it on stepBody', async () => {
    const lines: string[] = [];
    for (const c of TAKEOFFS) {
      const w = world(c.boxes);
      const grid = gridOf(w.solid);
      const exits = exitsFrom(grid, c.from);
      expect(exits.length, c.name).toBeGreaterThan(0);
      expect(exits[0]!.y, c.name).toBeGreaterThanOrEqual(Math.floor(c.from.y));
      const r = await planTakeoffRoute(grid, c.from, { x: 0.5, z: 0 }, { rockets: 4 });
      const line = `${c.name}: ${r.exits} exits; ${r.tried.join(' | ')}`;
      lines.push(line);
      expect(r.route, line).toBeDefined();
      const rt = r.route!;
      const course = { name: c.name, kind: 'stair' as const, world: w.solid, fills: [], start: { pos: c.from, yaw: rt.yaw, speed: 0, standing: true, rockets: 4 }, goals: rt.goals, margin: rt.margin, bounds: { min: c.from, max: c.from }, cells: 0 };
      for (const seed of [1, 2]) {
        const res = flyCourse(course, { seed, maxTicks: 300, maxMs: 600, maxNodes: 40_000, weight: rt.weight });
        const fl = `${c.name} seed ${seed}: ${res.success ? 'ok' : res.end}, ${res.hits} hits, ${res.ticks} ticks, ${res.rockets} rockets, plans ${res.stats.plans}`;
        lines.push(fl);
        expect(res.success, fl).toBe(true);
        expect(res.hits, fl).toBe(0);
      }
    }
    // under the 2-high ceiling no jump glides (Track F0): no route out of the inner platform of the 2-high stack
    const low = world(stack(2));
    const none = await planTakeoffRoute(gridOf(low.solid), { x: 0.5, y: FEET + 21, z: T + 0.5 }, { x: 0.5, z: 0 }, { rockets: 4 });
    expect(none.route).toBeUndefined();
    console.log(`[fly-route-landing] takeoffs\n  ${lines.join('\n  ')}`);
  }, 120_000);

  it('a whole trip: the brain takes off out of the 3-high stack by the route, climbs and lands 300 blocks away', async () => {
    const w = world(stack(3));
    const grid = gridOf(w.solid);
    const from = { x: 0.5, y: FEET + 21, z: T + 0.5 };
    const r = await planTakeoffRoute(grid, from, { x: 0.5, z: 0 }, { rockets: 4 });
    expect(r.route).toBeDefined();
    const target = { x: 0.5, z: 0.5, top: FEET, half: 1, ground: FEET };
    const t = trip(w, from, target, { seed: 5, route: { grid, plan: (req) => planRoute(req, grid), maxMs: 600 }, routeTakeoff: { goals: r.route!.goals, margin: r.route!.margin, weight: r.route!.weight }, takeoffYaw: r.route!.yaw, rockets: 16 });
    const line = `${t.end.ok ? 'ok' : t.end.reason} at ${t.body.pos.x.toFixed(1)} ${t.body.pos.y.toFixed(1)} ${t.body.pos.z.toFixed(1)}, ${t.ticks} ticks, ${t.rockets} rockets, route takeoff ${t.stats.routeTakeoffTicks} ticks, hits ${t.hits}; ${t.notes.filter((n) => n.includes('route')).join(' ; ')}`;
    expect(t.stats.routeTakeoffTicks, line).toBeGreaterThan(0);
    expect(t.hits, line).toBe(0);
    expect(t.end.ok, line).toBe(true);
    console.log(`[fly-route-landing] route takeoff trip: ${line}`);
  }, 60_000);
});
