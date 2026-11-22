// e2e (tag @bds), Track B2 (docs/build.md "Java files", "Bill of materials", "Fetch"; ADR 0125): a Java-format house
// built from raw materials, on a flat, peaceful server with the truth pack (bds-build by default; BUILD_BDS_PORT /
// BUILD_BDS_CONTAINER point it at another one). One afk-task bot (walking, the CLI's wiring, settings in memory) in its
// own random area, a home with one chest 3 east of it holding only raw materials (32 oak logs, 8 sand, 48 cobblestone,
// 8 clay balls), read by `!chests scan`, and an empty inventory. The house (5x3x5, 65 blocks; written by the test's own
// writer as .schem v3, .litematic or vanilla .nbt):
//   floor  oak log corners, 4 stone bricks, 2 smooth stone, 14 oak planks, 1 bricks block in the middle
//   walls  oak log corners, 3 glass windows, 8 oak planks, a doorway
//   roof   10 oak stairs (the two long sides) and 15 oak slabs
// `!build materials file house ...` gives the bill; `!build file house ... fetch` brings the raw materials from the chest,
// crafts the planks, stairs and slabs, sets a furnace down, smelts stone, smooth stone, glass and bricks, crafts the stone
// bricks and the bricks block, then builds. truth:blocksdiff compares the box with the file's Bedrock names (states are
// Track B1's: not compared).
//   BUILD_JAVA_FORMAT  schem (default) | litematic | nbt: the file the run builds
//   BUILD_JAVA_OUT     a file each run's line is appended to
// Env: BUILD_BDS_HOST / BUILD_BDS_PORT / BUILD_BDS_CONTAINER (build-truth.ts), BUILD_VERBOSE=1.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { readStructure } from '../../src/skills/build/formats/index.ts';
import { writeLitematic } from '../../src/skills/build/formats/litematic.ts';
import { writeSchem, type JavaCell } from '../../src/skills/build/formats/schem.ts';
import { writeVanilla } from '../../src/skills/build/formats/vanilla.ts';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, sleep, startBuildBot, teleport, truthLoaded, type BuildBot } from './build-truth.ts';

const F = FEET_Y;
const FORMAT = (process.env.BUILD_JAVA_FORMAT ?? 'schem') as 'schem' | 'litematic' | 'nbt';
const OUT = process.env.BUILD_JAVA_OUT;
const SIZE = { x: 5, y: 3, z: 5 };
const CHEST = { oak_log: 32, sand: 8, cobblestone: 48, clay_ball: 8 };
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

/** The house as Java cells (see the header). */
function javaHouse(): JavaCell[] {
  const cells: JavaCell[] = [];
  const put = (x: number, y: number, z: number, java: string) => cells.push({ pos: { x, y, z }, java: `minecraft:${java}` });
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      const corner = (x === 0 || x === 4) && (z === 0 || z === 4);
      const ring = x === 0 || x === 4 || z === 0 || z === 4;
      const mid = x === 2 || z === 2;
      if (corner) put(x, 0, z, 'oak_log[axis=y]');
      else if (ring) put(x, 0, z, mid ? 'stone_bricks' : z === 0 ? 'smooth_stone' : 'oak_planks');
      else put(x, 0, z, x === 2 && z === 2 ? 'bricks' : 'oak_planks');
      if (corner) put(x, 1, z, 'oak_log[axis=y]');
      else if (ring && !(mid && z === 0)) put(x, 1, z, mid ? 'glass' : 'oak_planks');
      if (z === 0) put(x, 2, z, 'oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]');
      else if (z === 4) put(x, 2, z, 'oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]');
      else put(x, 2, z, 'oak_slab[type=bottom,waterlogged=false]');
    }
  }
  return cells;
}

function houseFile(format: typeof FORMAT): Buffer {
  const cells = javaHouse();
  if (format === 'litematic') return writeLitematic([{ name: 'house', pos: { x: 0, y: 0, z: 0 }, size: SIZE, cells }], { name: 'house' });
  if (format === 'nbt') return writeVanilla(SIZE, cells);
  return writeSchem(SIZE, cells, 3);
}

