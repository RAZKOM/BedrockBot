// Track AE on bds-core (docs/panel.md, decision 0026): the LAN control panel on a real bot process.
//   1. the CLI with --health-port (9640..9649) and a token (BEDROCKBOT_PANEL_TOKEN): GET /api/state
//      without the token is 401, with it the status and the process stack;
//   2. the page renders (markers, cookie flow from ?token=);
//   3. POST /api/cmd `!wp set panel` creates the waypoint (reply, then `!wp panel`), `!goto` from the
//      panel moves the bot (truth position), and the log tail shows the command lines;
//   4. `!panel` prints the loopback URL (no token in it).
// Env: PANEL_E2E_PORT (default a random port in 9640..9649) plus core-truth.ts (CORE_BDS_*).
// Needs BDS_E2E=1 and bds-core with the truth pack (`node scripts/bds.mjs --profile core up` and `... pack`).
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PanelState } from '../../src/health/panel/state.ts';
import { PveTruth } from './pve-truth.ts';
import { centre, clearArea, connectPlayer, CORE_CONTAINER, E2E, FEET_Y, hdist, prepareServer, privateArea, sleep, startCli, until, waitOnline, type CoreCli } from './core-truth.ts';

const PORT = Number(process.env.PANEL_E2E_PORT ?? 9640 + randomInt(10));
const TOKEN = Array.from({ length: 24 }, () => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(57)]).join('');
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function state(): Promise<PanelState> {
  const r = await fetch(`${BASE}/api/state`, { headers: AUTH });
  expect(r.status).toBe(200);
  return (await r.json()) as PanelState;
}

