// Chat layer (PLAN.md task 1.2): parses every `text` packet, runs `!commands` from owners, and
// sends replies as player chat.
import type { Connection } from '../connection/connection.ts';
import type { TextPacket } from '../connection/types.ts';
import { createLogger, type Logger } from '../log.ts';
import { parseText, type ChatLine } from './text.ts';
import { commandInfo, helpReplies, type CommandInfo, type HelpSettings } from './help.ts'; // Track AM

/** Who sent a chat line. The console is `say` / `tell` typed into the BDS console (or docker exec). */
export type Sender = { kind: 'console' } | { kind: 'player'; name: string; xuid: string };

export interface OwnerConfig {
  /** Player names (case-insensitive). */
  names: readonly string[];
  /** XUIDs (exact). Offline-mode players have none, so local BDS tests use names. */
  xuids: readonly string[];
  /** Accept commands typed into the server console (`say !status`). Default true. */
  allowConsole: boolean;
}

export const DEFAULT_OWNERS: OwnerConfig = { names: [], xuids: [], allowConsole: true };

/**
 * Build an owner config from CLI/env entries: `Steve` (a name) or `xuid:2535412345678901`.
 * Entries may also be comma-separated lists.
 */
export function parseOwners(entries: readonly string[], allowConsole = true): OwnerConfig {
  const names: string[] = [];
  const xuids: string[] = [];
  for (const entry of entries.flatMap((e) => e.split(','))) {
    const t = entry.trim();
    if (!t) continue;
    if (t.toLowerCase().startsWith('xuid:')) {
      const x = t.slice(5).trim();
      if (x) xuids.push(x);
    } else {
      names.push(t);
    }
  }
  return { names, xuids, allowConsole };
}

/**
 * Who sent `line`, or undefined when it is not something a person typed: system and json messages,
 * truth-pack lines, join/leave translations, and the bot's own chat echoed back.
 *
 * The console shows up as source "Server" with an empty XUID on `announcement` (`say`) and
 * `whisper` (`tell`) lines. A player chatting under the name "Server" sends `chat`, not
 * `announcement`; only an operator could fake a console `say`, and online players always have an XUID.
 */
export function senderOf(line: ChatLine, ownName: string): Sender | undefined {
  if (line.truth || !line.source) return undefined;
  if (line.source.toLowerCase() === ownName.toLowerCase()) return undefined;
  if (line.type !== 'chat' && line.type !== 'whisper' && line.type !== 'announcement') return undefined;
  if (line.source === 'Server' && line.xuid === '' && line.type !== 'chat') return { kind: 'console' };
  return { kind: 'player', name: line.source, xuid: line.xuid };
}

export function isOwner(sender: Sender, owners: OwnerConfig): boolean {
  if (sender.kind === 'console') return owners.allowConsole;
  if (sender.xuid && owners.xuids.includes(sender.xuid)) return true;
  const name = sender.name.toLowerCase();
  return owners.names.some((n) => n.toLowerCase() === name);
}

export function senderLabel(sender: Sender): string {
  return sender.kind === 'console' ? 'console' : sender.name;
}

export interface ParsedCommand {
  name: string;
  args: string[];
}

/** `!status`, `!pos`, `! quit` -> { name, args }; anything else -> undefined. */
export function parseCommand(body: string, prefix = '!'): ParsedCommand | undefined {
  const text = body.trim();
  if (!text.startsWith(prefix)) return undefined;
  const words = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  const [first, ...args] = words;
  if (!first || !/^[a-z][\w-]*$/i.test(first)) return undefined;
  return { name: first.toLowerCase(), args };
}

export interface CommandContext {
  line: ChatLine;
  sender: Sender;
  args: string[];
  reply: (message: string) => void;
}

/** Track AM (docs/ux.md): `front` commands are the short `!help`; everything else is `more` (`!help all`). */
export type CommandTier = 'front' | 'more';
/** Track AM: the help groups, in the order `!help` prints them. */
export type CommandGroup = 'go' | 'work' | 'fight' | 'home' | 'control' | 'info';

export interface CommandDef {
  name: string;
  /** `<syntax> (one-line description)`: `!help <command>` splits it at the last parenthesis. */
  help: string;
  /** Default `more` (a name in help.ts FRONT_DOOR registered without a tier counts as front). */
  tier?: CommandTier;
  group?: CommandGroup;
  /** A command line that works as typed, e.g. `!get wood 16`. */
  example?: string;
  /** "also happens on its own when ...": only what the bot really does by itself today. */
  auto?: string;
  run(ctx: CommandContext): void;
}

export type CommandEvent =
  | { kind: 'run'; name: string; sender: Sender }
  | { kind: 'denied'; name: string; sender: Sender }
  | { kind: 'unknown'; name: string; sender: Sender };

export interface ChatOptions {
  owners?: OwnerConfig;
  prefix?: string;
  log?: Logger;
  /** Longer replies are cut (BDS accepts up to 512 characters of chat). Default 256. */
  maxReplyLength?: number;
  /** At most this many replies per `replyWindowMs` (loop and spam guard). Default 8 per 10 s. */
  maxReplies?: number;
  replyWindowMs?: number;
}

/** Outbound player chat packet. BDS drops the connection when `category` is not 'authored'. */
export function chatPacket(sourceName: string, message: string): TextPacket {
  return {
    needs_translation: false,
    category: 'authored',
    type: 'chat',
    source_name: sourceName,
    message,
    xuid: '',
    platform_chat_id: '',
    has_filtered_message: false,
  };
}

