// CLI: bot --task echo|afk|... [options]   (see USAGE below and docs/runbook.md)
// Targets: a local BDS in offline mode (default), or a Realm (PLAN.md task 1.6; the human signs in
// through the device-code flow on the first run, see docs/runbook.md "Realm join").
// Settings come from CLI flags > the config file (PLAN.md task 5.5, config/config.ts) > defaults.
// Tasks live in tasks/registry.ts (TaskDefinition, tasks/base.ts); add new ones in the
// "task registrations" block below or in the registry.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { Chat, parseOwners, senderLabel } from './chat/chat.ts';
import { registerBuiltinCommands, registerHardeningCommands, whisperOwners } from './chat/commands.ts';
import { ConfigError, defaultConfigPath, loadConfig, locateConfig, type LoadedConfig } from './config/config.ts';
import { DEFAULT_VERSION } from './config/defaults.ts';
import { resolveSettings, SettingsError, type CliValues, type Settings } from './config/resolve.ts';
import { Connection, VersionGateError } from './connection/connection.ts';
import { DisconnectLog } from './connection/disconnectLog.ts';
import { HealthServer } from './connection/health.ts';
import { Metrics } from './connection/metrics.ts';
import { defaultProfilesFolder, isInside, REPO_ROOT } from './connection/realm.ts';
import { PacketRecorder } from './connection/recorder.ts';
import { createLogger, type Logger } from './log.ts';
import type { RunningTask } from './tasks/base.ts';
import { buildTaskContext } from './tasks/context.ts';
import { allTasks, getTask, onChatContaining, taskNames, type WalkingTask } from './tasks/registry.ts';
import { currentPins, runUpdateCheck } from './update/check.ts';
import { UpdateNotifier } from './update/notifier.ts';
import { defaultCacheRoot, openWorldCache } from './world/cache/index.ts'; // Track T
import { mapRoutes } from './health/map/routes.ts'; // Track T
import { gatherTask } from './tasks/gatherWood.ts';
import { rlTaskDefinition } from './tasks/rlAgent.ts';
import { registerTask } from './tasks/registry.ts';

// ---- task registrations -------------------------------------------------------------------------
// Built-ins (echo, afk) register themselves in tasks/registry.ts. Other tasks:
//   import { registerTask } from './tasks/registry.ts';
//   registerTask(myTaskDefinition);
registerTask(gatherTask); // --task gather (PLAN.md 4.6, tasks/gatherWood.ts)
registerTask(rlTaskDefinition); // --task rl --bridge-port <port> (PLAN.md 6.2, tasks/rlAgent.ts)
// --------------------------------------------------------------------------------------------------

const BOT_DIR = fileURLToPath(new URL('..', import.meta.url));

