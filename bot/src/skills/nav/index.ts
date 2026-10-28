export { findPath, locateNode, explainStart, handBreakTicks, PathSearch, DEFAULT_COSTS, MAX_JUMP_RISE } from './astar.ts';
export type { MoveKind, NodeActions, PathNode, PathCosts, PathOptions, PathResult, LocatedNode } from './astar.ts';
export { TICKS, steadySpeed, jumpAirTicks, fallTicks, dropCost } from './costs.ts';
export { breakBlocker, DEFAULT_THROWAWAY, FACE_OFFSET } from './actions.ts';
export type { NavActions, NavBlockFace, BreakRules } from './actions.ts';
export { NavGrid, cellKey, CROSS_CLEAR, CROSS_TOGGLE, CROSS_BLOCKED } from './grid.ts';
export type { Crossing } from './grid.ts';
export { goalTest, octile, localGround, threatsOf, DEFAULT_GET_TO_REACH } from './goals.ts';
export type { Goal, GoalTest, NavGoal, AnyGoal, GetToBlockGoal, YLevelGoal, RunAwayGoal, SurfaceGoal, Threat, GoalGrid } from './goals.ts'; // Track R: task 7.10 goals
export { NavBlacklist, goalKey, blockKey, actionKey } from './blacklist.ts'; // Track R
export type { BlacklistEntry, BlacklistOptions, ActionKind } from './blacklist.ts';
export { PathFollower, PressGuard, yawTowards, angleDiff, turnTowards } from './follower.ts';
export type { FollowerOptions, FollowerInput, FollowStep } from './follower.ts';
export { Navigator } from './navigator.ts';
export type { NavWorld, NavInventory, NavigatorOptions, NavGotoOptions, GotoReport, PlanRecord, ReplanReason } from './navigator.ts';
