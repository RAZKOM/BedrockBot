// Web panel step 5 (Track P5, ADR 0116, docs/away.md, docs/panel.md "Away view"): away mode's server side.
//
//   state `away`            in the lite state (so a polling page and a hidden tab see it too): the notify switch, the
//                           mark (the newest notable event: the Away view fetches its timeline again when it moves),
//                           the newest notes and every open question with its choices and deadline
//   GET /api/timeline       the timeline of a window (events/timeline.ts): ?since=<ms> or ?hours=<h>, &group=job|hour,
//                           &tz=<minutes east of UTC>
//   GET /api/away           the same block with every kept note (NOTES_KEEP), the limiter's counters
//   GET /sw.js              a service worker of two listeners: phones (Chrome on Android) show a notification only
//                           through one; it is registered only on a secure origin (https, localhost)
//
// Notes come from the event bus: alerts and questions (notes.ts noteFor), with `notify` on, through the rate limit
// (NoteLimiter). Read-only: an answer is a chat command (`!answer 3 retry`) through POST /api/cmd, as every action.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventBus } from '../../events/bus.ts';
import { MAX_LIMIT } from '../../events/query.ts';
import type { BotEvent } from '../../events/registry.ts';
import { buildTimeline, type Timeline } from '../../events/timeline.ts';
import { MAX_SUMMARY_HOURS } from '../../events/summary.ts';
import type { Logger } from '../../log.ts';
import type { AskBox, AskCard, AskView } from '../../tasks/ask.ts';
import type { HealthRoute } from '../map/routes.ts';
import { NoteLimiter, noteFor, NOTES_KEEP, type Note } from './notes.ts';
import { AWAY_PATH, SW_PATH, TIMELINE_PATH, type AwayDiscord } from './shared.ts';
import type { DiscordSink } from '../notify/discord.ts'; // Track N1: the notes to Discord too

/** Notes the state carries (the newest). */
export const STATE_NOTES = 3;
/** The window of a timeline without `since` / `hours`. */
export const DEFAULT_HOURS = 8;

/** The `away` block of the panel state. */
export interface PanelAway {
  /** The bot's `notify` setting (notes are made only while it is on). */
  notify: boolean;
  /** The id of the newest notable or alert event, or queue / ask event (0: none this run). */
  mark: number;
  /** The newest notes, oldest first. */
  notes: Note[];
  /** The open questions, oldest first. */
  asks: AskView[];
}

export interface AwaySource {
  asks(): AskBox | undefined;
  notify(): boolean;
}

/** Track D1: another place notes go (the Discord bot, health/notify/discord-bot.ts); DiscordSink has the same shape. */
export interface NoteSink {
  /** Notes would be sent now (its switch on, its secret set). */
  active(): boolean;
  /** A note the limiter let through (a question with its view and, Track D2, its card words). Never throws. */
  send(note: Note, ask?: AskView, card?: AskCard): void;
  /** `!notify test`: one note now; the outcome as a line. */
  test(note: Pick<Note, 'title' | 'body' | 'ts' | 'kind'>): Promise<string>;
  /** One line for `!notify` and /api/away. */
  statusLine(): string;
  /** Track D3: the full status (`!discord`'s lines) for /api/away and the Away view; statusLine() when absent. */
  statusLines?(): string[];
}

export interface AwayLiveOptions {
  bus: Pick<EventBus, 'subscribe' | 'query'>;
  source: AwaySource;
  /** Something the pages should see soon (a note, a question): push the state. */
  changed?: () => void;
  /** Track N1 (docs/away.md "Discord"): every note the limiter lets through goes there too (with notifyDiscord on and a URL set). */
  discord?: DiscordSink;
  /** Track D1: more places every note goes (the Discord bot); they live and stop on their own. */
  sinks?: readonly NoteSink[];
  log?: Logger;
  now?: () => number;
}