const COMMON_OPTIONS = {
  config: { type: 'string' },
  'no-config': { type: 'boolean' },
  task: { type: 'string' },
  target: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  version: { type: 'string' },
  transport: { type: 'string' },
  signalling: { type: 'string' },
  'realm-name': { type: 'string' },
  'realm-invite': { type: 'string' },
  'realm-id': { type: 'string' },
  account: { type: 'string' },
  'profiles-folder': { type: 'string' },
  'no-record': { type: 'boolean' },
  username: { type: 'string' },
  record: { type: 'string' },
  'record-raw': { type: 'boolean' },
  duration: { type: 'string' },
  'exit-on-chat': { type: 'string' },
  'no-reconnect': { type: 'boolean' },
  'log-level': { type: 'string' },
  owner: { type: 'string', multiple: true },
  'no-console-owner': { type: 'boolean' },
  'nudge-interval': { type: 'string' },
  heartbeat: { type: 'boolean' },
  home: { type: 'string' },
  shelter: { type: 'string' },
  walk: { type: 'boolean' },
  'respawn-delay': { type: 'string' },
  'log-dir': { type: 'string' },
  'disconnect-log': { type: 'string' },
  'metrics-file': { type: 'string' },
  'metrics-interval': { type: 'string' },
  'health-port': { type: 'string' },
  'update-check-hours': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

function usage(): string {
  const tasks = allTasks()
    .map((t) => `                           ${t.name.padEnd(8)} ${t.summary}`)
    .join('\n');
  const extra = allTasks()
    .filter((t) => t.usage)
    .map((t) => ` ${t.name} task:\n${t.usage}`)
    .join('\n');
  return `usage: bot --task <name> [options]       (CLI flag > config file > default)
  --task <name>            task to run (default echo):
${tasks}
  --config <file>          config file (JSON, comments allowed; default env BEDROCKBOT_CONFIG, else
                           %LOCALAPPDATA%\\bedrockbot\\config.json or ~/.bedrockbot/config.json;
                           \`pnpm config:init\` writes an example). --no-config ignores it.
  --version <ver>          game version to speak (default ${DEFAULT_VERSION}, or env BOT_VERSION)
  --target <t>             bds (local BDS, offline; default) | realm (only selectable here, never by the config file)
 bds target (offline mode, local servers only):
  --host <host>            BDS host (default 127.0.0.1)
  --port <port>            BDS port (default 19132; NetherNet LAN discovery ignores it)
  --transport <t>          raknet | nethernet (default raknet)
  --signalling <s>         NetherNet signalling: lan (the only choice for a bds target)
  --username <name>        offline username (default EchoBot / AfkBot / per task)
 realm target (NetherNet, services signalling, Microsoft sign-in by YOU via device code):
  --realm-name <name>      Realm to join by name (or --realm-invite <code> / --realm-id <id>; config realm.*)
  --account <label>        token cache key, e.g. bot (config realm.accountName; not the gamertag)
  --profiles-folder <dir>  token cache directory, must be outside the repo
                           (default ${defaultProfilesFolder()})
  --no-record              do not write the packet capture (on by default for realm)
 recording:
  --record <file>          write a jsonl packet capture (.gz = gzip); login is always redacted
  --record-raw             also store raw packet bytes in the capture (fixtures)
  --duration <s>           disconnect and exit 0 after this many seconds
  --exit-on-chat <s>       disconnect and exit 0 once a chat line containing <s> arrives
  --no-reconnect           exit instead of reconnecting when the connection drops
  --log-level <lvl>        debug | info | warn | error (default info)
 chat commands (!status !pos !health !shelter !home !quit !help):
  --owner <who>            allowed player name or xuid:<xuid>; repeatable, comma lists ok
                           (also env BOT_OWNERS, config owners). The server console is always
  --no-console-owner       allowed unless this is given.
 afk task:
  --nudge-interval <s>     seconds between keepalive nudges (default 240; 0 = never)
  --heartbeat              also send an idle player_auth_input every tick between nudges
  --home <x,y,z>           walk back to this feet block after each respawn (and at dawn)
  --shelter <x,y,z>        walk into this feet block at dusk (time 12000), leave at dawn (23000)
  --walk                   enable walking (!home set / !shelter set) without --home/--shelter
  --respawn-delay <s>      press respawn this long after dying (default 2; negative = never)
 operations:
  --health-port <port>     serve GET /healthz and /metrics on 127.0.0.1:<port> (default off)
  --update-check-hours <h> check for new game/BDS/library versions every h hours (default 24 on a
                           realm target, else 0 = off); whispers the owners when one appears
 files (default directory bot/logs, git-ignored):
  --log-dir <dir>          directory for the files below
  --disconnect-log <file>  jsonl line per disconnect/kick (default <log-dir>/disconnects.jsonl)
  --metrics-file <file>    metrics JSON, rewritten every --metrics-interval (default <log-dir>/metrics.json)
  --metrics-interval <s>   default 60${extra ? `\n${extra}` : ''}`;
}

/** parseArgs option set: the common options plus every registered task's own options. */
function optionSet(): ParseArgsOptionsConfig {
  const opts: ParseArgsOptionsConfig = { ...COMMON_OPTIONS };
  for (const t of allTasks()) {
    for (const [k, v] of Object.entries(t.cliOptions ?? {})) {
      if (k in COMMON_OPTIONS) throw new Error(`task ${t.name}: option --${k} clashes with a common option`);
      opts[k] = v;
    }
  }
  return opts;
}

async function main(argv: string[]): Promise<number> {
  // pnpm forwards `--` separators (`pnpm bot:afk -- --port 1` gives `--task afk -- --port 1`); no
  // command here takes positional arguments, so drop them all.
  const args = argv.filter((a) => a !== '--');
  let values: CliValues;
  try {
    values = parseArgs({ args, options: optionSet(), strict: true }).values;
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${usage()}`);
    return 2;
  }
  if (values.help) {
    console.log(usage());
    return 0;
  }

  // Relative paths on the command line are relative to where the command was started (pnpm runs
  // `--filter bot start` inside bot/ but sets INIT_CWD to the original directory).
  const cwd = process.env.INIT_CWD ?? process.cwd();
  let loaded: LoadedConfig | undefined;
  let settings: Settings;
  try {
    if (!values['no-config']) loaded = loadConfig(locateConfig(values.config, process.env, cwd));
    settings = resolveSettings(values, loaded?.config ?? {}, {
      botVersion: process.env.BOT_VERSION,
      botOwners: process.env.BOT_OWNERS,
      cwd,
      defaultLogDir: join(BOT_DIR, 'logs'),
    });
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SettingsError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  const def = getTask(settings.task);
  if (!def) {
    console.error(`unknown task "${settings.task}" (${taskNames().join(', ')})\n${usage()}`);
    return 2;
  }

  const log = createLogger(settings.logLevel, 'bot');
  if (loaded?.path) {
    log.info(`config: ${loaded.path}`);
    if (isInside(loaded.path, REPO_ROOT) && loaded.config.realm) log.warn(`config file ${loaded.path} is inside the repository; keep Realm details outside it (default ${defaultConfigPath()})`);
  }
  const target = settings.target;
  const server = settings.server;
  const username = settings.username ?? def.defaultUsername ?? 'Bot';
  const recorder = settings.record ? new PacketRecorder(settings.record, { includeRaw: settings.recordRaw }) : undefined;
  if (target.kind === 'realm') {
    mkdirSync(target.profilesFolder, { recursive: true });
    log.info(`realm target: ${server}, account "${target.accountName}", token cache ${target.profilesFolder}, game version ${settings.version}`);
    log.info(settings.record ? `recording packets to ${settings.record} (login redacted)` : 'packet recording off (--no-record)');
  }
  const conn = new Connection({
    version: settings.version,
    username,
    logger: log,
    recorder,
    reconnect: settings.reconnect,
  });
  const metrics = new Metrics();
  metrics.attach(conn);
  const disconnects = new DisconnectLog(settings.disconnectLog);
  disconnects.attach(conn, server);
  conn.onClose((info) => {
    if (info.kind === 'kick') log.warn(`kick reason: ${JSON.stringify(info.kick ?? info.reason)}`);
  });

  const owners = parseOwners(settings.owners, settings.consoleOwner);
  const chat = new Chat(conn, { owners, log });

  // ---- the task ----
  const taskRef: { current?: RunningTask } = {};
  const built = buildTaskContext({
    name: def.name,
    conn,
    metrics,
    chat,
    version: settings.version,
    options: settings.common,
    values,
    taskConfig: settings.taskConfig,
    logLevel: settings.logLevel,
    position: () => taskRef.current?.position(),
  });
  const runningTask: RunningTask = def.create(built.ctx);
  taskRef.current = runningTask;
  metrics.provide(() => ({ task: def.name, position: runningTask.position() ?? null, server, taskStatus: runningTask.status() }));
  const healthLog: Logger = createLogger(settings.logLevel, 'health');
  // Track T: persistent world cache for walking tasks (docs/world-cache.md); env BEDROCKBOT_CACHE=0 off, BEDROCKBOT_CACHE_DIR root
  const cacheRoot = process.env.BEDROCKBOT_CACHE_DIR ?? defaultCacheRoot(loaded?.path ?? defaultConfigPath());
  const worldCache = built.mobility && process.env.BEDROCKBOT_CACHE !== '0' ? openWorldCache(built.mobility.world, { root: cacheRoot, server: target.kind === 'bds' ? `${target.host}:${target.port}` : server, logger: log }) : undefined;

  let health: HealthServer | undefined;
  let notifier: UpdateNotifier | undefined;
  let finishing = false;
  const finish = async (code: number, why: string): Promise<never> => {
    if (finishing) return new Promise<never>(() => {}); // the first caller exits
    finishing = true;
    log.info(`exiting (${why})`);
    runningTask.stop();
    built.stop();
    worldCache?.close(); // Track T: write the remembered chunks
    notifier?.stop();
    chat.stop();
    // Waits until RakNet has sent the disconnect packet, so the server ends the session now.
    if (conn.state !== 'closed') await conn.disconnectAndFlush(why);
    metrics.stopWriter();
    await health?.stop();
    await recorder?.close();
    if (recorder) log.info(`recorded ${recorder.count} packets to ${settings.record}`);
    process.exit(code);
  };

  registerBuiltinCommands(chat, {
    conn,
    metrics,
    position: () => runningTask.position(),
    extraStatus: () => runningTask.statusLine?.() ?? { task: def.name },
    quit: (by) => void finish(0, `!quit from ${senderLabel(by)}`),
  });
  const walking = runningTask as WalkingTask;
  registerHardeningCommands(chat, {
    health: () => ({
      health: built.respawn?.health ?? built.mobility?.world.self.health ?? null,
      food: built.mobility ? built.mobility.world.self.food : undefined,
      deaths: built.respawn?.deaths ?? metrics.counters.deaths ?? 0,
      dead: built.respawn?.dead ?? false,
      lastCause: built.respawn?.lastDeath?.cause ?? null,
      healthy: conn.state === 'spawned' && (runningTask.alive?.() ?? true),
    }),
    shelter: walking.shelter,
    home: walking.home,
    goto: walking.goto ? (p) => walking.goto!(p) : undefined,
    position: () => runningTask.position(),
  });
  chat.start();
  chat.onCommand((e) => {
    metrics.inc(`chat.${e.kind}`);
  });

  if (settings.healthPort !== undefined) {
    // Track T: GET /map and /map.json (health/map)
    const mob = built.mobility;
    const routes = mapRoutes({ world: mob?.world, cache: worldCache, position: () => runningTask.position(), skillsStatus: () => mob?.skills.status(), taskStatus: () => runningTask.status(), server });
    health = new HealthServer({ port: settings.healthPort, metrics, alive: () => runningTask.alive?.() ?? true, log: healthLog, routes });
    try {
      await health.start();
    } catch (e) {
      log.error(`health endpoint on 127.0.0.1:${settings.healthPort} failed: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }
  if (settings.updateCheckHours > 0) {
    notifier = new UpdateNotifier({
      intervalHours: settings.updateCheckHours,
      // compare against the game version this bot actually speaks
      check: () => runUpdateCheck({ pins: currentPins(settings.version) }),
      metrics,
      log: createLogger(settings.logLevel, 'update'),
      notify: (msg) => {
        const sent = whisperOwners(conn, owners.names, msg);
        log.warn(`update notifier: ${msg}${sent.length ? ` (whispered to ${sent.join(', ')})` : ''}`);
      },
    });
    notifier.start();
    log.info(`update check every ${settings.updateCheckHours} h (first in 60 s)`);
  }

  process.on('SIGINT', () => void finish(0, 'SIGINT'));
  process.on('SIGTERM', () => void finish(0, 'SIGTERM'));
  const exitOn = settings.exitOnChat;
  if (exitOn) onChatContaining(chat, exitOn, () => void finish(0, `saw "${exitOn}"`));
  let connected = false;
  conn.onClose((info) => {
    // Before the first spawn, the connect() rejection below decides the exit code.
    if (connected && !info.willReconnect && !finishing) void finish(info.versionMismatch ? 3 : 1, `connection closed: ${info.reason}`);
  });

  log.info(`logs: ${settings.disconnectLog}, ${settings.metricsFile} (every ${settings.metricsIntervalS} s)`);
  metrics.startWriter(settings.metricsFile, settings.metricsIntervalS * 1000);
  await runningTask.start();
  try {
    await conn.connect(target);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`connect failed: ${msg}`);
    return finish(e instanceof VersionGateError ? 3 : 1, 'connect failed');
  }
  connected = true;
  if (settings.durationS !== undefined) {
    const seconds = settings.durationS;
    setTimeout(() => void finish(0, `duration ${seconds} s elapsed`), seconds * 1000);
  }
  return new Promise<number>(() => {
    // run until a signal, !quit, the duration timer or a fatal close
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
