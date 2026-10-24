// e2e (tag @bds), PLAN.md task 7.10 on bds-move: the goal types and the failure blacklist.
//   any         over 10 log columns: reaches the nearest, the report names it
//   getToBlock  stands adjacent, in reach, with a visible face (not the diagonal that sees only glass)
//   yLevel      up a staircase to feet -57
//   runAway     from a point at the bot: at least the radius away (twice: on the spot, from 2 west)
//   surface     out of a 4-deep shaft by pillaring with cobblestone
//   blacklist   a log walled in glass fails 3 times, is blacklisted; the next `any` skips it
// Each run builds in its own random area (nav-worlds.ts privateOrigin) and restores flat ground at the end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkReach, EYE_HEIGHT } from '../../src/skills/dig/look.ts';
import { blockKey, goalTest, type NavGoal } from '../../src/skills/nav/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, buildLayout, connectBot, disconnectBot, fmt, hdist, teleport, type MoveBot } from './move-truth.ts';
import { privateOrigin, type Fill, type Layout, type Origin } from './nav-worlds.ts';

const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });

/** Flat ground again: dirt -63..-62, grass -61, air above (what the bds-move flat world has). */
function flat(x1: number, z1: number, x2: number, z2: number, top = -45): Fill[] {
  return [f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, top, z2, 'air')];
}

/** Log offsets for the `any` test (from the start column); index 0 is the nearest (8.5 blocks). */
const LOGS: readonly [number, number][] = [
  [8, 3],
  [-10, 5],
  [12, -9],
  [-7, -12],
  [15, 10],
  [3, 14],
  [-14, -3],
  [18, -2],
  [-5, 16],
  [11, 13],
];

export function goalsLayout(o: Origin) {
  const X = (dx: number) => o.x + dx;
  const Z = (dz: number) => o.z + dz;
  const area = { x1: X(-34), z1: Z(-24), x2: X(48), z2: Z(44) };
  const fills: Fill[] = [...flat(area.x1, area.z1, area.x2, area.z2)];
  // any: 10 log columns, 3 high
  const logs = LOGS.map(([dx, dz]) => ({ x: X(dx), y: -60, z: Z(dz) }));
  for (const p of logs) fills.push(f(p.x, -60, p.z, p.x, -58, p.z, 'oak_log'));
  // getToBlock: a stone block with glass on its north, west and top
  const target = { x: X(30), y: -60, z: Z(0) };
  fills.push(f(target.x, -60, target.z, target.x, -60, target.z, 'stone'));
  fills.push(f(target.x, -60, target.z - 1, target.x, -60, target.z - 1, 'glass'));
  fills.push(f(target.x - 1, -60, target.z, target.x - 1, -60, target.z, 'glass'));
  fills.push(f(target.x, -59, target.z, target.x, -59, target.z, 'glass'));
  // yLevel: a staircase along +z (feet -59, -58, -57, -56) and a plateau (feet -56)
  for (let i = 0; i < 4; i++) fills.push(f(X(28), -60, Z(10 + i), X(32), -60 + i, Z(10 + i), 'stone'));
  fills.push(f(X(28), -60, Z(14), X(32), -57, Z(18), 'stone'));
  // surface: a 9 x 9 platform one block up with a 1 x 1 shaft 4 deep (feet -63 at the bottom, -59 on the rim)
  const shaft = { x: X(-24), z: Z(-14) };
  fills.push(f(shaft.x - 4, -60, shaft.z - 4, shaft.x + 4, -60, shaft.z + 4, 'stone'));
  fills.push(f(shaft.x, -63, shaft.z, shaft.x, -60, shaft.z, 'air'));
  // blacklist: a log in a glass shell, and a free log further away
  const walled = { x: X(-22), y: -60, z: Z(22) };
  const free = { x: X(-12), y: -60, z: Z(32) };
  fills.push(f(walled.x - 1, -61, walled.z - 1, walled.x + 1, -59, walled.z + 1, 'glass'));
  fills.push(f(walled.x, -60, walled.z, walled.x, -60, walled.z, 'oak_log'));
  fills.push(f(free.x, -60, free.z, free.x, -58, free.z, 'oak_log'));
  const layout: Layout = { name: 'goals', anchor: { x: X(8.5), y: -60, z: Z(10.5) }, fills };
  const cleanup: Layout = { name: 'goals-cleanup', anchor: layout.anchor, fills: flat(area.x1, area.z1, area.x2, area.z2) };
  return {
    layout,
    cleanup,
    anyStart: { x: X(0.5), y: -60, z: Z(0.5) },
    logs,
    target,
    targetStart: { x: X(26.5), y: -60, z: Z(-3.5) },
    yStart: { x: X(30.5), y: -60, z: Z(6.5) },
    runStart: { x: X(12.5), y: -60, z: Z(30.5) },
    shaftBottom: { x: shaft.x + 0.5, y: -63, z: shaft.z + 0.5 },
    shaft,
    walled,
    free,
    walledStart: { x: walled.x + 3.5, y: -60, z: walled.z + 0.5 },
  };
}

