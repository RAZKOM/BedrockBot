// e2e (tag @bds), PLAN.md tasks 7.1 / 7.3 (planner side): a connected oak fence line on bds-move.
// The physics now gives fences their arms towards neighbouring fences (terrain/shapes.ts), so the
// body walking along the line, around its corner and through its gap never collides with it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, teleport, truthDiff, type MoveBot } from './move-truth.ts';
import { fenceLayout, privateOrigin, trackBody } from './nav-worlds.ts';

describe.skipIf(!E2E)('@bds nav v2: fence line (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const L = fenceLayout(o);

  beforeAll(async () => {
    bot = await connectBot('NavFence');
    await buildLayout(bot, L.layout);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-fence e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  it('walks along the fence line, then back through its gap, without touching it', async () => {
    await teleport(bot, L.start, 0);
    const before = bot.corrections.length;
    const tr = trackBody(bot);
    const a = await bot.skills.goto({ type: 'block', p: L.along }, { timeoutTicks: 1200 });
    const repA = bot.skills.status().lastGoto!;
    const b = await bot.skills.goto({ type: 'block', p: L.across }, { timeoutTicks: 1200 });
    const repB = bot.skills.status().lastGoto!;
    await bot.loop.waitTicks(10);
    tr.stop();
    const got = bot.corrections.slice(before);
    const td = await truthDiff(bot);
    const arms = bot.loop.world.boxesAt?.(o.x + 1, -60, o.z + 5)?.length;
    summary.push(
      `along: ${a.ok ? 'ok' : JSON.stringify(a)} in ${repA.ticks} ticks, ${repA.distance.toFixed(1)} blocks; across (through the gap): ${b.ok ? 'ok' : JSON.stringify(b)} in ${repB.ticks} ticks, ` +
        `${repB.distance.toFixed(1)} blocks; collision ticks ${tr.collided}, fence boxes at a mid-line post ${arms}, ${got.length} correction(s), end ${fmt(bot.loop.state.pos)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`,
    );
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    // post + north and south arms; a single 1.5-high box while the world model has fences as unknown runtime ids (1.26.60)
    expect(arms === 3 || arms === 1).toBe(true);
    expect(tr.collided).toBe(0);
    expect(td.diff).toBeLessThan(0.05);
    expect(got.length).toBe(0);
  }, 120_000);
});
