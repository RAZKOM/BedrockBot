// e2e (tag @bds), PLAN.md task 7.12: a goto 300 blocks into terrain the bot has seen but that is no
// longer loaded (bds-cache, generated world, seed 7). The bot first hops along the line (so the columns
// load and the cache remembers them), then stands at the start, 300 blocks from the goal: the columns
// near the goal are unloaded and only cached. Gates: the first plan, made before any new column
// arrives, is longer than 250 nodes (it plans through the cached terrain); the bot arrives; it never
// stands in a column that is not loaded. Natural terrain can make a line unwalkable (lakes, cliffs):
// an area whose cached plan is not `found`, or climbs more than 24 blocks (mountains), is replaced by
// another random one (up to 14).
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPath, locateNode } from '../../src/skills/nav/astar.ts';
import type { Goal } from '../../src/skills/nav/goals.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, cacheDir, connectCacheBot, disconnectCacheBot, fmt, hdist, hop, privateArea, removeDirs, settleChunks, standNear, nearestLand, type CacheBot } from './cache-truth.ts';

const DIST = 300;
/** Random areas tried until one is walkable through the cached terrain (oceans and cliffs are common on seed 7). */
const ATTEMPTS = 14;
/** Largest height range of the cached plan accepted for the walk. */
const MAX_Y_RANGE = 24;
const MAIN_MS = Number(process.env.CACHE_MAIN_MS ?? 600);
const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