async function cmd(text: string): Promise<{ status: number; body: { ok: boolean; command: string; replies: string[]; error?: string } }> {
  const r = await fetch(`${BASE}/api/cmd`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  return { status: r.status, body: (await r.json()) as { ok: boolean; command: string; replies: string[]; error?: string } };
}

describe.skipIf(!E2E)('core: LAN control panel (Track AE)', () => {
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];
  let observer: Awaited<ReturnType<typeof connectPlayer>> | undefined;
  let truth: PveTruth | undefined;
  let cli: CoreCli | undefined;

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    observer = await connectPlayer(`PanelObs${randomInt(1000, 9999)}`);
    truth = new PveTruth(observer.conn, CORE_CONTAINER);
    await truth.tp(observer.name, { x: HOME.x + 0.5, y: FEET_Y, z: HOME.z - 24 + 0.5 }, 0, 0);
    await clearArea(truth, HOME, 12, 4);
    // the child inherits these: the token, and no world cache under the user's config directory
    process.env.BEDROCKBOT_PANEL_TOKEN = TOKEN;
    process.env.BEDROCKBOT_CACHE = '0';
    cli = startCli(['--walk', '--health-port', String(PORT)]);
    delete process.env.BEDROCKBOT_PANEL_TOKEN;
    await waitOnline(truth, cli.name);
    await truth.tp(cli.name, centre(HOME), 0, 0);
    await until(async () => ((await fetch(`${BASE}/healthz`).catch(() => undefined))?.status === 200 ? true : undefined), 20_000, 'panel /healthz 200', 250);
  }, 90_000);

  afterAll(async () => {
    cli?.kill(); // only if a test failed before !quit
    await truth?.cleanup().catch(() => undefined);
    await truth?.clearAround(centre(HOME), 32).catch(() => undefined);
    await observer?.close();
    console.log(`panel e2e (port ${PORT}, area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  it('GET /api/state: 401 without the token, the status and stack with it', async () => {
    expect((await fetch(`${BASE}/api/state`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/state`, { headers: { authorization: 'Bearer wrongwrongwrongwrongwrong' } })).status).toBe(401);
    expect((await fetch(`${BASE}/metrics`)).status).toBe(401);
    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
    const s = await state();
    expect(s.bot.name).toBe(cli!.name);
    expect(s.bot.state).toBe('spawned');
    expect(s.status[0]).toMatch(/^status: up /);
    expect(s.status.some((l) => l.startsWith('processes: '))).toBe(true);
    expect(Array.isArray(s.stack)).toBe(true);
    expect(s.self.dimension).toBe('overworld');
    expect(s.self.health).toBeGreaterThan(0);
    expect(s.self.timeOfDay).not.toBeNull();
    expect(s.settings.length).toBeGreaterThan(10);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await state();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const line = `/api/state: ${JSON.stringify(s).length} bytes, median ${times[10]!.toFixed(1)} ms, max ${times[19]!.toFixed(1)} ms over 20; stack ${JSON.stringify(s.stack.map((e) => `${e.state} ${e.name}`))}; status "${s.status.join(' | ').slice(0, 160)}"`;
    console.log(line);
    measurements.push(line);
    expect(times[10]).toBeLessThan(250);
  });

  it('the page renders (cookie from ?token=, markers, no token in the HTML)', async () => {
    const r = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(r.status).toBe(303);
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    const page = await fetch(`${BASE}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    for (const m of ['<title>BedrockBot panel</title>', 'id="panel-status"', 'id="cmdform"', 'data-cmd="!home go"', 'data-key="guardRadius"', 'id="panel-map"', cli!.name]) expect(html).toContain(m);
    expect(html).not.toContain(TOKEN);
    expect((await fetch(`${BASE}/map`, { headers: { cookie } })).status).toBe(200);
    measurements.push(`page: ${html.length} bytes`);
  });

  it('POST /api/cmd: !wp set panel, !goto moves the bot, the log tail shows the commands', async () => {
    const start = (await truth!.pos(cli!.name)).location;
    const t0 = Date.now();
    const wp = await cmd('!wp set panel');
    const wpMs = Date.now() - t0;
    expect(wp.status).toBe(200);
    expect(wp.body.replies).toHaveLength(1);
    expect(wp.body.replies[0]).toMatch(/^waypoint panel set to -?\d+ -?\d+ -?\d+$/);
    const show = await cmd('wp panel');
    expect(show.body.command).toBe('!wp panel');
    expect(show.body.replies[0]).toMatch(/^waypoint panel: /);
    expect((await state()).logs.some((l) => l.includes('panel: !wp set panel (as console)'))).toBe(true);

    const target = { x: HOME.x + 7, y: FEET_Y, z: HOME.z + 3 };
    const t1 = Date.now();
    const go = await cmd(`!goto ${target.x} ${target.y} ${target.z}`);
    expect(go.body.replies[0]).toBe(`walking to ${target.x} ${target.y} ${target.z}`);
    const during = await state();
    expect(during.logs.some((l) => l.includes(`panel: !goto ${target.x} ${target.y} ${target.z} (as console)`))).toBe(true);
    expect(during.stack.some((e) => e.kind === 'user' && e.line.includes('walking to'))).toBe(true);
    measurements.push(`stack while walking: ${JSON.stringify(during.stack)}`);
    const arrived = await until(async () => {
      const p = (await truth!.pos(cli!.name)).location;
      return hdist(p, centre(target)) < 1 ? p : undefined;
    }, 30_000, 'bot at the !goto target', 200);
    const gotoMs = Date.now() - t1;
    expect(hdist(arrived, start)).toBeGreaterThan(5);
    const s = await until(async () => {
      const st = await state();
      return st.chat.some((c) => c.text.startsWith('arrived at')) ? st : undefined;
    }, 10_000, 'arrived reply in the panel chat', 250);
    expect(s.chat.map((c) => c.text)).toEqual(expect.arrayContaining([wp.body.replies[0], `walking to ${target.x} ${target.y} ${target.z}`]));
    const back = await cmd('!goto panel');
    expect(back.body.replies[0]).toMatch(/^walking to panel \(/);
    await until(async () => (hdist((await truth!.pos(cli!.name)).location, start) < 1.5 ? true : undefined), 30_000, 'back at the waypoint', 200);
    const line = `!wp set panel answered in ${wpMs} ms ("${wp.body.replies[0]}"); !goto +7,+3 from the panel: arrived after ${gotoMs} ms, moved ${hdist(arrived, start).toFixed(2)} blocks; !goto panel walked back`;
    console.log(line);
    measurements.push(line);
  }, 90_000);

  it('!panel prints the loopback URL; 5 commands per second', async () => {
    const r = await cmd('!panel');
    expect(r.body.replies[0]).toBe(`panel: http://127.0.0.1:${PORT}/ (this machine only; panel.host 0.0.0.0 + panel.token for the LAN)`);
    expect(r.body.replies[0]).not.toContain(TOKEN);
    await sleep(1100);
    const codes = await Promise.all(Array.from({ length: 7 }, () => cmd('!pos').then((x) => x.status)));
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
    measurements.push(`rate limit: 7 parallel !pos -> ${JSON.stringify(codes)}`);
  });

  it('!quit from the panel exits the bot with code 0', async () => {
    await sleep(1100); // past the rate-limit window of the previous test
    const r = await cmd('!quit');
    expect(r.body.replies[0]).toBe('bye (quit by console)');
    const t0 = Date.now();
    const code = await Promise.race([cli!.exit, sleep(15_000).then(() => 'timeout' as const)]);
    measurements.push(`!quit from the panel: exit ${String(code)} after ${Date.now() - t0} ms`);
    expect(code).toBe(0);
    cli = undefined;
  }, 30_000);
});
