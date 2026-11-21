// Notes to Discord through the owner's own webhook (Track N1, ADR 0116 addendum, docs/away.md "Discord").
//
//   const hook = loadWebhook({ env: process.env, configDir });     // env BEDROCKBOT_DISCORD_WEBHOOK, else the file
//   const sink = new DiscordSink({ webhook: () => hook, on: () => runtime.get('notifyDiscord') === true, log });
//   sink.send(note, ask);                                          // every note the panel's NoteLimiter lets through
//   await sink.test();                                             // `!notify test`: `discord: sent (204)`
//
// The webhook URL is a secret: anyone holding it can post to the channel. So:
// - it is read only from the environment or from one file in the config directory, never from chat or a setting;
// - only `https://<discord host>/api/webhooks/<id>/<token>` is accepted (parseWebhook), so the bot never posts anywhere
//   else; the refusal never repeats the value;
// - it is never printed: status lines show `set (id ...1234)` (the last 4 of the id, which is not the secret), and every
//   line this module logs or returns goes through scrub().
//
// Limits on top of the note limiter's (at most 5 notes in 10 min, questions every 10 s):
// - one request at a time, a timeout on each (REQUEST_TIMEOUT_MS);
// - a 429 is honoured: nothing is sent until its `retry_after` (or the Retry-After header) has passed, and the note
//   goes back to the head of the queue, at most MAX_TRIES times; a bucket at 0 (X-RateLimit-Remaining) waits for
//   X-RateLimit-Reset-After before the next request;
// - the queue holds QUEUE_MAX notes; beyond it the oldest is dropped and counted;
// - a 5xx or a network error is retried once after RETRY_MS, then the note is dropped (no retry storm);
// - 401, 403 and 404 (a wrong token, a deleted webhook) stop the sink until the URL changes or `!notify test`;
// - failures are logged at most once per FAIL_LOG_MS; nothing is ever thrown into the bot.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../log.ts';
import type { AskView } from '../../tasks/ask.ts';
import { durationText } from '../../events/registry.ts';
import type { Note } from '../panel/notes.ts';

export const DISCORD_ENV = 'BEDROCKBOT_DISCORD_WEBHOOK';
export const DISCORD_FILE = 'discord-webhook.url';
/** Tests only: send to `http://127.0.0.1:<port>` (or localhost) instead of Discord's host; anything else is refused. */
export const DISCORD_TEST_ORIGIN_ENV = 'BEDROCKBOT_DISCORD_TEST_ORIGIN';
/** The hosts Discord serves webhooks on (the stable, canary and PTB clients, the old domain). */
export const DISCORD_HOSTS: readonly string[] = ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com', 'canary.discordapp.com', 'ptb.discordapp.com'];
/** Discord's message limits (characters): content, embed title, description, footer, field name and value, an embed's total, the username. */
export const DISCORD_LIMITS = { content: 2000, title: 256, description: 4096, footer: 2048, fieldName: 256, fieldValue: 1024, embedTotal: 6000, username: 80 } as const;
export const REQUEST_TIMEOUT_MS = 10_000;
export const QUEUE_MAX = 10;
export const MAX_TRIES = 3;
export const RETRY_MS = 30_000;
/** A 429's wait at most (a longer one drops the queue instead of holding notes for hours). */
export const MAX_WAIT_MS = 10 * 60_000;
export const FAIL_LOG_MS = 10 * 60_000;
/** The colour bar: alerts red, questions amber, a test grey. */
const COLOUR = { alert: 0xd9534f, ask: 0xf0ad4e, test: 0x888888 } as const;

export interface Webhook {
  /** The URL, normalised (never printed). */
  url: string;
  id: string;
  source: 'env' | 'file';
}

export type WebhookState = { state: 'set'; hook: Webhook } | { state: 'unset' } | { state: 'refused'; source: 'env' | 'file'; why: string };

const PATH_RE = /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{1,25})\/([A-Za-z0-9_-]{1,128})\/?$/;

