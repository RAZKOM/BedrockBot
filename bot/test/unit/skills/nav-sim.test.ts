// Closed-loop movement tests without a server: FakeConnection -> InputLoop (own physics with the real
// block shapes) <- BotSkills / Navigator on generated worlds. The "server" here is the same physics,
// so these test planning, following, re-planning and stuck handling, not the model's accuracy
// (that is the e2e tests' job).
import { describe, expect, it } from 'vitest';
import { BotSkills, type SkillResult } from '../../../src/skills/index.ts';
import type { Goal } from '../../../src/skills/nav/goals.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, hillyGen, rng, surfaceFeet, type GenWorld } from './genworld.ts';

interface Run {
  result: SkillResult | undefined;
  ticks: number;
  pos: Vec3;
  skills: BotSkills;
  minFeet: number;
  inWaterTicks: number;
}

async function runGoto(gen: GenWorld, start: Vec3, goal: Goal, opts: { maxTicks?: number; during?: (t: number, s: BotSkills) => void; skills?: (s: BotSkills) => void } = {}): Promise<Run> {
  const { conn, loop } = harness(start);
  const world = fakeWorld(gen);
  const skills = new BotSkills({ loop, world });
  opts.skills?.(skills);
  conn.tick(5);
  let result: SkillResult | undefined;
  const p = skills.goto(goal).then((r) => (result = r));
  let t = 0;
  let minFeet = Infinity;
  let inWaterTicks = 0;
  const max = opts.maxTicks ?? 3000;
  while (skills.nav.busy && t < max) {
    opts.during?.(t, skills);
    conn.tick();
    minFeet = Math.min(minFeet, loop.state.pos.y);
    if (loop.state.inWater) inWaterTicks++;
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t, pos: loop.state.pos, skills, minFeet, inWaterTicks };
}

const hd = (a: Vec3, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

describe('goto on a flat world (closed loop)', () => {
  it('walks to 10 random points within 30 blocks and stops within 0.3 of each', async () => {
    const gen = flatGen();
    const r = rng(7);
    for (let i = 0; i < 10; i++) {
      const gx = Math.floor(r() * 60) - 30;
      const gz = Math.floor(r() * 60) - 30;
      const run = await runGoto(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: gx, y: -60, z: gz } });
      expect(run.result, `goal ${gx},${gz}`).toEqual({ ok: true });
      expect(hd(run.pos, { x: gx + 0.5, z: gz + 0.5 })).toBeLessThanOrEqual(0.3);
      // a straight walk at 0.2159 blocks/tick (sprinting is faster) plus turning
      expect(run.ticks).toBeLessThan(Math.hypot(gx, gz) / 0.2 + 60);
    }
  });

  it('sprints on a long straight run', async () => {
    const gen = flatGen();
    const run = await runGoto(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'xz', x: 0, z: 40 });
    expect(run.result).toEqual({ ok: true });
    expect(run.skills.status().lastGoto!.sprintTicks).toBeGreaterThan(50);
  });

  it('goto with sprint off never sprints', async () => {
    const gen = flatGen();
    const { conn, loop } = harness({ x: 0.5, y: -60, z: 0.5 });
    const skills = new BotSkills({ loop, world: fakeWorld(gen) });
    conn.tick(2);
    const p = skills.goto({ type: 'xz', x: 0, z: 30 }, { sprint: false });
    for (let i = 0; i < 400 && skills.nav.busy; i++) conn.tick();
    expect(await p).toEqual({ ok: true });
    expect(conn.sent.some((s) => s.input_data.includes('sprinting'))).toBe(false);
  });
});

