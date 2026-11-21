// Track D1 (ADR 0118 "Security model", docs/discord.md): the Discord bot's rules as pure functions: who may command it
// and where (users, channels, DMs; bots, webhooks, the bot itself and system messages ignored), what never comes from
// Discord, the per-user rate limit, the token (its shape, where it comes from, the masked text, the scrub), the id lists
// and their masked display in `!set` and the panel, the reply cut, the button ids.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Chat, parseOwners } from '../../../src/chat/chat.ts';
import { registerSettingsCommands } from '../../../src/chat/commands.ts';
import { describeSetting, formatSettingValue, RuntimeSettings, SettingError } from '../../../src/config/settings.ts';
import { redact } from '../../../src/health/panel/logRing.ts';
import {
  BOT_TOKEN_ENV,
  BOT_TOKEN_FILE,
  buttonId,
  CONTENT_MAX,
  COMMAND_MAX,
  gate,
  IDS_MAX,
  idSet,
  idsText,
  IgnoreCounts,
  loadToken,
  notesText,
  parseButtonId,
  parseIdList,
  parseNotesTarget,
  parseToken,
  refusal,
  replyMessages,
  scrubToken,
  tokenSource,
  tokenText,
  UserLimiter,
  type Incoming,
} from '../../../src/health/notify/discord-access.ts';
import type { CommandDeps } from '../../../src/tasks/process/deps.ts';
import { setup } from '../connection-fakes.ts';

/** Obviously fake, in the shape of a bot token (three base64url parts joined by dots). */
export const FAKE_TOKEN = 'NOT-A-REAL-TOKEN-unit-test-d1.fake00.NOT-A-REAL-TOKEN-just-for-the-tests';
const OWNER = '111111111111111111';
const OTHER = '222222222222222222';
const CHAN = '333333333333333333';
const GUILD = '444444444444444444';
const SELF = '555555555555555555';
const rules = { users: new Set([OWNER]), channels: new Set([CHAN]), self: SELF, prefix: '!' };
const msg = (o: Partial<Incoming> = {}): Incoming => ({ channelId: CHAN, guildId: GUILD, authorId: OWNER, type: 0, content: '!pos', ...o });

describe('the gate (who and where)', () => {
  it('an allowed user in a listed channel runs; in a DM too, the prefix added', () => {
    expect(gate(msg(), rules)).toEqual({ run: true, text: '!pos', dm: false });
    expect(gate(msg({ guildId: undefined, channelId: '666666666666666666', content: 'goto home' }), rules)).toEqual({ run: true, text: '!goto home', dm: true });
    expect(gate(msg({ type: 19 }), rules)).toMatchObject({ run: true }); // a reply to a message
  });

  it('everything else is ignored, with the reason', () => {
    expect(gate(msg({ authorId: OTHER }), rules)).toEqual({ run: false, why: 'stranger' });
    expect(gate(msg({ authorId: OTHER, guildId: undefined }), rules)).toEqual({ run: false, why: 'stranger' }); // a stranger's DM
    expect(gate(msg({ channelId: '666666666666666666' }), rules)).toEqual({ run: false, why: 'channel' }); // an allowed user elsewhere
    expect(gate(msg({ authorBot: true }), rules)).toEqual({ run: false, why: 'bot' });
    expect(gate(msg({ webhookId: '777777777777777777' }), rules)).toEqual({ run: false, why: 'webhook' });
    expect(gate(msg({ authorId: SELF }), rules)).toEqual({ run: false, why: 'self' });
    expect(gate(msg({ authorId: SELF, authorBot: true }), rules)).toEqual({ run: false, why: 'self' });
    expect(gate(msg({ type: 7 }), rules)).toEqual({ run: false, why: 'system' }); // a member joined
    expect(gate(msg({ content: 'hello there' }), rules)).toEqual({ run: false, why: 'not a command' }); // talk in a channel
    expect(gate(msg({ content: '' }), rules)).toEqual({ run: false, why: 'not a command' });
    expect(gate(msg({ content: `!say ${'x'.repeat(COMMAND_MAX)}` }), rules)).toEqual({ run: false, why: 'too long' });
    expect(gate(msg({ authorId: 'Steve' }), rules)).toEqual({ run: false, why: 'stranger' }); // a name is never an id
  });

  it('empty lists: nobody, nowhere', () => {
    expect(gate(msg(), { ...rules, users: new Set() })).toEqual({ run: false, why: 'stranger' });
    expect(gate(msg(), { ...rules, channels: new Set() })).toEqual({ run: false, why: 'channel' });
    expect(gate(msg({ guildId: undefined }), { ...rules, channels: new Set() })).toMatchObject({ run: true }); // a DM needs no channel
  });

  it('one line per message, control characters out', () => {
    expect(gate(msg({ content: '\n  !goto home\n!quit' }), rules)).toEqual({ run: true, text: '!goto home', dm: false });
    expect(gate(msg({ content: '!say a\u0007b' }), rules)).toEqual({ run: true, text: '!say a b', dm: false });
  });

  it('ignored messages are counted by reason and drained as one line', () => {
    const c = new IgnoreCounts();
    expect(c.drain()).toBeUndefined();
    c.add('stranger');
    c.add('stranger');
    c.add('channel');
    expect(c.drain()).toBe('3 ignored (2 stranger, 1 channel)');
    expect(c.drain()).toBeUndefined();
    expect(c.total).toBe(3);
  });
});

