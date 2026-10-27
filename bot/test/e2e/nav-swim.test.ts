// e2e (tag @bds), Track AJ (PLAN.md task 7.7, docs/pathfinding.md "Movement variety"): swimming on
// bds-move. A 6-wide, 3-deep river with walls at both ends (no way around): the bot walks in, swims
// across on the surface (forward + jump held) and climbs out onto the far bank, with 0 corrections and
// no damage (health from the server's attribute updates every tick and truth:pos at the end). An
// 18-block swimming lane measures the swim speed (ticks per block, the planner's `swim` cost), and a
// 1-deep ditch is waded. Each run builds in its own random area (nav-worlds.ts privateOrigin,
// MOVE_AREA pins it) and restores the flat world at the end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_COSTS } from '../../src/skills/nav/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, teleport, truthDiff, type MoveBot } from './move-truth.ts';
import { privateOrigin, trackBody, type Fill, type Layout } from './nav-worlds.ts';

/** NAV_TRACE=1: print the per-tick body state and command of a goto that got corrections. */
const TRACE = process.env.NAV_TRACE === '1';
const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });

describe.skipIf(!E2E)('@bds nav: swimming (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  // river: x o..o+20, water z o+7..o+12 (6 wide), y -63..-61 (3 deep); walls at x o-1 and o+21
  // lane: x o+30..o+32, water z o..o+17, walls at x o+29 and o+33 and across at z o-4 and o+21
  // ditch: x o+40..o+46, water z o+5..o+7 at y -61 (1 deep), walls at x o+39 and o+47
  const flat = (x1: number, z1: number, x2: number, z2: number): Fill[] => [f(x1, -64, z1, x2, -64, z2, 'bedrock'), f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, -45, z2, 'air')];
  const fills: Fill[] = [
    ...flat(o.x - 4, o.z - 6, o.x + 50, o.z + 24),
    f(o.x, -63, o.z + 7, o.x + 20, -61, o.z + 12, 'water'),
    f(o.x - 1, -63, o.z + 4, o.x - 1, -57, o.z + 15, 'stone'),
    f(o.x + 21, -63, o.z + 4, o.x + 21, -57, o.z + 15, 'stone'),
    f(o.x + 30, -63, o.z, o.x + 32, -61, o.z + 17, 'water'),
    f(o.x + 29, -63, o.z - 3, o.x + 29, -57, o.z + 20, 'stone'),
    f(o.x + 33, -63, o.z - 3, o.x + 33, -57, o.z + 20, 'stone'),
    f(o.x + 29, -63, o.z - 4, o.x + 33, -57, o.z - 4, 'stone'), // closed ends: no way around
    f(o.x + 29, -63, o.z + 21, o.x + 33, -57, o.z + 21, 'stone'),
    f(o.x + 40, -61, o.z + 5, o.x + 46, -61, o.z + 7, 'water'),
    f(o.x + 39, -61, o.z + 2, o.x + 39, -57, o.z + 10, 'stone'),
    f(o.x + 47, -61, o.z + 2, o.x + 47, -57, o.z + 10, 'stone'),
  ];
  const layout: Layout = { name: 'swim', anchor: { x: o.x + 20.5, y: -60, z: o.z + 2.5 }, fills };

  beforeAll(async () => {
    bot = await connectBot('NavSwim');
    await buildLayout(bot, layout);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-swim e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        await teleport(bot, layout.anchor);
        for (const fl of flat(o.x - 4, o.z - 6, o.x + 50, o.z + 24)) await bot.truth.fill(fl.from, fl.to, fl.block);
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 120_000);

  /** goto with body tracking, corrections and the lowest health the server reported on the way. */
  async function swim(label: string, from: Vec3, goal: Vec3) {
    await teleport(bot, from, 0);
    const before = bot.corrections.length;
    const tr = trackBody(bot);
    let minHealth = bot.world.self.health;
    let wetTicks = 0;
    let firstWet = -1;
    let lastWet = -1;
    let t = 0;
    const trace: string[] = [];
    const off = bot.loop.onBeforeStep((_t, s) => {
      minHealth = Math.min(minHealth, bot.world.self.health);
      if (s.inWater) {
        wetTicks++;
        if (firstWet < 0) firstWet = t;
        lastWet = t;
      }
      t++;
      if (TRACE) queueMicrotask(() => trace.push(`${t} tick ${_t} p ${fmt(s.pos)} v ${fmt(s.vel)} g ${s.onGround} w ${s.inWater} ch ${s.collidedHorizontally} | ${JSON.stringify(bot.loop.command)}`));
    });
    const plan = bot.skills.nav.plan({ type: 'block', p: goal }, from);
    const res = await bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks: 1500 });
    await bot.loop.waitTicks(10);
    off();
    tr.stop();
    const got = bot.corrections.slice(before);
    if (TRACE && got.length) console.log(`[nav-swim trace] ${label}\n${trace.join('\n')}`);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    const truth = await bot.truth.pos(bot.name);
    const health = (truth as unknown as { health: number | null }).health;
    const m = plan ? plan.path.map((n) => n.move) : [];
    const line =
      `${label}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, plan ${plan?.status ?? 'none'} (swim ${m.filter((x) => x === 'swim').length}, swimOut ${m.filter((x) => x === 'swimOut').length}), ` +
      `in water ${wetTicks} ticks (first ${firstWet}, last ${lastWet}), min health ${minHealth}, truth health ${health}, ${got.length} correction(s), stuck ${rep.stuck}, end ${fmt(td.local)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`;
    summary.push(line);
    return { res, rep, tr, got, td, m, minHealth, health, wetTicks, firstWet, lastWet, line };
  }

  it('crosses a 6-wide river: walks in, swims on the surface, climbs out; 0 corrections, no damage', async () => {
    const r = await swim('river 6 wide', { x: o.x + 10.5, y: -60, z: o.z + 2.5 }, { x: o.x + 10, y: -60, z: o.z + 17 });
    if (TRACE) for (let z = o.z + 11; z <= o.z + 14; z++) console.log(`[blocks] z ${z}: ${[-63, -62, -61, -60, -59].map((y) => `${y}:${bot.world.blockAt({ x: o.x + 10, y, z })?.name}/${JSON.stringify(bot.world.blockAt({ x: o.x + 10, y, z })?.states)}`).join(" ")}`);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.m).toContain('swim');
    expect(r.m).toContain('swimOut');
    expect(r.wetTicks).toBeGreaterThan(20);
    expect(r.got.length, r.line).toBe(0);
    expect(r.minHealth).toBe(20);
    expect(r.health).toBe(20);
    expect(Math.abs(r.td.local.y - -60)).toBeLessThan(1e-3);
  }, 120_000);

  it('swims an 18-block lane: ticks per block vs the swim cost', async () => {
    const r = await swim('lane 18', { x: o.x + 31.5, y: -60, z: o.z - 2.5 }, { x: o.x + 31, y: -60, z: o.z + 19 });
    expect(r.res, r.line).toEqual({ ok: true });
    // steady part: from z o+3 to z o+14 (11 blocks) on the surface
    const a = r.tr.path.findIndex((p) => p.z >= o.z + 3);
    const b = r.tr.path.findIndex((p) => p.z >= o.z + 14);
    const perBlock = (b - a) / 11;
    summary.push(`lane 18: ${perBlock.toFixed(2)} ticks per block swimming (z +3..+14), table swim ${DEFAULT_COSTS.swim}; whole water stretch ${r.lastWet - r.firstWet} ticks for 18 blocks`);
    expect(r.got.length, r.line).toBe(0);
    expect(perBlock).toBeGreaterThan(DEFAULT_COSTS.swim * 0.6);
    expect(perBlock).toBeLessThan(DEFAULT_COSTS.swim * 1.6);
  }, 120_000);

  it('wades a 1-deep ditch', async () => {
    const r = await swim('ditch 1 deep', { x: o.x + 43.5, y: -60, z: o.z + 2.5 }, { x: o.x + 43, y: -60, z: o.z + 10 });
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.got.length, r.line).toBe(0);
    expect(r.minHealth).toBe(20);
  }, 120_000);
});
