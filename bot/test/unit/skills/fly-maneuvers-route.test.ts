// Track F1 -> Track F2 (docs/flight.md "Manoeuvres (flight v2, Track F1)": the planner's edges): the
// manoeuvre library as route-planner edges (maneuvers-route.ts). An edge is flown here the way Track F2's
// route/primitives.ts edgeOf flies one: applies, then control(s, now, i) / step / done(s, now, i) tick by
// tick on the glide formula, the boost on the nominal burn, a landing goal ending the edge on a soft
// contact inside its cell. The adapter must hand the planner the same flight as the library's own
// rollout (runManeuver), keep no memory from one edge to the next, refuse what the law cannot fly, and
// its settle edges, chained, must land on a 1 x 1 cell as F2's landing test asks (|vy|, h under 0.3).
import { describe, expect, it } from 'vitest';
import { GLIDE, glideVelocity } from '../../../src/skills/input/physics.ts';
import { brake180, glideTurn, runManeuver, zoomClimb, speedOf } from '../../../src/skills/fly/maneuvers.ts';
import { approachRoute, asRoute, maneuverStateOf, ROUTE_EDGE_MAX_TICKS, routeLibrary, settleRoute, type RouteLook, type RouteManeuver, type RouteStateView } from '../../../src/skills/fly/maneuvers-route.ts';

const Y = 100;
const at = (h: number, o: { vy?: number; y?: number; x?: number; z?: number; boost?: number; rockets?: number } = {}): RouteStateView => ({
  pos: { x: o.x ?? 0.5, y: o.y ?? Y, z: o.z ?? 0.5 },
  vel: { x: 0, y: o.vy ?? -0.1, z: h },
  yaw: 0,
  boost: { min: o.boost ?? 0, max: o.boost ?? 0, nom: o.boost ?? 0 },
  gliding: true,
  rockets: o.rockets ?? 8,
});

interface Landing { cell: { x: number; z: number }; top: number }

/** One edge as edgeOf flies it (no grid; a landing goal: the floor plane of its cell). */
function edge(m: RouteManeuver, s: RouteStateView, goal?: Landing): { out: RouteStateView; controls: RouteLook[]; rockets: number; landed: boolean; hitFloor: boolean } | undefined {
  if (!m.applies(s)) return undefined;
  const ticks = Math.min(ROUTE_EDGE_MAX_TICKS, Math.max(1, m.ticks(s)));
  let now: RouteStateView = { ...s, pos: { ...s.pos }, vel: { ...s.vel }, boost: { ...s.boost } };
  const controls: RouteLook[] = [];
  let rockets = 0;
  for (let i = 0; i < ticks; i++) {
    const c = m.control(s, now, i);
    const n: RouteStateView = { ...now, pos: { ...now.pos }, boost: { ...now.boost }, yaw: c.yaw };
    let fired = false;
    if (c.fire && now.rockets > 0 && now.boost.max === 0) {
      n.boost = { min: 12, max: 18, nom: GLIDE.boostTicks };
      n.rockets = now.rockets - 1;
      fired = true;
      rockets++;
    }
    n.vel = glideVelocity(now.vel, c.yaw, c.pitch, n.boost.nom > 0);
    n.pos = { x: now.pos.x + n.vel.x, y: now.pos.y + n.vel.y, z: now.pos.z + n.vel.z };
    n.boost = { min: Math.max(0, n.boost.min - 1), max: Math.max(0, n.boost.max - 1), nom: Math.max(0, n.boost.nom - 1) };
    controls.push({ ...c, fire: fired });
    if (goal && now.pos.y >= goal.top && n.pos.y < goal.top) {
      const f = (now.pos.y - goal.top) / (now.pos.y - n.pos.y);
      const x = now.pos.x + (n.pos.x - now.pos.x) * f;
      const z = now.pos.z + (n.pos.z - now.pos.z) * f;
      const soft = -n.vel.y <= 0.3 && speedOf(n.vel) <= 0.3;
      const inCell = Math.floor(x) === goal.cell.x && Math.floor(z) === goal.cell.z;
      return { out: { ...n, pos: { x, y: goal.top, z }, gliding: false }, controls, rockets, landed: soft && inCell, hitFloor: !(soft && inCell) };
    }
    now = n;
    if (m.done?.(s, now, i)) break;
  }
  return { out: now, controls, rockets, landed: false, hitFloor: false };
}

