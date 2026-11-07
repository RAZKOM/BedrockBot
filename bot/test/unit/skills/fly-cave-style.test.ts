// Track F5b (docs/flight.md "Cave flight (Track F5b)", decisions/0069): the cave style's guard tests. The worm-cave
// generator, the via anchors of a window, the tracker's cave rules (the commit horizon, the speed cap, the
// bail-out, the stop on short partial plans), the waypoint route as a corridor, the shortcut proof, the setting,
// and one window of a generated cave flown offline on the style.
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { flatWorld, withBoxes } from '../../../src/skills/input/world.ts';
import { CAVE_STYLE, caveExecutorOptions, caveStretchOptions } from '../../../src/skills/fly/cave/style.ts';
import { flyWindow, styleOf } from '../../../src/skills/fly/cave/bench.ts';
import { orderedRoute, shortcutRoute, WaypointProvider, type RoutePoint } from '../../../src/skills/fly/cave/route.ts';
import { proveShortcut } from '../../../src/skills/fly/cave/proof.ts';
import { CorridorExecutor, UNDER_FLY, type CorridorPorts, type WindowProof } from '../../../src/skills/fly/corridor/executor.ts';
import { firstAhead, nextWindow, standableNear, viaGoal, type Stretch, type Window } from '../../../src/skills/fly/corridor/stretches.ts';
import { corridorWorld } from './fly-corridor-world.ts';
import { FlightCost, wideFace } from '../../../src/skills/fly/corridor/cost.ts';
import { portalOf, volumeOf } from '../../../src/skills/fly/corridor/coarse-port.ts';
import { caveSet, wormCave } from '../../../src/skills/fly/route/caves.ts';
import { standardCourses } from '../../../src/skills/fly/route/courses.ts';
import { gridOf, gridOfCells } from '../../../src/skills/fly/route/grid.ts';
import { stepState } from '../../../src/skills/fly/route/primitives.ts';
import { RouteTracker, SHORT_PARTIALS, type Planner } from '../../../src/skills/fly/route/tracker.ts';
import { NO_BOOST, type RouteGoal, type RoutePlan, type RouteRequest, type RouteState } from '../../../src/skills/fly/route/types.ts';
import type { Vec3 } from '../../../src/world/types.ts';

const F = -60;

describe('the worm-cave generator (route/caves.ts)', () => {
  it('is deterministic, carves a connected worm with standable waypoints inside its rock, the mouth open to the outside', () => {
    const a = wormCave({ seed: 7, length: 120 });
    const b = wormCave({ seed: 7, length: 120 });
    expect(a.cells.size).toBe(b.cells.size);
    expect(a.centre.length).toBe(120);
    expect(a.waypoints.length).toBeGreaterThanOrEqual(4);
    for (const w of a.waypoints) {
      expect(a.world.solidAt(w.x, w.y - 1, w.z), `floor under ${w.x} ${w.y} ${w.z}`).toBe(true);
      expect(a.world.solidAt(w.x, w.y, w.z)).toBe(false);
      expect(a.world.solidAt(w.x, w.y + 1, w.z)).toBe(false);
    }
    expect(a.start).toEqual(a.waypoints[0]);
    expect(a.goal).toEqual(a.waypoints[a.waypoints.length - 1]);
    // the rock round the cave is solid, the ground under it the flat world's
    const { min, max } = a.bounds;
    expect(a.world.solidAt(max.x, max.y, max.z)).toBe(true);
    expect(a.world.solidAt(min.x, F - 1, min.z)).toBe(true);
    expect(a.world.solidAt(min.x - 3, F, min.z)).toBe(false);
    // the coarse layer's view agrees with the body's world on a sample of cells
    let n = 0;
    for (let y = min.y; y <= max.y; y += 4) for (let z = min.z; z <= max.z; z += 5) for (let x = min.x; x <= max.x; x += 5) {
      const info = a.terrain.blockAt(x, y, z);
      expect(info, `${x} ${y} ${z}`).toBeDefined();
      expect(info!.name === 'stone', `${x} ${y} ${z}`).toBe(a.world.solidAt(x, y, z));
      n++;
    }
    expect(n).toBeGreaterThan(50);
    expect(a.narrowest.height).toBeGreaterThanOrEqual(2);
  });

  it('the GENERALISATION set: twelve caves of three widths, drops, pillars and water, every seed fixed', () => {
    const set = caveSet();
    expect(set.length).toBe(12);
    expect(new Set(set.map((c) => c.name)).size).toBe(12);
    expect(set.filter((c) => c.kind.includes('pillars')).length).toBeGreaterThanOrEqual(4);
    expect(set.filter((c) => c.water.size > 0).length).toBeGreaterThanOrEqual(1);
    expect(set.filter((c) => c.kind.includes('2 drops')).length).toBe(4);
    for (const c of set) expect(c.centre.length).toBeGreaterThanOrEqual(140);
    // water is no solid for the body and a liquid for the glide
    const wet = set.find((c) => c.water.size > 0)!;
    const k = [...wet.water][0]!;
    const z = (k % 0x10000) - 32768;
    const y = (Math.floor(k / 0x10000) % 0x400) - 512;
    const x = Math.floor(k / 0x4000000) - 32768;
    expect(wet.world.solidAt(x, y, z)).toBe(false);
    expect(wet.world.liquidAt!(x, y, z)).toEqual({ liquid: 'water', height: 8 / 9 });
    expect(wet.terrain.blockAt(x, y, z)!.name).toBe('water');
  });
});

