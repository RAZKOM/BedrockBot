// e2e (tag @bds), wave 11 Track BK (docs/mining.md "Quarry and tunnel", decision 0053): `!quarry` and
// `!tunnel` through the chat, on bds-dig by default (quarry-env.ts: QUARRY_BDS_HOST / QUARRY_BDS_PORT /
// QUARRY_BDS_CONTAINER, QUARRY_VERBOSE=1). One afk-task bot (build-truth.ts: wired like the CLI) in its own
// random area; every case builds its own stone platform (6 high on the flat world, so nothing reaches
// the bedrock) or stone wall and checks the result with truth:blocksdiff:
//   quarry   `!quarry here 8 8 4 east` on a platform: every cell air but the 3 stair treads, the bot back
//            at the start's height, the cobblestone carried; `!quarry status` while it runs
//   tunnel   `!tunnel east 20` (3x3) into a stone wall with 4 torches: the 180 cells air, the floor kept,
//            a torch on the left wall every 8 blocks
//   water    `!quarry here 6 6 3 east` with a water source in the top layer: the water, the 4 cells beside
//            it and everything under them stay (the columns stop), everything else is dug: no cell next
//            to the water was opened, the water did not spread
//   stop     `!stop` in the middle of an 8 x 8 x 4 quarry: the process is gone and nothing more is dug
//   wall water  `!quarry here 6 6 3 east` with a water source in the platform just outside the box's far
//            wall: the box cell beside it and the one under it stay, the rest is dug, the stairs are
//            walkable (the 3 cells over each tread air) and the bot gets out
//   built    `!quarry here 6 6 3 east` with a plank wall beyond the box, a wall torch hanging on it over
//            the box, a door and a torch standing on the box's top: they all survive with the cells
//            under them, the rest is dug
//   spiral   `!quarry here 2 2 6 east`: 5 treads round a 2 x 2 shaft (one column twice), all dug but them,
//            the bot back on top
import './quarry-env.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { quarryProcessOf } from '../../src/chat/commands-quarry.ts';
import { parseQuarryArgs, type QuarrySpec } from '../../src/skills/mine/quarry.ts';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, settled, sleep, startBuildBot, teleport, truthLoaded, until, type BuildBot } from './build-truth.ts';

const F = FEET_Y;
/** The platform's top block layer (the bot stands on it, feet one above). */
const TOP = F + 5;
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

