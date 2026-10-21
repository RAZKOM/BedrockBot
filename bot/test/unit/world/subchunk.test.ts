// Network subchunk decoder: synthetic round trips for every storage width, plus a cross-check against
// prismarine-chunk's 1.18 decoder on the recorded payloads (fixtures/<FIXTURE_VERSION>, default 1.26.60).
import { createRequire } from 'node:module';
import nbt from 'prismarine-nbt';
import { describe, expect, it } from 'vitest';
import { decodeSubChunk, Layer, localIndex } from '../../../src/world/subchunk.ts';
import { decodedInbound, encodeSubChunk, FIXTURE_VERSION, fillSection, readyRegistry } from './helpers.ts';

const require = createRequire(import.meta.url);
const ident = (rid: number) => rid;

function layerValues(l: Layer): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4096; i++) out.push(l.runtimeIdAt(i));
  return out;
}

describe('decodeSubChunk', () => {
  it('round-trips every bits-per-block width', () => {
    for (const bits of [1, 2, 3, 4, 5, 6, 8, 16]) {
      const n = Math.min(2 ** bits, 300);
      const blocks = fillSection((x, y, z) => -1000 - ((x * 31 + y * 7 + z) % n));
      const dec = decodeSubChunk(encodeSubChunk([blocks], { forceBits: bits, y: -3 }), ident);
      expect(dec.version).toBe(9);
      expect(dec.y).toBe(-3);
      const l = dec.section.layers[0]!;
      expect(layerValues(l), `bits ${bits}`).toEqual(blocks);
      expect(l.size).toBe(new Set(blocks).size);
      expect(l.index instanceof Uint16Array).toBe(l.size > 256);
    }
  });

  it('decodes the 0-bit single-value form with a negative (hashed) runtime id', () => {
    const air = -604749536;
    const dec = decodeSubChunk(encodeSubChunk([new Array<number>(4096).fill(air)], { forceBits: 0 }), ident);
    const l = dec.section.layers[0]!;
    expect(l.index).toBeNull();
    expect(l.runtimeIdAt(4095)).toBe(air);
    expect(l.stateAt(0)).toBe(air);
  });

  it('reads two layers (waterlogging) and version 8 without a y index', () => {
    const l0 = fillSection((x) => (x < 8 ? 1 : 2));
    const l1 = fillSection((x, y) => (y === 0 ? 3 : 4));
    const dec = decodeSubChunk(encodeSubChunk([l0, l1], { version: 8 }), ident);
    expect(dec.version).toBe(8);
    expect(dec.y).toBeUndefined();
    expect(layerValues(dec.section.layers[0]!)).toEqual(l0);
    expect(layerValues(dec.section.layers[1]!)).toEqual(l1);
  });

  it('uses Bedrock XZY order for local indices', () => {
    const blocks = fillSection((x, y, z) => x * 256 + z * 16 + y);
    const l = decodeSubChunk(encodeSubChunk([blocks]), ident).section.layers[0]!;
    expect(l.runtimeIdAt(localIndex(1, 2, 3))).toBe(256 + 3 * 16 + 2);
    expect(localIndex(-1, -1, -1)).toBe(localIndex(15, 15, 15));
  });

  it('parses trailing block entity NBT', () => {
    const tag = nbt.comp({ id: nbt.string('Chest'), x: nbt.int(4), y: nbt.int(-59), z: nbt.int(5) });
    const be = nbt.writeUncompressed(tag as unknown as nbt.NBT, 'littleVarint');
    const dec = decodeSubChunk(encodeSubChunk([new Array<number>(4096).fill(7)], { trailing: Buffer.concat([be, be]) }), ident);
    expect(dec.blockEntities).toEqual([
      { id: 'Chest', x: 4, y: -59, z: 5 },
      { id: 'Chest', x: 4, y: -59, z: 5 },
    ]);
  });

  it('maps runtime ids through the resolver and keeps the wire ids', () => {
    const blocks = fillSection((x) => (x === 0 ? 10 : 20));
    const l = decodeSubChunk(encodeSubChunk([blocks]), (rid) => (rid === 10 ? 1 : -1)).section.layers[0]!;
    expect(l.stateAt(localIndex(0, 0, 0))).toBe(1);
    expect(l.stateAt(localIndex(1, 0, 0))).toBe(-1);
    expect(l.runtimeIdAt(localIndex(1, 0, 0))).toBe(20);
  });

  it('rejects malformed payloads', () => {
    expect(() => decodeSubChunk(Buffer.from([7, 1]), ident)).toThrow(/unsupported storage version 7/);
    expect(() => decodeSubChunk(Buffer.from([9, 3, 0]), ident)).toThrow(/layer count 3/);
    expect(() => decodeSubChunk(Buffer.from([9, 1, 0, 2 << 1]), ident)).toThrow(/network runtime-id palette/);
    expect(() => decodeSubChunk(Buffer.from([9, 1, 0, (7 << 1) | 1]), ident)).toThrow(/invalid bits per block 7/);
    expect(() => decodeSubChunk(encodeSubChunk([fillSection((x) => x & 1)]).subarray(0, 20), ident)).toThrow(/unexpected end/);
    expect(() => decodeSubChunk(encodeSubChunk([fillSection(() => 1)], { version: 9 }), ident, 8)).toThrow(/newer than the shim/);
  });

  it('Layer.set grows the palette and widens the index past 256 entries', () => {
    const l = Layer.uniform(0, 100);
    l.set(5, 1, 101);
    expect(l.index).toBeInstanceOf(Uint8Array);
    for (let k = 0; k < 300; k++) l.set(k, k + 10, 1000 + k);
    expect(l.index).toBeInstanceOf(Uint16Array);
    expect(l.stateAt(299)).toBe(309);
    expect(l.runtimeIdAt(299)).toBe(1299);
    expect(l.stateAt(4000)).toBe(0);
  });

  it(`agrees with prismarine-chunk 1.18 on every recorded ${FIXTURE_VERSION} subchunk`, async () => {
    const reg = readyRegistry();
    // The same registry data, prepared the prismarine way, for the reference decoder.
    const loadRegistry = require('prismarine-registry') as (v: string) => { handleStartGame(p: unknown): void };
    const pReg = loadRegistry(`bedrock_${FIXTURE_VERSION}`);
    const lines = decodedInbound('world-chunks.jsonl.gz');
    const sg = lines.find((l) => l.name === 'start_game')!.params;
    const ir = lines.find((l) => l.name === 'item_registry')!.params;
    pReg.handleStartGame({ ...sg, itemstates: ir.itemstates });
    interface PChunk {
      networkDecodeSubChunkNoCache(y: number, buf: Buffer): Promise<void>;
      getBlockStateId(pos: { x: number; y: number; z: number }): number;
    }
    const Chunk = (require('prismarine-chunk/src/bedrock/1.18/chunk') as (r: unknown) => new (o: { x: number; z: number }) => PChunk)(pReg);
    let compared = 0;
    for (const p of lines) {
      if (p.name !== 'subchunk') continue;
      const origin = p.params.origin as { y: number };
      for (const e of p.params.entries as { dy: number; result: string; payload?: Buffer }[]) {
        if (e.result !== 'success' || !e.payload) continue;
        const cy = origin.y + e.dy;
        const mine = decodeSubChunk(e.payload, (rid) => reg.stateIdFromRuntimeId(rid)).section.layers[0]!;
        const col = new Chunk({ x: 0, z: 0 });
        await col.networkDecodeSubChunkNoCache(cy, e.payload);
        for (let x = 0; x < 16; x++) {
          for (let z = 0; z < 16; z++) {
            for (let y = 0; y < 16; y++) {
              const ref = col.getBlockStateId({ x, y: cy * 16 + y, z });
              if (mine.stateAt(localIndex(x, y, z)) !== ref) throw new Error(`mismatch at ${x},${cy * 16 + y},${z}`);
            }
          }
        }
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(300);
  });
});
