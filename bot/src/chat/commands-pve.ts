// PvE / follow chat commands (PLAN.md tasks 7.4 to 7.6, docs/pve.md), owner-only like every command:
//   !follow [name]          follow a player (default: whoever sent the command)
//   !come [name]            walk to within 2 blocks of the player (default: the sender)
//   !stop                   cancel every command (follow / come / kill / goto / gather) and a pending home
//                           return (Track Q: guard, flee and night keep running)
//   !guard [status] | on | off | <radius>
//   !kill <type> [n]        kill up to n (default 1) mobs of that type within 32 blocks; players: refused
// Registered by the afk task (tasks/registry.ts). Without the movement stack every command answers
// "<cmd> needs a task that can walk (...)", like !goto.
import type { Chat, Sender } from './chat.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { refusedKillType } from '../tasks/pve.ts';

export interface PveCommandDeps {
  follow(name: string): string;
  come(name: string): Promise<{ ok: boolean; reason?: string }>;
  stop(): string;
  guard(): { on: boolean; radius: number };
  setGuard(g: { on?: boolean; radius?: number }): { on: boolean; radius: number };
  kill(type: string, n: number): Promise<{ ok: boolean; killed: number; want: number; reason: string; type: string }>;
  /** True when `type` must be refused (player, selectors, a player's name). */
  refused(type: string): boolean;
  behaviour(): string;
  /** The bot's own name (it does not follow itself). */
  selfName(): string;
}

export const PVE_COMMANDS = ['follow', 'come', 'stop', 'guard', 'kill'] as const;

const NEEDS_WALK = 'needs a task that can walk (start with --walk, --home or --target realm)';
export const KILL_REFUSED = 'refused: I never attack players (PvE only)';
const MAX_KILL = 64;
const MAX_RADIUS = 64;

function who(sender: Sender, args: string[]): string | undefined {
  if (args[0]) return args[0];
  return sender.kind === 'player' ? sender.name.replace(/§./g, '') : undefined;
}

/**
 * The afk task's registration (Track Q, tasks/registry.ts list): the PvE commands on its controller.
 * `!stop` stops every command and what it pre-empted (and a pending home return); guard, flee and
 * night keep running.
 */
export function registerPveCommandsFor(d: CommandDeps): void {
  const p = d.pve;
  const world = d.world;
  registerPveCommands(
    d.chat,
    p && world
      ? {
          follow: (name) => p.follow({ playerName: name }),
          come: (name) => p.come(name),
          stop: () => p.stopCommands(),
          guard: () => p.guard,
          setGuard: (g) => p.setGuard(g),
          kill: (type, k) => p.kill(type, k),
          refused: (type) => refusedKillType(type, world.entities),
          behaviour: () => p.behaviour(),
          selfName: () => d.selfName(),
        }
      : undefined,
  );
}

export function registerPveCommands(chat: Chat, deps: PveCommandDeps | undefined): void {
  if (!deps) {
    for (const name of PVE_COMMANDS) {
      chat.register({
        name,
        help: '(needs walking)',
        run: ({ reply }) => {
          reply(`${name} ${NEEDS_WALK}`);
        },
      });
    }
    return;
  }
  chat.register({
    name: 'follow',
    help: '[name] (follow a player; default you)',
    run: ({ reply, sender, args }) => {
      const name = who(sender, args);
      if (!name) {
        reply('usage: !follow <name> (the console has no position)');
        return;
      }
      if (name.toLowerCase() === deps.selfName().toLowerCase()) {
        reply('I cannot follow myself');
        return;
      }
      reply(`following ${deps.follow(name)}`);
    },
  });
  chat.register({
    name: 'come',
    help: '[name] (walk to you, or to the named player)',
    run: ({ reply, sender, args }) => {
      const name = who(sender, args);
      if (!name) {
        reply('usage: !come <name> (the console has no position)');
        return;
      }
      reply(`coming to ${name}`);
      void deps.come(name).then((r) => {
        if (r.ok) reply(`here (${name})`);
        else if (r.reason === 'not_found') reply(`come: I cannot see ${name}`);
        else if (r.reason !== 'interrupted') reply(`come: ${r.reason ?? 'failed'}`);
      });
    },
  });
  chat.register({
    name: 'stop',
    help: '(stop every command: follow, come, kill, goto, gather; guard and night keep running)',
    run: ({ reply }) => {
      const was = deps.stop();
      reply(`stopped (was ${was}); ${deps.behaviour()}`);
    },
  });
  chat.register({
    name: 'guard',
    help: '[status] | on | off | <radius> (fight hostiles near home)',
    run: ({ reply, args }) => {
      const a = (args[0] ?? 'status').toLowerCase();
      if (a === 'status') {
        const g = deps.guard();
        reply(`guard ${g.on ? 'on' : 'off'}, radius ${g.radius}; ${deps.behaviour()}`);
        return;
      }
      if (a === 'on' || a === 'off') {
        const g = deps.setGuard({ on: a === 'on' });
        reply(`guard ${g.on ? 'on' : 'off'}, radius ${g.radius}`);
        return;
      }
      const r = Number(a);
      if (!Number.isFinite(r) || r < 2 || r > MAX_RADIUS) {
        reply(`usage: !guard [status] | on | off | <radius 2..${MAX_RADIUS}>`);
        return;
      }
      const g = deps.setGuard({ on: true, radius: Math.round(r) });
      reply(`guard on, radius ${g.radius}`);
    },
  });
  chat.register({
    name: 'kill',
    help: '<type> [n] (kill mobs of that type within 32 blocks; never players)',
    run: ({ reply, args }) => {
      const [type, count] = args;
      if (!type) {
        reply('usage: !kill <mob type> [n]');
        return;
      }
      if (deps.refused(type)) {
        reply(KILL_REFUSED);
        return;
      }
      const n = count === undefined ? 1 : Number(count);
      if (!Number.isInteger(n) || n < 1 || n > MAX_KILL) {
        reply(`usage: !kill <mob type> [n 1..${MAX_KILL}]`);
        return;
      }
      reply(`killing ${n} ${type}`);
      void deps.kill(type, n).then((r) => {
        if (r.reason === 'refused_player') reply(KILL_REFUSED);
        else if (r.reason === 'interrupted') reply(`kill ${r.type}: stopped after ${r.killed}/${r.want}`);
        else if (r.reason === 'none_left') reply(`kill ${r.type}: ${r.killed}/${r.want}, no more within 32 blocks`);
        else reply(`kill ${r.type}: ${r.killed}/${r.want} done`);
      });
    },
  });
}
