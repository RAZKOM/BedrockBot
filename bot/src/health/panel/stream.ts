// The panel's push channel (docs/panel.md "Live updates" and "Add a topic", decision 0061): GET
// /api/stream as Server-Sent Events behind the panel's token / cookie (the auth hook runs before every
// route). One hub per panel; modules register topics and publish, the hub does the rest:
//
//   const t = hub.topic('events', { kind: 'event' });       // every publish is one message
//   t.publish({ at: Date.now(), text: 'chest emptied' });
//   hub.topic('state', { kind: 'state', read: () => liteState(state()), sampleMs: 1000 });
//                                                           // a snapshot on connect, then deltas
//
//   kind 'state'  the hub keeps the last value; publish(v) (or the sampler, every sampleMs while a
//                 stream listens) sends only what changed (client/delta.ts ops, or the snapshot when
//                 that is shorter); a new stream gets the current value as a snapshot.
//   kind 'event'  publish(v) sends v; nothing is kept but the replay ring.
//
// Every message has a monotonic id `<boot>.<seq>`; a reconnect with Last-Event-ID (or ?last=<id>)
// replays what it missed from a bounded ring when it can, else it gets `hello {resumed: false}` and a
// snapshot of each state topic. A quiet stream gets a heartbeat every HEARTBEAT_MS; a client whose
// socket buffer grows past maxBuffered is dropped (it reconnects and resumes), and at most maxClients
// streams are open (503 beyond: the page polls instead).
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { silentLogger, type Logger } from '../../log.ts';
import { diffJson, type Json } from './client/delta.ts';
import { HEARTBEAT_EVENT, HEARTBEAT_MS, HELLO_EVENT, STREAM_PATH, type StreamHello } from './shared.ts';
import type { HealthRoute } from '../map/routes.ts';

export interface TopicOptions {
  kind: 'state' | 'event';
  /** state: the current value, read when a stream subscribes and every sampleMs while one listens. */
  read?: () => unknown;
  /** state: sample read() this often while a stream listens (absent: only on publish / refresh). */
  sampleMs?: number;
  /** Bytes one message may take (state: a snapshot); over it the hub logs a warning once (docs/panel.md "Budgets"). */
  budget?: number;
  /** state: bytes one delta may take (warning once over it). */
  deltaBudget?: number;
}

export interface Topic {
  readonly name: string;
  /** state: the new full value (only the change is sent); event: one message. */
  publish(value: unknown): void;
  /** state: read() now and publish it (after a command, say). */
  refresh(): void;
}

export interface StreamHubOptions {
  /** Streams open at once (default 8); beyond: 503. */
  maxClients?: number;
  /** Bytes a client's socket may hold unsent before it is dropped (default 256 KiB). */
  maxBuffered?: number;
  /** Messages kept for resuming (default 512) and their bytes (default 1 MiB). */
  ring?: number;
  ringBytes?: number;
  heartbeatMs?: number;
  /** The EventSource reconnect delay the server asks for (default 2000 ms). */
  retryMs?: number;
  log?: Logger;
  /** Fixed boot id (tests); default random. */
  boot?: string;
}

export interface StreamStats {
  clients: number;
  /** Streams opened, refused (cap), dropped (slow), resumed (replayed instead of a snapshot). */
  opened: number;
  refused: number;
  dropped: number;
  resumed: number;
  /** Messages and bytes written to sockets. */
  messages: number;
  bytes: number;
  seq: number;
  /** Per topic: messages published, the last and largest message bytes, snapshots sent. */
  topics: Record<string, { published: number; lastBytes: number; maxBytes: number; maxDelta: number; snapshots: number; lastSnapshotBytes: number }>;
}

interface Client {
  res: ServerResponse;
  topics: Set<string>;
  lastWrite: number;
}

interface RingEntry {
  seq: number;
  topic: string;
  text: string;
}

interface TopicState {
  name: string;
  opts: TopicOptions;
  last?: Json;
  /** JSON of `last` (the snapshot's data). */
  lastText?: string;
  timer?: NodeJS.Timeout;
  warned: Set<string>;
  stats: StreamStats['topics'][string];
}

const bigintSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

/** `<boot>.<seq>` -> its parts (undefined for anything else). */
export function parseEventId(id: string | undefined): { boot: string; seq: number } | undefined {
  const m = /^([A-Za-z0-9_-]{1,32})\.(\d{1,15})$/.exec(id ?? '');
  return m ? { boot: m[1]!, seq: Number(m[2]) } : undefined;
}

export class StreamHub {
  readonly boot: string;
  private readonly o: Required<Omit<StreamHubOptions, 'log' | 'boot'>>;
  private readonly log: Logger;
  private readonly topics = new Map<string, TopicState>();
  private readonly clients = new Set<Client>();
  private readonly ring: RingEntry[] = [];
  private ringBytes = 0;
  private seq = 0;
  private hb: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly counts = { opened: 0, refused: 0, dropped: 0, resumed: 0, messages: 0, bytes: 0 };

