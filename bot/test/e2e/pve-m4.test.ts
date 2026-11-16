// Track M4 (docs/pve.md "Track M4: early-game kits", ADR 0079 addendum) on bds-pve: what the early-kit rules stand on.
//   poison     the server's /effect poison on the bot: the bot sees its own mob_effect (level, length), the ticks of 1
//              come as the `poison` cause (not a hit by the skeleton standing 18 off: no duel input), and the health the
//              poison will leave is what low() counts; with the rule off the tick is blamed on the skeleton, as before
//   archer     the stone kit at 6 health at home, a skeleton 12 off: with `archerDuel` guard walks to it and fights it;
//              off, the bot stands (no flee: farther than 6 from home; no duel: 2 x the last hit is more than the health)
// Needs BDS_E2E=1 and bds-pve with the truth pack.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, cleanSpot, E2E, FEET_Y, hdist, prepareServer, privateArea, sleep, startPveBot, teleport, tracked, uniqueName, until, type PveBot } from './pve-truth.ts';

function note(line: string): void {
  console.log(line);
  if (process.env.M4_OUT) appendFileSync(process.env.M4_OUT, `${line}\n`);
}

describe.skipIf(!E2E)('pve: Track M4 early-kit rules', () => {
  let bot: PveBot | undefined;
  const ownerName = uniqueName('M4Owner');
  const area = privateArea();
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: area.x + 300 + 64 * i, y: FEET_Y, z: area.z + 600 };
  };

  async function fresh(b: PveBot): Promise<Vec3> {
    const at = nextSpot();
    const c = centre(at);
    await teleport(b, c);
    await cleanSpot(b, c, { r: 24, up: 5, entities: 60 }); // Track M5: clean ground whatever earlier runs left
    await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
    b.task.home?.set(at);
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    return c;
  }

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startPveBot('PveM4', {}, { owners: [ownerName] });
    // the rules are on by default: each case starts from the code before Track M4 and turns on the rule it is about
    for (const k of Object.keys(bot.pve.rules) as (keyof typeof bot.pve.rules)[]) bot.pve.rules[k] = false;
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('unequip', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'stone_sword', 1]);
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

  it('poison: the bot sees its own poison; a tick is the poison, not the skeleton 18 off', async () => {
    const b = bot!;
    for (const on of [false, true]) {
      const c = await fresh(b);
      b.pve.rules.poison = on;
      const sk = await b.truth.summon('skeleton', { x: c.x + 18, y: FEET_Y, z: c.z });
      await b.truth.effect(sk.entityId, 'slowness', 60, 255);
      await b.truth.effect(sk.entityId, 'weakness', 60, 255);
      await tracked(b, sk);
      b.pve.lastHit = { damage: 4, at: performance.now() };
      const taken0 = b.pve.taken.poison ?? 0;
      await b.truth.effect(b.name, 'poison', 10, 0);
      const p = await until(() => b.pve.mobs.selfPoison, 5000, 'the bot sees its own poison');
      const left = (p.until - performance.now()) / 1000;
      const h0 = b.pve.health();
      const after = b.pve.healthAfterPoison();
      await until(() => (b.pve.health() <= 18 ? true : undefined), 5000, 'two ticks of poison');
      note(`poison (rule ${on ? 'on' : 'off'}): amplifier ${p.amplifier}, ${left.toFixed(1)} s left, health ${b.pve.health()}, health after the poison ${after}, low ${b.pve.low()}, last hit ${b.pve.lastHit?.damage}, blamed ${b.pve.mobs.lastHitBy ? b.pve.mobs.lastHitBy.type : 'nobody'}, poison ticks counted ${(b.pve.taken.poison ?? 0) - taken0}`);
      expect(p.amplifier).toBe(0);
      expect(left).toBeGreaterThan(8);
      expect(left).toBeLessThanOrEqual(10.5);
      if (on) {
        expect(after).toBeLessThan(14); // 20 less about 8 ticks still to come
        expect(b.pve.lastHit?.damage).toBe(4);
        expect((b.pve.taken.poison ?? 0) - taken0).toBeGreaterThanOrEqual(2);
      } else {
        expect(after).toBe(h0);
        expect(b.pve.lastHit?.damage).toBe(1); // the tick taken for a hit (the fault the rule ends)
      }
      await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
      await b.truth.cleanup();
    }
    b.pve.rules.poison = false;
  }, 120_000);

  it('archer: at home at 6 health with a stone sword, a skeleton 12 off: on, guard walks to it; off, the bot stands', async () => {
    const b = bot!;
    const out: Record<string, { fought: boolean; closest: number }> = {};
    for (const on of [false, true]) {
      const c = await fresh(b);
      b.pve.rules.archerDuel = on;
      await b.truth.effect(b.name, 'resistance', 60, 4); // no damage: the test is about the choice, not the arrows
      await b.truth.setHealth(b.name, 6);
      b.pve.lastHit = { damage: 4, at: performance.now() };
      b.pve.setGuard({ on: true, radius: 16 });
      const sk = await b.truth.summon('skeleton', { x: c.x + 12, y: FEET_Y, z: c.z });
      await b.truth.effect(sk.entityId, 'slowness', 60, 255);
      const rid = await tracked(b, sk);
      let fought = false;
      let closest = Infinity;
      const t0 = Date.now();
      let held = Date.now();
      while (Date.now() - t0 < 15_000) {
        // the health held at 6 (it comes back with full food): low the whole case
        if (Date.now() - held > 1500) {
          held = Date.now();
          await b.truth.setHealth(b.name, 6);
        }
        if (b.pve.combat.target?.runtimeId === rid) fought = true;
        const e = b.pve.d.world.entities.get(rid);
        if (e) closest = Math.min(closest, hdist(b.pve.position(), e.pos));
        if (!b.pve.d.world.entities.has(rid)) break; // killed
        await sleep(100);
      }
      b.pve.setGuard({ on: false });
      b.pve.stop();
      out[on ? 'on' : 'off'] = { fought, closest };
      note(`archer at home (archerDuel ${on ? 'on' : 'off'}): fought ${fought}, closest ${closest === Infinity ? '-' : closest.toFixed(1)}, health ${b.pve.health()}`);
      await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
      await b.truth.cleanup();
    }
    b.pve.rules.archerDuel = false;
    expect(out.off!.fought).toBe(false);
    expect(out.off!.closest).toBeGreaterThan(9);
    expect(out.on!.fought).toBe(true);
    expect(out.on!.closest).toBeLessThan(4);
  }, 120_000);
});
