// Record a packet fixture (PLAN.md task 0.5): login + N seconds idle against a local BDS.
//   pnpm --filter bot record:fixture [--idle 10 --out ../fixtures/1.26.51/login-idle.jsonl.gz]
//   node scripts/record-fixture.ts --version 1.26.60 --port 19134 --bds 1.26.60.6   (bds60)
// --out defaults to ../fixtures/<version>/login-idle.jsonl.gz.
// Offline mode only; the `login` packet (identity chain) is redacted by the recorder.
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { Connection } from '../src/connection/connection.ts';
import { PacketRecorder } from '../src/connection/recorder.ts';
import type { Transport } from '../src/connection/types.ts';
import { createLogger } from '../src/log.ts';

const require = createRequire(import.meta.url);
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a, i) => !(a === '--' && i === 0)),
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '19132' },
    version: { type: 'string', default: '1.26.51' },
    transport: { type: 'string', default: 'raknet' },
    /** BDS build for the fixture header. */
    bds: { type: 'string', default: '1.26.51.1' },
    idle: { type: 'string', default: '10' },
    out: { type: 'string' },
    username: { type: 'string', default: 'FixtureBot' },
  },
});
const transport = values.transport as Transport;
if (transport !== 'raknet' && transport !== 'nethernet') throw new Error(`bad --transport ${values.transport}`);
const out = values.out ?? `../fixtures/${values.version}/login-idle.jsonl.gz`;

const log = createLogger('info', 'fixture');
const recorder = new PacketRecorder(out, { includeRaw: true });
const pkg = (name: string) => (require(`${name}/package.json`) as { version: string }).version;
recorder.record('meta', 'fixture', {
  kind: 'login-idle',
  idleSeconds: Number(values.idle),
  gameVersion: values.version,
  bds: `${values.bds} (itzg/minecraft-bedrock-server:2026.10.2, flat world, ${transport}, offline)`,
  bedrockProtocol: pkg('bedrock-protocol'),
  minecraftData: pkg('minecraft-data'),
  recordedAt: new Date().toISOString(),
});

const conn = new Connection({ version: values.version, username: values.username, logger: log, recorder, reconnect: false });
await conn.connect({ kind: 'bds', host: values.host, port: Number(values.port), transport, offline: true });
log.info(`spawned; idling ${values.idle} s`);
await new Promise((r) => setTimeout(r, Number(values.idle) * 1000));
await conn.disconnectAndFlush('fixture done');
await recorder.close();
log.info(`wrote ${recorder.count} packets to ${out}`);
process.exit(0);
