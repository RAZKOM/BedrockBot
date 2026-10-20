// Digging (PLAN.md Phase 4 tasks 4.1 and 4.2); see docs/digging.md.
export { Digger, BREAK_COOLDOWN_TICKS, TIMEOUT_FACTOR, MIN_TIMEOUT_SLACK } from './digger.ts';
export type { DigLoop, DigWorld, DigOptions, DigResult, SlotSelector } from './digger.ts';
export { estimateBreak, breakTicks, canHarvest, isEffective, MODIFIERS } from './breakTime.ts';
export type { BreakConditions, BreakEstimate } from './breakTime.ts';
export { chooseTool, HOTBAR_SIZE } from './tools.ts';
export type { ToolChoice, SlotItem } from './tools.ts';
export {
  FACE,
  EYE_HEIGHT,
  DEFAULT_REACH,
  DEFAULT_PICK_SCALAR,
  SERVER_PICK_BASE,
  lookAngles,
  blockCenter,
  faceToward,
  distanceToBlock,
  serverReachDistance,
  checkReach,
} from './look.ts';
export type { Face, ReachCheck } from './look.ts';
