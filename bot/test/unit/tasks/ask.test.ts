// Track P5: ask the owner (tasks/ask.ts, chat/commands-ask.ts, `!yes` / `!no` in chat/commands-nl.ts; ADR 0116, docs/away.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat, isOwner, parseOwners, type Sender } from '../../../src/chat/chat.ts';
import { askBoxOf, registerAskCommands } from '../../../src/chat/commands-ask.ts';
import { registerNlCommands } from '../../../src/chat/commands-nl.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import type { Connection } from '../../../src/connection/connection.ts';
import { events } from '../../../src/events/bus.ts';
import { viaPanel } from '../../../src/events/actor.ts';
import type { BotEvent } from '../../../src/events/registry.ts';
import { silentLogger } from '../../../src/log.ts';
import { FakeProvider } from '../../../src/nl/fake.ts';
import { NL_PROVIDER_KEY } from '../../../src/nl/provider.ts';
import { ASK_MAX_MS, ASK_MIN_MS, ASK_OPEN_MAX, AskBox, type AskAnswer, type AskSpec } from '../../../src/tasks/ask.ts';
import type { CommandDeps } from '../../../src/tasks/process/deps.ts';

const spec = (o: Partial<AskSpec> = {}): AskSpec => ({
  key: 'queue-fail',
  text: 'job #4 !goto 1 2 3 failed (unreachable): retry it, go on with the next, or pause the queue?',
  choices: [
    { id: 'retry', label: 'retry it', aliases: ['yes'] },
    { id: 'next', label: 'go on with the next', aliases: ['no'] },
    { id: 'stop', label: 'pause the queue' },
  ],
  default: 'next',
  waitMs: 60_000,
  ...o,
});

describe('the question box', () => {
  let seen: BotEvent[];
  let off: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
    off = events.subscribe((e) => {
      if (e.kind.startsWith('ask.')) seen.push(e);
    });
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  it('unanswered, the default is taken when the wait runs out; the wait is bounded both ways', async () => {
    const said: string[] = [];
    const box = new AskBox({ say: (m) => said.push(m) });
    const q = box.ask(spec({ waitMs: 1000 })); // under the minimum: ASK_MIN_MS
    expect(said[0]).toBe(`ask #1: ${spec().text} !answer 1 retry|next|stop (!yes retry, !no next); in 10 s: next`);
    expect(box.list()[0]!.until - box.list()[0]!.askedAt).toBe(ASK_MIN_MS);
    let got: AskAnswer | undefined;
    void q.answer.then((a) => (got = a));
    await vi.advanceTimersByTimeAsync(ASK_MIN_MS - 1);
    expect(got).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(got).toMatchObject({ id: 1, choice: 'next', how: 'timeout' });
    expect(box.size).toBe(0);
    const long = box.ask(spec({ waitMs: 10 * ASK_MAX_MS }));
    expect(box.list()[0]!.until - box.list()[0]!.askedAt).toBe(ASK_MAX_MS);
    box.dispose();
    expect(await long.answer).toMatchObject({ choice: 'next', how: 'closed' });
    expect(seen.map((e) => `${e.kind} ${e.sev} ${(e.data as { how?: string }).how ?? ''}`)).toEqual(['ask.asked notable ', 'ask.answered info timeout', 'ask.asked notable ', 'ask.answered info closed']);
    expect(box.stats).toEqual({ asked: 2, answered: 0, timedOut: 1 });
  });

  it('is answered by its word, number or alias, with or without the id; a wrong word says the choices', async () => {
    const box = new AskBox();
    const a = box.ask(spec());
    expect(box.answer(['maybe'], 'Steve', 'chat')).toBe('ask: #1 has no choice maybe (1 retry, 2 next, 3 stop)');
    expect(box.answer(['3'], 'Steve', 'chat')).toBe('ask: #1 answered: stop');
    expect(await a.answer).toMatchObject({ choice: 'stop', how: 'chat', by: 'Steve' });
    const b = box.ask(spec());
    expect(box.answer(['2', 'yes'], 'Steve', 'panel')).toBe('ask: #2 answered: retry');
    expect(await b.answer).toMatchObject({ id: 2, choice: 'retry', how: 'panel' });
    expect(box.answer(['1', 'retry'], 'Steve', 'chat')).toBe('ask: no question #1 waits');
    expect(box.answer([], undefined, 'chat')).toBe('ask: no question waits');
  });

  it('a second question of the same key replaces the first; more than ASK_OPEN_MAX close the oldest; two open need the id', async () => {
    const box = new AskBox();
    const first = box.ask(spec());
    box.ask(spec());
    expect(await first.answer).toMatchObject({ id: 1, choice: 'next', how: 'replaced' });
    const others = Array.from({ length: ASK_OPEN_MAX }, (_, i) => box.ask(spec({ key: `k${i}` })));
    expect(box.size).toBe(ASK_OPEN_MAX);
    expect(box.list().map((v) => v.id)).toEqual([3, 4, 5, 6]); // #2 closed with its default
    expect(box.answer(['retry'], 'Steve', 'chat')).toBe('ask: 4 questions wait (#3, #4, #5, #6): !answer <id> <choice>');
    expect(box.answer(['5', 'retry'], 'Steve', 'chat')).toBe('ask: #5 answered: retry');
    expect(await others[2]!.answer).toMatchObject({ choice: 'retry' });
    box.dispose();
  });

  it('!yes / !no take a question only when exactly one open question has that word', () => {
    const box = new AskBox();
    expect(box.takes('yes')).toBeUndefined();
    box.ask(spec());
    expect(box.takes('yes')?.id).toBe(1);
    expect(box.takes('no')?.id).toBe(1);
    box.ask(spec({ key: 'other' }));
    expect(box.takes('yes')).toBeUndefined(); // two would: neither is guessed
    expect(box.answerWord('yes', 'Steve', 'chat')).toBe('ask: no question takes !yes');
    box.ask(spec({ key: 'third', choices: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }], default: 'a' }));
    box.close('other');
    expect(box.takes('no')?.id).toBe(1);
    expect(box.answerWord('no', 'Steve', 'chat')).toBe('ask: #1 answered: next');
    box.dispose();
  });

  it('refuses a default that is not a choice', () => {
    expect(() => new AskBox().ask(spec({ default: 'later' }))).toThrow(/not one of the choices/);
  });
});

