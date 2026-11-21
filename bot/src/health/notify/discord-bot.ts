// The bot's own Discord bot (Track D1, ADR 0118, docs/discord.md): the owner commands the Minecraft bot from Discord and
// answers its questions with buttons, from a phone on any network, with nothing exposed (the gateway is an outbound
// websocket, everything sent goes over outbound REST; no port, no interactions URL).
//
//   const bot = new DiscordBot({ chat, settings: runtime, tokens: tokenSource({ env, configDir }), log });
//   setupPanel({ ..., noteSinks: [bot] });   // the notes (alerts, questions) through away mode's limiter
//   bot.start();                             // connects while `discordBot` is on and a token is set
//   bot.stop();
//
// A command from Discord runs exactly as the panel's: one chat line through Chat.handle as the first owner, `typed`,
// marked `discord` (viaDiscord). The rules of who, where and what are in discord-access.ts (ADR 0118 "Security
// model"); this file wires them: the gateway's MESSAGE_CREATE through gate(), refusal() and the per-user limiter; the
// replies said during the call as one reply message, then what that command and the processes it started say for
// FOLLOW_MS in batches (Track D2: only lines in the command's own scope, chat/scope.ts; a line from any other command
// or from nobody's is never followed); the notes to the notes channel or the allowed users' DMs with the question's
// choices as buttons; INTERACTION_CREATE (a press) answered within Discord's 3 s; `!discord [status|test]`. Nothing
// here throws into the bot: every handler is caught. The messages' layout: discord.ts (notes) and discord-reply.ts.
//
// Track D3 (ADR 0118 addendum D3): slash commands (discord-slash.ts) registered over REST after READY (a PUT only when a
// scope's hash changed), each run through the same door as a text command (the users and channels, the refusals, the
// per-user limit, Chat.handle as the first owner in a scope of its own) and answered within the 3 s: at once when it
// said something during its call, else deferred, the later lines as the reply's edit and follow-ups; a stranger, another
// channel, a refusal and the limit get an ephemeral answer only that user sees; autocomplete answers with the bot's own
// commands and waypoints (nothing for a stranger). `discordText off` drops text commands and every intent. `!discord
// setup` walks the set-up (discord-setup.ts).
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseCommand, type Chat } from '../../chat/chat.ts';
import { settingNotes } from '../../chat/commands.ts';
import { currentScope, newScope, outsideScope, type CommandScope } from '../../chat/scope.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import { viaDiscord } from '../../events/actor.ts';
import { events as globalBus, type EventBus } from '../../events/bus.ts';
import { durationText, type BotEvent } from '../../events/registry.ts';
import type { Logger } from '../../log.ts';
import type { AskCard, AskView } from '../../tasks/ask.ts';
import { panelLine } from '../panel/index.ts';
import type { Note } from '../panel/notes.ts';
import { choiceShort, outcomePayload, payloadFor, type AskOutcome, type DiscordPayload } from './discord.ts';
import { appIdFromToken, buttonId, COMMAND_MAX, cutText, gate, idSet, idsText, IgnoreCounts, interactionGate, INTERACTION_REFUSAL, notesText, parseButtonId, refusal, scrubToken, tokenText, UserLimiter, USER_RATE, type TokenState } from './discord-access.ts';
import { replyMessages } from './discord-reply.ts';
import { DISCORD_INTENTS, discordGatewayUrl, DiscordGateway, loopbackGatewayUrl, SLASH_ONLY_INTENTS, type GatewayState, type WsFactory } from './discord-gateway.ts';
import { DiscordRest, type RestFetch, type RestResult } from './discord-rest.ts';
import { setupCheck, setupLines } from './discord-setup.ts';
import { autocomplete, CALLBACK as SLASH_CALLBACK, COMMANDS_FILE, EPHEMERAL as SLASH_EPHEMERAL, INTERACTION, SlashRegistry, slashLine, slashText } from './discord-slash.ts';

/** What the bot says after a command is followed into its channel this long (`arrived at ...`), in batches. */
export const FOLLOW_MS = 120_000;
export const FOLLOW_BATCH_MS = 2_000;
/** Follow-up messages at most per command (the rest stays in the game chat and the panel). */
export const FOLLOW_MESSAGES = 8;
/** A command that said nothing during its call: the first look for its lines after this long. */
export const FIRST_WAIT_MS = 1_500;
/** Ignored messages are logged as one count line at most this often. */
export const COUNT_LOG_MS = 10 * 60_000;
/** Notes waiting at most (the oldest is dropped and counted). */
export const NOTES_QUEUE_MAX = 10;
/** Questions whose messages are remembered (to edit them when answered). */
export const ASK_KEEP = 16;
/** Track D2: Discord commands whose lines are followed at once (the oldest follow ends first). */
export const FOLLOWS_MAX = 4;
/** A failed send is logged at most this often (the count and the last failure are in `!discord`). */
export const FAIL_LOG_MS = 60_000;
/** Interaction response types: a message (4, with flags 64: only the presser sees it), an update of the pressed message (7). */
const CALLBACK = { message: SLASH_CALLBACK.message, update: SLASH_CALLBACK.update } as const;
const EPHEMERAL = SLASH_EPHEMERAL;
const NO_MENTIONS = { parse: [] as [] };

/** The chat parts the bot uses (`say` is wrapped to capture the replies, as the panel's ChatTap does; Track D3: `commandInfo` for autocomplete). */
export type BotChat = Pick<Chat, 'handle' | 'owners' | 'prefix' | 'say' | 'register'> & Partial<Pick<Chat, 'commandInfo'>>;

/**
 * Track D3: where a command's reply goes. A text command: its channel, the first message a reply to the user's. A slash
 * command: its interaction (the first message the reply itself, edited in when the answer was deferred; the rest
 * follow-ups), each call after the interaction's own answer (`ack`).
 */
