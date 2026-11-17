// patches/nethernet@1.1.2.patch: BDS 1.26.70 previews wrap the LAN CONNECTRESPONSE in a discovery packet of type 3
// and send it 8 times over about 3 s. nethernet 1.1.2 dropped the type ("Unknown packet type"), so a LAN connect to
// such a server timed out; the patch unwraps it and handles the first copy only.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const nnRequire = createRequire(createRequire(require.resolve('bedrock-protocol')).resolve('nethernet'));

interface Parsed {
  name: string;
  params: Record<string, unknown>;
}
interface Rinfo {
  address: string;
  port: number;
}
interface Util {
  processSecurePacket(buf: Buffer, deserializer: unknown): Parsed;
  RELIABLE_HEADER_SIZE: number;
}
interface Crypto {
  encrypt(b: Buffer): Buffer;
  calculateChecksum(b: Buffer): Buffer;
}
interface Serializer {
  createPacketBuffer(p: { name: string; params: Record<string, unknown> }): Buffer;
}
interface ClientProto {
  processPacket(buf: Buffer, rinfo: Rinfo): void;
}

const util = nnRequire('./src/util') as Util;
const crypto = nnRequire('./src/crypto') as Crypto;
const { createSerializer, createDeserializer } = nnRequire('./src/transforms/serializer') as {
  createSerializer: () => Serializer;
  createDeserializer: () => unknown;
};
const { Client } = nnRequire('./index.js') as { Client: { prototype: ClientProto } };

const SERVER = 0xb63a9e239fa72f8fn;
const ME = 0xc0829893cb3cd484n;
// The 8 bytes after the recipient, the same in every type-3 packet BDS 1.26.70.24 sent (any value works).
const CHANNEL = Buffer.from('21277d639502cd49', 'hex');
const SDP = 'CONNECTRESPONSE 1234567 v=0\r\ns=-\r\nt=0 0\r\n';

function inner(data: string): Buffer {
  const flags = Buffer.alloc(8);
  flags[0] = 1;
  return createSerializer().createPacketBuffer({
    name: 'discovery_message',
    params: { sender_id: SERVER, reserved: flags, recipient_id: ME, data },
  });
}

/** A type-3 frame as BDS 1.26.70.24 sends it: header (44 bytes, layout of a recorded one), then a discovery packet. */
function reliable(seq: bigint, body: Buffer, channel = CHANNEL): Buffer {
  const h = Buffer.alloc(util.RELIABLE_HEADER_SIZE);
  h.writeUInt16LE(h.length + body.length, 0);
  h.writeUInt16LE(3, 2);
  h.writeBigUInt64LE(SERVER, 4);
  h[12] = 1;
  h.writeBigUInt64LE(ME, 20);
  channel.copy(h, 28);
  h.writeBigUInt64LE(seq, 36);
  return Buffer.concat([h, body]);
}

const wire = (plain: Buffer): Buffer => Buffer.concat([crypto.calculateChecksum(plain), crypto.encrypt(plain)]);

function fakeClient() {
  const c = Object.create(Client.prototype) as ClientProto & {
    deserializer: unknown;
    handleMessage: ReturnType<typeof vi.fn>;
    handleResponse: ReturnType<typeof vi.fn>;
  };
  c.deserializer = createDeserializer();
  c.handleMessage = vi.fn();
  c.handleResponse = vi.fn();
  return c;
}

const RINFO = { address: '127.0.0.1', port: 7551 };
// ProtoDef reads an lu64 as [high, low].
const u64 = (v: unknown): bigint => (Array.isArray(v) ? (BigInt(v[0] >>> 0) << 32n) | BigInt(v[1] >>> 0) : BigInt(v as bigint));

describe('nethernet LAN packet type 3 (patched nethernet 1.1.2)', () => {
  it('the recorded header lays out sender, flags, recipient, channel and sequence', () => {
    // First 44 bytes of a type-3 packet from BDS 1.26.70.24 (its length 642, sequence 5).
    const rec = Buffer.from('820203008f2fa79f239e3ab6010000000000000084d43ccb939882c021277d639502cd490500000000000000', 'hex');
    expect(rec.length).toBe(util.RELIABLE_HEADER_SIZE);
    expect(rec.readUInt16LE(0)).toBe(642);
    expect(rec.readUInt16LE(2)).toBe(3);
    expect(rec.readBigUInt64LE(4)).toBe(SERVER);
    expect(rec.readBigUInt64LE(20)).toBe(ME);
    expect(rec.subarray(28, 36).equals(CHANNEL)).toBe(true);
    expect(rec.readBigUInt64LE(36)).toBe(5n);
    expect(reliable(5n, Buffer.alloc(0)).subarray(2)).toEqual(rec.subarray(2));
  });

  it('processSecurePacket unwraps the discovery packet inside', () => {
    const p = util.processSecurePacket(wire(reliable(5n, inner(SDP))), createDeserializer());
    expect(p.name).toBe('reliable_message');
    expect(p.params.sender_id).toBe(SERVER);
    expect(p.params.recipient_id).toBe(ME);
    expect(p.params.channel).toBe(CHANNEL.toString('hex'));
    expect(p.params.sequence).toBe(5n);
    const msg = p.params.packet as Parsed;
    expect(msg.name).toBe('discovery_message');
    expect(u64(msg.params.sender_id)).toBe(SERVER);
    expect(msg.params.data).toBe(SDP);
  });

  it('handles the first of 8 copies once, and a new sequence again', () => {
    const c = fakeClient();
    const copy = wire(reliable(5n, inner(SDP)));
    for (let i = 0; i < 8; i++) c.processPacket(copy, RINFO);
    expect(c.handleMessage).toHaveBeenCalledTimes(1);
    const [arg] = c.handleMessage.mock.calls[0] as [Parsed];
    expect(arg.name).toBe('discovery_message');
    expect(arg.params.data).toBe(SDP);

    c.processPacket(wire(reliable(6n, inner('CONNECTRESPONSE 7654321 v=0'))), RINFO);
    expect(c.handleMessage).toHaveBeenCalledTimes(2);
    // the same sequence on another channel is another message
    c.processPacket(wire(reliable(6n, inner(SDP), Buffer.alloc(8, 7))), RINFO);
    expect(c.handleMessage).toHaveBeenCalledTimes(3);
  });

  it('plain discovery messages are handled as before, every copy', () => {
    const c = fakeClient();
    const plain = wire(inner(SDP));
    c.processPacket(plain, RINFO);
    c.processPacket(plain, RINFO);
    expect(c.handleMessage).toHaveBeenCalledTimes(2);
    // the empty type-2 message BDS 1.26.70.24 sends just before the type 3 parses and is passed on (data '')
    c.processPacket(wire(inner('')), RINFO);
    expect(c.handleMessage).toHaveBeenCalledTimes(3);
  });

  it('a type 3 whose body is not a discovery packet is dropped without throwing', () => {
    const c = fakeClient();
    expect(() => c.processPacket(wire(reliable(9n, Buffer.from('ffff09000000', 'hex'))), RINFO)).not.toThrow();
    expect(c.handleMessage).not.toHaveBeenCalled();
    expect(c.handleResponse).not.toHaveBeenCalled();
  });

  it('keeps at most 256 sequences', () => {
    const c = fakeClient() as ReturnType<typeof fakeClient> & { _reliableSeen?: Set<string> };
    for (let s = 0n; s < 300n; s++) c.processPacket(wire(reliable(s, inner('x'))), RINFO);
    expect(c.handleMessage).toHaveBeenCalledTimes(300);
    expect(c._reliableSeen?.size).toBe(256);
  });
});
