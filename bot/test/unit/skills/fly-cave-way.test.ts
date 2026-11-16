// Track F17 (docs/flight.md "Windows beside the walk (Track F17)", decisions/0091): the guard tests of the windows beside a
// walk along a handed way (skills/fly/cave/waywin.ts) and of the tracker's rule they fly with (route/tracker.ts
// TrackerRules.refClear): the window laid from the way, the head room cut, the proof's rule, the gate, the scout, the
// hostiles, the stretch options, and a reference inside a solid that is no reason to bail out.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { flatWorld, withBoxes } from '../../../src/skills/input/world.ts';
import { CAVE_STYLE } from '../../../src/skills/fly/cave/style.ts';
import { UNDER_FLY_MIN } from '../../../src/skills/fly/corridor/executor.ts';
import { boreMargin } from '../../../src/skills/fly/corridor/stretches.ts';
import {
  headRoom,
  nodeFeet,
  wayAlong,
  wayAt,
  wayGate,
  wayLandsUnpowered,
  wayMiddle,
  wayPointNodes,
  wayTurns,
  wayMobs,
  wayPrice,
  wayProven,
  WayScout,
  wayStretchOptions,
  wayWindow,
  wayWindsBack,
  wayWorthProving,
  WAY_BAILS_MAX,
  WAY_HEAD_MIN,
  WAY_LEAD_S,
  WAY_MOB_REACH,
  WAY_OVER_S,
  WAY_PROOFS_MAX,
  WAY_RETRY_BLOCKS,
  WAY_ROCKET_RESERVE,
  WAY_SAVE_MIN_S,
  WAY_SAVE_SHARE,
  WAY_TURN_MAX,
  type WayNode,
} from '../../../src/skills/fly/cave/waywin.ts';
import { gridOfCells } from '../../../src/skills/fly/route/grid.ts';
import { replay } from '../../../src/skills/fly/route/primitives.ts';
import { RouteTracker } from '../../../src/skills/fly/route/tracker.ts';
import { NO_BOOST, type RouteControl, type RouteGoal, type RoutePlan, type RouteRequest, type RouteState } from '../../../src/skills/fly/route/types.ts';
import type { LandMob } from '../../../src/skills/fly/landmobs.ts';
import { PATH_PACE } from '../../../src/skills/fly/landprice.ts';
import { corridorWorld, LOW } from './fly-corridor-world.ts';
import { hookWorld, LEG, LOW as HOOK_LOW, SEP } from './fly-cave-way-world.ts';

const w = corridorWorld({ x: 0, z: 0 });
const world = withBoxes(flatWorld(), w.fills.map((f) => ({ from: f.from, to: f.to, solid: f.block === 'stone' })));
const solid = (x: number, y: number, z: number): boolean => world.solidAt(x, y, z) === true;
/** The way through the corridor world as a walk has it: 3 in from the mouth along the bore, round the bend, through the low section into the chamber (4.6 ticks a node, a sprint). */
function corridorWay(): WayNode[] {
  const way: WayNode[] = [];
  const push = (x: number, z: number): void => {
    way.push({ x, y: w.start.y, z, feet: w.start.y, cost: way.length ? 4.6 : 0 });
  };
  for (let x = w.mouthX + 3; x <= w.bendX; x++) push(x, w.start.z);
  for (let z = w.start.z + 1; z <= w.goal.z; z++) push(w.bendX, z);
  return way;
}
const way = corridorWay();
const ticksAt = way.reduce<number[]>((a, n, i) => (a.push((a[i - 1] ?? 0) + (i ? n.cost : 0)), a), []);
const price = (i: number, j: number): number => (Math.abs(ticksAt[j]! - ticksAt[i]!) / 20) * 1.07;
const opts = { solid, floor: solid, loaded: () => true, price };

