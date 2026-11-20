// The Jobs view (Track P4, docs/panel.md "Jobs", docs/queue.md): the fourth view beside the map, the cards and
// storage, phone first. The add box (with the command palette) queues a command; the queue shows the running job
// with its live line and a Stop, the waiting jobs with up / down / remove, Pause / Resume / Clear and the failure
// rule; the ended jobs show their state and end line with Retry; the standing goals show their switch (a `!set`),
// target, last run and how they share the body with the queue. Every action is a chat command (POST /api/cmd), the
// one the game's chat takes. The `jobs` topic keeps it current while the page streams; without the stream the view
// polls GET /api/jobs while it shows. The map's sheet, the storage view and the Bring picker queue their command
// with queueLine().
import { JOBS_PATH, JOBS_POLL_MS, JOBS_TOPIC, type GoalView, type JobsSummary, type QueueJobView } from '../shared.ts';
import { applyDelta, type DeltaOp, type Json } from './delta.ts';
import { dur, why, type El } from './dom.ts';
import type { Page } from './page.ts';
import type { Views } from './views.ts';

/** The chat command that queues `cmd` (the map's, storage's and Bring's Queue buttons). */
export function queueLine(cmd: string): string {
  return `!queue add ${cmd.trim()}`;
}

const ago = (ts: number | null): string => (ts ? `${dur(Math.max(0, Date.now() - ts) / 1000)} ago` : '');
const took = (j: QueueJobView): string => (j.startedAt && j.endedAt ? ` in ${dur(Math.max(0, j.endedAt - j.startedAt) / 1000)}` : '');

/** `!goto 1 2 3 (by Steve, panel)`. */
export function jobTitle(j: QueueJobView): string {
  return `#${j.id} ${j.command}`;
}

/** The goal's line under its name: target, relation, last run. */
export function goalText(g: GoalView): string {
  const parts: string[] = [];
  if (g.target) parts.push(g.target);
  if (g.relation === 'running') parts.push('running now');
  else if (g.relation === 'queue waits') parts.push('running: the queue waits for it');
  else if (g.relation === 'waits for the queue') parts.push('waits for the queue');
  if (!g.running && g.lastAt) parts.push(`last ${ago(g.lastAt)}${g.lastS !== null ? ` (${dur(g.lastS)})` : ''}${g.lastLine ? `: ${g.lastLine}` : ''}`);
  return parts.join(' · ');
}

export interface JobsView {
  /** The last summary (tests). */
  summary(): JobsSummary | null;
}

