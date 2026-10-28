// Track BE: the path executor's off-path checks (nav/baritone/executor.ts, ported from Baritone's
// PathExecutor), unit rules and closed loops without a server (FakeConnection -> InputLoop <- BotSkills):
// a body shoved off the path (InputLoop.nudge: no event explains it), a push along the path, a
// teleport onto the path, knocks (set_entity_motion) on and off the leg, in a parkour run-up and into
// water, an action that overruns its estimate, a dig timeout cancelling the digger; `offPath: false` is main's behaviour.
import { describe, expect, it } from 'vitest';
import { BotSkills, type BotSkillsOptions, type SkillResult } from '../../../src/skills/index.ts';
import {
  MAX_DIST_FROM_PATH,
  MAX_MAX_DIST_FROM_PATH,
  MAX_TICKS_AWAY,
  MOVEMENT_TIMEOUT_TICKS,
  OFF_PATH_GRACE_TICKS,
  distanceFromPath,
  nodeAt,
  nodeOverrun,
  offPathState,
  skipAhead,
  type ExecNode,
} from '../../../src/skills/nav/baritone/executor.ts';
import type { NavGoal } from '../../../src/skills/nav/goals.ts';
import type { GotoReport } from '../../../src/skills/nav/navigator.ts';
import type { NavActions } from '../../../src/skills/nav/index.ts';
import type { GotoOptions } from '../../../src/skills/types.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import type { InputLoop } from '../../../src/skills/input/inputLoop.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, hillyGen, rng, surfaceFeet, type GenWorld } from './genworld.ts';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Run {
  result: SkillResult | undefined;
  ticks: number;
  pos: Vec3;
  rep: GotoReport;
}

async function drive(
  gen: GenWorld,
  start: Vec3,
  goal: NavGoal,
  o: { nav?: Partial<BotSkillsOptions>; goto?: GotoOptions; actions?: NavActions | ((loop: InputLoop) => NavActions); maxTicks?: number; during?: (t: number, h: ReturnType<typeof harness>, s: BotSkills) => void } = {},
): Promise<Run> {
  const h = harness(start);
  const skills = new BotSkills({ loop: h.loop, world: fakeWorld(gen), ...o.nav, ...(o.actions ? { actions: typeof o.actions === 'function' ? o.actions(h.loop) : o.actions } : {}) });
  h.conn.tick(3);
  let result: SkillResult | undefined;
  const p = skills.goto(goal, o.goto).then((r) => (result = r));
  let t = 0;
  const max = o.maxTicks ?? 3000;
  while (skills.nav.busy && t < max) {
    o.during?.(t, h, skills);
    h.conn.tick();
    await flush();
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t, pos: h.loop.state.pos, rep: skills.status().lastGoto! };
}

const replans = (rep: GotoReport): string[] => rep.plans.filter((p) => p.reason !== 'start' && p.reason !== 'ahead').map((p) => `${p.reason}@${p.tick}`);
const line = (n: number, z0 = 0): ExecNode[] => Array.from({ length: n }, (_, i) => ({ x: 0, y: -60, z: z0 + i, feet: -60, move: i === 0 ? 'start' : 'walk' }));
const OFF = { nav: { offPath: false } };
const GOAL: NavGoal = { type: 'block', p: { x: 0, y: -60, z: 40 } };
const START = { x: 0.5, y: -60, z: 0.5 };

