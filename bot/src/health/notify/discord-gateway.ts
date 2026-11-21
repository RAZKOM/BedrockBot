// The Discord gateway for the bot (Track D1, ADR 0118, docs/discord.md "The connection"): one outbound websocket over
// Node's own WebSocket (no package), API v10, JSON, no compression. It receives the messages and the button presses;
// everything the bot sends goes over REST (discord-rest.ts).
//
//   const gw = new DiscordGateway({ token, url: () => rest.call('GET', '/gateway/bot'), intents: DISCORD_INTENTS, onDispatch });
//   gw.start();   gw.status();   gw.stop();
//
// The protocol (Discord's developer documentation; no test contacts Discord, so these are the documented values):
// - HELLO (op 10) gives the heartbeat interval; the first heartbeat (op 1, the last sequence number) goes after
//   interval * a random 0..1 (the jitter, so many clients do not beat together), then one every interval;
// - a heartbeat with the last one not acknowledged (op 11) means a dead link: the socket is closed with 4000 (not 1000,
//   which would end the session) and the session resumed;
// - IDENTIFY (op 2) with the token and the intents; READY gives the session id, the resume URL and the bot's user id;
// - RESUME (op 6) on the resume URL with the session id and the last sequence after a lost link; RESUMED, or INVALID
//   SESSION (op 9: d true resume again, false identify anew, after 1 to 5 s);
// - RECONNECT (op 7) and a server heartbeat request (op 1) are obeyed;
// - close codes 4004 (the token refused), 4010 to 4014 (shards, API version, intents; 4014 the Message Content intent
//   not switched on in the developer portal) stop for good until the token or the switch changes; 4007 and 4009 drop
//   the session; any other close resumes.
// The bot's own limits: a reconnect waits a backoff (BACKOFF_BASE_MS doubling to BACKOFF_MAX_MS, times 0.5 to 1 random);
// no HELLO within HELLO_TIMEOUT_MS closes and backs off; at most IDENTIFY_MAX new sessions a day (Discord allows 1 000;
// a loop of new sessions stops here, a resume does not count); at most SEND_MAX frames a minute (Discord allows 120);
// a frame over FRAME_MAX characters is dropped; every handler is caught, nothing is thrown into the bot.
import type { Logger } from '../../log.ts';

/** GUILD_MESSAGES (1 << 9), DIRECT_MESSAGES (1 << 12), MESSAGE_CONTENT (1 << 15, privileged: switched on in the portal). */
export const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
/**
 * Track D3: with text commands off (`discordText off`) the bot asks for no intent at all: slash commands and button
 * presses arrive as INTERACTION_CREATE whatever the intents, and no message is read, so the privileged Message Content
 * intent need not be switched on.
 */
export const SLASH_ONLY_INTENTS = 0;
export const GATEWAY_QUERY = '?v=10&encoding=json';
export const HELLO_TIMEOUT_MS = 15_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const IDENTIFY_MAX = 20;
export const IDENTIFY_WINDOW_MS = 24 * 3600_000;
export const SEND_MAX = 100;
export const FRAME_MAX = 4_000_000;

/** Close codes that end the gateway until the token or the switch changes, and what each means for the user. */
export const FATAL_CLOSE: Readonly<Record<number, string>> = {
  4004: 'the token was refused (4004): make a new one in the developer portal',
  4010: 'invalid shard (4010)',
  4011: 'sharding required (4011): the bot is in too many servers for one connection',
  4012: 'invalid API version (4012)',
  4013: 'invalid intents (4013)',
  4014: 'disallowed intents (4014): switch on the Message Content intent for the bot in the developer portal, or !set discordText off (slash commands only)',
};

/** What the gateway needs of a websocket (Node's own WebSocket has it; tests pass a fake). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WsFactory = (url: string) => WsLike;

export type GatewayState = 'off' | 'connecting' | 'identifying' | 'resuming' | 'ready' | 'waiting' | 'stopped';

export interface GatewayStatus {
  state: GatewayState;
  since: number;
  /** Why it stopped (a fatal close, no token, too many sessions). */
  why: string | null;
  /** The bot's own user id (READY). */
  self: string | null;
  /** Track D3: the application's id (READY's `application.id`). */
  app: string | null;
  /** Track D3: the servers the bot is in (READY's `guilds`, ids only), null before the first READY. */
  guilds: string[] | null;
  /** Track D3: the intents of the session (IDENTIFY). */
  intents: number;
  sessions: number;
  resumes: number;
  reconnects: number;
  lastClose: string | null;
  /** The last heartbeat's round trip. */
  latencyMs: number | null;
  received: number;
  sent: number;
}

