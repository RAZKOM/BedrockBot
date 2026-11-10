// Track F9d (docs/flight.md "Drawn lines (Track F9d)", "The route landing that arrived too high"): the two faults of the
// e2e gate fly-route-land, offline. (a) A route landing 150 blocks out was handed to the route tracker 10 to 27 over its
// cell depending on how long the flight's first two rockets happened to burn: near such a landing a burn now tops out at
// the hand-over's line whatever its length, and the hand-over is flown to the band the planner lands from at once
// (ROUTE_HAND_BAND: the height over the cell and the speed together; round 2, after a hand-over on the height but too
// fast for it cost the room under a roof 8 rockets). (b) A 1 x 1 hole 2 deep, where a correction of the server during
// the brake's station keeping gave the body to the flare, which stood on the rim: a cell under a rim is the brake's alone.
import { describe, expect, it } from 'vitest';
import { capCoast, climbMomentum, FlightBrain, ROUTE_CAP_RANGE, ROUTE_HAND_BAND, ROUTE_HAND_UP } from '../../../src/skills/fly/brain.ts';
import { simulateFlight } from '../../../src/skills/fly/glide.ts';
import { findLanding, type LandingOptions } from '../../../src/skills/fly/landing.ts';
import { cruiseHeight, yawDir } from '../../../src/skills/fly/plan.ts';
import { gridOf } from '../../../src/skills/fly/route/grid.ts';
import { ROUTE_ENTRY_OUT, ROUTE_ENTRY_UP, ROUTE_HANDOVER } from '../../../src/skills/fly/route/landing.ts';
import { planRoute } from '../../../src/skills/fly/route/search.ts';
import { GLIDE, IDLE_COMMAND, initialBody, stepBody, type BlockBox } from '../../../src/skills/input/index.ts';
import { FEET, world } from './fly-worlds.ts';

const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 12, probes: 16, budgetMs: 60_000, exact: 1, style: 'auto' };
const T = 150;
/** The gate's stacked platforms: a 3 x 3 platform 20 up and another 2 of air over it. */
const stack: BlockBox[] = [
  { from: { x: -1, y: FEET + 20, z: T - 1 }, to: { x: 1, y: FEET + 20, z: T + 1 }, solid: true },
  { from: { x: -1, y: FEET + 23, z: T - 1 }, to: { x: 1, y: FEET + 23, z: T + 1 }, solid: true },
];
/** The gate's 1 x 1 hole 2 deep. */
const hole: BlockBox[] = [{ from: { x: -90, y: FEET - 2, z: T }, to: { x: -90, y: FEET - 1, z: T }, solid: false }];
/** The whole trips' cell under a roof 3 above at ground level, walls on three sides (fly-route-landing.test.ts), 300 blocks out. */
const FAR = 300;
const room: BlockBox[] = [
  { from: { x: -3, y: FEET + 3, z: FAR - 3 }, to: { x: 3, y: FEET + 3, z: FAR + 3 }, solid: true },
  { from: { x: -3, y: FEET, z: FAR - 3 }, to: { x: -3, y: FEET + 2, z: FAR + 3 }, solid: true },
  { from: { x: 3, y: FEET, z: FAR - 3 }, to: { x: 3, y: FEET + 2, z: FAR + 3 }, solid: true },
  { from: { x: -3, y: FEET, z: FAR + 3 }, to: { x: 3, y: FEET + 2, z: FAR + 3 }, solid: true },
];
/**
 * What the route tracker lands from without a rocket (measured: the tracker on the physics from each state to standing,
 * the stack's slot, the room and a pocket in a cliff face): ROUTE_HAND_BAND, and beside it half a block lower from 0.8
 * to 1.1 a tick and half a block higher at 0.9 and under (a slow body sinks more a block).
 */
const lands = (over: number, speed: number): boolean =>
  speed >= ROUTE_HAND_BAND.slow && speed <= ROUTE_HAND_BAND.fast && ((over >= ROUTE_HAND_BAND.low && over <= ROUTE_HAND_BAND.high) || (over >= ROUTE_HAND_BAND.low - 0.5 && over < ROUTE_HAND_BAND.low && speed >= 0.8 && speed <= 1.1) || (over > ROUTE_HAND_BAND.high && over <= ROUTE_HAND_BAND.high + 0.5 && speed <= 0.9));

