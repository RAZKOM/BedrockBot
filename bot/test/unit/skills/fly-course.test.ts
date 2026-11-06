// Track F4a (docs/flight.md "Obstacle course (Track F4a)", decisions/0067): the obstacle courses offline. The layout
// is the truth pack's (packs/truth/src/course-layout.ts, what `truth:course` builds); route/courses.ts turns it into
// one Course per leg over the same world, and bench.ts flies the legs on stepBody. Also the F0 model in the route
// code: no rocket on the glide's first input, a held fire drops the burn the tracker assumed.
import { describe, expect, it } from 'vitest';
import { COURSE_NAMES, courseLayout, type CourseLayout } from '../../../../packs/truth/src/course-layout.ts';
import { flatWorld } from '../../../src/skills/input/world.ts';
import { COURSE_BURNS, flyCourse, flyLegs, scoreLine, scoreOf } from '../../../src/skills/fly/route/bench.ts';
import { layoutWorld, obstacleCourse } from '../../../src/skills/fly/route/courses.ts';
import { gridOf, gridOfCells } from '../../../src/skills/fly/route/grid.ts';
import { ROUTE_WEIGHT } from '../../../src/skills/fly/route/landing.ts';
import { inBurnTail, stepState, takeoff } from '../../../src/skills/fly/route/primitives.ts';
import { planRoute } from '../../../src/skills/fly/route/search.ts';
import { RouteTracker, type Planner } from '../../../src/skills/fly/route/tracker.ts';
import { BURN, GLIDE_DELAY, NO_BOOST, burnTick, freshBurn, type RouteGoal, type RoutePlan, type RouteRequest, type RouteState } from '../../../src/skills/fly/route/types.ts';

const O = { x: 0, y: -60, z: 0 };

/** The block after the ops at a cell (later ops win), or undefined outside every op. */
function blockAt(l: CourseLayout, x: number, y: number, z: number): string | undefined {
  let b: string | undefined;
  for (const op of l.ops) if (x >= op.from.x && x <= op.to.x && y >= op.from.y && y <= op.to.y && z >= op.from.z && z <= op.to.z) b = op.block;
  return b;
}

