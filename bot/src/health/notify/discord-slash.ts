// The Discord bot's slash commands (Track D3, ADR 0118 addendum D3, docs/discord.md "Slash commands"): what is registered,
// how an interaction becomes the chat line it stands for, the autocomplete answers, and the registration with its hash
// rule. Pure apart from SlashRegistry's REST calls and its small state file; the door (who, where, how often, what is
// refused) is the text commands' own (discord-access.ts), applied by discord-bot.ts.
//
//   slashPayload('global') / slashPayload('guild')     // the commands as Discord's JSON (registration bodies)
//   slashLine(data, '!')                               // INTERACTION_CREATE type 2's data -> '!goto home', or undefined
//   autocomplete({ data, commands, waypoints, prefix }) // type 4 -> up to 25 { name, value } choices
//   const reg = new SlashRegistry({ file, call: (m, p, b) => rest.call(m, p, b) });
//   await reg.sync(app, guilds)                        // a PUT only for a scope whose hash changed
//
// The set is small on purpose: one Discord command per bot command would be dozens, past what a phone's list can show,
// and every new bot command would change it. `/run` takes any command line with autocomplete from the bot's own help;
// the others are the ones a phone user taps most (see SLASH_DEFS).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { CommandInfo } from '../../chat/help.ts';
import type { Logger } from '../../log.ts';
import { COMMAND_MAX, DISCORD_REFUSE, SNOWFLAKE_RE } from './discord-access.ts';
import type { RestResult } from './discord-rest.ts';

/** Discord's interaction types (INTERACTION_CREATE `type`). */
export const INTERACTION = { ping: 1, command: 2, component: 3, autocomplete: 4 } as const;
/** Discord's interaction callback types. */
export const CALLBACK = { message: 4, deferred: 5, update: 7, autocomplete: 8 } as const;
/** A message only the user who sent the interaction sees. */
export const EPHEMERAL = 64;
/** A command's option type STRING; the command type CHAT_INPUT. */
export const OPTION_STRING = 3;
export const CHAT_INPUT = 1;
/** Interaction contexts (global commands only): a server (0), a direct message with the bot (1). */
export const CONTEXT = { guild: 0, botDm: 1 } as const;
/** The installation type: added to a server (the only one this bot uses). */
export const GUILD_INSTALL = 0;
/** Discord: at most 25 autocomplete choices, each name and value at most 100 characters. */
export const CHOICES_MAX = 25;
export const CHOICE_MAX = 100;
/** The registered hashes, next to config.json (not a secret: command names and server ids). */
export const COMMANDS_FILE = 'discord-commands.json';

export interface SlashOption {
  type: typeof OPTION_STRING;
  name: string;
  description: string;
  required?: true;
  autocomplete: true;
  max_length: number;
}

export interface SlashCommand {
  name: string;
  type: typeof CHAT_INPUT;
  description: string;
  options?: SlashOption[];
}

interface SlashDef {
  cmd: SlashCommand;
  /** The chat line without the prefix, from the options' values (trimmed, never empty when required). */
  line(o: Readonly<Record<string, string>>): string;
}

const opt = (name: string, description: string, required: boolean): SlashOption => ({ type: OPTION_STRING, name, description, ...(required ? { required: true as const } : {}), autocomplete: true, max_length: COMMAND_MAX });

/**
 * The slash commands, in the order Discord lists them. Why these: `/status` and `/stop` are the two a phone user needs
 * at once (what is it doing; stop it now), one tap with nothing to type; `/come` and `/goto` are the moves asked for most
 * (the help's `go` group), `/goto` with the waypoint names offered as they are typed; `/queue` is the away-from-the-game
 * workflow (ADR 0115: see, add, pause, resume jobs); `/run` is everything else, any command line, with the bot's own
 * command list and help as its autocomplete. `!help`'s other front-door commands (`get`, `bring`, `guard`, `build`, ...)
 * take arguments that `/run`'s autocomplete already shows from their help.
 */