describe.skipIf(!E2E)('@bds build: a Java house from raw materials (Track B2)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const builds = mkdtempSync(join(tmpdir(), 'bedrockbot-builds-'));
  let bot: BuildBot | undefined;
  const c = area;
  const L = {
    home: { x: c.x, y: F, z: c.z },
    chest: { x: c.x + 3, y: F, z: c.z },
    /** The house's min corner: 6 south of home, out of the way of the furnace and the crafting table. */
    house: { x: c.x - 2, y: F, z: c.z + 6 },
  };

  beforeAll(async () => {
    writeFileSync(join(builds, `house.${FORMAT}`), houseFile(FORMAT));
    await prepareServer();
    bot = await startBuildBot('Java', builds);
    await teleport(bot, centre(L.home));
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await truthLoaded(bot.truth, 'container', [L.chest.x, L.chest.y, L.chest.z, 'clear']).catch(() => undefined);
      await clearArea(bot.truth, c, 18, 8).catch(() => undefined);
      await bot.truth.clearAround(centre(L.home), 40).catch(() => undefined);
      await bot.stop();
    }
    rmSync(builds, { recursive: true, force: true });
    console.log(`[build-java e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it(`a ${FORMAT} house: the bill, then fetch brings, crafts and smelts, and the build matches by names`, async () => {
    const b = bot!;
    const s = readStructure(readFileSync(join(builds, `house.${FORMAT}`)), FORMAT, 'house');
    expect(s.blocks).toHaveLength(65);
    expect(s.unknown ?? []).toEqual([]);
    const want = new Map<string, string>();
    for (const blk of s.blocks) want.set(`${blk.pos.x},${blk.pos.y},${blk.pos.z}`, blk.name);
    const kinds: Record<string, number> = {};
    for (const n of want.values()) kinds[n] = (kinds[n] ?? 0) + 1;
    notes.push(`file: house.${FORMAT} ${readFileSync(join(builds, `house.${FORMAT}`)).length} bytes, ${JSON.stringify(kinds)}`);

    // the ground, the home and its one chest of raw materials
    await clearArea(b.truth, c, 18, 8);
    await truthLoaded(b.truth, 'set', [L.chest.x, L.chest.y, L.chest.z, 'chest']);
    for (const [item, n] of Object.entries(CHEST)) await truthLoaded(b.truth, 'chestput', [L.chest.x, L.chest.y, L.chest.z, item, n, 1]);
    await teleport(b, centre(L.home));
    await b.truth.ok('clear', [b.name]);
    await sleep(800);
    b.task.home!.set(L.home);
    let from = b.said.length;
    await b.command('!chests scan');
    notes.push(`scan: ${await b.reply((x) => /^chests: \d+ within /.test(x), from, 120_000)}`);

    const at = `${L.house.x} ${L.house.y} ${L.house.z}`;
    from = b.said.length;
    await b.command(`!build materials file house ${at}`);
    const first = await b.reply((x) => x.startsWith('materials for '), from, 30_000);
    await sleep(2500);
    const bill = b.said.slice(from).filter((x) => x !== first); // the bill's lines (a long one goes on in the next)
    notes.push(`materials: ${first} || ${bill.join(' || ')}`);
    expect(first).toMatch(/^materials for file house at .*: .*22 oak_planks.*; need /);
    expect(bill.join(' ')).toContain('from home: ');
    expect(bill.join(' ')).toContain('a furnace (8 cobblestone)');

    // the fetch's commands, with the time each began
    const t0 = Date.now();
    const steps: string[] = [];
    const poll = setInterval(() => {
      while (steps.length < b.build.fetched.length) steps.push(`${((Date.now() - t0) / 1000).toFixed(0)} s !${b.build.fetched[steps.length]}`);
    }, 250);
    from = b.said.length;
    try {
      await b.command(`!build file house ${at} fetch`);
      const start = await b.reply((x) => x.startsWith(`build file house at ${at}: fetching first`) || x.startsWith('build: '), from, 30_000);
      notes.push(`start: ${start}`);
      expect(start).toMatch(/^build file house at .*: fetching first: from home: /);
      const building = await b.reply((x) => x.startsWith(`building file house at ${at}`) || x.startsWith('build: '), from, 900_000);
      const fetchS = (Date.now() - t0) / 1000;
      notes.push(`fetch: ${fetchS.toFixed(0)} s, ${b.build.fetched.length} commands: ${steps.join(' | ')}`);
      notes.push(`then: ${building}`);
      expect(building).toMatch(/^building file house at /);
      const end = await b.reply((x) => x.startsWith(`build file house at ${at}:`) && !x.includes(': fetching first'), from, 900_000);
      const totalS = (Date.now() - t0) / 1000;
      await sleep(1500);
      const min = L.house;
      const max = { x: min.x + SIZE.x - 1, y: min.y + SIZE.y - 1, z: min.z + SIZE.z - 1 };
      const diff = await b.truth.blocksDiff(min, max, (p) => want.get(`${p.x - min.x},${p.y - min.y},${p.z - min.z}`) ?? 'air');
      const counts = await b.truth.counts(b.name);
      const said = b.said.slice(from).filter((x) => /^(smelt|furnace|craft|brought|bring|get|getting|gather|build|crafted|made)/.test(x));
      notes.push(`end: ${end} (${totalS.toFixed(0)} s in all) | blocksdiff ${diff.diffs} of ${diff.count} ${JSON.stringify(diff.first)} | inventory after ${JSON.stringify(counts)}`);
      notes.push(`said: ${said.join(' || ')}`);
      if (OUT) appendFileSync(OUT, `${new Date().toISOString()} ${FORMAT} fetch ${fetchS.toFixed(0)} s, ${b.build.fetched.length} commands, total ${totalS.toFixed(0)} s, blocksdiff ${diff.diffs} of ${diff.count} | ${end} | ${steps.join(' | ')}\n`);
      expect(end).toMatch(/: done, 65 \/ 65 placed, 0 skipped/);
      expect(diff.diffs).toBe(0);
      // every crafted and smelted kind came from the raw materials: the chest held nothing else, the inventory was empty
      for (const k of ['bring oak_log', 'craft oak_stairs', 'craft oak_slab', 'smelt cobblestone', 'smelt sand', 'smelt clay_ball', 'smelt stone', 'craft stone_bricks', 'craft brick_block']) expect(b.build.fetched.some((x) => x.startsWith(k))).toBe(true);
    } finally {
      clearInterval(poll);
    }
  }, 1_900_000);
});