describe('what never comes from Discord', () => {
  it('quit, test, learn and a change of the discord settings are refused with the reason; the rest runs', () => {
    expect(refusal('quit', [])).toMatch(/ends the bot/);
    expect(refusal('QUIT', [])).toMatch(/ends the bot/);
    expect(refusal('test', ['cmd', 'time', 'set', 'day'])).toMatch(/operator/);
    expect(refusal('learn', ['start'])).toMatch(/flight/);
    for (const k of ['discordBot', 'discordusers', 'discordChannels', 'DISCORDNOTES']) expect(refusal('set', [k, 'none'])).toMatch(/may not change its own door/);
    expect(refusal('set', ['discordUsers'])).toBeUndefined(); // showing it is fine (masked)
    expect(refusal('set', ['discordUsers', 'default'])).toMatch(/own door/);
    expect(refusal('set', ['fleeHealth', '8'])).toBeUndefined();
    // a queued line runs later as the queue's own (not marked discord): the same rule applies to what it holds
    expect(refusal('queue', ['add', '!set', 'discordUsers', '999999999999999999'])).toMatch(/^the queued line: Discord may not change its own door/);
    expect(refusal('queue', ['ADD', 'quit'])).toMatch(/^the queued line: it ends the bot/);
    expect(refusal('queue', ['add', '!goto', 'home'])).toBeUndefined();
    expect(refusal('queue', ['add', '!set', 'fleeHealth', '8'])).toBeUndefined();
    for (const n of ['goto', 'pos', 'stop', 'queue', 'answer', 'notify', 'discord', 'panel', 'follow']) expect(refusal(n, [])).toBeUndefined();
  });
});

describe('the per-user rate limit', () => {
  it('5 in 20 s; the first over is told, the rest are quiet; per user; the window frees', () => {
    const l = new UserLimiter(5, 20_000);
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(l.take(OWNER, t + i)).toBe('ok');
    expect(l.take(OWNER, t + 10)).toBe('over');
    expect(l.take(OWNER, t + 11)).toBe('quiet');
    expect(l.take(OTHER, t + 12)).toBe('ok');
    expect(l.take(OWNER, t + 20_005)).toBe('ok');
  });
});

