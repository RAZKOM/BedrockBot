// Track P5 (docs/away.md, docs/panel.md "Away view"): the notifications' rule and rate limit (health/panel/notes.ts),
// the away block, GET /api/timeline, /api/away and /sw.js (health/panel/away.ts), their sizes, and the Away view on the
// fake DOM of panel-dom.ts (the fifth view, the summary, the question cards with their countdown and answers, the
// switches, the notifications through the browser or a tone, the banner and title on the other views, phone width).
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../src/events/bus.ts';
import { EVENT_KINDS, type BotEvent, type EventData, type EventKind } from '../../../src/events/registry.ts';
import { AwayLive, STATE_NOTES, type PanelAway } from '../../../src/health/panel/away.ts';
import { PANEL_BUDGETS } from '../../../src/health/panel/budgets.ts';
import { askLeft, deviceText, discordRows, summaryText } from '../../../src/health/panel/client/away.ts';
import type { NotifyLike } from '../../../src/health/panel/client/dom.ts';
import { ASK_NOTE_COOLDOWN_MS, NOTE_COOLDOWN_MS, NOTE_WINDOW_MAX, NOTE_WINDOW_MS, NOTES_KEEP, NoteLimiter, noteFor } from '../../../src/health/panel/notes.ts';
import { renderPanelPage } from '../../../src/health/panel/page.ts';
import { AWAY_DISCORD_MS, NOTED_KEY, NOTIFY_KEY, SEEN_KEY, TIMELINE_PATH, VIEW_KEY, VIEWS } from '../../../src/health/panel/shared.ts';
import { liteState } from '../../../src/health/panel/state.ts';
import { buildTimeline, GROUPS_MAX } from '../../../src/events/timeline.ts';
import { AskBox } from '../../../src/tasks/ask.ts';
import { answer, flush, runPage, type FakeEl } from './panel-dom.ts';
import { fullState } from './panel-fixtures.ts';

const at = { x: 1, y: 64, z: 2 };
let nextId = 1;
const ev = <K extends EventKind>(kind: K, data: EventData<K>, ts = Date.now()): BotEvent => ({ id: nextId++, ts, kind, sev: EVENT_KINDS[kind].severity, data });
const died = (ts = Date.now()): BotEvent => ev('life.died', { n: 1, cause: 'death.attack.zombie', at }, ts);
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
const show = (what: string, n: number, budget: number): void => {
  if (process.env.PANEL_MEASURE) process.stdout.write(`panel budget: ${what} ${n} bytes (budget ${budget})\n`);
};

describe('what notifies', () => {
  it('alerts and questions only, each saying what happened and what the owner can do', () => {
    expect(noteFor(ev('combat.kill', { mob: 'zombie' }))).toBeUndefined();
    expect(noteFor(ev('queue.failed', { id: 1, command: '!x', end: 'e', durationS: 1 }))).toBeUndefined(); // notable: the timeline, not a ping
    expect(noteFor(died())).toMatchObject({ title: 'the bot died', body: expect.stringMatching(/^died \(zombie\) at 1 64 2\. It respawns by itself; what it carried lies at the spot for 5 minutes/) as string });
    expect(noteFor(ev('connection.kicked', { reason: 'kicked', message: 'x', willReconnect: false }))!.body).toMatch(/does not reconnect: start it again on its machine/);
    expect(noteFor(ev('connection.kicked', { reason: 'kicked', message: 'x', willReconnect: true }))!.body).toMatch(/reconnects by itself/);
    expect(noteFor(ev('connection.lost', { reason: 'outdated_client', kind: 'version' }))!.title).toBe('the bot lost the connection for good');
    const q = noteFor(ev('ask.asked', { id: 3, key: 'queue-fail', text: 'job #4 failed: retry it?', choices: ['retry', 'next', 'stop'], default: 'next', waitS: 120 }))!;
    expect(q).toMatchObject({ ask: 3, urgent: true, title: 'the bot asks (#3)' });
    expect(q.body).toBe("job #4 failed: retry it? Answer in the panel's Away view, or !answer 3 <choice> in the game; unanswered in 2 min 0 s: next.");
    expect(noteFor(ev('resource.low', { resource: 'food', left: 0, detail: 'no food carried' }))).toBeUndefined(); // notable
  });
});

