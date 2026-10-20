// e2e (tag @bds), PLAN.md task 3.5: a 100-block goal over hills reached in under 60 s, on the "long"
// layout (nav-worlds.ts: 1-block steps, slab stairs, 3-block drops, a water ditch with a 1-wide
// bridge, a wall with a gap, a stepped mound, two trees) on bds-move.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, hdist, teleport, truthDiff, type MoveBot } from './move-truth.ts';
import { LONG, LONG_LAYOUT } from './nav-worlds.ts';

describe.skipIf(!E2E)('@bds nav: 100 blocks over hills (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];

  beforeAll(async () => {
    bot = await connectBot('NavLong');
    await buildLayout(bot, LONG_LAYOUT);
  }, 120_000);

  afterAll(async () => {
    console.log(`[nav-long e2e]\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  it('reaches a goal 100 blocks away over hills in under 60 s', async () => {
    await teleport(bot, LONG.start, -90);
    let wet = 0;
    const off = bot.loop.onBeforeStep((_t, s) => {
      if (s.inWater) wet++;
    });
    const before = bot.corrections.length;
    const t0 = performance.now();
    const res = await bot.skills.goto({ type: 'block', p: LONG.goal }, { timeoutTicks: 1200 });
    const seconds = (performance.now() - t0) / 1000;
    off();
    await bot.loop.waitTicks(10);
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    summary.push(
      `long: ${res.ok ? 'ok' : JSON.stringify(res)} in ${seconds.toFixed(1)} s (${rep.ticks} ticks), straight-line ${hdist(LONG.start, LONG.goal).toFixed(1)} blocks, ` +
        `walked ${rep.distance.toFixed(1)} blocks, sprint ${rep.sprintTicks} ticks, plans ${rep.plans.map((p) => `${p.reason}:${p.status}/${p.nodes}n/${p.expanded}e/${p.ms}ms`).join(' ')}, ` +
        `${got.length} correction(s) (${(got.length / rep.distance).toFixed(4)} per block), stuck ${rep.stuck}, end ${fmt(bot.loop.state.pos)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`,
    );
    expect(res).toEqual({ ok: true });
    expect(seconds).toBeLessThan(60);
    expect(wet).toBe(0);
    expect(td.diff).toBeLessThan(0.05);
    expect(got.length / rep.distance).toBeLessThan(0.1);
  }, 120_000);
});
