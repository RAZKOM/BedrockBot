// e2e (tag @bds), wave 9 Track AG (docs/home.md "Spare shulker boxes"): when every chest at home is
// full, `!unload` takes an empty shulker box from the box chest, places it next to the bot, fills it,
// breaks it, picks it up and stores the full box in the box chest. On bds-home (flat, peaceful, truth
// pack), one afk-task bot in its own random area, the home of home-truth.ts buildHome read by
// `!chests scan`, then every container filled to the brim with stone by truth (the box chest keeps
// its 3 empty boxes), and the inventory: an iron pickaxe and 30 stacks of cobblestone.
//   expected  2 boxes filled (27 stacks + the rest; 16 cobblestone kept), both stored back in the box
//             chest: truth:container counts 3 shulker boxes there, and the boxes' NBT `Items` (the
//             server's inventory_content for the chest window, read by the bot) hold 1904 cobblestone
// Env: HOME_BDS_HOST / HOME_BDS_PORT / HOME_BDS_CONTAINER (home-truth.ts), HOME_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { buildHome, E2E, FEET_Y, prepareServer, privateArea, removeHome, sleep, startHomeBot, teleport, until, type HomeBot, type HomeLayout } from './home-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds home: spare shulker boxes when the chests are full (Track AG)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: HomeBot | undefined;
  let L: HomeLayout | undefined;

  beforeAll(async () => {
    await prepareServer();
    const b = await startHomeBot('Spare');
    bot = b;
    b.settings.set('autoUnload', 'off');
    L = await buildHome(b, area);
    b.task.home!.set(L.home);
    const from = b.said.length;
    await b.command('!chests scan');
    await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000); // Track AN: the scan line
  }, 240_000);

  afterAll(async () => {
    if (bot) {
      await removeHome(bot, L, area);
      await bot.stop();
    }
    console.log(`[home-shulker e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('chests full: a box from the box chest takes the overflow and goes back full', async () => {
    const b = bot!;
    const l = L!;
    const mob = b.built.mobility!;
    // every container full (truth), the box chest with its 3 empty boxes
    for (const p of [l.coal, l.wood, l.empty, l.boxes, l.barrel]) await b.truth.chestPut(p, 'stone', 64, 'all');
    for (const p of [l.coal, l.wood, l.empty, l.boxes, l.barrel]) expect((await b.truth.box(p)).free).toBe(0);
    await teleport(b, { x: l.home.x + 0.5, y: F, z: l.home.z + 0.5 });
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_pickaxe', 1]);
    await b.truth.stuff(b.name, 'cobblestone', 30);
    const inv = mob.world.inventory;
    await until(() => (inv.count('cobblestone') === 1920 ? true : undefined), 10_000, '30 stacks in the model');
    await sleep(300);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!unload');
    expect(await b.reply((s) => s.startsWith('unloading ') || s.startsWith('unload: '), from)).toBe('unloading 30 stacks into 5 known containers');
    const end = await b.reply((s) => s.startsWith('unloaded: ') || s.startsWith('unload: '), from, 300_000);
    const ms = Date.now() - t0;
    const rep = b.home.logistics.lastUnload!;
    notes.push(`unload: ${end} (${(ms / 1000).toFixed(1)} s; ${rep.requests} requests, ${rep.shared} on the shared Containers, ${rep.chests} chest trips, ${rep.boxes} boxes)`);
    notes.push(`inventory at the end: truth ${JSON.stringify(await b.truth.counts(b.name))}, model ${JSON.stringify(inv.slots.map((x, i) => (x ? `${i}:${x.count} ${x.name}` : '')).filter(Boolean))}`);
    notes.push(`keeper / warnings:\n    ${b.logs.filter((x) => x.includes('keeper') || x.includes(' warn ') || x.includes('unload:')).slice(-30).join('\n    ')}`);
    if (rep.boxes !== 2) notes.push(`log:\n    ${b.logs.filter((x) => !x.includes(':nav info')).slice(-80).join('\n    ')}`);
    expect(rep.boxes).toBe(2);
    expect(rep.left).toEqual([]);
    expect(end).toContain('2 shulker boxes filled and stored');
    expect(end).toContain('kept 16 cobblestone');
    // truth: the inventory and the box chest (3 boxes, the rest stone)
    const counts = await b.truth.counts(b.name);
    notes.push(`inventory after: ${JSON.stringify(counts)}`);
    expect(counts).toEqual({ iron_pickaxe: 1, cobblestone: 16 });
    const box = await b.truth.box(l.boxes);
    notes.push(`box chest after: ${JSON.stringify(box.counts)} free ${box.free}`);
    expect(box.counts.undyed_shulker_box).toBe(3);
    // no box (or box drop) left in the world
    expect((await b.truth.boxItems({ x: l.home.x + 0.5, y: F, z: l.home.z + 0.5 }, 12)).filter((i) => i.typeId.endsWith('shulker_box'))).toHaveLength(0);
    // the boxes' contents: the server's own data (NBT Items in the chest window's inventory_content)
    const o = await mob.skills.open(l.boxes);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    const inside: Record<string, number>[] = [];
    o.view.slots.forEach((s, i) => {
      if (s && isShulkerBox(s.name)) inside.push(shulkerContents(inv.rawItem(o.view.id, i)));
    });
    await mob.skills.closeContainer(o.view);
    notes.push(`boxes in the box chest: ${JSON.stringify(inside)}`);
    const cobble = inside.reduce((a, c) => a + (c.cobblestone ?? 0), 0);
    expect(cobble).toBe(1920 - 16);
    expect(inside.filter((c) => Object.keys(c).length === 0)).toHaveLength(1); // one box still empty
    const rec = b.home.memory().get(l.boxes)!;
    expect(rec.boxes).toEqual({ empty: 1, full: 2 });
  }, 360_000);
});
