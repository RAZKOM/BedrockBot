// Wave 11 Track AU: Elytra flight on the physics engine and on fakes (docs/flight.md):
// the planning geometry, the approach planner and the brain flying whole trips offline through
// stepBody (the same engine the input loop runs), the kit rules (keeper, !drop, stash, unloader,
// armour) and the owner's supply lines.
import { describe, expect, it } from 'vitest';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import { flyEndLine, registerFlyCommands } from '../../../src/chat/commands-fly.ts';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { silentLogger } from '../../../src/log.ts';
import type { Goal, SkillResult } from '../../../src/skills/types.ts';
import { parseBlockArgs, type CommandDeps } from '../../../src/tasks/process/deps.ts';
import { FlightBrain, climbMomentum } from '../../../src/skills/fly/brain.ts';
import { skyQuery } from '../../../src/skills/fly/controller.ts';
import { elytraWornLimit, fireworksLowLine, flightKitSlots, isFireworksBox, isFlightKitItem, keptKitLine, kitLine, kitReady, readKit, SupplyWatch } from '../../../src/skills/fly/kit.ts';
import {
  ApproachPlanner,
  approachHopeless,
  approachYaw,
  circleYaw,
  columnsAlong,
  cruiseHeight,
  estimateRockets,
  glideLine,
  glideMargin,
  pathAhead,
  profilePitch,
  PROFILE_START,
  rocketPitchFor,
  simulateProfile,
  spiralFit,
  takeoffSky,
  touchdownCost,
  turnTowards,
  walkMinutes,
  yawDiff,
  yawTo,
  type FlightBody,
  type LandingTarget,
} from '../../../src/skills/fly/plan.ts';
import { glideVelocity } from '../../../src/skills/input/index.ts';
import { flyTrip } from './fly-trip.ts';
import { neverDrop } from '../../../src/skills/survival/keeper.ts';
import { planArmour } from '../../../src/skills/survival/armour.ts';
import { planUnload } from '../../../src/skills/home/unloader.ts';
import type { ItemStack } from '../../../src/world/types.ts';
import { FLIGHT_PRIORITY, FlyProcess } from '../../../src/tasks/process/fly.ts';
import { PRIORITY } from '../../../src/tasks/process/manager.ts';

const FEET = -60;
const item = (name: string, count = 1, damage?: number): ItemStack => ({ name, count, networkId: 1, metadata: 0, ...(damage !== undefined ? { damage } : {}) });
/** A shulker box wire item with NBT Items. */
const boxRaw = (items: { name: string; count: number }[]) => ({ extra: { nbt: { nbt: { value: { Items: { value: { value: items.map((i) => ({ Name: { value: `minecraft:${i.name}` }, Count: { value: i.count } })) } } } } } } });

