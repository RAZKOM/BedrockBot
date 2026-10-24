// e2e (tag @bds), Track Z (PLAN.md 7.13 + 7.8; docs/farming.md "As a process") on bds-core
// (difficulty normal, truth pack with truth:field / truth:crops):
//   `!farm 3` on a 5 x 5 mature wheat field is a user process of the real afk task; a zombie summoned
//   7 blocks from the bot makes guard pre-empt it (stack guard:active farm:paused, the farmer paused),
//   the farm resumes once the zombie is dead and finishes the field (25 harvested and replanted,
//   truth: 25 farmland, 25 wheat); `!status` shows it in the stack; `!pause` / `!resume` hold and
//   release it; `!stop` ends it.
// Env: CORE_BDS_HOST / CORE_BDS_PORT / CORE_BDS_CONTAINER (core-truth.ts), CORE_VERBOSE=1. Own random
// 256-block cell, run-unique truth ids and summon tag; everything removed at the end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FarmTask } from '../../src/skills/farm/farmer.ts';
import type { FarmProcess } from '../../src/tasks/process/farm.ts';
import { armWithIronSword, centre, clearArea, E2E, FEET_Y, hdist, prepareServer, privateArea, sleep, startCoreBot, teleport, truthLoaded, until, type CoreBot } from './core-truth.ts';

const SOIL_Y = FEET_Y - 1;

interface TruthCrops {
  soilCounts: Record<string, number>;
  cropCounts: Record<string, number>;
  growth: number[];
}

