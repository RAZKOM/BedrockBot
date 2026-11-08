// Track F6 (docs/flight.md "Tight cave flight (Track F6)", decisions/0071): the guard tests. The search in pieces, the
// geodesic distance field (kept, off in the style), the tracker's re-timed reference under a burn other than the
// plan's nominal, and the style's numbers.
import { describe, expect, it } from 'vitest';
import { flatWorld, withBoxes } from '../../../src/skills/input/world.ts';
import { CAVE_STYLE, caveExecutorOptions, caveMargin, caveStretchOptions } from '../../../src/skills/fly/cave/style.ts';
import { landingGoal, viaGoal } from '../../../src/skills/fly/corridor/stretches.ts';
import { windowRequest } from '../../../src/skills/fly/corridor/drive.ts';
import { buildField, fieldDistance } from '../../../src/skills/fly/route/field.ts';
import { gridOf, gridOfCells } from '../../../src/skills/fly/route/grid.ts';
import { replayBurns, stepState } from '../../../src/skills/fly/route/primitives.ts';
import { planRoute } from '../../../src/skills/fly/route/search.ts';
import { RouteTracker } from '../../../src/skills/fly/route/tracker.ts';
import { BURN, NO_BOOST, type RouteControl, type RouteGoal, type RoutePlan, type RouteRequest, type RouteState } from '../../../src/skills/fly/route/types.ts';
import { gridOfSnapshot, snapshotFor } from '../../../src/skills/fly/route/worker.ts';

const F = -60;

/** A 3 x 3 bore along +z from z 0 to `len` (the hull in stone), feet F. */
function bore(len: number) {
  const w = withBoxes(flatWorld(), [
    { from: { x: -3, y: F, z: -2 }, to: { x: 3, y: F + 4, z: len + 2 }, solid: true },
    { from: { x: -1, y: F, z: 0 }, to: { x: 1, y: F + 2, z: len }, solid: false },
  ]);
  return { world: w, solid: (x: number, y: number, z: number) => w.solidAt(x, y, z) === true, grid: gridOf(w) };
}

describe('the search in pieces (route/search.ts planPieces, Track F6)', () => {
  it('a long bore with many goals completes in pieces where one search runs out of budget, and the joined plan is one plan', () => {
    const { solid, grid } = bore(120);
    const goals: RouteGoal[] = [viaGoal({ x: 0.5, y: F, z: 20.5 }), viaGoal({ x: 0.5, y: F, z: 40.5 }), viaGoal({ x: 0.5, y: F, z: 60.5 }), viaGoal({ x: 0.5, y: F, z: 80.5 }), viaGoal({ x: 0.5, y: F, z: 100.5 }), landingGoal({ x: 0, y: F, z: 116 }, solid)];
    const from = { x: 0.5, y: F, z: 2.5 };
    const base = windowRequest({ goals }, from, 16, { margin: 0.3, maxNodes: 20_000, maxMs: 60_000, riskCost: 2 });
    const whole = planRoute(base, gridOfSnapshot(snapshotFor(grid, base)));
    const pieces = planRoute({ ...base, pieces: 3 }, gridOfSnapshot(snapshotFor(grid, base)));
    expect(pieces.complete, pieces.why).toBe(true);
    expect(pieces.reached).toBe(goals.length);
    expect(pieces.states.length).toBe(pieces.controls.length);
    expect(pieces.ticks).toBe(pieces.controls.length);
    // the edges' offsets run through the joined controls in order
    let at = 0;
    for (const e of pieces.edges) {
      expect(e.at).toBe(at);
      at += e.ticks;
    }
    expect(at).toBe(pieces.controls.length);
    // the joined states are the controls re-flown from the start: the last one stands on the landing
    const last = pieces.states[pieces.states.length - 1]!;
    expect(last.wp).toBe(goals.length);
    expect(last.gliding).toBe(false);
    // the whole search either completes or needs more of the budget than the pieces did
    if (whole.complete) expect(pieces.nodes).toBeLessThanOrEqual(whole.nodes * 1.5 + 2000);
    else expect(whole.reached).toBeLessThan(goals.length);
  }, 120_000);

  it('a partial piece leaves a partial plan whose reached count is the goals passed, never more than the pieces proved', () => {
    const { solid, grid } = bore(40);
    // a goal nothing can pass: a box off in the rock beside the bore
    const goals: RouteGoal[] = [viaGoal({ x: 0.5, y: F, z: 20.5 }), { kind: 'waypoint', box: { min: { x: 20, y: F, z: 20 }, max: { x: 23, y: F + 3, z: 23 } } }, landingGoal({ x: 0, y: F, z: 36 }, solid)];
    const req = { ...windowRequest({ goals }, { x: 0.5, y: F, z: 2.5 }, 16, { margin: 0.3, maxNodes: 3000, maxMs: 10_000 }), pieces: 1 };
    const p = planRoute(req, gridOfSnapshot(snapshotFor(grid, req)));
    expect(p.complete).toBe(false);
    expect(p.reached).toBe(1);
    expect(p.states.length).toBe(p.controls.length);
    expect(p.why).toBeDefined();
  }, 60_000);
});