/** The shape check: a Discord webhook URL or a reason (which never repeats the value). */
export function parseWebhook(raw: string, source: 'env' | 'file' = 'env'): { ok: true; hook: Webhook } | { ok: false; why: string } {
  const s = raw.trim();
  if (!s) return { ok: false, why: 'empty' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, why: 'not a URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, why: 'not https' };
  if (!DISCORD_HOSTS.includes(u.hostname.toLowerCase())) return { ok: false, why: `the host is not one of ${DISCORD_HOSTS.join(', ')}` };
  if (u.port !== '' || u.username !== '' || u.password !== '') return { ok: false, why: 'a port or a user in the URL' };
  if (u.search !== '' || u.hash !== '') return { ok: false, why: 'a query or a fragment in the URL' };
  const m = PATH_RE.exec(u.pathname);
  if (!m) return { ok: false, why: 'the path is not /api/webhooks/<id>/<token>' };
  return { ok: true, hook: { url: `https://${u.hostname.toLowerCase()}/api/webhooks/${m[1]}/${m[2]}`, id: m[1]!, source } };
}

export interface LoadOptions {
  env: NodeJS.ProcessEnv;
  /** The config directory (where config.json is); undefined: the file is not looked for. */
  configDir: string | undefined;
  read?: (file: string) => string | undefined;
}

const readText = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

/** The environment wins over the file; a refused value is reported, never used. */
export function loadWebhook(o: LoadOptions): WebhookState {
  const read = o.read ?? readText;
  const env = o.env[DISCORD_ENV];
  let raw: string | undefined;
  let source: 'env' | 'file' = 'env';
  if (env !== undefined && env.trim() !== '') raw = env;
  else if (o.configDir) {
    try {
      raw = read(join(o.configDir, DISCORD_FILE));
    } catch {
      return { state: 'refused', source: 'file', why: `${DISCORD_FILE} cannot be read` };
    }
    source = 'file';
    // the first line that is not blank or a # comment
    if (raw !== undefined) raw = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? '';
  }
  if (raw === undefined) return { state: 'unset' };
  const p = parseWebhook(raw, source);
  return p.ok ? { state: 'set', hook: p.hook } : { state: 'refused', source, why: p.why };
}

/** The webhook as loaded at start, read again on `!notify` (the owner may put the file in place while the bot runs). */
export function webhookSource(o: LoadOptions): { get(): WebhookState; reload(): WebhookState } {
  let cur = loadWebhook(o);
  return {
    get: () => cur,
    reload: () => (cur = loadWebhook(o)),
  };
}

/** `set (id ...1234, env)`, `not set`, `refused (file: not https)`: what any output may say about the webhook. */
export function webhookText(w: WebhookState): string {
  if (w.state === 'unset') return 'not set';
  if (w.state === 'refused') return `refused (${w.source === 'env' ? DISCORD_ENV : DISCORD_FILE}: ${w.why})`;
  return `set (id ...${w.hook.id.slice(-4)}, ${w.hook.source === 'env' ? DISCORD_ENV : DISCORD_FILE})`;
}

/** Hide any webhook URL or token in a text (every line this module logs or returns passes here). */
export function scrub(text: string, hook?: Webhook): string {
  let s = text.replace(/(webhooks\/\d+\/)[A-Za-z0-9_.-]+/gi, '$1***');
  if (hook) {
    const token = hook.url.slice(hook.url.lastIndexOf('/') + 1);
    if (token.length >= 4) s = s.split(token).join('***');
  }
  return s;
}

/** The loopback origin a test may send to instead of Discord's host; undefined (Discord) for anything else. */
export function testOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.pathname === '/' && !u.search) return u.origin;
  } catch {
    // refused below
  }
  return undefined;
}

