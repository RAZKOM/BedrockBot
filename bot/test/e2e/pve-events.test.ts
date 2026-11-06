// Decision 0059 on bds-pve (docs/events.md): the event history of a real bot process.
//   1. the CLI (`--task afk --walk`, a panel port in 9920..9929 with a token, BEDROCKBOT_EVENTS_DIR and
//      the world cache in temporary directories) gets an iron sword; `!kill zombie` from the panel kills
//      a summoned zombie; truth:sethealth takes health away; the console's /kill kills the bot, which
//      respawns. GET /api/events then has the connection, the panel command, the job start and finish,
//      the fight, the kill, the damage, the death and the respawn; the summary counts them.
//   2. `!quit` (the batches are written), a NEW process on the same events directory: the old events
//      are served again (from the files), the new `connection.connected` continues the ids.
// Env: EVENTS_E2E_PORT (default a random port in 9920..9929) plus pve-truth.ts (PVE_BDS_*).
// Needs BDS_E2E=1 and bds-pve with the truth pack (`node scripts/bds.mjs --profile pve up` and `... pack`).
import { randomInt } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotEvent } from '../../src/events/registry.ts';
import type { EventSummary } from '../../src/events/summary.ts';
import { serverIdFor } from '../../src/world/cache/index.ts';
import { startCli, waitOnline, type CoreCli } from './core-truth.ts';
import { centre, connectPlayer, E2E, FEET_Y, prepareServer, privateArea, PVE_CONTAINER, PVE_HOST, PVE_PORT, PveTruth, pveCmd, uniqueName, until } from './pve-truth.ts';

const PORT = Number(process.env.EVENTS_E2E_PORT ?? 9920 + randomInt(10));
const TOKEN = Array.from({ length: 24 }, () => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(57)]).join('');
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { authorization: `Bearer ${TOKEN}` };

type Listed = BotEvent & { text: string };

async function list(query = ''): Promise<{ events: Listed[]; more: boolean; next: number }> {
  const r = await fetch(`${BASE}/api/events${query}`, { headers: AUTH });
  expect(r.status).toBe(200);
  return (await r.json()) as { events: Listed[]; more: boolean; next: number };
}

