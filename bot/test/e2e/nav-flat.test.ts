// e2e (tag @bds), PLAN.md task 3.3: flat-ground walking, turning and sprinting through goto on
// bds-move. Done when: 10 random points within 30 blocks reached, mean corrections under 0.1 per
// block. Runs once with sprinting allowed (the default) and once without. Needs BDS_E2E=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { rng } from '../unit/skills/genworld.ts';
import { E2E, FEET_Y, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, hdist, teleport, truthDiff, type MoveBot } from './move-truth.ts';
import { FLAT } from './nav-worlds.ts';

const SEED = Number(process.env.MOVE_SEED ?? 20261028);

describe.skipIf(!E2E)('@bds nav: flat walking, turning, sprint (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];

  beforeAll(async () => {
    bot = await connectBot('NavFlat');
    await buildLayout(bot, FLAT);
  }, 120_000);

  afterAll(async () => {
    console.log(`[nav-flat e2e]\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  async function tenPoints(label: string, seed: number, sprint: boolean): Promise<{ corrections: number; blocks: number; sprintTicks: number }> {
    await teleport(bot, { x: 0.5, y: FEET_Y, z: 0.5 });
    const r = rng(seed);
    let corrections = 0;
    let blocks = 0;
    let sprintTicks = 0;
    for (let i = 0; i < 10; i++) {
      let goal: Vec3;
      do {
        goal = { x: Math.floor(r() * 61) - 30, y: FEET_Y, z: Math.floor(r() * 61) - 30 };
      } while (Math.hypot(goal.x, goal.z) > 30 || hdist(bot.loop.state.pos, { x: goal.x + 0.5, z: goal.z + 0.5 }) < 3);
      const before = bot.corrections.length;
      const res = await bot.skills.goto({ type: 'block', p: goal }, { sprint, timeoutTicks: 1200 });
      await bot.loop.waitTicks(10);
      const got = bot.corrections.slice(before);
      const rep = bot.skills.status().lastGoto!;
      const td = await truthDiff(bot);
      const end = hdist(bot.loop.state.pos, { x: goal.x + 0.5, z: goal.z + 0.5 });
      corrections += got.length;
      blocks += rep.distance;
      sprintTicks += rep.sprintTicks;
      summary.push(
        `${label} #${i + 1} -> (${goal.x}, ${goal.z}): ${res.ok ? 'ok' : JSON.stringify(res)} ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, ` +
          `sprint ${rep.sprintTicks} ticks, ${got.length} correction(s), end ${end.toFixed(3)} from centre, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`,
      );
      expect(res, `goal ${fmt(goal)}`).toEqual({ ok: true });
      expect(end).toBeLessThanOrEqual(0.3);
      expect(td.diff).toBeLessThan(0.05);
    }
    summary.push(`${label}: ${corrections} correction(s) over ${blocks.toFixed(1)} blocks = ${(corrections / blocks).toFixed(4)} per block; sprint ${sprintTicks} ticks`);
    return { corrections, blocks, sprintTicks };
  }

  it('reaches 10 random points within 30 blocks (sprint allowed): corrections under 0.1 per block', async () => {
    const r = await tenPoints('sprint on', SEED, true);
    expect(r.sprintTicks).toBeGreaterThan(0);
    expect(r.corrections / r.blocks).toBeLessThan(0.1);
  }, 240_000);

  it('reaches 10 random points within 30 blocks walking only: corrections under 0.1 per block', async () => {
    const r = await tenPoints('sprint off', SEED + 1, false);
    expect(r.sprintTicks).toBe(0);
    expect(r.corrections / r.blocks).toBeLessThan(0.1);
  }, 240_000);

  it('lookAt turns smoothly to face a point (yaw and pitch match truth)', async () => {
    await teleport(bot, { x: 0.5, y: FEET_Y, z: 0.5 }, 0);
    const target = { x: -9.5, y: FEET_Y + 1.62 + 5, z: 10.5 }; // up-left, yaw 45, pitch about -19.5
    const yaws: number[] = [];
    const off = bot.loop.onBeforeStep(() => yaws.push(bot.loop.command.yaw));
    await bot.skills.lookAt(target);
    await bot.loop.waitTicks(5);
    off();
    const t = await bot.truth.pos(bot.name);
    const steps = yaws.slice(1).map((y, i) => Math.abs(y - yaws[i]!));
    summary.push(`lookAt: yaw ${bot.loop.command.yaw.toFixed(2)} pitch ${bot.loop.command.pitch.toFixed(2)}, truth yaw ${t.rotation.yaw.toFixed(2)} pitch ${t.rotation.pitch.toFixed(2)}, max step ${Math.max(...steps).toFixed(1)} deg`);
    expect(bot.loop.command.yaw).toBeCloseTo(45, 3);
    expect(bot.loop.command.pitch).toBeCloseTo((-Math.atan2(5, Math.hypot(10, 10)) * 180) / Math.PI, 3);
    expect(Math.abs(t.rotation.yaw - 45)).toBeLessThan(0.5);
    expect(Math.max(...steps)).toBeLessThanOrEqual(30.0001);
  }, 60_000);
});
