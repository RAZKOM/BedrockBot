// Move costs in ticks (Navigation v2, PLAN.md task 7.1), derived from the movement model's constants
// (input/physics.ts) the way Baritone derives its Java costs:
//
//   walk    1 / steady walking speed   = 1 / (0.1 x 0.98 / (1 - 0.546))  = 4.633 ticks per block
//   sprint  1 / steady sprinting speed = 1 / (0.13 x 0.98 / (1 - 0.546)) = 3.564 ticks per block
//   jump    air time of a standing jump from take-off to landing one block higher: 9 ticks for a
//           cardinal one-block climb (measured: 9.0 ticks per step on a staircase)
//   fall n  ticks to fall n blocks from rest (gravity 0.08, drag 0.98): 1 -> 5, 2 -> 7, 3 -> 9
//
// Measured on bds-move (docs/pathfinding.md): walking and sprinting match the steady speeds once up
// to speed; the follower's edge creep and landing are what `landing` pays for.
import { PHYSICS } from '../input/physics.ts';

/** Steady ground speed (blocks per tick) on default ground: impulse / (1 - inertia). */
export function steadySpeed(sprint: boolean): number {
  const inertia = PHYSICS.groundFriction * PHYSICS.airInertia;
  const accel = PHYSICS.walkSpeed * (sprint ? PHYSICS.sprintMultiplier : 1) * (PHYSICS.groundAccelFactor / inertia ** 3);
  return (accel * PHYSICS.impulseScale) / (1 - inertia);
}

/** Ticks from a standing jump until the body lands `rise` blocks higher (Infinity above the apex). */
export function jumpAirTicks(rise = 1): number {
  let y = 0;
  let v = PHYSICS.jumpVelocity;
  for (let t = 1; t < 100; t++) {
    const next = y + v;
    if (v < 0 && next <= rise) return t;
    y = next;
    v = (v - PHYSICS.gravity) * PHYSICS.drag;
  }
  return Infinity;
}

/** Ticks to fall `blocks` from rest (the first airborne tick already moves by gravity x drag). */
export function fallTicks(blocks: number): number {
  if (blocks <= 0) return 0;
  let y = 0;
  let v = 0;
  for (let t = 1; t < 400; t++) {
    v = (v - PHYSICS.gravity) * PHYSICS.drag;
    y += v;
    if (-y >= blocks - 1e-9) return t;
  }
  return Infinity;
}

/** Tick constants of the movement model. */
export const TICKS = Object.freeze({
  walk: 1 / steadySpeed(false),
  sprint: 1 / steadySpeed(true),
  jumpAir: jumpAirTicks(1),
  /** fall[n] = ticks to fall n blocks, n = 0..16. */
  fall: Object.freeze(Array.from({ length: 17 }, (_, n) => fallTicks(n))),
});

export interface PathCosts {
  /**
   * Ticks per block on flat ground. The navigator sets the sprint rate (3.564) when sprinting is
   * allowed and the walking rate (4.633) otherwise. Also the heuristic's per-block factor.
   */
  walk: number;
  /** Ticks for a cardinal one-block climb (jump). */
  jump: number;
  /** Extra ticks for walking a stairs block up or down (two 0.5 steps) on top of `walk`. */
  stairs: number;
  /** fall[n]: ticks to fall n blocks. */
  fall: readonly number[];
  /** Extra ticks per drop: creeping to the edge, landing. */
  landing: number;
  /** Highest fall the planner takes (blocks; 3 = no fall damage). */
  maxDrop: number;
  /** Surface preference: extra ticks per node with a solid block anywhere above the head. */
  underground: number;
  /** Extra ticks for a drop the move set cannot climb back (more than a jump, 1.25 blocks). */
  irreversibleDrop: number;
  /** Ticks per broken block on top of its break time (stop, aim, the 5-tick break cooldown). */
  dig: number;
  /** Ticks per placed block (pillar-up) on top of the jump. */
  place: number;
  /** Track BC: extra ticks per dig-down move (the stance over the block, the drop into its cell, settling) on top of fall[1] and the break. */
  digDown: number;
  /** Track BC: ticks per block walked sneaking (into, through and out of a cell the body only fits sneaking): walk / sneakScale. */
  sneakWalk: number;
  /** Ticks to open a door or fence gate (stop, use, wait for the state). */
  door: number;
  // Track AJ: movement variety (docs/pathfinding.md "Movement variety", measured on bds-move)
  /** Ticks per block swimming on the surface (forward + jump held). */
  swim: number;
  /** Extra ticks for getting into water (a preference for dry paths). */
  swimEnter: number;
  /** Ticks to climb out of the water onto a bank up to 1 block higher. */
  swimOut: number;
  /** Ticks per block climbing a ladder / vine up (0.2 blocks per tick). */
  climbUp: number;
  /** Ticks per block sliding down a ladder / vine (0.2 blocks per tick). */
  climbDown: number;
  /** Extra ticks for getting onto a ladder from its side or its top (settling in the column). */
  climbEnter: number;
  /** Extra ticks for getting off a ladder onto a floor beside it. */
  climbExit: number;
  /** Air ticks of a parkour jump landing at the same height / 1 lower (on top of the gap's walk ticks). */
  parkourAir: number;
  parkourAirDown: number;
  /** Extra ticks of a 2-block parkour for the run-up (backing up 2 blocks when the body arrives without speed). */
  parkourRunUp: number;
  /** Extra ticks per parkour jump (a preference for walking around). */
  parkourRisk: number;
}

/** Defaults (ticks). `walk` is the sprint rate; Navigator.goto uses TICKS.walk when sprint is off. */
export const DEFAULT_COSTS: Readonly<PathCosts> = Object.freeze({
  walk: TICKS.sprint,
  jump: TICKS.jumpAir,
  stairs: 1,
  fall: TICKS.fall,
  landing: 2,
  maxDrop: 3,
  underground: 6,
  irreversibleDrop: 30,
  dig: 12,
  place: 10,
  digDown: 6, // Track BC: bds-bari cave course, 11 shaft blocks in about 250 ticks = 23 per block with the 15-tick dirt break: about 8 of stance and drop against the planned fall[1] 5 + 6
  sneakWalk: TICKS.walk / PHYSICS.sneakScale, // Track BC: 15.44 (Baritone SNEAK_ONE_BLOCK_COST 15.385)
  door: 10,
  // Track AJ (measured on bds-move, docs/pathfinding.md "Movement variety")
  swim: 8.6,
  swimEnter: 10,
  swimOut: 14,
  climbUp: 5,
  climbDown: 5,
  climbEnter: 8,
  climbExit: 8,
  parkourAir: 12,
  parkourAirDown: 14,
  parkourRunUp: 12,
  parkourRisk: 10,
});

/** Ticks for a drop of `blocks` (walk off one block, fall, land). */
export function dropCost(c: PathCosts, blocks: number): number {
  const n = Math.max(0, Math.ceil(blocks - 1e-6));
  const fall = c.fall[n] ?? fallTicks(n);
  return c.walk + fall + c.landing;
}
