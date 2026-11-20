// Track P4 (docs/panel.md "Jobs", docs/queue.md): the `jobs` topic and GET /api/jobs (health/panel/jobs.ts), their
// byte budgets on a worst-case queue, and the Jobs view on the fake DOM of panel-dom.ts (the fourth view, the add
// box, up / down / remove, Pause / Resume / Clear, the failure rule, Retry, the goals' switches, the Queue buttons
// of the map's sheet, storage and Bring, the poll without a stream, and the rules that keep it usable at phone width).
import { describe, expect, it } from 'vitest';
import { diffJson, type Json } from '../../../src/health/panel/client/delta.ts';
import { goalText, queueLine } from '../../../src/health/panel/client/jobs.ts';
import { PANEL_BUDGETS } from '../../../src/health/panel/budgets.ts';
import { JobsLive, TOPIC_ENDED } from '../../../src/health/panel/jobs.ts';
import { renderPanelPage } from '../../../src/health/panel/page.ts';
import { JOBS_PATH, JOBS_POLL_MS, VIEW_KEY, VIEWS, type JobsSummary } from '../../../src/health/panel/shared.ts';
import { StreamHub } from '../../../src/health/panel/stream.ts';
import { DEFAULT_GOALS, registerGoal, StandingGoals } from '../../../src/tasks/goals.ts';
import type { Process, ProcessManager } from '../../../src/tasks/process/manager.ts';
import { COMMAND_MAX, HISTORY_KEEP, JobQueue, LINE_MAX, QUEUE_MAX, type QueueData, type QueueJob } from '../../../src/tasks/queue.ts';
import { answer, flush, runPage, type FakeEl, type Harness } from './panel-dom.ts';
import { fullState } from './panel-fixtures.ts';

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
const show = (what: string, n: number, budget: number): void => {
  if (process.env.PANEL_MEASURE) process.stdout.write(`panel budget: ${what} ${n} bytes (budget ${budget})\n`);
};

const long = (head: string, n: number): string => `${head} ${'x'.repeat(Math.max(0, n - head.length - 1))}`;

/** The worst case the topic can carry: 32 waiting jobs of 200 characters, the newest ended with 200-character end lines, a running job with a long line, every goal on with a long last line. */
function worstCase() {
  const now = Date.now();
  const jobs: QueueJob[] = [];
  let id = 1;
  for (let i = 0; i < HISTORY_KEEP; i++) jobs.push({ id: id++, command: long('!get kit iron', COMMAND_MAX), by: 'AVeryLongGamerTg', via: 'panel', addedAt: now - 9e6, startedAt: now - 8e6, endedAt: now - 7e6, state: i % 2 ? 'failed' : 'done', end: long('get iron_pickaxe: done in 12 min 3 s, 9 steps', LINE_MAX), how: 'job' });
  for (let i = 0; i < QUEUE_MAX + 1; i++) jobs.push({ id: id++, command: long(`!goto ${i} 64 -${i}`, COMMAND_MAX), by: 'AVeryLongGamerTg', via: 'chat', addedAt: now - 1000, state: 'waiting' });
  const saved: QueueData = { v: 1, paused: false, onFail: 'next', nextId: id, jobs };
  const proc = { name: 'goto', kind: 'user', priority: 40, done: false, result: new Promise(() => undefined), status: () => ({ line: long('walking to 100 64 -50: 120 blocks left, ETA 1 min 4 s', 160) }) } as unknown as Process;
  let started = false;
  const users: Process[] = [];
  const q = new JobQueue(
    {
      run: () => {
        started = true;
        users.push(proc);
        return true;
      },
      has: () => true,
      userProcesses: () => users,
      stopProcess: () => undefined,
      active: () => users[0],
      holders: [],
      ready: () => true,
      say: () => undefined,
    },
    saved,
  );
  // the first waiting job runs: the gap first, then one watch tick sees its process
  const t0 = Date.now();
  q.tick(t0);
  q.tick(t0 + 6000);
  q.tick(t0 + 6250);
  expect(started).toBe(true);
  const task = {};
  registerGoal(task, { id: 'mend', label: 'mending', setting: 'autoFood', process: 'mendchore', target: () => long('the elytra under 50 %', 80) });
  const controls: ((e: { kind: 'control'; from: string | undefined; to: string | undefined }) => void)[] = [];
  let active: Process | undefined;
  const chores = DEFAULT_GOALS.map((g) => ({ name: g.process, kind: 'auto', priority: 30, status: () => ({ line: long(`${g.id} chore`, 120) }), last: undefined }) as unknown as Process);
  const pm: Pick<ProcessManager, 'find' | 'onControl' | 'active'> = {
    find: (n: string) => chores.filter((c) => c.name === n),
    onControl: (fn) => {
      controls.push(fn);
      return () => undefined;
    },
    get active() {
      return active;
    },
  };
  const goals = new StandingGoals({
    task,
    settings: () => true,
    processes: pm,
    queue: () => ({ running: true, waiting: q.waiting().length }),
  });
  // every chore ran once: a long last line each
  for (const c of chores) {
    active = c;
    for (const f of controls) f({ kind: 'control', from: undefined, to: c.name });
    (c as unknown as { status: () => { line: string } }).status = () => ({ line: long(`${c.name}: the last run's line`, 400) });
    active = undefined;
    for (const f of controls) f({ kind: 'control', from: c.name, to: undefined });
  }
  return { q, goals, users, proc, t: t0 + 6250 };
}

