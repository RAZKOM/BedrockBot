// e2e (tag @bds), Track BI: the water bucket clutch on bds-gaunt (fall-truth.ts), each case twice:
//   planned    a 30-block stone tower, the goal on the ground east of it, a water bucket in the hotbar (a
//              30-block fall is 26 HP): the walk plans the clutch drop (40 ticks against 26 x 40 for the HP),
//              the FallGuard places the water on the landing block, the bot lands in it (0 fall damage),
//              picks the water up again (the water bucket is back, no water left around the tower) and walks
//              on to the goal
//   reactive   the bot walks off the edge of a 20-block tower with no goto at all: clutch, 0 damage,
//              bucket back, no water left; the same from 50 blocks (about 3 blocks per tick at the end)
// The bot wears Health Boost (40 HP, 80 for the 50-block case) so a missed clutch cannot kill it mid-suite.
//   slab       the same onto a strip of bottom slabs: the water waterlogs the slab the feet end in (0
//              damage), picked up from the slab (its second layer is empty again)
//   top slab   onto top slabs from 12 blocks: refused (the water would be inside the slab, not where the
//              feet end), no click, the model's damage (8 HP)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fallDamage } from '../../src/skills/fall/damage.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { disconnectBot } from './move-truth.ts';
import { E2E, connectFallBot, fallArea, fallHurts, fillAt, kit, report, setHealth, toughen, tpBot, waterIn, type FallBot } from './fall-truth.ts';

