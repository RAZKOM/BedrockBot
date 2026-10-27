// Track AE: the control panel over HTTP (docs/panel.md): token on every path but /healthz, the
// cookie flow, the state JSON shape, commands through Chat.handle as the first owner, the rate
// limit, the page markers, and !panel.
import { afterEach, describe, expect, it } from 'vitest';
import { Chat, parseOwners } from '../../../src/chat/chat.ts';
import { registerBuiltinCommands, registerSettingsCommands } from '../../../src/chat/commands.ts';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { HealthServer } from '../../../src/connection/health.ts';
import { Metrics } from '../../../src/connection/metrics.ts';
import { setupPanel, type Panel, type PanelDeps } from '../../../src/health/panel/index.ts';
import { buildPanelState, phaseOf, dimensionName, QUICK_COMMANDS, type PanelState } from '../../../src/health/panel/state.ts';
import { parseCommandBody } from '../../../src/health/panel/routes.ts';
import { createLogger, silentLogger } from '../../../src/log.ts';
import type { CommandDeps } from '../../../src/tasks/process/deps.ts';
import { setup } from '../connection-fakes.ts';

const TOKEN = 'Abcdefghijklmnopqrstuvwx';
let panel: Panel | undefined;
let health: HealthServer | undefined;
afterEach(async () => {
  await panel?.stop();
  await health?.stop();
  panel = undefined;
  health = undefined;
});

function makePanel(opts: { healthPort?: number; port?: number; token?: string; owners?: string[] }) {
  const { conn } = setup();
  const metrics = new Metrics();
  metrics.attach(conn);
  const chat = new Chat(conn, { owners: parseOwners(opts.owners ?? ['Steve']), log: silentLogger });
  const runtime = new RuntimeSettings();
  const task = {
    name: 'afk',
    start() {},
    stop() {},
    status: () => ({}),
    position: () => ({ x: 1, y: -60, z: 2 }),
    statusLine: () => ({ task: 'afk', nudges: 0 }),
    processLines: () => ['processes: idle'],
    processes: { stack: () => [{ name: 'guard', kind: 'guard', priority: 60, state: 'active', held: false, line: 'guarding r=16', etaS: undefined }] },
  };
  registerBuiltinCommands(chat, { conn, metrics, position: task.position, extraStatus: task.statusLine, extraLines: task.processLines, quit: () => undefined });
  registerSettingsCommands({ chat, settings: runtime } as unknown as CommandDeps);
  const built = {
    ctx: { clock: () => ({ timeOfDay: 13500 }) },
    respawn: { health: 17 },
    mobility: { world: { self: { food: 18, health: 17, dimension: 0 } }, skills: { status: () => ({}) } },
  };
  const deps: PanelDeps = {
    settings: { healthPort: opts.healthPort, panel: { host: '127.0.0.1', port: opts.port, token: opts.token }, server: '127.0.0.1:19180 (raknet)', task: 'afk' },
    conn,
    metrics,
    chat,
    built: built as unknown as PanelDeps['built'],
    runningTask: task,
    runtime,
    log: createLogger('info', 'panel-test'),
  };
  panel = setupPanel(deps);
  return { panel, chat, runtime };
}

