// e2e (tag @bds), Track BA: partial-path selection (Baritone's coefficient bests, nav/baritone/bestSoFar.ts).
// A truth-built 3-high U wall (base 20 wide across the line, arms 10 long, open away from the start)
// stands between the start and a goal 30 blocks out; the navigator's node budget (`path.maxNodes`,
// a NavigatorOptions field) is forced to 100 so the first plan is partial and ends at the wall's
// base. The bot must get round and reach the goal, with the planner worker and in-thread. Main's
// scoring (the lowest straight-line distance) gave up there: the plans from the wall's base found no
// node closer than the base within 100 nodes ("no progress", 3 failures, unreachable).
// Each run builds in its own random area (privateOrigin, MOVE_AREA pins it) and clears it at the end.
// Env: MOVE_BDS_* (move-truth.ts), PARTIAL_NODES (the forced node budget, default 100), MOVE_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import { BotSkills } from '../../src/skills/index.ts';
import { InputLoop, flatWorld, type CorrectionEvent, type InputLoopEvent } from '../../src/skills/input/index.ts';
import type { GotoReport, PlanRecord } from '../../src/skills/nav/navigator.ts';
import { World } from '../../src/world/index.ts';
import { Containers } from '../../src/world/containers.ts';
import { Hotbar } from '../../src/world/hotbar.ts';
import { E2E_VERSION } from './env.ts';
import { E2E, MOVE_CONTAINER, MOVE_TARGET, VERBOSE, buildLayout, describeCorrections, disconnectBot, fmt, hdist, prepareServer, teleport, uniqueName, type MoveBot } from './move-truth.ts';
import { privateOrigin, type Fill, type Layout } from './nav-worlds.ts';
import { Truth } from './skills-truth.ts';

const NODES = Number(process.env.PARTIAL_NODES ?? 100);

const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });
const clearBox = (x1: number, z1: number, x2: number, z2: number, top = -50): Fill[] => [f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, top, z2, 'air')];

/** The U: base across x + 12 (z - 10 .. + 9), arms along z - 10 and z + 9 to x + 21; start (x, z), goal (x + 30, z). */
function uLayout(o: { x: number; z: number }) {
  const fills: Fill[] = [...clearBox(o.x - 6, o.z - 16, o.x + 36, o.z + 16), f(o.x + 12, -60, o.z - 10, o.x + 12, -58, o.z + 9, 'stone'), f(o.x + 12, -60, o.z - 10, o.x + 21, -58, o.z - 10, 'stone'), f(o.x + 12, -60, o.z + 9, o.x + 21, -58, o.z + 9, 'stone')];
  const layout: Layout = { name: 'u-wall', anchor: { x: o.x + 4.5, y: -60, z: o.z + 0.5 }, fills };
  return { layout, cleanup: clearBox(o.x - 6, o.z - 16, o.x + 36, o.z + 16), start: { x: o.x + 0.5, y: -60, z: o.z + 0.5 }, goal: { x: o.x + 30, y: -60, z: o.z } };
}

/** connectBot (move-truth.ts) with a forced node budget: NavigatorOptions `path.maxNodes` (every plan, worker and in-thread). */
async function connectWithBudget(prefix: string, maxNodes: number): Promise<MoveBot> {
  await prepareServer();
  const name = uniqueName(prefix);
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
  const world = new World(conn, { version: E2E_VERSION, logger: silentLogger });
  const loop = new InputLoop(conn, { world: flatWorld(), logger: VERBOSE ? createLogger('info', 'input') : silentLogger });
  const hotbar = new Hotbar(conn, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
  const containers = new Containers(conn, world.inventory);
  const skills = new BotSkills({ loop, world, hotbar, containers, source: conn, logger: VERBOSE ? createLogger('debug', 'nav') : silentLogger, path: { maxNodes } });
  const truth = new Truth(conn, MOVE_CONTAINER);
  const corrections: CorrectionEvent[] = [];
  const events: InputLoopEvent[] = [];
  loop.onEvent((e) => {
    events.push(e);
    if (e.kind === 'correction') corrections.push(e);
  });
  loop.start();
  await conn.connect(MOVE_TARGET);
  await world.waitForChunks(4, { timeoutMs: 30_000 });
  await loop.waitTicks(10);
  return { name, conn, world, loop, skills, hotbar, truth, corrections, events };
}

const planLine = (p: PlanRecord): string => `${p.reason}${p.interim ? '(interim)' : p.upgrade ? '(final)' : ''}@${p.tick}:${p.status}/${p.nodes}n/${p.expanded}e/${p.via ?? '?'}${p.limited ? '/limit' : ''}`;

/** Re-plans after a stuck event, a move timeout, the end of a partial segment, or a failed plan ("no progress"). */
const replans = (rep: GotoReport): number => rep.plans.filter((p) => p.reason === 'stuck' || p.reason === 'timeout' || p.reason === 'partial' || p.reason === 'retry').length;

describe.skipIf(!E2E)('@bds nav: partial paths round a U wall with a tiny node budget (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const U = uLayout(o);
  let threads = 1;
  let detach: (() => void) | undefined;

  beforeAll(async () => {
    bot = await connectWithBudget('NavPart', NODES);
    detach = bot.skills.nav.attachPlanner(bot.world, { threads: () => threads });
    await buildLayout(bot, U.layout);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-partial e2e] area ${o.x},${o.z}, node budget ${NODES}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        bot.skills.cancel();
        await teleport(bot, U.layout.anchor);
        for (const c of U.cleanup) await bot.truth.fill(c.from, c.to, c.block);
      }
    } finally {
      detach?.();
      await disconnectBot(bot);
    }
  }, 120_000);

  for (const t of [1, 0]) {
    it(`reaches the goal behind the U (plannerThreads ${t}); the first plan is partial`, async () => {
      threads = t;
      await teleport(bot, U.start, -90);
      for (let i = 0; i < 100 && threads > 0 && !bot.skills.nav.planner?.ready; i++) await bot.loop.waitTicks(2);
      const before = bot.corrections.length;
      const res = await bot.skills.goto({ type: 'block', p: U.goal }, { timeoutTicks: 1500, sprint: false });
      await bot.loop.waitTicks(10);
      const got = bot.corrections.slice(before);
      const rep = bot.skills.status().lastGoto!;
      const line =
        `plannerThreads ${t}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks (straight ${hdist(U.start, U.goal).toFixed(1)}), ` +
        `${rep.segments} segment(s), re-plans (stuck / timeout / partial / retry) ${replans(rep)}, stuck ${rep.stuck}, failures ${rep.failures}, ${got.length} correction(s), ` +
        `end ${fmt(bot.loop.state.pos)}${describeCorrections(got)}\n    plans: ${rep.plans.map(planLine).join(' ')}`;
      summary.push(line);
      expect(res, line).toEqual({ ok: true });
      const first = rep.plans.find((p) => !p.interim)!;
      expect(first.status, line).toBe('partial');
      expect(first.limited, line).toBe(true);
      expect(rep.stuck, line).toBe(0);
      expect(got.length, line).toBeLessThanOrEqual(2);
    }, 150_000);
  }
});
