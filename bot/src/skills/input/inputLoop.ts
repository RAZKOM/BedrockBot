// InputLoop (PLAN.md task 3.1): every tick of the Connection's 20 Hz driver, steps the movement
// model with the current MoveCommand and queues one `player_auth_input`. Handles the server's
// `correct_player_move_prediction` (rewind + replay) and `move_player` teleports of the local player
// (adopt, `handled_teleport` on the next input).
import type {
  CorrectPlayerMovePredictionPacket,
  MovePlayerPacket,
  PlayerAuthInputPacket,
  RespawnPacket,
} from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { buildAuthInput, buildInputFlags } from './flags.ts';
import {
  applyCorrection,
  applyTeleport,
  serverStateFromCorrection,
  serverStateFromMovePlayer,
  type HistoryEntry,
} from './history.ts';
import { PHYSICS, ownEngine } from './physics.ts';
import type { BlockQuery, BodyState, MoveCommand, PhysicsEngine, Vec3 } from './types.ts';
import { IDLE_COMMAND, cloneBody, initialBody } from './types.ts';

/** The part of `Connection` the loop uses (a seam for unit tests). `Connection` satisfies it. */
export interface InputConnection {
  readonly runtimeId: bigint;
  readonly spawnPosition: Vec3 | undefined;
  on(name: 'move_player', fn: (p: MovePlayerPacket) => void): () => void;
  on(name: 'correct_player_move_prediction', fn: (p: CorrectPlayerMovePredictionPacket) => void): () => void;
  on(name: 'respawn', fn: (p: RespawnPacket) => void): () => void;
  queue(name: 'player_auth_input', p: PlayerAuthInputPacket): void;
  onTick(fn: (tick: bigint) => void): () => void;
  onSpawn(fn: () => void): () => void;
}

export interface InputLoopOptions {
  world: BlockQuery;
  /** Movement model; default the own engine (physics.ts). */
  engine?: PhysicsEngine;
  logger?: Logger;
  /** Inputs kept for rewinds. Default 200 (10 s). */
  historySize?: number;
}

export interface CorrectionEvent {
  kind: 'correction';
  /** Tick of the corrected input. */
  tick: bigint;
  /** Our tick when it arrived. */
  receivedAt: bigint;
  /** Our predicted feet position for that tick (undefined when older than the history). */
  local: Vec3 | undefined;
  /** Server feet position. */
  server: Vec3;
  delta: Vec3;
  onGround: boolean;
  /** Distance local -> server, blocks. */
  error: number | undefined;
  replayed: number;
  /** Corrections so far, this one included. */
  count: number;
}

export interface TeleportEvent {
  kind: 'teleport';
  tick: bigint;
  mode: MovePlayerPacket['mode'];
  /** Feet position. */
  to: Vec3;
  inFlight: number;
}

export interface ReadyEvent {
  kind: 'ready';
  feet: Vec3;
}

export type InputLoopEvent = CorrectionEvent | TeleportEvent | ReadyEvent;

export interface InputLoopState {
  /** Feet position. */
  pos: Vec3;
  /** End-of-tick velocity, blocks per tick. */
  vel: Vec3;
  onGround: boolean;
  collidedHorizontally: boolean;
  collidedVertically: boolean;
  /** Corrections received since construction. */
  corrections: number;
  teleports: number;
  /** Tick of the last input sent. */
  tick: bigint;
  /** A position is known and inputs are being sent. */
  ready: boolean;
}

export class InputLoop {
  world: BlockQuery;
  /** Movement model; may be swapped between runs (the physics spike does). */
  engine: PhysicsEngine;
  private readonly conn: InputConnection;
  private readonly log: Logger;
  private readonly historySize: number;
  private cmd: MoveCommand = { ...IDLE_COMMAND };
  private prevCmd: MoveCommand | undefined;
  private body: BodyState = initialBody({ x: 0, y: 0, z: 0 });
  private history: HistoryEntry[] = [];
  private ready = false;
  private skipNext = false;
  private handledTeleport = false;
  private corrections = 0;
  private teleports = 0;
  private lastTick = 0n;
  private unsubscribers: (() => void)[] = [];
  private readonly listeners = new Set<(e: InputLoopEvent) => void>();
  private readonly tickWaiters = new Set<{ until: bigint; resolve: () => void }>();

  constructor(conn: InputConnection, opts: InputLoopOptions) {
    this.conn = conn;
    this.world = opts.world;
    this.engine = opts.engine ?? ownEngine;
    this.log = opts.logger ?? silentLogger;
    this.historySize = opts.historySize ?? 200;
  }

  /** Subscribe to the connection. Call before `connect()` so the spawn is seen. */
  start(): void {
    if (this.unsubscribers.length) return;
    this.unsubscribers.push(
      this.conn.onSpawn(() => {
        const eye = this.conn.spawnPosition;
        if (eye) this.reset({ x: eye.x, y: eye.y - PHYSICS.eyeHeight, z: eye.z });
      }),
      this.conn.on('respawn', (p) => {
        if (p.state === 1) this.reset({ x: p.position.x, y: p.position.y - PHYSICS.eyeHeight, z: p.position.z });
      }),
      this.conn.on('move_player', (p) => {
        this.onMovePlayer(p);
      }),
      this.conn.on('correct_player_move_prediction', (p) => {
        this.onCorrection(p);
      }),
      this.conn.onTick((tick) => {
        this.onTick(tick);
      }),
    );
    // Already spawned (loop created late): start from the spawn point.
    const eye = this.conn.spawnPosition;
    if (eye && !this.ready) this.reset({ x: eye.x, y: eye.y - PHYSICS.eyeHeight, z: eye.z });
  }

