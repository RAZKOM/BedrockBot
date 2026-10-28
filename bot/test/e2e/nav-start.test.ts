// e2e (tag @bds), Track AX (2026-10-30): moves out of a partial-floor node (docs/pathfinding.md
// "Stairs and partial blocks"). The owner's Realm reports: the bot stood in a 1 x 1 hole whose floor is
// a chest (feet +0.95, the rim 1.05 higher) and every plan failed with no move from the start node;
// and it would not step from a dirt path (+0.9375) into a doorway under a lintel. Here: the chest hole
// (the bot teleported in, a goto to a cell 5 blocks away: a jump out) and a wall with an open door, a
// dirt path in front of it (a goto through the door), each twice. Runs on bds-move by default; the
// Track AX gate ran it on bds-dig (MOVE_BDS_PORT=19148 MOVE_BDS_CONTAINER=bds-dig, same flat world).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, MOVE_CONTAINER, connectBot, describeCorrections, disconnectBot, fmt, teleport, truthDiff, waitForBlock, type MoveBot } from './move-truth.ts';
import { privateOrigin, trackBody } from './nav-worlds.ts';
import { consoleCommand } from './skills-truth.ts';

describe.skipIf(!E2E)('@bds nav: out of a chest hole, from a dirt path through a door (Track AX)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const hole = { x: o.x, y: -62, z: o.z };
  const door = { x: o.x, y: -60, z: o.z + 8 };
  const path = { x: o.x, y: -61, z: o.z + 7 };
  const area = { from: { x: o.x - 8, y: -60, z: o.z - 3 }, to: { x: o.x + 8, y: -55, z: o.z + 13 } };

  const fill = async (a: Vec3, b: Vec3, block: string) => {
    for (let attempt = 0; ; attempt++) {
      const r = await bot.truth.cmd('fill', [a.x, a.y, a.z, b.x, b.y, b.z, block], 30_000);
      if (r.ok) return;
      if (r.reason !== 'unloaded_chunk' || attempt >= 10) throw new Error(`truth:fill failed: ${r.reason}`);
      await new Promise((res) => setTimeout(res, 500));
    }
  };
  const setblock = (p: Vec3, block: string, states?: string) =>
    consoleCommand(MOVE_CONTAINER, 'setblock', String(p.x), String(p.y), String(p.z), block, ...(states ? [states] : []));

  beforeAll(async () => {
    bot = await connectBot('NavPartial');
    await teleport(bot, { x: o.x + 0.5, y: -60, z: o.z + 4.5 });
    await fill(area.from, area.to, 'air');
    // the hole: air in the grass cell, a chest in the dirt cell below
    await fill({ ...hole, y: -61 }, { ...hole, y: -61 }, 'air');
    await setblock(hole, 'chest', '["minecraft:cardinal_direction"="south"]');
    // the wall (13 wide, 3 high), the open door in it, the dirt path in front
    await fill({ x: o.x - 6, y: -60, z: door.z }, { x: o.x + 6, y: -58, z: door.z }, 'stone');
    await fill(path, path, 'grass_path');
    await setblock(door, 'wooden_door', '["minecraft:cardinal_direction"="west","upper_block_bit"=false,"open_bit"=true]');
    await setblock({ ...door, y: -59 }, 'wooden_door', '["minecraft:cardinal_direction"="west","upper_block_bit"=true,"open_bit"=true]');
    await waitForBlock(bot, { ...door, y: -59 }, 'wooden_door', 10_000);
    await waitForBlock(bot, hole, 'chest', 10_000);
    await bot.loop.waitTicks(10);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-partial e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        await fill(area.from, area.to, 'air');
        await fill({ x: area.from.x, y: -61, z: area.from.z }, { x: area.to.x, y: -61, z: area.to.z }, 'grass_block');
        await fill(hole, hole, 'dirt');
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 120_000);

  async function walk(label: string, from: Vec3, goal: Vec3) {
    await teleport(bot, from, 0);
    const before = bot.corrections.length;
    const tr = trackBody(bot);
    const start = { ...bot.loop.state.pos };
    const plan = bot.skills.nav.plan({ type: 'block', p: goal }, start);
    const t0 = performance.now();
    const res = await bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks: 200 });
    const ms = performance.now() - t0;
    await bot.loop.waitTicks(10);
    tr.stop();
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    const moves = plan ? plan.path.map((n) => `${n.move}@${n.x},${n.y},${n.z}/${+n.feet.toFixed(4)}`).join(' ') : 'none';
    const line =
      `${label}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks (${(ms / 1000).toFixed(1)} s), start ${fmt(start)}, plan ${plan?.status ?? 'none'} [${moves}], ` +
      `segments ${rep.segments}, ${got.length} correction(s), stuck ${rep.stuck}, end ${fmt(td.local)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`;
    summary.push(line);
    return { res, rep, tr, got, td, plan, ms, line };
  }

  it('jumps out of a 1 x 1 hole with a chest floor to a cell 5 blocks away, twice', async () => {
    for (const run of [1, 2]) {
      const r = await walk(`chest hole ${run}`, { x: hole.x + 0.5, y: -61.05, z: hole.z + 0.5 }, { x: hole.x + 5, y: -60, z: hole.z });
      expect(r.res, r.line).toEqual({ ok: true });
      expect(r.ms, r.line).toBeLessThan(10_000);
      expect(r.plan?.path[1]?.move, r.line).toBe('jump');
      expect(Math.abs(r.td.local.y - -60), r.line).toBeLessThan(1e-3);
      expect(r.td.diff, r.line).toBeLessThan(0.05);
    }
  }, 120_000);

  it('walks from a dirt path through an open door under a lintel, twice', async () => {
    for (const run of [1, 2]) {
      const r = await walk(`dirt path door ${run}`, { x: path.x + 0.5, y: -60.0625, z: path.z + 0.5 }, { x: door.x, y: -60, z: door.z + 3 });
      expect(r.res, r.line).toEqual({ ok: true });
      expect(r.plan?.path.some((n) => n.x === door.x && n.z === door.z), r.line).toBe(true);
      expect(r.tr.path.some((p) => Math.floor(p.x) === door.x && Math.floor(p.z) === door.z), r.line).toBe(true);
      expect(Math.abs(r.td.local.y - -60), r.line).toBeLessThan(1e-3);
      expect(r.td.diff, r.line).toBeLessThan(0.05);
    }
  }, 120_000);
});