/** The service worker the page registers on a secure origin: a notification shown through it, a tap opens the panel. */
export const SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => { e.notification.close(); e.waitUntil(self.clients.matchAll({ type: 'window' }).then((l) => (l.length ? l[0].focus() : self.clients.openWindow('/')))); });
`;

export class AwayLive {
  private readonly o: AwayLiveOptions;
  private readonly limiter = new NoteLimiter();
  private notes: Note[] = [];
  private mark = 0;
  private readonly off: () => void;
  private offAsks: (() => void) | undefined;
  private watched: AskBox | undefined;
  private readonly timer: NodeJS.Timeout;
  private testId = -1; // Track N1: test notes have their own (negative) ids
  readonly stats = { notes: 0 };

  constructor(o: AwayLiveOptions) {
    this.o = o;
    this.off = o.bus.subscribe((e) => this.onEvent(e));
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref?.();
    this.watchAsks();
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Follow the task's question box (made by the task's registrations; a test may swap it). */
  private watchAsks(): AskBox | undefined {
    const b = this.o.source.asks();
    if (b !== this.watched) {
      this.offAsks?.();
      this.watched = b;
      this.offAsks = b?.onChange(() => this.o.changed?.());
    }
    return b;
  }

  onEvent(e: BotEvent): void {
    if (e.sev !== 'info' || e.kind.startsWith('queue.') || e.kind.startsWith('ask.')) this.mark = e.id;
    if (!this.notifyOn() && !this.discordOn()) return; // Track N1: notes are made for either path
    const draft = noteFor(e);
    if (!draft) return;
    const n = this.limiter.offer(draft, this.now());
    if (n) this.keep(n);
  }

  /** Folded notes whose time came. */
  flush(): void {
    for (const n of this.limiter.due(this.now())) this.keep(n);
  }

  private keep(n: Note, sink = true): void {
    if (n.id === 0) n = { ...n, id: this.testId-- };
    this.notes.push(n);
    if (this.notes.length > NOTES_KEEP) this.notes.splice(0, this.notes.length - NOTES_KEEP);
    this.stats.notes++;
    this.o.log?.info(`away: note ${n.title}${n.n > 1 ? ` (${n.n} folded)` : ''}`);
    if (sink) {
      const box = this.watchAsks();
      const ask = n.ask !== null ? box?.list().find((a) => a.id === n.ask) : undefined;
      const card = ask ? box?.card(ask.id) : undefined; // Track D2: the message card's words
      this.o.discord?.send(n, ask, card); // Track N1
      for (const s of this.o.sinks ?? []) s.send(n, ask, card); // Track D1
    }
    this.o.changed?.();
  }

  private discordOn(): boolean {
    return (this.o.discord?.active() ?? false) || (this.o.sinks ?? []).some((s) => s.active()); // Track D1: the other sinks too
  }

  /**
   * Track N1: `!notify test`: one test note through every path that is on (the open pages with `notify`, Discord with
   * `notifyDiscord`), outside the rate limit; the outcome of each, never the URL.
   */
  async test(text = 'a test notification: nothing to do'): Promise<string[]> {
    const ts = this.now();
    const out: string[] = [];
    if (this.notifyOn()) {
      this.keep({ id: 0, ts, kind: 'notify.test', event: 0, title: 'test', body: text, n: 1, ask: null }, false);
      out.push('panel: a note for the open pages');
    } else out.push('panel: off (!set notify on)');
    out.push(this.o.discord ? await this.o.discord.test({ title: 'test notification', body: text, ts, kind: 'notify.test' }) : 'discord: not wired');
    for (const s of this.o.sinks ?? []) out.push(await s.test({ title: 'test notification', body: text, ts, kind: 'notify.test' })); // Track D1
    return out;
  }

  /** Track N1: `!notify` (status): both paths in one line each (Track D1: and each other sink). */
  statusLines(): string[] {
    const s = this.limiter.stats;
    return [`notify: panel ${this.notifyOn() ? 'on' : 'off'}; ${s.sent} notes made, ${s.folded} folded, ${this.limiter.waiting} waiting`, this.o.discord ? this.o.discord.statusLine() : 'discord: not wired', ...(this.o.sinks ?? []).map((x) => x.statusLine())];
  }

  /**
   * Track D3: the Discord lines GET /api/away carries for the Away view: the webhook's (`!notify`'s line) and every other
   * sink's (the bot's `!discord` lines), from the same status functions; masked there (no URL, no token, ids by 4 digits).
   */
  discordLines(): AwayDiscord {
    const out: AwayDiscord = {};
    try {
      if (this.o.discord) out.discord = this.o.discord.statusLine();
      const bot = (this.o.sinks ?? []).flatMap((s) => s.statusLines?.() ?? [s.statusLine()]);
      if (bot.length) out.discordBot = bot;
    } catch {
      // a status that throws leaves its lines out
    }
    return out;
  }

  private notifyOn(): boolean {
    try {
      return this.o.source.notify();
    } catch {
      return false;
    }
  }

  state(max = STATE_NOTES): PanelAway {
    // Track D2: a note's Discord line stays out of the page's state
    return { notify: this.notifyOn(), mark: this.mark, notes: this.notes.slice(-max).map(({ line: _line, ...n }) => n), asks: this.watchAsks()?.list() ?? [] };
  }

  async timeline(p: URLSearchParams): Promise<Timeline | { error: string }> {
    const now = this.now();
    const rawSince = p.get('since');
    const rawHours = p.get('hours');
    let since: number;
    if (rawSince !== null && rawSince !== '') {
      since = Number(rawSince);
      if (!Number.isFinite(since) || since < 1e12) return { error: 'since must be wall-clock ms (from 1e12)' };
      since = Math.max(since, now - MAX_SUMMARY_HOURS * 3_600_000);
    } else {
      const h = rawHours === null || rawHours === '' ? DEFAULT_HOURS : Number(rawHours);
      if (!Number.isFinite(h) || h <= 0 || h > MAX_SUMMARY_HOURS) return { error: `hours must be > 0 and at most ${MAX_SUMMARY_HOURS}` };
      since = now - h * 3_600_000;
    }
    const g = p.get('group') ?? 'job';
    if (g !== 'job' && g !== 'hour') return { error: 'group must be job or hour' };
    const tz = Number(p.get('tz') ?? 0);
    if (!Number.isFinite(tz) || Math.abs(tz) > 14 * 60) return { error: 'tz must be minutes east of UTC (-840..840)' };
    const r = await this.o.bus.query({ since, limit: MAX_LIMIT });
    return buildTimeline(r.events, { since, now, group: g, tzMin: Math.round(tz), truncated: r.more });
  }

  route(): HealthRoute {
    return (path: string, req: IncomingMessage, res: ServerResponse): boolean => {
      if (path !== TIMELINE_PATH && path !== AWAY_PATH && path !== SW_PATH) return false;
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, { error: 'method not allowed' });
        return true;
      }
      const head = method === 'HEAD';
      if (path === SW_PATH) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'service-worker-allowed': '/' });
        res.end(head ? undefined : SERVICE_WORKER);
        return true;
      }
      if (path === AWAY_PATH) {
        send(res, 200, { ...this.state(NOTES_KEEP), limiter: { ...this.limiter.stats, waiting: this.limiter.waiting }, ...this.discordLines() }, head); // Track N1: the Discord line (masked); Track D3: the bot's
        return true;
      }
      const params = new URL(req.url ?? path, 'http://localhost').searchParams;
      this.timeline(params).then(
        (t) => send(res, 'error' in t ? 400 : 200, t, head),
        (e: unknown) => send(res, 500, { error: e instanceof Error ? e.message : String(e) }),
      );
      return true;
    };
  }

  stop(): void {
    this.o.discord?.stop(); // Track N1
    this.off();
    this.offAsks?.();
    clearInterval(this.timer);
  }
}

function send(res: ServerResponse, status: number, body: unknown, head = false): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(head ? undefined : `${JSON.stringify(body)}\n`);
}
