// Navigation v2 (PLAN.md tasks 7.1 / 7.2, planner side) without a server: tick costs, the surface
// preference (cave mouths, pits), segment planning with plan-ahead, sliced searches, unloaded world
// ending a segment, per-move timeouts, retreat to the last safe node, and the dig-through,
// pillar-up and door moves with fake actions that change the generated world.
import { describe, expect, it } from 'vitest';
import { BotSkills, type BotSkillsOptions } from '../../../src/skills/index.ts';
import { DEFAULT_COSTS, NavGrid, TICKS, findPath, type NavActions, type PathNode } from '../../../src/skills/nav/index.ts';
import type { Goal } from '../../../src/skills/nav/goals.ts';
import type { GotoOptions, SkillResult } from '../../../src/skills/types.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import type { InputLoop } from '../../../src/skills/input/inputLoop.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Drive {
  result: SkillResult | undefined;
  ticks: number;
  pos: Vec3;
  skills: BotSkills;
  minFeet: number;
  underTicks: number;
  inWaterTicks: number;
  stallTicks: number;
}

/** Closed-loop goto that lets action promises settle between ticks. */
async function drive(
  gen: GenWorld,
  start: Vec3,
  goal: Goal,
  o: {
    goto?: GotoOptions;
    nav?: Partial<BotSkillsOptions>;
    actions?: (loop: InputLoop) => NavActions;
    maxTicks?: number;
    world?: ReturnType<typeof fakeWorld>;
    during?: (t: number, s: BotSkills, h: ReturnType<typeof harness>) => void;
  } = {},
): Promise<Drive> {
  const h = harness(start);
  const { conn, loop } = h;
  const skills = new BotSkills({ loop, world: o.world ?? fakeWorld(gen), ...o.nav, ...(o.actions ? { actions: o.actions(loop) } : {}) });
  conn.tick(3);
  let result: SkillResult | undefined;
  const p = skills.goto(goal, o.goto).then((r) => (result = r));
  const sky = new NavGrid(gen);
  let t = 0;
  let minFeet = Infinity;
  let underTicks = 0;
  let inWaterTicks = 0;
  let stallTicks = 0;
  const max = o.maxTicks ?? 3000;
  while (skills.nav.busy && t < max) {
    o.during?.(t, skills, h);
    conn.tick();
    await flush();
    const s = loop.state;
    minFeet = Math.min(minFeet, s.pos.y);
    if (s.inWater) inWaterTicks++;
    if (s.onGround && sky.underground(Math.floor(s.pos.x), Math.floor(s.pos.z), s.pos.y)) underTicks++;
    if (t > 20 && Math.hypot(s.vel.x, s.vel.z) < 0.02) stallTicks++;
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t, pos: loop.state.pos, skills, minFeet, underTicks, inWaterTicks, stallTicks };
}

/**
 * Fake world-changing actions on a GenWorld, behaving like the real ones on BDS: the Digger takes
 * some ticks; Track O's PlaceSkill jumps by itself and places once the feet are 0.05 above the cell;
 * Track O's UseSkill toggles the door's lower half only (the upper half's open_bit stays 0).
 */
function fakeActions(gen: GenWorld, log: string[], loop: InputLoop): NavActions {
  const k = (p: Vec3) => `${p.x},${p.y},${p.z}`;
  return {
    dig: async (p) => {
      log.push(`dig ${k(p)} ${gen.blockAt(p.x, p.y, p.z)?.name}`);
      await loop.waitTicks(8);
      gen.set(p.x, p.y, p.z, 'air');
      return { ok: true };
    },
    place: async (p, face) => {
      log.push(`place ${k(p)} ${face}`);
      loop.setCommand({ forward: 0, jump: true });
      for (let i = 0; i < 20 && loop.state.pos.y < p.y + 1.05; i++) await loop.waitTicks(1);
      loop.setCommand({ jump: false });
      if (loop.state.pos.y < p.y + 1.05) return { ok: false, reason: 'not_above' };
      gen.set(p.x, p.y, p.z, 'cobblestone');
      return { ok: true };
    },
    useBlock: (p) => {
      const b = gen.blockAt(p.x, p.y, p.z)!;
      const open = Number(b.states.open_bit ?? 0) === 1 ? 0 : 1;
      log.push(`use ${k(p)} ${b.name} -> ${open ? 'open' : 'closed'}`);
      gen.set(p.x, p.y, p.z, b.name, { ...b.states, open_bit: open });
      return Promise.resolve({ ok: true });
    },
    throwawayItems: ['cobblestone'],
  };
}

