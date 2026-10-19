import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Writable } from 'node:stream';
import { createGzip } from 'node:zlib';

export type RecordDir = 'in' | 'out' | 'meta';

/** One jsonl line. BigInt values are strings; byte arrays are `{ "$bytes": "<base64>" }`. */
export interface RecordLine {
  dir: RecordDir;
  /** Milliseconds since the recorder was created. */
  t: number;
  /** Connection tick (20 Hz driver) when the packet was seen; 0 before spawn. */
  tick: number;
  name: string;
  params: unknown;
  /** Optional base64 of the exact packet bytes (id header + body, uncompressed), for replay tests. */
  raw?: string;
}

export interface RecorderOptions {
  /** Also store each packet's encoded bytes (`raw`), used for fixtures. Default false. */
  includeRaw?: boolean;
  /** Packet names whose params are replaced by '[redacted]' and never get `raw`. Default: login. */
  redact?: readonly string[];
  /** Clock in ms, for tests. */
  now?: () => number;
}

/** `login` carries the identity chain (Xbox tokens when online), so it is never written out. */
export const DEFAULT_REDACT: readonly string[] = ['login'];

/** JSON.stringify replacer: BigInt -> string, Buffer/Uint8Array -> { $bytes: base64 }. */
export function jsonSafeReplacer(this: unknown, key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  // Buffer#toJSON runs before the replacer, so look at the holder's original value.
  const original = (this as Record<string, unknown> | undefined)?.[key];
  if (original instanceof Uint8Array) return { $bytes: Buffer.from(original).toString('base64') };
  return value;
}

/** Serialise one record to a single jsonl line (no trailing newline). */
export function serializeRecord(line: RecordLine): string {
  return JSON.stringify(line, jsonSafeReplacer);
}

/** Convert decoded packet params into the same JSON-safe shape that recordings store. */
export function toJsonSafe(value: unknown): unknown {
  return (JSON.parse(JSON.stringify({ v: value }, jsonSafeReplacer)) as { v: unknown }).v;
}

export function parseRecording(text: string): RecordLine[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RecordLine);
}

/** Packet capture for replay (PLAN.md section 6): one jsonl line per packet. */
export class PacketRecorder {
  readonly includeRaw: boolean;
  private readonly redact: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly t0: number;
  private readonly sink: (line: string) => void;
  private readonly stream: Writable | undefined;
  private readonly finished: Promise<void> | undefined;
  private closed = false;
  count = 0;

  /**
   * `target` is a file path (parent dirs are created; a `.gz` suffix writes gzip) or a function
   * receiving each line.
   */
  constructor(target: string | ((line: string) => void), opts: RecorderOptions = {}) {
    this.includeRaw = opts.includeRaw ?? false;
    this.redact = new Set(opts.redact ?? DEFAULT_REDACT);
    this.now = opts.now ?? (() => performance.now());
    this.t0 = this.now();
    if (typeof target === 'string') {
      mkdirSync(dirname(target), { recursive: true });
      const file = createWriteStream(target, { flags: 'w' });
      let stream: Writable = file;
      if (target.endsWith('.gz')) {
        const gz = createGzip({ level: 9 });
        gz.pipe(file);
        stream = gz;
      }
      this.stream = stream;
      this.finished = new Promise((resolve, reject) => {
        file.once('close', () => { resolve(); });
        file.once('error', reject);
      });
      this.sink = (line) => {
        stream.write(line + '\n');
      };
    } else {
      this.stream = undefined;
      this.finished = undefined;
      this.sink = (line) => {
        target(line + '\n');
      };
    }
  }

  record(dir: RecordDir, name: string, params: unknown, tick: bigint | number = 0, raw?: Uint8Array): void {
    if (this.closed) return;
    const redacted = this.redact.has(name);
    const line: RecordLine = {
      dir,
      t: Math.round(this.now() - this.t0),
      tick: Number(tick),
      name,
      params: redacted ? '[redacted]' : params,
    };
    if (this.includeRaw && raw && !redacted) line.raw = Buffer.from(raw).toString('base64');
    this.sink(serializeRecord(line));
    this.count++;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.stream?.end();
    return this.finished ?? Promise.resolve();
  }
}
