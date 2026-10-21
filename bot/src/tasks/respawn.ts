// Death and respawn (PLAN.md task 5.1), reusable by every task (AFK, gather-wood, RL agent).
//
// Measured on BDS 1.26.60.6 (bds-hard, 2026-10-29; docs/runbook.md "Behaviour"): on death the server
// sends `death_info` {cause, messages}, `respawn` state 0 (twice: at the death spot, then at
// y 32767) and `update_attributes` minecraft:health 0. The respawn handshake that works:
//   client `respawn` state 2 (client ready)  ->  server `respawn` state 1 (the spawn point)
//   ->  client `respawn` state 2 (the Connection answers every state 1) + `player_action respawn`.
// Sending `player_action respawn` together with the first state 2, before the server's state 1 (what
// the AFK task did until 2026-10-29), leaves the player dead on the server: it stays at the death spot
// (a correct_player_move_prediction pulls the bot back there) and later kills produce no death.
//
// The controller counts deaths (metrics counter `deaths`, plus `deaths.<cause>`), remembers the
// cause, presses respawn after `respawnDelayMs`, and runs optional after-respawn hooks such as
// "walk back to the home point" (see `homeHook`).
import type { Connection } from '../connection/connection.ts';
import type { Metrics } from '../connection/metrics.ts';
import type { AnyPacket, Vec3 } from '../connection/types.ts';
import { silentLogger, type Logger } from '../log.ts';
import { eyeToFeet } from './echo.ts';

export interface DeathRecord {
  n: number;
  ts: string;
  /** `death_info.cause` (e.g. `death.attack.generic`, `death.attack.mob`), else `health_zero` / `unknown`. */
  cause: string;
  /** `death_info.messages` (translation parameters such as the player and the killer). */
  messages: string[];
  /** Last known feet position before the death. */
  at: Vec3 | undefined;
}

export type RespawnEvent =
  | { kind: 'death'; death: DeathRecord }
  | { kind: 'respawn'; feet: Vec3; death: DeathRecord | undefined }
  | { kind: 'health'; health: number; previous: number | undefined };

/** The part of `Connection` the controller uses (unit-test seam). */
export interface RespawnConnection {
  readonly state: Connection['state'];
  readonly runtimeId: bigint;
  on(name: string, fn: (p: AnyPacket) => void): () => void;
  queue(name: string, params: object): void;
  onSpawn(fn: () => void): () => void;
  onClose(fn: () => void): () => void;
}

export interface RespawnOptions {
  /** Press respawn this many ms after the death. Default 2000; negative = stay on the death screen. */
  respawnDelayMs?: number;
  metrics?: Metrics;
  log?: Logger;
  /** Current feet position, recorded with each death. */
  position?: () => Vec3 | undefined;
  /** Keep this many deaths in `history` (default 20). */
  historySize?: number;
}

/** A hook run after each respawn; `signal` aborts when the bot dies again or disconnects. */
export type RespawnHook = (feet: Vec3, death: DeathRecord | undefined, signal: AbortSignal) => Promise<void> | void;

interface RespawnPacketLike {
  state: number;
  position: Vec3;
}
interface DeathInfoLike {
  cause?: string;
  messages?: string[];
}
interface AttributesLike {
  runtime_entity_id: bigint | number;
  attributes: { name: string; current: number }[];
}

