// `pnpm bot:check` (Track REL1), the second half: the config file and its settings, the owners list, walking, the files
// that hold secrets (present or not: never read, never printed), the panel, the Realm sign-in cache, and the server
// (pinged only with --ping, and only the host the config or the command line names). Nothing here contacts Microsoft,
// Xbox Live, the Realm service or Discord. Pure apart from the injected I/O; unit-tested in test/unit/doctor.test.ts.
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ConfigError, defaultConfigPath, loadConfig, locateConfig, type BotConfig, type LoadedConfig } from '../config/config.ts';
import { resolveSettings, SettingsError, type Settings } from '../config/resolve.ts';
import { applyStartupSettings, resolveSettingsFile, RuntimeSettings, SETTING_KEYS, SettingError } from '../config/settings.ts';
import { defaultProfilesFolder, isInside, RealmGuardError, validateRealmTarget } from '../connection/realm.ts';
import type { Logger } from '../log.ts';
import type { Check } from './basic.ts';

/** The secret files the bot reads from the config directory (health/notify/discord.ts, discord-access.ts). */
export const WEBHOOK_FILE = 'discord-webhook.url';
export const BOT_TOKEN_FILE = 'discord-bot.token';
/** The example's owner, written by `pnpm config:init` (config/init.ts EXAMPLE_CONFIG). */
export const EXAMPLE_OWNER = 'YourGamertag';
export const EXAMPLE_REALM = 'Your Realm';

export interface DoctorOptions {
  config?: string | undefined;
  noConfig?: boolean | undefined;
  /** UDP ping of the target server (the config's host and port, or --host / --port). */
  ping?: boolean | undefined;
  host?: string | undefined;
  port?: string | undefined;
  transport?: string | undefined;
  /**
   * Track REL2: every flag given, as `pnpm bot:afk` parses them (config/cli-options.ts): merged with the config file the
   * way the bot merges them (`--walk`, `--health-port`, `--host`, `--set` ...). host / port / transport above win.
   */
  cli?: Readonly<Record<string, unknown>> | undefined;
}

export interface PingAnswer {
  protocol?: number | undefined;
  version?: string | undefined;
  motd?: string | undefined;
}

