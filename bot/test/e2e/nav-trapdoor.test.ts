// e2e (tag @bds), Track BG (decisions/0048-trapdoor-moves.md, docs/pathfinding.md "Trapdoors"): hatches on
// bds-move. Three rooms (6 high, x 7 x 7 inside) under a stone roof whose top is a platform (feet -53):
//   B  a ladder on the north wall reaching up into the roof (the hole), a trapdoor on it in the walking
//      layer (-53): down from the platform into the room and back up and out, closed (opened, closed behind)
//      and open (no action), panel opposite the ladder (the tightest gap: 0.63 for the 0.6 body) and on its side
//   A  the trapdoor in the roof layer (-54), the ladder ending under it (-55): down only (on BDS an open
//      trapdoor is not climbed, so nobody climbs out of such a hatch; measured)
//   W  a trapdoor in the roof without a ladder over a 2-deep pool: a fall of 8 into the water, out onto the floor
// 0 corrections expected. Each run builds in its own random area (nav-worlds.ts privateOrigin, MOVE_AREA pins
// it) and restores the flat world. NAV_TRACE=1 prints the per-tick body state of a goto with corrections.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, MOVE_CONTAINER, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, teleport, truthDiff, waitForBlock, type MoveBot } from './move-truth.ts';
import { privateOrigin, trackBody, type Fill, type Layout } from './nav-worlds.ts';
import { consoleCommand } from './skills-truth.ts';

const TRACE = process.env.NAV_TRACE === '1';
const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });

