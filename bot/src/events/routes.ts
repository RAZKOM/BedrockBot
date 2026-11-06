// The event API (decision 0059, docs/events.md "Query API"), mounted on the panel's server next to
// /api/state (health/panel/index.ts), behind the same token check:
//   GET /api/events?since=<id|ms>&until=<id|ms>&kinds=job,combat.kill&min=notable&limit=200
//       -> {"events":[{id,ts,kind,sev,data,text}],"more":false,"next":<last id>}
//   GET /api/events/summary?hours=8 -> EventSummary (summary.ts)
//   GET /api/events/kinds -> the registry (kind, category, severity, doc, fields)
// Bad parameters answer 400 with the reason.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HealthRoute } from '../health/map/routes.ts';
import { events as defaultBus, type EventBus } from './bus.ts';
import { MAX_LIMIT, type EventQuery } from './query.ts';
import { CATEGORIES, EVENT_KIND_NAMES, formatEvent, kindList, SEVERITIES, type BotEvent, type Severity } from './registry.ts';
import { MAX_SUMMARY_HOURS, summarize } from './summary.ts';

function send(res: ServerResponse, status: number, body: unknown, head = false): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(head ? undefined : `${JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
}

const KNOWN = new Set<string>([...EVENT_KIND_NAMES, ...CATEGORIES]);

function numberParam(p: URLSearchParams, name: string): number | undefined | { error: string } {
  const raw = p.get(name);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { error: `${name} must be a number >= 0 (an event id, or wall-clock ms from 1e12)` };
  return n;
}

/** Parse the query string of GET /api/events (pure; unit-tested). */
export function parseEventQuery(p: URLSearchParams): EventQuery | { error: string } {
  const since = numberParam(p, 'since');
  if (typeof since === 'object') return since;
  const until = numberParam(p, 'until');
  if (typeof until === 'object') return until;
  const limit = numberParam(p, 'limit');
  if (typeof limit === 'object') return limit;
  if (limit !== undefined && (limit < 1 || limit > MAX_LIMIT)) return { error: `limit must be 1..${MAX_LIMIT}` };
  const kinds = (p.get('kinds') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  const bad = kinds.filter((k) => !KNOWN.has(k));
  if (bad.length) return { error: `unknown kind(s) ${bad.join(', ')}: use a kind (${EVENT_KIND_NAMES[0]}, ...) or a category (${CATEGORIES.join(', ')}); GET /api/events/kinds lists them` };
  const min = p.get('min') ?? undefined;
  if (min !== undefined && !(SEVERITIES as readonly string[]).includes(min)) return { error: `min must be ${SEVERITIES.join(', ')}` };
  return { since, until, limit, kinds, min: min as Severity | undefined };
}

const withText = (e: BotEvent): BotEvent & { text: string } => ({ ...e, text: formatEvent(e) });

export function eventRoutes(bus: EventBus = defaultBus, now: () => number = Date.now): HealthRoute {
  return (path: string, req: IncomingMessage, res: ServerResponse): boolean => {
    if (path !== '/api/events' && path !== '/api/events/summary' && path !== '/api/events/kinds') return false;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, { error: 'method not allowed' });
      return true;
    }
    const head = method === 'HEAD';
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    if (path === '/api/events/kinds') {
      send(res, 200, { kinds: kindList(), categories: CATEGORIES, severities: SEVERITIES }, head);
      return true;
    }
    if (path === '/api/events/summary') {
      const raw = params.get('hours');
      const hours = raw === null || raw === '' ? 8 : Number(raw);
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_SUMMARY_HOURS) {
        send(res, 400, { error: `hours must be > 0 and at most ${MAX_SUMMARY_HOURS}` });
        return true;
      }
      const t = now();
      bus.query({ since: t - hours * 3_600_000, limit: MAX_LIMIT }).then(
        (r) => {
          send(res, 200, summarize(r.events, { hours, now: t, truncated: r.more }), head);
        },
        (e: unknown) => {
          send(res, 500, { error: e instanceof Error ? e.message : String(e) });
        },
      );
      return true;
    }
    const q = parseEventQuery(params);
    if ('error' in q) {
      send(res, 400, q);
      return true;
    }
    bus.query(q).then(
      (r) => {
        const list = r.events.map(withText);
        const next = list.length ? list[list.length - 1]!.id : (q.since ?? 0);
        send(res, 200, { events: list, more: r.more, next, ...(r.skipped ? { skipped: r.skipped } : {}) }, head);
      },
      (e: unknown) => {
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      },
    );
    return true;
  };
}