describe('via anchors: a stretch of waypoints with no portals (stretches.ts nextWindow, Track F5b)', () => {
  // a 3 x 3 bore along +z from z 0 to 80 (the hull in stone), feet F
  const bore = withBoxes(flatWorld(), [
    { from: { x: -3, y: F, z: -2 }, to: { x: 3, y: F + 4, z: 82 }, solid: true },
    { from: { x: -1, y: F, z: 0 }, to: { x: 1, y: F + 2, z: 80 }, solid: false },
  ]);
  const solid = (x: number, y: number, z: number) => bore.solidAt(x, y, z) === true;
  const pts: Vec3[] = [{ x: 0.5, y: F, z: 2.5 }, { x: 0.5, y: F, z: 30.5 }, { x: 0.5, y: F, z: 55.5 }, { x: 0.5, y: F, z: 78.5 }];
  const stretch: Stretch = { space: 'under', points: pts, portals: [], end: pts[3]! };

  it('firstAhead: the nearest point counts as passed within 2 blocks or beyond it along the way', () => {
    expect(firstAhead(pts, { x: 0.5, y: F, z: 2.5 })).toBe(1);
    expect(firstAhead(pts, { x: 0.5, y: F, z: 20 })).toBe(1);
    expect(firstAhead(pts, { x: 0.5, y: F, z: 33 })).toBe(2);
    expect(firstAhead(pts, { x: 0.5, y: F, z: 27 })).toBe(1);
    expect(firstAhead(pts, { x: 0.5, y: F, z: 29 })).toBe(2); // within 2 blocks: as good as passed (the via box is 3 wide)
    expect(firstAhead(pts, { x: 0.5, y: F, z: 100 })).toBe(4);
    expect(firstAhead([], { x: 0, y: 0, z: 0 })).toBe(0);
  });

  it('lays the window through the via points in order and lands on the end cell', () => {
    const w = nextWindow(stretch, pts[0]!, { loaded: () => true, solid, endCell: { x: 0, y: F, z: 78 } })!;
    expect(w).toBeDefined();
    expect(w.cut).toBe(false);
    expect(w.end).toEqual({ x: 0, y: F, z: 78 });
    const boxes = w.goals.filter((g) => g.kind === 'waypoint').map((g) => (g.kind === 'waypoint' ? g.box : undefined)!);
    // the two inner via points are boxes (3 x 3, 3 high) in order, before the landing
    expect(boxes.some((b) => b.min.z <= 30 && b.max.z > 30)).toBe(true);
    expect(boxes.some((b) => b.min.z <= 55 && b.max.z > 55)).toBe(true);
    expect(w.goals.at(-1)!.kind).toBe('landing');
    expect(viaGoal({ x: 0.5, y: F, z: 30.5 })).toEqual({ kind: 'waypoint', box: { min: { x: -1, y: F, z: 29 }, max: { x: 2, y: F + 3, z: 32 } } });
  });

  it('cut by its length, the window lands on the standable cell at the last via point reached', () => {
    const w = nextWindow(stretch, pts[0]!, { loaded: () => true, solid, endCell: { x: 0, y: F, z: 78 }, maxBlocks: 40 })!;
    expect(w.cut).toBe(true);
    expect(w.end).toEqual({ x: 0, y: F, z: 30 });
    expect(standableNear(solid, { x: 0.5, y: F, z: 30.5 })).toEqual({ x: 0, y: F, z: 30 });
    expect(standableNear(solid, { x: 0.5, y: F + 2, z: 30.5 })).toEqual({ x: 0, y: F, z: 30 }); // a block up or down too
    expect(standableNear((_x, _y, _z) => true, { x: 0.5, y: F, z: 30.5 })).toBeUndefined();
    // from past the first via point the window starts at the second
    const w2 = nextWindow(stretch, { x: 0.5, y: F, z: 33 }, { loaded: () => true, solid, endCell: { x: 0, y: F, z: 78 } })!;
    expect(w2.goals.some((g) => g.kind === 'waypoint' && g.box.min.z <= 30 && g.box.max.z > 30)).toBe(false);
  });
});

