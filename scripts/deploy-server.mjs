#!/usr/bin/env node
// Deploy main to a server over ssh (deploy/README.md): push to a bare repo on the server, update the
// checkout there, then run deploy/update.sh (install, lint, unit tests, restart the service).
// Works for any macOS or Linux host you can ssh to.
//
//   BEDROCKBOT_DEPLOY_HOST=<host> pnpm deploy:server                update the server
//   BEDROCKBOT_DEPLOY_HOST=<host> pnpm deploy:server -- --init      first time: create the bare repo and the checkout
//   BEDROCKBOT_DEPLOY_HOST=<host> pnpm deploy:server -- --force     after the history was rewritten
//   ... -- --dry-run                                                 print the commands, run nothing
//
// Environment (no machine name lives in the repository):
//   BEDROCKBOT_DEPLOY_HOST  required: whatever `ssh <host>` accepts (an alias from ~/.ssh/config, or user@address)
//   BEDROCKBOT_DEPLOY_DIR   the checkout on the server, relative to its home directory (default BedrockBot)
//   BEDROCKBOT_DEPLOY_REPO  the bare repo on the server, relative to its home directory (default bedrockbot.git)
//
// `--force` force-pushes main and makes the server's checkout follow it with a hard reset instead of a pull.
// Every step is checked: a failed push or a failed update stops here with its exit code.
import { spawnSync } from 'node:child_process';

const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

function fail(message, code = 2) {
  console.error(`deploy:server: ${message}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const known = new Set(['--init', '--force', '--dry-run']);
for (const a of args) if (!known.has(a)) fail(`unknown option ${a} (use --init, --force or --dry-run)`);
const init = args.includes('--init');
const force = args.includes('--force');
const dry = args.includes('--dry-run');
if (init && force) fail('--init and --force do not combine');

const host = process.env.BEDROCKBOT_DEPLOY_HOST ?? '';
const dir = process.env.BEDROCKBOT_DEPLOY_DIR ?? 'BedrockBot';
const repo = process.env.BEDROCKBOT_DEPLOY_REPO ?? 'bedrockbot.git';
if (!SAFE_HOST.test(host)) {
  console.error('deploy:server: set BEDROCKBOT_DEPLOY_HOST to the ssh host of the server (an alias from ~/.ssh/config or user@address).');
  console.error('  PowerShell: $env:BEDROCKBOT_DEPLOY_HOST = "myserver"     (persist with: setx BEDROCKBOT_DEPLOY_HOST myserver)');
  console.error('  bash:       export BEDROCKBOT_DEPLOY_HOST=myserver');
  process.exit(2);
}
for (const [name, value] of [['BEDROCKBOT_DEPLOY_DIR', dir], ['BEDROCKBOT_DEPLOY_REPO', repo]]) {
  if (!SAFE_PATH.test(value) || value.split('/').includes('..')) fail(`${name} must be a plain relative path (letters, digits, . _ - /), got ${JSON.stringify(value)}`);
}

/** The steps, as [label, command, arguments]. The remote command strings run in the server's shell, after `cd` to the checkout. */
function plan() {
  if (init) {
    return [
      ['create the bare repo on the server (if missing)', 'ssh', [host, `test -d ${repo} || git init -q --bare ${repo}`]],
      [`push main to ${host}`, 'git', ['push', `${host}:${repo}`, 'main']],
      ['create the checkout on the server (if missing)', 'ssh', [host, `test -d ${dir} || git clone -q ${repo} ${dir}`]],
    ];
  }
  const sync = force ? 'git fetch -q origin && git reset -q --hard origin/main' : 'git pull -q';
  return [
    [`push main to ${host}`, 'git', ['push', ...(force ? ['--force'] : []), `${host}:${repo}`, 'main']],
    [`update and restart on ${host}`, 'ssh', [host, `cd ${dir} && ${sync} && bash deploy/update.sh`]],
  ];
}

for (const [label, cmd, cmdArgs] of plan()) {
  console.log(`deploy:server: ${label}`);
  if (dry) {
    console.log(`  $ ${[cmd, ...cmdArgs.map((a) => (/[\s&|;]/.test(a) ? JSON.stringify(a) : a))].join(' ')}`);
    continue;
  }
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
  if (r.error) fail(`cannot run ${cmd}: ${r.error.message}`, 1);
  if (r.status !== 0) fail(`${label} failed (exit ${r.status ?? r.signal})`, r.status ?? 1);
}
if (init) {
  console.log('deploy:server: the server has the repo. Next: install Node and the dependencies there, sign in once, and install the service (deploy/README.md), then run without --init.');
}
