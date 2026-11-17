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
// Track K2 (the Realm bug: empty buckets only in the home chests, the bot more than 8 blocks from the home point):
//   bring    16 empty buckets in the home chest, the bot by the pen: `!bring bucket 2 home` takes 2 (withdraw takes buckets)
//   fromhome the same: `!milk` takes 2 buckets out of the chest and fills both at the cows
//   failed   the chest emptied behind the memory: the reply names the failed step and its reason; 40 blocks from home the
//            reply says the chests are out of reach and why
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
    /** Track K2: outside the pen's north fence, 11.7 blocks from home (the logistics' "at home" is 8). */
    byPen: { x: c.x + 10, y: F, z: c.z - 6 },
    /** Track K2: 40 blocks from home, out of reach of the home chests (homeChestRadius 16 + 8). */
    far: { x: c.x + 40, y: F, z: c.z },
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

  // Track K2: the Realm's case. Empty buckets only in the home chest (read by a scan), nothing carried, the bot next to the
  // pen (11.7 blocks from home: outside the home logistics' 8-block "at home", inside homeChestRadius + 8).
  async function bucketsAtHome(b: HomeBot, n: number): Promise<void> {
    await reset(b);
    // the pen as built (a gate an earlier case left open is closed again) with two adult cows in it
    await truthLoaded(b.truth, 'pen', [L.pen.x, L.pen.y, L.pen.z, 7, 7]);
    for (let i = await cowsInPen(b); i < 2; i++) await homeCmd('summon', 'cow', String(L.pen.x + 2 + i * 2 + 0.5), String(F), String(L.pen.z + 3.5), '0', '0', 'minecraft:ageable_grow_up');
    await until(async () => ((await cowsInPen(b)) >= 2 ? true : undefined), 10_000, 'two adult cows in the pen');
    await b.truth.chestPut(L.chest, 'bucket', n, 1);
    let from = b.said.length;
    await b.command('!chests clear');
    await b.reply((s) => s.startsWith('chests: forgot '), from);
    from = b.said.length;
    await b.command('!chests scan');
    note(`scan: ${await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000)}`);
    await teleport(b, centre(L.byPen));
    expect(b.home.logistics.atHome()).toBe(false);
  }
  async function forget(b: HomeBot): Promise<void> {
    const from = b.said.length;
    await b.command('!chests clear'); // the later cases see no buckets at home
    await b.reply((s) => s.startsWith('chests: forgot '), from).catch(() => undefined);
  }

  it('Track K2: empty buckets only in the home chest, the bot by the pen: `!bring bucket 2 home` takes 2 (the withdrawal works on buckets)', async () => {
    const b = bot!;
    await bucketsAtHome(b, 16);
    try {
      const from = b.said.length;
      const logs0 = b.logs.length;
      await b.command('!bring bucket 2 home');
      await until(() => (b.logs.slice(logs0).some((l) => l.includes(' bring: withdraw ')) ? true : undefined), 90_000, 'the withdrawal ended');
      const line = b.logs.slice(logs0).find((l) => l.includes(' bring: withdraw '))!.replace(/.* bring: /, '');
      note(`bring: ${line}; said ${b.said.slice(from).join(' | ')}`);
      expect(line).toMatch(/^withdraw done: took 2 bucket/);
      await until(async () => ((await counts(b)).empty === 2 ? true : undefined), 10_000, 'truth: 2 empty buckets');
      expect((await b.truth.box(L.chest)).counts.bucket ?? 0).toBe(14);
      await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 60_000, 'the bring over');
    } finally {
      await forget(b);
    }
  }, 200_000);

  it('Track K2: empty buckets only in the home chest, a cow near, the bot by the pen: `!milk` takes 2 out of the chest and fills them', async () => {
    const b = bot!;
    await bucketsAtHome(b, 16);
    try {
      const st = milkControllerOf(b.task)!.statusLine();
      note(`status: ${st}`);
      expect(st).toContain('next: 2 bucket from home, 2 at the cows');
      const from = b.said.length;
      const logs0 = b.logs.length;
      const t0 = Date.now();
      await b.command('!milk');
      const start = await b.reply((s) => s.startsWith('milk: '), from);
      const end = await b.reply((s) => s.startsWith('milk: ') && s !== start, from, 150_000);
      const lines = b.logs.slice(logs0).filter((l) => / (milk|bring|supply): /.test(l)).map((l) => l.replace(/^\S+ info /, ''));
      note(`milk from home: "${start}" -> "${end}" after ${((Date.now() - t0) / 1000).toFixed(1)} s; ${lines.join(' | ')}`);
      expect(lines).toContain('milk: plan for 2: 2 bucket from the chests at home, 2 at the cows');
      expect(lines.some((l) => l.startsWith('bring: withdraw done: took 2 bucket'))).toBe(true);
      expect(end).toMatch(/^milk: 2 milk buckets carried \(2 from a cow\)$/);
      await until(async () => ((await counts(b)).milk === 2 ? true : undefined), 5_000, 'truth: 2 milk buckets');
      expect(await counts(b)).toMatchObject({ milk: 2, empty: 0 });
      expect((await b.truth.box(L.chest)).counts.bucket ?? 0).toBe(14);
      expect(await gateClosed(b)).toBe(true);
    } finally {
      await forget(b);
    }
  }, 240_000);

  it('Track K2: the take fails (the chest emptied behind the memory): the reply says which step failed and why', async () => {
    const b = bot!;
    await bucketsAtHome(b, 16);
    try {
      await truthLoaded(b.truth, 'container', [L.chest.x, L.chest.y, L.chest.z, 'clear']); // the memory still says 16
      const from = b.said.length;
      const logs0 = b.logs.length;
      await b.command('!milk');
      const start = await b.reply((s) => s.startsWith('milk: '), from);
      const end = await b.reply((s) => s.startsWith('milk: ') && s !== start, from, 120_000);
      const lines = b.logs.slice(logs0).filter((l) => / (milk|bring): /.test(l)).map((l) => l.replace(/^\S+ info /, ''));
      note(`failed take: "${end}"; ${lines.join(' | ')}`);
      expect(end).toBe('milk: 0 milk buckets carried (nothing new); 2 short of 2: buckets out of the chests at home: the chests at home gave none (fewer there than remembered)');
      expect(lines).toContain('milk: buckets out of the chests at home: got 0 of 2 (the chests at home gave none (fewer there than remembered))');
      // out of reach (40 blocks from home): the reply says how far and the limit, and nothing walks
      await truthLoaded(b.truth, 'container', [L.chest.x, L.chest.y, L.chest.z, 'clear']);
      await b.truth.chestPut(L.chest, 'bucket', 16, 1);
      await teleport(b, centre(L.home));
      await forget(b); // the failed take's visit remembered the chest empty (a fresh read the scan would keep)
      let f = b.said.length;
      await b.command('!chests scan');
      await b.reply((s) => /^chests: \d+ within /.test(s), f, 120_000);
      await teleport(b, centre(L.far));
      f = b.said.length;
      await b.command('!milk');
      const s0 = await b.reply((s) => s.startsWith('milk: '), f);
      const far = await b.reply((s) => s.startsWith('milk: ') && s !== s0, f, 30_000);
      note(`out of reach: "${far}"`);
      expect(far).toBe('milk: 0 milk buckets carried (nothing new); 2 short of 2: 2 more: 16 buckets in the chests at home, out of reach: I am 40 blocks from home (they count within 24)');
      expect(hdist(b.task.position()!, centre(L.far))).toBeLessThan(1);
    } finally {
      await forget(b);
    }
  }, 240_000);

  // Track K3 (the Realm's case: home with a full inventory after test series): every slot holds a stack of loot
  async function fillInventory(b: HomeBot): Promise<void> {
    const loot = ['andesite', 'granite', 'diorite', 'tuff', 'calcite', 'cobbled_deepslate'];
    const inv = b.built.mobility!.world.inventory;
    for (let i = 0; i < 36; i++) await b.truth.ok('give', [b.name, loot[i % loot.length]!, 64]);
    await until(() => (inv.slots.slice(0, 36).every((s) => !!s && s.count > 0) ? true : undefined), 15_000, 'a full inventory in the model');
    await sleep(300);
  }

  it('Track K3: a full inventory at home, 16 buckets in the chest: `!bring bucket 2 home` unloads a stack first and takes 2 (3 of 3)', async () => {
    const b = bot!;
    const results: string[] = [];
    try {
      for (let trial = 1; trial <= 3; trial++) {
        await bucketsAtHome(b, 16);
        await teleport(b, centre(L.home));
        await fillInventory(b);
        const from = b.said.length;
        const logs0 = b.logs.length;
        const t0 = Date.now();
        await b.command('!bring bucket 2 home');
        const end = await b.reply((s) => /^(brought|bring:) /.test(s), from, 120_000);
        const lines = b.logs.slice(logs0).filter((l) => / (withdraw|bring): /.test(l)).map((l) => l.replace(/^\S+ info /, ''));
        note(`bring full #${trial}: "${end}" after ${((Date.now() - t0) / 1000).toFixed(1)} s; ${lines.join(' | ')}`);
        expect(lines).toContain('withdraw: no room for 1 stack: unloading 1 first');
        expect(end).toMatch(/^brought 2 buckets home \(from 1 chest; made room: unloaded 1 stack \(64 [a-z_]+\)\)$/);
        await until(async () => ((await counts(b)).empty === 2 ? true : undefined), 10_000, 'truth: 2 empty buckets');
        expect((await b.truth.box(L.chest)).counts.bucket ?? 0).toBe(14);
        await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 60_000, 'the bring over');
        results.push(`#${trial} ok`);
        await forget(b);
      }
    } finally {
      note(`bring with a full inventory: ${results.length} of 3 (${results.join(', ')})`);
      await forget(b);
    }
  }, 600_000);

  it('Track K3: a full inventory at home, 16 buckets in the chest, cows near: `!milk` makes room, takes 2 and fills both (3 of 3)', async () => {
    const b = bot!;
    const results: string[] = [];
    try {
      for (let trial = 1; trial <= 3; trial++) {
        await bucketsAtHome(b, 16);
        await teleport(b, centre(L.home));
        await fillInventory(b);
        const from = b.said.length;
        const logs0 = b.logs.length;
        const t0 = Date.now();
        await b.command('!milk');
        const start = await b.reply((s) => s.startsWith('milk: '), from);
        const end = await b.reply((s) => s.startsWith('milk: ') && s !== start, from, 150_000);
        const lines = b.logs.slice(logs0).filter((l) => / (milk|bring|withdraw): /.test(l)).map((l) => l.replace(/^\S+ info /, ''));
        note(`milk full #${trial}: "${end}" after ${((Date.now() - t0) / 1000).toFixed(1)} s; ${lines.join(' | ')}`);
        // 2 buckets in one stack: 1 slot for the take, 1 for the first milk bucket (the last fills in place)
        expect(lines).toContain('withdraw: no room for 2 stacks: unloading 2 first');
        expect(end).toMatch(/^milk: 2 milk buckets carried \(2 from a cow\); made room: unloaded 2 stacks \(.+\)$/);
        await until(async () => ((await counts(b)).milk === 2 ? true : undefined), 5_000, 'truth: 2 milk buckets');
        expect(await counts(b)).toMatchObject({ milk: 2, empty: 0 });
        expect((await b.truth.box(L.chest)).counts.bucket ?? 0).toBe(14);
        expect(await gateClosed(b)).toBe(true);
        results.push(`#${trial} ok`);
        await forget(b);
      }
    } finally {
      note(`milk with a full inventory: ${results.length} of 3 (${results.join(', ')})`);
      await forget(b);
    }
  }, 600_000);
});

