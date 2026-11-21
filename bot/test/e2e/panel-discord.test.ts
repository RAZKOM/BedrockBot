// Track N1 on bds-core (docs/away.md "Discord", ADR 0116 addendum): the notes to a Discord webhook from a real bot
// process, against a local fake webhook server in this test (ports 10125 to 10129; never Discord). The bot reads the
// webhook URL (an obviously fake token) from BEDROCKBOT_DISCORD_WEBHOOK: the e2e CLI runs with --no-config, which leaves
// the config directory's `discord-webhook.url` unread (that route is unit-tested), and sends to the fake server through
// the test-only BEDROCKBOT_DISCORD_TEST_ORIGIN. `notify` stays off: Discord alone makes the notes.
//   test      `!notify test` through the panel's API: one POST, the reply `discord: sent (204)`
//   death     the bot killed by the server: exactly one POST (`the bot died`) within 10 s, none more in the next 5 s
//   question  askOwner on, a queued job that fails: exactly one POST (`the bot asks (#N)`) with its choices and how to
//             answer; `!answer N next` through the API ends it
//   secret    the token in nothing the bot printed (its whole output), /api/state, /api/state?lite=1, /api/help,
//             /api/away, `!set`, `!notify` and the event store's files
// Env: N1_PANEL_PORT (default a random port in 10120..10124), N1_OUT=<file> (the measured lines appended),
// core-truth.ts (CORE_BDS_*). Needs BDS_E2E=1 and bds-core with the truth pack.
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PanelAway } from '../../src/health/panel/away.ts';
import type { JobsSummary, QueueJobView } from '../../src/health/panel/shared.ts';
import type { PveTruth } from './pve-truth.ts';
import { centre, clearArea, coreCmd, CORE_CONTAINER, CORE_TARGET, E2E, FEET_Y, prepareServer, privateArea, sleep, until, waitOnline, type CoreCli } from './core-truth.ts';
import { connectObserver, panelClient, quitPanelCli, startPanelCli, type Observer, type PanelCli } from './panel-e2e.ts';

const F = FEET_Y;
const panel = panelClient(Number(process.env.N1_PANEL_PORT ?? 10120 + randomInt(5))); // 10120..10124: the fake webhook has 10125..10129
/** Obviously fake (Discord's tokens are about 68 characters); the bot never sees Discord in this test. */
const TOKEN = `NOT-A-REAL-TOKEN_e2e-n1-${randomInt(1000, 9999)}`;
const ID = '123456789012345678';
const HOOK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;

interface Post {
  at: number;
  path: string;
  body: { content: string; embeds: { title: string; description: string; fields?: { name: string; value: string }[] }[]; allowed_mentions?: unknown };
}

async function fakeWebhook(lo = 10125, hi = 10129): Promise<{ server: Server; port: number; posts: Post[] }> {
  const start = lo + randomInt(hi - lo + 1);
  for (let i = 0; i <= hi - lo; i++) {
    const port = lo + ((start - lo + i) % (hi - lo + 1));
    const posts: Post[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (d: Buffer) => (b += d.toString()));
      req.on('end', () => {
        try {
          posts.push({ at: Date.now(), path: req.url ?? '', body: JSON.parse(b) as Post['body'] });
        } catch {
          posts.push({ at: Date.now(), path: req.url ?? '', body: { content: `unparsed: ${b.slice(0, 80)}`, embeds: [] } });
        }
        res.writeHead(204);
        res.end();
      });
    });
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (bound) return { server, port, posts };
  }
  throw new Error(`no free port in ${lo}..${hi}`);
}

/** Every file under `dir` (the event store), as text. */
function filesText(dir: string): string {
  let out = '';
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out += readFileSync(p, 'latin1');
    }
  };
  try {
    walk(dir);
  } catch {
    // no store yet
  }
  return out;
}

