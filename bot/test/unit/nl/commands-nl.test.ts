// PLAN.md 7.18 (Track Y): !do / !yes / !no and addressed chat on the real Chat (stub connection).
import { describe, expect, it } from 'vitest';
import { Chat, parseOwners } from '../../../src/chat/chat.ts';
import { nlProviderFrom, registerNlCommands } from '../../../src/chat/commands-nl.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import type { Connection } from '../../../src/connection/connection.ts';
import { silentLogger } from '../../../src/log.ts';
import { FakeProvider } from '../../../src/nl/fake.ts';
import { OllamaProvider } from '../../../src/nl/ollama.ts';
import { NL_PROVIDER_KEY, NL_VALUE_KEY, resolveNlConfig } from '../../../src/nl/provider.ts';
import type { CommandDeps } from '../../../src/tasks/process/deps.ts';
import { isOwner, type Sender } from '../../../src/chat/chat.ts';
import { until } from './helpers.ts';

const line = (source: string, body: string, type: ChatLine['type'] = 'chat'): ChatLine => ({ type, source, message: body, body, xuid: '', truth: false });

function setup(values: Record<string, unknown>) {
  const sent: string[] = [];
  const conn = { state: 'spawned', username: 'Bot', queue: (_n: string, p: { message: string }) => sent.push(p.message), on: () => () => undefined } as unknown as Connection;
  const chat = new Chat(conn, { owners: parseOwners(['Steve']), log: silentLogger, maxReplies: 100 });
  chat.register({ name: 'goto', help: '<waypoint> | x y z (walk)', run: ({ args, reply }) => reply(`arrived at ${args.join(' ')}`) });
  chat.register({ name: 'guard', help: 'on | off', run: ({ args, reply }) => reply(`guard ${args[0]}, radius 16`) });
  let stopped = false;
  const settings = new RuntimeSettings();
  const d = {
    chat,
    task: { name: 'afk', start: () => undefined, stop: () => (stopped = true), status: () => ({ nav: { waypoints: [{ name: 'home' }] } }), position: () => ({ x: 0, y: -60, z: 0 }) },
    settings,
    processes: { userProcesses: () => [] },
    log: silentLogger,
    isOwner: (s: Sender) => isOwner(s, chat.owners),
    selfName: () => 'Bot',
    position: () => ({ x: 0, y: -60, z: 0 }),
  } as unknown as CommandDeps;
  const fe = registerNlCommands(d, values);
  return { sent, chat, d, fe, settings, stopped: () => stopped };
}

describe('nl chat commands', () => {
  const fake = () =>
    new FakeProvider([
      ['walk home then guard', { steps: [{ command: 'goto', waypoint: 'home' }, { command: 'guard', mode: 'on' }] }],
      ['walk home', { steps: [{ command: 'goto', waypoint: 'home' }] }],
    ]);

  it('!do shows the plan, !yes runs it through the chat commands', async () => {
    const provider = fake();
    const { sent, chat } = setup({ [NL_PROVIDER_KEY]: provider });
    chat.handle(line('Server', '!do walk home then guard', 'whisper'));
    await until(() => sent.length === 1);
    expect(sent).toEqual(['plan: goto home, then guard on (!yes to run, !no to drop)']);
    expect(provider.requests[0]!.user).toBe('request from console: walk home then guard');
    expect(provider.requests[0]!.system).toContain('waypoints: home');
    expect(provider.requests[0]!.system).toContain('[chat: !goto <waypoint> | x y z (walk)]');
    chat.handle(line('Server', '!yes', 'whisper'));
    await until(() => sent.length === 4, 5000);
    expect(sent.slice(1)).toEqual(['arrived at home', 'guard on, radius 16', 'plan done (2 steps)']);
  });

  it('owner chat addressed to the bot goes the same way; others are ignored', async () => {
    const { sent, chat } = setup({ [NL_PROVIDER_KEY]: fake() });
    chat.handle(line('Alex', 'Bot, walk home'));
    chat.handle(line('Steve', 'hello everyone, walk home'));
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toEqual([]);
    chat.handle(line('Steve', '@Bot walk home'));
    await until(() => sent.length === 1);
    expect(sent[0]).toBe('plan: goto home (!yes to run, !no to drop)');
    chat.handle(line('Steve', '!no'));
    expect(sent[1]).toBe('plan dropped');
  });

  it('nlConfirm off runs the plan at once', async () => {
    const { sent, chat, settings } = setup({ [NL_PROVIDER_KEY]: fake() });
    settings.set('nlConfirm', 'off');
    chat.handle(line('Steve', 'Bot, walk home'));
    await until(() => sent.length === 2);
    expect(sent).toEqual(['plan: goto home', 'arrived at home']);
  });

  it('provider none: !do says it is off and addressed chat is ignored', async () => {
    const { sent, chat, d, stopped } = setup({ [NL_VALUE_KEY]: resolveNlConfig({ provider: 'none' }) });
    chat.handle(line('Steve', 'Bot, walk home'));
    chat.handle(line('Steve', '!do walk home'));
    await until(() => sent.length === 1);
    expect(sent).toEqual(['natural language is off (nl.provider is none; docs/natural-language.md)']);
    d.task.stop();
    expect(stopped()).toBe(true);
  });

  it('picks the provider from the task values', () => {
    expect(nlProviderFrom({})).toBeUndefined();
    expect(nlProviderFrom({ [NL_VALUE_KEY]: resolveNlConfig({ provider: 'ollama' }) })).toBeInstanceOf(OllamaProvider);
    const f = fake();
    expect(nlProviderFrom({ [NL_PROVIDER_KEY]: f, [NL_VALUE_KEY]: resolveNlConfig({ provider: 'ollama' }) })).toBe(f);
  });
});