describe('the geodesic distance field (route/field.ts; kept, off in the style)', () => {
  it('measures round a bend through the cells the body fits in, and never through a one-cell crack', () => {
    // an L: a 3 x 3 bore +z from z 0 to 30, then +x from x 0 to 30 at z 28 .. 30; a 1-wide crack straight on at z 31 .. 60
    const w = withBoxes(flatWorld(), [
      { from: { x: -3, y: F, z: -2 }, to: { x: 33, y: F + 4, z: 62 }, solid: true },
      { from: { x: -1, y: F, z: 0 }, to: { x: 1, y: F + 2, z: 30 }, solid: false },
      { from: { x: -1, y: F, z: 28 }, to: { x: 30, y: F + 2, z: 30 }, solid: false },
      { from: { x: 0, y: F, z: 31 }, to: { x: 0, y: F + 2, z: 60 }, solid: false },
    ]);
    const grid = gridOf(w);
    const start = { x: 0.5, y: F, z: 1.5 };
    const goal: RouteGoal = viaGoal({ x: 29.5, y: F, z: 29.5 });
    const f = buildField(grid, start, [goal], 0.3);
    const d = fieldDistance(f, 0, start);
    expect(d).toBeDefined();
    // the straight line is about 40; the way round the corner about 56
    expect(d!).toBeGreaterThan(50);
    expect(d!).toBeLessThan(62);
    expect(fieldDistance(f, 0, { x: 29.5, y: F, z: 29.5 })).toBe(0);
    // the crack (1 wide) is no way for the body: no distance there; solid cells and cells outside the box neither
    expect(fieldDistance(f, 0, { x: 0.5, y: F, z: 45.5 })).toBeUndefined();
    expect(fieldDistance(f, 0, { x: 10.5, y: F, z: 10.5 })).toBeUndefined();
    expect(fieldDistance(f, 0, { x: 500, y: F, z: 500 })).toBeUndefined();
    expect(f.rest[0]).toBe(0);
  });

  it('chains the goals: the rest of goal i is the way from it through the ones after', () => {
    const { grid } = bore(80);
    const goals: RouteGoal[] = [viaGoal({ x: 0.5, y: F, z: 20.5 }), viaGoal({ x: 0.5, y: F, z: 50.5 }), viaGoal({ x: 0.5, y: F, z: 70.5 })];
    const f = buildField(grid, { x: 0.5, y: F, z: 2.5 }, goals, 0.3);
    expect(f.dist.length).toBe(3);
    expect(f.rest[2]).toBe(0);
    expect(f.rest[1]).toBeGreaterThan(15);
    expect(f.rest[0]).toBeGreaterThan(f.rest[1]!);
    const at = fieldDistance(f, 0, { x: 0.5, y: F, z: 2.5 })!;
    expect(at).toBeGreaterThan(60);
    expect(at).toBeLessThan(75);
    // a request with the flag runs the same search over the field and still completes
    const req: RouteRequest = { ...windowRequest({ goals }, { x: 0.5, y: F, z: 2.5 }, 16, { margin: 0.3, maxNodes: 20_000, maxMs: 30_000 }), geodesic: true };
    const p = planRoute(req, gridOfSnapshot(snapshotFor(grid, req)));
    expect(p.complete, p.why).toBe(true);
  }, 60_000);
});

