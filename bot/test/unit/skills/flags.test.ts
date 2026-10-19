import { describe, expect, it } from 'vitest';
import { IDLE_COMMAND, buildAuthInput, buildInputFlags, initialBody, viewDirection, type BodyState, type MoveCommand } from '../../../src/skills/input/index.ts';

const cmd = (c: Partial<MoveCommand>): MoveCommand => ({ ...IDLE_COMMAND, ...c });
const body = (b: Partial<BodyState> = {}): BodyState => ({ ...initialBody({ x: 0.5, y: -60, z: 0.5 }, true), collidedVertically: true, ...b });

function flags(c: Partial<MoveCommand>, extra: { prevCmd?: Partial<MoveCommand>; state?: Partial<BodyState>; prevState?: Partial<BodyState>; jumped?: boolean; handledTeleport?: boolean } = {}): string[] {
  return buildInputFlags({
    cmd: cmd(c),
    prevCmd: extra.prevCmd ? cmd(extra.prevCmd) : undefined,
    state: body(extra.state),
    prevState: extra.prevState ? body(extra.prevState) : undefined,
    jumped: extra.jumped ?? false,
    handledTeleport: extra.handledTeleport ?? false,
  });
}

describe('buildInputFlags', () => {
  it('idle on the ground: only vertical_collision', () => {
    expect(flags({})).toEqual(['vertical_collision']);
  });

  it('move keys map to up / down / left / right', () => {
    expect(flags({ forward: 1 })).toContain('up');
    expect(flags({ forward: -1 })).toContain('down');
    expect(flags({ strafe: -1 })).toContain('left');
    expect(flags({ strafe: 1 })).toContain('right');
    expect(flags({ forward: 1, strafe: 1 })).toEqual(expect.arrayContaining(['up', 'right']));
  });

  it('jump: level flags while held, pressed / released edges, start_jumping on the jump tick', () => {
    const press = flags({ jump: true }, { jumped: true, state: { onGround: false, collidedVertically: false } });
    expect(press).toEqual(expect.arrayContaining(['jump_down', 'jumping', 'want_up', 'jump_current_raw', 'jump_pressed_raw', 'start_jumping']));
    expect(press).not.toContain('vertical_collision');
    const held = flags({ jump: true }, { prevCmd: { jump: true }, state: { onGround: false, collidedVertically: false } });
    expect(held).toEqual(['jump_down', 'jumping', 'want_up', 'jump_current_raw']);
    expect(flags({}, { prevCmd: { jump: true } })).toContain('jump_released_raw');
  });

  it('sprint and sneak: start / stop edges follow the body state', () => {
    const start = flags({ forward: 1, sprint: true }, { state: { sprinting: true }, prevState: { sprinting: false } });
    expect(start).toEqual(expect.arrayContaining(['sprint_down', 'sprinting', 'start_sprinting']));
    const stop = flags({ forward: 1 }, { state: { sprinting: false }, prevState: { sprinting: true } });
    expect(stop).toContain('stop_sprinting');
    expect(stop).not.toContain('sprinting');
    const sneak = flags({ sneak: true }, { state: { sneaking: true }, prevState: { sneaking: false } });
    expect(sneak).toEqual(expect.arrayContaining(['sneak_down', 'want_down', 'sneak_current_raw', 'sneak_pressed_raw', 'sneaking', 'start_sneaking']));
    expect(flags({}, { prevCmd: { sneak: true }, state: { sneaking: false }, prevState: { sneaking: true } })).toEqual(
      expect.arrayContaining(['sneak_released_raw', 'stop_sneaking']),
    );
  });

  it('collision flags and handled_teleport', () => {
    expect(flags({ forward: 1 }, { state: { collidedHorizontally: true } })).toContain('horizontal_collision');
    expect(flags({}, { state: { onGround: false, collidedVertically: false } })).toEqual([]);
    expect(flags({}, { handledTeleport: true })).toContain('handled_teleport');
  });
});

describe('buildAuthInput', () => {
  it('sends the eye position, the velocity as delta, the tick as BigInt and the 1.26.51 field set', () => {
    const state = body({ vel: { x: 0, y: -0.0784, z: 0.2 } });
    const p = buildAuthInput({ tick: 42n, cmd: cmd({ forward: 1, yaw: 90, pitch: 10 }), state, flags: ['up'] });
    expect(p.position).toEqual({ x: 0.5, y: Math.fround(-60 + 1.62), z: 0.5 });
    expect(p.tick).toBe(42n);
    expect(p.delta).toEqual({ x: 0, y: -0.0784, z: 0.2 });
    expect(p.move_vector).toEqual({ x: 0, z: 1 });
    expect(p.raw_move_vector).toEqual({ x: 0, z: 1 });
    expect(p.yaw).toBe(90);
    expect(p.head_yaw).toBe(90);
    expect(p.pitch).toBe(10);
    expect(p.interact_rotation).toEqual({ x: 10, z: 90 });
    expect(p.input_data).toEqual(['up']);
    expect(p.input_mode).toBe('mouse');
    expect(p.play_mode).toBe('normal');
    expect(p.interaction_model).toBe('crosshair');
    expect(p.camera_orientation.x).toBeCloseTo(-Math.cos((10 * Math.PI) / 180), 6);
  });

  it('reports no move vector when the tick was not simulated', () => {
    const p = buildAuthInput({ tick: 1n, cmd: cmd({ forward: 1 }), state: body(), flags: [], moving: false });
    expect(p.move_vector).toEqual({ x: 0, z: 0 });
    expect(p.raw_move_vector).toEqual({ x: 0, z: 0 });
  });

  it('viewDirection: yaw 0 looks +z, pitch 90 looks down', () => {
    const v = viewDirection(0, 0);
    expect(v.z).toBeCloseTo(1, 6);
    expect(viewDirection(0, 90).y).toBeCloseTo(-1, 6);
  });
});
