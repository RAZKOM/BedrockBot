// player_auth_input `input_data` flags and packet fields (pure functions).
// Flag names are minecraft-data bedrock 1.26.51 `InputData` (array of names on the wire).
import type { PlayerAuthInputPacket } from '../../connection/types.ts';
import { PHYSICS, moveVectorOf } from './physics.ts';
import type { BodyState, MoveCommand } from './types.ts';

/** What one tick's flags depend on. */
export interface FlagContext {
  cmd: MoveCommand;
  /** Previous tick's command (edges: *_pressed_raw, *_released_raw). */
  prevCmd: MoveCommand | undefined;
  /** Body after this tick's step (sprinting/sneaking state, collisions, ground). */
  state: BodyState;
  /** Body before this tick's step (start_/stop_ edges). */
  prevState: BodyState | undefined;
  /** The step jumped this tick. */
  jumped: boolean;
  /** First input after a move_player teleport. */
  handledTeleport: boolean;
}

/**
 * Builds `input_data` the way the vanilla client reports it. Level flags are sent every tick the
 * state holds; edge flags on the tick it changes:
 *
 * | state            | level flags                                        | edge flags                                   |
 * |------------------|----------------------------------------------------|----------------------------------------------|
 * | move keys        | up / down / left / right                           |                                              |
 * | jump key         | jump_down, jumping, want_up, jump_current_raw      | jump_pressed_raw, jump_released_raw          |
 * | jump performed   |                                                    | start_jumping (the tick it leaves the ground) |
 * | sprint key       | sprint_down                                        |                                              |
 * | sprinting        | sprinting                                          | start_sprinting, stop_sprinting              |
 * | sneak key        | sneak_down, want_down, sneak_current_raw           | sneak_pressed_raw, sneak_released_raw        |
 * | sneaking         | sneaking                                           | start_sneaking, stop_sneaking                |
 * | collisions       | vertical_collision (also while resting on ground), horizontal_collision |                     |
 * | teleport handled |                                                    | handled_teleport                             |
 */
export function buildInputFlags(ctx: FlagContext): string[] {
  const { cmd, state } = ctx;
  const prev = ctx.prevCmd;
  const flags: string[] = [];
  if (cmd.forward > 0) flags.push('up');
  if (cmd.forward < 0) flags.push('down');
  if (cmd.strafe < 0) flags.push('left');
  if (cmd.strafe > 0) flags.push('right');

  if (cmd.jump) flags.push('jump_down', 'jumping', 'want_up', 'jump_current_raw');
  if (cmd.jump && !prev?.jump) flags.push('jump_pressed_raw');
  if (!cmd.jump && prev?.jump) flags.push('jump_released_raw');
  if (ctx.jumped) flags.push('start_jumping');

  if (cmd.sprint) flags.push('sprint_down');
  if (state.sprinting) flags.push('sprinting');
  const wasSprinting = ctx.prevState?.sprinting ?? false;
  if (state.sprinting && !wasSprinting) flags.push('start_sprinting');
  if (!state.sprinting && wasSprinting) flags.push('stop_sprinting');

  if (cmd.sneak) flags.push('sneak_down', 'want_down', 'sneak_current_raw');
  if (state.sneaking) flags.push('sneaking');
  if (cmd.sneak && !prev?.sneak) flags.push('sneak_pressed_raw');
  if (!cmd.sneak && prev?.sneak) flags.push('sneak_released_raw');
  const wasSneaking = ctx.prevState?.sneaking ?? false;
  if (state.sneaking && !wasSneaking) flags.push('start_sneaking');
  if (!state.sneaking && wasSneaking) flags.push('stop_sneaking');

  // Track AU: the elytra glide. BDS 1.26.60 starts a glide only when `start_gliding` comes with a jump
  // press (the vanilla client presses jump in the air; measured on bds-fly: the flag alone is ignored,
  // player_action start_glide too), and confirms it with the `gliding` actor flag. `stop_gliding` on
  // the tick the glide ends (ground, water).
  const wasGliding = ctx.prevState?.gliding ?? false;
  if (state.gliding === true && !wasGliding) {
    for (const f of GLIDE_START_FLAGS) if (!flags.includes(f)) flags.push(f);
  }
  if (state.gliding !== true && wasGliding) flags.push('stop_gliding');

  if (state.collidedVertically || state.onGround) flags.push('vertical_collision');
  if (state.collidedHorizontally) flags.push('horizontal_collision');
  if (ctx.handledTeleport) flags.push('handled_teleport');
  return flags;
}

/** Track AU: what the tick that starts a glide carries (start_gliding plus the jump press BDS needs). */
export const GLIDE_START_FLAGS: readonly string[] = ['jump_down', 'jumping', 'want_up', 'jump_current_raw', 'jump_pressed_raw', 'start_gliding', 'start_jumping'];

/** Unit view vector for Bedrock yaw/pitch degrees (pitch +90 = down). */
export function viewDirection(yawDeg: number, pitchDeg: number): { x: number; y: number; z: number } {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp + 0, y: -Math.sin(pitch) + 0, z: Math.cos(yaw) * cp + 0 };
}

/** The full player_auth_input for one tick. `state.pos` is the feet; the packet carries the eye. */
export function buildAuthInput(opts: {
  tick: bigint;
  cmd: MoveCommand;
  state: BodyState;
  flags: string[];
  /** false when the tick was not simulated (unknown world): no move vector is reported. */
  moving?: boolean;
}): PlayerAuthInputPacket {
  const { cmd, state } = opts;
  const moving = opts.moving ?? true;
  const mv = moving ? moveVectorOf(cmd) : { x: 0, z: 0 };
  const raw = moving ? { x: Math.sign(-cmd.strafe) + 0, z: Math.sign(cmd.forward) + 0 } : { x: 0, z: 0 };
  const yaw = Math.fround(cmd.yaw);
  const pitch = Math.fround(cmd.pitch);
  return {
    pitch,
    yaw,
    position: { x: state.pos.x, y: Math.fround(state.pos.y + PHYSICS.eyeHeight), z: state.pos.z },
    move_vector: mv,
    head_yaw: yaw,
    input_data: opts.flags,
    input_mode: 'mouse',
    play_mode: 'normal',
    interaction_model: 'crosshair',
    interact_rotation: { x: pitch, z: yaw },
    tick: opts.tick,
    delta: { x: state.vel.x, y: state.vel.y, z: state.vel.z },
    analogue_move_vector: { x: 0, z: 0 },
    camera_orientation: viewDirection(cmd.yaw, cmd.pitch),
    raw_move_vector: raw,
  };
}