describe.skipIf(!E2E)('@bds water bucket clutch (bds-gaunt)', () => {
  let bot: FallBot;
  const o = fallArea();
  const summary: string[] = [];
  // four towers 5 x 5 along z: planned 30 high at z o.z, reactive 20 at o.z + 24, slab 20 at o.z + 48, top slab 12 at o.z + 72
  const tower = (i: number) => ({ x: o.x, z: o.z + 24 * i });

  beforeAll(async () => {
    bot = await connectFallBot('FallClutch', { x: o.x + 10, y: -60, z: o.z + 36 });
    await fillAt(bot, { x: o.x - 8, y: -60, z: o.z - 8 }, { x: o.x + 24, y: -8, z: o.z + 108 }, 'air');
    await fillAt(bot, { x: o.x - 8, y: -61, z: o.z - 8 }, { x: o.x + 24, y: -61, z: o.z + 108 }, 'grass_block');
    const heights = [30, 20, 20, 12, 50];
    for (let i = 0; i < 5; i++) {
      const t = tower(i);
      await fillAt(bot, { x: t.x, y: -60, z: t.z }, { x: t.x + 4, y: -61 + heights[i]!, z: t.z + 4 }, 'stone');
    }
    // the slab strips east of towers 2 and 3 (where the body lands when it walks off the east edge)
    for (const [i, half] of [
      [2, 'bottom'],
      [3, 'top'],
    ] as const) {
      const t = tower(i);
      for (let x = t.x + 5; x <= t.x + 7; x++) for (let z = t.z; z <= t.z + 4; z++) await bot.truth.ok('setblock', [x, -60, z, 'oak_slab', `minecraft:vertical_half=${half}`]);
    }
    await bot.loop.waitTicks(10);
  }, 240_000);

  afterAll(async () => {
    report(`fall-clutch e2e, area ${o.x},${o.z}`, summary);
    await disconnectBot(bot);
  });

  const box = (i: number): [Vec3, Vec3] => {
    const t = tower(i);
    return [
      { x: t.x - 6, y: -61, z: t.z - 6 },
      { x: t.x + 12, y: -30, z: t.z + 10 },
    ];
  };
  const buckets = async () => Object.fromEntries(Object.entries((await bot.truth.ok<{ counts: Record<string, number> }>('inv', [bot.name])).counts).map(([k, v]) => [k.replace('minecraft:', ''), v]));

  /** Walk off the east edge of tower i (from its top centre row) and wait until the clutch is over. */
  async function stepOff(i: number, h: number, amplifier = 4): Promise<number> {
    const t = tower(i);
    await tpBot(bot, { x: t.x + 4.5, y: -60 + h, z: t.z + 2.5 }, -90);
    await toughen(bot, amplifier);
    await bot.loop.waitTicks(5);
    const since = await bot.pve.now();
    bot.loop.setCommand({ yaw: -90, forward: 1 });
    for (let k = 0; k < 40 && bot.loop.state.onGround; k++) await bot.loop.waitTicks(1);
    bot.loop.setCommand({ forward: 0 });
    for (let k = 0; k < 200 && (!bot.loop.state.onGround || bot.skills.falls.busy); k++) await bot.loop.waitTicks(1);
    await bot.loop.waitTicks(10);
    return since;
  }

  for (const rep of [1, 2]) {
    it(`planned: a 30-block drop with the clutch, 0 damage, bucket recovered, no water left (run ${rep})`, async () => {
      await kit(bot, [['water_bucket', 1], ['bread', 4]]);
      const t = tower(0);
      await tpBot(bot, { x: t.x + 2.5, y: -30, z: t.z + 2.5 }, -90);
      await toughen(bot);
      await bot.loop.waitTicks(10);
      const since = await bot.pve.now();
      const res = await bot.skills.goto({ type: 'block', p: { x: t.x + 14, y: -60, z: t.z + 2 } }, { timeoutTicks: 1500 });
      for (let k = 0; k < 100 && bot.skills.falls.busy; k++) await bot.loop.waitTicks(1);
      await bot.loop.waitTicks(20);
      const hurt = await fallHurts(bot, since);
      const water = await waterIn(bot, ...box(0));
      const inv = await buckets();
      const c = bot.skills.falls.last;
      summary.push(`planned run ${rep}: ${JSON.stringify(res)}, fall damage ${hurt.total}, water left ${water}, inv ${JSON.stringify(inv)}, clutch ${JSON.stringify(c)}`);
      expect(res).toEqual({ ok: true });
      expect(hurt.total).toBe(0);
      expect(c).toMatchObject({ placed: true, recovered: true });
      expect(inv.water_bucket).toBe(1);
      expect(water).toBe(0);
    }, 180_000);
  }

  for (const rep of [1, 2]) {
    it(`reactive: walking off a 20-block tower, clutch, 0 damage, bucket recovered (run ${rep})`, async () => {
      await kit(bot, [['water_bucket', 1]]);
      const since = await stepOff(1, 20);
      const hurt = await fallHurts(bot, since);
      const water = await waterIn(bot, ...box(1));
      const inv = await buckets();
      const c = bot.skills.falls.last;
      summary.push(`reactive run ${rep}: fall damage ${hurt.total}, water left ${water}, inv ${JSON.stringify(inv)}, clutch ${JSON.stringify(c)}`);
      expect(hurt.total).toBe(0);
      expect(c).toMatchObject({ placed: true, recovered: true });
      expect(inv.water_bucket).toBe(1);
      expect(water).toBe(0);
    }, 120_000);
  }

  for (const rep of [1, 2]) {
    it(`reactive from 50 blocks (3 blocks per tick at the end): clutch, 0 damage, bucket recovered (run ${rep})`, async () => {
      await kit(bot, [['water_bucket', 1]]);
      const since = await stepOff(4, 50, 14); // 80 HP: a missed clutch (45 HP) is survived
      const hurt = await fallHurts(bot, since);
      const water = await waterIn(bot, ...box(4));
      const inv = await buckets();
      const c = bot.skills.falls.last;
      summary.push(`reactive 50 run ${rep}: fall damage ${hurt.total}, water left ${water}, inv ${JSON.stringify(inv)}, clutch ${JSON.stringify(c)}`);
      expect(hurt.total).toBe(0);
      expect(c).toMatchObject({ placed: true, recovered: true });
      expect(inv.water_bucket).toBe(1);
      expect(water).toBe(0);
    }, 120_000);
  }

  for (const rep of [1, 2]) {
    it(`bottom slab landing: the slab is waterlogged, 0 damage, picked up from the slab (run ${rep})`, async () => {
      await kit(bot, [['water_bucket', 1]]);
      const since = await stepOff(2, 20);
      const hurt = await fallHurts(bot, since);
      const c = bot.skills.falls.last;
      const inv = await buckets();
      const w = c?.target?.ok ? c.target.water : undefined;
      const layer1 = w ? bot.world.registry.nameOf(bot.world.chunks.stateIdAt(w.x, w.y, w.z, 1) ?? -1) : undefined;
      summary.push(`slab run ${rep}: fall damage ${hurt.total}, inv ${JSON.stringify(inv)}, layer 1 after ${layer1}, clutch ${JSON.stringify(c)}`);
      expect(hurt.total).toBe(0);
      expect(c).toMatchObject({ placed: true, recovered: true, landing: 'oak_slab' });
      expect(c?.target).toMatchObject({ ok: true, layer: 1 });
      expect(inv.water_bucket).toBe(1);
      expect(layer1).not.toBe('water');
    }, 120_000);
  }

  for (const rep of [1, 2]) {
    it(`top slab landing: refused (the water would be inside the slab), the model's damage (run ${rep})`, async () => {
      await kit(bot, [['water_bucket', 1]]);
      const before = bot.skills.falls.stats.clutches;
      const since = await stepOff(3, 12);
      const hurt = await fallHurts(bot, since);
      const c = bot.skills.falls.last;
      const water = await waterIn(bot, ...box(3));
      // a top slab in cell -60 has its top at -59: the drop from the tower top (feet -48) is 11
      const model = fallDamage(11, 'oak_slab');
      summary.push(`top slab run ${rep}: fall damage ${hurt.total} (model ${model}), water ${water}, clutch ${JSON.stringify(c)}`);
      expect(bot.skills.falls.stats.clutches).toBe(before);
      expect(c?.reason).toMatch(/inside/);
      expect(water).toBe(0);
      expect(hurt.total).toBe(model);
      await setHealth(bot, 20);
    }, 120_000);
  }
});
