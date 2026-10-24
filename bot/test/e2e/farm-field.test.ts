// e2e (tag @bds) for PLAN.md task 7.13 (farming) on bds-farm (BDS_E2E=1; docker/compose.farm.yml,
// truth pack deployed with `node scripts/bds.mjs --profile farm pack`):
//   cycle 1  a 9 x 9 field of mature wheat (truth:field) is harvested and replanted: 81 harvests,
//            81 plantings, every cell wheat at growth 0 again, all 81 farmland intact (no trampling),
//            wheat in the inventory = 81 = wheat drops, seeds = start + seed drops - 81
//   cycle 2  the field is set mature again and the inventory filled with cobblestone up to 2 free
//            slots: the farmer deposits wheat and surplus seeds into the chest when full, and again
//            harvests and replants all 81; wheat in inventory + chest = 162
//   bone     a 3 x 3 field at growth 0 with 16 bone meal: the bone meal is used up, the crops it grew
//            are harvested and replanted; with useBoneMeal() false no bone meal is used
// Random ticks are off during the suite (gamerule randomtickspeed 0) so stages are exact.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFarmer } from '../../src/skills/farm/index.ts';
import type { FarmTask } from '../../src/skills/farm/farmer.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E_VERSION } from './env.ts';
import {
  E2E,
  FEET_Y,
  FarmArea,
  SOIL_Y,
  clearArea,
  connectFarmBot,
  consoleCommand,
  FARM_CONTAINER,
  killItemsNear,
  pollUntil,
  prepareServer,
  stats,
  truthLoaded,
  type FarmBot,
  type TruthContainer,
  type TruthCrops,
  type TruthInv,
} from './farm-truth.ts';

const sum = (r: Record<string, number>, k: string) => r[k] ?? 0;

