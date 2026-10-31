// e2e (tag @bds), chat style (docs/chat-style.md, decision 0050): what the SERVER does with section-sign codes,
// newlines and long messages in a client's chat. The style module relies on all four facts; run this after
// every BDS bump (tools/bump-version/playbook.md) and when a Realm update lands.
// Runs only with BDS_E2E=1:  BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e chat-style
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chat } from '../../src/chat/chat.ts';
import { strip } from '../../src/chat/style.ts';
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
    // measured 2026-10-31 on BDS 1.26.60.6: 503 bytes relayed, 515 not. If this starts failing, MAX_WIRE has to move.
    const long = 'q'.repeat(530);
    expect(await relay('L2', long)).toBeUndefined();
    expect(sender.closed).toBe(false);
    expect(sender.kick).toBeUndefined();
  }, 30_000);

  it('counts UTF-8 BYTES, not characters: a colour code is 2 bytes, so 480 characters can be too long', async () => {
    const body = (signs: number): string => 'q'.repeat(480 - 'B1 '.length - signs) + S.repeat(signs);
    expect(await relay('B1', body(20))).toBe(body(20)); // 480 characters, 500 bytes
    expect(await relay('B2', body(40))).toBeUndefined(); // 480 characters, 520 bytes: dropped without an error
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
  let via = 'tellraw';

  beforeAll(async () => {
    conn = new Connection({ version: VERSION, username: BOT, logger: silentLogger, reconnect: false });
    chat = new Chat(conn, { log: silentLogger, maxReplies: 100 });
    chat.styleSource = { color: () => true, lines: () => true, via: () => via };
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
    // framed: the first page opens with the rule carrying the title and the page, the last one closes with a plain rule
    expect(strip(blocks[0]!)).toMatch(/^={3,} settings 1\/\d+ ={3,}\n/);
    expect(strip(last).endsWith('='.repeat(30))).toBe(true);
    expect(blocks.length).toBeGreaterThan(1);
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
    // the test was refused, so the owner is told in chat, once, with how to retry
    const warning = await watcher.waitText((t) => isChatFrom(t, BOT) && strip(t.message).includes('refused by the server'), 5_000, 'refusal warning');
    expect(strip(warning.message)).toContain('commands.generic');
    expect(strip(warning.message)).toContain('!colors tries again');
    expect(watcher.texts.filter((t) => isChatFrom(t, BOT) && strip(t.message).includes('refused by the server'))).toHaveLength(1);
    expect(conn.state).toBe('spawned');
  }, 30_000);

  it('opped again: !colors (retryRoute) tries at once instead of waiting for the pause, and /tellraw is delivered', async () => {
    bdsCmd('op', BOT);
    await sleep(1_500);
    expect(chat.routeStatus().route.state).toBe('refused'); // still paused from the refusal
    chat.retryRoute();
    chat.say('back on tellraw');
    await watcher.waitText((t) => t.type === 'json_whisper' && rawtext(t.message) === 'back on tellraw', 8_000, 'tellraw after retry');
    expect(chat.routeStatus()).toMatchObject({ via: 'tellraw', route: { state: 'on' } });
    expect(conn.state).toBe('spawned');
  }, 30_000);

  // /say and /me, measured 2026-10-31: /say needs an operator and arrives as an announcement "[Bot] text"; /me needs none and
  // arrives as chat "* Bot text" (no source name); both relay colour codes and newlines; an @a selector in the text is expanded.
  it('chatVia say (operator): arrives as an announcement "[Bot] text" with the codes and the newline intact', async () => {
    via = 'say';
    const message = `${S}6${S}lTitle${S}r\nsecond line 12`;
    chat.say(message);
    const got = await watcher.waitText((t) => t.type === 'announcement' && t.message === `[${BOT}] ${message}`, 8_000, 'say message');
    expect(got.source_name).toBe(BOT);
    expect(chat.routeStatus()).toMatchObject({ via: 'say', route: { state: 'on' } });
  }, 30_000);

  it('chatVia me works for a NON-operator: arrives as chat "* Bot text", and no warning is sent', async () => {
    bdsCmd('deop', BOT);
    await sleep(1_500);
    via = 'me';
    const asChat = (): number => watcher.texts.filter((t) => isChatFrom(t, BOT)).length;
    const before = asChat(); // earlier tests left their fallback lines in the watcher's list
    const message = `${S}aok${S}r\nline two`;
    chat.say(message);
    await watcher.waitText((t) => t.type === 'chat' && t.message === `* ${BOT} ${message}`, 8_000, 'me message');
    await sleep(1_200);
    expect(chat.routeStatus()).toMatchObject({ setting: 'me', via: 'me', route: { state: 'on' } });
    expect(asChat()).toBe(before); // nothing came as player chat
    // an @ selector never goes through /me (the server would expand it, or refuse the command)
    chat.say('ping @a end');
    await watcher.waitText((t) => isChatFrom(t, BOT) && t.message === 'ping @a end', 8_000, 'chat for a reply with @');
    expect(chat.routeStatus().route.state).toBe('on');
  }, 40_000);

  it('chatVia say as a non-operator: refused, resent as chat, and the warning blames operator rights', async () => {
    via = 'say';
    chat.say('say as non-op');
    await watcher.waitText((t) => isChatFrom(t, BOT) && t.message === 'say as non-op', 8_000, 'fallback chat');
    const warning = await watcher.waitText((t) => isChatFrom(t, BOT) && strip(t.message).startsWith('chatVia say: refused by the server (commands.generic.error.permissions)'), 5_000, 'say warning');
    expect(strip(warning.message)).toContain('not an operator');
    expect(chat.routeStatus()).toMatchObject({ setting: 'say', via: 'chat', route: { state: 'refused' } });
    expect(conn.state).toBe('spawned');
    bdsCmd('op', BOT);
  }, 30_000);
});
