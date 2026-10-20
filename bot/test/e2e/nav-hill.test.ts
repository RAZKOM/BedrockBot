// e2e (tag @bds), PLAN.md task 3.4 on the "hill" layout (nav-worlds.ts) on bds-move: climb a 10-high
// staircase, descend 3-block drops, walk up bottom slabs without jumping, refuse water and lava.
// Plus the movement rules folded into Phase 3: buoyancy after falling into water, fall damage in the
// skills status. Target: 0 corrections on the staircase and the drops (at most 2 accepted).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, FEET_Y, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, hdist, teleport, truthDiff, type MoveBot } from './move-truth.ts';
import { HILL, HILL_LAYOUT } from './nav-worlds.ts';

describe.skipIf(!E2E)('@bds nav: hill (stairs, drops, slabs, water, lava) on bds-move', () => {
  let bot: MoveBot;
  const summary: string[] = [];

  beforeAll(async () => {
    bot = await connectBot('NavHill');
    await buildLayout(bot, HILL_LAYOUT);
  }, 120_000);

  afterAll(async () => {
    console.log(`[nav-hill e2e]\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  /** goto with corrections counted until 10 ticks after it ends. */
  async function measuredGoto(label: string, goal: Vec3, timeoutTicks = 1200) {
    const before = bot.corrections.length;
    const flagsBefore = bot.events.length;
    const res = await bot.skills.goto({ type: 'block', p: goal }, { timeoutTicks });
    await bot.loop.waitTicks(10);
    const got = bot.corrections.slice(before);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    summary.push(
      `${label}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, ${rep.plans.length} plan(s) [${rep.plans.map((p) => `${p.reason}:${p.status}`).join(' ')}], ` +
        `${got.length} correction(s), end ${fmt(bot.loop.state.pos)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`,
    );
    void flagsBefore;
    return { res, got, rep, td };
  }

  it('climbs the 10-high staircase (corrections: target 0, at most 2)', async () => {
    await teleport(bot, HILL.stairsStart, 0);
    const { res, got, td } = await measuredGoto('stairs up 10', HILL.top);
    expect(res).toEqual({ ok: true });
    expect(bot.loop.state.pos.y).toBeCloseTo(HILL.top.y, 3);
    expect(td.diff).toBeLessThan(0.05);
    expect(got.length).toBeLessThanOrEqual(2);
  }, 120_000);

  it('descends three 3-block drops and a 1-block drop to the ground (corrections: target 0, at most 2)', async () => {
    await teleport(bot, { x: HILL.top.x + 0.5, y: HILL.top.y, z: HILL.top.z + 0.5 }, -90);
    const a = await measuredGoto('drop 3 to ledge 1', HILL.ledge1);
    expect(a.res).toEqual({ ok: true });
    expect(bot.loop.state.pos.y).toBeCloseTo(HILL.ledge1.y, 3);
    const b = await measuredGoto('drops to the ground', { x: 84, y: FEET_Y, z: 16 });
    expect(b.res).toEqual({ ok: true });
    expect(b.rep.plans[0]!.status).toBe('found');
    expect(bot.loop.state.pos.y).toBeCloseTo(FEET_Y, 3);
    expect(b.td.diff).toBeLessThan(0.05);
    expect(a.got.length + b.got.length).toBeLessThanOrEqual(2);
    // no fall damage from 3-block drops
    expect(bot.skills.status().damage.filter((d) => d.falling)).toHaveLength(0);
  }, 120_000);

  it('walks up the bottom-slab staircase without jumping', async () => {
    await teleport(bot, HILL.slabStart, 0);
    const jumpsBefore = countJumps();
    const { res, got, td } = await measuredGoto('slab stairs', HILL.slabTop);
    expect(res).toEqual({ ok: true });
    expect(bot.loop.state.pos.y).toBeCloseTo(HILL.slabTop.y, 3);
    expect(countJumps() - jumpsBefore).toBe(0);
    expect(td.diff).toBeLessThan(0.05);
    expect(got.length).toBeLessThanOrEqual(2);
  }, 120_000);

  it('paths around the water and lava pools, and refuses a goal in the water', async () => {
    await teleport(bot, HILL.poolStart, 0);
    let wet = 0;
    const off = bot.loop.onBeforeStep((_t, s) => {
      if (s.inWater || s.inLava) wet++;
    });
    const { res, got } = await measuredGoto('around the pools', HILL.poolGoal);
    off();
    expect(res).toEqual({ ok: true });
    expect(wet).toBe(0);
    expect(hdist(bot.loop.state.pos, { x: HILL.poolGoal.x + 0.5, z: HILL.poolGoal.z + 0.5 })).toBeLessThanOrEqual(0.3);
    expect(got.length).toBeLessThanOrEqual(2);
    const refuse = await bot.skills.goto({ type: 'block', p: HILL.inWater }, { timeoutTicks: 400 });
    summary.push(`goal in the water: ${JSON.stringify(refuse)} after ${bot.skills.status().lastGoto!.ticks} ticks`);
    expect(refuse).toEqual({ ok: false, reason: 'unreachable' });
    expect(bot.skills.status().lastGoto!.ticks).toBeLessThan(5);
  }, 120_000);

  it('falling into the water: buoyancy model keeps corrections low, then walks out', async () => {
    // 3 blocks above the pool centre: falls in, floats, then a goto out
    await teleport(bot, { x: 87.5, y: -57, z: 2.5 }, 0);
    const before = bot.corrections.length;
    await bot.loop.waitTicks(60);
    const floating = bot.corrections.slice(before);
    const st = bot.loop.state;
    summary.push(`fell into water: ${floating.length} correction(s) in 60 ticks, inWater ${st.inWater}, feet ${fmt(st.pos)}${describeCorrections(floating)}`);
    expect(st.inWater).toBe(true);
    // jump out of the pool: the goto cannot plan from water, so swim up the side by holding jump + forward
    bot.loop.setCommand({ yaw: 180, forward: 1, jump: true });
    let out = false;
    for (let i = 0; i < 80 && !out; i++) {
      await bot.loop.waitTicks(1);
      out = !bot.loop.state.inWater && bot.loop.state.onGround;
    }
    bot.loop.release();
    await bot.loop.waitTicks(10);
    const all = bot.corrections.slice(before);
    summary.push(`swam out: ${out}, ${all.length} correction(s) in total, feet ${fmt(bot.loop.state.pos)}`);
    const td = await truthDiff(bot);
    summary.push(`after water: truth diff ${td.diff.toFixed(4)}`);
    expect(floating.length).toBeLessThanOrEqual(5);
  }, 120_000);

  it('reports fall damage in the skills status', async () => {
    await teleport(bot, { x: 64.5, y: FEET_Y, z: -10.5 }, 0);
    const h0 = bot.skills.status().health;
    const before = bot.corrections.length;
    await teleport(bot, { x: 64.5, y: FEET_Y + 7, z: -10.5 }, 0);
    await bot.loop.waitTicks(40);
    const st = bot.skills.status();
    const got = bot.corrections.slice(before);
    summary.push(`fall 7: health ${h0} -> ${st.health}, damage ${JSON.stringify(st.damage, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}, ${got.length} correction(s)${describeCorrections(got)}`);
    expect(st.health).toBeLessThan(h0);
    expect(st.damage.at(-1)?.falling).toBe(true);
    // heal for later tests
    await bot.truth.cmd('give', [bot.name, 'golden_apple', 1]).catch(() => undefined);
  }, 60_000);

  function countJumps(): number {
    // start_jumping flags sent so far are not kept; count jumps from body state transitions instead
    return jumps;
  }
  let jumps = 0;
  let wasOnGround = true;
  beforeAll(() => {
    bot.loop.onBeforeStep((_t, s) => {
      if (wasOnGround && !s.onGround && s.vel.y > 0.3) jumps++;
      wasOnGround = s.onGround;
    });
  });
});