export class RespawnController {
  deaths = 0;
  /** Between the death and the server's `respawn` state 1. */
  dead = false;
  health: number | undefined;
  lastDeath: DeathRecord | undefined;
  readonly history: DeathRecord[] = [];
  readonly respawnDelayMs: number;
  private readonly conn: RespawnConnection;
  private readonly metrics: Metrics | undefined;
  private readonly log: Logger;
  private readonly position: () => Vec3 | undefined;
  private readonly historySize: number;
  private readonly listeners = new Set<(e: RespawnEvent) => void>();
  private readonly hooks: RespawnHook[] = [];
  private readonly unsubs: (() => void)[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** death_info that arrived before respawn state 0 (or after it, within the same death). */
  private pendingCause: DeathInfoLike | undefined;
  private hookAbort: AbortController | undefined;
  /** Promise of the running after-respawn hooks (tests and the e2e wait on it). */
  hooksDone: Promise<void> = Promise.resolve();

  constructor(conn: RespawnConnection, opts: RespawnOptions = {}) {
    this.conn = conn;
    this.respawnDelayMs = opts.respawnDelayMs ?? 2000;
    this.metrics = opts.metrics;
    this.log = opts.log ?? silentLogger;
    this.position = opts.position ?? (() => undefined);
    this.historySize = opts.historySize ?? 20;
  }

  onEvent(fn: (e: RespawnEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Run `hook` after every respawn (in registration order). */
  afterRespawn(hook: RespawnHook): void {
    this.hooks.push(hook);
  }

  start(): void {
    if (this.unsubs.length) return;
    const conn = this.conn;
    this.unsubs.push(
      conn.on('respawn', (raw) => {
        const p = raw as unknown as RespawnPacketLike;
        if (p.state === 0 && conn.state === 'spawned') this.onDeath('respawn_state_0');
        else if (p.state === 1 && this.dead) {
          // Second half of the handshake: the server has a spawn point; now really respawn.
          const zero = { x: 0, y: 0, z: 0 };
          conn.queue('player_action', { runtime_entity_id: conn.runtimeId, action: 'respawn', position: zero, result_position: zero, face: -1 });
          this.onRespawned(eyeToFeet(p.position));
        }
      }),
      conn.on('death_info', (raw) => {
        const p = raw as unknown as DeathInfoLike;
        this.pendingCause = p;
        if (this.dead && this.lastDeath && (this.lastDeath.cause === 'health_zero' || this.lastDeath.cause === 'unknown')) {
          this.lastDeath.cause = p.cause ?? this.lastDeath.cause;
          this.lastDeath.messages = p.messages ?? [];
          this.metrics?.inc(`deaths.${this.lastDeath.cause}`);
          this.log.info(`death cause: ${this.lastDeath.cause}${this.lastDeath.messages.length ? ` (${this.lastDeath.messages.join(', ')})` : ''}`);
        }
      }),
      conn.on('set_health', (raw) => {
        const p = raw as unknown as { health: number };
        this.setHealth(p.health);
      }),
      conn.on('update_attributes', (raw) => {
        const p = raw as unknown as AttributesLike;
        if (BigInt(p.runtime_entity_id) !== conn.runtimeId) return;
        const h = p.attributes.find((a) => a.name === 'minecraft:health');
        if (h) this.setHealth(h.current);
      }),
      conn.onSpawn(() => {
        // Fresh session (reconnect): the server decides; a dead player gets respawn state 0 again.
        this.dead = false;
        this.pendingCause = undefined;
      }),
      conn.onClose(() => {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.dead = false;
        this.hookAbort?.abort();
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubs.splice(0)) u();
    clearTimeout(this.timer);
    this.hookAbort?.abort();
  }

  status(): Record<string, unknown> {
    return {
      deaths: this.deaths,
      dead: this.dead,
      health: this.health ?? null,
      lastDeath: this.lastDeath ?? null,
    };
  }

  private setHealth(h: number): void {
    const prev = this.health;
    this.health = h;
    if (prev !== h) this.emit({ kind: 'health', health: h, previous: prev });
    // Health 0 while alive = death, even before (or without) respawn state 0.
    if (h <= 0 && !this.dead && this.conn.state === 'spawned') this.onDeath('health_zero');
  }

  private onDeath(trigger: 'respawn_state_0' | 'health_zero'): void {
    if (this.dead) return;
    this.dead = true;
    this.deaths++;
    this.hookAbort?.abort();
    const info = this.pendingCause;
    this.pendingCause = undefined;
    const cause = info?.cause ?? (trigger === 'health_zero' ? 'health_zero' : 'unknown');
    const death: DeathRecord = { n: this.deaths, ts: new Date().toISOString(), cause, messages: info?.messages ?? [], at: this.position() };
    this.lastDeath = death;
    this.history.push(death);
    if (this.history.length > this.historySize) this.history.shift();
    this.metrics?.inc('deaths');
    if (info?.cause) this.metrics?.inc(`deaths.${cause}`);
    const at = death.at ? ` at ${death.at.x.toFixed(1)} ${death.at.y.toFixed(1)} ${death.at.z.toFixed(1)}` : '';
    this.log.warn(`died (death ${this.deaths}, cause ${cause})${at}${this.respawnDelayMs >= 0 ? `; respawning in ${this.respawnDelayMs} ms` : ''}`);
    this.emit({ kind: 'death', death });
    if (this.respawnDelayMs < 0) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pressRespawn();
    }, this.respawnDelayMs);
  }

  /** The "Respawn" button: client ready (`respawn` state 2). `player_action respawn` follows the server's state 1. */
  pressRespawn(): void {
    if (!this.dead || this.conn.state !== 'spawned') return;
    this.conn.queue('respawn', { position: { x: 0, y: 0, z: 0 }, state: 2, runtime_entity_id: this.conn.runtimeId });
  }

  private onRespawned(feet: Vec3): void {
    this.dead = false;
    this.health = undefined;
    const death = this.lastDeath;
    this.log.info(`respawned at ${feet.x.toFixed(2)} ${feet.y.toFixed(2)} ${feet.z.toFixed(2)}`);
    this.emit({ kind: 'respawn', feet, death });
    if (this.hooks.length === 0) return;
    const abort = new AbortController();
    this.hookAbort = abort;
    this.hooksDone = (async () => {
      for (const hook of this.hooks) {
        if (abort.signal.aborted) return;
        try {
          await hook(feet, death, abort.signal);
        } catch (e) {
          this.log.warn(`after-respawn hook failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })();
  }

  private emit(e: RespawnEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch (err) {
        this.log.error(`respawn listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