export interface SetupInput {
  opts: DoctorOptions;
  env: NodeJS.ProcessEnv;
  cwd: string;
  repoRoot: string;
  /** Default log directory (bot/logs). */
  defaultLogDir: string;
  exists(path: string): boolean;
  /** File names in a directory ([] when it does not exist). */
  list(dir: string): string[];
  /** Game version -> protocol, for the versions this build speaks (resolve.ts autoVersions + protocol.ts). */
  speaks: Readonly<Record<string, number>>;
  ping?(target: { host: string; port: number; transport: 'raknet' | 'nethernet' }): Promise<PingAnswer>;
  /** True when nothing listens on 127.0.0.1:<port>. */
  portFree?(port: number): Promise<boolean>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** prismarine-auth's token cache file prefix for an account label (its createHash: sha1, 6 hex characters). */
export function tokenCachePrefix(accountName: string): string {
  return `${createHash('sha1').update(accountName, 'binary').digest('hex').slice(0, 6)}_`;
}

function collector(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const keep = (m: string) => {
    lines.push(m);
  };
  return { log: { debug() {}, info() {}, warn: keep, error: keep }, lines };
}

/** The realm block: valid (one selector, a cache label, the token folder outside the repository) and signed in before or not. */
export function realmCheck(r: NonNullable<BotConfig['realm']>, i: Pick<SetupInput, 'env' | 'list' | 'repoRoot'>): Check {
  const folder = r.profilesFolder ?? defaultProfilesFolder(i.env);
  try {
    validateRealmTarget({ kind: 'realm', accountName: r.accountName ?? '', profilesFolder: folder, ...(r.realmName !== undefined ? { realmName: r.realmName } : {}), ...(r.realmInvite !== undefined ? { realmInvite: r.realmInvite } : {}), ...(r.realmId !== undefined ? { realmId: r.realmId } : {}) }, { repoRoot: i.repoRoot });
  } catch (e) {
    return { name: 'realm', level: 'fail', text: message(e), fix: e instanceof RealmGuardError ? 'fix the realm block of the config file (docs/runbook.md "Realm join")' : 'see docs/runbook.md "Realm join"' };
  }
  // the example's block is harmless: only `--target realm` reads it
  if (r.realmName === EXAMPLE_REALM) return { name: 'realm', level: 'info', text: `the example's realm block ("${EXAMPLE_REALM}"), read only by \`pnpm bot:realm\`: put your Realm's name there to use one, or remove it` };
  // prismarine-auth's token files for this label: counted by name, never opened
  const cached = r.accountName ? i.list(folder).filter((f) => f.startsWith(tokenCachePrefix(r.accountName!)) && f.endsWith('-cache.json')).length : 0;
  if (cached > 0) return { name: 'realm', level: 'ok', text: `account "${r.accountName}": signed in before (${cached} token cache file${cached === 1 ? '' : 's'} in ${folder}; delete them to sign out)` };
  return { name: 'realm', level: 'info', text: `account "${r.accountName}": not signed in yet; the first \`pnpm bot:realm\` prints a Microsoft link and a code: sign in there with the bot's own account (docs/getting-started.md "A Realm")` };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function setupChecks(i: SetupInput): Promise<Check[]> {
  const out: Check[] = [];
  const o = i.opts;

  // ---- the config file ----
  let loaded: LoadedConfig | undefined;
  let configPath: string | undefined;
  if (o.noConfig) {
    out.push({ name: 'config', level: 'info', text: '--no-config: no config file read, all defaults (the bot saves no settings, waypoints or history)' });
  } else {
    const loc = locateConfig(o.config, i.env, i.cwd);
    configPath = loc.path;
    try {
      loaded = loadConfig(loc);
    } catch (e) {
      const fix = e instanceof ConfigError && e.message.includes('does not exist') ? `create it with \`pnpm config:init --path ${loc.path}\`, or drop ${loc.source === 'flag' ? '--config' : 'BEDROCKBOT_CONFIG'}` : `edit ${loc.path}: the message names the field (docs/runbook.md "Configuration")`;
      out.push({ name: 'config', level: 'fail', text: message(e), fix });
      return out; // the rest reads the config
    }
    if (!loaded.path) out.push({ name: 'config', level: 'info', text: `no config file at ${loc.path}: built-in defaults (nobody but the server console may command the bot)`, fix: '`pnpm config:init` writes a commented one there' });
    else if (isInside(loaded.path, i.repoRoot)) out.push({ name: 'config', level: 'warn', text: `${loaded.path} is inside the repository`, fix: `move it outside (default ${defaultConfigPath(i.env)}): it names your gamertag and maybe your Realm, and settings are not saved next to it` });
    else out.push({ name: 'config', level: 'ok', text: `${loaded.path} (${loc.source === 'default' ? 'the default place' : loc.source === 'env' ? 'from BEDROCKBOT_CONFIG' : 'from --config'})` });
  }
  const cfg: BotConfig = loaded?.config ?? {};

  // ---- merged settings (the same merge the bot does at start) ----
  let settings: Settings | undefined;
  const flags: Record<string, unknown> = { ...o.cli };
  for (const k of ['host', 'port', 'transport'] as const) if (o[k] !== undefined) flags[k] = o[k];
  const cliText = (k: string): string | undefined => {
    const v = flags[k];
    return typeof v === 'string' ? v : undefined;
  };
  const cliSet = Array.isArray(flags.set) ? flags.set.filter((x): x is string => typeof x === 'string') : undefined;
  try {
    settings = resolveSettings({ ...flags, task: cliText('task') ?? 'afk' }, cfg, { cwd: i.cwd, defaultLogDir: i.defaultLogDir, botOwners: i.env.BOT_OWNERS, botVersion: i.env.BOT_VERSION, panelToken: i.env.BEDROCKBOT_PANEL_TOKEN });
  } catch (e) {
    out.push({ name: 'settings', level: 'fail', text: message(e), fix: e instanceof SettingsError && message(e).includes('PANEL_TOKEN') ? 'fix or unset BEDROCKBOT_PANEL_TOKEN' : 'fix the option or the config field it names' });
  }
  const runtime = new RuntimeSettings();
  try {
    applyStartupSettings(runtime, { config: cfg.settings, configNudge: cfg.nudgeInterval, cliSet, cliNudge: cliText('nudge-interval') });
  } catch (e) {
    out.push({ name: 'settings', level: 'fail', text: message(e), fix: `edit the "settings" block of ${configPath ?? 'the config file'}; \`!help settings\` in the game lists the keys` });
  }
  if (!o.noConfig) {
    try {
      const where = resolveSettingsFile({ flag: cliText('settings'), env: i.env.BEDROCKBOT_SETTINGS, configPath, cwd: i.cwd, repoRoot: i.repoRoot });
      if (where.warning) out.push({ name: 'settings', level: 'warn', text: where.warning, fix: 'keep the config file outside the repository' });
      if (where.file && i.exists(where.file)) {
        const c = collector();
        const file = RuntimeSettings.open(where.file, { log: c.log });
        // what the bot runs with: defaults < settings.json < the config's settings block
        for (const k of SETTING_KEYS) if (runtime.source(k) === 'default' && file.source(k) === 'file') runtime.applyStartup(k, file.get(k));
        if (c.lines.length > 0) out.push({ name: 'settings', level: 'warn', text: `${where.file}: ${c.lines.length} value${c.lines.length === 1 ? '' : 's'} ignored (${c.lines[0]})`, fix: 'set it again with `!set <key> <value>` in the game, or remove the line' });
        else out.push({ name: 'settings', level: 'ok', text: `${where.file} (what \`!set\` saved)` });
      } else if (where.file) {
        out.push({ name: 'settings', level: 'info', text: `no settings.json yet (written by the first \`!set\`, next to the config file)` });
      }
    } catch (e) {
      if (e instanceof SettingError) out.push({ name: 'settings', level: 'fail', text: message(e), fix: 'fix the JSON in that file, or delete it (it only holds what `!set` saved)' });
      else throw e;
    }
  }

  // ---- owners ----
  const owners = (settings?.owners ?? cfg.owners ?? [])
    .flatMap((e) => e.split(','))
    .map((e) => e.trim())
    .filter(Boolean);
  const where = configPath ? `"owners" in ${configPath}` : 'the config file\'s "owners"';
  if (owners.length === 0) out.push({ name: 'owners', level: 'warn', text: 'nobody may command the bot from the game chat (only the server console)', fix: `add your gamertag to ${where}, or start the bot with --owner <gamertag>` });
  else if (owners.some((n) => n === EXAMPLE_OWNER)) out.push({ name: 'owners', level: 'warn', text: `still the example's "${EXAMPLE_OWNER}"`, fix: `replace it with your gamertag in ${where}` });
  else out.push({ name: 'owners', level: 'ok', text: `${owners.length} (${owners.length === 1 ? 'one name' : 'names'} the bot takes commands from; the server console too unless "consoleOwner" is false)` });

  // ---- walking ----
  if (settings?.target.kind === 'bds' && !settings.common.walk && !settings.common.home && !settings.common.shelter)
    out.push({ name: 'walking', level: 'warn', text: 'off: !come, !goto, !get and every command that moves answer "needs a task that can walk"', fix: `add "walk": true to ${configPath ?? 'the config file'}, or start with --walk` });
  else if (settings) out.push({ name: 'walking', level: 'ok', text: 'on' });

  // ---- the server ----
  if (settings?.target.kind === 'bds') {
    const t = settings.target;
    const label = `${t.host}:${t.port} (${t.transport})`;
    if (!LOOPBACK.has(t.host)) out.push({ name: 'server', level: 'info', text: `${label}: the bot joins in offline mode, so that server must run with online-mode=false; anyone who can reach it can join under any name, an owner's too (keep it on your own network)` });
    if (!o.ping || !i.ping) {
      out.push({ name: 'server', level: 'info', text: `${label}: not checked (\`pnpm bot:check --ping\` sends it one UDP ping)` });
    } else {
      try {
        const a = await i.ping({ host: t.host, port: t.port, transport: t.transport });
        const versions = Object.entries(i.speaks).filter(([, p]) => p === a.protocol).map(([v]) => v);
        const what = `answers: protocol ${a.protocol ?? '?'}, game ${a.version ?? '?'}${a.motd ? `, "${a.motd}"` : ''}`;
        if (a.protocol !== undefined && versions.length === 0) out.push({ name: 'server', level: 'fail', text: `${label} ${what}; this build speaks ${Object.entries(i.speaks).map(([v, p]) => `${v} (${p})`).join(', ')}`, fix: 'run a server of a version the bot speaks (docs/versions.md), or update the bot' });
        else out.push({ name: 'server', level: 'ok', text: `${label} ${what}${versions.length ? `; the bot speaks it as ${versions[0]}` : ''}` });
      } catch (e) {
        out.push({ name: 'server', level: 'fail', text: `${label}: no answer (${message(e)})`, fix: `start the server (the local test server: \`pnpm bds:up\`), check "host" and "port", and that UDP ${t.port} is open in the firewall` });
      }
    }
  }

  // ---- the Realm (used only with --target realm on the command line) ----
  if (cfg.realm) out.push(realmCheck(cfg.realm, i));

  // ---- the panel ----
  if (settings) {
    const port = settings.panel.port ?? settings.healthPort;
    const token = i.env.BEDROCKBOT_PANEL_TOKEN ? 'set (BEDROCKBOT_PANEL_TOKEN)' : cfg.panel?.token ? 'set (config panel.token)' : 'not set';
    if (port === undefined) out.push({ name: 'panel', level: 'info', text: 'off (set "healthPort", e.g. 9464, or start with --health-port 9464 for the page on http://127.0.0.1:<port>/)' });
    else {
      const lan = !LOOPBACK.has(settings.panel.host);
      if (lan && token === 'not set') out.push({ name: 'panel', level: 'fail', text: `panel.host ${settings.panel.host} without a token: the bot serves on 127.0.0.1 only`, fix: 'add a panel.token (`pnpm config:init --print` shows one) or keep panel.host 127.0.0.1' });
      else out.push({ name: 'panel', level: 'ok', text: `port ${port} on ${lan ? `${settings.panel.host} (your network; never port-forward it)` : '127.0.0.1 (this machine only)'}, token ${token}` });
      if (i.portFree && !(await i.portFree(port))) out.push({ name: 'panel', level: 'warn', text: `port ${port} is in use (another bot, or another program)`, fix: 'stop it, or pick another "healthPort" / --health-port' });
    }
  }

  // ---- Discord (secrets: present or not, never read) ----
  const dir = configPath ? dirname(configPath) : undefined;
  const hook = i.env.BEDROCKBOT_DISCORD_WEBHOOK ? 'set (BEDROCKBOT_DISCORD_WEBHOOK)' : dir && !o.noConfig && i.exists(join(dir, WEBHOOK_FILE)) ? `set (${WEBHOOK_FILE})` : 'not set';
  const tok = i.env.BEDROCKBOT_DISCORD_TOKEN ? 'set (BEDROCKBOT_DISCORD_TOKEN)' : dir && !o.noConfig && i.exists(join(dir, BOT_TOKEN_FILE)) ? `set (${BOT_TOKEN_FILE})` : 'not set';
  const notify = runtime.get('notifyDiscord') === true;
  const dbot = runtime.get('discordBot') === true;
  const users = String(runtime.get('discordUsers') ?? '').trim();
  if (notify && hook === 'not set') out.push({ name: 'discord', level: 'warn', text: 'notifyDiscord is on but no webhook URL is set: nothing is sent', fix: `put the URL in ${dir ? join(dir, WEBHOOK_FILE) : WEBHOOK_FILE} or env BEDROCKBOT_DISCORD_WEBHOOK (docs/away.md "Discord")` });
  if (dbot && tok === 'not set') out.push({ name: 'discord', level: 'warn', text: 'discordBot is on but no bot token is set: nothing connects', fix: `put the token in ${dir ? join(dir, BOT_TOKEN_FILE) : BOT_TOKEN_FILE} or env BEDROCKBOT_DISCORD_TOKEN (docs/discord.md)` });
  if (dbot && (users === '' || users === 'none')) out.push({ name: 'discord', level: 'warn', text: 'discordBot is on but discordUsers is empty: nobody may command it from Discord', fix: 'set discordUsers to your Discord user id (docs/discord.md)' });
  if (dir && i.repoRoot && isInside(dir, i.repoRoot) && (hook.includes('(discord') || tok.includes('(discord'))) out.push({ name: 'discord', level: 'warn', text: 'a Discord secret file lies inside the repository', fix: 'move the config directory outside the repository; never commit those files' });
  out.push({ name: 'discord', level: 'info', text: `webhook ${hook}, bot token ${tok}; notifyDiscord ${notify ? 'on' : 'off'}, discordBot ${dbot ? 'on' : 'off'} (both off by default)` });

  // ---- natural language ----
  if (settings) out.push({ name: 'nl', level: 'info', text: settings.nl.provider === 'none' ? '`!do` is off (no "nl" block; docs/natural-language.md)' : `\`!do\` asks ${settings.nl.provider} at ${settings.nl.url} (not checked)` });
  return out;
}
