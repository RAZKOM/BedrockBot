// Input loop and movement model types (PLAN.md section 4.3, task 3.1).
import type { Vec3 } from '../../connection/types.ts';

export type { Vec3 };

/**
 * The minimum the movement model needs from a world model: is the block at integer (x, y, z) a full
 * solid cube? `undefined` = not known (chunk not loaded); the loop then does not simulate.
 * Track B's `World` (PLAN.md 4.2) can be adapted with `p => world.blockAt(p)?.solid`.
 */
export interface BlockQuery {
  solidAt(x: number, y: number, z: number): boolean | undefined;
  /**
   * Optional: the block's collision boxes in block-local coordinates ([minX, minY, minZ, maxX, maxY,
   * maxZ], y may reach 1.5 for fences and walls); `undefined` = unknown. When present it replaces
   * `solidAt` for collisions (slabs, stairs, carpets, snow layers ...). See skills/terrain.
   */
  boxesAt?(x: number, y: number, z: number): readonly (readonly number[])[] | undefined;
  /** Optional: ground slipperiness of the block (default 0.6; ice 0.98, slime 0.8). */
  frictionAt?(x: number, y: number, z: number): number | undefined;
  /** Optional: the liquid in the block (`null` = none, `undefined` = unknown) and its surface height. */
  liquidAt?(x: number, y: number, z: number): LiquidCell | null | undefined;
  /** Track AJ, optional: the block is climbable (ladder, vine ...; see physics.ts CLIMB). */
  climbableAt?(x: number, y: number, z: number): boolean | undefined;
}

export interface LiquidCell {
  liquid: 'water' | 'lava';
  /** Surface height inside the block: 8/9 for a source, 1 for falling liquid. */
  height: number;
}

/**
 * Desired motion for the next tick(s). Held until changed.
 * - `forward`: -1..1 (+1 = walk where the yaw points)
 * - `strafe`: -1..1 (+1 = to the right of the yaw, -1 = to the left)
 * - `yaw`: Bedrock degrees, 0 = +z (south), 90 = -x (west), -90 / 270 = +x (east), 180 = -z (north)
 * - `pitch`: Bedrock degrees, +90 = straight down, -90 = straight up
 * - `jump`: the jump key is held (the body jumps when it is on the ground and the cooldown allows)
 * - `sneak`, `sprint`: the keys are held
 * - `glide` (Track AU): the elytra glide is wanted; the body glides from the first airborne tick on
 *   (`start_gliding` with a jump press goes out) until it touches the ground or water
 * - `boostStart` (Track AU): a firework rocket was used before this tick: the glide boost runs for
 *   this many ticks from this tick on (recorded in the history so replays reproduce it)
 */
export interface MoveCommand {
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
  glide?: boolean;
  boostStart?: number;
}

export const IDLE_COMMAND: Readonly<MoveCommand> = Object.freeze({
  forward: 0,
  strafe: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  sneak: false,
  sprint: false,
});

/** Simulated player body. `pos` is the FEET position; the wire carries the eye (feet + 1.62). */
export interface BodyState {
  pos: Vec3;
  /** Velocity at the end of the tick, blocks per tick (this is what `player_auth_input.delta` reports). */
  vel: Vec3;
  onGround: boolean;
  collidedHorizontally: boolean;
  collidedVertically: boolean;
  /** Jump cooldown: ticks until the held jump key can jump again (10 after a jump, reset on release). */
  jumpTicks: number;
  sprinting: boolean;
  sneaking: boolean;
  /** The body touched water (lava) at the start of the last tick. Optional for older callers. */
  inWater?: boolean;
  inLava?: boolean;
  /** Track AU: the body glides with the elytra (physics.ts GLIDE); ends on ground or water contact. */
  gliding?: boolean;
  /** Track AU: firework boost ticks left (0 = none). */
  boostTicks?: number;
}

export interface StepResult {
  state: BodyState;
  /** The body left the ground this tick (`start_jumping`). */
  jumped: boolean;
  /** false = the world around the body is unknown; `state` is the previous state unchanged. */
  simulated: boolean;
}

/** A movement model. Pure: must not mutate `prev`. */
export interface PhysicsEngine {
  readonly name: string;
  step(prev: BodyState, cmd: MoveCommand, world: BlockQuery): StepResult;
}

export function initialBody(feet: Vec3, onGround = false): BodyState {
  return {
    pos: { ...feet },
    vel: { x: 0, y: 0, z: 0 },
    onGround,
    collidedHorizontally: false,
    collidedVertically: false,
    jumpTicks: 0,
    sprinting: false,
    sneaking: false,
  };
}

export function cloneBody(s: BodyState): BodyState {
  return { ...s, pos: { ...s.pos }, vel: { ...s.vel } };
}
