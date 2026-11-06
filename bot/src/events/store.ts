// The event store (decision 0059, docs/events.md "Storage"): append-only JSONL, one file per UTC day
// (`<dir>/2026-11-05.jsonl`, one event per line), in `<config dir>/events/<server id>/` next to the
// world cache. Writes are batched (every second, or at once from 256 waiting) and asynchronous, so an
// emit never waits for the disk. Retention runs at the start, hourly and when the day changes: files
// older than `days` go, then the oldest until the total is under `maxBytes` (today's file is never
// deleted). A disk error switches the store to memory only with one logged error: the bot keeps its
// ring (bus.ts), the panel answers from it. On open the newest file's last good line gives the id to
// continue from, so ids keep increasing across restarts.
import { closeSync, mkdirSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { appendFile, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { silentLogger, type Logger } from '../log.ts';
import type { EventSink } from './bus.ts';
import { MS_FROM, select, matcher, limitOf, type EventQuery, type QueryResult } from './query.ts';
import type { BotEvent } from './registry.ts';

export const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const DAY_MS = 86_400_000;
export const DEFAULT_DAYS = 14;
export const DEFAULT_MAX_MB = 64;
const TAIL_BYTES = 256 * 1024;

/** `2026-11-05` (UTC) of a wall-clock ms. */
export function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Parse one stored line; undefined when it is not an event (corrupt, cut off by a crash). */
export function parseLine(line: string): BotEvent | undefined {
  const t = line.trim();
  if (!t) return undefined;
  try {
    const v = JSON.parse(t) as Partial<BotEvent>;
    if (typeof v.id !== 'number' || typeof v.ts !== 'number' || typeof v.kind !== 'string' || typeof v.sev !== 'string' || typeof v.data !== 'object' || v.data === null) return undefined;
    return v as BotEvent;
  } catch {
    return undefined;
  }
}

export interface EventStoreOptions {
  dir: string;
  /** Days of files kept (setting eventsDays). */
  days?: () => number;
  /** Total size cap in bytes (setting eventsMaxMb). */
  maxBytes?: () => number;
  log?: Logger;
  /** Write waiting events this often (ms). Default 1000. */
  flushMs?: number;
  /** Write at once from this many waiting events. Default 256. */
  batch?: number;
  now?: () => number;
  /** Tests: the append call (to make it fail). */
  append?: (file: string, data: string) => Promise<void>;
}

export class EventStore implements EventSink {
  readonly dir: string;
  /** The newest stored id when the store opened (0: none). */
  readonly lastId: number;
  private readonly o: EventStoreOptions;
  private readonly log: Logger;
  private readonly now: () => number;
  private queue: BotEvent[] = [];
  private inflight: BotEvent[] = [];
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private readonly hourly: NodeJS.Timeout | undefined;
  private lastDay: string;
  private _memoryOnly = false;
  private closed = false;
  readonly stats = { written: 0, writes: 0, deleted: 0, skipped: 0 };

  private constructor(o: EventStoreOptions, lastId: number, memoryOnly: boolean) {
    this.o = o;
    this.dir = o.dir;
    this.log = o.log ?? silentLogger;
    this.now = o.now ?? Date.now;
    this.lastId = lastId;
    this._memoryOnly = memoryOnly;
    this.lastDay = dayOf(this.now());
    if (!memoryOnly) {
      this.hourly = setInterval(() => void this.retention(), 3_600_000);
      this.hourly.unref();
      void this.retention();
    }
  }

  /** Create the directory and find the last stored id (synchronous: start-up only). */
  static open(o: EventStoreOptions): EventStore {
    const log = o.log ?? silentLogger;
    try {
      mkdirSync(o.dir, { recursive: true });
    } catch (e) {
      log.error(`events: cannot create ${o.dir} (${e instanceof Error ? e.message : String(e)}); keeping events in memory only`);
      return new EventStore(o, 0, true);
    }
    return new EventStore(o, lastStoredId(o.dir), false);
  }

  get memoryOnly(): boolean {
    return this._memoryOnly;
  }

  append(e: BotEvent): void {
    if (this._memoryOnly || this.closed) return;
    this.queue.push(e);
    if (this.queue.length >= (this.o.batch ?? 256)) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.o.flushMs ?? 1000);
      this.timer.unref();
    }
  }

  /** Write what waits (serialised: one write at a time). */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.writing = this.writing.then(() => this.write());
    return this.writing;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    clearInterval(this.hourly);
  }

  private async write(): Promise<void> {
    if (this.queue.length === 0 || this._memoryOnly) return;
    const batch = this.queue;
    this.queue = [];
    this.inflight = batch;
    const byDay = new Map<string, string[]>();
    for (const e of batch) {
      const d = dayOf(e.ts);
      let l = byDay.get(d);
      if (!l) byDay.set(d, (l = []));
      l.push(`${JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
    }
    const append = this.o.append ?? ((f: string, data: string) => appendFile(f, data, 'utf8'));
    try {
      for (const [d, lines] of byDay) await append(join(this.dir, `${d}.jsonl`), lines.join(''));
      this.stats.written += batch.length;
      this.stats.writes++;
    } catch (e) {
      this._memoryOnly = true;
      this.queue = [];
      clearInterval(this.hourly);
      this.log.error(`events: writing ${this.dir} failed (${e instanceof Error ? e.message : String(e)}); keeping events in memory only from now on`);
    } finally {
      this.inflight = [];
    }
    const today = dayOf(this.now());
    if (today !== this.lastDay) {
      this.lastDay = today;
      void this.retention();
    }
  }

  /** Delete files older than `days`, then the oldest until the total fits `maxBytes`. Returns the deleted names. */
  async retention(): Promise<string[]> {
    if (this._memoryOnly) return [];
    const deleted: string[] = [];
    try {
      const days = Math.max(1, this.o.days?.() ?? DEFAULT_DAYS);
      const max = this.o.maxBytes?.() ?? DEFAULT_MAX_MB * 1024 * 1024;
      const today = dayOf(this.now());
      const oldestKept = dayOf(this.now() - (days - 1) * DAY_MS);
      const files = (await readdir(this.dir)).filter((f) => FILE_RE.test(f)).sort();
      const sizes = new Map<string, number>();
      for (const f of files) sizes.set(f, (await stat(join(this.dir, f))).size);
      let total = [...sizes.values()].reduce((a, b) => a + b, 0);
      for (const f of files) {
        const day = f.slice(0, 10);
        if (day === today) continue;
        if (day < oldestKept || total > max) {
          await unlink(join(this.dir, f));
          total -= sizes.get(f) ?? 0;
          deleted.push(f);
        }
      }
    } catch (e) {
      this.log.warn(`events: retention in ${this.dir} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (deleted.length) {
      this.stats.deleted += deleted.length;
      this.log.info(`events: deleted ${deleted.length} old file(s) (${deleted.join(', ')})`);
    }
    return deleted;
  }

  /** Events from the files plus the ones not written yet; undefined in memory-only mode. */
  async query(q: EventQuery): Promise<QueryResult | undefined> {
    if (this._memoryOnly) return undefined;
    const files = (await readdir(this.dir)).filter((f) => FILE_RE.test(f)).sort();
    const sinceMs = q.since !== undefined && q.since >= MS_FROM ? q.since : undefined;
    const sinceId = q.since !== undefined && q.since < MS_FROM ? q.since : undefined;
    const untilDay = q.until !== undefined && q.until >= MS_FROM ? dayOf(q.until) : undefined;
    const m = matcher(q);
    const limit = limitOf(q);
    const chunks: BotEvent[][] = [];
    let matches = 0;
    let skipped = 0;
    for (let i = files.length - 1; i >= 0; i--) {
      const f = files[i]!;
      const day = f.slice(0, 10);
      if (untilDay !== undefined && day > untilDay) continue;
      if (sinceMs !== undefined && day < dayOf(sinceMs)) break;
      let text: string;
      try {
        text = await readFile(join(this.dir, f), 'utf8');
      } catch {
        continue; // deleted by retention meanwhile
      }
      const list: BotEvent[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const e = parseLine(line);
        if (e) list.push(e);
        else skipped++;
      }
      chunks.unshift(list);
      matches += list.filter(m).length;
      if (sinceId !== undefined && list.length > 0 && list[0]!.id <= sinceId + 1) break;
      if (q.since === undefined && matches >= limit) break;
    }
    const seen = new Set<number>();
    const all: BotEvent[] = [];
    for (const e of [...chunks.flat(), ...this.inflight, ...this.queue]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
    all.sort((a, b) => a.id - b.id);
    this.stats.skipped += skipped;
    const r = select(all, q);
    return skipped ? { ...r, skipped } : r;
  }

  /** Files and their total size (the runbook's `!events`-free check; tests). */
  usage(): { files: number; bytes: number } {
    if (this._memoryOnly) return { files: 0, bytes: 0 };
    try {
      const files = readdirSync(this.dir).filter((f) => FILE_RE.test(f));
      return { files: files.length, bytes: files.reduce((a, f) => a + statSync(join(this.dir, f)).size, 0) };
    } catch {
      return { files: 0, bytes: 0 };
    }
  }
}

/** The id of the newest good line in the newest file that has one (0: none). */
export function lastStoredId(dir: string): number {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  } catch {
    return 0;
  }
  for (let i = files.length - 1; i >= 0; i--) {
    const path = join(dir, files[i]!);
    let fd: number | undefined;
    try {
      const size = statSync(path).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fd = openSync(path, 'r');
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      let best = 0;
      for (const l of lines) {
        const e = parseLine(l);
        if (e && e.id > best) best = e.id;
      }
      if (best > 0) return best;
    } catch {
      // unreadable: try the one before
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return 0;
}