describe('fly: geometry', () => {
  it('yawTo / yawDiff / turnTowards follow the Bedrock yaw convention and turn by at most the step', () => {
    expect(yawTo({ x: 0, z: 0 }, { x: 0, z: 10 })).toBeCloseTo(0, 6);
    expect(yawTo({ x: 0, z: 0 }, { x: -10, z: 0 })).toBeCloseTo(90, 6);
    expect(yawDiff(170, -170)).toBe(20);
    expect(yawDiff(-170, 170)).toBe(-20);
    expect(turnTowards(0, 40)).toBe(15);
    expect(turnTowards(0, 10)).toBe(10);
    expect(approachYaw(0, { x: 0, z: 0 }, { x: 0.5, z: 0.5 })).toBe(0); // frozen within YAW_FREEZE
  });

  it('columnsAlong covers both ends and every column of a straight line', () => {
    const cols = columnsAlong({ x: 0.5, z: 0.5 }, { x: 10.5, z: 3.5 });
    expect(cols[0]).toEqual({ x: 0, z: 0 });
    expect(cols.at(-1)).toEqual({ x: 10, z: 3 });
    expect(cols.length).toBeGreaterThanOrEqual(11);
  });

  it('cruiseHeight clears every known column by the clearance, treats unknown columns as the highest known plus 24 (Track BL: unknown is not air), and never flies higher than the glide down needs', () => {
    const t: LandingTarget = { x: 150.5, z: 0.5, top: -20, half: 1 };
    const flat = cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, t, () => -61);
    expect(flat.y).toBeGreaterThanOrEqual(t.top + 12);
    expect(flat.y).toBeLessThan(t.top + 25);
    const hill = cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, t, (x) => (x > 60 && x < 70 ? 10 : -61), { clearance: 12 });
    expect(hill.y).toBe(10 + 1 + 12);
    expect(hill.highest).toBe(10);
    const unknown = cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, t, (x) => (x > 60 && x < 70 ? 10 : undefined));
    expect(unknown.unknown).toBeGreaterThan(100);
    expect(unknown.y).toBe(hill.y + 24);

  });

  it('estimateRockets (Track AU2: the climb, then a top-up per 310 blocks of glide the climb does not cover) and walkMinutes: a 420-block walk is about 1 minute', () => {
    expect(estimateRockets(300, 36)).toBe(2); // 36 up: 2 rockets, the glide covers (36 - 10) x 10 + 45 + 56 = 361 blocks
    expect(estimateRockets(1200, 120)).toBe(7 + 0); // 120 up covers 1100 + 150 + 56
    expect(estimateRockets(1490, 120)).toBe(7 + 1);
    expect(estimateRockets(100, 0)).toBe(1);
    expect(Math.round(walkMinutes(420))).toBe(1);
    expect(climbMomentum(1.06)).toBeCloseTo(14.0, 1);
    expect(climbMomentum(-0.2)).toBe(0);
  });

  it('Track AU2, the energy model: cruiseHeight climbs to what the glide needs (capped by flyMaxClimb), the margin grows with the distance, the glide line and the rocket pitch table', () => {
    const ground: LandingTarget = { x: 0.5, z: 1200.5, top: FEET, half: 1 };
    const long = cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, ground, () => FEET - 1);
    expect(long.needed).toBeGreaterThan(FEET + 120);
    expect(long.y).toBe(FEET + 120); // the cap
    expect(cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, ground, () => FEET - 1, { maxClimb: 200 }).y).toBeCloseTo(long.needed, 6);
    const short = cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, { ...ground, z: 300.5 }, () => FEET - 1);
    expect(short.y).toBeGreaterThan(FEET + 30);
    expect(short.y).toBeLessThan(FEET + 42); // about 36 up: 2 rockets
    expect(glideMargin(15, 100)).toBe(0);
    expect(glideMargin(15, 300)).toBe(5);
    expect(glideMargin(15, 1000)).toBe(15);
    expect(glideLine(ground, 56)).toBe(FEET + 10);
    expect(glideLine(ground, 1056)).toBe(FEET + 110);
    expect(rocketPitchFor(31)).toBe(-38);
    expect(rocketPitchFor(14)).toBe(-20);
    expect(rocketPitchFor(3)).toBe(-10);
    expect(rocketPitchFor(19)).toBe(-25);
  });

  it('Track AU2, takeoffSky: a roof over the start refuses with the owner line, a tree in the run picks another heading, open sky keeps the bearing; unknown cells count as a roof', () => {
    const from = { x: 0.5, y: FEET, z: 0.5 };
    const target = { x: 0.5, z: 300.5 };
    const open = takeoffSky(from, target, FEET + 40, 12, () => false);
    expect(open).toEqual({ ok: true, yaw: 0 });
    const roof = takeoffSky(from, target, FEET + 40, 12, (_x, y) => y === FEET + 4);
    expect(roof.ok).toBe(false);
    if (!roof.ok) expect(roof.line).toBe(`fly: no open sky here (roof at y ${FEET + 4}, 4 blocks up); walk outside first`);
    const unknown = takeoffSky(from, target, FEET + 40, 12, (_x, y) => (y > FEET + 20 ? undefined : false));
    expect(unknown.ok).toBe(false);
    // a tree 3 wide, 8 high, 10 blocks ahead on the bearing: the start is clear, the run turns 30 degrees
    const tree = takeoffSky(from, target, FEET + 40, 12, (x, y, z) => Math.abs(x) <= 1 && z >= 9 && z <= 11 && y <= FEET + 7);
    expect(tree.ok).toBe(true);
    if (tree.ok) expect(Math.abs(tree.yaw)).toBe(30);
    // the climb cone (review item 7): a one-block bump 10 out and a trunk beside the start allow the takeoff on the bearing; a roof 3 above still refuses
    const bump = takeoffSky(from, target, FEET + 40, 12, (x, y, z) => x === 0 && z === 10 && y <= FEET);
    expect(bump).toEqual({ ok: true, yaw: 0 });
    const trunk = takeoffSky(from, target, FEET + 40, 12, (x, y, z) => x === 1 && z === 0 && y <= FEET + 1);
    expect(trunk).toEqual({ ok: true, yaw: 0 });
    const low = takeoffSky(from, target, FEET + 40, 12, (_x, y) => y === FEET + 3);
    expect(low.ok).toBe(false);
    // a wall right across the run on every heading: refused, with the distance ahead
    const walled = takeoffSky(from, target, FEET + 40, 12, (x, y, z) => Math.max(Math.abs(x), Math.abs(z)) === 6 && y <= FEET + 30);
    expect(walled.ok).toBe(false);
    if (!walled.ok) expect(walled.line).toMatch(/^fly: no open sky here \(roof at y -59, 1 block up, \d ahead\); walk outside first$/);
  });

  it('Track AU2, pathAhead, spiralFit and circleYaw: a solid within 20 ticks of the glide is seen, a circle fits only where every column within radius + 4 is lower, the yaw follows the circle', () => {
    const body: FlightBody = { pos: { x: 0.5, y: 0, z: 0.5 }, vel: { x: 0, y: -0.15, z: 1.3 }, onGround: false, gliding: true, boostTicks: 0 };
    expect(pathAhead(body, 0, 0, 20, () => false)).toBeUndefined();
    const wall = pathAhead(body, 0, 0, 20, (_x, y, z) => z === 12 && y >= -5 && y <= 5);
    expect(wall).toBeGreaterThan(5);
    expect(wall).toBeLessThan(12);
    expect(pathAhead(body, 90, 0, 20, (_x, y, z) => z === 12 && y >= -5 && y <= 5)).toBeUndefined(); // turned away
    const flat = spiralFit({ x: 0.5, z: 0.5 }, 20, () => 0);
    expect(flat).toEqual({ centre: { x: 0.5, z: 0.5 }, radius: 24 });
    // walls 10 out on three sides, 20 high: nothing fits (6 + 4 reaches them)
    const walls = spiralFit({ x: 0.5, z: 0.5 }, 20, (x, z) => (Math.abs(x) === 10 && Math.abs(z) <= 10) || (z === 10 && Math.abs(x) <= 10) ? 30 : 0);
    expect(walls).toBeUndefined();
    // a wall 19 out: a radius of 14 fits
    expect(spiralFit({ x: 0.5, z: 0.5 }, 20, (x) => (x === 19 ? 30 : 0))?.radius).toBe(14);
    expect(spiralFit({ x: 0.5, z: 0.5 }, 20, (x) => (x === 19 ? undefined : 0))).toBeDefined(); // unknown counts as high
    expect(spiralFit({ x: 0.5, z: 0.5 }, 20, (x) => (x === 19 ? undefined : 0))?.radius).toBe(14);
    // on the circle heading along it the yaw barely changes; well outside it turns towards the circle
    const on = circleYaw(0, { x: 24.5, z: 0.5 }, { x: 0.5, z: 0.5 }, 24, 1); // at +x of the centre, dir +1 moves towards +z = yaw 0
    expect(Math.abs(yawDiff(on, 0))).toBeLessThanOrEqual(30);
    const far = circleYaw(0, { x: 60.5, z: 0.5 }, { x: 0.5, z: 0.5 }, 24, 1);
    expect(far).toBe(15); // turning towards the circle at -x (about yaw 84), 15 degrees a tick
  });
});

