// e2e (tag @bds), Track E1 (docs/early-game.md "Craft chains"): `!craft` on a flat, peaceful server with the truth pack
// (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another one). One afk-task bot in its own area.
//   chain    6 oak logs, `!craft wooden_pickaxe`: the planks, the table and the sticks are crafted first in the same
//            process, then the pickaxe (before: `craft: no oak_planks for wooden_pickaxe (need 3, have 0)`)
//   names    8 planks, `!craft stone_pickaxe`: the refusal names cobblestone, not the tag, and points at `!get`
//            (before: `craft: no stone_tool_materials for stone_pickaxe (need 3, have 0)`)
//   litter   leaf litter in every cell round the feet and leaves over them: the table goes on a litter cell cleared
//            first (before: `craft: no free cell next to the bot for a crafting table`, nothing crafted)
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, tablesAround, teleport, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds dayone craft: chains, raw-material refusals, a table on leaf litter (Track E1)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('DayCraft');
    bot = b;
    b.settings.set('autoUnload', 'off');
    await teleport(b, feet);
    await clearArea(b.truth, { x: area.x, z: area.z }, 8, 6);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 8, 6).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[dayone-craft e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('chain: 6 oak logs -> a wooden pickaxe (planks, the table and sticks first, one command)', async () => {
    const b = bot!;
    await loadKit(b, [['oak_log', 6]]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!craft wooden_pickaxe');
    const start = await b.reply((s) => s.startsWith('crafting ') || s.startsWith('craft: '), from);
    expect(start).toMatch(/^crafting 1 wooden_pickaxe \(first \d+ oak_planks, 1 crafting_table, \d+ stick, crafting table\)$/);
    const end = await b.reply((s) => s.startsWith('crafted ') || s.startsWith('craft: '), from, 60_000);
    notes.push(`chain: ${start} -> ${end} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    expect(end).toMatch(/^crafted 1 wooden_pickaxe .*; first crafted \d+ oak_planks, 1 crafting_table, \d+ stick$/);
    const inv = await b.truth.craftinv(b.name);
    expect(inv.counts.wooden_pickaxe).toBe(1);
    expect(inv.counts.crafting_table).toBe(1);
    expect(await tablesAround(b.truth, { x: area.x, y: F, z: area.z }, 3)).toEqual([]);
  }, 120_000);

  it('names: planks only -> the refusal names cobblestone and !get, nothing is crafted', async () => {
    const b = bot!;
    await loadKit(b, [['oak_planks', 8]]);
    const from = b.said.length;
    await b.command('!craft stone_pickaxe');
    const r = await b.reply((s) => s.startsWith('craft'), from);
    notes.push(`names: ${r}`);
    expect(r).toMatch(/^craft: no cobblestone for stone_pickaxe \(3 cobblestone missing; it would craft .*stick.* first; !get stone_pickaxe gets it all\)$/);
    await sleep(500);
    expect((await b.truth.craftinv(b.name)).counts).toEqual({ oak_planks: 8 });
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 60_000);

  it('litter: leaf litter round the feet and leaves over it -> the table on a cleared litter cell, picked up after', async () => {
    const b = bot!;
    await teleport(b, feet);
    await loadKit(b, [['oak_planks', 3], ['stick', 2], ['crafting_table', 1]]);
    // the measured case: litter in every ring cell at the feet, a canopy one over the head
    await craftCmd('fill', String(area.x - 2), String(F), String(area.z - 2), String(area.x + 2), String(F), String(area.z + 2), 'leaf_litter');
    await craftCmd('setblock', String(area.x), String(F), String(area.z), 'air');
    await craftCmd('fill', String(area.x - 2), String(F + 2), String(area.z - 2), String(area.x + 2), String(F + 2), String(area.z + 2), 'oak_leaves', '["persistent_bit"=true]');
    await sleep(1500);
    const litter = (await b.truth.block({ x: area.x + 1, y: F, z: area.z })).typeId;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!craft wooden_pickaxe');
    const end = await b.reply((s) => s.startsWith('crafted ') || s.startsWith('craft: '), from, 60_000);
    const log = b.logs.filter((x) => /clear|crafting table placed|no free cell/.test(x)).slice(-3);
    notes.push(`litter (${litter}): ${end} (${((Date.now() - t0) / 1000).toFixed(1)} s); ${log.join(' | ')}`);
    expect(litter).toBe('minecraft:leaf_litter');
    expect(end).toMatch(/^crafted 1 wooden_pickaxe \(3 oak_planks, 2 stick used\) in [\d.]+ s; crafting table placed and picked up$/);
    expect((await b.truth.craftinv(b.name)).counts).toMatchObject({ wooden_pickaxe: 1, crafting_table: 1 });
    expect(await tablesAround(b.truth, { x: area.x, y: F, z: area.z }, 3)).toEqual([]);
    await craftCmd('fill', String(area.x - 2), String(F), String(area.z - 2), String(area.x + 2), String(F + 2), String(area.z + 2), 'air');
  }, 120_000);
});