export interface GatewayOptions {
  /** The token now (undefined: none). */
  token: () => string | undefined;
  /** The gateway URL (GET /gateway/bot's `url`); validated by `allowUrl`. */
  url: () => Promise<string | undefined>;
  /** Only URLs this accepts are connected to (wss on discord.gg, or the tests' loopback). */
  allowUrl: (url: string) => boolean;
  /** Track D3: read at each IDENTIFY (the `discordText` switch changes it; the bot reconnects when it does). */
  intents: number | (() => number);
  onDispatch: (t: string, d: unknown) => void;
  onState?: (s: GatewayState) => void;
  ws?: WsFactory;
  log?: Logger;
  now?: () => number;
  random?: () => number;
  backoffBaseMs?: number;
  /** The `properties` of IDENTIFY. */
  name?: string;
}

interface Frame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/** wss on a discord.gg host (the gateway and its regional resume URLs), no port, user or query of its own. */
export function discordGatewayUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    return u.protocol === 'wss:' && (h === 'gateway.discord.gg' || h.endsWith('.discord.gg')) && u.port === '' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

/** The tests' gateway: ws on the loopback at the test origin's port. */
export function loopbackGatewayUrl(raw: string, origin: string): boolean {
  try {
    const u = new URL(raw);
    const o = new URL(origin);
    return u.protocol === 'ws:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === o.port;
  } catch {
    return false;
  }
}

export class DiscordGateway {
  private readonly o: GatewayOptions;
  private ws: WsLike | undefined;
  private st: GatewayState = 'off';
  private since: number;
  private why: string | null = null;
  private seq: number | null = null;
  private session: string | undefined;
  private resumeUrl: string | undefined;
  private self: string | null = null;
  private app: string | null = null;
  private guilds: string[] | null = null;
  private intentsSent = 0;
  private interval = 0;
  private acked = true;
  private beatAt = 0;
  private latency: number | null = null;
  private beatTimer: NodeJS.Timeout | undefined;
  private helloTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private identifies: number[] = [];
  private sends: number[] = [];
  private running = false;
  private gen = 0; // the socket generation: events of an old socket are ignored
  private readonly counts = { sessions: 0, resumes: 0, reconnects: 0, received: 0, sent: 0 };
  private lastClose: string | null = null;

