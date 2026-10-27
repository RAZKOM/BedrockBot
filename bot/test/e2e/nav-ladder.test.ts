// e2e (tag @bds), Track AJ (PLAN.md task 7.7, docs/pathfinding.md "Movement variety"): ladders and
// vines on bds-move. A 10-high stone tower with a 1 x 1 shaft and a ladder on the shaft's north wall:
// the bot walks in through a tunnel at the foot, climbs the ladder (jump held: 0.2 blocks per tick),
// steps off at the top onto the block behind the ladder, then comes back: steps off the top edge over
// the shaft (the slide stops on the ladder), slides down and walks out. A 10-high wall with vines on
// its face is climbed the same way. 0 corrections; climb speed up and down measured. Each run builds in
// its own random area (nav-worlds.ts privateOrigin, MOVE_AREA pins it) and restores the flat world.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_COSTS } from '../../src/skills/nav/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, MOVE_CONTAINER, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, teleport, truthDiff, waitForBlock, type MoveBot } from './move-truth.ts';
import { privateOrigin, trackBody, type Fill, type Layout } from './nav-worlds.ts';
import { consoleCommand } from './skills-truth.ts';

/** NAV_TRACE=1: print the per-tick body state and command of a goto that got corrections. */
const TRACE = process.env.NAV_TRACE === '1';
const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });

describe.skipIf(!E2E)('@bds nav: ladders and vines (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const flat = (x1: number, z1: number, x2: number, z2: number): Fill[] => [f(x1, -64, z1, x2, -64, z2, 'bedrock'), f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, -45, z2, 'air')];
  // tower x o..o+4, z o+4..o+8, y -60..-51 (top feet -50); shaft (o+2, o+6); tunnel (o+2, -60..-59, o+7..o+8)
  // vine wall x o+10..o+14, z o+5..o+8, y -60..-51; vines on its north face at (o+12, -60..-51, o+4)
  const shaft = { x: o.x + 2, z: o.z + 6 };
  const fills: Fill[] = [
    ...flat(o.x - 4, o.z - 2, o.x + 18, o.z + 16),
    f(o.x, -60, o.z + 4, o.x + 4, -51, o.z + 8, 'stone'),
    f(shaft.x, -60, shaft.z, shaft.x, -51, shaft.z, 'air'),
    f(shaft.x, -60, o.z + 7, shaft.x, -59, o.z + 8, 'air'),
    f(o.x + 10, -60, o.z + 5, o.x + 14, -51, o.z + 8, 'stone'),
  ];
  const layout: Layout = { name: 'ladder', anchor: { x: o.x + 7.5, y: -60, z: o.z + 12.5 }, fills };

  beforeAll(async () => {
    bot = await connectBot('NavLadder');
    await buildLayout(bot, layout);
    // ladder on the shaft's north wall (facing south), vines on the vine wall's north face (attached south)
    await consoleCommand(MOVE_CONTAINER, 'fill', ...[shaft.x, -60, shaft.z, shaft.x, -51, shaft.z].map(String), 'ladder', '["facing_direction"=3]');
    await consoleCommand(MOVE_CONTAINER, 'fill', ...[o.x + 12, -60, o.z + 4, o.x + 12, -51, o.z + 4].map(String), 'vine', '["vine_direction_bits"=1]');
    await waitForBlock(bot, { x: shaft.x, y: -51, z: shaft.z }, 'ladder', 10_000);
    await waitForBlock(bot, { x: o.x + 12, y: -51, z: o.z + 4 }, 'vine', 10_000);
    await bot.loop.waitTicks(10);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-ladder e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        await teleport(bot, layout.anchor);
        for (const fl of flat(o.x - 4, o.z - 2, o.x + 18, o.z + 16)) await bot.truth.fill(fl.from, fl.to, fl.block);
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 120_000);

  async function climb(label: string, from: Vec3, goal: Vec3, yaw: number) {
    await teleport(bot, from, yaw);
    const before = bot.corrections.length;
    const tr = trackBody(bot);
    const trace: string[] = [];
    const offTrace = bot.loop.onBeforeStep((tick, s) => {
      if (TRACE) queueMicrotask(() => trace.push(`tick ${tick} p ${fmt(s.pos)} v ${fmt(s.vel)} g ${s.onGround} ch ${s.collidedHorizontally} | ${JSON.stringify(bot.loop.command)}`));
    });
    const plan = bot.skills.nav.plan({ type: 'block', p: goal }, from);
    const res = await bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks: 1200 });
    await bot.loop.waitTicks(10);
    tr.stop();
    offTrace();
    const got = bot.corrections.slice(before);
    if (TRACE && got.length) console.log(`[nav-ladder trace] ${label}\n${trace.join('\n')}`);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    const m = plan ? plan.path.map((n) => n.move) : [];
    const line =
      `${label}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, plan ${plan?.status ?? 'none'} (climb ${m.filter((x) => x === 'climb').length}, climbOut ${m.filter((x) => x === 'climbOut').length}), ` +
      `${got.length} correction(s), stuck ${rep.stuck}, sneak ${rep.sneakTicks ?? 0} ticks, end ${fmt(td.local)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`;
    summary.push(line);
    return { res, rep, tr, got, td, m, line };
  }

  /** Ticks per block between feet y0 and y1 (either direction) while in column (x, z). */
  function perBlock(path: Vec3[], col: { x: number; z: number }, y0: number, y1: number): number {
    const inCol = (p: Vec3) => Math.floor(p.x) === col.x && Math.floor(p.z) === col.z;
    const up = y1 > y0;
    const a = path.findIndex((p) => inCol(p) && (up ? p.y >= y0 : p.y <= y0));
    const b = path.findIndex((p, i) => i > a && inCol(p) && (up ? p.y >= y1 : p.y <= y1));
    return a >= 0 && b > a ? (b - a) / Math.abs(y1 - y0) : NaN;
  }

  it('walks into a 1 x 1 shaft, climbs a 10-block ladder and steps onto the block behind it', async () => {
    const r = await climb('ladder up', { x: shaft.x + 0.5, y: -60, z: o.z + 12.5 }, { x: shaft.x, y: -50, z: o.z + 4 }, 180);
    const pb = perBlock(r.tr.path, shaft, -59, -52);
    summary.push(`ladder up: ${pb.toFixed(2)} ticks per block (feet -59 to -52), table climbUp ${DEFAULT_COSTS.climbUp}`);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.m.filter((x) => x === 'climb').length).toBeGreaterThanOrEqual(9);
    expect(r.got.length, r.line).toBe(0);
    expect(Math.abs(r.td.local.y - -50)).toBeLessThan(1e-3);
    expect(pb).toBeGreaterThan(DEFAULT_COSTS.climbUp * 0.7);
    expect(pb).toBeLessThan(DEFAULT_COSTS.climbUp * 1.6);
  }, 120_000);

  it('climbs back down into the shaft from its top edge and walks out', async () => {
    const r = await climb('ladder down', { x: shaft.x + 0.5, y: -50, z: o.z + 4.5 }, { x: shaft.x, y: -60, z: o.z + 12 }, 0);
    const pb = perBlock(r.tr.path, shaft, -52, -59);
    summary.push(`ladder down: ${pb.toFixed(2)} ticks per block (feet -52 to -59), table climbDown ${DEFAULT_COSTS.climbDown}`);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.got.length, r.line).toBe(0);
    expect(Math.abs(r.td.local.y - -60)).toBeLessThan(1e-3);
    expect(r.tr.minFeet).toBeGreaterThan(-60.01);
  }, 120_000);

  it('climbs a vine wall onto its top', async () => {
    const r = await climb('vine wall up', { x: o.x + 12.5, y: -60, z: o.z + 0.5 }, { x: o.x + 12, y: -50, z: o.z + 7 }, 0);
    const pb = perBlock(r.tr.path, { x: o.x + 12, z: o.z + 4 }, -59, -52);
    summary.push(`vine up: ${pb.toFixed(2)} ticks per block (feet -59 to -52)`);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.m).toContain('climb');
    expect(r.got.length, r.line).toBe(0);
    expect(Math.abs(r.td.local.y - -50)).toBeLessThan(1e-3);
  }, 120_000);
});