describe('jobs topic (Track P4)', () => {
  it('a snapshot of the worst case and the delta when a job ends and the next starts are within their budgets', () => {
    const { q, goals, users, proc, t } = worstCase();
    const hub = new StreamHub({ boot: 'x' });
    const live = new JobsLive({ hub, source: { queue: () => q, goals: () => goals, runAs: () => 'AVeryLongGamerTg' } });
    const snap = live.summary();
    expect(snap.queue?.waiting.length).toBe(QUEUE_MAX);
    expect(snap.queue?.ended.length).toBe(TOPIC_ENDED);
    expect(snap.goals.length).toBe(DEFAULT_GOALS.length + 1);
    expect(snap.goals.every((g) => (g.lastLine ?? '').length <= LINE_MAX)).toBe(true);
    const n = bytes({ snap });
    show('jobs snapshot (32 waiting, 10 ended, 9 goals)', n, PANEL_BUDGETS.jobs);
    expect(n).toBeLessThan(PANEL_BUDGETS.jobs);
    // the job ends, the next starts (after its gap)
    (proc as unknown as { done: boolean }).done = true;
    users.length = 0;
    for (let s = 250; s <= 4000; s += 250) q.tick(t + s);
    expect(q.get(HISTORY_KEEP + 1)?.state).toBe('done');
    const mid = live.summary();
    for (let s = 4250; s <= 12_000; s += 250) q.tick(t + s);
    const next = live.summary();
    expect(next.queue?.running?.id).toBe(HISTORY_KEEP + 2);
    const d1 = bytes({ d: diffJson(snap as unknown as Json, mid as unknown as Json) });
    const d2 = bytes({ d: diffJson(mid as unknown as Json, next as unknown as Json) });
    show('jobs delta (a job ended)', d1, PANEL_BUDGETS.jobsDelta);
    show('jobs delta (the next started)', d2, PANEL_BUDGETS.jobsDelta);
    expect(d1).toBeLessThan(PANEL_BUDGETS.jobsDelta);
    expect(d2).toBeLessThan(PANEL_BUDGETS.jobsDelta);
    live.stop();
    hub.close();
  });

  it('GET /api/jobs answers the summary; another method is refused; no queue: on false', () => {
    const hub = new StreamHub({ boot: 'x' });
    const { q, goals } = worstCase();
    const src: { queue: JobQueue | undefined } = { queue: undefined };
    const live = new JobsLive({ hub, source: { queue: () => src.queue, goals: () => goals, runAs: () => null } });
    const call = (method: string) => {
      const out = { status: 0, body: '' };
      const res = { writeHead: (s: number) => (out.status = s), end: (b?: string) => (out.body = b ?? '') };
      const hit = live.route()(JOBS_PATH, { method, url: JOBS_PATH } as never, res as never);
      return { hit, ...out };
    };
    expect(live.route()('/api/other', { method: 'GET' } as never, {} as never)).toBe(false);
    expect((JSON.parse(call('GET').body) as JobsSummary).on).toBe(false);
    src.queue = q;
    const got = JSON.parse(call('GET').body) as JobsSummary;
    expect(got.on).toBe(true);
    expect(got.queue?.running?.command).toMatch(/^!goto 0 64 -0/);
    expect(call('POST').status).toBe(405);
    live.stop();
    hub.close();
  });

  it('a queue change refreshes the topic (one refresh for a burst)', async () => {
    const hub = new StreamHub({ boot: 'x' });
    const q = new JobQueue({ run: () => true, has: () => true, userProcesses: () => [], stopProcess: () => undefined, active: () => undefined, holders: [], ready: () => true, say: () => undefined });
    const live = new JobsLive({ hub, source: { queue: () => q, goals: () => undefined, runAs: () => null } });
    q.add('!goto 1 2 3', 'Steve', 'chat');
    q.add('!goto 4 5 6', 'Steve', 'chat');
    await new Promise((r) => setTimeout(r, 300));
    expect(live.stats.refreshes).toBe(1);
    live.stop();
    hub.close();
  });
});

