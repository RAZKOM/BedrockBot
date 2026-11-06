// Decision 0061 on bds-core (docs/panel.md "Live updates", "Budgets", "Measured"): the panel's push
// channel and browser modules on a real bot process.
//   1. the page: its HTML under the budget, one entry <script type="module"> and a modulepreload per
//      module; every module served type-stripped (raw and gzip, immutable cache, 304), all under budget;
//   2. GET /api/stream: 401 without the token; hello, then a snapshot (time to first snapshot, size);
//      idle deltas for 10 s (count, sizes, bytes per second);
//   3. `!set` from the panel arrives as a delta (latency) and as a command.received event on the events
//      topic (also in /api/events); a truth `give` arrives as an inventory delta;
//   4. resuming with Last-Event-ID replays the missed messages, and the result equals a fresh snapshot;
//   5. the stream cap (8): the ninth stream is 503 (the page polls); ?lite=1 polling still works;
//   6. !quit.
// Env: PANEL_E2E_PORT (default a random port in 9940..9949) plus core-truth.ts (CORE_BDS_*).
// Needs BDS_E2E=1 and bds-core with the truth pack (`node scripts/bds.mjs --profile core up` and `... pack`).
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PANEL_BUDGETS } from '../../src/health/panel/budgets.ts';
import { applyDelta, type DeltaOp, type Json } from '../../src/health/panel/client/delta.ts';
import { EVENTS_TOPIC, HELLO_EVENT, STATE_TOPIC, type PanelStateLite, type StreamHello } from '../../src/health/panel/shared.ts';
import { openSse, type SseMessage, type SseStream } from '../unit/health/panel-sse.ts';
import { PveTruth } from './pve-truth.ts';
import { centre, clearArea, connectPlayer, CORE_CONTAINER, E2E, FEET_Y, prepareServer, privateArea, sleep, startCli, until, waitOnline, type CoreCli } from './core-truth.ts';

const PORT = Number(process.env.PANEL_E2E_PORT ?? 9940 + randomInt(10));
const TOKEN = Array.from({ length: 24 }, () => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(57)]).join('');
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { authorization: `Bearer ${TOKEN}` };

type Msg = { snap: PanelStateLite } | { d: DeltaOp[] };
const parse = (m: SseMessage): Msg => JSON.parse(m.data) as Msg;
const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const setting = (s: PanelStateLite, key: string): string | undefined => s.settings.find((r) => r.key === key)?.value;
const count = (s: PanelStateLite, item: string): number => (s.inventory?.slots ?? []).reduce((n, x) => n + (x?.name === item ? x.count : 0), 0);