export const SLASH_DEFS: readonly SlashDef[] = [
  { cmd: { name: 'status', type: CHAT_INPUT, description: 'What the bot is doing now (!status)' }, line: () => 'status' },
  { cmd: { name: 'stop', type: CHAT_INPUT, description: 'Stop every command now; guard and night keep running (!stop)' }, line: () => 'stop' },
  { cmd: { name: 'come', type: CHAT_INPUT, description: 'Walk to the owner in the game (!come)' }, line: () => 'come' },
  { cmd: { name: 'goto', type: CHAT_INPUT, description: 'Walk to a waypoint or to x y z (!goto)', options: [opt('place', 'A waypoint name (offered as you type), or x y z', true)] }, line: (o) => `goto ${o.place ?? ''}` },
  { cmd: { name: 'queue', type: CHAT_INPUT, description: 'The job queue: show it, or add, pause, resume, clear (!queue)', options: [opt('do', 'Empty: show the queue; or add <command>, pause, resume, clear, retry <id>', false)] }, line: (o) => (o.do ? `queue ${o.do}` : 'queue') },
  { cmd: { name: 'run', type: CHAT_INPUT, description: 'Run any bot command line, as typed after ! in the game', options: [opt('line', 'The command and its arguments, e.g. get wood 16 (offered as you type)', true)] }, line: (o) => o.line ?? '' },
];

export type SlashScope = 'global' | 'guild';

/**
 * The registration body. A global command is offered in direct messages with the bot only (contexts [1]): in a server it
 * would be refused in every channel not listed, and a server with a listed channel has the same commands registered for
 * it alone (they show at once there, and are not listed twice).
 */
export function slashPayload(scope: SlashScope): (SlashCommand & { contexts?: number[]; integration_types?: number[] })[] {
  return SLASH_DEFS.map((d) => (scope === 'global' ? { ...d.cmd, contexts: [CONTEXT.botDm], integration_types: [GUILD_INSTALL] } : { ...d.cmd }));
}

/** What an APPLICATION_COMMAND's or an autocomplete's `data` holds. */
export interface SlashData {
  name?: unknown;
  options?: unknown;
}

interface OptionIn {
  name?: unknown;
  value?: unknown;
  focused?: unknown;
}

/**
 * Option values as text: control characters gone, trimmed (Discord sends the user's typing as it is). `typing`: the
 * end is kept (an autocomplete: `goto ` asks for what follows the name, `goto` for the names).
 */
function optionValues(data: SlashData | undefined, typing = false): { values: Record<string, string>; focused: string | undefined } {
  const values: Record<string, string> = {};
  let focused: string | undefined;
  const list = Array.isArray(data?.options) ? (data.options as OptionIn[]) : [];
  for (const o of list.slice(0, 10)) {
    if (typeof o?.name !== 'string') continue;
    const raw = typeof o.value === 'string' ? o.value : typeof o.value === 'number' || typeof o.value === 'boolean' ? String(o.value) : '';
    // eslint-disable-next-line no-control-regex
    const v = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ');
    values[o.name] = (typing ? v.trimStart() : v.trim()).slice(0, COMMAND_MAX + 1);
    if (o.focused === true) focused = o.name;
  }
  return { values, focused };
}

/** `run line:!goto home` and `run line:goto home` are the same: a typed prefix is taken off. */
const unprefixed = (s: string, prefix: string): string => {
  let t = s.trimStart();
  while (prefix && t.startsWith(prefix)) t = t.slice(prefix.length).trimStart();
  return t;
};

/** The chat line a slash command stands for (`!goto home`), or undefined for a command this bot does not register. */
export function slashLine(data: SlashData | undefined, prefix: string): string | undefined {
  const name = typeof data?.name === 'string' ? data.name : '';
  const def = SLASH_DEFS.find((d) => d.cmd.name === name);
  if (!def) return undefined;
  const { values } = optionValues(data);
  const v = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, unprefixed(x, prefix)]));
  const line = unprefixed(def.line(v), prefix).trim();
  return line ? `${prefix}${line}` : undefined;
}

export interface Choice {
  name: string;
  value: string;
}

