// e2e (tag @bds), Track B1 (decision 0124, docs/build.md "Block states"): speed before and after on one
// structure. A JSON layer structure of 40 oriented blocks that the builder accepted before Track B1 too (stairs
// both ways up, slabs, logs, furnaces, carved pumpkins, every direction) is built once at rotation 0, and the
// time from the command to the done line and the cells whose states differ from the file are written down. It
// imports nothing from the builder, so the same file runs on the code before the track (which places these blocks
// by name only) and after. Gated by BUILD_SPEED=1 on top of BDS_E2E=1 (not part of the gate); the line goes to
// .work/b1/speed-<stamp>.txt with BUILD_SPEED_LABEL (`before` / `after`).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, sleep, startBuildBot, teleport, type BuildBot } from './build-truth.ts';

const F = FEET_Y;
const RUN = E2E && process.env.BUILD_SPEED === '1';
const LABEL = process.env.BUILD_SPEED_LABEL ?? 'run';
const OUT = fileURLToPath(new URL('../../../.work/b1/', import.meta.url));

type St = Record<string, string | number | boolean>;
const LEGEND: Record<string, { name: string; states: St }> = {
  a: { name: 'oak_stairs', states: { weirdo_direction: 0, upside_down_bit: false } },
  b: { name: 'oak_stairs', states: { weirdo_direction: 1, upside_down_bit: false } },
  c: { name: 'oak_stairs', states: { weirdo_direction: 2, upside_down_bit: false } },
  d: { name: 'oak_stairs', states: { weirdo_direction: 3, upside_down_bit: false } },
  e: { name: 'oak_stairs', states: { weirdo_direction: 0, upside_down_bit: true } },
  f: { name: 'oak_stairs', states: { weirdo_direction: 1, upside_down_bit: true } },
  g: { name: 'oak_stairs', states: { weirdo_direction: 2, upside_down_bit: true } },
  h: { name: 'oak_stairs', states: { weirdo_direction: 3, upside_down_bit: true } },
  s: { name: 'oak_slab', states: { 'minecraft:vertical_half': 'bottom' } },
  t: { name: 'oak_slab', states: { 'minecraft:vertical_half': 'top' } },
  x: { name: 'oak_log', states: { pillar_axis: 'x' } },
  z: { name: 'oak_log', states: { pillar_axis: 'z' } },
  y: { name: 'oak_log', states: { pillar_axis: 'y' } },
  n: { name: 'furnace', states: { 'minecraft:cardinal_direction': 'north' } },
  E: { name: 'furnace', states: { 'minecraft:cardinal_direction': 'east' } },
  S: { name: 'furnace', states: { 'minecraft:cardinal_direction': 'south' } },
  w: { name: 'furnace', states: { 'minecraft:cardinal_direction': 'west' } },
  N: { name: 'carved_pumpkin', states: { 'minecraft:cardinal_direction': 'north' } },
  O: { name: 'carved_pumpkin', states: { 'minecraft:cardinal_direction': 'east' } },
  P: { name: 'carved_pumpkin', states: { 'minecraft:cardinal_direction': 'south' } },
  W: { name: 'carved_pumpkin', states: { 'minecraft:cardinal_direction': 'west' } },
};
/** One layer, rows z = 0, 2, 4, 6, 8 (the odd rows free to stand in). */
const ROWS = ['abcdabcd', '........', 'efghefgh', '........', 'ststtsts', '........', 'xzyxzyxz', '........', 'nESwNOPW'];
const SPEED = { name: 'b1speed', layers: [ROWS], legend: LEGEND };

describe.skipIf(!RUN)('@bds build: speed before and after on one structure (Track B1)', () => {
  const area = privateArea();
  const builds = mkdtempSync(join(tmpdir(), 'bedrockbot-builds-'));
  let bot: BuildBot | undefined;
  let note = '';
  const at: Vec3 = { x: area.x + 3, y: F, z: area.z + 3 };

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(builds, 'b1speed.json'), JSON.stringify(SPEED));
    await prepareServer();
    bot = await startBuildBot('Speed', builds);
    await teleport(bot, { x: area.x + 0.5, y: F, z: area.z + 0.5 });
    await clearArea(bot.truth, area, 20, 8);
    await sleep(500);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await clearArea(bot.truth, area, 20, 8).catch(() => undefined);
      await bot.truth.clearAround({ x: area.x, y: F, z: area.z }, 40).catch(() => undefined);
      await bot.stop();
    }
    rmSync(builds, { recursive: true, force: true });
    const text = `[build-speed e2e ${LABEL}] area cell ${area.cell}: ${note}\n`;
    console.log(text);
    try {
      appendFileSync(join(OUT, `speed-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`), text);
    } catch {
      // the raw results folder is optional
    }
  }, 120_000);

  it('40 oriented blocks: the time and the cells whose states differ', async () => {
    const b = bot!;
    const kit: Record<string, number> = { dirt: 64 };
    for (const ch of ROWS.join('')) if (LEGEND[ch]) kit[LEGEND[ch].name] = (kit[LEGEND[ch].name] ?? 0) + 1;
    await b.truth.ok('clear', [b.name]);
    for (const [k, v] of Object.entries(kit)) for (let n = v; n > 0; n -= 64) await b.truth.ok('give', [b.name, k, Math.min(64, n)]);
    await sleep(800);
    await teleport(b, { x: at.x - 2.5, y: F, z: at.z - 2.5 });
    const from = b.said.length;
    const t0 = performance.now();
    await b.command(`!build file b1speed ${at.x} ${at.y} ${at.z}`);
    const end = await b.reply((s) => s.startsWith('build file '), from, 600_000);
    const secs = (performance.now() - t0) / 1000;
    let names = 0;
    let states = 0;
    for (const [z, row] of ROWS.entries()) {
      if (!row.trim().replace(/\./g, '')) continue;
      const y = at.y;
      const min = { x: at.x, y, z: at.z + z };
      const max = { x: at.x + row.length - 1, y, z: at.z + z };
      const byName = await b.truth.blocksDiff(min, max, (c) => LEGEND[row[c.x - at.x]!]?.name ?? 'air');
      const withStates = await b.truth.blocksDiff(min, max, (c) => {
        const l = LEGEND[row[c.x - at.x]!];
        return l ? `${l.name}[${Object.entries(l.states).map(([k, v]) => `${k}=${String(v)}`).join(';')}]` : 'air';
      });
      names += byName.diffs;
      states += withStates.diffs - byName.diffs;
    }
    note = `${end} | ${secs.toFixed(1)} s from the command | ${names} of 40 with another block, ${states} of 40 with other states`;
    expect(end).toMatch(/: done, /);
  }, 700_000);
});
