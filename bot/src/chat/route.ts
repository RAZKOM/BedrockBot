// How a reply reaches the players: as player chat (`text` packet, the default) or as a slash command sent
// as the bot (`chatVia me | say | tellraw`). Guide: docs/chat-style.md "Routes". Decision:
// docs/decisions/0050-chat-style.md.
//
// The four looks, measured on BDS 1.26.60.6 (bot/test/e2e/chat-style.test.ts keeps every line honest):
//
//   chat      `<Bot> text`    player chat; no permission needed; the owner's client masks digits in it (####, 2026-10-29)
//   me        `* Bot text`    /me; NO operator rights needed; arrives as chat; section-sign colour codes and newlines relayed
//   say       `[Bot] text`    /say; operator only (non-operator: commands.generic.error.permissions); arrives as announcement
//   tellraw   `text`          /tellraw @a {"rawtext":[...]}; operator only (commands.generic.permission.selector);
//                             arrives as json_whisper, no prefix at all; success is silent (no command_output)
//
// Two limits shape the code:
//   - a command of 505 bytes works, 511 makes the server DROP THE CONNECTION (chat only drops the message), and
//     the server counts UTF-8 bytes (a section sign is 2): SLASH_MAX, measured with wireSize, and a command over
//     it is never sent (that reply goes out as chat);
//   - the server expands selectors in /me and /say (`@a` becomes the player names for an operator, and makes a
//     non-operator's command fail): a reply with an `@` in it never goes out through those two.
//
// So a slash route is opt-in (the `chatVia` setting) with a safety net: a refused or failed command is resent as
// ordinary chat at once, and the route is not tried again by itself for RETRY_MS. Switching the setting, a
// restart and `!colors` try at once, and when that try is refused the owner is told in chat
// (Chat.onCommandOutput).
import { randomUUID } from 'node:crypto';
import { wireSize } from './style.ts';

/**
 * Longest slash command we ever send, in UTF-8 bytes (wireSize: a colour code's section sign is 2 bytes, and the server
 * counts bytes). Measured on BDS 1.26.60.6: 505 bytes delivered, 511 DROPPED THE CONNECTION, with ASCII and with section
 * signs alike.
 */
export const SLASH_MAX = 480;

/**
 * After a refusal, wait this long before trying the route again by itself (the owner may have made the bot an
 * operator meanwhile). Switching `chatVia`, a restart and `!colors` try at once instead.
 */
export const RETRY_MS = 60_000;

/** The slash styles of `chatVia`; `chat` (the default) is not one. */
export type RouteStyle = 'me' | 'say' | 'tellraw';

/** Every value of `chatVia`. */
export type RouteVia = 'chat' | RouteStyle;

export const ROUTE_VIAS: readonly RouteVia[] = ['chat', 'me', 'say', 'tellraw'];

export function isRouteStyle(v: unknown): v is RouteStyle {
  return v === 'me' || v === 'say' || v === 'tellraw';
}

/** What each value looks like in the chat window, and whether it needs the bot to be an operator (for `!colors` and the docs). */
export const ROUTE_INFO: Readonly<Record<RouteVia, { shows: string; needsOp: boolean }>> = {
  chat: { shows: '<Bot> text', needsOp: false },
  me: { shows: '* Bot text', needsOp: false },
  say: { shows: '[Bot] text', needsOp: true },
  tellraw: { shows: 'text, no name in front', needsOp: true },
};

/** The `command_request` packet the bot sends. */
export interface CommandRequest extends Record<string, unknown> {
  command: string;
  origin: { type: 'player'; uuid: string; request_id: string; player_entity_id: bigint };
  internal: boolean;
  version: 'latest';
}

/** What a `command_output` packet carries that the route reads (the rest is ignored). */
export interface CommandOutputLike {
  origin?: { uuid?: unknown };
  success_count?: unknown;
  output?: { message_id?: unknown }[];
}

