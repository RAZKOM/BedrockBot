// e2e (tag @bds), PLAN.md task 7.2: the dig-through move on bds-move with the real Digger. A 41-wide,
// 3-high dirt wall across the line: without allowBreak the bot walks around it; with allowBreak it
// digs through (two blocks by hand, 15 ticks each) because the detour costs more.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E, buildLayout, connectBot, describeCorrections, disconnectBot, hdist, teleport, waitForBlock, type MoveBot } from './move-truth.ts';
import { digLayout, privateOrigin } from './nav-worlds.ts';

describe.skipIf(!E2E)('@bds nav v2: dig-through (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const L = digLayout(o);
  const w = L.wall;

  beforeAll(async () => {
    bot = await connectBot('NavDig');
    await buildLayout(bot, L.layout);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-dig e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  /** Wall cells that are not dirt any more (world model). */
  function holes(): string[] {
    const out: string[] = [];
    for (let x = w.from.x; x <= w.to.x; x++) {
      for (let y = w.from.y; y <= w.to.y; y++) {
        const b = bot.world.blockAt({ x, y, z: w.from.z });
        if (b?.name !== 'dirt') out.push(`${x},${y}:${b?.name}`);
      }
    }
    return out;
  }

  it('walks around the wall when breaking is not allowed', async () => {
    await teleport(bot, L.start, 0);
    const before = bot.corrections.length;
    const res = await bot.skills.goto({ type: 'block', p: L.goal }, { timeoutTicks: 1500 });
    await bot.loop.waitTicks(10);
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    summary.push(`no break: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks (straight ${hdist(L.start, L.goal).toFixed(1)}), digs ${rep.actions.dig}, holes ${holes().length}, ${got.length} correction(s)${describeCorrections(got)}`);
    expect(res).toEqual({ ok: true });
    expect(rep.actions.dig).toBe(0);
    expect(holes()).toEqual([]);
    expect(rep.distance).toBeGreaterThan(hdist(L.start, L.goal) + 20);
    expect(got.length).toBeLessThanOrEqual(2);
  }, 120_000);

  it('digs through the wall when breaking is allowed', async () => {
    await teleport(bot, L.start, 0);
    const before = bot.corrections.length;
    const res = await bot.skills.goto({ type: 'block', p: L.goal }, { timeoutTicks: 1500, allowBreak: true });
    await bot.loop.waitTicks(10);
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    const h = holes();
    summary.push(
      `allow break: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, digs ${rep.actions.dig} (failed ${rep.actions.failed}), holes ${h.join(' ')}, ` +
        `plans ${rep.plans.map((p) => `${p.reason}:${p.status}`).join(' ')}, ${got.length} correction(s)${describeCorrections(got)}`,
    );
    expect(res).toEqual({ ok: true });
    expect(rep.actions.dig).toBeGreaterThanOrEqual(1);
    expect(h.length).toBeGreaterThanOrEqual(1);
    expect(h.length).toBeLessThanOrEqual(2);
    expect(rep.distance).toBeLessThan(hdist(L.start, L.goal) + 6);
    expect(got.length).toBeLessThanOrEqual(2);
    // restore the wall for a re-run in the same area
    await bot.truth.fill(w.from, w.to, w.block);
    await waitForBlock(bot, { x: w.to.x, y: w.to.y, z: w.to.z }, 'dirt');
  }, 120_000);
});