describe('the re-timed reference (route/tracker.ts retime, Track F6)', () => {
  const open = gridOfCells(() => false);
  const goals: RouteGoal[] = [{ kind: 'waypoint', box: { min: { x: -5, y: -10, z: 190 }, max: { x: 5, y: 10, z: 192 } } }];
  const start: RouteState = { pos: { x: 0.5, y: 0, z: 0.5 }, vel: { x: 0, y: -0.05, z: 0.8 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 4, wp: 0 };
  /** A plan of `n` climbing ticks (pitch -30: the burn's length shows in the climb; a level glide at 1.6 barely slows) whose first control fires. */
  const planOf = (n: number) => (req: RouteRequest): RoutePlan => {
    const controls: RouteControl[] = Array.from({ length: n }, (_, i) => ({ yaw: 0, pitch: -30, fire: i === 0 }));
    const states: RouteState[] = [];
    let s = req.start;
    for (const c of controls) states.push((s = stepState(s, c, false).next));
    return { controls, states, edges: [{ name: 'rocket', at: 0, ticks: n }], ticks: n, rockets: 1, cost: n, clearance: 0.4, complete: true, reached: 1, robust: true, nodes: 1, expanded: 1, ms: 0, budget: 'none' };
  };

  it('replayBurns: the k-th rocket burns the ticks given, the rest the nominal', () => {
    const controls: RouteControl[] = Array.from({ length: 30 }, (_, i) => ({ yaw: 0, pitch: -30, fire: i === 0 }));
    const nominal = replayBurns(start, controls, goals, [], false);
    const short = replayBurns(start, controls, goals, [9], false);
    const long = replayBurns(start, controls, goals, [21], false);
    expect(short[29]!.pos.z).toBeLessThan(nominal[29]!.pos.z);
    expect(long[29]!.pos.z).toBeGreaterThan(nominal[29]!.pos.z);
    expect(nominal[29]!.pos.z - short[29]!.pos.z).toBeGreaterThan(2);
    // the burns are counted in the controls' fire order
    const two: RouteControl[] = Array.from({ length: 50 }, (_, i) => ({ yaw: 0, pitch: -30, fire: i === 0 || i === 25 }));
    const a = replayBurns(start, two, goals, [BURN.nominal, 9], false);
    const b = replayBurns(start, two, goals, [9, BURN.nominal], false);
    expect(a[20]!.pos.z).toBeGreaterThan(b[20]!.pos.z);
  });

  it('a burn that ends early re-times the plan being flown (the rule on); without the rule the reference stays', () => {
    for (const retime of [true, false]) {
      // (the first plan is the one watched: a re-plan after the burn's end is another plan)
      let plan: RoutePlan | undefined;
      const planner = (req: RouteRequest): RoutePlan => {
        const p = planOf(40)(req);
        plan ??= p;
        return p;
      };
      const t = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planner, maxNodes: 1, maxMs: 1, rules: { ...CAVE_STYLE.rules, retime } });
      let body: RouteState = { ...start };
      let o = t.tick({ pos: body.pos, vel: body.vel, gliding: true, onGround: false, rockets: 4 }, 0);
      expect(o.control.fire).toBe(true);
      const before = plan!.states.map((s) => s.pos.z);
      // the body burns 9 ticks (the shortest), the plan assumed 15
      for (let k = 1; k <= 24; k++) {
        body = stepState(body, o.control, false, 9).next;
        o = t.tick({ pos: body.pos, vel: body.vel, gliding: true, onGround: false, rockets: 3 }, k);
      }
      const after = plan!.states.map((s) => s.pos.z);
      if (retime) {
        expect(t.stats.retimed).toBe(1);
        expect(after[30]!).toBeLessThan(before[30]! - 2);
        // the body is close to the re-timed reference
        expect(o.error).toBeLessThan(0.6);
      } else {
        expect(t.stats.retimed).toBeUndefined();
        expect(after).toEqual(before);
      }
    }
  });
});

describe('the style’s numbers (cave/style.ts, Track F6)', () => {
  it('pieces on, the field off, a wider landing zone, the extra margin only where the bore is high', () => {
    expect(CAVE_STYLE.pieces).toBe(3);
    expect(CAVE_STYLE.geodesic).toBe(false);
    expect(CAVE_STYLE.landReach).toBe(2);
    expect(CAVE_STYLE.rules.retime).toBe(true);
    expect(caveExecutorOptions(true)).toMatchObject({ landReach: 2 });
    expect(caveMargin({ margin: 0.3, height: 3 })).toBeCloseTo(0.3);
    expect(caveMargin({ margin: 0.3, height: 4 })).toBeCloseTo(0.3 + CAVE_STYLE.marginExtra);
    expect(caveMargin({ margin: 0.3 })).toBeCloseTo(0.3 + CAVE_STYLE.marginExtra);
    const s = caveStretchOptions({ margin: 0.3, height: 3 });
    expect(s.pieces).toBe(3);
    expect(s.geodesic).toBeUndefined();
    expect(s.margin).toBeCloseTo(0.3);
    const req = windowRequest({ goals: [viaGoal({ x: 0.5, y: F, z: 10.5 })] }, { x: 0.5, y: F, z: 0.5 }, 8, { ...s, maxMs: 1, maxNodes: 1 });
    expect(req.pieces).toBe(3);
    expect(req.riskCost).toBe(CAVE_STYLE.riskCost);
    expect(req.geodesic).toBeUndefined();
  });
});