const cobble = () => ({ slots: [{ name: 'cobblestone', count: 64 }], selected: 0 });
const wall = (gen: GenWorld, x1: number, z1: number, x2: number, z2: number, h = 3, block = 'stone') => gen.fill({ x: x1, y: -60, z: z1 }, { x: x2, y: -61 + h, z: z2 }, block);

describe('tick costs from the movement model', () => {
  it('walk 4.633, sprint 3.564 ticks per block; jump 9 ticks of air time; falls of 1 / 2 / 3 blocks take 5 / 7 / 9 ticks', () => {
    expect(TICKS.walk).toBeCloseTo(4.633, 3);
    expect(TICKS.sprint).toBeCloseTo(3.564, 3);
    expect(TICKS.jumpAir).toBe(9);
    expect([TICKS.fall[1], TICKS.fall[2], TICKS.fall[3]]).toEqual([5, 7, 9]);
    expect(DEFAULT_COSTS.walk).toBe(TICKS.sprint);
  });

  it('sprint off plans at the walking rate', () => {
    const gen = flatGen();
    const { conn, loop } = harness({ x: 0.5, y: -60, z: 0.5 });
    const skills = new BotSkills({ loop, world: fakeWorld(gen) });
    conn.tick(2);
    const fast = skills.nav.plan({ type: 'block', p: { x: 0, y: -60, z: 10 } })!;
    const slow = skills.nav.plan({ type: 'block', p: { x: 0, y: -60, z: 10 } }, undefined, { sprint: false })!;
    expect(fast.cost).toBeCloseTo(10 * TICKS.sprint, 6);
    expect(slow.cost).toBeCloseTo(10 * TICKS.walk, 6);
  });
});

describe('surface preference', () => {
  /** A stepped hill (4 layers) across the line z -5..15 with a 1-wide tunnel through it at x 0. */
  function caveHill(): GenWorld {
    const gen = flatGen();
    for (let k = 0; k < 4; k++) gen.fill({ x: -10 + k, y: -60 + k, z: -5 + k }, { x: 10 - k, y: -60 + k, z: 15 - k }, 'stone');
    gen.fill({ x: 0, y: -60, z: -5 }, { x: 0, y: -59, z: 15 }, 'air');
    return gen;
  }

  it('the straight line through a cave stays on the surface (and would take the tunnel without the penalty)', () => {
    const gen = caveHill();
    const start = { x: 0, y: -60, z: -20 };
    const goal: Goal = { type: 'block', p: { x: 0, y: -60, z: 30 } };
    const grid = new NavGrid(gen);
    const r = findPath(grid, start, goal);
    expect(r.status).toBe('found');
    const under = r.path.filter((n) => grid.underground(n.x, n.z, n.feet));
    expect(under).toEqual([]);

    const naive = findPath(new NavGrid(gen), start, goal, { costs: { underground: 0 } });
    expect(naive.path.some((n) => n.x === 0 && n.z === 5 && n.feet === -60)).toBe(true);
  });

  it('closed loop: walks over the hill, never under a roof', async () => {
    const run = await drive(caveHill(), { x: 0.5, y: -60, z: -19.5 }, { type: 'block', p: { x: 0, y: -60, z: 30 } });
    expect(run.result).toEqual({ ok: true });
    expect(run.underTicks).toBe(0);
  });

  /** A 3-deep 3 x 3 pit on the line z 8..10. */
  function pit(): GenWorld {
    const gen = flatGen();
    gen.fill({ x: -1, y: -63, z: 8 }, { x: 1, y: -61, z: 10 }, 'air');
    return gen;
  }

  it('never enters a 3-deep pit on the line, also with tiny segments (many partial ends next to it)', async () => {
    for (const segmentNodes of [20_000, 40, 12]) {
      const log: string[] = [];
      const run = await drive(pit(), { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 20 } }, { nav: { segmentNodes, logger: undefined } });
      log.push(`${segmentNodes}: ${JSON.stringify(run.result)} minFeet ${run.minFeet} segments ${run.skills.status().lastGoto!.segments}`);
      expect(run.result, log.join('\n')).toEqual({ ok: true });
      expect(run.minFeet, log.join('\n')).toBeGreaterThan(-60.001);
    }
  });

  it('prefers a staircase to an irreversible 3-block drop when the detour is short', () => {
    const gen = flatGen();
    // a 3-high plateau z <= 0, the goal below it; a staircase 3 blocks to the side
    gen.fill({ x: -20, y: -60, z: -20 }, { x: 20, y: -58, z: 0 }, 'stone');
    for (let i = 0; i < 3; i++) gen.fill({ x: 3, y: -60, z: 1 + i }, { x: 3, y: -60 + (2 - i), z: 1 + i }, 'stone');
    const r = findPath(new NavGrid(gen), { x: 0, y: -57, z: -3 }, { type: 'block', p: { x: 0, y: -60, z: 8 } });
    expect(r.status).toBe('found');
    expect(r.path.filter((n) => n.move === 'drop').every((n, i, a) => (a[i - 1] ?? n).feet - n.feet <= 1.25)).toBe(true);
    const falls = r.path.map((n, i) => (i ? r.path[i - 1]!.feet - n.feet : 0));
    expect(Math.max(...falls)).toBeLessThanOrEqual(1.25);
  });
});

