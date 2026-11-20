// Track P4: the typed flag of the chat, the queue file, the owner line, the standing goals (ADR 0115, docs/queue.md).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat, parseOwners, type CommandEvent } from '../../../src/chat/chat.ts';
import { loadQueueFile, ownerLine, queueFileOf, saveQueueFile } from '../../../src/chat/commands-queue.ts';
import { parseText } from '../../../src/chat/text.ts';
import type { TextPacket } from '../../../src/connection/types.ts';
import { silentLogger } from '../../../src/log.ts';
import { DEFAULT_GOALS, StandingGoals, goalDefs, registerGoal } from '../../../src/tasks/goals.ts';
import type { Process } from '../../../src/tasks/process/manager.ts';
import { connectAndSpawn, setup } from '../connection-fakes.ts';

const text = (p: Partial<TextPacket>): TextPacket => ({ needs_translation: false, category: 'authored', type: 'chat', message: '', xuid: '', ...p });

describe('the typed flag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('a line from the server is typed; a dispatch inside a handler and a plain handle() are not', async () => {
    const { conn, clients } = setup({ username: 'Bot' });
    const chat = new Chat(conn, { owners: parseOwners(['Steve']), log: silentLogger });
    chat.register({ name: 'goto', help: '', run: () => undefined });
    chat.register({
      name: 'get',
      help: '',
      run: ({ line }) => {
        chat.handle({ ...line, body: '!goto 1 2 3', message: '!goto 1 2 3' }); // a job's step
      },
    });
    chat.start();
    const events: CommandEvent[] = [];
    chat.onCommand((e) => events.push(e));
    const client = await connectAndSpawn(conn, clients);
    client.receive('text', text({ source_name: 'Steve', message: '!get bed' }));
    chat.handle(parseText(text({ source_name: 'Steve', message: '!goto 4 5 6' })));
    chat.handle(parseText(text({ source_name: 'Steve', message: '!goto 7 8 9' })), true); // the panel's
    expect(events.map((e) => (e.kind === 'run' ? `${e.name} ${(e.args ?? []).join(' ')} ${String(e.typed)}` : e.kind))).toEqual(['get bed true', 'goto 1 2 3 false', 'goto 4 5 6 false', 'goto 7 8 9 true']);
    chat.stop();
  });
});

describe('the queue file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  it('is kept beside the waypoints, per server, or in BEDROCKBOT_QUEUE_DIR, or nowhere with --no-config', () => {
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, '{}');
    const f = queueFileOf({ config: cfg, host: '127.0.0.1', port: 19132 }, {});
    expect(f).toMatch(/[\\/]queue[\\/][^\\/]+\.json$/);
    expect(f!.startsWith(dir)).toBe(true);
    expect(queueFileOf({ config: cfg }, { BEDROCKBOT_QUEUE_DIR: join(dir, 'q') })!.startsWith(join(dir, 'q'))).toBe(true);
    expect(queueFileOf({ 'no-config': true }, {})).toBeUndefined();
    expect(queueFileOf(undefined)).toBeUndefined();
  });
  it('is written atomically and read back; a broken file is an empty queue', () => {
    const f = join(dir, 'queue', 'x.json');
    saveQueueFile(f, { v: 1, paused: true, why: 'w', onFail: 'stop', nextId: 3, jobs: [{ id: 2, command: '!goto 1 2 3', by: 'Steve', via: 'chat', addedAt: 1, state: 'waiting' }] });
    expect(loadQueueFile(f)).toMatchObject({ paused: true, onFail: 'stop', nextId: 3, jobs: [{ id: 2 }] });
    writeFileSync(f, '{nope');
    const warn: string[] = [];
    expect(loadQueueFile(f, (m) => warn.push(m))).toBeUndefined();
    expect(warn[0]).toMatch(/could not be read/);
    writeFileSync(f, JSON.stringify({ v: 2, jobs: [] }));
    expect(loadQueueFile(f, (m) => warn.push(m))).toBeUndefined();
    expect(loadQueueFile(join(dir, 'none.json'))).toBeUndefined();
    expect(readFileSync(f, 'utf8')).toContain('"v":2');
  });
});

describe('the owner line', () => {
  it('is the first owner name, else the first XUID, else the console, else none', () => {
    expect(ownerLine({ names: ['Steve', 'Alex'], xuids: [], allowConsole: true }, '!goto 1 2 3')).toMatchObject({ type: 'chat', source: 'Steve', body: '!goto 1 2 3' });
    expect(ownerLine({ names: [], xuids: ['42'], allowConsole: true }, '!x')).toMatchObject({ type: 'chat', xuid: '42' });
    expect(ownerLine({ names: [], xuids: [], allowConsole: true }, '!x')).toMatchObject({ type: 'announcement', source: 'Server', message: '[Server] !x' });
    expect(ownerLine({ names: [], xuids: [], allowConsole: false }, '!x')).toBeUndefined();
  });
});

