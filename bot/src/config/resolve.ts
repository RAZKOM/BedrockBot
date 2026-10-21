// Merge CLI flags, the config file and defaults into the settings the CLI runs with (PLAN.md task
// 5.5). Pure apart from the Realm guard's filesystem checks; unit-tested in test/unit/config.test.ts.
// Precedence: CLI flag > config file > default. Relative CLI paths are resolved against the
// directory the command was started from (INIT_CWD under pnpm), config-file paths against the file.
import { isAbsolute, join, resolve } from 'node:path';
import type { CommonTaskOptions } from '../tasks/base.ts';
import { defaultProfilesFolder, realmLabel, RealmGuardError, validateRealmTarget } from '../connection/realm.ts';
import type { ConnectTarget, NethernetSignalling, RealmTarget, Transport, Vec3 } from '../connection/types.ts';
import type { BotConfig } from './config.ts';
import { parseVec3 } from './config.ts';
import { DEFAULT_HOST, DEFAULT_METRICS_INTERVAL_S, DEFAULT_NUDGE_INTERVAL_S, DEFAULT_PORT, DEFAULT_VERSION } from './defaults.ts';

/** The CLI values `resolveSettings` reads (strings as parseArgs returns them; undefined = not given). */
export interface CliValues {
  config?: string;
  'no-config'?: boolean;
  help?: boolean;
  task?: string;
  target?: string;
  host?: string;
  port?: string;
  version?: string;
  transport?: string;
  signalling?: string;
  'realm-name'?: string;
  'realm-invite'?: string;
  'realm-id'?: string;
  account?: string;
  'profiles-folder'?: string;
  'no-record'?: boolean;
  username?: string;
  record?: string;
  'record-raw'?: boolean;
  duration?: string;
  'exit-on-chat'?: string;
  'no-reconnect'?: boolean;
  'log-level'?: string;
  owner?: string[];
  'no-console-owner'?: boolean;
  'nudge-interval'?: string;
  heartbeat?: boolean;
  'log-dir'?: string;
  'disconnect-log'?: string;
  'metrics-file'?: string;
  'metrics-interval'?: string;
  'health-port'?: string;
  home?: string;
  shelter?: string;
  walk?: boolean;
  'respawn-delay'?: string;
  'update-check-hours'?: string;
  [k: string]: unknown;
}

export interface Settings {
  task: string;
  target: ConnectTarget;
  /** Human label: host:port (transport) or realm "name" (...). */
  server: string;
  version: string;
  username: string | undefined;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logDir: string;
  disconnectLog: string;
  metricsFile: string;
  metricsIntervalS: number;
  /** undefined = no health endpoint. */
  healthPort: number | undefined;
  reconnect: boolean;
  /** Packet capture file, if any. */
  record: string | undefined;
  recordRaw: boolean;
  durationS: number | undefined;
  exitOnChat: string | undefined;
  owners: string[];
  consoleOwner: boolean;
  common: CommonTaskOptions;
  updateCheckHours: number;
  taskConfig: Record<string, unknown>;
}

export class SettingsError extends Error {
  override name = 'SettingsError';
}

export interface ResolveEnv {
  /** BOT_VERSION */
  botVersion?: string;
  /** BOT_OWNERS (comma list) */
  botOwners?: string;
  /** Base for relative CLI paths. */
  cwd: string;
  /** Default log directory (bot/logs). */
  defaultLogDir: string;
  /** Default profiles folder for Realm tokens. */
  defaultProfilesFolder?: string;
  now?: Date;
}

function int(v: string | undefined, what: string, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new SettingsError(`bad ${what} "${v}" (integer ${min}..${max})`);
  return n;
}

function seconds(v: string | undefined, what: string, allowZero: boolean): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new SettingsError(`bad ${what} "${v}"`);
  return n;
}

