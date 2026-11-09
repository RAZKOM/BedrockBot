// Track I1 (docs/runbook.md "Tests on the Mac (Track I1)"): the test-host runner's guards, without ssh. The bench worker
// cap (bot/scripts/workers.ts), the runner's refusals and its --dry-run, the live bot's `!test` series read from its
// log (scripts/mac/live.mjs), and that the committed files name no machine or home folder.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { capWorkers } from '../../scripts/workers.ts';

const RUNNER = fileURLToPath(new URL('../../../scripts/mac-run.mjs', import.meta.url));
const LIVE = new URL('../../../scripts/mac/live.mjs', import.meta.url);
const COMMITTED = ['../../../scripts/mac-run.mjs', '../../../scripts/mac/remote.sh', '../../../scripts/mac/live.mjs', '../../../scripts/mac/bds.mjs', '../../../docker/compose.mac.yml'];

function run(args: string[], env: Record<string, string | undefined>): { status: number | null; out: string; err: string } {
  const merged: NodeJS.ProcessEnv = { ...process.env, BEDROCKBOT_TEST_HOST: undefined, BEDROCKBOT_DEPLOY_HOST: undefined, BEDROCKBOT_TEST_DIR: undefined, BEDROCKBOT_TEST_NODE: undefined, ...env };
  const r = spawnSync(process.execPath, [RUNNER, ...args], { env: merged, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe('bench worker cap (BEDROCKBOT_MAX_WORKERS)', () => {
  it('caps what was asked for, by default or by flag', () => {
    expect(capWorkers(8, '4')).toBe(4);
    expect(capWorkers(3, '4')).toBe(3);
    expect(capWorkers(10, '1')).toBe(1);
  });
  it('reads BEDROCKBOT_MAX_WORKERS by default', () => {
    vi.stubEnv('BEDROCKBOT_MAX_WORKERS', '2');
    expect(capWorkers(8)).toBe(2);
    vi.stubEnv('BEDROCKBOT_MAX_WORKERS', '');
    expect(capWorkers(8)).toBe(8);
    vi.unstubAllEnvs();
  });
  it('no cap when empty or not a positive number; never below 1', () => {
    expect(capWorkers(8, '')).toBe(8);
    expect(capWorkers(8, 'many')).toBe(8);
    expect(capWorkers(8, '0')).toBe(8);
    expect(capWorkers(0, '4')).toBe(1);
    expect(capWorkers(Number.NaN, '')).toBe(1);
  });
});

describe('mac-run: refusals and the dry run (no ssh)', () => {
  it('no host: exit 2 and says which variable to set', () => {
    const r = run(['--dry-run', '--', 'true'], {});
    expect(r.status).toBe(2);
    expect(r.err).toContain('BEDROCKBOT_TEST_HOST');
  });
  it('falls back to BEDROCKBOT_DEPLOY_HOST; the dry run names the copy and the command', () => {
    const r = run(['--dry-run', '--name', 'wt1', '--', 'BDS_E2E=1', 'pnpm', '--filter', 'bot', 'test:e2e', 'fly cave'], { BEDROCKBOT_DEPLOY_HOST: 'testbox' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('with testbox:~/bbtest.noindex/checkouts/wt1');
    // an assignment stays an assignment, a word with a space is quoted
    expect(r.out).toContain("would run on testbox: BDS_E2E=1 pnpm --filter bot test:e2e 'fly cave'");
  });
  it('refuses unsafe names and paths', () => {
    expect(run(['--dry-run', '--name', '../x', '--', 'true'], { BEDROCKBOT_TEST_HOST: 'h' }).status).toBe(2);
    expect(run(['--dry-run', '--', 'true'], { BEDROCKBOT_TEST_HOST: 'h', BEDROCKBOT_TEST_DIR: '/abs' }).status).toBe(2);
    expect(run(['--dry-run', '--', 'true'], { BEDROCKBOT_TEST_HOST: 'h', BEDROCKBOT_TEST_DIR: 'a/../b' }).status).toBe(2);
    expect(run(['--dry-run', '--', 'true'], { BEDROCKBOT_TEST_HOST: 'h;rm' }).status).toBe(2);
    expect(run(['--bogus', '--', 'true'], { BEDROCKBOT_TEST_HOST: 'h' }).status).toBe(2);
  });
  it('nothing to run: exit 2', () => {
    expect(run([], { BEDROCKBOT_TEST_HOST: 'h' }).status).toBe(2);
  });
});

describe('the live bot\'s !test series from its log (the wait rule)', async () => {
  const { seriesState } = (await import(LIVE.href)) as { seriesState: (lines: string[], now?: number) => { running: boolean; series?: string; run?: string; stale?: boolean } };
  const at = (min: number, rest: string) => `${new Date(Date.UTC(2026, 10, 9, 2, min)).toISOString()} INFO  [test] ${rest}`;
  const now = Date.UTC(2026, 10, 9, 2, 16);

  it('a series from its kit line to its summary line', () => {
    const lines = [at(10, 'test cave: kit elytra; records x.jsonl'), at(11, 'test cave 1/3: !fly cave_end from 1 2 3')];
    expect(seriesState(lines, now)).toMatchObject({ running: true, series: 'cave', run: '1/3' });
    lines.push(at(12, 'command /tp @s 1 2 3: ok commands.tp.success.coordinates (60 ms)'), at(13, 'test cave 1/3: arrived in 41 s; damage 0'));
    expect(seriesState(lines, now).running).toBe(true);
    lines.push(at(14, 'test cave: 1/3 arrived (1 of 3 runs, stopped), 41 s a run, damage 0, 0 deaths, flown 80%, 0 bail-outs; ends arrived 1'));
    expect(seriesState(lines, now).running).toBe(false);
  });
  it('a series that stopped logging (the bot restarted mid-run) is not waited for', () => {
    expect(seriesState([at(1, 'test cave 2/5: !fly cave_end from 1 2 3')], now)).toMatchObject({ running: false, stale: true });
  });
  it('other lines do not start one', () => {
    expect(seriesState([at(14, 'command /testfor @s: ok commands.testfor.success (62 ms)'), at(15, 'ops: probe ok: op')], now).running).toBe(false);
  });
});

describe('committed runner files name no machine, account or home folder', () => {
  it.each(COMMITTED)('%s', (rel) => {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    expect(text).not.toMatch(/\/Users\/[a-z]|\/home\/[a-z]|[A-Z]:[\\/]Users|\b(?:192\.168|10\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d+\.\d+\b/); // home paths, LAN / Tailscale addresses
  });
});
