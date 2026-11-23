// e2e (tag @bds), Track B3 (decision 0128, docs/build.md "Speed"): speed before and after on one medium structure.
// A hall 24 x 6 x 16 written as a Sponge .schem v3 (Track B2's writer): a stone brick floor, oak plank walls 4 high
// with oak log corners, glass windows and a doorway, a row of oak stairs along the top of the long walls (facing out),
// 734 blocks, every one within reach of the ground (no scaffold column needed). Built from the inventory (no fetch)
// once, and the time from the command to the done line written down with the blocks and states that differ. It
// imports nothing from the builder but the structure reader and writer (both there before Track B3), so the same file
// runs on the code before the track and after. Gated by BUILD_HALL=1 on top of BDS_E2E=1 (not part of the gate); the
// line goes to .work/b3/hall-<stamp>.txt with BUILD_HALL_LABEL (`before` / `after`).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { readStructure } from '../../src/skills/build/formats/index.ts';
import { writeSchem, type JavaCell } from '../../src/skills/build/formats/schem.ts';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, sleep, startBuildBot, teleport, type BuildBot } from './build-truth.ts';

const F = FEET_Y;
const RUN = E2E && process.env.BUILD_HALL === '1';
const LABEL = process.env.BUILD_HALL_LABEL ?? 'run';
const OUT = fileURLToPath(new URL('../../../.work/b3/', import.meta.url));
const W = 24;
const D = 16;
export const SIZE = { x: W, y: 6, z: D };

export function hall(): JavaCell[] {
  const cells: JavaCell[] = [];
  const put = (x: number, y: number, z: number, java: string) => cells.push({ pos: { x, y, z }, java: `minecraft:${java}` });
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) put(x, 0, z, 'stone_bricks');
  for (let y = 1; y <= 4; y++) {
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < D; z++) {
        if (!(x === 0 || x === W - 1 || z === 0 || z === D - 1)) continue;
        const corner = (x === 0 || x === W - 1) && (z === 0 || z === D - 1);
        if (z === D - 1 && x === 12 && y <= 2) continue; // the doorway
        const win = (y === 2 || y === 3) && !corner && (((z === 0 || z === D - 1) && x % 4 === 2) || ((x === 0 || x === W - 1) && z % 4 === 2));
        put(x, y, z, corner ? 'oak_log[axis=y]' : win ? 'glass' : 'oak_planks');
      }
    }
  }
  for (let x = 0; x < W; x++) {
    put(x, 5, 0, 'oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]');
    put(x, 5, D - 1, 'oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]');
  }
  return cells;
}

describe.skipIf(!RUN)('@bds build: speed before and after on a medium hall (Track B3)', () => {
  const area = privateArea();
  // the suite's body runs when it is skipped too: no folder then (it would be left behind)
  const builds = RUN ? mkdtempSync(join(tmpdir(), 'bedrockbot-builds-')) : '';
  let bot: BuildBot | undefined;
  let note = '';
  const at: Vec3 = { x: area.x - 12, y: F, z: area.z - 8 };

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(builds, 'hall.schem'), writeSchem(SIZE, hall(), 3));
    await prepareServer();
    bot = await startBuildBot('Hall', builds);
    await teleport(bot, { x: area.x + 0.5, y: F, z: area.z + 0.5 });
    await clearArea(bot.truth, area, 24, 10);
    await sleep(500);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await clearArea(bot.truth, area, 24, 10).catch(() => undefined);
      await bot.truth.clearAround({ x: area.x, y: F, z: area.z }, 40).catch(() => undefined);
      await bot.stop();
    }
    rmSync(builds, { recursive: true, force: true });
    const text = `[build-hall e2e ${LABEL}] area cell ${area.cell}: ${note}\n`;
    console.log(text);
    try {
      appendFileSync(join(OUT, `hall-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`), text);
    } catch {
      // the raw results folder is optional
    }
  }, 120_000);

  it('734 blocks from the inventory: the time and the cells that differ', async () => {
    const b = bot!;
    const s = readStructure(writeSchem(SIZE, hall(), 3), 'schem', 'hall');
    expect(s.blocks.length).toBe(734);
    const kit: Record<string, number> = { dirt: 64, cobblestone: 64 };
    for (const blk of s.blocks) {
      const item = blk.name === 'oak_log' ? 'oak_log' : blk.name;
      kit[item] = (kit[item] ?? 0) + 1;
    }
    await b.truth.ok('clear', [b.name]);
    for (const [k, v] of Object.entries(kit)) for (let n = v; n > 0; n -= 64) await b.truth.ok('give', [b.name, k, Math.min(64, n)]);
    await sleep(800);
    await teleport(b, { x: at.x - 2.5, y: F, z: at.z - 2.5 });
    const from = b.said.length;
    const t0 = performance.now();
    await b.command(`!build file hall ${at.x} ${at.y} ${at.z}`);
    const end = await b.reply((x) => x.startsWith('build file ') && /: (done|stopped|.* at \d+ \/)/.test(x), from, 1_500_000);
    const secs = (performance.now() - t0) / 1000;
    await sleep(1500);
    const want = new Map(s.blocks.map((blk) => [`${blk.pos.x},${blk.pos.y},${blk.pos.z}`, blk] as const));
    let names = 0;
    let states = 0;
    for (let y = 0; y < SIZE.y; y++) {
      const min = { x: at.x, y: at.y + y, z: at.z };
      const max = { x: at.x + W - 1, y: at.y + y, z: at.z + D - 1 };
      const rel = (c: Vec3) => want.get(`${c.x - at.x},${c.y - at.y},${c.z - at.z}`);
      const byName = await b.truth.blocksDiff(min, max, (c) => rel(c)?.name ?? 'air');
      const withStates = await b.truth.blocksDiff(min, max, (c) => {
        const blk = rel(c);
        if (!blk) return 'air';
        const st = Object.entries(blk.states ?? {});
        return st.length ? `${blk.name}[${st.map(([k, v]) => `${k}=${String(v)}`).join(';')}]` : blk.name;
      });
      names += byName.diffs;
      states += withStates.diffs - byName.diffs;
    }
    note = `${end} | ${secs.toFixed(1)} s from the command (${((secs * 1000) / 734).toFixed(0)} s per 1000 blocks) | ${names} of 734 with another block, ${states} with other states`;
    expect(end).toMatch(/: done, /);
  }, 1_600_000);
});
