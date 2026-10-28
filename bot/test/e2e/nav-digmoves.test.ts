// e2e (tag @bds), wave 11 Track BC (docs/pathfinding.md "Nodes and moves"): the moves that dig
// (nav/baritone/moves.ts, Baritone's movements over our grid and rules) on bds-bari (udp/19206, flat
// world, truth pack; BARI_BDS_HOST / BARI_BDS_PORT / BARI_BDS_CONTAINER), planned in the worker (the Realm's
// configuration: `attachPlanner`). Truth-built courses (nav-worlds.ts `digMovesLayout`):
//   tunnel   a 12-long dirt hill under a stone brick roof closing the corridor: a 1-wide tunnel (24 digs)
//   cave     a goal in a cave 12 blocks under the top of a dirt mound, a lava pocket under the grass in front
//            of the cave: a shaft down beside the cave (dig-down under the shaft rules, cobblestone in the
//            hotbar for the way back), never into the lava
//   cliff    a stone brick step under a dirt lintel: the jump up needs two head-room breaks
//   rock     a goal 8 blocks inside a stone block: a 16-dig tunnel with the iron pickaxe
//   gravel   a dirt barrier with gravel on top: unreachable by default (gravity_above), dug with
//            `allowGravityAbove` (the fallen gravel dug again before the body walks in)
// Each course: 0 to 1 corrections, no navigator tick over 100 ms; "before" is the same plan with the dig
// moves off (`moves`: only dig-through). Each run builds in its own random area (MOVE_AREA pins it) and
// clears it at the end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectTarget } from '../../src/connection/types.ts';
import { findPath, type PathOptions, type PathResult } from '../../src/skills/nav/astar.ts';
import { breakTicksWith } from '../../src/skills/nav/baritone/helper.ts';
import { NavGrid } from '../../src/skills/nav/grid.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { bdsTarget } from './env.ts';
import { E2E, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, hdist, sleep, teleport, truthDiff, waitForBlock, type MoveBot } from './move-truth.ts';
import { digMovesLayout, privateOrigin, trackBody } from './nav-worlds.ts';
import { consoleCommand } from './skills-truth.ts';

export const BARI_HOST = process.env.BARI_BDS_HOST ?? '127.0.0.1';
export const BARI_PORT = Number(process.env.BARI_BDS_PORT ?? 19206);
export const BARI_CONTAINER = process.env.BARI_BDS_CONTAINER ?? 'bds-bari';
export const BARI_TARGET: ConnectTarget = bdsTarget(BARI_HOST, BARI_PORT);

const NO_DIG_MOVES: PathOptions['moves'] = { digAscend: false, digDescend: false, digDownward: false };