describe.skipIf(!E2E)('@bds quarry and tunnel (Track BK)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const builds = mkdtempSync(join(tmpdir(), 'bedrockbot-quarry-'));
  let bot: BuildBot | undefined;
  let row = 0;

  const fill = (a: Vec3, b: Vec3, block: string) => truthLoaded(bot!.truth, 'fill', [a.x, a.y, a.z, b.x, b.y, b.z, block]);

  /** A fresh site: cleared flat ground, no drops. */
  async function site(): Promise<{ x: number; z: number }> {
    const s = { x: area.x, z: area.z - 60 + 40 * row++ };
    await teleport(bot!, { x: s.x + 0.5, y: F, z: s.z + 0.5 });
    await clearArea(bot!.truth, s, 24, 12);
    await bot!.truth.clearAround({ x: s.x, y: F, z: s.z }, 30);
    return s;
  }

  /** A stone platform around the site's x+1..x+12 (6 high) with the bot on top of it at x, z. */
  async function platform(s: { x: number; z: number }): Promise<Vec3> {
    await fill({ x: s.x - 3, y: F, z: s.z - 8 }, { x: s.x + 12, y: TOP, z: s.z + 8 }, 'stone');
    const feet = { x: s.x + 0.5, y: TOP + 1, z: s.z + 0.5 };
    await teleport(bot!, feet);
    await settled(bot!);
    return feet;
  }

  /** The spec the command will build from the bot's feet (stairs, box). */
  function expectedSpec(feet: Vec3, args: string): QuarrySpec {
    const r = parseQuarryArgs(args.split(' '), { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) }, 0);
    if ('error' in r) throw new Error(r.error);
    return r.spec;
  }

  async function give(item: string, n: number): Promise<void> {
    await bot!.truth.ok('give', [bot!.name, item, n]);
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startBuildBot('Quarry', builds);
    await give('diamond_pickaxe', 1);
    await sleep(500);
  }, 120_000);

  afterAll(async () => {
    console.log(`[quarry e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
    if (bot) {
      for (let i = 0; i < row; i++) await clearArea(bot.truth, { x: area.x, z: area.z - 60 + 40 * i }, 24, 12).catch(() => undefined);
      await bot.stop();
    }
    rmSync(builds, { recursive: true, force: true });
  }, 600_000); // 7 sites to clear (radius 24)

  it('!quarry here 8 8 4 east digs the whole box but the stairs and climbs back out', async () => {
    const b = bot!;
    const s = await site();
    const feet = await platform(s);
    const spec = expectedSpec(feet, 'here 8 8 4 east');
    const keep = new Set(spec.keep.map(key));
    expect(spec.keep).toHaveLength(3);
    const before = (await b.truth.counts(b.name)).cobblestone ?? 0;
    let from = b.said.length;
    const t0 = Date.now();
    await b.command('!quarry here 8 8 4 east');
    const first = await b.reply((m) => m.startsWith('quarry '), from);
    expect(first).toMatch(/^quarry 8x4x8 going east: -?\d+ -?\d+ -?\d+ to -?\d+ -?\d+ -?\d+, 4 layers, stairs from /);
    await sleep(8000);
    const sFrom = b.said.length;
    await b.command('!quarry status');
    const status = await b.reply((m) => m.startsWith('quarry 8x4x8: layer'), sFrom);
    expect(status).toMatch(/^quarry 8x4x8: layer [1-4]\/4, \d+ dug, \d+ skipped \(run\)/);
    from = b.said.length;
    const end = await b.reply((m) => m.startsWith('quarry 8x4x8: layer') && m.includes(' in '), from, 900_000);
    const ms = Date.now() - t0;
    const diff = await b.truth.blocksDiff(spec.box.min, spec.box.max, (c) => (keep.has(key(c)) ? 'stone' : 'air'));
    const pos = await settled(b);
    await sleep(1500);
    const after = (await b.truth.counts(b.name)).cobblestone ?? 0;
    notes.push(`quarry: ${status} | ${end} | ${(ms / 1000).toFixed(0)} s (${((253 * 60_000) / ms).toFixed(0)} blocks/min) | blocksdiff ${diff.diffs} of ${diff.count} ${JSON.stringify(diff.first.slice(0, 4))} | cobblestone ${before} -> ${after} | feet ${pos.x.toFixed(1)} ${pos.y.toFixed(2)} ${pos.z.toFixed(1)}`);
    expect(end).toMatch(/^quarry 8x4x8: layer 4\/4, 253 dug, 0 skipped done in \d+ s \[253 stone\]$/);
    expect(diff.diffs).toBe(0);
    expect(pos.y).toBeGreaterThan(TOP + 0.5); // back up on the platform
    expect(after - before).toBeGreaterThanOrEqual(200); // most drops picked up
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 960_000);

  it('!tunnel east 20 cuts a 3x3 tunnel with a torch every 8 blocks and the floor kept', async () => {
    const b = bot!;
    const s = await site();
    await fill({ x: s.x + 1, y: F, z: s.z - 4 }, { x: s.x + 22, y: F + 4, z: s.z + 4 }, 'stone');
    await give('torch', 4);
    await teleport(b, { x: s.x + 0.5, y: F, z: s.z + 0.5 });
    await sleep(500);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!tunnel east 20');
    const first = await b.reply((m) => m.startsWith('tunnel '), from);
    expect(first).toMatch(/^tunnel east 20 \(3x3\): /);
    const end = await b.reply((m) => m.startsWith('tunnel east 20 (3x3): block') && m.includes(' in '), from, 900_000);
    const ms = Date.now() - t0;
    const torches = new Set([key({ x: s.x + 8, y: F, z: s.z - 1 }), key({ x: s.x + 16, y: F, z: s.z - 1 })]);
    const min = { x: s.x + 1, y: F, z: s.z - 1 };
    const max = { x: s.x + 20, y: F + 2, z: s.z + 1 };
    const diff = await b.truth.blocksDiff(min, max, (c) => (torches.has(key(c)) ? 'torch' : 'air'));
    // the floor: never dug (the grass under the stone turned to dirt, so: no air in it)
    const floor = await b.truth.blocksDiff({ x: s.x + 1, y: F - 1, z: s.z - 1 }, { x: s.x + 20, y: F - 1, z: s.z + 1 }, () => 'air');
    const beyond = await b.truth.blocksDiff({ x: s.x + 21, y: F, z: s.z - 1 }, { x: s.x + 21, y: F + 2, z: s.z + 1 }, () => 'stone');
    const nearTorch = await b.truth.blocksDiff({ x: s.x + 7, y: F, z: s.z - 2 }, { x: s.x + 9, y: F + 1, z: s.z }, () => 'air');
    notes.push(`tunnel: ${end} | ${(ms / 1000).toFixed(0)} s | blocksdiff ${diff.diffs} of ${diff.count} ${JSON.stringify(diff.first.slice(0, 4))} | floor ${floor.count - floor.diffs} air | beyond ${beyond.diffs} | around the first torch ${JSON.stringify(nearTorch.first.filter((d) => !d.actual.endsWith('stone')))}`);
    expect(end).toMatch(/^tunnel east 20 \(3x3\): block 20\/20, 180 dug, 0 skipped done in \d+ s \[180 stone\], 2 torches$/);
    expect(diff.diffs).toBe(0);
    expect(floor.diffs).toBe(floor.count);
    expect(beyond.diffs).toBe(0);
  }, 960_000);

  it('a water source in the box: it and its neighbours stay, the columns under them stop, the rest is dug', async () => {
    const b = bot!;
    const s = await site();
    const feet = await platform(s);
    const spec = expectedSpec(feet, 'here 6 6 3 east');
    const water = { x: s.x + 4, y: TOP, z: s.z + 1 };
    await truthLoaded(b.truth, 'set', [water.x, water.y, water.z, 'water']);
    await sleep(500);
    const keep = new Set(spec.keep.map(key));
    const cols = new Set([`${water.x},${water.z}`, `${water.x - 1},${water.z}`, `${water.x + 1},${water.z}`, `${water.x},${water.z - 1}`, `${water.x},${water.z + 1}`]);
    const expected = (c: Vec3): string => (key(c) === key(water) ? 'water' : cols.has(`${c.x},${c.z}`) || keep.has(key(c)) ? 'stone' : 'air');
    const from = b.said.length;
    await b.command('!quarry here 6 6 3 east');
    const end = await b.reply((m) => m.startsWith('quarry 6x3x6: layer') && m.includes(' in '), from, 900_000);
    const diff = await b.truth.blocksDiff(spec.box.min, spec.box.max, expected);
    // the water did not spread: nothing but stone around the box's rim at the water's level
    const around = await b.truth.blocksDiff({ x: spec.box.min.x - 1, y: TOP + 1, z: spec.box.min.z - 1 }, { x: spec.box.max.x + 1, y: TOP + 1, z: spec.box.max.z + 1 }, () => 'air');
    notes.push(`water: ${end} | blocksdiff ${diff.diffs} of ${diff.count} ${JSON.stringify(diff.first.slice(0, 6))} | above ${around.diffs}`);
    expect(end).toMatch(/^quarry 6x3x6: layer 3\/3, \d+ dug, 15 skipped \(10 stopped column \(liquid\), 4 next_to_liquid, 1 liquid\) done in /);
    expect(diff.diffs).toBe(0);
    expect(around.diffs).toBe(0);
  }, 960_000);

  /** The 3 cells over every tread are air (feet, head, the step up). */
  async function treadsWalkable(spec: QuarrySpec): Promise<number> {
    let bad = 0;
    for (const t of spec.keep) bad += (await bot!.truth.blocksDiff({ ...t, y: t.y + 1 }, { ...t, y: t.y + 3 }, () => 'air')).diffs;
    return bad;
  }

  it('water outside the far wall: the cell beside it and the one under it stay, the stairs stay walkable, the bot gets out', async () => {
    const b = bot!;
    const s = await site();
    const feet = await platform(s);
    const spec = expectedSpec(feet, 'here 6 6 3 east');
    const water = { x: spec.box.max.x + 1, y: TOP - 1, z: s.z + 1 }; // in the platform, against the box's east wall
    await truthLoaded(b.truth, 'set', [water.x, water.y, water.z, 'water']);
    await sleep(500);
    const keep = new Set(spec.keep.map(key));
    const stay = new Set([key({ ...water, x: water.x - 1 }), key({ ...water, x: water.x - 1, y: water.y - 1 })]);
    const from = b.said.length;
    await b.command('!quarry here 6 6 3 east');
    const end = await b.reply((m) => m.startsWith('quarry 6x3x6: layer') && m.includes(' in '), from, 900_000);
    const diff = await b.truth.blocksDiff(spec.box.min, spec.box.max, (c) => (keep.has(key(c)) || stay.has(key(c)) ? 'stone' : 'air'));
    const w = await b.truth.blocksDiff(water, water, () => 'water');
    const walk = await treadsWalkable(spec);
    const pos = await settled(b);
    notes.push(`wall water: ${end} | blocksdiff ${diff.diffs} of ${diff.count} ${JSON.stringify(diff.first.slice(0, 6))} | water ${w.diffs === 0 ? 'kept' : JSON.stringify(w.first)} | treads blocked ${walk} | feet y ${pos.y.toFixed(2)}`);
    expect(end).toMatch(/^quarry 6x3x6: layer 3\/3, \d+ dug, 2 skipped \(.*\) done in /);
    expect(diff.diffs).toBe(0);
    expect(w.diffs).toBe(0);
    expect(walk).toBe(0);
    expect(pos.y).toBeGreaterThan(TOP + 0.5);
  }, 960_000);

  it('a plank wall with a wall torch, a door and a torch next to and on the box: they survive with their supports', async () => {
    const b = bot!;
    const s = await site();
    const feet = await platform(s);
    const spec = expectedSpec(feet, 'here 6 6 3 east');
    const wx = spec.box.max.x + 1;
    await fill({ x: wx, y: TOP + 1, z: spec.box.min.z }, { x: wx, y: TOP + 2, z: spec.box.max.z }, 'oak_planks');
    const wallTorch = { x: wx - 1, y: TOP + 1, z: s.z + 1 }; // hangs on the planks, over the box's east column
    const door = { x: s.x + 3, y: TOP + 1, z: s.z + 2 };
    const torch = { x: s.x + 4, y: TOP + 1, z: s.z - 1 };
    await truthLoaded(b.truth, 'setblock', [wallTorch.x, wallTorch.y, wallTorch.z, 'torch', 'torch_facing_direction=east']);
    await truthLoaded(b.truth, 'setblock', [door.x, door.y, door.z, 'wooden_door']);
    await truthLoaded(b.truth, 'setblock', [torch.x, torch.y, torch.z, 'torch']);
    await sleep(800);
    for (const [p, n] of [
      [wallTorch, 'torch'],
      [door, 'wooden_door'],
      [torch, 'torch'],
    ] as const)
      expect((await b.truth.blocksDiff(p, p, () => n)).diffs, `${n} at ${key(p)} before the job`).toBe(0);
    const keep = new Set(spec.keep.map(key));
    const stay = new Set([wallTorch, door, torch].map((p) => key({ ...p, y: TOP })));
    const from = b.said.length;
    await b.command('!quarry here 6 6 3 east');
    const end = await b.reply((m) => m.startsWith('quarry 6x3x6: layer') && m.includes(' in '), from, 900_000);
    const diff = await b.truth.blocksDiff(spec.box.min, spec.box.max, (c) => (keep.has(key(c)) || stay.has(key(c)) ? 'stone' : 'air'));
    const kept = [
      await b.truth.blocksDiff(wallTorch, wallTorch, () => 'torch'),
      await b.truth.blocksDiff(door, door, () => 'wooden_door'),
      await b.truth.blocksDiff(torch, torch, () => 'torch'),
      await b.truth.blocksDiff({ x: wx, y: TOP + 1, z: spec.box.min.z }, { x: wx, y: TOP + 2, z: spec.box.max.z }, () => 'oak_planks'),
    ];
    const walk = await treadsWalkable(spec);
    notes.push(`built: ${end} | blocksdiff ${diff.diffs} of ${diff.count} ${JSON.stringify(diff.first.slice(0, 6))} | wall torch, door, torch, planks: ${kept.map((k) => (k.diffs ? JSON.stringify(k.first) : 'kept')).join(', ')} | treads blocked ${walk}`);
    expect(end).toMatch(/^quarry 6x3x6: layer 3\/3, \d+ dug, \d+ skipped \(.*supports a block.*\) done in /);
    for (const k of kept) expect(k.diffs).toBe(0);
    expect(diff.diffs).toBe(0);
    expect(walk).toBe(0);
  }, 960_000);

  it('!quarry here 2 2 6 east: a spiral round the shaft, all dug but the treads, the bot back on top', async () => {
    const b = bot!;
    const s = await site();
    const feet = await platform(s);
    const spec = expectedSpec(feet, 'here 2 2 6 east');
    expect(spec.keep).toHaveLength(5);
    const keep = new Set(spec.keep.map(key));
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!quarry here 2 2 6 east');
    const end = await b.reply((m) => m.startsWith('quarry 2x6x2: layer') && m.includes(' in '), from, 900_000);
    const diff = await b.truth.blocksDiff(spec.box.min, spec.box.max, (c) => (keep.has(key(c)) ? 'stone' : 'air'));
    const walk = await treadsWalkable(spec);
    const pos = await settled(b);
    notes.push(`spiral: ${end} | ${((Date.now() - t0) / 1000).toFixed(0)} s | blocksdiff ${diff.diffs} of ${diff.count} ${JSON.stringify(diff.first.slice(0, 6))} | treads blocked ${walk} | feet y ${pos.y.toFixed(2)}`);
    expect(end).toMatch(/^quarry 2x6x2: layer 6\/6, 19 dug, 0 skipped done in /);
    expect(diff.diffs).toBe(0);
    expect(walk).toBe(0);
    expect(pos.y).toBeGreaterThan(TOP + 0.5);
  }, 960_000);

  it('!stop in the middle of a quarry: the process ends and nothing more is dug', async () => {
    const b = bot!;
    const s = await site();
    const feet = await platform(s);
    const spec = expectedSpec(feet, 'here 8 8 4 east');
    const from = b.said.length;
    await b.command('!quarry here 8 8 4 east');
    await b.reply((m) => m.startsWith('quarry '), from);
    await until(() => ((quarryProcessOf(b.task)?.job.stats.dug ?? 0) >= 20 ? true : undefined), 300_000, '20 blocks dug');
    const job = quarryProcessOf(b.task)!.job;
    await b.command('!stop');
    await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 10_000, 'no user process');
    const dug = job.stats.dug;
    await sleep(1500);
    const a = await b.truth.blocksDiff(spec.box.min, spec.box.max, () => 'stone');
    await sleep(4000);
    const c = await b.truth.blocksDiff(spec.box.min, spec.box.max, () => 'stone');
    notes.push(`stop: ${dug} dug at the stop, job ${job.state}, ${a.diffs} -> ${c.diffs} cells open after 1.5 s -> 5.5 s`);
    expect(job.state).toBe('stopped');
    expect(job.stats.dug).toBe(dug);
    expect(a.diffs).toBeGreaterThanOrEqual(20);
    expect(c.diffs).toBe(a.diffs);
    expect(a.diffs).toBeLessThanOrEqual(dug + 1);
  }, 600_000);
});
