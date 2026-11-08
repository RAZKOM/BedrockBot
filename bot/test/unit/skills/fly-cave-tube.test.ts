// Track F7 (docs/flight.md "Tight passages (Track F7)", decisions/0073): the guard tests. The tube controller on the
// tracker (the body matched to the plan by position, the forecast bail-out, the sink onto a dry floor), the burn
// branches carried across the search's pieces, the bench's rockets in the burn's tail, and the style's numbers.
import { describe, expect, it } from 'vitest';
import { flatWorld, withBoxes } from '../../../src/skills/input/world.ts';
import { CAVE_STYLE } from '../../../src/skills/fly/cave/style.ts';
import { landingGoal, viaGoal } from '../../../src/skills/fly/corridor/stretches.ts';
import { windowRequest } from '../../../src/skills/fly/corridor/drive.ts';
import { gridOf, gridOfCells } from '../../../src/skills/fly/route/grid.ts';
import { replay, stepState } from '../../../src/skills/fly/route/primitives.ts';
import { planRoute } from '../../../src/skills/fly/route/search.ts';
import { LOCATE_AHEAD, RouteTracker, SINK_REACH } from '../../../src/skills/fly/route/tracker.ts';
import { BURN, NO_BOOST, type RouteControl, type RouteGoal, type RoutePlan, type RouteRequest, type RouteState } from '../../../src/skills/fly/route/types.ts';
import { gridOfSnapshot, snapshotFor } from '../../../src/skills/fly/route/worker.ts';

const F = -60;
const open = gridOfCells(() => false);
const far: RouteGoal[] = [{ kind: 'waypoint', box: { min: { x: -5, y: -10, z: 390 }, max: { x: 5, y: 10, z: 392 } } }];

/** A level plan of `n` ticks along +z from `req.start` (the first control fires when `fire`). */
function levelPlan(n: number, fire: boolean) {
  return (req: RouteRequest): RoutePlan => {
    const controls: RouteControl[] = Array.from({ length: n }, (_, i) => ({ yaw: 0, pitch: fire ? -10 : 0, fire: fire && i === 0 }));
    const states = replay(req.start, controls, req.goals, false);
    return { controls, states, edges: [{ name: 'glide', at: 0, ticks: n }], ticks: n, rockets: fire ? 1 : 0, cost: n, clearance: 0.5, complete: true, reached: 1, robust: true, nodes: 1, expanded: 1, ms: 0, budget: 'none' };
  };
}

const bodyOf = (s: RouteState, rockets = 4) => ({ pos: s.pos, vel: s.vel, gliding: true, onGround: false, rockets });

