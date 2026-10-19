// Server corrections and teleports (pure functions over the input history).
//
// The server tags `correct_player_move_prediction` with the tick of the input it corrected. The client
// rewinds to that tick, takes the server's position / velocity / ground state, and re-simulates the
// inputs it sent after it (Mojang "Player movement overview"). `move_player` (teleport / reset) for
// the local player carries the last input tick the server had processed; the server takes the
// teleport state for the first input it processes afterwards without simulating it (bedboo-measured
// on BDS 1.26.51), and the client marks its next input with `handled_teleport`.
import type { CorrectPlayerMovePredictionPacket, MovePlayerPacket } from '../../connection/types.ts';
import { PHYSICS } from './physics.ts';
import type { BlockQuery, BodyState, MoveCommand, PhysicsEngine, Vec3 } from './types.ts';
import { cloneBody } from './types.ts';

/** One sent input and the body state after it. */
export interface HistoryEntry {
  tick: bigint;
  cmd: MoveCommand;
  state: BodyState;
  /** false = the input was sent without simulating (after a teleport, or the world was unknown). */
  simulated: boolean;
}

/** Server-side body state, feet position. */
export interface ServerState {
  tick: bigint;
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
}

export function serverStateFromCorrection(p: CorrectPlayerMovePredictionPacket): ServerState {
  return {
    tick: BigInt(p.tick),
    pos: { x: p.position.x, y: p.position.y - PHYSICS.eyeHeight, z: p.position.z },
    vel: { x: p.delta.x, y: p.delta.y, z: p.delta.z },
    onGround: p.on_ground,
  };
}

export function serverStateFromMovePlayer(p: MovePlayerPacket): ServerState {
  return {
    tick: BigInt(p.tick),
    pos: { x: p.position.x, y: p.position.y - PHYSICS.eyeHeight, z: p.position.z },
    vel: { x: 0, y: 0, z: 0 },
    onGround: p.on_ground,
  };
}

function adopt(base: BodyState, s: ServerState): BodyState {
  return {
    ...cloneBody(base),
    pos: { ...s.pos },
    vel: { ...s.vel },
    onGround: s.onGround,
    collidedVertically: s.onGround,
    collidedHorizontally: false,
  };
}

/** Re-simulate entries from index `from` on, each starting from the previous entry's state. */
function replay(entries: HistoryEntry[], from: number, engine: PhysicsEngine, world: BlockQuery): void {
  for (let i = from; i < entries.length; i++) {
    const e = entries[i]!;
    const prev = entries[i - 1]!.state;
    if (!e.simulated) {
      e.state = cloneBody(prev);
      continue;
    }
    const r = engine.step(prev, e.cmd, world);
    e.state = r.state;
  }
}

export interface CorrectionOutcome {
  /** Current body state after the rewind and replay. */
  state: BodyState;
  history: HistoryEntry[];
  /** Our predicted feet position for the corrected tick (before the correction), if still in the history. */
  predicted: Vec3 | undefined;
  /** Number of later inputs re-simulated. */
  replayed: number;
}

/**
 * Applies a correction. When the corrected tick is in the history, its state becomes the server's and
 * every later input is re-simulated; otherwise the server state is adopted as the current state.
 */
export function applyCorrection(
  history: readonly HistoryEntry[],
  current: BodyState,
  corr: ServerState,
  engine: PhysicsEngine,
  world: BlockQuery,
): CorrectionOutcome {
  const entries = history.map((e) => ({ ...e, state: cloneBody(e.state) }));
  const index = entries.findIndex((e) => e.tick === corr.tick);
  if (index < 0) {
    return { state: adopt(current, corr), history: [], predicted: undefined, replayed: 0 };
  }
  const entry = entries[index]!;
  const predicted = { ...entry.state.pos };
  entry.state = adopt(entry.state, corr);
  replay(entries, index + 1, engine, world);
  return { state: cloneBody(entries[entries.length - 1]!.state), history: entries, predicted, replayed: entries.length - 1 - index };
}

export interface TeleportOutcome {
  state: BodyState;
  history: HistoryEntry[];
  /** The next input must be sent without simulating (the server takes the teleport state for it). */
  skipNext: boolean;
  /** Inputs that were in flight when the server teleported (re-simulated from the target). */
  inFlight: number;
}

/**
 * Applies a teleport of the local player. Inputs sent after `tp.tick` were in flight: the first of
 * them is the one the server does not simulate, the rest are re-simulated from the target.
 */
export function applyTeleport(
  history: readonly HistoryEntry[],
  current: BodyState,
  tp: ServerState,
  engine: PhysicsEngine,
  world: BlockQuery,
): TeleportOutcome {
  const base: BodyState = { ...adopt(current, tp), vel: { x: 0, y: 0, z: 0 }, jumpTicks: 0 };
  const inFlight = tp.tick > 0n ? history.filter((e) => e.tick > tp.tick).map((e) => ({ ...e, state: cloneBody(e.state) })) : [];
  if (inFlight.length === 0) return { state: base, history: [], skipNext: true, inFlight: 0 };
  inFlight[0] = { ...inFlight[0]!, state: cloneBody(base), simulated: false };
  replay(inFlight, 1, engine, world);
  return { state: cloneBody(inFlight[inFlight.length - 1]!.state), history: inFlight, skipNext: false, inFlight: inFlight.length };
}
