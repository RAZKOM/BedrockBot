// Track N1 (docs/away.md "Discord", ADR 0116 addendum): the notes to the owner's own Discord webhook
// (health/notify/discord.ts): the shape check, where the URL comes from, the masking, the message and its cuts, the
// sink's limits (429, the bucket, the queue bound, the timeout, a dead webhook, no throw), and against a local fake
// webhook server (ports 10120 to 10124, never Discord): a death and a question reach it once each within the note
// limiter's rules, and the token appears in no log line, state, settings view, reply or /api/away answer.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chat, parseOwners } from '../../../src/chat/chat.ts';
import { registerSettingsCommands } from '../../../src/chat/commands.ts';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { Metrics } from '../../../src/connection/metrics.ts';
import { EventBus } from '../../../src/events/bus.ts';
import { AwayLive } from '../../../src/health/panel/away.ts';
import { setupPanel, type Panel, type PanelDeps } from '../../../src/health/panel/index.ts';
import { redact } from '../../../src/health/panel/logRing.ts';
import { NOTE_COOLDOWN_MS, type Note } from '../../../src/health/panel/notes.ts';
import { liteState } from '../../../src/health/panel/state.ts';
import {
  cut,
  DISCORD_ENV,
  DISCORD_FILE,
  DISCORD_HOSTS,
  DISCORD_LIMITS,
  DiscordSink,
  FAIL_LOG_MS,
  loadWebhook,
  parseWebhook,
  payloadFor,
  QUEUE_MAX,
  scrub,
  testOrigin,
  webhookSource,
  webhookText,
  type FetchLike,
  type WebhookState,
} from '../../../src/health/notify/discord.ts';
import type { Logger } from '../../../src/log.ts';
import { AskBox } from '../../../src/tasks/ask.ts';
import type { CommandDeps } from '../../../src/tasks/process/deps.ts';
import { setup } from '../connection-fakes.ts';

/** Obviously fake: Discord's tokens are about 68 characters of base64url; this one says what it is. */
const TOKEN = 'NOT-A-REAL-TOKEN_unit-test_n1';
const ID = '123456789012345678';
const URL_OK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
const set = (url = URL_OK): WebhookState => {
  const p = parseWebhook(url);
  if (!p.ok) throw new Error(p.why);
  return { state: 'set', hook: p.hook };
};
const at = { x: 1, y: 64, z: 2 };
const note = (over: Partial<Note> = {}): Note => ({ id: 1, ts: Date.UTC(2026, 10, 20, 12), kind: 'life.died', event: 1, title: 'the bot died', body: 'died (zombie) at 1 64 2.', n: 1, ask: null, ...over });

function capture(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const put = (l: string, ...rest: unknown[]) => lines.push([l, ...rest.map(String)].join(' '));
  return { lines, debug: put, info: put, warn: put, error: put };
}

describe('the shape check', () => {
  it('accepts a webhook on every Discord host, with an API version or a trailing slash', () => {
    for (const h of DISCORD_HOSTS) expect(parseWebhook(`https://${h}/api/webhooks/${ID}/${TOKEN}`).ok, h).toBe(true);
    expect(parseWebhook(`https://discord.com/api/v10/webhooks/${ID}/${TOKEN}/`)).toMatchObject({ ok: true, hook: { id: ID, url: URL_OK } });
    expect(parseWebhook(`  https://DISCORD.com/api/webhooks/${ID}/${TOKEN}\n`)).toMatchObject({ ok: true, hook: { url: URL_OK } });
    expect(parseWebhook('https://discord.com/api/webhooks/123/EXAMPLE').ok).toBe(true); // the docs' example
  });

  it('refuses anything else, and the reason never repeats the value', () => {
    const bad = [
      '',
      'not a url',
      `http://discord.com/api/webhooks/${ID}/${TOKEN}`,
      `https://example.com/api/webhooks/${ID}/${TOKEN}`,
      `https://discord.com.example.com/api/webhooks/${ID}/${TOKEN}`,
      `https://evil-discord.com/api/webhooks/${ID}/${TOKEN}`,
      `https://discord.com:8443/api/webhooks/${ID}/${TOKEN}`,
      `https://user:pw@discord.com/api/webhooks/${ID}/${TOKEN}`,
      `https://discord.com/api/webhooks/${ID}/${TOKEN}?wait=true`,
      `https://discord.com/api/webhooks/${ID}/${TOKEN}#x`,
      `https://discord.com/api/webhooks/abc/${TOKEN}`,
      `https://discord.com/api/webhooks/${ID}`,
      `https://discord.com/api/webhooks/${ID}/${TOKEN}/slack`,
      `https://discord.com/webhooks/${ID}/${TOKEN}`,
      `https://discord.com/api/webhooks/${ID}/tok%20en`,
    ];
    for (const b of bad) {
      const p = parseWebhook(b);
      expect(p.ok, b).toBe(false);
      if (!p.ok) expect(p.why).not.toContain(TOKEN);
    }
  });
});

