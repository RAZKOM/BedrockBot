// e2e (tag @bds), Track B10 (ADR 0135, docs/build.md "Never stranded"): a bot shut in by the build's own blocks digs
// itself out and places them again. On bds-build (flat, peaceful, truth pack), in its own random area: a file build
// (layers JSON) of a ring of oak planks 5 x 5, 3 high, already standing, and 2 stone 8 blocks off it; the bot inside
// the ring. Its walk to the stone finds no way (`no progress possible`); the runner digs the cheapest way out of the
// ring (2 planks: the feet and the head of one side), places the stone, and puts the 2 planks back from outside:
// truth:blocksdiff 0 over the whole file, the bot outside the ring.
// Env: BDS_E2E=1, BUILD_BDS_HOST / BUILD_BDS_PORT / BUILD_BDS_CONTAINER (build-truth.ts), BUILD_LOG_FILE.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, settled, sleep, startBuildBot, teleport, truthLoaded, type BuildBot } from './build-truth.ts';

const F = FEET_Y;
const SIDE = 5;
const HIGH = 3;
const FAR = 12; // the stone's x in the file

/** The file: layer y from 0, rows z, columns x; `#` oak planks (the ring), `s` stone. */
function stuckFile(): string {
  const layers: string[][] = [];
  for (let y = 0; y < HIGH; y++) {
    const rows: string[] = [];
    for (let z = 0; z < SIDE; z++) {
      let row = '';
      for (let x = 0; x <= FAR; x++) {
        const ring = x < SIDE && (x === 0 || x === SIDE - 1 || z === 0 || z === SIDE - 1);
        row += ring ? '#' : y === 0 && x === FAR && (z === 1 || z === 2) ? 's' : '.';
      }
      rows.push(row.replace(/\.+$/, ''));
    }
    layers.push(rows);
  }
  return JSON.stringify({ name: 'stuck', layers, legend: { '#': 'oak_planks', s: 'stone' } });
}

describe.skipIf(!E2E)('@bds build: shut in by its own blocks (Track B10)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const builds = mkdtempSync(join(tmpdir(), 'bedrockbot-builds-'));
  let bot: BuildBot | undefined;
  const at: Vec3 = { x: area.x + 3, y: F, z: area.z + 3 };
  const inside: Vec3 = { x: at.x + 2.5, y: F, z: at.z + 2.5 };

  beforeAll(async () => {
    writeFileSync(join(builds, 'stuck.json'), stuckFile());
    await prepareServer();
    bot = await startBuildBot('Stuck', builds);
    await teleport(bot, { x: area.x + 0.5, y: F, z: area.z + 0.5 });
    await clearArea(bot.truth, area, 24, 10);
    await sleep(500);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await clearArea(bot.truth, area, 24, 10).catch(() => undefined);
      await bot.stop();
    }
    rmSync(builds, { recursive: true, force: true });
    console.log(`[build-stuck e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('digs its way out of the ring, places the stone, and puts the ring back whole', async () => {
    const b = bot!;
    // the ring standing already (the build's own blocks), the bot inside it
    await truthLoaded(b.truth, 'fill', [at.x, F, at.z, at.x + SIDE - 1, F + HIGH - 1, at.z + SIDE - 1, 'oak_planks']);
    await truthLoaded(b.truth, 'fill', [at.x + 1, F, at.z + 1, at.x + SIDE - 2, F + HIGH - 1, at.z + SIDE - 2, 'air']);
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'stone', 2]);
    await b.truth.ok('give', [b.name, 'dirt', 16]);
    await teleport(b, inside);
    await sleep(800);
    const from = b.said.length;
    const logFrom = b.logs.length;
    const t0 = Date.now();
    await b.command(`!build file stuck ${at.x} ${at.y} ${at.z}`);
    const first = await b.reply((s) => s.startsWith('building ') || s.startsWith('build'), from, 30_000);
    const end = await b.reply((s) => s.startsWith('build file stuck at') && /: (done|stopped)/.test(s), from, 600_000);
    const ms = Date.now() - t0;
    const ring = (c: Vec3) => c.x - at.x < SIDE && c.z - at.z < SIDE && (c.x === at.x || c.x === at.x + SIDE - 1 || c.z === at.z || c.z === at.z + SIDE - 1);
    const diff = await b.truth.blocksDiff(at, { x: at.x + FAR, y: F + HIGH - 1, z: at.z + SIDE - 1 }, (c) => (ring(c) ? 'oak_planks' : c.y === F && c.x === at.x + FAR && (c.z === at.z + 1 || c.z === at.z + 2) ? 'stone' : 'air'));
    const feet = await settled(b);
    const logs = b.logs.slice(logFrom).filter((l) => / (info|warn) build: (shut in|.*dug to get out)/.test(l));
    notes.push(`${first} | ${end} | ${(ms / 1000).toFixed(1)} s | blocksdiff ${diff.diffs} of ${diff.count} ${JSON.stringify(diff.first.slice(0, 5))} | feet ${feet.x.toFixed(2)} ${feet.y.toFixed(2)} ${feet.z.toFixed(2)}`);
    for (const l of logs) notes.push(l);
    expect(first).toBe(`building file stuck at ${at.x} ${at.y} ${at.z}: 2 to place, 48 there already`);
    expect(end).toMatch(new RegExp(`^build file stuck at ${at.x} ${at.y} ${at.z}: done, 2 / 2 placed, 0 skipped`));
    expect(logs.some((l) => /build: shut in at .*: digging 2 blocks to get out .*2 of the build's \(placed again later\)/.test(l))).toBe(true);
    expect(logs.filter((l) => l.includes('dug to get out: placed again'))).toHaveLength(2);
    expect(diff.diffs).toBe(0);
    // out of the ring
    const fx = Math.floor(feet.x) - at.x;
    const fz = Math.floor(feet.z) - at.z;
    expect(fx < 0 || fx > SIDE - 1 || fz < 0 || fz > SIDE - 1).toBe(true);
  }, 660_000);
});
