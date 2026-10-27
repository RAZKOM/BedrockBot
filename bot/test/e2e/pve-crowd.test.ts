// Track AH (wave 9, combat v3, docs/pve.md "Targeting" and "Shield") on bds-pve (difficulty normal):
// - crowd rule: guard on, health 10, 4 zombies around the bot -> the fight ends `crowded` and a flight
//   starts; then 3 zombies at health 11 in iron armour with the rule on and off (`PVE_CROWD_RUNS` each,
//   default 3): damage, lowest health, deaths, kills and flights in a 45 s window;
// - shield: a shield given to the bot goes to the offhand (truth:stance); raised (sneaking) in front of
//   a zombie it blocks the hits (no damage, shield durability used); skeleton duels in iron armour at 10 blocks with and
//   without the shield (`PVE_SHIELD_RUNS` each, default 5; skeletons with resistance
//   `PVE_SHIELD_SKELETON_RESISTANCE`, default 2, so the duel lasts long enough to be shot at): arrow hits that hurt (truth:hurtlog) and
//   arrows blocked (truth:blocklog); creeper duels with the shield (`PVE_SHIELD_CREEPER_RUNS`, default 3):
//   no explosion damage.
// Every run uses its own spot in a random 256-block cell from x, z = 8192, random truth ids, a per-run
// summon tag, `--no-config` values (pve-truth.ts), and removes its mobs and drops at the end.
// Needs BDS_E2E=1 and bds-pve with the truth pack (`node scripts/bds.mjs --profile pve up` and `... pack`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { yawTowards } from '../../src/skills/nav/follower.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, E2E, FEET_Y, prepareServer, pveCmd, privateArea, sleep, startPveBot, teleport, tracked, until, type MobInfo, type PveBot } from './pve-truth.ts';

const CROWD_RUNS = Number(process.env.PVE_CROWD_RUNS ?? 3);
const SHIELD_RUNS = Number(process.env.PVE_SHIELD_RUNS ?? 5);
const SHIELD_CREEPER_RUNS = Number(process.env.PVE_SHIELD_CREEPER_RUNS ?? 3);
/** Resistance amplifier of the duel skeletons: 2 (60 %) makes 8 iron-sword hits of the 3, so it shoots during the duel. */
const SKELETON_RESISTANCE = Number(process.env.PVE_SHIELD_SKELETON_RESISTANCE ?? 2);

interface Stance {
  isSneaking: boolean;
  offhand: { typeId: string; damage: number | null } | null;
  health: number | null;
}

interface BlockRecord {
  tick: number;
  kind: 'melee' | 'projectile';
  sneaking: boolean;
  attackerType: string | null;
  shieldDamage: number | null;
}

