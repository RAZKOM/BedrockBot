// Track P1 (docs/versions.md "Packets the bot cannot read", ADR 0092): keep the bytes of a packet bedrock-protocol
// fails to parse.
//
// bedrock-protocol's Client.readPacket catches the parse error and emits only the Error ("Read error for ... : Missing
// characters in string ..."); its own dump (protodef's dumpFailedBuffer) runs only when nobody listens to `error`, and
// the Connection always listens. So the bytes were lost, and with them the only way to tell a misread field from a
// damaged packet. `tapReads` wraps the client's readPacket (and the batch it came from) so that an `error` emitted while
// a packet is being parsed is known to be that packet's; `ReadErrorCapture` writes it as one JSON file under the bot's
// logs directory, capped in count and total size, never the `login` packet.
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** How a batch was framed: each packet's declared length, which one failed, and how many bytes the batch lacked. */
export interface BatchFraming {
  /** Bytes in the (decompressed) batch. */
  bytes: number;
  /** Declared length of each packet in the batch, in order. */
  packets: number[];
  /** Index of the failed packet in `packets`, -1 when it was not found. */
  index: number;
  /** Bytes the last packet declared but the batch did not hold (0: the batch was whole). */
  short: number;
}

export interface ReadFailure {
  /** Date.now() of the failure. */
  at: number;
  /** Packet id (the first varint), undefined when even that could not be read. */
  id: number | undefined;
  /** The id's name in the protocol's packet map. */
  name: string | undefined;
  /** Bytes of the packet (id included). */
  length: number;
  error: string;
  /** The file written (absolute path); undefined when not written (`skipped` says why). */
  file?: string;
  skipped?: string;
  batch?: BatchFraming;
  /** The packet's bytes, kept in memory up to 64 KiB (tests, a resync decision). */
  bytes?: Buffer;
}

export interface ReadErrorOptions {
  /** Directory for the files (created on the first write). Undefined: nothing is written, the failure is still told. */
  dir?: string;
  /** At most this many files in the directory (counting files left by earlier runs). Default 20. */
  maxFiles?: number;
  /** At most this many bytes of files in the directory. Default 4 MiB. */
  maxBytes?: number;
  /** A batch is kept in the file only up to this size. Default 512 KiB. */
  maxBatchBytes?: number;
  now?: () => number;
}

/** What the capture knows about the packet's context (from the Connection). */
export interface ReadContext {
  gameVersion: string;
  /** start_game's game_version (the server's own; may be a newer patch than gameVersion's protocol data). */
  serverVersion?: string;
  transport?: string;
  session: number;
  tick: bigint;
  /** The decompressed batch the packet came from, when the tap saw it. */
  batch?: Buffer;
}

export const FILE_PREFIX = 'read-error-';
export const DEFAULT_MAX_FILES = 20;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_BATCH_BYTES = 512 * 1024;
/** Failures kept in memory (status, tests). */
const KEEP = 50;
const KEEP_BYTES = 64 * 1024;
/** Packets never written out: `login` carries the identity chain. */
export const NEVER_WRITTEN: ReadonlySet<string> = new Set(['login']);

/** An unsigned LEB128 varint at `offset` (the packet id and the batch's length prefixes); undefined when cut off. */
export function readVarint(buf: Uint8Array, offset = 0): { value: number; size: number } | undefined {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[offset + i];
    if (b === undefined) return undefined;
    value += (b & 0x7f) * 2 ** (7 * i);
    if ((b & 0x80) === 0) return { value, size: i + 1 };
  }
  return undefined;
}

/**
 * The packet id of a game packet: the low 10 bits of the header varint (the rest are sub-client ids, always 0 for a
 * client like ours).
 */
export function packetId(buf: Uint8Array): number | undefined {
  const v = readVarint(buf, 0);
  return v === undefined ? undefined : v.value & 0x3ff;
}

