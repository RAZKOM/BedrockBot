// e2e (tag @bds), Track E7 (docs/early-game.md "The shell's blocks", ADR 0104): the night shell's 10 throwaway blocks
// kept by `shellBlocks`, on a flat, peaceful server with the truth pack (bds-craft by default; CRAFT_BDS_PORT /
// CRAFT_BDS_CONTAINER point it at another). One afk-task bot in its own area.
//   chore    nothing carried, by day, nothing running: the blocks chore digs 10 blocks out of the ground near the bot
//            (never next to its feet)
//   base     home where the bot stands with `protectRadius` 16 (over the dig's own radius of 10): nothing is dug in
//            the base; the bot walks out of it first and digs there
//   job      3 cobblestone and 2 sticks carried, the clock 50 s before dusk: `!get stone_pickaxe` digs the shell's
//            blocks first and says so in its end line
//   death    `nightShell` on, a shelter under the open sky, 16 cobblestone carried, keepInventory off: the bot is
//            killed by day and its drops are removed; then dusk. `shellBlocks` on: the chore digs 10 blocks after the
//            respawn and the shell closes that night; E7_BLOCKS=off (the code before): no blocks, the bot stands in the
//            open
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1, E7_OUT=<file> (the
// measured lines appended), E7_LOG=<file> (the bot's log), E7_CASE=chore,base,job,death (a subset), E7_BLOCKS=off (the death case without the rule).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { shellBlocksCarried } from '../../src/skills/survival/shell-blocks.ts';
import { clearArea, craftCmd, E2E, FEET_Y, hdist, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const ONLY = process.env.E7_CASE;
const want = (c: string) => !ONLY || ONLY.split(',').includes(c);
const RULE = process.env.E7_BLOCKS !== 'off';

describe.skipIf(!E2E)('@bds early blocks: the night shell\'s blocks are kept (Track E7)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const carried = (b: CraftBot): number => shellBlocksCarried(b.built.mobility!.world.inventory.slots);
  const ring = (c: Vec3, dy: number): Vec3[] => [
    { x: c.x + 1, y: c.y + dy, z: c.z },
    { x: c.x - 1, y: c.y + dy, z: c.z },
    { x: c.x, y: c.y + dy, z: c.z + 1 },
    { x: c.x, y: c.y + dy, z: c.z - 1 },
  ];
  const shell = (c: Vec3): Vec3[] => [...ring(c, 0), ...ring(c, 1), { x: c.x, y: c.y + 2, z: c.z }];
  const solidCount = async (b: CraftBot, cells: Vec3[]): Promise<number> => {
    let n = 0;
    for (const p of cells) if ((await b.truth.block(p)).typeId !== 'minecraft:air') n++;
    return n;
  };
  /** Floor cells within `r` of (x, z) that are no longer there (dug). */
  const dugWithin = async (b: CraftBot, x: number, z: number, r: number): Promise<number> => {
    let n = 0;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.hypot(dx, dz) <= r && (await b.truth.block({ x: x + dx, y: F - 1, z: z + dz })).typeId === 'minecraft:air') n++;
    return n;
  };
  async function fresh(b: CraftBot): Promise<void> {
    b.settings.set('shellBlocks', 'off');
    b.settings.set('nightShell', 'off');
    b.settings.set('jobDusk', 'off');
    b.settings.set('protectRadius', '48');
    await craftCmd('time', 'set', '6000');
    await b.command('!stop');
    await sleep(1500);
    b.task.shelter!.set(undefined);
    b.task.home?.set(undefined);
    await b.truth.ok('clear', [b.name]);
    await clearArea(b.truth, { x: area.x, z: area.z }, 28, 6);
    await truthLoaded(b.truth, 'fill', [area.x - 28, F - 1, area.z - 28, area.x + 28, F - 1, area.z + 28, 'grass_block']);
    await craftCmd('kill', '@e[type=item]');
    await teleport(b, feet);
    await until(() => (b.built.mobility!.world.inventory.slots.every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
  }

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyBlks');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    await teleport(b, feet);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await craftCmd('time', 'set', 'noon').catch(() => undefined);
      await craftCmd('gamerule', 'keepinventory', 'true').catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await craftCmd('kill', '@e[type=item]').catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 24, 6).catch(() => undefined);
      await truthLoaded(bot.truth, 'fill', [area.x - 24, F - 1, area.z - 24, area.x + 24, F - 1, area.z + 24, 'grass_block']).catch(() => undefined);
      await bot.stop();
    }
    const text = `[early-blocks e2e]${RULE ? '' : ' (shellBlocks off)'} area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}\n`;
    console.log(text);
    if (process.env.E7_OUT) appendFileSync(process.env.E7_OUT, text);
    if (process.env.E7_LOG && bot) appendFileSync(process.env.E7_LOG, `${bot.logs.join('\n')}\n`);
  }, 120_000);

  it.runIf(want('chore'))('chore: nothing carried, by day, idle: 10 blocks dug near the bot, none next to its feet', async () => {
    const b = bot!;
    await fresh(b);
    const from = b.logs.length;
    const t0 = Date.now();
    b.settings.set('shellBlocks', 'on');
    await until(() => (carried(b) >= 10 ? true : undefined), 120_000, '10 shell blocks carried', 500);
    const s = (Date.now() - t0) / 1000;
    await sleep(1500);
    const near = await dugWithin(b, area.x, area.z, 1);
    notes.push(`chore: ${carried(b)} shell blocks ${s.toFixed(1)} s after the setting went on; ${b.logs.slice(from).filter((l) => l.includes('blocks chore')).join(' | ')}`);
    expect(near).toBe(0);
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 240_000);

  it.runIf(want('base'))('base: inside the base nothing is dug: the bot walks out of it first', async () => {
    const b = bot!;
    await fresh(b);
    b.settings.set('protectRadius', '16');
    b.task.home!.set({ x: area.x, y: F, z: area.z });
    const from = b.logs.length;
    const t0 = Date.now();
    b.settings.set('shellBlocks', 'on');
    await until(() => (carried(b) >= 10 ? true : undefined), 180_000, '10 shell blocks carried', 500);
    const s = (Date.now() - t0) / 1000;
    await sleep(1500);
    const inBase = await dugWithin(b, area.x, area.z, 11);
    const p = b.task.position()!;
    notes.push(`base: ${carried(b)} shell blocks in ${s.toFixed(1)} s, ${inBase} cells dug within 11 of home (the base is 16), the bot ${hdist(p, feet).toFixed(1)} from home; ${b.logs.slice(from).filter((l) => /blocks( chore)?:/.test(l)).join(' | ')}`);
    expect(inBase).toBe(0);
    expect(b.logs.slice(from).some((l) => l.includes('inside the base'))).toBe(true);
  }, 300_000);

  it.runIf(want('job'))('job: short of the blocks 50 s before dusk: the job digs them first and says so', async () => {
    const b = bot!;
    await fresh(b);
    await loadKit(b, [['crafting_table', 1], ['cobblestone', 3], ['stick', 2]]);
    b.settings.set('shellBlocks', 'on');
    await craftCmd('time', 'set', '11000');
    await sleep(300);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get stone_pickaxe');
    const end = await b.reply((s) => s.startsWith('get stone_pickaxe: '), from, 180_000);
    const got = (await b.truth.craftinv(b.name)).counts;
    notes.push(`job: ${end}; ${((Date.now() - t0) / 1000).toFixed(1)} s; ${carried(b)} shell blocks carried; inventory ${JSON.stringify(got)}`);
    expect(end).toMatch(/^get stone_pickaxe: done in \d+ s, \d+ steps?; .*dug the night shell's blocks/);
    expect(got.stone_pickaxe ?? 0).toBe(1);
    expect(carried(b)).toBeGreaterThanOrEqual(10);
  }, 300_000);

  it.runIf(want('death'))(`death: killed by day, the drops gone, then dusk: shellBlocks ${RULE ? 'on: 10 blocks dug, walled in' : 'off: no blocks, in the open'}`, async () => {
    const b = bot!;
    await fresh(b);
    const shelter = { x: area.x - 6, y: F, z: area.z };
    b.settings.set('nightShell', 'on');
    b.task.shelter!.set(shelter);
    await craftCmd('gamerule', 'keepinventory', 'false');
    await craftCmd('spawnpoint', b.name, String(area.x + 10), String(F), String(area.z));
    await loadKit(b, [['cobblestone', 16], ['stone_pickaxe', 1]]);
    if (RULE) b.settings.set('shellBlocks', 'on');
    const deaths = b.built.respawn?.deaths ?? 0;
    const from = b.logs.length;
    await b.truth.ok('kill', [b.name]);
    await until(() => ((b.built.respawn?.deaths ?? 0) > deaths ? true : undefined), 10_000, 'the death');
    await craftCmd('kill', '@e[type=item]');
    await until(() => (b.task.position() && (b.task.pve?.health() ?? 0) > 0 ? true : undefined), 30_000, 'the respawn', 500);
    const t0 = Date.now();
    if (RULE) await until(() => (carried(b) >= 10 ? true : undefined), 120_000, '10 shell blocks after the respawn', 500);
    else await sleep(15_000);
    const refillS = (Date.now() - t0) / 1000;
    const had = carried(b);
    await craftCmd('time', 'set', '13000');
    await until(() => {
      const p = b.task.position();
      return p && hdist(p, { x: shelter.x + 0.5, z: shelter.z + 0.5 }) < 1 ? true : undefined;
    }, 90_000, 'in the shelter', 500);
    await until(() => (b.logs.slice(from).some((l) => /night shell: (walled in|\d+ cell\(s\) open|\d+ throwaway blocks)/.test(l)) ? true : undefined), 60_000, 'the night shell line', 500);
    await sleep(1500);
    const solid = await solidCount(b, shell(shelter));
    const line = b.logs.slice(from).filter((l) => l.includes('night shell:')).slice(-1)[0] ?? '';
    notes.push(`death (shellBlocks ${RULE ? 'on' : 'off'}): ${had} shell blocks ${refillS.toFixed(1)} s after the respawn; ${solid} of 9 shell cells solid at night; ${line}; ${b.logs.slice(from).filter((l) => l.includes('blocks chore')).join(' | ')}`);
    await craftCmd('time', 'set', '23100');
    await sleep(8000);
    await craftCmd('gamerule', 'keepinventory', 'true');
    if (RULE) {
      expect(had).toBeGreaterThanOrEqual(10);
      expect(solid).toBe(9);
    } else {
      expect(had).toBe(0);
      expect(solid).toBe(0);
    }
  }, 480_000);
});
