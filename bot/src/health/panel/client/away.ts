// The Away view (Track P5, ADR 0116, docs/away.md, docs/panel.md "Away view"): the fifth view, phone first. What the bot
// did while the owner was away (GET /api/timeline: grouped by job or by hour, the notable and alert lines shown, the rest
// folded and fetched on a tap), the summary line, the questions the bot asks (a card with the choices and a countdown:
// a tap sends `!answer <id> <choice>`), and the notifications (the bot's `notify` switch, this device's switch, what the
// browser allows). The state's `away` block reaches every view (stream or poll, a hidden tab too): a banner and the
// tab's title say what waits; a note becomes a system notification where the browser allows one, else a tone.
import { AWAY_REFRESH_MS, NOTE_FRESH_MS, NOTED_KEY, NOTIFY_KEY, SEEN_KEY, TIMELINE_PATH, type AskView, type Note, type PanelAway, type Timeline, type TimelineGroup } from '../shared.ts';
import { dur, why, type El, type NotifyLike } from './dom.ts';
import type { Lite, Page } from './page.ts';
import type { Views } from './views.ts';

/** `1 min 40 s left, then: next` (the card's countdown). */
export function askLeft(v: AskView, now: number): string {
  const s = Math.max(0, Math.round((v.until - now) / 1000));
  const t = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${t} left, then: ${v.default}`;
}

/** The chat line a choice sends. */
export const answerLine = (v: AskView, choice: string): string => `!answer ${v.id} ${choice}`;

/** `14:00` of an hour group in the page's zone (tzMin east of UTC). */
export function hourLabel(ms: number, tzMin: number): string {
  const d = new Date(ms + tzMin * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** The summary line over the window (`while away 3 h 12 min: 5 jobs done, ...`). */
export function summaryText(t: Timeline, mode: 'look' | 'hours', firstLook: boolean, now: number): string {
  const span = dur(Math.max(0, now - t.since) / 1000);
  const head = mode === 'look' && !firstLook ? `while away ${span}` : `in the last ${span}${firstLook ? ' (the first look from this browser)' : ''}`;
  return `${head}: ${t.line}${t.truncated ? ' (more events than were read: counts are at least)' : ''}`;
}

/** What this device can do with notifications, in words (the Away view's line). */
export function deviceText(n: NotifyLike | undefined, on: boolean): string {
  const open = 'While the page is open, the banner and the tab title show what waits';
  if (!n) return `${open}; this browser shows no notifications.`;
  if (!n.secure) return `This page is http on a LAN or VPN address: browsers allow notifications only on a secure page (https, or localhost on the bot's machine), so none can show here. ${open}${on ? ', with a tone (tap the switch once to allow sound)' : ''}.`;
  const p = n.permission();
  if (p === 'unsupported') return `This browser has no notifications. ${open}.`;
  if (p === 'denied') return `The browser blocks notifications for this page (its site settings). ${open}.`;
  if (!on) return 'Turn the switch on to get the alerts and questions as notifications on this device while the page is open.';
  if (p === 'default') return 'Tap the switch again to let the browser ask.';
  return 'Notifications on for this device while a panel page is open (in a tab or the background); a closed page gets none.';
}

export interface AwayView {
  render(s: Lite): void;
  /** The last timeline (tests). */
  timeline(): Timeline | null;
}

const tzNow = (): number => -new Date().getTimezoneOffset();

export function setupAway(page: Page, views: Views): AwayView {
  const { ui } = page;
  const env = ui.env;
  const el = (id: string): El => ui.need(id);
  const doc = ui.doc;
  const baseTitle = doc.title ?? 'BedrockBot panel';
  let shown = false;
  let tl: Timeline | null = null;
  let away: PanelAway | null = null;
  let lastMark = -1;
  let refreshT: unknown = 0;
  let fetching = false;
  /** The newest note ts already shown (stored, so a reload does not ping again). */
  let noted = Number(ui.store.get(NOTED_KEY) ?? 'NaN');
  const askEls = new Map<number, { card: El; left: El }>();
  const replyEl = el('aw-reply');

  const seen = (): number | null => {
    const v = Number(ui.store.get(SEEN_KEY) ?? 'NaN');
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const deviceOn = (): boolean => ui.store.get(NOTIFY_KEY) === '1';
  const send = (cmd: string): void => {
    replyEl.textContent = `> ${cmd}\n...`;
    void page.send(cmd).then((out) => {
      replyEl.textContent = `> ${cmd}\n${out}`;
    });
  };
  const button = (label: string, aria: string, fn: () => void, cls = 'small'): El => {
    const b = ui.el('button', cls, label);
    b.type = 'button';
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', fn);
    return b;
  };

  // ---- the window and its timeline
  const sinceSel = el('aw-since');
  const groupSel = el('aw-group');
  const windowOf = (now: number): { since: number; mode: 'look' | 'hours'; first: boolean } => {
    if (sinceSel.value && sinceSel.value !== 'look') return { since: now - Number(sinceSel.value) * 3_600_000, mode: 'hours', first: false };
    const s = seen();
    return s ? { since: s, mode: 'look', first: false } : { since: now - 8 * 3_600_000, mode: 'look', first: true };
  };
  const load = (): void => {
    if (!shown || fetching) return;
    fetching = true;
    const now = Date.now();
    const w = windowOf(now);
    const url = `${TIMELINE_PATH}?since=${Math.floor(w.since)}&group=${groupSel.value === 'hour' ? 'hour' : 'job'}&tz=${tzNow()}`;
    void env
      .fetch(url, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${TIMELINE_PATH} ${r.status}`);
        tl = (await r.json()) as Timeline;
        ui.text('aw-sum', summaryText(tl, w.mode, w.first, Date.now()));
        renderTimeline(tl);
      })
      .catch((e: unknown) => {
        ui.text('aw-sum', `the timeline did not load (${why(e)})`);
      })
      .finally(() => {
        fetching = false;
      });
  };
  const loadSoon = (): void => {
    if (refreshT) return;
    refreshT = env.setTimeout(() => {
      refreshT = 0;
      load();
    }, AWAY_REFRESH_MS);
  };
  sinceSel.addEventListener('change', load);
  groupSel.addEventListener('change', load);
  el('aw-seen').addEventListener('click', () => {
    ui.store.set(SEEN_KEY, String(Date.now()));
    sinceSel.value = 'look';
    load();
    paint();
  });

  function lineEl(text: string, sev: string, ts: number): El {
    const d = ui.el('div', `awl sev-${sev}`);
    d.appendChild(ui.el('span', 'muted', `${hourLabel(ts, tzNow())} `));
    d.appendChild(ui.el('span', '', text));
    return d;
  }
  function groupEl(g: TimelineGroup): El {
    const box = ui.el('div', 'awg');
    box.dataset.group = g.key;
    const head = ui.el('div', 'awgh');
    if (g.kind === 'job') {
      head.appendChild(ui.el('span', `badge b-${g.state ?? 'running'}`, g.state ?? 'running'));
      head.appendChild(ui.el('b', 'grow', g.title));
    } else head.appendChild(ui.el('b', 'grow', `${hourLabel(g.from, tzNow())} to ${hourLabel(g.to, tzNow())}`));
    box.appendChild(head);
    if (g.end) box.appendChild(ui.el('div', 'end', g.end));
    for (const l of g.head) box.appendChild(lineEl(l.text, l.sev, l.ts));
    if (g.moreHead) box.appendChild(ui.el('div', 'muted small', `${g.moreHead} earlier notable lines (in the folded list)`));
    if (g.facts) box.appendChild(ui.el('div', 'small', g.facts));
    if (g.folded.n) {
      const more = ui.el('div', 'awfold');
      more.appendChild(
        button(`${g.folded.n} more: ${g.folded.text}`, `show every line of this group`, () => {
          const url = `/api/events?since=${Math.max(0, g.ids[0] - 1)}&until=${g.ids[1]}&limit=200`;
          void env
            .fetch(url, { cache: 'no-store', credentials: 'same-origin' })
            .then(async (r) => {
              if (!r.ok) throw new Error(`events ${r.status}`);
              const got = (await r.json()) as { events: { ts: number; sev: string; text: string }[]; more: boolean };
              ui.clear(more);
              for (const e of got.events) more.appendChild(lineEl(e.text, e.sev, e.ts));
              if (got.more) more.appendChild(ui.el('div', 'muted small', 'more lines: the first 200 shown'));
            })
            .catch((e: unknown) => {
              more.appendChild(ui.el('div', 'muted small', `not loaded (${why(e)})`));
            });
        }, 'small fold'),
      );
      box.appendChild(more);
    }
    return box;
  }
  function renderTimeline(t: Timeline): void {
    const list = el('aw-tl');
    ui.clear(list);
    for (const g of t.groups) list.appendChild(groupEl(g));
    if (t.olderGroups) list.appendChild(ui.el('div', 'muted small', `${t.olderGroups} older groups: a shorter window shows them`));
    if (!t.groups.length) list.appendChild(ui.el('div', 'muted small', 'nothing happened in this window'));
  }

  // ---- the questions
  function renderAsks(asks: readonly AskView[], now: number): void {
    const box = el('aw-asks');
    const ids = new Set(asks.map((a) => a.id));
    for (const id of [...askEls.keys()]) if (!ids.has(id)) askEls.delete(id);
    const order = asks.map((a) => a.id).join(',');
    if (box.dataset.order !== order) {
      box.dataset.order = order;
      ui.clear(box);
      for (const v of asks) {
        const card = ui.el('div', 'awask');
        card.dataset.ask = String(v.id);
        card.appendChild(ui.el('b', '', `#${v.id} ${v.text}`));
        const acts = ui.el('div', 'acts');
        for (const c of v.choices) acts.appendChild(button(`${c.n} ${c.label}`, `answer ${c.id} (${answerLine(v, c.id)})`, () => send(answerLine(v, c.id)), c.id === v.default ? 'primary' : ''));
        card.appendChild(acts);
        const left = ui.el('div', 'small muted');
        card.appendChild(left);
        box.appendChild(card);
        askEls.set(v.id, { card, left });
      }
      if (!asks.length) box.appendChild(ui.el('div', 'muted small', 'no question waits'));
    }
    for (const v of asks) {
      const e = askEls.get(v.id);
      const t = askLeft(v, now);
      if (e && e.left.textContent !== t) e.left.textContent = t;
    }
  }

  // ---- notifications
  const botSw = el('aw-bot');
  const devSw = el('aw-dev');
  devSw.checked = deviceOn();
  botSw.addEventListener('change', () => send(`!set notify ${botSw.checked ? 'on' : 'off'}`));
  devSw.addEventListener('change', () => {
    ui.store.set(NOTIFY_KEY, devSw.checked ? '1' : null);
    const n = env.notify;
    if (devSw.checked && n) {
      n.unlock(); // the tap allows the tone
      if (n.secure && n.permission() === 'default') void n.request().then(() => ui.text('aw-note', deviceText(n, deviceOn())));
    }
    ui.text('aw-note', deviceText(n, deviceOn()));
  });
  ui.text('aw-note', deviceText(env.notify, deviceOn()));

  function renderNotes(notes: readonly Note[]): void {
    const box = el('aw-notes');
    const sig = notes.map((n) => n.ts).join(',');
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    ui.clear(box);
    for (const n of [...notes].reverse()) {
      const d = ui.el('div', 'awl sev-alert');
      d.appendChild(ui.el('b', '', `${hourLabel(n.ts, tzNow())} ${n.title}`));
      d.appendChild(ui.el('div', 'small', n.body));
      box.appendChild(d);
    }
    if (!notes.length) box.appendChild(ui.el('div', 'muted small', 'no notification yet'));
  }
  /** New notes: a system notification where it may show, else a tone; each once (NOTED_KEY). */
  function ping(a: PanelAway): void {
    const newest = a.notes.reduce((m, n) => Math.max(m, n.ts), 0);
    if (!Number.isFinite(noted)) {
      noted = newest; // the first look on this browser: what is there is listed, not pinged
      ui.store.set(NOTED_KEY, String(noted));
      return;
    }
    const fresh = a.notes.filter((n) => n.ts > noted && Date.now() - n.ts < NOTE_FRESH_MS);
    if (newest > noted) {
      noted = newest;
      ui.store.set(NOTED_KEY, String(noted));
    }
    if (!a.notify || !deviceOn() || !fresh.length) return;
    const n = env.notify;
    for (const x of fresh) {
      if (!n) continue;
      void n.show(x.title, x.body, `bb-${x.kind}`).then((ok) => {
        if (!ok) n.beep();
      });
    }
  }

  // ---- the banner and the title on every view
  function paint(): void {
    const a = away;
    const asks = a?.asks ?? [];
    const s = seen() ?? 0;
    const unseen = (a?.notes ?? []).filter((n) => n.ts > s);
    const count = asks.length + unseen.length;
    const bar = el('awaybar');
    const want = count > 0 && !shown;
    if (bar.hidden === want) bar.hidden = !want;
    if (want) ui.text('awaybar-t', asks.length ? `the bot asks: ${asks[0]!.text}${count > 1 ? ` (+${count - 1})` : ''}` : `${unseen.at(-1)!.title}${count > 1 ? ` (+${count - 1})` : ''}`);
    const title = count ? `(${count}) ${baseTitle}` : baseTitle;
    if (doc.title !== undefined && doc.title !== title) doc.title = title;
    ui.text('view-away', count ? `Away ${count}` : 'Away');
  }

  views.on((v) => {
    const was = shown;
    shown = v === 'away';
    if (was && !shown) ui.store.set(SEEN_KEY, String(Date.now())); // leaving the view: the next look starts here
    if (shown) {
      if (away) {
        renderAsks(away.asks, Date.now());
        renderNotes(away.notes);
      }
      load();
    }
    paint();
  });

  return {
    render(s: Lite): void {
      const a = (s as { away?: PanelAway | null }).away ?? null;
      away = a;
      if (!a) return;
      botSw.checked = a.notify;
      ping(a);
      if (shown) {
        renderAsks(a.asks, Date.now());
        renderNotes(a.notes);
        if (a.mark !== lastMark && lastMark !== -1) loadSoon();
      }
      lastMark = a.mark;
      paint();
    },
    timeline: () => tl,
  };
}
