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
  applyMotion,
  applyTeleport,
  serverStateFromCorrection,
  serverStateFromMovePlayer,
  type HistoryEntry,
} from './history.ts';
import { GLIDE, PHYSICS, ownEngine } from './physics.ts';
import { newSprintTracker, stepSprint } from './sprint.ts';
import type { BlockQuery, BodyState, MoveCommand, PhysicsEngine, Vec3 } from './types.ts';
import { IDLE_COMMAND, cloneBody, initialBody } from './types.ts';

/**
 * `set_entity_motion` (minecraft-data 1.26.51): velocity in blocks per tick, `tick` = the input tick
 * the server applied it after (0 when not tied to an input). Not in connection/types.ts yet.
 */
export interface SetEntityMotionPacket {
  runtime_entity_id: bigint | number;
  velocity: Vec3;
  tick?: bigint | number;
}

interface UntypedOn {
  on(name: string, fn: (p: unknown) => void): () => void;
}

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
  /** Whether sprinting is possible (survival: food above 6). Default always. */
  canSprint?: () => boolean;
  /** Track AU: whether a glide is possible (an elytra in the chest slot). Default never. */
  canGlide?: () => boolean;
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

/** `set_entity_motion` for the own player (knockback, explosions, /damage pushes). */
export interface MotionEvent {
  kind: 'motion';
  /** Tick the server tied it to (0 = none). */
  tick: bigint;
  velocity: Vec3;
  /** Later inputs re-simulated from the new velocity. */
  replayed: number;
}

/** Track AU: the server's `gliding` actor flag for the own player (confirms or ends a glide). */
export interface GlideEvent {
  kind: 'glide';
  gliding: boolean;
  /** The server's tick on the packet (0 = none). */
  tick: bigint;
  /** Inputs re-simulated without the glide when the server ended one we still predicted. */
  replayed: number;
}

export type InputLoopEvent = CorrectionEvent | TeleportEvent | ReadyEvent | MotionEvent | GlideEvent;