export interface AutocompleteInput {
  data: SlashData | undefined;
  /** The bot's commands with their help (Chat.commandInfo: `!help`'s data). */
  commands: readonly CommandInfo[];
  /** The waypoint names of this server. */
  waypoints: readonly string[];
  prefix: string;
}

const cut = (s: string, n = CHOICE_MAX): string => (s.length <= n ? s : `${s.slice(0, n - 3)}...`);
const choice = (value: string, label?: string): Choice => ({ name: cut(label ?? value), value: cut(value) });

/** Fit a list for Discord: no empty or doubled value, at most 25. */
function fit(list: readonly Choice[]): Choice[] {
  const seen = new Set<string>();
  const out: Choice[] = [];
  for (const c of list) {
    if (!c.value.trim() || seen.has(c.value)) continue;
    seen.add(c.value);
    out.push(c);
    if (out.length >= CHOICES_MAX) break;
  }
  return out;
}

/** Names starting with what was typed first, then names holding it. */
function matching<T>(list: readonly T[], typed: string, key: (t: T) => string): T[] {
  const q = typed.toLowerCase();
  if (!q) return [...list];
  const starts = list.filter((x) => key(x).toLowerCase().startsWith(q));
  const holds = list.filter((x) => !key(x).toLowerCase().startsWith(q) && key(x).toLowerCase().includes(q));
  return [...starts, ...holds];
}

/** The literal start of each `a | b` alternative of a help syntax (`add <command>` -> `add`, `clear [ended]` -> `clear`). */
export function syntaxWords(syntax: string): string[] {
  const out: string[] = [];
  for (const alt of syntax.replace(/^\[|\]$/g, '').split(/\s+\|\s+/)) {
    const words: string[] = [];
    for (const w of alt.trim().split(/\s+/)) {
      if (!/^[a-z][a-z0-9_-]*$/i.test(w)) break;
      words.push(w);
    }
    if (words.length && !words.every((w) => w.length === 1)) out.push(words.join(' ')); // `x y z` stands for numbers
  }
  return out;
}

/** The commands `/run` offers: every command the bot has, less those Discord never takes; the front door first. */
function offered(commands: readonly CommandInfo[]): CommandInfo[] {
  const ok = commands.filter((c) => !DISCORD_REFUSE[c.name]);
  return [...ok.filter((c) => c.tier === 'front'), ...ok.filter((c) => c.tier !== 'front').sort((a, b) => a.name.localeCompare(b.name))];
}

/** What goes after a command name: waypoints for the commands that take one, else the help's words and its example. */
function argChoices(info: CommandInfo, rest: string, i: AutocompleteInput, lead: string): Choice[] {
  const wp = ['goto', 'wp', 'fly'].includes(info.name) ? matching(i.waypoints, rest, (w) => w).map((w) => choice(`${lead}${w}`)) : [];
  const words = matching(syntaxWords(info.syntax), rest, (w) => w).map((w) => choice(`${lead}${w}`));
  const ex = info.example ? unprefixed(info.example, i.prefix) : '';
  const example = ex.startsWith(`${info.name} `) && ex.slice(info.name.length + 1).toLowerCase().startsWith(rest.toLowerCase()) ? [choice(`${lead}${ex.slice(info.name.length + 1)}`, `${lead}${ex.slice(info.name.length + 1)} (the example)`)] : [];
  return [...wp, ...words, ...example];
}

/** `/run`'s line as it is typed: the command names (with their phrase), then that command's arguments. */
function lineChoices(typed: string, i: AutocompleteInput): Choice[] {
  const t = unprefixed(typed, i.prefix);
  const cmds = offered(i.commands);
  const sp = t.indexOf(' ');
  if (sp < 0) return matching(cmds, t, (c) => c.name).map((c) => choice(c.name, `${c.name}: ${c.phrase}`));
  const name = t.slice(0, sp).toLowerCase();
  const rest = t.slice(sp + 1).trimStart();
  const info = cmds.find((c) => c.name === name);
  const own = choice(t.trim());
  if (!info) return [own];
  // `queue add <line>`: the queued line is completed as /run's own
  if (name === 'queue' && /^add\s/i.test(rest)) return [own, ...lineChoices(rest.slice(4), i).map((c) => choice(`queue add ${c.value}`, `queue add ${c.name}`))];
  return [own, ...argChoices(info, rest, i, `${name} `)];
}