describe('fly: the manoeuvre library as route-planner edges (Track F1 -> F2)', () => {
  it('an edge flies the same ticks and end state as the library rollout (brake, glide turn, zoom), capped at 40 ticks', () => {
    for (const [m, p, s] of [
      [brake180, {}, at(1.48)],
      [brake180, { pitch: 0 }, at(1.05)],
      [glideTurn, { heading: -90, radius: 20 }, at(1.48)],
      [zoomClimb, { pitch: -45 }, at(1.0)],
    ] as const) {
      const e = edge(asRoute(m as never, p as never), s)!;
      const r = runManeuver(m as never, p as never, maneuverStateOf(s), { maxTicks: ROUTE_EDGE_MAX_TICKS });
      expect([m.name, e.controls.length]).toEqual([m.name, r.ticks]);
      expect(Math.hypot(e.out.pos.x - r.out.pos.x, e.out.pos.y - r.out.pos.y, e.out.pos.z - r.out.pos.z), m.name).toBeLessThan(1e-9);
    }
  });

  it('no memory leaks from one edge to the next: the same start twice gives the same controls (the zoom remembers it has risen)', () => {
    const z = asRoute(zoomClimb, { pitch: -30, ticks: ROUTE_EDGE_MAX_TICKS });
    const a = edge(z, at(1.2))!.controls;
    edge(z, at(0.9, { y: Y + 7 }));
    const b = edge(z, at(1.2))!.controls;
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(5);
  });

  it('applies: the brakes and settles refuse a burning rocket, the brake a slow body, the settle a body far off or under the top, the snap an empty hand, every edge a body not yet gliding', () => {
    const lib = routeLibrary([{ kind: 'landing', cell: { x: 0, z: 10 }, top: Y - 10 }]);
    const by = (n: string): RouteManeuver => lib.find((m) => m.name === n)!;
    expect(lib.map((m) => m.name)).toEqual(expect.arrayContaining(['settle', 'settle+20', 'brake180', 'brake180+0', 'hover', 'brake140L', 'brake160R', 'snap90L', 'snap45R', 'glideTurn90R', 'zoom-30']));
    expect(lib.every((m) => m.family === 'maneuver')).toBe(true);
    expect(by('brake180').applies(at(1.2))).toBe(true);
    expect(by('brake180').applies(at(1.2, { boost: 5 }))).toBe(false);
    expect(by('brake180').applies(at(0.3))).toBe(false);
    expect(by('settle').applies(at(1.0, { z: 2.5 }))).toBe(true);
    expect(by('settle').applies(at(1.0, { z: -20 }))).toBe(false);
    expect(by('settle').applies(at(0.1, { z: 10.5, y: Y - 11 }))).toBe(false);
    expect(by('settle').applies(at(1.0, { z: 2.5, boost: 3 }))).toBe(false);
    expect(by('snap90L').applies(at(1.4))).toBe(true);
    expect(by('snap90L').applies(at(1.4, { rockets: 0 }))).toBe(false);
    expect(by('hover').applies(at(0.1))).toBe(true);
    expect(by('hover').applies(at(1.0))).toBe(false);
    expect(lib.some((m) => m.applies({ ...at(1.2), glideIn: 3 }))).toBe(false);
    expect(routeLibrary([], { extras: false }).map((m) => m.name)).toEqual(['brake180', 'brake180+0', 'hover']);
  });

  it('the snap fires its rocket on the first tick and turns the velocity 90 degrees in a few ticks', () => {
    const snap = routeLibrary().find((m) => m.name === 'snap90R')!;
    const e = edge(snap, at(1.48))!;
    expect(e.rockets).toBe(1);
    expect(e.controls[0]!.fire).toBe(true);
    expect(e.controls.length).toBeLessThanOrEqual(6);
    expect(Math.abs(Math.abs((Math.atan2(-e.out.vel.x, e.out.vel.z) * 180) / Math.PI) - 90)).toBeLessThan(6);
  });

  it('the approach edges (brake.ts brakeApproach), then the settle, land from 24 out at 1.0 a tick: level 6 above the cell, and 3 over a rim 10 up (pitch -10 holds the height)', () => {
    for (const [above, pitchA] of [
      [6, 0],
      [13, -10],
    ] as const) {
      const goal = { cell: { x: 0, z: 24 }, top: Y - above };
      let s = at(1.0, { z: 0.5 });
      let ticks = 0;
      let landed = false;
      for (let k = 0; k < 8 && !landed; k++) {
        const e = edge(k === 0 ? approachRoute(goal, pitchA, 4) : settleRoute(goal, 0), s, goal);
        expect(e, `edge ${k}`).toBeDefined();
        expect(e!.hitFloor).toBe(false);
        // the approach holds the rim's height until it is over the cell
        if (k === 0) expect(e!.out.pos.y).toBeGreaterThan(goal.top + (above > 10 ? 11 : 0));
        ticks += e!.controls.length;
        landed = e!.landed;
        s = e!.out;
      }
      console.log(`approach${pitchA}/4 from ${above} above: landed ${landed} after ${ticks} ticks, ${Math.hypot(s.pos.x - 0.5, s.pos.z - 24.5).toFixed(3)} off, touchdown vy ${s.vel.y.toFixed(3)} h ${speedOf(s.vel).toFixed(3)}`);
      expect(landed).toBe(true);
      expect(Math.hypot(s.pos.x - 0.5, s.pos.z - 24.5)).toBeLessThan(0.1);
      expect(speedOf(s.vel)).toBeLessThan(0.05);
    }
  });

  for (const pitchE of [0, 20]) {
    it(`settle edges at pitch ${pitchE}, chained from the approach (1.05 a tick, 8 out, 6 above a 1 x 1 cell), land on the cell nearly still`, () => {
      const goal = { cell: { x: 0, z: 10 }, top: Y - 6 };
      const m = settleRoute(goal, pitchE);
      let s = at(1.05, { z: 2.5 });
      let edges = 0;
      let landed = false;
      let ticks = 0;
      while (edges < 10) {
        const e = edge(m, s, goal);
        expect(e, `edge ${edges} applies`).toBeDefined();
        edges++;
        ticks += e!.controls.length;
        expect(e!.hitFloor).toBe(false);
        s = e!.out;
        if (e!.landed) {
          landed = true;
          break;
        }
      }
      console.log(`settle +${pitchE}: landed ${landed} after ${edges} edges, ${ticks} ticks, ${Math.hypot(s.pos.x - 0.5, s.pos.z - 10.5).toFixed(3)} off, touchdown vy ${s.vel.y.toFixed(3)} h ${speedOf(s.vel).toFixed(3)}`);
      expect(landed).toBe(true);
      expect(Math.hypot(s.pos.x - 0.5, s.pos.z - 10.5)).toBeLessThan(0.15);
      expect(-s.vel.y).toBeLessThan(pitchE ? 0.25 : 0.17);
      expect(speedOf(s.vel)).toBeLessThan(0.1);
      expect(ticks).toBeLessThan(pitchE ? 80 : 100);
    });
  }
});