/** See `InputLoop.setTickExtras`. */
export type TickExtrasProvider = (tick: bigint) => Partial<PlayerAuthInputPacket> | undefined;

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
  /** `set_entity_motion` packets applied since construction. */
  motions: number;
  /** The body sprinted on the last tick (sprint key, sticky sprint or a double-tapped forward). */
  sprinting: boolean;
  /** The body touched water / lava on the last tick. */
  inWater: boolean;
  inLava: boolean;
  /** Track AU: the body glides (elytra); boost ticks of a firework rocket left. */
  gliding: boolean;
  boostTicks: number;
  /**
   * Track BH: the server holds the own player in the crawl / swim pose out of water (its `crawling` or
   * `swimming` actor flag, or a bounding box under 1 block high, not gliding): a glide that ended under less
   * than 1.8 of headroom leaves the body there (skills/fly/prone.ts digs it free).
   */
  prone?: boolean;
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
  private readonly canSprint: () => boolean;
  private readonly canGlide: () => boolean;
  /** Track AU: a rocket was used since the last input: the next input carries boostStart. */
  private pendingBoost: number | undefined;
  /** Track AU: the tick of the input that carried start_gliding, until the server's flag confirms it. */
  private glideRequestTick: bigint | undefined;
  private sprint = newSprintTracker();
  private cmd: MoveCommand = { ...IDLE_COMMAND };
  private prevCmd: MoveCommand | undefined;
  private body: BodyState = initialBody({ x: 0, y: 0, z: 0 });
  private history: HistoryEntry[] = [];
  private ready = false;
  private skipNext = false;
  private handledTeleport = false;
  private corrections = 0;
  private motions = 0;
  private teleports = 0;
  private lastTick = 0n;
  private unsubscribers: (() => void)[] = [];
  private readonly listeners = new Set<(e: InputLoopEvent) => void>();
  private readonly tickWaiters = new Set<{ until: bigint; resolve: () => void }>();
  private readonly beforeStep = new Set<(tick: bigint, state: InputLoopState) => void>();
  private tickExtras: TickExtrasProvider | undefined;
  /** Track AK: the body-pose slot (sleeping), separate from the tick-extras slot digging uses. */
  private pose: TickExtrasProvider | undefined;

  constructor(conn: InputConnection, opts: InputLoopOptions) {
    this.conn = conn;
    this.world = opts.world;
    this.engine = opts.engine ?? ownEngine;
    this.log = opts.logger ?? silentLogger;
    this.historySize = opts.historySize ?? 200;
    this.canSprint = opts.canSprint ?? (() => true);
    this.canGlide = opts.canGlide ?? (() => false);
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
      // Not in the typed overloads (kept stable for other fakes): Connection's untyped `on` serves it.
      (this.conn as unknown as UntypedOn).on('set_entity_motion', (p) => {
        this.onMotion(p as SetEntityMotionPacket);
      }),
      // Track AU: the own `gliding` actor flag confirms a glide or ends it (ground, water, no elytra)
      (this.conn as unknown as UntypedOn).on('set_entity_data', (p) => {
        this.onEntityData(p as { runtime_entity_id: bigint | number; metadata?: { key?: string; value?: unknown }[]; tick?: bigint | number });
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
      motions: this.motions,
      sprinting: b.sprinting,
      inWater: b.inWater ?? false,
      inLava: b.inLava ?? false,
      gliding: b.gliding ?? false,
      boostTicks: b.boostTicks ?? 0,
      prone: this.ownPose.prone && !(b.gliding ?? false) && !(b.inWater ?? false),
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

  /**
   * Run `fn` at the start of every tick, before the body is stepped, so a controller (path
   * following, lookAt) can set the command the same tick sees. Returns an unsubscribe function.
   */
  onBeforeStep(fn: (tick: bigint, state: InputLoopState) => void): () => void {
    this.beforeStep.add(fn);
    return () => {
      this.beforeStep.delete(fn);
    };
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

  /**
   * Per-tick extras (Track G, digging): `fn(tick)` is called once per sent input; its fields are
   * merged into that `player_auth_input` and its `input_data` flags are appended to the loop's own.
   * One provider at a time; `undefined` removes it.
   */
  setTickExtras(fn: TickExtrasProvider | undefined): void {
    this.tickExtras = fn;
  }

  /**
   * Track AU: a firework rocket was used this tick (the item-use transaction goes out in the same
   * batch): the glide boost runs for `ticks` ticks from the next input on (GLIDE.boostTicks by
   * default; the rocket's remove_entity ends it early through `endBoost`).
   */
  boost(ticks: number = GLIDE.boostTicks): void {
    this.pendingBoost = ticks;
  }

  /**
   * Track AU: the server removed the boosting rocket: the boost ended `agoTicks` inputs ago (the
   * packet's latency; default 3). The inputs since are re-simulated without it.
   */
  endBoost(agoTicks = 3): void {
    this.pendingBoost = undefined;
    if ((this.body.boostTicks ?? 0) === 0) return;
    const at = this.lastTick - BigInt(Math.max(0, agoTicks));
    const index = this.history.findIndex((e) => e.tick >= at);
    if (index < 0) {
      this.body = { ...cloneBody(this.body), boostTicks: 0 };
      return;
    }
    const entries = this.history.map((e) => ({ ...e, state: cloneBody(e.state) }));
    for (let i = index; i < entries.length; i++) entries[i]!.cmd = { ...entries[i]!.cmd, boostStart: 0 };
    this.replayFrom(entries, index);
  }

  /**
   * Track AK: a pose provider (the sleeping body held at the bed), a second slot beside
   * `setTickExtras` so a dig or a hotbar move neither replaces it nor is replaced by it. Merged like
   * the tick extras, after them: its fields win. One provider at a time; `undefined` removes it.
   */
  setPose(fn: TickExtrasProvider | undefined): void {
    this.pose = fn;
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
    this.sprint = newSprintTracker();
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
    if (this.beforeStep.size) {
      const st = this.state;
      for (const fn of [...this.beforeStep]) {
        try {
          fn(tick, st);
        } catch (err) {
          this.log.error(`input loop controller threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const cmd = { ...this.cmd };
    const prev = this.body;
    let state: BodyState;
    let jumped = false;
    let simulated = false;
    let moving = true;
    // BDS's own sprint rules (sticky sprint, double-tapped forward): the body sprints when the server will
    const simCmd: MoveCommand = { ...cmd, sprint: stepSprint(this.sprint, cmd, prev, this.canSprint()) };
    // Track AU: the glide only with an elytra on; a rocket used since the last input starts its boost here
    if (cmd.glide && !this.canGlide()) simCmd.glide = false;
    if (this.pendingBoost !== undefined) {
      simCmd.boostStart = this.pendingBoost;
      this.pendingBoost = undefined;
    }
    if (this.skipNext) {
      // first input after a teleport: the server takes the teleport state without simulating it
      this.skipNext = false;
      state = cloneBody(prev);
    } else {
      const r = this.engine.step(prev, simCmd, this.world);
      state = r.state;
      jumped = r.jumped;
      simulated = r.simulated;
      moving = r.simulated;
    }
    if (!moving) this.sprint = newSprintTracker(); // no keys reach the server this tick
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
    if (state.gliding === true && prev.gliding !== true) this.glideRequestTick = tick; // Track AU
    const packet = buildAuthInput({ tick, cmd: sentCmd, state, flags, moving });
    for (const extras of [this.tickExtras?.(tick), this.pose?.(tick)]) {
      if (!extras) continue;
      const { input_data: extraFlags, ...fields } = extras;
      Object.assign(packet, fields);
      if (extraFlags) packet.input_data = [...packet.input_data, ...extraFlags.filter((f) => !packet.input_data.includes(f))];
    }
    this.conn.queue('player_auth_input', packet);

    // the history keeps what was simulated (the effective sprint), so replays reproduce it
    this.history.push({ tick, cmd: moving ? simCmd : sentCmd, state: cloneBody(state), simulated });
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

  /** Track AU: re-simulate `entries` from `index` on (each from the previous entry's state) and adopt the result. */
  private replayFrom(entries: HistoryEntry[], index: number): number {
    let replayed = 0;
    for (let i = Math.max(1, index); i < entries.length; i++) {
      const e = entries[i]!;
      const prevState = entries[i - 1]!.state;
      e.state = e.simulated ? this.engine.step(prevState, e.cmd, this.world).state : cloneBody(prevState);
      replayed++;
    }
    this.history = entries;
    if (entries.length) this.body = cloneBody(entries[entries.length - 1]!.state);
    return replayed;
  }

  /** Track BH: the own pose from the server's actor data (`crawling` / `swimming` flags, `boundingbox_height`), see InputLoopState.prone. */
  private readonly ownPose = { crawling: false, swimming: false, height: undefined as number | undefined, prone: false };
  private onPose(metadata: { key?: string; value?: unknown }[] | undefined): void {
    if (!metadata) return;
    const flags = metadata.find((m) => m.key === 'flags')?.value as { crawling?: boolean; swimming?: boolean } | undefined;
    if (flags && typeof flags.crawling === 'boolean') this.ownPose.crawling = flags.crawling;
    if (flags && typeof flags.swimming === 'boolean') this.ownPose.swimming = flags.swimming;
    const h = metadata.find((m) => m.key === 'boundingbox_height')?.value;
    if (typeof h === 'number') this.ownPose.height = h;
    const prone = this.ownPose.crawling || this.ownPose.swimming || (this.ownPose.height !== undefined && this.ownPose.height < 1);
    if (prone !== this.ownPose.prone) this.log.info(`pose: ${prone ? 'prone' : 'standing'} (crawling ${this.ownPose.crawling}, swimming ${this.ownPose.swimming}, box height ${this.ownPose.height?.toFixed(2) ?? '?'})`);
    this.ownPose.prone = prone;
  }

  /** Track AU: the server's `gliding` flag for the own player. */
  private onEntityData(p: { runtime_entity_id: bigint | number; metadata?: { key?: string; value?: unknown }[]; tick?: bigint | number }): void {
    if (!this.ready || BigInt(p.runtime_entity_id) !== this.conn.runtimeId) return;
    this.onPose(p.metadata);
    const flags = p.metadata?.find((m) => m.key === 'flags')?.value as { gliding?: boolean } | undefined;
    if (!flags || typeof flags.gliding !== 'boolean') return;
    const tick = BigInt(p.tick ?? 0);
    if (flags.gliding) {
      this.glideRequestTick = undefined;
      this.emit({ kind: 'glide', gliding: true, tick, replayed: 0 });
      return;
    }
    if (!this.body.gliding) return;
    // a flags packet of the tick that carried our start_gliding (or older) describes the state before it:
    // the server confirms with the next one (measured: the request at tick N is confirmed at N + 1)
    if (this.glideRequestTick !== undefined && (tick === 0n || tick <= this.glideRequestTick)) return;
    // the server ended (or refused) a glide we still predict: no glide from the input after its tick on
    const index = tick > 0n ? this.history.findIndex((e) => e.tick > tick) : this.history.length - 1;
    let replayed = 0;
    if (index >= 0) {
      const entries = this.history.map((e) => ({ ...e, state: cloneBody(e.state) }));
      for (let i = index; i < entries.length; i++) entries[i]!.cmd = { ...entries[i]!.cmd, glide: false };
      replayed = this.replayFrom(entries, index);
    }
    this.body = { ...cloneBody(this.body), gliding: false, boostTicks: 0 };
    this.cmd = { ...this.cmd, glide: false };
    this.glideRequestTick = undefined;
    this.log.info(`glide ended by the server at tick ${tick} (now ${this.lastTick}); replayed ${replayed}`);
    this.emit({ kind: 'glide', gliding: false, tick, replayed });
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

  private onMotion(p: SetEntityMotionPacket): void {
    if (!this.ready || BigInt(p.runtime_entity_id) !== this.conn.runtimeId) return;
    const velocity = { x: p.velocity.x, y: p.velocity.y, z: p.velocity.z };
    const tick = BigInt(p.tick ?? 0);
    const out = applyMotion(this.history, this.body, tick, velocity, this.engine, this.world);
    this.body = out.state;
    this.history = out.history;
    this.motions++;
    this.log.info(`motion ${fmt(velocity)} at tick ${tick} (now ${this.lastTick}); replayed ${out.replayed}`);
    this.emit({ kind: 'motion', tick, velocity, replayed: out.replayed });
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
    this.sprint = newSprintTracker();
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
