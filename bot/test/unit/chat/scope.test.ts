// Track D2 (chat/scope.ts, ADR 0118 addendum): which command a line belongs to. Chat.handle runs every command line in a
// scope of its own; its replies (during the call and later), its timers' and promises' lines and its user processes'
// lines carry it; a step another command dispatches stays in that command's scope; a line from nobody's command has none.
// (sayKept's scope: chat.test.ts.)
import { describe, expect, it } from 'vitest';
import { Chat, parseOwners } from '../../../src/chat/chat.ts';
import { currentScope, inScope, newScope, outsideScope, type CommandScope } from '../../../src/chat/scope.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { viaDiscord, viaPanel } from '../../../src/events/actor.ts';
import { ProcessManager, PRIORITY, type Process } from '../../../src/tasks/process/manager.ts';
import { setup } from '../connection-fakes.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const line = (body: string): ChatLine => ({ type: 'chat', source: 'Steve', message: body, body, xuid: '', truth: false });

function world() {
  const { conn } = setup();
  const chat = new Chat(conn, { owners: parseOwners(['Steve']), log: silent, maxReplies: 100 });
  const said: { m: string; scope: CommandScope | undefined }[] = [];
  const orig = chat.say.bind(chat);
  chat.say = (m: string) => {
    said.push({ m, scope: currentScope() });
    return orig(m);
  };
  return { chat, said, scopeOf: (m: string) => said.find((s) => s.m === m)?.scope };
}

describe('command scopes', () => {
  it('a typed line gets a scope of its own: the reply during the call, a later reply, a timer and a promise carry it', async () => {
    const w = world();
    let later: (() => void) | undefined;
    w.chat.register({
      name: 'walk',
      help: '',
      run: ({ reply }) => {
        reply('walking');
        later = () => reply('arrived'); // the reply closure, called from outside any scope
        setTimeout(() => w.chat.say('a timer line'), 5);
        void Promise.resolve().then(() => w.chat.say('a promise line'));
      },
    });
    w.chat.handle(line('!walk'), true);
    await new Promise((r) => setTimeout(r, 20));
    outsideScope(() => later!());
    const s = w.scopeOf('walking')!;
    expect(s).toMatchObject({ via: 'chat', command: '!walk' });
    for (const m of ['arrived', 'a timer line', 'a promise line']) expect(w.scopeOf(m)).toBe(s);
    w.chat.say('a chore line');
    expect(w.scopeOf('a chore line')).toBeUndefined();
  });

  it('the panel and Discord: each command its own scope, marked by where it came from; a given scope is used', () => {
    const w = world();
    w.chat.register({ name: 'pos', help: '', run: ({ reply, args }) => reply(`pos ${args[0] ?? ''}`) });
    viaPanel(() => w.chat.handle(line('!pos a'), true));
    viaDiscord(() => w.chat.handle(line('!pos b'), true));
    w.chat.handle(line('!pos c'), true);
    const given = newScope('discord', '!pos d');
    viaDiscord(() => w.chat.handle(line('!pos d'), true, given));
    expect(w.scopeOf('pos a')?.via).toBe('panel');
    expect(w.scopeOf('pos b')?.via).toBe('discord');
    expect(w.scopeOf('pos c')?.via).toBe('chat');
    expect(w.scopeOf('pos d')).toBe(given);
    expect(new Set(['pos a', 'pos b', 'pos c', 'pos d'].map((m) => w.scopeOf(m)?.id)).size).toBe(4);
  });

  it('a step dispatched by a command (not typed, nested or later) stays in that command\'s scope; a typed line inside one does not', async () => {
    const w = world();
    w.chat.register({ name: 'step', help: '', run: ({ reply }) => reply('step done') });
    w.chat.register({
      name: 'job',
      help: '',
      run: ({ reply }) => {
        reply('job started');
        setTimeout(() => w.chat.handle(line('!step')), 5); // the obtain job's next step, later
      },
    });
    w.chat.handle(line('!job'), true);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.scopeOf('step done')).toBe(w.scopeOf('job started'));
    // the queue's dispatch: its own scope, taken by the (not typed) line
    const q = newScope('queue', '!step');
    w.said.length = 0;
    inScope(q, () => w.chat.handle(line('!step')));
    expect(w.scopeOf('step done')).toBe(q);
    // a typed line while another command's scope is current (a socket opened in it) is still a command of its own
    w.said.length = 0;
    inScope(q, () => w.chat.handle(line('!step'), true));
    expect(w.scopeOf('step done')).not.toBe(q);
  });

  it('the process manager runs a user process in the scope that added it, an auto process in none', () => {
    const seen: { user: (CommandScope | undefined)[]; auto: (CommandScope | undefined)[] } = { user: [], auto: [] };
    const proc = (kind: 'user' | 'auto', priority: number): Process => ({
      name: kind,
      kind,
      priority,
      done: false,
      wants: () => true,
      start: () => seen[kind].push(currentScope()),
      resume: () => undefined,
      pause: () => undefined,
      stop: () => seen[kind].push(currentScope()),
      tick: () => seen[kind].push(currentScope()),
      status: () => ({ line: kind }),
    });
    const m = new ProcessManager();
    const s = newScope('discord', '!goto home');
    const u = proc('user', PRIORITY.user);
    inScope(s, () => m.add(u));
    m.tick();
    const other = newScope('panel', '!status');
    inScope(other, () => m.tick()); // a tick that happens to run inside another command's call
    expect(seen.user).toEqual([s, s, s]);
    const a = proc('auto', PRIORITY.flee);
    inScope(other, () => m.add(a)); // an auto process requested inside a command: still nobody's
    m.tick();
    expect(seen.auto.every((x) => x === undefined)).toBe(true);
    inScope(other, () => m.stop(u));
    expect(seen.user.at(-1)).toBe(s);
  });
});
