// Builds the TaskContext (tasks/base.ts) for one task: the CLI (bot/src/index.ts) and the e2e tests
// use the same wiring, so the hard-* e2e tests exercise exactly what `--task afk --home ...` runs.
import type { Chat } from '../chat/chat.ts';
import type { Connection } from '../connection/connection.ts';
import type { Metrics } from '../connection/metrics.ts';
import type { Vec3 } from '../connection/types.ts';
import { createLogger, type Logger, type LogLevel } from '../log.ts';
import type { CommonTaskOptions, TaskContext } from './base.ts';
import { createMobility, type Mobility } from './mobility.ts';
import { WorldClock } from './night.ts';
import { RespawnController } from './respawn.ts';

export interface TaskContextInput {
  name: string;
  conn: Connection;
  metrics: Metrics;
  chat: Chat;
  version: string;
  options: CommonTaskOptions;
  values?: Record<string, unknown>;
  taskConfig?: Record<string, unknown>;
  logLevel?: LogLevel;
  /** Logger factory (default createLogger(logLevel, scope)). */
  logger?: (scope: string) => Logger;
  /** Feet position for death records (usually the task's position()). */
  position?: () => Vec3 | undefined;
}

export interface BuiltContext {
  ctx: TaskContext;
  /** The shared helpers, if the task created them. */
  readonly respawn: RespawnController | undefined;
  readonly mobility: Mobility | undefined;
  readonly clock: WorldClock | undefined;
  /** Stop the shared helpers (the task's stop() disposes the mobility). */
  stop(): void;
}

export function buildTaskContext(input: TaskContextInput): BuiltContext {
  const level = input.logLevel ?? 'info';
  const logger = input.logger ?? ((scope: string) => createLogger(level, scope));
  const { conn } = input;
  let respawn: RespawnController | undefined;
  let mobility: Mobility | undefined;
  let clock: WorldClock | undefined;
  const ctx: TaskContext = {
    name: input.name,
    conn,
    metrics: input.metrics,
    chat: input.chat,
    log: logger('bot'),
    version: input.version,
    options: input.options,
    values: input.values ?? {},
    taskConfig: input.taskConfig ?? {},
    logger,
    respawn: () => {
      if (!respawn) {
        respawn = new RespawnController(conn, {
          respawnDelayMs: input.options.respawnDelayMs,
          metrics: input.metrics,
          log: logger('respawn'),
          position: () => input.position?.(),
        });
        respawn.start();
      }
      return respawn;
    },
    mobility: () => {
      if (!mobility) {
        if (conn.state !== 'idle') throw new Error('ctx.mobility() must be called from create(), before connecting');
        mobility = createMobility(conn, { version: input.version, log: logger('move') });
      }
      return mobility;
    },
    clock: () => {
      if (!clock) {
        clock = new WorldClock(conn);
        clock.start();
      }
      return clock;
    },
  };
  return {
    ctx,
    get respawn() {
      return respawn;
    },
    get mobility() {
      return mobility;
    },
    get clock() {
      return clock;
    },
    stop: () => {
      respawn?.stop();
      clock?.stop();
    },
  };
}
