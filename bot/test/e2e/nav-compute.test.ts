// e2e (tag @bds), Track AB (docs/pathfinding.md "Compute", decisions/0023): the planner in a worker
// thread on bds-move. Each scenario runs with `plannerThreads` 1 (the worker) and 0 (in-thread, the
// behaviour before the worker) on the same terrain:
//   house   the nav-stairs layout's house walk (around a wall, up 2 levels of stairs, through a door):
//           one segment, 0 corrections, with either planner
//   cross   120 blocks of the cross-country course (nav-worlds.ts crossLayout: slab ramp and drop,
//           mounds, a wall with a gap, a ditch with a bridge, a cave hill): printed for both
//   walk    a goal 120 blocks away behind a cup of 3-high walls (about 250 blocks around it; the
//           straight-line heuristic makes A* flood the cup, 25 000+ nodes): the worker makes fewer
//           plans and no partial segments; both runs are printed
//   hard    a sealed cell 100 blocks away with allowPlace (pillar moves make the search space huge):
//           the worker searches 300 000+ nodes in a plan while the navigator's tick stays under 20 ms
// Each run builds in its own random area (privateOrigin, MOVE_AREA pins it) and clears it at the end.
// Env: MOVE_BDS_* (move-truth.ts), MOVE_SEED (course layout, default 7), MOVE_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GotoReport, PlanRecord } from '../../src/skills/nav/navigator.ts';
import type { NavGoal } from '../../src/skills/nav/goals.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, MOVE_CONTAINER, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, teleport, waitForBlock, type MoveBot } from './move-truth.ts';
import { crossLayout, privateOrigin, stairsLayout, trackBody, type Fill, type Layout } from './nav-worlds.ts';
import { consoleCommand } from './skills-truth.ts';

const SEED = Number(process.env.MOVE_SEED ?? 7);

const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });

/** Flat ground over a box (dirt, grass at -61, air from feet level to `top`). */
const clearBox = (x1: number, z1: number, x2: number, z2: number, top = -45): Fill[] => [f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, top, z2, 'air')];

/**
 * The goal 120 blocks along +x behind a cup: a 3-high wall across the line at x + 60 (z -100 .. 100)
 * with walls back towards the start at both ends (x + 20 .. 60). The way leaves the cup around a
 * corner (about 250 blocks); the straight-line heuristic makes A* flood the cup first (25 000+ nodes).
 */
function cupLayout(o: { x: number; z: number }) {
  // two halves (z < 0, z >= 0), each built from its own anchor: the truth pack edits loaded chunks only
  const halves = ([-1, 1] as const).map((s) => {
    const z0 = s < 0 ? o.z - 104 : o.z;
    const z1 = s < 0 ? o.z - 1 : o.z + 104;
    const fills: Fill[] = clearBox(o.x - 6, z0, o.x + 126, z1, -55);
    fills.push(f(o.x + 60, -60, Math.max(z0, o.z - 100), o.x + 60, -58, Math.min(z1, o.z + 100), 'stone'));
    fills.push(f(o.x + 20, -60, o.z + s * 100, o.x + 60, -58, o.z + s * 100, 'stone'));
    const layout: Layout = { name: 'cup', anchor: { x: o.x + 60.5, y: -60, z: o.z + s * 52 + 0.5 }, fills };
    return { layout, cleanup: clearBox(o.x - 6, z0, o.x + 126, z1, -50) };
  });
  return { halves, start: { x: o.x + 0.5, y: -60, z: o.z + 0.5 }, goal: { x: o.x + 120, y: -60, z: o.z } };
}

interface Run {
  label: string;
  ok: boolean;
  rep: GotoReport;
  /** Searches (a worker main plan's interim answer and its final answer are one). */
  plans: number;
  /** Final answers that were partial (segments that ended before the goal). */
  partial: number;
  corrections: number;
  /** Longest gap between two physics ticks (event-loop stalls show up here), ms. */
  maxGap: number;
  seconds: number;
  line: string;
}

const planLine = (p: PlanRecord): string =>
  `${p.reason}${p.interim ? '(interim)' : p.upgrade ? '(final)' : ''}@${p.tick}:${p.status}/${p.nodes}n/${p.expanded}e/${p.ms}ms/${p.slices}t/${p.via ?? '?'}${p.limited ? '/limit' : ''}`;