describe.skipIf(!E2E)('pve: crowd rule and shield (Track AH)', () => {
  let bot: PveBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];
  let spot = 0;
  /** A fresh spot 24 blocks from the last (within the private cell). */
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: HOME.x - 96 + 24 * (i % 9), y: FEET_Y, z: HOME.z - 96 + 24 * Math.floor(i / 9) };
  };

  const stance = (b: PveBot): Promise<Stance> => b.truth.ok<Stance>('stance', [b.name]);
  const blocklog = async (b: PveBot, since: number): Promise<BlockRecord[]> => (await b.truth.ok<{ events: BlockRecord[] }>('blocklog', [since, b.name], 20_000)).events;

  async function freshSpot(b: PveBot, health = 20): Promise<Vec3> {
    const at = nextSpot();
    await b.truth.cleanup();
    await b.truth.clearAround(centre(at), 24);
    await teleport(b, centre(at));
    b.task.home!.set(at);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    await b.truth.setHealth(b.name, health);
    await until(() => (Math.abs(b.pve.health() - health) < 0.01 ? true : undefined), 5_000, `health ${health}`);
    return at;
  }

  async function wearIron(b: PveBot): Promise<void> {
    for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await b.truth.ok('give', [b.name, piece, 1]);
    await until(
      async () => {
        const eq = (await b.truth.ok<{ equipment: Record<string, { typeId: string } | undefined> }>('durability', [b.name])).equipment;
        return eq.Head?.typeId === 'minecraft:iron_helmet' && eq.Chest && eq.Legs && eq.Feet ? true : undefined;
      },
      20_000,
      'iron armour worn',
      500,
    );
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startPveBot('PveCrowd');
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 64);
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('unequip', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'iron_sword', 1]);
    await bot.truth.setHealth(bot.name, 20);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 128).catch(() => undefined);
      await bot.truth.ok('unequip', [bot.name]).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${measurements.join('\n  ')}`);
  });

  // ---- crowd rule -----------------------------------------------------------------------------------

  it('crowd: 4 zombies at health 10 -> the guard fight ends `crowded` and a flight starts', async () => {
    const b = bot!;
    const at = await freshSpot(b, 10);
    b.pve.setGuard({ on: true, radius: 16 });
    const crowded0 = b.pve.combat.totals.crowded;
    const flees0 = b.metrics.snapshot().counters['pve.flees'] ?? 0;
    const c = centre(at);
    const z1 = await b.truth.summon('zombie', { x: c.x + 2.5, y: FEET_Y, z: c.z });
    // the first zombie must outlive the summons (resistance V: no damage), or the fight is over before the crowd forms
    await b.truth.effect(z1.entityId, 'resistance', 60, 4);
    await tracked(b, z1);
    await until(() => (b.pve.behaviour().startsWith('fighting') ? true : undefined), 10_000, 'guard fight', 50);
    const t0 = Date.now();
    const more: MobInfo[] = [];
    for (const [dx, dz] of [[-2, 1], [0, -2.5], [1, 2.5]] as const) more.push(await b.truth.summon('zombie', { x: c.x + dx, y: FEET_Y, z: c.z + dz }));
    await until(() => (b.pve.combat.totals.crowded > crowded0 ? true : undefined), 10_000, 'a fight ended crowded', 50);
    const crowdMs = Date.now() - t0;
    await until(() => ((b.metrics.snapshot().counters['pve.flees'] ?? 0) > flees0 ? true : undefined), 5_000, 'a flight', 50);
    const fleeMs = Date.now() - t0;
    const behaviour = b.pve.behaviour();
    const line = `crowd: fight ended crowded ${crowdMs} ms after the 3 zombies were summoned (health ${b.pve.health()}), flight ${fleeMs} ms (behaviour "${behaviour}"), fight.crowded ${b.metrics.snapshot().counters['pve.fight.crowded'] ?? 0}`;
    console.log(line);
    measurements.push(line);
    expect(b.built.respawn!.dead).toBe(false);
    b.pve.setGuard({ on: false });
    b.pve.stop();
    await b.truth.cleanup();
    await b.truth.setHealth(b.name, 20);
    await sleep(1000);
  }, 60_000);

  it(`crowd: 3 zombies at health 11 in iron armour, rule on vs off (${CROWD_RUNS} runs each): damage per run`, async () => {
    const b = bot!;
    await wearIron(b);
    const rows: { mode: string; damage: number; minHealth: number; dead: boolean; kills: number; flees: number }[] = [];
    for (let i = 0; i < 2 * CROWD_RUNS; i++) {
      const mode = i % 2 === 0 ? 'on' : 'off';
      b.pve.combat.crowdRule = mode === 'on';
      const at = await freshSpot(b, 11);
      b.pve.setGuard({ on: true, radius: 16 });
      const deaths0 = b.built.respawn!.deaths;
      const flees0 = b.metrics.snapshot().counters['pve.flees'] ?? 0;
      const since = await b.truth.now();
      const c = centre(at);
      const zs: MobInfo[] = [];
      for (const [dx, dz] of [[2.5, 0], [-2, 1.5], [0, -2.5]] as const) zs.push(await b.truth.summon('zombie', { x: c.x + dx, y: FEET_Y, z: c.z + dz }));
      let minHealth = 20;
      const t0 = Date.now();
      while (Date.now() - t0 < 45_000) {
        minHealth = Math.min(minHealth, b.pve.health());
        if (b.built.respawn!.deaths > deaths0) break;
        const left = await Promise.all(zs.map((z) => b.truth.entity(z.entityId)));
        if (left.every((x) => x.valid === false || (x.health ?? 1) <= 0)) break;
        await sleep(500);
      }
      const ms = Date.now() - t0;
      const states = await Promise.all(zs.map((z) => b.truth.entity(z.entityId)));
      const kills = states.filter((x) => x.valid === false || (x.health ?? 1) <= 0).length;
      const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
      const damage = +hurt.reduce((a, h) => a + h.damage, 0).toFixed(2);
      const dead = b.built.respawn!.deaths > deaths0;
      const flees = (b.metrics.snapshot().counters['pve.flees'] ?? 0) - flees0;
      rows.push({ mode, damage, minHealth, dead, kills, flees });
      const line = `crowd rule ${mode}, run ${Math.floor(i / 2) + 1}: ${(ms / 1000).toFixed(1)} s, damage ${damage} (${hurt.length} hits), lowest health ${minHealth.toFixed(1)}, ${dead ? 'DIED' : 'alive'}, zombies killed ${kills}/3, flights ${flees}`;
      console.log(line);
      measurements.push(line);
      b.pve.setGuard({ on: false });
      b.pve.stop();
      await b.truth.cleanup();
      if (dead) await until(() => (!b.built.respawn!.dead ? true : undefined), 30_000, 'respawned');
      await sleep(1000);
    }
    b.pve.combat.crowdRule = true;
    for (const mode of ['on', 'off']) {
      const r = rows.filter((x) => x.mode === mode);
      const line = `crowd rule ${mode}: damage ${r.map((x) => x.damage).join(', ')} (mean ${(r.reduce((a, x) => a + x.damage, 0) / r.length).toFixed(1)}), deaths ${r.filter((x) => x.dead).length}, kills ${r.reduce((a, x) => a + x.kills, 0)}, flights ${r.reduce((a, x) => a + x.flees, 0)}`;
      console.log(line);
      measurements.push(line);
    }
    // with the rule the bot runs: flights happen
    expect(rows.filter((x) => x.mode === 'on').reduce((a, x) => a + x.flees, 0)).toBeGreaterThanOrEqual(1);
    await b.truth.ok('unequip', [b.name]);
  }, 120_000 * CROWD_RUNS);

  // ---- shield ---------------------------------------------------------------------------------------

  it('shield: a shield given to the bot goes to the offhand; raised in front of a zombie it blocks the hits', async () => {
    const b = bot!;
    await freshSpot(b, 20);
    await b.truth.ok('give', [b.name, 'shield', 1]);
    const t0 = Date.now();
    const st = await until(async () => {
      const s = await stance(b);
      return s.offhand?.typeId === 'minecraft:shield' ? s : undefined;
    }, 10_000, 'shield in the offhand', 250);
    const equipMs = Date.now() - t0;
    expect(b.pve.combat.shield.equipped()).toBe(true);
    expect(b.built.mobility!.world.inventory.slots.some((s) => s?.name === 'shield')).toBe(false);
    // stand, face a zombie: shield up (sneak) vs down, 8 s each
    const loop = b.built.mobility!.loop;
    const out: string[] = [];
    const res: Record<string, { hits: number; damage: number; blocked: number }> = {};
    for (const up of [true, false]) {
      const p = await freshSpot(b, 20);
      const since = await b.truth.now();
      const z = await b.truth.summon('zombie', { x: centre(p).x + 2, y: FEET_Y, z: centre(p).z });
      const rid = await tracked(b, z);
      const before = (await stance(b)).offhand?.damage ?? 0;
      const off = loop.onBeforeStep(() => {
        const e = b.built.mobility!.world.entities.get(rid);
        const me = loop.state.pos;
        if (e) loop.setCommand({ yaw: yawTowards(e.pos.x - me.x, e.pos.z - me.z), pitch: 10, sneak: up, forward: 0, strafe: 0 });
      });
      let sneaking = false;
      const tEnd = Date.now() + 8_000;
      while (Date.now() < tEnd) {
        if (up && !sneaking) sneaking = (await stance(b)).isSneaking;
        await sleep(500);
      }
      off();
      loop.release();
      const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
      const bl = await blocklog(b, since);
      const after = (await stance(b)).offhand?.damage ?? 0;
      res[up ? 'up' : 'down'] = { hits: bl.length, damage: +hurt.reduce((a, h) => a + h.damage, 0).toFixed(2), blocked: after - before };
      out.push(`shield ${up ? 'up (server isSneaking ' + String(sneaking) + ')' : 'down'}: zombie swung ${bl.length} times, damage ${res[up ? 'up' : 'down']!.damage} (${hurt.length} hurt events), shield durability used ${after - before}`);
      await b.truth.cleanup();
    }
    const line = `shield: in the offhand ${equipMs} ms after the give; ${out.join('; ')}`;
    console.log(line);
    measurements.push(line);
    void st;
    expect(res.up!.damage).toBeLessThan(res.down!.damage);
    expect(res.up!.blocked).toBeGreaterThan(0);
  }, 90_000);

  it(`shield: skeleton duels at 10 blocks with and without the shield (${SHIELD_RUNS} runs each)`, async () => {
    const b = bot!;
    // iron armour (as on the Realm; without it a resistant skeleton killed the bot once in 4 arrows of 6)
    await wearIron(b);
    const sum: Record<string, { hurtArrows: number; arrowDamage: number; blocked: number; serverArrows: number; shieldTicks: number; runs: number }> = {
      with: { hurtArrows: 0, arrowDamage: 0, blocked: 0, serverArrows: 0, shieldTicks: 0, runs: 0 },
      without: { hurtArrows: 0, arrowDamage: 0, blocked: 0, serverArrows: 0, shieldTicks: 0, runs: 0 },
    };
    for (let i = 0; i < 2 * SHIELD_RUNS; i++) {
      const mode = i % 2 === 0 ? 'with' : 'without';
      if (mode === 'with' && !b.pve.combat.shield.equipped()) {
        await b.truth.ok('give', [b.name, 'shield', 1]);
        await until(async () => ((await stance(b)).offhand?.typeId === 'minecraft:shield' ? true : undefined), 10_000, 'shield in the offhand', 250);
      } else if (mode === 'without') {
        await pveCmd('replaceitem', 'entity', b.name, 'slot.weapon.offhand', '0', 'air'); // the shield only, the armour stays
        await until(() => (!b.pve.combat.shield.equipped() ? true : undefined), 5_000, 'offhand empty');
      }
      const at = await freshSpot(b, 20);
      const deaths0 = b.built.respawn!.deaths;
      const since = await b.truth.now();
      const angle = i * 1.3;
      const mob = await b.truth.summon('skeleton', { x: centre(at).x + 10 * Math.cos(angle), y: FEET_Y, z: centre(at).z + 10 * Math.sin(angle) });
      if (SKELETON_RESISTANCE >= 0) await b.truth.effect(mob.entityId, 'resistance', 120, SKELETON_RESISTANCE);
      const rid = await tracked(b, mob);
      const r = await b.pve.combat.fight(rid, { timeoutTicks: 1200 });
      await sleep(500);
      const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name && h.cause === 'projectile');
      const bl = (await blocklog(b, since)).filter((x) => x.kind === 'projectile');
      const blocked = bl.length - hurt.length;
      const s = sum[mode]!;
      s.hurtArrows += hurt.length;
      s.arrowDamage += hurt.reduce((a, h) => a + h.damage, 0);
      s.serverArrows += bl.length;
      s.blocked += Math.max(0, blocked);
      s.shieldTicks += r.shieldTicks ?? 0;
      s.runs++;
      const line = `skeleton ${mode} shield, run ${Math.floor(i / 2) + 1}: ${r.reason} in ${r.ticks} ticks, arrows reaching the bot ${bl.length} (sneaking at ${bl.filter((x) => x.sneaking).length}), arrows that hurt ${hurt.length} (${hurt.reduce((a, h) => a + h.damage, 0).toFixed(1)} damage), shield up ${r.shieldTicks ?? 0} ticks`;
      console.log(line);
      measurements.push(line);
      expect(b.built.respawn!.deaths).toBe(deaths0);
      await b.truth.cleanup();
    }
    for (const mode of ['with', 'without']) {
      const s = sum[mode]!;
      const line = `skeletons ${mode} shield over ${s.runs} duels: arrows reaching ${s.serverArrows}, arrows that hurt ${s.hurtArrows} (${s.arrowDamage.toFixed(1)} damage), blocked ${s.blocked}, shield up ${s.shieldTicks} ticks`;
      console.log(line);
      measurements.push(line);
    }
    expect(sum.with!.shieldTicks).toBeGreaterThan(0);
    expect(sum.without!.shieldTicks).toBe(0);
  }, 90_000 * SHIELD_RUNS);

  it(`shield: creeper duels with the shield (${SHIELD_CREEPER_RUNS} runs): no explosion damage`, async () => {
    const b = bot!;
    if (!b.pve.combat.shield.equipped()) {
      await b.truth.ok('give', [b.name, 'shield', 1]);
      await until(async () => ((await stance(b)).offhand?.typeId === 'minecraft:shield' ? true : undefined), 10_000, 'shield in the offhand', 250);
    }
    for (let i = 0; i < SHIELD_CREEPER_RUNS; i++) {
      const at = await freshSpot(b, 20);
      const deaths0 = b.built.respawn!.deaths;
      const since = await b.truth.now();
      const mob = await b.truth.summon('creeper', { x: centre(at).x + 6, y: FEET_Y, z: centre(at).z + 1 });
      const rid = await tracked(b, mob);
      const r = await b.pve.combat.fight(rid, { timeoutTicks: 1200 });
      await sleep(2000);
      const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
      const explosion = hurt.filter((h) => h.cause === 'entityExplosion' || h.cause === 'blockExplosion').reduce((a, h) => a + h.damage, 0);
      const line = `creeper with shield, run ${i + 1}: ${r.reason} in ${r.ticks} ticks, ${r.attacks} attacks, shield up ${r.shieldTicks ?? 0} ticks, explosion damage ${explosion.toFixed(1)}, all damage ${hurt.reduce((a, h) => a + h.damage, 0).toFixed(1)}`;
      console.log(line);
      measurements.push(line);
      expect(b.built.respawn!.deaths).toBe(deaths0);
      expect(explosion).toBe(0);
      // the ground may be cratered: restore it
      await b.truth.cmd('fill', [at.x - 6, FEET_Y - 4, at.z - 6, at.x + 12, FEET_Y - 2, at.z + 8, 'dirt'], 30_000);
      await b.truth.cmd('fill', [at.x - 6, FEET_Y - 1, at.z - 6, at.x + 12, FEET_Y - 1, at.z + 8, 'grass_block'], 30_000);
      await b.truth.cmd('fill', [at.x - 6, FEET_Y, at.z - 6, at.x + 12, FEET_Y + 4, at.z + 8, 'air'], 30_000);
      await b.truth.cleanup();
    }
    await b.truth.ok('unequip', [b.name]);
  }, 90_000 * SHIELD_CREEPER_RUNS);
});