async function startSeparate(token?: string, owners?: string[]) {
  const made = makePanel({ port: 0, token, owners });
  expect(made.panel.plan.mode).toBe('separate');
  expect(await made.panel.start(undefined)).toBe(true);
  const base = made.panel.urls()[0]!.replace(/\/$/, '');
  return { ...made, base };
}

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const post = (base: string, text: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/cmd`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text }) });

describe('panel state JSON', () => {
  it('has the documented shape', () => {
    const { panel } = makePanel({ healthPort: 9999 });
    const s: PanelState = panel.state();
    expect(Object.keys(s).sort()).toEqual(['bot', 'chat', 'commands', 'logs', 'quick', 'self', 'settings', 'stack', 'status', 'ts', 'v', 'inventory', 'job', 'combat', 'memory', 'planner', 'conn', 'paused'].sort()); // Track AP: inventory .. conn; Track AR: paused
    expect(s.v).toBe(1);
    expect(s.bot).toEqual({ name: 'UnitBot', server: '127.0.0.1:19180 (raknet)', task: 'afk', state: 'idle', healthy: false, gameVersion: '1.26.51' });
    expect(s.status[0]).toMatch(/^status: up .*pos 1\.00 -60\.00 2\.00, version 1\.26\.51, tick 0, task afk, nudges 0$/);
    expect(s.status[1]).toBe('processes: idle');
    expect(s.stack).toEqual([{ name: 'guard', kind: 'guard', priority: 60, state: 'active', line: 'guarding r=16', etaS: null }]);
    expect(s.self).toEqual({ health: 17, food: 18, pos: { x: 1, y: -60, z: 2 }, dimension: 'overworld', timeOfDay: 13500, phase: 'night', saturation: null, weather: null, day: null, deaths: null, lastDeath: null });
    expect(s.job).toBeNull(); // the fake stack has only the guard (an auto process)
    expect(s.conn).toMatchObject({ server: '127.0.0.1:19180 (raknet)', state: 'idle', reconnects: 0, kicks: 0 });
    const guard = s.settings.find((r) => r.key === 'guardRadius');
    expect(guard).toEqual({ key: 'guardRadius', kind: 'number', value: '16', default: '16', min: 2, max: 64, unit: 'blocks', source: 'default', description: expect.any(String) as string });
    expect(s.settings.find((r) => r.key === 'sprint')).toMatchObject({ kind: 'boolean', value: 'on' });
    expect(s.commands).toEqual(expect.arrayContaining(['status', 'pos', 'set', 'panel']));
    expect(s.quick).toEqual(QUICK_COMMANDS);
    expect(s.quick).not.toContain('!come');
  });

  it('survives throwing sources', () => {
    const boom = () => {
      throw new Error('x');
    };
    const s = buildPanelState({ name: boom, server: 's', task: 't', connState: boom, healthy: boom, gameVersion: boom, statusLines: boom, vitals: boom, position: boom, dimension: boom, timeOfDay: boom, logs: boom, chat: boom, commands: boom });
    expect(s.bot.state).toBe('unknown');
    expect(s.self).toEqual({ health: null, food: null, pos: null, dimension: null, timeOfDay: null, phase: null, saturation: null, weather: null, day: null, deaths: null, lastDeath: null });
    expect(s.settings).toEqual([]);
  });

  it('phases, dimensions and command bodies', () => {
    expect([0, 11999, 12000, 13000, 22999, 23000].map(phaseOf)).toEqual(['day', 'day', 'dusk', 'night', 'night', 'dawn']);
    expect([0, 1, 2, 7, undefined].map(dimensionName)).toEqual(['overworld', 'nether', 'the_end', '7', null]);
    expect(parseCommandBody('{"text":" wp set panel "}')).toEqual({ text: '!wp set panel' });
    expect(parseCommandBody('{"text":"!a\\nb"}')).toEqual({ text: '!a b' });
    expect(parseCommandBody('nope')).toHaveProperty('error');
    expect(parseCommandBody('{"text":""}')).toHaveProperty('error');
    expect(parseCommandBody(JSON.stringify({ text: `!${'x'.repeat(300)}` }))).toHaveProperty('error');
  });
});

describe('panel over HTTP', () => {
  it('token: 401 without, 200 with bearer; /healthz stays open', async () => {
    const { base } = await startSeparate(TOKEN);
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect((await fetch(`${base}/map.json`)).status).toBe(401);
    expect((await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer wrong-token-wrong-token' } })).status).toBe(401);
    expect((await fetch(`${base}/healthz`)).status).toBe(503); // not spawned, but answered without a token
    const r = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
    const s = (await r.json()) as PanelState;
    expect(s.stack[0]?.line).toBe('guarding r=16');
    const login = await fetch(`${base}/`);
    expect(login.status).toBe(401);
    expect(await login.text()).toContain('name="token"');
  });

  it('?token= once sets a cookie and redirects; the cookie opens the page', async () => {
    const { base } = await startSeparate(TOKEN);
    const r = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/');
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^bbpanel=\w+; HttpOnly; SameSite=Strict; Path=\//);
    const page = await fetch(`${base}/`, { headers: { cookie: cookie.split(';')[0]! } });
    expect(page.status).toBe(200);
    const html = await page.text();
    for (const marker of ['<title>BedrockBot panel</title>', 'data-panel="v1"', 'id="panel-status"', 'id="cmdform"', 'id="panel-settings"', 'data-key="guardRadius"', 'data-cmd="!home go"', "fetch('/map.json?'", '/api/marks', 'id="menu"', '/api/state', '/api/cmd']) {
      expect(html).toContain(marker);
    }
    expect(html).not.toContain(TOKEN);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)[a-z]/i); // no external assets
  });

  it('POST /api/cmd runs the command as the first owner and returns the replies', async () => {
    const { base, runtime } = await startSeparate(TOKEN);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const r = await post(base, '!pos', auth);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ command: '!pos', ok: true, replies: ['pos 1.00 -60.00 2.00'] });
    const set = await json(await post(base, 'set guardRadius 8', auth));
    expect(set.replies).toEqual(['guardRadius = 8 (was 16), not saved (no settings file)']);
    expect(runtime.get('guardRadius')).toBe(8);
    const s = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as PanelState;
    expect(s.settings.find((x) => x.key === 'guardRadius')).toMatchObject({ value: '8', source: 'chat' });
    expect(s.chat.map((c) => c.text)).toEqual(['pos 1.00 -60.00 2.00', 'guardRadius = 8 (was 16), not saved (no settings file)']);
    expect(s.chat[0]!.sent).toBe(false); // not spawned: shown in the panel only
    expect(s.logs.some((l) => l.includes('panel: !pos (as Steve)'))).toBe(true);
    expect((await post(base, '!nosuch', auth).then(json)).replies).toEqual(['unknown command !nosuch; try !help']);
    expect((await fetch(`${base}/api/cmd`, { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: '{"text":"!pos"}' })).status).toBe(403);
    expect((await fetch(`${base}/api/cmd`, { headers: auth })).status).toBe(405);
  });

  it('rate limit: 5 commands per second, then 429', async () => {
    const { base } = await startSeparate(TOKEN);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const codes = await Promise.all(Array.from({ length: 8 }, () => post(base, '!pos', auth).then((r) => r.status)));
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 1050));
    expect((await post(base, '!pos', auth)).status).toBe(200);
  });

  it('no token: loopback only, no auth needed from 127.0.0.1; console as owner when no names', async () => {
    const { base, panel } = await startSeparate(undefined, []);
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${base}/api/state`)).status).toBe(200);
    expect(await post(base, '!pos').then(json)).toMatchObject({ ok: true, replies: ['pos 1.00 -60.00 2.00'] });
    expect(panel.state().logs.some((l) => l.includes('panel: !pos (as console)'))).toBe(true);
    const bang = await post(base, '!panel').then(json);
    expect((bang.replies as string[])[0]).toMatch(/^panel: http:\/\/127\.0\.0\.1:\d+\/ \(this machine only/);
  });

  it('shared: the health server carries the panel and the token covers /metrics', async () => {
    const { panel } = makePanel({ healthPort: 1, token: TOKEN });
    expect(panel.plan.mode).toBe('shared');
    expect(panel.healthOptions.host).toBe('127.0.0.1');
    health = new HealthServer({ port: 0, metrics: new Metrics(), log: silentLogger, ...panel.healthOptions });
    const port = await health.start();
    expect(await panel.start(health)).toBe(true);
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    // Track AR: the map's markers behind the same token (no world cache here: empty lists)
    expect((await fetch(`${base}/api/marks`)).status).toBe(401);
    expect(await fetch(`${base}/api/marks`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())).toEqual({ chests: [], herds: [] });
  });

  it('Track AR: the state carries paused from the process manager (null without one)', () => {
    const { panel } = makePanel({ healthPort: 9999 });
    expect(panel.state().paused).toBeNull();
    const s = buildPanelState({ name: () => 'x', server: 's', task: 't', connState: () => 'spawned', healthy: () => true, gameVersion: () => 'v', statusLines: () => [], vitals: () => ({ health: 20, food: 20 }), position: () => undefined, dimension: () => 0, timeOfDay: () => 0, logs: () => [], chat: () => [], commands: () => [], paused: () => true });
    expect(s.paused).toBe(true);
  });

  it('off: !panel says how to turn it on', () => {
    const { panel } = makePanel({});
    expect(panel.plan.mode).toBe('off');
    expect(panel.run('!panel').replies).toEqual(['panel is off: set healthPort (or panel.port) in the config; see docs/panel.md']);
  });
});
