// Bedrock sprint rules the server applies on its own (measured on BDS 1.26.51.1 by LiteLDev/bedboo,
// LGPL-3.0, packages/mineflayer-bedrock/lib/plugins/physics.js "U16a" and "FINAL-FIX-LIB"; rules
// ported, no code copied):
// - A sprint is sticky: once the player sprints (sprint key with forward held), BDS keeps the sprint
//   speed while forward is held, also after the sprint key is released and `stop_sprinting` is sent.
//   It ends when forward is released, on back or sneak, when the body was stopped by a wall on the
//   previous tick, or when sprinting is not possible (food 6 or less).
// - A double tap: forward pressed again within 6 ticks of its previous press (press to press) starts
//   a sprint, also without any sprint key or flag.
// Without predicting these the server ends up faster than the client and corrects it.
import type { BodyState, MoveCommand } from './types.ts';

/** Press-to-press ticks of the forward key that BDS treats as a double tap (6 sprints, 7 does not). */
export const DOUBLE_TAP_TICKS = 6;

export interface SprintTracker {
  sticky: boolean;
  /** Input count of the last forward press (rising edge), -Infinity if none. */
  lastForwardPress: number;
  prevForward: boolean;
  /** Inputs seen. */
  n: number;
}

export function newSprintTracker(): SprintTracker {
  return { sticky: false, lastForwardPress: -Infinity, prevForward: false, n: 0 };
}

/**
 * Advances the tracker by one input and returns whether the body sprints this tick. `prev` is the
 * body before the step (its horizontal collision ends a sprint). Pure apart from `t`.
 */
export function stepSprint(t: SprintTracker, cmd: MoveCommand, prev: BodyState, canSprint = true): boolean {
  t.n++;
  const forward = cmd.forward > 0;
  if (forward && !t.prevForward) {
    if (t.n - t.lastForwardPress <= DOUBLE_TAP_TICKS) t.sticky = true;
    t.lastForwardPress = t.n;
  }
  t.prevForward = forward;
  if (cmd.sprint && forward && !cmd.sneak) t.sticky = true;
  if (t.sticky && (!forward || cmd.sneak || prev.collidedHorizontally || !canSprint)) t.sticky = false;
  return t.sticky;
}

export function cloneSprint(t: SprintTracker): SprintTracker {
  return { ...t };
}
