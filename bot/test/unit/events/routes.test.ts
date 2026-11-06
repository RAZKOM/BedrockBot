// GET /api/events, /api/events/summary, /api/events/kinds (decision 0059, docs/events.md "Query API")
// on a real HTTP server, and the summary over a fixed event list.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../../../src/events/bus.ts';
import { eventRoutes, parseEventQuery } from '../../../src/events/routes.ts';
import { summarize } from '../../../src/events/summary.ts';
import type { BotEvent } from '../../../src/events/registry.ts';
import { onFetchablePort } from '../health/panel-sse.ts';

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);

describe('event routes', () => {
  const bus = new EventBus();
  let server: Server;
  let base: string;
  let t = T0 - 9 * 3_600_000;

  beforeAll(async () => {
    bus.strict = true;
    bus.now = () => t;
    bus.emit('connection.connected', { server: 's', version: 'v' }); // 9 h ago: outside the 8 h summary
    t = T0 - 3_600_000;
    bus.emit('command.received', { command: 'kill', text: '!kill zombie', source: 'panel', sender: 'console' });
    bus.emit('job.started', { job: 'kill', kind: 'user', line: 'kill zombie', by: 'console' });
    bus.emit('combat.fight', { mob: 'zombie', outcome: 'killed', ticks: 60, attacks: 4, landed: 4, damageTaken: 2.5, kills: 1 });
    bus.emit('combat.kill', { mob: 'zombie' });
    bus.emit('job.finished', { job: 'kill', result: 'done (killed 1, want 1)', durationS: 3 });
    bus.emit('items.changed', { gained: { rotten_flesh: 2, cobblestone: 5 }, lost: { cobblestone: 2 }, jobs: ['kill'], periodS: 60 });
    bus.emit('container.deposit', { at: { x: 100, y: 64, z: -50 }, block: 'chest', items: { rotten_flesh: 2 } });
    bus.emit('combat.damage', { hits: 2, damage: 4.5, by: { zombie: 4.5 }, periodS: 60 });
    bus.emit('life.died', { n: 1, cause: 'death.attack.zombie' });
    bus.emit('job.failed', { job: 'mine', reason: 'no_pickaxe', durationS: 20 });
    const route = eventRoutes(bus, () => T0);
    // a port fetch() accepts (panel-sse.ts: port 0 can be one of the Fetch standard's bad ports)
    const got = await onFetchablePort(
      () =>
        createServer((req, res) => {
          const path = new URL(req.url ?? '/', 'http://x').pathname;
          if (!route(path, req, res)) {
            res.writeHead(404);
            res.end();
          }
        }),
      (sv) => new Promise<number>((r) => sv.listen(0, '127.0.0.1', () => r((sv.address() as AddressInfo).port))),
      (sv) => new Promise((r) => sv.close(r)),
    );
    server = got.server;
    base = `http://127.0.0.1:${got.port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const get = async (p: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  it('GET /api/events: filters, text, paging', async () => {
    const all = await get('/api/events');
    expect(all.status).toBe(200);
    const events = all.body.events as (BotEvent & { text: string })[];
    expect(events).toHaveLength(11);
    expect(events[4]!.text).toBe('killed a zombie');
    expect(all.body.next).toBe(11);
    const notable = await get('/api/events?min=notable');
    expect((notable.body.events as BotEvent[]).map((e) => e.kind)).toEqual(['life.died', 'job.failed']);
    const jobs = await get('/api/events?kinds=job,combat.kill');
    expect((jobs.body.events as BotEvent[]).map((e) => e.kind)).toEqual(['job.started', 'combat.kill', 'job.finished', 'job.failed']);
    const page = await get('/api/events?since=3&limit=2');
    expect((page.body.events as BotEvent[]).map((e) => e.id)).toEqual([4, 5]);
    expect(page.body.more).toBe(true);
    expect(page.body.next).toBe(5);
    const window = await get(`/api/events?since=${T0 - 2 * 3_600_000}&kinds=connection`);
    expect(window.body.events).toEqual([]);
  });

  it('bad parameters are a 400 with the reason; other methods 405; other paths fall through', async () => {
    expect((await get('/api/events?kinds=job,nope')).body.error).toMatch(/unknown kind\(s\) nope/);
    expect((await get('/api/events?min=urgent')).status).toBe(400);
    expect((await get('/api/events?limit=0')).status).toBe(400);
    expect((await get('/api/events?since=-1')).status).toBe(400);
    expect((await get('/api/events/summary?hours=0')).status).toBe(400);
    expect((await fetch(`${base}/api/events`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/api/eventsx`)).status).toBe(404);
    expect(parseEventQuery(new URLSearchParams('since=12&kinds=life'))).toEqual({ since: 12, until: undefined, limit: undefined, kinds: ['life'], min: undefined });
  });

  it('GET /api/events/summary?hours=8 and /api/events/kinds', async () => {
    const s = await get('/api/events/summary?hours=8');
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({
      hours: 8,
      total: 10,
      counts: { 'job.started': 1, 'combat.kill': 1 },
      bySeverity: { info: 8, notable: 1, alert: 1 },
      items: { gained: { cobblestone: 5, rotten_flesh: 2 }, lost: { cobblestone: 2 }, net: { cobblestone: 3, rotten_flesh: 2 } },
      containers: { deposited: { rotten_flesh: 2 }, withdrawn: {} },
      combat: { fights: 1, kills: 1, damageTaken: 4.5, flees: 0 },
      deaths: [{ cause: 'death.attack.zombie' }],
    });
    expect((s.body.jobs as { job: string; result: string }[]).map((j) => `${j.job} ${j.result}`)).toEqual(['kill finished', 'mine failed']);
    expect((s.body.highlights as { text: string }[]).map((h) => h.text)).toEqual(['died (zombie) at ?', 'mine failed: no_pickaxe (20 s)']);
    const k = await get('/api/events/kinds');
    expect((k.body.kinds as { kind: string }[]).some((x) => x.kind === 'job.failed')).toBe(true);
  });

  it('summarize marks a truncated window', () => {
    expect(summarize([], { hours: 1, now: T0, truncated: true })).toMatchObject({ total: 0, truncated: true, from: T0 - 3_600_000 });
  });
});
