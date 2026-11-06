// Task 5.4: health endpoint (127.0.0.1 only, /healthz 200/503, /metrics JSON) and metric rates.
import { afterEach, describe, expect, it } from 'vitest';
import { HEALTH_HOST, HealthServer, summarize } from '../../src/connection/health.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import { TARGET, setup } from './connection-fakes.ts';
import { onFetchablePort } from './health/panel-sse.ts';

let server: HealthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function get(port: number, path: string, method = 'GET'): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://${HEALTH_HOST}:${port}${path}`, { method });
  return { status: res.status, body: method === 'HEAD' ? {} : ((await res.json()) as Record<string, unknown>) };
}

describe('HealthServer', () => {
  it('/healthz is 503 until spawned, 200 while spawned and alive, 503 again when dead or closed', async () => {
    const { conn, clients } = setup();
    const metrics = new Metrics();
    metrics.attach(conn);
    metrics.provide(() => ({ task: 'afk', server: '127.0.0.1:19132 (raknet)', taskStatus: { logsPerHour: 12.5 } }));
    let alive = true;
    const started = await onFetchablePort(() => new HealthServer({ port: 0, metrics, alive: () => alive }), (s) => s.start(), (s) => s.stop());
    server = started.server;
    const port = started.port;
    expect(port).toBeGreaterThan(0);

    expect((await get(port, '/healthz')).status).toBe(503);
    const p = conn.connect(TARGET);
    await new Promise((r) => setTimeout(r, 10));
    clients.at(-1)!.spawn(5n);
    await p;
    const ok = await get(port, '/healthz');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, state: 'spawned' });
    alive = false;
    expect((await get(port, '/healthz')).status).toBe(503);
    alive = true;

    metrics.inc('nudges', 3);
    metrics.inc('deaths');
    metrics.inc('corrections', 4);
    const m = await get(port, '/metrics');
    expect(m.status).toBe(200);
    expect(m.body.summary).toMatchObject({
      healthy: true,
      state: 'spawned',
      reconnects: 0,
      deaths: 1,
      nudges: 3,
      logsPerHour: 12.5,
      gameVersion: '1.26.51',
      server: '127.0.0.1:19132 (raknet)',
      task: 'afk',
    });
    expect((m.body.summary as { correctionsPerMin: number }).correctionsPerMin).toBeGreaterThan(0);
    expect(m.body).toHaveProperty('counters');
    expect(m.body).toHaveProperty('rates');

    expect((await get(port, '/nope')).status).toBe(404);
    expect((await get(port, '/healthz', 'POST')).status).toBe(405);
    conn.disconnect();
    expect((await get(port, '/healthz')).status).toBe(503);
  });

  it('binds to 127.0.0.1 only', async () => {
    server = new HealthServer({ port: 0, metrics: new Metrics() });
    const port = await server.start();
    // The address the server reports is the loopback one.
    expect(port).toBeGreaterThan(0);
    const addr = (server as unknown as { server: { address(): { address: string } } }).server.address();
    expect(addr.address).toBe('127.0.0.1');
  });

  it('a port in use is reported as an error', async () => {
    server = new HealthServer({ port: 0, metrics: new Metrics() });
    const port = await server.start();
    const second = new HealthServer({ port, metrics: new Metrics() });
    await expect(second.start()).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('Metrics rates', () => {
  it('corrections per minute over 10 minutes, deaths and reconnects per hour', () => {
    let now = new Date('2026-10-29T00:00:00Z').getTime();
    const metrics = new Metrics({ now: () => new Date(now) });
    now += 60_000; // 1 min up
    metrics.inc('corrections', 6);
    expect(metrics.rates().correctionsPerMin).toBe(6);
    expect(metrics.rates().correctionsLastMin).toBe(6);
    now += 9 * 60_000; // 10 min up, the 6 corrections are 9 min old
    expect(metrics.rates().correctionsPerMin).toBe(0.6);
    expect(metrics.rates().correctionsLastMin).toBe(0);
    now += 2 * 60_000; // outside the 10-minute window
    expect(metrics.rates().correctionsPerMin).toBe(0);
    metrics.inc('deaths', 2);
    now += 48 * 60_000; // 1 h up
    expect(metrics.rates().deathsPerHour).toBe(2);
    expect(metrics.snapshot().rates).toEqual(metrics.rates());
  });

  it('summarize() takes logsPerHour from the task status and null otherwise', () => {
    const snap = new Metrics().snapshot();
    expect(summarize(snap).logsPerHour).toBeNull();
    expect(summarize({ ...snap, taskStatus: { logsPerHour: 3 } }).logsPerHour).toBe(3);
    expect(summarize(snap).healthy).toBe(false);
  });
});
