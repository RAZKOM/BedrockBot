#!/usr/bin/env node
// Push main to the Mac server's bare repo and run deploy/mac/update.sh there (deploy/mac/README.md).
//
//   BEDROCKBOT_DEPLOY_HOST=<ssh host> pnpm deploy:mac
//   BEDROCKBOT_DEPLOY_HOST=<ssh host> pnpm deploy:mac -- --force   # after the history was rewritten
//
// The host is whatever `ssh <host>` accepts (an alias from ~/.ssh/config, or user@address). It is read
// from the environment so no machine name lives in the repository. `--force` force-pushes main and makes
// the Mac's checkout follow it with a hard reset instead of a pull.
//
// Every step is checked: a failed push or a failed update stops here with its exit code.
import { spawnSync } from 'node:child_process';

const host = process.env.BEDROCKBOT_DEPLOY_HOST ?? '';
if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(host)) {
  console.error('deploy:mac: set BEDROCKBOT_DEPLOY_HOST to the ssh host of the Mac (an alias from ~/.ssh/config or user@address).');
  console.error('  PowerShell: $env:BEDROCKBOT_DEPLOY_HOST = "mac"     (persist with: setx BEDROCKBOT_DEPLOY_HOST mac)');
  console.error('  bash:       export BEDROCKBOT_DEPLOY_HOST=mac');
  process.exit(2);
}
const force = process.argv.slice(2).includes('--force');

function run(label, cmd, args) {
  console.log(`deploy:mac: ${label}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error) {
    console.error(`deploy:mac: cannot run ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`deploy:mac: ${label} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

const sync = force ? 'git fetch -q origin && git reset -q --hard origin/main' : 'git pull -q';
run(`push main to ${host}`, 'git', ['push', ...(force ? ['--force'] : []), `${host}:bedrockbot.git`, 'main']);
run(`update and restart on ${host}`, 'ssh', [host, `cd ~/BedrockBot && ${sync} && bash deploy/mac/update.sh`]);
