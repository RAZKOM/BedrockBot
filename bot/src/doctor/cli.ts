// `pnpm bot:check [--ping] [the flags of pnpm bot:afk]` (Track REL1, REL2: config/cli-options.ts is the flag table both
// read; docs/getting-started.md "Before the first start"). Also runs as `node bot/src/doctor/cli.ts` before any
// install. Checks this machine and the config, says what to do for each problem in one line, and exits 1 when something
// must be fixed. It contacts nothing, except one UDP ping of the configured (or given) server with --ping.
import { createServer } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { basicChecks, exitCode, formatReport, type Check } from './basic.ts';
import { AFK_OPTIONS, COMMON_OPTIONS } from '../config/cli-options.ts'; // dependency-free: parsed before the install is checked

const BOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const REPO_DIR = resolve(BOT_DIR, '..');

const USAGE = `usage: pnpm bot:check [--ping] [any flag of pnpm bot:afk: --config <file> | --no-config, --host, --port, --walk, --health-port, --set ...]
  checks Node, pnpm, the installed dependencies and patches, the config file and its settings, the owners list,
  walking, the panel, the secret files (present or not; never read), the Realm sign-in cache, and with --ping
  sends one UDP ping to the server the bot would join (the config's host and port, or --host / --port).
  The flags are read as the bot reads them (flag > config file > default), so pass the ones you start the bot with.
  It never contacts Microsoft, Xbox Live, the Realm service or Discord. Exit 1 when a FAIL line needs fixing.`;

/** `pnpm bot:afk`'s flags and the doctor's own `--ping`. */
const DOCTOR_OPTIONS = { ...COMMON_OPTIONS, ...AFK_OPTIONS, ping: { type: 'boolean' } } as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function json(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readText(path) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });
}

async function main(argv: string[]): Promise<number> {
  let values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  try {
    // Track REL2: the flags of `pnpm bot:afk` (the same table, config/cli-options.ts), so the check sees what they change
    ({ values } = parseArgs({ args: argv.filter((a) => a !== '--'), options: DOCTOR_OPTIONS, strict: true }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  console.log(`BedrockBot doctor: this machine and your config${values.ping ? ', and one ping of the server' : ''}`);
  const root = json(join(REPO_DIR, 'package.json'));
  const bot = json(join(BOT_DIR, 'package.json'));
  const checks: Check[] = basicChecks({
    nodeVersion: process.versions.node,
    engines: (root.engines as { node?: string } | undefined)?.node,
    packageManager: typeof root.packageManager === 'string' ? root.packageManager : undefined,
    userAgent: process.env.npm_config_user_agent,
    dependencies: (bot.dependencies ?? {}) as Record<string, string>,
    optional: (bot.optionalDependencies ?? {}) as Record<string, string>,
    botDir: BOT_DIR,
    readText,
  });
  if (exitCode(checks) !== 0) {
    console.log(formatReport(checks));
    console.log('(the config checks run once the lines above pass)');
    return 1;
  }
  // the dependencies are there: the config checks may import them now
  const { setupChecks } = await import('./setup.ts');
  const { autoVersions } = await import('../config/resolve.ts');
  const { supportedVersions } = await import('../connection/protocol.ts');
  const speaks = Object.fromEntries(autoVersions().map((v) => [v, supportedVersions[v] ?? 0]));
  const cwd = process.env.INIT_CWD ?? process.cwd();
  checks.push(
    ...(await setupChecks({
      opts: { config: str(values.config), noConfig: values['no-config'] === true, ping: values.ping === true, cli: values },
      env: process.env,
      cwd,
      repoRoot: REPO_DIR,
      defaultLogDir: join(BOT_DIR, 'logs'),
      exists: existsSync,
      list: (dir) => {
        try {
          return readdirSync(dir);
        } catch {
          return [];
        }
      },
      speaks,
      ping: async (t) => {
        const { default: bedrock } = await import('bedrock-protocol');
        const ad = t.transport === 'raknet' ? await bedrock.ping({ transport: 'raknet', host: t.host, port: t.port, timeout: 3000 }) : await bedrock.ping({ transport: 'nethernet', host: t.host, timeout: 3000 });
        return ad.transport === 'raknet' ? { protocol: Number(ad.protocol), version: ad.version, motd: ad.motd } : { protocol: ad.protocol ? Number(ad.protocol) : undefined, version: ad.gameVersion, motd: ad.motd };
      },
      portFree,
    })),
  );
  console.log(formatReport(checks));
  return exitCode(checks);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
