// Flee v2 on bds-gaunt (wave 7, Track W; docs/pve.md "Flee"): a boxed route where home lies behind the
// zombie. A ring corridor (2 wide, walls 3 high around a solid 17 x 17 core) with the bot on the south
// side, a zombie 4 blocks east of it and home in the south-east corner: the direct way home passes the
// zombie. Health set to 7 (fleeHealth 8), food 17 without saturation (no regeneration, nothing to eat),
// iron armour. Expected: the bot runs away first (its distance to the zombie and to home grow), around
// the ring, and reaches home from the other side within 60 s. Run twice per suite run (two rings).
// Needs BDS_E2E=1 and bds-gaunt with the truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { botDamage, centre, E2E, FEET_Y, fill, hdist, prepareServer, privateArea, sleep, startGauntBot, teleport, tracked, until, type GauntBot } from './gaunt-truth.ts';

describe.skipIf(!E2E)('gaunt: flee v2 (Track W)', () => {
  let bot: GauntBot | undefined;
  const area = privateArea();
  const lines: string[] = [];

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startGauntBot('GtFlee', {}, { values: { guard: '16' } });
    await teleport(bot, centre({ x: area.x, y: FEET_Y, z: area.z }));
    await bot.truth.clearAround(centre({ x: area.x, y: FEET_Y, z: area.z }), 96);
    await bot.truth.ok('clear', [bot.name]);
    for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await bot.truth.give(bot.name, piece, 1);
    await until(() => (bot!.built.mobility!.world.inventory.window(120)?.slots.filter(Boolean).length === 4 ? true : undefined), 15_000, 'iron armour worn');
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      for (const k of [0, 1]) {
        const c = { x: area.x + k * 40, y: FEET_Y, z: area.z };
        await fill(bot, { x: c.x - 11, y: FEET_Y, z: c.z - 11 }, { x: c.x + 11, y: FEET_Y + 2, z: c.z + 11 }, 'air').catch(() => undefined);
      }
      await bot.stop();
    }
    console.log(`measurements:\n  ${lines.join('\n  ')}`);
  });

  async function ring(c: Vec3): Promise<void> {
    const b = bot!;
    await fill(b, { x: c.x - 11, y: FEET_Y, z: c.z - 11 }, { x: c.x + 11, y: FEET_Y + 2, z: c.z + 11 }, 'stone');
    await fill(b, { x: c.x - 10, y: FEET_Y, z: c.z - 10 }, { x: c.x + 10, y: FEET_Y + 2, z: c.z + 10 }, 'air');
    await fill(b, { x: c.x - 8, y: FEET_Y, z: c.z - 8 }, { x: c.x + 8, y: FEET_Y + 2, z: c.z + 8 }, 'stone');
  }

  for (const k of [0, 1]) {
    it(`ring ${k + 1}: home behind the zombie -> away first, around the ring, home within 60 s`, async () => {
      const b = bot!;
      const c = { x: area.x + k * 40, y: FEET_Y, z: area.z };
      await ring(c);
      const start = { x: c.x - 3, y: FEET_Y, z: c.z + 9 };
      const home = { x: c.x + 9, y: FEET_Y, z: c.z + 9 };
      const homeC = centre(home);
      await teleport(b, centre(start));
      b.task.home!.set(home);
      await b.truth.setHealth(b.name, 7);
      await b.truth.setFood(b.name, 17, 0);
      await until(() => (b.pve.health() <= 7 ? true : undefined), 5000, 'health 7 in the model');
      const flees0 = b.pve.stats.flees;
      const since = await b.truth.now();
      const z = await b.truth.summon('zombie', { x: c.x + 1.5, y: FEET_Y, z: c.z + 9.5 });
      await b.truth.effect(z.entityId, 'slowness', 120, 1);
      await tracked(b, z);
      const t0 = Date.now();
      const samples: { t: number; dz: number; dh: number; pos: Vec3 }[] = [];
      let arrived: number | undefined;
      while (Date.now() - t0 < 60_000) {
        // one request at a time: the sample time is the time of the position reply
        const me = await b.truth.pos(b.name);
        const tMe = Date.now() - t0;
        const zz = await b.truth.entity(z.entityId);
        const dz = zz.valid === false ? NaN : hdist(me.location, zz.location);
        const dh = hdist(me.location, homeC);
        samples.push({ t: tMe, dz, dh, pos: me.location });
        if (dh <= 1.5 && Math.abs(me.location.y - FEET_Y) < 1) {
          arrived = Date.now() - t0;
          break;
        }
        await sleep(250);
      }
      const at2 = samples.find((s) => s.t >= 2000) ?? samples.at(-1)!;
      // the geometry at the start (the zombie was summoned 4 blocks east of the bot, home 12 east)
      const first = { t: 0, dz: hdist(centre(start), { x: c.x + 1.5, z: c.z + 9.5 }), dh: hdist(centre(start), homeC) };
      const maxDz = Math.max(...samples.map((s) => (Number.isFinite(s.dz) ? s.dz : 0)));
      const dmg = botDamage((await b.truth.hurtlog(since)).events, b.name);
      const health = b.pve.health();
      const line =
        `ring ${k + 1}: zombie ${first.dz.toFixed(1)} -> ${at2.dz.toFixed(1)} after ${(at2.t / 1000).toFixed(1)} s (max ${maxDz.toFixed(1)}), home ${first.dh.toFixed(1)} -> ${at2.dh.toFixed(1)}; ` +
        `${arrived !== undefined ? `home after ${(arrived / 1000).toFixed(1)} s` : 'NOT home in 60 s'}; flees ${b.pve.stats.flees - flees0}; damage ${dmg.total} ${JSON.stringify(dmg.byDamager)}; health ${health}; corrections ${b.built.mobility!.loop.state.corrections}`;
      console.log(line);
      lines.push(line);
      await b.truth.cleanup();
      await b.truth.setHealth(b.name, 20);
      await fill(b, { x: c.x - 11, y: FEET_Y, z: c.z - 11 }, { x: c.x + 11, y: FEET_Y + 2, z: c.z + 11 }, 'air');
      expect(at2.dz).toBeGreaterThan(first.dz + 1); // away from the zombie first
      expect(at2.dh).toBeGreaterThan(first.dh); // and away from home (it is behind the zombie)
      expect(arrived).toBeDefined();
      expect(arrived!).toBeLessThan(60_000);
      expect(health).toBeGreaterThan(0);
    }, 120_000);
  }
});
