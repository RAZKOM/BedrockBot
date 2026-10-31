// How a reply reaches the players: as player chat (`text` packet, the default) or as `/tellraw` (a slash
// command sent as the bot). Guide: docs/chat-style.md "Routes". Decision: docs/decisions/0050-chat-style.md.
//
// Why tellraw at all: a tellraw message arrives as a system message (`json_whisper`), not as player chat. It
// has no `<Bot>` name in front of every line, and it does not go through the chat text filter the owner's
// client applies to player chat (digits shown as ####, observed 2026-10-29; to be confirmed with the owner).
// Why not always: `/tellraw @a` needs operator rights, and the server drops the connection for a command
// that is too long. Measured on BDS 1.26.60.6 (bot/test/e2e/chat-style.test.ts keeps both facts honest):
//
//   operator      /tellraw @a {...}  delivered; success is silent (no command_output)
//   non-operator  /tellraw @a {...}  refused at once: command_output success 0, `commands.generic.permission.selector`
//   a command of 480 characters works; 512 makes the server DROP THE CONNECTION (chat only drops the message)
//
// So the route is an opt-in setting (`chatVia tellraw`) with a safety net: a refused or failed tellraw is
// resent as ordinary chat at once, and tellraw is not tried again for RETRY_MS. A message whose command would
// pass SLASH_MAX never becomes a command; it goes out as chat.
import { randomUUID } from 'node:crypto';

/** Longest slash command we ever send. 480 works on BDS 1.26.60.6, 512 drops the connection. */
export const SLASH_MAX = 480;

/** The text budget of a Doc message when the route is tellraw: the command wraps it in about 37 characters plus JSON escapes. */
export const DOC_MESSAGE_TELLRAW = 420;

/** After a refusal, wait this long before trying tellraw again (the owner may have made the bot an operator meanwhile). */
export const RETRY_MS = 10 * 60_000;

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

/** `/tellraw @a {"rawtext":[{"text":"..."}]}`: the JSON escapes quotes, backslashes and newlines; section signs pass as they are. */
export function tellrawCommand(text: string, target = '@a'): string {
  return `/tellraw ${target} ${JSON.stringify({ rawtext: [{ text }] })}`;
}

/** True when the tellraw command for `text` is short enough to send. */
export function fitsTellraw(text: string): boolean {
  return tellrawCommand(text).length <= SLASH_MAX;
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
 * The state of the tellraw route: which sent commands are still unanswered, and whether the server refused.
 * Pure (a clock is injected), so the unit tests cover it without a connection.
 */
export class TellrawRoute {
  private readonly pending = new Map<string, { text: string; at: number }>();
  private readonly now: () => number;
  private readonly retryMs: number;
  private offUntil = 0;
  private reason: string | undefined;

  constructor(now: () => number = Date.now, retryMs: number = RETRY_MS) {
    this.now = now;
    this.retryMs = retryMs;
  }

  /** May the next message try tellraw? (No while a refusal is fresh.) */
  usable(): boolean {
    return this.now() >= this.offUntil;
  }

  /** A tellraw command went out under `uuid` carrying `text` (the chat form of the same message). */
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
   * A `command_output` arrived. Returns the text to resend as chat when it answers one of our tellraws and it
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
