// The Discord bot's rules (Track D1, ADR 0118 "Security model", docs/discord.md): pure functions and small classes, so
// each rule has its unit test. Who may command the bot from Discord, where, how often, what never comes from Discord;
// the token (a secret: from the environment or one file, never printed); the reply cut; the question buttons' ids.
//
//   const v = gate(msg, { users, channels, self, prefix });       // { run: true, text } or { run: false, why }
//   refusal('quit', [])                                           // 'it ends the bot, ...' or undefined
//   limiter.take(userId, now)                                     // 'ok' | 'over' (first over in the window) | 'quiet'
//   loadToken({ env, configDir })                                 // { state: 'set', token, source } | unset | refused
//   scrubToken(text, token)                                       // the token, `Bot <x>` and token shapes -> ***
//   (the reply's layout: discord-reply.ts replyMessages)
//   buttonId(run, ask, choice) / parseButtonId(id)                // `bb:<run>:<ask id>:<choice>`
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strip } from '../../chat/style.ts';
import { SettingError } from '../../config/settings.ts';

export const BOT_TOKEN_ENV = 'BEDROCKBOT_DISCORD_TOKEN';
export const BOT_TOKEN_FILE = 'discord-bot.token';
/** Ids at most in `discordUsers` and in `discordChannels`. */
export const IDS_MAX = 10;
/** A Discord id (a snowflake): 17 to 20 digits. */
export const SNOWFLAKE_RE = /^\d{17,20}$/;
/** The settings that are Discord's own door: never changed from Discord. */
export const DISCORD_KEYS: readonly string[] = ['discordBot', 'discordUsers', 'discordChannels', 'discordNotes'];
/** A command line from Discord at most (characters; the game chat's own limit is 256 for a reply). */
export const COMMAND_MAX = 400;
/** Commands per user per window (button presses included). */
export const USER_RATE = { max: 5, windowMs: 20_000 } as const;
/** Discord's message content limit (characters). */
export const CONTENT_MAX = 2000;
/** A reply is at most this many messages; the rest is counted in the last line. */
export const REPLY_PARTS = 3;

// ---- the ids -------------------------------------------------------------------------------------------------------

/** `111..., 222...` / `none` -> `111...,222...` / `none` (the setting's parse; throws SettingError). */
export function parseIdList(raw: string, key: string): string {
  const s = raw.trim().toLowerCase();
  if (s === '' || s === 'none') return 'none';
  const ids = s.split(/[\s,]+/).filter(Boolean);
  for (const id of ids) if (!SNOWFLAKE_RE.test(id)) throw new SettingError(`${key} must be Discord ids (17 to 20 digits) separated by commas, or none; "${id.length > 24 ? `${id.slice(0, 24)}...` : id}" is not one`);
  const uniq = [...new Set(ids)];
  if (uniq.length > IDS_MAX) throw new SettingError(`${key} holds at most ${IDS_MAX} ids, got ${uniq.length}`);
  return uniq.join(',');
}

/** The ids of a list setting's value. */
export function idSet(text: string): Set<string> {
  return new Set(text === 'none' || !text ? [] : text.split(',').filter((s) => SNOWFLAKE_RE.test(s)));
}

/** `none` or `2 ids (...1234, ...5678)`: what every output shows of a list (the last 4 digits, never the whole id). */
export function idsText(text: string): string {
  const ids = [...idSet(text)];
  if (!ids.length) return 'none';
  return `${ids.length} id${ids.length === 1 ? '' : 's'} (${ids.map((i) => `...${i.slice(-4)}`).join(', ')})`;
}

/** `dm`, `none` or a channel id (the `discordNotes` setting's parse). */
export function parseNotesTarget(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === '' || s === 'dm') return 'dm';
  if (s === 'none' || s === 'off') return 'none';
  if (SNOWFLAKE_RE.test(s)) return s;
  throw new SettingError(`discordNotes must be dm, none or a channel id (17 to 20 digits), got "${raw.length > 24 ? `${raw.slice(0, 24)}...` : raw}"`);
}

/** `dm`, `none` or `channel ...1234`. */
export function notesText(v: string): string {
  return v === 'dm' || v === 'none' ? v : `channel ...${v.slice(-4)}`;
}

// ---- the gate ------------------------------------------------------------------------------------------------------

/** What the gate needs of a MESSAGE_CREATE. */
export interface Incoming {
  channelId: string;
  /** Absent in a direct message. */
  guildId?: string | undefined;
  authorId: string;
  authorBot?: boolean | undefined;
  /** Set when a webhook posted it. */
  webhookId?: string | undefined;
  /** Discord's message type: 0 a plain message, 19 a reply; everything else is a system message. */
  type: number;
  content: string;
}

export interface GateRules {
  users: ReadonlySet<string>;
  channels: ReadonlySet<string>;
  /** The bot's own user id (from READY). */
  self?: string | undefined;
  prefix: string;
}

