// The away timeline (Track P5, ADR 0116, docs/away.md "The timeline"): what the bot did over a window of the event
// history, grouped by queued job (queue.started .. queue.finished / queue.failed) with the time between jobs by hour,
// or by hour alone. Pure over a list of events (unit-tested); GET /api/timeline (health/panel/away.ts) feeds it the
// window from the bus (the ring or the files).
//
// Each group: its head lines (the notable and alert events, oldest first: the story), its facts in short (items
// gained and lost, fights, kills, damage, chore runs, the commands started), and the rest folded as counts with the
// id range to fetch them (`GET /api/events?since=<first - 1>&until=<last>`). The summary counts the window:
// `5 jobs done, 1 failed, 0 deaths, 1 reconnect`.
import { clipText, formatEvent, type BotEvent } from './registry.ts';

export type TimelineGroupBy = 'job' | 'hour';

export interface TimelineLine {
  id: number;
  ts: number;
  kind: string;
  sev: string;
  text: string;
}

export interface TimelineGroup {
  /** `job:12` or `hour:<start ms>:<first id>` (unique in the answer). */
  key: string;
  kind: 'job' | 'hour';
  /** A job's `#12 !get kit iron`; an hour group's is empty (the page writes the hour in its own time zone). */
  title: string;
  /** The hour's start (local to `tzMin`) for an hour group; the first event's time for a job. */
  from: number;
  /** The last event's time. */
  to: number;
  /** A job's state (`done`, `failed`, `cancelled`, `skipped`, `running`: no end in the window yet). */
  state: string | null;
  /** A job's end line. */
  end: string | null;
  /** The notable and alert events, oldest first; at most HEAD_MAX (the newest kept). */
  head: TimelineLine[];
  /** Notable or alert events left out of `head`. */
  moreHead: number;
  /** The info events in short: `12: 4 fights, 3 kills, 2 item changes, 3 commands`. */
  folded: { n: number; text: string };
  /** Event ids of the group: fetch every line with /api/events?since=<first - 1>&until=<last>. */
  ids: [number, number];
  /** One line of facts: `+cobblestone x32, iron_ingot x3; -torch x4 · 2 fights, 2 kills, 3.5 damage · chores: milk 1`. */
  facts: string;
}

export interface AwayCounts {
  jobs: { done: number; failed: number; cancelled: number };
  /** Auto jobs: chore episodes and walks home. */
  chores: number;
  deaths: number;
  reconnects: number;
  disconnects: number;
  kicks: number;
  fights: number;
  kills: number;
  flees: number;
  damage: number;
  questions: number;
  /** Questions whose wait ran out. */
  unanswered: number;
}

export interface Timeline {
  since: number;
  to: number;
  group: TimelineGroupBy;
  /** Events read. */
  total: number;
  /** The window had more events than were read. */
  truncated: boolean;
  counts: AwayCounts;
  /** `5 jobs done, 1 failed, 0 deaths, 1 reconnect` (the page puts `while away 3 h 12 min: ` before it). */
  line: string;
  /** Newest first; at most GROUPS_MAX. */
  groups: TimelineGroup[];
  /** Groups left out (older ones). */
  olderGroups: number;
}

/** Groups in an answer at most (the newest), head lines per group, a line's length. */
export const GROUPS_MAX = 48;
export const HEAD_MAX = 10;
export const LINE_TEXT_MAX = 160;

