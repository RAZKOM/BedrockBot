// The Discord REST API for the bot (Track D1, ADR 0118, docs/discord.md "Limits"): outbound https only, with
// Discord's rate limits honoured and the bot's own on top, so the Minecraft bot is never slowed or thrown into.
//
//   const rest = new DiscordRest({ token: () => tokens.get(), log });
//   const r = await rest.call('POST', '/channels/123/messages', { content: 'hi', allowed_mentions: { parse: [] } });
//   if (r.ok) r.body ... else r.status, r.why            // never a throw; `why` never holds the token
//
// Rules:
// - one request at a time per route (`POST /channels/<id>/messages`: the major id stays, the others become `:id`), each
//   with its own timeout (REQUEST_TIMEOUT_MS; an interaction's answer CALLBACK_TIMEOUT_MS, Discord wants it in 3 s);
// - the buckets Discord names (X-RateLimit-Bucket) are kept: at 0 remaining a route waits for X-RateLimit-Reset-After;
// - a 429 waits its `retry_after` (a global one holds every route) and is tried again, at most MAX_TRIES in all; a wait
//   over MAX_WAIT_MS fails the request instead;
// - at most GLOBAL_PER_S requests a second in all (Discord allows 50; the bot needs a few);
// - a 401 (the token refused) stops every request until the token changes: a refused token is never sent again and again
//   (Discord blocks an address after many 401, 403 and 429 answers);
// - a 5xx or no answer is tried once more after RETRY_MS, never for an interaction's answer (its 3 s are gone);
// - at most QUEUE_MAX requests wait per route; the oldest is failed (`queue full`);
// - the origin is Discord's (`https://discord.com/api/v10`); tests pass a loopback origin (testOrigin).
import type { Logger } from '../../log.ts';
import { scrubToken, type TokenState } from './discord-access.ts';

export const API_BASE = 'https://discord.com/api/v10';
export const REQUEST_TIMEOUT_MS = 10_000;
export const CALLBACK_TIMEOUT_MS = 2_500;
export const MAX_TRIES = 3;
export const MAX_WAIT_MS = 60_000;
export const RETRY_MS = 2_000;
export const GLOBAL_PER_S = 10;
export const QUEUE_MAX = 20;
/** Sent with every request (Discord asks bots for `DiscordBot (<url>, <version>)`; the project names no URL of its own). */
export const USER_AGENT = 'DiscordBot (bedrockbot, 1.0)';

export type RestResult = { ok: true; status: number; body: unknown } | { ok: false; status: number | null; why: string };

export type RestFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface RestOptions {
  token: () => TokenState;
  /** Tests: `http://127.0.0.1:<port>` (the path `/api/v10/...` is kept). */
  origin?: string | undefined;
  fetch?: RestFetch;
  now?: () => number;
  log?: Logger;
  timeoutMs?: number;
  retryMs?: number;
}

export interface CallOptions {
  /** Without the bot's Authorization header (an interaction's answer is authorised by its own token in the path). */
  noAuth?: boolean;
  /** The answer to a button press: short timeout, no retry. */
  callback?: boolean;
}

interface Job {
  method: string;
  path: string;
  body: unknown;
  o: CallOptions;
  tries: number;
  resolve: (r: RestResult) => void;
}

/** The rate-limit route of a path: the first id (the channel, the guild) stays, every later id is `:id`. */
export function routeKey(method: string, path: string): string {
  let first = true;
  const p = path.split('?')[0]!.replace(/\/(\d{5,25}|[A-Za-z0-9_.-]{40,})(?=\/|$)/g, (m, id: string) => {
    if (first && /^\d+$/.test(id) && !path.startsWith('/interactions/')) {
      first = false;
      return m;
    }
    return '/:id';
  });
  return `${method} ${p}`;
}