describe('segments, plan-ahead and sliced searches', () => {
  /** A 16 x 320 flat strip. */
  const strip = () => flatGen({ x: -8, y: -64, z: -8 }, { x: 16, y: 24, z: 320 });

  it('walks 290 blocks in many segments without stopping between them', async () => {
    const run = await drive(strip(), { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 290 } }, { nav: { segmentNodes: 60, aheadNodes: 40 }, maxTicks: 3000 });
    const rep = run.skills.status().lastGoto!;
    expect(run.result).toEqual({ ok: true });
    expect(rep.segments).toBeGreaterThanOrEqual(4);
    expect(rep.plans.filter((p) => p.reason === 'ahead').length).toBeGreaterThanOrEqual(3);
    expect(rep.plans.filter((p) => p.reason === 'partial')).toEqual([]);
    // sprinting the whole way except the start and the stop
    expect(run.ticks).toBeLessThan(290 * TICKS.sprint + 60);
    expect(run.stallTicks).toBeLessThanOrEqual(15);
  });

  it('a block update that changes nothing the planner reads (grass -> dirt) does not re-plan; a wall does', async () => {
    const gen = strip();
    const run = await drive(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 40 } }, {
      during: (t) => {
        if (t === 10) for (let z = 5; z < 30; z++) gen.set(0, -61, z, 'dirt');
        if (t === 30) for (let x = -7; x <= 7; x++) gen.set(x, -60, 30, 'stone');
      },
    });
    const rep = run.skills.status().lastGoto!;
    expect(run.result).toEqual({ ok: true });
    expect(rep.plans.map((p) => p.reason)).toEqual(['start', 'block']);
  });

  it('a search sliced over many ticks (sliceMs 0) still finds the path', async () => {
    const run = await drive(strip(), { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 100 } }, { nav: { sliceMs: 0 } });
    const rep = run.skills.status().lastGoto!;
    expect(run.result).toEqual({ ok: true });
    expect(rep.plans[0]!.slices).toBeGreaterThan(1);
  });

  it('a segment ending at unloaded world waits for the chunks (no failure)', async () => {
    const gen = strip();
    let loaded = false;
    const base = fakeWorld(gen);
    const world = { ...base, chunks: { ...base.chunks, stateIdAt: (x: number, y: number, z: number) => (z > 40 && !loaded ? undefined : gen.blockAt(x, y, z)?.stateId) } };
    const run = await drive(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 60 } }, {
      world,
      during: (t) => {
        if (t === 250) loaded = true;
      },
    });
    const rep = run.skills.status().lastGoto!;
    expect(run.result).toEqual({ ok: true });
    expect(rep.failures).toBe(0);
    expect(rep.unloadedWait).toBeGreaterThan(0);
  });
});

