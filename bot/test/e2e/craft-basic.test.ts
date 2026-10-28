// e2e (tag @bds), wave 11 Track AW (docs/crafting.md): `!craft` on bds-craft (flat, peaceful, truth
// pack). One afk-task bot (walking, the CLI's wiring, settings in memory) in its own random area.
//   2x2    8 oak logs -> `!craft oak_planks 32` -> 32 planks (truth), then `!craft stick 16` -> 16 sticks
//          from 8 planks: the inventory screen, no table
//   3x3    36 iron ingots and a crafting table carried -> `!craft iron_block 4`: the table is placed on a
//          free cell, opened as a workbench, 4 blocks made, the table dug and back in the inventory, no
//          table left standing (truth)
//   short  9 ingots, `!craft iron_block 100`: the start line names the shortfall, 1 block is made
//   keep   a diamond pickaxe, `!craft diamond_block`: refused (a tool is never an ingredient, and there
//          are no diamonds)
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearArea, E2E, FEET_Y, loadKit, prepareServer, privateArea, startCraftBot, tablesAround, teleport, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds craft: !craft in the inventory grid and at a crafting table (Track AW)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('Craft');
    bot = b;
    b.settings.set('autoUnload', 'off');
    await teleport(b, feet);
    await clearArea(b.truth, { x: area.x, z: area.z }, 8, 6);
    notes.push(`recipes indexed: ${b.craft.recipes.size}`);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 8, 6).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[craft-basic e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('2x2: 8 oak logs -> 32 planks, then 16 sticks from 8 of them (no table)', async () => {
    const b = bot!;
    await loadKit(b, [['oak_log', 8]]);
    let from = b.said.length;
    let t0 = Date.now();
    await b.command('!craft oak_planks 32');
    const start = await b.reply((s) => s.startsWith('crafting ') || s.startsWith('craft: '), from);
    expect(start).toBe('crafting 32 oak_planks (8 oak_log)');
    const end = await b.reply((s) => s.startsWith('crafted ') || s.startsWith('craft: '), from, 30_000);
    notes.push(`planks: ${end} (${((Date.now() - t0) / 1000).toFixed(1)} s from the command)`);
    expect(end).toMatch(/^crafted 32 oak_planks \(8 oak_log used\) in [\d.]+ s$/);
    let inv = await b.truth.craftinv(b.name);
    expect(inv.counts).toEqual({ oak_planks: 32 });
    from = b.said.length;
    t0 = Date.now();
    await b.command('!craft stick 16');
    expect(await b.reply((s) => s.startsWith('crafting ') || s.startsWith('craft: '), from)).toBe('crafting 16 stick (8 oak_planks)');
    const end2 = await b.reply((s) => s.startsWith('crafted ') || s.startsWith('craft: '), from, 30_000);
    notes.push(`sticks: ${end2} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    expect(end2).toMatch(/^crafted 16 stick \(8 oak_planks used\) in [\d.]+ s$/);
    inv = await b.truth.craftinv(b.name);
    expect(inv.counts).toEqual({ oak_planks: 24, stick: 16 });
    expect(b.built.mobility!.world.inventory.count('stick')).toBe(16);
    expect(b.built.mobility!.world.inventory.count('oak_planks')).toBe(24);
  }, 120_000);

  it('3x3: 36 ingots and a carried table -> 4 iron blocks; the table is placed, used and picked up', async () => {
    const b = bot!;
    await loadKit(b, [['iron_ingot', 36], ['crafting_table', 1]]);
    expect(await tablesAround(b.truth, { x: area.x, y: F, z: area.z }, 3)).toEqual([]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!craft iron_block 4');
    expect(await b.reply((s) => s.startsWith('crafting ') || s.startsWith('craft: '), from)).toBe('crafting 4 iron_block (36 iron_ingot, crafting table)');
    const end = await b.reply((s) => s.startsWith('crafted ') || s.startsWith('craft: '), from, 60_000);
    notes.push(`iron blocks: ${end} (${((Date.now() - t0) / 1000).toFixed(1)} s from the command)`);
    expect(end).toMatch(/^crafted 4 iron_block \(36 iron_ingot used\) in [\d.]+ s; crafting table placed and picked up$/);
    const inv = await b.truth.craftinv(b.name);
    expect(inv.counts).toEqual({ iron_block: 4, crafting_table: 1 });
    expect(await tablesAround(b.truth, { x: area.x, y: F, z: area.z }, 3)).toEqual([]);
    expect(b.built.mobility!.world.inventory.count('crafting_table')).toBe(1);
    expect(b.built.mobility!.world.inventory.count('iron_block')).toBe(4);
    const line = b.logs.filter((x) => x.includes(':craft info craft iron_block')).at(-1);
    notes.push(`log: ${line}`);
  }, 120_000);

  it('shortfall: 9 ingots for 100 blocks -> the reply says so and 1 block is made', async () => {
    const b = bot!;
    await loadKit(b, [['iron_ingot', 9], ['crafting_table', 1]]);
    const from = b.said.length;
    await b.command('!craft iron_block 100');
    const start = await b.reply((s) => s.startsWith('crafting ') || s.startsWith('craft: '), from);
    expect(start).toBe('crafting 1 iron_block (9 iron_ingot, crafting table; 891 iron_ingot short for 100)');
    const end = await b.reply((s) => s.startsWith('crafted ') || s.startsWith('craft: '), from, 60_000);
    notes.push(`shortfall: ${end}`);
    expect(end).toMatch(/^crafted 1 iron_block \(9 iron_ingot used\) in [\d.]+ s; crafting table placed and picked up; 891 iron_ingot short for 100$/);
    expect((await b.truth.craftinv(b.name)).counts).toEqual({ iron_block: 1, crafting_table: 1 });
  }, 120_000);

  it('keep rule: a diamond pickaxe is never an ingredient; no recipe; a busy guard', async () => {
    const b = bot!;
    await loadKit(b, [['diamond_pickaxe', 1], ['crafting_table', 1]]);
    const from = b.said.length;
    await b.command('!craft diamond_block');
    const r = await b.reply((s) => s.startsWith('craft'), from);
    notes.push(`keep: ${r}`);
    expect(r).toBe('craft: no diamond for diamond_block (need 9, have 0)');
    expect((await b.truth.craftinv(b.name)).counts).toEqual({ diamond_pickaxe: 1, crafting_table: 1 });
    const f2 = b.said.length;
    await b.command('!craft elytra');
    expect(await b.reply((s) => s.startsWith('craft'), f2)).toBe('craft: no recipe for elytra I can use (crafting table and inventory recipes only)');
    const f3 = b.said.length;
    await b.command('!craft');
    expect(await b.reply((s) => s.startsWith('usage'), f3)).toMatch(/^usage: !craft <item> \[n\]/);
  }, 60_000);
});
