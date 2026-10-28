// e2e (tag @bds), wave 11 Track BB (docs/pathfinding.md "Rules"): the shared movement rule set
// (nav/baritone/helper.ts, Baritone's MovementHelper over TerrainClass) on bds-bari (udp/19206, flat
// world, truth pack; BARI_BDS_HOST / BARI_BDS_PORT / BARI_BDS_CONTAINER). Truth-built corridors
// (nav-worlds.ts `rulesLayout`), one per rule:
//   magma      a magma strip on the path: walked around (allowWalkOnMagmaBlocks is off: never stood on, the
//              body is never on a magma block, health stays 20)
//   bushes     a line of sweet berry bushes: walked around (never inside a bush cell)
//   ice        a 2-high ice barrier over a lava pool closing the corridor (stone brick walls: built blocks the
//              rules never dig): never dug with allowBreak (`ice`), the goto is unreachable, every ice block
//              still there (truth)
//   gravel     a dirt barrier with gravel on top closing the corridor: not dug (`gravity_above`), the plan has
//              no path; with the gravel removed the same barrier is dug and the plan's cost carries the dig ticks
//   soul sand  a 3-long soul sand floor across the corridor: walked over (the feet dip to -60.125), the walk
//              takes longer than the plain corridor; corrections counted (the physics does not model the soul
//              sand speed factor yet: the server is slower than the local body, up to 2 corrections)
//   slabs      bottom slabs and a stairs step up as the floor: walked without a jump
// Each run builds in its own random area (privateOrigin, MOVE_AREA pins it) and clears it at the end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectTarget } from '../../src/connection/types.ts';
import { breakBlocker } from '../../src/skills/nav/actions.ts';
import { DEFAULT_COSTS } from '../../src/skills/nav/costs.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { bdsTarget } from './env.ts';
import { E2E, buildLayout, describeCorrections, disconnectBot, connectBot, fmt, teleport, truthDiff, waitForBlock, type MoveBot } from './move-truth.ts';
import { privateOrigin, rulesLayout, trackBody } from './nav-worlds.ts';
import { consoleCommand } from './skills-truth.ts';

export const BARI_HOST = process.env.BARI_BDS_HOST ?? '127.0.0.1';
export const BARI_PORT = Number(process.env.BARI_BDS_PORT ?? 19206);
export const BARI_CONTAINER = process.env.BARI_BDS_CONTAINER ?? 'bds-bari';
export const BARI_TARGET: ConnectTarget = bdsTarget(BARI_HOST, BARI_PORT);

