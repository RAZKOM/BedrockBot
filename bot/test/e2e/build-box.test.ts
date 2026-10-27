// e2e (tag @bds), wave 9 Track AL (docs/build.md): `!build fill`, `!build clear` and `!build materials`
// on bds-build (flat, peaceful, truth pack). One afk-task bot (walking, the CLI's wiring) in its own
// random area:
//   materials  `!build materials wall ...` (10 x 4) with an empty inventory: the exact count
//   fill       a 5 x 3 x 5 cobblestone box 3 blocks from the bot with exactly 75 cobblestone (and 16
//              dirt as the keeper's throwaway reserve): truth:blocksdiff 0 differences, 0 cobblestone
//              left, the 16 dirt untouched; `!build status` while it runs
//   clear      the same box dug empty: blocksdiff 0 against air, the cobblestone picked up
// Env: BUILD_BDS_HOST / BUILD_BDS_PORT / BUILD_BDS_CONTAINER (build-truth.ts), BUILD_VERBOSE=1.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, settled, sleep, startBuildBot, teleport, type BuildBot } from './build-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds build: fill, clear, materials (Track AL)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const builds = mkdtempSync(join(tmpdir(), 'bedrockbot-builds-'));
  let bot: BuildBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const min: Vec3 = { x: area.x + 3, y: F, z: area.z + 3 };
  const max: Vec3 = { x: area.x + 7, y: F + 2, z: area.z + 7 };
  const box = `${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z}`;

  beforeAll(async () => {
    await prepareServer();
    bot = await startBuildBot('Build', builds);
    await teleport(bot, home);
    await clearArea(bot.truth, area, 20, 10);
    await sleep(500);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await clearArea(bot.truth, area, 20, 10).catch(() => undefined);
      await bot.truth.clearAround(home, 40).catch(() => undefined);
      await bot.stop();
    }
    rmSync(builds, { recursive: true, force: true });
    console.log(`[build-box e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('!build materials on a 10 x 4 wall with an empty inventory replies the exact count', async () => {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    await sleep(500);
    const from = b.said.length;
    await b.command(`!build materials wall ${area.x - 5} ${F} ${area.z - 6} ${area.x + 4} ${area.z - 6} 4 cobblestone`);
    const r = await b.reply((s) => s.startsWith('materials ') || s.startsWith('build: '), from);
    notes.push(`materials: ${r}`);
    expect(r).toBe('materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)');
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 60_000);

  it('!build fill builds a 5 x 3 x 5 cobblestone box from exactly enough blocks', async () => {
    const b = bot!;
    await b.truth.ok('give', [b.name, 'cobblestone', 64]);
    await b.truth.ok('give', [b.name, 'cobblestone', 11]);
    await b.truth.ok('give', [b.name, 'dirt', 16]);
    await sleep(800);
    let from = b.said.length;
    await b.command(`!build materials fill ${box} cobblestone`);
    const m = await b.reply((s) => s.startsWith('materials '), from);
    expect(m).toBe('materials for fill 5x3x5 cobblestone: 75 cobblestone; have everything');
    from = b.said.length;
    const t0 = Date.now();
    await b.command(`!build fill ${box} cobblestone`);
    const first = await b.reply((s) => s.startsWith('building ') || s.startsWith('build'), from);
    expect(first).toBe('building fill 5x3x5 cobblestone: 75 to place');
    await sleep(6000);
    const sFrom = b.said.length;
    await b.command('!build status');
    const status = await b.reply((s) => s.startsWith('build: '), sFrom);
    const end = await b.reply((s) => s.startsWith('build fill '), from, 400_000);
    const ms = Date.now() - t0;
    const diff = await b.truth.blocksDiff(min, max, () => 'cobblestone');
    const counts = await b.truth.counts(b.name);
    const feet = await settled(b);
    notes.push(`fill: ${status} | ${end} | ${(ms / 1000).toFixed(1)} s from the command | blocksdiff ${diff.diffs} of ${diff.count} ${JSON.stringify(diff.first.slice(0, 5))} | inventory ${JSON.stringify(counts)} | corrections ${b.built.mobility!.loop.state.corrections} | feet ${feet.x.toFixed(2)} ${feet.y.toFixed(2)} ${feet.z.toFixed(2)}`);
    expect(status).toMatch(/^build: \d+ \/ 75 placed, \d+ skipped(, eta \d+ (s|min))?$/);
    expect(end).toMatch(/^build fill 5x3x5 cobblestone: done, 75 \/ 75 placed, 0 skipped in \d+ s \(\d+ blocks\/min\)$/);
    expect(diff.diffs).toBe(0);
    expect(counts.cobblestone ?? 0).toBe(0);
    expect(counts.dirt ?? 0).toBe(16);
  }, 480_000);

  it('!build clear digs the same box empty', async () => {
    const b = bot!;
    await b.truth.ok('give', [b.name, 'stone_pickaxe', 1]);
    await sleep(500);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command(`!build clear ${box}`);
    const first = await b.reply((s) => s.startsWith('building ') || s.startsWith('build'), from);
    expect(first).toBe('building clear 5x3x5: 75 to dig');
    const end = await b.reply((s) => s.startsWith('build clear '), from, 400_000);
    const ms = Date.now() - t0;
    const diff = await b.truth.blocksDiff(min, max, () => 'air');
    await sleep(1500);
    const counts = await b.truth.counts(b.name);
    notes.push(`clear: ${end} | ${(ms / 1000).toFixed(1)} s | blocksdiff ${diff.diffs} of ${diff.count} | inventory ${JSON.stringify(counts)}`);
    expect(end).toMatch(/^build clear 5x3x5: done, 75 \/ 75 dug, 0 skipped/);
    expect(diff.diffs).toBe(0);
    expect(counts.cobblestone ?? 0).toBeGreaterThanOrEqual(60); // the drops picked up (most of them; collect skips stragglers)
  }, 480_000);
});