/** An autocomplete's answer: the focused option's choices (`goto place`, `queue do`, `run line`). */
export function autocomplete(i: AutocompleteInput): Choice[] {
  const name = typeof i.data?.name === 'string' ? i.data.name : '';
  const { values, focused } = optionValues(i.data, true);
  const typed = focused ? (values[focused] ?? '') : '';
  if (name === 'goto' && focused === 'place') {
    const wps = matching(i.waypoints, typed.trim(), (w) => w);
    // what was typed is offered when no waypoint starts with it (x y z, a new name)
    const own = typed.trim() && !i.waypoints.some((w) => w.toLowerCase().startsWith(typed.trim().toLowerCase())) ? [choice(typed.trim())] : [];
    return fit([...own, ...wps.map((w) => choice(w))]);
  }
  if (name === 'queue' && focused === 'do') {
    const q = i.commands.find((c) => c.name === 'queue');
    if (/^add\s/i.test(typed)) return fit(lineChoices(typed.slice(4), i).map((c) => choice(`add ${c.value}`, `add ${c.name}`)));
    return fit([...(typed.trim() ? [choice(typed.trim())] : []), ...(q ? matching(syntaxWords(q.syntax), typed.trim(), (w) => w).map((w) => choice(w)) : [])]);
  }
  if (name === 'run' && focused === 'line') return fit(lineChoices(typed, i));
  return [];
}

// ---- the registration ---------------------------------------------------------------------------------------------

/** A scope's key: `global`, or a server's id. */
export type ScopeKey = string;

/** The hash of what one scope holds: the application, the scope and the commands' JSON. */
export function commandsHash(app: string, scope: ScopeKey, body: unknown): string {
  return createHash('sha256').update(JSON.stringify({ app, scope, body })).digest('hex').slice(0, 24);
}

export interface ScopeStatus {
  scope: ScopeKey;
  state: 'ok' | 'failed' | 'removed';
  /** ok: `registered` (a PUT this run) or `unchanged` (the hash matched: no call). */
  how?: 'registered' | 'unchanged';
  status?: number | null;
  why?: string;
  at: number;
}

export interface RegistryOptions {
  /** The state file (COMMANDS_FILE in the config directory); undefined: kept in memory (registered once per run). */
  file?: string | undefined;
  call: (method: string, path: string, body?: unknown) => Promise<RestResult>;
  log?: Logger;
  now?: () => number;
}

interface RegFile {
  v: 1;
  scopes: Record<ScopeKey, string>;
}

export const scopePath = (app: string, scope: ScopeKey): string => (scope === 'global' ? `/applications/${app}/commands` : `/applications/${app}/guilds/${scope}/commands`);

/**
 * Registers the commands where they are wanted and only when what a scope should hold changed (a bulk overwrite, PUT:
 * Discord replaces the scope's whole list, so a command dropped from SLASH_DEFS goes too). The hashes of what was
 * registered are kept in COMMANDS_FILE, so a restart registers nothing; a server no longer wanted gets an empty list.
 */
export class SlashRegistry {
  private readonly o: RegistryOptions;
  private hashes: Record<ScopeKey, string> = {};
  private last: ScopeStatus[] = [];
  readonly stats = { puts: 0, kept: 0, failed: 0 };

  constructor(o: RegistryOptions) {
    this.o = o;
    this.hashes = this.load();
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private load(): Record<ScopeKey, string> {
    if (!this.o.file) return {};
    try {
      if (!existsSync(this.o.file)) return {};
      const j = JSON.parse(readFileSync(this.o.file, 'utf8')) as Partial<RegFile>;
      const out: Record<ScopeKey, string> = {};
      for (const [k, v] of Object.entries(j.scopes ?? {})) if ((k === 'global' || SNOWFLAKE_RE.test(k)) && typeof v === 'string') out[k] = v;
      return out;
    } catch {
      return {}; // a broken file: registered again
    }
  }

  private save(): void {
    if (!this.o.file) return;
    try {
      const tmp = `${this.o.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ v: 1, scopes: this.hashes } satisfies RegFile, null, 2)}\n`);
      renameSync(tmp, this.o.file);
    } catch (e) {
      this.o.log?.warn(`discord bot: ${COMMANDS_FILE} not written (${e instanceof Error ? e.message : String(e)}): the commands are registered again at the next start`);
    }
  }