describe('stuck handling', () => {
  it('a move that takes longer than 2 x its estimate + 10 ticks re-plans with reason timeout', async () => {
    const gen = flatGen();
    const { conn, loop } = harness({ x: 0.5, y: -60, z: 0.5 });
    const skills = new BotSkills({ loop, world: fakeWorld(gen) });
    // a 1-block step the planner sees, with an invisible second block on top for the physics: the
    // jump (estimate 9 ticks) fails and times out after 28 ticks, before the 40-tick fallback
    gen.fill({ x: -8, y: -60, z: 3 }, { x: 8, y: -60, z: 12 }, 'stone');
    const real = loop.world;
    loop.world = { ...real, boxesAt: (x, y, z) => (z === 3 && y === -59 ? [[0, 0, 0, 1, 1, 1]] : real.boxesAt!(x, y, z)) };
    conn.tick(2);
    const p = skills.goto({ type: 'block', p: { x: 0, y: -59, z: 8 } });
    for (let i = 0; i < 400 && skills.nav.busy; i++) {
      conn.tick();
      await flush();
    }
    expect(await p).toEqual({ ok: false, reason: 'unreachable' });
    const rep = skills.status().lastGoto!;
    expect(rep.moveTimeouts).toBeGreaterThanOrEqual(1);
    expect(rep.plans.some((x) => x.reason === 'timeout')).toBe(true);
  });

  // Track AJ: in water the body now re-plans from its swim node (swims out) instead of retreating first
  it('knocked into a pool: re-plans from the water (or retreats) and arrives', async () => {
    const gen = flatGen();
    gen.fill({ x: -3, y: -61, z: 4 }, { x: 3, y: -61, z: 8 }, 'water');
    let pushed = false;
    const run = await drive(gen, { x: 6.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 6, y: -60, z: 12 } }, {
      during: (t, _s, h) => {
        if (!pushed && t === 15) {
          pushed = true;
          h.conn.receive('move_player', { runtime_id: 7, position: { x: 0.5, y: -61 + 1.62, z: 6.5 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'teleport', on_ground: false, ridden_runtime_id: 0, tick: 0n });
        }
      },
    });
    const rep = run.skills.status().lastGoto!;
    expect(pushed).toBe(true);
    expect(rep.retreats + rep.plans.filter((x) => x.reason !== 'start').length).toBeGreaterThanOrEqual(1);
    expect(run.result).toEqual({ ok: true });
  });
});

