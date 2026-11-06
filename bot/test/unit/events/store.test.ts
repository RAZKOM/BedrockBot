// The JSONL store (decision 0059, docs/events.md "Storage"): restart continuity, retention by days and
// by size, a corrupt line skipped, a disk error degrading to memory only, queries from files and ring.
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../../src/events/bus.ts';
import { DAY_MS, dayOf, EventStore, lastStoredId, parseLine } from '../../../src/events/store.ts';
import type { Logger } from '../../../src/log.ts';

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);

function logger(): Logger & { errors: string[]; infos: string[] } {
  const errors: string[] = [];
  const infos: string[] = [];
  return { errors, infos, debug() {}, info: (m: string) => infos.push(m), warn() {}, error: (m: string) => errors.push(m) };
}

describe('event store', () => {
  let dir: string;
  let bus: EventBus;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bot-events-'));
    bus = new EventBus(100);
    bus.strict = true;
  });
  afterEach(() => {
    bus.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one line per event into the day file, ids continue after a restart, old events survive', async () => {
    let t = T0;
    bus.now = () => t;
    const s1 = EventStore.open({ dir, now: () => t });
    bus.attach(s1, { lastId: s1.lastId });
    bus.emit('connection.connected', { server: 's', version: 'v' });
    bus.emit('combat.kill', { mob: 'zombie' });
    t += DAY_MS; // next UTC day: a second file
    bus.emit('job.failed', { job: 'mine', reason: 'no_pickaxe', durationS: 3 });
    await bus.close();
    expect(readdirSync(dir).sort()).toEqual([`${dayOf(T0)}.jsonl`, `${dayOf(T0 + DAY_MS)}.jsonl`]);
    expect(readFileSync(join(dir, `${dayOf(T0)}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(lastStoredId(dir)).toBe(3);

    // "restart": a new bus and store on the same directory
    const bus2 = new EventBus(100);
    bus2.now = () => t;
    const s2 = EventStore.open({ dir, now: () => t });
    expect(s2.lastId).toBe(3);
    bus2.attach(s2, { lastId: s2.lastId });
    expect(bus2.emit('connection.connected', { server: 's', version: 'v' })?.id).toBe(4);
    const all = await bus2.query({ since: 0 });
    expect(all.events.map((e) => e.kind)).toEqual(['connection.connected', 'combat.kill', 'job.failed', 'connection.connected']);
    const failed = await bus2.query({ min: 'notable' });
    expect(failed.events.map((e) => e.id)).toEqual([3]);
    const byTime = await bus2.query({ since: T0 + DAY_MS - 1, kinds: ['job'] });
    expect(byTime.events.map((e) => e.id)).toEqual([3]);
    await bus2.close();
  });

  it('paging: since an id returns the oldest `limit` after it, without since the newest', async () => {
    const s = EventStore.open({ dir, now: () => T0 });
    bus.now = () => T0;
    bus.attach(s);
    for (let i = 0; i < 10; i++) bus.emit('combat.kill', { mob: `m${i}` });
    await s.flush();
    const q = await s.query({ since: 3, limit: 4 });
    expect(q!.events.map((e) => e.id)).toEqual([4, 5, 6, 7]);
    expect(q!.more).toBe(true);
    const newest = await s.query({ limit: 3 });
    expect(newest!.events.map((e) => e.id)).toEqual([8, 9, 10]);
    const until = await s.query({ since: 0, until: 2 });
    expect(until!.events.map((e) => e.id)).toEqual([1, 2]);
    await bus.close();
  });

  it('events not written yet are part of the answer', async () => {
    const s = EventStore.open({ dir, now: () => T0, flushMs: 60_000 });
    bus.now = () => T0;
    bus.attach(s);
    bus.emit('combat.kill', { mob: 'zombie' });
    expect(readdirSync(dir)).toEqual([]);
    expect((await s.query({ since: 0 }))!.events).toHaveLength(1);
    await bus.close();
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('a corrupt line is skipped and counted; the id scan steps over it', async () => {
    const f = join(dir, `${dayOf(T0)}.jsonl`);
    writeFileSync(f, `${JSON.stringify({ id: 1, ts: T0, kind: 'combat.kill', sev: 'info', data: { mob: 'a' } })}\n{"id":2,"ts":${T0},"kind":"combat.ki\nnot json at all\n`);
    appendFileSync(f, `${JSON.stringify({ id: 3, ts: T0, kind: 'combat.kill', sev: 'info', data: { mob: 'b' } })}\n{"id":4,"ts"`);
    expect(parseLine('{"id":1}')).toBeUndefined();
    expect(lastStoredId(dir)).toBe(3);
    const s = EventStore.open({ dir, now: () => T0 });
    const r = await s.query({ since: 0 });
    expect(r!.events.map((e) => e.id)).toEqual([1, 3]);
    expect(r!.skipped).toBe(3);
    await s.close();
  });

  it('retention: files older than `days` go, then the oldest until the total fits; today stays', async () => {
    const line = (id: number, ts: number) => `${JSON.stringify({ id, ts, kind: 'combat.kill', sev: 'info', data: { mob: 'x'.repeat(200) } })}\n`;
    for (let d = 0; d < 6; d++) {
      const ts = T0 - d * DAY_MS;
      writeFileSync(join(dir, `${dayOf(ts)}.jsonl`), line(100 - d, ts).repeat(10));
    }
    writeFileSync(join(dir, 'notes.txt'), 'not an event file');
    const log = logger();
    let days = 4;
    let maxBytes = 1e9;
    const s = EventStore.open({ dir, now: () => T0, days: () => days, maxBytes: () => maxBytes, log });
    await s.flush();
    await new Promise((r) => setTimeout(r, 50)); // the retention started by open()
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()).toEqual([3, 2, 1, 0].map((d) => `${dayOf(T0 - d * DAY_MS)}.jsonl`));
    expect(log.infos.some((m) => m.includes('deleted 2 old file(s)'))).toBe(true);
    const size = readFileSync(join(dir, `${dayOf(T0)}.jsonl`)).length;
    maxBytes = size * 2 + 1; // room for two files: today and yesterday
    days = 30;
    expect(await s.retention()).toEqual([3, 2].map((d) => `${dayOf(T0 - d * DAY_MS)}.jsonl`));
    maxBytes = 1; // only today's file is left whatever the cap
    await s.retention();
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toEqual([`${dayOf(T0)}.jsonl`]);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    await s.close();
  });

  it('a failed write switches to memory only with one error; the bus answers from its ring', async () => {
    const log = logger();
    let calls = 0;
    const s = EventStore.open({
      dir,
      log,
      now: () => T0,
      append: () => {
        calls++;
        return Promise.reject(new Error('EIO: disk gone'));
      },
    });
    bus.now = () => T0;
    bus.attach(s);
    bus.emit('combat.kill', { mob: 'a' });
    await s.flush();
    bus.emit('combat.kill', { mob: 'b' });
    await s.flush();
    expect(calls).toBe(1);
    expect(s.memoryOnly).toBe(true);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toMatch(/memory only/);
    expect((await bus.query({ since: 0 })).events.map((e) => (e.data as { mob: string }).mob)).toEqual(['a', 'b']);
    await bus.close();
  });

  it('a directory that cannot be created means memory only from the start', () => {
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const log = logger();
    const s = EventStore.open({ dir: join(file, 'events'), log });
    expect(s.memoryOnly).toBe(true);
    expect(log.errors[0]).toMatch(/cannot create/);
  });
});