describe('the rate limit', () => {
  it('three deaths in a minute are one note now and one folded note after the cooldown', () => {
    const l = new NoteLimiter();
    const t = 1_000_000;
    expect(l.offer(noteFor(died(t))!, t)?.title).toBe('the bot died');
    expect(l.offer(noteFor(died(t + 20_000))!, t + 20_000)).toBeUndefined();
    expect(l.offer(noteFor(died(t + 40_000))!, t + 40_000)).toBeUndefined();
    expect(l.due(t + 50_000)).toEqual([]);
    const later = l.due(t + NOTE_COOLDOWN_MS);
    expect(later.length).toBe(1);
    expect(later[0]).toMatchObject({ title: 'the bot died (2 times in 20 s)', n: 2 });
    expect(later[0]!.body).toMatch(/^The last: died/);
    expect(l.stats).toEqual({ offered: 3, sent: 2, folded: 2 });
  });

  it('at most NOTE_WINDOW_MAX notes in NOTE_WINDOW_MS over every kind; the rest wait for a place', () => {
    const l = new NoteLimiter();
    const t = 2_000_000;
    const kinds: EventKind[] = ['life.died', 'connection.kicked', 'connection.lost'];
    const sent: string[] = [];
    // three kinds in turn every 20 s: each kind once a minute (its cooldown allows it), 12 alerts in 4 minutes
    for (let i = 0; i < 12; i++) {
      const k = kinds[i % 3]!;
      const ms = t + i * 20_000;
      const e = k === 'life.died' ? died(ms) : k === 'connection.kicked' ? ev(k, { reason: 'r', message: 'm', willReconnect: true }, ms) : ev(k, { reason: 'r', kind: 'k' }, ms);
      const n = l.offer(noteFor(e)!, ms);
      if (n) sent.push(n.title);
      for (const d of l.due(ms)) sent.push(d.title);
    }
    expect(sent.length).toBe(NOTE_WINDOW_MAX);
    expect(l.waiting).toBe(3); // one folded note per kind
    expect(l.due(t + NOTE_WINDOW_MS - 1)).toEqual([]);
    const after = l.due(t + NOTE_WINDOW_MS + 4 * 20_000);
    expect(after.map((n) => n.n)).toEqual([3, 2, 2]); // the oldest folded first
    expect(after[0]!.title).toBe('the bot lost the connection for good (3 times in 2 min 0 s)');
  });

  it('a question skips the window and is never folded, with its own short cooldown', () => {
    const l = new NoteLimiter();
    const t = 3_000_000;
    for (let i = 0; i < NOTE_WINDOW_MAX; i++) l.offer({ ...noteFor(died(t))!, key: `k${i}` }, t + i);
    const ask = (id: number, ms: number) => noteFor(ev('ask.asked', { id, key: 'queue-fail', text: 'q', choices: ['a', 'b'], default: 'a', waitS: 60 }, ms))!;
    expect(l.offer(ask(1, t + 10), t + 10)?.ask).toBe(1);
    expect(l.offer(ask(2, t + 20), t + 20)).toBeUndefined(); // within its cooldown: waits
    expect(l.due(t + 10 + ASK_NOTE_COOLDOWN_MS).map((n) => n.ask)).toEqual([2]);
  });
});

/** A bus and an away block over it. */
function live(notify = true, now = () => Date.now()) {
  const bus = new EventBus();
  let on = notify;
  const box = new AskBox({ bus });
  let pushes = 0;
  const a = new AwayLive({ bus, source: { asks: () => box, notify: () => on }, changed: () => pushes++, now });
  return {
    bus,
    box,
    a,
    pushes: () => pushes,
    set: (v: boolean) => {
      on = v;
    },
  };
}

function fakeRes() {
  const r = { status: 0, headers: {} as Record<string, string>, body: '', done: undefined as unknown as Promise<void> };
  let res!: () => void;
  r.done = new Promise((x) => (res = x));
  return {
    r,
    res: {
      writeHead: (s: number, h: Record<string, string>) => {
        r.status = s;
        r.headers = h;
      },
      end: (b?: string) => {
        r.body = b ?? '';
        res();
      },
    },
  };
}

