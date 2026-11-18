// Track M10 (docs/pve.md "Track M10: after the flight", ADR 0079 addendum) on bds-pve: what the shipped rule stands on.
//   back home  no blade (16 bread only), a skeleton summoned 7 off, guard on, resistance: a flight from home; once the bot is
//              20 or more out the flight is ended by hand (as a flight that gave up) and the skeleton removed. With `backHome`
//              the home return starts with nothing near and the bot stands within 3 of home within 40 s; off, it stays out
//              with no process running.
// Needs BDS_E2E=1 and bds-pve with the truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, cleanSpot, E2E, expectAlive, FEET_Y, hdist, prepareServer, privateArea, sleep, startPveBot, teleport, tracked, uniqueName, type PveBot } from './pve-truth.ts';

describe.skipIf(!E2E)('pve: Track M10 rules', () => {
  let bot: PveBot | undefined;
  const ownerName = uniqueName('M10Owner');
  const area = privateArea();
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: area.x + 300 + 160 * i, y: FEET_Y, z: area.z + 1180 };
  };

  /** No flight outlives a side: health up first (else the flee starts again at once), then stop until none runs. */
  async function quiet(b: PveBot): Promise<void> {
    b.pve.setGuard({ on: false });
    await b.truth.cleanup();
    await b.truth.setHealth(b.name, 20);
    const t0 = Date.now();
    do {
      b.pve.stop();
      await sleep(250);
    } while (b.pve.processes.active !== undefined && Date.now() - t0 < 5000);
  }

  async function fresh(b: PveBot): Promise<Vec3> {
    const at = nextSpot();
    const c = centre(at);
    await quiet(b);
    await teleport(b, c).catch(async () => {
      await sleep(1000);
      await teleport(b, c);
    });
    await cleanSpot(b, c, { r: 32, up: 5, entities: 70 });
    await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    b.task.home?.set(at);
    return c;
  }

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startPveBot('PveM10', {}, { owners: [ownerName] });
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('unequip', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'bread', 16]);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      bot.pve.rules.backHome = true;
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
  });

  it('back home: a flight from home that ends with nothing near walks home (on); off, the bot stays out', async () => {
    const b = bot!;
    const out: Record<string, { out: number; home: boolean; homeProc: boolean; end: number }> = {};
    try {
      for (const on of [false, true]) {
        const c = await fresh(b);
        b.pve.rules.backHome = on;
        await b.truth.effect(b.name, 'resistance', 120, 4);
        const deaths0 = b.built.respawn!.deaths;
        const flees0 = b.pve.stats.flees;
        const sk = await b.truth.summon('skeleton', { x: c.x + 7, y: FEET_Y, z: c.z });
        await tracked(b, sk);
        b.pve.setGuard({ on: true, radius: 16 });
        // the flight from home, until 20 or more out (at most 40 s)
        const t0 = Date.now();
        while (Date.now() - t0 < 40_000 && !(b.pve.stats.flees > flees0 && hdist(b.pve.position(), c) >= 20)) await sleep(200);
        const outAt = hdist(b.pve.position(), c);
        // the skeleton gone and the flight over (as one that gave up: nothing walks the bot home but the rule)
        await b.truth.cleanup();
        (b.pve.fleeProcess as unknown as { cancelEpisode(): void }).cancelEpisode();
        let home = false;
        let homeProc = false;
        const t1 = Date.now();
        while (Date.now() - t1 < 40_000 && b.built.respawn!.deaths === deaths0) {
          if (b.pve.processes.active?.name === 'home') homeProc = true;
          if (hdist(b.pve.position(), c) <= 3) {
            home = true;
            break;
          }
          await sleep(200);
        }
        const end = hdist(b.pve.position(), c);
        out[on ? 'on' : 'off'] = { out: outAt, home, homeProc, end };
        console.log(`back home (backHome ${on ? 'on' : 'off'}): ${outAt.toFixed(1)} out when the flight ended; home process ${homeProc ? 'yes' : 'no'}; ${home ? `home after ${((Date.now() - t1) / 1000).toFixed(1)} s` : `not home, ${end.toFixed(1)} out after 40 s`}`);
        expectAlive(b, deaths0, `back home, backHome ${on ? 'on' : 'off'}`);
        await quiet(b);
      }
    } finally {
      b.pve.rules.backHome = true;
    }
    expect(out.off!.out).toBeGreaterThanOrEqual(20);
    expect(out.on!.out).toBeGreaterThanOrEqual(20);
    expect(out.off!.home).toBe(false);
    expect(out.off!.homeProc).toBe(false);
    expect(out.on!.homeProc).toBe(true);
    expect(out.on!.home).toBe(true);
  }, 240_000);
});