describe('dig-through (allowBreak + a dig action)', () => {
  /** A closed 3-wide corridor along +z with a 3-high dirt wall across at z 10. */
  function corridor(block = 'dirt'): GenWorld {
    const gen = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 40 });
    wall(gen, -2, -1, -2, 20);
    wall(gen, 2, -1, 2, 20);
    wall(gen, -2, -1, 2, -1);
    wall(gen, -2, 20, 2, 20);
    wall(gen, -1, 10, 1, 10, 3, block);
    return gen;
  }

  it('without allowBreak the closed corridor is unreachable; with it the wall is dug (head first) and walked through', async () => {
    const none = await drive(corridor(), { x: 0.5, y: -60, z: 2.5 }, { type: 'block', p: { x: 0, y: -60, z: 15 } });
    expect(none.result).toEqual({ ok: false, reason: 'unreachable' });
    const gen = corridor();
    const log: string[] = [];
    const run = await drive(gen, { x: 0.5, y: -60, z: 2.5 }, { type: 'block', p: { x: 0, y: -60, z: 15 } }, { goto: { allowBreak: true }, actions: (loop) => fakeActions(gen, log, loop) });
    expect(run.result, log.join('\n')).toEqual({ ok: true });
    expect(log.filter((l) => l.startsWith('dig'))).toHaveLength(2);
    expect(log[0]).toMatch(/^dig -?\d+,-59,10 dirt/);
    expect(log[1]).toMatch(/^dig -?\d+,-60,10 dirt/);
    expect(run.skills.status().lastGoto!.actions.dig).toBe(2);
  });

  it('breaking costs ticks from the break-time table: an open wall of stone is walked around, dirt is dug', () => {
    const open = (block: string) => {
      const gen = flatGen();
      wall(gen, -24, 10, 24, 10, 3, block);
      return findPath(new NavGrid(gen), { x: 0, y: -60, z: 2 }, { type: 'block', p: { x: 0, y: -60, z: 18 } }, { allowBreak: true });
    };
    const stone = open('stone'); // 150 ticks per block by hand
    expect(stone.path.some((n) => n.act?.dig)).toBe(false);
    const dirt = open('dirt'); // 15 ticks per block by hand
    expect(dirt.path.some((n) => n.act?.dig)).toBe(true);
  });

  it('safety: never digs next to water, under gravel, a chest, or a protected block', () => {
    const digs = (setup: (g: GenWorld) => void, protectedBlocks?: string[]) => {
      const gen = corridor();
      setup(gen);
      const r = findPath(new NavGrid(gen), { x: 0, y: -60, z: 2 }, { type: 'block', p: { x: 0, y: -60, z: 15 } }, { allowBreak: true, ...(protectedBlocks ? { protectedBlocks } : {}) });
      return r.path.flatMap((n: PathNode) => n.act?.dig ?? []);
    };
    const xs = (cells: Vec3[]) => [...new Set(cells.map((c) => c.x))];
    // water right behind the wall at x 0: that column is not dug
    expect(xs(digs((g) => g.put(0, -60, 11, 'water')))).not.toContain(0);
    // gravel in the top of the wall at x 0 (y -58, right above the head cell)
    expect(xs(digs((g) => g.put(0, -58, 10, 'gravel')))).not.toContain(0);
    // a chest in the wall at x 0 (feet level)
    expect(xs(digs((g) => g.put(0, -60, 10, 'chest')))).not.toContain(0);
    // protected block names (the wall and the corridor's side walls)
    expect(digs(() => undefined, ['dirt', 'stone'])).toEqual([]);
    // never the floor: no dug cell is below the feet level
    expect(digs(() => undefined).every((c) => c.y >= -60)).toBe(true);
  });
});

