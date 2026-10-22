// PLAN.md task 7.11 on bds-surv: mob and spawner avoidance in the planner. A goto whose straight line
// passes a spawner bends around it (the body's distance to the spawner never below avoidSpawnerRadius,
// 8); a goto past a zombie in a glass box bends around it (never closer than avoidMobRadius, 4); with
// the radius set to 0 the same goto passes close (the control). Needs BDS_E2E=1 and bds-surv with the
// truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { blockGoal } from '../../src/tasks/mobility.ts';
import { centre, tracked } from './pve-truth.ts';
import { E2E, FEET_Y, fill, flatten, prepareServer, privateArea, startSurvBot, teleport, track, until, type SurvBot } from './surv-truth.ts';

describe.skipIf(!E2E)('survival: mob and spawner avoidance (task 7.11)', () => {
  let bot: SurvBot | undefined;
  const area = privateArea();
  const MID = { x: area.x, y: FEET_Y, z: area.z };
  const START = { x: MID.x - 16, y: FEET_Y, z: MID.z };
  const GOAL = { x: MID.x + 16, y: FEET_Y, z: MID.z };
  const measurements: string[] = [];
  const note = (s: string) => {
    console.log(s);
    measurements.push(s);
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startSurvBot('SurvAvoid');
    await teleport(bot, centre(START));
    await flatten(bot, MID.x, MID.z, 24, 16);
    await bot.truth.clearAround(centre(MID), 40);
    await bot.truth.setHealth(bot.name, 20);
    await bot.truth.setFood(bot.name, 20, 5, 0);
    await bot.truth.ok('clear', [bot.name]);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(MID), 40).catch(() => undefined);
      await fill(bot, { x: MID.x - 2, y: FEET_Y, z: MID.z - 2 }, { x: MID.x + 2, y: FEET_Y + 3, z: MID.z + 2 }, 'air').catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${measurements.join('\n  ')}`);
  });

  /** goto START -> GOAL (teleported to START first); the body's closest approach to `p` (cell-centre metric of nav/avoidance.ts). */
  async function walkPast(p: Vec3, label: string): Promise<{ min: number; ok: boolean; ticks: number }> {
    const b = bot!;
    const mob = b.built.mobility!;
    await teleport(b, centre(START), -90);
    const t0 = Date.now();
    const { result, path } = await track(b, () => mob.skills.goto(blockGoal(GOAL), { timeoutTicks: 1200 }));
    const min = Math.min(...path.map((q) => Math.hypot(q.x - (p.x + 0.5), Math.floor(q.y + 1e-3) - p.y, q.z - (p.z + 0.5))));
    const rep = mob.skills.nav.lastReport!;
    note(`${label}: goto ${result.ok ? 'ok' : result.reason} in ${rep.ticks} ticks (${Date.now() - t0} ms), ${rep.corrections} corrections, closest ${min.toFixed(2)} blocks; avoidance sources ${JSON.stringify(b.kit.avoidance.last)}; plans ${rep.plans.map((x) => `${x.reason}:${x.status}/${x.nodes}n/${x.expanded}e/${x.ms}ms`).join(" ")}`);
    return { min, ok: result.ok, ticks: rep.ticks };
  }

  it('bends around a spawner on the straight line (closest approach >= avoidSpawnerRadius 8)', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const sp = { ...MID };
    await fill(b, sp, sp, 'mob_spawner');
    await until(() => (mob.world.blockAt(sp)?.name === 'mob_spawner' ? true : undefined), 5_000, 'spawner in the model');
    const avoid = await walkPast(sp, 'spawner, radius 8');
    expect(avoid.ok).toBe(true);
    expect(avoid.min).toBeGreaterThanOrEqual(8);
    expect(b.kit.avoidance.last.spawners).toBe(1);
    b.kit.overrides.avoidSpawnerRadius = 0;
    const control = await walkPast(sp, 'spawner, radius 0 (control)');
    delete b.kit.overrides.avoidSpawnerRadius;
    expect(control.ok).toBe(true);
    expect(control.min).toBeLessThan(2);
    await fill(b, sp, sp, 'air');
  }, 120_000);

  it('bends around a stationary zombie behind glass (closest approach >= avoidMobRadius 4)', async () => {
    const b = bot!;
    b.pve.setGuard({ on: false });
    // a glass box (3 x 3 x 3 outside) around a 1 x 2 cell in the middle of the line
    await fill(b, { x: MID.x - 1, y: FEET_Y, z: MID.z - 1 }, { x: MID.x + 1, y: FEET_Y + 2, z: MID.z + 1 }, 'glass');
    await fill(b, MID, { x: MID.x, y: FEET_Y + 1, z: MID.z }, 'air');
    const z = await b.truth.summon('zombie', { x: MID.x + 0.5, y: FEET_Y, z: MID.z + 0.5 });
    await b.truth.effect(z.entityId, 'fire_resistance', 600, 0);
    await tracked(b, z);
    const avoid = await walkPast(MID, 'zombie behind glass, radius 4');
    expect(avoid.ok).toBe(true);
    expect(avoid.min).toBeGreaterThanOrEqual(4);
    expect(b.kit.avoidance.last.mobs).toBeGreaterThanOrEqual(1);
    b.kit.overrides.avoidMobRadius = 0;
    const control = await walkPast(MID, 'zombie behind glass, radius 0 (control)');
    delete b.kit.overrides.avoidMobRadius;
    expect(control.ok).toBe(true);
    expect(control.min).toBeLessThan(3);
    const still = await b.truth.entity(z.entityId);
    expect(Math.hypot(still.location.x - (MID.x + 0.5), still.location.z - (MID.z + 0.5))).toBeLessThan(0.6);
  }, 120_000);
});
