// Flight v2, Track F1 (docs/flight.md "Manoeuvres (flight v2, Track F1)", decisions/0057): the manoeuvre
// library. Every manoeuvre's law is flown on the physics engine (stepBody, with the world's collisions)
// and must do what its characterisation says; its rollout on the planners' model (runManeuver on plan.ts
// glideRollout) must predict that flight (the same glide formula: the end state within a few hundredths);
// the stubs refuse every entry; a chain hands each state over to the next manoeuvre.
import { describe, expect, it } from 'vitest';
import {
  brake180,
  BRAKE_DONE,
  cellKey,
  cellOfKey,
  creep,
  dive,
  elevator,
  flare,
  glideTurn,
  headingOf,
  hover,
  HOVER_SINK,
  keepYaw,
  MANEUVERS,
  partialBrake,
  rocketBrake,
  runChain,
  runManeuver,
  shortBoost,
  snapTurn,
  spiral,
  speedOf,
  stackedBoost,
  TURN_OFFSET_MAX,
  TURN_RATE_MAX,
  turnOffsetFor,
  turnRadius,
  turnRate,
  verticalClimb,
  wallKiss,
  zoomClimb,
  type Maneuver,
  type ManeuverState,
} from '../../../src/skills/fly/maneuvers.ts';
import { yawDiff } from '../../../src/skills/fly/plan.ts';
import { flatWorld, GLIDE, IDLE_COMMAND, initialBody, stepBody, withBoxes, type BlockBox, type BlockQuery } from '../../../src/skills/input/index.ts';

const Y = 100;

const at = (h: number, o: { vy?: number; yaw?: number; pitch?: number; boostTicks?: number; y?: number; x?: number; z?: number } = {}): ManeuverState => ({
  pos: { x: o.x ?? 0.5, y: o.y ?? Y, z: o.z ?? 0.5 },
  vel: { x: 0, y: o.vy ?? -0.1, z: h },
  boostTicks: o.boostTicks ?? 0,
  yaw: o.yaw ?? 0,
  pitch: o.pitch ?? 0,
});

/** The law of `m` flown on stepBody from `s` (gliding) in `world` until its exit, the ground or its tick cap. */
function fly<P>(m: Maneuver<P>, p: P, s: ManeuverState, world: BlockQuery = flatWorld()) {
  let body: ReturnType<typeof stepBody>['state'] = { ...initialBody(s.pos, false), vel: { ...s.vel }, gliding: true, onGround: false, boostTicks: s.boostTicks };
  const law = m.law(s, p);
  let yaw = s.yaw;
  let pitch = s.pitch;
  let rockets = 0;
  let minY = s.pos.y;
  let maxY = s.pos.y;
  let collided = false;
  for (let t = 1; t <= m.maxTicks(p); t++) {
    const look = law({ pos: body.pos, vel: body.vel, boostTicks: body.boostTicks ?? 0, yaw, pitch }, t);
    if (look.done) return { ticks: t - 1, body, rockets, minY, maxY, collided, landed: false };
    yaw = look.yaw;
    pitch = look.pitch;
    const fire = look.fire === true && (body.boostTicks ?? 0) <= 0;
    if (fire) rockets++;
    body = stepBody(body, { ...IDLE_COMMAND, glide: true, yaw, pitch, ...(fire ? { boostStart: GLIDE.boostTicks } : {}) }, world).state;
    minY = Math.min(minY, body.pos.y);
    maxY = Math.max(maxY, body.pos.y);
    if (body.collidedHorizontally) collided = true;
    if (body.onGround) return { ticks: t, body, rockets, minY, maxY, collided, landed: true };
  }
  return { ticks: m.maxTicks(p), body, rockets, minY, maxY, collided, landed: false };
}

/** The model's rollout predicts the stepBody flight (the same formula; float32 positions on stepBody). */
function expectPredicted<P>(m: Maneuver<P>, p: P, s: ManeuverState, tol = 0.05) {
  const model = runManeuver(m, p, s);
  const real = fly(m, p, s);
  expect(model.ok, `${m.name}: ${model.why}`).toBe(true);
  expect(Math.abs(model.ticks - real.ticks), `${m.name} ticks ${model.ticks} / ${real.ticks}`).toBeLessThanOrEqual(1);
  if (model.ticks === real.ticks) {
    expect(Math.hypot(model.out.pos.x - real.body.pos.x, model.out.pos.y - real.body.pos.y, model.out.pos.z - real.body.pos.z), `${m.name} end position`).toBeLessThan(tol * Math.max(1, model.ticks / 20));
  }
  return { model, real };
}