describe.skipIf(!E2E)('@bds nav: trapdoors in floors and ceilings (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const flat = (x1: number, z1: number, x2: number, z2: number): Fill[] => [f(x1, -64, z1, x2, -64, z2, 'bedrock'), f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, -45, z2, 'air')];
  /** Room k (0 = B, 1 = A, 2 = W): x0 .. x0 + 8, z o .. o + 8; roof -54; inside x0 + 1 .. x0 + 7, z o + 1 .. o + 7, y -60 .. -55. */
  const room = (k: number) => {
    const x0 = o.x + k * 12;
    return { x0, hatch: { x: x0 + 4, z: o.z + 1 }, platform: { x: x0 + 6, y: -53, z: o.z + 6 }, floor: { x: x0 + 6, y: -60, z: o.z + 6 } };
  };
  const B = room(0);
  const A = room(1);
  const W = room(2);
  const fills: Fill[] = [...flat(o.x - 4, o.z - 4, o.x + 40, o.z + 14)];
  for (const r of [B, A, W]) fills.push(f(r.x0, -60, o.z, r.x0 + 8, -54, o.z + 8, 'stone'), f(r.x0 + 1, -60, o.z + 1, r.x0 + 7, -55, o.z + 7, 'air'));
  fills.push(f(B.hatch.x, -54, B.hatch.z, B.hatch.x, -54, B.hatch.z, 'air'));
  fills.push(f(W.x0 + 3, -62, o.z + 3, W.x0 + 5, -61, o.z + 5, 'water'));
  const layout: Layout = { name: 'trapdoor', anchor: { x: o.x + 18.5, y: -60, z: o.z + 11.5 }, fills };
  const W_HATCH = { x: W.x0 + 4, y: -54, z: o.z + 4 };

  /** A spruce trapdoor at p: `direction` 0..3 (open panel at x 0 / x 1 / z 0 / z 1), open or closed, bottom or top half. */
  async function trapdoor(p: Vec3, direction: number, open: boolean, top = false): Promise<void> {
    await consoleCommand(MOVE_CONTAINER, 'setblock', String(p.x), String(p.y), String(p.z), 'spruce_trapdoor', `["direction"=${direction},"open_bit"=${open},"upside_down_bit"=${top}]`);
    const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      const b = bot.world.blockAt(p);
      if (b?.name === 'spruce_trapdoor' && Number(b.states.direction) === direction && Number(b.states.open_bit) === (open ? 1 : 0)) return;
      await bot.loop.waitTicks(1);
    }
    throw new Error(`trapdoor at ${fmt(p)} not seen`);
  }

  beforeAll(async () => {
    bot = await connectBot('NavTrap');
    await buildLayout(bot, layout);
    // B: the ladder on the north wall from the room's floor up into the roof; A: up to under the roof
    await consoleCommand(MOVE_CONTAINER, 'fill', ...[B.hatch.x, -60, B.hatch.z, B.hatch.x, -54, B.hatch.z].map(String), 'ladder', '["facing_direction"=3]');
    await consoleCommand(MOVE_CONTAINER, 'fill', ...[A.hatch.x, -60, A.hatch.z, A.hatch.x, -55, A.hatch.z].map(String), 'ladder', '["facing_direction"=3]');
    await waitForBlock(bot, { x: B.hatch.x, y: -54, z: B.hatch.z }, 'ladder', 10_000);
    await waitForBlock(bot, { x: A.hatch.x, y: -55, z: A.hatch.z }, 'ladder', 10_000);
    await bot.loop.waitTicks(10);
  }, 240_000);

  afterAll(async () => {
    console.log(`[nav-trapdoor e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        await teleport(bot, layout.anchor);
        for (const fl of flat(o.x - 4, o.z - 4, o.x + 40, o.z + 14)) await bot.truth.fill(fl.from, fl.to, fl.block);
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 120_000);

  async function go(label: string, from: Vec3, goal: Vec3, yaw = 180) {
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
    if (TRACE && got.length) console.log(`[nav-trapdoor trace] ${label}\n${trace.join('\n')}`);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    const m = plan ? plan.path.map((n) => n.move) : [];
    const line =
      `${label}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, plan ${plan?.status ?? 'none'} (${m.join(' ')}), ` +
      `actions ${JSON.stringify(rep.actions)}, ${got.length} correction(s), stuck ${rep.stuck}, end ${fmt(td.local)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`;
    summary.push(line);
    return { res, rep, tr, got, td, m, line };
  }

  const hatchB = { x: B.hatch.x, y: -53, z: B.hatch.z };
  const isOpen = (p: Vec3) => Number(bot.world.blockAt(p)?.states.open_bit);

  for (const [dir, side] of [
    [3, 'panel opposite the ladder'],
    [2, 'panel on the ladder side'],
  ] as const) {
    it(`B (${side}): down through the closed hatch onto the ladder into the room, closed behind`, async () => {
      await trapdoor(hatchB, dir, false);
      const r = await go(`B dir ${dir} closed down`, { x: B.platform.x + 0.5, y: -53, z: B.platform.z + 0.5 }, B.floor);
      expect(r.res, r.line).toEqual({ ok: true });
      expect(r.rep.actions, r.line).toMatchObject({ use: 1, close: 1, failed: 0 });
      expect(r.got.length, r.line).toBe(0);
      expect(Math.abs(r.td.local.y - -60)).toBeLessThan(1e-3);
      expect(isOpen(hatchB)).toBe(0);
    }, 120_000);

    it(`B (${side}): up the ladder, the hatch opened from below, out onto the platform, closed behind`, async () => {
      const r = await go(`B dir ${dir} closed up`, { x: B.floor.x + 0.5, y: -60, z: B.floor.z + 0.5 }, B.platform);
      expect(r.res, r.line).toEqual({ ok: true });
      expect(r.rep.actions, r.line).toMatchObject({ use: 1, close: 1, failed: 0 });
      expect(r.got.length, r.line).toBe(0);
      expect(Math.abs(r.td.local.y - -53)).toBeLessThan(1e-3);
      expect(isOpen(hatchB)).toBe(0);
    }, 120_000);
  }

  it('B open (top half): down and up again without any action, the hatch left open', async () => {
    await trapdoor(hatchB, 3, true, true);
    const down = await go('B open down', { x: B.platform.x + 0.5, y: -53, z: B.platform.z + 0.5 }, B.floor);
    expect(down.res, down.line).toEqual({ ok: true });
    expect(down.rep.actions, down.line).toMatchObject({ use: 0, close: 0, failed: 0 });
    expect(down.got.length, down.line).toBe(0);
    const up = await go('B open up', { x: B.floor.x + 0.5, y: -60, z: B.floor.z + 0.5 }, B.platform);
    expect(up.res, up.line).toEqual({ ok: true });
    expect(up.rep.actions, up.line).toMatchObject({ use: 0, close: 0, failed: 0 });
    expect(up.got.length, up.line).toBe(0);
    expect(isOpen(hatchB)).toBe(1);
  }, 180_000);

  it('A: down through the closed hatch in the roof layer onto the ladder under it; no way back up', async () => {
    const hatchA = { x: A.hatch.x, y: -54, z: A.hatch.z };
    await trapdoor(hatchA, 1, false, true);
    const r = await go('A closed down', { x: A.platform.x + 0.5, y: -53, z: A.platform.z + 0.5 }, A.floor);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.rep.actions, r.line).toMatchObject({ use: 1, close: 1, failed: 0 });
    expect(r.got.length, r.line).toBe(0);
    expect(r.tr.minFeet).toBeGreaterThan(-60.01);
    const back = bot.skills.nav.plan({ type: 'block', p: A.platform }, A.floor);
    summary.push(`A up: plan ${back?.status}`);
    expect(back?.status).not.toBe('found');
  }, 120_000);

  it('W: through a closed hatch without a ladder, a fall of 8 into the pool, out onto the floor', async () => {
    await trapdoor(W_HATCH, 0, false);
    const r = await go('W closed water drop', { x: W.platform.x + 0.5, y: -53, z: W.platform.z + 0.5 }, W.floor);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.m).toContain('swim');
    expect(r.rep.actions.use, r.line).toBe(1);
    expect(r.got.length, r.line).toBe(0);
    expect(Math.abs(r.td.local.y - -60)).toBeLessThan(1e-3);
    expect(bot.world.self.health).toBeGreaterThan(19);
  }, 120_000);
});