describe('fly: the approach planner (glide formula)', () => {
  const target: LandingTarget = { x: 0.5, z: 150.5, top: -20, half: 1 };
  const body = (y: number, z: number, h: number, vy = -0.15): FlightBody => ({ pos: { x: 0.5, y, z }, vel: { x: 0, y: vy, z: h }, onGround: false, gliding: true, boostTicks: 0 });

  it('the glide formula: level flight sinks about 0.15 blocks a tick; a hard flare from 1.2 blocks/tick climbs several blocks and bleeds the speed to about 0.3', () => {
    let v = { x: 0, y: -0.15, z: 1.2 };
    let dy = 0;
    for (let i = 0; i < 60; i++) {
      v = glideVelocity(v, 0, 0, false);
      dy += v.y;
    }
    expect(dy / 60).toBeGreaterThan(-0.17);
    expect(dy / 60).toBeLessThan(-0.13);
    v = { x: 0, y: -0.15, z: 1.2 };
    dy = 0;
    let rose = false;
    let ticks = 0;
    for (; ticks < 100; ticks++) {
      v = glideVelocity(v, 0, -60, false);
      dy += v.y;
      if (v.y > 0) rose = true;
      if (rose && v.y <= 0) break;
    }
    expect(dy).toBeGreaterThan(4);
    expect(dy).toBeLessThan(10);
    expect(Math.hypot(v.x, v.z)).toBeLessThan(0.4);
  });

  it('profilePitch walks the segments A1 -> A2 -> B (flare) -> C (settle) and only ahead of the flown phase the parameters are free', () => {
    const prof = { pitchA1: 10, ticksA1: 2, pitchA2: 20, flareAt: 12, pitchB: -60, pitchC: -10 };
    let st = { ...PROFILE_START };
    const far = { x: 0.5, y: 0, z: 100 };
    const near = { x: 0.5, y: 0, z: 140 };
    let r = profilePitch(prof, st, far, { x: 0, y: -0.1, z: 1 }, target);
    expect(r.pitch).toBe(10);
    st = r.next;
    r = profilePitch(prof, st, far, { x: 0, y: -0.1, z: 1 }, target);
    expect(r.pitch).toBe(10);
    st = r.next;
    r = profilePitch(prof, st, far, { x: 0, y: -0.1, z: 1 }, target);
    expect(r.pitch).toBe(20);
    expect(r.next.phase).toBe('A2');
    r = profilePitch(prof, r.next, near, { x: 0, y: -0.1, z: 1 }, target);
    expect(r.pitch).toBe(-60);
    expect(r.next.phase).toBe('B');
    r = profilePitch(prof, r.next, near, { x: 0, y: 0.2, z: 0.6 }, target);
    expect(r.next.rose).toBe(true);
    r = profilePitch(prof, r.next, near, { x: 0, y: -0.01, z: 0.5 }, target);
    expect(r.pitch).toBe(-10);
    expect(r.next.phase).toBe('C');
  });

  it('simulateProfile classifies a touchdown on the platform, a miss beside it, the ground and an overshoot; the cost prefers the soft centre', () => {
    const landed = simulateProfile(body(-19.5, 149.3, 0.3, -0.1), 0, target, { pitchA1: 0, ticksA1: 0, pitchA2: 0, flareAt: 0, pitchB: -60, pitchC: 0 });
    expect(landed.kind).toBe('landed');
    expect(landed.off).toBeLessThan(1.5);
    const over = simulateProfile(body(-10, 148, 1.2), 0, target, { pitchA1: 0, ticksA1: 0, pitchA2: 0, flareAt: 0, pitchB: -60, pitchC: 0 });
    expect(over.kind).toBe('over');
    const ground = simulateProfile(body(-50, 100, 1.2), 0, target, { pitchA1: 45, ticksA1: 0, pitchA2: 45, flareAt: 0, pitchB: -60, pitchC: 0 });
    expect(ground.kind).toBe('short');
    const wall = simulateProfile(body(-24, 146, 1.2, -0.1), 0, target, { pitchA1: 0, ticksA1: 0, pitchA2: 0, flareAt: 0, pitchB: -60, pitchC: 0 });
    expect(['wall', 'short']).toContain(wall.kind);
    const soft = touchdownCost({ kind: 'landed', pos: { x: 0.5, y: -20, z: 150.5 }, vel: { x: 0, y: -0.1, z: 0.3 }, ticks: 10, off: 0 }, target);
    const fast = touchdownCost({ kind: 'landed', pos: { x: 0.5, y: -20, z: 150.5 }, vel: { x: 0, y: -0.1, z: 1.3 }, ticks: 10, off: 0 }, target);
    const hard = touchdownCost({ kind: 'landed', pos: { x: 0.5, y: -20, z: 150.5 }, vel: { x: 0, y: -0.9, z: 0.3 }, ticks: 10, off: 0 }, target);
    expect(soft).toBeLessThan(1);
    expect(fast).toBeGreaterThan(30);
    expect(hard).toBeGreaterThan(20);
    expect(touchdownCost(over, target)).toBeGreaterThan(fast);
  });

  it('an obstacle along the way makes every plan a wall hit (the brain then goes around)', () => {
    const wall = (x: number, y: number, z: number) => z === 140 && Math.abs(x) <= 3 && y >= -21 && y <= -14;
    const planner = new ApproachPlanner(7, wall);
    const c = planner.step(body(-10, 94.5, 1.1), 0, target);
    expect(c.touchdown.kind).not.toBe('landed');
    expect(approachHopeless(c, 6, 56)).toBe(false); // patience: not yet within 45 blocks for 6 ticks
    expect(approachHopeless(c, 6, 40)).toBe(true);
  });

  it('from the approach entry (10 above, 56 out, 1.2 blocks/tick) the planner finds a landing that touches down under 0.5 blocks/tick within a block of the centre', () => {
    const planner = new ApproachPlanner(3);
    const c = planner.step(body(-10, 94.5, 1.2), 0, target);
    expect(c.touchdown.kind).toBe('landed');
    expect(c.sims).toBeGreaterThan(50);
    // fly the plan tick by tick with the planner re-planning (the controller's loop) on the pure formula
    let b = body(-10, 94.5, 1.2);
    let yaw = 0;
    for (let t = 0; t < 400 && b.pos.y > target.top; t++) {
      yaw = approachYaw(yaw, b.pos, target);
      const step = planner.step(b, yaw, target);
      const v = glideVelocity(b.vel, yaw, step.pitch, false);
      b = { ...b, pos: { x: b.pos.x + v.x, y: b.pos.y + v.y, z: b.pos.z + v.z }, vel: v };
    }
    expect(b.pos.y).toBeLessThanOrEqual(target.top + 0.01);
    expect(Math.hypot(b.pos.x - target.x, b.pos.z - target.z)).toBeLessThan(1.5);
    expect(Math.hypot(b.vel.x, b.vel.z)).toBeLessThan(0.6);
    expect(b.vel.y).toBeGreaterThan(-0.5);
  });
});

