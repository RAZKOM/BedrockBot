// e2e (tag @bds), PLAN.md task 7.1: the surface preference on bds-move. A stepped hill with a 1-wide
// tunnel on the straight line (the cave mouth): the path stays on the surface. A 3-deep pit on the
// straight line: never entered. Each run builds in its own random area (nav-worlds.ts privateOrigin).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, teleport, truthDiff, type MoveBot } from './move-truth.ts';
import { privateOrigin, surfaceLayout, trackBody } from './nav-worlds.ts';

describe.skipIf(!E2E)('@bds nav v2: surface preference (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const L = surfaceLayout(o);

  beforeAll(async () => {
    bot = await connectBot('NavSurf');
    await buildLayout(bot, L.layout);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-surface e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  it('crosses a hill with a cave mouth on the straight line on the surface', async () => {
    await teleport(bot, L.cave.start, 0);
    const before = bot.corrections.length;
    const tr = trackBody(bot);
    const res = await bot.skills.goto({ type: 'block', p: L.cave.goal }, { timeoutTicks: 1500 });
    await bot.loop.waitTicks(10);
    tr.stop();
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    const t = L.cave.tunnel;
    const inTunnel = tr.path.filter((p) => Math.floor(p.x) === t.x && p.z >= t.z0 && p.z < t.z1 + 1 && p.y < -58.9).length;
    const maxFeet = Math.max(...tr.path.map((p) => p.y));
    summary.push(
      `cave hill: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, highest feet ${maxFeet.toFixed(2)}, ` +
        `underground ticks ${tr.underground}, tunnel ticks ${inTunnel}, plans ${rep.plans.map((p) => `${p.reason}:${p.status}/${p.expanded}e/${p.ms}ms`).join(' ')}, ` +
        `${got.length} correction(s), max tick ${rep.maxTickMs} ms, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`,
    );
    expect(res).toEqual({ ok: true });
    expect(inTunnel).toBe(0);
    expect(maxFeet).toBeGreaterThan(-58.5); // over the top (the hill is too wide to walk around cheaply)
    expect(tr.underground).toBe(0);
    expect(td.diff).toBeLessThan(0.05);
    expect(got.length).toBeLessThanOrEqual(2);
  }, 120_000);

  it('never enters a 3-deep pit on the straight line', async () => {
    await teleport(bot, L.pit.start, 0);
    const before = bot.corrections.length;
    const tr = trackBody(bot);
    const res = await bot.skills.goto({ type: 'block', p: L.pit.goal }, { timeoutTicks: 1200 });
    await bot.loop.waitTicks(10);
    tr.stop();
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    summary.push(
      `pit: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, lowest feet ${tr.minFeet.toFixed(3)}, ` +
        `${got.length} correction(s), end ${fmt(bot.loop.state.pos)}${describeCorrections(got)}`,
    );
    expect(res).toEqual({ ok: true });
    expect(tr.minFeet).toBeGreaterThan(-60.01);
    expect(got.length).toBeLessThanOrEqual(2);
  }, 120_000);
});