describe('executor rules (Baritone PathExecutor)', () => {
  it('ports the constants', () => {
    expect(MAX_DIST_FROM_PATH).toBe(2);
    expect(MAX_MAX_DIST_FROM_PATH).toBe(3);
    expect(MAX_TICKS_AWAY).toBe(200);
    expect(MOVEMENT_TIMEOUT_TICKS).toBe(100);
    expect(OFF_PATH_GRACE_TICKS).toBe(20);
  });

  it('distance to the polyline of node centres, within the window', () => {
    const path = line(20);
    expect(distanceFromPath({ x: 0.5, y: -60, z: 5.2 }, path, 0, 19)).toBeCloseTo(0, 6);
    expect(distanceFromPath({ x: 2.5, y: -60, z: 5.2 }, path, 0, 19)).toBeCloseTo(2, 6);
    expect(distanceFromPath({ x: 0.5, y: -59, z: 5.2 }, path, 0, 19)).toBeCloseTo(1, 6);
    // beyond the window's last node
    expect(distanceFromPath({ x: 0.5, y: -60, z: 15.5 }, path, 0, 10)).toBeCloseTo(5, 6);
    expect(distanceFromPath({ x: 0.5, y: -60, z: 0.5 }, path, 30, 40)).toBe(Infinity);
    // a jump: the segment rises with the step
    const step: ExecNode[] = [
      { x: 0, y: -60, z: 0, feet: -60, move: 'start' },
      { x: 0, y: -59, z: 1, feet: -59, move: 'jump' },
    ];
    expect(distanceFromPath({ x: 0.5, y: -59.5, z: 1 }, step, 0, 1)).toBeCloseTo(0, 6);
  });

  it('off-path states: 3 blocks at once, 2 after the grace', () => {
    expect(offPathState(1.5, 1)).toBe('fine');
    expect(offPathState(2, 1)).toBe('fine');
    expect(offPathState(2.5, 1)).toBe('possibly_off');
    expect(offPathState(2.5, 20)).toBe('possibly_off');
    expect(offPathState(2.5, 21)).toBe('off');
    expect(offPathState(2.5, 200, MAX_TICKS_AWAY)).toBe('possibly_off');
    expect(offPathState(3.01, 1)).toBe('off');
  });

  it('overrun: cost + 100 ticks (x factor)', () => {
    expect(nodeOverrun(150, 50)).toBe(false);
    expect(nodeOverrun(151, 50)).toBe(true);
    expect(nodeOverrun(201, 50, 2)).toBe(true);
    expect(nodeOverrun(200, 50, 2)).toBe(false);
  });

  it('nodeAt / skipAhead find the node the body stands in', () => {
    const path = line(30);
    expect(nodeAt({ x: 0.3, y: -60, z: 7.9 }, path, 0, 29)).toBe(7);
    expect(nodeAt({ x: 1.3, y: -60, z: 7.9 }, path, 0, 29)).toBe(-1);
    expect(nodeAt({ x: 0.3, y: -58, z: 7.9 }, path, 0, 29)).toBe(-1);
    expect(skipAhead({ x: 0.5, y: -60, z: 12.5 }, path, 6)).toBe(12);
    expect(skipAhead({ x: 0.5, y: -60, z: 6.5 }, path, 6)).toBe(-1); // the aim itself: the follower's business
    expect(skipAhead({ x: 0.5, y: -60, z: 3.5 }, path, 6)).toBe(-1);
    const swim = path.map((n, i) => (i === 12 ? { ...n, move: 'swim' } : n));
    expect(skipAhead({ x: 0.5, y: -60, z: 12.5 }, swim, 6)).toBe(-1);
  });
});