describe('the away block and its routes', () => {
  it('notes come only while notify is on; the mark follows the notable events; questions show with their deadline', () => {
    const { bus, box, a, pushes, set } = live(false);
    bus.emit('combat.kill', { mob: 'zombie' });
    expect(a.state().mark).toBe(0);
    bus.emit('life.died', { n: 1, cause: 'x', at });
    expect(a.state()).toMatchObject({ notify: false, notes: [], asks: [] });
    expect(a.state().mark).toBeGreaterThan(0);
    set(true);
    bus.emit('life.died', { n: 2, cause: 'x', at });
    expect(a.state().notes.map((n) => n.title)).toEqual(['the bot died']);
    const p = pushes();
    box.ask({ key: 'queue-fail', text: 'job #1 failed: retry it?', choices: [{ id: 'retry', label: 'retry it' }, { id: 'next', label: 'next' }], default: 'next', waitMs: 60_000 });
    expect(pushes()).toBeGreaterThan(p); // the box changed: the pages hear it at once
    const s = a.state();
    expect(s.asks[0]).toMatchObject({ id: 1, default: 'next', choices: [{ id: 'retry', n: 1 }, { id: 'next', n: 2 }] });
    expect(s.notes.at(-1)).toMatchObject({ title: 'the bot asks (#1)', ask: 1 });
    box.dispose();
    a.stop();
  });

  it('the state carries the newest STATE_NOTES notes; /api/away every kept one', async () => {
    let t = 10_000_000;
    const { bus, a } = live(true, () => t);
    for (let i = 0; i < NOTES_KEEP + 5; i++) {
      t += NOTE_WINDOW_MS; // a fresh window each time
      bus.emit('connection.kicked', { reason: `r${i}`, message: 'm', willReconnect: true });
    }
    expect(a.state().notes.length).toBe(STATE_NOTES);
    const { r, res } = fakeRes();
    expect(a.route()('/api/away', { method: 'GET', url: '/api/away' } as never, res as never)).toBe(true);
    await r.done;
    const got = JSON.parse(r.body) as PanelAway & { limiter: { sent: number } };
    expect(got.notes.length).toBe(NOTES_KEEP);
    expect(got.limiter.sent).toBe(NOTES_KEEP + 5);
    a.stop();
  });

  it('GET /api/timeline: the window by since or hours, the grouping, refusals; /sw.js is a service worker', async () => {
    const { bus, a } = live();
    bus.emit('queue.started', { id: 1, command: '!goto 1 2 3', by: 'Steve' });
    bus.emit('queue.failed', { id: 1, command: '!goto 1 2 3', end: 'goto: unreachable', durationS: 2 });
    bus.emit('life.died', { n: 1, cause: 'x', at });
    const get = async (url: string) => {
      const { r, res } = fakeRes();
      expect(a.route()(new URL(url, 'http://x').pathname, { method: 'GET', url } as never, res as never)).toBe(true);
      await r.done;
      return r;
    };
    const ok = await get(`${TIMELINE_PATH}?hours=1&group=job&tz=60`);
    expect(ok.status).toBe(200);
    const t = JSON.parse(ok.body) as { line: string; groups: { kind: string; state: string | null }[] };
    expect(t.line).toBe('0 jobs done, 1 failed, 1 death, 0 reconnects');
    expect(t.groups.map((g) => `${g.kind} ${g.state ?? ''}`)).toEqual(['hour ', 'job failed']);
    expect((await get(`${TIMELINE_PATH}?since=${Date.now() - 60_000}`)).status).toBe(200);
    expect((await get(`${TIMELINE_PATH}?since=12`)).status).toBe(400);
    expect((await get(`${TIMELINE_PATH}?hours=0`)).status).toBe(400);
    expect((await get(`${TIMELINE_PATH}?group=day`)).status).toBe(400);
    expect((await get(`${TIMELINE_PATH}?tz=9999`)).status).toBe(400);
    const sw = await get('/sw.js');
    expect(sw.headers['content-type']).toMatch(/javascript/);
    expect(sw.body).toContain("addEventListener('notificationclick'");
    const { r, res } = fakeRes();
    a.route()(TIMELINE_PATH, { method: 'POST', url: TIMELINE_PATH } as never, res as never);
    await r.done;
    expect(r.status).toBe(405);
    expect(a.route()('/api/other', { method: 'GET' } as never, res as never)).toBe(false);
    a.stop();
  });

  it('sizes: the away block in the lite state with four questions and three notes at their limits; the worst timeline', () => {
    const { bus, box, a } = live();
    const long = (n: number) => 'x'.repeat(n);
    for (let i = 0; i < 4; i++) box.ask({ key: `k${i}`, text: long(300), choices: Array.from({ length: 6 }, (_, j) => ({ id: `c${j}${long(10)}`, label: long(80), aliases: ['yes'] })), default: `c0${long(10)}`, waitMs: 60_000 });
    for (let i = 0; i < 3; i++) bus.emit('connection.lost', { reason: long(200), kind: long(40) });
    const block = a.state();
    const lite = liteState(fullState({ away: () => block }));
    const base = liteState(fullState());
    const added = bytes(lite) - bytes(base);
    show('away block in the lite state (4 questions, 3 notes)', added, PANEL_BUDGETS.away);
    expect(added).toBeLessThan(PANEL_BUDGETS.away);
    // a day: 24 one-hour jobs, each with 30 events of every kind's fold
    const list: BotEvent[] = [];
    let id = 1;
    const t0 = Date.now() - GROUPS_MAX * 3_600_000;
    for (let h = 0; h < GROUPS_MAX; h++) {
      const ts = t0 + h * 3_600_000;
      list.push({ id: id++, ts, kind: 'queue.started', sev: 'info', data: { id: h, command: `!get kit iron ${long(180)}`, by: 'AVeryLongGamerTg' } });
      for (let k = 0; k < 15; k++) list.push({ id: id++, ts: ts + k, kind: 'job.failed', sev: 'notable', data: { job: 'mine', reason: long(200), durationS: 1 } });
      for (let k = 0; k < 15; k++) list.push({ id: id++, ts: ts + 100 + k, kind: 'items.changed', sev: 'info', data: { gained: Object.fromEntries(Array.from({ length: 10 }, (_, j) => [`item_name_${j}_${long(20)}`, 64])), lost: {}, jobs: ['mine'], periodS: 60 } });
      list.push({ id: id++, ts: ts + 1000, kind: 'queue.failed', sev: 'notable', data: { id: h, command: `!get kit iron ${long(180)}`, end: long(200), durationS: 3000 } });
    }
    const t = buildTimeline(list, { since: t0, now: Date.now() });
    expect(t.groups.length).toBe(GROUPS_MAX);
    show('timeline (48 jobs, 10 head lines each at 160)', bytes(t), PANEL_BUDGETS.timeline);
    expect(bytes(t)).toBeLessThan(PANEL_BUDGETS.timeline);
    box.dispose();
    a.stop();
  });
});