describe('fly: a route landing near its cell is handed over at its line whatever the burns (Track F9d)', () => {
  it('the coast of a rising body on a level look is a third more than climbMomentum counts', () => {
    // measured on the glide formula at 1.0 to 1.6 a tick: 0.3 up a tick coasts 1.7 blocks, 0.6 coasts 6.2, 1.06 coasts 16.4
    expect(capCoast(0.3)).toBeGreaterThan(1.4);
    expect(capCoast(0.3)).toBeLessThan(2.0);
    expect(capCoast(0.6)).toBeGreaterThan(5.6);
    expect(capCoast(0.6)).toBeLessThan(6.8);
    expect(capCoast(1.06)).toBeGreaterThan(15);
    expect(capCoast(1.06)).toBeLessThan(18);
    expect(capCoast(0.6)).toBeGreaterThan(climbMomentum(0.6) * 1.25);
    expect(capCoast(-0.2)).toBe(0);
    expect(ROUTE_CAP_RANGE).toBe(ROUTE_HANDOVER + 160);
    // the height aimed at is the planner's own entry's, on the level glide's line back to the hand-over: inside the band
    expect(ROUTE_HAND_UP).toBeCloseTo(ROUTE_ENTRY_UP + (ROUTE_HANDOVER - ROUTE_ENTRY_OUT) * 0.15, 6);
    expect(ROUTE_HAND_UP).toBeGreaterThan(ROUTE_HAND_BAND.low + 1);
    expect(ROUTE_HAND_UP).toBeLessThan(ROUTE_HAND_BAND.high);
  });

  it('the band: from its corners and its middle, straight in a block inside the hand-over, the planner has a whole plan onto the stack’s slot and into the room (a node budget, no wall clock)', async () => {
    for (const c of [
      { name: 'stack', boxes: stack, goal: { x: 0, y: FEET + 21, z: T } },
      { name: 'room', boxes: room, goal: { x: 0, y: FEET, z: FAR } },
    ]) {
      const w = world(c.boxes);
      const grid = gridOf(w.solid);
      const obstacle = (x: number, y: number, z: number): boolean => w.solid.solidAt(x, y, z) === true;
      const plan = await findLanding(c.goal, c.name, { look: w.look, obstacle, probe: () => Promise.resolve({ status: 'found' as const, blocks: 3 }), route: { grid, rockets: 2 } }, { ...OPTS, from: { x: 0.5, z: 0.5 } });
      if (plan.kind !== 'goal') throw new Error(plan.line);
      const rt = plan.target.route;
      expect(rt, plan.line).toBeDefined();
      if (!rt) continue;
      const d = yawDir(rt.bearing);
      const v = yawDir(rt.yaw);
      const out = ROUTE_HANDOVER - 1;
      for (const [over, speed] of [[ROUTE_HAND_BAND.low, ROUTE_HAND_BAND.slow], [ROUTE_HAND_BAND.low, ROUTE_HAND_BAND.fast], [ROUTE_HAND_BAND.high, ROUTE_HAND_BAND.slow], [ROUTE_HAND_BAND.high, ROUTE_HAND_BAND.fast], [ROUTE_HAND_UP, 0.9]] as const) {
        const start = { pos: { x: rt.entry.x + d.x * (out - ROUTE_ENTRY_OUT), y: rt.entry.y - ROUTE_ENTRY_UP + over, z: rt.entry.z + d.z * (out - ROUTE_ENTRY_OUT) }, vel: { x: v.x * speed, y: -0.17, z: v.z * speed }, yaw: rt.yaw, boost: { min: 0, max: 0, nom: 0 }, gliding: true, rockets: 60, wp: 0 };
        const p = planRoute({ start, goals: rt.goals, margin: rt.margin, maxNodes: 40_000, maxMs: 1e9, weight: rt.weight, library: 'landing' }, grid);
        const say = `${c.name} from ${over} over at ${speed}: ${p.complete ? 'whole' : `partial (${p.why ?? '?'})`}, ${p.expanded} expanded, ${p.ticks} ticks, ${p.rockets} rockets`;
        expect(p.complete, say).toBe(true);
        expect(p.rockets, say).toBe(0);
        expect(p.expanded, say).toBeLessThan(2000); // (measured 2 to 567)
      }
    }
  }, 120_000);

  it('the stacked platforms 150 blocks out: at every mix of a short, a middling and a long first and second burn the hand-over is inside what the tracker lands from (the height over the cell and the speed together), no rocket burning', async () => {
    const w = world(stack);
    const grid = gridOf(w.solid);
    const obstacle = (x: number, y: number, z: number): boolean => w.solid.solidAt(x, y, z) === true;
    const start = { x: 0.5, y: FEET, z: 0.5 };
    const plan = await findLanding({ x: 0, y: FEET + 21, z: T }, 'stack', { look: w.look, obstacle, probe: () => Promise.resolve({ status: 'found' as const, blocks: 3 }), route: { grid, rockets: 2 } }, { ...OPTS, from: { x: start.x, z: start.z } });
    if (plan.kind !== 'goal') throw new Error(plan.line);
    expect(plan.target.route).toBeDefined();
    const cz = cruiseHeight(start, plan.target, w.skyTop, {});
    const seen: string[] = [];
    // (before this track: 9/21 23 over, 12/21 27, 13/13 20, 16/15 23, 14/9 16)
    for (const [first, rest] of [[9, 9], [9, 21], [12, 21], [13, 9], [13, 13], [14, 16], [16, 12], [16, 15], [15, 21], [18, 9], [21, 21]] as const) {
      const notes: string[] = [];
      const sim = await simulateFlight({ world: w.solid, groundAt: (x, z, fromY) => w.dryGround(x, z, fromY), skyTop: w.skyTop }, start, plan.target, { cruiseY: cz.y, seed: 5, note: (m) => notes.push(m), route: { grid, plan: (req) => planRoute(req, grid), maxMs: 50 } }, { rockets: 64, maxTicks: 400, burn: (rocket) => (rocket === 0 ? first : rest), endLag: 2, until: (b) => b.phase === 'route' });
      const said = notes.find((m) => m.startsWith('route landing: handing over'));
      expect(said, `${first}/${rest}: ${sim.phase} after ${sim.ticks} ticks`).toBeDefined();
      const over = Number(/, ([\d.]+) over the cell/.exec(said!)![1]);
      const speed = Number(/at ([\d.]+) a tick/.exec(said!)![1]);
      seen.push(`${first}/${rest}: ${over} over at ${speed}`);
      // (round 1: 7.8 to 11.4 over at 0.78 to 1.07, the high ones as fast as the low; now 7.8 to 10.1 at 0.71 to 1.05 over 845 flights)
      expect(lands(over, speed), `${first}/${rest}: ${said}`).toBe(true);
      expect(said, `${first}/${rest}`).not.toMatch(/a rocket burning/);
      expect(sim.hits).toBe(0);
    }
    console.log(`[fly-route-cap] hand-overs: ${seen.join('; ')}`);
  }, 120_000);

  it('the room under a roof 300 blocks out (the whole trip round 1 made worse: handed over 10.6 over at 1.03 a tick, 8 rockets and 277 ticks of partial plans): at a short, the nominal and a long burn the hand-over is in the band and the tracker lands it without a rocket (the planner on a node budget: the same flight every time)', async () => {
    const w = world(room);
    const grid = gridOf(w.solid);
    const obstacle = (x: number, y: number, z: number): boolean => w.solid.solidAt(x, y, z) === true;
    const start = { x: 0.5, y: FEET, z: 0.5 };
    const plan = await findLanding({ x: 0, y: FEET, z: FAR }, 'room', { look: w.look, obstacle, probe: () => Promise.resolve({ status: 'found' as const, blocks: 3 }), route: { grid, rockets: 2 } }, { ...OPTS, from: { x: start.x, z: start.z } });
    if (plan.kind !== 'goal') throw new Error(plan.line);
    expect(plan.target.route, plan.line).toBeDefined();
    const cz = cruiseHeight(start, plan.target, w.skyTop, {});
    const seen: string[] = [];
    for (const [first, rest] of [[15, 15], [9, 21], [12, 9], [18, 12], [21, 15]] as const) {
      const notes: string[] = [];
      const sim = await simulateFlight({ world: w.solid, groundAt: (x, z, fromY) => w.dryGround(x, z, fromY), skyTop: w.skyTop }, start, plan.target, { cruiseY: cz.y, seed: 5, note: (m) => notes.push(m), route: { grid, plan: (req) => planRoute({ ...req, maxMs: 1e9 }, grid), maxMs: 1e9 } }, { rockets: 64, maxTicks: 1500, burn: (rocket) => (rocket === 0 ? first : rest), endLag: 2 });
      const said = notes.find((m) => m.startsWith('route landing: handing over'));
      expect(said, `${first}/${rest}: ${sim.phase} after ${sim.ticks} ticks`).toBeDefined();
      const over = Number(/, ([\d.]+) over the cell/.exec(said!)![1]);
      const speed = Number(/at ([\d.]+) a tick/.exec(said!)![1]);
      const say = `${first}/${rest}: ${over} over at ${speed}, ${sim.ticks} ticks, ${sim.stats.rockets} rockets (${sim.stats.rocketsBy.land} landing), route ${sim.stats.routeTicks} ticks, ${sim.stats.routeReplans} re-plans`;
      seen.push(say);
      expect(over, say).toBeGreaterThanOrEqual(ROUTE_HAND_BAND.low);
      expect(over, say).toBeLessThanOrEqual(ROUTE_HAND_BAND.high);
      expect(speed, say).toBeGreaterThanOrEqual(ROUTE_HAND_BAND.slow);
      expect(speed, say).toBeLessThanOrEqual(ROUTE_HAND_BAND.fast);
      expect(sim.end?.ok, `${say}: ${sim.end && !sim.end.ok ? sim.end.reason : sim.phase}`).toBe(true);
      expect(sim.hits, say).toBe(0);
      expect(sim.stats.rocketsBy.land, say).toBe(0);
      expect(sim.stats.routeTicks, say).toBeLessThanOrEqual(100); // (the base's 71 at the nominal burn; round 1's 277)
      expect(sim.stats.routeReplans, say).toBeLessThanOrEqual(3); // (1: the tracker's corridor check leaves the landing cell's floor out)
    }
    console.log(`[fly-route-cap] the room 300 out: ${seen.join('; ')}`);
  }, 240_000);

  it('the tracker flies a landing plan to its touchdown: its corridor check sweeps in the search\u2019s own grid (the landing cell\u2019s floor is no obstacle near the cell), so the stack\u2019s slot is landed without a rocket at the burns whose hand-overs, inside the band, ended in rockets round the platform', async () => {
    // Before: every landing plan was "blocked" two ticks before its end by its own touchdown and searched again from the
    // middle of its last manoeuvre, five to eight times a landing; where one of those searches found nothing (the slot's
    // plans pass its lip with 0.13 to 0.17 of clearance) the tracker fired a rocket and flew round the platform: 9/20 was
    // handed over 9.2 over at 0.85 a tick and took 465 route ticks and 13 rockets, 13/11 14 hits, 13/13 16 rockets.
    const w = world(stack);
    const grid = gridOf(w.solid);
    const obstacle = (x: number, y: number, z: number): boolean => w.solid.solidAt(x, y, z) === true;
    const start = { x: 0.5, y: FEET, z: 0.5 };
    const plan = await findLanding({ x: 0, y: FEET + 21, z: T }, 'stack', { look: w.look, obstacle, probe: () => Promise.resolve({ status: 'found' as const, blocks: 3 }), route: { grid, rockets: 2 } }, { ...OPTS, from: { x: start.x, z: start.z } });
    if (plan.kind !== 'goal') throw new Error(plan.line);
    const cz = cruiseHeight(start, plan.target, w.skyTop, {});
    const seen: string[] = [];
    for (const [first, rest] of [[9, 20], [13, 11], [13, 13], [19, 19]] as const) {
      const notes: string[] = [];
      const sim = await simulateFlight({ world: w.solid, groundAt: (x, z, fromY) => w.dryGround(x, z, fromY), skyTop: w.skyTop }, start, plan.target, { cruiseY: cz.y, seed: 5, note: (m) => notes.push(m), route: { grid, plan: (req) => planRoute({ ...req, maxMs: 1e9 }, grid), maxMs: 1e9 } }, { rockets: 64, maxTicks: 1500, burn: (rocket) => (rocket === 0 ? first : rest), endLag: 2 });
      const blocked = notes.filter((m) => m.includes('corridor is blocked')).length;
      const say = `${first}/${rest}: ${sim.ticks} ticks, ${sim.stats.rockets} rockets (${sim.stats.rocketsBy.land} landing), route ${sim.stats.routeTicks} ticks, ${sim.stats.routeReplans} re-plans, ${blocked} times blocked`;
      seen.push(say);
      expect(sim.end?.ok, `${say}: ${sim.end && !sim.end.ok ? sim.end.reason : sim.phase}`).toBe(true);
      expect(sim.hits, say).toBe(0);
      expect(sim.stats.rocketsBy.land, say).toBe(0);
      expect(sim.stats.routeTicks, say).toBeLessThanOrEqual(100);
      expect(sim.stats.routeReplans, say).toBeLessThanOrEqual(3);
      expect(blocked, say).toBe(0);
    }
    console.log(`[fly-route-cap] the stack 150 out, whole flights: ${seen.join('; ')}`);
  }, 240_000);

  it('the 1 x 1 hole after a correction in the approach (the body moved a third of a block near the hole): the brake lands it on the floor; the flare never takes a cell under a rim', async () => {
    const w = world(hole);
    const obstacle = (x: number, y: number, z: number): boolean => w.solid.solidAt(x, y, z) === true;
    const start = { x: 0.5, y: FEET, z: 0.5 };
    const plan = await findLanding({ x: -90, y: FEET - 2, z: T }, 'hole', { look: w.look, obstacle, probe: () => Promise.resolve({ status: 'found' as const, blocks: 3 }) }, { ...OPTS, from: { x: start.x, z: start.z } });
    if (plan.kind !== 'goal') throw new Error(plan.line);
    const target = plan.target;
    expect(target.rim).toBe(FEET);
    const cz = cruiseHeight(start, target, w.skyTop, {});
    // (each of these ended `landed_off` on the rim by the flare before this track)
    for (const [burn, within, dx, dz] of [[18, 1.5, 0, 0.4], [18, 3.5, 0.3, 0.3], [21, 2.5, 0.4, 0], [21, 1.5, -0.2, 0.6]] as const) {
      const brain = new FlightBrain(target, { cruiseY: cz.y, groundAt: (x, z, fromY) => w.dryGround(x, z, fromY), skyTop: w.skyTop, obstacle, terrain: (x, z) => ({ top: w.skyTop(x, z), src: 'live' as const }), margin: 15, clearance: 12, goArounds: 4, descent: 'auto', landStyle: 'auto' });
      let body = initialBody(start, true);
      let cmd = { ...IDLE_COMMAND };
      let rockets = 64;
      let lastFire = -100;
      let moved = false;
      let end: ReturnType<FlightBrain['step']>['end'];
      const styles = new Set<string>();
      for (let t = 1; t < 3000 && !end; t++) {
        if (!moved && brain.phase === 'approach' && Math.hypot(body.pos.x - target.x, body.pos.z - target.z) <= within) {
          moved = true;
          body = { ...body, pos: { x: body.pos.x + dx, y: body.pos.y, z: body.pos.z + dz } };
        }
        const out = brain.step({ tick: t, body: { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 }, yaw: cmd.yaw, pitch: cmd.pitch, rockets, canFire: t - lastFire >= 4, health: 20, elytraLeft: 400 });
        end = out.end;
        if (end) break;
        if (brain.phase === 'approach' && brain.stats.landStyle) styles.add(brain.stats.landStyle);
        const c = out.control;
        cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide, forward: c.forward ?? 0, sneak: c.sneak === true };
        if (c.fire) {
          rockets--;
          lastFire = t;
        }
        body = stepBody(body, { ...cmd, ...(c.fire ? { boostStart: Math.min(GLIDE.boostMaxTicks, burn) } : {}) }, w.solid).state;
      }
      const say = `burn ${burn}, moved ${dx} ${dz} ${within} out`;
      expect(moved, say).toBe(true);
      expect(end?.ok, `${say}: ${end && !end.ok ? end.reason : ''} at y ${end?.landedAt.y}`).toBe(true);
      expect(end!.landedAt.y, say).toBeCloseTo(FEET - 2, 1);
      expect([...styles], say).toEqual(['brake']);
    }
  }, 120_000);
});
