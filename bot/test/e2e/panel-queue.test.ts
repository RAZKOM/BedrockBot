// Track P4 on bds-core (docs/queue.md, docs/panel.md "Jobs", ADR 0115): the job queue and the standing goals on a real
// bot process, driven through the panel's API (POST /api/cmd, GET /api/jobs) as the Jobs view does.
//   order     four jobs (a walk, a waypoint, a walk, a position) run one after another, each with its end line, the
//             gap between them measured
//   failure   a walk into a sealed bedrock box fails and the next job runs (`onfail next`, the default); with
//             `onfail stop` the same failure pauses the queue and `!queue resume` goes on
//   preempt   a `!goto` typed in the panel while a queued walk runs: the queue pauses and says so, the walk is
//             replaced (cancelled), the typed walk arrives, the next job waits until `!queue resume`
//   restart   `!quit` while a queued walk runs, the CLI started again on the same config directory: the walk is ended
//             `cancelled` (not run again), the next job runs
//   night     `!get iron_chestplate` as a queued job with `jobDusk` on: dusk ends its mine step and the bot walls in at
//             the shelter; the job stays running and the next job waits all night; at dawn the job goes on, ends, and
//             the next job runs
//   goal      `!set autoMilk on` from the panel, a cow by home and an empty bucket: a walk home ends, the milk chore
//             runs in the gap before the next job (the queue waits for it), then the next job
// Env: P4_PANEL_PORT (default a random port in 10100..10109), P4_CASE=order,failure,... (a subset), P4_OUT=<file> (the
// measured lines appended), core-truth.ts (CORE_BDS_*). Needs BDS_E2E=1 and bds-core with the truth pack.
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import type { JobsSummary, QueueJobView } from '../../src/health/panel/shared.ts';
import type { QueueData } from '../../src/tasks/queue.ts';
import type { PveTruth } from './pve-truth.ts';
import { centre, clearArea, coreCmd, CORE_CONTAINER, CORE_TARGET, E2E, FEET_Y, hdist, prepareServer, privateArea, sleep, until, waitOnline, type CoreCli } from './core-truth.ts';
import { connectObserver, panelClient, panelPort, quitPanelCli, startPanelCli, type Observer, type PanelCli } from './panel-e2e.ts';

const F = FEET_Y;
const ONLY = process.env.P4_CASE;
const want = (c: string): boolean => !ONLY || ONLY.split(',').includes(c);
const panel = panelClient(panelPort(process.env.P4_PANEL_PORT, 10100));