/** The brain flying a whole trip on stepBody over a synthetic world (the offline simulator of the track). */
describe('fly: the brain flies whole trips on stepBody', () => {
  it('150 blocks to a 3x3 platform 40 up: lands on it with a soft touchdown and few rockets', () => {
    const r = flyTrip({ dist: 150, up: 40, half: 1 });
    expect(r.end.ok, JSON.stringify(r.end)).toBe(true);
    expect(r.end.off).toBeLessThanOrEqual(1.5);
    expect(r.lastAir.vy).toBeGreaterThan(-0.5);
    expect(r.rockets).toBeLessThanOrEqual(6);
    expect(r.goArounds).toBeLessThanOrEqual(2);
  });

  it('100 blocks to flat ground: one rocket, lands within a block and a half of the aim', () => {
    const r = flyTrip({ dist: 100, up: 0, half: 40 });
    expect(r.end.ok).toBe(true);
    expect(r.end.off).toBeLessThan(1.5);
    expect(r.rockets).toBeLessThanOrEqual(2);
  });

  it('from 60 blocks above the platform level, 100 blocks away: a circle of radius 24 around the platform (the descent geometry), no go-around', () => {
    const r = flyTrip({ dist: 100, up: 40, half: 1, startUp: 100 });
    expect(r.end.ok).toBe(true);
    expect(r.goArounds).toBe(0);
    expect(r.rockets).toBeLessThanOrEqual(2);
    expect(r.descents[0]).toMatch(/^spiral r24 at 0 out/);
    expect(r.hits).toBe(0);
  });

  it('Track AU2: the same with 20-high walls 10 blocks out on three sides: no circle fits there, one tangent to the approach line 30 blocks out does; a landing without a hit', () => {
    const r = flyTrip({ dist: 100, up: 40, half: 1, startUp: 100, walls: true });
    expect(r.end.ok, JSON.stringify(r.end)).toBe(true);
    expect(r.descents[0]).toMatch(/^spiral r\d+ at 3\d out/);
    expect(r.hits).toBe(0);
    expect(r.goArounds).toBeLessThanOrEqual(2);
  });

  it('a wall 12 high 10 blocks before the platform: the planner sees it (a go-around or a circle first), then a landing without a hit', () => {
    const r = flyTrip({ dist: 150, up: 40, half: 1, wall: true });
    expect(r.end.ok).toBe(true);
    expect(r.hits).toBe(0);
    expect(r.goArounds + r.descents.length).toBeGreaterThanOrEqual(1);
  });

  it('300 blocks to a 5x5 platform 20 up: at most 4 rockets (Track AU2: the climb to the glide line, no cruise boost)', () => {
    const r = flyTrip({ dist: 300, up: 20, half: 2 });
    expect(r.end.ok).toBe(true);
    expect(r.rockets).toBeLessThanOrEqual(4);
    expect(r.by.cruise).toBe(0);
  });

  it('Track AU2, the rocket economy on the flat: 300 blocks at most 2 rockets, 600 at most 4, 1200 at most 7 (before: 1 / 5 / 13 on bds-fly), the climb then the glide, at most one top-up per 300 blocks of glide beyond it', () => {
    const r300 = flyTrip({ dist: 300, up: 0, half: 1 });
    const r600 = flyTrip({ dist: 600, up: 0, half: 1 });
    const r1200 = flyTrip({ dist: 1200, up: 0, half: 1 });
    for (const r of [r300, r600, r1200]) expect(r.end.ok, JSON.stringify(r.end)).toBe(true);
    expect(r300.rockets).toBeLessThanOrEqual(2);
    expect(r600.rockets).toBeLessThanOrEqual(4);
    expect(r1200.rockets).toBeLessThanOrEqual(7);
    expect(r1200.maxY).toBeLessThanOrEqual(FEET + 120 + 31); // the cap of the climb plus one rocket's run-out
    for (const [r, d] of [[r600, 600], [r1200, 1200]] as const) {
      const cruise = Math.max(0, d - 56 - (r.maxY - FEET) * 1.25);
      expect(r.by.cruise).toBeLessThanOrEqual(Math.max(1, Math.ceil(cruise / 300)));
    }
    // the Realm's 1490-block flight (17 rockets on 2026-10-30): the model takes 9 to 10
    const realm = flyTrip({ dist: 1490, up: 0, half: 1 });
    expect(realm.end.ok).toBe(true);
    expect(realm.rockets).toBeLessThanOrEqual(10);
  });

  it('Track AU2, the path ahead: a tree 10 blocks ahead on the climb line is steered around (the sky check turns the takeoff 30 degrees, the climb looks 20 ticks ahead): no hit, landed', () => {
    const r = flyTrip({ dist: 300, up: 0, half: 1, tree: true, takeoffYaw: 30 });
    expect(r.end.ok, JSON.stringify(r.end)).toBe(true);
    expect(r.hits).toBe(0);
    const straight = flyTrip({ dist: 300, up: 0, half: 1, tree: true });
    expect(straight.end.ok, JSON.stringify(straight.end)).toBe(true);
    expect(straight.hits).toBe(0);
    expect(straight.steered).toBeGreaterThan(0);
  });

  it('Track AU2 review: a roof 12 above a cruising body that is under the glide line: no rocket goes (the boosted path is checked before firing)', () => {
    const target: LandingTarget = { x: 0.5, z: 600.5, top: FEET, half: 1, ground: FEET };
    const roofY = FEET + 40 + 12;
    const brain = new FlightBrain(target, { cruiseY: FEET + 70, groundAt: () => FEET, obstacle: (_x, y) => y === roofY, seed: 3 });
    // a body in the cruise, 40 up at 400 blocks out: the glide line there is about 54 up, so it wants a rocket
    const body: FlightBody = { pos: { x: 0.5, y: FEET + 40, z: 200.5 }, vel: { x: 0, y: -0.15, z: 1.4 }, onGround: false, gliding: true, boostTicks: 0 };
    brain.phase = 'cruise';
    let fired = false;
    for (let t = 1; t <= 10; t++) {
      const out = brain.step({ tick: t, body, yaw: 0, pitch: 0, rockets: 10, canFire: true, health: 20, elytraLeft: 400 });
      if (out.control.fire) fired = true;
    }
    expect(fired).toBe(false);
    expect(brain.stats.steered).toBeGreaterThan(0);
    // the same without the roof: the rocket goes
    const open = new FlightBrain(target, { cruiseY: FEET + 70, groundAt: () => FEET, obstacle: () => false, seed: 3 });
    open.phase = 'cruise';
    const out = open.step({ tick: 1, body, yaw: 0, pitch: 0, rockets: 10, canFire: true, health: 20, elytraLeft: 400 });
    expect(out.control.fire).toBe(true);
  });

  it('Track AU2 review: the fly-walk house: retargeted to the cell 2 blocks before its door wall while the body circles beyond the house: the go-around comes back from the open side and lands (before: 4 go-arounds, landed 30 off)', () => {
    // the landable cell before the door: as flown when its ground is known at the takeoff
    const direct = flyTrip({ dist: 295, up: 0, half: 1, house: 5 });
    expect(direct.end.ok, JSON.stringify(direct.end)).toBe(true);
    expect(direct.hits).toBe(0);
    // the goal inside the house first, the retarget once the body is 10 beyond its centre (the far side of the circle)
    for (const seed of [1, 2]) {
      const r = flyTrip({ dist: 300, up: 0, half: 1, house: 0, seed, retargetFrom: { x: 0.5, z: 295.5, top: FEET, half: 1, ground: FEET }, retargetWithin: 60, retargetBeyond: 10 });
      expect(r.retargeted).toBeGreaterThan(0);
      expect(r.end.ok, JSON.stringify(r.end)).toBe(true);
      expect(r.goArounds).toBeLessThanOrEqual(1);
      expect(r.hits).toBe(0);
    }
  });

  it('Track AU2, a roof 6 above the start the sky check did not see: the climb never flies into it; the flight ends on the ground under it as `roof`, not by health', () => {
    const r = flyTrip({ dist: 300, up: 0, half: 1, roof: true });
    expect(r.end.ok).toBe(false);
    if (!r.end.ok) expect(r.end.reason).toBe('roof');
    expect(r.body.onGround).toBe(true);
    expect(r.maxY).toBeLessThan(FEET + 6 - 0.6); // never into the roof's cells
    expect(r.steered).toBeGreaterThan(0);
  });

  it('out of rockets early: the flight ends on the ground (no_rockets or landed short), never in the air', () => {
    const r = flyTrip({ dist: 300, up: 20, half: 2, rockets: 1 });
    expect(r.body.onGround).toBe(true);
    expect(r.end.ok || r.end.reason === 'no_rockets' || r.end.reason === 'landed_off').toBe(true);
  });

  it('landNow in the air ends on the ground; landNow on the ground before the takeoff is done at once', () => {
    const target: LandingTarget = { x: 0.5, z: 150.5, top: -20, half: 1, ground: FEET };
    const brain = new FlightBrain(target, { cruiseY: -5, groundAt: () => FEET });
    brain.landNow('stopped', { pos: { x: 0.5, y: FEET, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: true, gliding: false, boostTicks: 0 });
    expect(brain.phase).toBe('done');
    const flying = new FlightBrain(target, { cruiseY: -5, groundAt: () => FEET });
    flying.step({ tick: 1, body: { pos: { x: 0.5, y: -30, z: 40 }, vel: { x: 0, y: -0.15, z: 1.2 }, onGround: false, gliding: true, boostTicks: 0 }, yaw: 0, pitch: 0, rockets: 10, canFire: true, health: 20, elytraLeft: 400 });
    flying.landNow('stopped', { pos: { x: 0.5, y: -30, z: 40 }, vel: { x: 0, y: -0.15, z: 1.2 }, onGround: false, gliding: true, boostTicks: 0 });
    expect(flying.phase).toBe('land');
    expect(flying.aim.top).toBe(FEET);
  });

  it('skyQuery treats unknown cells as air and keeps known ones', () => {
    const q = skyQuery({ solidAt: (x, y) => (y === 0 ? true : y === 1 ? false : undefined) });
    expect(q.solidAt(0, 0, 0)).toBe(true);
    expect(q.solidAt(0, 1, 0)).toBe(false);
    expect(q.solidAt(0, 5, 0)).toBe(false);
  });

  it('the in-air process outranks flee', () => {
    expect(FLIGHT_PRIORITY).toBeGreaterThan(PRIORITY.flee);
  });
});

describe('fly: the kit rules', () => {
  const raw64 = boxRaw([{ name: 'firework_rocket', count: 64 }]);
  const inv = (slots: (ItemStack | null)[], worn: ItemStack | null = null, raws: Record<number, unknown> = {}) => ({
    slots: [...slots, ...Array.from({ length: 36 - slots.length }, () => null)],
    rawItem: (_w: number, i: number) => raws[i],
    window: (id: number) => (id === 120 ? { slots: [null, worn, null, null] } : undefined),
  });

  it('a fireworks box is a shulker box holding rockets only; readKit counts the elytra, the rockets (hotbar and all) and the box', () => {
    expect(isFireworksBox('undyed_shulker_box', raw64)).toBe(true);
    expect(isFireworksBox('red_shulker_box', boxRaw([{ name: 'firework_rocket', count: 10 }, { name: 'cobblestone', count: 3 }]))).toBe(false);
    expect(isFireworksBox('undyed_shulker_box', boxRaw([]))).toBe(false);
    expect(isFireworksBox('chest', raw64)).toBe(false);
    const k = readKit(inv([item('firework_rocket', 16), null, null, null, null, null, null, null, null, item('elytra', 1, 32), item('firework_rocket', 7), item('undyed_shulker_box')], null, { 11: raw64 }));
    expect(k.elytraSlot).toBe(9);
    expect(k.elytraWorn).toBe(false);
    expect(k.elytraLeft).toBe(400);
    expect(k.rocketsHotbar).toBe(16);
    expect(k.rockets).toBe(23);
    expect(k.boxSlot).toBe(11);
    expect(k.boxRockets).toBe(64);
    expect(kitLine(k)).toBe('elytra 400/432, 23 rockets (16 in the hotbar), box 64');
    expect(keptKitLine(k)).toBe('kept the flight kit (elytra, 23 rockets, the fireworks box); !drop flightkit drops it');
    const named = readKit(inv([null, item('undyed_shulker_box')], item('elytra'), { 1: boxRaw([]) }), { namedBoxSlot: 1 });
    expect(named.boxSlot).toBe(1);
    expect(named.elytraWorn).toBe(true);
  });

  it('kitReady refuses without an elytra, with a worn one (toolWearLimit + 20) and without any rockets', () => {
    expect(kitReady(readKit(inv([item('firework_rocket', 5)])), 10)).toMatchObject({ ok: false, reason: 'no_elytra' });
    const worn = kitReady(readKit(inv([item('firework_rocket', 5), item('elytra', 1, 432 - 25)])), 10);
    expect(worn).toMatchObject({ ok: false, reason: 'elytra_worn', line: 'elytra worn: 25 uses left; I will not fly until it is mended or replaced' });
    expect(elytraWornLimit(10)).toBe(30);
    expect(kitReady(readKit(inv([item('elytra')])), 10)).toMatchObject({ ok: false, reason: 'no_rockets' });
    expect(kitReady(readKit(inv([item('elytra'), item('undyed_shulker_box')], null, { 1: raw64 })), 10)).toEqual({ ok: true });
  });

  it('the keeper never drops the kit, !drop items keeps the rockets, flightKitSlots names every kit slot', () => {
    expect(isFlightKitItem('firework_rocket')).toBe(true);
    expect(isFlightKitItem('minecraft:elytra')).toBe(true);
    expect(neverDrop('firework_rocket')).toBe(true);
    expect(neverDrop('elytra')).toBe(true);
    expect(keepOnDropItems('firework_rocket')).toBe(true);
    expect(keepOnDropItems('undyed_shulker_box')).toBe(true);
    const slots = flightKitSlots(inv([item('firework_rocket', 16), item('cobblestone', 64), item('elytra'), item('undyed_shulker_box'), item('purple_shulker_box')], null, { 3: raw64, 4: boxRaw([{ name: 'cobblestone', count: 64 }]) }), undefined);
    expect([...slots].sort()).toEqual([0, 2, 3]);
  });

  it('the unloader keeps a flight-kit box, the armour pass leaves a worn elytra alone', () => {
    const plan = planUnload(
      [
        { slot: 0, name: 'undyed_shulker_box', count: 1, boxUsed: 1, flightKit: true },
        { slot: 1, name: 'cobblestone', count: 64 },
      ],
      [{ key: 'c', pos: { x: 0, y: 0, z: 0 }, kind: 'chest', free: 27, contents: {}, room: {}, boxes: { empty: 0, full: 0 } }],
      { reserve: 0 },
    );
    expect(plan.kept).toContainEqual({ name: 'undyed_shulker_box', count: 1, why: 'flight_kit' });
    expect(plan.moves.some((m) => m.name === 'undyed_shulker_box')).toBe(false);
    expect(plan.moves.some((m) => m.name === 'cobblestone')).toBe(true);
    const moves = planArmour([item('iron_chestplate')], [null, item('elytra'), null, null]);
    expect(moves).toEqual([]);
    const plain = planArmour([item('iron_chestplate')], [null, null, null, null]);
    expect(plain).toHaveLength(1);
  });

  it('SupplyWatch says the low-fireworks line once per count and the worn-elytra line once per use count', () => {
    const w = new SupplyWatch();
    const low = readKit(inv([item('firework_rocket', 9), item('elytra')]));
    expect(w.check(low, 16, 10)).toEqual([fireworksLowLine(9)]);
    expect(fireworksLowLine(9)).toBe('fireworks low: 9 rockets left and the box is empty; give me more (drop them or !bring fireworks_rocket 64)');
    expect(w.check(low, 16, 10)).toEqual([]);
    const lower = readKit(inv([item('firework_rocket', 7), item('elytra')]));
    expect(w.check(lower, 16, 10)).toEqual([fireworksLowLine(7)]);
    const boxed = readKit(inv([item('firework_rocket', 7), item('elytra'), item('undyed_shulker_box')], null, { 2: raw64 }));
    expect(w.check(boxed, 16, 10)).toEqual([]);
    const worn = readKit(inv([item('firework_rocket', 40), item('elytra', 1, 432 - 25)]));
    expect(w.check(worn, 16, 10)).toEqual(['elytra worn: 25 uses left; I will not fly until it is mended or replaced']);
    expect(w.check(worn, 16, 10)).toEqual([]);
  });

  it('flyEndLine words the outcomes', () => {
    const target = { x: 0.5, z: 0.5, top: -20, half: 1, label: 'home' };
    const report = { ok: true, landedAt: { x: 0.7, y: -20, z: 0.2 }, off: 0.4, onTarget: true, rockets: 3, rocketsBy: { climb: 2, cruise: 0, goaround: 1, land: 0 }, descents: [], steered: 0, goArounds: 1, ticks: 200, corrections: 4, glideEnds: 1, touchdown: { vy: -0.1, h: 0.3 }, maxY: 0 };
    expect(flyEndLine({ ok: true, target, distance: 150, report, seconds: 12, notes: [] })).toBe('landed at 0.7 -20 0.2, 0.4 from the aim (home); 3 rockets, 1 go-around, 12 s');
    expect(flyEndLine({ ok: false, reason: 'stopped', target, distance: 150, report: { ...report, ok: false }, seconds: 5, notes: [] })).toMatch(/^landed \(stopped\) at /);
    expect(flyEndLine({ ok: false, reason: 'no_glide', target, distance: 150, seconds: 5, notes: [] })).toMatch(/^fly: the server did not let me glide/);
    expect(flyEndLine({ ok: false, reason: 'roof', target, distance: 150, report: { ...report, ok: false }, seconds: 5, notes: [] })).toMatch(/^landed \(no open sky ahead: a roof\) at .*; walk outside first/);
    expect(flyEndLine({ ok: false, reason: 'fly: no open sky here (roof at y 72, 3 blocks up); walk outside first', target, distance: 150, seconds: 0, notes: [] })).toBe('fly: no open sky here (roof at y 72, 3 blocks up); walk outside first');
  });
});

/**
 * Track AU2 review: the automatic flight of `!come` / `!goto` (commands-fly.ts wraps pve.come / pve.walk)
 * on a fake world: flat ground (the top block at FEET - 1), optionally a stone slab FEET .. FEET + 6 over
 * |x|, |z| <= 10 with a 2-high tunnel at x = 0 (the bot underground), optionally a mountain plateau
 * 100 high around the player (its top more than 80 above the bot: skyTop's scan starts inside it).
 */
function comeRig(o: { tunnel?: boolean; mountain?: boolean; home?: { x: number; y: number; z: number }; users?: number } = {}) {
  const solid = (x: number, y: number, z: number): boolean => {
    if (y < -64 || y > 319) return false;
    if (y <= FEET - 1) return true;
    if (o.tunnel && Math.abs(x) <= 10 && Math.abs(z) <= 10 && y <= FEET + 6) return !(x === 0 && z >= -2 && z <= 2 && y <= FEET + 1);
    if (o.mountain && Math.abs(x) <= 30 && z >= 270 && z <= 330 && y <= FEET + 100) return true;
    return false;
  };
  const block = (s: boolean) => ({ name: s ? 'stone' : 'air', stateId: 1, states: {}, hardness: s ? 1.5 : 0, solid: s, boxes: [] });
  const slots: (ItemStack | null)[] = [item('firework_rocket', 64), item('elytra', 1, 0), ...Array.from({ length: 34 }, () => null)];
  const inventory = { slots, selected: 0, rawItem: () => undefined, window: (id: number) => (id === 120 ? { slots: [null, null, null, null] } : undefined) };
  const world = { blockAt: (p: { x: number; y: number; z: number }) => block(solid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))), inventory, entityTracker: {}, self: { health: 20, dimension: 0 }, cache: undefined };
  const loop = { state: { ready: true, pos: { x: 0.5, y: FEET, z: 0.5 }, gliding: false, onGround: true }, waitTicks: () => Promise.resolve() };
  const added: unknown[] = [];
  const said: string[] = [];
  const walks: Goal[] = [];
  const comes: string[] = [];
  const playerAt = { x: 0.5, y: o.mountain ? FEET + 101 : FEET, z: 300.5 };
  const homes: string[] = [];
  const pve = {
    returnHome: (why: string) => (homes.push(why), Promise.resolve({ ok: true })),
    walk: (g: Goal) => (walks.push(g), Promise.resolve({ ok: false, reason: 'interrupted' })),
    come: (n: string) => (comes.push(n), Promise.resolve({ ok: true })),
    playerFeet: (n: string) => (n === 'Steve' ? playerAt : undefined),
    mover: undefined,
    hotbar: undefined,
  };
  const settings = new RuntimeSettings();
  const task = { name: 'afk', stop: () => {}, ...(o.home ? { home: { get: () => o.home } } : {}) };
  const deps = {
    chat: { register: () => {}, say: (m: string) => said.push(m) },
    task,
    conn: { queue: () => {} },
    mobility: { loop },
    skills: {},
    world,
    processes: { add: (p: unknown) => added.push(p), find: () => [], stop: () => true, userProcesses: () => Array.from({ length: o.users ?? 0 }, () => ({})) },
    settings,
    pve,
    log: silentLogger,
    parseBlock: parseBlockArgs,
    needsWalking: (c: string) => `${c} needs walking`,
  } as unknown as CommandDeps;
  registerFlyCommands(deps);
  return { pve: pve as unknown as { come(n: string): Promise<SkillResult>; returnHome(why: string, o?: { ifIdle?: boolean }): Promise<SkillResult> }, said, walks, comes, added, settings, homes };
}
// (Track BH: the takeoff is simulated before the reply now: wait for the first line, up to 5 s)
const settle = async (rig?: { said: string[] }): Promise<void> => {
  for (let i = 0; i < 250 && rig?.said.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 20));
};