describe('where the URL comes from, and what any output says of it', () => {
  it('the environment wins over the file; the file is its first line that is not blank or a # comment', () => {
    const files: Record<string, string> = { [join('/cfg', DISCORD_FILE)]: `# my channel\n\n  https://ptb.discord.com/api/webhooks/42/${TOKEN}  \n` };
    const read = (f: string) => files[f];
    expect(loadWebhook({ env: {}, configDir: undefined })).toEqual({ state: 'unset' });
    expect(loadWebhook({ env: {}, configDir: '/none', read })).toEqual({ state: 'unset' });
    expect(loadWebhook({ env: {}, configDir: '/cfg', read })).toMatchObject({ state: 'set', hook: { id: '42', source: 'file' } });
    expect(loadWebhook({ env: { [DISCORD_ENV]: URL_OK }, configDir: '/cfg', read })).toMatchObject({ state: 'set', hook: { id: ID, source: 'env' } });
    expect(loadWebhook({ env: { [DISCORD_ENV]: 'https://example.com/x' }, configDir: '/cfg', read })).toMatchObject({ state: 'refused', source: 'env' });
    expect(loadWebhook({ env: { [DISCORD_ENV]: '  ' }, configDir: '/cfg', read })).toMatchObject({ state: 'set', hook: { source: 'file' } }); // blank env: the file
    expect(loadWebhook({ env: {}, configDir: '/cfg', read: () => { throw new Error(`EACCES ${URL_OK}`); } })).toEqual({ state: 'refused', source: 'file', why: `${DISCORD_FILE} cannot be read` });
  });

  it('a file read again by reload (the owner puts it in place while the bot runs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'n1-hook-'));
    try {
      const src = webhookSource({ env: {}, configDir: dir });
      expect(src.get().state).toBe('unset');
      writeFileSync(join(dir, DISCORD_FILE), `${URL_OK}\n`);
      expect(src.get().state).toBe('unset');
      expect(src.reload()).toMatchObject({ state: 'set', hook: { id: ID, source: 'file' } });
      expect(src.get().state).toBe('set');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('webhookText shows set with the last 4 of the id (not the secret), not set, or the refusal', () => {
    expect(webhookText(set())).toBe(`set (id ...5678, ${DISCORD_ENV})`);
    expect(webhookText({ state: 'unset' })).toBe('not set');
    expect(webhookText({ state: 'refused', source: 'file', why: 'not https' })).toBe(`refused (${DISCORD_FILE}: not https)`);
    expect(webhookText(set())).not.toContain(TOKEN.slice(-4));
  });

  it('scrub hides any webhook token, and the panel log ring does too', () => {
    const line = `x ${URL_OK} y https://canary.discordapp.com/api/v10/webhooks/9/abc_DEF-1 z ${TOKEN}`;
    const w = set();
    const s = scrub(line, w.state === 'set' ? w.hook : undefined);
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain('abc_DEF-1');
    expect(s).toContain(`webhooks/${ID}/***`);
    expect(redact(line)).not.toContain('abc_DEF-1');
    expect(redact(`posting to ${URL_OK}`)).toBe(`posting to https://discord.com/api/webhooks/${ID}/***`);
  });

  it('a test origin is only http on 127.0.0.1 or localhost', () => {
    expect(testOrigin('http://127.0.0.1:10120')).toBe('http://127.0.0.1:10120');
    expect(testOrigin('http://localhost:10121/')).toBe('http://localhost:10121');
    for (const b of ['https://127.0.0.1:1', 'http://10.0.0.2:80', 'http://example.com', 'http://127.0.0.1:1/x', 'junk', '', undefined]) expect(testOrigin(b), String(b)).toBeUndefined();
  });
});

describe('the message', () => {
  it('a short content line, one embed, no pings', () => {
    const p = payloadFor(note(), { bot: 'UnitBot' });
    expect(p.content).toBe('UnitBot: the bot died');
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(p.embeds).toHaveLength(1);
    expect(p.embeds[0]).toMatchObject({ title: 'the bot died', description: 'died (zombie) at 1 64 2.', timestamp: '2026-11-20T12:00:00.000Z', footer: { text: 'UnitBot · life.died' } });
    expect(p.embeds[0]!.fields).toBeUndefined();
    expect(payloadFor(note({ n: 3 })).embeds[0]!.footer.text).toBe('life.died · 3 folded');
  });

  it('a question has its choices, the default and how to answer, and says Discord cannot answer back', () => {
    const now = Date.UTC(2026, 10, 20, 12);
    const ask = { id: 3, key: 'queue-fail', text: 'job #4 failed', choices: [{ id: 'retry', label: 'retry it', n: 1, yes: true, no: false }, { id: 'next', label: 'next', n: 2, yes: false, no: true }, { id: 'stop', label: 'pause', n: 3, yes: false, no: false }], default: 'next', askedAt: now, until: now + 120_000 };
    const p = payloadFor(note({ kind: 'ask.asked', title: 'the bot asks (#3)', ask: 3 }), { ask, now });
    const f = p.embeds[0]!.fields!;
    expect(f.map((x) => x.name)).toEqual(['Choices', 'Unanswered', 'How to answer']);
    expect(f[0]!.value).toBe('1 retry (retry it), 2 next, 3 stop (pause)');
    expect(f[1]!.value).toBe('in 2 min 0 s: next (the default)');
    expect(f[2]!.value).toMatch(/^Discord cannot carry an answer back\. In the game: !answer 3 <choice>/);
    expect(payloadFor(note({ ask: 5 })).embeds[0]!.fields![0]!.value).toMatch(/!answer 5 <choice>/); // the question gone from the box
  });

  it('every text within Discord limits, and a cut never splits a surrogate pair', () => {
    const long = 'x'.repeat(10_000);
    const ask = { id: 1, key: 'k', text: long, choices: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, label: long.slice(0, 40), n: i + 1, yes: false, no: false })), default: 'c0', askedAt: 0, until: 1 };
    const p = payloadFor(note({ title: long, body: long, ask: 1 }), { bot: long, ask });
    const e = p.embeds[0]!;
    expect(p.content.length).toBeLessThanOrEqual(DISCORD_LIMITS.content);
    expect(e.title.length).toBeLessThanOrEqual(DISCORD_LIMITS.title);
    expect(e.description.length).toBeLessThanOrEqual(DISCORD_LIMITS.description);
    expect(e.footer.text.length).toBeLessThanOrEqual(DISCORD_LIMITS.footer);
    for (const f of e.fields!) expect(f.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
    const total = e.title.length + e.description.length + e.footer.text.length + e.fields!.reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);
    const emoji = `${'a'.repeat(6)}\u{1F600}xyz`; // the pair at 6..7
    expect(cut(emoji, 10)).toBe('aaaaaa...');
    expect(cut('short', 10)).toBe('short');
  });
});

