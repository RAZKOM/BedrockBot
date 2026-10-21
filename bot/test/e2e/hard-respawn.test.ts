// PLAN.md task 5.1 on bds-hard: `truth:kill`; the afk task (with --home) sees the death and its cause,
// presses respawn, the server respawns it (world spawn, spawnRadius 10), and it walks back home.
// Deaths are counted in the metrics. Needs BDS_E2E=1 and bds-hard with the truth pack
// (`node scripts/bds.mjs --profile hard up` and `... pack`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RespawnEvent } from '../../src/tasks/respawn.ts';
import { centre, E2E, FEET_Y, fmt, hdist, prepareServer, sleep, startAfkBot, teleport, until, type HardBot } from './hard-truth.ts';

const HOME = { x: 14, y: FEET_Y, z: -9 };

describe.skipIf(!E2E)('hard: death and respawn (task 5.1)', () => {
  let bot: HardBot | undefined;
  const events: RespawnEvent[] = [];

  beforeAll(async () => {
    await prepareServer();
    bot = await startAfkBot('Hard51', { home: HOME });
    bot.built.respawn?.onEvent((e) => {
      if (e.kind !== 'health') events.push(e);
    });
    await teleport(bot, centre(HOME));
  }, 90_000);

  afterAll(async () => {
    await bot?.stop();
  });

  it('truth:kill -> death with cause, respawn, back home within 60 s; deaths counted', async () => {
    const b = bot!;
    for (let n = 1; n <= 2; n++) {
      const t0 = Date.now();
      const killed = await b.truth.ok<{ killed: boolean }>('kill', [b.name]);
      expect(killed.killed).toBe(true);
      const death = await until(() => events.find((e) => e.kind === 'death' && e.death.n === n), 5_000, `death ${n}`);
      expect(death.kind === 'death' && death.death.cause).toBe('death.attack.generic');
      const respawned = await until(() => events.find((e) => e.kind === 'respawn' && e.death?.n === n), 15_000, `respawn ${n}`);
      const respawnAt = respawned.kind === 'respawn' ? respawned.feet : undefined;
      const respawnMs = Date.now() - t0;
      // The server really respawned the bot there (truth), unless the spawn point happens to be home.
      const away = respawnAt !== undefined && hdist(respawnAt, centre(HOME)) > 2;
      if (away) {
        await until(async () => {
          const p = await b.truth.pos(b.name);
          return hdist(p.location, centre(HOME)) > 1.5 ? p : undefined;
        }, 10_000, `truth position away from home after respawn ${n}`, 100);
      }
      // home again (truth position) through the after-respawn hook's goto
      await until(async () => {
        const p = await b.truth.pos(b.name);
        return hdist(p.location, centre(HOME)) < 0.8 && Math.abs(p.location.y - FEET_Y) < 0.01 ? p : undefined;
      }, 60_000, `back home after death ${n}`, 500);
      const homeMs = Date.now() - t0;
      const truth = await b.truth.pos(b.name);
      console.log(
        `death ${n}: respawned at ${respawnAt ? fmt(respawnAt) : '?'} after ${respawnMs} ms (${respawnAt ? hdist(respawnAt, centre(HOME)).toFixed(1) : '?'} blocks from home), ` +
          `home after ${homeMs} ms, truth ${fmt(truth.location)}`,
      );
      expect(homeMs).toBeLessThan(60_000);
      const walked = b.built.mobility?.skills.nav.lastReport;
      expect(walked?.result).toEqual({ ok: true });
      if (away) expect(walked!.distance).toBeGreaterThan(hdist(respawnAt, centre(HOME)) - 1.5);
      await sleep(500);
    }
    const snap = b.metrics.snapshot();
    expect(snap.counters.deaths).toBe(2);
    expect(snap.counters['deaths.death.attack.generic']).toBe(2);
    expect(snap.counters['home.returns']).toBe(2);
    expect(b.built.respawn?.status()).toMatchObject({ deaths: 2, dead: false, lastDeath: { cause: 'death.attack.generic' } });
    expect(b.conn.state).toBe('spawned');
    console.log(`metrics: deaths ${snap.counters.deaths}, corrections ${snap.counters.corrections ?? 0}, rates ${JSON.stringify(snap.rates)}`);
  }, 180_000);
});