describe('standing goals', () => {
  function manager() {
    const fns: ((e: { kind: 'control'; from: string | undefined; to: string | undefined }) => void)[] = [];
    const m = {
      active: undefined as Process | undefined,
      procs: [] as Process[],
      find: (n: string) => m.procs.filter((p) => p.name === n),
      onControl: (fn: (typeof fns)[number]) => {
        fns.push(fn);
        return () => undefined;
      },
      control(to: Process | undefined) {
        const from = m.active?.name;
        m.active = to;
        for (const f of fns) f({ kind: 'control', from, to: to?.name });
      },
    };
    return m;
  }
  const chore = (name: string, last?: unknown): Process => ({ name, kind: 'auto', priority: 30, status: () => ({ line: `${name} (taking)` }), last }) as unknown as Process;

  it('lists every chore with its switch, target, last run and how it shares the body with the queue', () => {
    const m = manager();
    const task = {};
    let t = 1000;
    const settings: Record<string, unknown> = { autoFood: true, autoMilk: false, milkKeep: 2, foodMin: 10, fireworksKeep: 64, chorePen: 'none' };
    let q = { running: false, waiting: 0 };
    const g = new StandingGoals({ task, settings: (k) => (settings[k] ?? false) as boolean, processes: m, queue: () => q, now: () => t });
    const ids = g.list().map((x) => x.id);
    expect(ids).toEqual(DEFAULT_GOALS.map((d) => d.id));
    expect(g.list().find((x) => x.id === 'milk')).toMatchObject({ on: false, target: '2 milk buckets', relation: 'off', lastAt: null });
    const milk = chore('milk');
    m.procs.push(milk);
    settings.autoMilk = true;
    q = { running: false, waiting: 2 };
    m.control(milk);
    expect(g.list().find((x) => x.id === 'milk')).toMatchObject({ on: true, running: true, relation: 'queue waits', lastAt: 1000, lastS: null });
    t = 41_000;
    (milk as unknown as { last: unknown }).last = { before: 0, after: 2, keep: 2, fromBoxes: 0, fromHome: 0, crafted: 0, milked: 2, kinds: { cow: 2 }, empty: 0, reason: 'done' };
    m.control(undefined);
    expect(g.list().find((x) => x.id === 'milk')).toMatchObject({ running: false, lastAt: 1000, lastS: 40, lastLine: expect.stringMatching(/^milk: 2 milk buckets carried/) as string, relation: 'idle' });
    q = { running: true, waiting: 1 };
    expect(g.list().find((x) => x.id === 'milk')?.relation).toBe('waits for the queue');
    expect(g.list().find((x) => x.id === 'food')?.target).toBe('at least 10 hunger points carried');
    expect(g.parts().find((p) => p.startsWith('milk'))).toMatch(/^milk on \(autoMilk; 2 milk buckets\), waits for the queue; last 40 s ago: milk: 2 milk buckets carried/);
  });

  it('a chore that gives control back with no control event (a yield to idle) is closed by the sweep', () => {
    const m = manager();
    let t = 1000;
    const g = new StandingGoals({ task: {}, settings: () => true, processes: m, now: () => t });
    const unload = chore('home-chore');
    m.procs.push(unload);
    m.control(unload);
    t = 4000;
    m.active = undefined; // the manager's yieldControl: no event when nothing else wants control
    g.sweep(); // the queue's poll
    t = 90_000;
    expect(g.list().find((x) => x.id === 'unload')).toMatchObject({ running: false, lastAt: 1000, lastS: 3 });
  });

  it('a chore joins with one line (K6: autoMend), or replaces a default with its id', () => {
    const task = {};
    registerGoal(task, { id: 'mend', label: 'mending', setting: 'autoFood', process: 'mendchore', target: () => 'at 50 %' });
    registerGoal(task, { id: 'mend', label: 'mending', setting: 'autoFood', process: 'mendchore', target: () => 'at 40 %' });
    registerGoal(task, { id: 'food', label: 'food', setting: 'autoFood' });
    const defs = goalDefs(task);
    expect(defs.filter((d) => d.id === 'mend').length).toBe(1);
    expect(defs.at(-1)?.id).toBe('food');
    expect(defs.length).toBe(DEFAULT_GOALS.length + 1);
    expect(goalDefs({}).length).toBe(DEFAULT_GOALS.length);
  });
});
