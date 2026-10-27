// e2e (tag @bds), Track AJ (PLAN.md task 7.7, docs/pathfinding.md "Movement variety"): parkour gaps
// and edge sneaking on bds-move. Three walled 3-wide lanes cross a 4-deep pit with water at the
// bottom: a 1-block gap (walking speed), a 2-block gap (sprinted run-up) and a 2-block gap landing 1
// lower; each is crossed PARKOUR_RUNS (20) times and every crossing must land (falls are counted, a
// fall ends in the water). A 1-wide, 20-long bridge with a right-angle turn, 7 blocks above the ground, is walked with edge
// sneaking off and on (corrections, falls and sneak ticks before / after). Each run builds in its own
// random area (nav-worlds.ts privateOrigin, MOVE_AREA pins it) and restores the flat world at the end.
//   PARKOUR_RUNS=n    crossings per lane (default 20)    BRIDGE_RUNS=n   bridge walks per setting (default 5)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, teleport, type MoveBot } from './move-truth.ts';
import { privateOrigin, trackBody, type Fill, type Layout } from './nav-worlds.ts';

const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });
const RUNS = Number(process.env.PARKOUR_RUNS ?? 20);
const BRIDGE_RUNS = Number(process.env.BRIDGE_RUNS ?? 5);

describe.skipIf(!E2E)('@bds nav: parkour gaps and edge sneaking (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const flat = (x1: number, z1: number, x2: number, z2: number): Fill[] => [f(x1, -64, z1, x2, -64, z2, 'bedrock'), f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, -45, z2, 'air')];
  /** A 3-wide lane at x a..a+2 between walls, runway up to z o+4, a gap of g blocks, landing beyond (1 lower: `down`). */
  const lane = (a: number, g: number, down: boolean): Fill[] => [
    f(a - 1, -63, o.z - 3, a - 1, -57, o.z + 16, 'stone'),
    f(a + 3, -63, o.z - 3, a + 3, -57, o.z + 16, 'stone'),
    f(a, -63, o.z + 5, a + 2, -61, o.z + 4 + g, 'air'),
    f(a, -64, o.z + 5, a + 2, -64, o.z + 4 + g, 'water'),
    ...(down ? [f(a, -61, o.z + 5 + g, a + 2, -61, o.z + 15, 'air')] : []),
  ];
  const lanes = [
    { label: '1-block gap', a: o.x, g: 1, down: false },
    { label: '2-block gap', a: o.x + 6, g: 2, down: false },
    { label: '2-block gap, 1 lower', a: o.x + 12, g: 2, down: true },
  ];
  // bridge at y -57 (feet -56), 7 above the pit floor (-64): 10 blocks along +z at x o+21 (z o+23..o+32),
  // a right-angle turn, 10 blocks along +x at z o+32 (x o+22..o+31); platforms (3 x 3 on stone pillars)
  // around (o+21, o+21) and (o+33, o+32). The turn makes the body overshoot towards the edges.
  const bx = o.x + 21;
  const bz = o.z + 32;
  const W = o.x + 40;
  const fills: Fill[] = [
    ...flat(o.x - 4, o.z - 5, W, o.z + 40),
    ...lanes.flatMap((l) => lane(l.a, l.g, l.down)),
    f(o.x + 17, -63, o.z + 18, W - 2, -61, o.z + 37, 'air'),
    f(bx - 1, -63, o.z + 20, bx + 1, -57, o.z + 22, 'stone'),
    f(bx + 11, -63, bz - 1, bx + 13, -57, bz + 1, 'stone'),
    f(bx, -57, o.z + 23, bx, -57, bz, 'stone'),
    f(bx + 1, -57, bz, bx + 10, -57, bz, 'stone'),
  ];
  const layout: Layout = { name: 'parkour', anchor: { x: o.x + 10.5, y: -60, z: o.z + 20.5 }, fills };

  beforeAll(async () => {
    bot = await connectBot('NavParkour');
    await buildLayout(bot, layout);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-parkour e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        await teleport(bot, layout.anchor);
        for (const fl of flat(o.x - 4, o.z - 5, W, o.z + 40)) await bot.truth.fill(fl.from, fl.to, fl.block);
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 120_000);

  async function cross(from: Vec3, goal: Vec3, opts: { edgeSneak?: boolean } = {}) {
    await teleport(bot, from, 0);
    bot.skills.nav.edgeSneak = opts.edgeSneak ?? true;
    const before = bot.corrections.length;
    const tr = trackBody(bot);
    const res = await bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks: 600 });
    await bot.loop.waitTicks(10);
    tr.stop();
    bot.skills.nav.edgeSneak = true;
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    return { res, rep, tr, got };
  }

  for (const l of lanes) {
    it(`jumps the ${l.label} ${RUNS} times: every crossing lands`, async () => {
      const landFeet = l.down ? -61 : -60;
      let landed = 0;
      let falls = 0;
      let corrections = 0;
      let parkourPlans = 0;
      const ticks: number[] = [];
      const fails: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const from = { x: l.a + 1.5, y: -60, z: o.z - 1.5 };
        const goal = { x: l.a + 1, y: landFeet, z: o.z + 12 };
        const plan = bot.skills.nav.plan({ type: 'block', p: goal }, from);
        if (plan?.path.some((n) => n.move === 'parkour' && n.gap?.length === l.g)) parkourPlans++;
        const r = await cross(from, goal);
        const fell = r.tr.minFeet < landFeet - 0.5 || r.tr.wet > 0;
        corrections += r.got.length;
        if (fell) falls++;
        if (r.res.ok && !fell) {
          landed++;
          ticks.push(r.rep.ticks);
        } else fails.push(`#${i}: ${JSON.stringify(r.res)} min feet ${r.tr.minFeet.toFixed(2)} wet ${r.tr.wet} end ${fmt(bot.loop.state.pos)}${describeCorrections(r.got)}`);
      }
      const mean = ticks.length ? ticks.reduce((s, t) => s + t, 0) / ticks.length : NaN;
      summary.push(`${l.label}: ${landed}/${RUNS} landed, ${falls} fall(s), ${corrections} correction(s), parkour planned ${parkourPlans}/${RUNS}, goto ${mean.toFixed(1)} ticks mean (${Math.min(...ticks)}..${Math.max(...ticks)})${fails.length ? `; ${fails.join('; ')}` : ''}`);
      expect(parkourPlans).toBe(RUNS);
      expect(landed).toBe(RUNS);
      expect(falls).toBe(0);
      expect(corrections).toBe(0);
    }, 900_000);
  }

  it(`walks a 1-wide, 20-long bridge ${BRIDGE_RUNS} times each without and with edge sneaking`, async () => {
    const rows: Record<string, { ok: number; falls: number; corrections: number; sneak: number; ticks: number[] }> = {};
    for (const sneak of [false, true]) {
      const row = { ok: 0, falls: 0, corrections: 0, sneak: 0, ticks: [] as number[] };
      rows[sneak ? 'after (edge sneak on)' : 'before (edge sneak off)'] = row;
      for (let i = 0; i < BRIDGE_RUNS; i++) {
        // start on the bridge with the body centre 0.22 from an edge: the lane correction runs along it
        const from = { x: bx + (i % 2 === 0 ? 0.22 : 0.78), y: -56, z: o.z + 24.5 };
        const r = await cross(from, { x: bx + 12, y: -56, z: bz }, { edgeSneak: sneak });
        const fell = r.tr.minFeet < -56.5;
        if (r.res.ok && !fell) row.ok++;
        if (fell) row.falls++;
        row.corrections += r.got.length;
        row.sneak += r.rep.sneakTicks ?? 0;
        row.ticks.push(r.rep.ticks);
        if (fell) await teleport(bot, { x: bx + 0.5, y: -56, z: o.z + 21.5 }, 0);
      }
    }
    for (const [k, r] of Object.entries(rows)) summary.push(`bridge ${k}: ${r.ok}/${BRIDGE_RUNS} ok, ${r.falls} fall(s), ${r.corrections} correction(s), ${r.sneak} sneak ticks, ticks ${r.ticks.join(' ')}`);
    const after = rows['after (edge sneak on)']!;
    expect(after.ok).toBe(BRIDGE_RUNS);
    expect(after.falls).toBe(0);
    expect(after.corrections).toBe(0);
  }, 900_000);
});
