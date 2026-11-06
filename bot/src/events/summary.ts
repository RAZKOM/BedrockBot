// "What did the bot do in the last N hours" (decision 0059, docs/events.md "Summary"):
// GET /api/events/summary?hours=8. Pure over a list of events (unit-tested); the route feeds it the
// window from the bus (ring or files).
import { formatEvent, SEVERITIES, type BotEvent, type Severity } from './registry.ts';

export interface JobLine {
  ts: number;
  job: string;
  result: 'finished' | 'failed' | 'stopped';
  /** The result (finished) or the reason (failed, stopped). */
  detail: string;
  durationS: number;
  by?: string;
}

export interface EventSummary {
  hours: number;
  from: number;
  to: number;
  total: number;
  /** The window had more events than were read (the limit); counts are then a lower bound. */
  truncated: boolean;
  counts: Record<string, number>;
  bySeverity: Record<Severity, number>;
  items: { gained: Record<string, number>; lost: Record<string, number>; net: Record<string, number> };
  containers: { deposited: Record<string, number>; withdrawn: Record<string, number> };
  combat: { fights: number; kills: number; damageTaken: number; flees: number };
  jobs: JobLine[];
  deaths: { ts: number; cause: string }[];
  /** Alert and notable events, newest last (at most 50), with their timeline line. */
  highlights: { id: number; ts: number; kind: string; sev: string; text: string }[];
}

export const MAX_SUMMARY_HOURS = 24 * 31;

function addAll(into: Record<string, number>, from: unknown, sign = 1): void {
  if (typeof from !== 'object' || from === null) return;
  for (const [k, v] of Object.entries(from as Record<string, unknown>)) if (typeof v === 'number') into[k] = (into[k] ?? 0) + sign * v;
}

function clean(r: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(r).filter(([, n]) => n !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])));
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function summarize(list: readonly BotEvent[], o: { hours: number; now: number; truncated?: boolean }): EventSummary {
  const counts: Record<string, number> = {};
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const gained: Record<string, number> = {};
  const lost: Record<string, number> = {};
  const deposited: Record<string, number> = {};
  const withdrawn: Record<string, number> = {};
  const combat = { fights: 0, kills: 0, damageTaken: 0, flees: 0 };
  const jobs: JobLine[] = [];
  const deaths: { ts: number; cause: string }[] = [];
  const highlights: EventSummary['highlights'] = [];
  for (const e of list) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (e.sev in bySeverity) bySeverity[e.sev]++;
    const d = e.data as Record<string, unknown>;
    switch (e.kind) {
      case 'items.changed':
        addAll(gained, d.gained);
        addAll(lost, d.lost);
        break;
      case 'container.deposit':
        addAll(deposited, d.items);
        break;
      case 'container.withdraw':
        addAll(withdrawn, d.items);
        break;
      case 'combat.fight':
        combat.fights++;
        break;
      case 'combat.kill':
        combat.kills++;
        break;
      case 'combat.damage':
        combat.damageTaken += num(d.damage);
        break;
      case 'combat.flee':
        combat.flees++;
        break;
      case 'life.died':
        deaths.push({ ts: e.ts, cause: str(d.cause) });
        break;
      case 'job.finished':
        jobs.push({ ts: e.ts, job: str(d.job), result: 'finished', detail: str(d.result), durationS: num(d.durationS) });
        break;
      case 'job.failed':
        jobs.push({ ts: e.ts, job: str(d.job), result: 'failed', detail: str(d.reason), durationS: num(d.durationS) });
        break;
      case 'job.stopped':
        jobs.push({ ts: e.ts, job: str(d.job), result: 'stopped', detail: str(d.reason), durationS: num(d.durationS), ...(typeof d.by === 'string' ? { by: d.by } : {}) });
        break;
      default:
        break;
    }
    if (e.sev !== 'info') highlights.push({ id: e.id, ts: e.ts, kind: e.kind, sev: e.sev, text: formatEvent(e) });
  }
  const net: Record<string, number> = { ...gained };
  addAll(net, lost, -1);
  combat.damageTaken = Math.round(combat.damageTaken * 10) / 10;
  return {
    hours: o.hours,
    from: o.now - o.hours * 3_600_000,
    to: o.now,
    total: list.length,
    truncated: o.truncated ?? false,
    counts,
    bySeverity,
    items: { gained: clean(gained), lost: clean(lost), net: clean(net) },
    containers: { deposited: clean(deposited), withdrawn: clean(withdrawn) },
    combat,
    jobs,
    deaths,
    highlights: highlights.slice(-50),
  };
}