describe('words of the view', () => {
  it('the countdown, the summary, what this device can do', () => {
    const now = 1_000_000;
    expect(askLeft({ id: 1, key: 'k', text: 't', choices: [], default: 'next', askedAt: now, until: now + 100_000 }, now)).toBe('1 min 40 s left, then: next');
    expect(askLeft({ id: 1, key: 'k', text: 't', choices: [], default: 'next', askedAt: now, until: now - 5 }, now)).toBe('0 s left, then: next');
    const t = { since: now - (3 * 3600 + 12 * 60) * 1000, line: '5 jobs done, 1 failed, 0 deaths, 1 reconnect', truncated: false } as never;
    expect(summaryText(t, 'look', false, now)).toBe('while away 3 h 12 min: 5 jobs done, 1 failed, 0 deaths, 1 reconnect');
    expect(summaryText(t, 'hours', false, now)).toBe('in the last 3 h 12 min: 5 jobs done, 1 failed, 0 deaths, 1 reconnect');
    expect(summaryText(t, 'look', true, now)).toMatch(/^in the last 3 h 12 min \(the first look from this browser\)/);
    const n = (secure: boolean, p: string): NotifyLike => ({ secure, permission: () => p, request: () => Promise.resolve(p), show: () => Promise.resolve(true), beep: () => true, unlock: () => undefined });
    expect(deviceText(undefined, true)).toMatch(/shows no notifications/);
    expect(deviceText(n(false, 'unsupported'), true)).toMatch(/^This page is http on a LAN or VPN address: browsers allow notifications only on a secure page/);
    expect(deviceText(n(true, 'denied'), true)).toMatch(/blocks notifications/);
    expect(deviceText(n(true, 'default'), true)).toMatch(/let the browser ask/);
    expect(deviceText(n(true, 'granted'), true)).toMatch(/a closed page gets none/);
  });
});