/** A fake fetch: answers from a list, records every call. */
interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}
function fakeFetch(answers: (() => Answer | Promise<Answer>)[]) {
  const calls: { url: string; body: string; at: number }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body, at: Date.now() });
    const next = answers.shift() ?? (() => ({ status: 204 }));
    const r = await new Promise<{ status: number; headers?: Record<string, string>; body?: string }>((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      Promise.resolve(next()).then(resolve, reject);
    });
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, text: () => Promise.resolve(r.body ?? '') };
  };
  return { f, calls };
}
const ok = (): Answer => ({ status: 204 });

describe('the sink', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends while on with a URL set; off or unset sends nothing', async () => {
    let on = false;
    let hook: WebhookState = set();
    const { f, calls } = fakeFetch([]);
    const s = new DiscordSink({ webhook: () => hook, on: () => on, fetch: f });
    s.send(note());
    expect(calls).toHaveLength(0);
    on = true;
    hook = { state: 'unset' };
    expect(s.active()).toBe(false);
    s.send(note());
    expect(calls).toHaveLength(0);
    hook = set();
    s.send(note());
    await vi.waitFor(() => expect(s.stats.sent).toBe(1));
    expect(calls[0]!.url).toBe(URL_OK);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ embeds: [{ title: 'the bot died' }] });
    s.stop();
  });

  it('a 429 is honoured: nothing until retry_after, then the same note again', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { f, calls } = fakeFetch([() => ({ status: 429, headers: { 'retry-after': '9' }, body: JSON.stringify({ message: 'You are being rate limited.', retry_after: 2.5, global: false }) })]);
    const s = new DiscordSink({ webhook: () => set(), on: () => true, fetch: f });
    s.send(note({ title: 'one' }));
    s.send(note({ title: 'two' }));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
    expect(s.stats).toMatchObject({ rateLimited: 1, waiting: 2, last: '429: waiting 3 s' });
    await vi.advanceTimersByTimeAsync(2400);
    expect(calls).toHaveLength(1); // retry_after (2.5 s) wins over the header
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => (JSON.parse(c.body) as { content: string }).content)).toEqual(['one', 'one', 'two']);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(2500);
    expect(s.stats).toMatchObject({ sent: 2, dropped: 0, waiting: 0 });
    s.stop();
  });

  it('a bucket at 0 waits for X-RateLimit-Reset-After before the next request', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { f, calls } = fakeFetch([() => ({ status: 204, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '1.5' } })]);
    const s = new DiscordSink({ webhook: () => set(), on: () => true, fetch: f });
    s.send(note({ title: 'a' }));
    s.send(note({ title: 'b' }));
    await vi.advanceTimersByTimeAsync(1400);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
    s.stop();
  });

  it('the queue holds QUEUE_MAX notes; the oldest go first and are counted, logged once', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { f, calls } = fakeFetch([async () => (await hold, { status: 204 })]);
    const log = capture();
    const s = new DiscordSink({ webhook: () => set(), on: () => true, fetch: f, log });
    for (let i = 0; i < QUEUE_MAX + 6; i++) s.send(note({ title: `n${i}` }));
    expect(calls).toHaveLength(1); // n0 in flight
    expect(s.stats).toMatchObject({ waiting: QUEUE_MAX, dropped: 5 });
    expect(log.lines.filter((l) => l.includes('queue is full'))).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(QUEUE_MAX + 1);
    expect((JSON.parse(calls[1]!.body) as { content: string }).content).toBe('n6');
    s.stop();
  });

  it('a request with no answer is cut by the timeout, tried once more after the retry wait, then dropped', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const never = (): Promise<Answer> => new Promise<never>(() => undefined);
    const { f, calls } = fakeFetch([never, never]);
    const log = capture();
    const s = new DiscordSink({ webhook: () => set(), on: () => true, fetch: f, log, timeoutMs: 1000, retryMs: 5000 });
    s.send(note());
    await vi.advanceTimersByTimeAsync(1001);
    expect(s.stats.last).toBe('no answer: no answer in 1 s');
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1001);
    expect(s.stats).toMatchObject({ failed: 1, waiting: 0, sent: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2); // no retry storm
    expect(log.lines).toHaveLength(1);
    s.stop();
  });

  it('a 404 or 401 stops it until a test or another URL; nothing thrown, the URL in no line', async () => {
    const log = capture();
    let hook = set();
    const { f, calls } = fakeFetch([() => ({ status: 404, body: JSON.stringify({ message: 'Unknown Webhook', code: 10015 }) }), () => ({ status: 401, body: '{"message": "Invalid Webhook Token", "code": 50027}' })]);
    const s = new DiscordSink({ webhook: () => hook, on: () => true, fetch: f, log });
    s.send(note());
    await vi.waitFor(() => expect(s.stats.stopped).toBe('404 the webhook is invalid or was deleted'));
    s.send(note());
    s.send(note());
    expect(calls).toHaveLength(1);
    expect(s.stats.dropped).toBe(2);
    expect(s.statusLine()).toMatch(/stopped: 404 the webhook is invalid or was deleted \(!notify test tries again\)$/);
    expect(await s.test({ title: 't', body: 'b', ts: Date.now(), kind: 'notify.test' })).toBe('discord: 401 the webhook is invalid or was deleted');
    hook = set(`https://discord.com/api/webhooks/99/${TOKEN}`);
    s.send(note());
    await vi.waitFor(() => expect(s.stats.sent).toBe(1)); // another webhook: sent
    expect(s.stats.stopped).toBeNull();
    for (const l of [...log.lines, s.statusLine(), JSON.stringify(s.stats)]) expect(l).not.toContain(TOKEN);
    s.stop();
  });

  it('a 5xx is tried once more; a 400 is dropped with its reason scrubbed; a throwing fetch never throws', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { f, calls } = fakeFetch([() => ({ status: 502 }), ok, () => ({ status: 400, body: `{"message": "bad ${URL_OK}"}` })]);
    const s = new DiscordSink({ webhook: () => set(), on: () => true, fetch: f, retryMs: 1000 });
    s.send(note());
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls).toHaveLength(2);
    expect(s.stats.sent).toBe(1);
    s.send(note());
    await vi.advanceTimersByTimeAsync(10);
    expect(s.stats.failed).toBe(1);
    expect(s.stats.last).toMatch(/^400 refused/);
    expect(s.stats.last).not.toContain(TOKEN);
    const boom = new DiscordSink({ webhook: () => set(), on: () => true, fetch: () => {
      throw new Error(`connect ${URL_OK}`);
    } });
    expect(() => boom.send(note())).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);
    expect(boom.stats.last).not.toContain(TOKEN);
    const bad = new DiscordSink({ webhook: () => { throw new Error('x'); }, on: () => { throw new Error('y'); } });
    expect(() => bad.send(note())).not.toThrow();
    expect(bad.active()).toBe(false);
    s.stop();
    boom.stop();
  });

  it('failures are logged at most once per FAIL_LOG_MS', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const log = capture();
    const { f } = fakeFetch(Array.from({ length: 20 }, () => () => ({ status: 400 })));
    const s = new DiscordSink({ webhook: () => set(), on: () => true, fetch: f, log });
    for (let i = 0; i < 5; i++) {
      s.send(note());
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(s.stats.failed).toBe(5);
    expect(log.lines).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FAIL_LOG_MS);
    s.send(note());
    await vi.advanceTimersByTimeAsync(10);
    expect(log.lines).toHaveLength(2);
    s.stop();
  });

  it('!notify test: sent, not set, refused, off; never the URL', async () => {
    const { f } = fakeFetch([]);
    let hook: WebhookState = { state: 'unset' };
    let on = true;
    const s = new DiscordSink({ webhook: () => hook, on: () => on, fetch: f });
    const t = { title: 'test notification', body: 'b', ts: Date.now(), kind: 'notify.test' };
    expect(await s.test(t)).toMatch(/^discord: not set \(BEDROCKBOT_DISCORD_WEBHOOK or discord-webhook\.url in the config directory/);
    hook = { state: 'refused', source: 'env', why: 'not https' };
    expect(await s.test(t)).toBe('discord: refused (BEDROCKBOT_DISCORD_WEBHOOK: not https)');
    hook = set();
    on = false;
    expect(await s.test(t)).toBe('discord: off (!set notifyDiscord on)');
    on = true;
    expect(await s.test(t)).toBe('discord: sent (204)');
    s.stop();
  });
});