export type IgnoreWhy = 'webhook' | 'bot' | 'self' | 'system' | 'stranger' | 'channel' | 'not a command' | 'too long';
export type Verdict = { run: true; text: string; dm: boolean } | { run: false; why: IgnoreWhy };

/**
 * The security model's door (ADR 0118 rules 2 to 4): a command from an allowed user, in a listed channel or in a direct
 * message; everything else ignored, with the reason (counted, never answered). In a channel the line must start with the
 * prefix (a channel may hold talk); in a direct message the prefix is added when it is missing. One line per message.
 */
export function gate(m: Incoming, r: GateRules): Verdict {
  if (m.webhookId) return { run: false, why: 'webhook' };
  if (r.self && m.authorId === r.self) return { run: false, why: 'self' };
  if (m.authorBot) return { run: false, why: 'bot' };
  if (m.type !== 0 && m.type !== 19) return { run: false, why: 'system' };
  if (!SNOWFLAKE_RE.test(m.authorId) || !r.users.has(m.authorId)) return { run: false, why: 'stranger' };
  const dm = m.guildId === undefined || m.guildId === null;
  if (!dm && !r.channels.has(m.channelId)) return { run: false, why: 'channel' };
  // eslint-disable-next-line no-control-regex
  const first = (m.content.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!first) return { run: false, why: 'not a command' };
  let text = first;
  if (!text.startsWith(r.prefix)) {
    if (!dm) return { run: false, why: 'not a command' };
    text = `${r.prefix}${text}`;
  }
  if (text.length > COMMAND_MAX) return { run: false, why: 'too long' };
  return { run: true, text, dm };
}

/** Commands that never come from Discord, and why (ADR 0118 rule 6). */
export const DISCORD_REFUSE: Readonly<Record<string, string>> = {
  quit: 'it ends the bot, and nothing on Discord can start it again',
  test: 'the test bench sends slash commands as an operator: type it in the game or the panel',
  learn: 'it records a flight the owner flies in the game',
};

/** Why `!name args` is refused from Discord, or undefined when it runs. */
export function refusal(name: string, args: readonly string[]): string | undefined {
  const n = name.toLowerCase();
  const r = DISCORD_REFUSE[n];
  if (r) return r;
  if (n === 'set' && args.length >= 2) {
    const key = (args[0] ?? '').toLowerCase();
    if (DISCORD_KEYS.some((k) => k.toLowerCase() === key)) return 'Discord may not change its own door (who may command the bot, where, where notes go): set it in the game, the panel or settings.json';
  }
  // a queued job runs later as the queue's own line (not marked discord), so the line it holds passes the same rule
  if (n === 'queue' && (args[0] ?? '').toLowerCase() === 'add' && args.length >= 2) {
    const inner = refusal((args[1] ?? '').replace(/^[^a-z0-9]+/i, ''), args.slice(2));
    if (inner) return `the queued line: ${inner}`;
  }
  return undefined;
}

/** Ignored messages by reason since the last count line. */
export class IgnoreCounts {
  private counts = new Map<IgnoreWhy | 'press', number>();
  total = 0;

  add(why: IgnoreWhy | 'press'): void {
    this.counts.set(why, (this.counts.get(why) ?? 0) + 1);
    this.total++;
  }

  /** `3 ignored (2 stranger, 1 channel)` and the counts start again; undefined when there were none. */
  drain(): string | undefined {
    if (!this.counts.size) return undefined;
    const n = [...this.counts.values()].reduce((a, b) => a + b, 0);
    const parts = [...this.counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ');
    this.counts = new Map();
    return `${n} ignored (${parts})`;
  }
}

/** Per-user rate limit (ADR 0118 rule 7): `ok`, `over` (the first one over in the window: one line says so), `quiet`. */
export class UserLimiter {
  private readonly times = new Map<string, number[]>();
  private readonly told = new Map<string, number>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number = USER_RATE.max, windowMs: number = USER_RATE.windowMs) {
    this.max = max;
    this.windowMs = windowMs;
  }

  take(user: string, now: number): 'ok' | 'over' | 'quiet' {
    const t = (this.times.get(user) ?? []).filter((x) => now - x < this.windowMs);
    if (t.length >= this.max) {
      this.times.set(user, t);
      const last = this.told.get(user);
      if (last !== undefined && now - last < this.windowMs) return 'quiet';
      this.told.set(user, now);
      return 'over';
    }
    t.push(now);
    this.times.set(user, t);
    if (this.times.size > 64) for (const [k, v] of this.times) if (!v.some((x) => now - x < this.windowMs)) this.times.delete(k);
    return 'ok';
  }
}

// ---- the token -----------------------------------------------------------------------------------------------------

export type TokenState = { state: 'set'; token: string; source: 'env' | 'file' } | { state: 'unset' } | { state: 'refused'; source: 'env' | 'file'; why: string };