describe('pillar-up (allowPlace + a place action + throwaway blocks)', () => {
  /** A 3-deep 3 x 3 pit, closed (the box starts below the bedrock: the physics reads the layer under the floor). */
  function pit(): GenWorld {
    const gen = flatGen({ x: -16, y: -66, z: -16 }, { x: 32, y: 26, z: 32 });
    gen.fill({ x: -1, y: -63, z: -1 }, { x: 1, y: -61, z: 1 }, 'air');
    return gen;
  }

  it('a goto that starts in a 3-deep pit gets out by pillaring (unreachable without)', async () => {
    const none = await drive(pit(), { x: 0.5, y: -63, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 6 } }, { goto: { allowPlace: true } });
    expect(none.result).toEqual({ ok: false, reason: 'unreachable' }); // no place action
    const gen = pit();
    const log: string[] = [];
    const run = await drive(gen, { x: 0.5, y: -63, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 6 } }, { goto: { allowPlace: true }, actions: (loop) => fakeActions(gen, log, loop), nav: { inventory: cobble } });
    expect(run.result, log.join('\n')).toEqual({ ok: true });
    // two blocks up, then a jump onto the rim (feet -61 -> -60)
    expect(log.filter((l) => l.startsWith('place'))).toHaveLength(2);
    expect(log.every((l) => l.endsWith('down'))).toBe(true);
    expect(run.pos.y).toBeCloseTo(-60, 3);
  });

  it('no throwaway blocks in the inventory: no pillar-up', async () => {
    const gen = pit();
    const log: string[] = [];
    const run = await drive(gen, { x: 0.5, y: -63, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 6 } }, {
      goto: { allowPlace: true },
      actions: (loop) => fakeActions(gen, log, loop),
      nav: { inventory: () => ({ slots: [{ name: 'oak_log', count: 3 }], selected: 0 }) },
    });
    expect(run.result).toEqual({ ok: false, reason: 'unreachable' });
    expect(log).toEqual([]);
  });

  it('climbs a 4-high plateau by pillaring next to it', async () => {
    const gen = flatGen();
    gen.fill({ x: -2, y: -60, z: 6 }, { x: 2, y: -57, z: 10 }, 'stone');
    const log: string[] = [];
    const run = await drive(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -56, z: 8 } }, { goto: { allowPlace: true }, actions: (loop) => fakeActions(gen, log, loop), nav: { inventory: cobble } });
    expect(run.result, log.join('\n')).toEqual({ ok: true });
    expect(run.pos.y).toBeCloseTo(-56, 3);
    expect(log.filter((l) => l.startsWith('place')).length).toBeGreaterThanOrEqual(3);
  });

  it('Realm shape: 3 stairs up to a platform, allowPlace on or off: walked up, nothing placed', async () => {
    const build = () => {
      const gen = flatGen();
      gen.fill({ x: -3, y: -60, z: 6 }, { x: 3, y: -58, z: 10 }, 'stone'); // platform, feet -57
      for (let i = 0; i < 3; i++) {
        if (i > 0) gen.fill({ x: -1, y: -60, z: 3 + i }, { x: 1, y: -61 + i, z: 3 + i }, 'stone');
        gen.fill({ x: -1, y: -60 + i, z: 3 + i }, { x: 1, y: -60 + i, z: 3 + i }, 'oak_stairs', { weirdo_direction: 2 });
      }
      return gen;
    };
    for (const allowPlace of [false, true]) {
      const gen = build();
      const log: string[] = [];
      const run = await drive(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -57, z: 8 } }, { goto: { allowPlace }, actions: (loop) => fakeActions(gen, log, loop), nav: { inventory: cobble } });
      expect(run.result, `allowPlace ${allowPlace}: ${log.join(' ')}`).toEqual({ ok: true });
      expect(run.pos.y).toBeCloseTo(-57, 3);
      expect(log).toEqual([]);
      expect(run.skills.status().lastGoto!.actions.place).toBe(0);
    }
  });

  it('Realm home return: around a wall, up 2 levels over 4 cells (stairs, landing, stairs), through a door: nothing placed', async () => {
    // the owner's house: staircase along +x at z 20 from x 6, platform (feet -58) x 9..15, z 20..25,
    // a room on it (2-high walls) with the door in its west wall at (10, -58, 22); a wall at x 17
    const build = () => {
      const gen = flatGen();
      gen.put(6, -60, 20, 'oak_stairs', { weirdo_direction: 0 });
      gen.put(7, -60, 20, 'stone');
      gen.put(8, -60, 20, 'stone');
      gen.put(8, -59, 20, 'oak_stairs', { weirdo_direction: 0 });
      gen.fill({ x: 9, y: -60, z: 20 }, { x: 15, y: -59, z: 25 }, 'stone');
      gen.fill({ x: 10, y: -58, z: 20 }, { x: 15, y: -57, z: 20 }, 'stone');
      gen.fill({ x: 10, y: -58, z: 25 }, { x: 15, y: -57, z: 25 }, 'stone');
      gen.fill({ x: 10, y: -58, z: 20 }, { x: 10, y: -57, z: 25 }, 'stone');
      gen.fill({ x: 15, y: -58, z: 20 }, { x: 15, y: -57, z: 25 }, 'stone');
      gen.put(10, -58, 22, 'wooden_door', { 'minecraft:cardinal_direction': 'south', upper_block_bit: 0, open_bit: 0 });
      gen.put(10, -57, 22, 'wooden_door', { 'minecraft:cardinal_direction': 'south', upper_block_bit: 1, open_bit: 0 });
      gen.fill({ x: 17, y: -60, z: 17 }, { x: 17, y: -59, z: 28 }, 'stone');
      return gen;
    };
    for (const allowPlace of [false, true]) {
      const gen = build();
      const log: string[] = [];
      const run = await drive(gen, { x: 20.5, y: -60, z: 22.5 }, { type: 'block', p: { x: 14, y: -58, z: 22 } }, { goto: { allowPlace }, actions: (loop) => fakeActions(gen, log, loop), nav: { inventory: cobble } });
      expect(run.result, `allowPlace ${allowPlace}: ${log.join(' ')}`).toEqual({ ok: true });
      expect(run.pos.y).toBeCloseTo(-58, 3);
      expect(log.filter((l) => l.startsWith('place')), `allowPlace ${allowPlace}`).toEqual([]);
      expect(log.some((l) => l.startsWith('use 10,-58,22'))).toBe(true);
    }
  });

  it('a failed pillar cell is not planned again in the same goto; after 2 failed places the goto walks round by the stairs', async () => {
    const gen = flatGen();
    gen.fill({ x: -2, y: -60, z: 6 }, { x: 10, y: -57, z: 10 }, 'stone'); // plateau, feet -56
    for (let i = 0; i < 4; i++) {
      gen.fill({ x: 10, y: -60, z: 2 + i }, { x: 10, y: -61 + i, z: 2 + i }, 'stone');
      gen.put(10, -60 + i, 2 + i, 'oak_stairs', { weirdo_direction: 2 });
    }
    const log: string[] = [];
    const actions = (loop: InputLoop): NavActions => ({
      ...fakeActions(gen, log, loop),
      place: (p, face) => {
        log.push(`place ${p.x},${p.y},${p.z} ${face}`);
        return Promise.resolve({ ok: false, reason: 'refused' });
      },
    });
    const run = await drive(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -56, z: 8 } }, { goto: { allowPlace: true }, actions, nav: { inventory: cobble } });
    const places = log.filter((l) => l.startsWith('place'));
    expect(places.length).toBeGreaterThanOrEqual(1); // the pillar is the cheapest plan
    expect(places.length).toBeLessThanOrEqual(2);
    expect(new Set(places).size).toBe(places.length); // never the same cell twice
    expect(run.result, log.join(' ')).toEqual({ ok: true });
    expect(run.pos.y).toBeCloseTo(-56, 3);
  });
});