describe.skipIf(!E2E)('@bds world cache: goto 300 blocks into cached terrain (bds-cache)', () => {
  let bot: CacheBot;
  const dir = cacheDir('nav');
  const summary: string[] = [];

  beforeAll(async () => {
    // a long first plan needs a bigger main budget than the default 40 ms (about 5 000 expansions; a
    // 300-block plan over natural terrain expands 30 000 to 300 000): 600 ms sliced over the ticks
    bot = await connectCacheBot('CacheNav', { dir, nav: { mainMs: MAIN_MS, segmentNodes: 150_000 } });
  }, 120_000);

  afterAll(async () => {
    console.log(`[cache-nav e2e]\n  ${summary.join('\n  ')}`);
    await disconnectCacheBot(bot);
    removeDirs();
  });

  it('plans through cached terrain (> 250 nodes before any new chunk) and arrives', async () => {
    let start: Vec3 | undefined;
    let goal: Vec3 | undefined;
    let plan: ReturnType<typeof findPath> | undefined;
    for (let attempt = 0; attempt < ATTEMPTS && !goal; attempt++) {
      const a = privateArea();
      const [dx, dz] = DIRS[Math.floor(Math.random() * 4)]!;
      const g0 = { x: a.x + dx * DIST, z: a.z + dz * DIST };
      await hop(bot, g0.x, g0.z, 4);
      const g = nearestLand(bot, g0.x, g0.z, 10);
      if (!g) {
        summary.push(`attempt ${attempt}: area ${a.x},${a.z} dir ${dx},${dz}: no land at the goal`);
        continue;
      }
      for (const k of [2, 1]) await hop(bot, a.x + dx * 100 * k, a.z + dz * 100 * k, 4);
      const s = await standNear(bot, a.x, a.z);
      if (!s) {
        summary.push(`attempt ${attempt}: area ${a.x},${a.z}: no land at the start`);
        continue;
      }
      await settleChunks(bot);
      const gcx = g.x >> 4;
      const gcz = g.z >> 4;
      expect(bot.world.isLoaded(gcx, gcz)).toBe(false);
      expect(bot.cache.has(gcx, gcz)).toBe(true);
      // reachable through the cached terrain? one search with a large budget (also the measurement)
      const start0 = locateNode(bot.skills.nav.grid, bot.loop.state.pos);
      const t0 = performance.now();
      plan = start0 && findPath(bot.skills.nav.grid, start0, { type: 'block', p: g }, { ...bot.skills.nav.planOptions(), maxNodes: 600_000, maxMs: 5000 });
      const planMs = performance.now() - t0;
      const line = `attempt ${attempt}: area ${a.x},${a.z} dir ${dx},${dz}, start ${fmt(s)}, goal ${fmt(g)} (${hdist(s, g).toFixed(0)} blocks): one-go plan ${plan?.status} ${plan?.path.length} nodes, ${plan?.expanded} expanded, ${planMs.toFixed(1)} ms (search ${plan?.ms.toFixed(1)} ms), cached lookups ${bot.cache.stats.lookups}`;
      summary.push(line);
      if (plan?.status !== 'found') continue;
      // gentle terrain only: steep mountain courses are a navigator limit (stuck on terraces), not the cache's
      const ys = plan.path.map((n) => n.y);
      const yRange = Math.max(...ys) - Math.min(...ys);
      if (yRange > MAX_Y_RANGE) {
        summary.push(`attempt ${attempt}: path climbs ${yRange} blocks (> ${MAX_Y_RANGE}): too steep, next area`);
        continue;
      }
      start = s;
      goal = g;
    }
    expect(goal, `no walkable area found in ${ATTEMPTS} attempts`).toBeDefined();
    const g = goal!;

    // the goto: first plan before any new column loads, never standing in an unloaded column
    const loads0 = bot.loads.n;
    let loadsAtFirstPlan: number | undefined;
    let unloadedTicks = 0;
    let ticks = 0;
    const before = bot.corrections.length;
    const lookups0 = bot.cache.stats.lookups;
    const corr0 = bot.cache.stats.corrections;
    const cells0 = bot.cache.stats.correctionCells;
    const off = bot.loop.onBeforeStep((_t, st) => {
      ticks++;
      const rep = bot.skills.status().lastGoto;
      if (loadsAtFirstPlan === undefined && rep && rep.plans.length > 0) loadsAtFirstPlan = bot.loads.n;
      if (!bot.world.isLoaded(Math.floor(st.pos.x) >> 4, Math.floor(st.pos.z) >> 4)) unloadedTicks++;
    });
    const goalSpec: Goal = { type: 'block', p: g };
    const t0 = performance.now();
    const res = await bot.skills.goto(goalSpec, { timeoutTicks: 5000 });
    const seconds = (performance.now() - t0) / 1000;
    off();
    const rep = bot.skills.status().lastGoto!;
    const end = bot.loop.state.pos;
    const first = rep.plans[0]!;
    const reasons: Record<string, number> = {};
    for (const p of rep.plans) reasons[p.reason] = (reasons[p.reason] ?? 0) + 1;
    await bot.cache.flush();
    const files = readdirSync(dir).filter((f) => f.endsWith('.bin'));
    summary.push(
      `goto: ${res.ok ? 'ok' : JSON.stringify(res)} in ${seconds.toFixed(1)} s (${rep.ticks} ticks), start ${fmt(start!)} goal ${fmt(g)}, end ${fmt(end)}, walked ${rep.distance.toFixed(1)} blocks, ` +
        `${rep.segments} segment(s), ${rep.plans.length} plan(s) ${JSON.stringify(reasons)}, max tick ${rep.maxTickMs} ms, planner ${rep.planMs.toFixed(1)} ms, stuck ${rep.stuck}, waited for chunks ${rep.unloadedWait} ticks, ${bot.corrections.length - before} correction(s)`,
      `first plan (mainMs ${MAIN_MS}): ${first.status} ${first.nodes} nodes, ${first.expanded} expanded, ${first.ms} ms over ${first.slices} tick(s); columns loaded before it: ${(loadsAtFirstPlan ?? -1) - loads0}`,
      `cache: ${bot.cache.stats.lookups - lookups0} planner lookups during the goto, ${bot.cache.stats.corrections - corr0} cached column(s) loaded after planning, ${bot.cache.stats.correctionCells - cells0} cell(s) announced as changed; ticks in unloaded columns ${unloadedTicks} of ${ticks}`,
      `plans: ${rep.plans.map((p) => `${p.reason}@${p.tick}:${p.status}/${p.nodes}n/${p.expanded}e/${p.ms}ms`).join(' ')}`,
      `region files ${files.length}: ${files.join(' ')}; cache stats ${JSON.stringify(bot.cache.stats)}; memory ${JSON.stringify(bot.cache.info())}`,
    );
    expect(first.nodes).toBeGreaterThan(250);
    expect(loadsAtFirstPlan).toBe(loads0);
    expect(res).toEqual({ ok: true });
    expect(hdist(end, { x: g.x + 0.5, z: g.z + 0.5 })).toBeLessThan(1.5);
    expect(unloadedTicks).toBe(0);
    expect(files.length).toBeGreaterThan(0);
  }, 900_000);
});