async function cmd(text: string): Promise<{ ok: boolean; replies: string[] }> {
  const r = await fetch(`${BASE}/api/cmd`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  return (await r.json()) as { ok: boolean; replies: string[] };
}

describe.skipIf(!E2E)('pve: event history (decision 0059)', () => {
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];
  let observer: Awaited<ReturnType<typeof connectPlayer>> | undefined;
  let truth: PveTruth | undefined;
  let cli: CoreCli | undefined;
  let eventsDir: string | undefined;
  let cacheDir: string | undefined;
  let firstRun: Listed[] = [];

  const start = async (name: string): Promise<CoreCli> => {
    // the child inherits these: the token, the events and the world cache in temporary directories (never the user's config directory)
    process.env.BEDROCKBOT_PANEL_TOKEN = TOKEN;
    process.env.BEDROCKBOT_EVENTS_DIR = eventsDir;
    process.env.BEDROCKBOT_CACHE_DIR = cacheDir;
    delete process.env.BEDROCKBOT_EVENTS;
    const c = startCli(['--walk', '--health-port', String(PORT), '--respawn-delay', '1'], name, { host: PVE_HOST, port: PVE_PORT });
    delete process.env.BEDROCKBOT_PANEL_TOKEN;
    delete process.env.BEDROCKBOT_EVENTS_DIR;
    delete process.env.BEDROCKBOT_CACHE_DIR;
    await waitOnline(truth!, c.name);
    await until(async () => ((await fetch(`${BASE}/healthz`).catch(() => undefined))?.status === 200 ? true : undefined), 20_000, 'panel /healthz 200', 250);
    return c;
  };

  beforeAll(async () => {
    await prepareServer();
    observer = await connectPlayer(`EvObs${randomInt(1000, 9999)}`);
    truth = new PveTruth(observer.conn, PVE_CONTAINER);
    await truth.tp(observer.name, { x: HOME.x + 0.5, y: FEET_Y, z: HOME.z - 24 + 0.5 }, 0, 0);
    eventsDir = mkdtempSync(join(tmpdir(), 'bot-e2e-events-'));
    cacheDir = mkdtempSync(join(tmpdir(), 'bot-e2e-events-cache-'));
    cli = await start(uniqueName('EvBot'));
    await truth.tp(cli.name, centre(HOME), 0, 0);
    await truth.clearAround(centre(HOME), 32);
  }, 120_000);

  afterAll(async () => {
    cli?.kill(); // only if a test failed before !quit
    await truth?.cleanup().catch(() => undefined);
    await truth?.clearAround(centre(HOME), 32).catch(() => undefined);
    await observer?.close();
    for (const d of [eventsDir, cacheDir]) if (d) rmSync(d, { recursive: true, force: true });
    console.log(`events e2e (port ${PORT}, area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  it('a kill from the panel, damage and a death show in /api/events and the summary', async () => {
    const name = cli!.name;
    await truth!.ok('clear', [name]);
    await truth!.ok('give', [name, 'iron_sword', 1]);
    await truth!.setHealth(name, 20);
    const zombie = await truth!.summon('zombie', { x: HOME.x + 4.5, y: FEET_Y, z: HOME.z + 0.5 });
    // the CLI's world model has to see the zombie first (chunks after the teleport, the entity): a kill that finds none fails at once and is asked again
    let ended: Listed | undefined;
    const t0 = Date.now();
    for (let attempt = 0; attempt < 5 && ended?.kind !== 'job.finished'; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const since = (await list()).next;
      expect((await cmd('!kill zombie')).ok).toBe(true);
      ended = await until(async () => (await list(`?since=${since}&kinds=job.finished,job.failed`)).events.find((e) => (e.data as { job: string }).job === 'kill'), 60_000, 'the kill job ended', 500);
      measurements.push(`!kill zombie (attempt ${attempt + 1}): ${ended.kind} after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${ended.text}`);
    }
    expect(ended!.kind).toBe('job.finished');
    expect((await truth!.mobs('zombie')).filter((m) => m.entityId === zombie.entityId)).toHaveLength(0);

    await truth!.setHealth(name, 11); // a health drop: MobTracker.onHit -> combat.damage (written before the death)
    await new Promise((r) => setTimeout(r, 1500));
    await pveCmd('kill', name);
    await until(async () => ((await list('?kinds=life.respawned')).events.length ? true : undefined), 30_000, 'respawned', 500);

    const all = await list('?since=0&limit=5000');
    firstRun = all.events;
    const kinds = all.events.map((e) => e.kind);
    for (const k of ['connection.connected', 'command.received', 'job.started', 'job.finished', 'combat.fight', 'combat.kill', 'combat.damage', 'life.died', 'life.respawned']) expect(kinds, k).toContain(k);
    const command = all.events.find((e) => e.kind === 'command.received' && (e.data as { command: string }).command === 'kill')!;
    expect(command.data).toMatchObject({ text: '!kill zombie', source: 'panel', sender: 'console' });
    const started = all.events.find((e) => e.kind === 'job.started' && (e.data as { job: string }).job === 'kill')!;
    expect(started.data).toMatchObject({ kind: 'user', by: 'console' });
    expect(all.events.find((e) => e.kind === 'combat.kill')!.data).toEqual({ mob: 'zombie' });
    const fight = all.events.find((e) => e.kind === 'combat.fight')!;
    expect(fight.data).toMatchObject({ mob: 'zombie', outcome: 'killed' });
    const died = all.events.find((e) => e.kind === 'life.died')!;
    expect(died.sev).toBe('alert');
    expect(kinds.indexOf('combat.damage')).toBeLessThan(kinds.indexOf('life.died'));
    // ids increase, the text is there
    for (let i = 1; i < all.events.length; i++) expect(all.events[i]!.id).toBeGreaterThan(all.events[i - 1]!.id);
    expect(all.events.every((e) => e.text.length > 0)).toBe(true);

    const t1 = performance.now();
    const r = await fetch(`${BASE}/api/events/summary?hours=8`, { headers: AUTH });
    const ms = performance.now() - t1;
    expect(r.status).toBe(200);
    const s = (await r.json()) as EventSummary;
    expect(s.counts['combat.kill']).toBeGreaterThanOrEqual(1);
    expect(s.combat.kills).toBeGreaterThanOrEqual(1);
    expect(s.combat.damageTaken).toBeGreaterThan(0);
    expect(s.deaths).toHaveLength(1);
    expect(s.jobs.some((j) => j.job === 'kill' && j.result === 'finished')).toBe(true);
    expect(s.highlights.some((h) => h.kind === 'life.died')).toBe(true);
    expect((await fetch(`${BASE}/api/events`)).status).toBe(401);
    measurements.push(`run 1: ${all.events.length} events (${JSON.stringify(s.counts)}), summary ${JSON.stringify(s).length} bytes in ${ms.toFixed(1)} ms; death "${died.text}"; fight "${fight.text}"`);
  }, 150_000);

  it('after !quit and a new process on the same directory the old events are still served', async () => {
    const reply = await cmd('!quit');
    expect(reply.ok).toBe(true);
    expect(await cli!.exit).toBe(0);
    const dir = join(eventsDir!, serverIdFor(`${PVE_HOST}:${PVE_PORT}`));
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const lines = files.flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n'));
    const bytes = files.reduce((a, f) => a + readFileSync(join(dir, f)).length, 0);
    const quit = lines.map((l) => JSON.parse(l) as BotEvent).find((e) => e.kind === 'command.received' && (e.data as { command: string }).command === 'quit');
    expect(quit, 'the !quit command was written before the exit').toBeDefined();
    measurements.push(`files after run 1: ${files.join(', ')}, ${lines.length} lines, ${bytes} bytes (${(bytes / lines.length).toFixed(0)} bytes per event)`);

    cli = await start(uniqueName('EvBot'));
    const lastOld = Math.max(...lines.map((l) => (JSON.parse(l) as BotEvent).id));
    const now = await until(async () => {
      const r = await list('?since=0&limit=5000');
      return r.events.some((e) => e.kind === 'connection.connected' && e.id > lastOld) ? r : undefined;
    }, 20_000, 'the new connection.connected', 500);
    for (const old of firstRun) expect(now.events.some((e) => e.id === old.id && e.kind === old.kind), `${old.id} ${old.kind}`).toBe(true);
    const connected = now.events.filter((e) => e.kind === 'connection.connected');
    expect(connected.length).toBe(2);
    expect(connected[1]!.id).toBeGreaterThan(lastOld);
    const page = await list(`?since=${firstRun[1]!.id}&limit=2`);
    expect(page.events.map((e) => e.id)).toEqual([firstRun[2]!.id, firstRun[3]!.id]);
    const r = await fetch(`${BASE}/api/events/summary?hours=8`, { headers: AUTH });
    const s = (await r.json()) as EventSummary;
    expect(s.deaths).toHaveLength(1);
    expect(s.combat.kills).toBeGreaterThanOrEqual(1);
    measurements.push(`run 2: ${now.events.length} events served (${firstRun.length} from run 1), new ids from ${connected[1]!.id}`);
    expect((await cmd('!quit')).ok).toBe(true);
    expect(await cli.exit).toBe(0);
    cli = undefined;
  }, 120_000);
});
