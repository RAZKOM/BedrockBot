// e2e (tag @bds), Track K1 (ADR 0096, docs/pve.md "Milk on hand"): milk on hand on bds-home (flat, peaceful, truth
// pack). One afk-task bot (walking, the CLI's wiring, settings in memory, autoFood and autoUnload off) in its own random
// area; home at the area's centre, a 7 x 7 oak-fence pen 6 blocks east of it with two adult cows, a chest 3 blocks west.
//   milk     `!milk` with 3 empty buckets: all three filled at the cows in the pen (the click is breed.ts's
//            item_use_on_entity / interact with the bucket held), the gate closed again, 0 empty buckets left (truth)
//   trip     2 milk buckets in the home chest (read by `!chests scan`), nothing carried: a 20-block `!goto` takes both out
//            of the chest first (the trip readiness's milk step), then walks
//   refill   2 milk buckets carried, autoMilk on: the server poisons the bot for 30 s, milkCure drinks one (an empty bucket
//            is left), and the milk chore fills it again at the cows by itself (truth: 2 milk buckets, 0 empty)
//   craft    nothing but 3 iron ingots and a crafting table next to home: `!milk` crafts one bucket (milkCraft) and milks it
// Env: HOME_BDS_HOST / HOME_BDS_PORT / HOME_BDS_CONTAINER (home-truth.ts; default bds-home on 19196), HOME_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../src/config/settings.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { milkControllerOf } from '../../src/chat/commands-milk.ts';
import { bucketCounts } from '../../src/skills/food/milk.ts';
import { clearAreaHome, E2E, FEET_Y, hdist, homeCmd, prepareServer, privateArea, sleep, startHomeBot, teleport, truthLoaded, until, type HomeBot } from './home-truth.ts';

const F = FEET_Y;
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

