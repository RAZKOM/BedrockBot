// Operator commands from the bot itself (`command_request`) and truth-pack replies (`@truth {json}`
// text lines, possibly fragmented). Used by the RL bridge to run `/scriptevent rl:reset ...` without
// docker access: on BDS the bot is an operator (DEFAULT_PLAYER_PERMISSION_LEVEL=operator).
//
// Request ids carry a random per-instance tag: truth replies are broadcast to every player on the
// server, so two clients with plain sequence ids would answer each other's requests.
import { randomInt } from 'node:crypto';
import { commandRequestPacket } from '../chat/route.ts';
import { ReplyParser, textOf, type Reply } from '../../../packs/truth/src/protocol.ts';

export type { Reply };

/** The parts of Connection the command client uses. */
export interface CommandConnection {
  on(name: 'text', fn: (p: { type?: string; message?: string }) => void): () => void;
  queue(name: string, params: Record<string, unknown>): void;
}

export class TruthTimeoutError extends Error {
  readonly cmd: string;
  readonly ms: number;
  constructor(cmd: string, ms: number) {
    super(`timeout after ${ms} ms waiting for ${cmd}`);
    this.cmd = cmd;
    this.ms = ms;
  }
}

export class CommandClient {
  readonly tag = `b${randomInt(36 ** 5).toString(36)}`;
  private readonly conn: CommandConnection;
  private readonly parser = new ReplyParser();
  private readonly pending = new Map<string, (r: Reply) => void>();
  private readonly eventFns = new Set<(r: Reply) => void>();
  private seq = 0;
  private readonly unsub: () => void;

  constructor(conn: CommandConnection) {
    this.conn = conn;
    this.unsub = conn.on('text', (p) => {
      let r: Reply | null;
      try {
        r = this.parser.feed(textOf(p));
      } catch {
        return;
      }
      if (!r) return;
      if (r.cmd === 'event') {
        for (const fn of [...this.eventFns]) fn(r);
        return;
      }
      if (r.id == null) return;
      const fn = this.pending.get(r.id);
      if (fn) {
        this.pending.delete(r.id);
        fn(r);
      }
    });
  }

  dispose(): void {
    this.unsub();
    this.pending.clear();
  }

  /** Truth-pack events (`cmd: "event"`): playerBreakBlock, playerDie, ... */
  onEvent(fn: (r: Reply) => void): () => void {
    this.eventFns.add(fn);
    return () => this.eventFns.delete(fn);
  }

  /**
   * Sends a slash command as this player (`command_request`, origin player; chat/route.ts commandRequestPacket). Fire and
   * forget: a command whose `command_output` is wanted goes through skills/test/command.ts CommandRunner (Track T1).
   */
  command(text: string): void {
    this.conn.queue('command_request', commandRequestPacket(text));
  }

  /** `/scriptevent <ns:cmd> #<id> args...` and the reply with that id. */
  scriptevent(event: string, args: (string | number)[] = [], timeoutMs = 10_000): Promise<Reply> {
    const id = `${this.tag}x${++this.seq}`;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TruthTimeoutError(`${event} #${id}`, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.command(`/scriptevent ${event} #${id}${args.length ? ' ' + args.map(String).join(' ') : ''}`);
    });
  }
}
