// Track REL2 (docs/chat-style.md "The reply queue"): replies past the chat's rate limit wait for a slot instead of being
// dropped, oldest first, bounded; the waiting lines of one command go out merged while the bytes allow; an overflow is
// told once. The limit on the wire (maxReplies per replyWindowMs) is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat, KEPT_MS, MERGE_SEP, parseOwners, REPLY_QUEUE_MAX, REPLY_QUEUE_MS } from '../../../src/chat/chat.ts';
import { newScope, inScope } from '../../../src/chat/scope.ts';
import { MAX_WIRE, wireSize } from '../../../src/chat/style.ts';
import type { TextPacket } from '../../../src/connection/types.ts';
import { silentLogger } from '../../../src/log.ts';
import { connectAndSpawn, setup, type FakeClient } from '../connection-fakes.ts';

const consoleSay = (msg: string): TextPacket => ({ needs_translation: false, category: 'authored', type: 'announcement', source_name: 'Server', message: `[Server] ${msg}`, xuid: '' });

describe('the reply queue (Track REL2)', () => {
  let client: FakeClient;
  let chat: Chat;
  /** [time sent, text] of every chat packet, in order. */
  let wire: [number, string][];
  let t0: number;

  async function start(lines: Record<string, number> = {}) {
    const { conn, clients } = setup({ username: 'Bot' });
    chat = new Chat(conn, { owners: parseOwners(['Steve']), log: silentLogger });
    // commands that answer with `n` lines, like !help or !status
    for (const [name, n] of Object.entries(lines)) {
      chat.register({ name, help: '(test)', run: ({ reply }) => { for (let i = 1; i <= n; i++) reply(`${name} line ${i} of ${n}`); } });
    }
    chat.start();
    client = await connectAndSpawn(conn, clients);
    wire = [];
    t0 = Date.now();
    const q = client.queue.bind(client);
    client.queue = (name: string, params: object) => {
      if (name === 'text') wire.push([Date.now() - t0, String((params as { message: unknown }).message)]);
      q(name, params);
    };
    return conn;
  }

  /** The most chat messages sent in any window of `ms`. */
  function busiest(ms = 10_000): number {
    let most = 0;
    for (const [s] of wire) most = Math.max(most, wire.filter(([t]) => t >= s && t < s + ms).length);
    return most;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('5 commands typed in 1 s with the window full: every reply arrives, in order, never more than 8 in 10 s', async () => {
    await start({ help: 2, status: 1, pos: 1, inv: 1, wp: 1 });
    for (let i = 0; i < 8; i++) chat.say(`chore line ${i}`); // something else filled the window (a chore, a hint)
    for (const c of ['!help', '!status', '!pos', '!inv', '!wp']) {
      client.receive('text', consoleSay(c));
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    const texts = wire.map(([, m]) => m);
    expect(texts.slice(0, 8)).toEqual([...Array(8).keys()].map((i) => `chore line ${i}`));
    // the two lines of !help are one command's: merged into one message
    expect(texts.slice(8)).toEqual([`help line 1 of 2${MERGE_SEP}help line 2 of 2`, 'status line 1 of 1', 'pos line 1 of 1', 'inv line 1 of 1', 'wp line 1 of 1']);
    expect(busiest()).toBeLessThanOrEqual(8);
    expect(chat.waitingCount).toBe(0);
  });

  it('before the queue (the cause, reproduced): the same burst lost every reply; now none is lost', async () => {
    await start({ status: 1 });
    for (let i = 0; i < 8; i++) chat.say(`chore line ${i}`);
    expect(chat.say('a reply past the limit')).toBe(true); // was false: `chat rate limit, dropping: ...`
    expect(chat.waitingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(wire.map(([, m]) => m).at(-1)).toBe('a reply past the limit');
  });

  it('a long answer of one command is merged into messages of at most MAX_WIRE bytes', async () => {
    await start({ big: 30 });
    for (let i = 0; i < 8; i++) chat.say(`chore line ${i}`);
    client.receive('text', consoleSay('!big'));
    await vi.advanceTimersByTimeAsync(60_000);
    const merged = wire.slice(8).map(([, m]) => m);
    expect(merged.length).toBeLessThan(30);
    expect(merged.join(MERGE_SEP).split(MERGE_SEP)).toEqual([...Array(30).keys()].map((i) => `big line ${i + 1} of 30`));
    for (const m of merged) expect(wireSize(m)).toBeLessThanOrEqual(MAX_WIRE);
    expect(merged.filter((m) => wireSize(m) > MAX_WIRE - 20).length).toBeGreaterThan(0); // filled close to the limit
  });

  it('lines of different commands, or of no command, are not merged; multi-line blocks are not merged', async () => {
    await start();
    for (let i = 0; i < 8; i++) chat.say(`chore line ${i}`);
    chat.say('no scope a');
    chat.say('no scope b');
    const a = newScope('chat', '!a');
    const b = newScope('chat', '!b');
    inScope(a, () => chat.say('a 1'));
    inScope(b, () => chat.say('b 1'));
    inScope(a, () => chat.say('a 2')); // not next to a 1: stays apart (order first)
    inScope(b, () => { chat.say('block\nof two lines'); chat.say('b 3'); });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wire.slice(8).map(([, m]) => m)).toEqual(['no scope a', 'no scope b', 'a 1', 'b 1', 'a 2', 'block\nof two lines', 'b 3']);
  });

  it('a full queue drops the newest lines and says how many once, after the queue', async () => {
    await start();
    for (let i = 0; i < 8; i++) chat.say(`chore line ${i}`);
    for (let i = 0; i < REPLY_QUEUE_MAX; i++) expect(chat.say(`waiting ${i}`)).toBe(true);
    for (let i = 0; i < 3; i++) expect(chat.say(`lost ${i}`)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    const texts = wire.slice(8).map(([, m]) => m);
    expect(texts).toEqual([...[...Array(REPLY_QUEUE_MAX).keys()].map((i) => `waiting ${i}`), '(3 lines dropped: too fast)']);
    expect(busiest()).toBeLessThanOrEqual(8);
  });

  it('a reply loop still sends no more than 8 in any 10 s (the spam guard holds)', async () => {
    await start();
    for (let s = 0; s < 120; s++) {
      for (let i = 0; i < 5; i++) chat.say(`loop ${s}.${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(busiest()).toBeLessThanOrEqual(8);
    expect(wire.length).toBeLessThanOrEqual(8 * 7);
    expect(chat.waitingCount).toBeLessThanOrEqual(REPLY_QUEUE_MAX);
    expect(wire.filter(([, m]) => m.includes('lines dropped: too fast')).length).toBeLessThanOrEqual(1); // once while it never drains
  });

  it('a kept line (Track E7) goes after the replies waiting before it, and still waits out a reconnect', async () => {
    const conn = await start();
    for (let i = 0; i < 8; i++) chat.say(`chore line ${i}`);
    chat.say('reply first');
    expect(chat.sayKept('get kit: done in 80 s')).toBe(false);
    chat.say('reply after');
    await vi.advanceTimersByTimeAsync(10_200);
    expect(wire.slice(8).map(([, m]) => m)).toEqual(['reply first', 'get kit: done in 80 s', 'reply after']);
    for (let i = 0; chat.waitingCount === 0; i++) chat.say(`more ${i}`); // the window full again
    chat.sayKept('kept over a death');
    chat.say('waiting too');
    conn.disconnect('x');
    expect(chat.keptCount).toBe(1);
    expect(chat.waitingCount).toBe(2);
    await vi.advanceTimersByTimeAsync(REPLY_QUEUE_MS + 1_500);
    expect(chat.waitingCount).toBe(0); // a reply waits at most REPLY_QUEUE_MS
    expect(chat.keptCount).toBe(1); // the kept line longer
    await vi.advanceTimersByTimeAsync(KEPT_MS);
    expect(chat.keptCount).toBe(0);
  });
});
