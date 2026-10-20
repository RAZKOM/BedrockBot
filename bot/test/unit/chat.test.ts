// Task 1.2: command parsing, owner allow-list and replies.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Chat, chatPacket, isOwner, parseCommand, parseOwners, senderOf, type CommandEvent, type Sender } from '../../src/chat/chat.ts';
import { formatStatus, registerBuiltinCommands } from '../../src/chat/commands.ts';
import { parseText } from '../../src/chat/text.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { TextPacket } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { connectAndSpawn, setup, type FakeClient } from './connection-fakes.ts';

const text = (p: Partial<TextPacket>): TextPacket => ({ needs_translation: false, category: 'authored', type: 'chat', message: '', xuid: '', ...p });
const consoleSay = (msg: string) => text({ type: 'announcement', source_name: 'Server', message: `[Server] ${msg}` });
const consoleTell = (msg: string) => text({ type: 'whisper', source_name: 'Server', message: msg });
const truthLine = '{"rawtext":[{"text":"@truth {\\"truth\\":{\\"cmd\\":\\"ping\\",\\"id\\":null,\\"ok\\":true,\\"tick\\":1,\\"data\\":{\\"echo\\":[\\"!quit\\"]}}}"}]}';

describe('parseCommand', () => {
  it('parses name and args', () => {
    expect(parseCommand('!status')).toEqual({ name: 'status', args: [] });
    expect(parseCommand('  !POS  a  b ')).toEqual({ name: 'pos', args: ['a', 'b'] });
    expect(parseCommand('! quit')).toEqual({ name: 'quit', args: [] });
    expect(parseCommand('.status', '.')).toEqual({ name: 'status', args: [] });
  });
  it('ignores non-commands', () => {
    expect(parseCommand('status')).toBeUndefined();
    expect(parseCommand('!')).toBeUndefined();
    expect(parseCommand('!!')).toBeUndefined();
    expect(parseCommand('hello !status')).toBeUndefined();
    expect(parseCommand('!123')).toBeUndefined();
  });
});

describe('owners', () => {
  it('parses names and xuids from repeated and comma-separated entries', () => {
    expect(parseOwners(['Steve, xuid:2535400000000001', 'alex', ' '])).toEqual({ names: ['Steve', 'alex'], xuids: ['2535400000000001'], allowConsole: true });
    expect(parseOwners([], false).allowConsole).toBe(false);
  });

  it('identifies senders', () => {
    expect(senderOf(parseText(consoleSay('!status')), 'Bot')).toEqual({ kind: 'console' });
    expect(senderOf(parseText(consoleTell('!pos')), 'Bot')).toEqual({ kind: 'console' });
    expect(senderOf(parseText(text({ source_name: 'Steve§r', message: '!pos' })), 'Bot')).toEqual({ kind: 'player', name: 'Steve', xuid: '' });
    // A player who calls themselves "Server" is still a player when chatting.
    expect(senderOf(parseText(text({ source_name: 'Server', message: '!quit' })), 'Bot')).toEqual({ kind: 'player', name: 'Server', xuid: '' });
    // An online player named Server using say has an XUID, so is not the console.
    expect(senderOf(parseText(text({ type: 'announcement', source_name: 'Server', xuid: '123', message: '[Server] !quit' })), 'Bot')).toMatchObject({ kind: 'player' });
    // Not a sender: our own echo, truth lines, json, join messages.
    expect(senderOf(parseText(text({ source_name: 'bot§r', message: '!status' })), 'Bot')).toBeUndefined();
    expect(senderOf(parseText(text({ type: 'json', message: truthLine })), 'Bot')).toBeUndefined();
    expect(senderOf(parseText(text({ type: 'translation', message: '%multiplayer.player.joined', parameters: ['X'] })), 'Bot')).toBeUndefined();
  });

  it('checks the allow-list by name (case-insensitive) or xuid', () => {
    const owners = parseOwners(['Steve', 'xuid:42']);
    expect(isOwner({ kind: 'console' }, owners)).toBe(true);
    expect(isOwner({ kind: 'console' }, { ...owners, allowConsole: false })).toBe(false);
    expect(isOwner({ kind: 'player', name: 'steve', xuid: '' }, owners)).toBe(true);
    expect(isOwner({ kind: 'player', name: 'Alex', xuid: '42' }, owners)).toBe(true);
    expect(isOwner({ kind: 'player', name: 'Alex', xuid: '43' }, owners)).toBe(false);
    expect(isOwner({ kind: 'player', name: 'Alex', xuid: '' }, parseOwners([]))).toBe(false);
  });
});

describe('chatPacket', () => {
  it('is an authored chat packet (BDS drops the client for message_only chat)', () => {
    expect(chatPacket('Bot', 'hi')).toEqual({
      needs_translation: false,
      category: 'authored',
      type: 'chat',
      source_name: 'Bot',
      message: 'hi',
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false,
    });
  });
});

