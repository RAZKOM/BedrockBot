// Track P1 (connection/readErrors.ts, docs/versions.md "Packets the bot cannot read"): the bytes of a packet
// bedrock-protocol cannot parse are kept, capped, never the login packet; the session's end reason is not the read
// error; listeners are told. A fake client stands in for bedrock-protocol's: its readPacket parses with a stub and,
// like Client.readPacket, emits `error` on a failure and `packet` on a success.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { packetNames } from '../../src/connection/protocol.ts';
import { batchFraming, decompressBatch, packetId, ReadErrorCapture, readFailureLine, readVarint, tapReads, type ReadFailure } from '../../src/connection/readErrors.ts';
import type { Logger } from '../../src/log.ts';
import { connectAndSpawn, FakeClient, setup } from './connection-fakes.ts';

/** A client whose readPacket fails for packets starting with byte 0x94 (item_stack_response's id 148: 0x94 0x01). */
class ParsingClient extends FakeClient {
  encryptionEnabled = false;
  batchHeader: number | null = null;
  features = { compressorInHeader: true };
  readPacket(packet: Buffer): void {
    let des: { data: { name: string; params: object } };
    try {
      if (packet[0] === 0x94) throw new Error('Read error for undefined : Missing characters in string, found size is 69 expected size was 241');
      des = { data: { name: 'text', params: { message: packet.toString('hex') } } };
    } catch (e) {
      this.emit('error', e);
      return;
    }
    this.emit('packet', des);
    this.emit(des.data.name, des.data.params);
  }
  /** A NetherNet-style batch (no header byte, compressor byte, varint lengths) through handle -> readPacket. */
  handle(buffer: Buffer): void {
    const b = decompressBatch(buffer, { header: null, compressorInHeader: true })!;
    let off = 0;
    while (off < b.length) {
      const l = readVarint(b, off)!;
      off += l.size;
      const p = Buffer.alloc(l.value);
      b.copy(p, 0, off, off + l.value);
      off += l.value;
      this.readPacket(p);
    }
  }
}

const RESPONSE = Buffer.from('94010100c19a0c01021d00010f0f0101a2df0108626f745f6c6f6f7400001c000105050101a0df0108626f745f6c6f6f740000', 'hex');
const frame = (...packets: Buffer[]) => Buffer.concat(packets.flatMap((p) => [Buffer.from([p.length]), p]));

function warnings(): { log: Logger; warns: string[] } {
  const warns: string[] = [];
  return { warns, log: { debug() {}, info() {}, warn: (m: string) => warns.push(m), error: (m: string) => warns.push(`ERROR ${m}`) } };
}

describe('read errors: the pure parts', () => {
  it('varints, packet ids and names: item_stack_response is 148 (0x94 0x01) in 1.26.60', () => {
    expect(readVarint(Buffer.from([0x94, 0x01]))).toEqual({ value: 148, size: 2 });
    expect(readVarint(Buffer.from([0x94]))).toBeUndefined();
    expect(packetId(RESPONSE)).toBe(148);
    const names = packetNames('1.26.60');
    expect(names.get(148)).toBe('item_stack_response');
    expect(names.get(1)).toBe('login');
    expect(packetNames('0.0.1').size).toBe(0);
  });

  it('batch framing: the failed packet found in its batch, a batch that ends short told', () => {
    const a = Buffer.from([9, 1, 2]);
    const batch = frame(a, RESPONSE);
    expect(batchFraming(batch, RESPONSE)).toEqual({ bytes: batch.length, packets: [3, RESPONSE.length], index: 1, short: 0 });
    const cut = batch.subarray(0, batch.length - 10);
    expect(batchFraming(cut, RESPONSE)).toMatchObject({ packets: [3, RESPONSE.length], short: 10 });
  });

  it('decompressBatch: the compressor byte (255 none, 0 deflate), a header byte, a broken stream', () => {
    const plain = frame(RESPONSE);
    expect(decompressBatch(Buffer.concat([Buffer.from([255]), plain]), { compressorInHeader: true })).toEqual(plain);
    expect(decompressBatch(Buffer.concat([Buffer.from([0]), deflateRawSync(plain)]), { compressorInHeader: true })).toEqual(plain);
    expect(decompressBatch(Buffer.concat([Buffer.from([0xfe, 255]), plain]), { header: 0xfe, compressorInHeader: true })).toEqual(plain);
    expect(decompressBatch(Buffer.from([0, 1, 2, 3]), { compressorInHeader: true })).toBeUndefined();
    expect(decompressBatch(Buffer.from([1, 1, 2, 3]), { compressorInHeader: true })).toBeUndefined();
  });

  it('tapReads: `reading` is the packet only while it is parsed; the batch comes from handle (NetherNet) or onDecryptedPacket (RakNet)', () => {
    const seen: (Buffer | undefined)[] = [];
    const c = new ParsingClient();
    const tap = tapReads(c);
    c.on('error', () => seen.push(tap.reading));
    c.on('packet', () => tap.parsed());
    c.readPacket(RESPONSE);
    expect(seen).toEqual([RESPONSE]);
    expect(tap.reading).toBeUndefined();
    const batch = frame(Buffer.from([9, 1]), RESPONSE);
    c.handle(Buffer.concat([Buffer.from([255]), batch]));
    expect(tap.batch()).toEqual(batch);
    // RakNet: the decrypted (decompressed) batch
    const r = { onDecryptedPacket: vi.fn(), readPacket: vi.fn() };
    const tap2 = tapReads(r);
    r.onDecryptedPacket(batch);
    expect(tap2.batch()).toBe(batch);
  });
});

