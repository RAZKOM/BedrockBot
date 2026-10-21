// `pnpm config:init [--path <file>] [--force]` (PLAN.md task 5.5): writes a commented example config
// to the default location (%LOCALAPPDATA%\bedrockbot\config.json on Windows, ~/.bedrockbot/config.json
// elsewhere), or to --path / BEDROCKBOT_CONFIG. Never overwrites without --force. Refuses a path
// inside the repository (the file may hold your Realm's name and your gamertag).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isInside, REPO_ROOT } from '../connection/realm.ts';
import { defaultConfigPath, locateConfig, parseConfig } from './config.ts';

export const EXAMPLE_CONFIG = `{
  // BedrockBot config (docs/runbook.md "Configuration"). JSON with // comments.
  // Precedence: command-line flag > this file > built-in default. Remove what you do not need.
  // Keep this file OUTSIDE the repository. It holds no password or token: Microsoft sign-in tokens
  // live in realm.profilesFolder after you sign in once with the device code.

  // Task when --task is not given: "afk" (stay online) or "echo" (print chat).
  "task": "afk",

  // ---- local BDS (the default target; offline mode) ----
  "host": "127.0.0.1",
  "port": 19132,
  "transport": "raknet",          // or "nethernet"
  // "username": "AfkBot",        // offline name (max 16 characters)
  // "version": "1.26.60",        // game version; default = the pinned one (docs/versions.md)

  // ---- Realm (used ONLY with --target realm on the command line, e.g. \`pnpm bot:realm\`) ----
  "realm": {
    "realmName": "Your Realm",      // exactly one of realmName, realmInvite, realmId
    // "realmInvite": "ABCDEF123",
    // "realmId": "1234567",
    "accountName": "bot",           // token cache key (a label), not the gamertag
    // "profilesFolder": "C:/Users/you/AppData/Local/bedrockbot/profiles",  // default; must be outside the repo
    "record": true                  // packet capture in logDir (contains chat and names: keep private)
  },

  // ---- chat commands (!status !pos !health !shelter !home !quit !help) ----
  "owners": ["YourGamertag"],       // names or "xuid:<xuid>"
  "consoleOwner": true,             // the BDS console may run commands too

  // ---- AFK ----
  "nudgeInterval": 240,             // seconds between keepalive nudges; 0 = never
  "heartbeat": false,               // also send an idle input every tick
  // "home": [0, -60, 0],           // feet block to walk back to after a respawn and at dawn
  // "shelter": [10, -60, 10],      // feet block to walk into at dusk (time 12000), left at dawn (23000)
  // "walk": true,                  // movement stack without home/shelter, so !home set / !shelter set work

  // ---- operations ----
  // "logDir": "C:/Users/you/AppData/Local/bedrockbot/logs",  // default bot/logs in the repo (git-ignored)
  "metricsInterval": 60,            // seconds between metrics.json writes
  "healthPort": 0,                  // e.g. 9464: GET http://127.0.0.1:9464/healthz and /metrics; 0 = off
  // "updateCheckHours": 24,        // check for new game/BDS/library versions; default 24 on a Realm, else off
  "reconnect": true,
  "logLevel": "info"
}
`;

function main(argv: string[]): number {
  // pnpm forwards `--` separators (`pnpm bot:afk -- --port 1` gives `--task afk -- --port 1`); no
  // command here takes positional arguments, so drop them all.
  const args = argv.filter((a) => a !== '--');
  let values: { path?: string; force?: boolean; print?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ args, options: { path: { type: 'string' }, force: { type: 'boolean' }, print: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (values.help) {
    console.log('usage: pnpm config:init [--path <file>] [--force] [--print]');
    return 0;
  }
  if (values.print) {
    process.stdout.write(EXAMPLE_CONFIG);
    return 0;
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const loc = locateConfig(values.path, process.env, cwd);
  const path = resolve(loc.path);
  if (isInside(path, REPO_ROOT)) {
    console.error(`refusing to write ${path}: it is inside the repository; keep the config outside it (default ${defaultConfigPath()})`);
    return 2;
  }
  if (existsSync(path) && !values.force) {
    console.error(`${path} already exists (use --force to overwrite)`);
    return 1;
  }
  parseConfig(EXAMPLE_CONFIG, dirname(path)); // the example must stay valid
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, EXAMPLE_CONFIG);
  console.log(`wrote ${path}\nedit it, then: pnpm bot:afk   (Realm: pnpm bot:realm, see docs/runbook.md)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