  /** The scopes as the last sync left them. */
  status(): ScopeStatus[] {
    return this.last.map((s) => ({ ...s }));
  }

  /** The scopes registered before (from the file or this run). */
  known(): ScopeKey[] {
    return Object.keys(this.hashes);
  }

  /** Global (direct messages) and each server in `guilds`; `force` registers even an unchanged scope. */
  async sync(app: string, guilds: readonly string[], force = false): Promise<ScopeStatus[]> {
    const want = new Map<ScopeKey, unknown>([['global', slashPayload('global')]]);
    for (const g of guilds) if (SNOWFLAKE_RE.test(g)) want.set(g, slashPayload('guild'));
    const out: ScopeStatus[] = [];
    for (const [scope, body] of want) {
      const h = commandsHash(app, scope, body);
      if (!force && this.hashes[scope] === h) {
        this.stats.kept++;
        out.push({ scope, state: 'ok', how: 'unchanged', at: this.now() });
        continue;
      }
      const r = await this.o.call('PUT', scopePath(app, scope), body);
      if (r.ok) {
        this.stats.puts++;
        this.hashes[scope] = h;
        out.push({ scope, state: 'ok', how: 'registered', status: r.status, at: this.now() });
      } else {
        this.stats.failed++;
        delete this.hashes[scope];
        out.push({ scope, state: 'failed', status: r.status, why: r.why, at: this.now() });
      }
    }
    for (const scope of Object.keys(this.hashes)) {
      if (want.has(scope)) continue;
      const r = await this.o.call('PUT', scopePath(app, scope), []);
      // gone either way when the bot is no longer in that server (403 / 404)
      if (r.ok || r.status === 403 || r.status === 404) delete this.hashes[scope];
      out.push({ scope, state: r.ok ? 'removed' : 'failed', status: r.status, ...(r.ok ? {} : { why: r.why }), at: this.now() });
    }
    this.save();
    this.last = out;
    return this.status();
  }

  /** Every scope registered before gets an empty list (`!discord commands remove`); the hashes go. */
  async remove(app: string, extra: readonly ScopeKey[] = []): Promise<ScopeStatus[]> {
    const scopes = [...new Set(['global', ...Object.keys(this.hashes), ...extra])];
    const out: ScopeStatus[] = [];
    for (const scope of scopes) {
      const r = await this.o.call('PUT', scopePath(app, scope), []);
      if (r.ok || r.status === 403 || r.status === 404) delete this.hashes[scope];
      out.push({ scope, state: r.ok ? 'removed' : 'failed', status: r.status, ...(r.ok ? {} : { why: r.why }), at: this.now() });
    }
    this.save();
    this.last = out;
    return this.status();
  }
}

/** `global (DMs) registered, 1 server unchanged` / `1 failed (403 Missing Access)`: the line in `!discord`. */
export function slashText(list: readonly ScopeStatus[]): string {
  if (!list.length) return 'not registered yet';
  const ok = list.filter((s) => s.state === 'ok');
  const failed = list.filter((s) => s.state === 'failed');
  const servers = ok.filter((s) => s.scope !== 'global').length;
  const parts: string[] = [];
  if (ok.some((s) => s.scope === 'global')) parts.push('DMs');
  if (servers) parts.push(`${servers} server${servers === 1 ? '' : 's'}`);
  const head = parts.length ? `${SLASH_DEFS.length} for ${parts.join(' and ')}` : 'none';
  const f = failed[0];
  return `${head}${f ? `; ${failed.length} failed (${[f.status ?? 'no answer', f.why].filter(Boolean).join(' ')})` : ''}`;
}