describe('the tracker’s cave rules (route/tracker.ts TrackerRules)', () => {
  const open = gridOfCells(() => false);
  const goals: RouteGoal[] = [{ kind: 'waypoint', box: { min: { x: -5, y: -10, z: 90 }, max: { x: 5, y: 10, z: 92 } } }];
  const start: RouteState = { pos: { x: 0.5, y: 0, z: 0.5 }, vel: { x: 0, y: -0.05, z: 0.8 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 4, wp: 0 };
  const body = () => ({ pos: { ...start.pos }, vel: { ...start.vel }, gliding: true, onGround: false, rockets: 4 });
  /** A plan of `n` level ticks whose first control fires, complete or not. */
  const planOf = (n: number, complete: boolean) => (req: RouteRequest): RoutePlan => {
    const controls = Array.from({ length: n }, (_, i) => ({ yaw: 0, pitch: 0, fire: i === 0 }));
    const states: RouteState[] = [];
    let s = req.start;
    for (const c of controls) states.push((s = stepState(s, c, false).next));
    return { controls, states, edges: [{ name: 'rocket', at: 0, ticks: n }], ticks: n, rockets: 1, cost: n, clearance: 0.4, complete, reached: complete ? 1 : 0, robust: true, nodes: 1, expanded: 1, ms: 0, budget: 'none' };
  };

  it('refuseUncommitted (off in the style: measured harmful): no rocket on a partial plan shorter than the commit horizon', () => {
    const rules = { commitTicks: 12, refuseUncommitted: true };
    const short = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planOf(8, false), maxNodes: 1, maxMs: 1, rules });
    const o = short.tick(body(), 0);
    expect(o.status).toBe('tracking');
    expect(o.control.fire).toBe(false);
    expect(short.stats.uncommitted).toBe(1);
    expect(short.stats.fired).toBe(0);
    const long = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planOf(30, false), maxNodes: 1, maxMs: 1, rules });
    expect(long.tick(body(), 0).control.fire).toBe(true);
    const complete = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planOf(8, true), maxNodes: 1, maxMs: 1, rules });
    expect(complete.tick(body(), 0).control.fire).toBe(true);
    // the style's rules (no refusal) and no rules at all (the open-air drivers): the plan's rocket goes
    const styled = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planOf(8, false), maxNodes: 1, maxMs: 1, rules: CAVE_STYLE.rules });
    expect(styled.tick(body(), 0).control.fire).toBe(true);
    expect(CAVE_STYLE.rules.refuseUncommitted).toBeUndefined();
    expect(CAVE_STYLE.rules.fireSpeedMax).toBeUndefined();
    const plain = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planOf(8, false), maxNodes: 1, maxMs: 1 });
    expect(plain.tick(body(), 0).control.fire).toBe(true);
  });

  it('fireSpeedMax: no rocket on top of speed', () => {
    const fast = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planOf(30, true), maxNodes: 1, maxMs: 1, rules: { fireSpeedMax: 1.3 } });
    const b = body();
    b.vel = { x: 0, y: -0.05, z: 1.4 };
    const o = fast.tick(b, 0);
    expect(o.control.fire).toBe(false);
    expect(fast.stats.uncommitted).toBe(1);
    const slow = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planOf(30, true), maxNodes: 1, maxMs: 1, rules: { fireSpeedMax: 1.3 } });
    expect(slow.tick(body(), 0).control.fire).toBe(true);
  });

  it('bailAfter: a body gliding without a plan brakes, then sinks; a shadow tracker never bails; no more plans are asked for', () => {
    let asked = 0;
    const never: Planner = () => {
      asked++;
      return new Promise<RoutePlan>(() => {});
    };
    const t = new RouteTracker({ grid: open, margin: 0.3, goals, plan: never, maxNodes: 1, maxMs: 1, rules: { bailAfter: 6 } });
    let s = { ...start };
    let o = t.tick(body(), 0);
    for (let k = 1; k < 6; k++) {
      expect(o.status).toBe('planning');
      s = stepState(s, o.control, false).next;
      o = t.tick({ pos: s.pos, vel: s.vel, gliding: true, onGround: false, rockets: 4 }, k);
    }
    expect(o.status).toBe('bailing');
    expect(t.bailing).toBe(true);
    // the brake: the look 180 off the heading (the body flies +z), no rocket
    expect(Math.abs(((o.control.yaw % 360) + 360) % 360 - 180)).toBeLessThan(1e-6);
    expect(o.control.fire).toBe(false);
    const askedAtBail = asked;
    // the brake until slow, then the hover flip (the look alternating 180) at pitch 0
    let flips = 0;
    let last = o.control.yaw;
    for (let k = 6; k < 40; k++) {
      s = stepState(s, o.control, false).next;
      o = t.tick({ pos: s.pos, vel: s.vel, gliding: true, onGround: false, rockets: 4 }, k);
      expect(o.status).toBe('bailing');
      if (Math.abs(((o.control.yaw - last) % 360 + 540) % 360 - 180) < 1e-6) flips++;
      last = o.control.yaw;
    }
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeLessThan(0.3);
    expect(flips).toBeGreaterThan(10);
    expect(asked).toBe(askedAtBail);
    expect(t.stats.bailTicks).toBeGreaterThan(30);
    // a shadow tracker (the chain's next window) holds without ever bailing
    const shadow = new RouteTracker({ grid: open, margin: 0.3, goals, plan: never, maxNodes: 1, maxMs: 1, rules: { bailAfter: 6 } });
    for (let k = 0; k < 20; k++) expect(shadow.tick(body(), k, true).status).toBe('planning');
    expect(shadow.bailing).toBe(false);
    // without the rule the hold goes on
    const plain = new RouteTracker({ grid: open, margin: 0.3, goals, plan: never, maxNodes: 1, maxMs: 1 });
    for (let k = 0; k < 20; k++) expect(plain.tick(body(), k).status).toBe('planning');
  });

  it('partialStop: short partial plans in a row bail the body out; long or complete ones fly on', () => {
    const rules = { commitTicks: 12, partialStop: true };
    const short = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planOf(6, false), maxNodes: 1, maxMs: 1, rules });
    let s = { ...start };
    let o = short.tick(body(), 0);
    expect(o.status).toBe('tracking');
    let bailedAt = -1;
    for (let k = 1; k < 40 && bailedAt < 0; k++) {
      s = stepState(s, o.control, false).next;
      o = short.tick({ pos: s.pos, vel: s.vel, gliding: true, onGround: false, rockets: 4 }, k);
      if (o.status === 'bailing') bailedAt = k;
    }
    expect(bailedAt).toBeGreaterThan(0);
    expect(short.stats.plans).toBe(SHORT_PARTIALS);
    const long = new RouteTracker({ grid: open, margin: 0.3, goals, plan: planOf(30, false), maxNodes: 1, maxMs: 1, rules });
    s = { ...start };
    o = long.tick(body(), 0);
    for (let k = 1; k < 60; k++) {
      s = stepState(s, o.control, false).next;
      o = long.tick({ pos: s.pos, vel: s.vel, gliding: true, onGround: false, rockets: 4 }, k);
      expect(o.status).not.toBe('bailing');
    }
    // the partial plan was asked again before it ran out (the commit horizon), not only at its end
    expect(long.stats.replans).toBeGreaterThan(0);
  });

  it('the style’s options: the windows, the trackers and the setting (off by default)', () => {
    expect(SETTING_DEFS.flyCave.default).toBe('off');
    expect(UNDER_FLY).toBe(false);
    expect(caveExecutorOptions(false)).toEqual({ underFly: false });
    expect(caveExecutorOptions(true)).toMatchObject({ underFly: true, windowBlocks: CAVE_STYLE.windowBlocks, tailMin: CAVE_STYLE.tailMin });
    const s = caveStretchOptions({ margin: 0.3 });
    expect(s.margin).toBeCloseTo(0.3 + CAVE_STYLE.marginExtra);
    expect(s.window).toBe(CAVE_STYLE.chainWindow);
    expect(s.rules).toBe(CAVE_STYLE.rules);
    expect(styleOf({ variant: { chainWindow: 5, rules: { partialStop: false } } })).toMatchObject({ chainWindow: 5, riskCost: CAVE_STYLE.riskCost, rules: { ...CAVE_STYLE.rules, partialStop: false } });
  });
});

