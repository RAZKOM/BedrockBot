// Notifications (Track P5, ADR 0116, docs/away.md "Notifications"): which events become a notification, what each one
// says (what happened and what the owner can do), and the rate limit. Pure (unit-tested); health/panel/away.ts feeds it
// the bus and hands the notes to the open pages, which show them (a system notification where the browser allows one,
// else the page's banner and title).
//
// The rate limit, so three deaths in a minute are not three pings:
// - one kind (`life.died`) at most once per NOTE_COOLDOWN_MS; the ones in between are folded into one note sent when
//   the cooldown ends (`the bot died (3 times in 1 min 12 s)`, the last one's text);
// - at most NOTE_WINDOW_MAX notes in NOTE_WINDOW_MS over every kind; beyond it they wait, folded, until the window
//   frees a place;
// - a question (`ask.asked`) is never folded with another and skips the window (it needs an answer before its wait
//   runs out; the box keeps at most 4 open), but has its own cooldown of ASK_NOTE_COOLDOWN_MS.
import { durationText, formatEvent, type BotEvent } from '../../events/registry.ts';

export const NOTE_COOLDOWN_MS = 60_000;
export const NOTE_WINDOW_MS = 10 * 60_000;
export const NOTE_WINDOW_MAX = 5;
export const ASK_NOTE_COOLDOWN_MS = 10_000;
/** Notes kept for the pages (the newest). */
export const NOTES_KEEP = 20;
export const NOTE_TITLE_MAX = 80;
export const NOTE_BODY_MAX = 300;

export interface Note {
  /** This run's sequence (a restart starts again: the page remembers the last `ts` it showed, not the id). */
  id: number;
  ts: number;
  /** The event kind it came from (`life.died`, `ask.asked`). */
  kind: string;
  /** The event id (the newest folded one). */
  event: number;
  title: string;
  body: string;
  /** Events folded into it (1: just this one). */
  n: number;
  /** A question's id (the page's answer buttons), else null. */
  ask: number | null;
  /**
   * Track D2: what happened in one line (`zombie at 10 64 -3`), for a Discord message's body; the page shows `body`
   * and never gets this (AwayLive.state leaves it out).
   */
  line?: string;
}