describe('off the path (closed loop)', () => {
  it('a 3.2-block shove sideways re-plans within 2 ticks and arrives', async () => {
    const shove = (t: number, h: ReturnType<typeof harness>) => {
      if (t === 40) h.loop.nudge({ x: 3.2, y: 0, z: 0 });
    };
    const run = await drive(flatGen(), START, GOAL, { during: shove });
    expect(run.result).toEqual({ ok: true });
    expect(run.rep.offPath).toBe(1);
    const off = run.rep.plans.filter((p) => p.reason === 'off_path');
    expect(off).toHaveLength(1);
    // goto tick t + 1 is the tick after the shove (goto ticks start at 1)
    expect(off[0]!.tick - 41).toBeLessThanOrEqual(2);
    const before = await drive(flatGen(), START, GOAL, { ...OFF, during: shove });
    expect(before.result).toEqual({ ok: true });
    expect(replans(before.rep)).toEqual([]);
    console.log(`[nav-offpath] shove 3.2 sideways: off ${run.ticks} ticks ${JSON.stringify(replans(run.rep))}, main ${before.ticks} ticks ${JSON.stringify(replans(before.rep))}`);
  });

  it('a 1.5-block nudge does not re-plan', async () => {
    const run = await drive(flatGen(), START, GOAL, { during: (t, h) => t === 40 && h.loop.nudge({ x: 1.5, y: 0, z: 0 }) });
    expect(run.result).toEqual({ ok: true });
    expect(replans(run.rep)).toEqual([]);
    expect(run.rep.offPath).toBe(0);
  });

  it('a 2.5-block nudge that comes back within the grace does not re-plan; one held off re-plans after it', async () => {
    // pushed 2.5 off, back to 1 off after 15 ticks (the push lets go, a slope rolls it back)
    const back = await drive(flatGen(), START, GOAL, {
      during: (t, h) => {
        if (t === 40) h.loop.nudge({ x: 2.5, y: 0, z: 0 });
        if (t === 55) h.loop.nudge({ x: 1.5 - h.loop.state.pos.x, y: 0, z: 0 });
      },
    });
    expect(back.result).toEqual({ ok: true });
    expect(replans(back.rep)).toEqual([]);
    // held 2.5 off the path's line (x 0.5) for 40 ticks: a push that does not let go
    const held = await drive(flatGen(), START, GOAL, {
      during: (t, h) => {
        if (t >= 40 && t < 80) {
          const p = h.loop.state.pos;
          h.loop.nudge({ x: 3 - p.x, y: 0, z: 0 });
        }
      },
    });
    expect(held.result).toEqual({ ok: true });
    const off = held.rep.plans.filter((p) => p.reason === 'off_path');
    expect(off.length).toBeGreaterThanOrEqual(1);
    expect(off[0]!.tick).toBeGreaterThanOrEqual(41 + OFF_PATH_GRACE_TICKS);
    expect(off[0]!.tick).toBeLessThanOrEqual(41 + OFF_PATH_GRACE_TICKS + 3);
  });

  /** A zigzag: a closed 11-wide corridor along +z with walls across, the gap alternating east / west (the follower cannot see past a wall). */
  function zigzag(): GenWorld {
    const gen = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 80 });
    const w = (x0: number, z0: number, x1: number, z1: number) => gen.fill({ x: x0, y: -60, z: z0 }, { x: x1, y: -58, z: z1 }, 'stone');
    w(-6, -1, -6, 44);
    w(6, -1, 6, 44);
    for (let i = 0; i < 4; i++) {
      const z = 8 + i * 9;
      if (i % 2 === 0) w(-5, z, 2, z);
      else w(-2, z, 5, z);
    }
    return gen;
  }
  const ZIG_GOAL: NavGoal = { type: 'block', p: { x: 0, y: -60, z: 42 } };

  /** The path main plans from START, and a push (or teleport) at tick 30 onto the centre of its node `k`. */
  function onto(gen: GenWorld, k: number, tp: boolean): (t: number, h: ReturnType<typeof harness>) => void {
    const probe = harness(START);
    const skills = new BotSkills({ loop: probe.loop, world: fakeWorld(gen) });
    probe.conn.tick(3);
    const path = skills.nav.plan(ZIG_GOAL)!.path;
    const n = path[k]!;
    return (t, h) => {
      if (t !== 30) return;
      const p = h.loop.state.pos;
      if (!tp) h.loop.nudge({ x: n.x + 0.5 - p.x, y: n.feet - p.y, z: n.z + 0.5 - p.z });
      else h.conn.receive('move_player', { runtime_id: 7, position: { x: n.x + 0.5, y: n.feet + 1.62, z: n.z + 0.5 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'teleport', on_ground: true, ridden_runtime_id: 0, tick: 0n });
    };
  }

  it('pushed forward along a winding path: skips ahead, no re-plan, not slower than main', async () => {
    const push = onto(zigzag(), 25, false);
    const run = await drive(zigzag(), START, ZIG_GOAL, { during: push });
    const before = await drive(zigzag(), START, ZIG_GOAL, { ...OFF, during: push });
    expect(run.result).toEqual({ ok: true });
    expect(before.result).toEqual({ ok: true });
    expect(run.rep.skips).toBeGreaterThanOrEqual(1);
    expect(replans(run.rep)).toEqual([]);
    expect(run.ticks).toBeLessThanOrEqual(before.ticks);
    console.log(`[nav-offpath] zigzag, pushed to node 25: off ${run.ticks} ticks ${JSON.stringify(replans(run.rep))}, main ${before.ticks} ticks ${JSON.stringify(replans(before.rep))}`);
  });

  it('a teleport onto a later node of a winding path: the leg restarts there (main re-plans)', async () => {
    const tp = onto(zigzag(), 25, true);
    const run = await drive(zigzag(), START, ZIG_GOAL, { during: tp });
    const before = await drive(zigzag(), START, ZIG_GOAL, { ...OFF, during: tp });
    expect(run.result).toEqual({ ok: true });
    expect(before.result).toEqual({ ok: true });
    expect(replans(run.rep)).toEqual([]);
    expect(run.rep.snaps).toBe(1);
    expect(replans(before.rep).map((r) => r.split('@')[0])).toEqual(['correction']);
    console.log(`[nav-offpath] zigzag, teleported to node 25: off ${run.ticks} ticks, main ${before.ticks} ticks`);
  });

  it('a teleport off the path still re-plans (correction)', async () => {
    const tp = (t: number, h: ReturnType<typeof harness>) => {
      if (t !== 30) return;
      const p = h.loop.state.pos;
      h.conn.receive('move_player', { runtime_id: 7, position: { x: p.x + 5, y: -60 + 1.62, z: p.z }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'teleport', on_ground: true, ridden_runtime_id: 0, tick: 0n });
    };
    const run = await drive(flatGen(), START, GOAL, { during: tp });
    expect(run.result).toEqual({ ok: true });
    expect(replans(run.rep).map((r) => r.split('@')[0])).toEqual(['correction']);
  });

  /** A closed corridor with a 3-high dirt wall across at z 10: the only way is to dig 2 cells. */
  function digCorridor(): GenWorld {
    const gen = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 40 });
    const wall = (x0: number, z0: number, x1: number, z1: number, h = 4, b = 'stone') => gen.fill({ x: x0, y: -60, z: z0 }, { x: x1, y: -61 + h, z: z1 }, b);
    wall(-2, -1, -2, 20);
    wall(2, -1, 2, 20);
    wall(-2, -1, 2, -1);
    wall(-2, 20, 2, 20);
    wall(-1, 10, 1, 10, 3, 'dirt');
    return gen;
  }
  const DIG_START = { x: 0.5, y: -60, z: 2.5 };
  const DIG_GOAL: NavGoal = { type: 'block', p: { x: 0, y: -60, z: 15 } };

  it('an action that overruns its estimate between two digs fails as overrun (the next cell not dug); main digs on', async () => {
    // each dig takes 100 ticks; the overrun budget is forced to 0.5 x the node's cost (about 80 ticks)
    const slow = (gen: GenWorld, digs: string[]) => (loop: InputLoop): NavActions => ({
      dig: async (p) => {
        digs.push(`${p.x},${p.y},${p.z}`);
        await loop.waitTicks(100);
        gen.set(p.x, p.y, p.z, 'air');
        return { ok: true };
      },
    });
    const g1 = digCorridor();
    const d1: string[] = [];
    const run = await drive(g1, DIG_START, DIG_GOAL, { goto: { allowBreak: true }, actions: slow(g1, d1), nav: { overrun: { factor: 0.5, margin: 0 } }, maxTicks: 3000 });
    const over = run.rep.plans.filter((p) => p.reason === 'overrun');
    expect(run.rep.overruns, JSON.stringify(run.rep.plans)).toBeGreaterThanOrEqual(1);
    expect(over.length).toBeGreaterThanOrEqual(1);
    // the overrun came when the first dig finished (never while a dig was pending), so the first cell was dug
    expect(d1.length).toBeGreaterThanOrEqual(1);
    expect(new Set(d1).size).toBe(d1.length); // a cell that overran is not dug again
    const g2 = digCorridor();
    const d2: string[] = [];
    const before = await drive(g2, DIG_START, DIG_GOAL, { ...OFF, goto: { allowBreak: true }, actions: slow(g2, d2), nav: { offPath: false, overrun: { factor: 0.5, margin: 0 } }, maxTicks: 3000 });
    expect(before.result).toEqual({ ok: true });
    expect(d2).toHaveLength(2);
  });

  it('a dig that never finishes is not an overrun (pending); the dig timeout (600 ticks per cell) cancels the digger job', async () => {
    const digs: string[] = [];
    let cancels = 0;
    const actions: NavActions = {
      dig: (p) => {
        digs.push(`${p.x},${p.y},${p.z}`);
        return new Promise<SkillResult>(() => undefined);
      },
    };
    const run = await drive(digCorridor(), DIG_START, DIG_GOAL, { goto: { allowBreak: true }, actions, nav: { cancelDig: () => cancels++ }, maxTicks: 2000 });
    expect(run.rep.overruns).toBe(0);
    expect(cancels).toBeGreaterThanOrEqual(1);
    expect(run.rep.plans.some((p) => p.reason === 'action' && p.tick >= 1200)).toBe(true);
  });

  /** set_entity_motion for the own player (a knock), applied now. */
  const knock = (h: ReturnType<typeof harness>, v: Vec3) => h.conn.receive('set_entity_motion', { runtime_entity_id: 7n, velocity: v, tick: 0n });
  const firstReplan = (rep: GotoReport): number => rep.plans.find((p) => p.reason !== 'start' && p.reason !== 'ahead')?.tick ?? Infinity;

  it('a knock that lands on the leg walks on; one that lands off it re-plans no later than main', async () => {
    const along = (t: number, h: ReturnType<typeof harness>) => t === 30 && knock(h, { x: 0, y: 0.4, z: 0.6 });
    const on = await drive(flatGen(), START, GOAL, { during: along });
    const off = await drive(flatGen(), START, GOAL, { ...OFF, during: along });
    expect(on.result).toEqual({ ok: true });
    expect(replans(on.rep)).toEqual([]);
    expect(replans(off.rep).map((r) => r.split('@')[0])).toEqual(['correction']);
    const side = (t: number, h: ReturnType<typeof harness>) => t === 30 && knock(h, { x: 0.8, y: 0.4, z: 0 });
    const on2 = await drive(flatGen(), START, GOAL, { during: side });
    const off2 = await drive(flatGen(), START, GOAL, { ...OFF, during: side });
    expect(on2.result).toEqual({ ok: true });
    // re-planned at the knock as main does (from where the body stood); the landing may be off that plan too (off_path)
    expect(replans(on2.rep)[0]?.split('@')[0]).toBe('correction');
    expect(firstReplan(on2.rep)).toBeLessThanOrEqual(firstReplan(off2.rep));
    console.log(`[nav-offpath] knock along: ${on.ticks} ticks (main ${off.ticks}); knock sideways: re-plan at ${firstReplan(on2.rep)} (main ${firstReplan(off2.rep)})`);
  });

  it('a knock during a parkour run-up or into water re-plans no later than main', async () => {
    // a 2-block gap over a pit with water (nav-variety's gapWorld): knocked while the follower aims at the parkour node
    const gap = (): GenWorld => {
      const gen = flatGen();
      gen.fill({ x: -64, y: -63, z: 5 }, { x: 63, y: -61, z: 6 }, 'air');
      gen.fill({ x: -64, y: -64, z: 5 }, { x: 63, y: -64, z: 6 }, 'water');
      return gen;
    };
    const runUp = () => {
      let done = false;
      return (_t: number, h: ReturnType<typeof harness>, s: BotSkills) => {
        if (done) return;
        const f = (s.nav as unknown as { active?: { follower?: { path: readonly { move: string }[]; index: number } } }).active?.follower;
        if (f && f.path[f.index]?.move === 'parkour') {
          done = true;
          knock(h, { x: 0.3, y: 0.3, z: 0 });
        }
      };
    };
    const pg = { type: 'block', p: { x: 0, y: -60, z: 10 } } as NavGoal;
    const pOn = await drive(gap(), { x: 0.5, y: -60, z: 1.5 }, pg, { during: runUp() });
    const pOff = await drive(gap(), { x: 0.5, y: -60, z: 1.5 }, pg, { ...OFF, during: runUp() });
    expect(firstReplan(pOff.rep)).toBeLessThan(Infinity);
    expect(firstReplan(pOn.rep)).toBeLessThanOrEqual(firstReplan(pOff.rep));
    // a pool east of the lane: knocked into it
    const pool = (): GenWorld => {
      const gen = flatGen();
      gen.fill({ x: 2, y: -61, z: 4 }, { x: 6, y: -61, z: 20 }, 'water');
      return gen;
    };
    const into = (t: number, h: ReturnType<typeof harness>) => t === 30 && knock(h, { x: 0.9, y: 0.35, z: 0 });
    const wOn = await drive(pool(), START, GOAL, { during: into });
    const wOff = await drive(pool(), START, GOAL, { ...OFF, during: into });
    expect(wOn.result).toEqual({ ok: true });
    expect(firstReplan(wOff.rep)).toBeLessThan(Infinity);
    expect(firstReplan(wOn.rep)).toBeLessThanOrEqual(firstReplan(wOff.rep));
    console.log(`[nav-offpath] knock in the run-up: re-plan at ${firstReplan(pOn.rep)} (main ${firstReplan(pOff.rep)}); into water: ${firstReplan(wOn.rep)} (main ${firstReplan(wOff.rep)})`);
  });

  it('20 goals on the hilly world: no off-path re-plans, the same plans as main', async () => {
    const gen = hillyGen(11);
    const r = rng(5);
    let tried = 0;
    let offPlans = 0;
    let mainPlans = 0;
    let skips = 0;
    let offTicks = 0;
    let mainTicks = 0;
    while (tried < 20) {
      const sx = Math.floor(r() * 80) - 40;
      const sz = Math.floor(r() * 80) - 40;
      const gx = Math.floor(r() * 80) - 40;
      const gz = Math.floor(r() * 80) - 40;
      const sf = surfaceFeet(gen, sx, sz);
      const gf = surfaceFeet(gen, gx, gz);
      if (sf === undefined || gf === undefined) continue;
      const { conn, loop } = harness({ x: sx + 0.5, y: sf, z: sz + 0.5 });
      const probe = new BotSkills({ loop, world: fakeWorld(gen) });
      conn.tick(3);
      const goal: NavGoal = { type: 'block', p: { x: gx, y: Math.floor(gf), z: gz } };
      if (probe.nav.plan(goal)?.status !== 'found') continue;
      tried++;
      const start = { x: sx + 0.5, y: sf, z: sz + 0.5 };
      const on = await drive(gen, start, goal, { maxTicks: 4000 });
      const off = await drive(gen, start, goal, { ...OFF, maxTicks: 4000 });
      expect(on.result, `${sx},${sz} -> ${gx},${gz}`).toEqual({ ok: true });
      expect(on.rep.offPath).toBe(0);
      expect(on.rep.overruns).toBe(0);
      offPlans += replans(on.rep).length;
      mainPlans += replans(off.rep).length;
      skips += on.rep.skips ?? 0;
      offTicks += on.ticks;
      mainTicks += off.ticks;
    }
    console.log(`[nav-offpath] hilly 20: re-plans ${offPlans} (main ${mainPlans}), skips ${skips}, ticks ${offTicks} (main ${mainTicks})`);
    expect(offPlans).toBeLessThanOrEqual(mainPlans);
  });
});