describe('doors and gates (a useBlock action)', () => {
  /** A closed room x -4..4, z -4..5 (3-high walls) with a door or gate in the wall at (0, z 5). */
  function room(kind: 'door' | 'gate'): GenWorld {
    const gen = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 32 });
    wall(gen, -4, -4, 4, -4);
    wall(gen, -4, 5, 4, 5);
    wall(gen, -4, -4, -4, 5);
    wall(gen, 4, -4, 4, 5);
    if (kind === 'door') {
      // Bedrock 'west' = panel at z 0..0.1825: crossing along z needs the door open
      gen.put(0, -60, 5, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 0 });
      gen.put(0, -59, 5, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 1 });
    } else {
      gen.put(0, -60, 5, 'fence_gate', { 'minecraft:cardinal_direction': 'south' });
      gen.put(0, -59, 5, 'air');
    }
    return gen;
  }

  for (const kind of ['door', 'gate'] as const) {
    it(`a closed ${kind} is passable with useBlock (opened, walked through, closed behind with closeDoors); unreachable without`, async () => {
      const none = await drive(room(kind), { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 9 } });
      expect(none.result).toEqual({ ok: false, reason: 'unreachable' });
      const gen = room(kind);
      const log: string[] = [];
      const run = await drive(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 9 } }, { goto: { closeDoors: true }, actions: (loop) => fakeActions(gen, log, loop) });
      expect(run.result, log.join('\n')).toEqual({ ok: true });
      expect(log).toHaveLength(2);
      expect(log[0]).toMatch(/-> open$/);
      expect(log[1]).toMatch(/-> closed$/);
      expect(gen.blockAt(0, -60, 5)?.states.open_bit).toBe(0);
      const rep = run.skills.status().lastGoto!;
      expect(rep.actions).toMatchObject({ use: 1, close: 1, failed: 0 });
    });
  }

  it('an open door is walked through without any action', async () => {
    const gen = room('door');
    gen.put(0, -60, 5, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 0, open_bit: 1 });
    const run = await drive(gen, { x: 0.5, y: -60, z: 0.5 }, { type: 'block', p: { x: 0, y: -60, z: 9 } });
    expect(run.result).toEqual({ ok: true });
  });
});
