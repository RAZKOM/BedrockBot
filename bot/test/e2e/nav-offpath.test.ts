// e2e (tag @bds), Track BE: the path executor's off-path checks (nav/baritone/executor.ts, ported from
// Baritone's PathExecutor). Two courses in a private area: a straight 30-block lane, and a zigzag (a
// closed 11-wide corridor with 4 walls across, the gap alternating sides). Mid-goto the bot is moved
// by a truth `tp` (BDS sends move_player: the loop's `teleport` event; a knock arrives as
// set_entity_motion, the same path check): 3 blocks sideways off the lane, and forward onto a later
// node of the zigzag's path. Each case runs with the checks off (`nav.offPath = false`: main's
// behaviour, every such event re-plans) and on: ticks to arrive and re-plans. BDS has no silent push
// (every displacement is an event), so the per-tick off-path re-plan only shows in the unit sim.
// Env: MOVE_BDS_* (move-truth.ts), MOVE_AREA, MOVE_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GotoReport } from '../../src/skills/nav/navigator.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, buildLayout, connectBot, disconnectBot, fmt, teleport, type MoveBot } from './move-truth.ts';
import { privateOrigin, type Fill, type Layout } from './nav-worlds.ts';

const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });
const clearBox = (x1: number, z1: number, x2: number, z2: number, top = -54): Fill[] => [f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, top, z2, 'air')];

/** Zigzag at x - 6 .. x + 6 (start (x, z), goal (x, z + 42)); the lane at x + 18 (start (x + 18, z), goal (x + 18, z + 30)). */
function courses(o: { x: number; z: number }) {
  const box = clearBox(o.x - 8, o.z - 4, o.x + 22, o.z + 46);
  const walls: Fill[] = [f(o.x - 6, -60, o.z - 1, o.x - 6, -58, o.z + 44, 'stone'), f(o.x + 6, -60, o.z - 1, o.x + 6, -58, o.z + 44, 'stone'), f(o.x - 6, -60, o.z - 1, o.x + 6, -58, o.z - 1, 'stone')];
  for (let i = 0; i < 4; i++) {
    const z = o.z + 8 + i * 9;
    walls.push(i % 2 === 0 ? f(o.x - 5, -60, z, o.x + 2, -58, z, 'stone') : f(o.x - 2, -60, z, o.x + 5, -58, z, 'stone'));
  }
  const layout: Layout = { name: 'offpath', anchor: { x: o.x + 8.5, y: -60, z: o.z + 20.5 }, fills: [...box, ...walls] };
  return {
    layout,
    cleanup: box,
    zig: { start: { x: o.x + 0.5, y: -60, z: o.z + 0.5 }, goal: { x: o.x, y: -60, z: o.z + 42 } },
    lane: { start: { x: o.x + 18.5, y: -60, z: o.z + 0.5 }, goal: { x: o.x + 18, y: -60, z: o.z + 30 } },
  };
}

const replans = (rep: GotoReport): string[] => rep.plans.filter((p) => p.reason !== 'start' && p.reason !== 'ahead' && !p.upgrade && !p.interim).map((p) => `${p.reason}@${p.tick}`);

describe.skipIf(!E2E)('@bds nav: off the path (Track BE, bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const C = courses(o);

  beforeAll(async () => {
    bot = await connectBot('NavOff');
    await buildLayout(bot, C.layout);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-offpath e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        bot.skills.cancel();
        bot.skills.nav.offPath = true;
        await teleport(bot, C.layout.anchor);
        for (const c of C.cleanup) await bot.truth.fill(c.from, c.to, c.block);
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 120_000);

  /** goto `goal` from `start`; once `when(pos)` holds, a truth tp to `to(pos)`. */
  async function run(label: string, offPath: boolean, start: Vec3, goal: Vec3, when: (p: Vec3) => boolean, to: (p: Vec3) => Vec3) {
    bot.skills.nav.offPath = offPath;
    await teleport(bot, start, 0);
    let moved: Vec3 | undefined;
    const done = bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks: 1500 });
    let finished = false;
    void done.then(() => (finished = true));
    for (let i = 0; i < 600 && !finished && !moved; i++) {
      await bot.loop.waitTicks(1);
      const p = bot.loop.state.pos;
      if (when(p)) {
        moved = to(p);
        await bot.truth.tp(bot.name, moved, bot.loop.command.yaw, 0);
      }
    }
    const res = await done;
    const rep = bot.skills.status().lastGoto!;
    const line =
      `${label}, checks ${offPath ? 'on ' : 'off'}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, tp to ${moved ? fmt(moved) : 'none'}, ` +
      `re-plans ${JSON.stringify(replans(rep))}, snaps ${rep.snaps ?? 0}, skips ${rep.skips ?? 0}, off-path ${rep.offPath ?? 0}, stuck ${rep.stuck}, corrections ${rep.corrections}, end ${fmt(bot.loop.state.pos)}`;
    summary.push(line);
    return { res, rep, line, moved };
  }

  it('3 blocks sideways off a straight 30-block lane: re-planned, arrives (main vs Track BE)', async () => {
    const L = C.lane;
    for (const on of [false, true]) {
      const r = await run('lane, tp 3 sideways', on, L.start, L.goal, (p) => p.z > L.start.z + 12, (p) => ({ x: p.x + 3, y: -60, z: p.z }));
      expect(r.res, r.line).toEqual({ ok: true });
      expect(r.moved, r.line).toBeDefined();
      expect(replans(r.rep).length, r.line).toBeGreaterThanOrEqual(1);
    }
  }, 120_000);

  it('forward onto a later node of the zigzag: Track BE walks on from there, main re-plans', async () => {
    const Z = C.zig;
    bot.skills.nav.offPath = true;
    await teleport(bot, Z.start, 0);
    const plan = bot.skills.nav.plan({ type: 'block', p: Z.goal });
    expect(plan?.status).toBe('found');
    const n = plan!.path[Math.min(25, plan!.path.length - 3)]!;
    const target = { x: n.x + 0.5, y: n.feet, z: n.z + 0.5 };
    const ticks: number[] = [];
    for (const on of [false, true]) {
      const r = await run('zigzag, tp forward to a path node', on, Z.start, Z.goal, (p) => p.z > Z.start.z + 4, () => target);
      expect(r.res, r.line).toEqual({ ok: true });
      expect(r.moved, r.line).toBeDefined();
      if (on) {
        expect(r.rep.snaps, r.line).toBe(1);
        expect(replans(r.rep), r.line).toEqual([]);
      } else {
        expect(replans(r.rep).length, r.line).toBeGreaterThanOrEqual(1);
      }
      ticks.push(r.rep.ticks);
    }
    summary.push(`zigzag ticks: main ${ticks[0]}, Track BE ${ticks[1]}`);
  }, 150_000);
});