type ReplyTo = { kind: 'channel'; channel: string; ref: string } | { kind: 'slash'; app: string; token: string; ack: Promise<unknown>; original: boolean };

export interface DiscordBotDeps {
  chat: BotChat;
  settings: Pick<RuntimeSettings, 'get' | 'onChange'> | undefined;
  tokens: { get(): TokenState; reload(): TokenState };
  log: Logger;
  /** Tests: the loopback origin (discord.ts testOrigin) instead of Discord. */
  origin?: string | undefined;
  /** Why nothing may connect (the test origin variable set to something not loopback). */
  blocked?: string | undefined;
  bus?: Pick<EventBus, 'subscribe'>;
  /** The Minecraft bot's name, for the notes. */
  bot?: () => string | undefined;
  /** Track D3: the waypoint names (`/goto`'s autocomplete). */
  waypoints?: () => readonly string[];
  /** Track D3: the config directory, where the slash commands' hashes are kept (COMMANDS_FILE); undefined: in memory. */
  stateDir?: string | undefined;
  ws?: WsFactory;
  fetch?: RestFetch;
  now?: () => number;
  random?: () => number;
  backoffBaseMs?: number;
}

/** Discord's button styles (https://discord.com/developers/docs/interactions/message-components#button-object-button-styles). */
export const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;

/**
 * A question message's button rows (5 to a row). Track D2: each label is the choice's own short word (`Retry`, `Skip`,
 * `Pause queue`); the default is the one primary (blurple) button and the others secondary (grey), and the message says
 * once what no answer does (`Unanswered: Skip in 5 minutes`). Not green or red: no choice the bot asks about is a
 * good-or-bad one, and red would read as "this loses work", which none does (each only decides what the queue does next).
 */
export function askButtons(run: string, v: AskView, card?: AskCard): { type: 1; components: { type: 2; style: number; label: string; custom_id: string }[] }[] {
  const buttons = v.choices.map((c) => ({
    type: 2 as const,
    style: c.id === v.default ? BUTTON_STYLE.primary : BUTTON_STYLE.secondary,
    label: cutText(choiceShort(c.id, card), 80),
    custom_id: buttonId(run, v.id, c.id),
  }));
  const rows: { type: 1; components: typeof buttons }[] = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  return rows;
}

interface AskRec {
  id: number;
  note: Note;
  view: AskView;
  card: AskCard | undefined;
  posts: { channel: string; message: string }[];
  answer?: AskOutcome;
}

/** The question message once it is answered or its default taken: the matter kept, the outcome said, no buttons. */
export function answeredPayload(rec: Pick<AskRec, 'note' | 'view' | 'answer'> & { card?: AskCard | undefined }, bot?: string): DiscordPayload & { components: [] } {
  return outcomePayload({ note: rec.note, view: rec.view, card: rec.card, answer: rec.answer, bot });
}

/** What the bot reads of an INTERACTION_CREATE. */
interface Interaction {
  id?: unknown;
  token?: unknown;
  type?: unknown;
  application_id?: unknown;
  guild_id?: unknown;
  channel_id?: unknown;
  channel?: { id?: unknown };
  data?: { custom_id?: unknown; name?: unknown; options?: unknown };
  member?: { user?: { id?: unknown } };
  user?: { id?: unknown };
  message?: { id?: unknown; content?: unknown };
}

interface Follow {
  /** Track D2: the Discord command whose lines these are. */
  scope: CommandScope;
  /** Track D3: the channel (a text command) or the interaction (a slash command). */
  to: ReplyTo;
  until: number;
  lines: string[];
  left: number;
  text: string;
  said: boolean;
  timer?: NodeJS.Timeout | undefined;
}

export class DiscordBot {
  private readonly d: DiscordBotDeps;
  private readonly rest: DiscordRest;
  private readonly gw: DiscordGateway;
  /** This run's tag in every button id: a button from before a restart answers nothing. */
  readonly run = randomBytes(4).toString('hex');
  private readonly limiter = new UserLimiter();
  private readonly ignored = new IgnoreCounts();
  /** The Discord command being run now and what it said during the call (only lines in its scope). */
  private capturing: { scope: CommandScope; lines: string[] } | undefined;
  /** Track D2: per Discord command (its scope's id), the lines it says after its call, for FOLLOW_MS. */
  private readonly follows = new Map<number, Follow>();
  private readonly asks = new Map<number, AskRec>();
  private pressing: string | undefined;
  /** Track D2: the Discord user whose press is being run (the answered message names them). */
  private presser: string | undefined;
  private readonly dms = new Map<string, string>();
  private readonly notes: { payload: DiscordPayload; rec?: AskRec }[] = [];
  private notesBusy = false;
  private readonly offs: (() => void)[] = [];
  private countTimer: NodeJS.Timeout | undefined;
  private lastWaitLog = -Infinity;
  private lastFailLog = -Infinity;
  private lastFail: string | undefined;
  private token: string | undefined;
  private started = false;
  /** Track D3: the slash commands' registration (its hashes in the config directory). */
  readonly slash: SlashRegistry;
  private syncing: Promise<unknown> = Promise.resolve();
  readonly stats = { run: 0, refused: 0, limited: 0, presses: 0, sent: 0, failed: 0, notes: 0, dropped: 0, slash: 0, autocomplete: 0 };