describe('the window from a way (cave/waywin.ts wayWindow, Track F17)', () => {
  it('lays the cave style\'s window along the way from a node in the bore: on the way, at least UNDER_FLY_MIN long, its margin the passage\'s', () => {
    const ww = wayWindow(way, 10, opts)!;
    expect(ww).toBeDefined();
    expect(ww.start).toBe(10);
    expect(ww.land).toBeGreaterThan(ww.start);
    expect(ww.win.blocks).toBeGreaterThanOrEqual(UNDER_FLY_MIN);
    expect(ww.win.blocks).toBeLessThanOrEqual(CAVE_STYLE.windowBlocks + 1);
    // the landing is a node of the way (within 2.5 of its cell)
    const l = nodeFeet(way[ww.land]!);
    expect(Math.hypot(l.x - (ww.win.end.x + 0.5), l.z - (ww.win.end.z + 0.5))).toBeLessThanOrEqual(2.5);
    // the bore is 3 high: its margin is a 3 x 3 bore's
    expect(ww.win.height).toBe(3);
    expect(ww.win.margin).toBe(boreMargin(3, 3));
    expect(ww.walkS).toBeCloseTo(price(ww.start, ww.land), 6);
  });

  it('never starts under a roof lower than WAY_HEAD_MIN, and a window ends before the low section', () => {
    const lowAt = way.findIndex((n) => headRoom(solid, { x: n.x, y: n.feet, z: n.z }) < WAY_HEAD_MIN);
    expect(lowAt).toBeGreaterThan(0);
    expect(headRoom(solid, { x: way[lowAt]!.x, y: way[lowAt]!.feet, z: way[lowAt]!.z })).toBe(2);
    // no window from a node of the low section
    for (let i = lowAt; i < lowAt + LOW - 1; i++) expect(wayWindow(way, i, opts)).toBeUndefined();
    // a window from before it lands before it
    for (const s of [lowAt - 40, lowAt - 30]) {
      const ww = wayWindow(way, s, opts);
      if (ww) expect(ww.land).toBeLessThan(lowAt);
    }
  });

  it('measures the passage across the way: a 3 x 3 bore is 3 wide, not the 5 along it', () => {
    const ww = wayWindow(way, 10, opts)!;
    expect(ww.win.width).toBe(3);
  });

  it('ends a window before its way winds back past its start a wall away (the hook cave: no goal across the wall)', () => {
    const h = hookWorld({ x: 0, z: 0 });
    const hw = withBoxes(flatWorld(), h.fills.map((f) => ({ from: f.from, to: f.to, solid: f.block === 'stone' })));
    const hs = (x: number, y: number, z: number): boolean => hw.solidAt(x, y, z) === true;
    const hway: WayNode[] = h.line.map((c, i) => ({ x: c.x, y: c.y, z: c.z, feet: c.y, cost: i ? 4.6 : 0 }));
    const ho = { solid: hs, floor: hs, loaded: () => true, price: (i: number, j: number) => Math.abs(j - i) * 0.25 };
    const bend = h.line.findIndex((c) => c.z > h.start.z); // the first node of the way across
    let laid = 0;
    for (let i = 0; i < bend - UNDER_FLY_MIN; i++) {
      const ww = wayWindow(hway, i, ho);
      if (!ww) continue;
      laid++;
      // the start and each goal in turn in clear line at the body's height: the first goal is never in the bore back
      const first = ww.win.goals[0]!;
      const fz = first.kind === 'waypoint' ? first.box.min.z : first.cell.z;
      expect(fz, `from node ${i}`).toBeLessThan(h.start.z + SEP - 1);
      expect(ww.land, `from node ${i}`).toBeGreaterThan(i);
    }
    expect(laid).toBeGreaterThan(10);
    // the cut itself: a way of via points that comes back nearer its start than its first via ends before it does
    const ids = [0, 10, 20, 30];
    const v: WayNode[] = [
      ...Array.from({ length: 11 }, (_, k) => ({ x: k * 2, y: 0, z: 0, feet: 0, cost: 1 })),
      ...Array.from({ length: 10 }, (_, k) => ({ x: 20, y: 0, z: 1 + k, feet: 0, cost: 1 })),
      ...Array.from({ length: 10 }, (_, k) => ({ x: 18 - k * 2, y: 0, z: 10, feet: 0, cost: 1 })),
    ];
    expect(wayWindsBack(v, [0, 10, 20, 25, 30])).toBe(20);
    expect(wayWindsBack(v, ids.slice(0, 3))).toBeUndefined();
  });

  it('takes off, aims and ends in the passage\'s middle by a way along a bore\'s side row (wayMiddle)', () => {
    const h = hookWorld({ x: 0, z: 0 });
    const hw = withBoxes(flatWorld(), h.fills.map((f) => ({ from: f.from, to: f.to, solid: f.block === 'stone' })));
    const hs = (x: number, y: number, z: number): boolean => hw.solidAt(x, y, z) === true;
    const iway: WayNode[] = h.inner.map((c, i) => ({ x: c.x, y: c.y, z: c.z, feet: c.y, cost: i ? 4.6 : 0 }));
    const ho = { solid: hs, floor: hs, loaded: () => true, price: (i: number, j: number) => Math.abs(j - i) * 0.25 };
    // a side-row cell of the 3 x 3 bore in: its middle is the next row across (the row the centre line walks); the
    // middle row itself and a cell of the 2-high passage (3 wide too: its middle the same row) stay where they are
    const s = iway[30]!;
    expect(s.z).toBe(h.start.z + 1);
    expect(wayMiddle(hs, { x: s.x, y: s.feet, z: s.z }, hs)).toEqual({ x: s.x, y: s.feet, z: h.start.z });
    expect(wayMiddle(hs, { x: s.x, y: s.feet, z: h.start.z }, hs)).toEqual({ x: s.x, y: s.feet, z: h.start.z });
    // a cell 1 wide stays (no neighbour is floor with head room)
    const narrow = (x: number, y: number, z: number): boolean => !(z === 0 && y >= 0 && y <= 3 && x >= -10 && x <= 10) && y <= 3;
    expect(wayMiddle(narrow, { x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    // the window from that node takes off from the middle row, its via boxes and its end centred on it too
    const ww = wayWindow(iway, 30, ho)!;
    expect(ww).toBeDefined();
    expect(ww.from).toEqual({ x: s.x + 0.5, y: s.feet, z: h.start.z + 0.5 });
    // (the via and step boxes in the straight of the bore in, short of its far corner, are centred on its middle row)
    const farEnd = h.mouthX - HOOK_LOW - LEG + 1;
    let boxes = 0;
    for (const g of ww.win.goals) {
      if (g.kind !== 'waypoint' || g.box.max.z - g.box.min.z !== 3 || g.box.min.x <= farEnd + 3 || g.box.max.z > h.start.z + 3) continue;
      boxes++;
      expect(g.box.min.z).toBe(h.start.z - 1);
    }
    expect(boxes).toBeGreaterThan(0);
    const end = ww.win.end;
    if (end.x > farEnd + 3 && end.z <= h.start.z + 1) expect(end.z).toBe(h.start.z);
    expect(ww.win.width).toBe(3);
  });

  it('lands before a bend: a way that turns more than WAY_TURN_MAX off its first heading ends at the bend (wayTurns)', () => {
    // a way 20 east, then 10 north: the cut is the corner's node; 45 degrees off is no cut
    const v: WayNode[] = [
      ...Array.from({ length: 21 }, (_, k) => ({ x: k, y: 0, z: 0, feet: 0, cost: 1 })),
      ...Array.from({ length: 10 }, (_, k) => ({ x: 20, y: 0, z: 1 + k, feet: 0, cost: 1 })),
    ];
    expect(wayTurns(v, [0, 10, 20, 30])).toBe(20);
    expect(wayTurns(v, [0, 10, 20])).toBeUndefined();
    const d: WayNode[] = Array.from({ length: 30 }, (_, k) => ({ x: k, y: 0, z: k < 15 ? 0 : k - 15, feet: 0, cost: 1 }));
    expect(wayTurns(d, [0, 14, 29])).toBeUndefined();
    expect(WAY_TURN_MAX).toBeLessThan(90);
    // the corridor world: no window from the bore 10 or more before its bend goes round it (it may land a few blocks up
    // the side passage: its last leg a diagonal across the bend's corner); from nearer, the first leg is that diagonal
    // and the rest within WAY_TURN_MAX of it (the takeoff faces the side passage)
    const turned = way.findIndex((n) => n.z !== w.start.z);
    let laid = 0;
    for (let i = 0; i < way.length; i++) {
      const ww = wayWindow(way, i, opts);
      if (!ww) continue;
      laid++;
      expect(wayTurns(way, wayPointNodes(way, i, ww.land, solid)), `from node ${i}`).toBeUndefined();
      if (i < turned - 10) expect(ww.win.end.z, `from node ${i}`).toBeLessThanOrEqual(w.start.z + 4);
    }
    expect(laid).toBeGreaterThan(10);
  });

  it('finds the node of the way the body stands on, from a start, within its reach', () => {
    const p = nodeFeet(way[20]!);
    expect(wayAt(way, { ...p, x: p.x + 0.4 })).toBe(20);
    expect(wayAt(way, p, 25)).toBeUndefined();
    expect(wayAt(way, { ...p, y: p.y + 5 })).toBeUndefined();
    const along = wayAlong(way);
    expect(along[0]).toBe(0);
    expect(along[way.length - 1]!).toBeGreaterThan(150);
  });
});

describe('the rules of a window beside the walk (Track F17)', () => {
  const win = { margin: 0.3, goals: [{}, {}, {}] as RouteGoal[] };
  /** A plan's state with `wp` waypoints passed and a burn that may run `left` more ticks. */
  const st = (wp: number, left: number): RouteState => ({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 1.2 }, yaw: 0, boost: { min: 0, max: left, nom: left }, gliding: true, rockets: 3, wp });
  const plan = (o: Partial<RoutePlan>): Pick<RoutePlan, 'complete' | 'robust' | 'clearance' | 'reached' | 'states'> => ({ complete: true, robust: true, clearance: 0.32, reached: 3, states: [st(0, 15), st(1, 0), st(2, 0), st(3, 0)], ...o });

  it('flies only a proof that is complete, robust and keeps the window\'s margin all the way (not the corridor\'s 0.15)', () => {
    expect(wayProven(plan({}), win).ok).toBe(true);
    expect(wayProven(plan({ clearance: 0.3 }), win).ok).toBe(true);
    expect(wayProven(plan({ clearance: 0.28 }), win)).toEqual({ ok: false, why: "clearance 0.28, under the window's margin 0.30" });
    expect(CAVE_STYLE.proveClearMin).toBeLessThan(0.28);
    expect(wayProven(plan({ complete: false, reached: 1 }), win).why).toBe('partial, 1 of 3 goals');
    expect(wayProven(plan({ robust: false }), win).ok).toBe(false);
    // a narrow window's own margin is less: its proof needs only that, and never less than the corridor's floor
    expect(wayProven(plan({ clearance: 0.16 }), { ...win, margin: 0.12 }).ok).toBe(true);
    expect(wayProven(plan({ clearance: 0.13 }), { ...win, margin: 0.12 }).ok).toBe(false);
  });

  it('flies only a plan whose landing begins with every burn out (a bail-out there cannot stop a burning rocket)', () => {
    // the landing's stage begins at the first state past the last waypoint (wp 2 of 3 goals)
    expect(wayLandsUnpowered(plan({}), 3)).toBe(true);
    const burning = plan({ states: [st(0, 15), st(1, 6), st(2, 4), st(3, 0)] });
    expect(wayLandsUnpowered(burning, 3)).toBe(false);
    expect(wayProven(burning, win)).toEqual({ ok: false, why: 'clearance 0.32, but a rocket still burns where its landing begins' });
    // a burn that ends before the landing's stage is no matter
    expect(wayProven(plan({ states: [st(0, 15), st(1, 3), st(2, 0), st(3, 0)] }), win).ok).toBe(true);
    // a plan that never reaches the landing's stage is no landing
    expect(wayLandsUnpowered(plan({ states: [st(0, 0), st(1, 0)] }), 3)).toBe(false);
  });

  it('takes a window only when its flight and overhead save WAY_SAVE_MIN_S and WAY_SAVE_SHARE of the walk, with the rocket reserve left', () => {
    expect(WAY_OVER_S).toBeGreaterThanOrEqual(1.5);
    // a 14 s walk flown in 2.1 s: saves 9.9 s
    const g = wayGate({ walkS: 14, flyS: 2.1, rockets: 1, loose: 10 });
    expect(g.take).toBe(true);
    expect(g.saveS).toBeCloseTo(14 - 2.1 - WAY_OVER_S, 6);
    // the same with a proof of 1 s from where the body stopped: still
    expect(wayGate({ walkS: 14, flyS: 2.1, proofS: 1, rockets: 1, loose: 10 }).take).toBe(true);
    // a short stretch: saves 2.9 s, under WAY_SAVE_MIN_S
    expect(wayGate({ walkS: 6, flyS: 1.1, rockets: 1, loose: 10 }).take).toBe(false);
    // a long one that saves under its share of the walk
    const walkS = 40;
    const flyS = walkS - WAY_OVER_S - WAY_SAVE_SHARE * walkS + 0.5;
    expect(walkS - flyS - WAY_OVER_S).toBeGreaterThan(WAY_SAVE_MIN_S);
    expect(wayGate({ walkS, flyS, rockets: 1, loose: 10 }).take).toBe(false);
    // the reserve: 3 loose, a plan of 2 leaves 1
    const r = wayGate({ walkS: 14, flyS: 2.1, rockets: 2, loose: 2 + WAY_ROCKET_RESERVE - 1 });
    expect(r.take).toBe(false);
    expect(r.line).toMatch(/rockets at hand, the plan fires 2 and 2 stay: walked$/);
    // the landing's hostiles add to the cost
    expect(wayGate({ walkS: 14, flyS: 2.1, rockets: 1, loose: 10, overS: WAY_OVER_S + 6 }).take).toBe(false);
  });

  it('prices the walk as the landing search does: the probe\'s ticks at PATH_PACE, a deep drop\'s extra not counted', () => {
    const n = (z: number, feet: number, cost: number, move = 'walk') => ({ x: 0, y: feet, z, feet, cost, move });
    const flat = [n(0, 0, 0), n(1, 0, 4.6), n(2, 0, 4.6)];
    expect(wayPrice(flat, 30)(0, 2)).toBeCloseTo((9.2 / 20) * PATH_PACE, 9);
    expect(wayPrice(flat, 30)(2, 0)).toBeCloseTo((9.2 / 20) * PATH_PACE, 9);
    // a drop of 3 (deeper than a jump climbs back) costs the planner its 30 ticks of preference: no time
    const drop = [n(0, 3, 0), n(1, 0, 30 + 8, 'drop'), n(2, 0, 4.6)];
    expect(wayPrice(drop, 30)(0, 2)).toBeCloseTo((12.6 / 20) * PATH_PACE, 9);
  });

  it('is not proven at all where even the fastest flight could not pay', () => {
    expect(wayWorthProving(4, 20)).toBe(false);
    expect(wayWorthProving(20, 60)).toBe(true);
  });

  it('keeps away from hostiles: none within WAY_MOB_REACH of the body; with the landing\'s look a creeper by the landing refuses it and other hostiles cost seconds', () => {
    const body = { x: 0.5, y: -60, z: 0.5 };
    const land = { x: 40, z: 0, feet: -60 };
    const mob = (kind: LandMob['kind'], x: number, z: number, type = kind === 'creeper' ? 'creeper' : 'zombie'): LandMob => ({ id: 1n, type, kind, x, y: -60, z, lit: false, hunting: false });
    expect(wayMobs(body, land, [], true)).toEqual({ priceS: 0 });
    expect(wayMobs(body, land, [mob('melee', 0.5 + WAY_MOB_REACH - 1, 0.5)], false).refuse).toBe('a zombie 7.0 blocks away');
    expect(wayMobs(body, land, [mob('melee', 0.5 + WAY_MOB_REACH + 2, 0.5)], false)).toEqual({ priceS: 0 });
    expect(wayMobs(body, land, [mob('creeper', 45.5, 0.5)], true).refuse).toMatch(/^the landing: a creeper 5 off$/);
    expect(wayMobs(body, land, [mob('creeper', 45.5, 0.5)], false)).toEqual({ priceS: 0 });
    const z = wayMobs(body, land, [mob('melee', 41.5, 0.5)], true);
    expect(z.refuse).toBeUndefined();
    expect(z.priceS).toBeGreaterThan(0);
  });

  it('flies with the cave style\'s rules and a reference inside a solid taken for none (refClear), on the burn of the rockets at hand', () => {
    const so = wayStretchOptions({ margin: 0.3, height: 3 }, { min: 19, max: 31, nominal: 25 });
    expect(so.rules?.refClear).toBe(true);
    for (const k of Object.keys(CAVE_STYLE.rules) as (keyof typeof CAVE_STYLE.rules)[]) expect(so.rules?.[k]).toEqual(CAVE_STYLE.rules[k]);
    expect(so.kit).toEqual({ min: 19, max: 31, nominal: 25 });
    expect(wayStretchOptions({ margin: 0.3 }).kit).toBeUndefined();
    // (the cave style itself is as it was: the corridor's `!fly` windows do not take it)
    expect(CAVE_STYLE.rules.refClear).toBeUndefined();
  });
});

describe('the setting (Track F17)', () => {
  it('ships off, and with it off the walk after a landing is what it was (the handed way to the navigator, no scout)', () => {
    expect(SETTING_DEFS.flyCaveWindows.default).toBe(false);
    const src = readFileSync(fileURLToPath(new URL('../../../src/chat/commands-fly.ts', import.meta.url)), 'utf8');
    // the one place the scout is entered: the walk handed a way, the setting on
    expect(src).toContain('if (way && wayWindowsOn()) return wayWalk(goal, opts, label, way);');
    expect(src.split('wayWalk(').length - 1).toBe(1);
    expect(src).toMatch(/const wayWindowsOn = \(\): boolean => caveOn\(\) && d\.settings\.get\('flyCaveWindows'\) === true && routeOn\(\);/);
  });
});

describe('the scout beside the walk (cave/waywin.ts WayScout, Track F17)', () => {
  it('proves the first node WAY_LEAD_S ahead of the body, a start again only WAY_RETRY_BLOCKS on, and stops after WAY_BAILS_MAX bail-outs', () => {
    const s = new WayScout(way, opts);
    const a = s.next(0)!;
    expect(a).toBeDefined();
    expect(price(0, a.start)).toBeGreaterThanOrEqual(WAY_LEAD_S);
    expect(price(0, a.start - 1)).toBeLessThan(WAY_LEAD_S);
    const b = s.next(1)!;
    expect(s.along[b.start]! - s.along[a.start]!).toBeGreaterThanOrEqual(WAY_RETRY_BLOCKS);
    for (let k = 0; k < WAY_BAILS_MAX; k++) s.bailed();
    expect(s.next(b.start)).toBeUndefined();
  });

  it('spends at most WAY_PROOFS_MAX proofs a walk, and none where the rest of the way could not pay', () => {
    const s = new WayScout(way, opts);
    let n = 0;
    for (let at = 0; at < way.length && n < 100; at++) if (s.next(at)) n++;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(WAY_PROOFS_MAX);
    // a way of 30 nodes: under 7 s of walk, nothing to prove
    expect(new WayScout(way.slice(0, 30), opts).next(0)).toBeUndefined();
  });
});

describe('a reference inside a solid is no reason to bail out (route/tracker.ts rules.refClear, Track F17)', () => {
  // the plan's controls fly a level glide (the body flies them); its reference lies SUNK lower all the way (a reference
  // re-timed to another burn, into a bore's floor), inside a floor that follows the glide's sink SUNK under the body (the
  // body keeps 0.4 or more over it)
  const SUNK = 1.4;
  const start: RouteState = { pos: { x: 0.5, y: 5.5, z: 0.5 }, vel: { x: 0, y: 0, z: 1.2 }, yaw: 0, boost: { ...NO_BOOST }, gliding: true, rockets: 0, wp: 0 };
  const controls: RouteControl[] = Array.from({ length: 60 }, () => ({ yaw: 0, pitch: 0, fire: false }));
  const goals: RouteGoal[] = [{ kind: 'waypoint', box: { min: { x: -5, y: -10, z: 390 }, max: { x: 5, y: 10, z: 392 } } }];
  const body = replay(start, controls, goals, false);
  const yAt = (z: number): number => (body.find((s) => s.pos.z >= z) ?? body[body.length - 1]!).pos.y;
  const grid = gridOfCells((x, y, z) => z >= 2 && z < 200 && Math.abs(x) < 6 && y <= Math.floor(yAt(z) - SUNK) && y >= -20);
  const sunk = (req: RouteRequest): RoutePlan => {
    const states = replay(req.start, controls, goals, false).map((s) => ({ ...s, pos: { ...s.pos, y: s.pos.y - SUNK } }));
    return { controls, states, edges: [{ name: 'glide', at: 0, ticks: 60 }], ticks: 60, rockets: 0, cost: 60, clearance: 0.5, complete: true, reached: 1, robust: true, nodes: 1, expanded: 1, ms: 0, budget: 'none' };
  };

  // (the rule alone: the reference matched by time, no blocked-plan bail-out, an error of 1.3 off; the tube's forecast
  // bail-out is not this rule's)
  const isolated = { ...CAVE_STYLE.rules, tube: false, completeOnly: false, blockedBail: false, bailError: 1.3 };
  const fly = (rules: typeof isolated & { refClear?: boolean }): { bailedAt: number; notes: string[] } => {
    const notes: string[] = [];
    // (the first plan at once; the re-plans never come back, as from a worker slower than the 24 ticks looked at)
    let asked = 0;
    const t = new RouteTracker({ grid, margin: 0.3, goals, plan: (req) => (asked++ === 0 ? sunk(req) : new Promise<RoutePlan>(() => undefined)), maxNodes: 1, maxMs: 1, rules, note: (m) => notes.push(m) });
    let bailedAt = -1;
    for (let k = 0; k < 24; k++) {
      const s = body[Math.min(k, body.length - 1)]!;
      const o = t.tick({ pos: { ...s.pos }, vel: s.vel, gliding: true, onGround: false, rockets: 0 }, k);
      if (o.status === 'bailing' && bailedAt < 0) bailedAt = k;
    }
    return { bailedAt, notes };
  };

  it('off: the body 1.4 off a reference in the floor bails out "off the plan"; on: it flies on', () => {
    const off = fly({ ...isolated, refClear: false });
    expect(off.bailedAt).toBeGreaterThanOrEqual(1);
    expect(off.notes.some((n) => n.includes('blocks off the plan: bailing out'))).toBe(true);
    const on = fly({ ...isolated, refClear: true });
    expect(on.bailedAt, on.notes.join(' | ')).toBe(-1);
  });

  it('a body off a reference in clear air still bails out with the rule on (the reference 1.4 lower, the floor gone)', () => {
    const notes: string[] = [];
    let asked = 0;
    const t = new RouteTracker({ grid: gridOfCells(() => false), margin: 0.3, goals, plan: (req) => (asked++ === 0 ? sunk(req) : new Promise<RoutePlan>(() => undefined)), maxNodes: 1, maxMs: 1, rules: { ...isolated, refClear: true }, note: (m) => notes.push(m) });
    let bailed = false;
    for (let k = 0; k < 24 && !bailed; k++) {
      const s = body[k]!;
      bailed = t.tick({ pos: { ...s.pos }, vel: s.vel, gliding: true, onGround: false, rockets: 0 }, k).status === 'bailing';
    }
    expect(bailed).toBe(true);
    expect(notes.some((n) => n.includes('blocks off the plan: bailing out'))).toBe(true);
  });
});