  constructor(o: GatewayOptions) {
    this.o = o;
    this.since = this.now();
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private rand(): number {
    try {
      return this.o.random?.() ?? Math.random();
    } catch {
      return Math.random();
    }
  }

  private set(s: GatewayState, why: string | null = null): void {
    if (this.st !== s) this.since = this.now();
    this.st = s;
    this.why = why;
    try {
      this.o.onState?.(s);
    } catch {
      // the listener's fault
    }
  }

  status(): GatewayStatus {
    return { state: this.st, since: this.since, why: this.why, self: this.self, app: this.app, guilds: this.guilds ? [...this.guilds] : null, intents: this.intentsSent, ...this.counts, lastClose: this.lastClose, latencyMs: this.latency };
  }

  /** Track D3: the intents the next IDENTIFY sends. */
  intents(): number {
    try {
      return typeof this.o.intents === 'function' ? this.o.intents() : this.o.intents;
    } catch {
      return 0;
    }
  }

  /** Connect (identify, or resume a session this object holds). Idempotent while running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    void this.connect();
  }

  /** Close for good (1000: the session ends; the bot shows offline). */
  stop(why = 'off'): void {
    this.running = false;
    this.clearTimers();
    this.gen++;
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1000, 'bye');
    } catch {
      // closed already
    }
    this.session = undefined;
    this.resumeUrl = undefined;
    this.seq = null;
    this.set(why === 'off' ? 'off' : 'stopped', why === 'off' ? null : why);
  }

  private clearTimers(): void {
    clearTimeout(this.beatTimer);
    clearTimeout(this.helloTimer);
    clearTimeout(this.retryTimer);
    this.beatTimer = this.helloTimer = this.retryTimer = undefined;
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const token = this.o.token();
    if (!token) {
      this.running = false;
      this.set('stopped', 'no token');
      return;
    }
    const resume = this.session !== undefined && this.resumeUrl !== undefined;
    if (!resume) {
      const now = this.now();
      this.identifies = this.identifies.filter((t) => now - t < IDENTIFY_WINDOW_MS);
      if (this.identifies.length >= IDENTIFY_MAX) {
        this.running = false;
        this.set('stopped', `${IDENTIFY_MAX} new sessions in 24 h: stopped so a loop cannot use up Discord's daily limit (!set discordBot off, then on)`);
        this.o.log?.warn(`discord bot: ${this.why}`);
        return;
      }
    }
    this.set('connecting');
    let base: string | undefined;
    try {
      base = resume ? this.resumeUrl : await this.o.url();
    } catch {
      base = undefined;
    }
    if (!this.running) return;
    if (!base) {
      this.lastClose = 'no gateway URL from Discord';
      this.backoff();
      return;
    }
    if (!this.o.allowUrl(base)) {
      this.running = false;
      this.set('stopped', 'the gateway URL is not Discord\'s (refused: the token goes only to Discord)');
      this.o.log?.error(`discord bot: ${this.why}`);
      return;
    }
    const url = `${base.replace(/\/+$/, '')}/${GATEWAY_QUERY}`;
    const g = ++this.gen;
    let ws: WsLike;
    try {
      const make: WsFactory = this.o.ws ?? ((u) => new WebSocket(u) as unknown as WsLike);
      ws = make(url);
    } catch (e) {
      this.lastClose = `connect failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
      this.backoff();
      return;
    }
    this.ws = ws;
    this.acked = true;
    this.helloTimer = setTimeout(() => {
      if (g !== this.gen) return;
      this.lastClose = `no HELLO in ${HELLO_TIMEOUT_MS / 1000} s`;
      this.drop(4000);
    }, HELLO_TIMEOUT_MS);
    this.helloTimer.unref?.();
    ws.onmessage = (ev) => {
      if (g !== this.gen) return;
      try {
        this.onFrame(ev.data, resume);
      } catch (e) {
        this.o.log?.warn(`discord bot: a gateway frame failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
      }
    };
    ws.onclose = (ev) => {
      if (g !== this.gen) return;
      try {
        this.onClose(ev?.code ?? 1006, String(ev?.reason ?? ''));
      } catch {
        // never thrown into the bot
      }
    };
    ws.onerror = () => {
      // the close event follows; nothing to do here
    };
  }

  private sendFrame(f: Frame): void {
    const ws = this.ws;
    if (ws?.readyState !== 1) return;
    const now = this.now();
    this.sends = this.sends.filter((t) => now - t < 60_000);
    if (this.sends.length >= SEND_MAX && f.op !== 1) return; // heartbeats always go
    this.sends.push(now);
    try {
      ws.send(JSON.stringify(f));
      this.counts.sent++;
    } catch {
      // the close follows
    }
  }

  private onFrame(data: unknown, resume: boolean): void {
    if (typeof data !== 'string' || data.length > FRAME_MAX) return;
    const f = JSON.parse(data) as Frame;
    this.counts.received++;
    if (typeof f.s === 'number') this.seq = f.s;
    switch (f.op) {
      case 10: {
        clearTimeout(this.helloTimer);
        const iv = Number((f.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval);
        this.interval = Number.isFinite(iv) && iv >= 1000 ? iv : 41_250;
        this.schedule(this.interval * this.rand());
        const token = this.o.token();
        if (!token) {
          this.stop('no token');
          return;
        }
        if (resume && this.session) {
          this.set('resuming');
          this.sendFrame({ op: 6, d: { token, session_id: this.session, seq: this.seq } });
        } else {
          this.set('identifying');
          this.identifies.push(this.now());
          this.counts.sessions++;
          this.intentsSent = this.intents();
          this.sendFrame({ op: 2, d: { token, intents: this.intentsSent, properties: { os: process.platform, browser: this.o.name ?? 'bedrockbot', device: this.o.name ?? 'bedrockbot' } } });
        }
        return;
      }
      case 11:
        this.acked = true;
        this.latency = Math.max(0, this.now() - this.beatAt);
        return;
      case 1:
        this.beat(true);
        return;
      case 7:
        this.lastClose = 'Discord asked for a reconnect (op 7)';
        this.drop(4000);
        return;
      case 9: {
        const resumable = f.d === true;
        if (!resumable) {
          this.session = undefined;
          this.resumeUrl = undefined;
          this.seq = null;
        }
        this.lastClose = `invalid session (${resumable ? 'resumable' : 'new session'})`;
        this.drop(4000, 1000 + this.rand() * 4000);
        return;
      }
      case 0:
        this.dispatch(f.t ?? '', f.d);
    }
  }

  private dispatch(t: string, d: unknown): void {
    if (t === 'READY') {
      const r = d as { session_id?: unknown; resume_gateway_url?: unknown; user?: { id?: unknown }; application?: { id?: unknown }; guilds?: unknown } | undefined;
      this.session = typeof r?.session_id === 'string' ? r.session_id : undefined;
      this.resumeUrl = typeof r?.resume_gateway_url === 'string' && this.o.allowUrl(r.resume_gateway_url) ? r.resume_gateway_url : undefined;
      this.self = typeof r?.user?.id === 'string' ? r.user.id : null;
      this.app = typeof r?.application?.id === 'string' ? r.application.id : this.self; // Track D3
      this.guilds = Array.isArray(r?.guilds) ? (r.guilds as { id?: unknown }[]).map((g) => g?.id).filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
      this.attempt = 0;
      this.set('ready');
    } else if (t === 'RESUMED') {
      this.counts.resumes++;
      this.attempt = 0;
      this.set('ready');
    }
    try {
      this.o.onDispatch(t, d);
    } catch (e) {
      this.o.log?.warn(`discord bot: ${t} failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }

  private schedule(ms: number): void {
    clearTimeout(this.beatTimer);
    const g = this.gen;
    this.beatTimer = setTimeout(() => {
      if (g === this.gen) this.beat(false);
    }, Math.max(0, ms));
    this.beatTimer.unref?.();
  }

  /** A heartbeat; the last one unanswered closes the link (it is dead) and resumes. */
  private beat(asked: boolean): void {
    if (!asked && !this.acked) {
      this.lastClose = 'no heartbeat ACK';
      this.drop(4000);
      return;
    }
    this.acked = false;
    this.beatAt = this.now();
    this.sendFrame({ op: 1, d: this.seq });
    if (!asked) this.schedule(this.interval);
  }

  /** Close this socket ourselves and reconnect (resume when a session is held). */
  private drop(code: number, delayMs?: number): void {
    this.gen++;
    clearTimeout(this.beatTimer);
    clearTimeout(this.helloTimer);
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(code, 'reconnect');
    } catch {
      // closed already
    }
    this.counts.reconnects++;
    if (delayMs !== undefined) this.later(delayMs);
    else this.backoff();
  }

  private onClose(code: number, reason: string): void {
    this.clearTimers();
    this.ws = undefined;
    this.lastClose = `closed ${code}${reason ? ` ${reason.slice(0, 80)}` : ''}`;
    if (!this.running) return;
    const fatal = FATAL_CLOSE[code];
    if (fatal) {
      this.running = false;
      this.session = undefined;
      this.set('stopped', fatal);
      this.o.log?.warn(`discord bot: ${fatal}; not reconnecting until the token or discordBot changes (docs/discord.md)`);
      return;
    }
    if (code === 4007 || code === 4009) {
      this.session = undefined;
      this.resumeUrl = undefined;
      this.seq = null;
    }
    this.counts.reconnects++;
    this.backoff();
  }

  private backoff(): void {
    const base = this.o.backoffBaseMs ?? BACKOFF_BASE_MS;
    const ms = Math.min(BACKOFF_MAX_MS, base * 2 ** Math.min(this.attempt, 12)) * (0.5 + 0.5 * this.rand());
    this.attempt++;
    this.later(ms);
  }

  private later(ms: number): void {
    if (!this.running) return;
    this.set('waiting');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, Math.max(0, ms));
    this.retryTimer.unref?.();
  }
}