describe.skipIf(!E2E)('@bds home: milk on hand (Track K1)', () => {
  const area = privateArea();
  const c = area;
  const notes: string[] = [];
  const note = (s: string): void => {
    notes.push(s);
  };
  let bot: HomeBot | undefined;
  const L = {
    home: { x: c.x, y: F, z: c.z },
    /** The pen: 7 x 7 from here, its gate in the middle of the north side. */
    pen: { x: c.x + 6, y: F, z: c.z - 3 },
    chest: { x: c.x - 3, y: F, z: c.z },
    table: { x: c.x, y: F, z: c.z + 3 },
    away: { x: c.x - 20, y: F, z: c.z },
  };
  const gate = { x: L.pen.x + 3, y: F, z: L.pen.z };

  const counts = async (b: HomeBot): Promise<{ milk: number; empty: number; iron: number }> => {
    const t = await b.truth.counts(b.name);
    return { milk: t.milk_bucket ?? 0, empty: t.bucket ?? 0, iron: t.iron_ingot ?? 0 };
  };
  const model = (b: HomeBot) => bucketCounts(b.built.mobility!.world.inventory.slots);

  async function reset(b: HomeBot): Promise<void> {
    await truthLoaded(b.truth, 'container', [L.chest.x, L.chest.y, L.chest.z, 'clear']);
    await teleport(b, centre(L.home));
    await b.truth.ok('clear', [b.name]);
    await until(() => (b.built.mobility!.world.inventory.slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
    await sleep(300);
  }

  async function give(b: HomeBot, item: string, n: number): Promise<void> {
    const inv = b.built.mobility!.world.inventory;
    const before = inv.count(item);
    await b.truth.ok('give', [b.name, item, n]);
    await until(() => (inv.count(item) >= before + n ? true : undefined), 10_000, `${n} ${item} in the model`);
  }

  async function cowsInPen(b: HomeBot): Promise<number> {
    const r = await b.truth.ok<{ mobs: { typeId: string; baby: boolean }[] }>('herd', [L.pen.x + 3.5, F, L.pen.z + 3.5, 6]);
    return r.mobs.filter((m) => m.typeId === 'minecraft:cow' && !m.baby).length;
  }

  async function gateClosed(b: HomeBot): Promise<boolean> {
    const r = await truthLoaded<{ states?: Record<string, unknown>; typeId?: string }>(b.truth, 'block', [gate.x, gate.y, gate.z]).catch(() => undefined);
    return r?.states?.open_bit !== true;
  }

  beforeAll(async () => {
    await prepareServer();
    const settings = new RuntimeSettings();
    settings.applyStartup('autoFood', false); // the food chore would hunt the cows
    settings.applyStartup('autoUnload', false);
    const b = await startHomeBot('Milk', {}, { settings });
    bot = b;
    await teleport(b, centre(L.home));
    await b.truth.clearAround(centre(L.home), 40);
    await clearAreaHome(b.truth, c, 24, 6);
    await truthLoaded(b.truth, 'pen', [L.pen.x, L.pen.y, L.pen.z, 7, 7]);
    for (let i = 0; i < 2; i++) await homeCmd('summon', 'cow', String(L.pen.x + 2 + i * 2 + 0.5), String(F), String(L.pen.z + 3.5), '0', '0', 'minecraft:ageable_grow_up');
    await until(async () => ((await cowsInPen(b)) >= 2 ? true : undefined), 10_000, 'two adult cows in the pen');
    await truthLoaded(b.truth, 'set', [L.chest.x, L.chest.y, L.chest.z, 'chest']);
    b.task.home!.set(L.home);
    await reset(b);
  }, 240_000);

  afterAll(async () => {
    if (bot) {
      await truthLoaded(bot.truth, 'container', [L.chest.x, L.chest.y, L.chest.z, 'clear']).catch(() => undefined);
      await bot.truth.clearAround(centre(L.home), 40).catch(() => undefined);
      await clearAreaHome(bot.truth, c, 24, 6).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[home-milk e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('!milk with 3 empty buckets: all filled at the cows in the pen, the gate closed again', async () => {
    const b = bot!;
    await reset(b);
    await give(b, 'bucket', 3);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!milk');
    const start = await b.reply((s) => s.startsWith('milk: '), from);
    const end = await b.reply((s) => s.startsWith('milk: ') && s !== start, from, 90_000);
    note(`milk: "${start}" -> "${end}" after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const ticks = b.logs.filter((l) => / milk: cow #\d+ milked \(\d+ ticks\)/.test(l)).map((l) => l.replace(/.* milk: /, ''));
    note(`clicks: ${ticks.join(', ')}`);
    expect(end).toMatch(/^milk: 3 milk buckets carried \(3 from a cow\)/);
    await until(async () => ((await counts(b)).milk === 3 ? true : undefined), 5_000, 'truth: 3 milk buckets');
    expect(await counts(b)).toMatchObject({ milk: 3, empty: 0 });
    expect(await cowsInPen(b)).toBe(2);
    const closed = await gateClosed(b);
    note(`gate closed after: ${closed}`);
    expect(closed).toBe(true);
  }, 150_000);

  it('the trip readiness: 2 milk buckets in the home chest are taken before a 20-block walk', async () => {
    const b = bot!;
    await reset(b);
    await b.truth.chestPut(L.chest, 'milk_bucket', 1, 2);
    let from = b.said.length;
    await b.command('!chests clear'); // forget what an earlier read saw: the scan reads the chest again
    await b.reply((s) => s.startsWith('chests: forgot '), from);
    from = b.said.length;
    await b.command('!chests scan');
    note(`scan: ${await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000)}`);
    await teleport(b, centre(L.home));
    expect(milkControllerOf(b.task)!.tripNeeded()).toBe(true);
    from = b.said.length;
    const t0 = Date.now();
    await b.command(`!goto ${L.away.x} ${L.away.y} ${L.away.z}`);
    await until(() => {
      const p = b.task.position();
      return p && hdist(p, centre(L.away)) < 1.5 ? true : undefined;
    }, 90_000, 'the bot at the goal');
    note(`trip: arrived after ${((Date.now() - t0) / 1000).toFixed(1)} s; ${b.logs.filter((l) => l.includes(' trip: milk: ')).map((l) => l.replace(/.* trip: /, '')).join(' | ')}`);
    expect(await counts(b)).toMatchObject({ milk: 2 });
    expect((await b.truth.box(L.chest)).counts.milk_bucket ?? 0).toBe(0);
    expect(b.logs.some((l) => l.includes(' trip: milk: 2 milk buckets carried (2 from the chests at home)'))).toBe(true);
    void from;
  }, 200_000);

  it('after a drink against the poison the milk chore refills the bucket by itself (autoMilk on)', async () => {
    const b = bot!;
    await reset(b);
    await give(b, 'milk_bucket', 2);
    b.settings.set('autoMilk', true);
    try {
      const t0 = Date.now();
      await b.truth.effect(b.name, 'poison', 30, 0);
      await until(() => (b.logs.some((l) => l.includes(' pve: milk drunk: the poison is gone')) ? true : undefined), 20_000, 'the milk drunk');
      const drunk = (Date.now() - t0) / 1000;
      await until(() => (model(b).empty >= 1 || model(b).milk === 2 ? true : undefined), 5_000, 'an empty bucket after the drink');
      await until(async () => {
        const n = await counts(b);
        return n.milk === 2 && n.empty === 0 ? true : undefined;
      }, 90_000, 'truth: 2 milk buckets again');
      const full = (Date.now() - t0) / 1000;
      await until(() => (b.logs.some((l) => l.includes(' milk chore: done, ')) ? true : undefined), 30_000, 'the chore done');
      note(`refill: drunk after ${drunk.toFixed(1)} s, 2 milk buckets again after ${full.toFixed(1)} s; ${b.logs.filter((l) => l.includes(' milk chore: ')).map((l) => l.replace(/.* milk chore: /, '')).join(' | ')}`);
      expect(b.logs.some((l) => l.includes(' milk chore: done, milk: 2 milk buckets carried (1 from a cow)'))).toBe(true);
      expect(await gateClosed(b)).toBe(true);
    } finally {
      b.settings.set('autoMilk', false);
    }
  }, 200_000);

  it('the early game: no bucket, 3 iron ingots and a crafting table near: one bucket crafted and milked', async () => {
    const b = bot!;
    await reset(b);
    await truthLoaded(b.truth, 'set', [L.table.x, L.table.y, L.table.z, 'crafting_table']);
    try {
      // no bucket and no iron: nothing to do, and `!status` says why
      let f = b.said.length;
      await b.command('!status');
      const st0 = await b.reply((s) => s.startsWith('status: '), f);
      note(`status before: ${st0.replace(/^.*(milk [^,]*\)).*$/, '$1')}`);
      expect(st0).toContain('milk 0/2 (no bucket and no iron (3 iron ingots make one))');
      f = b.said.length;
      await b.command('!milk');
      const none = await b.reply((s) => s.startsWith('milk: ') && !s.includes('getting'), f, 30_000);
      note(`no iron: ${none}`);
      expect(none).toContain('no bucket and no iron');
      await give(b, 'iron_ingot', 3);
      const from = b.said.length;
      await b.command('!milk');
      const start = await b.reply((s) => s.startsWith('milk: '), from);
      const end = await b.reply((s) => s.startsWith('milk: ') && s !== start, from, 120_000);
      note(`craft: "${start}" -> "${end}"`);
      expect(end).toMatch(/^milk: 1 milk bucket carried \(a bucket crafted from 3 iron ingots, 1 from a cow\)/);
      expect(await counts(b)).toMatchObject({ milk: 1, iron: 0 });
      // one bucket only (milkCraft makes 1 at most): `!status` says why no more come
      const f2 = b.said.length;
      await b.command('!status');
      const st = await b.reply((s) => s.startsWith('status: '), f2);
      note(`status after: ${st.replace(/^.*(milk [^,]*\)).*$/, '$1')}`);
      expect(st).toContain('milk 1/2 (1 more need a bucket)');
    } finally {
      await truthLoaded(b.truth, 'set', [L.table.x, L.table.y, L.table.z, 'air']).catch(() => undefined);
    }
  }, 200_000);
});
