// e2e (tag @bds), chat style (docs/chat-style.md, decision 0050): what the SERVER does with section-sign codes,
// newlines and long messages in a client's chat. The style module relies on all four facts; run this after
// every BDS bump (tools/bump-version/playbook.md) and when a Realm update lands.
// Runs only with BDS_E2E=1:  BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e chat-style
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chat } from '../../src/chat/chat.ts';
import { Connection } from '../../src/connection/connection.ts';
import { silentLogger } from '../../src/log.ts';
import { bdsCmd, connectObserver, E2E, isChatFrom, sleep, TARGET, VERSION, type Observer } from './chat-helpers.ts';

const S = '§';

describe.skipIf(!E2E)('@bds chat style: what the server relays', () => {
  let sender: Observer;
  let watcher: Observer;

  beforeAll(async () => {
    // one at a time: simultaneous RakNet handshakes from one host time out now and then
    sender = await connectObserver('E2EStyleA');
    watcher = await connectObserver('E2EStyleB');
    await sleep(500);
  }, 60_000);

  afterAll(() => {
    sender?.close();
    watcher?.close();
  });

  /** Send `message` as the sender; the watcher's copy of it, or undefined when the server dropped it. */
  async function relay(tag: string, message: string): Promise<string | undefined> {
    sender.chat(`${tag} ${message}`);
    try {
      const p = await watcher.waitText((t) => t.type === 'chat' && t.message.startsWith(`${tag} `), 4_000, tag);
      return p.message.slice(tag.length + 1);
    } catch {
      return undefined;
    }
  }

  it('relays colour codes, a trailing sign and an unknown code unchanged', async () => {
    expect(await relay('S1', `${S}aGreen${S}r ${S}l${S}bbold aqua${S}r`)).toBe(`${S}aGreen${S}r ${S}l${S}bbold aqua${S}r`);
    expect(await relay('S2', `trail${S}`)).toBe(`trail${S}`);
    expect(await relay('S3', `${S}zunknown`)).toBe(`${S}zunknown`);
  });

  it('relays newlines inside one message (multi-line blocks)', async () => {
    const block = `${S}6${S}lTitle${S}r\n${S}b!come${S}r  come to you\n${S}b!follow${S}r  follow you`;
    expect(await relay('N1', block)).toBe(block);
  });

  it('relays a 480 character message (style.ts MAX_WIRE) and DROPS a long one without any error', async () => {
    const ok = 'q'.repeat(480 - 'L1 '.length);
    expect(await relay('L1', ok)).toBe(ok);
    // measured 2026-10-31 on BDS 1.26.60.6: 503 characters relayed, 523 not. If this starts failing, MAX_WIRE has to move.
    const long = 'q'.repeat(530);
    expect(await relay('L2', long)).toBeUndefined();
    expect(sender.closed).toBe(false);
    expect(sender.kick).toBeUndefined();
  }, 30_000);
});

// The /tellraw route (chat/route.ts, setting chatVia): a real Connection + Chat against bds-dev, where new players are
// operators by default. Measured 2026-10-31: an operator's /tellraw @a arrives as `json_whisper` (message = the rawtext
// JSON) and is silent on success; a non-operator's is refused (command_output, success 0) and must fall back to chat.
describe.skipIf(!E2E)('@bds chat style: the /tellraw route', () => {
  const BOT = 'E2ETellBot';
  let conn: Connection;
  let chat: Chat;
  let watcher: Observer;

  beforeAll(async () => {
    conn = new Connection({ version: VERSION, username: BOT, logger: silentLogger, reconnect: false });
    chat = new Chat(conn, { log: silentLogger, maxReplies: 100 });
    chat.styleSource = { color: () => true, lines: () => true, via: () => 'tellraw' };
    chat.start();
    await conn.connect(TARGET);
    watcher = await connectObserver('E2ETellWatch');
    bdsCmd('op', BOT); // a rerun starts from a known state: the bot is an operator
    await sleep(1_500);
  }, 90_000);

  afterAll(async () => {
    watcher?.close();
    await conn?.disconnectAndFlush('test done');
  });

  const rawtext = (m: string): string => (JSON.parse(m) as { rawtext: { text: string }[] }).rawtext.map((r) => r.text).join('');

  it('as an operator: delivered to the other players as a json message, with the codes, newlines and quotes intact', async () => {
    const message = `${S}6${S}lTitle${S}r\n${S}b!come${S}r  say "hi" back\\slash {x} @a !`;
    expect(chat.say(message)).toBe(true);
    const got = await watcher.waitText((t) => t.type === 'json_whisper' && rawtext(t.message) === message, 5_000, 'tellraw message');
    expect(got.type).toBe('json_whisper');
    expect(watcher.texts.some((t) => isChatFrom(t, BOT))).toBe(false); // it did not go out as player chat
    expect(chat.routeStatus()).toMatchObject({ setting: 'tellraw', via: 'tellraw' });
    expect(conn.state).toBe('spawned'); // and the server kept the connection
  }, 20_000);

  it('a Doc block of the rich help fits as a command and arrives whole', async () => {
    chat.helpSettings = { get: () => 0 };
    const blocks = chat.helpReplies(['settings']);
    for (const b of blocks) chat.say(b);
    const last = blocks.at(-1)!;
    await watcher.waitText((t) => t.type === 'json_whisper' && rawtext(t.message) === last, 8_000, 'last help block');
    expect(chat.routeStatus().via).toBe('tellraw');
    expect(conn.state).toBe('spawned');
  }, 30_000);

  it('after deop: the refused /tellraw is resent as player chat, the route pauses, and the bot stays connected', async () => {
    bdsCmd('deop', BOT);
    await sleep(1_500);
    chat.say('after deop one');
    await watcher.waitText((t) => isChatFrom(t, BOT) && t.message === 'after deop one', 8_000, 'fallback chat');
    expect(chat.routeStatus()).toMatchObject({ setting: 'tellraw', via: 'chat', route: { state: 'refused', reason: expect.stringContaining('commands.generic') as string } });
    chat.say('after deop two');
    await watcher.waitText((t) => isChatFrom(t, BOT) && t.message === 'after deop two', 5_000, 'chat while paused');
    expect(watcher.texts.filter((t) => t.type === 'json_whisper' && rawtext(t.message).startsWith('after deop'))).toHaveLength(0);
    expect(conn.state).toBe('spawned');
    bdsCmd('op', BOT);
  }, 30_000);
});
