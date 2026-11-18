// e2e (tag @bds), Track E2 (docs/early-game.md "The iron age"): `!get` of iron items through the obtain job, on a flat,
// peaceful server with the truth pack (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another).
// One afk-task bot in its own area; iron ore set into the floor, an oak tree.
//   pickaxe  a stone pickaxe, 8 cobblestone and 3 logs carried, 3 iron ore in the floor: `!get iron_pickaxe` mines the
//            ore, crafts and sets down a furnace, smelts with planks, crafts the pickaxe
//   ingot    `!get iron_ingot 2` with 2 raw iron and a coal carried and the furnace standing: one smelt step
//   kit      the stone kit's tools, 24 cobblestone (16 kept, 8 for the furnace), 6 raw beef, 13 iron ore in the floor, two trees: `!get kit iron` gets the
//            pickaxe, sword, shield and bucket (9 ingots) and the boots the other 4 allow, cooks the beef, says what
//            fell short; the boots are worn and the shield is in the offhand
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WINDOW_ARMOR, WINDOW_OFFHAND } from '../../src/world/inventory.ts';
import { clearArea, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds iron get: iron items through the obtain job (Track E2)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  /** Iron ore cells in the floor (y F - 1), a row starting at (x, z). */
  async function ores(x: number, z: number, n: number): Promise<void> {
    for (let i = 0; i < n; i++) await truthLoaded(bot!.truth, 'fill', [x + (i % 5), F - 1, z + Math.floor(i / 5), x + (i % 5), F - 1, z + Math.floor(i / 5), 'iron_ore']);
  }

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('IronGet');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    b.task.home?.set(undefined);
    await teleport(b, feet);
    await clearArea(b.truth, { x: area.x, z: area.z }, 24, 12);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 24, 12).catch(() => undefined);
      await truthLoaded(bot.truth, 'fill', [area.x - 24, F - 1, area.z - 24, area.x + 24, F - 1, area.z + 24, 'grass_block']).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[iron-get e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('pickaxe: !get iron_pickaxe mines the ore, sets a furnace down, smelts, crafts', async () => {
    const b = bot!;
    await ores(area.x + 4, area.z - 6, 3);
    await loadKit(b, [
      ['stone_pickaxe', 1],
      ['cobblestone', 8],
      ['oak_log', 3],
    ]);
    await sleep(1000);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get iron_pickaxe');
    const first = await b.reply((s) => s.startsWith('getting ') || s.startsWith('get'), from);
    expect(first).toBe('getting iron_pickaxe: first !mine iron_ore 3');
    const end = await b.reply((s) => s.startsWith('get iron_pickaxe: '), from, 480_000);
    const ms = Date.now() - t0;
    const inv = (await b.truth.craftinv(b.name)).counts;
    notes.push(`pickaxe: ${end}; ${(ms / 1000).toFixed(1)} s; replies ${b.said.slice(from).join(' | ')}; inventory ${JSON.stringify(inv)}`);
    // Track E4: the job's table stood between its crafts and was picked up at the end (a note before the steps)
    expect(end).toMatch(/^get iron_pickaxe: done in \d+ s, \d+ steps; picked up the crafting table; steps: mine iron_ore 3, craft furnace 1, furnace, (craft oak_planks \d+, )?smelt raw_iron 3, craft iron_pickaxe 1$/);
    expect(inv.iron_pickaxe).toBe(1);
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 540_000);

  it('ingot: !get iron_ingot 2 with the raw iron carried and the furnace standing is one smelt step', async () => {
    const b = bot!;
    await loadKit(b, [
      ['raw_iron', 2],
      ['coal', 1],
    ]);
    const from = b.said.length;
    await b.command('!get iron_ingot 2');
    expect(await b.reply((s) => s.startsWith('getting ') || s.startsWith('get'), from)).toBe('getting 2 iron_ingot: first !smelt raw_iron 2');
    const end = await b.reply((s) => s.startsWith('get iron_ingot: '), from, 120_000);
    const inv = (await b.truth.craftinv(b.name)).counts;
    notes.push(`ingot: ${end}; inventory ${JSON.stringify(inv)}`);
    expect(end).toMatch(/^get iron_ingot: done in \d+ s, 1 step \(smelt raw_iron 2\)$/);
    expect(inv.iron_ingot).toBe(2);
  }, 180_000);

  it('kit: !get kit iron from the stone kit with 13 iron ore: the tools, the shield, the bucket, the boots; armour short', async () => {
    const b = bot!;
    const spot = { x: area.x - 12.5, y: F, z: area.z + 0.5 };
    await teleport(b, spot);
    await ores(area.x - 18, area.z + 5, 13);
    for (const t of [
      { x: area.x - 6, z: area.z - 4 },
      { x: area.x - 6, z: area.z + 4 },
    ])
      await truthLoaded(b.truth, 'tree', [t.x, F, t.z, 5, 'oak', 1]);
    await loadKit(b, [
      ['crafting_table', 1],
      ['stone_sword', 1],
      ['stone_pickaxe', 1],
      ['stone_axe', 1],
      ['cobblestone', 24],
      ['beef', 6],
      ['oak_log', 2],
    ]);
    await sleep(1500);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get kit iron');
    const first = await b.reply((s) => s.startsWith('getting ') || s.startsWith('get'), from);
    expect(first).toMatch(/^getting the kit iron \(iron_pickaxe, iron_sword, shield, bucket, iron_chestplate, iron_leggings, iron_boots, iron_helmet(, bed)?, 6 food\): first !/); // Track E3: + the soft bed
    const end = await b.reply((s) => s.startsWith('get kit iron: '), from, 900_000);
    const ms = Date.now() - t0;
    await sleep(3000); // the armour pass and the offhand move after the last craft
    const inv = (await b.truth.craftinv(b.name)).counts;
    const world = b.built.mobility!.world;
    const armour = (world.inventory.window(WINDOW_ARMOR)?.slots ?? []).map((s) => s?.name ?? '-');
    const offhand = world.inventory.window(WINDOW_OFFHAND)?.slots[0]?.name ?? (world.inventory.window(WINDOW_OFFHAND)?.slots ?? []).find((s) => s)?.name;
    notes.push(`kit: ${end}; ${(ms / 1000).toFixed(1)} s; armour ${armour.join(',')}; offhand ${offhand ?? '-'}; inventory ${JSON.stringify(inv)}`);
    expect(end).toMatch(/^get kit iron: done in \d+ s, \d+ steps; short: iron_chestplate, iron_leggings, iron_helmet(, bed)? \(!mine iron_ore 33 got 13(; !kill sheep 3 got 0 white_wool)?\)(; [^;()]+)*; steps: mine iron_ore 33, /); // Track E3: the bed last, short too with no sheep near; Track E4: the notes (`picked up the crafting table`) after what is short
    // Track E3: the longer `short:` leaves the smelt step past the reply limit; the job's log names it
    expect(b.logs.some((l) => l.includes('get kit iron: !smelt raw_iron 13 -> 13 items'))).toBe(true);
    expect(inv.iron_pickaxe).toBe(1);
    expect(inv.iron_sword).toBe(1);
    expect(inv.bucket).toBe(1);
    expect(inv.cooked_beef).toBe(6);
    await until(() => (armour.includes('iron_boots') || (world.inventory.window(WINDOW_ARMOR)?.slots ?? []).some((s) => s?.name === 'iron_boots') ? true : undefined), 10_000, 'the boots worn');
    await until(() => ((world.inventory.window(WINDOW_OFFHAND)?.slots ?? []).some((s) => s?.name === 'shield') ? true : undefined), 10_000, 'the shield in the offhand');
  }, 960_000);
});