/** A bot token's shape: three base64url parts joined by dots (the first is the bot's id, the last the secret). */
const TOKEN_RE = /^[A-Za-z0-9_-]{18,100}\.[A-Za-z0-9_-]{4,20}\.[A-Za-z0-9_-]{20,200}$/;
/** The same shape anywhere in a text (the scrub). */
const TOKEN_SHAPE_G = /[A-Za-z0-9_-]{18,100}\.[A-Za-z0-9_-]{4,20}\.[A-Za-z0-9_-]{20,200}/g;

/** The shape check: a bot token or why not (never repeating the value). `Bot ` in front is taken off. */
export function parseToken(raw: string): { ok: true; token: string } | { ok: false; why: string } {
  let s = raw.trim();
  if (/^bot\s+/i.test(s)) s = s.replace(/^bot\s+/i, '').trim();
  if (!s) return { ok: false, why: 'empty' };
  if (/webhooks\//i.test(s) || /^https?:/i.test(s)) return { ok: false, why: 'a URL, not a bot token (the webhook URL goes in discord-webhook.url)' };
  if (!TOKEN_RE.test(s)) return { ok: false, why: 'not the shape of a bot token (three parts joined by dots)' };
  return { ok: true, token: s };
}

export interface TokenLoadOptions {
  env: NodeJS.ProcessEnv;
  /** The config directory; undefined: the file is not looked for (--no-config). */
  configDir: string | undefined;
  read?: (file: string) => string | undefined;
}

const readText = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

/** The environment wins over the file (its first line that is not blank or a # comment); a refused value is never used. */
export function loadToken(o: TokenLoadOptions): TokenState {
  const read = o.read ?? readText;
  const env = o.env[BOT_TOKEN_ENV];
  let raw: string | undefined;
  let source: 'env' | 'file' = 'env';
  if (env !== undefined && env.trim() !== '') raw = env;
  else if (o.configDir) {
    try {
      raw = read(join(o.configDir, BOT_TOKEN_FILE));
    } catch {
      return { state: 'refused', source: 'file', why: `${BOT_TOKEN_FILE} cannot be read` };
    }
    source = 'file';
    if (raw !== undefined) raw = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? '';
  }
  if (raw === undefined) return { state: 'unset' };
  const p = parseToken(raw);
  return p.ok ? { state: 'set', token: p.token, source } : { state: 'refused', source, why: p.why };
}

/** The token as loaded at start, read again on `!discord` and `!set discordBot` (a file put in place is picked up). */
export function tokenSource(o: TokenLoadOptions): { get(): TokenState; reload(): TokenState } {
  let cur = loadToken(o);
  return {
    get: () => cur,
    reload: () => (cur = loadToken(o)),
  };
}

/** `set (BEDROCKBOT_DISCORD_TOKEN)`, `not set`, `refused (discord-bot.token: ...)`: all any output says of the token. */
export function tokenText(t: TokenState): string {
  if (t.state === 'unset') return 'not set';
  const where = t.source === 'env' ? BOT_TOKEN_ENV : BOT_TOKEN_FILE;
  if (t.state === 'refused') return `refused (${where}: ${t.why})`;
  return `set (${where})`;
}

/** Hide the token, an `Authorization: Bot <x>` value, any token-shaped string and an interaction's token in a URL. */
export function scrubToken(text: string, token?: string): string {
  let s = text;
  if (token && token.length >= 8) s = s.split(token).join('***');
  return s
    .replace(TOKEN_SHAPE_G, '***')
    .replace(/(\bbot\s+)[A-Za-z0-9_.-]{20,}/gi, '$1***')
    .replace(/(interactions\/\d+\/)[A-Za-z0-9_.-]+/gi, '$1***');
}

// ---- the reply -----------------------------------------------------------------------------------------------------

/** A reply's text: no colour codes, no control characters, no code fence of its own (discord-reply.ts lays it out). */
export function plainLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return strip(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/```/g, "'''");
}

/** Cut to `n` UTF-16 units on a code point (never more than Discord counts). */
export function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = n - 3;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${s.slice(0, end)}...`;
}

// ---- the buttons ---------------------------------------------------------------------------------------------------

/** `bb:<run>:<ask id>:<choice>` (Discord allows 100 characters). */
export function buttonId(run: string, ask: number, choice: string): string {
  return `bb:${run}:${ask}:${choice}`.slice(0, 100);
}

/** The run tag, the question and the choice of a button's id; undefined for an id that is not the bot's. */
export function parseButtonId(id: unknown): { run: string; ask: number; choice: string } | undefined {
  if (typeof id !== 'string') return undefined;
  const m = /^bb:([0-9a-f]{8}):(\d{1,9}):([a-z0-9_-]{1,40})$/.exec(id);
  return m ? { run: m[1]!, ask: Number(m[2]), choice: m[3]! } : undefined;
}
