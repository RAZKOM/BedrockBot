// CLI: bot --task echo|afk --host 127.0.0.1 --port 19132 --version 1.26.60 [options]
// Targets: a local BDS in offline mode (default), or a Realm (PLAN.md task 1.6; the human signs in
// through the device-code flow on the first run, see docs/runbook.md "Realm join").
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Chat, parseOwners, senderLabel } from './chat/chat.ts';
import { registerBuiltinCommands } from './chat/commands.ts';
import { Connection, VersionGateError } from './connection/connection.ts';
import { DisconnectLog } from './connection/disconnectLog.ts';
import { Metrics } from './connection/metrics.ts';
import { defaultProfilesFolder, realmLabel, RealmGuardError, validateRealmTarget } from './connection/realm.ts';
import { PacketRecorder } from './connection/recorder.ts';
import type { ConnectTarget, NethernetSignalling, RealmTarget, Transport, Vec3 } from './connection/types.ts';
import { createLogger, type LogLevel } from './log.ts';
import { AfkTask } from './tasks/afk.ts';
import { EchoTask } from './tasks/echo.ts';

const BOT_DIR = fileURLToPath(new URL('..', import.meta.url));

const DEFAULT_VERSION = '1.26.60';

const USAGE = `usage: bot --task echo|afk [options]
  --task <name>            task to run: echo (print chat and position) | afk (stay online)
  --version <ver>          game version to speak (default ${DEFAULT_VERSION}, or env BOT_VERSION)
  --target <t>             bds (local BDS, offline; default) | realm
 bds target (offline mode, local servers only):
  --host <host>            BDS host (default 127.0.0.1)
  --port <port>            BDS port (default 19132; NetherNet LAN discovery ignores it)
  --transport <t>          raknet | nethernet (default raknet)
  --signalling <s>         NetherNet signalling: lan (the only choice for a bds target)
  --username <name>        offline username (default EchoBot / AfkBot)
 realm target (NetherNet, services signalling, Microsoft sign-in by YOU via device code):
  --realm-name <name>      Realm to join by name (or --realm-invite <code> / --realm-id <id>)
  --account <label>        token cache key, e.g. bot (required; not the gamertag)
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
      target: { type: 'string', default: 'bds' },
      host: { type: 'string' },
      port: { type: 'string' },
      version: { type: 'string', default: process.env.BOT_VERSION ?? DEFAULT_VERSION },
      transport: { type: 'string' },
      signalling: { type: 'string' },
      'realm-name': { type: 'string' },
      'realm-invite': { type: 'string' },
      'realm-id': { type: 'string' },
      account: { type: 'string' },
      'profiles-folder': { type: 'string' },
      'no-record': { type: 'boolean', default: false },
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
  const targetKind = values.target;
  if (targetKind !== 'bds' && targetKind !== 'realm') {
    console.error(`unknown target "${targetKind}" (bds | realm)`);
    return 2;
  }
  const transport = (values.transport ?? (targetKind === 'realm' ? 'nethernet' : 'raknet')) as Transport;
  if (transport !== 'raknet' && transport !== 'nethernet') {
    console.error(`unknown transport "${values.transport}"`);
    return 2;
  }
  const signalling = (values.signalling ?? (targetKind === 'realm' ? 'services' : 'lan')) as NethernetSignalling;
  if (signalling !== 'lan' && signalling !== 'services') {
    console.error(`unknown signalling "${values.signalling}" (lan | services)`);
    return 2;
  }
  const port = Number(values.port ?? 19132);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`bad port "${values.port}"`);
    return 2;
  }
  const host = values.host ?? '127.0.0.1';
  let target: ConnectTarget;
  if (targetKind === 'realm') {
    // Guard rails (PLAN.md section 2 checklist): a Realm is joined online through services
    // signalling only; refuse the offline/LAN options of a bds target instead of ignoring them.
    const bad = [
      values.host !== undefined && '--host',
      values.port !== undefined && '--port',
      transport !== 'nethernet' && `--transport ${transport}`,
      signalling !== 'services' && `--signalling ${signalling}`,
      values.username !== undefined && '--username (the in-game name is the gamertag of the signed-in account)',
    ].filter((x): x is string => typeof x === 'string');
    if (bad.length > 0) {
      console.error(`--target realm does not take ${bad.join(', ')}: Realms are online-only (NetherNet, services signalling)`);
      return 2;
    }
    if (!values.account) {
      console.error('--target realm needs --account <label> (token cache key, e.g. bot)');
      return 2;
    }
    const realm: RealmTarget = { kind: 'realm', accountName: values.account, profilesFolder: values['profiles-folder'] ?? defaultProfilesFolder() };
    if (values['realm-name'] !== undefined) realm.realmName = values['realm-name'];
    if (values['realm-invite'] !== undefined) realm.realmInvite = values['realm-invite'];
    if (values['realm-id'] !== undefined) realm.realmId = values['realm-id'];
    try {
      realm.profilesFolder = validateRealmTarget(realm);
    } catch (e) {
      console.error(e instanceof RealmGuardError ? e.message : String(e));
      return 2;
    }
    target = realm;
  } else {
    if (signalling !== 'lan') {
      console.error('--signalling services needs a signed-in account: use --target realm');
      return 2;
    }
    const realmOnly = (['realm-name', 'realm-invite', 'realm-id', 'account', 'profiles-folder'] as const).filter((k) => values[k] !== undefined);
    if (realmOnly.length > 0) {
      console.error(`${realmOnly.map((k) => `--${k}`).join(', ')} only valid with --target realm`);
      return 2;
    }
    target = { kind: 'bds', host, port, transport, offline: true };
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
  const username = target.kind === 'realm' ? target.accountName : (values.username ?? (taskName === 'afk' ? 'AfkBot' : 'EchoBot'));
  const server = target.kind === 'realm' ? realmLabel(target) : `${host}:${port} (${transport})`;

  // Realm sessions are always recorded unless --no-record (PLAN.md task 1.6: "packet recorder on").
  const recordPath =
    values.record ?? (target.kind === 'realm' && !values['no-record'] ? join(logDir, `realm-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`) : undefined);
  const recorder = recordPath ? new PacketRecorder(recordPath, { includeRaw: values['record-raw'] }) : undefined;
  if (target.kind === 'realm') {
    mkdirSync(target.profilesFolder, { recursive: true });
    log.info(`realm target: ${server}, account "${target.accountName}", token cache ${target.profilesFolder}, game version ${values.version}`);
    log.info(recordPath ? `recording packets to ${recordPath} (login redacted)` : 'packet recording off (--no-record)');
  }
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
    if (recorder) log.info(`recorded ${recorder.count} packets to ${recordPath}`);
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
    await conn.connect(target);
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
