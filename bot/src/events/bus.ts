// The event bus (decision 0059, docs/events.md): `events.emit(kind, data)` records one event. It never
// blocks and never throws into the caller: the event gets the next id, goes into the in-memory ring
// (the recent ones), to every subscriber and to the sink (the JSONL store, store.ts) that writes it
// later in a batch. A payload that does not fit its schema is logged once per kind and kept (strict
// mode, the unit tests, throws instead). A kind that fires more than RATE_PER_MIN times a minute is a
// bug at the seam: the extra ones are counted and dropped, so a loop cannot fill the disk.
import { silentLogger, type Logger } from '../log.ts';
import { checkPayload, eventDef, type BotEvent, type EventData, type EventKind } from './registry.ts';
import { queryRing, type EventQuery, type QueryResult } from './query.ts';

/** Where recorded events go besides the ring (store.ts EventStore). */
export interface EventSink {
  append(e: BotEvent): void;
  /** Events matching the query from disk plus what is waiting to be written; undefined = cannot (memory only now). */
  query(q: EventQuery): Promise<QueryResult | undefined>;
  close(): Promise<void>;
}

export type EventListener = (e: BotEvent) => void;

/** Events kept in memory (the ring). */
export const RING_SIZE = 2000;
/** Per kind and minute; more is a bug at the emitting site (counted in stats.dropped). */
export const RATE_PER_MIN = 120;

export class EventBus {
  private ring: BotEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private sink: EventSink | undefined;
  private nextId = 1;
  private log: Logger = silentLogger;
  private readonly warned = new Set<string>();
  private readonly rate = new Map<EventKind, { minute: number; n: number }>();
  /** Throw on an invalid payload or a rate overflow (unit tests). */
  strict = false;
  readonly stats = { emitted: 0, invalid: 0, dropped: {} as Partial<Record<EventKind, number>> };
  readonly ringSize: number;
  now: () => number = Date.now;

  constructor(ringSize = RING_SIZE) {
    this.ringSize = ringSize;
  }

  /** Record one event. Returns it (undefined when it was dropped by the rate guard). */
  emit<K extends EventKind>(kind: K, data: EventData<K>): BotEvent<K> | undefined {
    const ts = this.now();
    const minute = Math.floor(ts / 60_000);
    const r = this.rate.get(kind);
    if (r?.minute === minute) {
      if (++r.n > RATE_PER_MIN) {
        this.stats.dropped[kind] = (this.stats.dropped[kind] ?? 0) + 1;
        if (this.strict) throw new Error(`events: ${kind} fired more than ${RATE_PER_MIN} times in a minute`);
        this.warnOnce(`rate:${kind}`, `events: ${kind} fires more than ${RATE_PER_MIN} times a minute; dropping the rest this minute (a bug at the emitting site)`);
        return undefined;
      }
    } else {
      this.rate.set(kind, { minute, n: 1 });
    }
    const def = eventDef(kind);
    const problem = checkPayload(kind, data);
    if (problem) {
      this.stats.invalid++;
      if (this.strict) throw new Error(`events: ${kind} payload does not fit its schema: ${problem}`);
      this.warnOnce(`schema:${kind}`, `events: ${kind} payload does not fit its schema (${problem}); kept as it is`);
    }
    const e: BotEvent<K> = { id: this.nextId++, ts, kind, sev: def.severity, data };
    this.stats.emitted++;
    this.ring.push(e);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch (err) {
        this.warnOnce(`listener:${String(err)}`, `events: a subscriber threw on ${kind}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      this.sink?.append(e);
    } catch (err) {
      this.warnOnce('sink', `events: the store refused an event: ${err instanceof Error ? err.message : String(err)}`);
    }
    return e;
  }

  /** Every event from now on (after the ring and before the store write). Returns the unsubscribe. */
  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** The ring, oldest first. */
  recent(): readonly BotEvent[] {
    return this.ring;
  }

  /**
   * Attach the store: ids continue after `lastId` (the newest stored one), later events are written
   * there. `log` gets the bus's own warnings.
   */
  attach(sink: EventSink | undefined, opts: { lastId?: number; log?: Logger } = {}): void {
    this.sink = sink;
    if (opts.log) this.log = opts.log;
    const first = this.ring[0]?.id ?? this.nextId;
    if (opts.lastId !== undefined && opts.lastId >= first) {
      const shift = opts.lastId + 1 - first;
      // events emitted before the store opened (rare: start-up) are renumbered after the stored ones
      for (const e of this.ring) e.id += shift;
      this.nextId += shift;
    }
  }

  /**
   * Events matching `q`: from the ring when it covers the range (it holds every event after its
   * oldest one), else from the store (disk plus the unwritten queue), else what the ring has.
   */
  async query(q: EventQuery): Promise<QueryResult> {
    const fromRing = queryRing(this.ring, q);
    if (fromRing.complete || !this.sink) return fromRing.result;
    try {
      return (await this.sink.query(q)) ?? fromRing.result;
    } catch (err) {
      this.warnOnce('query', `events: reading the stored events failed (${err instanceof Error ? err.message : String(err)}); answering from memory`);
      return fromRing.result;
    }
  }

  /** Detach and flush the store (bot exit). */
  async close(): Promise<void> {
    const s = this.sink;
    this.sink = undefined;
    await s?.close();
  }

  /** Tests: forget everything (ring, ids, listeners, sink, counters). */
  reset(): void {
    this.ring = [];
    this.listeners.clear();
    this.sink = undefined;
    this.nextId = 1;
    this.rate.clear();
    this.warned.clear();
    this.stats.emitted = 0;
    this.stats.invalid = 0;
    this.stats.dropped = {};
    this.log = silentLogger;
    this.now = Date.now;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(msg);
  }
}

/** The bot's one bus: `import { events } from '../events/index.ts'; events.emit('job.finished', {...})`. */
export const events = new EventBus();
