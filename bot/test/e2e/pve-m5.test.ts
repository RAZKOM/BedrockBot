// Track M5 (docs/pve.md "Track M5: witches and arrows under poison", ADR 0079 addendum) on bds-pve: what the rules stand on.
//   way        the stone kit at 3 health 40 blocks from home, a zombie 13 off to the side starting the flight on foot, a
//              skeleton 27 off beside the way home (farther than the flight looks for threats, and farther than 16 from
//              home): with `shooterWay` the bot does not take the leg home; off, it walks home past the skeleton
//   range      which of six skeletons 24 to 104 off the server sends (what the memory of out-of-range shooters stands on)
//   bite       the server's poison on the bot (mob_effect) and a witch 20 off hold the flight's bites (`poisonBite`)
// Needs BDS_E2E=1 and bds-pve with the truth pack.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, cleanSpot, E2E, FEET_Y, hdist, prepareServer, privateArea, sleep, startPveBot, teleport, tracked, uniqueName, until, type PveBot } from './pve-truth.ts';

function note(line: string): void {
  console.log(line);
  if (process.env.M5_OUT) appendFileSync(process.env.M5_OUT, `${line}\n`);
}

describe.skipIf(!E2E)('pve: Track M5 rules', () => {
  let bot: PveBot | undefined;
  const ownerName = uniqueName('M5Owner');
  const area = privateArea();
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: area.x + 300 + 80 * i, y: FEET_Y, z: area.z + 700 };
  };

  /** No flight outlives a side: health up first (else the flee starts again at once), then stop until none runs. */
  async function quiet(b: PveBot): Promise<void> {
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
    // 2026-11-16: the `off` side's flee started again after its stop (health 3, the skeleton at 5), walked the bot from
    // the `on` side's start and a home chore after it took the bot home: the `on` side read 1.5 from home
    await quiet(b);
    // once (2026-11-16) the teleport after the `off` side's walk home found no chunk of the new spot in 20 s: once more
    await teleport(b, c).catch(async () => {
      await sleep(1000);
      await teleport(b, c);
    });
    await cleanSpot(b, c, { r: 32, up: 5, entities: 70 }); // clean ground whatever earlier runs left
    await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    return c;
  }

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startPveBot('PveM5', {}, { owners: [ownerName] });
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('unequip', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'stone_sword', 1]);
    await bot.truth.ok('give', [bot.name, 'bread', 16]);
    bot.pve.settings.set('mobReflex', false); // the zombie stays 13 off: nothing to strike, and no stand instead of the flight
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
  });

  it('range: the server sends a skeleton 24 off; how far it sends them is measured (the memory of shooterWay)', async () => {
    const b = bot!;
    const c = await fresh(b);
    const offs = [24, 40, 56, 72, 88, 104];
    const seen: Record<number, string> = {};
    const ids: Record<number, string> = {};
    for (const d of offs) {
      const r = await b.truth.summon('skeleton', { x: c.x + d, y: FEET_Y, z: c.z }).catch((e: Error) => e);
      if (r instanceof Error) {
        seen[d] = `not summoned (${r.message.slice(0, 40)})`;
        continue;
      }
      ids[d] = r.entityId;
      await b.truth.effect(r.entityId, 'slowness', 30, 255).catch(() => undefined);
    }
    await sleep(3000);
    const ents = [...b.pve.d.world.entities.values()].filter((e) => e.type.endsWith('skeleton'));
    for (const d of offs) {
      if (seen[d]) continue;
      seen[d] = ents.some((e) => Math.abs(e.pos.x - (c.x + d)) < 2 && Math.abs(e.pos.z - c.z) < 2) ? 'sent' : 'not sent';
    }
    note(`range: skeletons along x from the bot: ${offs.map((d) => `${d} ${seen[d]}`).join(', ')}`);
    await b.truth.cleanup();
    expect(seen[24]).toBe('sent');
  }, 60_000);

  it('way: at 3 health 40 from home, a skeleton beside the way: on, no leg home; off, the bot walks home past it', async () => {
    const b = bot!;
    const out: Record<string, { nearestHome: number; skeleton: number }> = {};
    for (const on of [false, true]) {
      const c = await fresh(b);
      b.pve.rules.shooterWay = on;
      const home = { x: Math.floor(c.x) - 20, y: FEET_Y, z: Math.floor(c.z) };
      b.task.home?.set(home);
      const start = { x: c.x + 20, y: FEET_Y, z: c.z };
      await teleport(b, start);
      await b.truth.effect(b.name, 'resistance', 60, 4); // no damage: the case is about the choice, not the arrows
      await b.truth.setHealth(b.name, 3);
      b.pve.lastHit = { damage: 4, at: performance.now() };
      const sk = await b.truth.summon('skeleton', { x: c.x - 6, y: FEET_Y, z: c.z + 9 });
      await b.truth.effect(sk.entityId, 'slowness', 60, 255);
      const skId = await tracked(b, sk);
      b.pve.setGuard({ on: true, radius: 16 });
      const z = await b.truth.summon('zombie', { x: start.x, y: FEET_Y, z: start.z - 13 });
      await b.truth.effect(z.entityId, 'slowness', 60, 255);
      await tracked(b, z);
      const homeC = { x: home.x + 0.5, z: home.z + 0.5 };
      let nearestHome = Infinity;
      let skeleton = Infinity;
      const t0 = Date.now();
      let held = Date.now();
      while (Date.now() - t0 < 15_000) {
        if (Date.now() - held > 1500) {
          held = Date.now();
          await b.truth.setHealth(b.name, 3); // low the whole case (full food heals)
        }
        const me = b.pve.position();
        nearestHome = Math.min(nearestHome, hdist(me, homeC));
        const s = b.pve.d.world.entities.get(skId);
        if (s) skeleton = Math.min(skeleton, hdist(me, s.pos));
        await sleep(100);
      }
      b.pve.setGuard({ on: false });
      await b.truth.cleanup();
      await quiet(b);
      out[on ? 'on' : 'off'] = { nearestHome, skeleton };
      note(`way home past a skeleton (shooterWay ${on ? 'on' : 'off'}): nearest to home ${nearestHome.toFixed(1)}, nearest to the skeleton ${skeleton === Infinity ? '-' : skeleton.toFixed(1)}`);
      await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
      await b.truth.cleanup();
    }
    b.pve.rules.shooterWay = true;
    expect(out.off!.nearestHome).toBeLessThan(20);
    // on: the away leg from the zombie (to the side) takes it a few blocks nearer (2026-11-16: 33.5 on, 15.5 and 1.1 off)
    expect(out.on!.nearestHome).toBeGreaterThan(28);
    expect(out.on!.skeleton).toBeGreaterThan(16); // never in its range (21.8 on; 5.0 off)
  }, 120_000);

  it('bite: the server poison on the bot and a witch 20 off hold the bites of the flight; the poison cleared, they do not', async () => {
    const b = bot!;
    const c = await fresh(b);
    await b.truth.effect(b.name, 'resistance', 60, 4);
    await b.truth.ok('setfood', [b.name, 14, 0]);
    const w = await b.truth.summon('witch', { x: c.x - 20, y: FEET_Y, z: c.z });
    await b.truth.effect(w.entityId, 'slowness', 60, 255);
    await b.truth.effect(w.entityId, 'weakness', 60, 255);
    await tracked(b, w);
    const before = b.pve.biteHeld(b.pve.position());
    await b.truth.effect(b.name, 'poison', 20, 0);
    await until(() => b.pve.mobs.selfPoison, 5000, 'the bot sees its own poison');
    const poisoned = b.pve.biteHeld(b.pve.position());
    b.pve.rules.poisonBite = false;
    const off = b.pve.biteHeld(b.pve.position());
    b.pve.rules.poisonBite = true;
    await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
    await until(() => (b.pve.mobs.selfPoison === undefined ? true : undefined), 5000, 'the poison removed');
    const cleared = b.pve.biteHeld(b.pve.position());
    note(`bites held (poisonBite): before the poison ${before}, poisoned with a witch 20 off ${poisoned}, rule off ${off}, poison cleared ${cleared}, food ${b.pve.food()}`);
    await b.truth.cleanup();
    expect(before).toBe(false);
    expect(poisoned).toBe(true);
    expect(off).toBe(false);
    expect(cleared).toBe(false);
  }, 120_000);
});