describe('fly: the trips home the bot makes by itself fly too (pve.returnHome)', () => {
  it('home 300 blocks away: a flight as the home return (named home, auto, the home priority); near home: the walk', async () => {
    const r = comeRig({ home: { x: 0, y: FEET, z: 300 } });
    void r.pve.returnHome('dawn');
    for (let i = 0; i < 250 && !r.added.some((p) => p instanceof FlyProcess); i++) await new Promise((res) => setTimeout(res, 20));
    const fly = r.added.find((p): p is FlyProcess => p instanceof FlyProcess);
    expect(fly).toBeDefined();
    expect(fly).toMatchObject({ name: 'home', kind: 'auto' });
    expect(fly!.priority).toBe(PRIORITY.home);
    expect(fly!.target).toMatchObject({ x: 0.5, z: 300.5, label: 'home' });
    expect(r.homes).toEqual([]); // not walked
    const near = comeRig({ home: { x: 0, y: FEET, z: 20 } });
    expect(await near.pve.returnHome('dawn')).toMatchObject({ ok: true });
    expect(near.homes).toEqual(['dawn']);
    expect(near.added.some((p) => p instanceof FlyProcess)).toBe(false);
  });

  it('ifIdle with a command running: nothing (busy), as the walk home did', async () => {
    const r = comeRig({ home: { x: 0, y: FEET, z: 300 }, users: 1 });
    expect(await r.pve.returnHome('food', { ifIdle: true })).toMatchObject({ ok: false, reason: 'busy' });
    expect(r.added.some((p) => p instanceof FlyProcess)).toBe(false);
    expect(r.homes).toEqual([]);
  });
});