// ---- the view on the fake DOM ------------------------------------------------------------------------------------

const job = (id: number, state: string, command: string, more: Record<string, unknown> = {}) => ({ id, command, by: 'Owner', via: 'panel', state, addedAt: Date.now() - 60_000, startedAt: null, endedAt: null, end: null, ...more });
const summary = (over: Partial<NonNullable<JobsSummary['queue']>> = {}): JobsSummary => ({
  on: true,
  me: 'Owner',
  queue: {
    paused: false,
    why: null,
    onFail: 'next',
    running: { ...job(3, 'running', '!goto 1 2 3', { startedAt: Date.now() - 20_000 }), line: 'walking: 40 blocks left' },
    waiting: [job(4, 'waiting', '!get bed'), job(5, 'waiting', '!fly home')],
    ended: [job(2, 'failed', '!goto 9 9 9', { startedAt: Date.now() - 90_000, endedAt: Date.now() - 80_000, end: 'goto: unreachable' })],
    hold: null,
    ...over,
  } as JobsSummary['queue'],
  goals: [
    { id: 'milk', label: 'milk buckets', setting: 'autoMilk', on: false, target: '2 milk buckets', running: false, lastAt: null, lastS: null, lastLine: null, relation: 'off' },
    { id: 'food', label: 'food reserve', setting: 'autoFood', on: true, target: 'at least 10 hunger points carried', running: false, lastAt: Date.now() - 120_000, lastS: 30, lastLine: 'food: done (full), 4 items, 2 killed', relation: 'waits for the queue' },
  ],
});

const ok = (replies: string[]) => answer({ ok: true, command: '', replies });
const deep = (e: FakeEl): string => [e.textContent, ...e.children.map(deep)].join(' ');
const buttonsIn = (e: FakeEl): FakeEl[] => [...(e.tagName === 'BUTTON' || e.type === 'button' ? [e] : []), ...e.children.flatMap(buttonsIn)];
const button = (e: FakeEl, label: string): FakeEl => buttonsIn(e).find((b) => b.textContent === label)!;
const inputsIn = (e: FakeEl): FakeEl[] => [...(e.type === 'checkbox' ? [e] : []), ...e.children.flatMap(inputsIn)];

const openJobs = (stream = true): Harness => runPage(renderPanelPage(fullState()), { stream, storage: { [VIEW_KEY]: 'jobs' } });