describe('a waypoint route as a corridor (cave/route.ts)', () => {
  const pts: RoutePoint[] = [
    { name: 'c_start', cell: { x: 0, y: F, z: 0 } },
    { name: 'c_1', cell: { x: 0, y: F, z: 40 } },
    { name: 'c_2', cell: { x: 0, y: F - 10, z: 80 } },
    { name: 'c_end', cell: { x: 0, y: F - 10, z: 120 } },
  ];
  const covered = (c: Vec3) => c.z >= 40;

  it('orders a numbered route and the shortcut from the nearest numbered point', () => {
    const named = [...pts, { name: 'c_shortcut', cell: { x: 20, y: F - 5, z: 45 } }, { name: 'other', cell: { x: 9, y: 9, z: 9 } }];
    expect(orderedRoute('c', named)!.map((p) => p.name)).toEqual(['c_start', 'c_1', 'c_2', 'c_end']);
    expect(orderedRoute('c', named.filter((p) => p.name !== 'c_1'))!.map((p) => p.name)).toEqual(['c_start', 'c_end']);
    expect(orderedRoute('x', named)).toBeUndefined();
    const s = shortcutRoute(pts, named[4]!);
    expect(s.branch.name).toBe('c_1');
    expect(s.points.map((p) => p.name)).toEqual(['c_start', 'c_1', 'c_shortcut', 'c_end']);
  });

  it('plans one fly leg through the points ahead with a portal where the cover changes; stuck, it walks the first segment', async () => {
    const p = new WaypointProvider(pts, { covered });
    const c = await p.plan({ start: { x: 0.5, y: F, z: 0.5 }, goal: { x: 0.5, y: F - 10, z: 120.5 }, modes: ['walk', 'fly'] });
    expect(c.status).toBe('found');
    expect(c.legs.map((l) => l.mode)).toEqual(['fly']);
    const leg = c.legs[0]!;
    expect(leg.waypoints.length).toBe(4);
    expect(leg.portals.length).toBe(1);
    expect(leg.portals[0]!.center).toEqual({ x: 0.5, y: F, z: 40.5 });
    expect(leg.portals[0]!.axis).toBe('z');
    expect(leg.portals[0]!.a).toBe('wp:sky');
    expect(leg.portals[0]!.b).toBe('wp:cave');
    expect(p.volumeAt({ x: 0, y: F + 1, z: 10 })!.kind).toBe('sky');
    expect(p.volumeAt({ x: 0, y: F + 1, z: 50 })!.kind).toBe('cave');
    // from past c_1 only the rest is planned; a second plan from the same spot walks the next segment
    const c2 = await p.plan({ start: { x: 0.5, y: F, z: 60 }, goal: { x: 0.5, y: F - 10, z: 120.5 }, modes: ['walk', 'fly'] });
    expect(c2.legs.map((l) => l.mode)).toEqual(['fly']);
    expect(c2.legs[0]!.waypoints.length).toBe(3);
    const c3 = await p.plan({ start: { x: 0.5, y: F, z: 61 }, goal: { x: 0.5, y: F - 10, z: 120.5 }, modes: ['walk', 'fly'] });
    expect(c3.legs.map((l) => l.mode)).toEqual(['walk', 'fly']);
    expect(c3.legs[0]!.to).toEqual({ x: 0.5, y: F - 10, z: 80.5 });
  });

  it('proves a shortcut through a straight 3 x 3 bore (flown over the burn range) and refuses one into a 2-high bore', { timeout: 180_000 }, async () => {
    const [straight] = standardCourses();
    const grid = gridOf(straight!.world);
    const s = straight!.start.pos;
    // the bore runs +z from the start: the stretch from standing 3 in to 34 in
    const a = { x: s.x, y: F + 1, z: s.z };
    const b = { x: s.x, y: F + 1, z: s.z + 31 };
    expect(grid.solid(Math.floor(a.x), F, Math.floor(a.z))).toBe(true);
    const yes = await proveShortcut(grid, [a, b], { maxMs: 1e9, maxNodes: 40_000 });
    console.log(yes.lines.join('\n'));
    expect(yes.proven, yes.reason ?? yes.lines.join('\n')).toBe(true);
    expect(yes.windows).toBeGreaterThanOrEqual(1);
    expect(yes.lines.length).toBe(yes.windows * 3);
    // a 2-high bore: no jump glides under its ceiling (F0), the flight never leaves the floor
    const low = standardCourses().find((c) => c.name === 'stair45-2high')!;
    const lg = gridOf(low.world);
    const p0 = low.start.pos;
    const no = await proveShortcut(lg, [{ x: p0.x, y: Math.floor(p0.y), z: p0.z }, { x: p0.x, y: Math.floor(p0.y), z: p0.z + 5 }], { maxMs: 1e9, maxNodes: 5_000, burns: [15] });
    expect(no.proven).toBe(false);
    expect(no.reason).toBeDefined();
  });
});

