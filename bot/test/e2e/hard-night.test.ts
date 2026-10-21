// PLAN.md task 5.2 on bds-hard: the afk task with --shelter/--home tracks the world time
// (sync_world_clocks), walks into the shelter after `truth:time night` (within 60 s, checked with
// truth:pos), leaves at sunrise back home, and with an unreachable (sealed) shelter logs, stays put and
// does not retry before its retry delay. HARD_EASY=1 adds a run on difficulty easy with zombies
// summoned around the bot. Needs BDS_E2E=1 and bds-hard with the truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NightEvent } from '../../src/tasks/night.ts';
import { buildHut, centre, clearArea, E2E, FEET_Y, fmt, hardCmd, hdist, prepareServer, sleep, startAfkBot, teleport, until, type HardBot } from './hard-truth.ts';

// Away from the respawn test's area (14, -9) and from the world spawn.
const HOME = { x: -20, y: FEET_Y, z: 20 };
const SHELTER = { x: -30, y: FEET_Y, z: 28 };
const SEALED = { x: -12, y: FEET_Y, z: 30 };
const EASY = process.env.HARD_EASY === '1';

function nightState(bot: HardBot): string {
  return String((bot.task.status().night as { state: string } | null)?.state);
}

describe.skipIf(!E2E)('hard: night safety (task 5.2)', () => {
  let bot: HardBot | undefined;
  const events: NightEvent[] = [];

  beforeAll(async () => {
    await prepareServer();
    bot = await startAfkBot('Hard52', { home: HOME, shelter: SHELTER });
    await teleport(bot, centre(HOME));
    await clearArea(bot, { x: -34, y: FEET_Y, z: 16 }, { x: -8, y: FEET_Y + 3, z: 34 });
    await buildHut(bot, SHELTER);
    await buildHut(bot, SEALED, true);
    // the shelter's world-model state must be current before the night starts
    await bot.built.mobility!.loop.waitTicks(10);
    const night = (bot.task as unknown as { status(): Record<string, unknown> }).status();
    expect(night).toMatchObject({ night: { state: 'day' } });
  }, 120_000);

  afterAll(async () => {
    await hardCmd('time', 'set', 'noon').catch(() => undefined);
    await hardCmd('difficulty', 'peaceful').catch(() => undefined);
    await bot?.stop();
  });

  it('truth:time night -> inside the shelter within 60 s; sunrise -> back home', async () => {
    const b = bot!;
    const n = b.task.shelter!;
    expect(n.get()).toEqual(SHELTER);
    const time = await b.truth.ok<{ timeOfDay: number }>('time', ['night']);
    expect(time.timeOfDay).toBe(13000);
    const t0 = Date.now();
    const clock = b.built.clock!;
    await until(() => (clock.timeOfDay !== undefined && clock.timeOfDay >= 13000 && clock.timeOfDay < 13100 ? true : undefined), 5_000, 'clock sync to 13000', 50);
    const inside = await until(async () => {
      const p = await b.truth.pos(b.name);
      return hdist(p.location, centre(SHELTER)) <= 1.0 && Math.abs(p.location.y - FEET_Y) < 0.01 ? p : undefined;
    }, 60_000, 'bot inside the shelter (truth)', 500);
    const ms = Date.now() - t0;
    console.log(`night: inside the shelter after ${ms} ms at ${fmt(inside.location)} (${hdist(centre(HOME), centre(SHELTER)).toFixed(1)} blocks from home), state ${nightState(b)}`);
    expect(ms).toBeLessThan(60_000);
    await until(() => (nightState(b) === 'sheltered' ? true : undefined), 5_000, 'state sheltered');
    // stays inside while the night lasts
    await sleep(3000);
    const still = await b.truth.pos(b.name);
    expect(hdist(still.location, centre(SHELTER))).toBeLessThanOrEqual(1.0);

    await b.truth.ok('time', ['sunrise']);
    const t1 = Date.now();
    await until(async () => {
      const p = await b.truth.pos(b.name);
      return hdist(p.location, centre(HOME)) < 0.8 ? p : undefined;
    }, 60_000, 'back home at dawn', 500);
    console.log(`dawn: back home after ${Date.now() - t1} ms`);
    expect(b.metrics.snapshot().counters['night.retreats']).toBe(1);
    await b.truth.ok('time', ['noon']);
  }, 150_000);

  it('unreachable (sealed) shelter: logs, stays put, no retry loop', async () => {
    const b = bot!;
    const n = b.task.shelter!;
    n.set(SEALED);
    const before = await b.truth.pos(b.name);
    // the dawn walk home of the previous test may still be finishing
    await until(() => (nightState(b) === 'day' ? true : undefined), 30_000, 'state day');
    expect(b.task.status()).toMatchObject({ night: { state: 'day', attempts: 0 } });
    const unreachable: NightEvent[] = [];
    const t0 = Date.now();
    await b.truth.ok('time', ['night']);
    const first = await until(
      () => {
        const st = b.task.status().night as { state: string; lastResult: unknown; attempts: number };
        return st.state === 'unreachable' || st.state === 'gave_up' ? st : undefined;
      },
      90_000,
      'unreachable',
      250,
    );
    const failMs = Date.now() - t0;
    unreachable.push(...events);
    const at = await b.truth.pos(b.name);
    // watch 20 s: no second attempt before the 60 s retry delay, the bot stays where it gave up
    const lastGoto = b.built.mobility!.skills.nav.lastReport;
    await sleep(20_000);
    const st = b.task.status().night as { state: string; attempts: number };
    const after = await b.truth.pos(b.name);
    console.log(
      `unreachable: first failure after ${failMs} ms (${JSON.stringify(first.lastResult)}), attempts ${st.attempts}, state ${st.state}; ` +
        `moved ${hdist(before.location, at.location).toFixed(1)} blocks while trying, ${hdist(at.location, after.location).toFixed(2)} in the 20 s after; ` +
        `last goto ${lastGoto?.ticks} ticks, ${lastGoto?.plans.length} plans, ${lastGoto?.failures} failures`,
    );
    expect(st.attempts).toBe(1);
    expect(hdist(at.location, after.location)).toBeLessThan(0.5);
    expect(b.metrics.snapshot().counters['night.unreachable']).toBe(1);
    await b.truth.ok('time', ['noon']);
    n.set(SHELTER);
    await sleep(1500);
  }, 150_000);

  it.skipIf(!EASY)('easy with zombies around: inside the shelter within 60 s (HARD_EASY=1)', async () => {
    const b = bot!;
    await teleport(b, centre(HOME));
    await hardCmd('difficulty', 'easy');
    const around: [number, number][] = [
      [6, 0],
      [-6, 3],
      [0, -7],
    ];
    for (const [dx, dz] of around) {
      await hardCmd('summon', 'zombie', String(HOME.x + dx), String(FEET_Y), String(HOME.z + dz));
    }
    const deathsBefore = b.built.respawn?.deaths ?? 0;
    const healthLog: number[] = [];
    const off = b.built.respawn!.onEvent((e) => {
      if (e.kind === 'health') healthLog.push(e.health);
    });
    await b.truth.ok('time', ['night']);
    const t0 = Date.now();
    const inside = await until(async () => {
      const p = await b.truth.pos(b.name);
      return hdist(p.location, centre(SHELTER)) <= 1.0 ? p : undefined;
    }, 60_000, 'inside the shelter on easy', 500);
    const ms = Date.now() - t0;
    await sleep(10_000);
    const later = await b.truth.pos(b.name);
    off();
    console.log(
      `easy: inside after ${ms} ms at ${fmt(inside.location)}; 10 s later ${fmt(later.location)} (${hdist(later.location, centre(SHELTER)).toFixed(2)} from the centre); ` +
        `deaths ${(b.built.respawn?.deaths ?? 0) - deathsBefore}, health ${healthLog.join(' ') || 'unchanged'}, motions ${b.built.mobility?.loop.state.motions}`,
    );
    expect(ms).toBeLessThan(60_000);
    await hardCmd('kill', '@e[type=zombie]');
    await hardCmd('difficulty', 'peaceful');
  }, 120_000);
});