describe('the token', () => {
  it('the shape check: three parts; `Bot ` taken off; a URL or junk refused without repeating it', () => {
    expect(parseToken(FAKE_TOKEN)).toEqual({ ok: true, token: FAKE_TOKEN });
    expect(parseToken(`  Bot ${FAKE_TOKEN}  `)).toEqual({ ok: true, token: FAKE_TOKEN });
    expect(parseToken('')).toEqual({ ok: false, why: 'empty' });
    const bad = parseToken('just-some-words');
    expect(bad).toEqual({ ok: false, why: 'not the shape of a bot token (three parts joined by dots)' });
    const url = parseToken('https://discord.com/api/webhooks/1/abc');
    expect(url.ok).toBe(false);
    expect(JSON.stringify(url)).not.toContain('abc');
  });

  it('the environment wins over the file; the file: its first line that is not blank or a comment; read again on reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd1-token-'));
    try {
      expect(loadToken({ env: {}, configDir: dir })).toEqual({ state: 'unset' });
      expect(loadToken({ env: {}, configDir: undefined })).toEqual({ state: 'unset' }); // --no-config
      const src = tokenSource({ env: {}, configDir: dir });
      expect(src.get().state).toBe('unset');
      writeFileSync(join(dir, BOT_TOKEN_FILE), `# my bot\n\n${FAKE_TOKEN}\n`);
      expect(src.get().state).toBe('unset');
      expect(src.reload()).toEqual({ state: 'set', token: FAKE_TOKEN, source: 'file' });
      expect(loadToken({ env: { [BOT_TOKEN_ENV]: `Bot ${FAKE_TOKEN}` }, configDir: dir })).toEqual({ state: 'set', token: FAKE_TOKEN, source: 'env' });
      writeFileSync(join(dir, BOT_TOKEN_FILE), 'oops\n');
      expect(loadToken({ env: {}, configDir: dir })).toEqual({ state: 'refused', source: 'file', why: 'not the shape of a bot token (three parts joined by dots)' });
      expect(loadToken({ env: {}, configDir: dir, read: () => { throw new Error('EACCES'); } })).toEqual({ state: 'refused', source: 'file', why: `${BOT_TOKEN_FILE} cannot be read` });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every output says set, not set or refused, never the token; the scrub hides it and its shape anywhere', () => {
    expect(tokenText({ state: 'set', token: FAKE_TOKEN, source: 'env' })).toBe(`set (${BOT_TOKEN_ENV})`);
    expect(tokenText({ state: 'set', token: FAKE_TOKEN, source: 'file' })).toBe(`set (${BOT_TOKEN_FILE})`);
    expect(tokenText({ state: 'unset' })).toBe('not set');
    expect(tokenText({ state: 'refused', source: 'file', why: 'empty' })).toBe(`refused (${BOT_TOKEN_FILE}: empty)`);
    expect(scrubToken(`failed: ${FAKE_TOKEN} at x`, FAKE_TOKEN)).toBe('failed: *** at x');
    expect(scrubToken('Authorization: Bot abcdefghijklmnopqrstuvwxyz123')).toBe('Authorization: Bot ***');
    expect(scrubToken('SOME-OTHER-TOKEN-SHAPED-X.abcdef.abcdefghijklmnopqrstuvwxyz0123 here')).toBe('*** here'); // a token the bot does not hold
    expect(scrubToken('POST /interactions/123456789012345678/aW50ZXJhY3Rpb24tdG9rZW4/callback')).toBe('POST /interactions/123456789012345678/***/callback');
    expect(redact(`discord: something ${FAKE_TOKEN}`)).not.toContain(FAKE_TOKEN); // the panel's log ring
  });
});

