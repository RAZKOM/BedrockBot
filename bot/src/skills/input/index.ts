export { InputLoop } from './inputLoop.ts';
export type {
  InputConnection,
  InputLoopOptions,
  InputLoopEvent,
  InputLoopState,
  CorrectionEvent,
  TeleportEvent,
  ReadyEvent,
  MotionEvent,
  GlideEvent,
  SetEntityMotionPacket,
} from './inputLoop.ts';
export { PHYSICS, LIQUID, CLIMB, GLIDE, ownEngine, stepBody, moveBody, moveVectorOf, playerBox, solidBoxes, yawSinCos, groundFriction, liquidContact, onClimbable, backOffFromEdge, glideVelocity, lookVector, boostTicksExpected, wallImpactDamage, glideFallStep } from './physics.ts'; // Track AJ: CLIMB, onClimbable, backOffFromEdge; Track AU: GLIDE, glideVelocity, lookVector; Track F0: boostTicksExpected, wallImpactDamage, glideFallStep
export type { Box, MoveResult } from './physics.ts';
export { buildInputFlags, buildAuthInput, viewDirection, GLIDE_START_FLAGS } from './flags.ts'; // Track AU: GLIDE_START_FLAGS
export type { FlagContext } from './flags.ts';
export { applyCorrection, applyMotion, applyTeleport, serverStateFromCorrection, serverStateFromMovePlayer } from './history.ts';
export type { HistoryEntry, ServerState, CorrectionOutcome, TeleportOutcome, MotionOutcome } from './history.ts';
export { DOUBLE_TAP_TICKS, newSprintTracker, stepSprint } from './sprint.ts';
export type { SprintTracker } from './sprint.ts';
export { flatWorld, withBoxes } from './world.ts';
export type { BlockBox } from './world.ts';
export { IDLE_COMMAND, initialBody, cloneBody } from './types.ts';
export type { BlockQuery, LiquidCell, MoveCommand, BodyState, StepResult, PhysicsEngine, Vec3 } from './types.ts';
