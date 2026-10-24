// Track V (wave 7, docs/pve.md "Creepers") on bds-pve (difficulty normal): the real creeper fuse
// distance and explosion damage measured with the truth pack (truth:combatlog creeper triggers and
// explosions, truth:hurtlog damage), then 5 creeper duels at full health without armour that the bot
// must survive (damage and explosions reported per run; zero explosions is the target), and the
// low-health rule (below 10 the bot does not engage: `creeper_avoided`, 11 blocks away by its own model, 8 or more by the server).
// Needs BDS_E2E=1 and bds-pve with the truth pack (`node scripts/bds.mjs --profile pve up` / `pack`).
// Env: PVE_BDS_HOST / PVE_BDS_PORT / PVE_BDS_CONTAINER (default 127.0.0.1, 19144, bds-pve),
// PVE_VERBOSE=1, PVE_CREEPER_RUNS (5).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { armWithIronSword, botDamage, centre, E2E, FEET_Y, fill, fmt, hdist, prepareServer, privateArea, sleep, startPveBot, teleport, tracked, until, type PveBot } from './pve-truth.ts';

interface CombatRecord {
  tick: number;
  kind: 'hit' | 'trigger' | 'explosion' | 'projectile';
  player: string | null;
  entityId: string | null;
  typeId: string | null;
  item: string | null;
  eventId: string | null;
  distance: number | null;
  location: { x: number; y: number; z: number } | null;
  players: { name: string; distance: number }[] | null;
}

const RUNS = Number(process.env.PVE_CREEPER_RUNS ?? 5);

async function combatlog(b: PveBot, since: number): Promise<CombatRecord[]> {
  return (await b.truth.ok<{ events: CombatRecord[] }>('combatlog', [since], 20_000)).events;
}

