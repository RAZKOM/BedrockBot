// Decision 0061: the push channel (health/panel/stream.ts) over real HTTP: topics, a snapshot on
// connect and deltas after, events, monotonic ids and resuming with Last-Event-ID, heartbeats, the
// stream cap, a slow client dropped, topic filters; then through the panel: the token, the state topic,
// a command pushing its effect, and a module adding its own topic and route (docs/panel.md "Add a topic").
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthServer } from '../../../src/connection/health.ts';
import { Metrics } from '../../../src/connection/metrics.ts';
import { applyDelta, type DeltaOp, type Json } from '../../../src/health/panel/client/delta.ts';
import { parseEventId, StreamHub } from '../../../src/health/panel/stream.ts';
import { HEARTBEAT_EVENT, HELLO_EVENT, STATE_TOPIC, type StreamHello } from '../../../src/health/panel/shared.ts';
import { silentLogger } from '../../../src/log.ts';
import { onFetchablePort, openSse, type SseStream } from './panel-sse.ts';

const servers: HealthServer[] = [];
const streams: SseStream[] = [];
const hubs: StreamHub[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  for (const h of hubs.splice(0)) h.close();
  for (const s of servers.splice(0)) await s.stop();
});

async function serve(hub: StreamHub): Promise<string> {
  hubs.push(hub);
  const { server, port } = await onFetchablePort(
    () => {
      const s = new HealthServer({ port: 0, metrics: new Metrics(), log: silentLogger });
      s.use(hub.route());
      return s;
    },
    (s) => s.start(),
    (s) => s.stop(),
  );
  servers.push(server);
  return `http://127.0.0.1:${port}`;
}

async function sse(url: string, headers: Record<string, string> = {}): Promise<SseStream> {
  const s = await openSse(url, headers);
  streams.push(s);
  return s;
}

const data = <T>(m: { data: string }): T => JSON.parse(m.data) as T;

