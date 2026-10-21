// Built-in chat commands (PLAN.md task 1.2 and 4.4): !status !pos !quit !help.
import { randomUUID } from 'node:crypto';
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

// ---- Phase 5 hardening commands (PLAN.md tasks 5.1, 5.2, 5.4): !health !shelter !home ----------

export interface HardeningDeps {
  /** Health, food, deaths, last death cause, etc. for !health. */
  health: () => { health: number | null; food?: number | null; deaths: number; dead: boolean; lastCause?: string | null; healthy: boolean };
  /** Night safety; undefined when the task cannot walk (no movement stack). */
  shelter?: {
    get(): Vec3 | undefined;
    set(p: Vec3 | undefined): void;
    /** Short state, e.g. `sheltered`, `day`, `unreachable`. */
    state(): string;
  };
  /** Home point (return after respawn / at dawn); undefined when the task cannot walk. */
  home?: {
    get(): Vec3 | undefined;
    set(p: Vec3 | undefined): void;
    /** Walk home now (`!home go`). */
    go?(): Promise<{ ok: boolean; reason?: string }>;
  };
  /** Walk to a feet block now (`!goto x y z`); undefined when the task cannot walk. */
  goto?: (p: Vec3) => Promise<{ ok: boolean; reason?: string }>;
  /** Current feet position (for `set`). */
  position: () => Vec3 | undefined;
}

/** Parse `x y z` into a feet block, or undefined. */
function parseBlock(args: string[]): Vec3 | undefined {
  if (args.length !== 3) return undefined;
  const n = args.map(Number);
  if (!n.every((v) => Number.isFinite(v))) return undefined;
  return { x: Math.floor(n[0]!), y: Math.floor(n[1]!), z: Math.floor(n[2]!) };
}

function blockOf(p: Vec3): Vec3 {
  return { x: Math.floor(p.x), y: Math.floor(p.y + 1e-6), z: Math.floor(p.z) };
}

function fmtBlock(p: Vec3 | undefined): string {
  return p ? `${p.x} ${p.y} ${p.z}` : 'none';
}

/** Parse `set`, `set x y z`, `clear` arguments for !shelter / !home. */
function pointCommand(name: string, target: NonNullable<HardeningDeps['home']>, position: () => Vec3 | undefined, extra?: () => string) {
  return ({ reply, args }: { reply: (m: string) => void; args: string[] }) => {
    const [sub, ...rest] = args;
    if (sub === undefined || sub === 'show') {
      reply(`${name} ${fmtBlock(target.get())}${extra ? `, ${extra()}` : ''}`);
      return;
    }
    if (sub === 'clear') {
      target.set(undefined);
      reply(`${name} cleared`);
      return;
    }
    if (sub === 'go') {
      const p = target.get();
      if (!p) {
        reply(`${name} is not set`);
        return;
      }
      if (!target.go) {
        reply(`${name} go is not available`);
        return;
      }
      reply(`walking to ${name} ${fmtBlock(p)}`);
      void target.go().then((r) => {
        reply(r.ok ? `arrived at ${name}` : `${name}: ${r.reason ?? 'failed'}`);
      });
      return;
    }
    if (sub === 'set') {
      let p: Vec3 | undefined;
      if (rest.length === 3) {
        const n = rest.map(Number);
        if (n.every((v) => Number.isFinite(v))) p = { x: Math.floor(n[0]!), y: Math.floor(n[1]!), z: Math.floor(n[2]!) };
      } else {
        const here = position();
        if (here) p = blockOf(here);
      }
      if (!p) {
        reply(`usage: !${name} set [x y z] | clear (position unknown)`);
        return;
      }
      target.set(p);
      reply(`${name} set to ${fmtBlock(p)}`);
      return;
    }
    reply(`usage: !${name} [show] | set [x y z] | go | clear`);
  };
}

