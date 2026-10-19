import { describe, expect, it } from 'vitest';
import { IDLE_COMMAND, flatWorld, initialBody, moveVectorOf, stepBody, withBoxes, type BlockQuery, type BodyState, type MoveCommand } from '../../../src/skills/input/index.ts';

const FEET = { x: 0.5, y: -60, z: 0.5 };
const flat = flatWorld();

function run(world: BlockQuery, start: BodyState, cmds: MoveCommand[]): { states: BodyState[]; jumps: number[] } {
  const states: BodyState[] = [];
  const jumps: number[] = [];
  let s = start;
  cmds.forEach((c, i) => {
    const r = stepBody(s, c, world);
    expect(r.simulated).toBe(true);
    if (r.jumped) jumps.push(i);
    s = r.state;
    states.push(s);
  });
  return { states, jumps };
}

const cmd = (c: Partial<MoveCommand>): MoveCommand => ({ ...IDLE_COMMAND, ...c });
const repeat = (n: number, c: MoveCommand): MoveCommand[] => Array.from({ length: n }, () => c);
const grounded = (p = FEET): BodyState => initialBody(p, true);

describe('stepBody: ground', () => {
  it('standing still keeps the position; the end-of-tick velocity is (0, -0.0784, 0)', () => {
    const { states } = run(flat, grounded(), repeat(5, cmd({})));
    const last = states.at(-1)!;
    expect(last.pos).toEqual(FEET);
    expect(last.onGround).toBe(true);
    expect(last.collidedVertically).toBe(true);
    expect(last.vel.x).toBe(0);
    expect(last.vel.z).toBe(0);
    expect(last.vel.y).toBeCloseTo(-0.0784, 6);
  });

  it('walking forward at yaw 0 follows v += 0.098; z += v; v *= 0.546 (verify.mjs model)', () => {
    const { states } = run(flat, grounded(), repeat(30, cmd({ forward: 1 })));
    let v = 0;
    let z = FEET.z;
    for (const s of states) {
      v += 0.098;
      z += v;
      v *= 0.546;
      expect(s.pos.z).toBeCloseTo(z, 4);
      expect(s.pos.x).toBe(FEET.x);
      expect(s.pos.y).toBe(-60);
    }
    // terminal walking speed 0.098 / (1 - 0.546) = 0.2159 blocks/tick
    expect(states.at(-1)!.pos.z - states.at(-2)!.pos.z).toBeCloseTo(0.2159, 3);
  });

  it('yaw 90 walks towards -x, yaw -90 towards +x, strafe right at yaw 0 goes -x', () => {
    const west = run(flat, grounded(), repeat(10, cmd({ forward: 1, yaw: 90 }))).states.at(-1)!;
    expect(west.pos.x).toBeLessThan(FEET.x - 1);
    expect(west.pos.z).toBeCloseTo(FEET.z, 5);
    const east = run(flat, grounded(), repeat(10, cmd({ forward: 1, yaw: -90 }))).states.at(-1)!;
    expect(east.pos.x).toBeGreaterThan(FEET.x + 1);
    const right = run(flat, grounded(), repeat(10, cmd({ strafe: 1 }))).states.at(-1)!;
    expect(right.pos.x).toBeLessThan(FEET.x - 1);
    expect(right.pos.z).toBeCloseTo(FEET.z, 5);
  });

  it('sprinting is 1.3 x faster on the ground; sneaking 0.3 x', () => {
    const walk = run(flat, grounded(), repeat(40, cmd({ forward: 1 }))).states.at(-1)!.pos.z;
    const sprint = run(flat, grounded(), repeat(40, cmd({ forward: 1, sprint: true }))).states.at(-1)!.pos.z;
    const sneak = run(flat, grounded(), repeat(40, cmd({ forward: 1, sneak: true }))).states.at(-1)!.pos.z;
    expect((sprint - FEET.z) / (walk - FEET.z)).toBeCloseTo(1.3, 2);
    expect((sneak - FEET.z) / (walk - FEET.z)).toBeCloseTo(0.3, 2);
  });

  it('coasts to a stop after the key is released', () => {
    const { states } = run(flat, grounded(), [...repeat(20, cmd({ forward: 1 })), ...repeat(30, cmd({}))]);
    const last = states.at(-1)!;
    expect(Math.abs(last.vel.z)).toBeLessThan(1e-6);
    expect(last.pos.z - states[19]!.pos.z).toBeCloseTo(0.2159 * 0.546 / (1 - 0.546), 2);
  });
});

