// e2e (tag @bds), task 1.3: AFK keepalive against bds-dev.
//   BDS_E2E=1                 quick check: nudges keep the position (truth pos, within 0.01) and
//                             never draw a correct_player_move_prediction (~25 s)
//   BDS_E2E=1 BDS_SOAK=1      also the idle-kick soak (~7 min): recreates bds-dev with
//                             PLAYER_IDLE_TIMEOUT=1, runs `bot --task afk --nudge-interval 30` for
//                             3 min (no kick, no correction), then a control without nudges
//                             (any kick must be kicked_for_idle; BDS_IDLE_CONTROL_STRICT=1 requires
//                             one), then restores PLAYER_IDLE_TIMEOUT=0.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import { parseDisconnectLog } from '../../src/connection/disconnectLog.ts';
import type { MetricsSnapshot } from '../../src/connection/metrics.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { AfkTask } from '../../src/tasks/afk.ts';
import { BOT_DIR, bdsScript, connectObserver, E2E, HOST, PORT, SOAK, sleep, TARGET, truthQuery, VERSION, waitFor, type Observer } from './chat-helpers.ts';
import { CLI_TARGET_ARGS } from './env.ts';

interface TruthPos {
  location: Vec3;
  isOnGround: boolean;
  rotation: { pitch: number; yaw: number };
}

describe.skipIf(!E2E)('@bds AFK nudges against bds-dev', () => {
  let conn: Connection | undefined;
  afterAll(async () => {
    await conn?.disconnectAndFlush('test done');
  });

  it('nudges keep the position within 0.01 and draw no correction', async () => {
    conn = new Connection({ version: VERSION, username: 'E2EAfkNudge', logger: silentLogger, reconnect: false });
    const afk = new AfkTask(conn, { nudgeIntervalMs: 3_000, log: silentLogger });
    let corrections = 0;
    conn.on('correct_player_move_prediction', () => corrections++);
    afk.start();
    await conn.connect(TARGET);
    const c = conn;
    await sleep(1_000); // settle input processed
    const before = (await truthQuery(c, 'pos', ['E2EAfkNudge'])).data as unknown as TruthPos;

    await waitFor<void>((done) => afk.onEvent((e) => { if (e.kind === 'nudge' && e.n === 4) done(); }), 20_000, '4 nudges');
    await sleep(1_000); // a correction comes >= 5 ticks later
    const after = (await truthQuery(c, 'pos', ['E2EAfkNudge'])).data as unknown as TruthPos;
    console.log(`[keepalive] truth pos before ${JSON.stringify(before.location)} after ${JSON.stringify(after.location)} after 4 nudges; bot feet ${JSON.stringify(afk.feet)}`);
    for (const k of ['x', 'y', 'z'] as const) {
      expect(Math.abs(after.location[k] - before.location[k])).toBeLessThanOrEqual(0.01);
      expect(Math.abs(after.location[k] - afk.feet![k])).toBeLessThanOrEqual(0.01);
    }
    expect(after.isOnGround).toBe(true);
    expect(corrections).toBe(0);
    expect(afk.corrections).toBe(0);
    expect(c.state).toBe('spawned');
  }, 40_000);
});

interface CliRun {
  code: number | null;
  stderr: string;
  ms: number;
}

/** Run `node src/index.ts --task afk ...` until it exits (or is killed after maxMs). */
function runAfkCli(args: string[], maxMs: number): Promise<CliRun> {
  const t0 = Date.now();
  const child = spawn(process.execPath, ['src/index.ts', '--task', 'afk', '--host', HOST, '--port', String(PORT), ...CLI_TARGET_ARGS, ...args], {
    cwd: BOT_DIR,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const timer = setTimeout(() => child.kill(), maxMs);
  return new Promise((resolve) =>
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, ms: Date.now() - t0 });
    }),
  );
}

