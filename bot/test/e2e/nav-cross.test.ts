// e2e (tag @bds), PLAN.md task 7.1: a 200-block cross-country goto on bds-move (nav-worlds.ts
// crossLayout: slab ramp and a 2-block drop, seeded mounds, a wall with a gap, a water ditch with a
// bridge, a cave hill with its tunnel on the line, a 3-deep pit on the line, trees, steps). Target:
// 0 corrections, no tick over 100 ms in the navigator, never in the tunnel, the pit or the water.
// Reports the segments, the planner time per segment and the max per-tick time.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, hdist, teleport, truthDiff, type MoveBot } from './move-truth.ts';
import { crossLayout, privateOrigin, trackBody } from './nav-worlds.ts';

const SEED = Number(process.env.MOVE_SEED ?? 7);

describe.skipIf(!E2E)('@bds nav v2: 200 blocks cross-country (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const L = crossLayout(o, SEED);

  beforeAll(async () => {
    bot = await connectBot('NavCross');
    await buildLayout(bot, L.layout);
  }, 240_000);

  afterAll(async () => {
    console.log(`[nav-cross e2e] area ${o.x},${o.z} seed ${SEED}\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  it('reaches a goal 200 blocks away over mixed terrain with 0 corrections and no long ticks', async () => {
    await teleport(bot, L.start, -90);
    const before = bot.corrections.length;
    const tr = trackBody(bot);
    const t0 = performance.now();
    const res = await bot.skills.goto({ type: 'block', p: L.goal }, { timeoutTicks: 3000 });
    const seconds = (performance.now() - t0) / 1000;
    await bot.loop.waitTicks(10);
    tr.stop();
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    const inPit = tr.path.filter((p) => p.x >= L.pit.x0 && p.x < L.pit.x1 + 1 && p.z >= L.pit.z0 && p.z < L.pit.z1 + 1 && p.y < -60.5).length;
    const segMs = rep.plans.map((p) => p.ms);
    summary.push(
      `cross: ${res.ok ? 'ok' : JSON.stringify(res)} in ${seconds.toFixed(1)} s (${rep.ticks} ticks), straight ${hdist(L.start, L.goal).toFixed(1)} blocks, walked ${rep.distance.toFixed(1)}, ` +
        `sprint ${rep.sprintTicks} ticks, ${rep.segments} segment(s), ${rep.plans.length} plan(s), max tick ${rep.maxTickMs} ms, planner ${rep.planMs.toFixed(1)} ms total, ` +
        `per plan max ${Math.max(...segMs).toFixed(1)} ms, waited for chunks ${rep.unloadedWait} ticks, stuck ${rep.stuck} (timeouts ${rep.moveTimeouts}), ` +
        `underground ticks ${tr.underground}, pit ticks ${inPit}, wet ticks ${tr.wet}, ${got.length} correction(s), end ${fmt(bot.loop.state.pos)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`,
      `plans: ${rep.plans.map((p) => `${p.reason}@${p.tick}:${p.status}/${p.nodes}n/${p.expanded}e/${p.ms}ms/${p.slices}t`).join(' ')}`,
    );
    expect(res).toEqual({ ok: true });
    expect(rep.maxTickMs).toBeLessThan(100);
    expect(inPit).toBe(0);
    expect(tr.wet).toBe(0);
    expect(td.diff).toBeLessThan(0.05);
    expect(got.length).toBe(0);
  }, 240_000);
});
