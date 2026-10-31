// Sleeping on bds-gaunt (wave 7, Track W; docs/survival.md "Sleep"): a bed 4 blocks from home (which
// is also the shelter), the time set to night with the daylight cycle on. (1) The night process prefers
// the bed: a boxed zombie 5 blocks from the bed makes the server refuse (`tile.bed.notSafe`); the bot
// waits next to the bed and tries again 20 s later; with the zombie gone it sleeps (truth: isSleeping),
// the server skips the night (the bot is the only player), the bot wakes up in the morning and the
// night process ends. (2) `!sleep off`, night again: the bot stays up; `!sleep` from the console: it
// goes to bed, sleeps, `good morning`. Needs BDS_E2E=1 and bds-gaunt with the truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { centre, E2E, FEET_Y, fill, gauntCmd, hdist, prepareServer, privateArea, saidSince, sleep, startGauntBot, teleport, until, type GauntBot } from './gaunt-truth.ts';

describe.skipIf(!E2E)('gaunt: sleeping (Track W)', () => {
  let bot: GauntBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const BED_FOOT = { x: HOME.x + 4, y: FEET_Y, z: HOME.z };
  const lines: string[] = [];

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    bot = await startGauntBot('GtSleep', { home: HOME, shelter: HOME });
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 64);
    await fill(bot, { x: HOME.x - 8, y: FEET_Y, z: HOME.z - 8 }, { x: HOME.x + 12, y: FEET_Y + 3, z: HOME.z + 8 }, 'air');
    await bot.truth.bed(BED_FOOT, 3); // head east of the foot
  }, 120_000);

  afterAll(async () => {
    await gauntCmd('gamerule', 'dodaylightcycle', 'false').catch(() => undefined);
    if (bot) {
      await bot.truth.time('noon').catch(() => undefined);
      await bot.truth.cleanup().catch(() => undefined);
      await fill(bot, { x: HOME.x - 8, y: FEET_Y, z: HOME.z - 8 }, { x: HOME.x + 12, y: FEET_Y + 3, z: HOME.z + 8 }, 'air').catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${lines.join('\n  ')}`);
  });

  it('auto-sleep: monsters near -> refused, waits, retries; asleep; night skipped; up in the morning', async () => {
    const b = bot!;
    const night = b.night!;
    expect(night.bedAttached).toBe(true);
    // a zombie in a glass box 5 blocks south of the bed (it cannot reach the bot)
    const box = { x: BED_FOOT.x, y: FEET_Y, z: BED_FOOT.z + 5 };
    await fill(b, { x: box.x - 1, y: FEET_Y, z: box.z - 1 }, { x: box.x + 1, y: FEET_Y + 2, z: box.z + 1 }, 'glass');
    await fill(b, box, { x: box.x, y: FEET_Y + 1, z: box.z }, 'air');
    const z = await b.truth.summon('zombie', { x: box.x + 0.5, y: FEET_Y, z: box.z + 0.5 });
    await gauntCmd('gamerule', 'dodaylightcycle', 'true');
    const corr0 = b.built.mobility!.loop.state.corrections;
    const t0 = Date.now();
    await b.truth.time(18000);
    // refused because of the zombie
    await until(() => ((night.sleepStatus().refusals as number) >= 1 ? true : undefined), 30_000, 'first refusal (monsters)', 100);
    const refusedMs = Date.now() - t0;
    expect(night.sleepStatus().lastReason).toBe('monsters');
    const behaviourWaiting = b.pve.behaviour();
    const bedPos = (await b.truth.pos(b.name)).location;
    await b.truth.cleanup(); // the zombie goes
    await fill(b, { x: box.x - 1, y: FEET_Y, z: box.z - 1 }, { x: box.x + 1, y: FEET_Y + 2, z: box.z + 1 }, 'air');
    const asleep = await until(async () => {
      const s = await b.truth.sleeping(b.name);
      return s.sleeping ? s : undefined;
    }, 40_000, 'asleep (truth)', 250);
    const asleepMs = Date.now() - t0;
    expect(b.pve.behaviour()).toBe('sleeping');
    // the only player asleep: the server skips the night and wakes the bot
    const awake = await until(async () => {
      const s = await b.truth.sleeping(b.name);
      return !s.sleeping ? s : undefined;
    }, 30_000, 'awake (truth)', 250);
    const awakeMs = Date.now() - t0;
    expect(awake.timeOfDay).toBeLessThan(2000);
    await until(() => (b.pve.processes.active?.name !== 'night' && !night.sleepStatus().sleeping ? true : undefined), 15_000, 'night process done', 100);
    const corrections = b.built.mobility!.loop.state.corrections - corr0;
    const line =
      `auto-sleep with a boxed zombie 5 blocks from the bed: refused (monsters) after ${(refusedMs / 1000).toFixed(1)} s ("${behaviourWaiting}", standing ${hdist(bedPos, { x: BED_FOOT.x + 1, z: BED_FOOT.z + 0.5 }).toFixed(1)} from the bed head); zombie removed -> asleep after ${(asleepMs / 1000).toFixed(1)} s ` +
      `(at ${asleep.location.x.toFixed(2)} ${asleep.location.y.toFixed(3)} ${asleep.location.z.toFixed(2)}, time ${asleep.timeOfDay}); woken by the night skip after ${(awakeMs / 1000).toFixed(1)} s, time ${awake.timeOfDay}, at ${awake.location.x.toFixed(2)} ${awake.location.z.toFixed(2)}; ` +
      `corrections ${corrections}; night stats ${JSON.stringify(night.sleepStatus())}; entity ${z.entityId}`;
    console.log(line);
    lines.push(line);
  }, 150_000);

  it('!sleep off keeps it up at night; !sleep sends it to bed; good morning', async () => {
    const b = bot!;
    const night = b.night!;
    let n0 = b.said.length;
    await gauntCmd('say', '!sleep off');
    await until(() => saidSince(b, n0, 'sleep: auto off'), 10_000, '!sleep off reply');
    expect(night?.autoSleep).toBe(false); // through the saved setting autoSleep
    await b.truth.time(18000);
    await until(() => {
      const t = b.pve.timeOfDay();
      return t !== undefined && t >= 17_900 && t < 19_000 ? true : undefined;
    }, 20_000, 'night in the bot clock');
    await sleep(3000);
    expect((await b.truth.sleeping(b.name)).sleeping).toBe(false);
    expect(night.sleepStatus().phase).not.toBe('asleep');
    n0 = b.said.length;
    const t0 = Date.now();
    await gauntCmd('say', '!sleep');
    const going = await until(() => saidSince(b, n0, 'going to bed'), 10_000, '!sleep reply');
    const sleeping = await until(() => saidSince(b, n0, 'sleeping (bed'), 30_000, 'sleeping reply');
    const asleepMs = Date.now() - t0;
    const morning = await until(() => saidSince(b, n0, 'good morning'), 30_000, 'good morning');
    const morningMs = Date.now() - t0;
    const s = await b.truth.sleeping(b.name);
    expect(s.sleeping).toBe(false);
    expect(s.timeOfDay).toBeLessThan(2000);
    const n1 = b.said.length;
    await gauntCmd('say', '!sleep status');
    const st = await until(() => saidSince(b, n1, 'sleep: auto'), 10_000, '!sleep status reply');
    expect(st).toContain('sleep: auto off');
    const line = `!sleep (auto off): "${going}" -> "${sleeping}" after ${(asleepMs / 1000).toFixed(1)} s -> "${morning}" after ${(morningMs / 1000).toFixed(1)} s, time ${s.timeOfDay}; "${st}"`;
    console.log(line);
    lines.push(line);
    await gauntCmd('say', '!sleep on');
  }, 120_000);
});
