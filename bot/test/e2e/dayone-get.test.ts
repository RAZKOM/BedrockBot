// e2e (tag @bds), Track E1 (docs/early-game.md "From nothing"): `!get` of a crafted item from an empty inventory, on a
// flat, peaceful server with the truth pack (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at
// another one). One afk-task bot in its own area with two oak trees and a patch of stone in the floor.
//   pickaxe  nothing carried, `!get stone_pickaxe`: one log trip, the wooden pickaxe, 3 cobblestone mined with it, the
//            stone pickaxe (before: `get: I do not know how to get stone_pickaxe; I can get: ...`)
//   stop     `!get kit`, then `!get stop` while its first step runs: the job and its process end, nothing else starts
//   nothing  `!get enchanting_table`: refused with the reason (obsidian needs a diamond pickaxe, a book has no rule), no
//            process (Track E2: `!get iron_pickaxe` is an obtain job now: iron-get.test.ts)
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds dayone get: a crafted item from nothing (Track E1)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('DayGet');
    bot = b;
    b.settings.set('autoUnload', 'off');
    await teleport(b, feet);
    await clearArea(b.truth, { x: area.x, z: area.z }, 16, 12);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 16, 12).catch(() => undefined);
      await truthLoaded(bot.truth, 'fill', [area.x - 16, F - 1, area.z - 16, area.x + 16, F - 1, area.z + 16, 'grass_block']).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[dayone-get e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('pickaxe: nothing carried -> !get stone_pickaxe gathers, crafts, mines and crafts again', async () => {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    for (const t of [
      { x: area.x + 6, z: area.z - 3 },
      { x: area.x + 6, z: area.z + 4 },
    ])
      await truthLoaded(b.truth, 'tree', [t.x, F, t.z, 5, 'oak', 1]);
    // stone in the floor, its top open
    await truthLoaded(b.truth, 'fill', [area.x - 5, F - 1, area.z - 2, area.x - 3, F - 1, area.z + 2, 'stone']);
    await sleep(1500);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get stone_pickaxe');
    const first = await b.reply((s) => s.startsWith('getting ') || s.startsWith('get'), from);
    expect(first).toMatch(/^getting stone_pickaxe: first !gather \d+$/);
    const end = await b.reply((s) => s.startsWith('get stone_pickaxe: '), from, 420_000);
    const ms = Date.now() - t0;
    const counts = await b.truth.craftinv(b.name);
    notes.push(`pickaxe: ${end}; ${(ms / 1000).toFixed(1)} s; replies ${b.said.slice(from).join(' | ')}; inventory ${JSON.stringify(counts.counts)}`);
    // Track E4: the job's table is picked up before the mine step and at the end (a note before the steps)
    expect(end).toMatch(/^get stone_pickaxe: done in \d+ s, 4 steps(; picked up the crafting table; steps: | \()gather \d+, craft wooden_pickaxe 1, mine stone 3, craft stone_pickaxe 1\)?$/);
    expect(counts.counts.stone_pickaxe).toBe(1);
    expect(counts.counts.wooden_pickaxe).toBe(1);
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 480_000);

  it('stop: !get stop ends the kit job and its step', async () => {
    const b = bot!;
    await teleport(b, feet);
    await b.truth.ok('clear', [b.name]);
    await truthLoaded(b.truth, 'tree', [area.x + 10, F, area.z, 5, 'oak', 1]);
    await sleep(1000);
    const from = b.said.length;
    await b.command('!get kit');
    expect(await b.reply((s) => s.startsWith('getting the kit'), from)).toMatch(/^getting the kit \(crafting_table, stone_sword, stone_pickaxe, stone_axe, 16 cobblestone, 6 food\): first !gather \d+$/);
    await until(() => (b.processes.userProcesses().some((p) => p.name === 'gather') ? true : undefined), 10_000, 'the gather step');
    const f2 = b.said.length;
    await b.command('!get stop');
    const r = await b.reply((s) => s.startsWith('stopped get kit'), f2);
    await sleep(2000);
    notes.push(`stop: ${r}; after: ${b.said.slice(f2).join(' | ')}`);
    expect(r).toMatch(/^stopped get kit after 0 steps \(at !gather \d+\)$/);
    expect(b.processes.userProcesses()).toHaveLength(0);
    expect(b.said.slice(f2).some((s) => s.startsWith('get kit: '))).toBe(false);
  }, 120_000);

  it('nothing: !get enchanting_table is refused with the reason, no process', async () => {
    const b = bot!;
    const from = b.said.length;
    await b.command('!get enchanting_table');
    const r = await b.reply((s) => s.startsWith('get'), from);
    notes.push(`nothing: ${r}`);
    expect(r).toMatch(/^get enchanting_table: no way to get /);
    await sleep(500);
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 60_000);
});