export interface NoteDraft {
  key: string;
  kind: string;
  event: number;
  ts: number;
  title: string;
  body: string;
  ask: number | null;
  /** A question: no folding, no window. */
  urgent: boolean;
  /** Track D2: see Note.line. */
  line?: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
/** Track D2: a note's one line at most. */
export const NOTE_LINE_MAX = 160;
const xyz = (p: unknown): string | undefined => {
  const q = p as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  return q && typeof q.x === 'number' && typeof q.y === 'number' && typeof q.z === 'number' ? `${Math.floor(q.x)} ${Math.floor(q.y)} ${Math.floor(q.z)}` : undefined;
};

/** Track D2: the server's death ids (`death.attack.<id>`) in words; an id not listed is shown as it is. */
const CAUSE_WORDS: Readonly<Record<string, string>> = {
  generic: 'killed',
  outOfWorld: 'fell out of the world',
  fall: 'fell',
  lava: 'lava',
  inFire: 'burned',
  onFire: 'burned',
  drown: 'drowned',
  starve: 'starved',
  explosion: 'blown up',
  inWall: 'suffocated',
  freeze: 'froze',
  wither: 'withered',
  lightningBolt: 'lightning',
  fallingBlock: 'a falling block',
  sweetBerry: 'a berry bush',
};

/** Track D2: a death's cause and place in one line (`zombie at 10 64 -3`, `skeleton (arrow) at 4 70 2`, `fell at 3 70 9`). */
export function deathLine(d: Record<string, unknown>): string {
  const id = typeof d.cause === 'string' ? d.cause.replace(/^death\.attack\./, '').replace(/\.(player|item)$/, '') : undefined;
  const cause = id === undefined ? 'unknown cause' : (CAUSE_WORDS[id] ?? id);
  // the killer, when the server named one (`%entity.zombie.name`)
  const who = Array.isArray(d.messages) ? d.messages.map((m) => /^%?entity\.([a-z_]+)\.name$/.exec(String(m))?.[1]?.replace(/_/g, ' ')).find((m) => m !== undefined) : undefined;
  const at = xyz(d.at);
  // `mob` and `player` say only that something killed it: the killer is the cause then (`zombie`), else beside it (`skeleton (arrow)`)
  const what = who && who !== cause ? (cause === 'mob' || cause === 'player' ? who : `${who} (${cause})`) : cause;
  return clip(`${what}${at ? ` at ${at}` : ''}`, NOTE_LINE_MAX);
}

/** The notification an event makes, or undefined (only alerts and questions notify). */
export function noteFor(e: BotEvent): NoteDraft | undefined {
  const d = e.data as Record<string, unknown>;
  const text = formatEvent(e);
  const base = { kind: e.kind, event: e.id, ts: e.ts, ask: null, urgent: false };
  switch (e.kind) {
    case 'life.died':
      return { ...base, key: e.kind, title: 'the bot died', body: `${text}. It respawns by itself; what it carried lies at the spot for 5 minutes. The panel's Away view shows what led to it.`, line: deathLine(d) };
    case 'connection.kicked':
      return { ...base, key: e.kind, title: 'the bot was kicked', body: `${text}. ${d.willReconnect === true ? 'It reconnects by itself; nothing to do unless it happens again.' : 'It does not reconnect: start it again on its machine.'}`, line: clip(`${typeof d.message === 'string' ? d.message : typeof d.reason === 'string' ? d.reason : 'no reason'}: ${d.willReconnect === true ? 'it reconnects by itself' : 'start it again on its machine'}`, NOTE_LINE_MAX) };
    case 'connection.lost':
      return { ...base, key: e.kind, title: 'the bot lost the connection for good', body: `${text}. It does not reconnect by itself: start it again on its machine.`, line: 'start it again on its machine' };
    case 'ask.asked': {
      const id = typeof d.id === 'number' ? d.id : 0;
      const wait = typeof d.waitS === 'number' ? durationText(d.waitS) : 'a while';
      return { ...base, key: `${e.kind}:${String(d.key)}`, ask: id, urgent: true, title: `the bot asks (#${id})`, body: `${String(d.text)} Answer in the panel's Away view, or !answer ${id} <choice> in the game; unanswered in ${wait}: ${String(d.default)}.` };
    }
    default:
      return e.sev === 'alert' ? { ...base, key: e.kind, title: clip(text, NOTE_TITLE_MAX), body: "The panel's Away view has the rest." } : undefined;
  }
}

interface Pending {
  first: number;
  last: NoteDraft;
  n: number;
}

export class NoteLimiter {
  private readonly lastAt = new Map<string, number>();
  private sent: number[] = [];
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  readonly stats = { offered: 0, sent: 0, folded: 0 };

  /** A new draft: the note to send now, or undefined (folded until its cooldown or the window allows). */
  offer(d: NoteDraft, now: number): Note | undefined {
    this.stats.offered++;
    const p = this.pending.get(d.key);
    if (p && !d.urgent) {
      p.n++;
      p.last = d;
      this.stats.folded++;
      return undefined;
    }
    if (this.allowed(d, now)) return this.send(d, 1, now, d.ts);
    this.pending.set(d.key, { first: d.ts, last: d, n: 1 });
    this.stats.folded++;
    return undefined;
  }

  /** Folded notes whose time came (call every second or so). */
  due(now: number): Note[] {
    const out: Note[] = [];
    for (const [key, p] of [...this.pending.entries()].sort((a, b) => a[1].first - b[1].first)) {
      if (!this.allowed(p.last, now)) continue;
      this.pending.delete(key);
      out.push(this.send(p.last, p.n, now, p.first));
    }
    return out;
  }

  get waiting(): number {
    return this.pending.size;
  }

  private allowed(d: NoteDraft, now: number): boolean {
    const last = this.lastAt.get(d.key);
    const cool = d.urgent ? ASK_NOTE_COOLDOWN_MS : NOTE_COOLDOWN_MS;
    if (last !== undefined && now - last < cool) return false;
    if (d.urgent) return true;
    this.sent = this.sent.filter((t) => now - t < NOTE_WINDOW_MS);
    return this.sent.length < NOTE_WINDOW_MAX;
  }

  private send(d: NoteDraft, n: number, now: number, first: number): Note {
    this.lastAt.set(d.key, now);
    if (!d.urgent) this.sent.push(now);
    this.stats.sent++;
    const title = n > 1 ? `${d.title} (${n} times in ${durationText((d.ts - first) / 1000)})` : d.title;
    return { id: this.nextId++, ts: now, kind: d.kind, event: d.event, title: clip(title, NOTE_TITLE_MAX), body: clip(n > 1 ? `The last: ${d.body}` : d.body, NOTE_BODY_MAX), n, ask: d.ask, ...(d.line ? { line: d.line } : {}) };
  }
}
