// Track AF (wave 8, food v2) on bds-food (difficulty easy; docs/food.md "Breeding"): breeding on the real afk task.
//   1. the breeding chore does not run while `autoBreed` is off (chorePen set, wheat carried, 2 cows in the pen);
//   2. `!breed cow 1` with 2 adult cows in a fenced pen and wheat in the inventory: a calf within 10 s
//      (truth `herd` shows baby: true), 2 wheat used, the bot's tracker saw both parents in love;
//   3. `autoBreed on`: the chore walks into the chorePen and breeds 2 more cows there (a second calf).
// Needs BDS_E2E=1 and bds-food with the truth pack (`node scripts/bds.mjs --profile food up` and `... pack`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../src/config/settings.ts';
import { foodControllerOf, foodExtrasOf } from '../../src/chat/commands-food.ts';
import { centre, clearArea, E2E, FEET_Y, foodCmd, prepareServer, privateArea, sleep, startFoodBot, teleport, truthLoaded, until, type FoodBot } from './food-truth.ts';

describe.skipIf(!E2E)('food v2: breeding (Track AF)', () => {
  let bot: FoodBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  /** The pen: 7 x 7 from (HOME.x + 8, HOME.z - 3), gate in the middle of its north side. */
  const PEN = { x: HOME.x + 8, y: FEET_Y, z: HOME.z - 3 };
  const PEN_MID = { x: PEN.x + 3, y: FEET_Y, z: PEN.z + 3 };
  const measurements: string[] = [];
  const note = (s: string) => {
    console.log(s);
    measurements.push(s);
  };
  const summonAdults = async (at: { x: number; z: number }, n: number) => {
    for (let i = 0; i < n; i++) await foodCmd('summon', 'cow', String(at.x + (i % 2) + 0.5), String(FEET_Y), String(at.z + Math.floor(i / 2) + 0.5), '0', '0', 'minecraft:ageable_grow_up');
  };
  const cows = async () => (await bot!.truth.ok<{ mobs: { baby: boolean; typeId: string; location: { x: number; z: number } }[] }>('herd', [PEN_MID.x + 0.5, FEET_Y, PEN_MID.z + 0.5, 12])).mobs.filter((m) => m.typeId === 'minecraft:cow');

  beforeAll(async () => {
    await prepareServer();
    const settings = new RuntimeSettings();
    settings.applyStartup('autoFood', false);
    bot = await startFoodBot('Breed', { home: HOME }, { settings });
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 64);
    await clearArea(bot.truth, HOME, 24, 6);
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'wheat', 16]);
    await bot.truth.ok('setfood', [bot.name, 20, 20]);
    await bot.truth.setHealth(bot.name, 20);
    const inv = bot.built.mobility!.world.inventory;
    await until(() => (inv.count('wheat') === 16 ? true : undefined), 5_000, 'wheat in the model');
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 64).catch(() => undefined);
      await clearArea(bot.truth, HOME, 24, 6).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements (area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 120_000);

  it('the breeding chore does not run while autoBreed is off', async () => {
    const b = bot!;
    const ctl = foodControllerOf(b.task)!;
    await truthLoaded(b.truth, 'pen', [PEN.x, PEN.y, PEN.z, 7, 7]);
    await summonAdults({ x: PEN.x + 2, z: PEN.z + 2 }, 2);
    const w = b.built.mobility!.world;
    await until(() => ([...w.entities.values()].filter((e) => e.type === 'minecraft:cow').length >= 2 ? true : undefined), 15_000, '2 cows tracked');
    let n = b.said.length;
    await b.command(`!set chorePen ${PEN_MID.x} ${PEN_MID.y} ${PEN_MID.z}`);
    const set = await b.reply((s) => s.startsWith('chorePen'), n);
    expect(set).toMatch(new RegExp(`^chorePen = ${PEN_MID.x} ${PEN_MID.y} ${PEN_MID.z}`));
    expect(b.settings.get('autoBreed')).toBe(false);
    // the pen is detected around the chorePen block
    const ext = foodExtrasOf(ctl)!;
    const pen = ext.pens.penAt({ x: PEN_MID.x + 0.5, y: FEET_Y, z: PEN_MID.z + 0.5 });
    expect(pen, 'the truth pen is a pen').toBeDefined();
    note(`pen detected: ${JSON.stringify(pen)}`);
    let sawBreed = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if (ctl.breedChore?.running || b.processes.stack().some((e) => e.name === 'breed')) sawBreed = true;
      await sleep(100);
    }
    expect(sawBreed, 'no breeding chore with autoBreed off').toBe(false);
    expect(ctl.breedChore!.stats.started).toBe(0);
    expect(ctl.breedChore!.stats.checks).toBe(0);
    expect(w.inventory.count('wheat')).toBe(16);
    expect((await cows()).filter((c) => c.baby).length).toBe(0);
    n = b.said.length;
    await b.command('!food status');
    note(`!food status: ${await b.reply((s) => s.startsWith('food:'), n)}`);
  }, 60_000);

  it('!breed cow 1: two adult cows in a pen and wheat -> a calf within 10 s', async () => {
    const b = bot!;
    const w = b.built.mobility!.world;
    const ctl = foodControllerOf(b.task)!;
    const ext = foodExtrasOf(ctl)!;
    const loveSeen = new Set<bigint>();
    const off = b.built.mobility!.loop.onBeforeStep(() => {
      for (const rid of ext.babies.inLove) loveSeen.add(rid);
    });
    const n0 = b.said.length;
    const t0 = Date.now();
    await b.command('!breed cow 1');
    const start = await b.reply((s) => s.startsWith('breeding') || s.startsWith('breed:'), n0);
    expect(start).toBe('breeding 1 cow pair');
    // the second feed: the wheat count drops to 14
    const tFed = await until(() => (w.inventory.count('wheat') <= 14 ? Date.now() : undefined), 60_000, 'both cows fed', 50);
    const tCalf = await until(async () => ((await cows()).some((c) => c.baby) ? Date.now() : undefined), 10_000, 'a calf (truth herd baby: true) within 10 s of the second feed', 250);
    const done = await b.reply((s) => s.startsWith('breed:'), n0, 30_000);
    off();
    const herd = await cows();
    const inv = await b.truth.counts(b.name);
    note(
      `!breed cow 1: "${start}" -> "${done}"; both fed ${((tFed - t0) / 1000).toFixed(1)} s after the command, calf ${((tCalf - tFed) / 1000).toFixed(1)} s after the second feed ` +
        `(${((tCalf - t0) / 1000).toFixed(1)} s total); truth herd ${herd.filter((c) => !c.baby).length} adults + ${herd.filter((c) => c.baby).length} calf; wheat ${inv.wheat ?? 0}; inlove flags seen on ${loveSeen.size} mobs; ` +
        `breeder ${JSON.stringify(ext.breeder.totals)}`,
    );
    expect(done).toMatch(/^breed: fed 1\/1 cow pair, 1 baby/);
    expect(herd.filter((c) => c.baby).length).toBe(1);
    expect(herd.filter((c) => !c.baby).length).toBe(2);
    expect(inv.wheat).toBe(14);
    expect(loveSeen.size, 'the inlove actor flag of both parents').toBeGreaterThanOrEqual(2);
    // the bot walked out of the pen and closed the gate behind it
    const gate = await b.truth.ok<{ typeId: string; states: Record<string, unknown> }>('block', [PEN.x + 3, FEET_Y, PEN.z]);
    note(`gate after !breed: ${gate.typeId} open_bit ${String(gate.states.open_bit)}`);
    expect(gate.states.open_bit).toBe(false);
    // the bot's own tracker marks the calf as a baby too
    expect([...w.entities.values()].filter((e) => e.type === 'minecraft:cow' && ext.babies.isBaby(e.runtimeId)).length).toBe(1);
  }, 120_000);

  it('autoBreed on: the chore breeds the chorePen when it holds fewer than 8 adults', async () => {
    const b = bot!;
    const ctl = foodControllerOf(b.task)!;
    await summonAdults({ x: PEN.x + 4, z: PEN.z + 4 }, 2);
    const w = b.built.mobility!.world;
    await until(() => ([...w.entities.values()].filter((e) => e.type === 'minecraft:cow').length >= 5 ? true : undefined), 15_000, '5 cows tracked');
    await teleport(b, centre(HOME));
    await sleep(1500);
    const n = b.said.length;
    const t0 = Date.now();
    await b.command('!set autoBreed on');
    await b.reply((s) => s.startsWith('autoBreed'), n);
    const started = await until(() => (ctl.breedChore!.running ? Date.now() : undefined), 15_000, 'breeding chore started', 100);
    expect(b.processes.active?.name).toBe('breed');
    expect(b.processes.active?.kind).toBe('auto');
    await until(() => (!ctl.breedChore!.running ? true : undefined), 90_000, 'breeding chore done', 250);
    const last = ctl.breedChore!.last;
    const herd = await cows();
    note(`auto breed: started ${started - t0} ms after !set autoBreed on; result ${JSON.stringify(last)} ${ctl.breedChore!.lastWhy}; truth herd ${herd.filter((c) => !c.baby).length} adults + ${herd.filter((c) => c.baby).length} calves; wheat ${w.inventory.count('wheat')}`);
    expect(last?.pairs).toBe(1);
    expect(herd.filter((c) => c.baby).length).toBe(2);
    const gate = await b.truth.ok<{ states: Record<string, unknown> }>('block', [PEN.x + 3, FEET_Y, PEN.z]);
    expect(gate.states.open_bit, 'the gate is closed behind the bot').toBe(false);
    // next look in 10 minutes
    expect(ctl.breedChore!.nextTry).toBeGreaterThan(performance.now() + 9 * 60_000);
    const n2 = b.said.length;
    await b.command('!set autoBreed off');
    await b.reply((s) => s.startsWith('autoBreed'), n2);
  }, 180_000);
});