describe('stepBody: jumping and falling', () => {
  it('a jump leaves the ground once, peaks about 1.2522 above and lands after 12 ticks', () => {
    const { states, jumps } = run(flat, grounded(), [...repeat(3, cmd({ jump: true })), ...repeat(20, cmd({}))]);
    expect(jumps).toEqual([0]);
    expect(states[0]!.vel.y).toBeCloseTo((0.42 - 0.08) * 0.98, 5);
    const peak = Math.max(...states.map((s) => s.pos.y)) - FEET.y;
    expect(peak).toBeCloseTo(1.2522, 3);
    const landed = states.findIndex((s, i) => i > 0 && s.onGround);
    expect(landed).toBe(11);
    expect(states.at(-1)!.pos.y).toBe(-60);
  });

  it('holding jump re-jumps only after landing and the 10-tick cooldown', () => {
    const { jumps } = run(flat, grounded(), repeat(40, cmd({ jump: true })));
    expect(jumps.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < jumps.length; i++) expect(jumps[i]! - jumps[i - 1]!).toBeGreaterThanOrEqual(10);
  });

  it('falls with gravity 0.08 and drag 0.98 and lands on the first solid block below', () => {
    const start = initialBody({ x: 0.5, y: -57, z: 0.5 }, false);
    const { states } = run(flat, start, repeat(30, cmd({})));
    expect(states[0]!.pos.y).toBe(-57); // velocity 0 at the start of the first tick
    expect(states[0]!.vel.y).toBeCloseTo(-0.0784, 6);
    expect(states[1]!.pos.y).toBeCloseTo(-57.0784, 5);
    const landed = states.findIndex((s) => s.onGround);
    expect(landed).toBeGreaterThan(5);
    expect(states[landed]!.pos.y).toBe(-60);
    expect(states.at(-1)!.pos.y).toBe(-60);
  });

  it('walks off a 3-block ledge and lands', () => {
    const world = withBoxes(flat, [{ from: { x: 0, y: -60, z: 0 }, to: { x: 0, y: -58, z: 2 }, solid: true }]);
    const { states } = run(world, grounded({ x: 0.5, y: -57, z: 0.5 }), [...repeat(25, cmd({ forward: 1 })), ...repeat(20, cmd({}))]);
    const last = states.at(-1)!;
    expect(last.pos.y).toBe(-60);
    expect(last.pos.z).toBeGreaterThan(3.3);
    expect(last.onGround).toBe(true);
  });
});

describe('stepBody: collisions', () => {
  // a wall at z = 3 (blocks y -60 and -59)
  const wall = withBoxes(flat, [{ from: { x: -2, y: -60, z: 3 }, to: { x: 2, y: -59, z: 3 }, solid: true }]);

  it('stops at a wall with horizontal_collision and zero velocity into it', () => {
    const { states } = run(wall, grounded(), repeat(30, cmd({ forward: 1 })));
    const last = states.at(-1)!;
    expect(last.pos.z).toBeCloseTo(3 - 0.3, 5);
    expect(last.collidedHorizontally).toBe(true);
    expect(last.vel.z).toBe(0);
    expect(last.pos.y).toBe(-60);
  });

  it('auto-steps up 0.5625 but not a full block; a jump climbs a 1-block step', () => {
    const step = withBoxes(flat, [{ from: { x: -2, y: -60, z: 3 }, to: { x: 2, y: -60, z: 6 }, solid: true }]);
    const walk = run(step, grounded(), repeat(30, cmd({ forward: 1 }))).states.at(-1)!;
    expect(walk.pos.y).toBe(-60);
    expect(walk.pos.z).toBeCloseTo(2.7, 5);
    const jump = run(step, grounded(), repeat(30, cmd({ forward: 1, jump: true }))).states;
    expect(jump.some((s) => s.onGround && s.pos.y === -59)).toBe(true);
  });

  it('does not simulate when the world around is unknown', () => {
    const unknown: BlockQuery = { solidAt: () => undefined };
    const s = grounded();
    const r = stepBody(s, cmd({ forward: 1 }), unknown);
    expect(r.simulated).toBe(false);
    expect(r.state).toEqual(s);
  });
});

describe('moveVectorOf', () => {
  it('maps forward/strafe to Bedrock move_vector (x = left, z = forward), normalized, sneak x 0.3', () => {
    expect(moveVectorOf({ forward: 1, strafe: 0, sneak: false })).toEqual({ x: 0, z: 1 });
    expect(moveVectorOf({ forward: 0, strafe: 1, sneak: false })).toEqual({ x: -1, z: 0 });
    const diag = moveVectorOf({ forward: 1, strafe: -1, sneak: false });
    expect(diag.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(diag.z).toBeCloseTo(Math.SQRT1_2, 6);
    expect(moveVectorOf({ forward: 1, strafe: 0, sneak: true }).z).toBeCloseTo(0.3, 6);
  });
});