/** Cut to `n` characters (UTF-16 units: never more than Discord counts), on a code point. */
export function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = n - 3;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--; // never split a surrogate pair
  return `${s.slice(0, end)}...`;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  timestamp: string;
  footer: { text: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface DiscordPayload {
  content: string;
  embeds: DiscordEmbed[];
  /** No @everyone, @here, user or role ping from any text the bot sends. */
  allowed_mentions: { parse: [] };
}

const embedSize = (e: DiscordEmbed): number => e.title.length + e.description.length + e.footer.text.length + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

/** The message a note becomes: a short content line (what a phone's push shows) and one embed. */
export function payloadFor(note: Pick<Note, 'title' | 'body' | 'ts' | 'ask' | 'kind' | 'n'>, o: { bot?: string; ask?: AskView; now?: number; test?: boolean; buttons?: boolean } = {}): DiscordPayload {
  const who = o.bot ? `${o.bot}: ` : '';
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (o.ask) {
    const left = Math.max(0, (o.ask.until - (o.now ?? Date.now())) / 1000);
    fields.push({ name: 'Choices', value: cut(o.ask.choices.map((c) => `${c.n} ${c.id}${c.label && c.label !== c.id ? ` (${c.label})` : ''}`).join(', '), DISCORD_LIMITS.fieldValue) });
    fields.push({ name: 'Unanswered', value: cut(`in ${durationText(left)}: ${o.ask.default} (the default)`, DISCORD_LIMITS.fieldValue) });
    // Track D1: the Discord bot's message carries the choices as buttons (an allowed user's press answers)
    const how = o.buttons ? `A button below (users on discordUsers only), or !answer ${o.ask.id} <choice> to the bot here, in the game or the panel's Away view.` : `Discord cannot carry an answer back. In the game: !answer ${o.ask.id} <choice>; or a choice's button in the panel's Away view.`;
    fields.push({ name: 'How to answer', value: cut(how, DISCORD_LIMITS.fieldValue) });
  } else if (note.ask !== null) {
    fields.push({ name: 'How to answer', value: `Discord cannot carry an answer back. In the game: !answer ${note.ask} <choice>; or the panel's Away view.` });
  }
  const embed: DiscordEmbed = {
    title: cut(note.title, DISCORD_LIMITS.title),
    description: cut(note.body, DISCORD_LIMITS.description),
    color: o.test ? COLOUR.test : note.ask !== null ? COLOUR.ask : COLOUR.alert,
    timestamp: new Date(note.ts).toISOString(),
    footer: { text: cut(`${o.bot ? `${o.bot} · ` : ''}${note.kind}${note.n > 1 ? ` · ${note.n} folded` : ''}`, DISCORD_LIMITS.footer) },
    ...(fields.length ? { fields } : {}),
  };
  if (embedSize(embed) > DISCORD_LIMITS.embedTotal) embed.description = cut(embed.description, Math.max(16, embed.description.length - (embedSize(embed) - DISCORD_LIMITS.embedTotal)));
  // no `username`: the name the owner gave the webhook shows (Discord refuses some names with a 400)
  return { content: cut(`${who}${note.title}`, DISCORD_LIMITS.content), embeds: [embed], allowed_mentions: { parse: [] } };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface DiscordSinkOptions {
  /** The webhook now (webhookSource().get). */
  webhook: () => WebhookState;
  /** Read it again (webhookSource().reload; `!notify` calls it). */
  reload?: () => WebhookState;
  /** The `notifyDiscord` setting. */
  on: () => boolean;
  /** The bot's name for the message (optional). */
  bot?: () => string | undefined;
  log?: Logger;
  fetch?: FetchLike;
  now?: () => number;
  /** Tests: the loopback origin (testOrigin) to send to instead of Discord's host. */
  origin?: string;
  timeoutMs?: number;
  queueMax?: number;
  retryMs?: number;
}

interface Item {
  payload: DiscordPayload;
  tries: number;
}

export interface DiscordStats {
  sent: number;
  failed: number;
  dropped: number;
  rateLimited: number;
  waiting: number;
  /** The last outcome (`sent (204)`, `429: waiting 2 s`), scrubbed. */
  last: string | null;
  lastAt: number | null;
  /** Set when a 401, 403 or 404 stopped it (until the URL changes or a test). */
  stopped: string | null;
}

type Outcome = { kind: 'ok'; status: number } | { kind: 'limited'; status: 429; waitMs: number } | { kind: 'dead'; status: number; why: string } | { kind: 'bad'; status: number; why: string } | { kind: 'retry'; status: number | null; why: string };

export class DiscordSink {
  private readonly o: DiscordSinkOptions;
  private readonly queue: Item[] = [];
  private busy = false;
  private until = 0;
  private timer: NodeJS.Timeout | undefined;
  private stoppedFor: string | undefined; // the URL a dead answer was for (a new token or webhook sends again; never printed)
  private lastFailLog = -Infinity;
  private closed = false;
  private readonly inflight = new Set<AbortController>();
  readonly stats: DiscordStats = { sent: 0, failed: 0, dropped: 0, rateLimited: 0, waiting: 0, last: null, lastAt: null, stopped: null };

  constructor(o: DiscordSinkOptions) {
    this.o = o;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private hook(): Webhook | undefined {
    try {
      const w = this.o.webhook();
      return w.state === 'set' ? w.hook : undefined;
    } catch {
      return undefined;
    }
  }

  private isOn(): boolean {
    try {
      return this.o.on() === true;
    } catch {
      return false;
    }
  }

  /** Whether a note would be sent now (on and a URL set). */
  active(): boolean {
    return this.isOn() && this.hook() !== undefined;
  }

  /** A note the limiter let through. Never throws. */
  send(note: Note, ask?: AskView): void {
    try {
      if (this.closed || !this.isOn()) return;
      const h = this.hook();
      if (!h) return;
      if (this.stats.stopped && this.stoppedFor === h.url) {
        this.stats.dropped++;
        return;
      }
      this.queue.push({ payload: payloadFor(note, { ...(this.bot() ? { bot: this.bot()! } : {}), ...(ask ? { ask } : {}), now: this.now() }), tries: 0 });
      while (this.queue.length > (this.o.queueMax ?? QUEUE_MAX)) {
        this.queue.shift();
        this.stats.dropped++;
        this.failLog(`discord: the queue is full: dropped the oldest note (${this.stats.dropped} dropped in all)`);
      }
      this.stats.waiting = this.queue.length;
      this.pump();
    } catch (e) {
      this.failLog(`discord: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private bot(): string | undefined {
    try {
      const b = this.o.bot?.();
      return b === '' ? undefined : b;
    } catch {
      return undefined;
    }
  }

  private schedule(ms: number): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, Math.max(0, ms));
    this.timer.unref?.();
  }

  private pump(): void {
    if (this.busy || this.closed || !this.queue.length) return;
    const wait = this.until - this.now();
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    const h = this.hook();
    if (!h || !this.isOn()) {
      this.stats.dropped += this.queue.length;
      this.queue.length = 0;
      this.stats.waiting = 0;
      return;
    }
    const item = this.queue.shift()!;
    this.stats.waiting = this.queue.length;
    this.busy = true;
    item.tries++;
    void this.post(h, item.payload).then((r) => {
      this.busy = false;
      this.settle(h, item, r);
      this.pump();
    });
  }

  /** The counters and the last outcome (no queue change). */
  private record(h: Webhook, r: Outcome): void {
    this.stats.lastAt = this.now();
    switch (r.kind) {
      case 'ok':
        this.stats.sent++;
        this.stats.last = `sent (${r.status})`;
        this.stats.stopped = null;
        this.stoppedFor = undefined;
        return;
      case 'limited':
        this.stats.rateLimited++;
        this.stats.last = `429: waiting ${durationText(r.waitMs / 1000)}`;
        return;
      case 'dead':
        this.stats.failed++;
        this.stats.last = `${r.status} ${r.why}`;
        this.stats.stopped = `${r.status} ${r.why}`;
        this.stoppedFor = h.url;
        return;
      case 'bad':
        this.stats.failed++;
        this.stats.last = `${r.status} ${r.why}`;
        return;
      case 'retry':
        this.stats.last = `${r.status ?? 'no answer'}: ${r.why}`;
    }
  }

  private settle(h: Webhook, item: Item, r: Outcome): void {
    const now = this.now();
    this.record(h, r);
    switch (r.kind) {
      case 'ok':
        return;
      case 'limited':
        if (r.waitMs > MAX_WAIT_MS) {
          this.until = now + MAX_WAIT_MS;
          this.stats.dropped += this.queue.length + 1;
          this.queue.length = 0;
          this.failLog(`discord: rate-limited for ${durationText(r.waitMs / 1000)}: dropped the waiting notes`);
        } else if (item.tries < MAX_TRIES) this.queue.unshift(item);
        else {
          this.stats.dropped++;
          this.failLog(`discord: rate-limited ${item.tries} times: dropped a note`);
        }
        this.stats.waiting = this.queue.length;
        return;
      case 'dead':
        this.stats.dropped += this.queue.length;
        this.queue.length = 0;
        this.stats.waiting = 0;
        this.o.log?.warn(`discord: ${r.status} ${r.why}: not sending until the URL changes or !notify test`);
        return;
      case 'bad':
        this.failLog(`discord: ${r.status} ${r.why}: dropped a note`);
        return;
      case 'retry':
        if (item.tries < 2) {
          this.queue.unshift(item);
          this.until = Math.max(this.until, now + (this.o.retryMs ?? RETRY_MS));
        } else {
          this.stats.failed++;
          this.failLog(`discord: ${r.status ?? 'no answer'} ${r.why} (twice): dropped a note`);
        }
        this.stats.waiting = this.queue.length;
    }
  }

  /** One POST; every outcome is a value (never a throw). Honours a 0 bucket's reset for the next request. */
  private async post(h: Webhook, payload: DiscordPayload): Promise<Outcome> {
    const f: FetchLike = this.o.fetch ?? ((url, init) => fetch(url, init));
    const url = this.o.origin ? `${this.o.origin}${h.url.slice(h.url.indexOf('/api/'))}` : h.url;
    const ac = new AbortController();
    this.inflight.add(ac);
    const t = setTimeout(() => ac.abort(), this.o.timeoutMs ?? REQUEST_TIMEOUT_MS);
    t.unref?.();
    try {
      const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'BedrockBot (notes)' }, body: JSON.stringify(payload), signal: ac.signal });
      const text = await res.text().catch(() => '');
      const remaining = res.headers.get('x-ratelimit-remaining');
      const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
      if (remaining === '0' && Number.isFinite(resetAfter) && resetAfter > 0) this.until = Math.max(this.until, this.now() + Math.min(resetAfter * 1000, MAX_WAIT_MS));
      const s = res.status;
      if (s >= 200 && s < 300) return { kind: 'ok', status: s };
      if (s === 429) {
        let after = NaN;
        try {
          after = Number((JSON.parse(text) as { retry_after?: unknown }).retry_after);
        } catch {
          // the header below
        }
        if (!Number.isFinite(after)) after = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(after) && after >= 0 ? Math.ceil(after * 1000) : 5000;
        this.until = Math.max(this.until, this.now() + Math.min(waitMs, MAX_WAIT_MS));
        return { kind: 'limited', status: 429, waitMs };
      }
      if (s === 401 || s === 403 || s === 404) return { kind: 'dead', status: s, why: 'the webhook is invalid or was deleted' };
      if (s >= 500) return { kind: 'retry', status: s, why: 'Discord failed' };
      return { kind: 'bad', status: s, why: `refused (${scrub(text, h).replace(/\s+/g, ' ').slice(0, 120)})` };
    } catch (e) {
      const aborted = ac.signal.aborted;
      const msg = aborted ? `no answer in ${durationText((this.o.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000)}` : scrub(e instanceof Error ? `${e.message}${e.cause instanceof Error ? `: ${e.cause.message}` : ''}` : String(e), h);
      return { kind: 'retry', status: null, why: msg };
    } finally {
      clearTimeout(t);
      this.inflight.delete(ac);
    }
  }

  private failLog(line: string): void {
    const now = this.now();
    if (now - this.lastFailLog < FAIL_LOG_MS) return;
    this.lastFailLog = now;
    this.o.log?.warn(scrub(line, this.hook()));
  }

  /** `!notify test`: one message now (not queued), the outcome as a line without the URL. */
  async test(note: Pick<Note, 'title' | 'body' | 'ts' | 'kind'>): Promise<string> {
    let w: WebhookState;
    try {
      w = this.o.webhook();
    } catch {
      w = { state: 'unset' };
    }
    if (w.state === 'unset') return `discord: not set (${DISCORD_ENV} or ${DISCORD_FILE} in the config directory; docs/away.md "Discord")`;
    if (w.state === 'refused') return `discord: ${webhookText(w)}`;
    if (!this.isOn()) return 'discord: off (!set notifyDiscord on)';
    const wait = this.until - this.now();
    if (wait > 0) return `discord: rate-limited for ${durationText(wait / 1000)} more`;
    const h = w.hook;
    const r = await this.post(h, payloadFor({ ...note, ask: null, n: 1 }, { ...(this.bot() ? { bot: this.bot()! } : {}), test: true })); // a test also tries a stopped webhook
    this.record(h, r);
    this.pump();
    switch (r.kind) {
      case 'ok':
        return `discord: sent (${r.status})`;
      case 'limited':
        return `discord: 429 rate-limited: wait ${durationText(r.waitMs / 1000)}`;
      case 'dead':
      case 'bad':
        return scrub(`discord: ${r.status} ${r.why}`, h);
      case 'retry':
        return scrub(`discord: ${r.status ?? 'failed'}: ${r.why}`, h);
    }
  }

  /** The webhook's state (for the masked text: webhookText). */
  webhookState(): WebhookState {
    try {
      return this.o.webhook();
    } catch {
      return { state: 'unset' };
    }
  }

  /** Read the webhook again (the env, else the file); never throws. */
  reload(): void {
    try {
      this.o.reload?.();
    } catch {
      // the old value stays
    }
  }

  /** One line for `!notify` and the panel: whether on, the webhook (masked), the counts. */
  statusLine(): string {
    let w: WebhookState;
    try {
      w = this.o.webhook();
    } catch {
      w = { state: 'unset' };
    }
    const s = this.stats;
    const on = this.isOn();
    const head = `discord: ${on ? 'on' : 'off'}, webhook ${webhookText(w)}`;
    if (on && w.state !== 'set') return `${head}: nothing is sent (docs/away.md "Discord")`;
    const counts = `; ${s.sent} sent, ${s.failed} failed, ${s.dropped} dropped, ${s.waiting} waiting`;
    const last = s.last && s.lastAt !== null ? `; last ${s.last} ${durationText((this.now() - s.lastAt) / 1000)} ago` : '';
    const stopped = s.stopped ? `; stopped: ${s.stopped} (!notify test tries again)` : '';
    return `${head}${counts}${last}${stopped}`;
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const ac of this.inflight) ac.abort();
    this.queue.length = 0;
  }
}
