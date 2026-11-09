// e2e (tag @bds), Track R2 (docs/pathfinding.md "Reachability (Track R1)", its R2 part; decisions/0072-reachability.md
// "R2"): the owner's walking settings with allowPlace on (allowBreak and allowPlace on, digPenalty 500, sprint; live
// until 2026-11-09, allowPlace off since: these scenarios need a pillar, so they keep it on) where only a pillar
// climbs, on bds-fly (udp 19204; REACH_BDS_PORT / REACH_BDS_CONTAINER move it). Built with truth:fill on the flat world at a private origin (MOVE_AREA pins it):
//   plateau  a stone-brick block 5 x 5, 6 high (built blocks: no stair is dug up it): the goal on its top, reached by
//            a pillar against its side, 3 runs
//   walled   a bedrock ring 11 x 11, 20 high, on bedrock ground, the goal inside: the only way in is up the
//            outside on a pillar and a 20-block fall inside. Unreachable, `rule:falls` naming the fall (the ring is built over
//            the column's sent sections: the column top reads it, Track R2), and the body is never left on a
//            pillar's top (back on the ground), 3 runs
// Every run starts from the same ground cell with a pickaxe and 64 dirt; NAV_PILLAR_OUT=<file> writes the summary.
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { bdsTarget } from './env.ts';
import { E2E, connectBot, disconnectBot, fmt, sleep, teleport, type MoveBot } from './move-truth.ts';
import { privateOrigin } from './nav-worlds.ts';

const PORT = Number(process.env.REACH_BDS_PORT ?? 19204);
const CONTAINER = process.env.REACH_BDS_CONTAINER ?? 'bds-fly';
const TARGET = bdsTarget('127.0.0.1', PORT);
const RUNS = Number(process.env.NAV_PILLAR_RUNS ?? 3);
const FEET = -60;

describe.skipIf(!E2E)('@bds nav: pillars with the live settings (Track R2, bds-fly)', () => {
  let bot: MoveBot;
  const o = { ...privateOrigin(), y: FEET };
  const summary: string[] = [];
  const at = (dx: number, dy: number, dz: number): Vec3 => ({ x: o.x + dx, y: FEET + dy, z: o.z + dz });
  const fill = async (a: Vec3, b: Vec3, block: string): Promise<void> => {
    for (let i = 0; ; i++) {
      const r = await bot.truth.cmd('fill', [a.x, a.y, a.z, b.x, b.y, b.z, block], 30_000);
      if (r.ok) return;
      if (i >= 10) throw new Error(`truth:fill ${block}: ${r.reason}`);
      await sleep(300);
    }
  };
  // the plateau at x 0..4, the walled yard at x 20..30 (inside 21..29), the start on the ground west of both
  const start = at(-6, 0, 2);
  const plateauGoal = at(2, 6, 2);
  const yardGoal = at(25, 0, 5);

  async function build(clear: boolean): Promise<void> {
    await fill(at(-8, 0, -4), at(34, 24, 14), 'air');
    if (clear) {
      await fill(at(-8, -3, -4), at(34, -2, 14), 'dirt');
      await fill(at(-8, -1, -4), at(34, -1, 14), 'grass');
      return;
    }
    await fill(at(0, 0, 0), at(4, 5, 4), 'stone_bricks');
    // the ground round the yard bedrock too (the "why" search, digging for free, would comb a dirt floor for a way under)
    await fill(at(-8, -3, -4), at(34, -1, 14), 'bedrock');
    await fill(at(20, -4, 0), at(30, 19, 10), 'bedrock');
    await fill(at(21, 0, 1), at(29, 19, 9), 'air');
  }

  beforeAll(async () => {
    bot = await connectBot('NavPillar', { target: TARGET, container: CONTAINER });
    await teleport(bot, { x: start.x + 0.5, y: start.y, z: start.z + 0.5 });
    await build(false);
    bot.skills.nav.setDigPenalty(() => 500);
    bot.skills.nav.digWay = () => true;
  }, 300_000);

  afterAll(async () => {
    const text = `[nav-pillar e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`;
    console.log(text);
    if (process.env.NAV_PILLAR_OUT) writeFileSync(process.env.NAV_PILLAR_OUT, text);
    try {
      if (bot) {
        await teleport(bot, { x: start.x + 0.5, y: start.y, z: start.z + 0.5 });
        await build(true);
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 300_000);

  /** One `!goto` as the session runs it with the live settings, from the start cell with a pickaxe and 64 dirt. */
  async function run(name: string, goal: Vec3) {
    await bot.truth.cmd('clear', [bot.name]);
    await bot.truth.cmd('give', [bot.name, 'iron_pickaxe', 1]);
    await bot.truth.cmd('give', [bot.name, 'dirt', 64]);
    await teleport(bot, { x: start.x + 0.5, y: start.y, z: start.z + 0.5 });
    await bot.loop.waitTicks(10);
    const detach = bot.skills.nav.attachPlanner(bot.world, { threads: () => 1 });
    await sleep(1500);
    try {
      let minHealth = bot.world.self.health;
      const off = bot.loop.onBeforeStep(() => {
        minHealth = Math.min(minHealth, bot.world.self.health);
      });
      const res = await bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks: 3000, explain: true, allowBreak: true, allowPlace: true, sprint: true });
      await bot.loop.waitTicks(20);
      off();
      const rep = bot.skills.status().lastGoto!;
      const truth = await bot.truth.pos(bot.name);
      const line = `${name}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, ${rep.plans.length} plan(s), placed ${rep.actions.place}, broken ${rep.actions.dig}, min health ${minHealth}, end ${fmt(truth.location)}`;
      summary.push(line, `  plans ${rep.plans.map((p) => `${p.reason}:${p.status}:${p.expanded}:${Math.round(p.ms)}ms`).join(' ')}`);
      return { res, rep, minHealth, truth, line };
    } finally {
      detach();
      // the run's own pillar blocks away before the next run
      await build(false);
    }
  }

  it(`plateau: the goal on a 6-high block of built blocks is reached by a pillar against its side, ${RUNS} runs`, async () => {
    for (let i = 1; i <= RUNS; i++) {
      const r = await run(`plateau ${i}`, plateauGoal);
      expect(r.res, r.line).toEqual({ ok: true });
      expect(Math.abs(r.truth.location.y - plateauGoal.y), r.line).toBeLessThan(0.6);
      expect(r.rep.actions.place, r.line).toBeGreaterThan(0);
      expect(r.minHealth, r.line).toBe(20);
    }
  }, 900_000);

  it(`walled: the yard behind a 20-high bedrock ring is unreachable, the body back on the ground, ${RUNS} runs`, async () => {
    for (let i = 1; i <= RUNS; i++) {
      const r = await run(`walled ${i}`, yardGoal);
      expect(r.res.ok, r.line).toBe(false);
      expect(r.res, r.line).toMatchObject({ reason: 'unreachable' });
      // the cause names the fall (before the column-top fix the pillar rule saw no ring and the "why" search ran out: `budget`)
      expect(r.res, r.line).toMatchObject({ cause: 'rule:falls' });
      expect((r.res as { note?: string }).note, r.line).toMatch(/^rule falls: a [\d.]+-block fall \([\d.]+ HP\) over the fall budget of [\d.]+ HP$/);
      expect(r.truth.location.y, r.line).toBeLessThan(FEET + 1.5); // never left on a pillar's top
      expect(r.minHealth, r.line).toBe(20);
    }
  }, 900_000);
});
