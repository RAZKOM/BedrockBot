// Session metrics (PLAN.md task 1.3 / 1.7: "metrics file complete"): uptime, reconnects, kicks by
// reason, plus free-form counters (nudges, chat commands, corrections). Shown by `!status` and
// written to a JSON file every minute.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Connection } from './connection.ts';
import type { CloseInfo } from './types.ts';

export interface MetricsSnapshot {
  ts: string;
  startedAt: string;
  /** Process (bot) uptime in seconds. */
  uptimeS: number;
  state: string;
  username: string;
  gameVersion: string;
  tick: number;
  /** Current session: spawn time and seconds since; null while not spawned. */
  session: { spawnedAt: string; uptimeS: number } | null;
  spawns: number;
  /** Successful spawns after the first one. */
  reconnects: number;
  disconnects: number;
  closesByKind: Record<string, number>;
  kicks: { total: number; byReason: Record<string, number> };
  lastDisconnect: { ts: string; reason: string; kind: string } | null;
  counters: Record<string, number>;
  [extra: string]: unknown;
}

/** Key for `kicks.byReason`: the DisconnectFailReason name plus the message the player sees. */
export function kickKey(info: CloseInfo): string {
  if (!info.kick) return info.reason;
  return info.kick.message ? `${info.kick.reason}: ${info.kick.message}` : info.kick.reason;
}

function secondsBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
}

export class Metrics {
  readonly startedAt: Date;
  spawns = 0;
  disconnects = 0;
  readonly closesByKind: Record<string, number> = {};
  readonly kicksByReason: Record<string, number> = {};
  readonly counters: Record<string, number> = {};
  lastDisconnect: { ts: string; reason: string; kind: string } | null = null;
  private sessionStart: Date | undefined;
  private conn: Connection | undefined;
  private readonly now: () => Date;
  private readonly providers: (() => Record<string, unknown>)[] = [];
  private writer: NodeJS.Timeout | undefined;
  private writerPath: string | undefined;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.startedAt = this.now();
  }

  get reconnects(): number {
    return Math.max(0, this.spawns - 1);
  }

  get kicks(): number {
    return Object.values(this.kicksByReason).reduce((a, b) => a + b, 0);
  }

  /** Count spawns and closes of `conn`. Returns an unsubscribe function. */
  attach(conn: Connection): () => void {
    this.conn = conn;
    const offSpawn = conn.onSpawn(() => {
      this.spawns++;
      this.sessionStart = this.now();
    });
    const offClose = conn.onClose((info) => {
      this.recordClose(info);
    });
    return () => {
      offSpawn();
      offClose();
    };
  }

  recordClose(info: CloseInfo): void {
    this.disconnects++;
    this.sessionStart = undefined;
    this.closesByKind[info.kind] = (this.closesByKind[info.kind] ?? 0) + 1;
    if (info.kind === 'kick') {
      const key = kickKey(info);
      this.kicksByReason[key] = (this.kicksByReason[key] ?? 0) + 1;
    }
    this.lastDisconnect = { ts: this.now().toISOString(), reason: info.reason, kind: info.kind };
  }

  inc(name: string, by = 1): void {
    this.counters[name] = (this.counters[name] ?? 0) + by;
  }

  /** Extra fields merged into every snapshot (position, task status, ...). */
  provide(fn: () => Record<string, unknown>): void {
    this.providers.push(fn);
  }

  snapshot(): MetricsSnapshot {
    const now = this.now();
    const conn = this.conn;
    const snap: MetricsSnapshot = {
      ts: now.toISOString(),
      startedAt: this.startedAt.toISOString(),
      uptimeS: secondsBetween(this.startedAt, now),
      state: conn?.state ?? 'idle',
      username: conn?.username ?? '',
      gameVersion: conn?.gameVersion ?? '',
      tick: Number(conn?.tick ?? 0n),
      session: this.sessionStart ? { spawnedAt: this.sessionStart.toISOString(), uptimeS: secondsBetween(this.sessionStart, now) } : null,
      spawns: this.spawns,
      reconnects: this.reconnects,
      disconnects: this.disconnects,
      closesByKind: { ...this.closesByKind },
      kicks: { total: this.kicks, byReason: { ...this.kicksByReason } },
      lastDisconnect: this.lastDisconnect,
      counters: { ...this.counters },
    };
    for (const fn of this.providers) {
      try {
        Object.assign(snap, fn());
      } catch {
        // a broken provider must not break the metrics file
      }
    }
    return snap;
  }

  /** Write the snapshot to `path` atomically (temp file + rename). */
  writeFile(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2) + '\n');
    renameSync(tmp, path);
  }

  /** Write now and then every `intervalMs` (default 60 s) until stopWriter(). */
  startWriter(path: string, intervalMs = 60_000): void {
    this.stopWriter(false);
    this.writerPath = path;
    this.writeFile(path);
    this.writer = setInterval(() => {
      try {
        this.writeFile(path);
      } catch {
        // disk full or file locked: try again next interval
      }
    }, intervalMs);
    this.writer.unref();
  }

  /** Stop the periodic writer; by default write one final snapshot. */
  stopWriter(final = true): void {
    clearInterval(this.writer);
    this.writer = undefined;
    if (final && this.writerPath) {
      try {
        this.writeFile(this.writerPath);
      } catch {
        // ignore on shutdown
      }
    }
  }
}

/** Human-readable duration: 45s, 12m03s, 5h07m, 3d04h. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d${pad(h)}h`;
  if (h > 0) return `${h}h${pad(m)}m`;
  if (m > 0) return `${m}m${pad(sec)}s`;
  return `${sec}s`;
}