describe('the Jobs view (Track P4, fake DOM)', () => {
  it('is the fourth view: remembered, switched to and from, the topic joined', () => {
    expect(VIEWS).toEqual(['map', 'cards', 'storage', 'jobs']);
    const h = openJobs();
    expect(h.doc.documentElement.dataset.view).toBe('jobs');
    expect(h.streams[0]!.url).toBe('/api/stream?topics=state,jobs');
    h.els.get('jb-map')!.fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('map');
    h.els.get('view-jobs-m')!.fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('jobs');
    h.els.get('jb-storage')!.fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('storage');
    h.els.get('st-jobs')!.fire('click');
    expect(h.storage.get(VIEW_KEY)).toBe('jobs');
    h.els.get('jb-cards')!.fire('click');
    h.els.get('view-jobs')!.fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('jobs');
  });

  it('renders the queue and the goals from the topic, and a delta', () => {
    const h = openJobs();
    h.streams[0]!.emit('jobs', { snap: summary() }, 'b.1');
    expect(h.els.get('jb-state')!.textContent).toBe('running');
    expect(deep(h.els.get('jb-run')!)).toMatch(/running #3 !goto 1 2 3 Stop walking: 40 blocks left · since 20 s ago/);
    const wait = h.els.get('jb-wait')!;
    expect(wait.children.map((r) => r.dataset.job)).toEqual(['4', '5']);
    expect(deep(wait)).toContain('added by Owner (panel) 1 min ago');
    expect(button(wait.children[0]!, '↑').disabled).toBe(true);
    expect(button(wait.children[1]!, '↓').disabled).toBe(true);
    expect(deep(h.els.get('jb-ended')!)).toMatch(/failed #2 !goto 9 9 9 Retry goto: unreachable in 10 s · 1 min ago/);
    const goals = h.els.get('jb-goals')!;
    expect(goals.children.map((r) => r.dataset.goal)).toEqual(['milk', 'food']);
    expect(inputsIn(goals).map((b) => b.checked)).toEqual([false, true]);
    expect(deep(goals.children[1]!)).toContain('at least 10 hunger points carried · waits for the queue · last 2 min ago (30 s): food: done (full), 4 items, 2 killed');
    expect(h.els.get('jb-pause')!.hidden).toBe(false);
    expect(h.els.get('jb-resume')!.hidden).toBe(true);
    // paused, nothing running: a delta
    h.streams[0]!.emit('jobs', { d: [['s', ['queue', 'paused'], true], ['s', ['queue', 'why'], '!goto was typed'], ['s', ['queue', 'running'], null], ['s', ['queue', 'hold'], 'paused (!goto was typed)']] }, 'b.2');
    expect(h.els.get('jb-state')!.textContent).toBe('paused (!goto was typed): paused (!goto was typed)');
    expect(h.els.get('jb-resume')!.hidden).toBe(false);
    expect(h.els.get('jb-run')!.children.length).toBe(0);
  });

  it('every action is the chat command: add (with the prefix or not), move, remove, stop, retry, pause, resume, clear, the failure rule, a goal switch', async () => {
    const h = openJobs();
    h.streams[0]!.emit('jobs', { snap: summary() }, 'b.1');
    const act = async (fn: () => void): Promise<string> => {
      h.fetchQueue.push(ok(['queue: ...']));
      fn();
      await flush();
      return h.posted.at(-1)!;
    };
    const cmd = h.els.get('jb-cmd')!;
    expect(
      await act(() => {
        cmd.value = 'get kit iron';
        h.els.get('jb-form')!.fire('submit');
      }),
    ).toBe('!queue add get kit iron');
    expect(cmd.value).toBe('');
    expect(h.els.get('jb-reply')!.textContent).toBe('> !queue add get kit iron\nqueue: ...');
    const wait = h.els.get('jb-wait')!;
    expect(await act(() => button(wait.children[1]!, '↑').fire('click'))).toBe('!queue move 5 1');
    expect(await act(() => button(wait.children[0]!, '↓').fire('click'))).toBe('!queue move 4 2');
    expect(await act(() => button(wait.children[0]!, '×').fire('click'))).toBe('!queue remove 4');
    expect(await act(() => button(h.els.get('jb-run')!, 'Stop').fire('click'))).toBe('!queue remove 3');
    expect(await act(() => button(h.els.get('jb-ended')!, 'Retry').fire('click'))).toBe('!queue retry 2');
    expect(await act(() => h.els.get('jb-pause')!.fire('click'))).toBe('!queue pause');
    expect(await act(() => h.els.get('jb-resume')!.fire('click'))).toBe('!queue resume');
    expect(await act(() => h.els.get('jb-clear')!.fire('click'))).toBe('!queue clear');
    expect(
      await act(() => {
        h.els.get('jb-onfail')!.value = 'stop';
        h.els.get('jb-onfail')!.fire('change');
      }),
    ).toBe('!queue onfail stop');
    const sw = inputsIn(h.els.get('jb-goals')!)[0]!;
    expect(
      await act(() => {
        sw.checked = true;
        sw.fire('change');
      }),
    ).toBe('!set autoMilk on');
  });

  it('the add box has the palette; Queue on the map sheet, the storage confirm and Bring send !queue add', async () => {
    const h = openJobs();
    h.fetchQueue.push(answer({ commands: [{ name: 'get', tier: 'front', syntax: '<item>', help: 'get it' }, { name: 'goto', tier: 'more', syntax: '<x y z>', help: 'walk' }] }));
    const cmd = h.els.get('jb-cmd')!;
    cmd.fire('focus');
    await flush();
    cmd.value = 'g';
    cmd.fire('input');
    expect(h.els.get('jb-pal')!.hidden).toBe(false);
    expect(deep(h.els.get('jb-pal')!)).toContain('!get');
    expect(queueLine(' !bring diamond 4 ')).toBe('!queue add !bring diamond 4');
    // storage's confirm (the scan) and its Queue
    h.els.get('jb-storage')!.fire('click');
    h.els.get('st-scan')!.fire('click');
    h.fetchQueue.push(ok(['queue: added #7 !chests scan (1 of 1)']));
    h.els.get('st-queue')!.fire('click');
    await flush();
    expect(h.posted.at(-1)).toBe('!queue add !chests scan');
    expect(h.els.get('st-reply')!.textContent).toBe('> !queue add !chests scan\nqueue: added #7 !chests scan (1 of 1)');
    expect(h.els.get('st-confirm')!.hidden).toBe(true);
  });

  it('without a stream it polls /api/jobs while it shows', async () => {
    const h = openJobs(false);
    expect(h.fetched).toContain(JOBS_PATH);
    const t = h.timers.filter((x) => x.ms === JOBS_POLL_MS).at(-1)!;
    expect(t).toBeDefined();
    h.fetchQueue.push(answer(summary()));
    t.fn();
    await flush();
    expect(h.els.get('jb-wait')!.children.length).toBe(2);
  });

  it('no queue (the bot without walking) says so', () => {
    const h = openJobs();
    h.streams[0]!.emit('jobs', { snap: { on: false, queue: null, goals: [], me: null } }, 'b.1');
    expect(h.els.get('jb-state')!.textContent).toBe('(no queue: the bot needs --walk)');
  });

  it('goal lines', () => {
    expect(goalText({ id: 'x', label: 'x', setting: 'autoMilk', on: true, target: null, running: true, lastAt: Date.now(), lastS: null, lastLine: 'x', relation: 'queue waits' })).toBe('running: the queue waits for it');
  });

  it('phone width: the rows wrap, nothing is wider than a phone, the buttons are touch sized', () => {
    const html = renderPanelPage(fullState());
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const rules = css.split('\n').filter((l) => /#jobs|\.jb\b|\.jbtools|\.jb /.test(l));
    expect(rules.length).toBeGreaterThan(2);
    for (const r of rules) for (const m of r.matchAll(/(?:^|[^-])width:\s*(\d+)px/g)) expect(Number(m[1]), r).toBeLessThanOrEqual(320);
    expect(rules.some((r) => /\.jb \{[^}]*flex-wrap: wrap/.test(r))).toBe(true);
    expect(rules.some((r) => /\.jbtools \{[^}]*flex-wrap: wrap/.test(r))).toBe(true);
    expect(rules.some((r) => /\.jb button \{[^}]*min-height: 3[4-9]px/.test(r))).toBe(true);
    expect(rules.some((r) => r.includes('overflow-wrap: anywhere'))).toBe(true);
    // the screen itself is the storage layer (fixed, scrolls, max 900 wide, padded)
    expect(html).toMatch(/<div id="jobs" class="storescreen">/);
  });
});