describe.skipIf(!E2E)('core: !farm as a process (Track Z)', () => {
  let bot: CoreBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const field = { x: HOME.x + 2, z: HOME.z - 2, w: 5, d: 5 };
  const notes: string[] = [];

  beforeAll(async () => {
    await prepareServer();
    bot = await startCoreBot('FarmProc', { home: HOME });
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 48);
    await clearArea(bot.truth, HOME, 14, 6);
    await armWithIronSword(bot);
    await bot.truth.ok('give', [bot.name, 'wheat_seeds', 8]);
    await bot.truth.setHealth(bot.name, 20);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 48).catch(() => undefined);
      await clearArea(bot.truth, HOME, 14, 6).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[farm-process e2e] area cell ${area.cell} (${HOME.x}, ${HOME.z})\n  ${notes.join('\n  ')}`);
  }, 60_000);

  it('a guard fight pre-empts !farm; the farm resumes and finishes the field; !status / !pause / !resume / !stop apply', async () => {
    const b = bot!;
    await truthLoaded(b.truth, 'field', [field.x, SOIL_Y, field.z, field.w, field.d, 'wheat', 7]);
    const w = b.built.mobility!.world;
    await until(() => (w.blockAt({ x: field.x + 4, y: FEET_Y, z: field.z + 4 })?.name === 'wheat' ? true : undefined), 10_000, 'field in the world model');
    b.pve.setGuard({ on: true });
    // stand next to the field and farm radius 3 around its centre
    const at = { x: field.x + 2, y: FEET_Y, z: field.z + 2 };
    await teleport(b, centre(at));
    expect(hdist(b.task.position()!, centre(at))).toBeLessThan(0.5);
    let n = b.said.length;
    const t0 = Date.now();
    await b.command('!farm 3');
    // on farmland the feet are at -60.0625: the block is -61
    expect(await b.reply((s) => s.startsWith('farming'), n)).toMatch(new RegExp(`^farming r=3 around ${at.x} -6[01] ${at.z}$`));
    const proc = () => b.processes.find('farm')[0] as FarmProcess | undefined;
    const farm: FarmTask = (await until(() => proc(), 5_000, 'farm process')).task;
    await until(() => (farm.stats.harvested >= 4 ? true : undefined), 60_000, 'first harvests', 100);
    const harvestedAtFight = farm.stats.harvested;
    const me = b.task.position()!;
    const mob = await b.truth.summon('zombie', { x: Math.floor(me.x) + 0.5, y: FEET_Y, z: Math.floor(me.z) - 7.5 });
    const tSummon = Date.now();
    const fight = await until(() => (b.pve.behaviour().startsWith('fighting zombie') ? b.pve.behaviour() : undefined), 10_000, 'guard fight', 50);
    const preemptMs = Date.now() - tSummon;
    expect(b.processes.stack().map((e) => `${e.name}:${e.state}`)).toEqual(['guard:active', 'farm:paused']);
    expect(farm.state).toBe('paused');
    const pausedAt = { h: farm.stats.harvested, p: farm.stats.planted };
    await until(async () => ((await b.truth.entity(mob.entityId)).valid === false ? true : undefined), 60_000, 'zombie dead', 250);
    const killMs = Date.now() - tSummon;
    const resumed = await until(() => (b.processes.stack()[0]?.name === 'farm' && b.processes.stack()[0]?.state === 'active' ? Date.now() : undefined), 30_000, 'farm resumed', 50);
    // !status while farming: the stack line
    n = b.said.length;
    await b.command('!status');
    const stackLine = await b.reply((s) => s.startsWith('processes:'), n);
    expect(stackLine).toMatch(/\[active\] farm r=3 at /);
    await until(() => (farm.stats.harvested >= 20 && farm.stats.planted >= farm.stats.harvested && farm.state === 'waiting' ? true : undefined), 180_000, 'field finished', 250).catch((e: unknown) => {
      throw new Error(`${String(e)}: ${farm.summary()}, state ${farm.state}, last error ${farm.lastError}`);
    });
    const doneMs = Date.now() - t0;
    const crops = await truthLoaded<TruthCrops>(b.truth, 'crops', [field.x, SOIL_Y, field.z, field.w, field.d]);
    notes.push(
      `farm + guard: "${fight}" ${preemptMs} ms after the summon (farm paused at ${harvestedAtFight} harvested; ${pausedAt.h}/${pausedAt.p} while paused), zombie dead after ${killMs} ms, ` +
        `farm resumed ${resumed - tSummon} ms after the summon, field done ${doneMs} ms after !farm: ${farm.stats.harvested} harvested, ${farm.stats.planted} planted, pauses ${farm.stats.pauses}, ` +
        `${farm.stats.plantRejected} plantings rejected; truth soil ${JSON.stringify(crops.soilCounts)} crops ${JSON.stringify(crops.cropCounts)}; resumes ${b.metrics.snapshot().counters['process.farm.resumed'] ?? 0}; "${stackLine}"`,
    );
    expect(farm.stats.pauses).toBeGreaterThanOrEqual(1);
    // the zombie may break a crop on its way across the field (then it is planted, not harvested)
    expect(farm.stats.harvested).toBeGreaterThanOrEqual(20);
    expect(farm.stats.planted).toBeGreaterThanOrEqual(farm.stats.harvested);
    expect(crops.soilCounts.farmland).toBe(25);
    expect(crops.cropCounts.wheat).toBe(25);
    expect(b.metrics.snapshot().counters['process.farm.resumed']).toBeGreaterThanOrEqual(1);

    // !pause holds it, !resume releases it, !stop ends it
    n = b.said.length;
    await b.command('!pause');
    expect(await b.reply((s) => s.startsWith('paused'), n)).toMatch(/^paused: farming \(\d+ harvested\)/);
    expect(farm.state).toBe('paused');
    n = b.said.length;
    await b.command('!resume');
    expect(await b.reply((s) => s.startsWith('resumed'), n)).toMatch(/^resumed: farming/);
    await sleep(500);
    expect(farm.state).not.toBe('paused');
    n = b.said.length;
    await b.command('!stop');
    expect(await b.reply((s) => s.startsWith('stopped'), n)).toMatch(/^stopped \(was farm/);
    expect(farm.state).toBe('stopped');
    expect(b.processes.userProcesses()).toHaveLength(0);
    b.pve.setGuard({ on: false });
    notes.push(`!pause -> farm ${'paused'}, !resume -> running, !stop -> stopped; stack empty`);
  }, 360_000);
});
