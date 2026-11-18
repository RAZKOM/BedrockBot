// e2e (tag @bds), Track E2 (docs/early-game.md "The iron age"): the furnace set down and smelting, on a flat, peaceful
// server with the truth pack (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another one).
//   furnace  8 cobblestone and 2 logs carried, no home: `!furnace` crafts the table's chain and the furnace and sets it
//            down next to the bot (truth: a furnace block there); a second `!furnace` places nothing
//   smelt    5 raw iron and 1 coal carried: `!smelt` puts them in that furnace, waits, takes 5 iron ingots out (truth)
//   home     a home 12 blocks away and a furnace carried: `!smelt iron 2` walks home, sets it down within 16 of home
//            and smelts 2 of the 3 raw iron (planks for fuel)
//   cook     raw beef, planks and 8 cobblestone carried, no furnace near: the owner's `!cook` crafts one, sets it down, cooks
//   tunnel   a one-wide stone tunnel, one side cell open: `!smelt` sets the furnace there, then `!craft iron_pickaxe` digs
//            a stone side cell out for the crafting table (before: `craft: made no iron_pickaxe (no_table)`)
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearArea, E2E, FEET_Y, hdist, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, type CraftBot } from './craft-truth.ts';
import type { Vec3 } from '../../src/world/types.ts';

const F = FEET_Y;

/** Furnace blocks within `r` (x, z) of `c` at the feet level (truth). */
async function furnacesAround(b: CraftBot, c: Vec3, r: number): Promise<Vec3[]> {
  const out: Vec3[] = [];
  for (let dx = -r; dx <= r; dx++)
    for (let dz = -r; dz <= r; dz++) {
      const p = { x: Math.floor(c.x) + dx, y: F, z: Math.floor(c.z) + dz };
      const t = (await b.truth.block(p)).typeId;
      if (t === 'minecraft:furnace' || t === 'minecraft:lit_furnace') out.push(p);
    }
  return out;
}