describe('stream hub', () => {
  it('topic names and kinds are checked; ids parse', () => {
    const hub = new StreamHub();
    hubs.push(hub);
    hub.topic('state', { kind: 'state', read: () => ({}) });
    expect(() => hub.topic('state', { kind: 'event' })).toThrow(/exists/);
    expect(() => hub.topic('hello', { kind: 'event' })).toThrow(/exists/);
    expect(() => hub.topic('Bad Name', { kind: 'event' })).toThrow(/a-z/);
    expect(() => hub.topic('x', { kind: 'state', sampleMs: 100 })).toThrow(/needs read/);
    expect(() => hub.publish('nope', 1)).toThrow(/not registered/);
    expect(parseEventId('abc.12')).toEqual({ boot: 'abc', seq: 12 });
    expect(parseEventId('abc')).toBeUndefined();
    expect(parseEventId(undefined)).toBeUndefined();
  });

  it('connect: hello, then a snapshot; a change is a delta; nothing changed sends nothing; events pass through', async () => {
    const hub = new StreamHub({ boot: 'b1' });
    const pad = 'x'.repeat(200); // a delta is sent only when it is shorter than the snapshot
    let v: Json = { hp: 20, inv: [null, { n: 'stone', c: 64 }], log: ['a', 'b'], pad };
    const state = hub.topic(STATE_TOPIC, { kind: 'state', read: () => v });
    const ev = hub.topic('events', { kind: 'event' });
    const base = await serve(hub);
    const s = await sse(`${base}/api/stream`);
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(s.headers.get('cache-control')).toBe('no-store, no-transform');
    const hello = data<StreamHello>(await s.next(HELLO_EVENT));
    expect(hello).toEqual({ boot: 'b1', resumed: false, topics: ['state', 'events'], hb: 5000 });
    const snap = await s.next(STATE_TOPIC);
    expect(snap.id).toBe('b1.1');
    let have = data<{ snap: Json }>(snap).snap;
    expect(have).toEqual(v);
    v = { hp: 18, inv: [null, { n: 'stone', c: 63 }], log: ['b', 'c'], pad };
    state.refresh();
    state.publish(v); // the same value again: no message
    ev.publish({ text: 'chest emptied' });
    const d = await s.next(STATE_TOPIC);
    expect(d.id).toBe('b1.2');
    const ops = data<{ d: DeltaOp[] }>(d).d;
    expect(ops).toEqual([
      ['s', ['hp'], 18],
      ['s', ['inv', 1, 'c'], 63],
      ['a', ['log'], 1, ['c']],
    ]);
    have = applyDelta(have, ops);
    expect(have).toEqual(v);
    const e = await s.next('events');
    expect(e.id).toBe('b1.3'); // one sequence over every topic
    expect(data(e)).toEqual({ text: 'chest emptied' });
    expect(hub.stats()).toMatchObject({ clients: 1, opened: 1, seq: 3, topics: { state: { published: 2, snapshots: 1 }, events: { published: 1 } } });
  });

  it('resume: Last-Event-ID replays what was missed; another boot or a lost gap gets a snapshot', async () => {
    const hub = new StreamHub({ boot: 'b2', ring: 4 });
    let n = 0;
    const pad = 'x'.repeat(200);
    const t = hub.topic('state', { kind: 'state', read: () => ({ n, pad }) });
    const base = await serve(hub);
    const s1 = await sse(`${base}/api/stream`);
    const first = await s1.next('state');
    s1.close();
    n = 1;
    t.refresh();
    n = 2;
    t.refresh();
    const s2 = await sse(`${base}/api/stream`, { 'last-event-id': first.id });
    expect(data<StreamHello>(await s2.next(HELLO_EVENT)).resumed).toBe(true);
    let have = data<{ snap: Json }>(first).snap;
    const a = await s2.next('state');
    const b = await s2.next('state');
    expect([a.id, b.id]).toEqual(['b2.2', 'b2.3']);
    have = applyDelta(applyDelta(have, data<{ d: DeltaOp[] }>(a).d), data<{ d: DeltaOp[] }>(b).d);
    expect(have).toEqual({ n: 2, pad });
    // ?last= works like the header (the page uses it after a hidden tab)
    const s3 = await sse(`${base}/api/stream?last=${b.id}`);
    expect(data<StreamHello>(await s3.next(HELLO_EVENT)).resumed).toBe(true);
    // another boot: a snapshot
    const s4 = await sse(`${base}/api/stream`, { 'last-event-id': 'zz.2' });
    expect(data<StreamHello>(await s4.next(HELLO_EVENT)).resumed).toBe(false);
    expect(data<{ snap: Json }>(await s4.next('state')).snap).toEqual({ n: 2, pad });
    // the ring (4 messages) lost what came after b2.1: a snapshot
    for (n = 3; n < 9; n++) t.refresh();
    const s5 = await sse(`${base}/api/stream`, { 'last-event-id': first.id });
    expect(data<StreamHello>(await s5.next(HELLO_EVENT)).resumed).toBe(false);
    expect(data<{ snap: Json }>(await s5.next('state')).snap).toEqual({ n: 9, pad }); // the loop left n at 9; open() reads it
    expect(hub.stats().resumed).toBe(2);
  });

  it('the sampler pushes while a stream listens; a quiet stream gets heartbeats', async () => {
    const hub = new StreamHub({ heartbeatMs: 120 });
    let n = 0;
    hub.topic('state', { kind: 'state', read: () => ({ n, pad: 'x'.repeat(200) }), sampleMs: 40 });
    hub.topic('quiet', { kind: 'event' });
    const base = await serve(hub);
    const s = await sse(`${base}/api/stream?topics=state`);
    await s.next('state');
    n = 5;
    const d = await s.next('state', 1000);
    expect(data<{ d: DeltaOp[] }>(d).d).toEqual([['s', ['n'], 5]]);
    const q = await sse(`${base}/api/stream?topics=quiet`);
    expect(data<StreamHello>(await q.next(HELLO_EVENT)).topics).toEqual(['quiet']);
    const hb = await q.next(HEARTBEAT_EVENT, 1000);
    expect(Number(hb.data)).toBeGreaterThan(0);
    expect(q.messages.some((m) => m.event === 'state')).toBe(false); // not subscribed
    expect((await sse(`${base}/api/stream?topics=nope`)).status).toBe(400);
  });

  it('at most maxClients streams (503 beyond, the page polls); close() ends them', async () => {
    const hub = new StreamHub({ maxClients: 2 });
    hub.topic('state', { kind: 'state', read: () => ({ a: 1 }) });
    const base = await serve(hub);
    const a = await sse(`${base}/api/stream`);
    const b = await sse(`${base}/api/stream`);
    await a.next('state');
    await b.next('state');
    const c = await sse(`${base}/api/stream`);
    expect(c.status).toBe(503);
    expect(hub.stats()).toMatchObject({ clients: 2, refused: 1 });
    a.close();
    for (let i = 0; i < 50 && hub.stats().clients > 1; i++) await new Promise((r) => setTimeout(r, 10));
    const d = await sse(`${base}/api/stream`);
    expect(d.status).toBe(200);
    hub.close();
    await b.ended;
    expect(hub.stats().clients).toBe(0);
    expect((await fetch(`${base}/api/stream`)).status).toBe(503); // stopping
  });

  it('a slow client (its socket buffer past maxBuffered) is dropped, the others keep going', () => {
    const hub = new StreamHub({ maxBuffered: 1000 });
    hubs.push(hub);
    const t = hub.topic('events', { kind: 'event' });
    const fake = (buffered: () => number) => {
      const res = {
        destroyed: false,
        writableEnded: false,
        written: '',
        get writableLength() {
          return buffered();
        },
        writeHead: () => res,
        write: (s: string) => {
          res.written += s;
          return true;
        },
        end: () => undefined,
        on: () => res,
        destroy: () => {
          res.destroyed = true;
        },
      };
      return res;
    };
    const req = { method: 'GET', url: '/api/stream', headers: {}, socket: { setNoDelay: () => undefined } } as unknown as IncomingMessage;
    let backlog = 0;
    const slow = fake(() => backlog);
    const fast = fake(() => 0);
    hub.open(req, slow as unknown as ServerResponse);
    hub.open(req, fast as unknown as ServerResponse);
    expect(hub.stats().clients).toBe(2);
    backlog = 5000;
    t.publish({ big: 'x'.repeat(100) });
    expect(slow.destroyed).toBe(true);
    expect(hub.stats()).toMatchObject({ clients: 1, dropped: 1 });
    t.publish({ next: 1 });
    expect(fast.written).toContain('"next":1');
    expect(slow.written).not.toContain('"next":1');
  });
});