// ---- the chat commands on the real Chat (stub connection)

const line = (source: string, body: string, type: ChatLine['type'] = 'chat'): ChatLine => ({ type, source, message: body, body, xuid: '', truth: false });

function setup(provider = new FakeProvider([['walk home', { steps: [{ command: 'goto', waypoint: 'home' }] }]])) {
  const sent: string[] = [];
  const conn = { state: 'spawned', username: 'Bot', queue: (_n: string, p: { message: string }) => sent.push(p.message), on: () => () => undefined } as unknown as Connection;
  const chat = new Chat(conn, { owners: parseOwners(['Steve']), log: silentLogger, maxReplies: 100 });
  chat.register({ name: 'goto', help: '<waypoint> (walk)', run: ({ args, reply }) => reply(`arrived at ${args.join(' ')}`) });
  const task = { name: 'afk', start: () => undefined, stop: () => undefined, status: () => ({ nav: { waypoints: [{ name: 'home' }] } }), position: () => ({ x: 0, y: -60, z: 0 }) };
  const d = {
    chat,
    task,
    settings: new RuntimeSettings(),
    processes: { userProcesses: () => [] },
    log: silentLogger,
    isOwner: (s: Sender) => isOwner(s, chat.owners),
    selfName: () => 'Bot',
    position: () => ({ x: 0, y: -60, z: 0 }),
  } as unknown as CommandDeps;
  registerAskCommands(d);
  registerNlCommands(d, { [NL_PROVIDER_KEY]: provider });
  return { sent, chat, box: askBoxOf(task)!, task };
}

describe('the answer from chat and from the panel', () => {
  it('!answer lists, answers by id and word; the panel line is marked panel', async () => {
    const { sent, chat, box } = setup();
    const q = box.ask(spec());
    expect(sent.at(-1)).toMatch(/^ask #1: job #4/);
    chat.handle(line('Steve', '!answer'));
    expect(sent.at(-1)).toMatch(/^ask #1: .* !answer 1 retry\|next\|stop/);
    chat.handle(line('Alex', '!answer 1 retry')); // not an owner: ignored
    expect(box.size).toBe(1);
    viaPanel(() => chat.handle(line('Steve', '!answer 1 stop'), true));
    expect(await q.answer).toMatchObject({ choice: 'stop', how: 'panel', by: 'Steve' });
    expect(sent.at(-1)).toBe('ask: #1 answered: stop');
  });

  it('!yes and !no answer the question when no plan waits, and run or drop a plan when one does', async () => {
    const { sent, chat, box } = setup();
    const q = box.ask(spec());
    chat.handle(line('Steve', '!yes'));
    expect(await q.answer).toMatchObject({ choice: 'retry', how: 'chat', by: 'Steve' });
    const r = box.ask(spec());
    chat.handle(line('Steve', '!no'));
    expect(await r.answer).toMatchObject({ choice: 'next', how: 'chat' });
    // a plan from !do waits: !yes runs the plan, the question stays
    const s = box.ask(spec());
    chat.handle(line('Steve', '!do walk home'));
    for (let i = 0; i < 50 && !sent.some((m) => m.startsWith('plan:')); i++) await new Promise((res) => setTimeout(res, 10));
    expect(sent.some((m) => m.startsWith('plan: goto home'))).toBe(true);
    chat.handle(line('Steve', '!yes'));
    for (let i = 0; i < 50 && !sent.includes('arrived at home'); i++) await new Promise((res) => setTimeout(res, 10));
    expect(sent).toContain('arrived at home');
    expect(box.size).toBe(1);
    box.dispose();
    expect(await s.answer).toMatchObject({ how: 'closed' });
  });

  it('the task stopping closes every question with its default', async () => {
    const { box, task } = setup();
    const q = box.ask(spec({ default: 'stop' }));
    task.stop();
    expect(await q.answer).toMatchObject({ choice: 'stop', how: 'closed' });
    expect(askBoxOf(task)).toBeUndefined();
  });
});
