// RL bridge (PLAN.md task 6.2): WebSocket server, message schema (4.5), observation builder, action
// executor (action space v1), episode bookkeeping. See docs/rl.md.
export * from './schema.ts';
export { ActionExecutor, ACTION_TICK_CAP, NOOP_TICKS, TURN_DEG, GOTO_RADIUS, COLLECT_RADIUS, raycast, viewVector, isDigTarget } from './actions.ts';
export type { ActionLoop, ActionSkills, ActionResult } from './actions.ts';
export { collectDrops, dropsNear } from './collect.ts';
export { CommandClient, TruthTimeoutError } from './commands.ts';
export { Episode, DEFAULT_LIMITS } from './episode.ts';
export type { EpisodeLimits, StepOutcome, EndReason } from './episode.ts';
export { buildObservation, buildGrid, blockClass, nearestLog, inventoryCounts, logCount, isLogItem, normYaw, LOG_SEARCH_RADIUS } from './observation.ts';
export type { ObsWorld, ObsBody, NearestLog } from './observation.ts';
export { RlSession } from './session.ts';
export type { SessionDeps, SessionOptions, ResetRequest } from './session.ts';
export { BridgeServer } from './server.ts';
export type { BridgeOptions } from './server.ts';
export { WsServer, WsConnection, FrameDecoder, encodeFrame, acceptKey } from './ws.ts';