describe.skipIf(!E2E)('core: the job queue and the standing goals (Track P4)', () => {
  const area = privateArea();
  const HOME = { x: area.x, y: F, z: area.z };
  const at = (dx: number, dz: number): Vec3 => ({ x: HOME.x + dx, y: F, z: HOME.z + dz });
  const notes: string[] = [];
  let observer: Observer | undefined;
  let truth: PveTruth | undefined;
  let run: PanelCli | undefined;
  let cli: CoreCli | undefined;

  const jobs = (): Promise<JobsSummary> => panel.get<JobsSummary>('/api/jobs');
  const all = async (): Promise<QueueJobView[]> => {
    const q = (await jobs()).queue!;
    return [...q.ended, ...(q.running ? [q.running] : []), ...q.waiting];
  };
  const job = async (id: number): Promise<QueueJobView | undefined> => (await all()).find((j) => j.id === id);
  /** POST a command as the panel does; the replies. */
  const cmd = async (text: string): Promise<string[]> => {
    const r = await panel.cmd(text);
    expect(r.status, text).toBe(200);
    return r.body.replies;
  };
  /** `!queue add <c>`: the new job's id. */
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
  const pos = async (): Promise<Vec3> => (await truth!.pos(cli!.name)).location;
  const s = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '-' : (ms / 1000).toFixed(1));
  const note = (line: string): void => {
    notes.push(line);
    console.log(`[p4] ${line}`);
  };
  /** Each case starts from a clean, empty queue at HOME by day, no home or shelter. */
  async function fresh(): Promise<void> {
    await coreCmd('time', 'set', 'noon');
    await cmd('!queue pause');
    await cmd('!stop');
    await cmd('!queue clear');
    await cmd('!queue clear ended');
    await cmd('!queue onfail next');
    await cmd('!home clear');
    await cmd('!shelter clear');
    await cmd('!set autoMilk off');
    await cmd('!set nightShell off');
    await coreCmd('clear', cli!.name);
    await coreCmd('kill', '@e[type=item]');
    await coreCmd('kill', '@e[type=cow]');
    await truth!.tp(cli!.name, centre(HOME), 0, 0);
    await sleep(1500);
    await cmd('!queue resume');
  }

  /** The queue's own directory (the e2e CLI runs with --no-config: BEDROCKBOT_QUEUE_DIR keeps the queue across the restart). */
  const qdir = mkdtempSync(join(tmpdir(), 'bot-e2e-p4-queue-'));
  async function start(dir?: string, name?: string): Promise<void> {
    const keep = process.env.BEDROCKBOT_QUEUE_DIR;
    process.env.BEDROCKBOT_QUEUE_DIR = qdir;
    try {
      run = startPanelCli(panel, { prefix: 'bot-e2e-p4-', args: ['--walk'], ...(dir ? { dir } : {}), ...(name ? { name } : {}) });
    } finally {
      if (keep === undefined) delete process.env.BEDROCKBOT_QUEUE_DIR;
      else process.env.BEDROCKBOT_QUEUE_DIR = keep;
    }
    cli = run.cli;
    await waitOnline(truth!, cli.name);
    await panel.healthy();
    await until(async () => ((await jobs()).on ? true : undefined), 20_000, 'the queue on the panel');
  }

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    observer = await connectObserver(`P4Obs${randomInt(1000, 9999)}`, CORE_TARGET, CORE_CONTAINER);
    truth = observer.truth;
    await truth.tp(observer.name, { x: HOME.x + 0.5, y: F, z: HOME.z - 40 + 0.5 }, 0, 0);
    await clearArea(truth, HOME, 24, 6);
    await truth.fill({ x: HOME.x - 24, y: F - 1, z: HOME.z - 24 }, { x: HOME.x + 24, y: F - 1, z: HOME.z + 24 }, 'grass_block');
    await start();
    await truth.tp(cli!.name, centre(HOME), 0, 0);
    await cmd('!set autoFood off'); // the food chore would hunt on the flat world's empty plain (not this track's)
  }, 120_000);

  afterAll(async () => {
    await quitPanelCli(panel, cli).catch(() => undefined);
    cli?.kill();
    await coreCmd('time', 'set', 'noon').catch(() => undefined);
    await coreCmd('kill', '@e[type=cow]').catch(() => undefined);
    await truth?.cleanup().catch(() => undefined);
    await clearArea(truth!, HOME, 24, 6).catch(() => undefined);
    await truth?.fill({ x: HOME.x - 24, y: F - 1, z: HOME.z - 24 }, { x: HOME.x + 24, y: F - 1, z: HOME.z + 24 }, 'grass_block').catch(() => undefined);
    await observer?.close();
    run?.cleanup();
    rmSync(qdir, { recursive: true, force: true });
    const text = `[panel-queue e2e] port ${panel.port}, area cell ${area.cell}\n  ${notes.join('\n  ')}\n`;
    console.log(text);
    if (process.env.P4_OUT) appendFileSync(process.env.P4_OUT, text);
  }, 90_000);

  it.runIf(want('order'))('order: four jobs run one after another, each with its end line', async () => {
    await fresh();
    const a = at(10, 0);
    const b = at(0, 10);
    const t0 = Date.now();
    const ids = [await add(`!goto ${a.x} ${a.y} ${a.z}`), await add('!wp set p4q'), await add(`!goto ${b.x} ${b.y} ${b.z}`), await add('!pos')];
    const last = await waitEnd(ids[3]!, 120_000);
    const list = await all();
    const js = ids.map((id) => list.find((j) => j.id === id)!);
    for (const j of js) expect(j.state, `${j.command}: ${j.end}`).toBe('done');
    for (let i = 1; i < js.length; i++) expect(js[i]!.startedAt!).toBeGreaterThanOrEqual(js[i - 1]!.endedAt!);
    expect(hdist(await pos(), { x: b.x + 0.5, z: b.z + 0.5 })).toBeLessThan(1.5);
    expect(js[1]!.end).toMatch(/^waypoint p4q set to /);
    const wp = (await cmd('!wp p4q'))[0]!;
    const m = /(-?\d+) (-?\d+) (-?\d+)/.exec(wp)!;
    expect(Math.hypot(Number(m[1]) - a.x, Number(m[3]) - a.z)).toBeLessThanOrEqual(1);
    expect(last.end).toMatch(/^pos /);
    const gaps = js.slice(1).map((j, i) => s(j.startedAt! - js[i]!.endedAt!));
    note(`order: GET /api/jobs (the jobs topic's snapshot) ${JSON.stringify(await jobs()).length} bytes with ${(await all()).length} jobs and ${(await jobs()).goals.length} goals`);
    note(`order: ${js.map((j) => `#${j.id} ${j.command} ${j.state} in ${s(j.endedAt! - j.startedAt!)} s (${j.end})`).join('; ')}; gaps ${gaps.join(', ')} s; ${s(Date.now() - t0)} s in all`);
    await cmd('!wp del p4q').catch(() => undefined);
  }, 180_000);

  it.runIf(want('failure'))('failure: a failed job is followed by the next (onfail next); onfail stop pauses the queue', async () => {
    await fresh();
    // a sealed bedrock block 12 blocks off, its walls 5 thick: the cell inside is out of reach from anywhere outside
    // (a goto that ends within reach of a cell it cannot enter is done with a note: the navigator's rule)
    const c = at(-12, 0);
    await truth!.fill({ x: c.x - 5, y: F - 1, z: c.z - 5 }, { x: c.x + 5, y: F + 5, z: c.z + 5 }, 'bedrock');
    await truth!.fill({ x: c.x, y: F, z: c.z }, { x: c.x, y: F + 1, z: c.z }, 'air');
    try {
      const f1 = await add(`!goto ${c.x} ${c.y} ${c.z}`);
      const n1 = await add('!craft diamond_sword');
      const n2 = await add('!pos');
      const j1 = await waitEnd(f1, 120_000);
      const j2 = await waitEnd(n1, 60_000);
      const j3 = await waitEnd(n2, 60_000);
      note(`failure (next): #${j1.id} ${j1.state} in ${s(j1.endedAt! - j1.startedAt!)} s (${j1.end}); #${j2.id} ${j2.state} (${j2.end}); #${j3.id} ${j3.state} (${j3.end})`);
      expect(j1.state).toBe('failed');
      expect(j2.state).toBe('failed');
      expect(j3.state).toBe('done');
      // onfail stop: the failure pauses the queue
      await cmd('!queue onfail stop');
      await truth!.tp(cli!.name, centre(HOME), 0, 0);
      const f2 = await add('!craft diamond_sword');
      const n3 = await add('!pos');
      const k1 = await waitEnd(f2, 60_000);
      expect(k1.state).toBe('failed');
      await sleep(8000);
      const q = (await jobs()).queue!;
      expect(q.paused).toBe(true);
      expect(q.why).toBe(`#${f2} failed`);
      expect((await job(n3))?.state).toBe('waiting');
      await cmd('!queue resume');
      const k2 = await waitEnd(n3, 30_000);
      expect(k2.state).toBe('done');
      note(`failure (stop): #${k1.id} failed (${k1.end}); the queue paused (${q.why}); after !queue resume #${k2.id} ${k2.state} ${s(k2.startedAt! - k1.endedAt!)} s after the failure`);
    } finally {
      await truth!.fill({ x: c.x - 5, y: F, z: c.z - 5 }, { x: c.x + 5, y: F + 5, z: c.z + 5 }, 'air');
      await truth!.fill({ x: c.x - 5, y: F - 1, z: c.z - 5 }, { x: c.x + 5, y: F - 1, z: c.z + 5 }, 'grass_block');
      await cmd('!queue onfail next');
    }
  }, 300_000);

  it.runIf(want('preempt'))('preempt: a command typed in the panel pauses the queue; the queued walk is replaced, the next waits for !queue resume', async () => {
    await fresh();
    const d = at(20, 20);
    const e = at(-12, 6);
    const w1 = await add(`!goto ${d.x} ${d.y} ${d.z}`);
    const w2 = await add('!pos');
    await waitState(w1, 'running', 30_000);
    await until(async () => (hdist(await pos(), { x: HOME.x + 0.5, z: HOME.z + 0.5 }) > 3 ? true : undefined), 30_000, 'the queued walk under way');
    const t0 = Date.now();
    const replies = await cmd(`!goto ${e.x} ${e.y} ${e.z}`);
    const q = (await jobs()).queue!;
    expect(q.paused).toBe(true);
    expect(q.why).toBe('!goto was typed');
    const j1 = await waitEnd(w1, 30_000);
    expect(j1.state).toBe('cancelled');
    expect(j1.end).toMatch(/^!goto was typed/);
    await until(async () => (hdist(await pos(), { x: e.x + 0.5, z: e.z + 0.5 }) < 1.5 ? true : undefined), 60_000, 'the typed walk arrived');
    const arrived = Date.now() - t0;
    await sleep(8000);
    expect((await job(w2))?.state).toBe('waiting');
    await cmd('!queue resume');
    const j2 = await waitEnd(w2, 30_000);
    expect(j2.state).toBe('done');
    const said = (await panel.state()).chat.map((c) => c.text).find((t) => t.startsWith('queue: paused: !goto was typed'));
    expect(said).toMatch(/^queue: paused: !goto was typed; #\d+ !goto .* is left to it; !queue resume goes on with #\d+ !pos$/);
    note(`preempt: the typed !goto replied ${JSON.stringify(replies)}; the queue said "${said}"; #${j1.id} ${j1.state} (${j1.end}); the typed walk arrived ${s(arrived)} s after it was sent; #${w2} waited 8 s paused, then ${j2.state} after !queue resume`);
  }, 180_000);

  it.runIf(want('restart'))('restart: the running job is not run again after a restart; the next runs', async () => {
    await fresh();
    const g = at(-20, -20);
    const r1 = await add(`!goto ${g.x} ${g.y} ${g.z}`);
    const r2 = await add('!pos');
    await waitState(r1, 'running', 30_000);
    await until(async () => (hdist(await pos(), { x: HOME.x + 0.5, z: HOME.z + 0.5 }) > 3 ? true : undefined), 30_000, 'the queued walk under way');
    const dir = run!.dir;
    const kept = /queue: kept in (.+?\.json)/.exec(cli!.output())?.[1];
    expect(kept, cli!.output().split('\n').filter((l) => l.includes('queue')).join('\n')).toBeDefined();
    expect(readdirSync(qdir)).toHaveLength(1);
    const file = kept!;
    const before = JSON.parse(readFileSync(file, 'utf8')) as QueueData;
    expect(before.jobs.find((j) => j.id === r1)?.state).toBe('running');
    const t0 = Date.now();
    await quitPanelCli(panel, cli);
    await start(dir, cli!.name); // the same player: it joins where it logged off
    const back = Date.now() - t0;
    const stoppedAt = await pos(); // where it joined (this server puts a joining offline player at the world spawn)
    const j1 = await job(r1);
    expect(j1?.state).toBe('cancelled');
    expect(j1?.end).toMatch(/^stopped by a restart \(started \d+ s before\); not run again \(!queue retry \d+ puts it back\)$/);
    const j2 = await waitEnd(r2, 60_000).catch(async (e: unknown) => {
      note(`restart: no end: ${JSON.stringify((await jobs()).queue)}; log: ${cli!.output().split('\n').filter((l) => /queue|WARN|ERROR/.test(l)).slice(-15).join(' | ')}`);
      throw e;
    });
    expect(j2.state).toBe('done');
    // the walk was not run again: the bot did not go on to its goal
    expect(hdist(await pos(), { x: g.x + 0.5, z: g.z + 0.5 })).toBeGreaterThan(2);
    expect(hdist(await pos(), stoppedAt)).toBeLessThan(2);
    const log = cli!.output().split('\n').filter((l) => l.includes('queue:')).slice(0, 4);
    note(`restart: back online ${s(back)} s after !quit; #${r1} ${j1?.state} (${j1?.end}); #${r2} ${j2.state} ${s(j2.startedAt! - t0 - back)} s after the panel answered; log: ${log.map((l) => l.replace(/^.*?queue:/, 'queue:')).join(' | ')}`);
  }, 180_000);

  it.runIf(want('night'))('night: a queued !get job pauses for the night with jobDusk; the queue waits; both go on at dawn', async () => {
    await fresh();
    const shelter = at(-6, 0);
    await cmd('!set jobDusk on');
    await cmd('!set nightShell on');
    await cmd(`!shelter set ${shelter.x} ${shelter.y} ${shelter.z}`);
    for (let i = 0; i < 8; i++) await truth!.fill({ x: HOME.x + 4 + (i % 4), y: F - 1, z: HOME.z - 6 + Math.floor(i / 4) }, { x: HOME.x + 4 + (i % 4), y: F - 1, z: HOME.z - 6 + Math.floor(i / 4) }, 'iron_ore');
    for (const [item, n] of [['stone_pickaxe', 1], ['crafting_table', 1], ['cobblestone', 26], ['oak_planks', 8], ['coal', 2]] as const) await coreCmd('give', cli!.name, item, String(n));
    await sleep(1000);
    await coreCmd('time', 'set', '11900');
    const t0 = Date.now();
    const g1 = await add('!get iron_chestplate');
    const g2 = await add('!pos');
    await waitState(g1, 'running', 30_000);
    // dusk once the mine step has its first ore
    await until(async () => {
      const st = await panel.state();
      const ore = (st.inventory?.slots ?? []).filter((x) => x?.name === 'raw_iron').reduce((n, x) => n + (x?.count ?? 0), 0);
      return ore >= 1 && st.stack.some((p) => p.name === 'mine') ? true : undefined;
    }, 90_000, 'the mine step with its first ore', 200);
    await coreCmd('time', 'set', '12100');
    const pauseLine = await until(async () => (await panel.state()).chat.map((c) => c.text).find((t) => t.includes('paused for the night')), 90_000, 'the pause line', 500);
    const pausedS = (Date.now() - t0) / 1000;
    // the night: the job stays running, the next job waits
    await sleep(15_000);
    const night = (await jobs()).queue!;
    expect(night.running?.id).toBe(g1);
    expect(night.waiting.map((j) => j.id)).toEqual([g2]);
    expect(night.paused).toBe(false);
    const t1 = Date.now();
    await coreCmd('time', 'set', '23100');
    const j1 = await waitEnd(g1, 480_000);
    const j2 = await waitEnd(g2, 60_000);
    note(`night: ${pauseLine} (${pausedS.toFixed(1)} s after the add); in the night #${g1} ${night.running?.state} with ${night.waiting.length} waiting, the queue not paused; dawn: #${g1} ${j1.state} ${s(j1.endedAt! - t1)} s after the clock went to 23100 (${j1.end}); #${g2} ${j2.state} ${s(j2.startedAt! - j1.endedAt!)} s after it`);
    expect(j1.state).toBe('done');
    expect(j1.end).toMatch(/^get iron_chestplate: done in .*paused for 1 night/);
    expect(j2.state).toBe('done');
    expect(j2.startedAt!).toBeGreaterThanOrEqual(j1.endedAt!);
  }, 720_000);

  it.runIf(want('goal'))('goal: autoMilk turned on from the panel runs between two jobs; the queue waits for it', async () => {
    await fresh();
    await cmd(`!home set ${HOME.x} ${HOME.y} ${HOME.z}`);
    await coreCmd('give', cli!.name, 'bucket', '1');
    await truth!.tp(cli!.name, centre(at(30, 0)), 0, 0); // over 16 from home: the chore does not want
    await truth!.summon('cow', { x: HOME.x + 3.5, y: F, z: HOME.z + 3.5 });
    expect(await cmd('!set autoMilk on')).toEqual([expect.stringMatching(/autoMilk/) as string]);
    const q0 = (await jobs()).queue!;
    expect(q0.paused).toBe(false); // `!set` is an answer: it does not pause the queue
    const a1 = await add(`!goto ${HOME.x} ${HOME.y} ${HOME.z}`);
    const a2 = await add('!pos');
    // sample the milk goal's relation to the queue until the second job ends
    const relations = new Set<string>();
    const j2 = await until(async () => {
      const v = await jobs();
      const milk = v.goals.find((g) => g.id === 'milk');
      if (milk) relations.add(milk.relation);
      return v.queue!.ended.find((x) => x.id === a2);
    }, 150_000, 'the second job ended', 200).catch(async (e: unknown) => {
      note(`goal: no end: ${JSON.stringify(await jobs())}; log: ${cli!.output().split('\n').filter((l) => /milk|queue|WARN/.test(l)).slice(-15).join(' | ')}`);
      throw e;
    });
    const j1 = (await job(a1))!;
    expect(j1.state).toBe('done');
    expect(j2.state).toBe('done');
    const v = await jobs();
    const milk = v.goals.find((g) => g.id === 'milk')!;
    expect(milk.on).toBe(true);
    expect(milk.lastS).not.toBeNull();
    const choreEnd = milk.lastAt! + milk.lastS! * 1000;
    // the chore ran after the first job's walk ended (the queue's poll sees that end up to 250 ms late) and before the second
    expect(milk.lastAt!).toBeGreaterThanOrEqual(j1.endedAt! - 300);
    expect(j2.startedAt!).toBeGreaterThanOrEqual(choreEnd);
    const st = await panel.state();
    const milkBuckets = (st.inventory?.slots ?? []).filter((x) => x?.name === 'milk_bucket').length;
    note(`goal: #${a1} ${j1.state}; the milk chore started ${s(milk.lastAt! - j1.endedAt!)} s after its walk ended and ran ${milk.lastS} s (${milk.lastLine}); #${a2} started ${s(j2.startedAt! - choreEnd)} s after the chore ended; relations seen ${[...relations].join(', ')}; ${milkBuckets} milk bucket(s) carried`);
    expect(milkBuckets).toBe(1);
    await cmd('!set autoMilk off');
  }, 240_000);
});