describe('read errors: the capture', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bedrockbot-p1-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const ctx = { gameVersion: '1.26.60', transport: 'nethernet', session: 1, tick: 42n };
  const names = packetNames('1.26.60');

  it('one JSON file a failure: id, name, length, error, the bytes, the batch; the WARN line names packet and file', () => {
    const cap = new ReadErrorCapture({ dir, now: () => Date.UTC(2026, 10, 16, 9, 29, 35) });
    const batch = frame(RESPONSE);
    const f = cap.capture(RESPONSE, new Error('Read error for undefined : Missing characters'), { ...ctx, batch }, names);
    expect(f).toMatchObject({ id: 148, name: 'item_stack_response', length: RESPONSE.length, error: 'Read error for undefined : Missing characters' });
    expect(f.file).toBeDefined();
    const doc = JSON.parse(readFileSync(f.file!, 'utf8')) as Record<string, unknown> & { batch: { data: string; index: number } };
    expect(doc).toMatchObject({ kind: 'bedrockbot-read-error', format: 1, at: '2026-11-16T09:29:35.000Z', gameVersion: '1.26.60', transport: 'nethernet', tick: 42, id: 148, name: 'item_stack_response' });
    expect(Buffer.from(doc.bytes as string, 'base64')).toEqual(RESPONSE);
    expect(Buffer.from(doc.batch.data, 'base64')).toEqual(batch);
    expect(doc.batch.index).toBe(0);
    expect(readFailureLine(f)).toBe(`unreadable packet 148 item_stack_response (${RESPONSE.length} bytes): Read error for undefined : Missing characters; bytes saved to ${f.file}`);
    expect(f.bytes).toEqual(RESPONSE);
  });

  it('never the login packet; nothing written without a directory (the failure still counted)', () => {
    const cap = new ReadErrorCapture({ dir });
    const login = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x01]);
    const f = cap.capture(login, new Error('x'), ctx, names);
    expect(f).toMatchObject({ name: 'login', skipped: 'login is never written' });
    expect(readdirSync(dir)).toEqual([]);
    const mem = new ReadErrorCapture();
    expect(mem.capture(RESPONSE, new Error('x'), ctx, names).skipped).toBe('no logs directory');
    expect(mem.count).toBe(1);
    expect(mem.failures).toHaveLength(1);
  });

  it('capped by count and by bytes, counting the files earlier runs left', () => {
    writeFileSync(join(dir, 'read-error-old-1.json'), 'x'.repeat(100));
    writeFileSync(join(dir, 'unrelated.txt'), 'x'.repeat(10_000));
    const cap = new ReadErrorCapture({ dir, maxFiles: 3 });
    const out = [1, 2, 3].map(() => cap.capture(RESPONSE, new Error('x'), ctx, names));
    expect(out.map((f) => f.file !== undefined)).toEqual([true, true, false]);
    expect(out[2]!.skipped).toBe('3 files already (limit 3)');
    const small = new ReadErrorCapture({ dir: join(dir, 'b'), maxBytes: 3000 });
    const big = Buffer.concat([RESPONSE, Buffer.alloc(4000)]);
    expect(small.capture(big, new Error('x'), ctx, names).skipped).toMatch(/^0 bytes of files already \(limit 3000\)$/);
    expect(small.capture(RESPONSE, new Error('x'), ctx, names).file).toBeDefined();
  });

  it('a batch too big for the size cap is left out before the packet is', () => {
    const cap = new ReadErrorCapture({ dir, maxBytes: 2500, maxBatchBytes: 1_000_000 });
    const batch = frame(RESPONSE, Buffer.alloc(100, 7), ...Array.from({ length: 10 }, () => Buffer.alloc(120, 3)));
    const f = cap.capture(RESPONSE, new Error('x'), { ...ctx, batch }, names);
    expect(f.file).toBeDefined();
    const doc = JSON.parse(readFileSync(f.file!, 'utf8')) as { batch: Record<string, unknown>; bytes: string };
    expect(doc.batch.data).toBeUndefined();
    expect(doc.batch.packets).toHaveLength(12);
    expect(doc.bytes).toBe(RESPONSE.toString('base64'));
  });
});