describe('fly: the obstacle courses (Track F4a)', () => {
  it('layoutWorld is the layout the truth pack builds: every op painted in order inside the bounds, the flat world outside', () => {
    const flat = flatWorld();
    for (const name of COURSE_NAMES) {
      const l = courseLayout(name, O)!;
      const w = layoutWorld(l);
      const { min, max } = l.bounds;
      // a deterministic sample of the box (every 3rd cell on each axis) and its faces' outside neighbours
      for (let y = min.y; y <= max.y; y += 3) {
        for (let z = min.z; z <= max.z; z += 3) {
          for (let x = min.x; x <= max.x; x += 3) {
            const b = blockAt(l, x, y, z);
            expect(w.solidAt(x, y, z), `${name} ${x} ${y} ${z}`).toBe(b === undefined ? flat.solidAt(x, y, z) === true : b !== 'air');
          }
        }
      }
      for (const [x, y, z] of [[min.x - 1, O.y, min.z], [max.x + 1, O.y - 1, max.z], [min.x, max.y + 1, min.z]] as const) expect(w.solidAt(x, y, z)).toBe(flat.solidAt(x, y, z));
    }
  });

  it('obstacleCourse: one Course per leg; the landings flown with the landing edges and the route weight, as the brain flies them', () => {
    const [stack] = obstacleCourse('stack');
    expect(stack!.goals[0]!.kind).toBe('landing');
    expect(stack!.library).toBe('landing');
    expect(stack!.weight).toBe(ROUTE_WEIGHT);
    const [rings] = obstacleCourse('rings');
    expect(rings!.goals.every((g) => g.kind === 'waypoint')).toBe(true);
    expect(rings!.library).toBeUndefined();
    expect(rings!.labels?.length).toBe(rings!.goals.length);
    const full = obstacleCourse('full', { x: 1000, y: -60, z: 2000 });
    expect(full.map((c) => c.name)).toEqual(['full/climb', 'full/weave', 'full/ledge', 'full/finish', 'full/stack', 'full/shaft']);
    expect(full.map((c) => c.chained)).toEqual([false, true, true, true, false, false]);
    // every leg's start is in the air of its world (standing: on a floor)
    for (const c of full) {
      const p = c.start.pos;
      expect(c.world.solidAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), c.name).toBe(false);
      if (c.start.standing) expect(c.world.solidAt(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)), c.name).toBe(true);
    }
    expect(() => obstacleCourse('nope')).toThrow();
  });

  it('the F0 model in stepState: a rocket on the glide’s first input after a jump does nothing, on the next it burns', () => {
    const grid = gridOf(flatWorld());
    let s: RouteState = { pos: { x: 0.5, y: -60, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, boost: { ...NO_BOOST }, gliding: false, rockets: 3, wp: 0 };
    s = stepState(s, { yaw: 0, pitch: 0, fire: false, jump: true, glide: true }, false, BURN.nominal, grid).next;
    for (let k = 0; k < GLIDE_DELAY; k++) s = stepState(s, { yaw: 0, pitch: -20, fire: true }, false).next;
    expect(s.glideIn).toBeUndefined();
    expect(s.glideFresh).toBe(true);
    const first = stepState(s, { yaw: 0, pitch: -20, fire: true }, false);
    expect(first.fired).toBe(false);
    expect(first.next.rockets).toBe(3);
    expect(first.next.glideFresh).toBeUndefined();
    const second = stepState(first.next, { yaw: 0, pitch: -20, fire: true }, false);
    expect(second.fired).toBe(true);
    expect(second.next.rockets).toBe(2);
    // the takeoff edge asks for its rocket on that second gliding input, not on the first
    const t = takeoff(0, -20, true);
    expect(t.control(s, s, 2).fire).toBe(false);
    expect(t.control(s, first.next, 3).fire).toBe(true);
  });

  it('the tracker: a fire the driver held drops the assumed burn and goes again on the next tick', () => {
    const grid = gridOf(flatWorld());
    const tracker = new RouteTracker({ grid, margin: 0.3, goals: [{ kind: 'waypoint', box: { min: { x: -5, y: -50, z: 60 }, max: { x: 5, y: -30, z: 62 } } }], plan: (req) => planRoute(req, grid), maxNodes: 20_000, maxMs: 200 });
    const body = { pos: { x: 0.5, y: -50, z: 0.5 }, vel: { x: 0, y: -0.05, z: 0.6 }, gliding: true, onGround: false, rockets: 4 };
    let fired = -1;
    for (let t = 0; t < 40 && fired < 0; t++) {
      const out = tracker.tick(body, t);
      if (out.control.fire) fired = t;
      body.pos = { x: body.pos.x + body.vel.x, y: body.pos.y + body.vel.y, z: body.pos.z + body.vel.z };
    }
    if (fired < 0) return; // (the plan needed no rocket from here: nothing to hold)
    expect(tracker.boostRange.max).toBeGreaterThan(0);
    tracker.fireHeld();
    expect(tracker.boostRange.max).toBe(0);
    expect(tracker.stats.fired).toBe(0);
    const again = tracker.tick(body, fired + 1);
    expect(again.control.fire).toBe(true);
  });

  it('a rocket may go once the burn may be over (its earliest end): the union of the two lifetimes, never in its first ticks', () => {
    let b = freshBurn();
    expect(inBurnTail(b)).toBe(false);
    expect(inBurnTail(NO_BOOST)).toBe(false);
    for (let k = 0; k < BURN.min - 1; k++) b = burnTick(b);
    expect(b.min).toBeGreaterThan(0);
    expect(inBurnTail(b)).toBe(false);
    b = burnTick(b);
    expect(b).toMatchObject({ min: 0 });
    expect(b.nom).toBeGreaterThan(0);
    expect(inBurnTail(b)).toBe(true);
    // in the model: a rocket there starts a fresh burn (the union), one in the burn's first ticks does nothing
    const s: RouteState = { pos: { x: 0.5, y: -40, z: 0.5 }, vel: { x: 0, y: -0.05, z: 1.2 }, yaw: 0, boost: b, gliding: true, rockets: 3, wp: 0 };
    const fired = stepState(s, { yaw: 0, pitch: 0, fire: true }, false);
    expect(fired.fired).toBe(true);
    expect(fired.next.rockets).toBe(2);
    const early = stepState({ ...s, boost: freshBurn() }, { yaw: 0, pitch: 0, fire: true }, false);
    expect(early.fired).toBe(false);
  });

  it('the tracker with a lead: the first plan of a gliding body starts where the hold takes it, and the hold flies until then', () => {
    const grid = gridOf(flatWorld());
    const lead = 6;
    let asked: RouteState | undefined;
    const tracker = new RouteTracker({ grid, margin: 0.3, goals: [{ kind: 'waypoint', box: { min: { x: -5, y: -50, z: 60 }, max: { x: 5, y: -30, z: 62 } } }], plan: (req) => {
        asked ??= req.start;
        return planRoute(req, grid);
      }, maxNodes: 20_000, maxMs: 200, lead });
    let body: RouteState = { pos: { x: 0.5, y: -45, z: 0.5 }, vel: { x: 0, y: -0.05, z: 0.6 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 4, wp: 0 };
    for (let t = 0; t < lead; t++) {
      const out = tracker.tick({ pos: body.pos, vel: body.vel, gliding: true, onGround: false, rockets: 4 }, t);
      expect(out.status, `tick ${t}`).toBe('planning');
      expect(out.control).toMatchObject({ pitch: 0, fire: false });
      body = stepState(body, out.control, false).next;
    }
    // the plan was asked for the state the body is in now, and tracking starts from it
    expect(asked).toBeDefined();
    expect(Math.hypot(asked!.pos.x - body.pos.x, asked!.pos.y - body.pos.y, asked!.pos.z - body.pos.z)).toBeLessThan(1e-9);
    const out = tracker.tick({ pos: body.pos, vel: body.vel, gliding: true, onGround: false, rockets: 4 }, lead);
    expect(out.status).toBe('tracking');
    expect(out.error).toBeLessThan(1e-9);
  });

  it('no powered flight on a plan that grazes a solid (PLAN_CLEAR_MIN) or without a plan; with no plan the hold steers clear of a wall', () => {
    const open = gridOfCells(() => false);
    const goals: RouteGoal[] = [{ kind: 'waypoint', box: { min: { x: -5, y: -10, z: 60 }, max: { x: 5, y: 10, z: 62 } } }];
    const start: RouteState = { pos: { x: 0.5, y: 0, z: 0.5 }, vel: { x: 0, y: -0.05, z: 0.8 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 4, wp: 0 };
    // a plan whose first control fires, at a clearance: the rocket goes on 0.4, not on 0 (the Realm cave's partial plans)
    const planAt = (clearance: number) => (req: RouteRequest): RoutePlan => {
      const controls = Array.from({ length: 12 }, (_, i) => ({ yaw: 0, pitch: 0, fire: i === 0 }));
      const states: RouteState[] = [];
      let s = req.start;
      for (const c of controls) states.push((s = stepState(s, c, false).next));
      return { controls, states, edges: [{ name: 'rocket', at: 0, ticks: 12 }], ticks: 12, rockets: 1, cost: 12, clearance, complete: false, reached: 0, robust: true, nodes: 1, expanded: 1, ms: 0, budget: 'nodes' };
    };
    const body = { pos: start.pos, vel: start.vel, gliding: true, onGround: false, rockets: 4 };
    const safe = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planAt(0.4), maxNodes: 1, maxMs: 1 });
    expect(safe.tick(body, 0).control.fire).toBe(true);
    const notes: string[] = [];
    const grazing = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planAt(0), maxNodes: 1, maxMs: 1, note: (m) => notes.push(m) });
    const out = grazing.tick(body, 0);
    expect(out.status).toBe('tracking');
    expect(out.control.fire).toBe(false);
    expect(grazing.stats.refused).toBe(1);
    expect(grazing.stats.fired).toBe(0);
    expect(notes.some((m) => m.includes('no rocket on a plan with clearance 0.00'))).toBe(true);
    // no plan yet (the worker has not answered): a level hold along the heading in open air, the evade rule before a wall
    const never: Planner = () => new Promise<RoutePlan>(() => {});
    const inAir = new RouteTracker({ grid: open, margin: 0.3, goals, plan: never, maxNodes: 1, maxMs: 1 });
    const h = inAir.tick(body, 0);
    expect(h.status).toBe('planning');
    expect(h.control).toMatchObject({ pitch: 0, fire: false });
    expect(Math.abs(h.control.yaw)).toBeLessThan(1e-9);
    expect(inAir.stats.evadeTicks).toBe(0);
    const walled = new RouteTracker({ grid: gridOfCells((_x, _y, z) => z === 5), margin: 0.3, goals, plan: never, maxNodes: 1, maxMs: 1 });
    const w = walled.tick(body, 0);
    expect(w.control.fire).toBe(false);
    expect(walled.stats.evadeTicks).toBe(1);
    expect(walled.stats.holdTicks).toBe(0);
  });

  it('the stations fly offline: the staircase from standing, chained legs go on from the body the last one ended with', () => {
    const [stair] = obstacleCourse('stair');
    const r = flyCourse(stair!, { seed: 1, burn: BURN.nominal, maxMs: 600, maxNodes: 40_000, continueOnHit: true });
    expect(r.success, `${r.end} ${r.reached}/${r.goals}`).toBe(true);
    expect(r.damage).toBe(0);
    const s = scoreOf('stair', [r]);
    expect(scoreLine(s)).toMatch(/^stair: 1\/1 done, 1 clean/);
    expect(COURSE_BURNS).toContain(BURN.min);
    expect(COURSE_BURNS).toContain(BURN.max);
    // the rings split into two legs: the second, chained, starts from the body the first ended with, not from its own
    // start (put in the ground here: from there it could not fly at all)
    const [rings] = obstacleCourse('rings');
    const legs = [
      { ...rings!, name: 'rings/a', goals: rings!.goals.slice(0, 2) },
      { ...rings!, name: 'rings/b', goals: rings!.goals.slice(2), chained: true, start: { ...rings!.start, pos: { x: 0.5, y: -70, z: 0.5 } } },
    ];
    const rs = flyLegs(legs, { seed: 3, burn: BURN.nominal, maxMs: 600, maxNodes: 40_000 });
    expect(rs.length).toBe(2);
    expect(rs[0]!.success, `${rs[0]!.end} ${rs[0]!.reached}/${rs[0]!.goals}`).toBe(true);
    expect(rs[1]!.success, `${rs[1]!.end} ${rs[1]!.reached}/${rs[1]!.goals}`).toBe(true);
    expect(rs[1]!.rocketsLeft).toBeLessThanOrEqual(rs[0]!.rocketsLeft);
  }, 120_000);
});