describe('goto on built terrain (closed loop)', () => {
  /** 10-high staircase of full blocks (+z), platform on top, a 3-block drop on the far side. */
  function hill(): GenWorld {
    const gen = flatGen();
    for (let i = 0; i < 10; i++) gen.fill({ x: 0, y: -60, z: 5 + i }, { x: 2, y: -60 + i, z: 5 + i }, 'stone');
    gen.fill({ x: 0, y: -60, z: 15 }, { x: 2, y: -51, z: 18 }, 'stone');
    // 3-block drop: a 3-high ledge east of the top platform
    gen.fill({ x: 3, y: -60, z: 15 }, { x: 6, y: -54, z: 18 }, 'stone');
    return gen;
  }

  it('climbs a 10-high staircase', async () => {
    const run = await runGoto(hill(), { x: 1.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 1, y: -50, z: 16 } });
    expect(run.result).toEqual({ ok: true });
    expect(run.pos.y).toBeCloseTo(-50, 3);
    const plans = run.skills.status().lastGoto!.plans;
    expect(plans).toHaveLength(1);
  });

  it('descends a 3-block drop', async () => {
    // from the top platform (feet -50) down to the ledge (feet -53)
    const run = await runGoto(hill(), { x: 1.5, y: -50, z: 16.5 }, { type: 'block', p: { x: 5, y: -53, z: 16 } });
    expect(run.result).toEqual({ ok: true });
    expect(run.pos.y).toBeCloseTo(-53, 3);
  });

  it('steps up bottom slabs without jumping', async () => {
    const gen = flatGen();
    gen.fill({ x: -1, y: -60, z: 3 }, { x: 1, y: -60, z: 3 }, 'oak_slab');
    gen.fill({ x: -1, y: -60, z: 4 }, { x: 1, y: -60, z: 8 }, 'stone');
    const { conn, loop } = harness({ x: 0.5, y: -60, z: 0.5 });
    const skills = new BotSkills({ loop, world: fakeWorld(gen) });
    conn.tick(2);
    const p = skills.goto({ type: 'block', p: { x: 0, y: -59, z: 6 } });
    for (let i = 0; i < 300 && skills.nav.busy; i++) conn.tick();
    expect(await p).toEqual({ ok: true });
    expect(loop.state.pos.y).toBeCloseTo(-59, 3);
    expect(conn.sent.some((s) => s.input_data.includes('start_jumping'))).toBe(false);
    expect(skills.status().lastGoto!.plans[0]!.nodes).toBeGreaterThan(5);
  });

  it('walks around a water pool instead of through it', async () => {
    const gen = flatGen();
    gen.fill({ x: -3, y: -61, z: 3 }, { x: 3, y: -61, z: 7 }, 'water');
    const run = await runGoto(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 10 } });
    expect(run.result).toEqual({ ok: true });
    expect(run.inWaterTicks).toBe(0);
    expect(run.minFeet).toBeGreaterThanOrEqual(-60.0001);
  });

  it('refuses a goal in water or behind lava as unreachable', async () => {
    const gen = flatGen();
    gen.fill({ x: -3, y: -61, z: 3 }, { x: 3, y: -61, z: 7 }, 'water');
    const inWater = await runGoto(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -61, z: 5 } });
    expect(inWater.result).toEqual({ ok: false, reason: 'unreachable' });
    // an island ringed by lava
    const lava = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 32 });
    lava.fill({ x: 4, y: -61, z: 4 }, { x: 10, y: -61, z: 10 }, 'lava');
    lava.put(7, -61, 7, 'stone');
    const behind = await runGoto(lava, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 7, y: -60, z: 7 } });
    // the search also touches the edge of the (finite) generated world, so it cannot prove "no path":
    // it walks to the closest node, waits for the "unloaded" world (200 ticks, not a failure), then
    // gives up after 3 failed re-plans
    expect(behind.result).toEqual({ ok: false, reason: 'unreachable' });
    expect(behind.ticks).toBeLessThan(400);
    expect(behind.skills.status().lastGoto!.unloadedWait).toBeGreaterThan(0);
    expect(behind.inWaterTicks).toBe(0);
    // a fully known world proves it at once
    const closed = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 32 });
    closed.fill({ x: -16, y: -60, z: -16 }, { x: 15, y: -58, z: -16 }, 'stone');
    closed.fill({ x: -16, y: -60, z: 15 }, { x: 15, y: -58, z: 15 }, 'stone');
    closed.fill({ x: -16, y: -60, z: -16 }, { x: -16, y: -58, z: 15 }, 'stone');
    closed.fill({ x: 15, y: -60, z: -16 }, { x: 15, y: -58, z: 15 }, 'stone');
    closed.fill({ x: 4, y: -61, z: 4 }, { x: 10, y: -61, z: 10 }, 'lava');
    closed.put(7, -61, 7, 'stone');
    const proven = await runGoto(closed, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 7, y: -60, z: 7 } });
    expect(proven.result).toEqual({ ok: false, reason: 'unreachable' });
    expect(proven.ticks).toBeLessThan(3);
  });

  it('re-plans around a wall that appears mid-path (block updates)', async () => {
    const gen = flatGen();
    let built = false;
    const run = await runGoto(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 20 } }, {
      during: (_t, s) => {
        if (!built && s.status().lastGoto && s.status().lastGoto!.distance > 3) {
          built = true;
          for (let x = -4; x <= 4; x++) for (let y = -60; y <= -58; y++) gen.set(x, y, 10, 'stone');
        }
      },
    });
    expect(built).toBe(true);
    expect(run.result).toEqual({ ok: true });
    const plans = run.skills.status().lastGoto!.plans;
    expect(plans.map((p) => p.reason)).toContain('block');
  });

  it('gives up with unreachable after 3 stuck re-plans (an obstacle the planner cannot see)', async () => {
    const gen = flatGen();
    const { conn, loop } = harness({ x: 0.5, y: -60, z: 0.5 });
    const skills = new BotSkills({ loop, world: fakeWorld(gen) });
    // the physics sees a wall at z = 5 that the planner's world does not have
    const real = loop.world;
    loop.world = {
      ...real,
      solidAt: (x, y, z) => (z === 5 && y >= -60 && y <= -55 ? true : real.solidAt(x, y, z)),
      boxesAt: (x, y, z) => (z === 5 && y >= -60 && y <= -55 ? [[0, 0, 0, 1, 1, 1]] : real.boxesAt!(x, y, z)),
    };
    conn.tick(2);
    const p = skills.goto({ type: 'block', p: { x: 0, y: -60, z: 10 } });
    let t = 0;
    while (skills.nav.busy && t < 2000) {
      conn.tick();
      t++;
    }
    expect(await p).toEqual({ ok: false, reason: 'unreachable' });
    const rep = skills.status().lastGoto!;
    expect(rep.stuck).toBe(3);
    // per-move timeouts (2 x the estimate of the straight line being walked + 10 ticks) or the
    // 40-tick no-progress fallback, whichever comes first
    expect(rep.plans.filter((x) => x.reason === 'timeout' || x.reason === 'stuck')).toHaveLength(2);
    expect(t).toBeLessThan(250);
  });

  it('times out and can be cancelled', async () => {
    const gen = flatGen();
    const { conn, loop } = harness({ x: 0.5, y: -60, z: 0.5 });
    const skills = new BotSkills({ loop, world: fakeWorld(gen) });
    conn.tick(2);
    // timeoutTicks is a budget without progress (2026-10-30): a walk that keeps closing in on the goal runs on,
    // up to the hard cap of 20 budgets. A goal 5000 blocks away cannot be reached in 20 x 20 ticks, so the cap ends it.
    const p1 = skills.goto({ type: 'xz', x: 0, z: 5000 }, { timeoutTicks: 20 });
    conn.tick(25);
    let settled = false;
    void p1.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // still walking: it made progress inside the budget
    conn.tick(400);
    expect(await p1).toEqual({ ok: false, reason: 'timeout' });
    const p2 = skills.goto({ type: 'xz', x: 0, z: 50 });
    conn.tick(5);
    skills.cancel();
    expect(await p2).toEqual({ ok: false, reason: 'interrupted' });
    expect(loop.command.forward).toBe(0);
  });
});