describe.skipIf(!E2E || !SOAK)('@bds @soak idle kick vs keepalive (PLAYER_IDLE_TIMEOUT=1)', () => {
  let dir: string;
  let observer: Observer | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bot-e2e-soak-'));
    const out = await bdsScript(['up'], { BDS_IDLE_TIMEOUT: '1' });
    console.log(`[soak] ${out.trim()}`);
    expect((await bdsScript(['idle'])).trim()).toBe('player-idle-timeout=1');
  }, 240_000);

  afterAll(async () => {
    observer?.close();
    const out = await bdsScript(['up'], { BDS_IDLE_TIMEOUT: '0' });
    console.log(`[soak] restored: ${out.trim()}`);
    expect((await bdsScript(['idle'])).trim()).toBe('player-idle-timeout=0');
    rmSync(dir, { recursive: true, force: true });
  }, 240_000);

  it('with a 30 s nudge the AFK bot survives 3 minutes: no kick, no correction, position unchanged', async () => {
    const logDir = join(dir, 'nudge');
    const run = await runAfkCli(['--username', 'E2ESoakNudge', '--nudge-interval', '30', '--duration', '180', '--metrics-interval', '30', '--no-reconnect', '--no-console-owner', '--log-dir', logDir], 200_000);
    expect(run.code, run.stderr).toBe(0);
    const metrics = JSON.parse(readFileSync(join(logDir, 'metrics.json'), 'utf8')) as MetricsSnapshot;
    const disc = parseDisconnectLog(readFileSync(join(logDir, 'disconnects.jsonl'), 'utf8'));
    console.log(`[soak] nudge run: exit ${run.code} after ${(run.ms / 1000).toFixed(0)} s, counters ${JSON.stringify(metrics.counters)}, kicks ${JSON.stringify(metrics.kicks)}, disconnects ${JSON.stringify(disc)}`);
    expect(metrics.kicks.total).toBe(0);
    expect(metrics.counters.nudges).toBeGreaterThanOrEqual(5);
    expect(metrics.counters.corrections ?? 0).toBe(0);
    expect(metrics.reconnects).toBe(0);
    expect(disc).toEqual([expect.objectContaining({ kind: 'client', reason: 'client: duration 180 s elapsed' })]);
    expect(run.stderr).not.toContain('kick');
    expect(run.stderr).not.toContain('correct_player_move_prediction');
  }, 220_000);

  it('control: without nudges, any kick is kicked_for_idle (strict mode requires one)', async () => {
    // Measured on BDS 1.26.51.1 (docs/runbook.md): the idle kick fired once (kicked_for_idle, empty
    // message, 63 s after the last input) and could not be reproduced in 15+ later attempts with
    // the same and varied inputs, so by default this run documents what happens instead of
    // requiring a kick. BDS_IDLE_CONTROL_STRICT=1 turns "no kick" into a failure.
    const logDir = join(dir, 'control');
    // A silent client (never sends player_auth_input) idles alongside.
    observer = await connectObserver('E2ESoakSilent');
    const run = await runAfkCli(['--username', 'E2ESoakIdle', '--nudge-interval', '0', '--duration', '150', '--no-reconnect', '--no-console-owner', '--metrics-interval', '30', '--log-dir', logDir], 170_000);
    const disc = parseDisconnectLog(readFileSync(join(logDir, 'disconnects.jsonl'), 'utf8'));
    const metrics = JSON.parse(readFileSync(join(logDir, 'metrics.json'), 'utf8')) as MetricsSnapshot;
    const kick = disc.find((d) => d.kind === 'kick');
    console.log(`[soak] control run: exit ${run.code} after ${(run.ms / 1000).toFixed(0)} s; ${kick ? `KICKED: ${JSON.stringify(kick)}` : 'no kick within 150 s'}; kicks ${JSON.stringify(metrics.kicks)}; silent observer ${observer.closed ? `closed ${JSON.stringify(observer.kick)}` : 'still connected'}`);
    expect(disc).toHaveLength(1);
    if (kick) {
      expect(run.code).toBe(1); // --no-reconnect: the kick ends the process
      expect(kick).toMatchObject({ kick: { reason: 'kicked_for_idle' }, reason: 'kicked: kicked_for_idle' });
      expect(kick.spawnedMs).toBeGreaterThanOrEqual(55_000);
      expect(metrics.kicks.byReason).toEqual({ kicked_for_idle: 1 });
    } else {
      expect(process.env.BDS_IDLE_CONTROL_STRICT, 'BDS did not idle-kick the bot without nudges').not.toBe('1');
      expect(run.code).toBe(0);
      expect(disc[0]).toMatchObject({ kind: 'client', reason: 'client: duration 150 s elapsed' });
    }
    expect(metrics.counters.nudges ?? 0).toBe(0);
  }, 200_000);
});