async function cmd(text: string): Promise<{ status: number; replies: string[] }> {
  const r = await fetch(`${BASE}/api/cmd`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  const body = (await r.json()) as { replies?: string[] };
  return { status: r.status, replies: body.replies ?? [] };
}

/** Follow the state topic of a stream: apply every snapshot or delta, until `done` holds (returns the messages it took). */
async function follow(s: SseStream, have: { v: PanelStateLite }, done: (v: PanelStateLite) => boolean, ms: number): Promise<SseMessage[]> {
  const took: SseMessage[] = [];
  const deadline = Date.now() + ms;
  while (!done(have.v)) {
    const m = await s.next(STATE_TOPIC, Math.max(1, deadline - Date.now()));
    took.push(m);
    const p = parse(m);
    have.v = 'snap' in p ? p.snap : (applyDelta(have.v as unknown as Json, p.d) as unknown as PanelStateLite);
  }
  return took;
}

describe.skipIf(!E2E)('core: panel push channel and browser modules (decision 0061)', () => {
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];
  const open: SseStream[] = [];
  let observer: Awaited<ReturnType<typeof connectPlayer>> | undefined;
  let truth: PveTruth | undefined;
  let cli: CoreCli | undefined;
  let tmp: string | undefined;

  const stream = async (path = '/api/stream', headers: Record<string, string> = {}): Promise<SseStream> => {
    const s = await openSse(`${BASE}${path}`, { ...AUTH, ...headers });
    open.push(s);
    return s;
  };

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    observer = await connectPlayer(`StreamObs${randomInt(1000, 9999)}`);
    truth = new PveTruth(observer.conn, CORE_CONTAINER);
    await truth.tp(observer.name, { x: HOME.x + 0.5, y: FEET_Y, z: HOME.z - 24 + 0.5 }, 0, 0);
    await clearArea(truth, HOME, 8, 4);
    // the child inherits these: the token, and the world cache and the event store in a temporary
    // directory, never under the user's config directory
    tmp = mkdtempSync(join(tmpdir(), 'bot-e2e-panel-stream-'));
    process.env.BEDROCKBOT_PANEL_TOKEN = TOKEN;
    process.env.BEDROCKBOT_CACHE_DIR = join(tmp, 'cache');
    process.env.BEDROCKBOT_EVENTS_DIR = join(tmp, 'events');
    delete process.env.BEDROCKBOT_CACHE;
    cli = startCli(['--walk', '--health-port', String(PORT)]);
    delete process.env.BEDROCKBOT_PANEL_TOKEN;
    delete process.env.BEDROCKBOT_CACHE_DIR;
    delete process.env.BEDROCKBOT_EVENTS_DIR;
    await waitOnline(truth, cli.name);
    await truth.tp(cli.name, centre(HOME), 0, 0);
    await until(async () => ((await fetch(`${BASE}/healthz`).catch(() => undefined))?.status === 200 ? true : undefined), 20_000, 'panel /healthz 200', 250);
  }, 90_000);

  afterAll(async () => {
    for (const s of open) s.close();
    cli?.kill(); // only if a test failed before !quit
    await truth?.cleanup().catch(() => undefined);
    await truth?.clearAround(centre(HOME), 16).catch(() => undefined);
    await observer?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    console.log(`panel stream e2e (port ${PORT}, area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  it('the page and its modules: one entry module, a preload per module, type-stripped, cached, under budget', async () => {
    const html = await fetch(`${BASE}/`, { headers: AUTH }).then((r) => r.text());
    const htmlBytes = Buffer.byteLength(html);
    expect(htmlBytes).toBeLessThan(PANEL_BUDGETS.html);
    expect(html).not.toContain(TOKEN);
    const entry = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => m[1]!);
    const preload = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]!);
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatch(/^\/ui\/[\w-]{12}\/client\/boot\.ts$/);
    expect(preload[0]).toBe(entry[0]);
    let raw = 0;
    let gz = 0;
    const sizes: string[] = [];
    for (const url of preload) {
      expect((await fetch(`${BASE}${url}`)).status).toBe(401); // the token covers the modules too
      const plain = await fetch(`${BASE}${url}`, { headers: { ...AUTH, 'accept-encoding': 'identity' } });
      expect(plain.status).toBe(200);
      expect(plain.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      expect(plain.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      const code = await plain.text();
      expect(code).not.toMatch(/^\s*import type\b/m);
      // fetch() decodes gzip by itself: the wire size is the content-length, the body the same code
      const zipped = await fetch(`${BASE}${url}`, { headers: { ...AUTH, 'accept-encoding': 'gzip' } });
      expect(zipped.headers.get('content-encoding')).toBe('gzip');
      const wire = Number(zipped.headers.get('content-length'));
      expect(await zipped.text()).toBe(code);
      const bytes = Buffer.byteLength(code);
      expect(bytes).toBeLessThan(PANEL_BUDGETS.module);
      raw += bytes;
      gz += wire;
      sizes.push(`${url.replace(/^\/ui\/[^/]+\//, '')} ${bytes}/${wire}`);
      const etag = plain.headers.get('etag')!;
      expect((await fetch(`${BASE}${url}`, { headers: { ...AUTH, 'if-none-match': etag } })).status).toBe(304);
    }
    expect(raw).toBeLessThan(PANEL_BUDGETS.modules);
    measurements.push(`page ${htmlBytes} bytes (budget ${PANEL_BUDGETS.html}); ${preload.length} modules ${raw} bytes raw, ${gz} gzip (budget ${PANEL_BUDGETS.modules}): ${sizes.join(', ')}`);
  });

  it('GET /api/stream: 401 without the token; hello, a snapshot, then idle deltas', async () => {
    expect((await openSse(`${BASE}/api/stream`)).status).toBe(401);
    const t0 = performance.now();
    const s = await stream();
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const hello = JSON.parse((await s.next(HELLO_EVENT)).data) as StreamHello;
    expect(hello.topics).toContain(STATE_TOPIC);
    expect(hello.resumed).toBe(false);
    const first = await s.next(STATE_TOPIC);
    const firstMs = performance.now() - t0;
    const snap = parse(first);
    expect('snap' in snap).toBe(true);
    const have = { v: (snap as { snap: PanelStateLite }).snap };
    expect(have.v.lite).toBe(true);
    expect(have.v.bot.name).toBe(cli!.name);
    expect(first.bytes).toBeLessThan(PANEL_BUDGETS.snapshot);
    // idle: 10 s of whatever changes on its own (the clock, uptime, the log)
    const from = s.messages.indexOf(first) + 1;
    await sleep(10_000);
    const after = s.messages.slice(from);
    const idle = after.filter((m) => m.event === STATE_TOPIC);
    const hb = after.filter((m) => m.event === 'hb');
    for (const m of idle) {
      const p = parse(m);
      have.v = 'snap' in p ? p.snap : (applyDelta(have.v as unknown as Json, p.d) as unknown as PanelStateLite);
    }
    const sizes = idle.map((m) => m.bytes);
    const big = idle.filter((m) => m.bytes >= PANEL_BUDGETS.delta);
    for (const m of big) {
      const p = parse(m);
      const what = 'snap' in p ? 'a snapshot' : p.d.map((op) => `${op[0]} ${op[1].join('.')} ${JSON.stringify(op.slice(2)).length}`).join('; ');
      measurements.push(`over the delta budget: ${m.id} ${m.bytes} bytes: ${what}`);
    }
    s.close();
    expect(big.map((m) => m.bytes)).toEqual([]);
    const total = sizes.reduce((a, b) => a + b, 0) + hb.reduce((a, m) => a + m.bytes, 0);
    // the applied state matches the server's
    const lite = (await fetch(`${BASE}/api/state?lite=1`, { headers: AUTH }).then((r) => r.json())) as PanelStateLite;
    expect(have.v.bot.name).toBe(lite.bot.name);
    expect(have.v.settings).toEqual(lite.settings);
    measurements.push(
      `stream: first snapshot ${first.bytes} bytes after ${firstMs.toFixed(0)} ms (budget ${PANEL_BUDGETS.snapshot}); idle 10 s: ${idle.length} deltas (median ${med(sizes)}, max ${Math.max(0, ...sizes)} bytes; budget ${PANEL_BUDGETS.delta}), ${hb.length} heartbeats, ${(total / 10).toFixed(0)} bytes/s`,
    );
    s.close();
  }, 30_000);

  it('a command and an inventory change arrive as deltas', async () => {
    const s = await stream();
    const first = parse(await s.next(STATE_TOPIC));
    const have = { v: (first as { snap: PanelStateLite }).snap };
    // !set from the panel: the hub pushes 250 ms after a command
    const t0 = performance.now();
    expect((await cmd('!set guardRadius 9')).status).toBe(200);
    const took = await follow(s, have, (v) => setting(v, 'guardRadius') === '9', 5000);
    const setMs = performance.now() - t0;
    const setBytes = took.at(-1)!.bytes;
    // the same command as a bot event on the events topic (decision 0059: command.received, source panel)
    interface Ev {
      id: number;
      kind: string;
      data: { text?: string; source?: string };
      text: string;
    }
    const evMsg = await until(
      () => s.messages.find((m) => m.event === EVENTS_TOPIC && (JSON.parse(m.data) as Ev).data.text === '!set guardRadius 9'),
      5000,
      'command.received on the events topic',
      50,
    );
    const ev = JSON.parse(evMsg.data) as Ev;
    expect(ev).toMatchObject({ kind: 'command.received', data: { source: 'panel' } });
    expect(ev.text).toContain('!set guardRadius 9');
    expect(evMsg.bytes).toBeLessThan(PANEL_BUDGETS.event);
    // a late page fills in from the event API, then follows the topic: the same event there
    const listed = (await fetch(`${BASE}/api/events?limit=50`, { headers: AUTH }).then((r) => r.json())) as { events: Ev[] };
    expect(listed.events.find((x) => x.id === ev.id)).toMatchObject({ kind: 'command.received', text: ev.text });
    // a truth give: the sampler (1 s) sees the new stack
    const before = count(have.v, 'oak_planks');
    const t1 = performance.now();
    await truth!.ok('give', [cli!.name, 'oak_planks', 7]);
    const inv = await follow(s, have, (v) => count(v, 'oak_planks') === before + 7, 8000);
    const invMs = performance.now() - t1;
    const invMsg = inv.at(-1)!;
    expect('d' in parse(invMsg)).toBe(true);
    expect(invMsg.bytes).toBeLessThan(PANEL_BUDGETS.delta);
    await sleep(1100); // the command rate limit
    expect((await cmd('!set guardRadius 16')).status).toBe(200);
    measurements.push(`!set -> delta ${setMs.toFixed(0)} ms (${setBytes} bytes), event ${evMsg.bytes} bytes ("${ev.text}"); give 7 oak_planks -> inventory delta ${invMs.toFixed(0)} ms (${invMsg.bytes} bytes: ${invMsg.data.slice(0, 160)})`);
    expect(setMs).toBeLessThan(1500);
    expect(invMs).toBeLessThan(4000);
    s.close();
  }, 30_000);

  it('Last-Event-ID resumes: the missed messages replay, and the result equals a fresh snapshot', async () => {
    const s = await stream();
    const have = { v: (parse(await s.next(STATE_TOPIC)) as { snap: PanelStateLite }).snap };
    let lastId = s.messages.filter((m) => m.event === STATE_TOPIC).at(-1)!.id;
    await sleep(1500);
    for (const m of s.messages.filter((x) => x.event === STATE_TOPIC).slice(1)) {
      const p = parse(m);
      have.v = 'snap' in p ? p.snap : (applyDelta(have.v as unknown as Json, p.d) as unknown as PanelStateLite);
      lastId = m.id;
    }
    s.close();
    await sleep(1100);
    expect((await cmd('!set guardRadius 11')).status).toBe(200); // changes while away
    await sleep(2500);
    const r = await stream('/api/stream', { 'last-event-id': lastId });
    const hello = JSON.parse((await r.next(HELLO_EVENT)).data) as StreamHello;
    expect(hello.resumed).toBe(true);
    const replay = await follow(r, have, (v) => setting(v, 'guardRadius') === '11', 5000);
    expect(replay.every((m) => 'd' in parse(m))).toBe(true);
    const fresh = await stream();
    const snap = (parse(await fresh.next(STATE_TOPIC)) as { snap: PanelStateLite }).snap;
    expect(have.v.settings).toEqual(snap.settings);
    expect(have.v.inventory?.slots).toEqual(snap.inventory?.slots);
    // another boot's id: a snapshot, not a replay
    const other = await stream('/api/stream', { 'last-event-id': 'nope.5' });
    expect((JSON.parse((await other.next(HELLO_EVENT)).data) as StreamHello).resumed).toBe(false);
    expect('snap' in parse(await other.next(STATE_TOPIC))).toBe(true);
    measurements.push(`resume after ${lastId}: ${replay.length} deltas replayed (${replay.reduce((n, m) => n + m.bytes, 0)} bytes) instead of a ${JSON.stringify({ snap }).length}-byte snapshot`);
    for (const x of [r, fresh, other]) x.close();
    await sleep(1100);
    await cmd('!set guardRadius 16');
  }, 30_000);

  it('the stream cap: the ninth stream is 503 (the page polls ?lite=1 instead, which still works)', async () => {
    for (const s of open.splice(0)) s.close(); // whatever an earlier test left open
    await sleep(500); // closed streams leave the hub
    const many: SseStream[] = [];
    for (let i = 0; i < 8; i++) {
      const s = await stream();
      expect(s.status).toBe(200);
      many.push(s);
    }
    const ninth = await openSse(`${BASE}/api/stream`, AUTH);
    expect(ninth.status).toBe(503);
    expect(ninth.headers.get('retry-after')).toBe('30');
    const t0 = performance.now();
    const lite = await fetch(`${BASE}/api/state?lite=1`, { headers: AUTH });
    expect(lite.status).toBe(200);
    const body = (await lite.json()) as PanelStateLite;
    expect(body.lite).toBe(true);
    expect(body.bot.name).toBe(cli!.name);
    measurements.push(`cap: 8 streams open, the ninth 503 (retry-after 30); ?lite=1 meanwhile ${(performance.now() - t0).toFixed(0)} ms`);
    for (const s of many) s.close();
  }, 30_000);

  it('!quit from the panel ends the open streams and exits with code 0', async () => {
    const s = await stream();
    await s.next(STATE_TOPIC);
    await sleep(1100);
    const r = await cmd('!quit');
    expect(r.replies[0]).toBe('bye (quit by console)');
    const code = await Promise.race([cli!.exit, sleep(15_000).then(() => 'timeout' as const)]);
    expect(code).toBe(0);
    await Promise.race([s.ended, sleep(5000)]);
    cli = undefined;
  }, 30_000);
});