describe('read errors: the Connection', () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'bedrockbot-p1-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function parsingSetup() {
    const { log, warns } = warnings();
    const clients: ParsingClient[] = [];
    const s = setup({ logger: log, readErrors: new ReadErrorCapture({ dir }), reconnect: false, createClient: () => {
      const c = new ParsingClient();
      clients.push(c);
      return c;
    } });
    return { ...s, clients, warns };
  }

  it('a packet that fails to parse: one WARN line with id, name and file, the file written, listeners told, the packets after it still read', async () => {
    const { conn, clients, warns } = parsingSetup();
    const c = (await connectAndSpawn(conn, clients)) as unknown as ParsingClient;
    const told: ReadFailure[] = [];
    conn.onReadError((f) => told.push(f));
    const texts: string[] = [];
    conn.on('text', (p) => texts.push(String((p as { message: string }).message)));
    c.emit('start_game', { runtime_entity_id: 1n, game_version: '1.26.63' });
    c.handle(Buffer.concat([Buffer.from([255]), frame(Buffer.from([9, 1]), RESPONSE, Buffer.from([9, 2]))]));
    expect(told).toHaveLength(1);
    expect(JSON.parse(readFileSync(told[0]!.file!, 'utf8'))).toMatchObject({ serverVersion: '1.26.63' });
    expect(told[0]).toMatchObject({ id: 148, name: 'item_stack_response', batch: { packets: [2, RESPONSE.length, 2], index: 1, short: 0 } });
    expect(texts).toEqual(['0901', '0902']);
    const line = warns.find((w) => w.startsWith('unreadable packet'));
    expect(line).toMatch(/^unreadable packet 148 item_stack_response \(51 bytes\): Read error for undefined : Missing characters in string, found size is 69 expected size was 241; bytes saved to .*read-error-.*item_stack_response\.json$/);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(warns.filter((w) => w.startsWith('error:'))).toEqual([]);
    expect(conn.readErrors.count).toBe(1);
  });

  it('the read error is not the session\'s end reason (before: a close minutes later was told as the read error)', async () => {
    const { conn, clients } = parsingSetup();
    const c = (await connectAndSpawn(conn, clients)) as unknown as ParsingClient;
    const closes: string[] = [];
    conn.onClose((i) => closes.push(i.reason));
    c.readPacket(RESPONSE);
    c.close();
    expect(closes).toEqual(['connection closed']);
  });

  it('an error outside a parse (a transport error) is still the end reason', async () => {
    const { conn, clients } = parsingSetup();
    const c = (await connectAndSpawn(conn, clients)) as unknown as ParsingClient;
    const closes: string[] = [];
    conn.onClose((i) => closes.push(i.reason));
    c.emit('error', new Error('Signal connection closed unexpectedly'));
    c.close();
    expect(closes).toEqual(['error: Signal connection closed unexpectedly']);
    expect(conn.readErrors.count).toBe(0);
  });

  it('a client without readPacket (a test double) works as before', async () => {
    const { conn, clients } = setup();
    const c = await connectAndSpawn(conn, clients);
    const told: ReadFailure[] = [];
    conn.onReadError((f) => told.push(f));
    c.emit('error', new Error('boom'));
    expect(told).toEqual([]);
  });
});
