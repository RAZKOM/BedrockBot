// e2e (tag @bds), Track EF1 (docs/benchmarks.md): the survey that chose the benchmark's spots. Not a gate: run once on a
// fresh copy of the benchmark's world (generated, seed 7). One bot visits a grid of columns, reads the ground where it
// lands (the first solid block under the sky that is not a log or leaves), and counts what the jobs need round it:
// coal, iron, diamond ore within 32 (the miner's scan), logs by kind within 48 (the gather's search), sand, gravel, water.
// One JSON line a column into BENCH_SURVEY_OUT.
//   BENCH_SURVEY  x0,z0,step,n (default 1000,1000,300,5: n x n columns from x0, z0)
//   BENCH_SURVEY_POINTS  x,z;x,z;... (columns to visit instead of the grid)
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { benchCmd, E2E, prepareServer, sleep, startBenchBot, type BenchBot } from './bench-truth.ts';

const OUT = process.env.BENCH_SURVEY_OUT;
const [X0, Z0, STEP, N] = (process.env.BENCH_SURVEY ?? '1000,1000,300,5').split(',').map(Number) as [number, number, number, number];
const POINTS: [number, number][] = process.env.BENCH_SURVEY_POINTS
  ? process.env.BENCH_SURVEY_POINTS.split(';').map((s) => s.split(',').map(Number) as [number, number])
  : Array.from({ length: N * N }, (_, i) => [X0 + STEP * (i % N), Z0 + STEP * Math.floor(i / N)] as [number, number]);

const isLog = (n: string) => n.endsWith('_log') && !n.startsWith('stripped_');
const isLeaves = (n: string) => n.endsWith('_leaves');
const isLiquid = (n: string) => n.includes('water') || n.includes('lava');

describe.skipIf(!E2E)('@bds bench survey (Track EF1)', () => {
  let bot: BenchBot | undefined;

  beforeAll(async () => {
    await prepareServer();
    await benchCmd('gamerule', 'falldamage', 'false');
    bot = await startBenchBot('Survey');
  }, 180_000);

  afterAll(async () => {
    await benchCmd('gamerule', 'falldamage', 'true').catch(() => undefined);
    await bot?.stop();
  }, 60_000);

  it('reads the ground and the resources at every column', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const w = mob.world;
    for (const [x, z] of POINTS) {
      const air: Vec3 = { x: x + 0.5, y: 200, z: z + 0.5 };
      await b.truth.tp(b.name, air, 0, 0);
      await sleep(1500);
      await w.waitForChunks(3, { center: air, timeoutMs: 90_000 }).catch(() => undefined);
      await sleep(1500);
      let ground: number | undefined;
      let top = '';
      let tree = false;
      let liquid = '';
      for (let y = 200; y > -64; y--) {
        const blk = w.blockAt({ x, y, z });
        if (!blk) continue;
        if (isLiquid(blk.name) && !liquid) liquid = blk.name;
        if (!blk.solid) continue;
        if (isLog(blk.name) || isLeaves(blk.name)) {
          tree = true;
          continue;
        }
        ground = y;
        top = blk.name;
        break;
      }
      if (ground === undefined) {
        console.log(`[survey] ${x} ${z}: no ground read`);
        continue;
      }
      const feet: Vec3 = { x: x + 0.5, y: ground + 1, z: z + 0.5 };
      await b.truth.tp(b.name, feet, 0, 0);
      await sleep(1500);
      await w.waitForChunks(3, { center: feet, timeoutMs: 60_000 }).catch(() => undefined);
      const count = (pred: (n: string) => boolean, r: number) => w.find((blk) => pred(blk.name), { origin: feet, radius: r, max: 5000 }).length;
      const logs: Record<string, number> = {};
      for (const p of w.find((blk) => isLog(blk.name), { origin: feet, radius: 48, max: 5000 })) {
        const n = w.blockAt(p)?.name ?? '?';
        logs[n] = (logs[n] ?? 0) + 1;
      }
      const row = {
        x,
        z,
        feet: ground + 1,
        top,
        tree,
        liquid,
        coal: count((n) => n === 'coal_ore' || n === 'deepslate_coal_ore', 32),
        iron: count((n) => n === 'iron_ore' || n === 'deepslate_iron_ore', 32),
        diamond: count((n) => n === 'diamond_ore' || n === 'deepslate_diamond_ore', 32),
        sand: count((n) => n === 'sand', 32),
        gravel: count((n) => n === 'gravel', 32),
        water: count((n) => n === 'water' || n === 'flowing_water', 16),
        logs,
      };
      console.log(`[survey] ${JSON.stringify(row)}`);
      if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    }
  }, 3_600_000);
});
