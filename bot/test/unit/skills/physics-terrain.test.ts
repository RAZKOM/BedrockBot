// Movement model on real block shapes, friction, liquids; Bedrock sprint rules; knockback.
import { describe, expect, it } from 'vitest';
import { IDLE_COMMAND, applyMotion, flatWorld, initialBody, stepBody, type BodyState, type MoveCommand } from '../../../src/skills/input/index.ts';
import { DOUBLE_TAP_TICKS, newSprintTracker, stepSprint } from '../../../src/skills/input/sprint.ts';
import { groundFriction, liquidContact } from '../../../src/skills/input/physics.ts';
import { blockQueryOf } from '../../../src/skills/terrain/index.ts';
import { flatGen } from './genworld.ts';
import { harness } from './fakes.ts';

function run(q: ReturnType<typeof blockQueryOf>, s: BodyState, cmd: Partial<MoveCommand>, ticks: number): BodyState {
  const c = { ...IDLE_COMMAND, ...cmd };
  for (let i = 0; i < ticks; i++) s = stepBody(s, c, q).state;
  return s;
}

describe('physics on block shapes', () => {
  it('a full-cube world through boxesAt matches the solidAt-only model bit for bit', () => {
    const q = blockQueryOf(flatGen());
    const plain = flatWorld();
    let a = initialBody({ x: 0.5, y: -60, z: 0.5 }, true);
    let b = initialBody({ x: 0.5, y: -60, z: 0.5 }, true);
    const cmd = { ...IDLE_COMMAND, forward: 1, yaw: -37, sprint: true, jump: true };
    for (let i = 0; i < 80; i++) {
      a = stepBody(a, cmd, q).state;
      b = stepBody(b, cmd, plain).state;
    }
    expect(a.pos).toEqual(b.pos);
    expect(a.vel).toEqual(b.vel);
  });

  it('walks up a bottom slab by auto-step (0.5 < 0.5625) without jumping', () => {
    const w = flatGen();
    w.fill({ x: -1, y: -60, z: 2 }, { x: 1, y: -60, z: 9 }, 'oak_slab');
    const q = blockQueryOf(w);
    const s = run(q, initialBody({ x: 0.5, y: -60, z: 0.5 }, true), { forward: 1 }, 20);
    expect(s.pos.z).toBeGreaterThan(2.5);
    expect(s.pos.y).toBeCloseTo(-59.5, 5);
  });

  it('cannot walk onto a fence (1.5 high) but can step onto a carpet', () => {
    const w = flatGen();
    w.fill({ x: -1, y: -60, z: 2 }, { x: 1, y: -60, z: 2 }, 'oak_fence');
    const q = blockQueryOf(w);
    const s = run(q, initialBody({ x: 0.5, y: -60, z: 0.5 }, true), { forward: 1, jump: true }, 40);
    expect(s.pos.z).toBeLessThan(2.375 - 0.3 + 1e-3); // stopped at the post (0.375 .. 0.625)
    const w2 = flatGen();
    w2.fill({ x: -1, y: -60, z: 2 }, { x: 1, y: -60, z: 6 }, 'white_carpet');
    const s2 = run(blockQueryOf(w2), initialBody({ x: 0.5, y: -60, z: 0.5 }, true), { forward: 1 }, 20);
    expect(s2.pos.y).toBeCloseTo(-59.9375, 5);
  });

  it('slides further on ice (friction 0.98)', () => {
    const plain = flatGen();
    const icy = flatGen();
    icy.fill({ x: -5, y: -61, z: -5 }, { x: 5, y: -61, z: 40 }, 'ice');
    const coast = (q: ReturnType<typeof blockQueryOf>) => {
      let s = run(q, initialBody({ x: 0.5, y: -60, z: 0.5 }, true), { forward: 1 }, 10);
      const z0 = s.pos.z;
      s = run(q, s, {}, 40);
      return s.pos.z - z0;
    };
    expect(groundFriction(blockQueryOf(icy), { x: 0.5, y: -60, z: 0.5 })).toBe(0.98);
    expect(coast(blockQueryOf(icy))).toBeGreaterThan(3 * coast(blockQueryOf(plain)));
  });

  it('sinks slowly in water (gravity 0.005, drag 0.8) and rises with jump held', () => {
    const w = flatGen();
    w.fill({ x: -3, y: -63, z: -3 }, { x: 3, y: -61, z: 3 }, 'water');
    const q = blockQueryOf(w);
    expect(liquidContact(q, { x: 0.5, y: -61.5, z: 0.5 })).toEqual({ water: true, lava: false });
    let s = initialBody({ x: 0.5, y: -61, z: 0.5 });
    s = stepBody(s, IDLE_COMMAND, q).state;
    expect(s.inWater).toBe(true);
    expect(s.vel.y).toBeCloseTo(-0.005, 6);
    s = run(q, s, {}, 10);
    // terminal sink speed: v = 0.8 v - 0.005 -> 0.025 per tick
    expect(s.vel.y).toBeGreaterThan(-0.0251);
    const up = run(q, s, { jump: true }, 10);
    expect(up.pos.y).toBeGreaterThan(s.pos.y);
  });
});

