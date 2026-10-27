// e2e (tag @bds), wave 9 Track AG (docs/home.md): chest discovery, the chest memory, `!stock`,
// `!unload` and the autoUnload chore on bds-home (flat, peaceful, truth pack). One afk-task bot
// (walking, the CLI's wiring, settings in memory) in its own random area with a home of 4 chests and a
// barrel (home-truth.ts buildHome): coal + iron, oak logs (labelled `wood`), an empty double chest,
// 3 empty shulker boxes, a barrel with 5 dirt.
//   scan     `!chests scan` reads all 5 containers; the memory matches truth:container for each (the
//            double chest: one record of 54 slots, the other half its partner)
//   stock    `!stock coal` answers from memory
//   unload   inventory (truth:stuff) 2 stacks of coal, 2 of oak logs, 3 of cobblestone, 32 dirt, bread,
//            an iron pickaxe: `!unload` puts the coal with the coal, the logs with the logs (the `wood`
//            chest), the cobblestone into the empty chest (16 kept), the dirt into the barrel (its own
//            slot type `barrel`), keeps the bread and the pickaxe; every deposit is counted on the
//            shared Containers
//   chore    autoUnload on, 10 stacks of cobblestone, the bot walks back home: the chore unloads them
// Env: HOME_BDS_HOST / HOME_BDS_PORT / HOME_BDS_CONTAINER (home-truth.ts), HOME_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chestKey } from '../../src/world/cache/chests.ts';
import { buildHome, E2E, FEET_Y, prepareServer, privateArea, removeHome, sleep, startHomeBot, teleport, until, type HomeBot, type HomeLayout } from './home-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds home: chest memory, !stock, !unload (Track AG)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: HomeBot | undefined;
  let L: HomeLayout | undefined;

  beforeAll(async () => {
    await prepareServer();
    const b = await startHomeBot('Home');
    bot = b;
    b.settings.set('autoUnload', 'off');
    L = await buildHome(b, area);
    b.task.home!.set(L.home);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await removeHome(bot, L, area);
      await bot.stop();
    }
    console.log(`[home-chests e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('!chests scan reads all 5 containers; the memory matches truth', async () => {
    const b = bot!;
    const l = L!;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!chests scan');
    expect(await b.reply((s) => s.startsWith('chests: reading '), from)).toMatch(/^chests: reading the containers within 16 blocks of home/);
    const end = await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000);
    notes.push(`scan: ${end} (${((Date.now() - t0) / 1000).toFixed(1)} s from the command)`);
    // the session scan of the chore may have read some of them first: read + fresh = 5
    const m = /^chests: (\d+) within 16 blocks, (\d+) reachable within \d+ path blocks, read (\d+)/.exec(end); // Track AN: the scan line (homeChestWalk default 64)
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(6); // 6 blocks (the double chest has two)
    const mem = b.home.memory();
    for (const [what, p] of Object.entries({ coal: l.coal, wood: l.wood, boxes: l.boxes, barrel: l.barrel })) {
      const rec = mem.get(p);
      const truth = await b.truth.box(p);
      notes.push(`${what}: memory ${JSON.stringify(rec?.contents)} free ${rec?.free}/${rec?.size}; truth ${JSON.stringify(truth.counts)} free ${truth.free}/${truth.size}`);
      expect(rec?.readAt ?? 0).toBeGreaterThan(0);
      expect(rec!.contents).toEqual(truth.counts);
      expect(rec!.free).toBe(truth.free);
      expect(rec!.size).toBe(truth.size);
    }
    expect(mem.get(l.boxes)!.boxes).toEqual({ empty: 3, full: 0 });
    expect(mem.get(l.barrel)!.kind).toBe('barrel');
    // the double chest: one record of 54 slots, the other half is its partner
    const halves = [mem.get(l.empty), mem.get(l.emptyOther)].filter((r) => r && r.readAt > 0);
    expect(halves).toHaveLength(1);
    const dbl = halves[0]!;
    notes.push(`double chest: record at ${chestKey(dbl)}, size ${dbl.size}, partner ${dbl.partner ? chestKey(dbl.partner) : 'none'}`);
    expect(dbl.size).toBe(54);
    expect(dbl.double).toBe(true);
    expect(dbl.free).toBe(54);
    expect([chestKey(l.empty), chestKey(l.emptyOther)]).toContain(chestKey(dbl.partner!));
    // label the wood chest
    const f2 = b.said.length;
    await b.command(`!chests label ${l.wood.x} ${l.wood.y} ${l.wood.z} wood`);
    expect(await b.reply((s) => s.startsWith('chests: '), f2)).toBe(`chests: chest ${l.wood.x} ${l.wood.y} ${l.wood.z} (wood) labelled`);
    const f3 = b.said.length;
    await b.command('!chests');
    const list = await b.reply((s) => s.startsWith('chests: '), f3);
    notes.push(`!chests: ${list}`);
    expect(list).toMatch(/^chests: 5 remembered \(5 reachable\): /); // Track AN: the counts by kind first
  }, 180_000);

  it('!stock coal answers from memory', async () => {
    const b = bot!;
    const l = L!;
    const from = b.said.length;
    await b.command('!stock coal');
    const r = await b.reply((s) => s.startsWith('coal: ') || s.startsWith('stock: '), from);
    notes.push(`!stock coal: ${r}`);
    expect(r).toBe(`coal: 20 in chest ${l.coal.x} ${l.coal.y} ${l.coal.z}`);
    const f2 = b.said.length;
    await b.command('!stock shulker');
    const s = await b.reply((x) => x.startsWith('shulker_box: ') || x.startsWith('stock: '), f2);
    notes.push(`!stock shulker: ${s}`);
    expect(s).toBe(`shulker_box: 3 in chest ${l.boxes.x} ${l.boxes.y} ${l.boxes.z} (3 empty)`);
  }, 60_000);

  it('!unload: coal to the coal, logs to the wood chest, cobblestone to the empty chest, dirt to the barrel; keeps food, tools, 16 cobblestone', async () => {
    const b = bot!;
    const l = L!;
    const mob = b.built.mobility!;
    await teleport(b, { x: l.home.x + 0.5, y: F, z: l.home.z + 0.5 });
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_pickaxe', 1]);
    await b.truth.ok('give', [b.name, 'bread', 5]);
    await b.truth.stuff(b.name, 'coal', 2);
    await b.truth.stuff(b.name, 'oak_log', 2);
    await b.truth.stuff(b.name, 'cobblestone', 3);
    await b.truth.ok('give', [b.name, 'dirt', 32]);
    const inv = mob.world.inventory;
    await until(() => (inv.count('dirt') === 32 && inv.count('cobblestone') === 192 && inv.count('bread') === 5 ? true : undefined), 10_000, 'the inventory in the model');
    await sleep(300);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!unload');
    const start = await b.reply((s) => s.startsWith('unloading ') || s.startsWith('unload: '), from);
    notes.push(`!unload: ${start}`);
    expect(start).toBe('unloading 8 stacks into 5 known containers');
    const end = await b.reply((s) => s.startsWith('unloaded: ') || s.startsWith('unload: '), from, 180_000);
    const ms = Date.now() - t0;
    const rep = b.home.logistics.lastUnload!;
    notes.push(`unload: ${end} (${(ms / 1000).toFixed(1)} s; ${rep.requests} requests, ${rep.shared} on the shared Containers, ${rep.chests} chest trips)`);
    const at = (p: { x: number; y: number; z: number }) => `${p.x} ${p.y} ${p.z}`;
    expect(end).toContain(`128 coal -> chest ${at(l.coal)}`);
    expect(end).toContain(`128 oak_log -> chest ${at(l.wood)} (wood)`);
    expect(end).toMatch(new RegExp(`176 cobblestone -> double chest (${at(l.empty)}|${at(l.emptyOther)})`));
    expect(end).toContain(`32 dirt -> barrel ${at(l.barrel)}`);
    expect(end).toContain('kept 16 cobblestone');
    // one request per (stack, destination slot): coal and logs top up the partial stack first, then a new slot
    expect(rep.requests).toBe(4 + 4 + 3 + 1);
    expect(rep.shared).toBeGreaterThanOrEqual(rep.requests);
    // truth: the containers and the inventory
    const coal = await b.truth.box(l.coal);
    const wood = await b.truth.box(l.wood);
    const dbl = await b.truth.box(l.empty);
    const barrel = await b.truth.box(l.barrel);
    notes.push(`truth after: coal chest ${JSON.stringify(coal.counts)}, wood ${JSON.stringify(wood.counts)}, double ${JSON.stringify(dbl.counts)}, barrel ${JSON.stringify(barrel.counts)}`);
    expect(coal.counts).toEqual({ coal: 148, iron_ingot: 10 });
    expect(wood.counts).toEqual({ oak_log: 160 });
    expect(dbl.counts).toEqual({ cobblestone: 176 });
    expect(barrel.counts).toEqual({ dirt: 37 });
    const counts = await b.truth.counts(b.name);
    notes.push(`inventory after: ${JSON.stringify(counts)}`);
    expect(counts).toEqual({ iron_pickaxe: 1, bread: 5, cobblestone: 16 });
    // the memory followed every trip
    expect(b.home.memory().get(l.barrel)!.contents).toEqual({ dirt: 37 });
    const f2 = b.said.length;
    await b.command('!stock coal');
    expect(await b.reply((s) => s.startsWith('coal: '), f2)).toBe(`coal: 148 in chest ${at(l.coal)}`);
  }, 240_000);

  it('autoUnload: back home with 10 stacks of cobblestone, the chore unloads them', async () => {
    const b = bot!;
    const l = L!;
    const mob = b.built.mobility!;
    const away = { x: l.home.x + 0.5, y: F, z: l.home.z + 12.5 };
    await teleport(b, away);
    await b.truth.stuff(b.name, 'cobblestone', 10);
    await until(() => (mob.world.inventory.count('cobblestone') === 16 + 640 ? true : undefined), 10_000, 'the cobblestone in the model');
    b.settings.set('autoUnload', 'on');
    const before = b.home.chore.stats.unloads;
    const t0 = Date.now();
    const from = b.said.length;
    await b.command(`!goto ${l.home.x} ${l.home.y} ${l.home.z}`);
    await b.reply((s) => s.startsWith('arrived'), from, 60_000).catch(() => undefined);
    await until(() => (b.home.chore.stats.unloads > before ? true : undefined), 120_000, 'the chore to unload', 500);
    const rep = b.home.logistics.lastUnload!;
    const line = b.logs.filter((x) => x.includes(':home info unload:')).at(-1);
    notes.push(`chore: ${line} (${((Date.now() - t0) / 1000).toFixed(1)} s from the !goto)`);
    expect(rep.ok).toBe(true);
    expect(rep.moved.reduce((a, m) => a + (m.name === 'cobblestone' ? m.count : 0), 0)).toBe(640);
    expect(mob.world.inventory.count('cobblestone')).toBe(16);
    const dbl = await b.truth.box(l.empty);
    expect(dbl.counts.cobblestone).toBe(176 + 640);
    b.settings.set('autoUnload', 'off');
  }, 240_000);
});
