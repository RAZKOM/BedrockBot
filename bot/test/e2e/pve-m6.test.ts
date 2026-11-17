// Track M6 (docs/pve.md "Track M6: archer groups, crossbows", ADR 0079 addendum) on bds-pve: what the rules stand on.
//   bare     no blade (16 bread only), a pillager summoned 7 off, guard on, 20 s a side: with `bareArcher` the flight on foot
//            starts at full health and the bot never strikes the pillager; off, guard chases it with a fist first
//   volley   a stone sword at 11 health (resistance: the case is about the choice, not the arrows), three skeletons held 10
//            to 12 off in sight: with `volley` the flight on foot starts above fleeHealth (one round is 12); off, it does not
// Needs BDS_E2E=1 and bds-pve with the truth pack.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, cleanSpot, E2E, expectAlive, FEET_Y, prepareServer, privateArea, sleep, startPveBot, teleport, tracked, uniqueName, until, type PveBot } from './pve-truth.ts';

function note(line: string): void {
  console.log(line);
  if (process.env.M6_OUT) appendFileSync(process.env.M6_OUT, `${line}\n`);
}

describe.skipIf(!E2E)('pve: Track M6 rules', () => {
  let bot: PveBot | undefined;
  const ownerName = uniqueName('M6Owner');
  const area = privateArea();
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: area.x + 300 + 80 * i, y: FEET_Y, z: area.z + 860 };
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
    } while (b.pve.processes.active?.name === 'flee' && Date.now() - t0 < 5000);
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
    bot = await startPveBot('PveM6', {}, { owners: [ownerName] });
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('unequip', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'bread', 16]);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
  });

  it('bare: no blade and a pillager 7 off: on, the flight starts at full health and no fist strikes it; off, guard chases it first', async () => {
    const b = bot!;
    const out: Record<string, { fleeAt: number | null; strikes: number; damage: number }> = {};
    for (const on of [false, true]) {
      const c = await fresh(b);
      b.pve.rules.bareArcher = on;
      const deaths0 = b.built.respawn!.deaths;
      const since = await b.truth.now();
      const p = await b.truth.summon('pillager', { x: c.x + 7, y: FEET_Y, z: c.z });
      const pid = await tracked(b, p);
      b.pve.setGuard({ on: true, radius: 16 });
      let fleeAt: number | null = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000 && b.built.respawn!.deaths === deaths0) {
        if (fleeAt === null && b.pve.processes.active?.name === 'flee') fleeAt = b.pve.health();
        await sleep(100);
      }
      const hurt = (await b.truth.hurtlog(since)).events;
      const strikes = hurt.filter((h) => h.damagerName === b.name && h.victimId === p.entityId).length;
      const damage = +hurt.filter((h) => h.victimName === b.name).reduce((s, h) => s + h.damage, 0).toFixed(1);
      out[on ? 'on' : 'off'] = { fleeAt, strikes, damage };
      note(`bare pillager (bareArcher ${on ? 'on' : 'off'}): flight started at health ${fleeAt ?? '-'}, fist strikes on it ${strikes}, damage taken ${damage} in 20 s${b.built.respawn!.deaths > deaths0 ? ', DIED' : ''} (#${pid})`);
      if (on) expectAlive(b, deaths0, 'bare pillager, bareArcher on');
      b.pve.setGuard({ on: false });
      if (b.built.respawn!.dead) await until(() => (!b.built.respawn!.dead ? true : undefined), 30_000, 'respawned');
      await quiet(b);
    }
    b.pve.rules.bareArcher = true;
    expect(out.on!.fleeAt).not.toBeNull();
    expect(out.on!.fleeAt!).toBeGreaterThanOrEqual(16); // before a second bolt (4 each)
    expect(out.on!.strikes).toBe(0);
    expect(out.off!.strikes).toBeGreaterThan(0); // the code before: a fist chase
  }, 150_000);

  it('volley: a stone sword at 11 health, three skeletons in sight: on, the flight starts above fleeHealth; off, it does not', async () => {
    const b = bot!;
    await b.truth.ok('give', [b.name, 'stone_sword', 1]);
    await until(() => (b.pve.hasBlade() ? true : undefined), 5000, 'the sword in the hotbar');
    const out: Record<string, boolean> = {};
    for (const on of [false, true]) {
      const c = await fresh(b);
      b.task.home?.set({ x: Math.floor(c.x) + 60, y: FEET_Y, z: Math.floor(c.z) }); // home out of the way
      b.pve.rules.volley = on;
      await b.truth.effect(b.name, 'resistance', 60, 4);
      await b.truth.ok('setfood', [b.name, 14, 0]); // no regeneration: the health stays where it is set
      for (const [dx, dz] of [
        [10, 0],
        [-8, 7],
        [0, -12],
      ] as const) {
        const s = await b.truth.summon('skeleton', { x: c.x + dx, y: FEET_Y, z: c.z + dz });
        await b.truth.effect(s.entityId, 'slowness', 60, 255);
        await tracked(b, s);
      }
      await b.truth.setHealth(b.name, 11);
      await until(() => (Math.abs(b.pve.health() - 11) < 0.5 ? true : undefined), 5000, 'health 11');
      const round = b.pve.volleyNow(b.pve.position());
      b.pve.setGuard({ on: true, radius: 16 });
      let fled = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        if (b.pve.processes.active?.name === 'flee') fled = true;
        await sleep(100);
      }
      out[on ? 'on' : 'off'] = fled;
      note(`volley (rule ${on ? 'on' : 'off'}): health ${b.pve.health().toFixed(1)}, ${round.shooters} shooters in sight, a round ${round.damage.toFixed(1)}: ${fled ? 'the flight started' : 'no flight'} in 3 s`);
      await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
      await quiet(b);
    }
    b.pve.rules.volley = true;
    expect(out.on).toBe(true);
    expect(out.off).toBe(false);
  }, 120_000);
});
