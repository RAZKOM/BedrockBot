// e2e (tag @bds), task 1.2: chat commands against bds-dev. A second throwaway client (plain
// bedrock-protocol) sees the bot's reply packets, since BDS does not log player chat.
// Runs only with BDS_E2E=1:  BDS_E2E=1 pnpm --filter bot test:e2e
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chat, parseOwners, type CommandEvent } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { TextPacket } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { EchoTask } from '../../src/tasks/echo.ts';
import { BOT_DIR, bdsCmd, connectObserver, E2E, HOST, isChatFrom, PORT, sleep, TARGET, VERSION, type Observer } from './chat-helpers.ts';
import { CLI_TARGET_ARGS } from './env.ts';

const BOT = 'E2EChatBot';
const OWNER = 'E2EOwner';
const STRANGER = 'E2EStranger';

describe.skipIf(!E2E)('@bds chat commands against bds-dev', () => {
  let conn: Connection;
  let chat: Chat;
  let watcher: Observer;
  let owner: Observer;
  let stranger: Observer;
  const events: CommandEvent[] = [];
  let quits = 0;

  beforeAll(async () => {
    conn = new Connection({ version: VERSION, username: BOT, logger: silentLogger, reconnect: false });
    const echo = new EchoTask(conn, { print: () => {} });
    echo.start();
    const metrics = new Metrics();
    metrics.attach(conn);
    chat = new Chat(conn, { owners: parseOwners([OWNER]), log: silentLogger });
    registerBuiltinCommands(chat, { conn, metrics, position: () => echo.feet, quit: () => quits++ });
    chat.onCommand((e) => events.push(e));
    chat.start();
    await conn.connect(TARGET);
    // Connect one at a time: simultaneous RakNet handshakes from one host time out now and then.
    watcher = await connectObserver('E2EWatcher');
    owner = await connectObserver(OWNER);
    stranger = await connectObserver(STRANGER);
    await sleep(500);
  }, 90_000);

  afterAll(async () => {
    for (const o of [watcher, owner, stranger]) o?.close();
    await conn?.disconnectAndFlush('test done');
  });

  const fromBot = (re: RegExp) => (p: TextPacket) => isChatFrom(p, BOT) && re.test(p.message);

  it('console `say !status` produces a reply packet seen by another player', async () => {
    const t0 = Date.now();
    bdsCmd('say', '!status');
    const reply = await watcher.waitText(fromBot(/^status: /), 5_000, 'status reply');
    console.log(`[chat] reply after ${Date.now() - t0} ms: ${JSON.stringify(reply)}`);
    const version = VERSION.replaceAll('.', '\\.'); // env BOT_VERSION, default 1.26.60
    expect(reply.message).toMatch(new RegExp(`^status: up \\d+s, session \\d+s, reconnects 0, kicks 0, pos -?\\d+\\.\\d\\d -60\\.00 -?\\d+\\.\\d\\d, version ${version}, tick \\d+$`));
    expect(reply).toMatchObject({ type: 'chat', category: 'authored', needs_translation: false });
  });

  it('console `tell <bot> !pos` (whisper) and `say !help`', async () => {
    bdsCmd('tell', BOT, '!pos');
    const pos = await watcher.waitText(fromBot(/^pos /), 5_000, 'pos reply');
    expect(pos.message).toMatch(/^pos -?\d+\.\d\d -60\.00 -?\d+\.\d\d$/);
    bdsCmd('say', '!help');
    const help = await watcher.waitText(fromBot(/^commands: /), 5_000, 'help reply');
    expect(help.message).toBe('commands: !status !pos !quit !help');
  });

  it('answers an allow-listed player and ignores everyone else', async () => {
    stranger.chat('!pos');
    await sleep(2_000);
    expect(events.filter((e) => e.kind === 'denied' && e.sender.kind === 'player' && e.sender.name === STRANGER)).toHaveLength(1);
    const before = watcher.texts.filter(fromBot(/^pos /)).length;
    owner.chat('!pos');
    await watcher.waitText((p) => watcher.texts.filter(fromBot(/^pos /)).length > before && fromBot(/^pos /)(p), 5_000, 'pos reply to owner');
    expect(events.at(-1)).toMatchObject({ kind: 'run', name: 'pos', sender: { kind: 'player', name: OWNER } });
    expect(watcher.texts.filter(fromBot(/^pos /))).toHaveLength(before + 1);
  });

  it('ignores @truth lines, even when they echo a command', async () => {
    const n = events.length;
    bdsCmd('scriptevent', 'truth:ping', '#chat1', '!quit');
    await watcher.waitText((p) => p.message.includes('"id\\":\\"chat1') || p.message.includes('"id":"chat1'), 5_000, 'truth ping reply');
    await sleep(500);
    expect(events.length).toBe(n);
    expect(quits).toBe(0);
  });

  it('CLI: console `say !quit` disconnects gracefully and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-quit-'));
    try {
      const child = spawn(
        process.execPath,
        ['src/index.ts', '--task', 'afk', '--host', HOST, '--port', String(PORT), ...CLI_TARGET_ARGS, '--username', 'E2EQuit', '--nudge-interval', '0', '--log-dir', dir],
        { cwd: BOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let err = '';
      let said = false;
      const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => { resolve(code); }));
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
        if (!said && err.includes('spawned as E2EQuit')) {
          said = true;
          setTimeout(() => { bdsCmd('say', '!quit'); }, 500);
        }
      });
      const timer = setTimeout(() => child.kill(), 20_000);
      const code = await exit;
      clearTimeout(timer);
      expect(code, err).toBe(0);
      expect(err).toContain('!quit from console');
      expect(err).toContain('exiting (!quit from console)');
      const bye = await watcher.waitText((p) => isChatFrom(p, 'E2EQuit') && p.message === 'bye (quit by console)', 2_000, 'bye reply');
      expect(bye).toBeDefined();
      // The server saw a clean leave (no lingering session): the same name can log in right away.
      const again = await connectObserver('E2EQuit');
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
