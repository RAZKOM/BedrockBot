// e2e (tag @bds), Track BI: long falls on bds-gaunt (fall-truth.ts). A 12-block stone tower with no way down
// but the fall; the goal on the ground 10 blocks east. With health 20 the walk drops the 12 blocks and
// arrives; the server's fall damage (truth:hurtlog) is the model's (8 HP). With health 12 (the margin is
// 8) the goto refuses: unreachable with the note that names the drop and the reason; the bot stays on top.
// Each case runs twice.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fallDamage } from '../../src/skills/fall/damage.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { disconnectBot } from './move-truth.ts';
import { E2E, connectFallBot, fallArea, fallHurts, fillAt, kit, report, setHealth, tpBot, type FallBot } from './fall-truth.ts';

describe.skipIf(!E2E)('@bds long falls: a 12-block cliff (bds-gaunt)', () => {
  let bot: FallBot;
  const o = fallArea();
  const summary: string[] = [];
  const TOP_FEET = -48;
  const top: Vec3 = { x: o.x + 2.5, y: TOP_FEET, z: o.z + 2.5 };
  const goal: Vec3 = { x: o.x + 14, y: -60, z: o.z + 2 };

  beforeAll(async () => {
    bot = await connectFallBot('FallLong', { x: o.x + 10, y: -60, z: o.z });
    // clear the area, then a 5 x 5 stone tower 12 high (top block at -49)
    await fillAt(bot, { x: o.x - 8, y: -60, z: o.z - 8 }, { x: o.x + 24, y: -40, z: o.z + 12 }, 'air');
    await fillAt(bot, { x: o.x - 8, y: -61, z: o.z - 8 }, { x: o.x + 24, y: -61, z: o.z + 12 }, 'grass_block');
    await fillAt(bot, { x: o.x, y: -60, z: o.z }, { x: o.x + 4, y: -49, z: o.z + 4 }, 'stone');
    await kit(bot, [['bread', 4]]);
  }, 180_000);

  afterAll(async () => {
    report(`fall-long e2e, area ${o.x},${o.z}`, summary);
    await disconnectBot(bot);
  });

  for (const rep of [1, 2]) {
    it(`drops 12 blocks and arrives; the damage is the model's (run ${rep})`, async () => {
      await tpBot(bot, top, -90);
      await setHealth(bot, 20);
      await bot.loop.waitTicks(10);
      const since = await bot.pve.now();
      const t0 = bot.loop.state.tick;
      const res = await bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks: 1200 });
      const ticks = Number(bot.loop.state.tick - t0);
      await bot.loop.waitTicks(10);
      const hurt = await fallHurts(bot, since);
      const p = await bot.truth.pos(bot.name);
      const rep2 = bot.skills.status().lastGoto;
      const drops = rep2?.plans.length ?? 0;
      summary.push(`run ${rep}: ${JSON.stringify(res)} in ${ticks} ticks, fall damage ${hurt.total} (${hurt.events.length} hurts, model ${fallDamage(12)}), health ${(p as unknown as { health: number }).health}, plans ${drops}, corrections ${rep2?.corrections}`);
      expect(res).toEqual({ ok: true });
      expect(hurt.total).toBe(fallDamage(12));
      expect(Math.abs(p.location.x - (goal.x + 0.5))).toBeLessThan(1);
    }, 120_000);
  }

  for (const rep of [1, 2]) {
    it(`health 12 (margin 8): refuses the drop and says why (run ${rep})`, async () => {
      await tpBot(bot, top, -90);
      await setHealth(bot, 12);
      await bot.loop.waitTicks(10);
      const since = await bot.pve.now();
      const res = await bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks: 1200 });
      const hurt = await fallHurts(bot, since);
      const p = await bot.truth.pos(bot.name);
      summary.push(`low health run ${rep}: ${JSON.stringify(res)}, feet ${p.location.y.toFixed(2)}, fall damage ${hurt.total}`);
      expect(res).toEqual({ ok: false, reason: 'unreachable', note: 'the way down is a 12-block drop (8 HP), refused: it would leave 4 HP, the margin is 8' });
      expect(p.location.y).toBeCloseTo(TOP_FEET, 1);
      expect(hurt.total).toBe(0);
      await setHealth(bot, 20);
    }, 120_000);
  }
});
