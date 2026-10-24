// Config file (PLAN.md task 5.5): bot settings, including the Realm target fields, live in a JSON file
// outside the repository so nobody types them on a command line and nothing private is committed.
//
//   path: --config <file>, else env BEDROCKBOT_CONFIG, else %LOCALAPPDATA%\bedrockbot\config.json
//         (Windows) or ~/.bedrockbot/config.json. A missing default file is fine (all defaults);
//         a missing file named by --config / BEDROCKBOT_CONFIG is an error.
//   format: JSON; `//` and `/* */` comments are allowed (`pnpm config:init` writes a commented example).
//   precedence: CLI flag > config file > built-in default.
//   safety: the file can hold the Realm details, but only `--target realm` on the command line
//   selects the Realm (target "realm" is refused in the file).
//
// The file holds no secrets: Microsoft sign-in tokens stay in `realm.profilesFolder` (prismarine-auth's
// cache, written after the human's device-code sign-in), which must be outside the repository
// (connection/realm.ts guard rails, applied after merging).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { NlConfigSchema } from '../nl/provider.ts'; // Track Y

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const port = z.number().int().min(1).max(65535);

export const RealmConfigSchema = z
  .object({
    /** Realm name as listed for the bot account. Exactly one of realmName, realmInvite, realmId. */
    realmName: z.string().min(1).optional(),
    realmInvite: z.string().min(1).optional(),
    realmId: z.string().min(1).optional(),
    /** Token cache key (a local label such as "bot"), not the gamertag. */
    accountName: z.string().min(1).optional(),
    /** Token cache directory; must be outside the repository. Relative paths are relative to the config file. */
    profilesFolder: z.string().min(1).optional(),
    /** Write the packet capture for Realm sessions (default true). */
    record: z.boolean().optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    $schemaVersion: z.literal(1).optional(),
    task: z.string().min(1).optional(),
    /**
     * Only 'bds' here: going online is always an explicit `--target realm` on the command line (or
     * `pnpm bot:realm`), so a config file can never make a plain run (or a test) join a Realm.
     */
    target: z.literal('bds', { error: 'only "bds" is allowed in the config file; choose a Realm with --target realm on the command line' }).optional(),
    /** Build the movement stack even without home/shelter (so !home set / !shelter set work). */
    walk: z.boolean().optional(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'game version like 1.26.60').optional(),
    host: z.string().min(1).optional(),
    port: port.optional(),
    transport: z.enum(['raknet', 'nethernet']).optional(),
    username: z.string().min(1).max(16).optional(),
    realm: RealmConfigSchema.optional(),
    /** Chat command owners: player names or "xuid:<xuid>". */
    owners: z.array(z.string().min(1)).optional(),
    /** Accept commands typed into the server console (default true). */
    consoleOwner: z.boolean().optional(),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    /** Log directory; relative paths are relative to the config file. */
    logDir: z.string().min(1).optional(),
    metricsInterval: z.number().positive().optional(),
    /** 127.0.0.1 port for GET /healthz and /metrics; 0 or absent = off. */
    healthPort: z.number().int().min(0).max(65535).optional(),
    reconnect: z.boolean().optional(),
    nudgeInterval: z.number().min(0).optional(),
    heartbeat: z.boolean().optional(),
    /** AFK home point (feet, block coordinates); the bot walks back after respawning or at dawn. */
    home: vec3.optional(),
    /** Night shelter (feet); the bot walks there at dusk and leaves at dawn. */
    shelter: vec3.optional(),
    /** Hours between update checks inside the bot; 0 = off. */
    updateCheckHours: z.number().min(0).optional(),
    /** Free-form per-task options, e.g. { "gather": { ... } }. */
    tasks: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    /**
     * Runtime settings at start-up (Track Q, config/settings.ts; `!set` lists the keys), e.g.
     * { "allowBreak": true, "guardRadius": 24 }. They win over settings.json at start-up; keys and
     * bounds are checked when the bot starts.
     */
    settings: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
    nl: NlConfigSchema.optional(), // Track Y: { provider: 'ollama' | 'none', url, model, timeoutMs } (docs/natural-language.md)
  })
  .strict();

export type BotConfig = z.infer<typeof ConfigSchema>;
export type RealmConfig = z.infer<typeof RealmConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Default config path: %LOCALAPPDATA%\bedrockbot\config.json on Windows, ~/.bedrockbot/config.json elsewhere. */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'bedrockbot', 'config.json');
  return join(home, '.bedrockbot', 'config.json');
}

export interface ConfigLocation {
  path: string;
  /** Where the path came from; a missing default file is not an error. */
  source: 'flag' | 'env' | 'default';
}

export function locateConfig(flag: string | undefined, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): ConfigLocation {
  if (flag) return { path: resolve(cwd, flag), source: 'flag' };
  if (env.BEDROCKBOT_CONFIG) return { path: resolve(cwd, env.BEDROCKBOT_CONFIG), source: 'env' };
  return { path: defaultConfigPath(env), source: 'default' };
}

/** Remove `//` line comments and block comments outside of strings, and trailing commas. */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Parse and validate config text. Relative paths in it are resolved against `baseDir`. */
export function parseConfig(text: string, baseDir: string, label = 'config'): BotConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch (e) {
    throw new ConfigError(`${label}: not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
    throw new ConfigError(`${label}: ${issues.join('; ')}`);
  }
  const cfg = r.data;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  if (cfg.logDir) cfg.logDir = abs(cfg.logDir);
  if (cfg.realm?.profilesFolder) cfg.realm.profilesFolder = abs(cfg.realm.profilesFolder);
  return cfg;
}

export interface LoadedConfig {
  config: BotConfig;
  /** The file that was read, or undefined when the default file does not exist. */
  path: string | undefined;
  location: ConfigLocation;
}

export function loadConfig(location: ConfigLocation): LoadedConfig {
  if (!existsSync(location.path)) {
    if (location.source !== 'default') throw new ConfigError(`config file ${location.path} (from ${location.source === 'flag' ? '--config' : 'BEDROCKBOT_CONFIG'}) does not exist`);
    return { config: {}, path: undefined, location };
  }
  const text = readFileSync(location.path, 'utf8');
  return { config: parseConfig(text, dirname(location.path), location.path), path: location.path, location };
}

/** Parse "x,y,z" (CLI) into a vector. */
export function parseVec3(s: string): [number, number, number] | undefined {
  const parts = s.split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!];
}
