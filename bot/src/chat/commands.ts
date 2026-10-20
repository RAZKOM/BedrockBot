// Built-in chat commands (PLAN.md task 1.2 and 4.4): !status !pos !quit !help.
import type { Connection } from '../connection/connection.ts';
import { formatDuration, type Metrics } from '../connection/metrics.ts';
import type { Vec3 } from '../connection/types.ts';
import type { Chat, Sender } from './chat.ts';
import { senderLabel } from './chat.ts';

export interface BuiltinDeps {
  conn: Connection;
  metrics: Metrics;
  /** The bot's feet position, when known. */
  position: () => Vec3 | undefined;
  /** Graceful shutdown (disconnect, exit 0). Called after the goodbye reply had time to go out. */
  quit: (by: Sender) => void;
  /** Extra `key value` parts for !status (e.g. task name, nudges). */
  extraStatus?: () => Record<string, string | number>;
  /** Delay between the !quit reply and quit(), so the reply is flushed (> 1 tick). Default 300 ms. */
  quitDelayMs?: number;
}

export function formatPos(p: Vec3 | undefined): string {
  return p ? `${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}` : 'unknown';
}

export interface StatusParts {
  uptimeS: number;
  sessionS: number | undefined;
  reconnects: number;
  kicks: number;
  position: Vec3 | undefined;
  gameVersion: string;
  tick: bigint | number;
  extra?: Record<string, string | number>;
}

/** One-line status, e.g. `status: up 1h02m, session 12m03s, reconnects 1, kicks 0, pos 0.50 -60.00 0.50, version 1.26.51, tick 14460`. */
export function formatStatus(s: StatusParts): string {
  const parts = [
    `up ${formatDuration(s.uptimeS)}`,
    `session ${s.sessionS === undefined ? '-' : formatDuration(s.sessionS)}`,
    `reconnects ${s.reconnects}`,
    `kicks ${s.kicks}`,
    `pos ${formatPos(s.position)}`,
    `version ${s.gameVersion}`,
    `tick ${s.tick}`,
  ];
  for (const [k, v] of Object.entries(s.extra ?? {})) parts.push(`${k} ${v}`);
  return `status: ${parts.join(', ')}`;
}

export function registerBuiltinCommands(chat: Chat, deps: BuiltinDeps): void {
  const { conn, metrics } = deps;
  chat.register({
    name: 'status',
    help: '(uptime, reconnects, position, version, tick)',
    run: ({ reply }) => {
      const snap = metrics.snapshot();
      reply(
        formatStatus({
          uptimeS: snap.uptimeS,
          sessionS: snap.session?.uptimeS,
          reconnects: snap.reconnects,
          kicks: snap.kicks.total,
          position: deps.position(),
          gameVersion: conn.gameVersion,
          tick: conn.tick,
          extra: deps.extraStatus?.(),
        }),
      );
    },
  });
  chat.register({
    name: 'pos',
    help: '(feet position)',
    run: ({ reply }) => {
      reply(`pos ${formatPos(deps.position())}`);
    },
  });
  chat.register({
    name: 'quit',
    help: '(disconnect and exit)',
    run: ({ reply, sender }) => {
      reply(`bye (quit by ${senderLabel(sender)})`);
      setTimeout(() => { deps.quit(sender); }, deps.quitDelayMs ?? 300);
    },
  });
  chat.register({
    name: 'help',
    help: '(this list)',
    run: ({ reply }) => {
      reply(`commands: ${chat.commandNames().map((n) => `${chat.prefix}${n}`).join(' ')}`);
    },
  });
}
