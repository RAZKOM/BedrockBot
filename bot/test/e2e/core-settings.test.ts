// PLAN.md task 7.9 on bds-core (Track Q; docs/processes.md "Settings"): runtime settings from chat.
//   1. `!set guardRadius 8` changes the guard live: a zombie 12 blocks from home is left alone, and
//      fought as soon as `!set guardRadius 16` widens the radius again;
//   2. the value survives a restart of the bot PROCESS: CLI run 1 (`--settings <tmp file>`) takes
//      `!set guardRadius 8` and quits; CLI run 2 with the same file reports 8, ignores a zombie at 12
//      blocks and fights one at 5;
//   3. `--guard 1` exits with code 2 and one line (no stack trace).
// Needs BDS_E2E=1 and bds-core with the truth pack (`node scripts/bds.mjs --profile core up` and `... pack`).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PveTruth } from './pve-truth.ts';
import {
  armWithIronSword,
  centre,
  clearArea,
  connectPlayer,
  coreCmd,
  CORE_CONTAINER,
  E2E,
  FEET_Y,
  hdist,
  prepareServer,
  privateArea,
  sleep,
  startCli,
  startCoreBot,
  teleport,
  uniqueName,
  until,
  waitOnline,
  type CoreBot,
  type CoreCli,
} from './core-truth.ts';
import { CLI_TARGET_ARGS } from './env.ts';

const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

describe('core: CLI errors (task 7.8 item 4)', () => {
  it('--guard 1 exits 2 with one line on stderr', () => {
    const r = spawnSync(process.execPath, ['src/index.ts', '--task', 'afk', ...CLI_TARGET_ARGS, '--walk', '--guard', '1', '--port', '1'], { cwd: BOT_DIR, encoding: 'utf8', timeout: 60_000 });
    console.log(`--guard 1: exit ${r.status}, stderr ${JSON.stringify(r.stderr)}, stdout ${JSON.stringify(r.stdout)}`);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.trimEnd().split('\n')).toEqual(['error: guard radius must be 2..64, got 1']);
  });
});