function vec(v: string | undefined, what: string): Vec3 | undefined {
  if (v === undefined) return undefined;
  const p = parseVec3(v);
  if (!p) throw new SettingsError(`bad ${what} "${v}" (expected x,y,z)`);
  return { x: p[0], y: p[1], z: p[2] };
}

const fromTuple = (t: [number, number, number] | undefined): Vec3 | undefined => (t ? { x: t[0], y: t[1], z: t[2] } : undefined);

/** Merge; throws SettingsError (exit code 2) on bad or conflicting options. */
export function resolveSettings(cli: CliValues, cfg: BotConfig, env: ResolveEnv): Settings {
  const path = (p: string) => (isAbsolute(p) ? p : resolve(env.cwd, p));
  const task = cli.task ?? cfg.task ?? 'echo';
  const targetKind = cli.target ?? 'bds';
  if (targetKind !== 'bds' && targetKind !== 'realm') throw new SettingsError(`unknown target "${targetKind}" (bds | realm)`);
  const transport = (cli.transport ?? (targetKind === 'realm' ? 'nethernet' : (cfg.transport ?? 'raknet'))) as Transport;
  if (transport !== 'raknet' && transport !== 'nethernet') throw new SettingsError(`unknown transport "${cli.transport}"`);
  const signalling = (cli.signalling ?? (targetKind === 'realm' ? 'services' : 'lan')) as NethernetSignalling;
  if (signalling !== 'lan' && signalling !== 'services') throw new SettingsError(`unknown signalling "${cli.signalling}" (lan | services)`);
  const port = int(cli.port, 'port', 1, 65535) ?? cfg.port ?? DEFAULT_PORT;
  const host = cli.host ?? cfg.host ?? DEFAULT_HOST;
  const version = cli.version ?? env.botVersion ?? cfg.version ?? DEFAULT_VERSION;

  let target: ConnectTarget;
  let server: string;
  if (targetKind === 'realm') {
    // Guard rails (PLAN.md section 2 checklist): a Realm is joined online through services signalling
    // only; refuse the offline/LAN options of a bds target instead of ignoring them. (Config-file host,
    // port and username belong to the bds target and are simply not used here.)
    const bad = [
      cli.host !== undefined && '--host',
      cli.port !== undefined && '--port',
      transport !== 'nethernet' && `--transport ${transport}`,
      signalling !== 'services' && `--signalling ${signalling}`,
      cli.username !== undefined && '--username (the in-game name is the gamertag of the signed-in account)',
    ].filter((x): x is string => typeof x === 'string');
    if (bad.length > 0) throw new SettingsError(`--target realm does not take ${bad.join(', ')}: Realms are online-only (NetherNet, services signalling)`);
    const r = cfg.realm ?? {};
    const accountName = cli.account ?? r.accountName;
    if (!accountName) throw new SettingsError('--target realm needs --account <label> or realm.accountName in the config file (token cache key, e.g. bot)');
    const profilesFolder = cli['profiles-folder'] !== undefined ? path(cli['profiles-folder']) : (r.profilesFolder ?? env.defaultProfilesFolder ?? defaultProfilesFolder());
    const realm: RealmTarget = { kind: 'realm', accountName, profilesFolder };
    // A selector on the command line replaces the config file's selector entirely.
    const cliSel = cli['realm-name'] !== undefined || cli['realm-invite'] !== undefined || cli['realm-id'] !== undefined;
    const sel = cliSel ? { realmName: cli['realm-name'], realmInvite: cli['realm-invite'], realmId: cli['realm-id'] } : r;
    if (sel.realmName !== undefined) realm.realmName = sel.realmName;
    if (sel.realmInvite !== undefined) realm.realmInvite = sel.realmInvite;
    if (sel.realmId !== undefined) realm.realmId = sel.realmId;
    try {
      realm.profilesFolder = validateRealmTarget(realm);
    } catch (e) {
      throw new SettingsError(e instanceof RealmGuardError ? e.message : String(e));
    }
    target = realm;
    server = realmLabel(realm);
  } else {
    if (signalling !== 'lan') throw new SettingsError('--signalling services needs a signed-in account: use --target realm');
    const realmOnly = (['realm-name', 'realm-invite', 'realm-id', 'account', 'profiles-folder'] as const).filter((k) => cli[k] !== undefined);
    if (realmOnly.length > 0) throw new SettingsError(`${realmOnly.map((k) => `--${k}`).join(', ')} only valid with --target realm`);
    target = { kind: 'bds', host, port, transport, offline: true };
    server = `${host}:${port} (${transport})`;
  }

  const logLevel = (cli['log-level'] ?? cfg.logLevel ?? 'info') as Settings['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new SettingsError(`bad --log-level "${logLevel}"`);
  const logDir = cli['log-dir'] !== undefined ? path(cli['log-dir']) : (cfg.logDir ?? env.defaultLogDir);
  const metricsIntervalS = seconds(cli['metrics-interval'], '--metrics-interval', false) ?? cfg.metricsInterval ?? DEFAULT_METRICS_INTERVAL_S;
  const nudgeIntervalS = seconds(cli['nudge-interval'], '--nudge-interval', true) ?? cfg.nudgeInterval ?? DEFAULT_NUDGE_INTERVAL_S;
  const hp = int(cli['health-port'], '--health-port', 0, 65535) ?? cfg.healthPort;
  const durationS = seconds(cli.duration, '--duration', false);
  const respawnDelayMs = cli['respawn-delay'] !== undefined ? Number(cli['respawn-delay']) * 1000 : 2000;
  if (!Number.isFinite(respawnDelayMs)) throw new SettingsError(`bad --respawn-delay "${cli['respawn-delay']}"`);
  const recordDefault = target.kind === 'realm' && !cli['no-record'] && (cfg.realm?.record ?? true);
  const record =
    cli.record !== undefined ? path(cli.record) : recordDefault ? join(logDir, `realm-${(env.now ?? new Date()).toISOString().replace(/[:.]/g, '-')}.jsonl.gz`) : undefined;
  const owners = [...(cli.owner ?? []), ...(cli.owner?.length ? [] : (cfg.owners ?? [])), ...(env.botOwners ? [env.botOwners] : [])];
  return {
    task,
    target,
    server,
    version,
    username: target.kind === 'realm' ? target.accountName : (cli.username ?? cfg.username),
    logLevel,
    logDir,
    disconnectLog: cli['disconnect-log'] !== undefined ? path(cli['disconnect-log']) : join(logDir, 'disconnects.jsonl'),
    metricsFile: cli['metrics-file'] !== undefined ? path(cli['metrics-file']) : join(logDir, 'metrics.json'),
    metricsIntervalS,
    healthPort: hp === undefined || hp === 0 ? undefined : hp,
    reconnect: cli['no-reconnect'] ? false : (cfg.reconnect ?? true),
    record,
    recordRaw: cli['record-raw'] ?? false,
    durationS,
    exitOnChat: cli['exit-on-chat'],
    owners,
    consoleOwner: cli['no-console-owner'] ? false : (cfg.consoleOwner ?? true),
    common: {
      nudgeIntervalS,
      heartbeat: cli.heartbeat ?? cfg.heartbeat ?? false,
      home: vec(cli.home, '--home') ?? fromTuple(cfg.home),
      shelter: vec(cli.shelter, '--shelter') ?? fromTuple(cfg.shelter),
      // A Realm bot always carries the movement stack so !home set / !home go / !goto work without a flag.
      walk: cli.walk ?? cfg.walk ?? target.kind === 'realm',
      respawnDelayMs,
    },
    updateCheckHours: seconds(cli['update-check-hours'], '--update-check-hours', true) ?? cfg.updateCheckHours ?? (target.kind === 'realm' ? 24 : 0),
    taskConfig: cfg.tasks?.[task] ?? {},
  };
}