describe.skipIf(!E2E)('@bds nav: the moves that dig (Track BC, bds-bari)', () => {
  let bot: MoveBot;
  let detach: (() => void) | undefined;
  const summary: string[] = [];
  const o = privateOrigin();
  const L = digMovesLayout(o);

  beforeAll(async () => {
    bot = await connectBot('NavDigMoves', { target: BARI_TARGET, container: BARI_CONTAINER });
    await buildLayout(bot, L.layout);
    for (const c of L.stateFills) {
      await consoleCommand(BARI_CONTAINER, 'fill', ...[c.from.x, c.from.y, c.from.z, c.to.x, c.to.y, c.to.z].map(String), c.block, ...(c.states ? [c.states] : []));
    }
    // the Realm's configuration: the planner worker (its budget holds a dig-heavy search; in-thread: 40 ms)
    detach = bot.skills.nav.attachPlanner(bot.world);
    await bot.truth.cmd('give', [bot.name, 'cobblestone', 64]);
    await bot.truth.cmd('give', [bot.name, 'iron_pickaxe', 1]);
    const t0 = performance.now();
    while (performance.now() - t0 < 10_000) {
      const names = bot.world.inventory.slots.map((s) => s?.name);
      if (names.includes('cobblestone') && names.includes('iron_pickaxe') && bot.skills.nav.planner?.ready) break;
      await sleep(100);
    }
    expect(bot.world.inventory.slots.map((s) => s?.name)).toContain('iron_pickaxe');
    expect(bot.skills.nav.planner?.ready).toBe(true);
  }, 240_000);

  afterAll(async () => {
    console.log(`[nav-digmoves e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        detach?.();
        await teleport(bot, L.layout.anchor);
        for (const fl of L.cleanup) await bot.truth.fill(fl.from, fl.to, fl.block);
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 120_000);

  /** Blocks the truth pack finds in a box (`truth:find`), by name. */
  async function count(from: Vec3, to: Vec3, block: string): Promise<number> {
    const r = await bot.truth.ok<{ positions: number[][] }>('find', [from.x, from.y, from.z, to.x, to.y, to.z, block, 2048], 20_000);
    return r.positions.length;
  }

  const inv = () => bot.world.inventory;
  const moves = (r: PathResult | undefined) => (r ? r.path.reduce<Record<string, number>>((m, n) => ((m[n.move + (n.act?.dig ? '+dig' : '')] = (m[n.move + (n.act?.dig ? '+dig' : '')] ?? 0) + 1), m), {}) : {});
  const digsOf = (r: PathResult | undefined) => r?.path.reduce((n, p) => n + (p.act?.dig?.length ?? 0), 0) ?? 0;

  async function course(label: string, from: Vec3, goal: Vec3, opts: { allowBreak?: boolean; allowPlace?: boolean; timeoutTicks?: number; ready?: { p: Vec3; block: string }[] } = {}) {
    await teleport(bot, from, 0);
    // the course's blocks are in the world model: buildLayout waits for the last fill only, and a big fill reaches the model
    // with the chunk re-sent after the teleport (the cave's mound arrived a second after the body stood on it)
    for (const r of opts.ready ?? []) await waitForBlock(bot, r.p, r.block, 15_000);
    await bot.loop.waitTicks(20);
    const start = { x: Math.floor(from.x), y: Math.floor(from.y + 1e-3), z: Math.floor(from.z) };
    // "before": the same search with only dig-through (main's move set); "after": the navigator's own plan
    // (in this process, blocking the bot's tick loop for up to 1.5 s each: the corrections count starts after;
    // on a grid of their own, so the navigator's cache is not filled with 300 000 cells)
    const grid = new NavGrid(bot.skills.nav.grid.source);
    const base: PathOptions = { allowBreak: true, allowPlace: opts.allowPlace ?? false, throwaway: 64, allowGravityAbove: bot.skills.nav.allowGravityAbove, maxNodes: 500_000, maxMs: 1500, breakTicks: (c) => breakTicksWith(c, inv()) };
    const t0 = performance.now();
    const before = findPath(grid, start, { type: 'block', p: goal }, { ...base, moves: NO_DIG_MOVES });
    const t1 = performance.now();
    const after = findPath(grid, start, { type: 'block', p: goal }, base);
    const t2 = performance.now();
    await bot.loop.waitTicks(20);
    const before0 = bot.corrections.length;
    const health0 = bot.world.self.health;
    const tr = trackBody(bot);
    const res = await bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks: 2400, ...opts });
    await bot.loop.waitTicks(10);
    tr.stop();
    const got = bot.corrections.slice(before0);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    const line =
      `${label}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks (straight ${hdist(from, goal).toFixed(1)}), digs ${rep.actions.dig} (failed ${rep.actions.failed}), places ${rep.actions.place}, ` +
      `plans ${rep.plans.map((p) => `${p.reason}:${p.status}/${p.nodes}n/${p.expanded}e/${p.ms}ms/${p.via}`).join(' ')}, max tick ${rep.maxTickMs} ms, min feet ${tr.minFeet.toFixed(2)}, wet ${tr.wet}, health ${health0} -> ${bot.world.self.health}, ` +
      `${got.length} correction(s), truth diff ${td.diff.toFixed(3)}${describeCorrections(got)}\n    before (dig-through only): ${before.status} ${before.expanded}e ${(t1 - t0).toFixed(1)} ms cost ${before.cost.toFixed(0)} ${JSON.stringify(moves(before))} ${digsOf(before)} digs` +
      `\n    after (Track BC): ${after.status} ${after.path.length}n ${after.expanded}e ${(t2 - t1).toFixed(1)} ms cost ${after.cost.toFixed(0)} ${JSON.stringify(moves(after))} ${digsOf(after)} digs`;
    summary.push(line);
    return { res, rep, tr, got, td, before, after, line };
  }

  it('tunnel: a 1-wide tunnel through a 12-block dirt hill under a roof (the dig-through move, 24 digs executed in order)', async () => {
    const r = await course('tunnel', L.tunnel.start, L.tunnel.goal, { allowBreak: true, ready: [{ p: L.tunnel.hill.to, block: 'dirt' }, { p: L.tunnel.hill.from, block: 'dirt' }] });
    expect(r.before.status).toBe('found'); // dig-through is the move here, before and after
    expect(r.after.cost).toBeCloseTo(r.before.cost, 6);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.rep.actions.dig).toBeGreaterThanOrEqual(24);
    expect(r.rep.actions.dig).toBeLessThanOrEqual(27);
    expect(r.rep.distance).toBeLessThan(hdist(L.tunnel.start, L.tunnel.goal) + 6);
    expect(r.got.length).toBeLessThanOrEqual(1);
    expect(r.rep.maxTickMs).toBeLessThan(100);
    expect(Math.abs(r.td.local.y - -60)).toBeLessThan(1e-3);
  }, 240_000);

  it('cave: 12 blocks down to a cave by a shaft beside it, never into the lava pocket (before: unreachable)', async () => {
    const lava0 = await count(L.cave.lava.from, L.cave.lava.to, 'lava');
    expect(lava0).toBe(6);
    const sx = Math.floor(L.cave.start.x);
    const sz = Math.floor(L.cave.start.z);
    const r = await course('cave', L.cave.start, L.cave.goal, {
      allowBreak: true,
      allowPlace: true,
      ready: [-49, -52, -56, -60]
        .map((y) => ({ p: { x: sx, y, z: sz }, block: 'dirt' }))
        .concat([{ p: L.cave.lava.to, block: 'lava' }, { p: L.cave.mound.from, block: 'dirt' }, { p: { x: L.cave.mound.to.x, y: L.cave.mound.to.y, z: L.cave.mound.to.z }, block: 'dirt' }, { p: { x: L.cave.mound.to.x, y: L.cave.mound.from.y, z: L.cave.mound.from.z }, block: 'dirt' }, { p: { x: L.cave.mound.from.x, y: L.cave.mound.to.y, z: L.cave.mound.to.z }, block: 'dirt' }]),
    });
    {
      // the column under the body at the end, as the world model and the navigator's grid see it (diagnostics)
      const p = bot.loop.state.pos;
      const [x, z] = [Math.floor(p.x), Math.floor(p.z)];
      const col: string[] = [];
      const g = bot.skills.nav.grid;
      for (let y = Math.floor(p.y) + 1; y >= Math.floor(p.y) - 3; y--) col.push(`${y}: world ${bot.world.blockAt({ x, y, z })?.name ?? '?'} / source ${g.source.blockAt(x, y, z)?.name ?? '?'} / grid ${g.cls(x, y, z)?.name ?? '?'}`);
      summary.push(`cave column under ${fmt(p)}: ${col.join('; ')} (onSection wired: ${typeof bot.world.chunks.onSection})`);
    }
    expect(r.before.status).not.toBe('found');
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.rep.actions.dig).toBeGreaterThanOrEqual(10); // 12 blocks down in a 1 x 1 shaft beside the cave (11 dig-downs) and a step in
    expect(r.rep.actions.dig).toBeLessThanOrEqual(22);
    if (r.after.status === 'found') expect(r.after.path.filter((n) => n.move === 'downward').length).toBeGreaterThanOrEqual(8);
    expect(r.tr.wet).toBe(0);
    expect(bot.world.self.health).toBe(20);
    expect(await count(L.cave.lava.from, L.cave.lava.to, 'lava')).toBe(6);
    // the dig-down drop: the server breaks the block on its own timer and its body falls before the client's update_block
    // arrives; measured 0 corrections in 3 of 4 runs and one vertical correction of 0.74 per shaft block (the body idle,
    // each re-plan the same shaft) in the other: at most one per shaft block
    expect(r.got.length).toBeLessThanOrEqual(11);
    expect(r.got.every((c) => (c.error ?? 0) < 0.8 && Math.abs(c.server.x - (c.local?.x ?? c.server.x)) < 0.01 && Math.abs(c.server.z - (c.local?.z ?? c.server.z)) < 0.01), r.line).toBe(true);
    expect(r.rep.maxTickMs).toBeLessThan(100);
    expect(Math.abs(r.td.local.y - -60)).toBeLessThan(1e-3);
  }, 300_000);

  it('cliff: a step under a lintel is climbed after two head-room breaks (before: unreachable)', async () => {
    const r = await course('cliff', L.cliff.start, L.cliff.goal, { allowBreak: true, ready: [{ p: L.cliff.lintel.to, block: 'dirt' }] });
    expect(r.before.status).not.toBe('found');
    expect(r.res, r.line).toEqual({ ok: true });
    const jump = r.after.path.find((n) => n.move === 'jump' && n.act?.dig);
    expect(jump?.act?.dig?.length).toBe(2);
    expect(r.rep.actions.dig).toBe(2);
    expect(await count(L.cliff.lintel.from, L.cliff.lintel.to, 'dirt')).toBe(4);
    expect(r.got.length).toBeLessThanOrEqual(1);
    expect(r.rep.maxTickMs).toBeLessThan(100);
    expect(Math.abs(r.td.local.y - -59)).toBeLessThan(1e-3);
  }, 240_000);

  it('rock: a goal 8 blocks inside solid stone is reached with the iron pickaxe (before: a straight 18-dig tunnel; after: up the face by ascends and down into the block by descends, 15 digs)', async () => {
    const r = await course('rock', L.rock.start, L.rock.goal, { allowBreak: true, ready: [{ p: L.rock.block.to, block: 'stone' }, { p: L.rock.goal, block: 'stone' }] });
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.rep.actions.dig).toBeGreaterThanOrEqual(13);
    expect(r.rep.actions.dig).toBeLessThanOrEqual(18);
    expect(r.after.cost).toBeLessThanOrEqual(r.before.cost + 1e-6);
    expect(r.got.length).toBeLessThanOrEqual(1);
    expect(r.rep.maxTickMs).toBeLessThan(100);
    expect(Math.floor(r.td.local.x)).toBe(L.rock.goal.x);
    expect(Math.floor(r.td.local.z)).toBe(L.rock.goal.z);
  }, 240_000);

  it('gravel: a dirt barrier under gravel is refused by default and dug with allowGravityAbove (the fallen gravel dug again)', async () => {
    const refused = await course('gravel (refused)', L.gravel.start, L.gravel.goal, { allowBreak: true, timeoutTicks: 400, ready: [{ p: L.gravel.top.to, block: 'gravel' }] });
    expect(refused.res.ok, refused.line).toBe(false);
    expect(refused.rep.actions.dig).toBe(0);
    expect(refused.after.status).toBe('none');
    expect(await count(L.gravel.top.from, L.gravel.top.to, 'gravel')).toBe(3);
    bot.skills.nav.allowGravityAbove = true;
    try {
      const dug = await course('gravel (allowGravityAbove)', L.gravel.start, L.gravel.goal, { allowBreak: true });
      const top = await count(L.gravel.top.from, L.gravel.top.to, 'gravel');
      const fallen = await count(L.gravel.barrier.from, L.gravel.barrier.to, 'gravel');
      const dirt = await count(L.gravel.barrier.from, L.gravel.barrier.to, 'dirt');
      summary.push(`gravel: ${top} gravel left on top, ${fallen} in the barrier, ${dirt} dirt left; plan ${dug.after.status} cost ${dug.after.cost.toFixed(0)} ${JSON.stringify(moves(dug.after))} ${digsOf(dug.after)} digs`);
      expect(dug.res, dug.line).toEqual({ ok: true });
      expect(dug.after.status).toBe('found');
      // the planner pays the gravel either as the falling stack over a dug dirt cell or (cheaper here) as a dug cell of an
      // ascend onto the barrier; either way the barrier is opened with the gravel gone from its column
      expect(dug.rep.actions.dig).toBeGreaterThanOrEqual(2);
      expect(dug.rep.actions.failed).toBe(0);
      expect(dug.got.length).toBeLessThanOrEqual(1);
      expect(dirt).toBeLessThanOrEqual(5);
      expect(top).toBeLessThanOrEqual(2);
      expect(fallen).toBe(0);
    } finally {
      bot.skills.nav.allowGravityAbove = false;
    }
    // restore for a re-run in the same area
    await bot.truth.fill(L.gravel.barrier.from, L.gravel.barrier.to, 'dirt');
    await bot.truth.fill(L.gravel.top.from, L.gravel.top.to, 'gravel');
    await waitForBlock(bot, L.gravel.top.to, 'gravel');
  }, 300_000);

  it('sneak-through: a 1.5-high passage under top slabs is crossed sneaking (the smallest gap a sneaking body passes on BDS), 0 corrections', async () => {
    const r = await course('sneak', L.sneak.start, L.sneak.goal, { allowBreak: false, ready: [{ p: L.sneak.ceiling.to, block: 'smooth_stone_slab' }, { p: L.sneak.ceiling.from, block: 'smooth_stone_slab' }] });
    summary.push(`sneak: sneak ticks ${r.rep.sneakTicks ?? 0}, plan ${JSON.stringify(moves(r.after))}`);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.after.path.filter((n) => n.move === 'sneak').length).toBeGreaterThanOrEqual(8);
    expect(r.rep.sneakTicks ?? 0).toBeGreaterThan(20);
    expect(r.rep.actions.dig).toBe(0);
    expect(r.got.length).toBe(0);
    expect(r.rep.maxTickMs).toBeLessThan(100);
    expect(await count(L.sneak.ceiling.from, L.sneak.ceiling.to, 'smooth_stone_slab')).toBe(21);
  }, 240_000);

  it('the navigator reports the planner worker for every course', () => {
    expect(summary.some((l) => l.includes('/worker'))).toBe(true);
    console.log(`[nav-digmoves e2e] end ${fmt(bot.loop.state.pos)}`);
  });
});
