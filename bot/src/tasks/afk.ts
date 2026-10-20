// AFK task (PLAN.md task 1.3 and 4.4): stand still and defeat the idle kick with a tiny
// `player_auth_input` nudge every N minutes: a look-around (yaw change) and a one-tick sneak toggle.
// The position never changes, so the server's simulation agrees with ours and no
// `correct_player_move_prediction` should ever arrive (counted when one does).
//
// Measured on BDS 1.26.51.1 (player-idle-timeout=1, docs/runbook.md): a client that never sends
// player_auth_input is never idle-kicked, and identical inputs keep resetting the idle timer. The
// kick itself (reason `kicked_for_idle`, empty message) was seen once, ~63 s after the last input,
// and did not reproduce in later runs. The task sends one standing "settle" input after each spawn
// (as a real client would) and relies on the nudges, not on any of that.
import { EYE_HEIGHT, type Connection } from '../connection/connection.ts';
import type { Metrics } from '../connection/metrics.ts';
import type { PlayerAuthInputPacket, Vec3 } from '../connection/types.ts';
import { createLogger, type Logger } from '../log.ts';
import { eyeToFeet } from './echo.ts';

export interface AfkOptions {
  /** Time between nudges (ms). 0 disables nudging. Default 4 minutes. */
  nudgeIntervalMs?: number;
  /**
   * Also send an idle `player_auth_input` on every tick between nudges, as a vanilla client does.
   * Default false: only the nudge ticks are sent (see docs/runbook.md "Phase 1 on BDS" for why).
   */
  heartbeat?: boolean;
  /** Look-around angle in degrees (alternates left/right). Default 30. */
  yawDelta?: number;
  /** Include the one-tick sneak toggle in each nudge. Default true. */
  sneak?: boolean;
  /** Send one standing input on the first tick after each spawn. Default true. */
  settle?: boolean;
  /**
   * Press "respawn" this many ms after dying (server `respawn` state 0). Default 2000; a negative
   * value leaves the bot on the death screen.
   */
  respawnDelayMs?: number;
  metrics?: Metrics;
  log?: Logger;
  /** Clock (ms), for tests. */
  now?: () => number;
}

export type AfkEvent =
  | { kind: 'nudge'; n: number; tick: bigint }
  | { kind: 'correction'; feet: Vec3; tick: bigint }
  | { kind: 'position'; feet: Vec3; source: 'respawn' | 'move_player' | 'correction' }
  | { kind: 'death' }
  | { kind: 'respawn'; feet: Vec3 };

/** Ticks of one nudge: look, sneak press, sneak release, look back. */
export const NUDGE_TICKS = 4;

const SNEAK_PRESS = ['sneak_down', 'want_down', 'sneak_current_raw', 'sneak_pressed_raw', 'sneaking', 'start_sneaking'];
const SNEAK_RELEASE = ['sneak_released_raw', 'stop_sneaking'];

/** Unit look vector for a Bedrock yaw/pitch in degrees (yaw 0 = +z, 90 = -x; pitch 90 = down). */
export function lookVector(yawDeg: number, pitchDeg: number): Vec3 {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { x: r(-Math.sin(yaw) * Math.cos(pitch)), y: r(-Math.sin(pitch)), z: r(Math.cos(yaw) * Math.cos(pitch)) };
}

export class AfkTask {
  readonly name = 'afk';
  /** Feet position (respawn state 1, own move_player, corrections). */
  feet: Vec3 | undefined;
  yaw = 0;
  pitch = 0;
  nudges = 0;
  corrections = 0;
  inputsSent = 0;
  readonly nudgeIntervalMs: number;
  readonly heartbeat: boolean;
  readonly settle: boolean;
  readonly respawnDelayMs: number;
  deaths = 0;
  /** On the death screen (between respawn state 0 and state 1). */
  dead = false;
  private readonly yawDelta: number;
  private readonly sneak: boolean;
  private readonly conn: Connection;
  private readonly metrics: Metrics | undefined;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly listeners = new Set<(e: AfkEvent) => void>();
  private readonly unsubs: (() => void)[] = [];
  private nextNudgeAt = Infinity;
  /** Step within the current nudge, -1 when idle. */
  private step = -1;
  /** A settle input is due on the next tick. */
  private settlePending = false;
  private respawnTimer: NodeJS.Timeout | undefined;
  private direction = 1;
  private pendingTeleport = false;
  private lastTick = -1n;

