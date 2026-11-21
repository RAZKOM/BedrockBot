// Track P4: the job queue's rules (tasks/queue.ts; ADR 0115, docs/queue.md).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Process } from '../../../src/tasks/process/manager.ts';
import { AskBox, type AskSpec } from '../../../src/tasks/ask.ts';
import { ASK_KEY, GAP_MS, HOLD_MAX_MS, HISTORY_KEEP, JobQueue, JOB_MAX_MS, QUEUE_MAX, SETTLE_MS, START_MAX_MS, lineState, queueRefusal, typedWork, type JobHolder, type QueueData, type QueuePorts } from '../../../src/tasks/queue.ts';

interface FakeProc {
  name: string;
  kind: 'user' | 'auto';
  priority: number;
  done: boolean;
  result: Promise<unknown>;
  end(v: unknown): void;
  status(): { line: string };
}

function proc(name: string, kind: 'user' | 'auto' = 'user', priority = 40): FakeProc {
  let res!: (v: unknown) => void;
  const result = new Promise<unknown>((r) => (res = r));
  const p: FakeProc = {
    name,
    kind,
    priority,
    done: false,
    result,
    end(v) {
      p.done = true;
      res(v);
    },
    status: () => ({ line: `${name} running` }),
  };
  return p;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** The fake bot: a manager stack, a chat log and a clock. */
function makeBot() {
  const h = {
    t: 1_000_000,
    users: [] as FakeProc[],
    active: undefined as FakeProc | undefined,
    said: [] as string[],
    ran: [] as string[],
    ready: true,
    owner: true,
    saved: undefined as QueueData | undefined,
    obtain: undefined as (object & { result?: Promise<string>; finish?: (l: string) => void }) | undefined,
    q: undefined as unknown as JobQueue,
    reply(m: string) {
      h.said.push(m);
      h.q.observeReply(m);
    },
    start(name: string): FakeProc {
      const p = proc(name);
      h.users.push(p);
      void p.result.then(() => {
        h.users = h.users.filter((x) => x !== p);
      });
      return p;
    },
  };
  return h;
}
type H = ReturnType<typeof makeBot>;

/** A bot with its queue. `commands` maps a command name to what running it does. */
function harness(commands: Record<string, (h: H, args: string[]) => void> = {}, saved?: QueueData, extra: Partial<QueuePorts> = {}): H {
  const h = makeBot();
  const holder: JobHolder = {
    name: 'get',
    current: () => h.obtain,
    end: (j) => (j as { result?: Promise<string> }).result,
    stop: () => h.obtain?.finish?.('get x: stopped by !queue remove after 3 s'),
  };
  const ports: QueuePorts = {
    run: (c) => {
      if (!h.owner) return false;
      h.ran.push(c);
      const [name, ...args] = c.slice(1).split(' ');
      commands[name!]?.(h, args);
      return true;
    },
    has: (n) => n in commands || ['queue', 'follow', 'stop', 'farm', 'learn'].includes(n),
    userProcesses: () => h.users as unknown as Process[],
    stopProcess: (p) => (p as unknown as FakeProc).end('stopped'),
    active: () => h.active ?? h.users.at(-1),
    holders: [holder],
    ready: () => h.ready,
    say: (m) => h.said.push(m),
    now: () => h.t,
    save: (d) => {
      h.saved = d;
    },
    ...extra, // Track P5: ask, isAnswer
  };
  h.q = new JobQueue(ports, saved);
  return h;
}

/** A goto that walks for `ms` and then ends with `ok`. */
const walkFor = (ms: number, ok = true, line = 'arrived at 1 2 3') => (h: H): void => {
  const p = h.start('goto');
  h.reply('walking to 1 2 3');
  setTimeoutFake(h, ms, () => {
    if (p.done) return;
    h.reply(ok ? line : 'goto: unreachable');
    p.end(ok ? { ok: true, reason: 'arrived' } : { ok: false, reason: 'unreachable' });
  });
};

// timers on the harness clock
const timers = new WeakMap<object, { at: number; fn: () => void }[]>();
function setTimeoutFake(h: H, ms: number, fn: () => void): void {
  const list = timers.get(h) ?? [];
  list.push({ at: h.t + ms, fn });
  timers.set(h, list);
}
async function run(h: H, ms: number): Promise<void> {
  for (let s = 0; s < ms; s += 250) {
    h.t += 250;
    const list = timers.get(h) ?? [];
    for (const x of list.filter((x) => x.at <= h.t)) {
      list.splice(list.indexOf(x), 1);
      x.fn();
    }
    await flush();
    h.q.tick(h.t);
    await flush();
  }
}

describe('what can be queued', () => {
  const has = (n: string): boolean => ['goto', 'follow', 'farm', 'stop', 'get', 'learn', 'queue', 'quit', 'set'].includes(n);
  it('refuses what never ends, acts on the running work or is the queue', () => {
    expect(queueRefusal('follow', [], has)).toMatch(/never ends/);
    expect(queueRefusal('stop', [], has)).toMatch(/running work/);
    expect(queueRefusal('get', ['stop'], has)).toMatch(/running work/);
    expect(queueRefusal('farm', [], has)).toMatch(/until stopped/);
    expect(queueRefusal('farm', ['new'], has)).toBeUndefined();
    expect(queueRefusal('queue', ['add', 'x'], has)).toMatch(/own commands/);
    expect(queueRefusal('quit', [], has)).toMatch(/ends the bot/);
    expect(queueRefusal('nope', [], has)).toMatch(/no command/);
    expect(queueRefusal('goto', ['home'], has)).toBeUndefined();
    expect(queueRefusal('get', ['kit', 'iron'], has)).toBeUndefined();
  });
  it('a typed command pauses the queue only when it does work', () => {
    expect(typedWork('goto', ['home'])).toBe(true);
    expect(typedWork('stop', [])).toBe(true);
    expect(typedWork('status', [])).toBe(false);
    expect(typedWork('get', ['status'])).toBe(false);
    expect(typedWork('set', ['autoMilk', 'on'])).toBe(false);
    expect(typedWork('queue', ['add', 'goto'])).toBe(false);
    expect(typedWork('pause', [])).toBe(false);
    expect(typedWork('home', [])).toBe(false);
    expect(typedWork('home', ['go'])).toBe(true);
    expect(typedWork('quit', [])).toBe(false);
    expect(typedWork('sleep', ['on'])).toBe(false);
  });
  it('reads an end line', () => {
    expect(lineState('get iron_pickaxe: done in 3 min 2 s, 5 steps')).toBe('done');
    expect(lineState('get bed: failed (no sheep)')).toBe('failed');
    expect(lineState('get bed: stopped after 4 min: night')).toBe('failed');
    expect(lineState('usage: !goto <x y z>')).toBe('failed');
    expect(lineState('autoMilk = true')).toBe('done');
    expect(lineState('get stick: already carried')).toBe('done');
    expect(lineState(undefined)).toBe('done');
    expect(lineState('craft: no diamond for diamond_sword (2 missing)')).toBe('failed');
    expect(lineState('no waypoint nowhere (!wp list)')).toBe('failed');
    expect(lineState('waypoint qa set to 1 2 3')).toBe('done');
    expect(lineState('pos 1.50 -60.00 2.50')).toBe('done');
  });
});

describe('the queue', () => {
  it('adds with refusals, the limit, the prefix and the length', () => {
    const h = harness({ goto: () => undefined });
    expect(h.q.add('!follow Steve', 'Steve', 'chat')).toMatchObject({ ok: false, why: expect.stringMatching(/^cannot queue !follow: it never ends/) as string });
    expect(h.q.add('goto 1 2 3', 'Steve', 'chat')).toMatchObject({ ok: true, pos: 1, job: { command: '!goto 1 2 3', id: 1, state: 'waiting' } });
    expect(h.q.add(`!goto ${'1 '.repeat(120)}`, 'Steve', 'chat')).toMatchObject({ ok: false, why: expect.stringMatching(/longer than/) as string });
    for (let i = 1; i < QUEUE_MAX; i++) expect(h.q.add('!goto 1 2 3', 'Steve', 'chat').ok).toBe(true);
    expect(h.q.add('!goto 1 2 3', 'Steve', 'chat')).toMatchObject({ ok: false, why: expect.stringMatching(/32 waiting/) as string });
    expect(h.saved?.jobs.length).toBe(QUEUE_MAX);
  });

  it('runs jobs in order, one at a time, with the gap between them, and keeps each end line', async () => {
    const h = harness({ goto: walkFor(3000), set: (x) => x.reply('autoMilk = true') });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    h.q.add('!set autoMilk on', 'Steve', 'panel');
    h.q.add('!goto 4 5 6', 'Steve', 'chat');
    await run(h, GAP_MS - 500);
    expect(h.ran).toEqual([]); // the gap: a due chore takes its turn first
    await run(h, 750);
    expect(h.ran).toEqual(['!goto 1 2 3']);
    expect(h.q.view().running?.command).toBe('!goto 1 2 3');
    await run(h, 3000 + SETTLE_MS + 500);
    expect(h.q.get(1)).toMatchObject({ state: 'done', end: 'arrived at 1 2 3', how: 'process' });
    // the end time is when the walk ended, not when the settle confirmed it (a chore in the settle runs after the job)
    const j1 = h.q.get(1)!;
    expect(j1.endedAt! - j1.startedAt!).toBeGreaterThanOrEqual(3000);
    expect(j1.endedAt! - j1.startedAt!).toBeLessThan(3000 + SETTLE_MS);
    expect(h.ran.length).toBe(1);
    await run(h, GAP_MS + 3000);
    expect(h.q.get(2)).toMatchObject({ state: 'done', end: 'autoMilk = true', how: 'reply' });
    await run(h, GAP_MS + 3000 + SETTLE_MS + 1000);
    expect(h.ran).toEqual(['!goto 1 2 3', '!set autoMilk on', '!goto 4 5 6']);
    expect(h.q.get(3)?.state).toBe('done');
    expect(h.said.at(-1)).toBe('queue: all 3 jobs ended: 3 done');
  });

  it('a failed job is followed by the next (onfail next), or pauses the queue (onfail stop)', async () => {
    const h = harness({ goto: walkFor(1000, false) });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    h.q.add('!goto 4 5 6', 'Steve', 'chat');
    await run(h, GAP_MS + 1000 + SETTLE_MS + 1000);
    expect(h.q.get(1)).toMatchObject({ state: 'failed', end: 'goto: unreachable' });
    await run(h, GAP_MS + 500);
    expect(h.q.get(2)?.state).toBe('running');

    const s = harness({ goto: walkFor(1000, false) });
    s.q.setOnFail('stop');
    s.q.add('!goto 1 2 3', 'Steve', 'chat');
    s.q.add('!goto 4 5 6', 'Steve', 'chat');
    await run(s, GAP_MS + 1000 + SETTLE_MS + 1000);
    expect(s.q.get(1)?.state).toBe('failed');
    expect(s.q.paused).toBe(true);
    expect(s.said.some((m) => m.startsWith('queue: paused: #1 !goto 1 2 3 failed'))).toBe(true);
    await run(s, GAP_MS * 2);
    expect(s.q.get(2)?.state).toBe('waiting');
    s.q.resume();
    await run(s, GAP_MS + 500);
    expect(s.q.get(2)?.state).toBe('running');
  });

  it('a command that only answers ends after its reply; a refusal fails; silence ends after the limit', async () => {
    const h = harness({ goto: (x) => x.reply('usage: !goto <x y z> | <waypoint>'), wp: () => undefined });
    h.q.add('!goto nowhere', 'Steve', 'chat');
    h.q.add('!wp', 'Steve', 'chat');
    await run(h, GAP_MS + 6000);
    expect(h.q.get(1)).toMatchObject({ state: 'failed', end: 'usage: !goto <x y z> | <waypoint>', how: 'reply' });
    await run(h, GAP_MS + START_MAX_MS + 1000);
    expect(h.q.get(2)).toMatchObject({ state: 'done', end: '(no reply)' });
  });

  it('a multi-step job (the obtain job) is followed by its end line, across the gaps between its steps', async () => {
    const h = harness({
      get: (x) => {
        let fin!: (l: string) => void;
        const job = { result: new Promise<string>((r) => (fin = r)), finish: (l: string) => fin(l) };
        x.obtain = job;
        x.reply('get iron_pickaxe: 5 steps');
        // step 1 runs, a gap with nothing, step 2 runs, then the end line
        const s1 = x.start('gather');
        setTimeoutFake(x, 2000, () => s1.end({ ok: true }));
        setTimeoutFake(x, 6000, () => {
          const s2 = x.start('mine');
          setTimeoutFake(x, 2000, () => {
            s2.end({ ok: true });
            x.reply('get iron_pickaxe: done in 10 s, 5 steps');
            job.finish('get iron_pickaxe: done in 10 s, 5 steps');
            x.obtain = undefined;
          });
        });
      },
    });
    h.q.add('!get iron_pickaxe', 'Steve', 'chat');
    await run(h, GAP_MS + 250);
    expect(h.q.get(1)?.state).toBe('running');
    await run(h, 7000);
    expect(h.q.get(1)?.state).toBe('running'); // between the steps the job object holds it
    await run(h, 2000 + SETTLE_MS + 1000);
    expect(h.q.get(1)).toMatchObject({ state: 'done', end: 'get iron_pickaxe: done in 10 s, 5 steps', how: 'job' });
  });

  it('a typed command that does work pauses the queue and says so; the running job is watched to its end', async () => {
    const h = harness({ goto: walkFor(4000) });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    h.q.add('!goto 4 5 6', 'Steve', 'chat');
    await run(h, GAP_MS + 500);
    h.q.onTyped('status', []);
    expect(h.q.paused).toBe(false);
    h.q.onTyped('goto', ['7', '8', '9']);
    const typed = h.start('goto'); // the owner's own goto stacks over the job's
    expect(h.q.paused).toBe(true);
    expect(h.said.at(-1)).toMatch(/^queue: paused: !goto was typed; #1 !goto 1 2 3 is left to it; !queue resume goes on with #2 !goto 4 5 6/);
    await run(h, 4000 + SETTLE_MS + 1000);
    expect(h.q.get(1)?.state).toBe('done');
    expect(h.q.view().waiting.length).toBe(1);
    typed.end({ ok: true });
    await run(h, GAP_MS * 2);
    expect(h.q.get(2)?.state).toBe('waiting'); // paused: nothing starts
    h.q.resume();
    await run(h, GAP_MS + 500);
    expect(h.q.get(2)?.state).toBe('running');
  });

  it('a typed !stop ends the running job as cancelled, not failed', async () => {
    const h = harness({ goto: walkFor(60_000) });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    await run(h, GAP_MS + 500);
    h.q.onTyped('stop', []);
    h.users[0]!.end({ ok: false, reason: 'stopped' });
    await run(h, SETTLE_MS + 1000);
    expect(h.q.get(1)?.state).toBe('cancelled');
  });

  it('a job whose process the typed command replaced ends cancelled, with what it last said', async () => {
    const h = harness({ goto: walkFor(60_000) });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    await run(h, GAP_MS + 500);
    h.q.onTyped('goto', ['9', '9', '9']);
    h.users[0]!.end('replaced');
    h.start('goto');
    h.reply('walking to 9 9 9'); // the typed command's reply: not the job's
    await run(h, SETTLE_MS + 1000);
    expect(h.q.get(1)).toMatchObject({ state: 'cancelled', end: '!goto was typed (last: walking to 1 2 3)' });
  });

  it('a death fails the job', async () => {
    const h = harness({ goto: walkFor(60_000) });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    await run(h, GAP_MS + 500);
    h.users[0]!.end('death');
    await run(h, SETTLE_MS + 1000);
    expect(h.q.get(1)?.state).toBe('failed');
  });

  it('a death while a walk runs fails the job though the walk stops as interrupted (a real death, Track P5 e2e)', async () => {
    let dead = false;
    const h = harness({ goto: walkFor(60_000) }, undefined, { dead: () => dead });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    await run(h, GAP_MS + 500);
    h.reply('walking to 1 2 3');
    dead = true;
    await run(h, 500);
    h.users[0]!.end('interrupted');
    await run(h, SETTLE_MS + 1000);
    expect(h.q.get(1)).toMatchObject({ state: 'failed', end: 'the bot died during it (interrupted (last: walking to 1 2 3))' });
  });

  it('an interrupted walk with no death stays cancelled', async () => {
    const h = harness({ goto: walkFor(60_000) }, undefined, { dead: () => false });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    await run(h, GAP_MS + 500);
    h.users[0]!.end('interrupted');
    await run(h, SETTLE_MS + 1000);
    expect(h.q.get(1)?.state).toBe('cancelled');
  });

  it('does not start while a command, a fight or the night has the bot; a chore is waited for at most HOLD_MAX_MS', async () => {
    const h = harness({ goto: walkFor(1000) });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    h.active = proc('night', 'auto', 80);
    await run(h, GAP_MS * 3);
    expect(h.q.view().hold).toBe('night has the bot');
    expect(h.ran).toEqual([]);
    h.active = proc('milk', 'auto', 30);
    await run(h, GAP_MS * 2);
    expect(h.q.view().hold).toBe('the milk chore runs');
    expect(h.ran).toEqual([]);
    await run(h, HOLD_MAX_MS);
    expect(h.ran).toEqual(['!goto 1 2 3']);
    // a fight is never started over
    const f = harness({ goto: walkFor(1000) });
    f.q.add('!goto 1 2 3', 'Steve', 'chat');
    f.active = proc('guard', 'auto', 60);
    await run(f, HOLD_MAX_MS + GAP_MS);
    expect(f.ran).toEqual([]);
    // the bot dead or away
    const d = harness({ goto: walkFor(1000) });
    d.ready = false;
    d.q.add('!goto 1 2 3', 'Steve', 'chat');
    await run(d, GAP_MS * 2);
    expect(d.ran).toEqual([]);
    expect(d.q.view().hold).toMatch(/not in the game/);
  });

  it('never starts while the owner\'s own command runs', async () => {
    const h = harness({ goto: walkFor(1000) });
    const own = h.start('kill');
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    await run(h, GAP_MS * 2);
    expect(h.ran).toEqual([]);
    own.end({ ok: true });
    await run(h, GAP_MS + 500);
    expect(h.ran).toEqual(['!goto 1 2 3']);
  });

  it('skips a job when there is nobody to run it as', async () => {
    const h = harness({ goto: walkFor(1000) });
    h.owner = false;
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    await run(h, GAP_MS + 500);
    expect(h.q.get(1)).toMatchObject({ state: 'skipped', end: expect.stringMatching(/no owner/) as string });
  });

  it('remove, move, clear, retry', async () => {
    const h = harness({ goto: walkFor(60_000) });
    for (const c of ['!goto 1 1 1', '!goto 2 2 2', '!goto 3 3 3']) h.q.add(c, 'Steve', 'chat');
    expect(h.q.move(3, 1)).toBe('queue: #3 !goto 3 3 3 is 1 of 3');
    expect(h.q.waiting().map((j) => j.id)).toEqual([3, 1, 2]);
    expect(h.q.remove(1)).toBe('queue: removed #1 !goto 1 1 1');
    await run(h, GAP_MS + 500);
    expect(h.q.get(3)?.state).toBe('running');
    expect(h.q.remove(3, 'Steve')).toBe('queue: stopping #3 !goto 3 3 3');
    await run(h, SETTLE_MS + 1000);
    expect(h.q.get(3)).toMatchObject({ state: 'cancelled', how: 'removed', end: expect.stringMatching(/^stopped by !queue remove by Steve/) as string });
    expect(h.q.clear()).toMatch(/^queue: 1 waiting job removed/);
    const r = h.q.retry(3, 'Steve', 'chat');
    expect(r).toMatchObject({ ok: true, job: { command: '!goto 3 3 3', id: 4 } });
    expect(h.q.clear(true)).toBe('queue: 1 ended job dropped');
  });

  it('removing a running obtain job stops the job itself', async () => {
    const h = harness({
      get: (x) => {
        let fin!: (l: string) => void;
        x.obtain = { result: new Promise<string>((r) => (fin = r)), finish: (l: string) => { fin(l); x.obtain = undefined; } };
      },
    });
    h.q.add('!get bed', 'Steve', 'chat');
    await run(h, GAP_MS + 500);
    h.q.remove(1);
    await run(h, SETTLE_MS + 1000);
    expect(h.q.get(1)).toMatchObject({ state: 'cancelled', how: 'removed' });
  });

  it('a job over JOB_MAX_MS is stopped and fails', async () => {
    const h = harness({ goto: walkFor(JOB_MAX_MS * 2) });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    await run(h, GAP_MS + 500);
    h.t += JOB_MAX_MS;
    await run(h, SETTLE_MS + 1000);
    expect(h.q.get(1)).toMatchObject({ state: 'failed', how: 'limit' });
  }, 60_000);

  it('a restart: the job that was running is not run again, the rest go on', async () => {
    const h = harness({ goto: walkFor(60_000) });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    h.q.add('!goto 4 5 6', 'Steve', 'chat');
    await run(h, GAP_MS + 500);
    expect(h.saved?.jobs[0]?.state).toBe('running');
    const r = harness({ goto: walkFor(1000) }, h.saved);
    expect(r.q.get(1)).toMatchObject({ state: 'cancelled', how: 'restart', end: expect.stringMatching(/^stopped by a restart \(started \d+ s before\); not run again \(!queue retry 1 puts it back\)/) as string });
    expect(r.q.add('!goto 7 8 9', 'Steve', 'chat')).toMatchObject({ job: { id: 3 } });
    await run(r, GAP_MS + 500);
    expect(r.ran).toEqual(['!goto 4 5 6']);
    // with onfail stop the restart pauses it
    const s = harness({ goto: walkFor(60_000) });
    s.q.setOnFail('stop');
    s.q.add('!goto 1 2 3', 'Steve', 'chat');
    s.q.add('!goto 4 5 6', 'Steve', 'chat');
    await run(s, GAP_MS + 500);
    const s2 = harness({ goto: walkFor(1000) }, s.saved);
    expect(s2.q.paused).toBe(true);
    // a paused queue stays paused
    const p = harness({ goto: walkFor(1000) });
    p.q.add('!goto 1 2 3', 'Steve', 'chat');
    p.q.pause();
    const p2 = harness({ goto: walkFor(1000) }, p.saved);
    await run(p2, GAP_MS * 2);
    expect(p2.ran).toEqual([]);
  });

  it('keeps the newest HISTORY_KEEP ended jobs', async () => {
    const h = harness({ set: (x) => x.reply('ok') });
    for (let i = 0; i < HISTORY_KEEP + 5; i++) h.q.add('!set a b', 'Steve', 'chat');
    await run(h, (HISTORY_KEEP + 5) * (GAP_MS + 3000));
    const ended = h.q.jobs().filter((j) => j.state === 'done');
    expect(ended.length).toBe(HISTORY_KEEP);
    expect(ended[0]!.id).toBe(6);
  }, 60_000);

  it('the view and the lines', async () => {
    const h = harness({ goto: walkFor(60_000) });
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    h.q.add('!goto 4 5 6', 'Steve', 'panel');
    expect(h.q.view().hold).toBe(null);
    await run(h, 1000);
    expect(h.q.view().hold).toMatch(/^the gap between jobs/);
    await run(h, GAP_MS);
    const v = h.q.view();
    expect(v.running).toMatchObject({ id: 1, line: 'goto running' });
    expect(v.waiting.map((j) => j.via)).toEqual(['panel']);
    expect(h.q.lines()[0]).toBe('queue: running #1 !goto 1 2 3 (goto running); waiting #2 !goto 4 5 6');
    h.q.pause();
    expect(h.q.lines()[0]).toMatch(/^queue \(paused: !queue pause\):/);
  });
});

// ---- Track P5: a failed job asks the owner (askOwner; ADR 0116, docs/away.md)
describe('a failed job asks the owner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  /** A queue whose ask port is a real question box (askOwner on). */
  function asked(onFail: 'next' | 'stop' = 'next', waitMs = 60_000) {
    const box = new AskBox();
    const specs: Omit<AskSpec, 'waitMs'>[] = [];
    const h = harness({ goto: walkFor(1000, false) }, undefined, {
      ask: (s) => {
        specs.push(s);
        return box.ask({ ...s, waitMs }).answer;
      },
      isAnswer: (n) => (n === 'yes' || n === 'no') && box.takes(n) !== undefined,
    });
    h.q.setOnFail(onFail);
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    h.q.add('!goto 4 5 6', 'Steve', 'chat');
    return { h, box, specs };
  }
  const failFirst = (h: H): Promise<void> => run(h, GAP_MS + 1000 + SETTLE_MS + 1000);

  it('holds the queue until the answer; retry puts the job back first in line', async () => {
    const { h, box, specs } = asked();
    await failFirst(h);
    expect(h.q.get(1)?.state).toBe('failed');
    expect(specs[0]).toMatchObject({ key: ASK_KEY, default: 'next' });
    expect(specs[0]!.text).toBe('job #1 !goto 1 2 3 failed (goto: unreachable): retry it, go on with the next, or pause the queue?');
    expect(h.q.askingAbout()?.id).toBe(1);
    await run(h, GAP_MS * 3);
    expect(h.q.get(2)?.state).toBe('waiting'); // held, not run on
    expect(h.q.view().hold).toBe('the owner is asked about #1 (retry, next or stop)');
    expect(box.answer(['1', 'retry'], 'Steve', 'panel')).toBe('ask: #1 answered: retry');
    await run(h, 250);
    expect(h.said.at(-1)).toBe('queue: #1 again as #3 !goto 1 2 3 (Steve chose retry)');
    expect(h.q.waiting().map((j) => j.id)).toEqual([3, 2]);
    expect(h.q.get(3)?.via).toBe('panel');
    await run(h, GAP_MS + 500);
    expect(h.q.get(3)?.state).toBe('running');
  });

  it('next goes on; stop pauses the queue', async () => {
    const a = asked();
    await failFirst(a.h);
    a.box.answer(['next'], 'Steve', 'chat');
    await run(a.h, GAP_MS + 500);
    expect(a.h.q.get(2)?.state).toBe('running');
    const b = asked();
    await failFirst(b.h);
    b.box.answer(['3'], 'Steve', 'chat');
    await run(b.h, GAP_MS * 2);
    expect(b.h.q.paused).toBe(true);
    expect(b.h.q.get(2)?.state).toBe('waiting');
    expect(b.h.said.at(-1)).toBe('queue: paused: #1 !goto 1 2 3 failed (Steve chose stop); !queue resume goes on');
  });

  it('unanswered, the onfail rule decides when the wait runs out: next goes on, stop stays paused', async () => {
    vi.useFakeTimers();
    const a = asked('next', 20_000);
    await failFirst(a.h);
    await run(a.h, GAP_MS * 2);
    expect(a.h.q.get(2)?.state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(20_000);
    await run(a.h, GAP_MS + 500);
    expect(a.h.q.get(2)?.state).toBe('running');
    const b = asked('stop', 20_000);
    await failFirst(b.h);
    // with onfail stop the pause is made at once and kept on disk (a restart while asking leaves it paused)
    expect(b.h.q.paused).toBe(true);
    expect(b.h.saved?.paused).toBe(true);
    expect(b.h.saved?.why).toBe('#1 failed: the owner is asked');
    await vi.advanceTimersByTimeAsync(20_000);
    await run(b.h, GAP_MS * 2);
    expect(b.h.q.paused).toBe(true);
    expect(b.h.q.get(2)?.state).toBe('waiting');
    expect(b.h.said.at(-1)).toBe('queue: paused: #1 !goto 1 2 3 failed (unanswered: the onfail rule); !queue resume goes on');
    // onfail stop answered next: the pause made while asking is taken back
    const c = asked('stop');
    await failFirst(c.h);
    c.box.answer(['next'], 'Steve', 'chat');
    await run(c.h, GAP_MS + 500);
    expect(c.h.q.paused).toBe(false);
    expect(c.h.q.get(2)?.state).toBe('running');
  });

  it('askOwner off (no port answer): the onfail rule acts at once, as before; !yes / !no that answer do not pause the queue', async () => {
    const h = harness({ goto: walkFor(1000, false) }, undefined, { ask: () => undefined });
    h.q.setOnFail('stop');
    h.q.add('!goto 1 2 3', 'Steve', 'chat');
    await failFirst(h);
    expect(h.q.paused).toBe(true);
    expect(h.q.askingAbout()).toBeUndefined();
    const a = asked();
    await failFirst(a.h);
    a.h.q.onTyped('yes', []);
    expect(a.h.q.paused).toBe(false);
    a.h.q.onTyped('goto', ['7', '8', '9']);
    expect(a.h.q.paused).toBe(true); // work typed: paused as always
    a.box.dispose();
  });
});