describe.skipIf(!E2E)('@bds iron smelt: a furnace set down and smelting (Track E2)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('IronSm');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    await teleport(b, feet);
    await clearArea(b.truth, { x: area.x, z: area.z }, 20, 12);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 20, 12).catch(() => undefined);
      await truthLoaded(bot.truth, 'fill', [area.x - 20, F - 1, area.z - 20, area.x + 20, F - 1, area.z + 20, 'grass_block']).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[iron-smelt e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('furnace: !furnace crafts one from cobblestone and sets it down next to the bot; again: nothing placed', async () => {
    const b = bot!;
    b.task.home?.set(undefined);
    await loadKit(b, [
      ['cobblestone', 8],
      ['oak_log', 2],
    ]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!furnace');
    expect(await b.reply((s) => s.startsWith('furnace'), from)).toMatch(/^furnace: crafting one from 8 cobblestone here$/);
    const end = await b.reply((s) => /^furnace (placed|:)/.test(s) && !s.includes('crafting one'), from, 90_000);
    const ms = Date.now() - t0;
    const placed = await furnacesAround(b, feet, 3);
    notes.push(`furnace: ${end}; ${(ms / 1000).toFixed(1)} s; truth ${JSON.stringify(placed)}; inventory ${JSON.stringify((await b.truth.craftinv(b.name)).counts)}`);
    expect(end).toMatch(/^furnace placed at -?\d+ -?\d+ -?\d+ \(crafted from 8 cobblestone\)$/);
    expect(placed).toHaveLength(1);
    const f2 = b.said.length;
    await b.command('!furnace');
    expect(await b.reply((s) => s.startsWith('furnace'), f2)).toMatch(/^furnace: one stands at -?\d+ -?\d+ -?\d+ already$/);
    await sleep(1000);
    expect(await furnacesAround(b, feet, 3)).toHaveLength(1);
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 150_000);

  it('smelt: !smelt puts the raw iron and the coal in, waits, takes the ingots out', async () => {
    const b = bot!;
    await loadKit(b, [
      ['raw_iron', 5],
      ['coal', 1],
    ]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!smelt');
    expect(await b.reply((s) => s.startsWith('smelting') || s.startsWith('smelt:'), from)).toMatch(/^smelting 5 raw_iron in the furnace at /);
    const end = await b.reply((s) => s.startsWith('smelted') || s.startsWith('smelt:'), from, 120_000);
    const ms = Date.now() - t0;
    const inv = (await b.truth.craftinv(b.name)).counts;
    notes.push(`smelt: ${end}; ${(ms / 1000).toFixed(1)} s; inventory ${JSON.stringify(inv)}`);
    expect(end).toMatch(/^smelted 5 iron_ingot in the (lit_)?furnace at -?\d+ -?\d+ -?\d+ \(\d+ s, fuel 1 coal\)$/);
    expect(inv.iron_ingot).toBe(5);
    expect(inv.raw_iron ?? 0).toBe(0);
    expect(ms).toBeGreaterThan(5 * 10_000 - 2000);
  }, 150_000);

  it('home: with a home 12 away and a furnace carried, !smelt iron 2 sets it down within 16 of home and smelts 2', async () => {
    const b = bot!;
    const h = { x: area.x + 12, y: F, z: area.z + 0.5 };
    // clear the first furnace away so none stands within 16 of home
    for (const p of await furnacesAround(b, feet, 3)) await truthLoaded(b.truth, 'fill', [p.x, p.y, p.z, p.x, p.y, p.z, 'air']);
    b.task.home?.set({ x: Math.floor(h.x) + 0.5, y: F, z: Math.floor(h.z) + 0.5 });
    const homeAt = b.task.home?.get();
    await teleport(b, { x: area.x - 0.5, y: F, z: area.z + 0.5 });
    await loadKit(b, [
      ['furnace', 1],
      ['raw_iron', 3],
      ['oak_planks', 4],
    ]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!smelt iron 2');
    expect(await b.reply((s) => s.startsWith('smelting') || s.startsWith('smelt:'), from)).toBe('smelting 2 raw_iron; setting a furnace down first');
    const end = await b.reply((s) => s.startsWith('smelted') || s.startsWith('smelt:'), from, 120_000);
    const ms = Date.now() - t0;
    const inv = (await b.truth.craftinv(b.name)).counts;
    const placed = await furnacesAround(b, h, 4);
    const me = b.task.position()!;
    notes.push(`home: ${end}; ${(ms / 1000).toFixed(1)} s; home ${JSON.stringify(homeAt)}; furnace ${JSON.stringify(placed)}; bot ${hdist(me, h).toFixed(1)} from home; inventory ${JSON.stringify(inv)}`);
    expect(end).toMatch(/^smelted 2 iron_ingot in the (lit_)?furnace at .* \(\d+ s, fuel 2 oak_planks\); furnace placed at -?\d+ -?\d+ -?\d+$/);
    expect(placed).toHaveLength(1);
    expect(hdist({ x: placed[0]!.x + 0.5, y: F, z: placed[0]!.z + 0.5 }, h)).toBeLessThanOrEqual(5);
    expect(inv.iron_ingot).toBe(2);
    expect(inv.raw_iron).toBe(1);
  }, 150_000);

  it('cook: raw beef, planks and 8 cobblestone, no furnace near: !cook sets one down and cooks', async () => {
    const b = bot!;
    b.task.home?.set(undefined);
    const spot = { x: area.x - 10.5, y: F, z: area.z - 10.5 };
    await teleport(b, spot);
    await loadKit(b, [
      ['beef', 2],
      ['oak_planks', 6],
      ['cobblestone', 8],
    ]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!cook');
    const end = await b.reply((s) => s.startsWith('cooked') || s.startsWith('cook:'), from, 120_000);
    const ms = Date.now() - t0;
    const inv = (await b.truth.craftinv(b.name)).counts;
    const placed = await furnacesAround(b, spot, 3);
    notes.push(`cook: ${end}; ${(ms / 1000).toFixed(1)} s; furnace ${JSON.stringify(placed)}; inventory ${JSON.stringify(inv)}; replies ${b.said.slice(from).join(' | ')}`);
    expect(end).toMatch(/^cooked 2 cooked_beef in the (lit_)?furnace at /);
    expect(placed).toHaveLength(1);
    expect(inv.cooked_beef).toBe(2);
  }, 150_000);

  it('tunnel: in a one-wide stone tunnel the furnace takes the open cell, the table goes into a dug side cell', async () => {
    const b = bot!;
    b.task.home?.set(undefined);
    const c = { x: area.x + 10, z: area.z - 10 };
    // the furnaces the cases before set down go (the cooker would walk to one of them)
    await truthLoaded(b.truth, 'fill', [area.x - 20, F, area.z - 20, area.x + 20, F + 1, area.z + 20, 'air']);
    // stone round a 1 x 2 body cell, the cell east of the feet open
    await truthLoaded(b.truth, 'fill', [c.x - 3, F, c.z - 3, c.x + 3, F + 2, c.z + 3, 'stone']);
    await truthLoaded(b.truth, 'fill', [c.x, F, c.z, c.x, F + 1, c.z, 'air']);
    await truthLoaded(b.truth, 'fill', [c.x + 1, F, c.z, c.x + 1, F, c.z, 'air']);
    await teleport(b, { x: c.x + 0.5, y: F, z: c.z + 0.5 });
    await loadKit(b, [
      ['furnace', 1],
      ['raw_iron', 3],
      ['coal', 1],
      ['stick', 2],
      ['crafting_table', 1],
      ['stone_pickaxe', 1],
    ]);
    const from = b.said.length;
    await b.command('!smelt');
    const sm = await b.reply((s) => s.startsWith('smelted') || s.startsWith('smelt:'), from, 120_000);
    const f2 = b.said.length;
    const t0 = Date.now();
    await b.command('!craft iron_pickaxe');
    const end = await b.reply((s) => s.startsWith('crafted') || s.startsWith('craft:'), f2, 60_000);
    const ms = Date.now() - t0;
    const inv = (await b.truth.craftinv(b.name)).counts;
    notes.push(`tunnel: ${sm}; ${end}; ${(ms / 1000).toFixed(1)} s; inventory ${JSON.stringify(inv)}; logs ${b.logs.filter((l) => /table|furnace:/.test(l)).slice(-4).join(' | ')}`);
    expect(sm).toMatch(/^smelted 3 iron_ingot in the (lit_)?furnace at -?\d+ -?\d+ -?\d+ .*; furnace placed at /);
    expect(end).toMatch(/^crafted 1 iron_pickaxe /);
    expect(inv.iron_pickaxe).toBe(1);
    await truthLoaded(b.truth, 'fill', [c.x - 3, F, c.z - 3, c.x + 3, F + 2, c.z + 3, 'air']);
  }, 240_000);
});
