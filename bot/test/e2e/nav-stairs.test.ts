// e2e (tag @bds): stairs and partial blocks on bds-move (docs/pathfinding.md "Stairs and partial
// blocks"). A 6-step oak staircase walked up and down without a jump (and the same climb on full
// blocks, jumped, for the tick comparison); stairs met from the high side; a path over carpet,
// farmland, a dirt path, snow layers and slabs; gotos that start standing on a stairs block's low half
// and on a slab. The stairs are placed with the console `fill` and block states, so on BDS 1.26.60
// they carry the new `minecraft:corner` state (runtime ids the 1.26.30 registry data does not know;
// terrain/shapes.ts resolves them). Each run builds in its own random area (nav-worlds.ts
// privateOrigin, MOVE_AREA pins it) and clears it at the end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../../src/skills/terrain/classify.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, MOVE_CONTAINER, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, teleport, truthDiff, waitForBlock, type MoveBot } from './move-truth.ts';
import { privateOrigin, stairsLayout, trackBody } from './nav-worlds.ts';
import { consoleCommand } from './skills-truth.ts';

describe.skipIf(!E2E)('@bds nav: stairs and partial blocks (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const L = stairsLayout(o);

  beforeAll(async () => {
    bot = await connectBot('NavStairs');
    await buildLayout(bot, L.layout);
    // stairs and other block states through the console (truth:fill takes plain block names)
    for (const c of L.stateFills) {
      await consoleCommand(MOVE_CONTAINER, 'fill', ...[c.from.x, c.from.y, c.from.z, c.to.x, c.to.y, c.to.z].map(String), c.block, ...(c.states ? [c.states] : []));
    }
    const last = L.stateFills.at(-1)!;
    await waitForBlock(bot, last.to, last.block, 10_000);
    await bot.loop.waitTicks(10);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-stairs e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        await teleport(bot, L.layout.anchor);
        for (const f of L.cleanup) await bot.truth.fill(f.from, f.to, f.block);
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 120_000);

  /** goto with body tracking, jump presses (from the input commands) and corrections. */
  async function walk(label: string, from: Vec3, goal: Vec3, opts: { sprint?: boolean; allowPlace?: boolean } = {}) {
    await teleport(bot, from, 0);
    const before = bot.corrections.length;
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
    const planMoves = plan ? plan.path.map((n) => n.move) : [];
    const count = (m: string) => planMoves.filter((x) => x === m).length;
    const line =
      `${label}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, ${jumps} jump(s), ` +
      `plan ${plan?.status ?? 'none'} (walk ${count('walk')}, diag ${count('diag')}, jump ${count('jump')}, drop ${count('drop')}), segments ${rep.segments}, ` +
      `${got.length} correction(s), stuck ${rep.stuck}, end ${fmt(td.local)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`;
    summary.push(line);
    return { res, rep, tr, jumps, got, td, planMoves, line };
  }

  it('reads 1.26.60 stairs (minecraft:corner runtime ids) as stairs, not unknown blocks', () => {
    const lines: string[] = [];
    for (const [label, p] of Object.entries(L.probe)) {
      const b = bot.world.blockAt(p);
      const c = b && classify(b);
      lines.push(`${label} ${b?.name}${b?.stateId === -1 ? ` rid ${String(b.states.runtime_id)}` : ''} -> ${c?.name} top ${c?.top} floor ${c?.floor} unknown ${c?.unknown}`);
      expect(c?.unknown, label).toBe(false);
    }
    summary.push(`blocks: ${lines.join('; ')}`);
    expect(classify(bot.world.blockAt(L.probe.stairs)!).name).toBe('oak_stairs');
  });

  it('walks a 6-step oak staircase up and down without jumping', async () => {
    const up = await walk('stairs up', L.stairs.bottom, L.stairs.top);
    expect(up.res, up.line).toEqual({ ok: true });
    expect(up.planMoves).not.toContain('jump');
    expect(up.jumps).toBe(0);
    const firstStep = up.tr.path.findIndex((p) => p.y >= -59 - 1e-3);
    const lastStep = up.tr.path.findIndex((p) => p.y >= -54 - 1e-3);
    summary.push(`stairs up: ${((lastStep - firstStep) / 5).toFixed(2)} ticks per step (feet -59 to -54)`);
    expect(Math.abs(up.td.local.y - -54)).toBeLessThan(1e-3);
    const down = await walk('stairs down', L.stairs.topStart, L.stairs.bottomGoal);
    expect(down.res, down.line).toEqual({ ok: true });
    expect(down.planMoves).not.toContain('jump');
    expect(down.planMoves).not.toContain('drop');
    expect(down.jumps).toBe(0);
    expect(Math.abs(down.td.local.y - -60)).toBeLessThan(1e-3);
    // the same climb on full blocks (jumps), for the tick comparison
    const blocks = await walk('full-block steps up', L.blocks.bottom, L.blocks.top);
    expect(blocks.res, blocks.line).toEqual({ ok: true });
    const b0 = blocks.tr.path.findIndex((p) => p.y >= -59 - 1e-3);
    const b1 = blocks.tr.path.findIndex((p) => p.y >= -54 - 1e-3);
    summary.push(`full-block steps up: ${((b1 - b0) / 5).toFixed(2)} ticks per step (feet -59 to -54)`);
  }, 120_000);

  it('Realm shape: 3 stairs up to a platform, allowPlace off and on: walked up, nothing placed', async () => {
    await bot.truth.cmd('give', [bot.name, 'cobblestone', 64]);
    await bot.loop.waitTicks(10);
    for (const allowPlace of [false, true]) {
      const r = await walk(`3 stairs to a platform, allowPlace ${allowPlace}`, L.realm.start, L.realm.goal, { allowPlace });
      expect(r.res, r.line).toEqual({ ok: true });
      expect(r.rep.actions.place, r.line).toBe(0);
      expect(r.planMoves).not.toContain('pillar');
      expect(r.jumps).toBe(0);
      expect(Math.abs(r.td.local.y - -57)).toBeLessThan(1e-3);
    }
  }, 90_000);

  it("the owner's house: around a wall, up 2 levels over 4 cells, through a door; allowPlace off and on, nothing placed", async () => {
    const d = L.house.door;
    for (const allowPlace of [false, true]) {
      // the door closed again for each run
      for (const [dy, upper] of [
        [0, false],
        [1, true],
      ] as const)
        await consoleCommand(MOVE_CONTAINER, 'setblock', String(d.x), String(d.y + dy), String(d.z), 'wooden_door', `["minecraft:cardinal_direction"="south","upper_block_bit"=${upper},"open_bit"=false]`);
      await bot.loop.waitTicks(10);
      const r = await walk(`house, allowPlace ${allowPlace}`, L.house.start, L.house.goal, { allowPlace, sprint: true });
      summary.push(`  actions ${JSON.stringify(r.rep.actions)}, plans ${r.rep.plans.map((p) => `${p.reason}:${p.status}/${p.nodes}n`).join(' ')}`);
      expect(r.res, r.line).toEqual({ ok: true });
      expect(r.rep.actions.place, r.line).toBe(0);
      expect(r.planMoves).not.toContain('pillar');
      expect(Math.abs(r.td.local.y - -58)).toBeLessThan(1e-3);
    }
  }, 120_000);

  it('climbs stairs met from the high side', async () => {
    const r = await walk('stairs facing away', L.away.bottom, L.away.top);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(Math.abs(r.td.local.y - -54)).toBeLessThan(1e-3);
  }, 60_000);

  it('walks over carpet, farmland, a dirt path, snow layers and slabs without jumping', async () => {
    const r = await walk('partial blocks', L.partial.start, L.partial.goal);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.planMoves.slice(1).every((m) => m === 'walk' || m === 'diag')).toBe(true);
    expect(r.jumps).toBe(0);
    const feet = [...new Set(r.tr.path.filter((p) => Math.abs(p.x - L.partial.start.x) < 0.2).map((p) => p.y.toFixed(4)))];
    summary.push(`partial blocks: feet heights on the way ${feet.join(' ')}`);
  }, 60_000);

  it('plans and moves from a start standing on a stairs low half and on a slab', async () => {
    const stair = await walk('start on a stairs low half', L.starts.stairLow, L.starts.stairGoal);
    expect(stair.res, stair.line).toEqual({ ok: true });
    expect(stair.rep.segments).toBeGreaterThan(0);
    const slab = await walk('start on a slab', L.starts.slab, L.starts.slabGoal);
    expect(slab.res, slab.line).toEqual({ ok: true });
    expect(slab.rep.segments).toBeGreaterThan(0);
  }, 60_000);
});
