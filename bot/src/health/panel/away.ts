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
import type { AskBox, AskView } from '../../tasks/ask.ts';
import type { HealthRoute } from '../map/routes.ts';
import { NoteLimiter, noteFor, NOTES_KEEP, type Note } from './notes.ts';
import { AWAY_PATH, SW_PATH, TIMELINE_PATH } from './shared.ts';

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

export interface AwayLiveOptions {
  bus: Pick<EventBus, 'subscribe' | 'query'>;
  source: AwaySource;
  /** Something the pages should see soon (a note, a question): push the state. */
  changed?: () => void;
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
    if (!this.notifyOn()) return;
    const draft = noteFor(e);
    if (!draft) return;
    const n = this.limiter.offer(draft, this.now());
    if (n) this.keep(n);
  }

  /** Folded notes whose time came. */
  flush(): void {
    for (const n of this.limiter.due(this.now())) this.keep(n);
  }

  private keep(n: Note): void {
    this.notes.push(n);
    if (this.notes.length > NOTES_KEEP) this.notes.splice(0, this.notes.length - NOTES_KEEP);
    this.stats.notes++;
    this.o.log?.info(`away: note ${n.title}${n.n > 1 ? ` (${n.n} folded)` : ''}`);
    this.o.changed?.();
  }

  private notifyOn(): boolean {
    try {
      return this.o.source.notify();
    } catch {
      return false;
    }
  }

  state(max = STATE_NOTES): PanelAway {
    return { notify: this.notifyOn(), mark: this.mark, notes: this.notes.slice(-max), asks: this.watchAsks()?.list() ?? [] };
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
        send(res, 200, { ...this.state(NOTES_KEEP), limiter: { ...this.limiter.stats, waiting: this.limiter.waiting } }, head);
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
    this.off();
    this.offAsks?.();
    clearInterval(this.timer);
  }
}

function send(res: ServerResponse, status: number, body: unknown, head = false): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(head ? undefined : `${JSON.stringify(body)}\n`);
}