  constructor(conn: Connection, opts: AfkOptions = {}) {
    this.conn = conn;
    this.nudgeIntervalMs = opts.nudgeIntervalMs ?? 240_000;
    this.heartbeat = opts.heartbeat ?? false;
    this.settle = opts.settle ?? true;
    this.respawnDelayMs = opts.respawnDelayMs ?? 2000;
    this.yawDelta = opts.yawDelta ?? 30;
    this.sneak = opts.sneak ?? true;
    this.metrics = opts.metrics;
    this.log = opts.log ?? createLogger('info', 'afk');
    this.now = opts.now ?? (() => Date.now());
  }

  onEvent(fn: (e: AfkEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  start(): void {
    const conn = this.conn;
    this.unsubs.push(
      conn.on('respawn', (p) => {
        if (p.state === 0 && conn.state === 'spawned') {
          this.onDeath();
          return;
        }
        if (p.state !== 1) return;
        const feet = eyeToFeet(p.position);
        this.setFeet(feet, 'respawn');
        if (this.dead) {
          // Back from the death screen (the Connection answers state 1 with state 2).
          this.dead = false;
          this.settlePending = this.settle;
          this.scheduleNext();
          this.log.info(`respawned at ${feet.x.toFixed(2)} ${feet.y.toFixed(2)} ${feet.z.toFixed(2)}`);
          this.emit({ kind: 'respawn', feet });
        }
      }),
      conn.on('move_player', (p) => {
        if (BigInt(p.runtime_id) !== conn.runtimeId) return;
        this.setFeet(eyeToFeet(p.position), 'move_player');
        this.yaw = p.yaw;
        this.pitch = p.pitch;
        if (p.mode === 'teleport' || p.mode === 'reset') this.pendingTeleport = true;
      }),
      conn.on('correct_player_move_prediction', (p) => {
        if (p.prediction_type !== 'player') return;
        const feet = eyeToFeet(p.position);
        this.corrections++;
        this.metrics?.inc('corrections');
        this.log.warn(`correct_player_move_prediction at tick ${p.tick}: feet ${feet.x.toFixed(3)} ${feet.y.toFixed(3)} ${feet.z.toFixed(3)}`);
        this.setFeet(feet, 'correction');
        this.emit({ kind: 'correction', feet, tick: BigInt(p.tick) });
      }),
      conn.onSpawn(() => {
        // Fresh session: tick restarts at 0, schedule the first nudge one interval from now.
        this.step = -1;
        this.lastTick = -1n;
        this.settlePending = this.settle;
        this.scheduleNext();
      }),
      conn.onClose(() => {
        this.step = -1;
        this.nextNudgeAt = Infinity;
        this.dead = false;
        clearTimeout(this.respawnTimer);
      }),
      conn.onTick((tick) => {
        this.onTick(tick);
      }),
    );
    if (conn.state === 'spawned') {
      this.settlePending = this.settle;
      this.feet ??= conn.spawnPosition ? eyeToFeet(conn.spawnPosition) : undefined;
      this.scheduleNext();
    }
  }

  stop(): void {
    for (const u of this.unsubs.splice(0)) u();
    clearTimeout(this.respawnTimer);
    this.step = -1;
    this.nextNudgeAt = Infinity;
  }

  /** Start a nudge on the next tick (also used by tests and the soak). */
  nudgeNow(): void {
    if (this.step < 0) this.step = 0;
  }

  status(): Record<string, unknown> {
    return {
      state: this.conn.state,
      feet: this.feet,
      nudges: this.nudges,
      corrections: this.corrections,
      deaths: this.deaths,
      dead: this.dead,
      nudgeIntervalMs: this.nudgeIntervalMs,
      heartbeat: this.heartbeat,
      nextNudgeInMs: Number.isFinite(this.nextNudgeAt) ? Math.max(0, this.nextNudgeAt - this.now()) : null,
    };
  }

  /** Server `respawn` state 0 while spawned: we died. Press respawn after a short delay. */
  private onDeath(): void {
    if (this.dead) return;
    this.dead = true;
    this.step = -1;
    this.deaths++;
    this.metrics?.inc('deaths');
    this.log.warn(`died (death ${this.deaths})${this.respawnDelayMs >= 0 ? `; respawning in ${this.respawnDelayMs} ms` : ''}`);
    this.emit({ kind: 'death' });
    if (this.respawnDelayMs < 0) return;
    clearTimeout(this.respawnTimer);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      if (!this.dead || this.conn.state !== 'spawned') return;
      const rid = this.conn.runtimeId;
      const zero = { x: 0, y: 0, z: 0 };
      // What the vanilla client sends on the "Respawn" button: client ready + player_action respawn.
      this.conn.queue('respawn', { position: zero, state: 2, runtime_entity_id: rid });
      this.conn.queue('player_action', { runtime_entity_id: rid, action: 'respawn', position: zero, result_position: zero, face: -1 });
    }, this.respawnDelayMs);
  }