// Track K3: cows farther out. Its own area: home at the centre, no pen, one adult cow 50 blocks east held in place
// (slowness), milkRange 64; `!milk far` with 2 empty buckets walks there by the normal walk, fills both and walks home.
describe.skipIf(!E2E)('@bds home: milk farther out (Track K3)', () => {
  const area = privateArea();
  const c = area;
  const notes: string[] = [];
  let bot: HomeBot | undefined;
  const home = { x: c.x, y: F, z: c.z };
  const cowAt = { x: c.x + 50, y: F, z: c.z };

  async function cowNear(b: HomeBot): Promise<number> {
    const r = await b.truth.ok<{ mobs: { typeId: string; baby: boolean }[] }>('herd', [cowAt.x + 0.5, F, cowAt.z + 0.5, 8]);
    return r.mobs.filter((m) => m.typeId === 'minecraft:cow' && !m.baby).length;
  }
  async function placeCow(b: HomeBot): Promise<void> {
    await homeCmd('kill', `@e[type=cow,x=${cowAt.x},y=${F},z=${cowAt.z},r=30]`).catch(() => undefined);
    await homeCmd('summon', 'cow', String(cowAt.x + 0.5), String(F), String(cowAt.z + 0.5), '0', '0', 'minecraft:ageable_grow_up');
    await until(async () => ((await cowNear(b)) >= 1 ? true : undefined), 10_000, 'an adult cow 50 blocks east');
    await homeCmd('effect', `@e[type=cow,x=${cowAt.x},y=${F},z=${cowAt.z},r=8]`, 'slowness', '600', '255', 'true');
  }

  beforeAll(async () => {
    await prepareServer();
    const settings = new RuntimeSettings();
    settings.applyStartup('autoFood', false);
    settings.applyStartup('autoUnload', false);
    const b = await startHomeBot('MilkFar', {}, { settings });
    bot = b;
    await teleport(b, centre(home));
    await b.truth.clearAround(centre(home), 64);
    await clearAreaHome(b.truth, c, 24, 6);
    await clearAreaHome(b.truth, { x: c.x + 40, z: c.z }, 24, 6);
    b.task.home!.set(home);
    b.settings.set('milkRange', 64);
  }, 240_000);

  afterAll(async () => {
    if (bot) {
      await homeCmd('kill', `@e[type=cow,x=${cowAt.x},y=${F},z=${cowAt.z},r=30]`).catch(() => undefined);
      await bot.truth.clearAround(centre(home), 64).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[home-milk far e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('`!milk far` with milkRange 64: walks 50 blocks to the cow, fills 2 buckets and walks home (3 of 3)', async () => {
    const b = bot!;
    const results: string[] = [];
    try {
      for (let trial = 1; trial <= 3; trial++) {
        await teleport(b, centre(home));
        await b.truth.ok('clear', [b.name]);
        await until(() => (b.built.mobility!.world.inventory.slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
        await placeCow(b);
        const inv = b.built.mobility!.world.inventory;
        await b.truth.ok('give', [b.name, 'bucket', 2]);
        await until(() => (inv.count('bucket') >= 2 ? true : undefined), 10_000, '2 buckets in the model');
        const seen = [...b.built.mobility!.world.entities.values()].filter((e) => e.type === 'minecraft:cow').map((e) => hdist(e.pos, centre(home)).toFixed(0));
        const from = b.said.length;
        const logs0 = b.logs.length;
        const t0 = Date.now();
        await b.command('!milk far');
        const start = await b.reply((s) => s.startsWith('milk: '), from);
        const end = await b.reply((s) => s.startsWith('milk: ') && s !== start, from, 180_000);
        const s = (Date.now() - t0) / 1000;
        const lines = b.logs.slice(logs0).filter((l) => l.includes(' milk: ')).map((l) => l.replace(/^\S+ info /, ''));
        const back = hdist(b.task.position()!, centre(home));
        notes.push(`far #${trial}: cows in view at ${seen.join(', ') || 'none'} blocks; "${start}" -> "${end}" after ${s.toFixed(1)} s, ${back.toFixed(1)} blocks from home; ${lines.join(' | ')}`);
        expect(start).toMatch(/; the nearest within 64: a cow \d+ blocks away/);
        expect(end).toMatch(/^milk: 2 milk buckets carried \(2 from a cow\); went to a cow \d+ blocks away; walked home$/);
        await until(async () => ((await b.truth.counts(b.name)).milk_bucket === 2 ? true : undefined), 5_000, 'truth: 2 milk buckets');
        expect(back).toBeLessThan(3);
        results.push(`#${trial} ${s.toFixed(0)} s`);
      }
    } finally {
      notes.push(`far: ${results.length} of 3 (${results.join(', ')})`);
    }
  }, 900_000);

  it('`!milk far` with no cow within milkRange: the reply names the nearest one known', async () => {
    const b = bot!;
    await teleport(b, centre(home));
    await placeCow(b);
    b.settings.set('milkRange', 30);
    try {
      await b.truth.ok('clear', [b.name]);
      await b.truth.ok('give', [b.name, 'bucket', 1]);
      await until(() => (b.built.mobility!.world.inventory.count('bucket') >= 1 ? true : undefined), 10_000, 'a bucket in the model');
      const from = b.said.length;
      await b.command('!milk far');
      const start = await b.reply((s) => s.startsWith('milk: '), from);
      const end = await b.reply((s) => s.startsWith('milk: ') && s !== start, from, 60_000);
      notes.push(`none within 30: "${start}" -> "${end}"`);
      expect(start).toMatch(/; none known within 30 \(the nearest I know: a cow \d+ blocks away/);
      // `!milk` wants milkKeep (2) with 1 bucket carried
      expect(end).toMatch(/2 short of 2: no cow, mooshroom or goat known within 30 blocks \(the nearest I know: a cow \d+ blocks away/);
      expect(hdist(b.task.position()!, centre(home))).toBeLessThan(1.5);
    } finally {
      b.settings.set('milkRange', 64);
    }
  }, 120_000);
});
