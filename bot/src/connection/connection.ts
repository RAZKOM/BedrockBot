// Connection layer (PLAN.md section 4.1, tasks 0.3 and 0.5): wraps bedrock-protocol's createClient
// with a version gate, the spawn handshake, a 20 Hz tick driver, per-tick batched sends,
// reconnect with backoff and a packet recorder. Logic ported from spikes A, B, C and E.
import bedrock from 'bedrock-protocol';
import type { ClientOptions } from 'bedrock-protocol';
import { backoffDelay, defaultBackoff, type BackoffPolicy } from './backoff.ts';
import type { PacketRecorder } from './recorder.ts';
import type { PacketSerializer } from './protocol.ts';
import { checkVersion } from './versionGate.ts';
import type {
  AnyPacket,
  CloseInfo,
  ConnectionState,
  ConnectTarget,
  InboundPackets,
  OutboundPackets,
  RespawnPacket,
  Transport,
  Vec3,
} from './types.ts';
import { createLogger, type Logger } from '../log.ts';

export const TICK_MS = 50;
/** Eye height above the feet for a standing player. */
export const EYE_HEIGHT = 1.62;

/** The subset of a bedrock-protocol Client the Connection uses (a seam for tests). */
export interface ProtocolClient {
  // Listener args depend on the event (decoded packet, Error, ...), like Node's EventEmitter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, fn: (...args: any[]) => void): unknown;
  queue(name: string, params: object): void;
  write(name: string, params: object): void;
  disconnect(reason?: string): void;
  close(): void;
  serializer?: PacketSerializer;
}

export interface ServerInfo {
  transport: Transport;
  protocol: number | undefined;
  version: string | undefined;
  motd: string | undefined;
  levelName: string | undefined;
}

export type ClientFactory = (opts: ClientOptions) => ProtocolClient;
export type PingFn = (target: Extract<ConnectTarget, { kind: 'bds' }>, timeoutMs: number) => Promise<ServerInfo>;

export interface ReconnectPolicy extends BackoffPolicy {
  enabled: boolean;
  /** Give up after this many consecutive failed attempts. Infinity = never. */
  maxAttempts: number;
}

export interface ConnectionOptions {
  /** Game version to speak, e.g. '1.26.51'. Must be supported by bedrock-protocol. */
  version: string;
  /** Offline-mode username. */
  username: string;
  logger?: Logger;
  recorder?: PacketRecorder;
  /** true/false or a partial policy; default enabled with 1 s base, x2, 60 s cap, 20 % jitter. */
  reconnect?: boolean | Partial<ReconnectPolicy>;
  /** Close and retry when spawn has not happened within this many ms. Default 30 000. */
  spawnTimeoutMs?: number;
  pingTimeoutMs?: number;
  viewDistance?: number;
  /** Test seams. */
  createClient?: ClientFactory;
  ping?: PingFn;
}

export class VersionGateError extends Error {
  override name = 'VersionGateError';
}

type Handler = (p: AnyPacket) => void;

const defaultCreateClient: ClientFactory = (opts) => bedrock.createClient(opts);