describe.skipIf(!E2E)('@bds farm: 9 x 9 wheat field, chest, bone meal (7.13)', () => {
  let bot: FarmBot;
  const area = new FarmArea();
  const cx = area.x0;
  const cz = area.z0;
  const field = { x: cx - 4, z: cz - 4, w: 9, d: 9 };
  const chest: Vec3 = { x: cx - 8, y: FEET_Y, z: cz };
  const bone = { x: cx + 9, z: cz - 1, w: 3, d: 3 };
  const notes: string[] = [];
  /** Item drops seen in the area (bot side, add_item_entity), by name. */
  const drops: Record<string, number> = {};
  let farm: FarmTask;
  let boneMeal = true;

  const crops = (f: { x: number; z: number; w: number; d: number }) => truthLoaded<TruthCrops>(bot.truth, 'crops', [f.x, SOIL_Y, f.z, f.w, f.d]);
  const inv = () => bot.truth.ok<TruthInv>('inv', [bot.name]);
  const chestCounts = async () => (await truthLoaded<TruthContainer>(bot.truth, 'container', [chest.x, chest.y, chest.z])).counts;
  /** Items of that name lying in the area (world model). */
  const lying = (name: string) => {
    let n = 0;
    for (const e of bot.world.entities.values()) if (e.type === 'minecraft:item' && e.item?.name === name && Math.abs(e.pos.x - cx) <= 16 && Math.abs(e.pos.z - cz) <= 16) n += e.item.count;
    return n;
  };
  const tally = (f: TruthCrops) => {
    const g: Record<string, number> = {};
    for (const x of f.growth) g[x] = (g[x] ?? 0) + 1;
    return JSON.stringify(g);
  };

  beforeAll(async () => {
    await prepareServer();
    await consoleCommand(FARM_CONTAINER, 'gamerule', 'randomtickspeed', '0');
    bot = await connectFarmBot('Farm');
    await bot.teleport({ x: cx - 6.5, y: FEET_Y, z: cz + 0.5 }, -90);
    await clearArea(bot.truth, cx, cz, 16, 6);
    await killItemsNear(cx, cz, 18);
    await truthLoaded(bot.truth, 'set', [chest.x, chest.y, chest.z, 'chest']);
    await truthLoaded(bot.truth, 'container', [chest.x, chest.y, chest.z, 'clear']);
    bot.world.entityTracker.onAdd((e) => {
      if (e.type !== 'minecraft:item' || !e.item) return;
      if (Math.abs(e.pos.x - cx) > 16 || Math.abs(e.pos.z - cz) > 16) return;
      drops[e.item.name] = (drops[e.item.name] ?? 0) + e.item.count;
    });
    ({ farm } = createFarmer({ skills: bot.skills, world: bot.world, loop: bot.loop, source: bot.conn, hotbar: bot.hotbar, containers: bot.containers, log: bot.logger }, { useBoneMeal: () => boneMeal }));
  }, 180_000);

  afterAll(async () => {
    farm?.stop();
    process.stdout.write(`[farm-field e2e] BDS ${E2E_VERSION}, area cell ${area.cell} (${cx}, ${cz})\n  ${notes.join('\n  ')}\n`);
    if (bot) {
      await clearArea(bot.truth, cx, cz, 16, 6).catch(() => undefined);
      await killItemsNear(cx, cz, 18).catch(() => undefined);
      await consoleCommand(FARM_CONTAINER, 'gamerule', 'randomtickspeed', '1').catch(() => undefined);
      await bot.close();
    }
  });

  /** Run the farmer until `done()` or the timeout; returns seconds. */
  async function farmUntil(center: Vec3, radius: number, done: () => boolean, timeoutMs: number): Promise<number> {
    const t0 = performance.now();
    void farm.start({ center, radius, chest, waitTicks: 100 });
    const ok = await pollUntil(done, timeoutMs);
    const s = (performance.now() - t0) / 1000;
    farm.stop();
    await bot.loop.waitTicks(5);
    expect(ok, `farm state ${farm.state}, ${farm.summary()}, last error ${farm.lastError}`).toBeGreaterThanOrEqual(0);
    return s;
  }

  it('cycle 1: harvests the mature 9 x 9 field and replants every cell', async () => {
    await truthLoaded(bot.truth, 'field', [field.x, SOIL_Y, field.z, field.w, field.d, 'wheat', 7]);
    await bot.loadout([['wheat_seeds', 16]]);
    expect(await pollUntil(() => bot.world.blockAt({ x: field.x + 8, y: FEET_Y, z: field.z + 8 })?.name === 'wheat', 5_000)).toBeGreaterThanOrEqual(0);
    const c0 = bot.loop.state.corrections;
    const s = await farmUntil({ x: cx + 0.5, y: FEET_Y, z: cz + 0.5 }, 4, () => farm.stats.harvested >= 81 && farm.stats.planted >= 81 && farm.state === 'waiting', 480_000);
    const f = await crops(field);
    const i = await inv();
    const st = farm.stats;
    notes.push(
      `cycle 1: ${s.toFixed(1)} s, ${st.harvested} harvested, ${st.planted} planted, ${st.stands} stands, ${st.collectRounds} collects, ${st.trampleRoutesRefused} routes refused (trampling), ` +
        `${bot.loop.state.corrections - c0} corrections; harvest ticks ${stats(st.harvestTicks)}; plant ticks ${stats(st.plantTicks)}`,
    );
    notes.push(`cycle 1 truth: soil ${JSON.stringify(f.soilCounts)}, crops ${JSON.stringify(f.cropCounts)}, growth ${tally(f)}; drops ${JSON.stringify(drops)}; inventory ${JSON.stringify(i.counts)}; seeds left lying ${lying('wheat_seeds')}; plant retries ${st.plantRetries}`);
    expect(st.harvested).toBe(81);
    expect(st.planted).toBe(81);
    expect(f.soilCounts.farmland).toBe(81); // nothing trampled
    expect(f.cropCounts.wheat).toBe(81);
    expect(f.growth.every((g) => g === 0)).toBe(true);
    // drops: one wheat per crop; every drop picked up
    expect(sum(drops, 'wheat')).toBe(81);
    expect(sum(i.counts, 'minecraft:wheat')).toBe(81);
    // seeds: what dropped is in the inventory, or still lying in the field (the farmer gives up on a drop after 2 approaches)
    expect(sum(i.counts, 'minecraft:wheat_seeds') + lying('wheat_seeds')).toBe(16 + sum(drops, 'wheat_seeds') - 81);
    expect(bot.world.inventory.count('wheat')).toBe(81);
  }, 600_000);

  it('cycle 2: deposits into the chest when the inventory is full and harvests + replants again', async () => {
    // mature again, inventory filled with cobblestone up to 2 free slots (the harvest fills them: deposit below 2)
    for (const k of Object.keys(drops)) delete drops[k];
    await truthLoaded(bot.truth, 'field', [field.x, SOIL_Y, field.z, field.w, field.d, 'wheat', 7]);
    const free = bot.world.inventory.freeSlots().length;
    for (let k = 0; k < free - 2; k++) await bot.truth.ok('give', [bot.name, 'cobblestone', 64]);
    expect(await pollUntil(() => bot.world.inventory.freeSlots().length === 2, 5_000)).toBeGreaterThanOrEqual(0);
    const seeds0 = bot.world.inventory.count('wheat_seeds');
    const lying0 = lying('wheat_seeds');
    const c0 = bot.loop.state.corrections;
    const s = await farmUntil({ x: cx + 0.5, y: FEET_Y, z: cz + 0.5 }, 4, () => farm.stats.harvested >= 81 && farm.stats.planted >= 81 && farm.state === 'waiting', 480_000);
    const f = await crops(field);
    const i = await inv();
    const ch = await chestCounts();
    const st = farm.stats;
    notes.push(
      `cycle 2: ${s.toFixed(1)} s, ${st.harvested} harvested, ${st.planted} planted, ${st.trips} deposit trip(s) ${JSON.stringify(st.deposited)}, ${st.trampleRoutesRefused} routes refused, ` +
        `${bot.loop.state.corrections - c0} corrections; harvest ticks ${stats(st.harvestTicks)}; plant ticks ${stats(st.plantTicks)}`,
    );
    notes.push(`cycle 2 truth: soil ${JSON.stringify(f.soilCounts)}, growth ${tally(f)}; drops ${JSON.stringify(drops)}; inventory ${JSON.stringify(i.counts)}; chest ${JSON.stringify(ch)}`);
    expect(st.harvested).toBe(81);
    expect(st.planted).toBe(81);
    expect(f.soilCounts.farmland).toBe(81);
    expect(f.cropCounts.wheat).toBe(81);
    expect(f.growth.every((g) => g === 0)).toBe(true);
    expect(st.trips).toBeGreaterThanOrEqual(1);
    expect(sum(ch, 'minecraft:wheat')).toBeGreaterThan(0);
    expect(sum(drops, 'wheat')).toBe(81);
    // all wheat of both cycles is in the inventory or the chest; seeds add up too
    expect(sum(i.counts, 'minecraft:wheat') + sum(ch, 'minecraft:wheat')).toBe(162);
    expect(sum(i.counts, 'minecraft:wheat_seeds') + sum(ch, 'minecraft:wheat_seeds') + lying('wheat_seeds') - lying0).toBe(seeds0 + sum(drops, 'wheat_seeds') - 81);
    expect(sum(i.counts, 'minecraft:cobblestone')).toBeGreaterThan(0); // never deposited
    expect(sum(ch, 'minecraft:cobblestone')).toBe(0);
  }, 600_000);

  it('bone meal grows crops that are then harvested and replanted; off when useBoneMeal() is false', async () => {
    await truthLoaded(bot.truth, 'field', [field.x, SOIL_Y, field.z, field.w, field.d, 'none', 0]);
    await truthLoaded(bot.truth, 'field', [bone.x, SOIL_Y, bone.z, bone.w, bone.d, 'wheat', 0]);
    for (const k of Object.keys(drops)) delete drops[k];
    await bot.loadout([['wheat_seeds', 8], ['bone_meal', 16]]);
    await bot.teleport({ x: bone.x - 1.5, y: FEET_Y, z: bone.z + 1.5 }, -90);
    const center = { x: bone.x + 1.5, y: FEET_Y, z: bone.z + 1.5 };
    // off: nothing to do (all growing, no mature), no bone meal used
    boneMeal = false;
    const s0 = await farmUntil(center, 1, () => farm.state === 'waiting' && farm.stats.rounds >= 1, 30_000);
    expect(farm.stats.boneMealUsed).toBe(0);
    expect(bot.world.inventory.count('bone_meal')).toBe(16);
    notes.push(`bone meal off: waiting after ${s0.toFixed(1)} s, 0 used`);
    // on: uses all 16
    boneMeal = true;
    const s = await farmUntil(center, 1, () => bot.world.inventory.count('bone_meal') === 0 && farm.state === 'waiting', 240_000);
    const f = await crops(bone);
    const i = await inv();
    const st = farm.stats;
    notes.push(
      `bone meal: ${s.toFixed(1)} s, ${st.boneMealUsed} used, ${st.boneMealGrown} crops grown to maturity, ${st.harvested} harvested, ${st.planted} planted; ` +
        `truth growth ${tally(f)}, crops ${JSON.stringify(f.cropCounts)}; drops ${JSON.stringify(drops)}; inventory ${JSON.stringify(i.counts)}`,
    );
    expect(st.boneMealUsed).toBe(16);
    expect(sum(i.counts, 'minecraft:bone_meal')).toBe(0);
    expect(st.boneMealGrown).toBeGreaterThanOrEqual(3);
    expect(st.harvested).toBe(st.boneMealGrown);
    expect(st.planted).toBe(st.harvested);
    expect(f.cropCounts.wheat).toBe(9);
    expect(f.soilCounts.farmland).toBe(9);
    expect(sum(drops, 'wheat')).toBe(st.harvested);
    expect(sum(i.counts, 'minecraft:wheat')).toBeGreaterThanOrEqual(st.harvested);
  }, 400_000);
});
