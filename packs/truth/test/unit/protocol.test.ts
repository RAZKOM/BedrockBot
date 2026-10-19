import { describe, expect, it } from 'vitest';
import {
  MARKER,
  ReplyParser,
  RleEncoder,
  box,
  encodeReply,
  fnv1aOf,
  iterateBox,
  nsId,
  parseRequest,
  rleDecode,
  structureId,
  textOf,
  tokenize,
  type Reply,
} from '../../src/protocol.js';

describe('tokenize / parseRequest', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenize('  a  b\t"c d" "e\\"f" ')).toEqual(['a', 'b', 'c d', 'e"f']);
    expect(tokenize('""')).toEqual(['']);
  });

  it('takes the first #token as request id', () => {
    expect(parseRequest('truth:block', '#42 1 2 3')).toEqual({ cmd: 'block', id: '42', args: ['1', '2', '3'] });
    expect(parseRequest('truth:ping', '')).toEqual({ cmd: 'ping', id: null, args: [] });
    expect(parseRequest('truth:ping', '# x')).toEqual({ cmd: 'ping', id: null, args: ['#', 'x'] });
  });
});

describe('box and canonical order', () => {
  it('normalises corners and iterates y, z, x (x fastest)', () => {
    const b = box({ x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0 });
    expect(b.volume).toBe(8);
    const order = [...iterateBox(b)].map((p) => `${p.x}${p.y}${p.z}`);
    expect(order).toEqual(['000', '100', '001', '101', '010', '110', '011', '111']);
  });
});

describe('RLE', () => {
  it('round-trips through palette + runs', () => {
    const values = ['a', 'a', 'b', 'a', 'a', 'a', 'c'];
    const r = new RleEncoder();
    values.forEach((v) => r.push(v));
    expect(r.palette).toEqual(['a', 'b', 'c']);
    expect(r.runs).toEqual([
      [0, 2],
      [1, 1],
      [0, 3],
      [2, 1],
    ]);
    expect(rleDecode(r.palette, r.runs)).toEqual(values);
  });
});

describe('FNV-1a', () => {
  it('matches the reference 32-bit FNV-1a over bytes with 0x00 separators', () => {
    // reference values: FNV-1a("") = 811c9dc5, FNV-1a("a") = e40c292c, FNV-1a("a\0") = 2b24d044
    expect(fnv1aOf([])).toBe('811c9dc5');
    expect(fnv1aOf(['a'])).toBe('2b24d044');
    expect(fnv1aOf(['minecraft:air', 'minecraft:stone'])).not.toBe(fnv1aOf(['minecraft:stone', 'minecraft:air']));
  });
});

describe('ids', () => {
  it('namespaces bare ids', () => {
    expect(nsId('stone')).toBe('minecraft:stone');
    expect(nsId('truth:x')).toBe('truth:x');
    expect(structureId('forest')).toBe('mystructure:forest');
    expect(structureId('truth:probe')).toBe('truth:probe');
  });
});

describe('reply encoding', () => {
  const reply: Reply = { cmd: 'blocks', id: '7', ok: true, tick: 1, data: { s: 'x'.repeat(1000) } };

  it('fits in one line when short', () => {
    const lines = encodeReply(reply, 100000, 'r1');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(MARKER)).toBe(true);
    expect(new ReplyParser().feed(lines[0]!)).toEqual(reply);
  });

  it('fragments and reassembles long replies', () => {
    const lines = encodeReply(reply, 200, 'r2');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(200);
    const p = new ReplyParser();
    const results = lines.map((l) => p.feed(l));
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results.at(-1)).toEqual(reply);
  });

  it('ignores unrelated chat and extracts rawtext', () => {
    expect(new ReplyParser().feed('<Steve> hi')).toBeNull();
    const line = encodeReply(reply, 100000, 'r3')[0]!;
    const packet = { type: 'json', message: JSON.stringify({ rawtext: [{ text: line }] }) };
    expect(textOf(packet)).toBe(line);
  });
});