export class DiscordRest {
  private readonly o: RestOptions;
  private readonly queues = new Map<string, Job[]>();
  private readonly busy = new Set<string>();
  private readonly routeBucket = new Map<string, string>();
  private readonly buckets = new Map<string, { remaining: number; resetAt: number }>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private globalUntil = 0;
  private sentAt: number[] = [];
  private deadFor: string | undefined; // the token a 401 was for (never printed)
  private closed = false;
  private readonly inflight = new Set<AbortController>();
  readonly stats = { sent: 0, failed: 0, limited: 0, dropped: 0, unauthorised: 0 };

  constructor(o: RestOptions) {
    this.o = o;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private token(): string | undefined {
    try {
      const t = this.o.token();
      return t.state === 'set' ? t.token : undefined;
    } catch {
      return undefined;
    }
  }

  /** A 401 stopped requests (until the token changes). */
  stopped(): boolean {
    const t = this.token();
    return t !== undefined && this.deadFor === t;
  }

  /** One request through the route's queue. Never throws. */
  call(method: string, path: string, body?: unknown, o: CallOptions = {}): Promise<RestResult> {
    return new Promise<RestResult>((resolve) => {
      if (this.closed) return resolve({ ok: false, status: null, why: 'stopped' });
      const key = routeKey(method, path);
      const q = this.queues.get(key) ?? [];
      q.push({ method, path, body, o, tries: 0, resolve });
      while (q.length > QUEUE_MAX) {
        this.stats.dropped++;
        q.shift()!.resolve({ ok: false, status: null, why: 'queue full' });
      }
      this.queues.set(key, q);
      this.pump(key);
    });
  }

  private wait(key: string, ms: number): void {
    if (this.timers.has(key) || this.closed) return;
    const t = setTimeout(() => {
      this.timers.delete(key);
      this.pump(key);
    }, Math.max(1, ms));
    t.unref?.();
    this.timers.set(key, t);
  }

  private pump(key: string): void {
    if (this.closed || this.busy.has(key)) return;
    const q = this.queues.get(key);
    if (!q?.length) return;
    const now = this.now();
    const b = this.routeBucket.get(key);
    const bucket = b ? this.buckets.get(b) : undefined;
    this.sentAt = this.sentAt.filter((t) => now - t < 1000);
    const waits = [this.globalUntil - now, bucket && bucket.remaining <= 0 ? bucket.resetAt - now : 0, this.sentAt.length >= GLOBAL_PER_S ? 1000 - (now - this.sentAt[0]!) : 0];
    const w = Math.max(...waits);
    if (w > 0) {
      // an interaction's answer cannot wait past its 3 s
      const head = q[0]!;
      if (head.o.callback && w > CALLBACK_TIMEOUT_MS) {
        q.shift();
        this.stats.failed++;
        head.resolve({ ok: false, status: 429, why: 'rate-limited past the 3 s an answer to a press has' });
        this.pump(key);
        return;
      }
      this.wait(key, w);
      return;
    }
    const job = q.shift()!;
    this.busy.add(key);
    this.sentAt.push(now);
    if (bucket && bucket.remaining > 0) bucket.remaining--;
    job.tries++;
    void this.send(key, job).then((r) => {
      this.busy.delete(key);
      if (r === 'again') q.unshift(job);
      else job.resolve(r);
      this.pump(key);
    });
  }

  /** One HTTP request; every outcome a value. `again`: the job goes back to the head of its queue. */
  private async send(key: string, job: Job): Promise<RestResult | 'again'> {
    const token = this.token();
    if (!job.o.noAuth && !token) return { ok: false, status: null, why: 'no token' };
    if (!job.o.noAuth && this.deadFor !== undefined && this.deadFor === token) return { ok: false, status: 401, why: 'the token was refused (401): nothing is sent until it changes' };
    const f: RestFetch = this.o.fetch ?? ((url, init) => fetch(url, init));
    const url = `${this.o.origin ? `${this.o.origin}/api/v10` : API_BASE}${job.path}`;
    const ac = new AbortController();
    this.inflight.add(ac);
    const ms = job.o.callback ? CALLBACK_TIMEOUT_MS : (this.o.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const t = setTimeout(() => ac.abort(), ms);
    t.unref?.();
    const headers: Record<string, string> = { 'user-agent': USER_AGENT };
    if (!job.o.noAuth && token) headers.authorization = `Bot ${token}`;
    if (job.body !== undefined) headers['content-type'] = 'application/json';
    try {
      const res = await f(url, { method: job.method, headers, ...(job.body !== undefined ? { body: JSON.stringify(job.body) } : {}), signal: ac.signal });
      const text = await res.text().catch(() => '');
      this.learn(key, res.headers);
      const s = res.status;
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (s >= 200 && s < 300) {
        this.stats.sent++;
        return { ok: true, status: s, body };
      }
      if (s === 429) {
        this.stats.limited++;
        const b = body as { retry_after?: unknown; global?: unknown } | undefined;
        let after = Number(b?.retry_after);
        if (!Number.isFinite(after)) after = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(after) && after >= 0 ? Math.ceil(after * 1000) : 5000;
        const global = b?.global === true || res.headers.get('x-ratelimit-global') === 'true';
        if (global) this.globalUntil = Math.max(this.globalUntil, this.now() + Math.min(waitMs, MAX_WAIT_MS));
        else {
          const bk = this.routeBucket.get(key) ?? key;
          this.buckets.set(bk, { remaining: 0, resetAt: this.now() + Math.min(waitMs, MAX_WAIT_MS) });
          this.routeBucket.set(key, bk);
        }
        if (waitMs > MAX_WAIT_MS || job.tries >= MAX_TRIES || job.o.callback) {
          this.stats.failed++;
          return { ok: false, status: 429, why: `rate-limited (${Math.ceil(waitMs / 1000)} s)` };
        }
        return 'again';
      }
      if (s === 401 && !job.o.noAuth) {
        this.stats.unauthorised++;
        this.stats.failed++;
        this.deadFor = token;
        this.o.log?.warn('discord bot: the token was refused (401): nothing is sent until it changes (docs/discord.md)');
        return { ok: false, status: 401, why: 'the token was refused' };
      }
      if (s >= 500 && !job.o.callback && job.tries < 2) {
        await this.sleep(this.o.retryMs ?? RETRY_MS);
        return 'again';
      }
      this.stats.failed++;
      const msg = (body as { message?: unknown } | undefined)?.message;
      return { ok: false, status: s, why: scrubToken(typeof msg === 'string' ? msg : `HTTP ${s}`, token).slice(0, 160) };
    } catch (e) {
      if (!job.o.callback && job.tries < 2 && !this.closed) {
        await this.sleep(this.o.retryMs ?? RETRY_MS);
        return 'again';
      }
      this.stats.failed++;
      const why = ac.signal.aborted ? `no answer in ${Math.round(ms / 100) / 10} s` : scrubToken(e instanceof Error ? `${e.message}${e.cause instanceof Error ? `: ${e.cause.message}` : ''}` : String(e), token);
      return { ok: false, status: null, why: why.slice(0, 160) };
    } finally {
      clearTimeout(t);
      this.inflight.delete(ac);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
  }

  /** The bucket headers of an answer. */
  private learn(key: string, h: { get(name: string): string | null }): void {
    const bucket = h.get('x-ratelimit-bucket');
    const remaining = Number(h.get('x-ratelimit-remaining'));
    const after = Number(h.get('x-ratelimit-reset-after'));
    if (!bucket && !Number.isFinite(remaining)) return;
    const bk = bucket ?? key;
    this.routeBucket.set(key, bk);
    if (Number.isFinite(remaining) && h.get('x-ratelimit-remaining') !== null) this.buckets.set(bk, { remaining, resetAt: this.now() + (Number.isFinite(after) ? Math.min(after * 1000, MAX_WAIT_MS) : 1000) });
  }

  /** Waiting requests in all. */
  waiting(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  stop(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const ac of this.inflight) ac.abort();
    for (const q of this.queues.values()) for (const j of q.splice(0)) j.resolve({ ok: false, status: null, why: 'stopped' });
  }
}
