// e2e (tag @bds), Track R9 (ADR 0097, docs/flight.md "Rockets on hand"): rockets on hand on bds-home (flat, peaceful,
// truth pack). One afk-task bot (walking, the CLI's wiring, settings in memory, autoFood and autoUnload off) in its own
// random area; home at the area's centre, a chest 3 blocks west, a crafting table 3 blocks south for the paper case.
//   chore    20 paper and 20 gunpowder in the home chest (read by `!chests scan`), a fireworks box of 4 rockets carried,
//            autoRockets on: the chore takes both out of the chest, crafts 60 rockets (1 paper + 1 gunpowder for 3, the
//            inventory's 2 x 2 grid) and puts them into the fireworks box: 64 in the box, nothing loose, the chest empty
//   cane     6 sugar cane and 2 gunpowder in the home chest, a crafting table near, no paper: `!rockets 6` takes 3 cane
//            and 2 gunpowder, makes 3 paper at the table and 6 rockets with flight duration 1 (the model reads it)
//   none     30 paper but no gunpowder anywhere: `!rockets` says so at once, and `!status` has `rockets 0/64 (no gunpowder)`
// Env: HOME_BDS_HOST / HOME_BDS_PORT / HOME_BDS_CONTAINER (home-truth.ts; default bds-home on 19196), HOME_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../src/config/settings.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { rocketsControllerOf } from '../../src/chat/commands-rockets.ts';
import { isShulkerBox } from '../../src/skills/container/chest.ts';
import { flightKitMemoryOf, readKit } from '../../src/skills/fly/kit.ts';
import { clearAreaHome, E2E, FEET_Y, prepareServer, privateArea, sleep, startHomeBot, teleport, truthLoaded, until, type HomeBot } from './home-truth.ts';

const F = FEET_Y;
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