describe('formatStatus', () => {
  it('formats all parts', () => {
    expect(
      formatStatus({
        uptimeS: 3723,
        sessionS: 723,
        reconnects: 2,
        kicks: 1,
        position: { x: 0.5, y: -60, z: 0.5 },
        gameVersion: '1.26.51',
        tick: 14460n,
        extra: { task: 'afk', nudges: 3 },
      }),
    ).toBe('status: up 1h02m, session 12m03s, reconnects 2, kicks 1, pos 0.50 -60.00 0.50, version 1.26.51, tick 14460, task afk, nudges 3');
    expect(formatStatus({ uptimeS: 5, sessionS: undefined, reconnects: 0, kicks: 0, position: undefined, gameVersion: '1.26.51', tick: 0 })).toBe(
      'status: up 5s, session -, reconnects 0, kicks 0, pos unknown, version 1.26.51, tick 0',
    );
  });
});

describe('Chat with built-in commands', () => {
  let client: FakeClient;
  let chat: Chat;
  let quit: Mock<(by: Sender) => void>;
  let events: CommandEvent[];

  async function start(owners = parseOwners(['Steve'])) {
    const { conn, clients } = setup({ username: 'Bot' });
    const metrics = new Metrics();
    metrics.attach(conn);
    metrics.inc('nudges', 3);
    chat = new Chat(conn, { owners, log: silentLogger });
    quit = vi.fn<(by: Sender) => void>();
    registerBuiltinCommands(chat, {
      conn,
      metrics,
      position: () => ({ x: 0.5, y: -60, z: 0.5 }),
      extraStatus: () => ({ nudges: metrics.counters.nudges ?? 0 }),
      quit,
    });
    chat.start();
    events = [];
    chat.onCommand((e) => events.push(e));
    client = await connectAndSpawn(conn, clients);
    return conn;
  }

  /** Replies sent on the next tick. */
  async function replies(): Promise<string[]> {
    await vi.advanceTimersByTimeAsync(60);
    const out = client.sentOf('text').map((p) => String(p.message));
    client.sent = [];
    return out;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers !status, !pos and !help from the console', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(2_000);
    client.receive('text', consoleSay('!status'));
    const [status] = await replies();
    expect(status).toMatch(/^status: up 2s, session 2s, reconnects 0, kicks 0, pos 0\.50 -60\.00 0\.50, version 1\.26\.51, tick \d+, nudges 3$/);
    client.receive('text', consoleTell('!pos'));
    expect(await replies()).toEqual(['pos 0.50 -60.00 0.50']);
    client.receive('text', consoleSay('!help'));
    expect(await replies()).toEqual(['commands: !status !pos !quit !help']);
    expect(events.map((e) => `${e.kind}:${e.name}`)).toEqual(['run:status', 'run:pos', 'run:help']);
  });

  it('replies as an authored chat packet from the bot', async () => {
    await start();
    client.receive('text', consoleSay('!pos'));
    await vi.advanceTimersByTimeAsync(60);
    expect(client.sentOf('text')).toEqual([chatPacket('Bot', 'pos 0.50 -60.00 0.50')]);
  });

  it('accepts owners, ignores everyone else, its own echo and truth lines', async () => {
    await start();
    client.receive('text', text({ source_name: 'Steve§r', message: '!pos' }));
    expect(await replies()).toEqual(['pos 0.50 -60.00 0.50']);
    client.receive('text', text({ source_name: 'Mallory§r', message: '!quit' }));
    client.receive('text', text({ source_name: 'Bot§r', message: '!quit' }));
    client.receive('text', text({ type: 'json', message: truthLine }));
    expect(await replies()).toEqual([]);
    expect(events.map((e) => `${e.kind}:${e.name}`)).toEqual(['run:pos', 'denied:quit']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(quit).not.toHaveBeenCalled();
  });

  it('ignores the console when allowConsole is off', async () => {
    await start(parseOwners(['Steve'], false));
    client.receive('text', consoleSay('!status'));
    expect(await replies()).toEqual([]);
    expect(events).toEqual([{ kind: 'denied', name: 'status', sender: { kind: 'console' } }]);
  });

  it('!quit replies first, then quits after the reply went out', async () => {
    await start();
    client.receive('text', consoleSay('!quit'));
    expect(await replies()).toEqual(['bye (quit by console)']);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(quit).toHaveBeenCalledWith({ kind: 'console' });
  });

  it('unknown commands get a hint; replies are rate limited', async () => {
    await start();
    client.receive('text', consoleSay('!dance'));
    expect(await replies()).toEqual(['unknown command !dance; try !help']);
    for (let i = 0; i < 20; i++) client.receive('text', consoleSay('!pos'));
    expect(await replies()).toHaveLength(7); // 8 per 10 s, one already used
    await vi.advanceTimersByTimeAsync(10_000);
    client.receive('text', consoleSay('!pos'));
    expect(await replies()).toHaveLength(1);
  });

  it('does not send while not spawned', async () => {
    const conn = await start();
    conn.disconnect('x');
    expect(chat.say('hello')).toBe(false);
  });
});
