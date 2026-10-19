// CLI: bot --task echo --host 127.0.0.1 --port 19132 --version 1.26.51 [--record file]
// Local BDS only for now (offline mode). Realm targets arrive with PLAN.md task 1.6.
import { parseArgs } from 'node:util';
import { Connection, VersionGateError } from './connection/connection.ts';
import { PacketRecorder } from './connection/recorder.ts';
import type { Transport } from './connection/types.ts';
import { createLogger, type LogLevel } from './log.ts';
import { EchoTask } from './tasks/echo.ts';

const USAGE = `usage: bot --task echo [options]
  --task <name>        task to run (echo)
  --host <host>        BDS host (default 127.0.0.1)
  --port <port>        BDS port (default 19132)
  --version <ver>      game version to speak (default 1.26.51)
  --transport <t>      raknet | nethernet (default raknet)
  --username <name>    offline username (default EchoBot)
  --record <file>      write a jsonl packet capture
  --record-raw         also store raw packet bytes in the capture (fixtures)
  --duration <s>       disconnect and exit 0 after this many seconds
  --exit-on-chat <s>   disconnect and exit 0 once a chat line containing <s> arrives
  --no-reconnect       exit instead of reconnecting when the connection drops
  --log-level <lvl>    debug | info | warn | error (default info)`;

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
      username: { type: 'string', default: 'EchoBot' },
      record: { type: 'string' },
      'record-raw': { type: 'boolean', default: false },
      duration: { type: 'string' },
      'exit-on-chat': { type: 'string' },
      'no-reconnect': { type: 'boolean', default: false },
      'log-level': { type: 'string', default: 'info' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.task !== 'echo') {
    console.error(`unknown task "${values.task}"\n${USAGE}`);
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

  const log = createLogger(values['log-level'] as LogLevel, 'bot');
  const recorder = values.record ? new PacketRecorder(values.record, { includeRaw: values['record-raw'] }) : undefined;
  const conn = new Connection({
    version: values.version,
    username: values.username,
    logger: log,
    recorder,
    reconnect: !values['no-reconnect'],
  });
  const task = new EchoTask(conn);
  task.start();
  const exitOn = values['exit-on-chat'];

  let finishing = false;
  const finish = async (code: number, why: string): Promise<never> => {
    if (!finishing) {
      finishing = true;
      log.info(`exiting (${why})`);
      task.stop();
      if (conn.state !== 'closed') conn.disconnect(why);
      await recorder?.close();
      if (recorder) log.info(`recorded ${recorder.count} packets to ${values.record}`);
      // Give RakNet a moment to flush the disconnect packet.
      await new Promise((r) => setTimeout(r, 200));
    }
    process.exit(code);
  };
  process.on('SIGINT', () => void finish(0, 'SIGINT'));
  process.on('SIGTERM', () => void finish(0, 'SIGTERM'));
  if (exitOn) {
    task.onEvent((e) => {
      if (e.kind === 'chat' && e.text.includes(exitOn)) void finish(0, `saw "${exitOn}"`);
    });
  }
  conn.onClose((info) => {
    if (!info.willReconnect && !finishing) void finish(1, `connection closed: ${info.reason}`);
  });

  try {
    await conn.connect({ kind: 'bds', host: values.host, port, transport, offline: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`connect failed: ${msg}`);
    return finish(e instanceof VersionGateError ? 3 : 1, 'connect failed');
  }
  if (values.duration) {
    const seconds = Number(values.duration);
    setTimeout(() => void finish(0, `duration ${seconds} s elapsed`), seconds * 1000);
  }
  return new Promise<number>(() => {
    // run until a signal, the duration timer or a fatal close
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
