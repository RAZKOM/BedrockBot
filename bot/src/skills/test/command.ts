// Track T1 (docs/runbook.md "The Realm as a test server", ADR 0075): slash commands sent BY THE BOT with their answer read
// back. Every command goes out as `command_request` (chat/route.ts commandRequestPacket: `version` 'latest' and a
// `player_entity_id`, or the server drops it) under a fresh origin uuid, and the server's `command_output` with the same
// uuid is the answer: `success_count` and the first message's id and parameters.
//
// Measured on BDS 1.26.60.6 (bds-fly3, 2026-11-08; the runbook section has the table):
//   operator: /testfor @s -> 1, commands.testfor.success [name]; /tp @s x y z -> 1, commands.tp.success.coordinates;
//             /give -> commands.give.success; /replaceitem -> commands.replaceitem.success.entity; /effect -> commands.effect.success;
//             an unknown command -> 0, commands.generic.unknown; bad arguments -> 0, commands.generic.syntax
//   member (de-opped): /testfor @s, /tp @s ... -> 0, commands.generic.permission.selector (the same id the Realm gave /tellraw)
//   /tellraw succeeds silently (no command_output at all): a command without an answer times out, it is not a failure.
// Answers came 60 to 110 ms after the request.
//
// The runner sends one command at a time (the next waits for the answer or the timeout, then a gap), at most
// MAX_PER_MINUTE a minute, refuses a command over route.ts SLASH_MAX bytes (511 makes the server drop the connection),
// and logs every command with its result.
import { commandRequestPacket, SLASH_MAX } from '../../chat/route.ts';
import { wireSize } from '../../chat/style.ts';
import { silentLogger, type Logger } from '../../log.ts';

/** Wait this long for a command's answer. */
export const COMMAND_TIMEOUT_MS = 5000;
/** At least this long between two commands. */
export const COMMAND_GAP_MS = 150;
/** At most this many commands a minute (a test run needs about 10 between runs). */
export const MAX_PER_MINUTE = 60;

/** One message of a `command_output`. */
export interface OutputMessage {
  id: string;
  success: boolean;
  params: string[];
}

/** What `command_output` says, read defensively (any field may be missing on an unknown server). */
export interface ParsedOutput {
  uuid: string | undefined;
  successCount: number;
  messages: OutputMessage[];
}

/** Read a `command_output` packet. */
export function parseCommandOutput(packet: unknown): ParsedOutput {
  const p = (packet ?? {}) as { origin?: { uuid?: unknown }; success_count?: unknown; output?: unknown };
  const uuid = typeof p.origin?.uuid === 'string' ? p.origin.uuid : undefined;
  const successCount = typeof p.success_count === 'number' && Number.isFinite(p.success_count) ? p.success_count : 0;
  const messages: OutputMessage[] = [];
  if (Array.isArray(p.output)) {
    for (const m of p.output as { message_id?: unknown; success?: unknown; parameters?: unknown }[]) {
      if (!m || typeof m !== 'object') continue;
      messages.push({
        id: typeof m.message_id === 'string' ? m.message_id : '',
        success: m.success === true,
        params: Array.isArray(m.parameters) ? m.parameters.map((x) => String(x)) : [],
      });
    }
  }
  return { uuid, successCount, messages };
}

export type CommandError = 'timeout' | 'too_long' | 'not_spawned' | 'rate_limited' | 'stopped';

export interface CommandResult {
  command: string;
  /** The server ran it (`success_count` > 0). False on a refusal and on every error. */
  ok: boolean;
  successCount: number;
  /** The first message's id (`commands.tp.success.coordinates`, `commands.generic.permission.selector`). */
  messageId?: string;
  params: string[];
  /** Milliseconds from sending to the answer. */
  ms: number;
  /** Set when there was no answer to read. */
  error?: CommandError;
}

/** A refusal for lack of rights (not a syntax error or a missing target). */
export function isPermissionRefusal(r: Pick<CommandResult, 'ok' | 'messageId'>): boolean {
  return !r.ok && typeof r.messageId === 'string' && /permission|not\s*op|cheat|disabled/i.test(r.messageId);
}

