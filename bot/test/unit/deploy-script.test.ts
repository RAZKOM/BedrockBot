// scripts/deploy-server.mjs (deploy/README.md): the commands it would run, and the input it refuses.
// Everything goes through --dry-run, so no test touches ssh or git.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/deploy-server.mjs', import.meta.url));

function run(args: string[], env: Record<string, string | undefined>): { status: number | null; out: string[]; err: string } {
  const merged: NodeJS.ProcessEnv = { ...process.env, BEDROCKBOT_DEPLOY_HOST: undefined, BEDROCKBOT_DEPLOY_DIR: undefined, BEDROCKBOT_DEPLOY_REPO: undefined, ...env };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: merged, encoding: 'utf8' });
  return { status: r.status, out: r.stdout.split('\n').filter(Boolean), err: r.stderr };
}

describe('deploy-server: the commands', () => {
  it('update: push main, then pull and run update.sh in the checkout', () => {
    const r = run(['--dry-run'], { BEDROCKBOT_DEPLOY_HOST: 'myserver' });
    expect(r.status).toBe(0);
    expect(r.out).toEqual([
      'deploy:server: push main to myserver',
      '  $ git push myserver:bedrockbot.git main',
      'deploy:server: update and restart on myserver',
      '  $ ssh myserver "cd BedrockBot && git pull -q && bash deploy/update.sh"',
    ]);
  });

  it('--force: force-push, and the checkout is reset to origin/main instead of pulled', () => {
    const r = run(['--dry-run', '--force'], { BEDROCKBOT_DEPLOY_HOST: 'me@10.0.0.5' });
    expect(r.status).toBe(0);
    expect(r.out[1]).toBe('  $ git push --force me@10.0.0.5:bedrockbot.git main');
    expect(r.out[3]).toBe('  $ ssh me@10.0.0.5 "cd BedrockBot && git fetch -q origin && git reset -q --hard origin/main && bash deploy/update.sh"');
  });

  it('--init: bare repo, push, checkout; no update.sh yet', () => {
    const r = run(['--dry-run', '--init'], { BEDROCKBOT_DEPLOY_HOST: 'srv' });
    expect(r.status).toBe(0);
    expect(r.out.filter((l) => l.startsWith('  $ '))).toEqual([
      '  $ ssh srv "test -d bedrockbot.git || git init -q --bare bedrockbot.git"',
      '  $ git push srv:bedrockbot.git main',
      '  $ ssh srv "test -d BedrockBot || git clone -q bedrockbot.git BedrockBot"',
    ]);
    expect(r.out.join('\n')).not.toContain('update.sh');
  });

  it('the checkout and the bare repo can be renamed (relative to the server home)', () => {
    const r = run(['--dry-run'], { BEDROCKBOT_DEPLOY_HOST: 'srv', BEDROCKBOT_DEPLOY_DIR: 'apps/bot', BEDROCKBOT_DEPLOY_REPO: 'git/bot.git' });
    expect(r.status).toBe(0);
    expect(r.out[1]).toBe('  $ git push srv:git/bot.git main');
    expect(r.out[3]).toBe('  $ ssh srv "cd apps/bot && git pull -q && bash deploy/update.sh"');
  });
});

describe('deploy-server: refusals (exit 2, nothing runs)', () => {
  it('no host: says how to set it', () => {
    const r = run(['--dry-run'], {});
    expect(r.status).toBe(2);
    expect(r.err).toContain('BEDROCKBOT_DEPLOY_HOST');
    expect(r.out).toEqual([]);
  });

  it.each(['-oProxyCommand=evil', 'host name', 'a;b', '$(id)', 'srv`id`'])('host %j', (host) => {
    const r = run(['--dry-run'], { BEDROCKBOT_DEPLOY_HOST: host });
    expect(r.status).toBe(2);
    expect(r.out).toEqual([]);
  });

  it.each(['../escape', '/abs/path', 'a/../b', 'dir; rm -rf ~', '-flag', 'with space'])('directory %j', (dir) => {
    const r = run(['--dry-run'], { BEDROCKBOT_DEPLOY_HOST: 'srv', BEDROCKBOT_DEPLOY_DIR: dir });
    expect(r.status).toBe(2);
    expect(r.err).toContain('BEDROCKBOT_DEPLOY_DIR');
    expect(r.out).toEqual([]);
  });

  it('an unknown option, and --init with --force', () => {
    expect(run(['--dry-run', '--wat'], { BEDROCKBOT_DEPLOY_HOST: 'srv' }).status).toBe(2);
    expect(run(['--dry-run', '--init', '--force'], { BEDROCKBOT_DEPLOY_HOST: 'srv' }).status).toBe(2);
  });
});