export function setupJobs(page: Page, views: Views, palette: (input: El, pal: El) => void): JobsView {
  const { ui } = page;
  const env = ui.env;
  const el = (id: string): El => ui.need(id);
  const input = el('jb-cmd');
  const replyEl = el('jb-reply');
  let sum: JobsSummary | null = null;
  let shown = false;
  let joined = false;
  let pollT: unknown = 0;

  palette(input, el('jb-pal'));
  const send = (cmd: string): void => {
    replyEl.textContent = `> ${cmd}\n...`;
    void page.send(cmd).then((out) => {
      replyEl.textContent = `> ${cmd}\n${out}`;
      if (!page.streaming()) refresh();
    });
  };
  el('jb-form').addEventListener('submit', (ev) => {
    ev?.preventDefault?.();
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    send(queueLine(v));
  });
  el('jb-pause').addEventListener('click', () => send('!queue pause'));
  el('jb-resume').addEventListener('click', () => send('!queue resume'));
  el('jb-clear').addEventListener('click', () => send('!queue clear'));
  const onfail = el('jb-onfail');
  onfail.addEventListener('change', () => send(`!queue onfail ${onfail.value === 'stop' ? 'stop' : 'next'}`));

  function button(label: string, aria: string, fn: () => void, cls = 'small'): El {
    const b = ui.el('button', cls, label);
    b.type = 'button';
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', fn);
    return b;
  }
  function badge(state: string): El {
    return ui.el('span', `badge b-${state}`, state);
  }
  function row(j: QueueJobView, extra: El[], end: string | null): El {
    const r = ui.el('div', 'jb');
    r.dataset.job = String(j.id);
    r.appendChild(badge(j.state));
    r.appendChild(ui.el('span', 'grow', jobTitle(j)));
    for (const e of extra) r.appendChild(e);
    if (end) r.appendChild(ui.el('div', 'end', end));
    return r;
  }

  function render(s: JobsSummary): void {
    const q = s.queue;
    if (!q) {
      ui.text('jb-state', s.on ? '' : '(no queue: the bot needs --walk)');
      return;
    }
    ui.text('jb-state', `${q.paused ? `paused (${q.why ?? 'paused'})` : q.running ? 'running' : q.waiting.length ? 'waiting for the bot' : 'empty'}${!q.running && q.hold && q.waiting.length ? `: ${q.hold}` : ''}`);
    el('jb-pause').hidden = q.paused;
    el('jb-resume').hidden = !q.paused;
    el('jb-clear').disabled = q.waiting.length === 0;
    onfail.value = q.onFail;
    const run = el('jb-run');
    ui.clear(run);
    if (q.running) {
      const j = q.running;
      run.appendChild(row(j, [button('Stop', `stop job ${j.id} (!queue remove ${j.id})`, () => send(`!queue remove ${j.id}`), 'small danger')], `${j.line ?? 'started'} · since ${ago(j.startedAt)}`));
    }
    const wait = el('jb-wait');
    ui.clear(wait);
    q.waiting.forEach((j, i) => {
      const acts = [
        button('↑', `move job ${j.id} up`, () => send(`!queue move ${j.id} ${i}`)),
        button('↓', `move job ${j.id} down`, () => send(`!queue move ${j.id} ${i + 2}`)),
        button('×', `remove job ${j.id}`, () => send(`!queue remove ${j.id}`)),
      ];
      acts[0]!.disabled = i === 0;
      acts[1]!.disabled = i === q.waiting.length - 1;
      wait.appendChild(row(j, acts, `added by ${j.by} (${j.via}) ${ago(j.addedAt)}`));
    });
    if (!q.running && !q.waiting.length) wait.appendChild(ui.el('div', 'muted small', 'nothing waits: add a command above, or Queue on the map, storage or Bring'));
    const ended = el('jb-ended');
    ui.clear(ended);
    for (const j of [...q.ended].reverse()) ended.appendChild(row(j, [button('Retry', `run job ${j.id} again (!queue retry ${j.id})`, () => send(`!queue retry ${j.id}`))], `${j.end ?? ''}${took(j)}${j.endedAt ? ` · ${ago(j.endedAt)}` : ''}`));
    if (!q.ended.length) ended.appendChild(ui.el('div', 'muted small', 'no job has ended yet'));
    const goals = el('jb-goals');
    ui.clear(goals);
    for (const g of s.goals) {
      const r = ui.el('div', 'jb');
      r.dataset.goal = g.id;
      const lab = ui.el('label', 'sw');
      const box = ui.el('input');
      box.type = 'checkbox';
      box.checked = g.on;
      box.setAttribute('aria-label', `${g.label} (${g.setting})`);
      box.addEventListener('change', () => send(`!set ${g.setting} ${box.checked ? 'on' : 'off'}`));
      lab.appendChild(box);
      lab.appendChild(ui.el('span'));
      r.appendChild(lab);
      r.appendChild(ui.el('b', 'grow', `${g.label} `));
      r.appendChild(ui.el('span', 'muted small', g.setting));
      const t = goalText(g);
      if (t) r.appendChild(ui.el('div', 'end', t));
      goals.appendChild(r);
    }
    if (!s.goals.length) goals.appendChild(ui.el('div', 'muted small', 'no standing goals'));
  }

  function take(s: JobsSummary): void {
    sum = s;
    if (shown) render(s);
  }
  const refresh = (): void => {
    void env
      .fetch(JOBS_PATH, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${JOBS_PATH} ${r.status}`);
        take((await r.json()) as JobsSummary);
      })
      .catch((e: unknown) => env.console.debug(`panel: jobs: ${why(e)}`));
  };
  const poll = (): void => {
    env.clearTimeout(pollT);
    pollT = 0;
    if (!shown) return;
    if (!page.streaming()) refresh();
    pollT = env.setTimeout(poll, JOBS_POLL_MS);
  };

  views.on((v) => {
    shown = v === 'jobs';
    if (!shown) return;
    if (!joined) {
      joined = true;
      page.listen(JOBS_TOPIC, (data) => {
        const m = JSON.parse(data) as { snap?: JobsSummary; d?: DeltaOp[] };
        if (m.snap) take(m.snap);
        else if (m.d && sum) take(applyDelta(sum as unknown as Json, m.d) as unknown as JobsSummary);
      });
    }
    if (sum) render(sum);
    poll(); // without the stream: GET /api/jobs now and every JOBS_POLL_MS
  });

  return { summary: () => sum };
}