  constructor(opts: StreamHubOptions = {}) {
    this.boot = opts.boot ?? randomBytes(6).toString('base64url');
    this.log = opts.log ?? silentLogger;
    this.o = {
      maxClients: opts.maxClients ?? 8,
      maxBuffered: opts.maxBuffered ?? 256 * 1024,
      ring: opts.ring ?? 512,
      ringBytes: opts.ringBytes ?? 1024 * 1024,
      heartbeatMs: opts.heartbeatMs ?? HEARTBEAT_MS,
      retryMs: opts.retryMs ?? 2000,
    };
  }

  /** Register a topic (once per name); the returned handle publishes. */
  topic(name: string, opts: TopicOptions): Topic {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`stream topic name ${name}: a-z 0-9 _ - (32 at most)`);
    if (this.topics.has(name) || name === HELLO_EVENT || name === HEARTBEAT_EVENT) throw new Error(`stream topic ${name} exists`);
    if (opts.kind === 'state' && !opts.read && opts.sampleMs) throw new Error(`stream topic ${name}: sampleMs needs read`);
    const t: TopicState = { name, opts, warned: new Set(), stats: { published: 0, lastBytes: 0, maxBytes: 0, maxDelta: 0, snapshots: 0, lastSnapshotBytes: 0 } };
    this.topics.set(name, t);
    return {
      name,
      publish: (v) => this.publish(name, v),
      refresh: () => this.refresh(name),
    };
  }

  /** Names of the registered topics. */
  topicNames(): string[] {
    return [...this.topics.keys()];
  }

  /** Publish on a registered topic (state: the full new value; event: one message). */
  publish(name: string, value: unknown): void {
    const t = this.topics.get(name);
    if (!t) throw new Error(`stream topic ${name} is not registered`);
    if (this.closed) return;
    if (t.opts.kind === 'event') {
      this.emit(t, JSON.stringify(value, bigintSafe) ?? 'null');
      return;
    }
    const next = JSON.parse(JSON.stringify(value, bigintSafe) ?? 'null') as Json;
    const nextText = JSON.stringify(next);
    const prev = t.last;
    t.last = next;
    t.lastText = nextText;
    if (prev === undefined) {
      this.emit(t, `{"snap":${nextText}}`);
      return;
    }
    const ops = diffJson(prev, next);
    if (ops.length === 0) return;
    const delta = `{"d":${JSON.stringify(ops)}}`;
    const data = delta.length < nextText.length + 9 ? delta : `{"snap":${nextText}}`;
    if (data === delta) {
      t.stats.maxDelta = Math.max(t.stats.maxDelta, delta.length);
      if (t.opts.deltaBudget && delta.length > t.opts.deltaBudget) this.warnOnce(t, 'delta', delta.length, t.opts.deltaBudget);
    }
    this.emit(t, data);
  }

  /** state: read the value now and publish it. */
  refresh(name: string): void {
    const t = this.topics.get(name);
    if (!t?.opts.read || this.closed) return;
    let v: unknown;
    try {
      v = t.opts.read();
    } catch (e) {
      this.log.warn(`panel: stream topic ${name}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.publish(name, v);
  }

  stats(): StreamStats {
    return { clients: this.clients.size, ...this.counts, seq: this.seq, topics: Object.fromEntries([...this.topics.values()].map((t) => [t.name, { ...t.stats }])) };
  }

  /** The GET /api/stream route (mount it after the auth hook, like every panel route). */
  route(): HealthRoute {
    return (path, req, res) => {
      if (path !== STREAM_PATH) return false;
      this.open(req, res);
      return true;
    };
  }

  /** Answer one stream request. */
  open(req: IncomingMessage, res: ServerResponse): void {
    const json = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
      res.end(`${JSON.stringify(body)}\n`);
    };
    if (req.method !== 'GET') return json(405, { error: 'GET only (text/event-stream)' });
    if (this.closed) return json(503, { error: 'the panel is stopping' });
    const url = new URL(req.url ?? STREAM_PATH, 'http://panel');
    const asked = url.searchParams.get('topics');
    const topics = new Set(asked === null ? this.topics.keys() : asked.split(',').filter((n) => this.topics.has(n)));
    if (topics.size === 0) return json(400, { error: `no such topic; there are: ${this.topicNames().join(', ')}` });
    if (this.clients.size >= this.o.maxClients) {
      this.counts.refused++;
      return json(503, { error: `too many streams (${this.o.maxClients}); the page polls instead` }, { 'retry-after': '30' });
    }
    const header = req.headers['last-event-id'];
    const last = parseEventId((Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('last') ?? undefined);

    // the latest of every state topic first, so a replay ends where a snapshot would
    for (const n of topics) if (this.topics.get(n)!.opts.kind === 'state') this.refresh(n);
    const replay = this.replayAfter(last, topics);

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    req.socket.setNoDelay(true);
    const c: Client = { res, topics, lastWrite: Date.now() };
    this.clients.add(c);
    this.counts.opened++;
    const done = (): void => this.remove(c);
    res.on('close', done);
    res.on('error', done);
    const hello: StreamHello = { boot: this.boot, resumed: replay !== undefined, topics: [...topics], hb: this.o.heartbeatMs };
    let head = `retry: ${this.o.retryMs}\n\nevent: ${HELLO_EVENT}\ndata: ${JSON.stringify(hello)}\n\n`;
    if (replay) {
      this.counts.resumed++;
      for (const e of replay) head += e.text;
    } else {
      for (const n of topics) {
        const t = this.topics.get(n)!;
        if (t.opts.kind !== 'state' || t.lastText === undefined) continue;
        const msg = `{"snap":${t.lastText}}`;
        t.stats.snapshots++;
        t.stats.lastSnapshotBytes = msg.length;
        if (t.opts.budget && msg.length > t.opts.budget) this.warnOnce(t, 'snapshot', msg.length, t.opts.budget);
        head += `id: ${this.boot}.${this.seq}\nevent: ${n}\ndata: ${msg}\n\n`;
      }
    }
    this.write(c, head, 1 + (replay?.length ?? topics.size));
    this.timers();
  }

  /** End every stream and stop the timers (the panel stops). */
  close(): void {
    this.closed = true;
    for (const c of [...this.clients]) {
      c.res.end();
      this.remove(c);
    }
    this.timers();
  }

  // ---- internals -----------------------------------------------------------------------------------

  private replayAfter(last: { boot: string; seq: number } | undefined, topics: Set<string>): RingEntry[] | undefined {
    if (last?.boot !== this.boot || last.seq > this.seq) return undefined;
    const oldest = this.ring.length ? this.ring[0]!.seq : this.seq + 1;
    if (last.seq < oldest - 1) return undefined; // the ring lost messages after `last`
    return this.ring.filter((e) => e.seq > last.seq && topics.has(e.topic));
  }

  private emit(t: TopicState, data: string): void {
    this.seq++;
    const text = `id: ${this.boot}.${this.seq}\nevent: ${t.name}\ndata: ${data}\n\n`;
    t.stats.published++;
    t.stats.lastBytes = data.length;
    t.stats.maxBytes = Math.max(t.stats.maxBytes, data.length);
    if (t.opts.budget && t.opts.kind === 'event' && data.length > t.opts.budget) this.warnOnce(t, 'message', data.length, t.opts.budget);
    this.ring.push({ seq: this.seq, topic: t.name, text });
    this.ringBytes += text.length;
    while (this.ring.length > this.o.ring || (this.ringBytes > this.o.ringBytes && this.ring.length > 1)) this.ringBytes -= this.ring.shift()!.text.length;
    for (const c of [...this.clients]) if (c.topics.has(t.name)) this.write(c, text, 1);
  }

  private write(c: Client, text: string, messages: number): void {
    const res = c.res;
    if (res.destroyed || res.writableEnded) {
      this.remove(c);
      return;
    }
    res.write(text);
    c.lastWrite = Date.now();
    this.counts.messages += messages;
    this.counts.bytes += text.length;
    if (res.writableLength > this.o.maxBuffered) {
      this.counts.dropped++;
      this.log.warn(`panel: stream dropped: ${res.writableLength} bytes unsent (a slow client; it reconnects and resumes)`);
      this.remove(c);
      res.destroy();
    }
  }

  private remove(c: Client): void {
    if (!this.clients.delete(c)) return;
    this.timers();
  }

  /** Samplers and the heartbeat run only while a stream listens. */
  private timers(): void {
    const any = this.clients.size > 0 && !this.closed;
    for (const t of this.topics.values()) {
      const want = any && !!t.opts.sampleMs && [...this.clients].some((c) => c.topics.has(t.name));
      if (want && !t.timer) {
        t.timer = setInterval(() => this.refresh(t.name), t.opts.sampleMs);
        t.timer.unref();
      } else if (!want && t.timer) {
        clearInterval(t.timer);
        t.timer = undefined;
      }
    }
    if (any && !this.hb) {
      this.hb = setInterval(() => this.heartbeat(), Math.max(50, Math.floor(this.o.heartbeatMs / 2)));
      this.hb.unref();
    } else if (!any && this.hb) {
      clearInterval(this.hb);
      this.hb = undefined;
    }
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const c of [...this.clients]) if (now - c.lastWrite >= this.o.heartbeatMs) this.write(c, `event: ${HEARTBEAT_EVENT}\ndata: ${now}\n\n`, 1);
  }

  private warnOnce(t: TopicState, what: string, bytes: number, budget: number): void {
    if (t.warned.has(what)) return;
    t.warned.add(what);
    this.log.warn(`panel: stream ${t.name} ${what} ${bytes} bytes, over its budget of ${budget} (docs/panel.md "Budgets")`);
  }
}