// ---- the view on the fake DOM ------------------------------------------------------------------------------------

const deep = (e: FakeEl): string => [e.textContent, ...e.children.map(deep)].join(' ');
const buttonsIn = (e: FakeEl): FakeEl[] => [...(e.tagName === 'BUTTON' || e.type === 'button' ? [e] : []), ...e.children.flatMap(buttonsIn)];

function awayBlock(over: Partial<PanelAway> = {}): PanelAway {
  const now = Date.now();
  return {
    notify: true,
    mark: 40,
    notes: [{ id: 1, ts: now - 5000, kind: 'life.died', event: 39, title: 'the bot died', body: 'died (zombie) at 1 64 2. It respawns by itself.', n: 1, ask: null }],
    asks: [{ id: 2, key: 'queue-fail', text: 'job #4 !goto 1 2 3 failed (unreachable): retry it, go on with the next, or pause the queue?', choices: [{ id: 'retry', label: 'retry it (next in line)', n: 1, yes: true, no: false }, { id: 'next', label: 'go on with the next', n: 2, yes: false, no: true }, { id: 'stop', label: 'pause the queue', n: 3, yes: false, no: false }], default: 'next', askedAt: now - 20_000, until: now + 100_000 }],
    ...over,
  };
}

const timelineAnswer = (since = Date.now() - 3_600_000) =>
  answer({
    since,
    to: Date.now(),
    group: 'job',
    total: 9,
    truncated: false,
    counts: {},
    line: '0 jobs done, 1 failed, 1 death, 0 reconnects',
    groups: [{ key: 'job:4:30', kind: 'job', title: '#4 !goto 1 2 3', from: Date.now() - 60_000, to: Date.now() - 1000, state: 'failed', end: 'goto: unreachable', head: [{ id: 39, ts: Date.now() - 5000, kind: 'life.died', sev: 'alert', text: 'died (zombie) at 1 64 2' }], moreHead: 0, folded: { n: 7, text: '3 commands, 4 item changes' }, ids: [30, 40], facts: '+cobblestone x32' }],
    olderGroups: 0,
  });

function fakeNotify(secure = true, permission = 'granted') {
  const shown: string[] = [];
  let beeps = 0;
  let unlocked = 0;
  const n: NotifyLike = { secure, permission: () => permission, request: () => Promise.resolve(permission), show: (t) => (shown.push(t), Promise.resolve(secure && permission === 'granted')), beep: () => (beeps++, true), unlock: () => void unlocked++ };
  return { n, shown, beeps: () => beeps, unlocked: () => unlocked };
}

/** A page; on the Away view the timeline fetch at start gets its answer first. */
const pageWith = (away: PanelAway | null, storage: Record<string, string> = {}, notify?: NotifyLike) =>
  runPage(renderPanelPage(fullState({ away: () => away ?? undefined })), { stream: true, storage, ...(notify ? { notify } : {}), ...(storage[VIEW_KEY] === 'away' ? { answers: [timelineAnswer()] } : {}) });