describe('the tube controller (route/tracker.ts rules.tube, Track F7)', () => {
  it('matches the body to the plan by position: a body carried ahead by a long burn is matched up to LOCATE_AHEAD states on, and its error stays small', () => {
    expect(LOCATE_AHEAD).toBeGreaterThanOrEqual(6);
    const start: RouteState = { pos: { x: 0.5, y: 0, z: 0.5 }, vel: { x: 0, y: -0.05, z: 0.8 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 4, wp: 0 };
    const errs = { tube: 0, plain: 0 };
    for (const tube of [true, false]) {
      const t = new RouteTracker({ grid: open, margin: 0.3, goals: far, plan: levelPlan(80, true), maxNodes: 1, maxMs: 1, rules: { ...CAVE_STYLE.rules, tube, retime: false, bailError: undefined } });
      let body: RouteState = { ...start };
      let o = t.tick(bodyOf(body), 0);
      expect(o.control.fire).toBe(true);
      // the body burns 21 (the plan assumed 15): it runs ahead of the time index
      let maxErr = 0;
      for (let k = 1; k <= 40; k++) {
        body = stepState(body, o.control, false, BURN.max).next;
        o = t.tick(bodyOf(body, 3), k);
        if (k > 25 && o.status === 'tracking') maxErr = Math.max(maxErr, o.error);
      }
      if (tube) errs.tube = maxErr;
      else errs.plain = maxErr;
    }
    // with the tube the body is matched to where it is on the path (the error left is the height the longer burn gained);
    // without, to the timetable's point behind it
    expect(errs.tube).toBeLessThan(1.0);
    expect(errs.tube).toBeLessThan(errs.plain);
  });

  it('bails out on its own forecast: a plan whose controls fly the body into a wall brakes before the wall, and the hit is light', () => {
    // a wall across the bore 30 ahead; the plan (a level glide at 1.6 a tick) runs straight at it
    const wallZ = 30;
    const grid = gridOfCells((x, y, z) => z >= wallZ && z < wallZ + 2 && Math.abs(x) < 6 && y > -8 && y < 8);
    const start: RouteState = { pos: { x: 0.5, y: 0, z: 0.5 }, vel: { x: 0, y: -0.02, z: 1.6 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 0, wp: 0 };
    const t = new RouteTracker({ grid, margin: 0.3, goals: far, plan: levelPlan(60, false), maxNodes: 1, maxMs: 1, rules: { ...CAVE_STYLE.rules, bailError: undefined } });
    let body: RouteState = { ...start };
    let bailedAt = -1;
    let speedAtWall = Infinity;
    for (let k = 0; k < 60; k++) {
      const o = t.tick(bodyOf(body, 0), k);
      if (o.status === 'bailing' && bailedAt < 0) bailedAt = k;
      body = stepState(body, o.control, false).next;
      if (body.pos.z >= wallZ - 0.6) {
        speedAtWall = Math.hypot(body.vel.x, body.vel.z);
        break;
      }
    }
    expect(bailedAt).toBeGreaterThanOrEqual(0);
    // the brake began while the wall was still some ticks away, and the body reaches it slowly, or not at all (Infinity)
    expect(start.pos.z + 1.6 * bailedAt).toBeLessThan(wallZ - 4);
    expect(speedAtWall === Infinity || speedAtWall < 0.6).toBe(true);
  });

  it('the bail-out sinks onto a dry floor within SINK_REACH when the column under the body is water', () => {
    // the floor at y -1 everywhere; the cells under the body's column and its neighbours in x are water (solid to the grid, no floor)
    const water = (x: number, z: number): boolean => Math.abs(x - 0) <= 1 && z >= 0 && z < 40;
    const solid = (x: number, y: number, z: number): boolean => y <= -1 || (y <= 1 && water(x, z) && y >= -1);
    const grid = gridOfCells((x, y, z) => solid(x, y, z) || y <= -1);
    const floor = (x: number, y: number, z: number): boolean => y <= -1 && !water(x, z);
    const start: RouteState = { pos: { x: 0.5, y: 6, z: 10.5 }, vel: { x: 0, y: -0.05, z: 0.25 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 0, wp: 0 };
    // no plan at all: the body glides without one and bails out after `bailAfter` ticks
    const planless = (): RoutePlan => ({ controls: [], states: [], edges: [], ticks: 0, rockets: 0, cost: 0, clearance: 1, complete: false, reached: 0, robust: false, nodes: 1, expanded: 0, ms: 0, budget: 'none' });
    const t = new RouteTracker({ grid, margin: 0.3, goals: far, plan: planless, maxNodes: 1, maxMs: 1, rules: { ...CAVE_STYLE.rules }, floor });
    let body: RouteState = { ...start };
    let k = 0;
    for (; k < 200 && body.pos.y > 2.1; k++) {
      const o = t.tick(bodyOf(body, 0), k);
      body = stepState(body, o.control, false).next;
    }
    expect(t.bailing).toBe(true);
    // the body came down over a dry column, not over the water it was above, within reach
    expect(Math.abs(Math.floor(body.pos.x) - 0)).toBeGreaterThan(1);
    expect(Math.abs(Math.floor(body.pos.x) - 0)).toBeLessThanOrEqual(SINK_REACH);
    expect(floor(Math.floor(body.pos.x), -1, Math.floor(body.pos.z))).toBe(true);
  });
});

describe('the burn branches across the pieces (route/search.ts planPieces, Track F7)', () => {
  it('a piece starts from the piece before with its early and late bodies, so a joined plan with a rocket early is swept for the burn to the end', () => {
    const w = withBoxes(flatWorld(), [
      { from: { x: -3, y: F, z: -2 }, to: { x: 3, y: F + 4, z: 92 }, solid: true },
      { from: { x: -1, y: F, z: 0 }, to: { x: 1, y: F + 2, z: 90 }, solid: false },
    ]);
    const grid = gridOf(w);
    const solid = (x: number, y: number, z: number) => w.solidAt(x, y, z) === true;
    const goals: RouteGoal[] = [viaGoal({ x: 0.5, y: F, z: 20.5 }), viaGoal({ x: 0.5, y: F, z: 40.5 }), viaGoal({ x: 0.5, y: F, z: 60.5 }), landingGoal({ x: 0, y: F, z: 86 }, solid)];
    const req = { ...windowRequest({ goals }, { x: 0.5, y: F, z: 2.5 }, 16, { margin: 0.3, maxNodes: 40_000, maxMs: 60_000, riskCost: 2 }), pieces: 2 };
    const p = planRoute(req, gridOfSnapshot(snapshotFor(grid, req)));
    expect(p.complete, p.why).toBe(true);
    // the states are a plain replay (no branches on them); replayed with the branches on, the body carries them past the
    // first piece's end as the search did
    const withB = replay(req.start, p.controls, req.goals, false, true);
    const firstFire = p.controls.findIndex((c) => c.fire);
    if (firstFire >= 0) {
      const midway = withB[Math.min(withB.length - 1, firstFire + 25)]!;
      expect(midway.early !== undefined || midway.boost.max === 0).toBe(true);
    }
    expect(p.states.every((s) => s.early === undefined)).toBe(true);
  }, 120_000);
});

describe('the style’s numbers (cave/style.ts, Track F7)', () => {
  it('the tube on, the blocked-plan bail-out off', () => {
    expect(CAVE_STYLE.rules.tube).toBe(true);
    expect(CAVE_STYLE.rules.blockedBail).toBe(false);
  });
});