export function registerHardeningCommands(chat: Chat, deps: HardeningDeps): void {
  chat.register({
    name: 'health',
    help: '(health, food, deaths, last death cause)',
    run: ({ reply }) => {
      const h = deps.health();
      const parts = [
        `health ${h.health ?? '?'}`,
        ...(h.food !== undefined ? [`food ${h.food ?? '?'}`] : []),
        `deaths ${h.deaths}`,
        ...(h.lastCause ? [`last ${h.lastCause}`] : []),
        h.dead ? 'dead' : 'alive',
        h.healthy ? 'healthy' : 'unhealthy',
      ];
      reply(`health: ${parts.join(', ')}`);
    },
  });
  const shelter = deps.shelter;
  chat.register({
    name: 'shelter',
    help: '[show] | set [x y z] | clear (night shelter)',
    run: shelter
      ? pointCommand('shelter', shelter, deps.position, () => `state ${shelter.state()}`)
      : ({ reply }) => {
          reply('shelter needs a task that can walk (start with --walk, --shelter or --target realm)');
        },
  });
  const gotoFn = deps.goto;
  chat.register({
    name: 'goto',
    help: 'x y z (walk to a feet block now)',
    run: gotoFn
      ? ({ reply, args }) => {
          const p = parseBlock(args);
          if (!p) {
            reply('usage: !goto x y z');
            return;
          }
          reply(`walking to ${fmtBlock(p)}`);
          void gotoFn(p).then((r) => {
            reply(r.ok ? `arrived at ${fmtBlock(p)}` : `goto: ${r.reason ?? 'failed'}`);
          });
        }
      : ({ reply }) => {
          reply('goto needs a task that can walk (start with --walk, --home or --target realm)');
        },
  });
  const home = deps.home;
  chat.register({
    name: 'home',
    help: '[show] | set [x y z] | go | clear (return point after respawn and at dawn)',
    run: home
      ? pointCommand('home', home, deps.position)
      : ({ reply }) => {
          reply('home needs a task that can walk (start with --walk, --home or --target realm)');
        },
  });
}

/**
 * A slash command sent as the bot (`command_request`), e.g. `/tell Steve hi`. Used to whisper the
 * owners (update notifier). `/tell` needs no operator rights on BDS (*unverified on a Realm*).
 * 1.26.x: `version` must be the string 'latest' and `player_entity_id` must be present, else the
 * server drops the request (bedrock-protocol docs/API.md "Running commands").
 */
export function commandRequestPacket(command: string, uuid: string = randomUUID()): Record<string, unknown> {
  return {
    command: command.startsWith('/') ? command : `/${command}`,
    origin: { type: 'player', uuid, request_id: '', player_entity_id: 0n },
    internal: false,
    version: 'latest',
  };
}

/** Whisper `message` to every named owner (XUID-only owners cannot be addressed by /tell). Returns the names. */
export function whisperOwners(conn: Pick<Connection, 'state' | 'queue'>, names: readonly string[], message: string): string[] {
  if (conn.state !== 'spawned') return [];
  const clean = message.replace(/[\r\n]+/g, ' ').slice(0, 200);
  for (const n of names) conn.queue('command_request', commandRequestPacket(`/tell "${n.replace(/"/g, '')}" ${clean}`));
  return [...names];
}

// ---- !gather (PLAN.md task 4.6, Track H; tasks/gatherWood.ts) ----------------------------------

export interface GatherCommandDeps {
  /** Start (or restart) gathering `n` logs; `chest` overrides the configured chest. Returns the reply. */
  start(n: number, chest: Vec3 | undefined): string;
  /** Stop gathering. Returns the reply. */
  stop(): string;
  /** One-line gather status. */
  status(): string;
}

/** `!gather <n> [x y z]` | `!gather stop` | `!gather` (status). */
export function registerGatherCommands(chat: Chat, deps: GatherCommandDeps): void {
  chat.register({
    name: 'gather',
    help: '<n> [x y z] | stop (gather n logs into the chest)',
    run: ({ args, reply }) => {
      const [first, ...rest] = args;
      if (first === undefined || first === 'status') {
        reply(deps.status());
        return;
      }
      if (first === 'stop') {
        reply(deps.stop());
        return;
      }
      const n = Number(first);
      if (!Number.isInteger(n) || n <= 0 || n > 100_000) {
        reply('usage: !gather <n> [x y z] | stop');
        return;
      }
      let chest: Vec3 | undefined;
      if (rest.length > 0) {
        const c = rest.map(Number);
        if (c.length !== 3 || c.some((v) => !Number.isFinite(v))) {
          reply('usage: !gather <n> [x y z] | stop');
          return;
        }
        chest = { x: Math.floor(c[0]!), y: Math.floor(c[1]!), z: Math.floor(c[2]!) };
      }
      reply(deps.start(n, chest));
    },
  });
}