describe('the Away view (Track P5, fake DOM)', () => {
  it('is the fifth view: the header, map, storage and jobs switch to it; it loads the timeline from the last look', async () => {
    expect(VIEWS.at(-1)).toBe('away');
    const seen = String(Date.now() - 2 * 3_600_000);
    const h = pageWith(awayBlock(), { [SEEN_KEY]: seen });
    expect(h.doc.documentElement.dataset.view).toBe('cards');
    h.fetchQueue.push(timelineAnswer(Number(seen)));
    h.els.get('view-away')!.fire('click');
    await flush();
    expect(h.doc.documentElement.dataset.view).toBe('away');
    expect(h.fetched.at(-1)).toMatch(new RegExp(`^${TIMELINE_PATH}\\?since=${seen}&group=job&tz=-?\\d+$`));
    expect(h.els.get('aw-sum')!.textContent).toBe('while away 2 h 0 min: 0 jobs done, 1 failed, 1 death, 0 reconnects');
    const tl = h.els.get('aw-tl')!;
    expect(deep(tl)).toMatch(/failed #4 !goto 1 2 3 .*goto: unreachable .*died \(zombie\) at 1 64 2 .*\+cobblestone x32 .*7 more: 3 commands, 4 item changes/);
    for (const id of ['view-away-m', 'st-away', 'jb-away']) expect(h.els.get(id)!.dataset.goview).toBe('away');
    // leaving the view: the next look starts now
    h.els.get('aw-map')!.fire('click');
    expect(Number(h.storage.get(SEEN_KEY))).toBeGreaterThan(Number(seen));
  });

  it('a folded group fetches its every line on a tap; the window and the grouping refetch', async () => {
    const h = pageWith(awayBlock(), { [VIEW_KEY]: 'away' });
    await flush();
    const tl = h.els.get('aw-tl')!;
    const fold = buttonsIn(tl).find((b) => (b.textContent ?? '').startsWith('7 more'))!;
    h.fetchQueue.push(answer({ events: [{ id: 31, ts: Date.now(), sev: 'info', kind: 'command.received', text: 'command !goto 1 2 3 from panel' }], more: false }));
    fold.fire('click');
    await flush();
    expect(h.fetched.at(-1)).toBe('/api/events?since=29&until=40&limit=200');
    expect(deep(tl)).toContain('command !goto 1 2 3 from panel');
    h.fetchQueue.push(timelineAnswer(Date.now() - 24 * 3_600_000));
    h.els.get('aw-since')!.value = '24';
    h.els.get('aw-since')!.fire('change');
    await flush();
    expect(h.fetched.at(-1)).toMatch(/^\/api\/timeline\?since=\d+&group=job/);
    expect(h.els.get('aw-sum')!.textContent).toMatch(/^in the last 24 h 0 min: /);
    h.fetchQueue.push(timelineAnswer());
    h.els.get('aw-group')!.value = 'hour';
    h.els.get('aw-group')!.fire('change');
    await flush();
    expect(h.fetched.at(-1)).toMatch(/group=hour/);
  });

  it('a question is a card with its choices and countdown; a tap sends !answer; the default is marked', async () => {
    const h = pageWith(awayBlock(), { [VIEW_KEY]: 'away' });
    await flush();
    const asks = h.els.get('aw-asks')!;
    expect(deep(asks)).toMatch(/#2 job #4 !goto 1 2 3 failed \(unreachable\): retry it, go on with the next, or pause the queue\? .*1 retry it \(next in line\) .*2 go on with the next .*3 pause the queue .*1 min 4\d s left, then: next/);
    const b = buttonsIn(asks);
    expect(b.map((x) => x.className)).toEqual(['', 'primary', '']);
    h.fetchQueue.push(answer({ ok: true, command: '', replies: ['ask: #2 answered: retry'] }));
    b[0]!.fire('click');
    await flush();
    expect(h.posted.at(-1)).toBe('!answer 2 retry');
    expect(h.els.get('aw-reply')!.textContent).toBe('> !answer 2 retry\nask: #2 answered: retry');
    // the question answered: the next state has none
    h.streams[0]!.emit('state', { snap: liteState(fullState({ away: () => awayBlock({ asks: [] }) })) }, 'b.2');
    expect(deep(h.els.get('aw-asks')!)).toContain('no question waits');
  });

  it('on the other views a banner and the tab title say what waits; Open goes to the view', () => {
    const h = pageWith(awayBlock(), { [SEEN_KEY]: String(Date.now() - 60_000) });
    expect(h.els.get('awaybar')!.hidden).toBe(false);
    expect(h.els.get('awaybar-t')!.textContent).toMatch(/^the bot asks: job #4 .* \(\+1\)$/);
    expect(h.els.get('view-away')!.textContent).toBe('Away 2');
    expect((h.started.page.ui.doc as { title?: string }).title).toBe('(2) BedrockBot panel');
    h.fetchQueue.push(timelineAnswer());
    h.els.get('awaybar-go')!.fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('away');
    expect(h.els.get('awaybar')!.hidden).toBe(true);
    // nothing waits: no banner, the plain title
    const q = pageWith(awayBlock({ asks: [], notes: [] }));
    expect(q.els.get('awaybar')!.hidden).toBe(true);
    expect((q.started.page.ui.doc as { title?: string }).title).toBe('BedrockBot panel');
  });

  it('the switches: the bot\'s sends !set notify; the device\'s is kept here and asks the browser on a tap', async () => {
    const f = fakeNotify(true, 'default');
    const h = pageWith(awayBlock({ notify: false }), { [VIEW_KEY]: 'away' }, f.n);
    await flush();
    expect(h.els.get('aw-bot')!.checked).toBe(false);
    h.fetchQueue.push(answer({ ok: true, command: '', replies: ['notify = true'] }));
    h.els.get('aw-bot')!.checked = true;
    h.els.get('aw-bot')!.fire('change');
    await flush();
    expect(h.posted.at(-1)).toBe('!set notify on');
    expect(h.els.get('aw-note')!.textContent).toMatch(/^Turn the switch on/);
    h.els.get('aw-dev')!.checked = true;
    h.els.get('aw-dev')!.fire('change');
    expect(h.storage.get(NOTIFY_KEY)).toBe('1');
    expect(f.unlocked()).toBe(1);
    expect(h.els.get('aw-note')!.textContent).toMatch(/let the browser ask/);
  });

  it('a new note is a system notification once (kept across a reload); over http a tone instead; the first look pings nothing', () => {
    const now = Date.now();
    const note = (id: number, ts: number) => ({ id, ts, kind: 'life.died', event: id, title: `note ${id}`, body: 'b', n: 1, ask: null });
    const f = fakeNotify(true, 'granted');
    const h = pageWith(awayBlock({ notes: [note(1, now - 9000)] }), { [NOTIFY_KEY]: '1' }, f.n);
    expect(f.shown).toEqual([]); // the first look: listed, not pinged
    expect(h.storage.get(NOTED_KEY)).toBe(String(now - 9000));
    h.streams[0]!.emit('state', { snap: liteState(fullState({ away: () => awayBlock({ notes: [note(1, now - 9000), note(2, now - 1000)] }) })) }, 'b.2');
    expect(f.shown).toEqual(['note 2']);
    h.streams[0]!.emit('state', { snap: liteState(fullState({ away: () => awayBlock({ notes: [note(1, now - 9000), note(2, now - 1000)], mark: 41 }) })) }, 'b.3');
    expect(f.shown).toEqual(['note 2']); // once
    // a reload: the stored marker; the device switch off: nothing
    const again = pageWith(awayBlock({ notes: [note(2, now - 1000), note(3, now - 500)] }), { [NOTED_KEY]: String(now - 1000) }, f.n);
    expect(f.shown).toEqual(['note 2']);
    expect(again.storage.get(NOTED_KEY)).toBe(String(now - 500));
    // over http on a LAN address: show() fails, the tone plays
    const http = fakeNotify(false, 'unsupported');
    pageWith(awayBlock({ notes: [note(3, now - 500), note(4, now - 100)] }), { [NOTED_KEY]: String(now - 500), [NOTIFY_KEY]: '1' }, http.n);
    return flush().then(() => {
      expect(http.shown).toEqual(['note 4']);
      expect(http.beeps()).toBe(1);
    });
  });

  it('Track D3: the Discord section reads /api/away while the view shows: the webhook\'s and the bot\'s lines, again every AWAY_DISCORD_MS, never once the view is left', async () => {
    const h = pageWith(awayBlock(), { [VIEW_KEY]: 'away' });
    await flush();
    const t = h.timers.find((x) => x.ms === 0)!;
    expect(t).toBeDefined();
    const before = h.fetched.length;
    const body = {
      discord: 'discord: on; webhook set (discord-webhook.url); 3 sent, 0 failed',
      discordBot: ['discord bot: on, ready as FakeBot (12 s); 2 users (...1111, ...1212), 1 channel (...3333), notes to dm', 'discord bot: 4 in, 3 out; 1 ignored (strangers, other channels), 0 refused', 'discord bot: text commands on; slash commands 6 for DMs and 1 server; 2 run, 5 autocompletes'],
    };
    h.fetchQueue.push(answer(body));
    t.fn();
    await flush();
    expect(h.fetched.slice(before)).toEqual(['/api/away']);
    const box = h.els.get('aw-discord')!;
    expect(box.children.map(deep).map((s) => s.replace(/\s+/g, ' ').trim())).toEqual([
      'webhook on; webhook set (discord-webhook.url); 3 sent, 0 failed',
      'bot on, ready as FakeBot (12 s); 2 users (...1111, ...1212), 1 channel (...3333), notes to dm',
      'bot 4 in, 3 out; 1 ignored (strangers, other channels), 0 refused',
      'bot text commands on; slash commands 6 for DMs and 1 server; 2 run, 5 autocompletes',
    ]);
    const again = h.timers.filter((x) => x.ms === AWAY_DISCORD_MS);
    expect(again).toHaveLength(1);
    // a failed read says so; then the view is left: the timer that fires reads nothing
    h.fetchQueue.push(() => Promise.resolve({ status: 500, ok: false, text: () => Promise.resolve('{}'), json: () => Promise.resolve({}) }));
    again[0]!.fn();
    await flush();
    expect(deep(box)).toMatch(/not loaded \(.*500/);
    h.fetchQueue.push(timelineAnswer());
    h.els.get('aw-map')!.fire('click');
    const n = h.fetched.length;
    for (const x of h.timers.filter((y) => y.ms === AWAY_DISCORD_MS)) x.fn();
    await flush();
    expect(h.fetched.length).toBe(n);
    // an old bot without either: said so
    expect(discordRows({})).toEqual([]);
    expect(discordRows(null)).toEqual([]);
  });

  it('Track D3: /api/away carries the webhook\'s line and every sink\'s status lines; none without them', async () => {
    const bus = new EventBus();
    const box = new AskBox({ bus });
    const sink = { send: () => Promise.resolve('sent' as const), statusLines: () => ['discord bot: off', 'discord bot: 0 in, 0 out'] };
    const a = new AwayLive({ bus, source: { asks: () => box, notify: () => true }, discord: { statusLine: () => 'discord: off', stop: () => undefined } as never, sinks: [sink as never] });
    const { r, res } = fakeRes();
    a.route()('/api/away', { method: 'GET', url: '/api/away' } as never, res as never);
    await r.done;
    expect(JSON.parse(r.body)).toMatchObject({ discord: 'discord: off', discordBot: ['discord bot: off', 'discord bot: 0 in, 0 out'] });
    const plain = live();
    const p = fakeRes();
    plain.a.route()('/api/away', { method: 'GET', url: '/api/away' } as never, p.res as never);
    await p.r.done;
    expect(JSON.parse(p.r.body)).not.toHaveProperty('discordBot');
    a.stop();
    plain.a.stop();
    box.dispose();
    plain.box.dispose();
  });

  it('a page without the away block (an old bot) leaves the view empty and the banner hidden', () => {
    const h = pageWith(null);
    expect(h.els.get('awaybar')!.hidden).toBe(true);
    expect(h.els.get('view-away')!.textContent).toBe('Away');
  });

  it('phone width: the rows wrap, nothing is wider than a phone, the buttons are touch sized', () => {
    const html = renderPanelPage(fullState());
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const rules = css.split('\n').filter((l) => /#away|\.aw|\.awaybar/.test(l));
    expect(rules.length).toBeGreaterThan(5);
    for (const r of rules) for (const m of r.matchAll(/(?:^|[^-])width:\s*(\d+)px/g)) expect(Number(m[1]), r).toBeLessThanOrEqual(320);
    for (const sel of ['.awtools', '.awgh', '.awask .acts, .awfold']) expect(rules.some((r) => r.includes(`${sel} {`) && r.includes('flex-wrap: wrap')), sel).toBe(true);
    expect(rules.some((r) => /\.awask button, \.awfold button \{[^}]*min-height: 3[4-9]px/.test(r))).toBe(true);
    expect(rules.some((r) => /\.awaybar \{[^}]*left: 8px; right: 8px/.test(r))).toBe(true);
    expect(rules.filter((r) => r.includes('overflow-wrap: anywhere')).length).toBeGreaterThan(3);
    expect(html).toMatch(/<div id="away" class="storescreen">/);
    // Track D3: the Discord lines wrap anywhere and never widen the column
    expect(rules.some((r) => /\.awdc \{[^}]*overflow-wrap: anywhere[^}]*min-width: 0/.test(r))).toBe(true);
    expect(html).toContain('<h2>Discord</h2><div id="aw-discord" class="awdc"></div>');
  });
});
