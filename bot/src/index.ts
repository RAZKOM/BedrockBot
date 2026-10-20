// CLI: bot --task echo|afk --host 127.0.0.1 --port 19132 --version 1.26.51 [options]
// Local BDS only for now (offline mode). Realm targets arrive with PLAN.md task 1.6.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Chat, parseOwners, senderLabel } from './chat/chat.ts';
import { registerBuiltinCommands } from './chat/commands.ts';
import { Connection, VersionGateError } from './connection/connection.ts';
import { DisconnectLog } from './connection/disconnectLog.ts';
import { Metrics } from './connection/metrics.ts';
import { PacketRecorder } from './connection/recorder.ts';
import type { Transport, Vec3 } from './connection/types.ts';
import { createLogger, type LogLevel } from './log.ts';
import { AfkTask } from './tasks/afk.ts';
import { EchoTask } from './tasks/echo.ts';

const BOT_DIR = fileURLToPath(new URL('..', import.meta.url));

const USAGE = `usage: bot --task echo|afk [options]
  --task <name>            task to run: echo (print chat and position) | afk (stay online)
  --host <host>            BDS host (default 127.0.0.1)
  --port <port>            BDS port (default 19132)
  --version <ver>          game version to speak (default 1.26.51)
  --transport <t>          raknet | nethernet (default raknet)
  --username <name>        offline username (default EchoBot / AfkBot)
  --record <file>          write a jsonl packet capture
  --record-raw             also store raw packet bytes in the capture (fixtures)
  --duration <s>           disconnect and exit 0 after this many seconds
  --exit-on-chat <s>       disconnect and exit 0 once a chat line containing <s> arrives
  --no-reconnect           exit instead of reconnecting when the connection drops
  --log-level <lvl>        debug | info | warn | error (default info)
 chat commands (!status !pos !quit !help):
  --owner <who>            allowed player name or xuid:<xuid>; repeatable, comma lists ok
                           (also env BOT_OWNERS). The server console is always allowed unless
  --no-console-owner       is given.
 afk task:
  --nudge-interval <s>     seconds between keepalive nudges (default 240; 0 = never)
  --heartbeat              also send an idle player_auth_input every tick between nudges
 files (default directory bot/logs, git-ignored):
  --log-dir <dir>          directory for the files below
  --disconnect-log <file>  jsonl line per disconnect/kick (default <log-dir>/disconnects.jsonl)
  --metrics-file <file>    metrics JSON, rewritten every --metrics-interval (default <log-dir>/metrics.json)
  --metrics-interval <s>   default 60`;

