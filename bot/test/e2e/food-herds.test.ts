// Track AF (wave 8, food v2) on bds-food (difficulty easy; docs/food.md "Herd memory", "Pens"):
//   1. herds: 4 cows summoned 120 blocks east of home while the bot stands next to them (a herd mark is
//      recorded), the bot walks back 112 blocks home (`!goto`), then `!food 4` walks back to them from
//      the mark and brings 4+ beef (truth inventory), with `foodLeave 0`;
//   2. pens: a fenced pen with 2 cows and 2 free cows outside; `!food 6` takes the 2 free cows and leaves
//      the pen alone (truth herd: 2 adults in the pen, none outside).
// Needs BDS_E2E=1 and bds-food with the truth pack (`node scripts/bds.mjs --profile food up` and `... pack`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../src/config/settings.ts';
import { foodControllerOf, foodExtrasOf } from '../../src/chat/commands-food.ts';
import { centre, clearArea, E2E, FEET_Y, foodCmd, prepareServer, privateArea, startFoodBot, teleport, truthLoaded, until, type FoodBot } from './food-truth.ts';

describe.skipIf(!E2E)('food v2: remembered herds and pens (Track AF)', () => {
  let bot: FoodBot | undefined;
  const area = privateArea();
  // home on the west side of the cell, so the herd 120 blocks east stays inside this run's 256-block cell
  const HOME = { x: area.x - 100, y: FEET_Y, z: area.z };
  const FAR = { x: HOME.x + 120, y: FEET_Y, z: HOME.z };
  /** Pen of test 2: 7 x 7 from (HOME.x + 12, HOME.z - 3), gate in the middle of its north side. */
  const PEN = { x: HOME.x + 12, y: FEET_Y, z: HOME.z - 3 };
  const PEN_MID = { x: PEN.x + 3.5, y: FEET_Y, z: PEN.z + 3.5 };
  const FREE = { x: HOME.x - 10, y: FEET_Y, z: HOME.z };
  const measurements: string[] = [];
  const note = (s: string) => {
    console.log(s);
    measurements.push(s);
  };
  const summonAdults = async (at: { x: number; z: number }, n: number) => {
    for (let i = 0; i < n; i++) await foodCmd('summon', 'cow', String(at.x + (i % 2) + 0.5), String(FEET_Y), String(at.z + Math.floor(i / 2) + 0.5), '0', '0', 'minecraft:ageable_grow_up');
  };
  const cowsNear = async (at: { x: number; z: number }, r: number) =>
    (await bot!.truth.ok<{ mobs: { baby: boolean; typeId: string; location: { x: number; y: number; z: number } }[] }>('herd', [at.x, FEET_Y, at.z, r])).mobs.filter((m) => m.typeId === 'minecraft:cow');
  /** Flat strip from home to past the far herd. */
  const flatStrip = async () => {
    for (let x = HOME.x - 20; x <= FAR.x + 20; x += 40) {
      const c = { x: x + 20, y: FEET_Y, z: HOME.z };
      if (x > HOME.x + 60) await teleport(bot!, centre(c)); // the far part is outside the ticking range of home
      await clearArea(bot!.truth, c, 20, 5);
    }
  };

  beforeAll(async () => {
    await prepareServer();
    const settings = new RuntimeSettings();
    settings.applyStartup('autoFood', false);
    settings.applyStartup('foodLeave', 0);
    bot = await startFoodBot('Herds', { home: HOME }, { settings });
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 64);
    await flatStrip();
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'iron_sword', 1]);
    await bot.truth.ok('setfood', [bot.name, 20, 20]);
    await bot.truth.setHealth(bot.name, 20);
  }, 300_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 64).catch(() => undefined);
      await bot.truth.clearAround(centre(FAR), 64).catch(() => undefined);
      await clearArea(bot.truth, HOME, 24, 6).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements (area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 120_000);

  it('herds: !food 4 walks 120 blocks back to a herd remembered from a mark', async () => {
    const b = bot!;
    const ctl = foodControllerOf(b.task)!;
    const ext = foodExtrasOf(ctl)!;
    const w = b.built.mobility!.world;
    // stand next to the far herd
    await teleport(b, centre({ x: FAR.x - 6, y: FEET_Y, z: FAR.z }));
    await b.truth.clearAround(centre(FAR), 40);
    await summonAdults(FAR, 4);
    await until(() => ([...w.entities.values()].filter((e) => e.type === 'minecraft:cow').length >= 4 ? true : undefined), 15_000, '4 cows tracked');
    const cx = Math.floor(FAR.x) >> 4;
    const cz = Math.floor(FAR.z) >> 4;
    const mark = await until(() => {
      const m = ext.herds.store.near(FAR, 24).find((h) => (h.wild.cow?.adults ?? 0) >= 1);
      const total = ext.herds.store.near(FAR, 24).reduce((a, h) => a + (h.wild.cow?.adults ?? 0), 0);
      return m && total >= 4 ? m : undefined;
    }, 10_000, 'herd mark with 4 cows');
    note(`herd mark: cell ${mark.cx},${mark.cz} (cows' cell ${cx},${cz}) at ${mark.x} ${mark.y} ${mark.z}: ${JSON.stringify(mark.wild)}; observe passes ${ext.herds.stats.passes}, mean ${(ext.herds.stats.ms / ext.herds.stats.passes).toFixed(3)} ms, max ${ext.herds.stats.maxMs.toFixed(3)} ms`);
    // walk back home (112 blocks)
    let n = b.said.length;
    const tw = Date.now();
    await b.command(`!goto ${HOME.x} ${HOME.y} ${HOME.z}`);
    // how far the entity tracker keeps the cows while the bot walks away
    let lastTracked = 0;
    const sampler = setInterval(() => {
      const p = b.task.position();
      const cows = [...w.entities.values()].filter((e) => e.type === 'minecraft:cow');
      if (p && cows.length > 0) lastTracked = Math.max(lastTracked, ...cows.map((e) => Math.hypot(e.pos.x - p.x, e.pos.z - p.z)));
    }, 100);
    const arrived = await b.reply((s) => s.startsWith('arrived at') || s.startsWith('goto:'), n, 120_000);
    clearInterval(sampler);
    expect(arrived).toMatch(/^arrived at/);
    const tracked = [...w.entities.values()].filter((e) => e.type === 'minecraft:cow').length;
    note(`walked home in ${((Date.now() - tw) / 1000).toFixed(1)} s ("${arrived}"); cows tracked up to ${lastTracked.toFixed(1)} blocks away; still tracked at home: ${tracked}; marks within 200: ${ext.herds.near(b.task.position()!, 200).length}`);
    // nothing within 48 blocks of home
    const n0 = b.said.length;
    const t0 = Date.now();
    await b.command('!food 4');
    const start = await b.reply((s) => s.startsWith('gathering'), n0);
    const done = await b.reply((s) => s.startsWith('food:'), n0, 300_000);
    const ms = Date.now() - t0;
    const counts = await b.truth.counts(b.name);
    const left = await cowsNear(FAR, 32);
    note(`!food 4: "${start}" -> "${done}" after ${(ms / 1000).toFixed(1)} s; truth beef ${counts.beef ?? 0}, leather ${counts.leather ?? 0}; cows left at the herd ${left.length}`);
    expect(done).toMatch(/^food: \d+\/4 items from \d cow \(1 walk to remembered herds\)/);
    expect(counts.beef ?? 0).toBeGreaterThanOrEqual(4);
    n = b.said.length;
    await b.command('!food herds');
    note(`!food herds: ${await b.reply((s) => s.startsWith('food:'), n)}`);
  }, 420_000);

  it('pens: !food 6 takes the 2 free cows and leaves the 2 in the pen', async () => {
    const b = bot!;
    const ctl = foodControllerOf(b.task)!;
    const ext = foodExtrasOf(ctl)!;
    const w = b.built.mobility!.world;
    // forget the far herd (the survivors of test 1): this test is about the pen
    await b.truth.clearAround(centre(FAR), 40);
    for (const m of ext.herds.store.near(FAR, 64)) ext.herds.store.clear(m.cx, m.cz);
    await teleport(b, centre(HOME));
    await b.truth.clearAround(centre(HOME), 40);
    await truthLoaded(b.truth, 'pen', [PEN.x, PEN.y, PEN.z, 7, 7]);
    await summonAdults({ x: PEN.x + 2, z: PEN.z + 2 }, 2);
    await summonAdults(FREE, 2);
    await until(() => ([...w.entities.values()].filter((e) => e.type === 'minecraft:cow' && Math.hypot(e.pos.x - HOME.x, e.pos.z - HOME.z) < 40).length >= 4 ? true : undefined), 15_000, '4 cows tracked');
    const n0 = b.said.length;
    const t0 = Date.now();
    await b.command('!food 6');
    const start = await b.reply((s) => s.startsWith('gathering'), n0);
    const done = await b.reply((s) => s.startsWith('food:'), n0, 240_000);
    const ms = Date.now() - t0;
    const inPen = await cowsNear(PEN_MID, 3.5);
    const free = await cowsNear(FREE, 12);
    const counts = await b.truth.counts(b.name);
    note(`!food 6 (pen): "${start}" -> "${done}" after ${(ms / 1000).toFixed(1)} s; truth: ${inPen.length} cows in the pen, ${free.length} free cows left, beef ${counts.beef ?? 0}; pen fills ${ext.pens.fills}`);
    expect(start).toMatch(/in pens cow 2/);
    expect(done).toMatch(/^food: \d+\/6 items from 2 cow, nothing left to hunt/);
    expect(done, 'no walk to the stale mark of the cows just killed').not.toMatch(/walk/);
    expect(inPen.length).toBe(2);
    expect(free.length).toBe(0);
  }, 300_000);
});