/** A `command_request` packet as the bot sends it. 1.26.x: `version` is the string 'latest' and `player_entity_id` must be present, else the server drops the request. */
export function commandRequestPacket(command: string, uuid: string = randomUUID()): CommandRequest {
  return {
    command: command.startsWith('/') ? command : `/${command}`,
    origin: { type: 'player', uuid, request_id: '', player_entity_id: 0n },
    internal: false,
    version: 'latest',
  };
}

/** `/tellraw @a {"rawtext":[{"text":"..."}]}`: the JSON escapes quotes, backslashes and newlines; colour codes pass as they are. */
export function tellrawCommand(text: string, target = '@a'): string {
  return `/tellraw ${target} ${JSON.stringify({ rawtext: [{ text }] })}`;
}

/** True when the tellraw command for `text` is short enough to send. */
export function fitsTellraw(text: string): boolean {
  return wireSize(tellrawCommand(text)) <= SLASH_MAX;
}

/**
 * The command that sends `text` in `style`, or undefined when that style cannot carry it: `/me` and `/say` take the
 * text as it is (quotes, backslashes, colour codes and newlines are relayed unchanged) except that the server expands an `@`
 * selector in it. The caller still checks the length against SLASH_MAX. The only commands this ever builds are
 * /me, /say and /tellraw @a.
 */
export function routeCommand(style: RouteStyle, text: string): string | undefined {
  if (style === 'tellraw') return tellrawCommand(text);
  if (text.includes('@') || text.trim() === '') return undefined;
  return `/${style} ${text}`;
}

/** What the route knows, for `!colors` and the log. */
export interface RouteStatus {
  /** `on`: tried and not refused (or not yet tried); `refused`: waiting to retry. */
  state: 'on' | 'refused';
  /** The server's message id of the last refusal, e.g. `commands.generic.permission.selector`. */
  reason?: string;
  /** Milliseconds until the next try while refused. */
  retryInMs?: number;
}

/**
 * The state of a slash route: which sent commands are still unanswered, and whether the server refused.
 * Pure (a clock is injected), so the unit tests cover it without a connection.
 */
export class SlashRoute {
  private readonly pending = new Map<string, { text: string; at: number }>();
  private readonly now: () => number;
  private readonly retryMs: number;
  private offUntil = 0;
  private reason: string | undefined;

  constructor(now: () => number = Date.now, retryMs: number = RETRY_MS) {
    this.now = now;
    this.retryMs = retryMs;
  }

  /** May the next message try the route? (No while a refusal is fresh.) */
  usable(): boolean {
    return this.now() >= this.offUntil;
  }

  /** Forget a refusal: the next message tries again (the setting was switched, or the owner asked with `!colors`). */
  reset(): void {
    this.offUntil = 0;
    this.reason = undefined;
  }

  /** A command went out under `uuid` carrying `text` (the chat form of the same message). */
  track(uuid: string, text: string): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (t - v.at > 15_000) this.pending.delete(k); // success is silent: forget the answered ones
    if (this.pending.size >= 64) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    this.pending.set(uuid, { text, at: t });
  }

  /**
   * Switch the route off for `ms` without a command_output, e.g. after the server KICKED the bot for a command
   * (`invalid_command_request_packet`): the next session's replies go out as chat, so a reconnect cannot loop.
   */
  refuse(reason: string, ms: number = this.retryMs): void {
    this.offUntil = Math.max(this.offUntil, this.now() + ms);
    this.reason = reason;
  }

  /**
   * A `command_output` arrived. Returns the text to resend as chat when it answers one of our commands and it
   * failed; undefined for every other command (whispers, truth commands) and for a success.
   */
  onOutput(uuid: string | undefined, successCount: number, messageId?: string): string | undefined {
    if (uuid === undefined) return undefined;
    const sent = this.pending.get(uuid);
    if (!sent) return undefined;
    this.pending.delete(uuid);
    if (successCount > 0) return undefined;
    this.offUntil = this.now() + this.retryMs;
    this.reason = messageId ?? 'failed';
    return sent.text;
  }

  status(): RouteStatus {
    if (this.usable()) return { state: 'on' };
    return { state: 'refused', ...(this.reason ? { reason: this.reason } : {}), retryInMs: this.offUntil - this.now() };
  }
}