describe.skipIf(!E2E)('@bds home: rockets on hand (Track R9)', () => {
  const area = privateArea();
  const c = area;
  const notes: string[] = [];
  const note = (s: string): void => {
    notes.push(s);
  };
  let bot: HomeBot | undefined;
  const L = {
    home: { x: c.x, y: F, z: c.z },
    chest: { x: c.x - 3, y: F, z: c.z },
    table: { x: c.x, y: F, z: c.z + 3 },
    drop: { x: c.x + 2, y: F, z: c.z },
  };

  const counts = async (b: HomeBot): Promise<Record<string, number>> => b.truth.counts(b.name);
  const kit = (b: HomeBot) => readKit(b.built.mobility!.world.inventory, flightKitMemoryOf(b.task));

  async function reset(b: HomeBot): Promise<void> {
    await truthLoaded(b.truth, 'container', [L.chest.x, L.chest.y, L.chest.z, 'clear']);
    await truthLoaded(b.truth, 'set', [L.table.x, L.table.y, L.table.z, 'air']);
    await teleport(b, centre(L.home));
    await b.truth.ok('clear', [b.name]);
    await until(() => (b.built.mobility!.world.inventory.slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
    await sleep(300);
  }

  /** Forget what an earlier read saw and read the chest again (the chest memory: Supply.available's home counts). */
  async function scan(b: HomeBot): Promise<void> {
    let from = b.said.length;
    await b.command('!chests clear');
    await b.reply((s) => s.startsWith('chests: forgot '), from);
    from = b.said.length;
    await b.command('!chests scan');
    note(`scan: ${await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000)}`);
    await teleport(b, centre(L.home));
  }

  /** A fireworks box of `n` rockets (the truth pack's, no NBT) dropped next to the bot and picked up. */
  async function fireworksBox(b: HomeBot, n: number): Promise<void> {
    const inv = b.built.mobility!.world.inventory;
    await b.truth.ok('boxdrop', [L.drop.x, L.drop.y, L.drop.z, 'firework_rocket', n, 1]);
    const has = () => (inv.slots.slice(0, 36).some((s) => !!s && isShulkerBox(s.name)) ? true : undefined);
    await sleep(1200);
    if (!has()) await b.built.mobility!.skills.collect(4, 160, { origin: centre(L.drop), filter: (it) => isShulkerBox(it.name) });
    await until(has, 10_000, 'the fireworks box in the inventory');
    await until(() => (kit(b).boxRockets === n ? true : undefined), 5_000, `the fireworks box of ${n} in the model`);
    await teleport(b, centre(L.home));
  }

  beforeAll(async () => {
    await prepareServer();
    const settings = new RuntimeSettings();
    settings.applyStartup('autoFood', false);
    settings.applyStartup('autoUnload', false);
    const b = await startHomeBot('Rockets', {}, { settings });
    bot = b;
    await teleport(b, centre(L.home));
    await b.truth.clearAround(centre(L.home), 40);
    await clearAreaHome(b.truth, c, 16, 6);
    await truthLoaded(b.truth, 'set', [L.chest.x, L.chest.y, L.chest.z, 'chest']);
    b.task.home!.set(L.home);
    await reset(b);
  }, 240_000);

  afterAll(async () => {
    if (bot) {
      await truthLoaded(bot.truth, 'container', [L.chest.x, L.chest.y, L.chest.z, 'clear']).catch(() => undefined);
      await bot.truth.clearAround(centre(L.home), 40).catch(() => undefined);
      await clearAreaHome(bot.truth, c, 16, 6).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[home-rockets e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('the chore: paper and gunpowder in the home chest, the fireworks box low: 60 crafted into the box, 64 in all', async () => {
    const b = bot!;
    await reset(b);
    await b.truth.chestPut(L.chest, 'paper', 20, 1);
    await b.truth.chestPut(L.chest, 'gunpowder', 20, 1);
    await fireworksBox(b, 4);
    await scan(b);
    const ctl = rocketsControllerOf(b.task)!;
    note(`before: ${ctl.statusLine()}`);
    const t0 = Date.now();
    b.settings.set('autoRockets', true);
    try {
      await until(() => (b.logs.some((l) => l.includes(' rockets chore: done, ')) ? true : undefined), 150_000, 'the rockets chore done');
    } finally {
      b.settings.set('autoRockets', false);
    }
    const s = (Date.now() - t0) / 1000;
    note(`chore: ${s.toFixed(1)} s; ${b.logs.filter((l) => / rockets chore: | rockets: | craft firework_rocket| supply: /.test(l)).map((l) => l.replace(/^\S+ info /, '')).join(' | ')}`);
    const done = b.logs.find((l) => l.includes(' rockets chore: done, '))!;
    expect(done).toContain('rockets: 64 carried (60 crafted, 20 gunpowder, 20 paper fetched, 60 into the fireworks box)');
    const k = kit(b);
    note(`kit: ${k.rockets} loose, the box ${k.boxRockets} (slot ${k.boxSlot})`);
    expect(k.boxRockets).toBe(64);
    expect(k.rockets).toBe(0);
    const n = await counts(b);
    expect(n.paper ?? 0).toBe(0);
    expect(n.gunpowder ?? 0).toBe(0);
    expect(n.firework_rocket ?? 0).toBe(0);
    const chest = await b.truth.box(L.chest);
    expect(chest.counts.paper ?? 0).toBe(0);
    expect(chest.counts.gunpowder ?? 0).toBe(0);
  }, 240_000);

  it('from sugar cane: 6 cane and 2 gunpowder in the home chest, a table near: !rockets 6 makes 3 paper there and 6 rockets of flight 1', async () => {
    const b = bot!;
    await reset(b);
    await truthLoaded(b.truth, 'set', [L.table.x, L.table.y, L.table.z, 'crafting_table']);
    await b.truth.chestPut(L.chest, 'sugar_cane', 6, 1);
    await b.truth.chestPut(L.chest, 'gunpowder', 2, 1);
    await scan(b);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!rockets 6');
    const start = await b.reply((x) => x.startsWith('rockets: '), from);
    const end = await b.reply((x) => x.startsWith('rockets: ') && x !== start, from, 150_000);
    note(`cane: "${start}" -> "${end}" after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    expect(end).toBe('rockets: 6 carried (6 crafted, 3 paper from sugar cane, 2 gunpowder, 3 sugar_cane fetched)');
    const n = await counts(b);
    expect(n).toMatchObject({ firework_rocket: 6, paper: 1 });
    expect(n.gunpowder ?? 0).toBe(0);
    expect(n.sugar_cane ?? 0).toBe(0);
    const inv = b.built.mobility!.world.inventory;
    const st = inv.slots.find((x) => x?.name === 'firework_rocket');
    note(`the model's crafted stack: ${st?.count} rockets, flight ${st?.flight ?? 'unknown'}`);
    expect(st?.flight).toBe(1);
    expect((await b.truth.box(L.chest)).counts.sugar_cane ?? 0).toBe(3);
    expect((await truthLoaded<{ typeId?: string }>(b.truth, 'block', [L.table.x, L.table.y, L.table.z])).typeId).toBe('minecraft:crafting_table');
  }, 240_000);

  it('no gunpowder anywhere: !rockets says so, and so does !status', async () => {
    const b = bot!;
    await reset(b);
    await b.truth.chestPut(L.chest, 'paper', 30, 1);
    await scan(b);
    let from = b.said.length;
    await b.command('!rockets');
    const r = await b.reply((x) => x.startsWith('rockets: '), from, 20_000);
    note(`none: ${r}`);
    expect(r).toBe('rockets: 0 of 64 carried; 64 short: no gunpowder (carried, in the boxes or at home)');
    from = b.said.length;
    await b.command('!status');
    const st = await b.reply((x) => x.startsWith('status: '), from);
    note(`status: ${st.replace(/^.*(rockets [^,]*\)).*$/, '$1')}`);
    expect(st).toContain('rockets 0/64 (no gunpowder)');
    await sleep(500);
    expect(b.processes.userProcesses().length).toBe(0);
  }, 120_000);
});
