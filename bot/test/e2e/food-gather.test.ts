// PLAN.md task 7.16 on bds-food (difficulty easy; Track X, docs/food.md): food gathering on the real afk task.
//   1. `!food 6` with 4 cows (and a baby cow) in a fenced pen 20 blocks from home, a closed gate:
//      raw beef in the inventory (truth), 2 cows (foodLeave) and the baby left alive;
//   2. `!cook` with a furnace 3 blocks from home and coal: 4 raw beef -> 4 cooked beef (truth inventory);
//   3. the auto trigger (autoFood on): it starts within 30 s after the inventory food is cleared while
//      the bot idles at home, and does not start while a `!goto` runs (it starts after the arrival).
// Needs BDS_E2E=1 and bds-food with the truth pack (`node scripts/bds.mjs --profile food up` and `... pack`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../src/config/settings.ts';
import { foodControllerOf } from '../../src/chat/commands-food.ts';
import { inventoryFoodPoints } from '../../src/skills/food/finder.ts';
import { centre, clearArea, E2E, FEET_Y, foodCmd, prepareServer, privateArea, sleep, startFoodBot, teleport, truthLoaded, until, type FoodBot } from './food-truth.ts';

describe.skipIf(!E2E)('food: gather, cook, auto trigger (task 7.16)', () => {
  let bot: FoodBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  /** The pen: 7 x 7 from (HOME.x + 18, HOME.z - 3), gate in the middle of its north side. */
  const PEN = { x: HOME.x + 18, y: FEET_Y, z: HOME.z - 3 };
  const PEN_MID = { x: PEN.x + 3.5, y: FEET_Y, z: PEN.z + 3.5 };
  const FURNACE = { x: HOME.x - 3, y: FEET_Y, z: HOME.z };
  /** The goto target of test 3: 40 blocks west of home (the pen is 58+ blocks from there, beyond the 48-block hunt radius). */
  const AWAY = { x: HOME.x - 40, y: FEET_Y, z: HOME.z };
  const measurements: string[] = [];
  const note = (s: string) => {
    console.log(s);
    measurements.push(s);
  };

  const cowsIn = async (at: { x: number; y: number; z: number }, r: number) => (await bot!.truth.near(at, r)).filter((m) => m.typeId === 'minecraft:cow');
  // console summons with the grow-up event: always adults (a Script API spawn is a baby 1 time in 20);
  // no run tag, so clearAround removes them at the end
  const summonCows = async (at: { x: number; z: number }, n: number) => {
    for (let i = 0; i < n; i++) await foodCmd('summon', 'cow', String(at.x + (i % 2) - 0.5), String(FEET_Y), String(at.z + Math.floor(i / 2) - 0.5), '0', '0', 'minecraft:ageable_grow_up');
  };
  /** Adult cows the bot itself sees within 48 blocks of `at` (its baby flags). */
  const seenAdults = (at: { x: number; y: number; z: number }): number => {
    const w = bot!.built.mobility!.world;
    const ctl = foodControllerOf(bot!.task)!;
    return [...w.entities.values()].filter((e) => e.type === 'minecraft:cow' && !ctl.d.hunter.isBaby(e.runtimeId) && Math.hypot(e.pos.x - at.x, e.pos.z - at.z) <= 48).length;
  };
  const giveKit = async () => {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_sword', 1]);
    const inv = b.built.mobility!.world.inventory;
    await until(() => (inv.slots.some((s) => s?.name === 'iron_sword') ? true : undefined), 5_000, 'sword in the model');
  };

  beforeAll(async () => {
    await prepareServer();
    const settings = new RuntimeSettings();
    settings.applyStartup('autoFood', false);
    bot = await startFoodBot('Food', { home: HOME }, { settings });
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 80);
    await clearArea(bot.truth, { x: HOME.x - 10, y: FEET_Y, z: HOME.z }, 35, 6);
    await giveKit();
    await bot.truth.ok('setfood', [bot.name, 20, 20]);
    await bot.truth.setHealth(bot.name, 20);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 80).catch(() => undefined);
      await clearArea(bot.truth, { x: HOME.x - 10, y: FEET_Y, z: HOME.z }, 35, 6).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements (area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 120_000);

  it('!food 6: hunts the cows in a fenced pen, keeps 2 and the baby, raw beef in the inventory', async () => {
    const b = bot!;
    const w = b.built.mobility!.world;
    const pen = await truthLoaded<{ gate: { x: number; y: number; z: number } }>(b.truth, 'pen', [PEN.x, PEN.y, PEN.z, 7, 7]);
    await summonCows({ x: PEN.x + 3, z: PEN.z + 3 }, 4);
    // a baby cow (no run tag: removed by clearAround at the end)
    await foodCmd('summon', 'cow', String(PEN.x + 5), String(FEET_Y), String(PEN.z + 5), '0', '0', 'minecraft:entity_born');
    await until(() => ([...w.entities.values()].filter((e) => e.type === 'minecraft:cow').length >= 5 ? true : undefined), 15_000, '5 cows tracked');
    const ctl = foodControllerOf(b.task)!;
    expect(seenAdults(PEN_MID)).toBe(4);
    expect(ctl).toBeDefined();
    const babies = [...w.entities.values()].filter((e) => e.type === 'minecraft:cow' && ctl.d.hunter.isBaby(e.runtimeId));
    expect(babies.length, 'the baby cow carries the baby actor flag').toBe(1);
    const n0 = b.said.length;
    const t0 = Date.now();
    await b.command('!food 6');
    const start = await b.reply((s) => s.startsWith('gathering'), n0);
    const done = await b.reply((s) => s.startsWith('food:'), n0, 240_000);
    const ms = Date.now() - t0;
    const counts = await b.truth.counts(b.name);
    const cows = await cowsIn(PEN_MID, 48);
    const adults = (await b.truth.ok<{ mobs: { baby: boolean; typeId: string }[] }>('herd', [PEN_MID.x, PEN_MID.y, PEN_MID.z, 48])).mobs.filter((m) => m.typeId === 'minecraft:cow');
    note(
      `!food 6: "${start}" -> "${done}" after ${(ms / 1000).toFixed(1)} s; truth inventory beef ${counts.beef ?? 0}, leather ${counts.leather ?? 0}; cows left ${cows.length} ` +
        `(${adults.filter((m) => !m.baby).length} adults, ${adults.filter((m) => m.baby).length} baby); gate ${pen.gate.x} ${pen.gate.y} ${pen.gate.z}; corrections ${b.built.mobility!.loop.state.corrections}`,
    );
    expect(done).toMatch(/^food: \d+\/6 items from 2 cow/);
    expect(adults.filter((m) => !m.baby).length).toBe(2);
    expect(adults.filter((m) => m.baby).length).toBe(1);
    // Bedrock's cow loot is 1-3 beef per kill (no looting): 2 kills give 2..6
    expect(counts.beef ?? 0).toBeGreaterThanOrEqual(2);
    if ((counts.beef ?? 0) < 4) note(`note: only ${counts.beef ?? 0} beef from 2 cows (loot 1-3 each)`);
    // back home afterwards (home return)
    await until(() => {
      const p = b.task.position();
      return p && Math.hypot(p.x - (HOME.x + 0.5), p.z - (HOME.z + 0.5)) < 1.5 ? true : undefined;
    }, 30_000, 'back home');
  }, 300_000);

  it('!cook: a furnace with coal near home turns 4 raw beef into 4 cooked beef', async () => {
    const b = bot!;
    await truthLoaded(b.truth, 'setblock', [FURNACE.x, FURNACE.y, FURNACE.z, 'furnace']);
    await giveKit();
    await b.truth.ok('give', [b.name, 'beef', 4]);
    await b.truth.ok('give', [b.name, 'coal', 2]);
    const w = b.built.mobility!.world;
    await until(() => (w.inventory.count('coal') === 2 && w.inventory.count('beef') === 4 && w.blockAt(FURNACE)?.name === 'furnace' ? true : undefined), 5_000, 'beef, coal and the furnace in the model');
    const n0 = b.said.length;
    const t0 = Date.now();
    await b.command('!cook');
    const start = await b.reply((s) => s.startsWith('cooking'), n0);
    const done = await b.reply((s) => s.startsWith('cooked') || s.startsWith('cook:'), n0, 120_000);
    const ms = Date.now() - t0;
    const counts = await b.truth.counts(b.name);
    const furnace = await b.truth.furnace(FURNACE);
    note(`!cook: "${start}" -> "${done}" after ${(ms / 1000).toFixed(1)} s; truth inventory cooked_beef ${counts.cooked_beef ?? 0}, beef ${counts.beef ?? 0}, coal ${counts.coal ?? 0}; furnace ${JSON.stringify(furnace.slots)}`);
    expect(done).toMatch(/^cooked 4 cooked_beef in the furnace at /);
    expect(counts.cooked_beef).toBe(4);
    expect(counts.beef ?? 0).toBe(0);
    expect(furnace.slots[0]).toBeNull();
    expect(furnace.slots[2]).toBeNull();
    // the model agrees with the server
    expect(w.inventory.count('cooked_beef')).toBe(4);
  }, 180_000);

  it('auto trigger: starts within 30 s of the food being cleared while idle; not while a !goto runs', async () => {
    const b = bot!;
    const ctl = foodControllerOf(b.task)!;
    const w = b.built.mobility!.world;
    await truthLoaded(b.truth, 'setblock', [FURNACE.x, FURNACE.y, FURNACE.z, 'air']);
    await teleport(b, centre(HOME));
    // enough food carried: nothing happens when the chore is switched on
    await giveKit();
    await b.truth.ok('give', [b.name, 'cooked_beef', 10]);
    await until(() => (inventoryFoodPoints(w.inventory.slots) >= 80 ? true : undefined), 5_000, 'food in the model');
    // 2 more cows into the pen (4 adults: 2 may be hunted)
    await summonCows({ x: PEN.x + 3, z: PEN.z + 3 }, 2);
    await until(() => (seenAdults(PEN_MID) >= 4 ? true : undefined), 15_000, '4 adult cows at the pen');
    let n = b.said.length;
    await b.command('!set autoFood on');
    await b.reply((s) => s.startsWith('autoFood'), n);
    await sleep(3000);
    expect(ctl.chore.running, 'no chore with 80 food points').toBe(false);

    // (a) idle at home: clear the food -> the chore starts within 30 s
    const tClear = Date.now();
    await giveKit();
    const started = await until(() => (ctl.chore.running ? Date.now() : undefined), 30_000, 'food chore started', 100);
    const stack = b.processes.stack().map((e) => `${e.name}:${e.kind}:${e.state}`);
    note(`auto (idle): chore started ${started - tClear} ms after the food was cleared (truth clear); stack ${stack.join(' ')}`);
    expect(b.processes.active?.name).toBe('food');
    expect(b.processes.active?.kind).toBe('auto');
    await until(() => (!ctl.chore.running ? true : undefined), 240_000, 'chore done', 250);
    const last = ctl.chore.last!;
    const counts = await b.truth.counts(b.name);
    note(`auto (idle): ${last.gained} items from ${last.killed} kills (${last.reason}); truth beef ${counts.beef ?? 0}; cows in the pen ${(await cowsIn(PEN_MID, 6)).length}`);
    expect(last.killed).toBe(2);

    // (b) a !goto runs while the food is cleared: no chore during the walk; it starts after the arrival
    await teleport(b, centre(HOME));
    await giveKit();
    await b.truth.ok('give', [b.name, 'cooked_beef', 10]);
    await until(() => (inventoryFoodPoints(w.inventory.slots) >= 80 ? true : undefined), 5_000, 'food in the model');
    await summonCows({ x: AWAY.x + 6, z: AWAY.z }, 4);
    await until(() => (seenAdults(AWAY) >= 4 ? true : undefined), 15_000, '4 adult cows near the goto target');
    ctl.chore.nextTry = -Infinity; // forget the 30 s retry pause of the run above
    n = b.said.length;
    await b.command(`!goto ${AWAY.x} ${AWAY.y} ${AWAY.z}`);
    await b.reply((s) => s.startsWith('walking to'), n);
    const tClear2 = Date.now();
    await giveKit();
    let sawChore = false;
    let samples = 0;
    let arrived: number | undefined;
    const arrival = b.reply((s) => s.startsWith('arrived at') || s.startsWith('goto:'), n, 60_000).then((s) => {
      arrived = Date.now();
      return s;
    });
    while (arrived === undefined) {
      if (ctl.chore.running || b.processes.stack().some((e) => e.name === 'food')) sawChore = true;
      samples++;
      await sleep(50);
    }
    const arrivedLine = await arrival;
    expect(arrivedLine).toMatch(/^arrived at/);
    expect(sawChore, 'the chore must not start while the goto runs').toBe(false);
    const started2 = await until(() => (ctl.chore.running ? Date.now() : undefined), 30_000, 'food chore after the arrival', 100);
    note(`auto (goto): food cleared ${(arrived - tClear2) / 1000} s before the arrival, ${samples} samples during the walk without a chore; chore started ${started2 - arrived} ms after the arrival`);
    await until(() => (!ctl.chore.running ? true : undefined), 240_000, 'chore done', 250);
    note(`auto (goto): ${ctl.chore.last!.gained} items from ${ctl.chore.last!.killed} kills (${ctl.chore.last!.reason}); cows near the goto target ${(await cowsIn({ x: AWAY.x, y: FEET_Y, z: AWAY.z }, 48)).length}`);
    expect(ctl.chore.last!.killed).toBe(2);
    n = b.said.length;
    await b.command('!set autoFood off');
    await b.reply((s) => s.startsWith('autoFood'), n);
  }, 600_000);
});
