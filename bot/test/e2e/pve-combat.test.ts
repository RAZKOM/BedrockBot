// PLAN.md task 7.4 on bds-pve (difficulty normal): the combat skill kills 3 summoned zombies one after
// another, a skeleton, and handles a creeper without explosion damage; guard mode fights a zombie
// summoned 10 blocks from home and walks back home; flee runs to the shelter when the health is set
// low with a hostile alive; `!kill player` is refused. Every hit is checked on the server side
// (truth:hurtlog). Needs BDS_E2E=1 and bds-pve with the truth pack
// (`node scripts/bds.mjs --profile pve up` and `... pack`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KILL_REFUSED } from '../../src/chat/commands-pve.ts';
import type { FightResult } from '../../src/skills/combat/combat.ts';
import {
  armWithIronSword,
  botDamage,
  botHits,
  centre,
  connectPlayer,
  E2E,
  FEET_Y,
  fmt,
  hdist,
  prepareServer,
  privateArea,
  pveCmd,
  sleep,
  startPveBot,
  teleport,
  tracked,
  uniqueName,
  until,
  type PveBot,
} from './pve-truth.ts';

describe.skipIf(!E2E)('pve: combat, guard, flee (task 7.4)', () => {
  let bot: PveBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];

  beforeAll(async () => {
    await prepareServer();
    bot = await startPveBot('PveFight');
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 48);
    await armWithIronSword(bot);
    await bot.truth.setHealth(bot.name, 20);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 48).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${measurements.join('\n  ')}`);
  });

  /** Summon, fight to the end, and check the result against the server's hurt log. */
  async function fightOne(type: string, offset: { x: number; z: number }): Promise<{ r: FightResult; serverHits: number; taken: number; explosion: number }> {
    const b = bot!;
    const since = await b.truth.now();
    const mob = await b.truth.summon(type, { x: HOME.x + 0.5 + offset.x, y: FEET_Y, z: HOME.z + 0.5 + offset.z });
    const rid = await tracked(b, mob);
    const r = await b.pve.combat.fight(rid, { timeoutTicks: 1200 });
    await sleep(500);
    const log = await b.truth.hurtlog(since);
    const hits = botHits(log.events, b.name, mob.entityId);
    const dmg = botDamage(log.events, b.name);
    const explosion = (dmg.byCause.entityExplosion ?? 0) + (dmg.byCause.blockExplosion ?? 0);
    const after = await b.truth.entity(mob.entityId);
    const line =
      `${type}: ${r.reason} in ${r.ticks} ticks, ${r.attacks} attack packets, ${r.landed} seen landing, ${hits.length} server-side hits ` +
      `(damage ${hits.map((h) => h.damage.toFixed(1)).join('+')}), bot took ${dmg.total} (${JSON.stringify(dmg.byCause)}), mob after: ${after.valid === false ? 'removed' : `health ${after.health}`}`;
    console.log(line);
    measurements.push(line);
    // the server agrees that it is dead (removed, or at 0 health in its death animation)
    if (r.reason === 'killed') expect(after.valid === false || (after.health ?? 1) <= 0).toBe(true);
    return { r, serverHits: hits.length, taken: dmg.total, explosion };
  }

  it('kills 3 summoned zombies one after another with an iron sword without dying', async () => {
    const b = bot!;
    const deaths0 = b.built.respawn!.deaths;
    for (let i = 0; i < 3; i++) {
      const angle = (i * 2 * Math.PI) / 3;
      const res = await fightOne('zombie', { x: Math.round(6 * Math.cos(angle)), z: Math.round(6 * Math.sin(angle)) });
      expect(res.r.reason).toBe('killed');
      expect(res.serverHits).toBeGreaterThanOrEqual(2);
      // every attack packet the server accepted shows in the hurt log; we never swing at nothing in reach
      expect(res.serverHits).toBeLessThanOrEqual(res.r.attacks);
    }
    expect(b.built.respawn!.deaths).toBe(deaths0);
    expect(b.built.respawn!.dead).toBe(false);
  }, 180_000);

  it('kills a skeleton (ranged attacker: the approach works)', async () => {
    const b = bot!;
    await b.truth.setHealth(b.name, 20);
    const res = await fightOne('skeleton', { x: 10, z: 3 });
    expect(res.r.reason).toBe('killed');
    expect(res.serverHits).toBeGreaterThanOrEqual(2);
    expect(b.built.respawn!.dead).toBe(false);
  }, 120_000);

  it('handles a creeper without taking explosion damage', async () => {
    const b = bot!;
    await b.truth.setHealth(b.name, 20);
    const res = await fightOne('creeper', { x: -5, z: 4 });
    expect(['killed', 'exploded', 'gone']).toContain(res.r.reason);
    expect(res.explosion).toBe(0);
    expect(b.built.respawn!.dead).toBe(false);
  }, 120_000);

  it('guard: a zombie summoned 10 blocks from home is fought, then the bot walks back home', async () => {
    const b = bot!;
    await b.truth.setHealth(b.name, 20);
    await teleport(b, centre(HOME));
    b.task.home!.set(HOME);
    b.pve.setGuard({ on: true, radius: 16 });
    await until(() => (b.pve.behaviour() === 'guarding r=16' ? true : undefined), 5_000, 'guarding');
    const since = await b.truth.now();
    const t0 = Date.now();
    const mob = await b.truth.summon('zombie', { x: HOME.x + 0.5 + 10, y: FEET_Y, z: HOME.z + 0.5 });
    await tracked(b, mob);
    const seen = await until(() => (b.pve.behaviour().startsWith('fighting') ? b.pve.behaviour() : undefined), 10_000, 'guard fight starts', 50);
    const triggerMs = Date.now() - t0;
    await until(async () => ((await b.truth.entity(mob.entityId)).valid === false ? true : undefined), 60_000, 'zombie dead', 500);
    const killMs = Date.now() - t0;
    await until(async () => {
      const p = await b.truth.pos(b.name);
      return hdist(p.location, centre(HOME)) < 1.0 ? p : undefined;
    }, 60_000, 'back home', 500);
    const homeMs = Date.now() - t0;
    await until(() => (b.pve.behaviour() === 'guarding r=16' ? true : undefined), 10_000, 'guarding again');
    const log = await b.truth.hurtlog(since);
    const line = `guard: "${seen}" after ${triggerMs} ms, zombie dead after ${killMs} ms, home after ${homeMs} ms, ${botHits(log.events, b.name, mob.entityId).length} hits, bot took ${botDamage(log.events, b.name).total}`;
    console.log(line);
    measurements.push(line);
    expect(b.metrics.snapshot().counters['pve.guard']).toBeGreaterThanOrEqual(1);
    b.pve.setGuard({ on: false });
  }, 150_000);

  it('flee: health set low with a hostile alive -> runs to the shelter', async () => {
    const b = bot!;
    await b.truth.setHealth(b.name, 20);
    await teleport(b, centre(HOME));
    // daytime: at night the night safety walks to the shelter by itself and flee leaves it alone
    await b.truth.ok('time', ['noon']);
    const clock = b.built.clock!;
    await until(() => (clock.timeOfDay !== undefined && clock.timeOfDay < 12000 ? true : undefined), 5_000, 'clock at noon', 50);
    const SHELTER = { x: HOME.x - 14, y: FEET_Y, z: HOME.z + 2 };
    b.task.shelter!.set(SHELTER);
    b.pve.stop();
    const t0 = Date.now();
    await b.truth.setHealth(b.name, 5);
    // a husk (does not burn) that cannot move (slowness 255) and does not hit hard: alive, near, not a killer
    const mob = await b.truth.summon('husk', { x: HOME.x + 0.5 + 4, y: FEET_Y, z: HOME.z + 0.5 + 3 });
    await b.truth.effect(mob.entityId, 'slowness', 120, 255);
    await b.truth.effect(mob.entityId, 'weakness', 120, 255);
    await until(() => (b.pve.behaviour() === 'fleeing' ? true : undefined), 5_000, 'fleeing', 50);
    const fleeMs = Date.now() - t0;
    const at = await until(async () => {
      const p = await b.truth.pos(b.name);
      return hdist(p.location, centre(SHELTER)) < 1.5 ? p : undefined;
    }, 30_000, 'at the shelter', 250);
    const line = `flee: fleeing ${fleeMs} ms after health 5, at the shelter ${fmt(at.location)} after ${Date.now() - t0} ms (${hdist(centre(HOME), centre(SHELTER)).toFixed(1)} blocks)`;
    console.log(line);
    measurements.push(line);
    expect(b.metrics.snapshot().counters['pve.flees']).toBeGreaterThanOrEqual(1);
    b.task.shelter!.set(undefined);
    await b.truth.cleanup();
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('time', ['midnight']);
  }, 90_000);

  it('!kill player and !kill <player name> are refused; the combat skill refuses a player target', async () => {
    const b = bot!;
    const other = await connectPlayer(uniqueName('PveVictim'));
    try {
      await b.truth.tp(other.name, { x: HOME.x + 2.5, y: FEET_Y, z: HOME.z + 0.5 }, 0, 0);
      const rid = await until(() => {
        for (const e of b.built.mobility!.world.entities.values()) if (e.username === other.name) return e.runtimeId;
        return undefined;
      }, 10_000, 'the other player tracked');
      const since = await b.truth.now();
      const n0 = b.said.length;
      await pveCmd('tell', b.name, '!kill', 'player');
      await pveCmd('tell', b.name, '!kill', other.name);
      await until(() => (b.said.slice(n0).filter((s) => s === KILL_REFUSED).length >= 2 ? true : undefined), 10_000, 'two refusals');
      const direct = await b.pve.combat.fight(rid);
      expect(direct.reason).toBe('refused_player');
      expect(b.pve.combat.attack(rid)).toBe(false);
      const kill = await b.pve.kill('player', 1);
      expect(kill.reason).toBe('refused_player');
      await sleep(1000);
      const log = await b.truth.hurtlog(since);
      expect(log.events.filter((h) => h.victimName === other.name)).toHaveLength(0);
      console.log(`refusals: ${b.said.slice(n0).join(' | ')}`);
    } finally {
      await other.close();
    }
  }, 60_000);
});
