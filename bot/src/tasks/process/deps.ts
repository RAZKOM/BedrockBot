// The one object every chat-command registration of the AFK task receives (PLAN.md 7.8, Track Q).
// Built once in tasks/registry.ts (afk task) and handed to each `register...(deps)` in the list
// marked "command registrations" there. Other tracks add one import and one list entry:
//   registerNavCommands(deps)       Track R (goals, waypoints)
//   registerSurvivalCommands(deps)  Track S (eat, armour, ...)
//   registerFarmCommands(deps)      Track U (farming)
// Everything that moves the bot should be a process (deps.processes.add(...), tasks/process/manager.ts)
// and read its knobs live from deps.settings (config/settings.ts). Without walking (`--task afk`
// without --walk/--home/--shelter) the movement parts are undefined: reply with deps.needsWalking(cmd).
import type { Chat, Sender } from '../../chat/chat.ts';
import type { Connection } from '../../connection/connection.ts';
import type { Metrics } from '../../connection/metrics.ts';
import type { Vec3 } from '../../connection/types.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import type { Logger } from '../../log.ts';
import type { BotSkills } from '../../skills/index.ts';
import type { World } from '../../world/index.ts';
import type { Mobility } from '../mobility.ts';
import type { PveController } from '../pve.ts';
import type { WalkingTask } from '../registry.ts';
import type { ProcessManager } from './manager.ts';

export interface CommandDeps {
  chat: Chat;
  /** The running afk task (home, shelter, goto, status). */
  task: WalkingTask;
  conn: Connection;
  metrics: Metrics;
  /** Movement stack; undefined without walking. */
  mobility: Mobility | undefined;
  skills: BotSkills | undefined;
  world: World | undefined;
  /** One active process at a time; undefined without walking. */
  processes: ProcessManager | undefined;
  /** Live runtime settings (`!set`); always present (in memory without a settings file). */
  settings: RuntimeSettings;
  /** Guard, flee, follow, come, kill; undefined without walking. */
  pve: PveController | undefined;
  log: Logger;
  /** Chat owner check (commands already run for owners only; for commands that act for someone else). */
  isOwner(sender: Sender): boolean;
  /** The bot's own name. */
  selfName(): string;
  /** Feet position, when known. */
  position(): Vec3 | undefined;
  /** `x y z` arguments -> feet block, or undefined. */
  parseBlock(args: readonly string[]): Vec3 | undefined;
  /** `10 -60 3` (or `none`). */
  fmtBlock(p: Vec3 | undefined): string;
  /** The standard reply for movement commands without walking: `<cmd> needs a task that can walk (...)`. */
  needsWalking(cmd: string): string;
}

export const NEEDS_WALKING = 'needs a task that can walk (start with --walk, --home or --target realm)';

export function parseBlockArgs(args: readonly string[]): Vec3 | undefined {
  if (args.length !== 3) return undefined;
  const n = args.map(Number);
  if (!n.every((v) => Number.isFinite(v))) return undefined;
  return { x: Math.floor(n[0]!), y: Math.floor(n[1]!), z: Math.floor(n[2]!) };
}

export function fmtBlockPos(p: Vec3 | undefined): string {
  return p ? `${p.x} ${p.y} ${p.z}` : 'none';
}