describe('fly: the automatic flight of !come (commands-fly.ts)', () => {
  it('!come to a player 300 blocks away under open sky flies to the player (half 2); with autoFly off it walks', async () => {
    const r = comeRig();
    void r.pve.come('Steve');
    await settle(r);
    expect(r.said).toEqual(['flying (300 blocks; walking would be ~1 min)']);
    const fly = r.added.find((p): p is FlyProcess => p instanceof FlyProcess);
    // Track BF: a landable goal is a walk landing: any of its flat dry neighbourhood (an off-centre touchdown is no go-around)
    expect(fly?.target).toMatchObject({ x: 0.5, z: 300.5, top: FEET, walk: true, label: 'Steve', cell: { kind: 'goal' } });
    expect(fly?.target.cells?.size).toBeGreaterThan(9);
    expect(r.comes).toEqual([]);
    const off = comeRig();
    off.settings.set('autoFly', false);
    await off.pve.come('Steve');
    expect(off.comes).toEqual(['Steve']);
    expect(off.said).toEqual([]);
  });

  it('review item 1: underground (a tunnel 7 under the surface) !come walks to an open-sky cell on the surface first, not along the tunnel', async () => {
    const r = comeRig({ tunnel: true });
    void r.pve.come('Steve');
    await settle(r);
    expect(r.said[0]).toBe(`fly: no open sky here (roof at y ${FEET + 2}, 2 blocks up); walking towards Steve and taking off outside`);
    expect(r.walks[0]).toEqual({ type: 'block', p: { x: 0, y: FEET + 7, z: 4 } });
    expect(r.added.some((p) => p instanceof FlyProcess)).toBe(false);
  });

  it('review item 4: a player on a plateau more than 80 above the bot: its top is the plateau top, not the cell skyTop started in, so the player is landed on', async () => {
    const r = comeRig({ mountain: true });
    void r.pve.come('Steve');
    await settle(r);
    expect(r.said).toEqual(['flying (300 blocks; walking would be ~1 min)']);
    const fly = r.added.find((p): p is FlyProcess => p instanceof FlyProcess);
    expect(fly?.target).toMatchObject({ top: FEET + 101, walk: true, cell: { kind: 'goal' } });
  });
});
