// The gauntlet on bds-gaunt (wave 7, Track W; docs/pve.md "Flee", "Trip readiness"): a second client
// (the "player", an owner) stands 80 blocks away; the bot wears iron armour, holds an iron sword and
// has 8 bread, guard on (radius 16), at midnight on normal difficulty. 6 zombies and 2 skeletons are
// summoned along the route as the bot passes marks (truth summon). `!come` must arrive alive in 5 of 5
// runs (each on a fresh lane); per run: time, damage taken (truth hurt log), fights, flees, lowest
// health. Needs BDS_E2E=1 and bds-gaunt with the truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { botDamage, centre, connectPlayer, E2E, FEET_Y, hdist, prepareServer, privateArea, saidSince, sleep, startGauntBot, teleport, uniqueName, until, type GauntBot } from './gaunt-truth.ts';

const RUNS = Number(process.env.GAUNT_RUNS ?? 5);
/** Marks (blocks from the start along +x) and what is summoned there, ahead of the bot (dx from the mark, dz off the line). */
const WAVES: { mark: number; mobs: { type: string; dx: number; dz: number }[] }[] = [
  { mark: 5, mobs: [{ type: 'zombie', dx: 14, dz: 3 }, { type: 'zombie', dx: 15, dz: -3 }] },
  { mark: 20, mobs: [{ type: 'skeleton', dx: 14, dz: 6 }] },
  { mark: 30, mobs: [{ type: 'zombie', dx: 12, dz: 3 }, { type: 'zombie', dx: 13, dz: -2 }] },
  { mark: 45, mobs: [{ type: 'skeleton', dx: 12, dz: -6 }, { type: 'zombie', dx: 12, dz: 2 }] },
  { mark: 55, mobs: [{ type: 'zombie', dx: 10, dz: 2 }] },
];

