// Event queries (decision 0059, docs/events.md "Query API"): one filter for the ring, the files and
// the HTTP route.
//
//   since   an event id (exclusive: id > since) or wall-clock ms (ts >= since); numbers from 1e12 on
//           are ms (an id never gets there), so `since=<last id seen>` pages forward and
//           `since=<Date.now() - 8 h>` asks for a time window
//   until   the same split: id <= until or ts <= until
//   kinds   full kinds (`job.failed`) or categories (`job`); empty = all
//   min     the lowest severity (info < notable < alert)
//   limit   with `since`: the oldest `limit` after it (paging forward); without: the newest `limit`;
//           either way returned oldest first, `more` says whether the limit cut something off
import { SEVERITY_RANK, type BotEvent, type Severity } from './registry.ts';

export interface EventQuery {
  since?: number | undefined;
  until?: number | undefined;
  kinds?: readonly string[] | undefined;
  min?: Severity | undefined;
  limit?: number | undefined;
}

export interface QueryResult {
  events: BotEvent[];
  /** The limit cut matching events off (newer ones with `since`, older ones without). */
  more: boolean;
  /** Lines that could not be read (corrupt JSON) while answering. */
  skipped?: number;
}

/** `since` / `until` from this value on are wall-clock ms, below it event ids. */
export const MS_FROM = 1e12;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 5000;

export function atLeast(e: { sev: string }, min: Severity): boolean {
  return (SEVERITY_RANK[e.sev as Severity] ?? 0) >= SEVERITY_RANK[min];
}

/** The filter of a query (without the limit). */
export function matcher(q: EventQuery): (e: BotEvent) => boolean {
  const kinds = q.kinds?.length ? q.kinds : undefined;
  const since = q.since;
  const until = q.until;
  return (e) => {
    if (since !== undefined && (since >= MS_FROM ? e.ts < since : e.id <= since)) return false;
    if (until !== undefined && (until >= MS_FROM ? e.ts > until : e.id > until)) return false;
    if (q.min && !atLeast(e, q.min)) return false;
    if (kinds && !kinds.some((k) => e.kind === k || e.kind.startsWith(`${k}.`))) return false;
    return true;
  };
}

export function limitOf(q: EventQuery): number {
  const l = q.limit ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(l)));
}

/** Apply the filter and the limit to events sorted by id (oldest first). */
export function select(sorted: readonly BotEvent[], q: EventQuery): QueryResult {
  const m = matcher(q);
  const hits = sorted.filter(m);
  const limit = limitOf(q);
  if (hits.length <= limit) return { events: hits, more: false };
  return q.since !== undefined ? { events: hits.slice(0, limit), more: true } : { events: hits.slice(-limit), more: true };
}

/**
 * Answer from the ring. `complete` = the ring certainly holds every matching event (it holds every
 * event after its oldest one): with `since`, the ring starts at or before it; without, it has at
 * least `limit` matches.
 */
export function queryRing(ring: readonly BotEvent[], q: EventQuery): { complete: boolean; result: QueryResult } {
  const result = select(ring, q);
  const first = ring[0];
  let complete: boolean;
  if (!first) complete = false;
  else if (q.since !== undefined) complete = q.since >= MS_FROM ? first.ts < q.since : first.id <= q.since + 1;
  else complete = result.more || result.events.length >= limitOf(q);
  return { complete, result };
}
