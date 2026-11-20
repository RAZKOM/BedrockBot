// e2e (tag @bds), Track E5 (docs/early-game.md "Other ground", ADR 0103): branch mining never digs inside the base round
// home. On a flat, peaceful server with the truth pack (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER
// point it at another). One afk-task bot in its own area, `protectRadius 8`, `mineBranchY -63` (the flat world's
// dirt), `mineTunnelLen 6`; `!home set` where the bot stands, then `!mine iron_ore 1` with no iron in the world: the
// miner knows none and branch mines. Before (measured on a fresh plains world: `!home set` where the kit ended, then
// the iron kit's `!mine iron_ore 33`), the staircase started at home and dug the base; now the bot walks out past the
// base's edge first and digs away from home.
// E5_BEFORE=1 records what the code did without asserting the new behaviour (the before runs on the base tree).
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1, E5_OUT=<file>.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearArea, E2E, FEET_Y, loadKit, prepareServer, privateArea, startCraftBot, teleport, truthLoaded, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const BEFORE = process.env.E5_BEFORE === '1';
const R = 8;

describe.skipIf(!E2E)('@bds early base: branch mining starts outside the base round home (Track E5)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const home = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyBase');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    b.settings.set('protectRadius', String(R));
    b.settings.set('mineBranchY', '-63');
    b.settings.set('mineTunnelLen', '6');
    await teleport(b, home);
    await clearArea(b.truth, { x: area.x, z: area.z }, 40, 12);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      // the dug dirt back (the layers under the flat world's grass)
      await truthLoaded(bot.truth, 'fill', [area.x - 40, F - 3, area.z - 40, area.x + 40, F - 2, area.z + 40, 'dirt']).catch(() => undefined);
      await truthLoaded(bot.truth, 'fill', [area.x - 40, F - 1, area.z - 40, area.x + 40, F - 1, area.z + 40, 'grass_block']).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 40, 12).catch(() => undefined);
      bot.task.home?.set(undefined);
      await bot.stop();
    }
    const text = `[early-base e2e]${BEFORE ? ' (before)' : ''} area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}\n`;
    console.log(text);
    if (process.env.E5_OUT) appendFileSync(process.env.E5_OUT, text);
  }, 120_000);

  it('home set where the bot stands, no ore known: the staircase starts past the base edge and nothing in the base is dug', async () => {
    const b = bot!;
    await loadKit(b, [
      ['stone_pickaxe', 1],
      ['cobblestone', 16],
    ]);
    b.task.home?.set({ x: Math.floor(home.x), y: F, z: Math.floor(home.z) }); // (as !home set where it stands)
    const logFrom = b.logs.length;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!mine iron_ore 1');
    const end = await b.reply((s) => /^branch iron_ore: |^mine iron_ore: |branch mining iron_ore: inside the base/.test(s), from, 240_000);
    const ms = Date.now() - t0;
    const dug = b.logs
      .slice(logFrom)
      .map((l) => / dig \((-?\d+), (-?\d+), (-?\d+)\): \S+ -> air/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }));
    const dist = (p: { x: number; z: number }) => Math.hypot(p.x + 0.5 - home.x, p.z + 0.5 - home.z);
    const inside = dug.filter((p) => dist(p) <= R);
    const first = dug[0];
    notes.push(`${end}; ${(ms / 1000).toFixed(1)} s; ${dug.length} dug, ${inside.length} inside the base (r ${R}); the first at ${first ? `${dist(first).toFixed(1)} from home` : '-'}; ${b.logs.slice(logFrom).filter((l) => l.includes('branch:')).slice(0, 3).join(' | ')}`);
    if (BEFORE) return;
    expect(dug.length).toBeGreaterThan(4);
    expect(inside).toEqual([]);
    expect(dist(first!)).toBeGreaterThan(R);
    expect(b.logs.slice(logFrom).some((l) => l.includes('branch: inside the base (protectRadius 8 round home): walking out to '))).toBe(true);
  }, 300_000);

  // Track E5: measured on a fresh snowy taiga, the kit with 6 spruce logs carried asked for logs again and stopped
  // (`!gather 4 got nothing (gather done: 6/4 logs)`): the server's twelve planks kinds, spruce never tried
  it('spruce logs only: `!get wooden_pickaxe` crafts spruce planks from them (no gather)', async () => {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    await loadKit(b, [['spruce_log', 6]]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get wooden_pickaxe');
    const end = await b.reply((s) => s.startsWith("get wooden_pickaxe: "), from, 120_000);
    const got = (await b.truth.craftinv(b.name)).counts;
    notes.push(`spruce: ${end}; ${((Date.now() - t0) / 1000).toFixed(1)} s; ${JSON.stringify(got)}`);
    if (BEFORE) return;
    expect(end).toMatch(/^get wooden_pickaxe: done in \d+ s, 1 step/);
    expect(got.wooden_pickaxe ?? 0).toBe(1);
    expect(got.spruce_planks ?? 0).toBeGreaterThan(0);
  }, 180_000);

  // Track E5: measured on a fresh mountain world with home set, the fuel step `!mine coal_ore 4` refused every coal ore
  // it knew (816, all inside the base: protected_area) and got nothing; coal in the base is no coal for the fuel rule
  it('home set, coal ore only inside the base: `!get iron_ingot 3` burns planks from the logs, no coal step', async () => {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    await teleport(b, home);
    const hx = Math.floor(home.x);
    const hz = Math.floor(home.z);
    b.task.home?.set({ x: hx, y: F, z: hz });
    await truthLoaded(b.truth, 'fill', [hx + 3, F - 2, hz - 1, hx + 4, F - 2, hz + 1, 'coal_ore']);
    await loadKit(b, [
      ['stone_pickaxe', 1],
      ['cobblestone', 16],
      ['crafting_table', 1],
      ['raw_iron', 3],
      ['oak_log', 1],
    ]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get iron_ingot 3');
    const end = await b.reply((s) => s.startsWith("get iron_ingot: "), from, 240_000).catch(() => 'no end reply');
    if (end === 'no end reply') {
      await b.command('!get stop');
      await b.command('!stop');
    }
    const got = (await b.truth.craftinv(b.name)).counts;
    notes.push(`coal: ${end}; ${((Date.now() - t0) / 1000).toFixed(1)} s; iron_ingot ${got.iron_ingot ?? 0}; ${b.said.slice(from).filter((s) => /^mining |coal/.test(s)).slice(0, 3).join(' | ')}`);
    if (BEFORE) return;
    expect(end).toMatch(/^get iron_ingot: done in \d+ s/);
    expect(end).not.toMatch(/mine coal_ore/);
    expect(got.iron_ingot ?? 0).toBe(3);
  }, 300_000);

  // Track E5: measured on a fresh mountain world, 2 oak logs carried, the iron kit's fuel step `!gather 1` ended at once
  // (`gather done: 2/1 logs`: `!gather N` counts the logs carried), got nothing, and the job stopped
  it('2 oak logs carried, 2 chests asked (4 logs): the gather step gets the 2 more from a tree', async () => {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    b.task.home?.set(undefined);
    const tx = area.x - 14;
    const tz = area.z + 14;
    await teleport(b, { x: tx + 4.5, y: F, z: tz + 0.5 });
    await truthLoaded(b.truth, 'tree', [tx, F, tz, 5, 'oak', 1]);
    await loadKit(b, [
      ['oak_log', 2],
      ['crafting_table', 1],
    ]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get chest 2');
    const end = await b.reply((s) => s.startsWith("get chest: "), from, 240_000).catch(() => 'no end reply');
    if (end === 'no end reply') {
      await b.command('!get stop');
      await b.command('!stop');
    }
    const got = (await b.truth.craftinv(b.name)).counts;
    notes.push(`gather: ${end}; ${((Date.now() - t0) / 1000).toFixed(1)} s; ${JSON.stringify(got)}`);
    await truthLoaded(b.truth, 'fill', [tx - 3, F, tz - 3, tx + 3, F + 9, tz + 3, 'air']).catch(() => undefined);
    if (BEFORE) return;
    expect(end).toMatch(/^get chest: done in \d+ s/);
    expect(got.chest ?? 0).toBe(2);
  }, 300_000);

  // Track E5: measured on a fresh mountain world, the kit's table stood in a notch of the pit the stone step had dug;
  // the line from the eye to its top face crossed the block over it and the next craft refused it, with no planks for
  // a second table (`!craft stone_pickaxe 1 got nothing (craft: made no stone_pickaxe (no_table))`)
  it('in a one-wide pit two deep: `!get kit` sets its table in a notch and uses it for every craft', async () => {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    b.task.home?.set(undefined);
    const px = area.x + 20;
    const pz = area.z;
    await truthLoaded(b.truth, 'fill', [px, F - 2, pz, px, F - 1, pz, 'air']);
    await teleport(b, { x: px + 0.5, y: F - 2, z: pz + 0.5 });
    await loadKit(b, [
      ['cobblestone', 24],
      ['oak_planks', 12], // what the kit plans; with 4 left after the sticks, the refused table costs a second one
      ['bread', 6],
    ]);
    const from = b.said.length;
    const logFrom = b.logs.length;
    const t0 = Date.now();
    await b.command('!get kit');
    const end = await b.reply((s) => s.startsWith("get kit: "), from, 240_000).catch(() => 'no end reply');
    if (end === 'no end reply') {
      await b.command('!get stop');
      await b.command('!stop');
    }
    const got = (await b.truth.craftinv(b.name)).counts;
    const placed = b.logs.slice(logFrom).filter((l) => l.includes('craft: crafting table placed at ')).length;
    notes.push(`pit: ${end}; ${((Date.now() - t0) / 1000).toFixed(1)} s; ${placed} table(s) placed; ${JSON.stringify(got)}`);
    if (BEFORE) return;
    expect(end).toMatch(/^get kit: done in \d+ s/);
    expect(placed).toBe(1);
    for (const it of ['stone_sword', 'stone_pickaxe', 'stone_axe', 'crafting_table']) expect(got[it] ?? 0).toBe(1);
  }, 300_000);
});