describe('fly: the manoeuvre library on stepBody (flight v2, Track F1)', () => {
  it('the glide-turn geometry: fastest turn 6.38 degrees a tick at 96.4 degrees off; the offset solver inverts the rate; the radius is speed / rate', () => {
    expect(TURN_OFFSET_MAX).toBeCloseTo(96.38, 1);
    expect(TURN_RATE_MAX).toBeCloseTo(6.38, 1);
    for (const r of [0.5, 1, 3, 5, 6]) expect(turnRate(turnOffsetFor(r))).toBeCloseTo(r, 3);
    expect(turnOffsetFor(10)).toBe(TURN_OFFSET_MAX);
    expect(turnRadius(1.48, TURN_OFFSET_MAX)).toBeCloseTo(13.3, 0);
  });

  it('brake180: from a level glide at 1.48 under 0.2 in 10 ticks over about 5.5 blocks; pitch -30 (the hold) keeps the height within half a block, pitch 0 sinks a block', () => {
    const { model, real } = expectPredicted(brake180, {}, at(1.48));
    expect(speedOf(real.body.vel)).toBeLessThan(BRAKE_DONE);
    expect(real.ticks).toBeLessThanOrEqual(11);
    expect(real.body.pos.z - 0.5).toBeGreaterThan(4.5);
    expect(real.body.pos.z - 0.5).toBeLessThan(6.5);
    expect(Math.abs(real.body.pos.y - Y)).toBeLessThan(0.5);
    expect(model.swept.size).toBeGreaterThan(5);
    const level = fly(brake180, { pitch: 0 }, at(1.48));
    expect(Y - level.body.pos.y).toBeGreaterThan(0.7);
    // from the approach speed (1.05): 8 ticks, 3.5 blocks
    const slow = fly(brake180, {}, at(1.05));
    expect(slow.ticks).toBeLessThanOrEqual(9);
    expect(slow.body.pos.z - 0.5).toBeLessThan(4);
    expect(brake180.entry(at(0.2), {})).toBeDefined();
  });

  it('partial brake: the look 140 to 170 off slows under 0.2 within 15 ticks while the velocity swings to that side; 100 to 120 off is a turn, not a brake', () => {
    for (const offset of [140, 160, 170]) {
      const { real } = expectPredicted(partialBrake, { offset, side: 1 }, at(1.48));
      expect(speedOf(real.body.vel), `offset ${offset}`).toBeLessThan(BRAKE_DONE + 0.01);
      expect(real.ticks).toBeLessThanOrEqual(15);
      expect(Math.abs(yawDiff(0, headingOf(real.body.vel)))).toBeGreaterThan(10);
    }
    const turn = fly(partialBrake, { offset: 100, side: 1 }, at(1.48));
    expect(speedOf(turn.body.vel)).toBeGreaterThan(BRAKE_DONE);
    expect(partialBrake.entry(at(1.48), { offset: 60, side: 1 })).toBeDefined();
  });

  it(`hover: station keeping holds the point within 0.1 for 60 ticks, sinking ${HOVER_SINK} a tick at pitch 0 (more at +-20)`, () => {
    const { real } = expectPredicted(hover, { ticks: 60 }, at(0, { vy: -0.15 }));
    expect(Math.hypot(real.body.pos.x - 0.5, real.body.pos.z - 0.5)).toBeLessThan(0.1);
    expect((Y - real.body.pos.y) / 60).toBeCloseTo(HOVER_SINK, 2);
    expect(real.body.vel.y).toBeCloseTo(-HOVER_SINK, 2);
    const steep = fly(hover, { ticks: 60, pitch: 20 }, at(0, { vy: -0.15 }));
    expect(-steep.body.vel.y).toBeGreaterThan(0.2);
    expect(Math.hypot(steep.body.pos.x - 0.5, steep.body.pos.z - 0.5)).toBeLessThan(0.1);
    expect(hover.entry(at(1.0), { ticks: 10 })).toBeDefined();
  });

  it('precision creep: 3 blocks sideways from a standstill in at most 40 ticks onto the point (within 0.1, still), sinking about 5', () => {
    const to = { x: 3.5, z: 0.5 };
    const { real } = expectPredicted(creep, { to }, at(0, { vy: -0.15 }));
    expect(Math.hypot(real.body.pos.x - to.x, real.body.pos.z - to.z)).toBeLessThanOrEqual(0.1);
    expect(real.ticks).toBeLessThanOrEqual(40);
    expect(Y - real.body.pos.y).toBeLessThan(6);
    // the station-keeping law: towards the point while far, the look flipped every tick on it
    expect(Math.abs(yawDiff(keepYaw({ pos: { x: 0.5, y: Y, z: 0.5 }, vel: { x: 0, y: -0.15, z: 0 }, yaw: 0 }, to), -90))).toBeLessThan(1);
    expect(Math.abs(yawDiff(keepYaw({ pos: { x: 3.5, y: Y, z: 0.5 }, vel: { x: 0, y: -0.15, z: 0 }, yaw: 30 }, to), 210))).toBeLessThan(1e-6);
  });

  it('elevator: straight down a 1 x 1 shaft 10 deep from 1 over its rim without touching a wall (11 blocks: 74 ticks at pitch 0, 50 at pitch 20)', () => {
    // a 1 x 1 shaft: the walls from y 50 to 59, the floor block at 49 (feet 50)
    const shaft: BlockBox[] = [
      { from: { x: -1, y: 49, z: -1 }, to: { x: 1, y: 59, z: 1 }, solid: true },
      { from: { x: 0, y: 50, z: 0 }, to: { x: 0, y: 59, z: 0 }, solid: false },
    ];
    const world = withBoxes(flatWorld(), shaft);
    for (const [pitch, most] of [
      [0, 76],
      [20, 52],
    ] as const) {
      const s = at(0, { vy: -0.15, y: 61, x: 0.52, z: 0.47 });
      const r = fly(elevator, { downTo: 49, pitch, at: { x: 0.5, z: 0.5 } }, s, world);
      expect(r.landed, `pitch ${pitch}`).toBe(true);
      expect(r.collided, `pitch ${pitch}: a wall`).toBe(false);
      expect(r.body.pos.y).toBe(50);
      expect(r.ticks).toBeLessThanOrEqual(most);
      expect(Math.hypot(r.body.pos.x - 0.5, r.body.pos.z - 0.5)).toBeLessThan(0.1);
    }
    expectPredicted(elevator, { downTo: Y - 10 }, at(0, { vy: -0.15 }));
  });

  it('powered snap turn: under a rocket the velocity follows the look 90 degrees round in at most 5 ticks (one rocket)', () => {
    const { real } = expectPredicted(snapTurn, { heading: -90, fire: true }, at(1.48), 0.1);
    expect(real.rockets).toBe(1);
    expect(real.ticks).toBeLessThanOrEqual(5);
    expect(Math.abs(yawDiff(headingOf(real.body.vel), -90))).toBeLessThanOrEqual(5);
    expect(snapTurn.entry(at(1.48), { heading: 90 })).toBeDefined();
  });

  it('coordinated glide turn: 90 degrees at the radius asked (the chord of the quarter circle within 0.8 to 1.05 of radius x sqrt 2), no rocket', () => {
    for (const radius of [15, 20, 40]) {
      const { real } = expectPredicted(glideTurn, { heading: -90, radius }, at(1.48), 0.1);
      expect(Math.abs(yawDiff(headingOf(real.body.vel), -90)), `radius ${radius}`).toBeLessThanOrEqual(3);
      const chord = Math.hypot(real.body.pos.x - 0.5, real.body.pos.z - 0.5) / Math.SQRT2;
      expect(chord / radius, `radius ${radius}: ${chord.toFixed(1)}`).toBeGreaterThan(0.8);
      expect(chord / radius).toBeLessThan(1.05);
      expect(real.rockets).toBe(0);
    }
  });

  it('zoom climb: from 1.48 at pitch -45 up about 21 blocks with the speed bled to 0.35; from 1.0 about 4', () => {
    const { real } = expectPredicted(zoomClimb, { pitch: -45 }, at(1.48), 0.1);
    expect(real.body.pos.y - Y).toBeGreaterThan(18);
    expect(real.body.pos.y - Y).toBeLessThan(24);
    const slow = fly(zoomClimb, { pitch: -45 }, at(1.0));
    expect(slow.body.pos.y - Y).toBeGreaterThan(3);
    expect(slow.body.pos.y - Y).toBeLessThan(6);
  });

  it('the wrappers: the flare (-60 from 1.05: up 3 to 5), the descent circle (20 down in 130 ticks or less near the circle), the dive (hands over at 1.05), the vertical climb (30 up on one or two rockets)', () => {
    const f = expectPredicted(flare, { pitch: -60 }, at(1.05), 0.1).real;
    expect(f.body.pos.y - Y).toBeGreaterThan(3);
    expect(f.body.pos.y - Y).toBeLessThan(5);
    const centre = { x: 12.5, z: 0.5 };
    const sp = expectPredicted(spiral, { centre, radius: 12, dir: 1, exitY: Y - 20 }, at(1.0, { vy: -0.15 }), 0.2).real;
    expect(sp.ticks).toBeLessThanOrEqual(130);
    expect(Math.abs(Math.hypot(sp.body.pos.x - centre.x, sp.body.pos.z - centre.z) - 12)).toBeLessThan(4);
    const dv = expectPredicted(dive, { profile: { divePitch: 75, pullPitch: -30, pullAt: 140 }, target: { x: 0.5, z: 400 } }, at(1.2, { vy: -0.15, y: 250 }), 0.2).real;
    expect(speedOf(dv.body.vel)).toBeLessThanOrEqual(1.06);
    const vc = expectPredicted(verticalClimb, { top: Y + 30 }, at(0, { vy: 0, pitch: -90 }), 0.2).real;
    expect(vc.body.pos.y).toBeGreaterThanOrEqual(Y + 30);
    expect(vc.rockets).toBeGreaterThanOrEqual(1);
    expect(vc.rockets).toBeLessThanOrEqual(2);
  });

  it('the stubs (the short boost by a hotbar switch, stacked rockets, the wall kiss, the rocket brake) refuse every entry until Track F0 measures them', () => {
    for (const m of [shortBoost, stackedBoost, wallKiss, rocketBrake] as Maneuver<never>[]) {
      expect(m.status).toBe('stub');
      const r = runManeuver(m, {} as never, at(1.2));
      expect(r.end).toBe('refused');
      expect(r.why).toMatch(/Track F0/);
    }
    // every manoeuvre has a status and a note; the measured ones are the Track AU / AU2 / BL laws
    for (const m of Object.values(MANEUVERS)) {
      expect(m.note.length).toBeGreaterThan(10);
      expect(['measured', 'model', 'stub']).toContain(m.status);
    }
    expect(Object.values(MANEUVERS).filter((m) => m.status === 'measured').map((m) => m.name)).toEqual(['flare', 'spiral', 'dive']);
  });

  it('the simulator hook: a run ends on a solid in the box (hit), on a landing target (landed), at its exit (done); the swept cells round-trip', () => {
    // a wall 4 blocks ahead: the brake does not stop in time at pitch 0 from 1.48
    const wall = (x: number, y: number, z: number) => z === 4 && y >= Y - 3 && y <= Y + 3;
    const hit = runManeuver(brake180, { pitch: 0 }, at(1.48), { obstacle: wall });
    expect(hit.end).toBe('hit');
    expect(hit.ok).toBe(false);
    const free = runManeuver(brake180, {}, at(1.48), { obstacle: (_x, y) => y < 0 });
    expect(free.end).toBe('done');
    // the elevator onto a 1 x 1 pillar top under the body
    const pillar = runManeuver(elevator, { downTo: Y - 20 }, at(0, { vy: -0.15 }), { target: { x: 0.5, z: 0.5, top: Y - 8, half: 0.5, precise: true } });
    expect(pillar.end).toBe('landed');
    expect(pillar.touchdown!.off).toBeLessThan(0.1);
    const k = cellKey(-3, 70, 12);
    expect(cellOfKey(k)).toEqual({ x: (-3 & 0xffff), y: 70, z: 12 });
    expect(free.swept.has(cellKey(0, Y, 1))).toBe(true);
  });

  it('a chain: brake, creep back onto the point, the elevator down onto a pillar top (no rocket), from the approach speed', () => {
    const target = { x: 0.5, z: 8.5, top: Y - 10, half: 0.5, precise: true };
    const c = runChain(
      [
        { m: brake180, p: {} },
        { m: creep, p: { to: { x: 0.5, z: 8.5 } } },
        { m: elevator, p: { downTo: Y - 20 } },
      ],
      at(1.05),
      { target },
    );
    expect(c.landed, c.runs.map((r) => `${r.name} ${r.end} ${r.why ?? ''}`).join(' | ')).toBe(true);
    expect(c.runs.map((r) => r.name)).toEqual(['brake180', 'creep', 'elevator']);
    expect(c.rockets).toBe(0);
    expect(c.runs[2]!.touchdown!.off).toBeLessThan(0.15);
  });
});
