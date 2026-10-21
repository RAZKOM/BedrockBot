// Task plumbing shared by every task the CLI can run (PLAN.md section 4.4). A task is registered as a
// `TaskDefinition` (tasks/registry.ts) and created once per process with a `TaskContext` that gives it
// the connection, metrics, chat, a logger, its options, and two lazily created shared helpers:
//   ctx.respawn()   death/respawn handling (tasks/respawn.ts): counts deaths, presses respawn,
//                   runs after-respawn hooks (e.g. walk back to a home point or a chest)
//   ctx.mobility()  the movement stack World -> InputLoop -> BotSkills (tasks/mobility.ts); must be
//                   called from create(), i.e. before the connection is opened
//   ctx.clock()     world time (tasks/night.ts WorldClock)
// Tasks are created before conn.connect() and started right after (also before the first spawn).
import type { ParseArgsOptionsConfig } from 'node:util';
import type { Chat } from '../chat/chat.ts';
import type { Connection } from '../connection/connection.ts';
import type { Metrics } from '../connection/metrics.ts';
import type { Vec3 } from '../connection/types.ts';
import type { Logger } from '../log.ts';
import type { Mobility } from './mobility.ts';
import type { WorldClock } from './night.ts';
import type { RespawnController } from './respawn.ts';

/** PLAN.md 4.4, as the CLI runs it. */
export interface Task {
  readonly name: string;
  start(): void | Promise<void>;
  stop(): void;
  status(): Record<string, unknown>;
}

export interface RunningTask extends Task {
  /** Feet position for !pos, !status and the metrics. */
  position(): Vec3 | undefined;
  /** Extra `key value` parts for !status. */
  statusLine?(): Record<string, string | number>;
  /** False while the bot cannot act although spawned (e.g. on the death screen); /healthz is 503 then. */
  alive?(): boolean;
}

/** Options common to the built-in tasks (CLI flag > config file > default). */
export interface CommonTaskOptions {
  nudgeIntervalS: number;
  heartbeat: boolean;
  /** Feet block to return to after a respawn and at dawn. */
  home: Vec3 | undefined;
  /** Night shelter (feet block). */
  shelter: Vec3 | undefined;
  /** Build the movement stack even without home/shelter (so `!home set` / `!shelter set` work). */
  walk: boolean;
  respawnDelayMs: number;
}

export interface TaskContext {
  readonly name: string;
  readonly conn: Connection;
  readonly metrics: Metrics;
  readonly chat: Chat;
  readonly log: Logger;
  readonly version: string;
  readonly options: CommonTaskOptions;
  /** Raw CLI values (including the task's own `cliOptions`). */
  readonly values: Readonly<Record<string, unknown>>;
  /** `tasks.<name>` from the config file. */
  readonly taskConfig: Readonly<Record<string, unknown>>;
  logger(scope: string): Logger;
  respawn(): RespawnController;
  mobility(): Mobility;
  clock(): WorldClock;
}

export interface TaskDefinition {
  name: string;
  /** One line for --help. */
  summary: string;
  /** Extra CLI options (merged into the parser; names must not clash with the common ones). */
  cliOptions?: ParseArgsOptionsConfig;
  /** Extra --help lines. */
  usage?: string;
  /** Default offline username on a bds target. */
  defaultUsername?: string;
  create(ctx: TaskContext): RunningTask;
}
