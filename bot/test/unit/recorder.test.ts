import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { PacketRecorder, parseRecording, serializeRecord, toJsonSafe } from '../../src/connection/recorder.ts';

const dir = mkdtempSync(join(tmpdir(), 'recorder-test-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('serializeRecord', () => {
  it('writes BigInt as strings and bytes as base64', () => {
    const line = serializeRecord({
      dir: 'in',
      t: 5,
      tick: 3,
      name: 'start_game',
      params: { runtime_entity_id: 1n, nested: { big: -4294967295n, list: [1n, 2] }, payload: Buffer.from([1, 2, 3]), u8: new Uint8Array([255]) },
    });
    expect(JSON.parse(line)).toEqual({
      dir: 'in',
      t: 5,
      tick: 3,
      name: 'start_game',
      params: { runtime_entity_id: '1', nested: { big: '-4294967295', list: ['1', 2] }, payload: { $bytes: 'AQID' }, u8: { $bytes: '/w==' } },
    });
    expect(line).not.toContain('\n');
  });

  it('toJsonSafe matches the stored shape', () => {
    expect(toJsonSafe({ a: 1n, b: Buffer.from('hi'), c: [{ d: 2n }], e: undefined })).toEqual({ a: '1', b: { $bytes: 'aGk=' }, c: [{ d: '2' }] });
  });
});

describe('PacketRecorder', () => {
  it('records direction, relative time, tick and name; redacts login', () => {
    const lines: string[] = [];
    let now = 1000;
    const rec = new PacketRecorder((l) => lines.push(l), { now: () => now, includeRaw: true });
    rec.record('out', 'login', { tokens: { identity: 'secret-chain' } }, 0n, Buffer.from('secret'));
    now = 1050;
    rec.record('in', 'text', { type: 'chat', message: 'hi' }, 7n, Buffer.from([9, 0]));
    expect(rec.count).toBe(2);
    const parsed = parseRecording(lines.join(''));
    expect(parsed[0]).toEqual({ dir: 'out', t: 0, tick: 0, name: 'login', params: '[redacted]' });
    expect(parsed[1]).toEqual({ dir: 'in', t: 50, tick: 7, name: 'text', params: { type: 'chat', message: 'hi' }, raw: 'CQA=' });
    expect(lines.join('')).not.toContain('secret');
  });

  it('omits raw unless asked to', () => {
    const lines: string[] = [];
    const rec = new PacketRecorder((l) => lines.push(l));
    rec.record('in', 'text', {}, 1, Buffer.from([1]));
    expect(parseRecording(lines.join(''))[0]).not.toHaveProperty('raw');
  });

  it('writes jsonl files, gzip when the name ends in .gz, and ignores writes after close', async () => {
    const plain = join(dir, 'sub', 'a.jsonl');
    const gz = join(dir, 'b.jsonl.gz');
    for (const path of [plain, gz]) {
      const rec = new PacketRecorder(path);
      rec.record('meta', 'connect', { host: '127.0.0.1' });
      rec.record('in', 'play_status', { status: 'player_spawn' }, 0n);
      await rec.close();
      rec.record('in', 'late', {});
      const buf = readFileSync(path);
      const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      const lines = parseRecording(text);
      expect(lines.map((l) => [l.dir, l.name])).toEqual([
        ['meta', 'connect'],
        ['in', 'play_status'],
      ]);
      expect(text.endsWith('\n')).toBe(true);
    }
  });
});
