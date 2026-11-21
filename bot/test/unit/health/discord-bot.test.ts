// Track D1 (ADR 0118, docs/discord.md): the Discord bot's gateway (heartbeat with jitter, a dead link noticed, resume,
// reconnect with backoff, the fatal closes, the daily session cap, only Discord's URL), its REST client (429, the
// global limit, the bucket, 401, the callback's 3 s, the timeout, the scrub) and the whole bot against a local fake
// Discord (a websocket and REST server on a free loopback port through Node's own WebSocket; never Discord): a command
// from an allowed user runs as the first owner marked discord and its reply comes back, strangers, bots, webhooks and
// other channels are ignored, refused commands say why, the per-user limit, later lines follow, a question's buttons
// answer it (a stranger's press refused privately), its messages edited when it ends, `!discord`, and the token in no
// output.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chat, parseOwners, senderLabel } from '../../../src/chat/chat.ts';
import { registerSettingsCommands } from '../../../src/chat/commands.ts';
import { answerHow } from '../../../src/chat/commands-ask.ts';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { sourceOf, viaPanel } from '../../../src/events/actor.ts';
import { EventBus } from '../../../src/events/bus.ts';
import { AwayLive } from '../../../src/health/panel/away.ts';
import { BOT_TOKEN_ENV, parseButtonId, tokenSource, type TokenState } from '../../../src/health/notify/discord-access.ts';
import { answeredPayload, askButtons, DiscordBot, FOLLOW_BATCH_MS } from '../../../src/health/notify/discord-bot.ts';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, DISCORD_INTENTS, discordGatewayUrl, DiscordGateway, FATAL_CLOSE, IDENTIFY_MAX, loopbackGatewayUrl, type WsLike } from '../../../src/health/notify/discord-gateway.ts';
import { DiscordRest, routeKey, type RestFetch } from '../../../src/health/notify/discord-rest.ts';
import type { Logger } from '../../../src/log.ts';
import { AskBox, type AskAnswer } from '../../../src/tasks/ask.ts';
import type { CommandDeps } from '../../../src/tasks/process/deps.ts';
import { setup } from '../connection-fakes.ts';
import { FAKE_TOKEN } from './discord-access.test.ts';
import { COMMANDS_FILE, slashPayload } from '../../../src/health/notify/discord-slash.ts';
import { fakeDiscord, tokenOf, type FakeDiscord } from './fake-discord.ts';

const OWNER = '111111111111111111';
const OWNER2 = '121212121212121212';
const STRANGER = '222222222222222222';
const CHAN = '333333333333333333';
const OTHER_CHAN = '343434343434343434';
const NOTES = '363636363636363636';
const GUILD = '444444444444444444';
const set: TokenState = { state: 'set', token: FAKE_TOKEN, source: 'env' };

function capture(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const put = (l: string, ...rest: unknown[]) => lines.push([l, ...rest.map(String)].join(' '));
  return { lines, debug: put, info: put, warn: put, error: put };
}

