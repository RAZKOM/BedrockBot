// Track P5 on bds-core (docs/away.md, docs/panel.md "Away view", ADR 0116): away mode on a real bot process, driven
// through the panel's API as the Away view does (POST /api/cmd, GET /api/timeline, /api/away, /api/state?lite=1).
//   timeline  a queue with a job that fails (`!craft diamond_sword` with nothing), a walk during which the bot is killed
//             (the death fails it) and a `!pos`: GET /api/timeline since the start shows both failed jobs as their own
//             groups, the death in the walk's group, and the summary counts 1 done, 2 failed, 1 death; with `notify` on
//             the death is a note in the away block
//   answer    askOwner on, askWaitS 10: a failed job asks; the question is in the away block with its choices and
//             deadline; `!answer <id> retry` through the API puts the job back first in line (it fails again and asks
//             again); `!answer <id> next` goes on, the next job runs
//   timeout   the same question left alone: after askWaitS the onfail rule decides (`next`: the next job runs; `stop`:
//             the queue stays paused), the ask.answered event says `timeout`
// Env: P5_PANEL_PORT (default a random port in 10110..10119), P5_CASE=timeline,answer,timeout (a subset), P5_OUT=<file>
// (the measured lines appended), core-truth.ts (CORE_BDS_*). Needs BDS_E2E=1 and bds-core with the truth pack.
import { appendFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import type { PanelAway } from '../../src/health/panel/away.ts';
import type { JobsSummary, QueueJobView } from '../../src/health/panel/shared.ts';
import type { Timeline } from '../../src/events/timeline.ts';
import type { PveTruth } from './pve-truth.ts';
import { centre, clearArea, coreCmd, CORE_CONTAINER, CORE_TARGET, E2E, FEET_Y, prepareServer, privateArea, sleep, until, waitOnline, type CoreCli } from './core-truth.ts';
import { connectObserver, panelClient, panelPort, quitPanelCli, startPanelCli, type Observer, type PanelCli } from './panel-e2e.ts';

const F = FEET_Y;
const ONLY = process.env.P5_CASE;
const want = (c: string): boolean => !ONLY || ONLY.split(',').includes(c);
const panel = panelClient(panelPort(process.env.P5_PANEL_PORT, 10110));
const WAIT_S = 10;

interface Listed {
  id: number;
  ts: number;
  kind: string;
  data: Record<string, unknown>;
  text: string;
}

describe.skipIf(!E2E)('core: away mode (Track P5)', () => {
  const area = privateArea();
  const HOME = { x: area.x, y: F, z: area.z };
  const at = (dx: number, dz: number): Vec3 => ({ x: HOME.x + dx, y: F, z: HOME.z + dz });
  const notes: string[] = [];
  let observer: Observer | undefined;
  let truth: PveTruth | undefined;
  let run: PanelCli | undefined;
  let cli: CoreCli | undefined;

  const jobs = (): Promise<JobsSummary> => panel.get<JobsSummary>('/api/jobs');
  const away = (): Promise<PanelAway & { limiter: Record<string, number> }> => panel.get('/api/away');
  const all = async (): Promise<QueueJobView[]> => {
    const q = (await jobs()).queue!;
    return [...q.ended, ...(q.running ? [q.running] : []), ...q.waiting];
  };
  const job = async (id: number): Promise<QueueJobView | undefined> => (await all()).find((j) => j.id === id);
  const cmd = async (text: string): Promise<string[]> => {
    const r = await panel.cmd(text);
    expect(r.status, text).toBe(200);
    return r.body.replies;
  };
  const add = async (c: string): Promise<number> => {
    const r = await cmd(`!queue add ${c}`);
    const m = /^queue: added #(\d+) /.exec(r.find((x) => x.startsWith('queue: added')) ?? '');
    expect(m, `${c}: ${r.join(' | ')}`).not.toBeNull();
    return Number(m![1]);
  };
  const ended = (j: QueueJobView | undefined): boolean => !!j && j.state !== 'waiting' && j.state !== 'running';
  const waitEnd = (id: number, ms: number): Promise<QueueJobView> => until(async () => {
    const j = await job(id);
    return ended(j) ? j : undefined;
  }, ms, `job #${id} ended`, 250);
  const waitState = (id: number, state: string, ms: number): Promise<QueueJobView> => until(async () => {
    const j = await job(id);
    return j?.state === state ? j : undefined;
  }, ms, `job #${id} ${state}`, 200);
  /** The one open question, once the away block has it. */
  const asked = (ms = 20_000) => until(async () => (await away()).asks[0], ms, 'a question in the away block', 200);
  const events = async (q: string): Promise<Listed[]> => (await panel.get<{ events: Listed[] }>(`/api/events${q}`)).events;
  const s = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '-' : (ms / 1000).toFixed(1));
  const note = (line: string): void => {
    notes.push(line);
    console.log(`[p5] ${line}`);
  };
  async function fresh(): Promise<void> {
    await coreCmd('time', 'set', 'noon');
    await cmd('!queue pause');
    await cmd('!stop');
    await cmd('!queue clear');
    await cmd('!queue clear ended');
    await cmd('!queue onfail next');
    await cmd('!set askOwner off');
    await coreCmd('clear', cli!.name);
    await coreCmd('kill', '@e[type=item]');
    await truth!.tp(cli!.name, centre(HOME), 0, 0);
    await sleep(1500);
    await cmd('!queue resume');
  }

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    observer = await connectObserver(`P5Obs${randomInt(1000, 9999)}`, CORE_TARGET, CORE_CONTAINER);
    truth = observer.truth;
    await truth.tp(observer.name, { x: HOME.x + 0.5, y: F, z: HOME.z - 40 + 0.5 }, 0, 0);
    await clearArea(truth, HOME, 24, 6);
    await truth.fill({ x: HOME.x - 24, y: F - 1, z: HOME.z - 24 }, { x: HOME.x + 24, y: F - 1, z: HOME.z + 24 }, 'grass_block');
    run = startPanelCli(panel, { prefix: 'bot-e2e-p5-', args: ['--walk', '--respawn-delay', '1'], events: true });
    cli = run.cli;
    await waitOnline(truth, cli.name);
    await panel.healthy();
    await until(async () => ((await jobs()).on ? true : undefined), 20_000, 'the queue on the panel');
    await truth.tp(cli.name, centre(HOME), 0, 0);
    await cmd('!set autoFood off'); // the food chore would hunt on the flat world's empty plain (not this track's)
    await cmd('!set notify on');
    await cmd(`!set askWaitS ${WAIT_S}`);
  }, 120_000);

  afterAll(async () => {
    await quitPanelCli(panel, cli).catch(() => undefined);
    cli?.kill();
    await coreCmd('time', 'set', 'noon').catch(() => undefined);
    await truth?.cleanup().catch(() => undefined);
    await clearArea(truth!, HOME, 24, 6).catch(() => undefined);
    await truth?.fill({ x: HOME.x - 24, y: F - 1, z: HOME.z - 24 }, { x: HOME.x + 24, y: F - 1, z: HOME.z + 24 }, 'grass_block').catch(() => undefined);
    await observer?.close();
    run?.cleanup();
    const text = `[panel-away e2e] port ${panel.port}, area cell ${area.cell}\n  ${notes.join('\n  ')}\n`;
    console.log(text);
    if (process.env.P5_OUT) appendFileSync(process.env.P5_OUT, text);
  }, 90_000);

  it.runIf(want('timeline'))('timeline: a failed job and a death show as their groups, the summary counts them, the death is a note', async () => {
    await fresh();
    const since = Date.now();
    const far = at(22, 22);
    const f1 = await add('!craft diamond_sword');
    const w = await add(`!goto ${far.x} ${far.y} ${far.z}`);
    const p = await add('!pos');
    await waitState(w, 'running', 60_000);
    await sleep(1500);
    const killedAt = Date.now();
    await coreCmd('kill', cli!.name);
    const jw = await waitEnd(w, 30_000);
    const jp = await waitEnd(p, 60_000);
    const jf = (await job(f1))!;
    expect(jf.state).toBe('failed');
    // the walk's process stops as interrupted on a real death; the queue sees the death on its poll and fails the job
    // (`the bot died during it (interrupted (last: walking to ...))`, docs/queue.md "Known limits")
    expect(jw.state, jw.end ?? '').toBe('failed');
    expect(jw.end ?? '').toMatch(/^the bot died during it/);
    expect(jp.state).toBe('done');
    const note1 = await until(async () => (await away()).notes.find((n) => n.kind === 'life.died' && n.ts >= killedAt), 10_000, 'the death as a note', 200);
    const t0 = Date.now();
    const raw = await fetch(`${panel.base}/api/timeline?since=${since}&group=job&tz=0`, { headers: panel.auth });
    const body = await raw.text();
    const tl = JSON.parse(body) as Timeline;
    const ms = Date.now() - t0;
    const groups = tl.groups.filter((g) => g.kind === 'job');
    const gf = groups.find((g) => g.title.startsWith(`#${f1} `));
    const gw = groups.find((g) => g.title.startsWith(`#${w} `));
    expect(gf?.state).toBe('failed');
    expect(gw?.state).toBe(jw.state);
    expect(gw!.head.some((l) => l.kind === 'life.died')).toBe(true);
    const failed = jw.state === 'failed' ? 2 : 1;
    const cancelled = jw.state === 'cancelled' ? 1 : 0;
    expect(tl.counts.jobs).toEqual({ done: 1, failed, cancelled });
    expect(tl.counts.deaths).toBe(1);
    expect(tl.line).toMatch(new RegExp(`^1 job done, ${failed} failed, ${cancelled ? '1 cancelled, ' : ''}1 death, \\d+ reconnects?`));
    const lite = await panel.get<{ away: PanelAway }>('/api/state?lite=1');
    note(`timeline: #${f1} ${jf.state} (${jf.end}); the walk #${w} ${jw.state} after the kill (${jw.end}); #${p} ${jp.state}`);
    note(`timeline: ${tl.line}; ${tl.groups.length} groups (${groups.map((g) => `${g.title} ${g.state}`).join('; ')}); the death in #${w}'s group: ${gw!.head.find((l) => l.kind === 'life.died')!.text}`);
    note(`timeline: GET /api/timeline ${Buffer.byteLength(body)} bytes in ${ms} ms over ${tl.total} events; the away block ${JSON.stringify(lite.away).length} bytes in the lite state (${JSON.stringify(lite).length} in all)`);
    note(`timeline: the death's note ${s(note1.ts - killedAt)} s after the kill: ${note1.title}: ${note1.body}`);
  }, 240_000);

  it.runIf(want('answer'))('answer: a failed job asks; retry through the API puts it back first, next goes on', async () => {
    await fresh();
    await cmd('!set askOwner on');
    const f = await add('!craft diamond_sword');
    const p = await add('!pos');
    const j1 = await waitEnd(f, 60_000);
    expect(j1.state).toBe('failed');
    const q1 = await asked();
    const askS = (q1.askedAt - j1.endedAt!) / 1000;
    expect(q1.choices.map((c) => c.id)).toEqual(['retry', 'next', 'stop']);
    expect(q1.default).toBe('next');
    expect(Math.round((q1.until - q1.askedAt) / 1000)).toBe(WAIT_S);
    const hold = `the owner is asked about #${f} (retry, next or stop)`;
    await until(async () => ((await jobs()).queue!.hold === hold ? true : undefined), 5000, 'the hold line', 200); // the queue's next tick (250 ms)
    expect((await job(p))?.state).toBe('waiting');
    const r1 = await cmd(`!answer ${q1.id} retry`);
    expect(r1).toContain(`ask: #${q1.id} answered: retry`);
    const again = await until(async () => (await all()).find((j) => j.id > p && j.command === '!craft diamond_sword'), 10_000, 'the job again');
    const q = (await jobs()).queue!;
    expect(q.waiting[0]?.id ?? q.running?.id).toBe(again.id);
    const j2 = await waitEnd(again.id, 60_000);
    expect(j2.state).toBe('failed');
    const q2 = await until(async () => (await away()).asks.find((a) => a.id !== q1.id), 20_000, 'the second question');
    const tAns = Date.now();
    expect(await cmd(`!answer ${q2.id} next`)).toContain(`ask: #${q2.id} answered: next`);
    const jp = await waitEnd(p, 30_000);
    expect(jp.state).toBe('done');
    const ans = await events(`?since=0&kinds=ask.answered&limit=50`);
    const a1 = ans.find((e) => e.data.id === q1.id)!;
    const a2 = ans.find((e) => e.data.id === q2.id)!;
    expect(a1.data).toMatchObject({ choice: 'retry', how: 'panel' });
    expect(a2.data).toMatchObject({ choice: 'next', how: 'panel' });
    const n = (await away()).notes.filter((x) => x.ask === q1.id || x.ask === q2.id);
    expect(n.length).toBe(2);
    note(`answer: asked ${askS.toFixed(1)} s after #${f} failed; retry -> #${again.id} first in line, failed again, asked again (#${q2.id}); next -> #${p} started ${s(jp.startedAt! - tAns)} s after the answer, ${jp.state}; answers ${a1.text} | ${a2.text}; the notes: ${n.map((x) => x.title).join(', ')}`);
  }, 240_000);

  it.runIf(want('timeout'))('timeout: unanswered, the onfail rule decides: next goes on; stop stays paused', async () => {
    await fresh();
    await cmd('!set askOwner on');
    const f = await add('!craft diamond_sword');
    const p = await add('!pos');
    const j1 = await waitEnd(f, 60_000);
    const q1 = await asked();
    const jp = await waitEnd(p, 60_000);
    expect(jp.state).toBe('done');
    const ev1 = (await events(`?since=0&kinds=ask.answered&limit=50`)).find((e) => e.data.id === q1.id)!;
    expect(ev1.data).toMatchObject({ choice: 'next', how: 'timeout' });
    const after1 = (jp.startedAt! - j1.endedAt!) / 1000;
    expect(after1).toBeGreaterThanOrEqual(WAIT_S);
    // onfail stop: paused at once, still paused after the wait
    await cmd('!queue onfail stop');
    const f2 = await add('!craft diamond_sword');
    const p2 = await add('!pos');
    const k1 = await waitEnd(f2, 60_000);
    const q2 = await asked();
    expect(q2.default).toBe('stop');
    expect((await jobs()).queue!.why).toBe(`#${f2} failed: the owner is asked`);
    await until(async () => ((await away()).asks.some((a) => a.id === q2.id) ? undefined : true), (WAIT_S + 10) * 1000, 'the second question timed out', 250);
    await sleep(7000);
    const q = (await jobs()).queue!;
    expect(q.paused).toBe(true);
    expect(q.why).toBe(`#${f2} failed (unanswered: the onfail rule)`);
    expect((await job(p2))?.state).toBe('waiting');
    const ev2 = (await events(`?since=0&kinds=ask.answered&limit=50`)).find((e) => e.data.id === q2.id)!;
    expect(ev2.data).toMatchObject({ choice: 'stop', how: 'timeout' });
    note(`timeout: next: #${p} started ${after1.toFixed(1)} s after #${f} failed (asked, ${WAIT_S} s unanswered: ${ev1.text}); stop: paused from the failure (${s(k1.endedAt! - k1.startedAt!)} s job), still paused after the wait (${q.why}), #${p2} waiting`);
    await cmd('!queue onfail next');
    await cmd('!queue resume');
    await waitEnd(p2, 30_000);
  }, 240_000);
});