  constructor(d: DiscordBotDeps) {
    this.d = d;
    this.rest = new DiscordRest({ token: () => this.tokenState(), origin: d.origin, ...(d.fetch ? { fetch: d.fetch } : {}), ...(d.now ? { now: d.now } : {}), log: d.log });
    this.slash = new SlashRegistry({ file: d.stateDir ? join(d.stateDir, COMMANDS_FILE) : undefined, call: (m, p, b) => this.rest.call(m, p, b), log: d.log, ...(d.now ? { now: d.now } : {}) });
    const origin = d.origin;
    this.gw = new DiscordGateway({
      token: () => {
        const t = this.tokenState();
        return t.state === 'set' ? t.token : undefined;
      },
      url: async () => {
        const r = await this.rest.call('GET', '/gateway/bot');
        if (!r.ok && r.status === 401) this.gw.stop('the token was refused (401): make a new one in the developer portal'); // no loop on a dead token
        const url = r.ok ? (r.body as { url?: unknown } | undefined)?.url : undefined;
        return typeof url === 'string' ? url : undefined;
      },
      allowUrl: origin ? (u) => loopbackGatewayUrl(u, origin) : discordGatewayUrl,
      intents: () => this.intents(), // Track D3: none with text commands off
      onDispatch: (t, data) => this.onDispatch(t, data),
      onState: (s) => this.onState(s),
      ...(d.ws ? { ws: d.ws } : {}),
      log: d.log,
      ...(d.now ? { now: d.now } : {}),
      ...(d.random ? { random: d.random } : {}),
      ...(d.backoffBaseMs !== undefined ? { backoffBaseMs: d.backoffBaseMs } : {}),
    });
    // every reply goes through say(): capture the ones a Discord command makes, follow the later ones
    const orig = d.chat.say.bind(d.chat);
    d.chat.say = (message: string): boolean => {
      const sent = orig(message);
      try {
        this.onSay(message);
      } catch {
        // never break the game chat
      }
      return sent;
    };
    d.chat.register({
      name: 'discord',
      help: '[status|test|setup|commands [sync|remove]] (the Discord bot: connected or not, who may command it (counts only), messages in and out; test sends one note; setup checks each set-up step and says what is missing; commands: the slash commands)',
      tier: 'more',
      group: 'info',
      example: '!discord setup',
      run: ({ reply, args }) => {
        const sub = (args[0] ?? 'status').toLowerCase();
        this.reload();
        if (sub === 'status') {
          for (const l of this.statusLines()) reply(l);
          return;
        }
        if (sub === 'setup' || sub === 'check') {
          reply('discord setup: checking (the switch, the token, the gateway, the servers, the users, the channels, the notes, the slash commands) ...');
          void this.setup().then(
            (ls) => ls.forEach((l) => reply(l)),
            () => reply('discord setup: the check failed'),
          );
          return;
        }
        if (sub === 'commands') {
          this.commandsCmd((args[1] ?? 'status').toLowerCase(), reply);
          return;
        }
        if (sub !== 'test') {
          reply('usage: !discord [status|test|setup|commands [sync|remove]]');
          return;
        }
        void this.test({ title: 'test notification', body: 'nothing to do', ts: this.now(), kind: 'notify.test' }).then(
          (l) => reply(l),
          () => reply('discord bot: the test failed'),
        );
      },
    });
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private tokenState(): TokenState {
    try {
      return this.d.tokens.get();
    } catch {
      return { state: 'unset' };
    }
  }

  private setting(key: 'discordBot' | 'discordUsers' | 'discordChannels' | 'discordNotes' | 'discordText'): unknown {
    try {
      return this.d.settings?.get(key);
    } catch {
      return undefined;
    }
  }

  private on(): boolean {
    return this.setting('discordBot') === true && !this.d.blocked;
  }

  /** Track D3: text commands (`discordText`, on unless set off: an older settings source has no key). */
  private textOn(): boolean {
    return this.setting('discordText') !== false;
  }

  /** Track D3: the intents IDENTIFY asks for: the messages and their content with text commands, else none. */
  private intents(): number {
    return this.textOn() ? DISCORD_INTENTS : SLASH_ONLY_INTENTS;
  }

  private text(key: 'discordUsers' | 'discordChannels' | 'discordNotes', fallback: string): string {
    const v = this.setting(key);
    return typeof v === 'string' ? v : fallback;
  }

  private users(): Set<string> {
    return idSet(this.text('discordUsers', 'none'));
  }

  private channels(): Set<string> {
    return idSet(this.text('discordChannels', 'none'));
  }

  private notesTo(): string {
    return this.text('discordNotes', 'dm');
  }

  private scrub(s: string): string {
    return scrubToken(s, this.token);
  }

  /** Connect while on and a token is set; follow `discordBot`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const off = this.d.settings?.onChange((key) => {
      if (key === 'discordBot') this.apply();
      // Track D3: other intents need a new session (IDENTIFY); a new channel may be in a new server for the commands
      const gs = this.gw.status();
      if (key === 'discordText' && gs.state !== 'off' && (gs.state === 'stopped' || gs.intents !== this.intents())) {
        outsideScope(() => this.gw.stop());
        this.apply();
      }
      if (key === 'discordChannels' && this.gw.status().state === 'ready') void this.syncSlash();
    });
    if (off) this.offs.push(off);
    try {
      this.offs.push((this.d.bus ?? globalBus).subscribe((e) => this.onEvent(e)));
    } catch {
      // no bus: no edits of answered questions
    }
    settingNotes.set('discordBot', () => this.settingNote());
    this.countTimer = setInterval(() => {
      const l = this.ignored.drain();
      if (l) this.d.log.info(`discord bot: ${l} in the last ${COUNT_LOG_MS / 60_000} min (docs/discord.md "Security model")`);
    }, COUNT_LOG_MS);
    this.countTimer.unref?.();
    this.apply();
  }

  /** Read the token again (the env, else the file) and connect, reconnect or close to match. */
  reload(): void {
    try {
      this.d.tokens.reload();
    } catch {
      // the old value stays
    }
    this.apply();
  }

  /**
   * Connected exactly while on with a token. A new token (the file or the env changed) starts again; a gateway stopped
   * for good (a refused token, a missing intent, too many sessions) stays stopped until the token or `discordBot`
   * changes, so a status command never starts a loop.
   */
  private apply(): void {
    // Track D2: the gateway's socket and timers belong to no command (a `!set discordBot on` typed somewhere would
    // otherwise lend its scope to everything the gateway runs later)
    outsideScope(() => this.applyNow());
  }

  private applyNow(): void {
    const t = this.tokenState();
    const tok = t.state === 'set' ? t.token : undefined;
    const changed = tok !== this.token;
    this.token = tok;
    if (!this.started) return;
    if (!this.on() || !tok) {
      if (this.gw.status().state !== 'off') this.gw.stop();
      return;
    }
    if (changed && this.gw.status().state !== 'off') this.gw.stop();
    if (this.gw.status().state === 'off') this.gw.start();
  }

  stop(): void {
    this.started = false;
    for (const o of this.offs.splice(0)) o();
    settingNotes.delete('discordBot');
    clearInterval(this.countTimer);
    for (const f of this.follows.values()) clearTimeout(f.timer);
    this.follows.clear();
    this.gw.stop();
    this.rest.stop();
  }

  private onState(s: GatewayState): void {
    const g = this.gw.status();
    if (s === 'ready') this.d.log.info(`discord bot: gateway ready (${g.sessions} session${g.sessions === 1 ? '' : 's'}, ${g.resumes} resumed)`);
    else if (s === 'stopped' && g.why) this.d.log.warn(this.scrub(`discord bot: stopped: ${g.why}`));
    else if (s === 'waiting' && this.now() - this.lastWaitLog >= COUNT_LOG_MS) {
      this.lastWaitLog = this.now();
      this.d.log.info(this.scrub(`discord bot: gateway lost (${g.lastClose ?? 'no answer'}): reconnecting`));
    }
  }

  // ---- in: messages and presses --------------------------------------------------------------------------------------

  private onDispatch(t: string, data: unknown): void {
    if (t === 'MESSAGE_CREATE') this.onMessage(data);
    else if (t === 'INTERACTION_CREATE') this.onInteraction(data);
    else if (t === 'READY') void this.syncSlash(); // Track D3: a new session (a resume keeps what was registered)
  }

  /**
   * Track D3: the slash commands where they are wanted: for direct messages (global) and in the server of each listed
   * channel (GET /channels/<id> names it); a PUT only for a scope whose hash changed. One sync at a time, outside every
   * command's scope. `force` registers again even when nothing changed (`!discord commands sync`).
   */
  syncSlash(force = false): Promise<unknown> {
    this.syncing = this.syncing.then(() =>
      outsideScope(async () => {
        try {
          const app = this.appId();
          if (!app || !this.on()) return;
          const guilds = new Set<string>();
          for (const ch of this.channels()) {
            const r = await this.rest.call('GET', `/channels/${ch}`);
            const g = r.ok ? (r.body as { guild_id?: unknown } | undefined)?.guild_id : undefined;
            if (typeof g === 'string') guilds.add(g);
          }
          const st = await this.slash.sync(app, [...guilds], force);
          const done = st.filter((s) => s.how === 'registered' || s.state === 'removed').length;
          const failed = st.filter((s) => s.state === 'failed');
          if (done) this.d.log.info(`discord bot: slash commands ${slashText(st)}`);
          if (failed.length) this.d.log.warn(this.scrub(`discord bot: slash commands: ${slashText(st)} (!discord setup says what to do)`));
        } catch (e) {
          this.d.log.warn(this.scrub(`discord bot: slash commands not registered: ${e instanceof Error ? e.message : String(e)}`));
        }
      }),
    );
    return this.syncing;
  }

  /** The application's id: READY's, else the token's first part. */
  private appId(): string | undefined {
    const t = this.tokenState();
    return this.gw.status().app ?? appIdFromToken(t.state === 'set' ? t.token : undefined);
  }

  private onMessage(data: unknown): void {
    if (!this.on() || !this.textOn()) return; // Track D3: discordText off: no text command at all
    const m = (data ?? {}) as { id?: unknown; channel_id?: unknown; guild_id?: unknown; author?: { id?: unknown; bot?: unknown; system?: unknown }; webhook_id?: unknown; type?: unknown; content?: unknown };
    const channel = typeof m.channel_id === 'string' ? m.channel_id : '';
    const author = typeof m.author?.id === 'string' ? m.author.id : '';
    const v = gate(
      { channelId: channel, guildId: typeof m.guild_id === 'string' ? m.guild_id : undefined, authorId: author, authorBot: m.author?.bot === true || m.author?.system === true, webhookId: typeof m.webhook_id === 'string' ? m.webhook_id : undefined, type: typeof m.type === 'number' ? m.type : 0, content: typeof m.content === 'string' ? m.content : '' },
      { users: this.users(), channels: this.channels(), self: this.gw.status().self ?? undefined, prefix: this.d.chat.prefix },
    );
    if (!v.run) {
      if (v.why !== 'self') this.ignored.add(v.why);
      return;
    }
    const where: ReplyTo = { kind: 'channel', channel, ref: typeof m.id === 'string' ? m.id : '' };
    const lim = this.limiter.take(author, this.now());
    if (lim !== 'ok') {
      this.stats.limited++;
      if (lim === 'over') this.replyTo(where, [`slow down: at most ${USER_RATE.max} commands in ${USER_RATE.windowMs / 1000} s from one user; the rest of this window is ignored`]);
      return;
    }
    const cmd = parseCommand(v.text, this.d.chat.prefix);
    if (!cmd) {
      this.ignored.add('not a command');
      return;
    }
    const why = refusal(cmd.name, cmd.args);
    if (why) {
      this.stats.refused++;
      this.d.log.info(`discord: ${this.d.chat.prefix}${cmd.name} refused (from ${author}): ${why}`);
      this.replyTo(where, [`${this.d.chat.prefix}${cmd.name} is not taken from Discord: ${why}`]);
      return;
    }
    const run = this.runLine(v.text, author, 'text');
    if (run === undefined) {
      this.replyTo(where, ['no owner to run commands as (owners empty and consoleOwner off)']);
      return;
    }
    this.follow(run, where, v.text, 0);
  }

  /**
   * Track D2: this command's later lines (said in its scope) follow; every other command's follow goes on by itself.
   * `answered`: messages of the reply already sent (a slash command's immediate answer); none: the reply now.
   */
  private follow(run: { scope: CommandScope; lines: string[] }, to: ReplyTo, text: string, answered: number): void {
    const { scope, lines } = run;
    const f: Follow = { scope, to, until: this.now() + FOLLOW_MS, lines: [], left: FOLLOW_MESSAGES, text, said: lines.length > 0 };
    this.follows.set(scope.id, f);
    while (this.follows.size > FOLLOWS_MAX) this.endFollow(this.follows.values().next().value!);
    if (lines.length) {
      const msgs = replyMessages(lines);
      for (const c of msgs.slice(answered)) this.sendTo(to, c);
    } else this.flushSoon(f, FIRST_WAIT_MS);
  }

  /**
   * One line through Chat.handle as the first owner, marked discord, in a command scope of its own (chat/scope.ts);
   * the scope and the replies said in it during the call.
   */
  private runLine(text: string, from: string, how: 'text' | 'press' | 'slash'): { scope: CommandScope; lines: string[] } | undefined {
    const line = panelLine(this.d.chat.owners, text);
    if (!line) return undefined;
    const as = line.type === 'announcement' ? 'console' : line.source;
    this.d.log.info(`discord: ${text} (${how === 'press' ? 'a button, ' : how === 'slash' ? 'a slash command, ' : ''}as ${as}, from ${from})`);
    this.stats.run++;
    const prev = this.capturing;
    const cap = { scope: newScope('discord', text, this.now()), lines: [] as string[] };
    this.capturing = cap;
    try {
      viaDiscord(() => this.d.chat.handle(line, true, cap.scope));
    } catch (e) {
      this.d.log.warn(`discord: ${text} failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    } finally {
      this.capturing = prev;
    }
    return cap;
  }

  /**
   * Track D2: a line the bot says is a Discord command's only when it is said in that command's scope (during its call,
   * in what its promises and timers run, in the user processes it added). Any other line (another command's, typed in
   * the game or the panel; a chore's; a reflex's) never reaches Discord this way: the notes go through the limiter.
   */
  private onSay(m: string): void {
    const s = currentScope();
    if (!s) return;
    if (this.capturing?.scope === s) {
      if (this.capturing.lines.length < 200) this.capturing.lines.push(m);
      return;
    }
    const f = this.follows.get(s.id);
    if (f?.scope !== s) return;
    if (this.now() > f.until || f.left <= 0) {
      this.endFollow(f);
      return;
    }
    if (f.lines.length < 200) f.lines.push(m);
    this.flushSoon(f, FOLLOW_BATCH_MS);
  }

  private endFollow(f: Follow): void {
    clearTimeout(f.timer);
    f.timer = undefined;
    if (this.follows.get(f.scope.id) === f) this.follows.delete(f.scope.id);
  }

  private flushSoon(f: Follow, ms: number): void {
    if (f.timer) return;
    // the timer belongs to no command: what the flush posts is not a line of the bot's
    f.timer = outsideScope(() =>
      setTimeout(() => {
        f.timer = undefined;
        this.flush(f);
      }, ms),
    );
    f.timer.unref?.();
  }

  private flush(f: Follow): void {
    if (this.follows.get(f.scope.id) !== f) return;
    const lines = f.lines.splice(0);
    if (!lines.length) {
      if (!f.said) {
        f.said = true;
        this.replyTo(f.to, [`${f.text}: no reply yet (what it says in the next ${durationText(FOLLOW_MS / 1000)} follows here)`]);
      }
      return;
    }
    const msgs = replyMessages(lines, Math.max(1, f.left));
    f.left -= msgs.length;
    f.said = true;
    for (const c of msgs) this.sendTo(f.to, c);
    if (f.left <= 0) this.endFollow(f);
  }

  private replyTo(to: ReplyTo, lines: readonly string[]): void {
    for (const c of replyMessages(lines)) this.sendTo(to, c);
  }

  /**
   * One reply message. To a channel: the first a reply to the user's message. To a slash command (Track D3): after the
   * interaction's answer, the first into the deferred answer itself (PATCH @original), the rest as follow-ups; in order.
   * Both carry no pings. A follow-up needs no bot token: the interaction's own token (15 minutes) is in its path.
   */
  private sendTo(to: ReplyTo, content: string): void {
    if (to.kind === 'channel') {
      const ref = to.ref;
      to.ref = '';
      void this.post(to.channel, { content, allowed_mentions: NO_MENTIONS, ...(ref ? { message_reference: { message_id: ref, fail_if_not_exists: false } } : {}) });
      return;
    }
    const original = to.original;
    to.original = false;
    const base = `/webhooks/${to.app}/${to.token}`;
    to.ack = to.ack.then(() =>
      this.rest
        .call(original ? 'PATCH' : 'POST', original ? `${base}/messages/@original` : base, { content, allowed_mentions: NO_MENTIONS }, { noAuth: true })
        .then((r) => this.count(r, original ? 'the reply to a slash command' : 'a follow-up of a slash command')),
    );
  }

  private async post(channel: string, body: Record<string, unknown>): Promise<string | undefined> {
    if (!channel) return undefined;
    const r = await this.rest.call('POST', `/channels/${channel}/messages`, body);
    return this.count(r, `a message to channel ...${channel.slice(-4)}`) ? ((r as { body: { id?: unknown } }).body?.id as string | undefined) : undefined;
  }

  private count(r: RestResult, what: string): boolean {
    if (r.ok) {
      this.stats.sent++;
      return true;
    }
    this.stats.failed++;
    this.lastFail = this.scrub(`${what}: ${r.status ?? 'no answer'} ${r.why}`);
    if (this.now() - this.lastFailLog >= FAIL_LOG_MS) {
      this.lastFailLog = this.now();
      this.d.log.warn(`discord bot: ${this.lastFail} (failures are logged at most once a minute)`);
    }
    return false;
  }

  private onInteraction(data: unknown): void {
    const i = (data ?? {}) as Interaction;
    if (typeof i.id !== 'string' || typeof i.token !== 'string') return;
    const path = `/interactions/${i.id}/${i.token}/callback`;
    const what = i.type === INTERACTION.command ? 'the answer to a slash command' : i.type === INTERACTION.autocomplete ? 'an autocomplete' : 'the answer to a press';
    const respond = (body: Record<string, unknown>): Promise<unknown> => this.rest.call('POST', path, body, { noAuth: true, callback: true }).then((r) => this.count(r, what));
    const answer = (type: number, body: Record<string, unknown>): Promise<unknown> => respond({ type, data: { allowed_mentions: NO_MENTIONS, ...body } });
    const quiet = (text: string): Promise<unknown> => answer(CALLBACK.message, { content: cutText(text, 2000), flags: EPHEMERAL });
    const user = typeof i.member?.user?.id === 'string' ? i.member.user.id : typeof i.user?.id === 'string' ? i.user.id : '';
    if (i.type === INTERACTION.autocomplete) return this.onAutocomplete(i, user, respond);
    if (i.type === INTERACTION.command) return this.onSlash(i, user, answer, respond, quiet);
    if (i.type !== INTERACTION.component) return; // a button press
    if (!this.on() || !user || !this.users().has(user)) {
      this.stats.refused++;
      this.ignored.add('press');
      void quiet('Only the users this bot was told to take commands from may answer.');
      return;
    }
    const b = parseButtonId(i.data?.custom_id);
    if (!b) {
      void quiet('Not a button this bot knows.');
      return;
    }
    if (b.run !== this.run) {
      const content = typeof i.message?.content === 'string' ? i.message.content : '';
      void answer(CALLBACK.update, { content: cutText(`${content} (closed: the bot started again since this question)`, 2000), components: [] });
      return;
    }
    const lim = this.limiter.take(user, this.now());
    if (lim !== 'ok') {
      this.stats.limited++;
      void quiet(`Slow down: at most ${USER_RATE.max} commands in ${USER_RATE.windowMs / 1000} s.`);
      return;
    }
    this.stats.presses++;
    this.pressing = typeof i.message?.id === 'string' ? i.message.id : undefined;
    this.presser = user;
    let lines: string[] | undefined;
    try {
      lines = this.runLine(`${this.d.chat.prefix}answer ${b.ask} ${b.choice}`, user, 'press')?.lines;
    } finally {
      this.pressing = undefined;
      this.presser = undefined;
    }
    const rec = this.asks.get(b.ask);
    if (lines?.some((l) => l.includes('answered: ')) && rec?.answer) void answer(CALLBACK.update, answeredPayload(rec, this.botName()) as unknown as Record<string, unknown>);
    else void quiet(lines?.length ? replyMessages(lines, 1)[0] ?? 'no reply' : 'no owner to run commands as');
  }

  /** Track D3: who and where an interaction comes from. */
  private who(i: Interaction, user: string): { userId: string; guildId: string | undefined; channelId: string } {
    const channel = typeof i.channel_id === 'string' ? i.channel_id : typeof i.channel?.id === 'string' ? i.channel.id : '';
    return { userId: user, guildId: typeof i.guild_id === 'string' ? i.guild_id : undefined, channelId: channel };
  }

  /**
   * Track D3: a slash command, through the text commands' door: the user and the channel (interactionGate), the line it
   * stands for (slashLine), its length, the per-user limit, the refusals; then Chat.handle as the first owner in a scope
   * of its own. Answered within the 3 s: with the reply when the command said something during its call, else deferred
   * ("thinking") and the reply edited in. A stranger, another channel, a refusal and the limit: an answer only that user
   * sees, nothing run.
   */
  private onSlash(i: Interaction, user: string, answer: (type: number, body: Record<string, unknown>) => Promise<unknown>, respond: (body: Record<string, unknown>) => Promise<unknown>, quiet: (text: string) => Promise<unknown>): void {
    const p = this.d.chat.prefix;
    if (!this.on()) {
      void quiet('The bot does not take commands from Discord now (discordBot off).');
      return;
    }
    const g = interactionGate(this.who(i, user), { users: this.users(), channels: this.channels() });
    if (!g.run) {
      this.stats.refused++;
      this.ignored.add(g.why);
      void quiet(INTERACTION_REFUSAL[g.why]);
      return;
    }
    const text = slashLine(i.data, p);
    if (!text) {
      void quiet('Not a command this bot registers (an old one: !discord commands sync registers the current ones).');
      return;
    }
    if (text.length > COMMAND_MAX) {
      this.ignored.add('too long');
      void quiet(`Too long: at most ${COMMAND_MAX} characters.`);
      return;
    }
    const lim = this.limiter.take(user, this.now());
    if (lim !== 'ok') {
      this.stats.limited++;
      void quiet(`Slow down: at most ${USER_RATE.max} commands in ${USER_RATE.windowMs / 1000} s from one user.`);
      return;
    }
    const cmd = parseCommand(text, p);
    if (!cmd) {
      void quiet(`${text}: not a command line (it starts with a command's name, e.g. goto home)`);
      return;
    }
    const why = refusal(cmd.name, cmd.args);
    if (why) {
      this.stats.refused++;
      this.d.log.info(`discord: ${p}${cmd.name} refused (a slash command, from ${user}): ${why}`);
      void quiet(`${p}${cmd.name} is not taken from Discord: ${why}`);
      return;
    }
    this.stats.slash++;
    const app = typeof i.application_id === 'string' ? i.application_id : (this.appId() ?? '');
    const run = this.runLine(text, user, 'slash');
    if (!run) {
      void quiet('no owner to run commands as (owners empty and consoleOwner off)');
      return;
    }
    const first = run.lines.length ? replyMessages(run.lines)[0] : undefined;
    const ack = first !== undefined ? answer(CALLBACK.message, { content: first }) : respond({ type: SLASH_CALLBACK.deferred });
    this.follow(run, { kind: 'slash', app, token: String(i.token), ack, original: first === undefined }, text, first !== undefined ? 1 : 0);
  }

  /** Track D3: autocomplete: the bot's commands and waypoints to an allowed user in an allowed place, nothing to anyone else. */
  private onAutocomplete(i: Interaction, user: string, respond: (body: Record<string, unknown>) => Promise<unknown>): void {
    this.stats.autocomplete++;
    const g = interactionGate(this.who(i, user), { users: this.users(), channels: this.channels() });
    let choices: { name: string; value: string }[] = [];
    if (this.on() && g.run) {
      try {
        choices = autocomplete({ data: i.data, commands: this.d.chat.commandInfo?.() ?? [], waypoints: this.d.waypoints?.() ?? [], prefix: this.d.chat.prefix });
      } catch {
        choices = [];
      }
    }
    void respond({ type: SLASH_CALLBACK.autocomplete, data: { choices } });
  }

  /** A question's end (the bus's ask.answered): its messages are edited to say so, the buttons gone. */
  private onEvent(e: BotEvent): void {
    if (e.kind !== 'ask.answered') return;
    const a = e.data as AskOutcome & { id: number };
    const rec = this.asks.get(a.id);
    if (!rec || rec.answer) return;
    // a press answers synchronously inside its own run: the presser is the one named (a mention: Discord shows the name)
    rec.answer = { choice: a.choice, how: a.how, by: a.by, afterS: a.afterS, ...(a.how === 'discord' && this.presser ? { user: this.presser } : {}) };
    for (const p of rec.posts) if (p.message !== this.pressing) this.edit(rec, p);
  }

  private edit(rec: AskRec, p: { channel: string; message: string }): void {
    void this.rest.call('PATCH', `/channels/${p.channel}/messages/${p.message}`, answeredPayload(rec, this.botName())).then((r) => this.count(r, 'the edit of a question'));
  }

  private botName(): string | undefined {
    try {
      const b = this.d.bot?.();
      return b === '' ? undefined : b;
    } catch {
      return undefined;
    }
  }

  // ---- out: the notes (away mode's NoteSink) ------------------------------------------------------------------------

  /** Notes would be sent now: on, a token, somewhere to send them. */
  active(): boolean {
    const to = this.notesTo();
    return this.on() && this.tokenState().state === 'set' && to !== 'none' && (to !== 'dm' || this.users().size > 0);
  }

  /** A note the limiter let through; a question with its choices as buttons. Never throws. */
  send(note: Note, ask?: AskView, card?: AskCard): void {
    try {
      if (!this.active()) return;
      const payload: DiscordPayload & { components?: unknown } = payloadFor(note, { ...(this.botName() ? { bot: this.botName()! } : {}), ...(ask ? { ask, buttons: true } : {}), ...(card ? { card } : {}), now: this.now() });
      let rec: AskRec | undefined;
      if (ask && note.ask !== null) {
        payload.components = askButtons(this.run, ask, card);
        rec = { id: ask.id, note, view: ask, card, posts: [] };
        this.asks.set(ask.id, rec);
        while (this.asks.size > ASK_KEEP) this.asks.delete(this.asks.keys().next().value!);
      }
      this.notes.push({ payload, ...(rec ? { rec } : {}) });
      while (this.notes.length > NOTES_QUEUE_MAX) {
        this.notes.shift();
        this.stats.dropped++;
      }
      void this.pumpNotes();
    } catch (e) {
      this.d.log.warn(this.scrub(`discord bot: a note failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  private async pumpNotes(): Promise<void> {
    if (this.notesBusy) return;
    this.notesBusy = true;
    try {
      while (this.notes.length) {
        const n = this.notes.shift()!;
        for (const ch of await this.targets()) {
          const id = await this.post(ch, n.payload as unknown as Record<string, unknown>);
          if (!id || !n.rec) continue;
          const p = { channel: ch, message: id };
          n.rec.posts.push(p);
          if (n.rec.answer) this.edit(n.rec, p); // answered before the message was out
        }
        this.stats.notes++;
      }
    } catch {
      // the next note tries again
    } finally {
      this.notesBusy = false;
    }
  }

  /** The channels notes go to: the notes channel, or a DM channel per allowed user (opened once). */
  private async targets(): Promise<string[]> {
    const to = this.notesTo();
    if (to === 'none') return [];
    if (to !== 'dm') return [to];
    const out: string[] = [];
    for (const u of this.users()) {
      let ch = this.dms.get(u);
      if (!ch) {
        const r = await this.rest.call('POST', '/users/@me/channels', { recipient_id: u });
        const id = r.ok ? (r.body as { id?: unknown } | undefined)?.id : undefined;
        if (typeof id !== 'string') {
          this.count(r, `the DM to user ...${u.slice(-4)}`);
          continue;
        }
        ch = id;
        this.dms.set(u, ch);
      }
      out.push(ch);
    }
    return out;
  }

  /** `!discord test` and `!notify test`: one note now to where notes go; the outcome as a line. */
  async test(note: Pick<Note, 'title' | 'body' | 'ts' | 'kind'>): Promise<string> {
    const t = this.tokenState();
    if (this.d.blocked) return `discord bot: ${this.d.blocked}`;
    if (t.state !== 'set') return `discord bot: token ${tokenText(t)} (docs/discord.md)`;
    if (!this.on()) return 'discord bot: off (!set discordBot on)';
    const to = this.notesTo();
    if (to === 'none') return 'discord bot: notes go nowhere (discordNotes none)';
    if (to === 'dm' && this.users().size === 0) return 'discord bot: no user to send a DM to (discordUsers none)';
    const payload = { ...payloadFor({ ...note, ask: null, n: 1 }, { ...(this.botName() ? { bot: this.botName()! } : {}), test: true }), allowed_mentions: NO_MENTIONS };
    const before = this.stats.failed;
    const chs = await this.targets();
    let ok = 0;
    for (const ch of chs) if (await this.post(ch, payload)) ok++;
    const where = to === 'dm' ? `${ok} of ${this.users().size} DM${this.users().size === 1 ? '' : 's'}` : `${ok} of 1 channel (${notesText(to)})`;
    return this.scrub(ok > 0 && this.stats.failed === before ? `discord bot: test sent to ${where}` : `discord bot: test sent to ${where}; ${this.stats.failed - before} failed (the log says why)`);
  }

  /** One line for `!notify` and /api/away. */
  statusLine(): string {
    const g = this.gw.status();
    return `discord bot: ${this.on() ? 'on' : 'off'}, gateway ${g.state}, notes ${notesText(this.notesTo())}; ${this.stats.notes} notes, ${this.stats.sent} sent, ${this.stats.failed} failed, ${this.stats.dropped} dropped`;
  }

  /** `!discord`: the state, the lists' sizes (never the ids' whole digits), the counts. */
  statusLines(): string[] {
    const g = this.gw.status();
    const t = this.tokenState();
    const state = g.state === 'ready' ? `ready for ${durationText((this.now() - g.since) / 1000)}` : g.state === 'stopped' && g.why ? `stopped: ${g.why}` : g.state;
    const link = `${g.sessions} session${g.sessions === 1 ? '' : 's'}, ${g.resumes} resumed, ${g.reconnects} reconnects${g.latencyMs !== null ? `, heartbeat ${g.latencyMs} ms` : ''}${g.lastClose && g.state !== 'ready' ? `, last: ${g.lastClose}` : ''}`;
    const head = `discord bot: ${this.on() ? 'on' : this.d.blocked ? `off (${this.d.blocked})` : 'off (!set discordBot on)'}, token ${tokenText(t)}; gateway ${state} (${link})`;
    const users = this.users().size;
    const chans = this.channels().size;
    const lists = `discord bot: ${users} user${users === 1 ? '' : 's'}${users === 0 ? ' (nobody may command it: !set discordUsers <your Discord user id>)' : ''}, ${chans} channel${chans === 1 ? '' : 's'}, notes ${notesText(this.notesTo())}; in: ${this.stats.run} run, ${this.stats.presses} presses, ${this.stats.refused} refused, ${this.stats.limited} rate-limited, ${this.ignored.total} ignored; out: ${this.stats.sent} sent, ${this.stats.failed} failed${this.lastFail ? ` (last: ${this.lastFail})` : ''}, ${this.rest.waiting()} waiting`;
    const slash = `discord bot: text commands ${this.textOn() ? 'on' : 'off (slash commands only, no intent asked for)'}; slash commands ${slashText(this.slash.status())}; ${this.stats.slash} run, ${this.stats.autocomplete} autocompletes`;
    return [this.scrub(head), this.scrub(lists), this.scrub(slash)];
  }

  /** Track D3: `!discord setup`: every set-up step with its state and fix (discord-setup.ts), the invite link last. */
  async setup(): Promise<string[]> {
    const t = this.tokenState();
    const r = await setupCheck({
      on: this.on(),
      blocked: this.d.blocked,
      token: t,
      text: this.textOn(),
      gateway: this.gw.status(),
      restStopped: this.rest.stopped(),
      users: [...this.users()],
      channels: [...this.channels()],
      notes: this.notesTo(),
      slash: this.slash.status(),
      ...(t.state === 'set' && !this.d.blocked ? { call: (m: string, p: string) => this.rest.call(m, p) } : {}),
    });
    return setupLines(r).map((l) => this.scrub(l));
  }

  /** Track D3: `!discord commands [status|sync|remove]`. */
  private commandsCmd(sub: string, reply: (l: string) => void): void {
    const app = this.appId();
    if (sub === 'status') {
      reply(`discord bot: slash commands ${slashText(this.slash.status())}${this.slash.known().length ? `; registered before: ${this.slash.known().length} scope${this.slash.known().length === 1 ? '' : 's'}` : ''}`);
      return;
    }
    if (sub !== 'sync' && sub !== 'remove') {
      reply('usage: !discord commands [status|sync|remove]');
      return;
    }
    if (!app || this.tokenState().state !== 'set') {
      reply('discord bot: the application id is not known yet (a token, then the gateway: !discord setup)');
      return;
    }
    const done = sub === 'sync' ? this.syncSlash(true).then(() => this.slash.status()) : outsideScope(() => this.slash.remove(app));
    void done.then(
      (st) => reply(`discord bot: slash commands ${sub === 'sync' ? slashText(st) : `removed from ${st.filter((s) => s.state === 'removed').length} of ${st.length} scope${st.length === 1 ? '' : 's'}`}`),
      () => reply('discord bot: the slash commands call failed'),
    );
  }

  /** The second line of `!set discordBot [on|off]`. */
  private settingNote(): string | undefined {
    this.reload();
    const t = this.tokenState();
    if (this.setting('discordBot') !== true) return undefined;
    if (this.d.blocked) return `discordBot: ${this.d.blocked}`;
    if (t.state === 'unset') return 'discordBot: no token is set, so nothing connects: put it in env BEDROCKBOT_DISCORD_TOKEN or discord-bot.token in the config directory, never in chat (docs/discord.md)';
    if (t.state === 'refused') return `discordBot: the token is ${tokenText(t)}, so nothing connects (docs/discord.md)`;
    const users = this.text('discordUsers', 'none');
    return `discordBot: token ${tokenText(t)}; connecting (!discord says when it is ready); users ${idsText(users)}${idSet(users).size === 0 ? ': nobody may command it yet (!set discordUsers <your Discord user id>)' : ''}`;
  }
}