class FakeWs implements WsLike {
  readyState = 1;
  sent: { op: number; d: unknown }[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onclose: WsLike['onclose'] = null;
  onerror: WsLike['onerror'] = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(s: string): void {
    this.sent.push(JSON.parse(s) as { op: number; d: unknown });
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  recv(o: unknown): void {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function gateway(over: Partial<ConstructorParameters<typeof DiscordGateway>[0]> = {}) {
  const socks: FakeWs[] = [];
  const dispatched: string[] = [];
  let urls = 0;
  const gw = new DiscordGateway({
    token: () => FAKE_TOKEN,
    url: () => {
      urls++;
      return Promise.resolve('wss://gateway.discord.gg');
    },
    allowUrl: discordGatewayUrl,
    intents: DISCORD_INTENTS,
    onDispatch: (t) => dispatched.push(t),
    ws: (u) => {
      const s = new FakeWs(u);
      socks.push(s);
      return s;
    },
    random: () => 0.25,
    ...over,
  });
  return { gw, socks, dispatched, urls: () => urls };
}

const READY = (s = 1) => ({ op: 0, t: 'READY', s, d: { session_id: 'sess-1', resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg', user: { id: '555555555555555555' } } });

describe('the gateway', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('identify with the intents, the first heartbeat after interval x jitter, then every interval', async () => {
    vi.useFakeTimers();
    const { gw, socks, dispatched } = gateway();
    gw.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(socks).toHaveLength(1);
    expect(socks[0]!.url).toBe('wss://gateway.discord.gg/?v=10&encoding=json');
    socks[0]!.recv({ op: 10, d: { heartbeat_interval: 40_000 } });
    expect(socks[0]!.sent[0]).toMatchObject({ op: 2, d: { token: FAKE_TOKEN, intents: DISCORD_INTENTS } });
    expect(DISCORD_INTENTS).toBe(512 + 4096 + 32768); // guild messages, direct messages, message content
    expect(gw.status().state).toBe('identifying');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(socks[0]!.sent.filter((f) => f.op === 1)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socks[0]!.sent.filter((f) => f.op === 1)).toEqual([{ op: 1, d: null }]); // 40 000 x 0.25
    socks[0]!.recv({ op: 11 });
    socks[0]!.recv(READY(1));
    expect(gw.status()).toMatchObject({ state: 'ready', self: '555555555555555555', sessions: 1 });
    socks[0]!.recv({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} });
    expect(dispatched).toEqual(['READY', 'MESSAGE_CREATE']);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(socks[0]!.sent.filter((f) => f.op === 1).at(-1)).toEqual({ op: 1, d: 2 }); // the last sequence
    socks[0]!.recv({ op: 1 }); // Discord asks for one now
    expect(socks[0]!.sent.filter((f) => f.op === 1)).toHaveLength(3);
    gw.stop();
    expect(socks[0]!.closed?.code).toBe(1000);
  });

  it('a heartbeat not acknowledged: the link is closed with 4000 and the session resumed on the resume URL', async () => {
    vi.useFakeTimers();
    const { gw, socks } = gateway();
    gw.start();
    await vi.advanceTimersByTimeAsync(0);
    socks[0]!.recv({ op: 10, d: { heartbeat_interval: 40_000 } });
    socks[0]!.recv(READY(3));
    await vi.advanceTimersByTimeAsync(10_000); // the first beat; no ACK comes
    await vi.advanceTimersByTimeAsync(40_000);
    expect(socks[0]!.closed?.code).toBe(4000);
    expect(gw.status().state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS * 0.625);
    expect(socks).toHaveLength(2);
    expect(socks[1]!.url).toBe('wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json');
    socks[1]!.recv({ op: 10, d: { heartbeat_interval: 40_000 } });
    expect(socks[1]!.sent[0]).toEqual({ op: 6, d: { token: FAKE_TOKEN, session_id: 'sess-1', seq: 3 } });
    socks[1]!.recv({ op: 0, t: 'RESUMED', s: 4, d: {} });
    expect(gw.status()).toMatchObject({ state: 'ready', resumes: 1, sessions: 1 });
    gw.stop();
  });

  it('op 7 resumes; op 9 false identifies anew after 1 to 5 s; 4007 and 4009 drop the session', async () => {
    vi.useFakeTimers();
    const { gw, socks } = gateway();
    gw.start();
    await vi.advanceTimersByTimeAsync(0);
    socks[0]!.recv({ op: 10, d: { heartbeat_interval: 40_000 } });
    socks[0]!.recv(READY(1));
    socks[0]!.recv({ op: 7 });
    await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
    socks[1]!.recv({ op: 10, d: { heartbeat_interval: 40_000 } });
    expect(socks[1]!.sent[0]!.op).toBe(6);
    socks[1]!.recv({ op: 9, d: false });
    await vi.advanceTimersByTimeAsync(1999);
    expect(socks).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // 1 000 + 4 000 x 0.25
    socks[2]!.recv({ op: 10, d: { heartbeat_interval: 40_000 } });
    expect(socks[2]!.sent[0]!.op).toBe(2);
    socks[2]!.recv(READY(1));
    socks[2]!.serverClose(4009, 'Session timed out');
    await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
    socks[3]!.recv({ op: 10, d: { heartbeat_interval: 40_000 } });
    expect(socks[3]!.sent[0]!.op).toBe(2);
    expect(gw.status().sessions).toBe(3);
    gw.stop();
  });

  it('the backoff doubles with jitter up to 5 min; a fatal close stops for good', async () => {
    vi.useFakeTimers();
    let n = 0;
    const { gw, socks } = gateway({
      url: () => {
        n++;
        return Promise.resolve(undefined); // Discord does not answer
      },
    });
    gw.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    const waits = [2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000].map((w) => w * 0.625);
    for (const [i, w] of waits.entries()) {
      await vi.advanceTimersByTimeAsync(w - 1);
      expect(n, `try ${i + 2}`).toBe(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(n).toBe(i + 2);
    }
    expect(Math.max(...waits)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    gw.stop();
    expect(socks).toHaveLength(0);
    for (const code of Object.keys(FATAL_CLOSE).map(Number)) {
      const g = gateway();
      g.gw.start();
      await vi.advanceTimersByTimeAsync(0);
      g.socks[0]!.recv({ op: 10, d: { heartbeat_interval: 40_000 } });
      g.socks[0]!.serverClose(code, 'x');
      expect(g.gw.status().state).toBe('stopped');
      await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS * 2);
      expect(g.socks).toHaveLength(1);
    }
    const g = gateway();
    g.gw.start();
    await vi.advanceTimersByTimeAsync(0);
    g.socks[0]!.serverClose(4014, 'Disallowed intent(s).');
    expect(g.gw.status().why).toMatch(/Message Content intent/);
  });

  it('at most 20 new sessions a day: a loop of identifies stops; a URL that is not Discord is never connected to', async () => {
    vi.useFakeTimers();
    const { gw, socks } = gateway();
    gw.start();
    for (let i = 0; i < IDENTIFY_MAX + 5; i++) {
      const had = socks.length;
      for (let t = 0; t < 400 && socks.length === had && gw.status().state !== 'stopped'; t++) await vi.advanceTimersByTimeAsync(1000);
      if (socks.length === had) break;
      const s = socks.at(-1)!;
      s.recv({ op: 10, d: { heartbeat_interval: 40_000 } });
      s.serverClose(4009);
    }
    expect(socks).toHaveLength(IDENTIFY_MAX);
    expect(socks.every((s) => s.sent[0]?.op === 2)).toBe(true);
    expect(gw.status()).toMatchObject({ state: 'stopped', sessions: IDENTIFY_MAX });
    expect(gw.status().why).toMatch(/20 new sessions in 24 h/);
    const evil = gateway({ url: () => Promise.resolve('wss://evil.example.com') });
    evil.gw.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(evil.socks).toHaveLength(0);
    expect(evil.gw.status().why).toMatch(/not Discord's/);
    for (const ok of ['wss://gateway.discord.gg', 'wss://gateway-us-east1-b.discord.gg']) expect(discordGatewayUrl(ok)).toBe(true);
    for (const bad of ['ws://gateway.discord.gg', 'wss://discord.gg.evil.com', 'wss://evil.com/?h=discord.gg', 'https://gateway.discord.gg', 'wss://gateway.discord.gg:8443', 'nonsense']) expect(discordGatewayUrl(bad), bad).toBe(false);
    expect(loopbackGatewayUrl('ws://127.0.0.1:10131', 'http://127.0.0.1:10131')).toBe(true);
    expect(loopbackGatewayUrl('ws://127.0.0.1:10132', 'http://127.0.0.1:10131')).toBe(false);
    expect(loopbackGatewayUrl('ws://10.0.0.1:10131', 'http://127.0.0.1:10131')).toBe(false);
  });

  it('no token: nothing connects; a handler that throws is caught', async () => {
    vi.useFakeTimers();
    const none = gateway({ token: () => undefined });
    none.gw.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(none.socks).toHaveLength(0);
    expect(none.gw.status()).toMatchObject({ state: 'stopped', why: 'no token' });
    const boom = gateway({
      onDispatch: () => {
        throw new Error('handler');
      },
    });
    boom.gw.start();
    await vi.advanceTimersByTimeAsync(0);
    boom.socks[0]!.recv({ op: 10, d: { heartbeat_interval: 40_000 } });
    expect(() => boom.socks[0]!.recv(READY(1))).not.toThrow();
    expect(() => boom.socks[0]!.onmessage?.({ data: 'not json' })).not.toThrow();
    expect(boom.gw.status().state).toBe('ready');
    boom.gw.stop();
  });
});

describe('the REST client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  interface Ans {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }
  const fetchOf = (answers: (Ans | 'hang')[], calls: { url: string; auth?: string | undefined; at: number }[]): RestFetch => (url, init) => {
    calls.push({ url, auth: init.headers.authorization, at: Date.now() });
    const a = answers.shift() ?? { status: 200, body: {} };
    if (a === 'hang')
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    return Promise.resolve({ status: a.status, headers: { get: (n: string) => a.headers?.[n.toLowerCase()] ?? null }, text: () => Promise.resolve(a.body === undefined ? '' : JSON.stringify(a.body)) });
  };

  it('routes: the first id stays, the others go; an interaction token never stays', () => {
    expect(routeKey('POST', '/channels/333333333333333333/messages')).toBe('POST /channels/333333333333333333/messages');
    expect(routeKey('PATCH', '/channels/333333333333333333/messages/999999999999999999')).toBe('PATCH /channels/333333333333333333/messages/:id');
    expect(routeKey('POST', '/interactions/999999999999999999/aW50ZXJhY3Rpb246OTk5OTk5OTk5OTk5OTk5OTk5Ojk5OTk5/callback')).toBe('POST /interactions/:id/:id/callback');
  });

  it('a 429 waits its retry_after and is tried again; a global one holds every route; a 0 bucket waits its reset', async () => {
    vi.useFakeTimers();
    const calls: { url: string; at: number }[] = [];
    const rest = new DiscordRest({ token: () => set, fetch: fetchOf([{ status: 429, body: { retry_after: 1.5, global: false } }, { status: 200, body: { id: '1' } }], calls) });
    const p = rest.call('POST', `/channels/${CHAN}/messages`, { content: 'x' });
    await vi.advanceTimersByTimeAsync(1499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ ok: true, status: 200, body: { id: '1' } });
    expect(rest.stats).toMatchObject({ limited: 1, sent: 1 });
    const g: { url: string; at: number }[] = [];
    const rest2 = new DiscordRest({ token: () => set, fetch: fetchOf([{ status: 429, body: { retry_after: 2, global: true } }, { status: 200 }, { status: 200 }], g) });
    const a = rest2.call('POST', `/channels/${CHAN}/messages`, {});
    await vi.advanceTimersByTimeAsync(10);
    const b = rest2.call('POST', `/channels/${OTHER_CHAN}/messages`, {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(g).toHaveLength(1); // the other route waits too
    await vi.advanceTimersByTimeAsync(1000);
    expect((await a).ok && (await b).ok).toBe(true);
    const k: { url: string; at: number }[] = [];
    const rest3 = new DiscordRest({ token: () => set, fetch: fetchOf([{ status: 200, headers: { 'x-ratelimit-bucket': 'abc', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '3' } }, { status: 200 }], k) });
    await rest3.call('POST', `/channels/${CHAN}/messages`, {});
    const c = rest3.call('POST', `/channels/${CHAN}/messages`, {});
    await vi.advanceTimersByTimeAsync(2999);
    expect(k).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await c).ok).toBe(true);
  });

  it('a 401 stops every request until the token changes; an answer to a press goes without the bot token and is never retried', async () => {
    let tok: TokenState = set;
    const calls: { url: string; auth?: string | undefined; at: number }[] = [];
    const log = capture();
    const rest = new DiscordRest({ token: () => tok, fetch: fetchOf([{ status: 401, body: { message: '401: Unauthorized' } }, { status: 200 }, { status: 503 }], calls), log });
    expect(await rest.call('GET', '/gateway/bot')).toMatchObject({ ok: false, status: 401 });
    expect(await rest.call('GET', '/gateway/bot')).toMatchObject({ ok: false, status: 401 });
    expect(calls).toHaveLength(1);
    expect(rest.stopped()).toBe(true);
    tok = { state: 'set', token: `${FAKE_TOKEN}x`, source: 'file' };
    expect(await rest.call('GET', '/gateway/bot')).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.auth).toBe(`Bot ${FAKE_TOKEN}`);
    expect(await rest.call('POST', '/interactions/999999999999999999/tok-abc/callback', { type: 6 }, { noAuth: true, callback: true })).toMatchObject({ ok: false, status: 503 });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.auth).toBeUndefined();
    expect(log.lines.join('\n')).not.toContain(FAKE_TOKEN);
  });

  it('no answer: aborted after the timeout, tried once more, then failed; the error never holds the token', async () => {
    vi.useFakeTimers();
    const calls: { url: string; at: number }[] = [];
    const rest = new DiscordRest({ token: () => set, fetch: fetchOf(['hang', 'hang'], calls), timeoutMs: 1000, retryMs: 500 });
    const p = rest.call('POST', `/channels/${CHAN}/messages`, {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ ok: false, status: null, why: 'no answer in 1 s' });
    const boom = new DiscordRest({ token: () => set, fetch: () => Promise.reject(new Error(`connect failed with ${FAKE_TOKEN}`)), retryMs: 1 });
    const r = boom.call('GET', '/gateway/bot');
    await vi.advanceTimersByTimeAsync(10);
    const got = await r;
    expect(got.ok).toBe(false);
    expect(JSON.stringify(got)).not.toContain(FAKE_TOKEN);
  });
});

describe('the buttons and the answered message', () => {
  it('Track D2: up to 5 a row, short labels, the default the one primary button; the answered message says the outcome, drops the buttons', () => {
    const view = { id: 3, key: 'k', text: 'job failed: retry?', choices: ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ id, label: `do ${id}`, n: i + 1, yes: false, no: false })), default: 'b', askedAt: 0, until: 60_000 };
    const card = { title: 'Job #3 failed: !x', detail: 'it broke', choices: { a: { short: 'Again', done: 'Done again' } } };
    const rows = askButtons('0a1b2c3d', view, card);
    expect(rows.map((r) => r.components.length)).toEqual([5, 1]);
    expect(rows[0]!.components[1]).toEqual({ type: 2, style: 1, label: 'B', custom_id: 'bb:0a1b2c3d:3:b' });
    expect(rows[0]!.components[0]).toEqual({ type: 2, style: 2, label: 'Again', custom_id: 'bb:0a1b2c3d:3:a' });
    expect(rows.flatMap((r) => r.components).filter((b) => b.style === 1)).toHaveLength(1);
    expect(parseButtonId(rows[1]!.components[0]!.custom_id)).toEqual({ run: '0a1b2c3d', ask: 3, choice: 'f' });
    const note = { id: 1, ts: 0, kind: 'ask.asked', event: 1, title: 'the bot asks (#3)', body: 'job failed: retry?', n: 1, ask: 3 };
    const p = answeredPayload({ note, view, card, answer: { choice: 'a', how: 'discord', by: 'Steve', afterS: 14, user: OWNER } }, 'UnitBot');
    expect(p).toEqual({ content: '', embeds: [{ title: 'Job #3 failed: !x', description: `It broke\n**Done again** by <@${OWNER}> · 14 s`, color: 0x99aab5, timestamp: '1970-01-01T00:00:00.000Z', footer: { text: 'UnitBot' } }], allowed_mentions: { parse: [] }, components: [] });
    expect(answeredPayload({ note, view, answer: { choice: 'b', how: 'timeout', afterS: 120 } }).embeds[0]!.description).toBe('No answer: b chosen');
    expect(answeredPayload({ note, view, answer: { choice: 'b', how: 'panel', by: 'Steve', afterS: 61 } }).embeds[0]!.description).toBe('**B chosen** by Steve in the panel · 1 min 1 s');
  });
});