describe('Bedrock sprint rules (sticky sprint, double tap)', () => {
  const cmd = (c: Partial<MoveCommand>): MoveCommand => ({ ...IDLE_COMMAND, ...c });
  const body = initialBody({ x: 0, y: 0, z: 0 }, true);

  it('keeps sprinting after the sprint key is released while forward is held; forward release ends it', () => {
    const t = newSprintTracker();
    expect(stepSprint(t, cmd({ forward: 1, sprint: true }), body)).toBe(true);
    expect(stepSprint(t, cmd({ forward: 1 }), body)).toBe(true);
    expect(stepSprint(t, cmd({ forward: 1 }), body)).toBe(true);
    expect(stepSprint(t, cmd({}), body)).toBe(false);
    for (let i = 0; i < 10; i++) stepSprint(t, cmd({}), body);
    expect(stepSprint(t, cmd({ forward: 1 }), body)).toBe(false);
  });

  it('a wall (horizontal collision on the previous tick) or sneaking ends the sprint', () => {
    const t = newSprintTracker();
    stepSprint(t, cmd({ forward: 1, sprint: true }), body);
    expect(stepSprint(t, cmd({ forward: 1 }), { ...body, collidedHorizontally: true })).toBe(false);
    expect(stepSprint(t, cmd({ forward: 1 }), body)).toBe(false);
    const t2 = newSprintTracker();
    stepSprint(t2, cmd({ forward: 1, sprint: true }), body);
    expect(stepSprint(t2, cmd({ forward: 1, sneak: true }), body)).toBe(false);
  });

  it(`a forward re-press within ${DOUBLE_TAP_TICKS} ticks of the previous press sprints, 7 does not`, () => {
    for (const [gap, sprints] of [
      [DOUBLE_TAP_TICKS, true],
      [DOUBLE_TAP_TICKS + 1, false],
    ] as const) {
      const t = newSprintTracker();
      stepSprint(t, cmd({ forward: 1 }), body);
      for (let i = 1; i < gap; i++) stepSprint(t, cmd({}), body);
      expect(stepSprint(t, cmd({ forward: 1 }), body), `gap ${gap}`).toBe(sprints);
    }
  });

  it('the InputLoop sends start_sprinting on a double tap and keeps sprinting without the key', () => {
    const { conn, loop } = harness({ x: 0.5, y: -60, z: 0.5 });
    loop.world = flatWorld();
    conn.tick(2);
    loop.setCommand({ forward: 1 });
    conn.tick(2);
    loop.setCommand({ forward: 0 });
    conn.tick(2);
    loop.setCommand({ forward: 1 });
    conn.tick(1);
    expect(conn.sent.at(-1)!.input_data).toContain('start_sprinting');
    expect(conn.sent.at(-1)!.input_data).not.toContain('sprint_down');
    conn.tick(5);
    expect(conn.sent.at(-1)!.input_data).toContain('sprinting');
    expect(loop.state.sprinting).toBe(true);
    loop.setCommand({ forward: 0 });
    conn.tick(1);
    expect(conn.sent.at(-1)!.input_data).toContain('stop_sprinting');
  });
});

describe('set_entity_motion (knockback)', () => {
  it('applies the velocity after the tagged input and re-simulates the later ones', () => {
    const { conn, loop } = harness({ x: 0.5, y: -60, z: 0.5 });
    loop.world = flatWorld();
    conn.tick(10);
    const tagged = conn.sent.at(-4)!.tick;
    conn.receive('set_entity_motion', { runtime_entity_id: 7n, velocity: { x: 0.4, y: 0.36, z: 0 }, tick: tagged });
    const s = loop.state;
    expect(s.motions).toBe(1);
    expect(s.pos.x).toBeGreaterThan(0.5 + 0.4);
    expect(s.pos.y).toBeGreaterThan(-60);
    // other entities' motion is ignored
    conn.receive('set_entity_motion', { runtime_entity_id: 99n, velocity: { x: 5, y: 0, z: 0 }, tick: tagged });
    expect(loop.state.motions).toBe(1);
  });

  it('pure applyMotion: untagged motion replaces the current velocity', () => {
    const b = initialBody({ x: 0, y: 0, z: 0 }, true);
    const out = applyMotion([], b, 0n, { x: 1, y: 0.5, z: 0 }, { name: 'own', step: stepBody }, flatWorld());
    expect(out.state.vel).toEqual({ x: 1, y: 0.5, z: 0 });
    expect(out.state.onGround).toBe(true); // the first tick of the push still uses ground friction
    expect(out.replayed).toBe(0);
  });
});
