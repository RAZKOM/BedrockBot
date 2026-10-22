// e2e (tag @bds), PLAN.md task 7.1: the tick cost table (nav/costs.ts) against bds-move. Measures
// ticks per block on 50-block straight runs (walking and sprinting, steady part between blocks 10
// and 40), ticks per step on a 1-block staircase, and the time of 1- and 3-block drops, and compares
// them with the costs the planner uses. Asserts only loose bounds; the numbers go to the summary
// (docs/pathfinding.md "Measured").
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_COSTS, TICKS, dropCost } from '../../src/skills/nav/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, buildLayout, connectBot, disconnectBot, teleport, type MoveBot } from './move-truth.ts';
import { privateOrigin, trackBody, type Fill, type Layout } from './nav-worlds.ts';

describe.skipIf(!E2E)('@bds nav v2: tick costs vs the server (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });
  // runway x o.x .. o.x + 2, z o.z .. o.z + 60; staircase x o.x + 10, 6 steps; drops at x o.x + 20
  const fills: Fill[] = [
    f(o.x - 4, -63, o.z - 4, o.x + 30, -62, o.z + 64, 'dirt'),
    f(o.x - 4, -61, o.z - 4, o.x + 30, -61, o.z + 64, 'grass_block'),
    f(o.x - 4, -60, o.z - 4, o.x + 30, -45, o.z + 64, 'air'),
  ];
  for (let i = 0; i < 6; i++) fills.push(f(o.x + 9, -60, o.z + 5 + i, o.x + 11, -60 + i, o.z + 5 + i, 'stone'));
  fills.push(f(o.x + 9, -60, o.z + 11, o.x + 11, -55, o.z + 14, 'stone'));
  // ledge for drops: feet -57 platform, 3-block drop to the ground; a 1-block step-down platform
  fills.push(f(o.x + 19, -60, o.z, o.x + 21, -58, o.z + 6, 'stone'));
  fills.push(f(o.x + 25, -60, o.z, o.x + 27, -60, o.z + 6, 'stone'));
  const layout: Layout = { name: 'costs', anchor: { x: o.x + 10.5, y: -60, z: o.z + 30.5 }, fills };

  beforeAll(async () => {
    bot = await connectBot('NavCosts');
    await buildLayout(bot, layout);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-costs e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  /** Ticks per block between z0 and z1 of a recorded path. */
  function ticksPerBlock(path: Vec3[], z0: number, z1: number): number {
    const a = path.findIndex((p) => p.z >= z0);
    const b = path.findIndex((p) => p.z >= z1);
    return (b - a) / (path[b]!.z - path[a]!.z);
  }

  for (const sprint of [false, true]) {
    it(`${sprint ? 'sprints' : 'walks'} 50 blocks: ticks per block vs the cost table`, async () => {
      await teleport(bot, { x: o.x + 1.5, y: -60, z: o.z + 0.5 }, 0);
      const tr = trackBody(bot);
      const res = await bot.skills.goto({ type: 'block', p: { x: o.x + 1, y: -60, z: o.z + 50 } }, { sprint });
      tr.stop();
      const rep = bot.skills.status().lastGoto!;
      const tpb = ticksPerBlock(tr.path, o.z + 10, o.z + 40);
      const table = sprint ? TICKS.sprint : TICKS.walk;
      summary.push(`${sprint ? 'sprint' : 'walk'} 50: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks (whole run ${(rep.ticks / 50).toFixed(3)} ticks/block), steady ${tpb.toFixed(3)} ticks/block, table ${table.toFixed(3)}, sprint ticks ${rep.sprintTicks}`);
      expect(res).toEqual({ ok: true });
      expect(Math.abs(tpb - table)).toBeLessThan(0.25);
    }, 60_000);
  }

  it('climbs a 6-step staircase: ticks per step vs the jump cost', async () => {
    await teleport(bot, { x: o.x + 10.5, y: -60, z: o.z + 1.5 }, 0);
    const tr = trackBody(bot);
    const res = await bot.skills.goto({ type: 'block', p: { x: o.x + 10, y: -54, z: o.z + 12 } });
    tr.stop();
    // first and last landing on a step (feet rises by 1 at each)
    const firstStep = tr.path.findIndex((p) => p.y >= -59 - 1e-3);
    const lastStep = tr.path.findIndex((p) => p.y >= -54 - 1e-3);
    const perStep = (lastStep - firstStep) / 5;
    summary.push(`stairs 6: ${res.ok ? 'ok' : JSON.stringify(res)} in ${bot.skills.status().lastGoto!.ticks} ticks, ${perStep.toFixed(2)} ticks per step (landing to landing), table jump ${DEFAULT_COSTS.jump}`);
    expect(res).toEqual({ ok: true });
    expect(perStep).toBeLessThan(DEFAULT_COSTS.jump * 2);
  }, 60_000);

  it('drops 3 blocks and 1 block: ticks vs the drop cost', async () => {
    const drops: string[] = [];
    for (const [label, from, to, blocks] of [
      ['3', { x: o.x + 20.5, y: -57, z: o.z + 3.5 }, { x: o.x + 20, y: -60, z: o.z + 9 }, 3],
      ['1', { x: o.x + 26.5, y: -59, z: o.z + 3.5 }, { x: o.x + 26, y: -60, z: o.z + 9 }, 1],
    ] as const) {
      await teleport(bot, from, 0);
      const tr = trackBody(bot);
      const res = await bot.skills.goto({ type: 'block', p: to }, { sprint: false });
      tr.stop();
      // from the last tick at the edge cell (z < edge) on the upper level to the landing
      const edge = o.z + 7;
      const leave = tr.path.findIndex((p) => p.z >= edge - 0.5);
      const land = tr.path.findIndex((p) => Math.abs(p.y - -60) < 1e-3);
      drops.push(`drop ${label}: ${res.ok ? 'ok' : JSON.stringify(res)}, ${land - leave} ticks from 0.5 before the edge to the landing, table ${dropCost({ ...DEFAULT_COSTS, walk: TICKS.walk }, blocks).toFixed(1)} (fall ${TICKS.fall[blocks]})`);
      expect(res).toEqual({ ok: true });
    }
    summary.push(drops.join('; '));
  }, 60_000);
});
