// Chat layer (PLAN.md task 1.2): parses every `text` packet, runs `!commands` from owners, and
// sends replies as player chat.
import type { Connection } from '../connection/connection.ts';
import type { TextPacket } from '../connection/types.ts';
import { createLogger, type Logger } from '../log.ts';
import { parseText, type ChatLine } from './text.ts';
import { commandInfo, helpReplies, type CommandInfo, type HelpSettings } from './help.ts'; // Track AM
import { richHelpReplies } from './help-rich.ts'; // chat style (docs/chat-style.md)
import { colorize, Doc, fitWire, isStyled, paint, PLAIN_MODE, strip, wireSize, type StyleMode, type Tone } from './style.ts';
import { commandRequestPacket, isRouteStyle, routeCommand, SLASH_MAX, SlashRoute, type CommandOutputLike, type RouteStatus, type RouteStyle, type RouteVia } from './route.ts'; // the optional /me, /say, /tellraw routes

/** Longest multi-line block (visible text plus codes) say() lets through when `chatLines` is on; the wire limit is style.ts MAX_WIRE. */
const MAX_BLOCK = 440;

/** The "route was refused" line waits this long, so replies refused together are resent before it. */
const WARN_DELAY_MS = 400;

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
  private offOutput: (() => void) | undefined;
  private readonly route = new SlashRoute(() => Date.now());
  /** The `chatVia` value the last message saw, to notice a switch to a slash route (a restart counts: undefined before the first message). */
  private lastVia: string | undefined;
  /** A try the owner caused (a switch, a restart, `!colors`) has not been answered by a refusal yet: the first refusal is told in chat. */
  private routeTest = false;
  private warnTimer: ReturnType<typeof setTimeout> | undefined;

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

  /**
   * Chat style switches, read live on every message (docs/chat-style.md). Set by the afk task's UX wiring
   * (modes.ts registerUxCommands) from the `chatColor`, `chatLines` and `chatVia` settings; undefined = all
   * off / chat, which is how every unit test and every other task runs.
   */
  styleSource: { color(): boolean; lines(): boolean; via?(): string } | undefined;

  /** The switches right now (both off when no source is wired or it throws). While replies go out as tellraw a Doc measures its messages as the command counts them (`tellraw`). */
  styleMode(): StyleMode {
    try {
      if (!this.styleSource) return PLAIN_MODE;
      const mode: StyleMode = { color: this.styleSource.color(), lines: this.styleSource.lines() };
      if (this.slashStyle() === 'tellraw') mode.tellraw = true;
      return mode;
    } catch {
      return PLAIN_MODE;
    }
  }

  /**
   * The slash route in use (`chatVia me | say | tellraw`), or undefined for plain chat or while the server's refusal
   * is fresh. The one place that reads the setting, so it is also where a switch to a slash route (or the first
   * message after a start with one on) is noticed: that clears an old refusal and makes the next message the
   * test; a refusal of it is told in chat.
   */
  private slashStyle(): RouteStyle | undefined {
    try {
      const via = this.styleSource?.via?.();
      if (via !== this.lastVia) {
        this.lastVia = via;
        if (isRouteStyle(via)) this.retryRoute();
      }
      return isRouteStyle(via) && this.route.usable() ? via : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Try the slash route again now (`!colors`, a switch of `chatVia`): forgets a refusal, and the next reply is the
   * test; if the server refuses it, the owner gets one chat line saying so. Harmless while `chatVia` is `chat`.
   */
  retryRoute(): void {
    this.route.reset();
    this.routeTest = true;
  }

  /**
   * The reply route for `!colors`: what `chatVia` asks for (`setting`), what is in use now (`via`: `chat` while
   * the server's refusal is fresh), and whether the server refused (`refused` + its message id; the route is
   * tried again after RETRY_MS).
   */
  routeStatus(): { setting: string; via: RouteVia; route: RouteStatus } {
    let setting = 'chat';
    try {
      setting = this.styleSource?.via?.() ?? 'chat';
    } catch {
      /* the setting cannot be read: chat */
    }
    return { setting, via: this.slashStyle() ?? 'chat', route: this.route.status() };
  }

  /**
   * `text` in a tone when `chatColor` is on, else `text` unchanged. For the one time a command KNOWS what its
   * words mean and does not want them guessed: `reply(`${chat.paint('bad', 'refused')}: no chest`)`. A reply
   * with a painted part is sent as it is (the automatic colour skips it), so paint the parts that matter.
   */
  paint(tone: Tone, text: string): string {
    return paint(tone, text, this.styleMode().color);
  }

  /**
   * The messages of a long, structured answer. With `chatLines` on: what `build` makes of a fresh Doc in the
   * live modes. Off: `plain`, exactly as given. Write both once; do not test the modes yourself.
   *
   *   for (const m of chat.layout(oldLines, (d) => d.title('stock').pairs(rows))) reply(m);
   */
  layout(plain: readonly string[] | (() => string[]), build: (d: Doc) => void): string[] {
    const mode = this.styleMode();
    if (!mode.lines) return typeof plain === 'function' ? plain() : [...plain];
    const d = new Doc(mode);
    build(d);
    return d.messages();
  }

  /** Track AM: the `!help [all | settings | <command>]` reply lines. */
  helpReplies(args: readonly string[] = []): string[] {
    const mode = this.styleMode();
    const infos = this.commandInfo();
    if (mode.lines) return richHelpReplies(infos, args, { prefix: this.prefix, maxLength: this.maxReplyLength, settings: this.helpSettings, mode });
    return helpReplies(infos, args, { prefix: this.prefix, maxLength: this.maxReplyLength, settings: this.helpSettings });
  }

  start(): void {
    if (this.off) return;
    this.off = this.conn.on('text', (p) => {
      this.handle(parseText(p));
    });
    // a /say or /tellraw the server refused (the bot is not an operator) comes back here as command_output; the text goes out as chat instead
    this.offOutput = this.conn.on('command_output', (p) => {
      this.onCommandOutput(p);
    });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
    this.offOutput?.();
    this.offOutput = undefined;
    clearTimeout(this.warnTimer);
    this.warnTimer = undefined;
  }

  /** `command_output` for one of our slash commands: when it failed, resend the text as chat and pause the route (route.ts). */
  private onCommandOutput(packet: Record<string, unknown>): void {
    const p = packet as CommandOutputLike;
    const first = p.output?.[0]?.message_id;
    const id = typeof first === 'string' ? first : undefined;
    const uuid = typeof p.origin?.uuid === 'string' ? p.origin.uuid : undefined;
    const successCount = typeof p.success_count === 'number' ? p.success_count : 0;
    const text = this.route.onOutput(uuid, successCount, id);
    if (text === undefined) return;
    const why = id ?? 'no message id';
    if (this.conn.state !== 'spawned') return;
    this.conn.queue('text', chatPacket(this.conn.username, text));
    const via = this.lastVia ?? 'tellraw';
    if (this.routeTest) {
      // the owner asked for the route (or just switched to it): tell them it did not work, once, where they are looking
      this.routeTest = false;
      this.log.warn(`/${via} refused (${why}); replies stay in chat. ${this.prefix}colors tries again`);
      // `/me` needs no operator rights, so a refusal of it is not about that
      const opHint = via === 'me' ? '' : ' The bot is probably not an operator; make it one, then';
      // a moment later, so the rest of a burst that was refused together (a help block) is resent before the warning
      this.warnTimer = setTimeout(() => {
        this.warnTimer = undefined;
        if (this.conn.state !== 'spawned') return;
        this.conn.queue('text', chatPacket(this.conn.username, this.finish(`chatVia ${via}: refused by the server (${why}), so replies stay in chat.${opHint} ${this.prefix}colors tries again`)));
      }, WARN_DELAY_MS);
    } else {
      this.log.info(`/${via} refused again (${why}); chat for ${Math.round(this.route.status().retryInMs ?? 0) / 1000} s more`);
    }
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
    this.send(this.finish(message));
    return true;
  }

  /**
   * The last step: the finished text goes out as player chat, or as `/me`, `/say` or `/tellraw @a` when `chatVia`
   * asks for it, the server has not refused it lately, the style can carry the text (no `@` for /me and /say) and
   * the command stays under route.ts SLASH_MAX (a longer command makes the server drop the connection). Whatever
   * the route, the text is the same; the only commands ever sent are those three (route.ts routeCommand).
   */
  private send(text: string): void {
    const style = this.slashStyle();
    if (style) {
      const command = routeCommand(style, text);
      if (command !== undefined && wireSize(command) <= SLASH_MAX) {
        const packet = commandRequestPacket(command);
        this.route.track(packet.origin.uuid, text);
        this.conn.queue('command_request', packet);
        return;
      }
    }
    this.conn.queue('text', chatPacket(this.conn.username, text));
  }

  /**
   * The text that goes on the wire (docs/chat-style.md): cut to the reply limit, then coloured when `chatColor`
   * is on. A message that already carries codes (a Doc block, `!colors`) is left as it is. Whatever the codes
   * add, the result is at most style.ts MAX_WIRE characters: the server drops a longer chat message silently.
   */
  private finish(message: string): string {
    const mode = this.styleMode();
    if (isStyled(message)) return fitWire(message, message);
    const limit = mode.lines && message.includes('\n') ? MAX_BLOCK : this.maxReplyLength;
    const text = message.length > limit ? `${message.slice(0, limit - 3)}...` : message;
    return mode.color ? fitWire(colorize(text), strip(text)) : fitWire(text, text); // bytes, not characters: see style.ts MAX_WIRE
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