/** How `batch` (a decompressed batch: varint length, packet, ...) was framed, and where `packet` sits in it. */
export function batchFraming(batch: Uint8Array, packet: Uint8Array): BatchFraming {
  const packets: number[] = [];
  let index = -1;
  let short = 0;
  let off = 0;
  while (off < batch.length) {
    const len = readVarint(batch, off);
    if (!len) {
      short = 1;
      break;
    }
    off += len.size;
    const have = Math.min(len.value, batch.length - off);
    if (index < 0 && len.value === packet.length && Buffer.from(batch.buffer, batch.byteOffset + off, have).equals(Buffer.from(packet.buffer, packet.byteOffset, have))) index = packets.length;
    packets.push(len.value);
    if (have < len.value) short = len.value - have;
    off += len.value;
  }
  return { bytes: batch.length, packets, index, short };
}

/**
 * A batch as the transport handed it to the client, decompressed: `compressorInHeader` batches start with the
 * algorithm (0 deflate, 255 none). Undefined when it cannot be read (snappy, a broken stream).
 */
export function decompressBatch(raw: Buffer, opts: { header?: number | null; compressorInHeader?: boolean }): Buffer | undefined {
  try {
    let b = raw;
    if (opts.header) {
      if (b[0] !== opts.header) return undefined;
      b = b.subarray(1);
    }
    if (!opts.compressorInHeader) return inflateRawSync(b);
    if (b[0] === 255) return b.subarray(1);
    if (b[0] === 0) return inflateRawSync(b.subarray(1));
    return undefined;
  } catch {
    return undefined;
  }
}

/** The parts of a bedrock-protocol Client the tap wraps (all optional: a test double may have none). */
export interface TappableClient {
  readPacket?: (packet: Buffer) => void;
  handle?: (buffer: Buffer) => void;
  onDecryptedPacket?: (buffer: Buffer) => void;
  encryptionEnabled?: boolean;
  batchHeader?: number | null;
  features?: { compressorInHeader?: boolean };
}

export interface ReadTap {
  /** The packet being parsed right now (from readPacket's start until it parsed), undefined otherwise. */
  readonly reading: Buffer | undefined;
  /** Mark the packet being read as parsed (the client's `packet` event). */
  parsed(): void;
  /** The decompressed batch the current packet came from, when known. */
  batch(): Buffer | undefined;
}

/**
 * Wrap `client.readPacket` so an `error` emitted while a packet is parsed can be tied to its bytes, and remember the
 * last batch (`handle` without encryption: NetherNet; `onDecryptedPacket` with it: RakNet). The client emits `packet`
 * right after a successful parse; the caller calls `parsed()` there, so an error from a later handler of the same
 * packet (a bad server handshake) is not taken for a read failure.
 */