async function main(argv: string[]): Promise<number> {
  // `pnpm start -- --task echo` may forward the separator itself.
  const args = argv.filter((a, i) => !(a === '--' && i === 0));
  const { values } = parseArgs({
    args,
    options: {
      task: { type: 'string', default: 'echo' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '19132' },
      version: { type: 'string', default: '1.26.51' },
      transport: { type: 'string', default: 'raknet' },
      username: { type: 'string' },
      record: { type: 'string' },
      'record-raw': { type: 'boolean', default: false },
      duration: { type: 'string' },
      'exit-on-chat': { type: 'string' },
      'no-reconnect': { type: 'boolean', default: false },
      'log-level': { type: 'string', default: 'info' },
      owner: { type: 'string', multiple: true, default: [] },
      'no-console-owner': { type: 'boolean', default: false },
      'nudge-interval': { type: 'string', default: '240' },
      heartbeat: { type: 'boolean', default: false },
      'log-dir': { type: 'string' },
      'disconnect-log': { type: 'string' },
      'metrics-file': { type: 'string' },
      'metrics-interval': { type: 'string', default: '60' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const taskName = values.task;
  if (taskName !== 'echo' && taskName !== 'afk') {
    console.error(`unknown task "${taskName}"\n${USAGE}`);
    return 2;
  }
  const transport = values.transport as Transport;
  if (transport !== 'raknet' && transport !== 'nethernet') {
    console.error(`unknown transport "${values.transport}"`);
    return 2;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`bad port "${values.port}"`);
    return 2;
  }
  const nudgeS = Number(values['nudge-interval']);
  const metricsS = Number(values['metrics-interval']);
  if (!Number.isFinite(nudgeS) || nudgeS < 0 || !Number.isFinite(metricsS) || metricsS <= 0) {
    console.error('bad --nudge-interval or --metrics-interval');
    return 2;
  }

  const log = createLogger(values['log-level'] as LogLevel, 'bot');
  const logDir = resolve(values['log-dir'] ?? join(BOT_DIR, 'logs'));
  const disconnectPath = resolve(values['disconnect-log'] ?? join(logDir, 'disconnects.jsonl'));
  const metricsPath = resolve(values['metrics-file'] ?? join(logDir, 'metrics.json'));
  const username = values.username ?? (taskName === 'afk' ? 'AfkBot' : 'EchoBot');
  const server = `${values.host}:${port} (${transport})`;

  const recorder = values.record ? new PacketRecorder(values.record, { includeRaw: values['record-raw'] }) : undefined;
  const conn = new Connection({
    version: values.version,
    username,
    logger: log,
    recorder,
    reconnect: !values['no-reconnect'],
  });
  const metrics = new Metrics();
  metrics.attach(conn);
  const disconnects = new DisconnectLog(disconnectPath);
  disconnects.attach(conn, server);
  conn.onClose((info) => {
    if (info.kind === 'kick') log.warn(`kick reason: ${JSON.stringify(info.kick ?? info.reason)}`);
  });

  let position: () => Vec3 | undefined;
  let extraStatus: () => Record<string, string | number> = () => ({ task: taskName });
  let stopTask: () => void;
  let echo: EchoTask | undefined;
  if (taskName === 'afk') {
    const afk = new AfkTask(conn, { nudgeIntervalMs: nudgeS * 1000, heartbeat: values.heartbeat, metrics, log });
    afk.start();
    position = () => afk.feet;
    extraStatus = () => ({ task: 'afk', nudges: afk.nudges, corrections: afk.corrections });
    stopTask = () => { afk.stop(); };
    log.info(`afk: nudge every ${nudgeS > 0 ? `${nudgeS} s` : 'never'}${values.heartbeat ? ', heartbeat every tick' : ''}`);
  } else {
    echo = new EchoTask(conn);
    echo.start();
    const e = echo;
    position = () => e.feet;
    stopTask = () => { e.stop(); };
  }
  metrics.provide(() => ({ task: taskName, position: position() ?? null, server }));

  const owners = parseOwners([...values.owner, ...(process.env.BOT_OWNERS ? [process.env.BOT_OWNERS] : [])], !values['no-console-owner']);
  const chat = new Chat(conn, { owners, log });

  let finishing = false;
  const finish = async (code: number, why: string): Promise<never> => {
    if (finishing) return new Promise<never>(() => {}); // the first caller exits
    finishing = true;
    log.info(`exiting (${why})`);
    stopTask();
    chat.stop();
    // Waits until RakNet has sent the disconnect packet, so the server ends the session now.
    if (conn.state !== 'closed') await conn.disconnectAndFlush(why);
    metrics.stopWriter();
    await recorder?.close();
    if (recorder) log.info(`recorded ${recorder.count} packets to ${values.record}`);
    process.exit(code);
  };

  registerBuiltinCommands(chat, {
    conn,
    metrics,
    position: () => position(),
    extraStatus: () => extraStatus(),
    quit: (by) => void finish(0, `!quit from ${senderLabel(by)}`),
  });
  chat.start();
  chat.onCommand((e) => {
    metrics.inc(`chat.${e.kind}`);
  });

  process.on('SIGINT', () => void finish(0, 'SIGINT'));
  process.on('SIGTERM', () => void finish(0, 'SIGTERM'));
  const exitOn = values['exit-on-chat'];
  if (exitOn && echo) {
    echo.onEvent((e) => {
      if (e.kind === 'chat' && e.text.includes(exitOn)) void finish(0, `saw "${exitOn}"`);
    });
  } else if (exitOn) {
    chat.onLine((line) => {
      if (line.message.includes(exitOn)) void finish(0, `saw "${exitOn}"`);
    });
  }
  let connected = false;
  conn.onClose((info) => {
    // Before the first spawn, the connect() rejection below decides the exit code.
    if (connected && !info.willReconnect && !finishing) void finish(info.versionMismatch ? 3 : 1, `connection closed: ${info.reason}`);
  });

  log.info(`logs: ${disconnectPath}, ${metricsPath} (every ${metricsS} s)`);
  metrics.startWriter(metricsPath, metricsS * 1000);
  try {
    await conn.connect({ kind: 'bds', host: values.host, port, transport, offline: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`connect failed: ${msg}`);
    return finish(e instanceof VersionGateError ? 3 : 1, 'connect failed');
  }
  connected = true;
  if (values.duration) {
    const seconds = Number(values.duration);
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