describe.skipIf(!E2E)('pve: creeper protocol (Track V)', () => {
  let bot: PveBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];
  /** Every spot a creeper may have blown up (restored at the end). */
  const spots: Vec3[] = [];
  /** A fresh, flat spot per creeper (explosions leave craters the next run must not start in). */
  const spot = (i: number): Vec3 => {
    const p = { x: HOME.x + 24 * (i % 6) - 60, y: FEET_Y, z: HOME.z + 24 * Math.floor(i / 6) - 24 };
    spots.push(p);
    return p;
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startPveBot('PveCreep');
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 48);
    await armWithIronSword(bot);
    await bot.truth.ok('unequip', [bot.name]);
    await bot.truth.setHealth(bot.name, 20);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 96).catch(() => undefined);
      // the flat world again where creepers exploded: dirt, grass, air
      for (const p of spots) {
        await fill(bot, { x: p.x - 9, y: FEET_Y - 3, z: p.z - 9 }, { x: p.x + 9, y: FEET_Y - 2, z: p.z + 9 }, 'dirt').catch(() => undefined);
        await fill(bot, { x: p.x - 9, y: FEET_Y - 1, z: p.z - 9 }, { x: p.x + 9, y: FEET_Y - 1, z: p.z + 9 }, 'grass_block').catch(() => undefined);
        await fill(bot, { x: p.x - 9, y: FEET_Y, z: p.z - 9 }, { x: p.x + 9, y: FEET_Y + 4, z: p.z + 9 }, 'air').catch(() => undefined);
      }
      await bot.stop();
    }
    console.log(`measurements:\n  ${measurements.join('\n  ')}`);
  });

  /** Back to full health at a fresh spot, nothing around. */
  async function reset(b: PveBot, at: Vec3): Promise<void> {
    await b.truth.cleanup();
    await b.truth.clearAround(centre(at), 32);
    await until(() => (b.built.respawn!.dead ? undefined : true), 30_000, 'alive');
    await teleport(b, centre(at));
    await b.truth.setHealth(b.name, 20);
    await until(() => (b.pve.health() >= 20 ? true : undefined), 5_000, 'health 20 in the model');
  }

  it('measures the fuse distance and the explosion damage at 4 and 5.5 blocks (bot standing still)', async () => {
    const b = bot!;
    let k = 0;
    for (const at of [4, 5.5]) {
      const p0 = spot(k++);
      await reset(b, p0);
      b.pve.stop();
      const since = await b.truth.now();
      const creeper = await b.truth.summon('creeper', { x: p0.x + 0.5 + 6, y: FEET_Y, z: p0.z + 0.5 });
      // the creeper walks up to the standing bot and lights its fuse
      const trig = await until(async () => (await combatlog(b, since)).find((r) => r.kind === 'trigger' && r.entityId === creeper.entityId && (r.eventId ?? '').includes('start')), 20_000, 'creeper fuse lit', 100);
      const loc = (await b.truth.entity(creeper.entityId)).location;
      // step back to `at` blocks from it (same side it came from) and let it explode
      await b.truth.effect(creeper.entityId, 'slowness', 10, 255);
      await b.truth.tp(b.name, { x: loc.x - at, y: FEET_Y, z: loc.z }, -90, 0);
      const ex = await until(async () => (await combatlog(b, since)).find((r) => r.kind === 'explosion' && r.entityId === creeper.entityId), 10_000, 'explosion', 100);
      await sleep(500);
      const dmg = botDamage((await b.truth.hurtlog(since)).events, b.name);
      const all = (await combatlog(b, since)).filter((r) => r.entityId === creeper.entityId && r.kind === 'trigger');
      const line =
        `fuse: lit at ${trig.distance?.toFixed(2)} blocks (${trig.eventId}), triggers ${all.map((r) => `${r.eventId}@${r.distance?.toFixed(2)}`).join(', ')}; ` +
        `explosion ${ex.tick - trig.tick} ticks after the trigger, bot put ${at} blocks from it${ex.players?.length ? ` (${ex.players.find((p) => p.name === b.name)?.distance.toFixed(2)} at the blast)` : ''}: took ${dmg.total} (${JSON.stringify(dmg.byCause)}), normal difficulty`;
      console.log(line);
      measurements.push(line);
      expect(trig.distance).toBeLessThan(6);
    }
  }, 120_000);

  it(`creeper duels at full health without armour: ${RUNS} of ${RUNS} survived`, async () => {
    const b = bot!;
    let explosions = 0;
    for (let i = 0; i < RUNS; i++) {
      const p0 = spot(2 + i);
      await reset(b, p0);
      const since = await b.truth.now();
      const deaths0 = b.built.respawn!.deaths;
      const angle = (i * 2 * Math.PI) / RUNS + 0.4;
      const creeper = await b.truth.summon('creeper', { x: p0.x + 0.5 + 6 * Math.cos(angle), y: FEET_Y, z: p0.z + 0.5 + 6 * Math.sin(angle) });
      const rid = await tracked(b, creeper);
      const r = await b.pve.combat.fight(rid, { timeoutTicks: 1200 });
      await sleep(800);
      const log = await combatlog(b, since);
      const ex = log.filter((x) => x.kind === 'explosion' && x.entityId === creeper.entityId);
      const lit = log.filter((x) => x.kind === 'trigger' && x.entityId === creeper.entityId && (x.eventId ?? '').includes('start'));
      const out = log.filter((x) => x.kind === 'trigger' && x.entityId === creeper.entityId && (x.eventId ?? '').includes('stop'));
      const hits = log.filter((x) => x.kind === 'hit' && x.player === b.name && x.entityId === creeper.entityId);
      const dmg = botDamage((await b.truth.hurtlog(since)).events, b.name);
      explosions += ex.length;
      const line =
        `duel ${i + 1}: ${r.reason} in ${r.ticks} ticks, ${r.attacks} attacks, ${hits.length} server hits (min distance ${hits.length ? Math.min(...hits.map((h) => h.distance ?? 99)).toFixed(2) : '-'}), ` +
        `fuse lit ${lit.length}x${lit.length ? ` at ${lit.map((x) => x.distance?.toFixed(2)).join('/')}` : ''}, out ${out.length}x${out.length ? ` at ${out.map((x) => x.distance?.toFixed(2)).join('/')}` : ''}, explosions ${ex.length}, bot took ${dmg.total} (${JSON.stringify(dmg.byCause)})`;
      console.log(line);
      measurements.push(line);
      expect(b.built.respawn!.deaths).toBe(deaths0);
      expect(b.built.respawn!.dead).toBe(false);
      expect(['killed', 'exploded', 'gone']).toContain(r.reason);
    }
    measurements.push(`duels: ${explosions} explosion(s) in ${RUNS} runs`);
  }, 120_000 * RUNS);

  it('below health 10 a creeper is not engaged: creeper_avoided, 8 or more blocks away, wantsFlee', async () => {
    const b = bot!;
    const p0 = spot(2 + RUNS);
    await reset(b, p0);
    const since = await b.truth.now();
    const creeper = await b.truth.summon('creeper', { x: p0.x + 0.5 + 5, y: FEET_Y, z: p0.z + 0.5 });
    const rid = await tracked(b, creeper);
    await b.truth.setHealth(b.name, 8);
    await until(() => (b.pve.health() <= 8 ? true : undefined), 5_000, 'health 8 in the model');
    const e = b.built.mobility!.world.entities.get(rid)!;
    expect(b.pve.wantsFlee(e)).toBe(true);
    const r = await b.pve.combat.fight(rid);
    const p = await b.truth.pos(b.name);
    const ce = await b.truth.entity(creeper.entityId);
    const c = ce.location ?? b.built.mobility!.world.entities.get(rid)?.pos ?? centre(p0);
    const log = await combatlog(b, since);
    const line = `low health: ${r.reason} after ${r.ticks} ticks, ${r.attacks} attacks, bot ${fmt(p.location)} ${hdist(p.location, c).toFixed(2)} blocks from the creeper (${ce.valid === false ? 'gone' : 'alive'}), took ${botDamage((await b.truth.hurtlog(since)).events, b.name).total}, explosions ${log.filter((x) => x.kind === 'explosion').length}`;
    console.log(line);
    measurements.push(line);
    expect(r.reason).toBe('creeper_avoided');
    expect(r.attacks).toBe(0);
    expect(hdist(p.location, c)).toBeGreaterThanOrEqual(8);
    await b.truth.setHealth(b.name, 20);
  }, 90_000);
});