describe('the window proven before its takeoff (executor.ts `prove`, Track F5b)', () => {
  /** The executor over the corridor world with stub flights and a scripted proof. */
  function trip(proofs: (w: Window, n: number) => WindowProof) {
    const w = corridorWorld({ x: 1000, z: 2000 });
    const centre = (c: Vec3): Vec3 => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
    let pos = centre(w.start);
    const calls: { kind: string; cell: Vec3; goals?: number; blocks?: number; plan?: boolean }[] = [];
    let n = 0;
    const ports: CorridorPorts = {
      provider: w.stub(),
      position: () => ({ ...pos }),
      dim: () => 0,
      solid: (x, y, z) => w.solidAt(x, y, z),
      loaded: () => true,
      waitLoaded: () => Promise.resolve(true),
      flySky: (cell) => {
        calls.push({ kind: 'sky', cell });
        pos = centre(cell);
        return Promise.resolve({ ok: true, at: { ...pos } });
      },
      proveWindow: (win) => Promise.resolve(proofs(win, ++n)),
      flyUnder: (win, _l, plan) => {
        calls.push({ kind: 'under', cell: win.end, goals: win.goals.length, blocks: win.blocks, plan: plan !== undefined });
        pos = centre(win.end);
        return Promise.resolve({ ok: true, at: { ...pos } });
      },
      walk: (cell) => {
        calls.push({ kind: 'walk', cell });
        pos = centre(cell);
        return Promise.resolve({ ok: true, at: { ...pos } });
      },
      stopped: () => false,
    };
    return { w, calls, ex: new CorridorExecutor(ports, { underFly: true, prove: true }) };
  }
  const fake = (complete: boolean, reached: number): WindowProof => ({ complete, robust: true, reached, ms: 1, ...(complete ? { plan: { controls: [], states: [], edges: [], ticks: 0, rockets: 0, cost: 0, clearance: 1, complete: true, reached, robust: true, nodes: 1, expanded: 1, ms: 1, budget: 'none' } } : {}) });

  it('a complete proof flies the window with its plan; a partial one cuts the window back to the goals reached', async () => {
    const t = trip((w, n) => (n === 1 ? fake(false, 3) : fake(true, w.goals.length)));
    const r = await t.ex.run(t.w.goal, 'the chamber');
    expect(r.ok).toBe(true);
    const unders = t.calls.filter((c) => c.kind === 'under');
    expect(unders.length).toBeGreaterThanOrEqual(1);
    // the first window flown is the cut one: fewer goals than the full bore window of 8, with the proven plan
    expect(unders[0]!.goals).toBeLessThan(8);
    expect(unders[0]!.goals).toBeLessThanOrEqual(3);
    expect(unders[0]!.plan).toBe(true);
    expect(r.cuts).toBe(1);
    expect(r.proofs).toBeGreaterThanOrEqual(2);
    expect(r.unproven).toBe(0);
  });

  it('a proof that reaches nothing walks to the window’s first goal and tries again from there', async () => {
    const t = trip((w, n) => (n === 1 ? fake(false, 0) : fake(true, w.goals.length)));
    const r = await t.ex.run(t.w.goal, 'the chamber');
    expect(r.ok).toBe(true);
    const kinds = t.calls.map((c) => c.kind);
    expect(kinds.indexOf('walk')).toBeLessThan(kinds.indexOf('under'));
    expect(r.unproven).toBe(1);
    expect(r.windows).toBeGreaterThanOrEqual(1);
  });
});