// ---- against a local fake webhook server (never Discord)

interface Fake {
  server: Server;
  port: number;
  posts: { path: string; body: Record<string, unknown> }[];
  answer: (path: string) => { status: number; headers?: Record<string, string>; body?: string };
}

async function fakeWebhook(lo = 10120, hi = 10124): Promise<Fake> {
  for (let port = lo; port <= hi; port++) {
    const f: Fake = { server: undefined as unknown as Server, port, posts: [], answer: () => ({ status: 204 }) };
    f.server = createServer((req, res) => {
      let b = '';
      req.on('data', (d: Buffer) => (b += d.toString()));
      req.on('end', () => {
        f.posts.push({ path: req.url ?? '', body: JSON.parse(b || '{}') as Record<string, unknown> });
        const a = f.answer(req.url ?? '');
        res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers ?? {}) });
        res.end(a.body ?? '');
      });
    });
    const okBind = await new Promise<boolean>((resolve) => {
      f.server.once('error', () => resolve(false));
      f.server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (okBind) return f;
  }
  throw new Error(`no free port in ${lo}..${hi}`);
}
const close = (f: Fake | undefined) => new Promise<void>((r) => (f ? f.server.close(() => r()) : r()));

describe('against a local fake webhook', () => {
  let fake: Fake | undefined;
  let panel: Panel | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    await panel?.stop();
    panel = undefined;
    await close(fake);
    fake = undefined;
  });

  it('a death and a question reach it once each; two more deaths inside the minute fold into one later message', async () => {
    fake = await fakeWebhook();
    let t = 50_000_000;
    const bus = new EventBus();
    const box = new AskBox({ bus });
    const sink = new DiscordSink({ webhook: () => set(), on: () => true, origin: `http://127.0.0.1:${fake.port}` });
    const a = new AwayLive({ bus, source: { asks: () => box, notify: () => false }, discord: sink, now: () => t }); // notify off: Discord alone makes the notes
    bus.emit('life.died', { n: 1, cause: 'death.attack.zombie', at });
    box.ask({ key: 'queue-fail', text: 'job #2 failed: retry it?', choices: [{ id: 'retry', label: 'retry it' }, { id: 'next', label: 'go on' }], default: 'next', waitMs: 60_000 });
    await vi.waitFor(() => expect(fake!.posts).toHaveLength(2), { timeout: 5000 });
    t += 20_000;
    bus.emit('life.died', { n: 2, cause: 'death.attack.zombie', at });
    t += 20_000;
    bus.emit('life.died', { n: 3, cause: 'death.attack.zombie', at });
    a.flush();
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.posts).toHaveLength(2); // folded: the cooldown
    t += NOTE_COOLDOWN_MS;
    a.flush();
    await vi.waitFor(() => expect(fake!.posts).toHaveLength(3), { timeout: 5000 });
    const [d1, q, d2] = fake.posts.map((p) => p.body as { content: string; embeds: { title: string; footer: { text: string }; fields?: { name: string; value: string }[] }[] });
    expect(fake.posts.every((p) => p.path === `/api/webhooks/${ID}/${TOKEN}`)).toBe(true);
    expect(d1!.embeds[0]!.title).toBe('the bot died');
    expect(q!.embeds[0]!.title).toBe('the bot asks (#1)');
    expect(q!.embeds[0]!.fields![0]!.value).toBe('1 retry (retry it), 2 next (go on)');
    expect(d2!.embeds[0]!.title).toMatch(/^the bot died \(2 times in \d+ s\)$/); // the span from the events' own times (the bus's clock)
    expect(d2!.embeds[0]!.footer).toEqual({ text: 'life.died · 2 folded' });
    expect(sink.stats).toMatchObject({ sent: 3, failed: 0, dropped: 0 });
    const { r, res } = fakeRes();
    expect(a.route()('/api/away', { method: 'GET', url: '/api/away' } as never, res as never)).toBe(true);
    const got = JSON.parse(r.body) as { discord: string; notes: unknown[] };
    expect(got.discord).toMatch(/^discord: on, webhook set \(id \.\.\.5678, BEDROCKBOT_DISCORD_WEBHOOK\); 3 sent, 0 failed, 0 dropped, 0 waiting; last sent \(204\)/);
    expect(r.body).not.toContain(TOKEN);
    expect(JSON.stringify(a.state())).not.toContain(TOKEN);
    box.dispose();
    a.stop();
  });

  it('the token in no log line, state, settings view, !set, !notify reply or /api/away; !set notifyDiscord says when no URL is set', async () => {
    fake = await fakeWebhook();
    const dir = mkdtempSync(join(tmpdir(), 'n1-panel-'));
    const log = capture();
    try {
      const src = webhookSource({ env: {}, configDir: dir });
      const { conn } = setup();
      const metrics = new Metrics();
      metrics.attach(conn);
      const chat = new Chat(conn, { owners: parseOwners(['Steve']), log: silent });
      const runtime = new RuntimeSettings();
      registerSettingsCommands({ chat, settings: runtime } as unknown as CommandDeps);
      const sink = new DiscordSink({ webhook: () => src.get(), reload: () => src.reload(), on: () => runtime.get('notifyDiscord') === true, bot: () => 'UnitBot', log, origin: `http://127.0.0.1:${fake.port}` });
      const bus = new EventBus();
      const task = { name: 'afk', start() {}, stop() {}, status: () => ({}), position: () => ({ x: 1, y: -60, z: 2 }) };
      const deps: PanelDeps = {
        settings: { healthPort: 9999, panel: { host: '127.0.0.1', port: undefined, token: undefined }, server: 's', task: 'afk' },
        conn,
        metrics,
        chat,
        built: { ctx: { clock: () => ({}) }, mobility: undefined } as unknown as PanelDeps['built'],
        runningTask: task,
        runtime,
        log,
        icons: null,
        events: bus,
        discord: sink,
      };
      panel = setupPanel(deps);
      const said: string[] = [];
      const run = (text: string) => said.push(...panel!.run(text).replies);
      const later = () => panel!.state().chat.map((c) => c.text); // replies said after the command returned (the test's POST)
      run('!set notifyDiscord on');
      expect(said.at(-1)).toMatch(/^notifyDiscord: no webhook URL is set, so nothing is sent: put it in env BEDROCKBOT_DISCORD_WEBHOOK or discord-webhook\.url in the config directory, never in chat/);
      run('!notify');
      expect(said.at(-1)).toBe('discord: on, webhook not set: nothing is sent (docs/away.md "Discord")');
      writeFileSync(join(dir, DISCORD_FILE), `${URL_OK}\n`);
      run('!set notifyDiscord');
      expect(said.at(-1)).toBe(`notifyDiscord: webhook set (id ...5678, ${DISCORD_FILE}); !notify test sends one`);
      run('!notify test');
      await vi.waitFor(() => expect(later()).toContain('discord: sent (204)'), { timeout: 5000 });
      expect(later()).toContain('panel: off (!set notify on)');
      expect(fake.posts).toHaveLength(1);
      expect((fake.posts[0]!.body as { embeds: { title: string }[] }).embeds[0]!.title).toBe('test notification');
      bus.emit('life.died', { n: 1, cause: 'x', at });
      await vi.waitFor(() => expect(fake!.posts).toHaveLength(2), { timeout: 5000 });
      fake.answer = () => ({ status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' });
      run('!notify test');
      await vi.waitFor(() => expect(later().at(-1)).toBe('discord: 404 the webhook is invalid or was deleted'), { timeout: 5000 });
      run('!notify');
      run('!set');
      run('!set notifyDiscord');
      const state = panel.state();
      const outputs = [...said, ...later(), ...log.lines, JSON.stringify(state), JSON.stringify(liteState(state)), JSON.stringify(sink.stats), sink.statusLine()];
      for (const o of outputs) {
        expect(o).not.toContain(TOKEN);
        expect(o).not.toContain(URL_OK);
      }
      expect(JSON.stringify(state.settings.find((x) => x.key === 'notifyDiscord'))).toMatch(/"value":"on"/);
      expect(said.some((l) => l.startsWith('discord: on, webhook set (id ...5678, discord-webhook.url); 2 sent, 1 failed'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const silent: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function fakeRes() {
  const r = { status: 0, body: '' };
  return { r, res: { writeHead: (s: number) => (r.status = s), end: (b?: string) => (r.body = b ?? '') } };
}