export class Chat {
  readonly owners: OwnerConfig;
  readonly prefix: string;
  private readonly conn: Connection;
  private readonly log: Logger;
  private readonly maxReplyLength: number;
  private readonly maxReplies: number;
  private readonly replyWindowMs: number;
  private readonly commands = new Map<string, CommandDef>();
  private readonly lineListeners = new Set<(line: ChatLine) => void>();
  private readonly commandListeners = new Set<(e: CommandEvent) => void>();
  private readonly replyTimes: number[] = [];
  private off: (() => void) | undefined;

  constructor(conn: Connection, opts: ChatOptions = {}) {
    this.conn = conn;
    this.owners = opts.owners ?? DEFAULT_OWNERS;
    this.prefix = opts.prefix ?? '!';
    this.log = opts.log ?? createLogger('info', 'chat');
    this.maxReplyLength = opts.maxReplyLength ?? 256;
    this.maxReplies = opts.maxReplies ?? 8;
    this.replyWindowMs = opts.replyWindowMs ?? 10_000;
    // Track AM: `!commands` = `!help all` (`!help` itself is registered with the built-ins, commands.ts)
    this.register({
      name: 'commands',
      help: '(every command by group, names only: the same as !help all)',
      group: 'info',
      example: '!commands',
      run: ({ reply }) => {
        for (const line of this.helpReplies(['all'])) reply(line);
      },
    });
  }

  register(def: CommandDef): void {
    this.commands.set(def.name.toLowerCase(), def);
  }

  commandNames(): string[] {
    return [...this.commands.keys()];
  }

  /** Track AM: is the command registered (e.g. `!unload` once Track AG's lands). */
  has(name: string): boolean {
    return this.commands.has(name.toLowerCase());
  }

  /** `!name help (also on its own: ...)` per command, ` | ` between (the natural-language prompt's reference). */
  helpText(): string {
    return [...this.commands.values()].map((c) => `${this.prefix}${c.name} ${c.help}${c.auto ? ` (also on its own: ${c.auto})` : ''}`).join(' | ');
  }

  /** Track AM: every command with its tier, group, syntax, description, example and auto line. */
  commandInfo(): CommandInfo[] {
    return [...this.commands.values()].map((c) => commandInfo(c));
  }

  /** Track AM: the settings `!help settings` lists (set by the afk task's registration, help.ts registerUx). */
  helpSettings: HelpSettings | undefined;

  /**
   * Track AM: a next-step hint for a reply (help.ts hintFor); undefined = none. say() appends it when
   * the result still fits in one message.
   */
  hinter: ((message: string) => string | undefined) | undefined;

  /** Track AM: the `!help [all | settings | <command>]` reply lines. */
  helpReplies(args: readonly string[] = []): string[] {
    return helpReplies(this.commandInfo(), args, { prefix: this.prefix, maxLength: this.maxReplyLength, settings: this.helpSettings });
  }

  start(): void {
    if (this.off) return;
    this.off = this.conn.on('text', (p) => {
      this.handle(parseText(p));
    });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
  }

  /** Every parsed chat line (including truth lines and our own echo). */
  onLine(fn: (line: ChatLine) => void): () => void {
    this.lineListeners.add(fn);
    return () => {
      this.lineListeners.delete(fn);
    };
  }

  /** Commands run, denied (not an owner) or unknown. */
  onCommand(fn: (e: CommandEvent) => void): () => void {
    this.commandListeners.add(fn);
    return () => {
      this.commandListeners.delete(fn);
    };
  }

  /** Send a player chat message as the bot. Returns false when dropped (not spawned or rate limited). */
  say(message: string): boolean {
    if (this.conn.state !== 'spawned') {
      this.log.warn(`not spawned, dropping chat: ${message}`);
      return false;
    }
    const now = Date.now();
    while (this.replyTimes.length > 0 && now - (this.replyTimes[0] ?? 0) > this.replyWindowMs) this.replyTimes.shift();
    if (this.replyTimes.length >= this.maxReplies) {
      this.log.warn(`chat rate limit, dropping: ${message}`);
      return false;
    }
    this.replyTimes.push(now);
    const hint = this.hint(message); // Track AM
    if (hint) message = `${message} ${hint}`;
    const text = message.length > this.maxReplyLength ? `${message.slice(0, this.maxReplyLength - 3)}...` : message;
    this.conn.queue('text', chatPacket(this.conn.username, text));
    return true;
  }

  /** Process one parsed line (exposed for tests). */
  handle(line: ChatLine): void {
    for (const fn of [...this.lineListeners]) fn(line);
    const sender = senderOf(line, this.conn.username);
    if (!sender) return;
    const cmd = parseCommand(line.body, this.prefix);
    if (!cmd) return;
    if (!isOwner(sender, this.owners)) {
      this.log.info(`ignoring ${this.prefix}${cmd.name} from ${senderLabel(sender)} (not an owner)`);
      this.emit({ kind: 'denied', name: cmd.name, sender });
      return;
    }
    const def = this.commands.get(cmd.name);
    if (!def) {
      this.emit({ kind: 'unknown', name: cmd.name, sender });
      this.say(`unknown command ${this.prefix}${cmd.name}; try ${this.prefix}help`);
      return;
    }
    this.log.info(`${this.prefix}${cmd.name} from ${senderLabel(sender)}`);
    this.emit({ kind: 'run', name: cmd.name, sender });
    try {
      def.run({ line, sender, args: cmd.args, reply: (m) => { this.say(m); } });
    } catch (e) {
      this.log.error(`${this.prefix}${cmd.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      this.say(`${this.prefix}${cmd.name} failed`);
    }
  }

  private hint(message: string): string | undefined {
    try {
      const h = this.hinter?.(message);
      return h && message.length + 1 + h.length <= this.maxReplyLength ? h : undefined;
    } catch {
      return undefined;
    }
  }

  private emit(e: CommandEvent): void {
    for (const fn of [...this.commandListeners]) fn(e);
  }
}