describe('FlightCost in a real cave (corridor/cost.ts, Track F5b)', () => {
  it('a wide y face between two cave sections is a sloping bore, a narrow one a shaft; a nook of 1 does not price the volume Infinity', () => {
    const c = new FlightCost();
    const up = volumeOf('u', 'cave', { x: 0, y: 48, z: 0 }, { x: 15, y: 63, z: 15 }, { headroom: { min: 1, max: 5 }, minSpan: 4 });
    const down = volumeOf('d', 'cave', { x: 0, y: 32, z: 0 }, { x: 15, y: 47, z: 15 }, { headroom: { min: 1, max: 5 }, minSpan: 4 });
    const face = portalOf({ a: 'u', b: 'd', axis: 'y', center: { x: 8, y: 48, z: 8 }, height: 5, width: 4 });
    const shaft = portalOf({ a: 'u', b: 'd', axis: 'y', center: { x: 8, y: 48, z: 8 }, height: 2, width: 2 });
    expect(wideFace(face)).toBe(true);
    expect(wideFace(shaft)).toBe(false);
    const alongFace = c.edgeCost(face, up, down, 30);
    const downShaft = c.edgeCost(shaft, up, down, 30);
    expect(Number.isFinite(alongFace)).toBe(true);
    expect(Number.isFinite(downShaft)).toBe(true);
    expect(alongFace).toBeLessThan(downShaft);
    expect(alongFace).toBeLessThan(30 * 4);
  });
});