describe('goto over generated hills (closed loop)', () => {
  it('reaches 20 random reachable surface goals on a hilly world', async () => {
    const gen = hillyGen(11);
    const r = rng(5);
    let reached = 0;
    let tried = 0;
    const failures: string[] = [];
    while (tried < 20) {
      const sx = Math.floor(r() * 80) - 40;
      const sz = Math.floor(r() * 80) - 40;
      const gx = Math.floor(r() * 80) - 40;
      const gz = Math.floor(r() * 80) - 40;
      const sf = surfaceFeet(gen, sx, sz);
      const gf = surfaceFeet(gen, gx, gz);
      if (sf === undefined || gf === undefined) continue;
      const { conn, loop } = harness({ x: sx + 0.5, y: sf, z: sz + 0.5 });
      const skills = new BotSkills({ loop, world: fakeWorld(gen) });
      conn.tick(3);
      const plan = skills.nav.plan({ type: 'block', p: { x: gx, y: Math.floor(gf), z: gz } });
      if (plan?.status !== 'found') continue;
      tried++;
      const run = await runGoto(gen, { x: sx + 0.5, y: sf, z: sz + 0.5 }, { type: 'block', p: { x: gx, y: Math.floor(gf), z: gz } }, { maxTicks: 4000 });
      if (run.result?.ok) reached++;
      else failures.push(`${sx},${sz} -> ${gx},${gz}: ${JSON.stringify(run.result)} at ${JSON.stringify(run.pos)}`);
      expect(run.inWaterTicks).toBe(0);
    }
    expect(failures).toEqual([]);
    expect(reached).toBe(20);
  });
});