  private scheduleNext(): void {
    this.nextNudgeAt = this.nudgeIntervalMs > 0 ? this.now() + this.nudgeIntervalMs : Infinity;
  }

  private onTick(tick: bigint): void {
    if (!this.feet || this.dead) return;
    if (this.step < 0 && this.now() >= this.nextNudgeAt) this.step = 0;
    if (this.step < 0) {
      if (this.heartbeat || this.settlePending) this.send(tick, this.yaw, []);
      return;
    }
    const lookYaw = this.yaw + this.direction * this.yawDelta;
    switch (this.step) {
      case 0:
        this.send(tick, lookYaw, []);
        break;
      case 1:
        this.send(tick, lookYaw, this.sneak ? SNEAK_PRESS : []);
        break;
      case 2:
        this.send(tick, lookYaw, this.sneak ? SNEAK_RELEASE : []);
        break;
      default:
        this.send(tick, this.yaw, []);
        break;
    }
    this.step++;
    if (this.step >= NUDGE_TICKS) {
      this.step = -1;
      this.direction = -this.direction;
      this.nudges++;
      this.metrics?.inc('nudges');
      this.log.info(`nudge ${this.nudges} at tick ${tick}`);
      this.emit({ kind: 'nudge', n: this.nudges, tick });
      this.scheduleNext();
    }
  }

  /** Build the input for one tick. Feet never move: the bot stands still on the ground. */
  buildInput(tick: bigint, yaw: number, extraFlags: readonly string[]): PlayerAuthInputPacket {
    const feet = this.feet ?? { x: 0, y: 0, z: 0 };
    const flags = ['vertical_collision', ...extraFlags];
    if (this.pendingTeleport) flags.push('handled_teleport');
    const zero2 = { x: 0, z: 0 };
    return {
      pitch: this.pitch,
      yaw,
      position: { x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z },
      move_vector: zero2,
      head_yaw: yaw,
      input_data: flags,
      input_mode: 'mouse',
      play_mode: 'normal',
      interaction_model: 'crosshair',
      interact_rotation: zero2,
      tick,
      delta: { x: 0, y: 0, z: 0 },
      analogue_move_vector: zero2,
      camera_orientation: lookVector(yaw, this.pitch),
      raw_move_vector: zero2,
    };
  }

  private send(tick: bigint, yaw: number, extraFlags: readonly string[]): void {
    if (tick === this.lastTick) return; // at most one input per tick
    this.lastTick = tick;
    this.conn.queue('player_auth_input', this.buildInput(tick, yaw, extraFlags));
    this.pendingTeleport = false;
    this.settlePending = false;
    this.inputsSent++;
  }

  private setFeet(feet: Vec3, source: 'respawn' | 'move_player' | 'correction'): void {
    this.feet = feet;
    this.emit({ kind: 'position', feet, source });
  }

  private emit(e: AfkEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }
}