  stop(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  get state(): InputLoopState {
    const b = this.body;
    return {
      pos: { ...b.pos },
      vel: { ...b.vel },
      onGround: b.onGround,
      collidedHorizontally: b.collidedHorizontally,
      collidedVertically: b.collidedVertically,
      corrections: this.corrections,
      teleports: this.teleports,
      tick: this.lastTick,
      ready: this.ready,
    };
  }

  get command(): Readonly<MoveCommand> {
    return { ...this.cmd };
  }

  /** Change the desired motion from the next tick on (unspecified fields keep their value). */
  setCommand(c: Partial<MoveCommand>): void {
    this.cmd = { ...this.cmd, ...c };
  }

  /** Release all movement keys (keeps yaw and pitch). */
  release(): void {
    this.setCommand({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false });
  }

  onEvent(fn: (e: InputLoopEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Resolves after `n` more inputs have been sent. */
  waitTicks(n: number): Promise<void> {
    return new Promise((resolve) => {
      this.tickWaiters.add({ until: this.lastTick + BigInt(n), resolve });
    });
  }

  /**
   * Debug / test hook: shift the local position without any input that would explain it (the server
   * should correct it). Never used by skills.
   */
  nudge(d: Vec3): void {
    this.body = { ...cloneBody(this.body), pos: { x: this.body.pos.x + d.x, y: this.body.pos.y + d.y, z: this.body.pos.z + d.z } };
  }

  // ---- internals ------------------------------------------------------------------------------

  private emit(e: InputLoopEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch (err) {
        this.log.error(`input loop listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private reset(feet: Vec3): void {
    this.body = initialBody(feet);
    this.history = [];
    this.prevCmd = undefined;
    this.skipNext = false;
    this.handledTeleport = false;
    this.ready = true;
    this.log.debug(`input loop ready at feet ${fmt(feet)}`);
    this.emit({ kind: 'ready', feet: { ...feet } });
  }

  private onTick(tick: bigint): void {
    if (!this.ready) return;
    const cmd = { ...this.cmd };
    const prev = this.body;
    let state: BodyState;
    let jumped = false;
    let simulated = false;
    let moving = true;
    if (this.skipNext) {
      // first input after a teleport: the server takes the teleport state without simulating it
      this.skipNext = false;
      state = cloneBody(prev);
    } else {
      const r = this.engine.step(prev, cmd, this.world);
      state = r.state;
      jumped = r.jumped;
      simulated = r.simulated;
      moving = r.simulated;
    }
    const sentCmd = moving ? cmd : { ...IDLE_COMMAND, yaw: cmd.yaw, pitch: cmd.pitch };
    const flags = buildInputFlags({
      cmd: sentCmd,
      prevCmd: this.prevCmd,
      state,
      prevState: prev,
      jumped,
      handledTeleport: this.handledTeleport,
    });
    this.handledTeleport = false;
    this.conn.queue('player_auth_input', buildAuthInput({ tick, cmd: sentCmd, state, flags, moving }));

    this.history.push({ tick, cmd: sentCmd, state: cloneBody(state), simulated });
    if (this.history.length > this.historySize) this.history.splice(0, this.history.length - this.historySize);
    this.prevCmd = sentCmd;
    this.body = state;
    this.lastTick = tick;
    for (const w of [...this.tickWaiters]) {
      if (tick >= w.until) {
        this.tickWaiters.delete(w);
        w.resolve();
      }
    }
  }

  private onCorrection(p: CorrectPlayerMovePredictionPacket): void {
    if (p.prediction_type !== 'player' || !this.ready) return;
    const server = serverStateFromCorrection(p);
    const out = applyCorrection(this.history, this.body, server, this.engine, this.world);
    this.body = out.state;
    this.history = out.history;
    this.corrections++;
    const error = out.predicted ? dist(out.predicted, server.pos) : undefined;
    this.log.info(
      `correction #${this.corrections} for tick ${server.tick} (now ${this.lastTick}): local ${out.predicted ? fmt(out.predicted) : '?'} server ${fmt(server.pos)} ` +
        `error ${error?.toFixed(4) ?? '?'} delta ${fmt(server.vel)} onGround ${server.onGround} replayed ${out.replayed}`,
    );
    this.emit({
      kind: 'correction',
      tick: server.tick,
      receivedAt: this.lastTick,
      local: out.predicted,
      server: server.pos,
      delta: server.vel,
      onGround: server.onGround,
      error,
      replayed: out.replayed,
      count: this.corrections,
    });
  }

  private onMovePlayer(p: MovePlayerPacket): void {
    if (BigInt(p.runtime_id) !== this.conn.runtimeId) return;
    this.cmd = { ...this.cmd, yaw: p.yaw, pitch: p.pitch };
    if (p.mode === 'rotation') return;
    const tp = serverStateFromMovePlayer(p);
    const out = applyTeleport(this.history, this.body, tp, this.engine, this.world);
    this.body = out.state;
    this.history = out.history;
    this.skipNext = out.skipNext;
    if (p.mode === 'teleport' || p.mode === 'reset') this.handledTeleport = true;
    this.teleports++;
    if (!this.ready) {
      this.ready = true;
      this.emit({ kind: 'ready', feet: { ...tp.pos } });
    }
    this.log.info(`teleport (${p.mode}) to feet ${fmt(tp.pos)} at server tick ${tp.tick}; in flight ${out.inFlight}`);
    this.emit({ kind: 'teleport', tick: tp.tick, mode: p.mode, to: { ...tp.pos }, inFlight: out.inFlight });
  }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function fmt(v: Vec3): string {
  return `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
}
