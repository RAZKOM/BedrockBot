// e2e (tag @bds), Track E4 (docs/early-game.md "Wear and setbacks", ADR 0101): the obtain job through wear and
// setbacks, on a flat, peaceful server with the truth pack (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER
// point it at another). One afk-task bot in its own area, no home set.
//   wear     a stone pickaxe with 13 uses left (the limit is 10), 5 iron ore in the floor: `!get iron_helmet` mines
//            until the pickaxe is worn, crafts a fresh one from the carried cobblestone, mines the rest, smelts, crafts
//   worn     a stone pickaxe with 6 uses left at the start, 3 iron ore: `!get iron_pickaxe` crafts a fresh one first
//   furnace  3 iron ore, a coal ore 23 blocks off: `!get iron_pickaxe` sets a furnace down by the ore, walks to the
//            coal (over 16 from the furnace), smelts at the same furnace (one furnace crafted, not two); the table the
//            job left standing is picked up
//   death    `deathReturn` on, the spawn point 30 blocks off, by day: a death 8 s into the smelt; the job walks back,
//            picks the drops up, takes the ingots out of the furnace, crafts the pickaxe; by night it does not go back
// E4_BEFORE=1 records what the code did without asserting the new behaviour (the before runs on the base tree).
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1, E4_OUT=<file> (the
// measured lines appended), E4_CASE=wear,worn,furnace,death,night (a subset).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const BEFORE = process.env.E4_BEFORE === '1';
const ONLY = process.env.E4_CASE; // wear | worn | furnace | death | night (all when unset)
const want = (c: string) => !ONLY || ONLY.split(',').includes(c);

describe.skipIf(!E2E)('@bds early wear: the obtain job through wear and setbacks (Track E4)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  /** Ore cells in the floor (y F - 1), a row starting at (x, z). */
  async function ores(x: number, z: number, n: number, block = 'iron_ore'): Promise<void> {
    for (let i = 0; i < n; i++) await truthLoaded(bot!.truth, 'fill', [x + (i % 5), F - 1, z + Math.floor(i / 5), x + (i % 5), F - 1, z + Math.floor(i / 5), block]);
  }

  /** The furnaces the earlier cases set down go (the smelt would walk to a remembered one within 64). */
  async function forgetFurnaces(b: CraftBot): Promise<void> {
    // (imported here: the base tree the before runs on has no such module)
    const placed = BEFORE ? [] : (await import('../../src/skills/items/placed.ts')).placedOf(b.task).all();
    for (const f of [...placed]) await truthLoaded(b.truth, 'fill', [f.p.x, f.p.y, f.p.z, f.p.x, f.p.y, f.p.z, 'air']);
  }

  const steps = (end: string) => /steps?(?:: | \()(.*?)\)?$/.exec(end)?.[1] ?? '';
  const count = (end: string, re: RegExp) => steps(end).split(', ').filter((s) => re.test(s)).length;

  beforeAll(async () => {
    await prepareServer();
    await craftCmd('gamerule', 'keepinventory', 'false');
    const b = await startCraftBot('EarlyWear');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    b.task.home?.set(undefined);
    await teleport(b, feet);
    await clearArea(b.truth, { x: area.x, z: area.z }, 40, 12);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await craftCmd('kill', '@e[type=item]').catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 40, 12).catch(() => undefined);
      await truthLoaded(bot.truth, 'fill', [area.x - 40, F - 1, area.z - 40, area.x + 40, F - 1, area.z + 40, 'grass_block']).catch(() => undefined);
      await craftCmd('time', 'set', 'noon').catch(() => undefined);
      await bot.stop();
    }
    const text = `[early-wear e2e]${BEFORE ? ' (before)' : ''} area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}\n`;
    console.log(text);
    if (process.env.E4_OUT) appendFileSync(process.env.E4_OUT, text); // a passing run's stdout is not shown
  }, 120_000);

  it.runIf(want('wear'))('wear: a stone pickaxe worn out in the mine step is replaced from the carried cobblestone and the rest is mined', async () => {
    const b = bot!;
    await teleport(b, feet);
    await ores(area.x + 4, area.z - 6, 5);
    await loadKit(b, [
      ['crafting_table', 1],
      ['cobblestone', 16],
      ['oak_planks', 8],
      ['coal', 2],
    ]);
    await b.truth.ok('givedamaged', [b.name, 'stone_pickaxe', 118]); // 131 - 118 = 13 uses left
    const inv = b.built.mobility!.world.inventory;
    await until(() => (inv.slots.some((s) => s?.name === 'stone_pickaxe' && s.damage === 118) ? true : undefined), 10_000, 'the worn pickaxe in the model');
    await sleep(500);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get iron_helmet');
    const end = await b.reply((s) => s.startsWith('get iron_helmet: '), from, 600_000);
    const ms = Date.now() - t0;
    const got = (await b.truth.craftinv(b.name)).counts;
    const model = inv.slots.filter((s) => s?.name.endsWith('_pickaxe')).map((s) => `${s!.name} damage ${s!.damage ?? '?'}`);
    const server = (await b.truth.ok<{ slots: { typeId: string; damage: number }[] }>('durability', [b.name])).slots.filter((s) => s.typeId.endsWith('_pickaxe')).map((s) => `${s.typeId.replace('minecraft:', '')} damage ${s.damage}`);
    notes.push(`wear: ${end}; ${(ms / 1000).toFixed(1)} s; pickaxes model [${model.join(', ')}] server [${server.join(', ')}]; inventory ${JSON.stringify(got)}; log ${b.logs.filter((l) => /mine:|pickaxe|worn/.test(l)).slice(-12).join(' | ')}`);
    if (BEFORE) return;
    expect(end).toMatch(/^get iron_helmet: done in \d+ s, \d+ steps; replaced the stone_pickaxe \(worn\)(; [^;]+)*; steps: mine iron_ore 5, craft stone_pickaxe 1, mine iron_ore \d, .*craft iron_helmet 1$/);
    // the helmet is worn right after the craft (the armour pass)
    const head = (await b.truth.ok<{ equipment: Record<string, { typeId?: string } | undefined> }>('durability', [b.name])).equipment.Head?.typeId ?? '';
    // (the two reads are not one snapshot: the pass may move it between them)
    expect((got.iron_helmet ?? 0) > 0 || head.endsWith('iron_helmet')).toBe(true);
    // the worn pickaxe kept at the limit or over it (10 uses left of 131 at most damage 121), the fresh one used
    expect(inv.slots.filter((s) => s?.name === 'stone_pickaxe').map((s) => s!.damage ?? 0).sort((a, c) => c - a)[0]).toBeLessThanOrEqual(122);
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 660_000);

  it.runIf(want('worn'))('worn: a stone pickaxe already past the limit at the start: a fresh one first, then the ore', async () => {
    const b = bot!;
    const spot = { x: area.x + 0.5, y: F, z: area.z - 12.5 };
    await teleport(b, spot);
    await ores(area.x + 4, area.z - 16, 3);
    await loadKit(b, [
      ['crafting_table', 1],
      ['cobblestone', 16],
      ['oak_planks', 8],
      ['coal', 2],
    ]);
    await b.truth.ok('givedamaged', [b.name, 'stone_pickaxe', 125]); // 6 uses left, under the limit of 10
    const inv = b.built.mobility!.world.inventory;
    await until(() => (inv.slots.some((s) => s?.name === 'stone_pickaxe' && s.damage === 125) ? true : undefined), 10_000, 'the worn pickaxe in the model');
    await sleep(500);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get iron_pickaxe');
    const end = await b.reply((s) => s.startsWith('get iron_pickaxe: '), from, 600_000);
    const ms = Date.now() - t0;
    const got = (await b.truth.craftinv(b.name)).counts;
    const server = (await b.truth.ok<{ slots: { typeId: string; damage: number }[] }>('durability', [b.name])).slots.filter((s) => s.typeId.endsWith('_pickaxe')).map((s) => `${s.typeId.replace('minecraft:', '')} damage ${s.damage}`);
    notes.push(`worn: ${end}; ${(ms / 1000).toFixed(1)} s; pickaxes [${server.join(', ')}]; inventory ${JSON.stringify(got)}`);
    if (BEFORE) return;
    expect(end).toMatch(/^get iron_pickaxe: done in \d+ s, \d+ steps; replaced the stone_pickaxe \(worn\)(; [^;]+)*; steps: craft stone_pickaxe 1, mine iron_ore 3, .*craft iron_pickaxe 1$/);
    expect(got.iron_pickaxe ?? 0).toBe(1);
  }, 660_000);

  it.runIf(want('furnace'))('furnace: no home, the bot walks off to the coal and smelts at the furnace it set down (one furnace crafted); its table is picked up', async () => {
    const b = bot!;
    const spot = { x: area.x - 14.5, y: F, z: area.z + 10.5 };
    await teleport(b, spot);
    await forgetFurnaces(b);
    const ox = area.x - 16;
    const oz = area.z + 14;
    await ores(ox, oz, 3);
    await ores(ox + 23, oz, 1, 'coal_ore');
    await loadKit(b, [
      ['stone_pickaxe', 1],
      ['crafting_table', 1],
      ['cobblestone', 16],
      ['stick', 2],
    ]);
    await sleep(1000);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get iron_pickaxe');
    const end = await b.reply((s) => s.startsWith('get iron_pickaxe: '), from, 600_000);
    const ms = Date.now() - t0;
    await sleep(1500);
    const got = (await b.truth.craftinv(b.name)).counts;
    const craft = b.craft.crafter;
    const furnaces = count(end, /^craft furnace /);
    notes.push(`furnace: ${end}; ${(ms / 1000).toFixed(1)} s; furnaces crafted ${furnaces}; tables placed ${craft.stats.tablesPlaced}, left standing ${craft.pendingTables.length}; inventory ${JSON.stringify(got)}; replies ${b.said.slice(from).filter((s) => /furnace|table/.test(s)).join(' | ')}`);
    if (BEFORE) return;
    expect(end).toMatch(/^get iron_pickaxe: done in \d+ s, \d+ steps; .*used the furnace at -?\d+ -?\d+ -?\d+ again.*; steps: mine iron_ore 3, craft furnace 1, furnace, mine coal_ore 1, smelt raw_iron 3, craft iron_pickaxe 1$/);
    expect(furnaces).toBe(1);
    expect(got.iron_pickaxe ?? 0).toBe(1);
    expect(got.crafting_table ?? 0).toBe(1);
    expect(craft.pendingTables).toEqual([]);
  }, 660_000);

  async function deathCase(label: string, night: boolean): Promise<void> {
    const b = bot!;
    const spot = { x: area.x + 14.5, y: F, z: area.z + 14.5 };
    await teleport(b, spot);
    await craftCmd('kill', '@e[type=item]');
    await forgetFurnaces(b);
    // the respawn point 30 blocks off (the world spawn is far from the private areas)
    await craftCmd('spawnpoint', b.name, String(Math.floor(spot.x) - 30), String(F), String(Math.floor(spot.z)));
    if (!BEFORE) b.settings.set('deathReturn', 'on'); // (the base tree has no such setting)
    await loadKit(b, [
      ['stone_pickaxe', 1],
      ['crafting_table', 1],
      ['furnace', 1],
      ['raw_iron', 3],
      ['coal', 1],
      ['stick', 2],
      ['cobblestone', 20],
      ['dirt', 10],
    ]);
    await sleep(1000);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get iron_pickaxe');
    // the smelt runs: 8 s into it (raw iron in the furnace), the bot dies
    await until(() => (b.said.slice(from).some((s) => s.startsWith('smelting ')) ? true : undefined), 120_000, 'the smelt step');
    await until(() => (b.built.mobility!.world.inventory.count('raw_iron') === 0 ? true : undefined), 60_000, 'the raw iron in the furnace');
    await sleep(8000);
    if (night) await craftCmd('time', 'set', 'midnight');
    const deaths = b.built.respawn?.deaths ?? 0;
    await b.truth.ok('kill', [b.name]);
    await until(() => ((b.built.respawn?.deaths ?? 0) > deaths ? true : undefined), 10_000, 'the death');
    const end = await b.reply((s) => s.startsWith('get iron_pickaxe: ') && !s.includes(' died ') && !s.includes(': recovered '), from, 420_000);
    const ms = Date.now() - t0;
    await sleep(1500);
    const got = (await b.truth.craftinv(b.name)).counts;
    const live = b.said.slice(from).filter((s) => / died |: recovered /.test(s));
    notes.push(`${label}: ${end}; ${(ms / 1000).toFixed(1)} s; live ${live.join(' | ')}; inventory ${JSON.stringify(got)}`);
    if (night) await craftCmd('time', 'set', 'noon');
    if (!BEFORE) b.settings.set('deathReturn', 'off');
    if (BEFORE) return;
    if (night) {
      expect(end).toMatch(/^get iron_pickaxe: stopped by a death \(\w+\) after \d+ s, \d+ steps? \(at !smelt raw_iron 3\): not going back: it is night or near dusk .*; the furnace at -?\d+ -?\d+ -?\d+ holds the smelt(; worked through a night .*)?$/);
      return;
    }
    expect(live[0]).toMatch(/^get iron_pickaxe: died \(at !smelt raw_iron 3\) \(\w+\); walking back \d+ blocks to -?\d+ -?\d+ -?\d+ for the drops$/);
    expect(live[1]).toMatch(/^get iron_pickaxe: recovered \d+ of \d+ stacks in \d+ s.*; smelted 3 iron_ingot in the furnace at .*; going on with the job$/);
    expect(end).toMatch(/^get iron_pickaxe: done in \d+ s, \d+ steps; recovered \d+ of \d+ stacks.*; steps: .*recover \d+\/\d+, craft iron_pickaxe 1$/);
    expect(got.iron_pickaxe ?? 0).toBe(1);
  }

  it.runIf(want('death'))('death: deathReturn on, by day: back for the drops and the ingots in the furnace, then the pickaxe', async () => {
    await deathCase('death', false);
  }, 600_000);

  it.runIf(want('night'))('night: deathReturn on, a death by night: not going back, the furnace named', async () => {
    await deathCase('night', true);
  }, 600_000);
});
