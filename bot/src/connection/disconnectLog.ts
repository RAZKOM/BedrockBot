// Append-only jsonl log of every session end (PLAN.md task 1.1, Realm checklist item 4: "log every
// kick reason"). One line per close: kicks, transport errors, restarts, our own disconnects.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Connection } from './connection.ts';
import type { CloseInfo } from './types.ts';

export interface DisconnectRecord {
  /** ISO timestamp. */
  ts: string;
  username: string;
  /** host:port (transport). */
  server: string;
  gameVersion: string;
  reason: string;
  kind: CloseInfo['kind'];
  /** Server disconnect packet: DisconnectFailReason name and the message shown to the player. */
  kick?: { reason: string; message?: string };
  willReconnect: boolean;
  retryInMs?: number;
  /** How long the session had been spawned (ms). */
  spawnedMs?: number;
}

export class DisconnectLog {
  readonly path: string;
  count = 0;
  private readonly now: () => Date;

  constructor(path: string, opts: { now?: () => Date } = {}) {
    this.path = path;
    this.now = opts.now ?? (() => new Date());
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Log every close of `conn`. Returns an unsubscribe function. */
  attach(conn: Connection, server: string): () => void {
    return conn.onClose((info) => {
      this.write(this.toRecord(info, conn.username, server, conn.gameVersion));
    });
  }

  toRecord(info: CloseInfo, username: string, server: string, gameVersion: string): DisconnectRecord {
    const rec: DisconnectRecord = {
      ts: this.now().toISOString(),
      username,
      server,
      gameVersion,
      reason: info.reason,
      kind: info.kind,
      willReconnect: info.willReconnect,
    };
    if (info.kick) rec.kick = info.kick;
    if (info.retryInMs !== undefined) rec.retryInMs = info.retryInMs;
    if (info.spawnedMs !== undefined) rec.spawnedMs = info.spawnedMs;
    return rec;
  }

  write(rec: DisconnectRecord): void {
    // Synchronous on purpose: closes are rare and the line must survive a crash right after.
    appendFileSync(this.path, JSON.stringify(rec) + '\n');
    this.count++;
  }
}

/** Parse a disconnects.jsonl file's text. */
export function parseDisconnectLog(text: string): DisconnectRecord[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as DisconnectRecord);
}
