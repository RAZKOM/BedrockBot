// PLAN.md task 7.4 "a full night at home survived with guard on", on bds-pve: difficulty normal,
// natural mob spawning ON, daylight cycle on from time 13000 (night), the bot stands at home with
// an iron sword and guard mode (radius 16) for 6000 ticks (5 minutes). Pass: 0 deaths. Prints kills,
// damage taken by cause and attacker type (truth:hurtlog), and the bot's behaviours over time.
// Needs BDS_E2E=1 and bds-pve with the truth pack. Takes about 6 minutes; skip it with
// BDS_PVE_NIGHT=0.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armWithIronSword, botDamage, botHits, centre, E2E, FEET_Y, hdist, prepareServer, privateArea, pveCmd, sleep, startPveBot, teleport, type PveBot } from './pve-truth.ts';

const NIGHT = process.env.BDS_PVE_NIGHT !== '0';
const TICKS = Number(process.env.BDS_PVE_NIGHT_TICKS ?? 6000);
/** Time of day at the start (default 16000, deep night; 13000 = night falls). */
const START_TIME = Number(process.env.BDS_PVE_NIGHT_START ?? 16000);

describe.skipIf(!E2E || !NIGHT)('pve: a night at home with guard on (task 7.4)', () => {
  let bot: PveBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    bot = await startPveBot('PveNight', { home: HOME });
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 64);
    await armWithIronSword(bot);
    await bot.truth.setHealth(bot.name, 20);
    bot.pve.setGuard({ on: true, radius: 16 });
  }, 120_000);

  afterAll(async () => {
    await pveCmd('gamerule', 'domobspawning', 'false').catch(() => undefined);
    await pveCmd('gamerule', 'dodaylightcycle', 'false').catch(() => undefined);
    await pveCmd('time', 'set', 'midnight').catch(() => undefined);
    if (bot) {
      await bot.truth.clearAround(centre(HOME), 96).catch(() => undefined);
      await bot.stop();
    }
  });

  it(`survives ${TICKS} ticks of night on normal difficulty with natural spawning (0 deaths)`, async () => {
    const b = bot!;
    const loop = b.built.mobility!.loop;
    const since = await b.truth.now();
    await pveCmd('gamerule', 'domobspawning', 'true');
    await pveCmd('gamerule', 'dodaylightcycle', 'true');
    await pveCmd('time', 'set', String(START_TIME));
    const deaths0 = b.built.respawn!.deaths;
    const t0 = loop.state.tick;
    const timeline: string[] = [];
    const behaviours = new Map<string, number>();
    let minHealth = 20;
    let last = Date.now();
    while (loop.state.tick - t0 < BigInt(TICKS)) {
      await sleep(1000);
      const beh = b.pve.behaviour().replace(/ \(.*\)$/, '');
      behaviours.set(beh, (behaviours.get(beh) ?? 0) + 1);
      minHealth = Math.min(minHealth, b.pve.health());
      if (Date.now() - last >= 30_000) {
        last = Date.now();
        const p = b.task.position();
        const s = b.pve.stats;
        const line = `t+${loop.state.tick - t0}: health ${b.pve.health()}, ${b.pve.behaviour()}, kills ${s.kills}, fights ${s.fights}, flees ${s.flees}, deaths ${b.built.respawn!.deaths - deaths0}, ${p ? `${hdist(p, centre(HOME)).toFixed(1)} blocks from home` : '?'}`;
        timeline.push(line);
        console.log(line);
      }
    }
    await pveCmd('gamerule', 'domobspawning', 'false');
    const log = await b.truth.hurtlog(since);
    const dmg = botDamage(log.events, b.name);
    const hits = botHits(log.events, b.name);
    const s = b.pve.stats;
    const killedTypes: Record<string, number> = {};
    for (const h of log.events) if (h.damagerName === b.name && h.healthAfter !== null && h.healthAfter <= 0) killedTypes[h.victimType.replace('minecraft:', '')] = (killedTypes[h.victimType.replace('minecraft:', '')] ?? 0) + 1;
    const deaths = b.built.respawn!.deaths - deaths0;
    console.log(
      `night: ${TICKS} ticks, deaths ${deaths}, min health ${minHealth}, kills ${s.kills} (${JSON.stringify(killedTypes)}), fights ${s.fights}, flees ${s.flees}, ` +
        `attack packets ${b.pve.combat.totals.attacks}, server-side hits ${hits.length}, damage taken ${dmg.total} by cause ${JSON.stringify(dmg.byCause)} by attacker ${JSON.stringify(dmg.byDamager)}, ` +
        `behaviour seconds ${JSON.stringify(Object.fromEntries(behaviours))}`,
    );
    expect(deaths).toBe(0);
  }, (TICKS / 20) * 1000 + 120_000);
});