/** Short labels for the folded counts (a kind not listed folds under its own name). */
const FOLD_LABEL: Record<string, [string, string]> = {
  'combat.fight': ['fight', 'fights'],
  'combat.kill': ['kill', 'kills'],
  'combat.damage': ['damage batch', 'damage batches'],
  'items.changed': ['item change', 'item changes'],
  'container.deposit': ['chest deposit', 'chest deposits'],
  'container.withdraw': ['chest withdrawal', 'chest withdrawals'],
  'command.received': ['command', 'commands'],
  'job.started': ['process start', 'process starts'],
  'job.finished': ['process end', 'process ends'],
  'job.stopped': ['process stop', 'process stops'],
  'home.arrived': ['walk home', 'walks home'],
  'life.respawned': ['respawn', 'respawns'],
  'connection.connected': ['connect', 'connects'],
  'queue.started': ['job start', 'job starts'],
  'queue.finished': ['job end', 'job ends'],
  'ask.answered': ['answer', 'answers'],
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function addCounts(into: Map<string, number>, from: unknown): void {
  if (typeof from !== 'object' || from === null) return;
  for (const [k, v] of Object.entries(from as Record<string, unknown>)) if (typeof v === 'number') into.set(k, (into.get(k) ?? 0) + v);
}

function topCounts(m: Map<string, number>, n: number): string {
  const e = [...m.entries()].filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const s = e.slice(0, n).map(([k, v]) => `${k} x${Math.round(v * 10) / 10}`).join(', ');
  return e.length > n ? `${s}, +${e.length - n} more` : s;
}

/** The summary line from the counts (pure; unit-tested). */
export function awayLine(c: AwayCounts): string {
  const parts = [plural(c.jobs.done, 'job done', 'jobs done'), `${c.jobs.failed} failed`];
  if (c.jobs.cancelled) parts.push(`${c.jobs.cancelled} cancelled`);
  parts.push(plural(c.deaths, 'death', 'deaths'), plural(c.reconnects, 'reconnect', 'reconnects'));
  if (c.kicks) parts.push(plural(c.kicks, 'kick', 'kicks'));
  if (c.questions) parts.push(`${plural(c.questions, 'question', 'questions')}${c.unanswered ? ` (${c.unanswered} unanswered)` : ''}`);
  return parts.join(', ');
}

interface Building {
  g: TimelineGroup;
  fold: Map<string, number>;
  heads: TimelineLine[];
  gained: Map<string, number>;
  lost: Map<string, number>;
  fights: number;
  kills: number;
  damage: number;
  chores: Map<string, number>;
  commands: number;
}

/** The start of the hour of `ts` in the zone `tzMin` minutes east of UTC. */
export function hourStart(ts: number, tzMin = 0): number {
  const off = tzMin * 60_000;
  return Math.floor((ts + off) / 3_600_000) * 3_600_000 - off;
}

/**
 * Build the timeline of `list` (oldest first, as the bus answers). `tzMin`: the page's offset east of UTC in minutes
 * (an hour group starts at the page's whole hour).
 */
export function buildTimeline(list: readonly BotEvent[], o: { since: number; now: number; group?: TimelineGroupBy; tzMin?: number; truncated?: boolean }): Timeline {
  const group = o.group ?? 'job';
  const tz = o.tzMin ?? 0;
  const counts: AwayCounts = { jobs: { done: 0, failed: 0, cancelled: 0 }, chores: 0, deaths: 0, reconnects: 0, disconnects: 0, kicks: 0, fights: 0, kills: 0, flees: 0, damage: 0, questions: 0, unanswered: 0 };
  const done: Building[] = [];
  let cur: Building | undefined;
  /** The queued job running in the window (its group is open). */
  let job: { id: number } | undefined;
  /** User process jobs started outside a queued job: name -> how many are open (their ends count as jobs). */
  const userOpen = new Map<string, number>();

  const open = (kind: 'job' | 'hour', e: BotEvent, title = '', key?: string): Building => {
    const from = kind === 'hour' ? hourStart(e.ts, tz) : e.ts;
    const b: Building = {
      g: { key: key ?? `hour:${from}:${e.id}`, kind, title, from, to: e.ts, state: kind === 'job' ? 'running' : null, end: null, head: [], moreHead: 0, folded: { n: 0, text: '' }, ids: [e.id, e.id], facts: '' },
      fold: new Map(),
      heads: [],
      gained: new Map(),
      lost: new Map(),
      fights: 0,
      kills: 0,
      damage: 0,
      chores: new Map(),
      commands: 0,
    };
    done.push(b);
    return b;
  };

  for (const e of list) {
    const d = e.data as Record<string, unknown>;
    // where the event goes
    if (e.kind === 'queue.started') job = { id: num(d.id) };
    if (group === 'job' && e.kind === 'queue.started') {
      cur = open('job', e, `#${num(d.id)} ${str(d.command)}`, `job:${num(d.id)}:${e.id}`);
    } else if (group === 'job' && job && cur?.g.kind === 'job') {
      // inside a queued job until its end
    } else if (!cur || cur.g.kind === 'job' || hourStart(e.ts, tz) !== cur.g.from) {
      cur = open('hour', e);
    }
    const b = cur;
    b.g.to = e.ts;
    b.g.ids[1] = e.id;
    // what it adds
    switch (e.kind) {
      case 'queue.finished': {
        const st = str(d.state);
        if (st === 'done') counts.jobs.done++;
        else counts.jobs.cancelled++;
        if (b.g.kind === 'job') {
          b.g.state = st;
          b.g.end = clipText(str(d.end), LINE_TEXT_MAX);
        }
        break;
      }
      case 'queue.failed':
        counts.jobs.failed++;
        if (b.g.kind === 'job') {
          b.g.state = 'failed';
          b.g.end = clipText(str(d.end), LINE_TEXT_MAX);
        }
        break;
      case 'job.started':
        if (str(d.kind) === 'auto') {
          counts.chores++;
          const n = str(d.job);
          b.chores.set(n, (b.chores.get(n) ?? 0) + 1);
        } else {
          b.commands++;
          if (!job) userOpen.set(str(d.job), (userOpen.get(str(d.job)) ?? 0) + 1);
        }
        break;
      case 'job.finished':
      case 'job.failed':
      case 'job.stopped': {
        const n = str(d.job);
        const k = userOpen.get(n) ?? 0;
        if (k > 0 && !job) {
          userOpen.set(n, k - 1);
          if (e.kind === 'job.finished') counts.jobs.done++;
          else if (e.kind === 'job.failed') counts.jobs.failed++;
          else counts.jobs.cancelled++;
        }
        break;
      }
      case 'life.died':
        counts.deaths++;
        break;
      case 'connection.reconnected':
        counts.reconnects++;
        break;
      case 'connection.disconnected':
        counts.disconnects++;
        break;
      case 'connection.kicked':
        counts.kicks++;
        break;
      case 'combat.fight':
        counts.fights++;
        b.fights++;
        break;
      case 'combat.kill':
        counts.kills++;
        b.kills++;
        break;
      case 'combat.flee':
        counts.flees++;
        break;
      case 'combat.damage':
        counts.damage += num(d.damage);
        b.damage += num(d.damage);
        break;
      case 'items.changed':
        addCounts(b.gained, d.gained);
        addCounts(b.lost, d.lost);
        break;
      case 'ask.asked':
        counts.questions++;
        break;
      case 'ask.answered':
        if (str(d.how) === 'timeout') counts.unanswered++;
        break;
      default:
        break;
    }
    if (e.sev === 'notable' || e.sev === 'alert') b.heads.push({ id: e.id, ts: e.ts, kind: e.kind, sev: e.sev, text: clipText(formatEvent(e), LINE_TEXT_MAX) });
    else b.fold.set(e.kind, (b.fold.get(e.kind) ?? 0) + 1);
    if (job && (e.kind === 'queue.finished' || e.kind === 'queue.failed') && num(d.id) === job.id) {
      job = undefined;
      if (group === 'job') cur = undefined; // the next event opens an hour group
    }
  }

  const groups = done.map((b) => finishGroup(b));
  counts.damage = Math.round(counts.damage * 10) / 10;
  const newest = groups.reverse();
  return {
    since: o.since,
    to: o.now,
    group,
    total: list.length,
    truncated: o.truncated ?? false,
    counts,
    line: awayLine(counts),
    groups: newest.slice(0, GROUPS_MAX),
    olderGroups: Math.max(0, newest.length - GROUPS_MAX),
  };
}

function finishGroup(b: Building): TimelineGroup {
  const g = b.g;
  g.head = b.heads.slice(-HEAD_MAX);
  g.moreHead = Math.max(0, b.heads.length - HEAD_MAX);
  const fold = [...b.fold.entries()].sort((x, y) => y[1] - x[1]);
  const n = fold.reduce((s, [, k]) => s + k, 0);
  g.folded = { n, text: fold.slice(0, 6).map(([k, c]) => (FOLD_LABEL[k] ? plural(c, FOLD_LABEL[k][0], FOLD_LABEL[k][1]) : `${c} ${k}`)).join(', ') + (fold.length > 6 ? `, +${fold.length - 6} more kinds` : '') };
  const facts: string[] = [];
  const gained = topCounts(b.gained, 4);
  const lost = topCounts(b.lost, 4);
  if (gained || lost) facts.push(`${gained ? `+${gained}` : ''}${gained && lost ? '; ' : ''}${lost ? `-${lost}` : ''}`);
  const fight: string[] = [];
  if (b.fights) fight.push(plural(b.fights, 'fight', 'fights'));
  if (b.kills) fight.push(plural(b.kills, 'kill', 'kills'));
  if (b.damage) fight.push(`${Math.round(b.damage * 10) / 10} damage`);
  if (fight.length) facts.push(fight.join(', '));
  if (b.chores.size) facts.push(`chores: ${[...b.chores.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (b.commands && g.kind === 'hour') facts.push(plural(b.commands, 'command started', 'commands started'));
  g.facts = clipText(facts.join(' · '), 300);
  return g;
}