describe.skipIf(!E2E)('@bds nav: planner compute, worker thread vs in-thread (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const S = stairsLayout(o);
  const oc = { x: o.x, z: o.z + 64 };
  const C = crossLayout(oc, SEED);
  const B = cupLayout({ x: o.x + 320, z: o.z });
  /** The sealed cell: a 3 x 4 x 3 stone shell 100 blocks along the course, off its centre line. */
  const box = { x: oc.x, y: -60, z: oc.z + 13 };
  const boxFills: Fill[] = [f(box.x - 1, -61, box.z - 1, box.x + 1, -58, box.z + 1, 'stone'), f(box.x, -60, box.z, box.x, -59, box.z, 'air')];
  let threads = 1;
  let detach: (() => void) | undefined;

  beforeAll(async () => {
    bot = await connectBot('NavComp');
    detach = bot.skills.nav.attachPlanner(bot.world, { threads: () => threads });
    await buildLayout(bot, S.layout);
    for (const c of S.stateFills) {
      await consoleCommand(MOVE_CONTAINER, 'fill', ...[c.from.x, c.from.y, c.from.z, c.to.x, c.to.y, c.to.z].map(String), c.block, ...(c.states ? [c.states] : []));
    }
    const last = S.stateFills.at(-1)!;
    await waitForBlock(bot, last.to, last.block, 10_000);
    await buildLayout(bot, { ...C.layout, fills: [...C.layout.fills, ...boxFills] });
    for (const h of B.halves) await buildLayout(bot, h.layout);
    await bot.truth.cmd('give', [bot.name, 'cobblestone', 64]);
    await bot.loop.waitTicks(10);
  }, 400_000);

  afterAll(async () => {
    const st = bot?.skills.nav.planner?.stats;
    if (st) summary.push(`worker: ${JSON.stringify(st)}`);
    console.log(`[nav-compute e2e] area ${o.x},${o.z} seed ${SEED}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        bot.skills.cancel();
        await teleport(bot, S.layout.anchor);
        for (const c of S.cleanup) await bot.truth.fill(c.from, c.to, c.block);
        await teleport(bot, C.layout.anchor);
        // the course area (and anything pillared on it) back to the flat world
        for (const c of clearBox(oc.x - 106, oc.z - 14, oc.x + 106, oc.z + 14, -30)) await bot.truth.fill(c.from, c.to, c.block);
        for (const h of B.halves) {
          await teleport(bot, h.layout.anchor);
          for (const c of h.cleanup) await bot.truth.fill(c.from, c.to, c.block);
        }
      }
    } finally {
      detach?.();
      await disconnectBot(bot);
    }
  }, 240_000);

  async function run(label: string, from: Vec3, goal: NavGoal, opts: { allowPlace?: boolean; timeoutTicks?: number } = {}): Promise<Run> {
    await teleport(bot, from, -90);
    // the worker plans once it runs and has the loaded columns (until then the navigator plans in-thread)
    for (let i = 0; i < 100 && threads > 0 && !bot.skills.nav.planner?.ready; i++) await bot.loop.waitTicks(2);
    const before = bot.corrections.length;
    const tr = trackBody(bot);
    let last = 0;
    let maxGap = 0;
    const off = bot.loop.onBeforeStep(() => {
      const now = performance.now();
      if (last) maxGap = Math.max(maxGap, now - last);
      last = now;
    });
    const t0 = performance.now();
    const res = await bot.skills.goto(goal, { timeoutTicks: opts.timeoutTicks ?? 3000, ...(opts.allowPlace ? { allowPlace: true } : {}) });
    const seconds = (performance.now() - t0) / 1000;
    await bot.loop.waitTicks(10);
    off();
    tr.stop();
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    const finals = rep.plans.filter((p) => !p.interim);
    const partial = finals.filter((p) => p.status === 'partial' && p.nodes > 1).length;
    const hits = finals.filter((p) => p.limited).length;
    const line =
      `${label} (plannerThreads ${threads}): ${res.ok ? 'ok' : JSON.stringify(res)} in ${seconds.toFixed(1)} s (${rep.ticks} ticks), walked ${rep.distance.toFixed(1)} blocks, ` +
      `${finals.length} plan(s) (+${rep.plans.length - finals.length} interim), ${rep.segments} segment(s), ${partial} partial, ${hits} hit a budget, ${rep.upgrades ?? 0} upgrade(s), ${rep.stale ?? 0} stale, ` +
      `planner ${rep.planMs.toFixed(1)} ms, max tick ${rep.maxTickMs} ms, max tick gap ${maxGap.toFixed(1)} ms, stuck ${rep.stuck}, ${got.length} correction(s), end ${fmt(bot.loop.state.pos)}${describeCorrections(got)}\n    plans: ` +
      rep.plans.map(planLine).join(' ');
    summary.push(line);
    return { label, ok: res.ok, rep, plans: finals.length, partial, corrections: got.length, maxGap, seconds, line };
  }

  it("the owner's house (nav-stairs layout): one segment, 0 corrections, worker and in-thread", async () => {
    const d = S.house.door;
    const runs: Run[] = [];
    for (const t of [1, 0]) {
      threads = t;
      for (const [dy, upper] of [
        [0, false],
        [1, true],
      ] as const)
        await consoleCommand(MOVE_CONTAINER, 'setblock', String(d.x), String(d.y + dy), String(d.z), 'wooden_door', `["minecraft:cardinal_direction"="south","upper_block_bit"=${upper},"open_bit"=false]`);
      await bot.loop.waitTicks(10);
      runs.push(await run('house', S.house.start, { type: 'block', p: S.house.goal }));
    }
    expect(runs[0]!.rep.plans.every((p) => p.via === 'worker'), runs[0]!.line).toBe(true);
    expect(runs[1]!.rep.plans.every((p) => p.via === 'thread'), runs[1]!.line).toBe(true);
    for (const r of runs) {
      expect(r.ok, r.line).toBe(true);
      expect(r.rep.segments, r.line).toBe(1);
      expect(r.corrections, r.line).toBe(0);
    }
  }, 120_000);

  it('120 blocks of the cross-country course, worker and in-thread', async () => {
    const goal: NavGoal = { type: 'block', p: { x: C.start.x - 0.5 + 120, y: -60, z: C.start.z - 0.5 } };
    for (const t of [1, 0]) {
      threads = t;
      const r = await run('cross 120', C.start, goal);
      expect(r.ok, r.line).toBe(true);
      expect(r.corrections, r.line).toBe(0);
    }
  }, 240_000);

  it('a 120-block walk out of a cup: fewer plans and no partial segments with the worker', async () => {
    const goal: NavGoal = { type: 'block', p: B.goal };
    const runs: Run[] = [];
    for (const t of [1, 0]) {
      threads = t;
      runs.push(await run('walk 120 (cup)', B.start, goal));
    }
    const [w, i] = runs as [Run, Run];
    // the worker gets out of the cup; in-thread (40 ms / 20 000-node budgets) walks into it and, measured
    // on bds-move, ends `unreachable` after 5 plans that all hit their budget (only printed: it may get lucky)
    expect(w.ok, w.line).toBe(true);
    for (const r of runs) expect(r.corrections, r.line).toBe(0);
    expect(w.plans, `${w.line}\n${i.line}`).toBeLessThan(i.plans);
    expect(w.partial, w.line).toBe(0);
    expect(i.partial, i.line).toBeGreaterThan(0);
  }, 300_000);

  it('a 300 000-node search in the worker keeps the tick under 20 ms (sealed cell 100 blocks away, allowPlace)', async () => {
    const runs: Run[] = [];
    for (const t of [1, 0]) {
      threads = t;
      runs.push(await run('hard goal', C.start, { type: 'block', p: box }, { allowPlace: true, timeoutTicks: 1200 }));
      bot.skills.cancel();
    }
    const [w, i] = runs as [Run, Run];
    expect(w.ok, w.line).toBe(false);
    expect(i.ok, i.line).toBe(false);
    const big = Math.max(...w.rep.plans.map((p) => p.expanded));
    expect(big, w.line).toBeGreaterThanOrEqual(300_000);
    expect(w.rep.maxTickMs, w.line).toBeLessThan(20);
  }, 300_000);
});