describe('the id lists and where notes go', () => {
  it('ids only (17 to 20 digits), at most 10, none for nobody; shown by their last 4 digits', () => {
    expect(parseIdList(`${OWNER}, ${OTHER} ${OWNER}`, 'discordUsers')).toBe(`${OWNER},${OTHER}`);
    expect(parseIdList('none', 'discordUsers')).toBe('none');
    expect(parseIdList('  ', 'discordUsers')).toBe('none');
    expect(() => parseIdList('Steve', 'discordUsers')).toThrow(SettingError);
    expect(() => parseIdList('12345', 'discordUsers')).toThrow(/17 to 20 digits/);
    expect(() => parseIdList(Array.from({ length: IDS_MAX + 1 }, (_, i) => `1${String(i).padStart(17, '0')}`).join(','), 'discordUsers')).toThrow(/at most 10/);
    expect(idSet(`${OWNER},${OTHER}`)).toEqual(new Set([OWNER, OTHER]));
    expect(idSet('none').size).toBe(0);
    expect(idsText(`${OWNER},${OTHER}`)).toBe('2 ids (...1111, ...2222)');
    expect(idsText(OWNER)).toBe('1 id (...1111)');
    expect(idsText('none')).toBe('none');
    expect(parseNotesTarget('DM')).toBe('dm');
    expect(parseNotesTarget('off')).toBe('none');
    expect(parseNotesTarget(CHAN)).toBe(CHAN);
    expect(() => parseNotesTarget('general')).toThrow(/dm, none or a channel id/);
    expect(notesText(CHAN)).toBe('channel ...3333');
  });

  it('!set and the panel show the lists masked; the default is nobody, off, DMs', () => {
    const s = new RuntimeSettings();
    expect([s.get('discordBot'), s.get('discordUsers'), s.get('discordChannels'), s.get('discordNotes')]).toEqual([false, 'none', 'none', 'dm']);
    s.set('discordUsers', `${OWNER} ${OTHER}`);
    expect(s.get('discordUsers')).toBe(`${OWNER},${OTHER}`);
    expect(formatSettingValue('discordUsers', s.get('discordUsers'))).toBe('2 ids (...1111, ...2222)');
    expect(describeSetting('discordUsers', s.get('discordUsers'))).not.toContain(OWNER);
    const { conn } = setup();
    const chat = new Chat(conn, { owners: parseOwners(['Steve']), log: { debug() {}, info() {}, warn() {}, error() {} } });
    registerSettingsCommands({ chat, settings: s } as unknown as CommandDeps);
    const said: string[] = [];
    const orig = chat.say.bind(chat);
    chat.say = (m: string) => {
      said.push(m);
      return orig(m);
    };
    const line = (body: string) => ({ type: 'chat' as const, source: 'Steve', message: body, body, xuid: '', truth: false });
    chat.handle(line('!set'));
    chat.handle(line('!set discordUsers'));
    chat.handle(line(`!set discordChannels ${CHAN}`));
    const all = said.join('\n');
    expect(all).not.toContain(OWNER);
    expect(all).not.toContain(OTHER);
    expect(all).not.toContain(CHAN);
    expect(all).toContain('discordUsers 2 ids (...1111, ...2222)');
    expect(all).toContain('discordChannels = 1 id (...3333) (was none)');
  });
});

describe('the reply', () => {
  it('a code block; colour codes and fences out; split between lines; at most 3 messages, the rest counted', () => {
    expect(replyMessages(['§aat§r 1 64 2'])).toEqual(['```\nat 1 64 2\n```']);
    expect(replyMessages(['a ``` b'])).toEqual(["```\na ''' b\n```"]);
    expect(replyMessages([])).toEqual([]);
    expect(replyMessages(['', '  '])).toEqual([]);
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(90)}`);
    const out = replyMessages(lines);
    expect(out).toHaveLength(3);
    for (const m of out) {
      expect(m.length).toBeLessThanOrEqual(CONTENT_MAX);
      expect(m.startsWith('```\n') && m.endsWith('\n```')).toBe(true);
    }
    expect(out[2]).toMatch(/\.\.\. \d+ more lines \(the game chat and the panel have them\)\n```$/);
    const kept = out.join('\n').split('\n').filter((l) => l.startsWith('line ')).length;
    expect(Number(/(\d+) more lines/.exec(out[2]!)![1])).toBe(100 - kept);
    const huge = replyMessages(['y'.repeat(5000)]);
    expect(huge).toHaveLength(1);
    expect(huge[0]!.length).toBeLessThanOrEqual(CONTENT_MAX);
    const surrogate = replyMessages([`${'z'.repeat(1990)}😀😀😀`])[0]!;
    expect(surrogate.length).toBeLessThanOrEqual(CONTENT_MAX);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(surrogate)).toBe(false); // never half a pair
  });
});

describe('the button ids', () => {
  it('bb:<run>:<ask>:<choice> round trip; anything else is not the bot', () => {
    const id = buttonId('0a1b2c3d', 7, 'retry');
    expect(id).toBe('bb:0a1b2c3d:7:retry');
    expect(parseButtonId(id)).toEqual({ run: '0a1b2c3d', ask: 7, choice: 'retry' });
    for (const bad of ['bb:0a1b2c3d:7:', 'bb:xyz:7:retry', 'other:0a1b2c3d:7:retry', 'bb:0a1b2c3d:x:retry', 'bb:0a1b2c3d:7:re try', 7, undefined]) expect(parseButtonId(bad)).toBeUndefined();
  });
});
