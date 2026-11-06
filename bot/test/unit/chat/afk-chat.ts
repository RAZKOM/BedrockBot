// The real afk command registry for unit tests (docs/ux.md; shared by chat/ux.test.ts and the map
// screen's guard test, decision 0062): the afk task with walking, plus the CLI's built-ins and the
// hardening commands, registered in index.ts order on a Chat over a fake connection.
import { Chat } from '../../../src/chat/chat.ts';
import { registerBuiltinCommands, registerHardeningCommands } from '../../../src/chat/commands.ts';
import { Metrics } from '../../../src/connection/metrics.ts';
import { RuntimeSettings, SETTINGS_VALUE_KEY } from '../../../src/config/settings.ts';
import { silentLogger } from '../../../src/log.ts';
import type { CommonTaskOptions, TaskContext } from '../../../src/tasks/base.ts';
import { createMobility, type Mobility } from '../../../src/tasks/mobility.ts';
import { WorldClock } from '../../../src/tasks/night.ts';
import { afkTask } from '../../../src/tasks/registry.ts';
import { RespawnController } from '../../../src/tasks/respawn.ts';
import { setup as connSetup } from '../connection-fakes.ts';

/** The afk task with walking, plus the CLI's built-ins and hardening commands (index.ts order). */
export function afkChat(settings = new RuntimeSettings()) {
  const { conn } = connSetup();
  const chat = new Chat(conn, { log: silentLogger });
  let m: Mobility | undefined;
  const COMMON: CommonTaskOptions = { nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: true, respawnDelayMs: 2000 };
  const ctx: TaskContext = {
    name: 'afk',
    conn,
    metrics: new Metrics(),
    chat,
    log: silentLogger,
    version: '1.26.60',
    options: COMMON,
    values: { [SETTINGS_VALUE_KEY]: settings },
    taskConfig: {},
    logger: () => silentLogger,
    respawn: () => new RespawnController(conn),
    mobility: () => (m ??= createMobility(conn, { version: '1.26.60' })),
    clock: () => new WorldClock(conn),
  };
  const task = afkTask.create(ctx);
  registerBuiltinCommands(chat, { conn, metrics: new Metrics(), position: () => undefined, quit: () => undefined });
  registerHardeningCommands(chat, { health: () => ({ health: 20, deaths: 0, dead: false, healthy: true }), position: () => undefined });
  return { chat, task, settings };
}