describe.skipIf(!E2E)('gaunt: !come through a gauntlet (Track W)', () => {
  let bot: GauntBot | undefined;
  let player: Awaited<ReturnType<typeof connectPlayer>> | undefined;
  const playerName = uniqueName('GtOwner');
  const area = privateArea();
  const lines: string[] = [];
  const results: { alive: boolean; ms: number }[] = [];
  const rawLocs: string[] = [];

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startGauntBot('GtCome', {}, { owners: [playerName], values: { guard: '16' } });
    await teleport(bot, centre({ x: area.x - 40, y: FEET_Y, z: area.z }));
    await bot.truth.clearAround(centre({ x: area.x, y: FEET_Y, z: area.z }), 120);
    player = await connectPlayer(playerName);
    bot.conn.on('player_location', (q) => rawLocs.push(JSON.stringify(q, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)))); // the raw locator packets, for the log
  }, 120_000);

  afterAll(async () => {
    await player?.close().catch(() => undefined);
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre({ x: area.x, y: FEET_Y, z: area.z }), 120).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${lines.join('\n  ')}`);
  });

  async function kit(b: GauntBot): Promise<void> {
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('unequip', [b.name]);
    await b.truth.give(b.name, 'iron_sword', 1);
    for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await b.truth.give(b.name, piece, 1);
    await b.truth.give(b.name, 'bread', 8);
    const inv = b.built.mobility!.world.inventory;
    await until(() => (inv.window(120)?.slots.filter(Boolean).length === 4 && inv.slots.some((s) => s?.name === 'bread') ? true : undefined), 20_000, 'armour worn, bread in the inventory');
    await b.truth.setHealth(b.name, 20);
    await b.truth.setFood(b.name, 20, 5);
  }

  for (let run = 0; run < RUNS; run++) {
    it(`run ${run + 1}/${RUNS}: !come 80 blocks through 6 zombies and 2 skeletons arrives alive`, async () => {
      const b = bot!;
      const lane = area.z - 48 + run * 24;
      const start: Vec3 = { x: area.x - 40, y: FEET_Y, z: lane };
      const goal: Vec3 = { x: area.x + 40, y: FEET_Y, z: lane };
      await b.truth.clearAround(centre({ x: area.x, y: FEET_Y, z: lane }), 60);
      await teleport(b, centre(start));
      await kit(b);
      // next to the bot first, then away: leaving the entity range is what makes BDS send a locator
      // update after a teleport (a teleport between two far places sometimes sends none; a walking
      // player is reported as it moves)
      // 80 blocks is beyond the entity range: the position comes from the locator bar. After a teleport
      // BDS does not always send it (in about 1 of 5 runs nothing came, so the bot walked to the previous
      // lane's goal): the test repeats the near -> far teleport up to 3 times until the bar reports the
      // player (a real player walking is reported as it moves; this is the harness, not the bot)
      let tries = 0;
      let known: Vec3 | undefined;
      for (; tries < 3; tries++) {
        if (tries === 2) {
          // still nothing: a fresh join is always reported (player_list add, then player_location)
          await player!.close().catch(() => undefined);
          await sleep(1000);
          player = await connectPlayer(playerName);
        }
        await b.truth.tp(player!.name, centre({ x: start.x + 6, y: FEET_Y, z: lane }), 0, 0);
        await sleep(2000);
        await b.truth.tp(player!.name, centre(goal), 0, 0);
        await sleep(3000);
        known = b.pve.playerFeet(player!.name);
        if (known && hdist(known, centre(goal)) < 4) break;
      }
      const p = player!;
      const knownOff = known ? hdist(known, centre(goal)) : undefined;
      if (tries > 0) console.log(`run ${run + 1}: the locator bar needed ${tries + 1} teleports (raw ${JSON.stringify(rawLocs.slice(-2))})`);
      const deaths0 = b.task.status().respawn as { deaths: number };
      const stats0 = { ...b.pve.stats };
      const since = await b.truth.now();
      let minHealth = b.pve.health();
      const sampler = setInterval(() => {
        minHealth = Math.min(minHealth, b.pve.health());
      }, 100);
      const n0 = b.said.length;
      const t0 = Date.now();
      p.say('!come');
      let next = 0;
      let arrived: number | undefined;
      let dead = false;
      const summoned: string[] = [];
      try {
        while (Date.now() - t0 < 240_000) {
          const me = (await b.truth.pos(b.name)).location;
          if (!b.task.alive?.() || b.pve.health() <= 0) {
            dead = true;
            break;
          }
          while (next < WAVES.length && me.x - start.x >= WAVES[next]!.mark) {
            const w = WAVES[next]!;
            for (const m of w.mobs) {
              const mobInfo = await b.truth.summon(m.type, { x: start.x + w.mark + m.dx + 0.5, y: FEET_Y, z: lane + m.dz + 0.5 });
              summoned.push(`${m.type}@${w.mark}`);
              void mobInfo;
            }
            next++;
          }
          const them = (await b.truth.pos(p.name)).location;
          if (hdist(me, them) <= 2.5 && next >= WAVES.length) {
            arrived = Date.now() - t0;
            break;
          }
          await sleep(300);
        }
      } finally {
        clearInterval(sampler);
      }
      const hurt = botDamage((await b.truth.hurtlog(since)).events, b.name);
      const deaths1 = b.task.status().respawn as { deaths: number };
      const st = b.pve.stats;
      const replies = b.said.slice(n0);
      const alive = !dead && deaths1.deaths === deaths0.deaths && arrived !== undefined;
      results.push({ alive, ms: arrived ?? 240_000 });
      const line =
        `run ${run + 1}: ${alive ? `arrived alive after ${((arrived ?? 0) / 1000).toFixed(1)} s` : dead || deaths1.deaths > deaths0.deaths ? 'DIED' : 'not there in 240 s'}; ` +
        `player position known ${knownOff === undefined ? 'no' : `${knownOff.toFixed(0)} blocks off`}; summoned ${summoned.length} (${summoned.join(' ')}); fights ${st.fights - stats0.fights}, kills ${st.kills - stats0.kills}, flees ${st.flees - stats0.flees}; ` +
        `damage ${hurt.total} ${JSON.stringify(hurt.byDamager)}; lowest health ${minHealth.toFixed(1)}, end ${b.pve.health()}; replies ${replies.join(' | ')}`;
      console.log(line);
      lines.push(line);
      // clean the lane for the next run (mobs and drops)
      await b.truth.cleanup();
      await b.truth.clearAround(centre({ x: area.x, y: FEET_Y, z: lane }), 60);
      expect(saidSince(b, n0, 'coming to')).toBeDefined();
      expect(alive).toBe(true);
    }, 300_000);
  }

  it('summary', () => {
    const ok = results.filter((r) => r.alive).length;
    const line = `gauntlet: ${ok}/${results.length} arrived alive; times ${results.map((r) => (r.ms / 1000).toFixed(1)).join(', ')} s`;
    console.log(line);
    lines.push(line);
    expect(ok).toBe(results.length);
  });
});