describe('one window of a generated cave flown offline on the style (cave/bench.ts flyWindow)', () => {
  it('ends on a floor or its landing with no fatal damage, the rules counted', { timeout: 120_000 }, async () => {
    const cave = caveSet()[8]!; // wide-109
    const solid = (x: number, y: number, z: number) => cave.world.solidAt(x, y, z) === true;
    const pts = cave.waypoints.slice(0, 4).map((c) => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 }));
    const stretch: Stretch = { space: 'under', points: pts, portals: [], end: pts[pts.length - 1]! };
    const win = nextWindow(stretch, pts[0]!, { loaded: () => true, solid, endCell: cave.waypoints[3]!, maxBlocks: CAVE_STYLE.windowBlocks, tailMin: CAVE_STYLE.tailMin })!;
    expect(win).toBeDefined();
    expect(win.goals.length).toBeGreaterThanOrEqual(2);
    const r = await flyWindow(cave.world, pts[0]!, win.goals, win.margin, { seed: 2, burn: 15, maxMs: 1e9, maxNodes: 20_000, latency: false });
    console.log(`cave window: ${r.end} ${r.reached}/${r.goals}, ${r.ticks} ticks, ${r.rockets} rockets, damage ${r.damage.toFixed(1)}, ${r.trackers} trackers, ${r.plans} plans (${r.partial} partial), refused ${r.refused}, uncommitted ${r.uncommitted}${r.bailed ? ', bailed' : ''}`);
    expect(['done', 'ground', 'water']).toContain(r.end);
    expect(r.damage).toBeLessThan(20);
    expect(r.maxHit).toBeLessThan(10);
  });
});