describe('the bot against a local fake Discord (Node WebSocket, a free loopback port)', () => {
  let fake: FakeDiscord | undefined;
  let bot: DiscordBot | undefined;
  let away: AwayLive | undefined;
  afterEach(async () => {
    bot?.stop();
    away?.stop();
    bot = undefined;
    away = undefined;
    await fake?.close();
    fake = undefined;
  });

  function world(o: { users?: string; channels?: string; notes?: string; on?: boolean; env?: NodeJS.ProcessEnv; origin?: string; blocked?: string; stateDir?: string; text?: boolean } = {}) {
    const { conn } = setup();
    const chat = new Chat(conn, { owners: parseOwners(['Steve']), log: capture() });
    const runtime = new RuntimeSettings();
    registerSettingsCommands({ chat, settings: runtime } as unknown as CommandDeps);
    const bus = new EventBus();
    const box = new AskBox({ bus });
    const sources: string[] = [];
    const quits: number[] = [];
    chat.register({ name: 'answer', help: '', run: ({ reply, args, sender }) => reply(box.answer(args, senderLabel(sender), answerHow(sender))) });
    chat.register({
      name: 'pos',
      help: '',
      run: ({ reply, sender }) => {
        sources.push(`${sourceOf(sender)} ${senderLabel(sender)}`);
        reply('§aat§r 1 64 2 @everyone');
      },
    });
    chat.register({
      name: 'later',
      help: '',
      run: ({ reply }) => {
        reply('walking to 9 64 9');
        setTimeout(() => chat.say('arrived at 9 64 9'), 200);
      },
    });
    chat.register({ name: 'quiet', help: '', run: () => setTimeout(() => chat.say('done quietly'), 2500) });
    chat.register({ name: 'quit', help: '', run: () => quits.push(1) });
    chat.register({ name: 'status', help: '(what it is doing now)', tier: 'front', group: 'info', run: ({ reply, sender }) => (sources.push(`${sourceOf(sender)} ${senderLabel(sender)}`), reply('status: idle')) }); // Track D3
    chat.register({ name: 'goto', help: '<waypoint> | x y z [now] (walk to a waypoint)', group: 'go', run: ({ reply, args }) => reply(`walking to ${args.join(' ')}`) });
    runtime.set('discordUsers', o.users ?? `${OWNER},${OWNER2}`);
    if (o.text === false) runtime.set('discordText', false);
    runtime.set('discordChannels', o.channels ?? CHAN);
    runtime.set('discordNotes', o.notes ?? NOTES);
    if (o.on !== false) runtime.set('discordBot', true);
    const log = capture();
    const said: string[] = [];
    const tokens = tokenSource({ env: o.env ?? { [BOT_TOKEN_ENV]: FAKE_TOKEN }, configDir: undefined });
    const made = new DiscordBot({ chat, settings: runtime, tokens, log, bus, origin: o.origin ?? fake!.origin, ...(o.blocked ? { blocked: o.blocked } : {}), bot: () => 'UnitBot', backoffBaseMs: 100, waypoints: () => ['home', 'base', 'mine'], ...(o.stateDir ? { stateDir: o.stateDir } : {}) });
    bot = made;
    const orig = chat.say.bind(chat);
    chat.say = (m: string) => {
      said.push(m);
      return orig(m);
    };
    away?.stop(); // a second world in one test
    away = new AwayLive({ bus, source: { asks: () => box, notify: () => false }, sinks: [made] });
    const game = (body: string) => chat.handle({ type: 'chat', source: 'Steve', message: body, body, xuid: '', truth: false }, true);
    return { chat, runtime, bus, box, sources, quits, log, said, game, bot: made };
  }

  const postsTo = (ch: string) => fake!.posts.filter((p) => p.path === `/channels/${ch}/messages`);
  const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

  it('commands: an allowed user runs as the first owner marked discord, the reply comes back; strangers, bots, webhooks and other channels get nothing', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0] });
    const w = world();
    w.bot.start();
    await vi.waitFor(() => expect(fake!.readies).toBe(1), { timeout: 5000 });
    expect(fake.frames.find((f) => f.op === 2)!.d).toMatchObject({ intents: DISCORD_INTENTS });
    const id = fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!pos' });
    await vi.waitFor(() => expect(postsTo(CHAN)).toHaveLength(1), { timeout: 5000 });
    const p = postsTo(CHAN)[0]!;
    expect(p.body).toEqual({ content: 'at 1 64 2 @everyone', allowed_mentions: { parse: [] }, message_reference: { message_id: id, fail_if_not_exists: false } }); // Track D2: plain text; no ping (allowed_mentions)
    expect(p.auth).toBe(`Bot ${FAKE_TOKEN}`);
    expect(w.sources).toEqual(['discord Steve']);
    expect(w.log.lines).toContain(`discord: !pos (as Steve, from ${OWNER})`);
    fake.message({ author: STRANGER, channel: CHAN, guild: GUILD, content: '!pos' });
    fake.message({ author: STRANGER, channel: '999999999999999999', content: '!pos' }); // a stranger's DM
    fake.message({ author: OWNER, channel: OTHER_CHAN, guild: GUILD, content: '!pos' });
    fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!pos', bot: true });
    fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!pos', webhook: '777777777777777777' });
    fake.message({ author: '1000000000000000001', channel: CHAN, guild: GUILD, content: '!pos' }); // the bot itself
    fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: 'just talking' });
    await settle(600);
    expect(fake.posts).toHaveLength(1);
    expect(w.sources).toHaveLength(1);
    // a DM from an allowed user: no prefix needed
    fake.message({ author: OWNER, channel: '919191919191919191', content: 'pos' });
    await vi.waitFor(() => expect(postsTo('919191919191919191')).toHaveLength(1), { timeout: 5000 });
    expect(w.bot.statusLines()[1]).toMatch(/6 ignored/);
  });

  it('refused commands say why; the per-user limit; later lines follow; a quiet command says so first', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0] });
    const w = world();
    w.bot.start();
    await vi.waitFor(() => expect(fake!.readies).toBe(1), { timeout: 5000 });
    fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!quit' });
    fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!set discordUsers none' });
    await vi.waitFor(() => expect(postsTo(CHAN)).toHaveLength(2), { timeout: 5000 });
    expect(String(postsTo(CHAN)[0]!.body.content)).toMatch(/!quit is not taken from Discord: it ends the bot/);
    expect(String(postsTo(CHAN)[1]!.body.content)).toMatch(/!set is not taken from Discord: Discord may not change its own door/);
    expect(w.quits).toHaveLength(0);
    expect(w.runtime.get('discordUsers')).toBe(`${OWNER},${OWNER2}`);
    fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!later' });
    await vi.waitFor(() => expect(postsTo(CHAN).some((x) => String(x.body.content).includes('arrived at 9 64 9'))).toBe(true), { timeout: 6000 });
    const contents = postsTo(CHAN).map((x) => String(x.body.content));
    expect(contents).toContain('walking to 9 64 9');
    expect(contents).toContain('arrived at 9 64 9');
    fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!quiet' });
    await vi.waitFor(() => expect(postsTo(CHAN).some((x) => String(x.body.content).includes('!quiet: no reply yet'))).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(postsTo(CHAN).some((x) => String(x.body.content).includes('done quietly'))).toBe(true), { timeout: 8000 });
    // OWNER2: 5 commands in 20 s, the 6th is told, the 7th is ignored
    const before = postsTo(CHAN).length;
    for (let i = 0; i < 7; i++) fake.message({ author: OWNER2, channel: CHAN, guild: GUILD, content: '!pos' });
    await vi.waitFor(() => expect(postsTo(CHAN).length).toBe(before + 6), { timeout: 5000 });
    await settle(500);
    expect(postsTo(CHAN).length).toBe(before + 6);
    expect(postsTo(CHAN).filter((x) => String(x.body.content).includes('at most 5 commands in 20 s'))).toHaveLength(1);
  }, 30_000);

  it('Track D2: only the Discord command\'s own lines follow it: a panel or game command\'s reply and a line from nobody\'s command never reach Discord', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0] });
    const w = world();
    w.chat.register({ name: 'slow', help: '', run: ({ reply }) => setTimeout(() => reply('slow: done'), 600) });
    w.bot.start();
    await vi.waitFor(() => expect(fake!.readies).toBe(1), { timeout: 5000 });
    fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!later' });
    await vi.waitFor(() => expect(postsTo(CHAN)).toHaveLength(1), { timeout: 5000 }); // `walking to`, said during the call
    // in the follow window: the panel's command (its own scope), a typed one, a chore's line (no scope), a slow panel reply
    viaPanel(() => w.chat.handle({ type: 'chat', source: 'Steve', message: '!discord', body: '!discord', xuid: '', truth: false }, true));
    viaPanel(() => w.chat.handle({ type: 'chat', source: 'Steve', message: '!slow', body: '!slow', xuid: '', truth: false }, true));
    w.game('!pos');
    w.chat.say('food: ate 1 bread');
    await vi.waitFor(() => expect(postsTo(CHAN).some((x) => String(x.body.content).includes('arrived at 9 64 9'))).toBe(true), { timeout: 6000 });
    await settle(FOLLOW_BATCH_MS + 1000);
    const all = postsTo(CHAN).map((x) => String(x.body.content)).join('\n');
    expect(all).toBe('walking to 9 64 9\narrived at 9 64 9');
    for (const said of ['slow: done', 'food: ate 1 bread', '§aat§r 1 64 2 @everyone']) expect(w.said).toContain(said); // the game chat had them all
    for (const not of ['discord bot:', 'slow: done', 'food: ate', '@everyone']) expect(all).not.toContain(not);
  }, 20_000);

  it('a question: buttons in the notes channel; a stranger\'s press refused privately; the owner\'s press answers it (discord) and the message shows it; a closed one is edited', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0] });
    const w = world();
    w.bot.start();
    await vi.waitFor(() => expect(fake!.readies).toBe(1), { timeout: 5000 });
    const q = w.box.ask({ key: 'queue-fail', text: 'job #4 failed: retry it?', choices: [{ id: 'retry', label: 'retry it' }, { id: 'next', label: 'go on' }, { id: 'stop', label: 'pause' }], default: 'next', waitMs: 60_000 });
    await vi.waitFor(() => expect(postsTo(NOTES)).toHaveLength(1), { timeout: 5000 });
    const note = postsTo(NOTES)[0]!;
    const rows = note.body.components as { components: { custom_id: string; label: string }[] }[];
    expect(rows[0]!.components.map((b) => b.label)).toEqual(['Retry', 'Next', 'Stop']);
    const embed = (note.body.embeds as { title: string; description: string; fields?: unknown[] }[])[0]!;
    expect(embed.title).toBe('Job #4 failed: retry it?');
    expect(embed.description).toMatch(/^Unanswered: Next <t:\d+:R>$/); // Track D2: the buttons are the choices
    expect(embed.fields).toBeUndefined();
    const message = { id: '808080808080808080', channel_id: NOTES, content: String(note.body.content) };
    fake.answer = (r) => (r.method === 'POST' && r.path === `/channels/${NOTES}/messages` ? { status: 200, body: { id: message.id } } : undefined);
    // the post above got a random id: send the question again so its message id is known
    const q2 = w.box.ask({ key: 'queue-fail', text: 'job #5 failed: retry it?', choices: [{ id: 'retry', label: 'retry it' }, { id: 'next', label: 'go on' }], default: 'next', waitMs: 60_000 });
    expect((await q.answer).how).toBe('replaced');
    await vi.waitFor(() => expect(postsTo(NOTES)).toHaveLength(2), { timeout: 15_000 }); // the limiter: a question every 10 s
    const ids = (postsTo(NOTES)[1]!.body.components as { components: { custom_id: string }[] }[])[0]!.components.map((b) => b.custom_id);
    fake.press({ user: STRANGER, customId: ids[0]!, message, guild: GUILD });
    await vi.waitFor(() => expect(fake!.callbacks).toHaveLength(1), { timeout: 5000 });
    expect(fake.callbacks[0]!.body).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
    expect(fake.callbacks[0]!.auth).toBeUndefined();
    expect(w.box.size).toBe(1);
    fake.press({ user: OWNER, customId: ids[0]!.replace(/^bb:[0-9a-f]{8}/, 'bb:00000000'), message, guild: GUILD }); // a button from an earlier run
    await vi.waitFor(() => expect(fake!.callbacks).toHaveLength(2), { timeout: 5000 });
    expect(fake.callbacks[1]!.body).toMatchObject({ type: 7, data: { components: [] } });
    expect(w.box.size).toBe(1);
    const t0 = Date.now();
    fake.press({ user: OWNER, customId: ids[1]!, message, guild: GUILD }); // next
    const a: AskAnswer = await q2.answer;
    expect(a).toMatchObject({ choice: 'next', how: 'discord', by: 'Steve' });
    await vi.waitFor(() => expect(fake!.callbacks).toHaveLength(3), { timeout: 5000 });
    const cb = fake.callbacks[2]!;
    expect(cb.at - t0).toBeLessThan(3000); // Discord's 3 s
    const data = (cb.body as { type: number; data: { content: string; components: unknown[]; embeds: { description: string }[] } });
    expect(data.type).toBe(7);
    expect(data.data.components).toEqual([]);
    expect(data.data.content).toBe('');
    expect(data.data.embeds[0]!.description).toMatch(new RegExp(`^\\*\\*Next chosen\\*\\* by <@${OWNER}> · \\d+ s$`)); // Track D2: the presser named
    expect(fake.edits).toHaveLength(1); // the first question's message, replaced; the pressed one is updated by the answer itself
    expect(fake.edits[0]!.path).toMatch(new RegExp(`^/channels/${NOTES}/messages/\\d+$`));
    expect(fake.edits[0]!.path).not.toContain(message.id);
    expect(JSON.stringify(fake.edits[0]!.body)).toContain('Closed by a newer question: next chosen');
    expect(fake.edits[0]!.body.components).toEqual([]);
    expect(w.log.lines.some((l) => l === `discord: !answer ${q2.id} next (a button, as Steve, from ${OWNER})`)).toBe(true);
    // pressed again: the question is gone, said privately
    fake.press({ user: OWNER, customId: ids[1]!, message, guild: GUILD });
    await vi.waitFor(() => expect(fake!.callbacks).toHaveLength(4), { timeout: 5000 });
    expect(fake.callbacks[3]!.body).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(String((fake.callbacks[3]!.body.data as { content: string }).content)).toMatch(/no question #\d+ waits/);
  }, 40_000);

  it('!discord: the counts, not the ids; test sends one note; a reconnect resumes; the token in no output', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0] });
    const w = world();
    w.bot.start();
    await vi.waitFor(() => expect(fake!.readies).toBe(1), { timeout: 5000 });
    w.game('!discord');
    const status = w.said.join('\n');
    expect(status).toMatch(/discord bot: on, token set \(BEDROCKBOT_DISCORD_TOKEN\); gateway ready for/);
    expect(status).toMatch(/2 users, 1 channel, notes channel \.\.\.3636/);
    for (const id of [OWNER, OWNER2, CHAN, NOTES]) expect(status).not.toContain(id);
    w.game('!discord test');
    await vi.waitFor(() => expect(w.said.at(-1)).toBe('discord bot: test sent to 1 of 1 channel (channel ...3636)'), { timeout: 5000 });
    expect((postsTo(NOTES)[0]!.body.embeds as { title: string }[])[0]!.title).toBe('Test notification');
    fake.closeAll(4000, 'test');
    await vi.waitFor(() => expect(fake!.resumed).toBe(1), { timeout: 5000 });
    fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!pos' });
    await vi.waitFor(() => expect(postsTo(CHAN)).toHaveLength(1), { timeout: 5000 });
    w.game('!set discordBot');
    w.game('!set');
    w.game('!notify');
    const outputs = [...w.said, ...w.log.lines, ...w.bot.statusLines(), w.bot.statusLine(), JSON.stringify(w.runtime.snapshot()), JSON.stringify(w.bot.stats), ...fake.posts.map((p) => JSON.stringify(p.body)), ...fake.edits.map((p) => JSON.stringify(p.body))];
    for (const o of outputs) expect(o).not.toContain(FAKE_TOKEN);
    expect(fake.frames.filter((f) => f.op === 2 || f.op === 6).every((f) => (f.d as { token: string }).token === FAKE_TOKEN)).toBe(true); // it goes to Discord only
  }, 30_000);

  it('a refused token stops it (no loop); a new token starts it again; off closes; nothing connects with a blocked origin or no token', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0] });
    const env: NodeJS.ProcessEnv = { [BOT_TOKEN_ENV]: `${FAKE_TOKEN}-wrong` };
    const w = world({ env });
    w.bot.start();
    await vi.waitFor(() => expect(w.bot.statusLines()[0]).toMatch(/stopped: the token was refused \(401\)/), { timeout: 5000 });
    const calls = fake.rest.length;
    await settle(800);
    expect(fake.rest.length).toBe(calls);
    env[BOT_TOKEN_ENV] = FAKE_TOKEN;
    w.game('!discord');
    await vi.waitFor(() => expect(fake!.readies).toBe(1), { timeout: 5000 });
    w.game('!set discordBot off');
    await vi.waitFor(() => expect(w.bot.statusLines()[0]).toMatch(/^discord bot: off .*gateway off/), { timeout: 5000 });
    w.bot.stop();
    const before = fake.connections;
    const b = world({ blocked: 'BEDROCKBOT_DISCORD_TEST_ORIGIN is not a loopback origin: nothing connects' });
    b.bot.start();
    const n = world({ env: {} });
    n.bot.start();
    n.game('!set discordBot on');
    expect(n.said.join('\n')).toMatch(/discordBot: no token is set, so nothing connects: put it in env BEDROCKBOT_DISCORD_TOKEN or discord-bot\.token/);
    await settle(500);
    expect(fake.connections).toBe(before);
    expect(await b.bot.test({ title: 't', body: 'b', ts: 0, kind: 'notify.test' })).toMatch(/not a loopback origin/);
    b.bot.stop();
  }, 30_000);

  // ---- Track D3: slash commands, autocomplete, discordText, !discord setup ----------------------------------------

  const D3 = { guilds: [GUILD], channels: { [CHAN]: { guild_id: GUILD } } };
  const cb = (id: string) => fake!.callbacks.find((c) => c.path.includes(`/interactions/${id}/`));
  const ups = (id: string) => fake!.followups.filter((c) => c.path.includes(tokenOf(id)));

  it('Track D3: registered after READY for DMs and the listed channel\'s server, once: a restart with the same set registers nothing', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0], ...D3 });
    const dir = mkdtempSync(join(tmpdir(), 'bb-d3-'));
    try {
      const w = world({ stateDir: dir });
      w.bot.start();
      await vi.waitFor(() => expect(fake!.puts).toHaveLength(2), { timeout: 5000 });
      const app = '1000000000000000001';
      expect(fake.puts.map((p) => p.path)).toEqual([`/applications/${app}/commands`, `/applications/${app}/guilds/${GUILD}/commands`]);
      expect(fake.puts.every((p) => p.auth === `Bot ${FAKE_TOKEN}`)).toBe(true);
      expect(fake.puts[0]!.body as unknown).toEqual(slashPayload('global'));
      expect(fake.registered.get(GUILD)!.map((c) => c.name)).toEqual(['status', 'stop', 'come', 'goto', 'queue', 'run']);
      expect(JSON.parse(readFileSync(join(dir, COMMANDS_FILE), 'utf8'))).toMatchObject({ v: 1, scopes: { global: expect.any(String) as string, [GUILD]: expect.any(String) as string } });
      expect(w.log.lines.some((l) => l === 'discord bot: slash commands 6 for DMs and 1 server')).toBe(true);
      w.game('!discord');
      expect(w.said.find((l) => l.startsWith('discord bot: text commands on; slash commands 6 for DMs and 1 server'))).toBeDefined();
      w.bot.stop();
      const again = world({ stateDir: dir });
      again.bot.start();
      await vi.waitFor(() => expect(fake!.readies).toBe(2), { timeout: 5000 });
      await vi.waitFor(() => expect(again.bot.slash.status()).toHaveLength(2), { timeout: 5000 });
      expect(again.bot.slash.status().map((s) => s.how)).toEqual(['unchanged', 'unchanged']);
      expect(fake.puts).toHaveLength(2);
      // forced: `!discord commands sync`
      again.game('!discord commands sync');
      await vi.waitFor(() => expect(fake!.puts).toHaveLength(4), { timeout: 5000 });
      again.game('!discord commands remove');
      await vi.waitFor(() => expect(again.said.some((l) => l === 'discord bot: slash commands removed from 2 of 2 scopes')).toBe(true), { timeout: 5000 });
      expect(fake.registered.get('global')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('Track D3: a slash command runs through the same door: answered with its reply, its later lines as follow-ups; a quiet one deferred, then edited in', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0], ...D3 });
    const w = world();
    w.bot.start();
    await vi.waitFor(() => expect(fake!.puts).toHaveLength(2), { timeout: 5000 });
    const s = fake.slash({ user: OWNER, name: 'status', channel: CHAN, guild: GUILD });
    await vi.waitFor(() => expect(cb(s)).toBeDefined(), { timeout: 5000 });
    expect(cb(s)!.body).toEqual({ type: 4, data: { allowed_mentions: { parse: [] }, content: 'status: idle' } }); // not ephemeral: the channel sees it
    expect(cb(s)!.auth).toBeUndefined();
    expect(w.sources).toEqual(['discord Steve']);
    expect(w.log.lines).toContain(`discord: !status (a slash command, as Steve, from ${OWNER})`);
    // later lines: follow-ups on the interaction's own webhook, no bot token
    const l = fake.slash({ user: OWNER, name: 'run', options: { line: 'later' }, channel: CHAN, guild: GUILD });
    await vi.waitFor(() => expect(ups(l)).toHaveLength(1), { timeout: 6000 });
    expect(cb(l)!.body).toMatchObject({ type: 4, data: { content: 'walking to 9 64 9' } });
    expect(ups(l)[0]!).toMatchObject({ method: 'POST', path: `/webhooks/1000000000000000001/${tokenOf(l)}`, auth: undefined, body: { content: 'arrived at 9 64 9', allowed_mentions: { parse: [] } } });
    // a command that says nothing at once: deferred (Discord shows "thinking"), then the answer edited in, then follow-ups
    const q = fake.slash({ user: OWNER, name: 'run', options: { line: '!quiet' }, channel: CHAN, guild: GUILD });
    await vi.waitFor(() => expect(cb(q)).toBeDefined(), { timeout: 5000 });
    expect(cb(q)!.body).toEqual({ type: 5 });
    await vi.waitFor(() => expect(ups(q)).toHaveLength(2), { timeout: 8000 });
    expect(ups(q).map((u) => `${u.method} ${u.path.endsWith('/messages/@original') ? '@original' : 'follow-up'} ${String(u.body.content)}`)).toEqual(['PATCH @original !quiet: no reply yet (what it says in the next 2 min 0 s follows here)', 'POST follow-up done quietly']);
    // a DM from an allowed user; /goto through its own line
    const g = fake.slash({ user: OWNER, name: 'goto', options: { place: 'base' }, channel: '919191919191919191' });
    await vi.waitFor(() => expect(cb(g)).toBeDefined(), { timeout: 5000 });
    expect(cb(g)!.body).toMatchObject({ type: 4, data: { content: 'walking to base' } });
    // nothing posted in the channel itself: every answer went to the interactions
    expect(fake.posts).toHaveLength(0);
    for (const x of [...w.log.lines, ...w.bot.statusLines()]) expect(x).not.toContain('fake-interaction-token');
  }, 30_000);

  it('Track D3: a stranger, another channel, a refused command and the limit: an answer only that user sees, nothing run', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0], ...D3 });
    const w = world();
    w.bot.start();
    await vi.waitFor(() => expect(fake!.puts).toHaveLength(2), { timeout: 5000 });
    const eph = (id: string) => cb(id)!.body as { type: number; data: { flags?: number; content: string } };
    const ids = {
      stranger: fake.slash({ user: STRANGER, name: 'status', channel: CHAN, guild: GUILD }),
      strangerDm: fake.slash({ user: STRANGER, name: 'status', channel: '929292929292929292' }),
      channel: fake.slash({ user: OWNER, name: 'status', channel: OTHER_CHAN, guild: GUILD }),
      quit: fake.slash({ user: OWNER, name: 'run', options: { line: 'quit' }, channel: CHAN, guild: GUILD }),
      door: fake.slash({ user: OWNER, name: 'run', options: { line: 'set discordText off' }, channel: CHAN, guild: GUILD }),
      queued: fake.slash({ user: OWNER, name: 'queue', options: { do: 'add !learn' }, channel: CHAN, guild: GUILD }),
      old: fake.slash({ user: OWNER, name: 'nosuch', channel: CHAN, guild: GUILD }),
    };
    await vi.waitFor(() => expect(Object.values(ids).every((id) => cb(id))).toBe(true), { timeout: 5000 });
    for (const id of Object.values(ids)) expect(eph(id)).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(eph(ids.stranger).data.content).toBe('Only the users this bot was told to take commands from may use it.');
    expect(eph(ids.strangerDm).data.content).toBe('Only the users this bot was told to take commands from may use it.');
    expect(eph(ids.channel).data.content).toMatch(/^Not taken in this channel/);
    expect(eph(ids.quit).data.content).toMatch(/^!quit is not taken from Discord: it ends the bot/);
    expect(eph(ids.door).data.content).toMatch(/^!set is not taken from Discord: Discord may not change its own door/);
    expect(eph(ids.queued).data.content).toMatch(/^!queue is not taken from Discord: the queued line: it records a flight/);
    expect(eph(ids.old).data.content).toMatch(/^Not a command this bot registers/);
    expect(w.quits).toHaveLength(0);
    expect(w.runtime.get('discordText')).toBe(true);
    expect(w.sources).toHaveLength(0);
    // OWNER2: 5 in 20 s, then each one more is told so, privately
    const mine = Array.from({ length: 7 }, () => fake!.slash({ user: OWNER2, name: 'status', channel: CHAN, guild: GUILD }));
    await vi.waitFor(() => expect(mine.every((id) => cb(id))).toBe(true), { timeout: 5000 });
    expect(mine.map((id) => (eph(id).data.flags === 64 ? 'slow' : eph(id).data.content))).toEqual(['status: idle', 'status: idle', 'status: idle', 'status: idle', 'status: idle', 'slow', 'slow']);
    expect(eph(mine[5]!).data.content).toBe('Slow down: at most 5 commands in 20 s from one user.');
    expect(fake.posts).toHaveLength(0);
  }, 30_000);

  it('Track D3: autocomplete: the bot\'s commands and waypoints to an allowed user, nothing to a stranger, never a refused command', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0], ...D3 });
    const w = world();
    w.bot.start();
    await vi.waitFor(() => expect(fake!.puts).toHaveLength(2), { timeout: 5000 });
    const choices = (id: string) => (cb(id)!.body as { type: number; data: { choices: { name: string; value: string }[] } });
    const a = fake.autocomplete({ user: OWNER, name: 'run', focused: 'line', options: { line: 'q' }, channel: CHAN, guild: GUILD });
    const b = fake.autocomplete({ user: OWNER, name: 'goto', focused: 'place', options: { place: '' }, channel: CHAN, guild: GUILD });
    const c = fake.autocomplete({ user: STRANGER, name: 'goto', focused: 'place', options: { place: '' }, channel: CHAN, guild: GUILD });
    const d = fake.autocomplete({ user: OWNER, name: 'run', focused: 'line', options: { line: 'goto b' }, channel: '919191919191919191' });
    await vi.waitFor(() => expect([a, b, c, d].every((id) => cb(id))).toBe(true), { timeout: 5000 });
    expect(choices(a).type).toBe(8);
    expect(choices(a).data.choices.map((x) => x.value)).toEqual(['quiet']); // `quit` is never offered
    expect(choices(b).data.choices.map((x) => x.value)).toEqual(['home', 'base', 'mine']);
    expect(choices(c)).toEqual({ type: 8, data: { choices: [] } }); // a stranger learns nothing
    expect(choices(d).data.choices.map((x) => x.value)).toEqual(['goto b', 'goto base']);
    expect(w.bot.stats).toMatchObject({ autocomplete: 4, run: 0 }); // typing runs nothing and spends no command
  }, 30_000);

  it('Track D3: discordText off: no intent asked for (a new session), typed commands ignored, slash commands still run', async () => {
    fake = await fakeDiscord({ token: FAKE_TOKEN, ports: [0, 0], ...D3 });
    const w = world();
    w.bot.start();
    await vi.waitFor(() => expect(fake!.readies).toBe(1), { timeout: 5000 });
    expect(fake.frames.filter((f) => f.op === 2).map((f) => (f.d as { intents: number }).intents)).toEqual([DISCORD_INTENTS]);
    w.game('!set discordText off');
    await vi.waitFor(() => expect(fake!.readies).toBe(2), { timeout: 5000 });
    expect(fake.frames.filter((f) => f.op === 2).map((f) => (f.d as { intents: number }).intents)).toEqual([DISCORD_INTENTS, 0]);
    fake.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!pos' });
    const s = fake.slash({ user: OWNER, name: 'status', channel: CHAN, guild: GUILD });
    await vi.waitFor(() => expect(cb(s)).toBeDefined(), { timeout: 5000 });
    await settle(500);
    expect(fake.posts).toHaveLength(0);
    expect(cb(s)!.body).toMatchObject({ type: 4, data: { content: 'status: idle' } });
    w.game('!discord');
    expect(w.said.some((l) => l.startsWith('discord bot: text commands off (slash commands only, no intent asked for)'))).toBe(true);
    // after a 4014 (the intent not switched on) the switch starts it again with no intent
    w.bot.stop();
    const off = world({ text: true });
    off.bot.start();
    await vi.waitFor(() => expect(fake!.readies).toBe(3), { timeout: 5000 });
    fake.closeAll(4014, 'Disallowed intent(s).');
    await vi.waitFor(() => expect(off.bot.statusLines()[0]).toMatch(/stopped: disallowed intents \(4014\)/), { timeout: 5000 });
    off.game('!set discordText off');
    await vi.waitFor(() => expect(fake!.readies).toBe(4), { timeout: 5000 });
    expect((fake.frames.filter((f) => f.op === 2).at(-1)!.d as { intents: number }).intents).toBe(0);
  }, 30_000);

  it('Track D3: !discord setup: every step ok on a good set-up; a broken one says what is missing and how to fix it', async () => {
    const ROLE = '505050505050505050';
    fake = await fakeDiscord({
      token: FAKE_TOKEN,
      ports: [0, 0],
      guilds: [GUILD],
      channels: { [CHAN]: { guild_id: GUILD }, [NOTES]: { guild_id: GUILD } },
      guildData: { [GUILD]: { owner_id: OWNER, roles: [{ id: GUILD, permissions: '0' }, { id: ROLE, permissions: String(1024 + 2048 + 16384 + 65536) }] } },
      members: { [GUILD]: { '1000000000000000001': { roles: [ROLE] }, [OWNER]: { roles: [] }, [OWNER2]: { roles: [] } } },
    });
    const w = world();
    w.bot.start();
    await vi.waitFor(() => expect(fake!.puts).toHaveLength(2), { timeout: 5000 });
    const before = fake.rest.filter((r) => r.method !== 'GET').length;
    w.game('!discord setup');
    await vi.waitFor(() => expect(w.said.some((l) => l.startsWith('invite: '))).toBe(true), { timeout: 5000 });
    const good = w.said.filter((l) => l.startsWith('discord setup') || l.startsWith('ok: ') || l.startsWith('invite: ') || /^(missing|unknown|off) /.test(l));
    expect(good).toEqual([
      'discord setup: checking (the switch, the token, the gateway, the servers, the users, the channels, the notes, the slash commands) ...',
      'discord setup: 10 ok',
      'ok: switch, token, gateway, application, servers, users, channel ...3333, notes, text, slash',
      'invite: https://discord.com/oauth2/authorize?client_id=1000000000000000001&scope=bot+applications.commands&permissions=84992',
    ]);
    expect(fake.rest.filter((r) => r.method !== 'GET').length).toBe(before); // the check only reads
    // broken: a channel the bot cannot see, a user in no shared server, the notes channel without Embed Links
    w.bot.stop();
    await fake.close();
    fake = await fakeDiscord({
      token: FAKE_TOKEN,
      ports: [0, 0],
      guilds: [GUILD],
      channels: { [CHAN]: { status: 403 }, [NOTES]: { guild_id: GUILD, permission_overwrites: [{ id: ROLE, type: 0, allow: '0', deny: '16384' }] } },
      guildData: { [GUILD]: { owner_id: OWNER, roles: [{ id: GUILD, permissions: '0' }, { id: ROLE, permissions: String(1024 + 2048 + 16384 + 65536) }] } },
      members: { [GUILD]: { '1000000000000000001': { roles: [ROLE] }, [OWNER]: { roles: [] } } },
    });
    const b = world();
    b.bot.start();
    await vi.waitFor(() => expect(fake!.puts).toHaveLength(1), { timeout: 5000 }); // DMs only: the channel's server is unknown
    b.game('!discord setup');
    await vi.waitFor(() => expect(b.said.some((l) => l.startsWith('invite: '))).toBe(true), { timeout: 5000 });
    const lines = b.said.filter((l) => /^(missing|unknown) /.test(l) || l.startsWith('discord setup: ') || l.startsWith('ok: '));
    expect(lines.slice(1)).toEqual([
      'discord setup: 7 ok, 3 missing',
      'missing users: ...1212 shares no server with the bot: no direct message either way; fix: join a server the bot is in, or invite the bot to yours',
      'missing channel ...3333: the bot cannot see it (403); fix: invite the bot to that server with the link below, or give its role View Channel there',
      'missing notes: channel ...3636: seen, but the bot may not Embed Links there; fix: channel settings > Permissions: allow the bot\'s role Embed Links',
      'ok: switch, token, gateway, application, servers, text, slash',
    ]);
    for (const l of b.said) expect(l).not.toContain(FAKE_TOKEN);
  }, 30_000);
});
