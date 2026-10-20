// e2e (tag @bds), PLAN.md task 3.6: a wall placed mid-path with truth:fill while the bot walks; the
// navigator sees the block updates, re-plans and walks around it. Also: a goal sealed off by walls is
// given up as 'unreachable'. On bds-move, "wall" layout (nav-worlds.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, hdist, teleport, truthDiff, type MoveBot } from './move-truth.ts';
import { WALL, WALL_LAYOUT } from './nav-worlds.ts';

describe.skipIf(!E2E)('@bds nav: re-plan around a wall placed mid-path (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];

  beforeAll(async () => {
    bot = await connectBot('NavWall');
    await buildLayout(bot, WALL_LAYOUT);
  }, 120_000);

  afterAll(async () => {
    console.log(`[nav-wall e2e]\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  it('re-routes around a wall that appears across its path', async () => {
    await teleport(bot, WALL.start, 0);
    const before = bot.corrections.length;
    let placed: Promise<unknown> | undefined;
    let placedAt: { x: number; y: number; z: number } | undefined;
    const off = bot.loop.onBeforeStep((_t, s) => {
      if (!placed && s.pos.z > -92) {
        placedAt = { ...s.pos };
        const w = WALL.wall;
        placed = bot.truth.fill(w.from, w.to, w.block);
      }
    });
    const res = await bot.skills.goto({ type: 'block', p: WALL.goal }, { timeoutTicks: 1200, sprint: false });
    off();
    await placed;
    await bot.loop.waitTicks(10);
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    summary.push(
      `wall: placed at bot ${placedAt ? fmt(placedAt) : '?'}; ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks ` +
        `(straight ${hdist(WALL.start, WALL.goal).toFixed(1)}), plans ${rep.plans.map((p) => `${p.reason}@${p.tick}:${p.status}`).join(' ')}, stuck ${rep.stuck}, ` +
        `${got.length} correction(s), truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`,
    );
    expect(placed).toBeDefined();
    expect(res).toEqual({ ok: true });
    expect(rep.plans.some((p) => p.reason === 'block' || p.reason === 'stuck')).toBe(true);
    expect(rep.distance).toBeGreaterThan(hdist(WALL.start, WALL.goal) + 2); // it went around
    expect(td.diff).toBeLessThan(0.05);
    expect(got.length).toBeLessThanOrEqual(2);
  }, 120_000);

  it("gives up on a goal sealed off by walls with 'unreachable'", async () => {
    // a 3-high ring around (12, -90)
    const c = { x: 12, z: -90 };
    await bot.truth.fill({ x: c.x - 2, y: -60, z: c.z - 2 }, { x: c.x + 2, y: -58, z: c.z + 2 }, 'stone');
    await bot.truth.fill({ x: c.x - 1, y: -60, z: c.z - 1 }, { x: c.x + 1, y: -58, z: c.z + 1 }, 'air');
    await bot.loop.waitTicks(10);
    await teleport(bot, { x: 0.5, y: -60, z: -90.5 }, -90);
    const res = await bot.skills.goto({ type: 'block', p: { x: c.x, y: -60, z: c.z } }, { timeoutTicks: 1200 });
    const rep = bot.skills.status().lastGoto!;
    summary.push(`sealed goal: ${JSON.stringify(res)} after ${rep.ticks} ticks, plans ${rep.plans.map((p) => `${p.reason}:${p.status}`).join(' ')}, failures ${rep.failures}`);
    expect(res).toEqual({ ok: false, reason: 'unreachable' });
    expect(rep.ticks).toBeLessThan(400);
  }, 120_000);
});