describe.skipIf(!E2E)('@bds nav: the shared movement rules (Track BB, bds-bari)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const L = rulesLayout(o);

  beforeAll(async () => {
    bot = await connectBot('NavRules', { target: BARI_TARGET, container: BARI_CONTAINER });
    await buildLayout(bot, L.layout);
    for (const c of L.stateFills) {
      await consoleCommand(BARI_CONTAINER, 'fill', ...[c.from.x, c.from.y, c.from.z, c.to.x, c.to.y, c.to.z].map(String), c.block, ...(c.states ? [c.states] : []));
    }
    const last = L.stateFills.at(-1)!;
    await waitForBlock(bot, last.to, last.block, 10_000);
    await bot.loop.waitTicks(10);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-rules e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        await teleport(bot, L.layout.anchor);
        for (const f of L.cleanup) await bot.truth.fill(f.from, f.to, f.block);
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 120_000);

  /** Blocks the truth pack finds in a box (`truth:find`), by name. */
  async function count(from: Vec3, to: Vec3, block: string): Promise<number> {
    const r = await bot.truth.ok<{ positions: number[][] }>('find', [from.x, from.y, from.z, to.x, to.y, to.z, block, 256], 20_000);
    return r.positions.length;
  }

  /** The block under the feet / the block the feet are in, per tick of the track. */
  function cellsUnder(path: Vec3[]): { under: Set<string>; inside: Set<string> } {
    const under = new Set<string>();
    const inside = new Set<string>();
    for (const p of path) {
      const x = Math.floor(p.x);
      const z = Math.floor(p.z);
      const y = Math.floor(p.y + 1e-6);
      under.add(bot.world.blockAt({ x, y: y - 1, z })?.name ?? '?');
      inside.add(bot.world.blockAt({ x, y, z })?.name ?? '?');
    }
    return { under, inside };
  }

  async function walk(label: string, from: Vec3, goal: Vec3, opts: { allowBreak?: boolean; timeoutTicks?: number } = {}) {
    await teleport(bot, from, 0);
    const before = bot.corrections.length;
    const health0 = bot.world.self.health;
    const tr = trackBody(bot);
    let jumps = 0;
    let held = false;
    const off = bot.loop.onBeforeStep((_t, s) => {
      const j = bot.loop.command.jump;
      if (j && !held && s.onGround) jumps++;
      held = j;
    });
    const plan = bot.skills.nav.plan({ type: 'block', p: goal }, from, opts);
    const res = await bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks: 1200, ...opts });
    await bot.loop.waitTicks(10);
    off();
    tr.stop();
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    const cells = cellsUnder(tr.path);
    const line =
      `${label}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, ${jumps} jump(s), plan ${plan?.status ?? 'none'}` +
      `${plan ? ` cost ${plan.cost.toFixed(1)}` : ''}, digs ${rep.actions.dig}, min feet ${tr.minFeet.toFixed(3)}, health ${health0} -> ${bot.world.self.health}, ` +
      `under [${[...cells.under].join(' ')}], in [${[...cells.inside].join(' ')}], ${got.length} correction(s), end ${fmt(td.local)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`;
    summary.push(line);
    return { res, rep, tr, jumps, got, td, plan, cells, line };
  }

  it('a magma strip on the path is walked around, never stood on', async () => {
    const r = await walk('magma', L.magma.start, L.magma.goal);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.cells.under.has('magma'), r.line).toBe(false);
    expect(bot.world.self.health).toBe(20);
    expect(r.got.length).toBeLessThanOrEqual(2);
    // the rule: magma is no floor and not walked into (allowWalkOnMagmaBlocks off)
    expect(bot.skills.nav.grid.stand(L.magma.x, -60, L.magma.strip.from.z)).toBeNaN();
  }, 120_000);

  it('a line of sweet berry bushes is walked around, never entered', async () => {
    const r = await walk('berry bushes', L.bush.start, L.bush.goal);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.cells.inside.has('sweet_berry_bush'), r.line).toBe(false);
    expect(bot.world.self.health).toBe(20);
    expect(r.got.length).toBeLessThanOrEqual(2);
    expect(bot.skills.nav.grid.stand(L.bush.x, -60, L.bush.line.from.z)).toBeNaN();
  }, 120_000);

  it('an ice barrier over lava is never dug: unreachable with allowBreak, every ice block still there', async () => {
    const iceBefore = await count(L.ice.barrier.from, L.ice.barrier.to, 'ice');
    expect(iceBefore).toBe(6);
    const reason = breakBlocker(bot.skills.nav.grid, L.ice.x, -60, L.ice.barrier.from.z);
    const r = await walk('ice over lava', L.ice.start, L.ice.goal, { allowBreak: true, timeoutTicks: 400 });
    summary.push(`ice: break rule ${reason}, ${await count(L.ice.barrier.from, L.ice.barrier.to, 'ice')} ice left, ${await count(L.ice.lava.from, L.ice.lava.to, 'lava')} lava`);
    expect(reason).toBe('ice');
    expect(r.res.ok, r.line).toBe(false);
    expect(r.rep.actions.dig).toBe(0);
    expect(r.plan?.status).toBe('none');
    expect(await count(L.ice.barrier.from, L.ice.barrier.to, 'ice')).toBe(6);
    expect(await count(L.ice.lava.from, L.ice.lava.to, 'lava')).toBe(3);
  }, 120_000);

  it('a dirt barrier with gravel on top is not dug (gravity_above); without the gravel it is, and the plan pays the dig ticks', async () => {
    const reason = breakBlocker(bot.skills.nav.grid, L.gravel.x, -59, L.gravel.barrier.from.z);
    expect(reason).toBe('gravity_above');
    const blocked = await walk('gravel over the dig', L.gravel.start, L.gravel.goal, { allowBreak: true, timeoutTicks: 400 });
    expect(blocked.res.ok, blocked.line).toBe(false);
    expect(blocked.rep.actions.dig).toBe(0);
    expect(blocked.plan?.status).toBe('none');
    expect(await count(L.gravel.top.from, L.gravel.top.to, 'gravel')).toBe(3);
    // the control: the same barrier without the gravel is dug, and the plan's cost carries 2 x (15 ticks by hand + dig)
    await bot.truth.fill(L.gravel.top.from, L.gravel.top.to, 'air');
    await waitForBlock(bot, L.gravel.top.to, 'air');
    await bot.loop.waitTicks(5);
    const dug = await walk('gravel removed', L.gravel.start, L.gravel.goal, { allowBreak: true });
    expect(dug.res, dug.line).toEqual({ ok: true });
    // Track BC: the cheapest plan is now an ascend onto the barrier with one break (jump + 1 dig) rather than the 2-dig
    // dig-through; either way every dug cell pays its break time + `dig`
    expect(dug.rep.actions.dig).toBeGreaterThanOrEqual(1);
    expect(dug.plan?.status).toBe('found');
    const digNode = dug.plan!.path.find((n) => n.act?.dig);
    expect(digNode?.move === 'jump' ? digNode.act!.dig!.length === 1 : digNode?.move === 'walk' && digNode.act!.dig!.length === 2, dug.line).toBe(true);
    expect(digNode!.cost).toBeGreaterThanOrEqual(digNode!.act!.dig!.length * (15 + DEFAULT_COSTS.dig));
    expect(await count(L.gravel.barrier.from, L.gravel.barrier.to, 'dirt')).toBeLessThanOrEqual(6 - digNode!.act!.dig!.length);
  }, 180_000);

  it('a soul sand floor is walked over (slower than the plain corridor)', async () => {
    const plain = await walk('plain corridor', L.soul.start, L.soul.goal);
    expect(plain.res, plain.line).toEqual({ ok: true });
    await bot.truth.fill(L.soul.fill.from, L.soul.fill.to, L.soul.fill.block);
    await waitForBlock(bot, L.soul.fill.to, 'soul_sand');
    await bot.loop.waitTicks(5);
    const soul = await walk('soul sand', L.soul.start, L.soul.goal);
    expect(soul.res, soul.line).toEqual({ ok: true });
    expect(soul.cells.under.has('soul_sand'), soul.line).toBe(true);
    expect(soul.tr.minFeet).toBeLessThanOrEqual(-60.1);
    expect(soul.plan!.cost).toBeGreaterThan(plain.plan!.cost);
    expect(soul.rep.ticks).toBeGreaterThanOrEqual(plain.rep.ticks);
    expect(soul.got.length).toBeLessThanOrEqual(2); // input/physics.ts has no soul sand speed factor (docs/pathfinding.md "Known gaps")
    summary.push(`soul sand: ${soul.rep.ticks} ticks vs ${plain.rep.ticks} plain (plan cost ${soul.plan!.cost.toFixed(1)} vs ${plain.plan!.cost.toFixed(1)})`);
  }, 120_000);

  it('bottom slabs and a stairs step are walked as floors without a jump', async () => {
    const r = await walk('slabs and stairs', L.slabs.start, L.slabs.goal);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.plan?.path.map((n) => n.move)).not.toContain('jump');
    expect(r.jumps).toBe(0);
    expect(r.cells.inside.has('smooth_stone_slab'), r.line).toBe(true);
    expect(Math.abs(r.td.local.y - -59)).toBeLessThan(1e-3);
    expect(r.got.length).toBe(0);
  }, 120_000);
});