describe.skipIf(!E2E)('@bds nav goals and blacklist (task 7.10, bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const L = goalsLayout(o);
  const t0 = performance.now();

  beforeAll(async () => {
    bot = await connectBot('NavGoals');
    await buildLayout(bot, L.layout);
    await bot.truth.cmd('clear', [bot.name]);
    await bot.truth.cmd('give', [bot.name, 'cobblestone', 64]);
  }, 240_000);

  afterAll(async () => {
    try {
      if (bot) {
        await buildLayout(bot, L.cleanup);
        await bot.truth.cmd('clear', [bot.name]);
      }
    } finally {
      console.log(`[nav-goals e2e] area ${o.x},${o.z}, ${((performance.now() - t0) / 1000).toFixed(1)} s\n  ${summary.join('\n  ')}`);
      await disconnectBot(bot);
    }
  }, 240_000);

  const report = () => bot.skills.status().lastGoto!;
  const cell = () => ({ x: Math.floor(bot.loop.state.pos.x), y: Math.floor(bot.loop.state.pos.y + 1e-3), z: Math.floor(bot.loop.state.pos.z) });
  const eye = () => ({ x: bot.loop.state.pos.x, y: bot.loop.state.pos.y + EYE_HEIGHT, z: bot.loop.state.pos.z });

  it('any over 10 logs reaches the nearest and reports which member', async () => {
    await teleport(bot, L.anyStart, 0);
    const goal: NavGoal = { type: 'any', goals: L.logs.map((p): NavGoal => ({ type: 'getToBlock', p })) };
    const res = await bot.skills.goto(goal, { timeoutTicks: 1200 });
    const rep = report();
    const t = L.logs[0]!;
    const c = cell();
    summary.push(`any: ${JSON.stringify(res)} in ${rep.ticks} ticks, reached member ${rep.reached?.index}, end ${fmt(bot.loop.state.pos)}, plans ${rep.plans.map((p) => `${p.status}/${p.expanded}e/${p.ms}ms`).join(' ')}`);
    expect(res).toEqual({ ok: true });
    expect(rep.reached?.index).toBe(0);
    expect(Math.max(Math.abs(c.x - t.x), Math.abs(c.z - t.z))).toBe(1);
    expect(checkReach(eye(), t, 4.5).ok).toBe(true);
  }, 120_000);

  it('getToBlock stands adjacent with reach and a visible face', async () => {
    await teleport(bot, L.targetStart, 0);
    const res = await bot.skills.goto({ type: 'getToBlock', p: L.target }, { timeoutTicks: 1200 });
    const rep = report();
    const c = cell();
    const t = L.target;
    const done = goalTest({ type: 'getToBlock', p: t }, bot.skills.nav.grid).done(c.x, c.y, c.z, bot.loop.state.pos.y);
    const r = checkReach(eye(), t, 4.5);
    summary.push(`getToBlock: ${JSON.stringify(res)} in ${rep.ticks} ticks, end cell ${c.x - o.x},${c.z - o.z} (target 30,0), reach ${r.distance.toFixed(2)}`);
    expect(res).toEqual({ ok: true });
    expect(Math.max(Math.abs(c.x - t.x), Math.abs(c.z - t.z))).toBe(1);
    expect(c).not.toEqual({ x: t.x - 1, y: -60, z: t.z - 1 }); // the near diagonal sees only glass
    expect(r.ok).toBe(true);
    expect(done).toBe(true);
  }, 120_000);

  it('yLevel climbs to feet -57 and stops at the first cell there', async () => {
    await teleport(bot, L.yStart, 0);
    const res = await bot.skills.goto({ type: 'yLevel', y: -57 }, { timeoutTicks: 1200 });
    const rep = report();
    summary.push(`yLevel: ${JSON.stringify(res)} in ${rep.ticks} ticks, end ${fmt(bot.loop.state.pos)}`);
    expect(res).toEqual({ ok: true });
    expect(bot.loop.state.pos.y).toBeCloseTo(-57, 2);
    expect(cell().z - o.z).toBe(12);
  }, 120_000);

  it('runAway increases the distance from a point by at least the radius', async () => {
    for (const [label, dx] of [
      ['on the spot', 0],
      ['2 west', -2],
    ] as const) {
      await teleport(bot, L.runStart, 0);
      const s = bot.loop.state.pos;
      const threat: Vec3 = { x: s.x + dx, y: s.y, z: s.z };
      const d0 = hdist(s, threat);
      const r = 12;
      const res = await bot.skills.goto({ type: 'runAway', from: threat, r }, { timeoutTicks: 1200 });
      const rep = report();
      const d1 = hdist(bot.loop.state.pos, threat);
      summary.push(`runAway (${label}): ${JSON.stringify(res)} in ${rep.ticks} ticks, distance ${d0.toFixed(2)} -> ${d1.toFixed(2)} (r ${r}), end ${fmt(bot.loop.state.pos)}`);
      expect(res).toEqual({ ok: true });
      expect(d1).toBeGreaterThanOrEqual(r - 0.5);
      if (dx === 0) expect(d1 - d0).toBeGreaterThanOrEqual(r - 0.5);
      else expect(bot.loop.state.pos.x).toBeGreaterThan(s.x + 5); // away from the threat (it is west)
    }
  }, 180_000);

  it('surface: out of a 4-deep shaft by pillaring (cobblestone in the hotbar)', async () => {
    await teleport(bot, L.shaftBottom, 0);
    const res = await bot.skills.goto({ type: 'surface' }, { timeoutTicks: 1200, allowPlace: true });
    const rep = report();
    const p = bot.loop.state.pos;
    summary.push(`surface: ${JSON.stringify(res)} in ${rep.ticks} ticks, places ${rep.actions.place} (failed ${rep.actions.failed}), end ${fmt(p)}`);
    expect(res).toEqual({ ok: true });
    expect(p.y).toBeGreaterThanOrEqual(-59.01); // the rim level (-59) or on a pillar flush with it
    expect(rep.actions.place).toBeGreaterThanOrEqual(3); // 3 up, then a jump onto the rim (or a 4th)
    expect(bot.skills.nav.grid.underground(Math.floor(p.x), Math.floor(p.z), p.y)).toBe(false);
  }, 120_000);

  it('an unreachable log (walled in glass) is blacklisted after 3 failures; the next any goto skips it', async () => {
    const key = blockKey(L.walled);
    for (let i = 1; i <= 3; i++) {
      await teleport(bot, L.walledStart, 0);
      const t1 = performance.now();
      const res = await bot.skills.goto({ type: 'getToBlock', p: L.walled }, { timeoutTicks: 1200 });
      const rep = report();
      summary.push(`walled log, try ${i}: ${JSON.stringify(res)} in ${rep.ticks} ticks (${((performance.now() - t1) / 1000).toFixed(1)} s), failures ${rep.failures}, blacklist count ${bot.skills.nav.blacklist.count(key)}${rep.blacklisted?.length ? `, blacklisted ${rep.blacklisted.join(' ')}` : ''}`);
      expect(res.ok).toBe(false);
      expect(bot.skills.nav.blacklist.count(key)).toBe(i);
    }
    expect(bot.skills.nav.blacklist.blocked(L.walled)).toBe(true);
    await teleport(bot, L.walledStart, 0);
    const res = await bot.skills.goto({ type: 'any', goals: [{ type: 'getToBlock', p: L.walled }, { type: 'getToBlock', p: L.free }] }, { timeoutTicks: 1200 });
    const rep = report();
    summary.push(`any after the blacklist: ${JSON.stringify(res)} in ${rep.ticks} ticks, skipped ${JSON.stringify(rep.skipped)}, reached member ${rep.reached?.index}, plans ${rep.plans.length}, blacklist size ${bot.skills.nav.blacklist.size}`);
    expect(res).toEqual({ ok: true });
    expect(rep.skipped).toEqual([key]);
    expect(rep.reached?.index).toBe(1);
    expect(checkReach(eye(), L.free, 4.5).ok).toBe(true);
    const again = await bot.skills.goto({ type: 'getToBlock', p: L.walled });
    expect(again).toEqual({ ok: false, reason: 'blacklisted' });
  }, 240_000);
});