describe.skipIf(!E2E)('core: notes to a Discord webhook (Track N1)', () => {
  const area = privateArea();
  const HOME = { x: area.x, y: F, z: area.z };
  const notes: string[] = [];
  let observer: Observer | undefined;
  let truth: PveTruth | undefined;
  let run: PanelCli | undefined;
  let cli: CoreCli | undefined;
  let fake: Awaited<ReturnType<typeof fakeWebhook>> | undefined;

  const cmd = async (text: string): Promise<string[]> => {
    const r = await panel.cmd(text);
    expect(r.status, text).toBe(200);
    return r.body.replies;
  };
  const chatSince = async (ts: number): Promise<string[]> => (await panel.state()).chat.filter((c) => c.ts >= ts).map((c) => c.text);
  const posts = (title: RegExp, since: number): Post[] => fake!.posts.filter((p) => p.at >= since && title.test(p.body.embeds[0]?.title ?? ''));
  const note = (line: string): void => {
    notes.push(line);
    console.log(`[n1] ${line}`);
  };

  beforeAll(async () => {
    fake = await fakeWebhook();
    await prepareServer({ time: 'noon' });
    observer = await connectObserver(`N1Obs${randomInt(1000, 9999)}`, CORE_TARGET, CORE_CONTAINER);
    truth = observer.truth;
    await truth.tp(observer.name, { x: HOME.x + 0.5, y: F, z: HOME.z - 40 + 0.5 }, 0, 0);
    await clearArea(truth, HOME, 12, 6);
    await truth.fill({ x: HOME.x - 12, y: F - 1, z: HOME.z - 12 }, { x: HOME.x + 12, y: F - 1, z: HOME.z + 12 }, 'grass_block');
    const keep = process.env.BEDROCKBOT_DISCORD_TEST_ORIGIN;
    const keepEnv = process.env.BEDROCKBOT_DISCORD_WEBHOOK;
    process.env.BEDROCKBOT_DISCORD_TEST_ORIGIN = `http://127.0.0.1:${fake.port}`;
    process.env.BEDROCKBOT_DISCORD_WEBHOOK = HOOK;
    try {
      run = startPanelCli(panel, { prefix: 'bot-e2e-n1-', args: ['--walk', '--respawn-delay', '1'], events: true });
    } finally {
      if (keep === undefined) delete process.env.BEDROCKBOT_DISCORD_TEST_ORIGIN;
      else process.env.BEDROCKBOT_DISCORD_TEST_ORIGIN = keep;
      if (keepEnv === undefined) delete process.env.BEDROCKBOT_DISCORD_WEBHOOK;
      else process.env.BEDROCKBOT_DISCORD_WEBHOOK = keepEnv;
    }
    cli = run.cli;
    await waitOnline(truth, cli.name);
    await panel.healthy();
    await until(async () => ((await panel.get<JobsSummary>('/api/jobs')).on ? true : undefined), 20_000, 'the queue on the panel');
    await truth.tp(cli.name, centre(HOME), 0, 0);
    await cmd('!set autoFood off');
    await cmd('!set notify off');
    await cmd('!set askWaitS 30');
    const r = await cmd('!set notifyDiscord on');
    expect(r.join(' | ')).toMatch(/notifyDiscord: webhook set \(id \.\.\.5678, BEDROCKBOT_DISCORD_WEBHOOK\); !notify test sends one/);
  }, 120_000);

  afterAll(async () => {
    await quitPanelCli(panel, cli).catch(() => undefined);
    cli?.kill();
    await truth?.cleanup().catch(() => undefined);
    await clearArea(truth!, HOME, 12, 6).catch(() => undefined);
    await truth?.fill({ x: HOME.x - 12, y: F - 1, z: HOME.z - 12 }, { x: HOME.x + 12, y: F - 1, z: HOME.z + 12 }, 'grass_block').catch(() => undefined);
    await observer?.close();
    run?.cleanup();
    await new Promise<void>((r) => (fake ? fake.server.close(() => r()) : r()));
    const text = `[panel-discord e2e] port ${panel.port}, fake webhook ${fake?.port}, area cell ${area.cell}\n  ${notes.join('\n  ')}\n`;
    console.log(text);
    if (process.env.N1_OUT) appendFileSync(process.env.N1_OUT, text);
  }, 90_000);

  it('test: !notify test is one POST and says sent (204)', async () => {
    const t0 = Date.now();
    await cmd('!notify test');
    const reply = await until(async () => (await chatSince(t0)).find((l) => l.startsWith('discord: ')), 15_000, 'the test reply', 200);
    expect(reply).toBe('discord: sent (204)');
    expect(posts(/^test notification$/, t0)).toHaveLength(1);
    const p = posts(/^test notification$/, t0)[0]!;
    expect(p.path).toBe(`/api/webhooks/${ID}/${TOKEN}`);
    expect(p.body.allowed_mentions).toEqual({ parse: [] });
    note(`test: ${reply}, the POST ${((p.at - t0) / 1000).toFixed(2)} s after the command: ${p.body.content}`);
  }, 60_000);

  it('death: one POST within 10 s, none more after', async () => {
    await truth!.tp(cli!.name, centre(HOME), 0, 0);
    await sleep(1500);
    const t0 = Date.now();
    await coreCmd('kill', cli!.name);
    const p = await until(() => Promise.resolve(posts(/^the bot died/, t0)[0]), 10_000, 'the death at the webhook', 100);
    await sleep(5000);
    expect(posts(/^the bot died/, t0)).toHaveLength(1);
    note(`death: one POST ${((p.at - t0) / 1000).toFixed(2)} s after the kill: ${p.body.content} | ${p.body.embeds[0]!.description}`);
  }, 60_000);

  it('question: one POST with the choices and how to answer; !answer ends it', async () => {
    await sleep(3000); // respawned
    await truth!.tp(cli!.name, centre(HOME), 0, 0);
    await cmd('!queue onfail next');
    await cmd('!set askOwner on');
    const t0 = Date.now();
    const r = await cmd('!queue add !craft diamond_sword');
    expect(r.join(' ')).toMatch(/queue: added #\d+/);
    const away = (): Promise<PanelAway> => panel.get<PanelAway>('/api/away');
    const q = await until(async () => (await away()).asks[0], 60_000, 'the question in the away block', 200);
    const p = await until(() => Promise.resolve(posts(/^the bot asks/, t0)[0]), 15_000, 'the question at the webhook', 100);
    const f = p.body.embeds[0]!.fields ?? [];
    expect(p.body.embeds[0]!.title).toBe(`the bot asks (#${q.id})`);
    expect(f.map((x) => x.name)).toEqual(['Choices', 'Unanswered', 'How to answer']);
    expect(f[0]!.value).toMatch(/retry.*next.*stop/);
    expect(f[2]!.value).toContain(`!answer ${q.id} <choice>`);
    expect(await cmd(`!answer ${q.id} next`)).toContain(`ask: #${q.id} answered: next`);
    await sleep(4000);
    expect(posts(/^the bot asks/, t0)).toHaveLength(1);
    await cmd('!set askOwner off');
    const jobs = (await panel.get<JobsSummary>('/api/jobs')).queue!;
    const ended: QueueJobView[] = jobs.ended;
    note(`question: one POST ${((p.at - q.askedAt) / 1000).toFixed(2)} s after the question was asked: ${p.body.embeds[0]!.title}; ${f.map((x) => `${x.name}: ${x.value}`).join(' | ')}; ${ended.length} ended jobs`);
  }, 120_000);

  it('secret: the token is in no output, state, settings view, reply or stored event', async () => {
    const replies = [...(await cmd('!set')), ...(await cmd('!set notifyDiscord')), ...(await cmd('!notify')), ...(await cmd('!notify status'))];
    const status = replies.find((l) => l.startsWith('discord: '));
    expect(status).toMatch(/^discord: on, webhook set \(id \.\.\.5678, BEDROCKBOT_DISCORD_WEBHOOK\); \d+ sent, 0 failed, 0 dropped/);
    await sleep(500);
    const get = async (path: string): Promise<string> => (await fetch(`${panel.base}${path}`, { headers: panel.auth })).text();
    const views: [string, string][] = [
      ['replies', replies.join('\n')],
      ['/api/state', await get('/api/state')],
      ['/api/state?lite=1', await get('/api/state?lite=1')],
      ['/api/help', await get('/api/help')],
      ['/api/away', await get('/api/away')],
      ['/api/events', await get('/api/events?since=0&limit=1000')],
      ['the event store', filesText(join(run!.dir, 'events'))],
      ['the bot output', cli!.output()],
    ];
    for (const [what, text] of views) {
      expect(text.includes(TOKEN), what).toBe(false);
      expect(text.includes(HOOK), what).toBe(false);
    }
    expect(cli!.output()).toMatch(/discord: webhook set \(id \.\.\.5678, BEDROCKBOT_DISCORD_WEBHOOK\)/);
    note(`secret: the token in none of ${views.map(([w, t]) => `${w} (${t.length} chars)`).join(', ')}; ${status}`);
  }, 60_000);
});