const defaultPing: PingFn = async (target, timeoutMs) => {
  const ad =
    target.transport === 'raknet'
      ? await bedrock.ping({ transport: 'raknet', host: target.host, port: target.port, timeout: timeoutMs })
      : await bedrock.ping({ transport: 'nethernet', host: target.host, timeout: timeoutMs });
  if (ad.transport === 'raknet') {
    return { transport: 'raknet', protocol: Number(ad.protocol), version: ad.version, motd: ad.motd, levelName: ad.levelName };
  }
  return { transport: 'nethernet', protocol: ad.protocol ? Number(ad.protocol) : undefined, version: ad.gameVersion, motd: ad.motd, levelName: ad.levelName };
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Connection {
  readonly version: string;
  readonly username: string;
  readonly recorder: PacketRecorder | undefined;
  private readonly log: Logger;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly spawnTimeoutMs: number;
  private readonly pingTimeoutMs: number;
  private readonly viewDistance: number;
  private readonly makeClient: ClientFactory;
  private readonly pingServer: PingFn;

  private _state: ConnectionState = 'idle';
  private _gameVersion: string;
  private _runtimeId = 0n;
  private _tick = 0n;
  private _spawnPosition: Vec3 | undefined;
  private _serverInfo: ServerInfo | undefined;

  private target: Extract<ConnectTarget, { kind: 'bds' }> | undefined;
  private client: ProtocolClient | undefined;
  private session = 0;
  private attempt = 0;
  private userClosed = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private spawnTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private pending: [string, object][] = [];
  private firstSpawn: { resolve: () => void; reject: (e: Error) => void } | undefined;
  /** Best known reason why each session ended (kick message, error, timeout). */
  private readonly lastReason = new Map<number, string>();
  /** Packet names with a dispatcher on the current client. */
  private attachedNames = new Set<string>();
  /** Session whose end has already been handled. */
  private ending = 0;

  private readonly packetHandlers = new Map<string, Set<Handler>>();
  private readonly tickHandlers = new Set<(tick: bigint) => void>();
  private readonly spawnHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<(info: CloseInfo) => void>();

  constructor(opts: ConnectionOptions) {
    this.version = opts.version;
    this.username = opts.username;
    this._gameVersion = opts.version;
    this.recorder = opts.recorder;
    this.log = opts.logger ?? createLogger('info', 'connection');
    const r = typeof opts.reconnect === 'object' ? opts.reconnect : { enabled: opts.reconnect ?? true };
    this.reconnectPolicy = { ...defaultBackoff, enabled: true, maxAttempts: Infinity, ...r };
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? 30_000;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? 3_000;
    this.viewDistance = opts.viewDistance ?? 10;
    this.makeClient = opts.createClient ?? defaultCreateClient;
    this.pingServer = opts.ping ?? defaultPing;
  }

  get state(): ConnectionState {
    return this._state;
  }
  /** From ping (server advertisement) once connected; the requested version before that. */
  get gameVersion(): string {
    return this._gameVersion;
  }
  get runtimeId(): bigint {
    return this._runtimeId;
  }
  /** Current tick of the 20 Hz driver (resets to 0 on every spawn). */
  get tick(): bigint {
    return this._tick;
  }
  /** Eye position from the last `respawn` state 1 packet (the real spawn point). */
  get spawnPosition(): Vec3 | undefined {
    return this._spawnPosition;
  }
  get serverInfo(): ServerInfo | undefined {
    return this._serverInfo;
  }

  // ---- public API ---------------------------------------------------------------------------

  /** Resolves on the first spawn. Rejects on a version-gate refusal or when retries are exhausted. */
  connect(target: ConnectTarget): Promise<void> {
    if (target.kind === 'realm') {
      return Promise.reject(new Error('Realm targets are not implemented yet (PLAN.md task 1.6)'));
    }
    if (this._state === 'connecting' || this._state === 'spawned') {
      return Promise.reject(new Error(`connect() called while ${this._state}`));
    }
    const gate = checkVersion(this.version);
    if (!gate.ok) {
      this.setState('closed');
      return Promise.reject(new VersionGateError(gate.message));
    }
    this.target = target;
    this.userClosed = false;
    this.attempt = 0;
    return new Promise<void>((resolve, reject) => {
      this.firstSpawn = { resolve, reject };
      void this.attemptOnce();
    });
  }

  /** Leave the server and stop reconnecting. */
  disconnect(reason = 'client leaving'): void {
    this.userClosed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const client = this.client;
    if (client) {
      this.lastReason.set(this.session, `client: ${reason}`);
      try {
        client.disconnect(reason);
      } catch (e) {
        this.log.warn(`disconnect failed: ${errorMessage(e)}`);
        client.close();
      }
      // bedrock-protocol emits 'close' synchronously; make sure we end up closed either way.
      if (this.client === client) this.endSession(this.session, `client: ${reason}`);
    } else if (this._state !== 'closed') {
      this.setState('closed');
      this.firstSpawn?.reject(new Error(`disconnected before spawn: ${reason}`));
      this.firstSpawn = undefined;
      this.emitClose({ reason: 'client', willReconnect: false });
    }
  }

  /** Subscribe to an inbound packet by name. Returns an unsubscribe function. */
  on<K extends keyof InboundPackets>(name: K, fn: (p: InboundPackets[K]) => void): () => void;
  on(name: string, fn: (p: AnyPacket) => void): () => void;
  on(name: string, fn: (p: never) => void): () => void {
    let set = this.packetHandlers.get(name);
    if (!set) {
      set = new Set();
      this.packetHandlers.set(name, set);
    }
    const h = fn as Handler;
    set.add(h);
    if (this.client && !this.attachedNames.has(name)) {
      this.attachName(this.client, name, this.session);
      this.attachedNames.add(name);
    }
    return () => {
      set.delete(h);
    };
  }

  /** Queue an outbound packet. After spawn it is sent with the next tick's batch; before spawn, immediately. */
  queue<K extends keyof OutboundPackets>(name: K, params: OutboundPackets[K]): void;
  queue(name: string, params: AnyPacket): void;
  queue(name: string, params: object): void {
    if (this._state === 'spawned') {
      this.pending.push([name, params]);
    } else if (this.client) {
      this.client.queue(name, params);
    } else {
      this.log.warn(`dropping outbound ${name}: not connected`);
    }
  }

  /** Run `fn` on every tick of the 20 Hz driver while spawned. Returns an unsubscribe function. */
  onTick(fn: (tick: bigint) => void): () => void {
    this.tickHandlers.add(fn);
    return () => {
      this.tickHandlers.delete(fn);
    };
  }

  /** Called after every (re)spawn, once the handshake has been sent. */
  onSpawn(fn: () => void): () => void {
    this.spawnHandlers.add(fn);
    return () => {
      this.spawnHandlers.delete(fn);
    };
  }

  /** Called whenever a session ends, with the reason and whether a reconnect is scheduled. */
  onClose(fn: (info: CloseInfo) => void): () => void {
    this.closeHandlers.add(fn);
    return () => {
      this.closeHandlers.delete(fn);
    };
  }

  // ---- session lifecycle ----------------------------------------------------------------------

  private setState(s: ConnectionState): void {
    if (this._state !== s) this.log.debug(`state ${this._state} -> ${s}`);
    this._state = s;
  }

  private async attemptOnce(): Promise<void> {
    const target = this.target;
    if (!target || this.userClosed) return;
    const session = ++this.session;
    this.setState('connecting');
    this.recorder?.record('meta', 'connect', { host: target.host, port: target.port, transport: target.transport, version: this.version, attempt: this.attempt });

    let info: ServerInfo;
    try {
      info = await this.pingServer(target, this.pingTimeoutMs);
    } catch (e) {
      this.endSession(session, `ping failed: ${errorMessage(e)}`);
      return;
    }
    if (session !== this.session || this.userClosed) return;
    this._serverInfo = info;
    this.log.info(
      `server ${target.host}:${target.port} (${info.transport}) protocol ${info.protocol ?? '?'} version ${info.version ?? '?'} motd "${info.motd ?? ''}" level "${info.levelName ?? ''}"`,
    );
    const gate = checkVersion(this.version, info.protocol);
    if (!gate.ok) {
      this.fail(new VersionGateError(gate.message));
      return;
    }
    if (info.version) this._gameVersion = info.version;

    const opts: ClientOptions = {
      host: target.host,
      port: target.port,
      username: this.username,
      offline: true,
      version: this.version,
      transport: target.transport,
      raknetBackend: 'raknet-native',
      skipPing: true,
      viewDistance: this.viewDistance,
      conLog: (...args: unknown[]) => {
        this.log.debug(args.map(String).join(' '));
      },
    };
    if (target.transport === 'nethernet') opts.nethernet = { signalling: 'lan' };

    let client: ProtocolClient;
    try {
      client = this.makeClient(opts);
    } catch (e) {
      this.endSession(session, `createClient failed: ${errorMessage(e)}`);
      return;
    }
    this.client = client;
    this.attach(client, session);
    this.spawnTimer = setTimeout(() => {
      if (session === this.session && this._state !== 'spawned') {
        const reason = `no spawn within ${this.spawnTimeoutMs} ms`;
        this.lastReason.set(session, reason);
        client.close();
        this.endSession(session, reason);
      }
    }, this.spawnTimeoutMs);
  }

  private attach(client: ProtocolClient, session: number): void {
    const rec = this.recorder;
    const current = () => session === this.session;

    // Record outbound packets, including the ones bedrock-protocol sends on its own (login,
    // resource pack responses, latency echoes, set_local_player_as_initialized).
    const origWrite = client.write.bind(client);
    const origQueue = client.queue.bind(client);
    const recordOut = (name: string, params: object) => {
      if (!rec) return;
      let raw: Buffer | undefined;
      if (rec.includeRaw && client.serializer) {
        try {
          raw = client.serializer.createPacketBuffer({ name, params });
        } catch {
          raw = undefined;
        }
      }
      rec.record('out', name, params, this._tick, raw);
    };
    client.write = (name, params) => {
      recordOut(name, params);
      origWrite(name, params);
    };
    client.queue = (name, params) => {
      recordOut(name, params);
      origQueue(name, params);
    };

    client.on('packet', (des: { data: { name: string; params: unknown }; fullBuffer?: Buffer; buffer?: Buffer }) => {
      if (!current()) return;
      rec?.record('in', des.data.name, des.data.params, this._tick, des.fullBuffer ?? des.buffer);
    });

    // Spawn handshake (spike C): without it the server ignores all player input.
    client.on('start_game', (p: InboundPackets['start_game']) => {
      this._runtimeId = BigInt(p.runtime_entity_id);
    });
    client.on('respawn', (p: RespawnPacket) => {
      if (p.state !== 1) return;
      this._spawnPosition = { ...p.position };
      client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: this._runtimeId });
    });
    client.on('play_status', (p: InboundPackets['play_status']) => {
      if (p.status === 'player_spawn') {
        client.queue('serverbound_loading_screen', { type: 1 });
        client.queue('serverbound_loading_screen', { type: 2 });
      } else if (p.status !== 'login_success') {
        this.lastReason.set(session, `play_status ${p.status}`);
      }
    });
    client.on('spawn', () => {
      if (current()) this.onSpawned();
    });

    // Disconnect reasons.
    client.on('kick', (p: InboundPackets['disconnect']) => {
      const reason = `kicked: ${p.reason}${p.message ? ` "${p.message}"` : ''}`;
      this.lastReason.set(session, reason);
      this.log.warn(reason);
    });
    client.on('error', (e: Error) => {
      const reason = `error: ${errorMessage(e)}`;
      if (!this.lastReason.has(session)) this.lastReason.set(session, reason);
      this.log.warn(reason);
    });
    client.on('close', () => {
      this.endSession(session, this.lastReason.get(session) ?? 'connection closed');
    });

    // User packet handlers.
    for (const name of this.packetHandlers.keys()) this.attachName(client, name, session);
    this.attachedNames = new Set(this.packetHandlers.keys());
  }

  private attachName(client: ProtocolClient, name: string, session: number): void {
    client.on(name, (p: AnyPacket) => {
      if (session !== this.session) return;
      const set = this.packetHandlers.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(p);
        } catch (e) {
          this.log.error(`handler for ${name} threw: ${errorMessage(e)}`);
        }
      }
    });
  }

  private onSpawned(): void {
    clearTimeout(this.spawnTimer);
    this.attempt = 0;
    this.setState('spawned');
    this.log.info(`spawned as ${this.username} (runtime id ${this._runtimeId})`);
    this.startTicker();
    this.firstSpawn?.resolve();
    this.firstSpawn = undefined;
    for (const fn of [...this.spawnHandlers]) {
      try {
        fn();
      } catch (e) {
        this.log.error(`spawn handler threw: ${errorMessage(e)}`);
      }
    }
  }

  /** Session `session` is over (closed, kicked, failed to ping or to spawn). Idempotent. */
  private endSession(session: number, reason: string): void {
    if (session !== this.session || this._state === 'closed' || this.ending === session) return;
    this.ending = session;
    clearTimeout(this.spawnTimer);
    this.stopTicker();
    this.pending = [];
    this.client = undefined;
    this.lastReason.delete(session);
    this.recorder?.record('meta', 'close', { reason }, this._tick);

    const policy = this.reconnectPolicy;
    if (this.userClosed) {
      this.setState('closed');
      this.log.info(`disconnected (${reason})`);
      this.firstSpawn?.reject(new Error(`disconnected before spawn: ${reason}`));
      this.firstSpawn = undefined;
      this.emitClose({ reason, willReconnect: false });
      return;
    }
    if (!policy.enabled || this.attempt >= policy.maxAttempts) {
      this.fail(new Error(`connection lost: ${reason}`), reason);
      return;
    }
    const delay = backoffDelay(this.attempt, policy);
    this.attempt++;
    this.setState('connecting');
    this.log.warn(`connection lost (${reason}); reconnect attempt ${this.attempt} in ${delay} ms`);
    this.emitClose({ reason, willReconnect: true, retryInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attemptOnce();
    }, delay);
  }

  /** Terminal failure: no reconnect. */
  private fail(err: Error, reason = err.message): void {
    clearTimeout(this.spawnTimer);
    clearTimeout(this.reconnectTimer);
    this.stopTicker();
    const client = this.client;
    this.client = undefined;
    this.ending = this.session;
    client?.close();
    this.setState('closed');
    this.log.error(err.message);
    this.firstSpawn?.reject(err);
    this.firstSpawn = undefined;
    this.emitClose({ reason, willReconnect: false });
  }

  private emitClose(info: CloseInfo): void {
    for (const fn of [...this.closeHandlers]) {
      try {
        fn(info);
      } catch (e) {
        this.log.error(`close handler threw: ${errorMessage(e)}`);
      }
    }
  }

  // ---- 20 Hz driver -------------------------------------------------------------------------

  private startTicker(): void {
    this.stopTicker();
    this._tick = 0n;
    let next = performance.now() + TICK_MS;
    const step = () => {
      if (this._state !== 'spawned') return;
      this._tick++;
      for (const fn of [...this.tickHandlers]) {
        try {
          fn(this._tick);
        } catch (e) {
          this.log.error(`tick handler threw: ${errorMessage(e)}`);
        }
      }
      this.flush();
      next += TICK_MS;
      const now = performance.now();
      // Fell far behind (event loop stall): skip the missed ticks instead of bursting.
      if (now - next > 5 * TICK_MS) next = now + TICK_MS;
      this.tickTimer = setTimeout(step, Math.max(0, next - now));
    };
    this.tickTimer = setTimeout(step, TICK_MS);
  }

  private stopTicker(): void {
    clearTimeout(this.tickTimer);
    this.tickTimer = undefined;
  }

  private flush(): void {
    const client = this.client;
    if (!client || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    for (const [name, params] of batch) client.queue(name, params);
  }
}