export function tapReads(client: TappableClient): ReadTap {
  let reading: Buffer | undefined;
  let lastRaw: { buf: Buffer; compressed: boolean } | undefined;
  const read = client.readPacket;
  if (typeof read === 'function') {
    const orig = read.bind(client);
    client.readPacket = (packet: Buffer) => {
      reading = packet;
      try {
        orig(packet);
      } finally {
        reading = undefined;
      }
    };
  }
  const handle = client.handle;
  if (typeof handle === 'function') {
    const orig = handle.bind(client);
    client.handle = (buffer: Buffer) => {
      if (!client.encryptionEnabled) lastRaw = { buf: buffer, compressed: true };
      orig(buffer);
    };
  }
  const dec = client.onDecryptedPacket;
  if (typeof dec === 'function') {
    const orig = dec.bind(client);
    client.onDecryptedPacket = (buffer: Buffer) => {
      lastRaw = { buf: buffer, compressed: false };
      orig(buffer);
    };
  }
  return {
    get reading() {
      return reading;
    },
    parsed() {
      reading = undefined;
    },
    batch() {
      if (!lastRaw) return undefined;
      if (!lastRaw.compressed) return lastRaw.buf;
      const opts: { header?: number | null; compressorInHeader?: boolean } = { header: client.batchHeader ?? null };
      if (client.features?.compressorInHeader !== undefined) opts.compressorInHeader = client.features.compressorInHeader;
      return decompressBatch(lastRaw.buf, opts);
    },
  };
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** One JSON file per unreadable packet (see the module comment); the failures also stay in memory (the newest 50). */
export class ReadErrorCapture {
  readonly dir: string | undefined;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly maxBatchBytes: number;
  private readonly now: () => number;
  private readonly kept: ReadFailure[] = [];
  /** Files and bytes in the directory (read once, at the first failure). */
  private onDisk: { files: number; bytes: number } | undefined;
  private seq = 0;
  /** Failures seen since the start. */
  count = 0;

  constructor(opts: ReadErrorOptions = {}) {
    this.dir = opts.dir;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxBatchBytes = opts.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.now = opts.now ?? Date.now;
  }

  /** The newest failures (oldest first). */
  get failures(): readonly ReadFailure[] {
    return this.kept;
  }

  private disk(): { files: number; bytes: number } {
    if (this.onDisk) return this.onDisk;
    const d = { files: 0, bytes: 0 };
    try {
      for (const f of readdirSync(this.dir!)) {
        if (!f.startsWith(FILE_PREFIX)) continue;
        d.files++;
        d.bytes += statSync(join(this.dir!, f)).size;
      }
    } catch {
      // no directory yet
    }
    this.onDisk = d;
    return d;
  }

  /** Record one failure: the packet's bytes and the error (and the batch's framing when known). */
  capture(packet: Buffer, error: unknown, ctx: ReadContext, names: ReadonlyMap<number, string>): ReadFailure {
    this.count++;
    const at = this.now();
    const id = packetId(packet);
    const name = id === undefined ? undefined : names.get(id);
    const f: ReadFailure = { at, id, name, length: packet.length, error: errorText(error) };
    if (ctx.batch) f.batch = batchFraming(ctx.batch, packet);
    if (packet.length <= KEEP_BYTES) f.bytes = Buffer.from(packet);
    this.kept.push(f);
    if (this.kept.length > KEEP) this.kept.shift();
    if (name !== undefined && NEVER_WRITTEN.has(name)) {
      f.skipped = `${name} is never written`;
      return f;
    }
    if (!this.dir) {
      f.skipped = 'no logs directory';
      return f;
    }
    const d = this.disk();
    if (d.files >= this.maxFiles) {
      f.skipped = `${d.files} files already (limit ${this.maxFiles})`;
      return f;
    }
    const doc: Record<string, unknown> = {
      kind: 'bedrockbot-read-error',
      format: 1,
      at: new Date(at).toISOString(),
      gameVersion: ctx.gameVersion,
      serverVersion: ctx.serverVersion,
      transport: ctx.transport,
      session: ctx.session,
      tick: Number(ctx.tick),
      id,
      name,
      length: packet.length,
      error: f.error,
      stack: error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n') : undefined,
      bytes: packet.toString('base64'),
    };
    if (f.batch) doc.batch = { ...f.batch, ...(ctx.batch && ctx.batch.length <= this.maxBatchBytes ? { data: ctx.batch.toString('base64') } : {}) };
    let text = JSON.stringify(doc, null, 1);
    if (d.bytes + text.length > this.maxBytes && doc.batch) {
      // the batch goes first, then the packet itself
      doc.batch = { ...f.batch };
      text = JSON.stringify(doc, null, 1);
    }
    if (d.bytes + text.length > this.maxBytes) {
      f.skipped = `${d.bytes} bytes of files already (limit ${this.maxBytes})`;
      return f;
    }
    const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
    const file = join(this.dir, `${FILE_PREFIX}${stamp}-${++this.seq}-${name ?? id ?? 'unknown'}.json`);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, text);
      d.files++;
      d.bytes += text.length;
      f.file = file;
    } catch (e) {
      f.skipped = `write failed: ${errorText(e)}`;
    }
    return f;
  }
}

/** The WARN line for a failure (one line: the packet by id and name, the error, the file). */
export function readFailureLine(f: ReadFailure): string {
  const what = `${f.id ?? '?'}${f.name ? ` ${f.name}` : ''}`;
  const framing = f.batch && f.batch.short > 0 ? `; its batch was ${f.batch.short} bytes short` : '';
  return `unreadable packet ${what} (${f.length} bytes): ${f.error}${framing}; ${f.file ? `bytes saved to ${f.file}` : `bytes not saved (${f.skipped ?? '?'})`}`;
}