/** `ok commands.tp.success.coordinates (82 ms)` / `refused commands.generic.permission.selector` / `timeout`. */
export function resultText(r: CommandResult): string {
  if (r.error) return r.error === 'timeout' ? `no answer in ${Math.round(r.ms)} ms` : r.error.replace('_', ' ');
  return `${r.ok ? 'ok' : 'refused'} ${r.messageId ?? '(no message)'}${r.params.length ? ` [${r.params.join(', ')}]` : ''} (${Math.round(r.ms)} ms)`;
}

/** The parts of Connection the runner uses (unit-test seam). */
export interface CommandSource {
  readonly state: string;
  on(name: 'command_output', fn: (p: unknown) => void): () => void;
  queue(name: 'command_request', params: Record<string, unknown>): void;
}

export interface CommandRunnerOptions {
  log?: Logger;
  timeoutMs?: number;
  gapMs?: number;
  maxPerMinute?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
}

interface Waiting {
  resolve: (p: ParsedOutput) => void;
}

export class CommandRunner {
  private readonly conn: CommandSource;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly gapMs: number;
  private readonly maxPerMinute: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly makeUuid: (() => string) | undefined;
  private readonly waiting = new Map<string, Waiting>();
  private readonly sentAt: number[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private lastSent = -Infinity;
  private readonly off: () => void;
  private disposed = false;
  readonly counts = { sent: 0, ok: 0, refused: 0, errors: 0 };

  constructor(conn: CommandSource, opts: CommandRunnerOptions = {}) {
    this.conn = conn;
    this.log = opts.log ?? silentLogger;
    this.timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
    this.gapMs = opts.gapMs ?? COMMAND_GAP_MS;
    this.maxPerMinute = opts.maxPerMinute ?? MAX_PER_MINUTE;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.makeUuid = opts.uuid;
    this.off = conn.on('command_output', (p) => {
      const out = parseCommandOutput(p);
      if (out.uuid === undefined) return;
      const w = this.waiting.get(out.uuid);
      if (!w) return; // the chat route's /me, /say, /tellraw and anything else not ours
      this.waiting.delete(out.uuid);
      w.resolve(out);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.off();
    this.waiting.clear();
  }

  /** Send `command` (with or without the slash) after the ones before it; resolves with the answer, never rejects. */
  run(command: string, opts: { timeoutMs?: number } = {}): Promise<CommandResult> {
    const next = this.chain.then(() => this.runNow(command, opts.timeoutMs ?? this.timeoutMs));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async runNow(command0: string, timeoutMs: number): Promise<CommandResult> {
    const command = command0.startsWith('/') ? command0 : `/${command0}`;
    const fail = (error: CommandError, ms = 0): CommandResult => {
      this.counts.errors++;
      const r: CommandResult = { command, ok: false, successCount: 0, params: [], ms, error };
      this.log.warn(`command ${command}: ${resultText(r)}`);
      return r;
    };
    if (this.disposed) return fail('stopped');
    if (wireSize(command) > SLASH_MAX) return fail('too_long');
    if (this.conn.state !== 'spawned') return fail('not_spawned');
    const wait = this.lastSent + this.gapMs - this.now();
    if (wait > 0) await this.sleep(wait);
    const t = this.now();
    while (this.sentAt.length > 0 && t - this.sentAt[0]! > 60_000) this.sentAt.shift();
    if (this.sentAt.length >= this.maxPerMinute) return fail('rate_limited');
    const packet = this.makeUuid ? commandRequestPacket(command, this.makeUuid()) : commandRequestPacket(command);
    const uuid = packet.origin.uuid;
    const answer = new Promise<ParsedOutput | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(uuid);
        resolve(undefined);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.waiting.set(uuid, {
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
      });
    });
    this.sentAt.push(t);
    this.lastSent = t;
    this.counts.sent++;
    this.conn.queue('command_request', packet);
    const out = await answer;
    const ms = this.now() - t;
    if (!out) return fail('timeout', ms);
    const first = out.messages[0];
    const r: CommandResult = { command, ok: out.successCount > 0, successCount: out.successCount, ...(first?.id ? { messageId: first.id } : {}), params: first?.params ?? [], ms };
    if (r.ok) this.counts.ok++;
    else this.counts.refused++;
    this.log[r.ok ? 'info' : 'warn'](`command ${command}: ${resultText(r)}`);
    return r;
  }
}