describe.skipIf(!E2E)('core: runtime settings (task 7.9)', () => {
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-settings-'));
  let bot: CoreBot | undefined;

  beforeAll(async () => {
    await prepareServer();
  }, 60_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 48).catch(() => undefined);
      await bot.stop().catch(() => undefined);
    }
    rmSync(dir, { recursive: true, force: true });
    console.log(`measurements (area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  /** A slow, harmless zombie `dz` blocks south of home (it stays where it is summoned). */
  async function parkedZombie(truth: PveTruth, dz: number): Promise<{ entityId: string }> {
    const mob = await truth.summon('zombie', { x: HOME.x + 0.5, y: FEET_Y, z: HOME.z + 0.5 + dz });
    await truth.effect(mob.entityId, 'slowness', 120, 255);
    await truth.effect(mob.entityId, 'weakness', 120, 255);
    return mob;
  }

  it('!set guardRadius 8 changes the guard live', async () => {
    bot = await startCoreBot('CoreSet', { home: HOME }, { values: { guard: 'on' } });
    const b = bot;
    await teleport(b, centre(HOME));
    await b.truth.clearAround(centre(HOME), 48);
    await clearArea(b.truth, HOME, 16, 4);
    await armWithIronSword(b);
    await b.truth.setHealth(b.name, 20);
    expect(b.pve.behaviour()).toBe('guarding r=16');
    let n = b.said.length;
    await b.command('!set guardRadius 8');
    expect(await b.reply((s) => s.startsWith('guardRadius'), n)).toBe('guardRadius = 8 (was 16), not saved (no settings file)');
    expect(b.pve.behaviour()).toBe('guarding r=8');
    const far = await parkedZombie(b.truth, 12);
    await sleep(5000);
    expect(b.pve.stats.guardTriggers).toBe(0);
    expect((await b.truth.entity(far.entityId)).valid).not.toBe(false);
    const still = await b.truth.pos(b.name);
    expect(hdist(still.location, centre(HOME))).toBeLessThan(1);
    n = b.said.length;
    const t0 = Date.now();
    await b.command('!set guardRadius 16');
    await b.reply((s) => s.startsWith('guardRadius = 16'), n);
    await until(() => (b.pve.behaviour().startsWith('fighting zombie') ? true : undefined), 10_000, 'fight after widening', 50);
    const fightMs = Date.now() - t0;
    await until(async () => ((await b.truth.entity(far.entityId)).valid === false ? true : undefined), 60_000, 'zombie dead', 250);
    const line = `live: radius 8 -> zombie 12 blocks from home left alone for 5 s; !set guardRadius 16 -> fighting ${fightMs} ms after the command (chat round trip included), dead after ${Date.now() - t0} ms`;
    console.log(line);
    measurements.push(line);
    await b.stop();
    bot = undefined;
  }, 120_000);

  it('a !set value survives a restart of the bot process', async () => {
    const file = join(dir, 'settings.json');
    const observer = await connectPlayer(uniqueName('CoreObs'));
    const truth = new PveTruth(observer.conn, CORE_CONTAINER);
    let cli: CoreCli | undefined;
    const said = (name: string) => observer.heard.filter((h) => h.from.startsWith(name)).map((h) => h.message);
    try {
      await truth.tp(observer.name, { x: HOME.x + 0.5, y: FEET_Y, z: HOME.z - 20 + 0.5 }, 0, 0);
      const args = ['--settings', file, '--walk', '--home', `${HOME.x},${HOME.y},${HOME.z}`, '--guard', 'on'];
      // run 1: change the setting from chat, then quit
      cli = startCli(args);
      await waitOnline(truth, cli.name);
      await sleep(1000);
      const t0 = Date.now();
      await coreCmd('tell', cli.name, '!set', 'guardRadius', '8');
      const r1 = await until(() => said(cli!.name).find((m) => m.startsWith('guardRadius')), 10_000, 'run 1 reply', 100);
      expect(r1).toBe('guardRadius = 8 (was 16)');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ guardRadius: 8 });
      const setMs = Date.now() - t0;
      await coreCmd('tell', cli.name, '!quit');
      expect(await cli.exit).toBe(0);
      expect(cli.output()).toContain(`settings ${file}`);

      // run 2: same settings file, a new process
      cli = startCli(args);
      const name2 = cli.name;
      await waitOnline(truth, name2);
      await truth.tp(name2, centre(HOME), 0, 0);
      await sleep(3000);
      await coreCmd('tell', name2, '!set', 'guardRadius');
      const r2 = await until(() => said(name2).find((m) => m.startsWith('guardRadius')), 10_000, 'run 2 reply', 100);
      expect(r2).toBe('guardRadius 8 (2..64 blocks, default 16): guard: fight hostiles within this radius of home');
      await truth.ok('clear', [name2]);
      await truth.ok('give', [name2, 'iron_sword', 1]);
      await truth.setHealth(name2, 20);
      const far = await parkedZombie(truth, 12);
      await sleep(5000);
      expect((await truth.entity(far.entityId)).valid).not.toBe(false);
      expect(cli.output()).not.toMatch(/guard: zombie/);
      expect(hdist((await truth.pos(name2)).location, centre(HOME))).toBeLessThan(1);
      const t1 = Date.now();
      const near = await parkedZombie(truth, 5);
      await until(() => (/guard: zombie #\d+ within 8 blocks, fighting/.test(cli!.output()) ? true : undefined), 10_000, 'run 2 fights the near zombie', 100);
      const fightMs = Date.now() - t1;
      await until(async () => ((await truth.entity(near.entityId)).valid === false ? true : undefined), 60_000, 'near zombie dead', 250);
      expect((await truth.entity(far.entityId)).valid).not.toBe(false);
      const line = `restart: !set answered after ${setMs} ms and written to settings.json; run 2 read guardRadius 8 from it ("${r2.slice(0, 40)}..."), left a zombie at 12 blocks alone for 5 s, fought one at 5 blocks ${fightMs} ms after the summon`;
      console.log(line);
      measurements.push(line);
      await coreCmd('tell', name2, '!quit');
      expect(await cli.exit).toBe(0);
      cli = undefined;
    } finally {
      cli?.kill();
      await truth.cleanup().catch(() => undefined);
      await truth.clearAround(centre(HOME), 48).catch(() => undefined);
      await observer.close();
    }
    expect(existsSync(file)).toBe(true);
  }, 180_000);
});
