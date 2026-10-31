// Track BG (decisions/0048-trapdoor-moves.md, docs/pathfinding.md "Trapdoors"): the planner goes down and up
// through trapdoors in floors and ceilings (hatches): onto the ladder under a hatch, through a hatch onto a
// floor or into water, up a ladder through a hatch above (a closed one opened first, closed behind), and
// past an open trapdoor's panel like a ladder's thin box. Grid / planner checks on generated worlds, then
// closed loops with fake actions (the "server" is the own physics; the e2e suite nav-trapdoor tests BDS).
import { describe, expect, it } from 'vitest';
import { BotSkills } from '../../../src/skills/index.ts';
import { CROSS_BLOCKED, CROSS_CLEAR, CROSS_TOGGLE, NavGrid, findPath, isPanel, type NavActions, type PathNode, type PathOptions } from '../../../src/skills/nav/index.ts';
import type { NavGoal } from '../../../src/skills/nav/goals.ts';
import type { InputLoop } from '../../../src/skills/input/inputLoop.ts';
import type { GotoOptions, SkillResult } from '../../../src/skills/types.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const moves = (path: readonly PathNode[]) => path.map((n) => n.move);
const uses = (path: readonly PathNode[]) => path.flatMap((n) => n.act?.use ?? []);

/** Trapdoor states: `direction` 0..3 (open panel at x 0 / x 1 / z 0 / z 1, measured on BDS 1.26.60), closed = a floor slab (bottom) or a ceiling slab (top). */
const td = (direction: number, open = 0, top = 0) => ({ direction, open_bit: open, upside_down_bit: top });

/**
 * A room x -3..3, z -3..3, y -60..-55 (6 high) under a roof at y -54 (the platform: feet -53), walls at x / z
 * +-4 from -60 to -54. A ladder on the north wall in column (0, -3), y -60..`ladderTop` (facing south: box at
 * z 0..0.1875).
 *  - 'B': the ladder reaches the roof layer (-54, the hole) and the trapdoor sits on it in the walking layer (-53)
 *  - 'A': the trapdoor is in the roof layer (-54) and the ladder ends one below (-55): down only
 */
function hatchWorld(kind: 'A' | 'B', state: Record<string, number> = td(3), name = 'spruce_trapdoor'): GenWorld {
  const gen = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 32 });
  gen.fill({ x: -4, y: -60, z: -4 }, { x: 4, y: -54, z: 4 }, 'stone');
  gen.fill({ x: -3, y: -60, z: -3 }, { x: 3, y: -55, z: 3 }, 'air');
  const ladderTop = kind === 'B' ? -54 : -55;
  gen.fill({ x: 0, y: -60, z: -3 }, { x: 0, y: ladderTop, z: -3 }, 'ladder', { facing_direction: 3 });
  gen.put(0, kind === 'B' ? -53 : -54, -3, name, state);
  return gen;
}

const PLATFORM = { x: 2, y: -53, z: 2 };
const ROOM = { x: 2, y: -60, z: 2 };
const OPEN: PathOptions = { allowOpen: true };

describe('grid: trapdoor panels and hatches (Track BG)', () => {
  it('an open trapdoor is a thin panel (passable, a ladder-like box); closed ones are slabs', () => {
    const gen = flatGen();
    gen.put(0, -60, 0, 'spruce_trapdoor', td(3, 1));
    gen.put(1, -60, 0, 'spruce_trapdoor', td(3, 0));
    gen.put(2, -60, 0, 'spruce_trapdoor', td(3, 0, 1));
    const grid = new NavGrid(gen);
    expect(isPanel(grid.cls(0, -60, 0)!)).toBe(true);
    expect(isPanel(grid.cls(1, -60, 0)!)).toBe(false);
    expect(grid.free(0, -60, 0)).toBe(true);
    expect(grid.stand(0, -60, 0)).toBe(-60); // standing beside the panel, on the grass
    expect(grid.stand(1, -60, 0)).toBeCloseTo(-59.8175, 6); // on a closed bottom trapdoor
    // the panel (z 0.8175..1) stops a walk leaving towards +z, not one along x or leaving towards -z
    expect(grid.climberLets(0, -60, 0, 0, 1, false)).toBe(false);
    expect(grid.climberLets(0, -60, 0, 0, -1, false)).toBe(true);
    expect(grid.climberLets(0, -60, 0, 1, 0, false)).toBe(true);
    expect(grid.climberLets(0, -60, 0, 0, 1, true)).toBe(true); // entering towards it: the body stops in front
    expect(grid.climberLets(0, -60, 0, 0, -1, true)).toBe(false); // entering from its side
  });

  it('hatch(): open CLEAR, closed wooden TOGGLE, closed iron BLOCKED, open iron CLEAR; any side next to a ladder fits', () => {
    for (const dir of [0, 1, 2, 3]) {
      expect(new NavGrid(hatchWorld('B', td(dir, 1))).hatch(0, -53, -3)).toBe(CROSS_CLEAR);
      expect(new NavGrid(hatchWorld('B', td(dir, 0))).hatch(0, -53, -3)).toBe(CROSS_TOGGLE);
      expect(new NavGrid(hatchWorld('B', td(dir, 0, 1))).hatch(0, -53, -3)).toBe(CROSS_TOGGLE);
    }
    expect(new NavGrid(hatchWorld('B', td(3, 0), 'iron_trapdoor')).hatch(0, -53, -3)).toBe(CROSS_BLOCKED);
    expect(new NavGrid(hatchWorld('B', td(3, 1), 'iron_trapdoor')).hatch(0, -53, -3)).toBe(CROSS_CLEAR);
    expect(new NavGrid(hatchWorld('B')).hatch(1, -53, -3)).toBe(CROSS_BLOCKED); // not a trapdoor
  });
});

describe('planner: through hatches (Track BG)', () => {
  it("B: down from the platform through a closed hatch onto the ladder (opened first), up again and out past the panel", () => {
    for (const dir of [0, 1, 2, 3]) {
      for (const top of [0, 1]) {
        const grid = new NavGrid(hatchWorld('B', td(dir, 0, top)));
        const down = findPath(grid, PLATFORM, { type: 'block', p: ROOM }, OPEN);
        expect(down.status, `dir ${dir} top ${top}`).toBe('found');
        expect(uses(down.path)).toEqual([{ x: 0, y: -53, z: -3 }]);
        expect(moves(down.path)).toContain('climb');
        const up = findPath(grid, ROOM, { type: 'block', p: PLATFORM }, OPEN);
        expect(up.status, `up dir ${dir} top ${top}`).toBe('found');
        expect(uses(up.path)).toEqual([{ x: 0, y: -53, z: -3 }]);
        const k = up.path.findIndex((n) => n.act?.use);
        expect(up.path[k]!.move).toBe('climb');
        expect(up.path[k]!.y).toBe(-54); // the top ladder cell: the body's head enters the hatch
        const out = up.path[k + 1]!;
        expect(out.move).toBe('climbOut');
        // never out through the open panel's side
        const side = [[-1, 0], [1, 0], [0, -1], [0, 1]][dir]!;
        expect([out.x - 0, out.z + 3], `dir ${dir}`).not.toEqual(side);
      }
    }
  });

  it('B: without allowOpen a closed hatch is a floor (no way down); an open one needs no action', () => {
    const closed = findPath(new NavGrid(hatchWorld('B')), PLATFORM, { type: 'block', p: ROOM });
    expect(closed.status).toBe('none');
    const open = findPath(new NavGrid(hatchWorld('B', td(3, 1))), PLATFORM, { type: 'block', p: ROOM });
    expect(open.status).toBe('found');
    expect(uses(open.path)).toEqual([]);
    const up = findPath(new NavGrid(hatchWorld('B', td(3, 1))), ROOM, { type: 'block', p: PLATFORM });
    expect(up.status).toBe('found');
    expect(uses(up.path)).toEqual([]);
  });

  it('a closed iron trapdoor blocks; a blacklisted one too (noAction)', () => {
    expect(findPath(new NavGrid(hatchWorld('B', td(3), 'iron_trapdoor')), PLATFORM, { type: 'block', p: ROOM }, OPEN).status).toBe('none');
    const grid = new NavGrid(hatchWorld('B'));
    const noAction = new Set([((0 + 1048576) * 2097152 + (-3 + 1048576)) * 1024 + (-53 + 512)]);
    expect(findPath(grid, PLATFORM, { type: 'block', p: ROOM }, { ...OPEN, noAction }).status).toBe('none');
    expect(findPath(grid, PLATFORM, { type: 'block', p: ROOM }, { ...OPEN, moves: { trapdoor: false } }).status).toBe('none');
  });

  it('A: a hatch in the roof layer over a ladder that ends below it: down (onto the ladder), never up (BDS: no climbing out)', () => {
    for (const top of [0, 1]) {
      const grid = new NavGrid(hatchWorld('A', td(1, 0, top)));
      const down = findPath(grid, PLATFORM, { type: 'block', p: ROOM }, OPEN);
      expect(down.status, `top ${top}`).toBe('found');
      expect(uses(down.path)).toEqual([{ x: 0, y: -54, z: -3 }]);
      const entry = down.path.find((n) => n.act?.use)!;
      expect(entry).toMatchObject({ move: 'climb', x: 0, y: -55, z: -3 });
      expect(findPath(grid, ROOM, { type: 'block', p: PLATFORM }, OPEN).status).toBe('none');
    }
  });

  it('through a hatch without a ladder: a fall onto a floor, or into still water deeper than maxDrop', () => {
    // a 2-high room under the roof: the fall from the platform (feet -53) to the floor (feet -56) is 3
    const gen = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 32 });
    gen.fill({ x: -4, y: -60, z: -4 }, { x: 4, y: -54, z: 4 }, 'stone');
    gen.fill({ x: -3, y: -56, z: -3 }, { x: 3, y: -55, z: 3 }, 'air');
    gen.put(0, -54, 0, 'trapdoor', td(0));
    const floor = findPath(new NavGrid(gen), PLATFORM, { type: 'block', p: { x: 2, y: -56, z: 2 } }, OPEN);
    expect(floor.status).toBe('found');
    expect(floor.path.find((n) => n.act?.use)).toMatchObject({ move: 'drop', x: 0, y: -56, z: 0, feet: -56 });
    // water 2 deep at the bottom of the 6-high room: a fall of 7 into it
    const wet = hatchWorld('A');
    wet.fill({ x: 0, y: -60, z: -3 }, { x: 0, y: -55, z: -3 }, 'air'); // no ladder
    wet.put(0, -54, -3, 'stone');
    wet.put(0, -54, 0, 'trapdoor', td(0));
    wet.fill({ x: -1, y: -61, z: -1 }, { x: 1, y: -60, z: 1 }, 'water');
    const grid = new NavGrid(wet);
    const r = findPath(grid, PLATFORM, { type: 'block', p: ROOM }, OPEN);
    expect(r.status).toBe('found');
    expect(r.path.find((n) => n.act?.use)).toMatchObject({ move: 'swim', x: 0, y: -60, z: 0 });
  });

  it('an open trapdoor standing in a doorway: passed along its panel, not through it', () => {
    // a 1-wide corridor along z (walls at x -1 and 1) with an open trapdoor at (0, -60, 3)
    const make = (dir: number) => {
      const gen = flatGen();
      gen.fill({ x: -1, y: -60, z: 0 }, { x: -1, y: -58, z: 6 }, 'stone');
      gen.fill({ x: 1, y: -60, z: 0 }, { x: 1, y: -58, z: 6 }, 'stone');
      gen.fill({ x: -2, y: -60, z: 6 }, { x: 2, y: -58, z: 6 }, 'stone');
      gen.put(0, -60, 3, 'spruce_trapdoor', td(dir, 1));
      return new NavGrid(gen);
    };
    // panels at x 0 / x 1: along the corridor; at z 0 / z 1: across it
    expect(findPath(make(0), { x: 0, y: -60, z: 0 }, { type: 'block', p: { x: 0, y: -60, z: 5 } }, { maxNodes: 3000 }).status).toBe('found');
    expect(findPath(make(1), { x: 0, y: -60, z: 0 }, { type: 'block', p: { x: 0, y: -60, z: 5 } }, { maxNodes: 3000 }).status).toBe('found');
    const across = findPath(make(3), { x: 0, y: -60, z: 0 }, { type: 'block', p: { x: 0, y: -60, z: 5 } }, { maxNodes: 3000 });
    expect(across.path.some((n) => n.z === 5 && n.x === 0)).toBe(false);
  });
});

// ---- closed loops ---------------------------------------------------------------------------------

function fakeActions(gen: GenWorld, log: string[], loop: InputLoop): NavActions {
  return {
    useBlock: async (p) => {
      const b = gen.blockAt(p.x, p.y, p.z)!;
      const open = Number(b.states.open_bit ?? 0) === 1 ? 0 : 1;
      log.push(`use ${p.x},${p.y},${p.z} -> ${open ? 'open' : 'closed'} at feet ${loop.state.pos.y.toFixed(2)}`);
      await loop.waitTicks(3);
      gen.set(p.x, p.y, p.z, b.name, { ...b.states, open_bit: open });
      return { ok: true };
    },
  };
}

async function drive(gen: GenWorld, start: Vec3, goal: NavGoal, goto: GotoOptions = {}, maxTicks = 1500, actions = fakeActions) {
  const { conn, loop } = harness(start);
  const log: string[] = [];
  const skills = new BotSkills({ loop, world: fakeWorld(gen), actions: actions(gen, log, loop) });
  conn.tick(3);
  let result: SkillResult | undefined;
  const p = skills.goto(goal, goto).then((r) => (result = r));
  let t = 0;
  let minFeet = Infinity;
  while (skills.nav.busy && t < maxTicks) {
    conn.tick();
    await flush();
    minFeet = Math.min(minFeet, loop.state.pos.y);
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t, pos: loop.state.pos, log, rep: skills.status().lastGoto!, minFeet };
}

describe('closed loop: hatches (Track BG)', () => {
  for (const dir of [0, 2, 3]) {
    it(`B (panel ${['west', 'east', 'north (the ladder side)', 'south (opposite the ladder)'][dir]}): down through the closed hatch and up again, closed behind both times`, async () => {
      const gen = hatchWorld('B', td(dir));
      const down = await drive(gen, { x: 2.5, y: -53, z: 2.5 }, { type: 'block', p: ROOM });
      expect(down.result, down.log.join('\n')).toEqual({ ok: true });
      expect(down.log.map((l) => l.split(' at ')[0])).toEqual(['use 0,-53,-3 -> open', 'use 0,-53,-3 -> closed']);
      expect(down.rep.actions).toMatchObject({ use: 1, close: 1, failed: 0 });
      expect(Math.abs(down.pos.y + 60)).toBeLessThan(1e-6);
      const up = await drive(gen, { x: 2.5, y: -60, z: 2.5 }, { type: 'block', p: PLATFORM });
      expect(up.result, up.log.join('\n')).toEqual({ ok: true });
      expect(up.log.map((l) => l.split(' at ')[0])).toEqual(['use 0,-53,-3 -> open', 'use 0,-53,-3 -> closed']);
      expect(Math.abs(up.pos.y + 53)).toBeLessThan(1e-6);
      expect(gen.blockAt(0, -53, -3)?.states.open_bit).toBe(0);
    });
  }

  it('Track BG2: a close the server rejects is clicked once more, then left open: no goto failure, no retreat', async () => {
    const gen = hatchWorld('B');
    // opens fine, every close is rejected (the Realm: a sneaking click from the ladder with an item in the hand)
    const rejecting = (g: GenWorld, log: string[], loop: InputLoop): NavActions => {
      const inner = fakeActions(g, log, loop);
      return {
        useBlock: async (p) => {
          if (Number(g.blockAt(p.x, p.y, p.z)!.states.open_bit ?? 0) === 0) return inner.useBlock!(p);
          log.push(`use ${p.x},${p.y},${p.z} -> rejected`);
          await loop.waitTicks(3);
          return { ok: false, reason: 'rejected' };
        },
      };
    };
    const down = await drive(gen, { x: 2.5, y: -53, z: 2.5 }, { type: 'block', p: ROOM }, {}, 1500, rejecting);
    expect(down.result, down.log.join('\n')).toEqual({ ok: true });
    expect(down.log.map((l) => l.split(' at ')[0])).toEqual(['use 0,-53,-3 -> open', 'use 0,-53,-3 -> rejected', 'use 0,-53,-3 -> rejected']);
    expect(down.rep.actions).toMatchObject({ use: 1, failed: 0 });
    expect(down.rep.retreats).toBe(0);
    expect(down.rep.closeFailed).toBe(1);
    expect(Math.abs(down.pos.y + 60)).toBeLessThan(1e-6);
    expect(gen.blockAt(0, -53, -3)?.states.open_bit).toBe(1);
  });

  it('closeTrapdoors false leaves the hatch open', async () => {
    const gen = hatchWorld('B');
    const down = await drive(gen, { x: 2.5, y: -53, z: 2.5 }, { type: 'block', p: ROOM }, { closeTrapdoors: false });
    expect(down.result, down.log.join('\n')).toEqual({ ok: true });
    expect(down.log).toHaveLength(1);
    expect(gen.blockAt(0, -53, -3)?.states.open_bit).toBe(1);
  });

  it('A: down through the roof hatch onto the ladder below it, closed behind', async () => {
    const gen = hatchWorld('A', td(1));
    const down = await drive(gen, { x: 2.5, y: -53, z: 2.5 }, { type: 'block', p: ROOM });
    expect(down.result, down.log.join('\n')).toEqual({ ok: true });
    expect(down.log.map((l) => l.split(' at ')[0])).toEqual(['use 0,-54,-3 -> open', 'use 0,-54,-3 -> closed']);
    expect(down.minFeet).toBeGreaterThan(-60.01);
  });

  it('through a hatch into water (a fall of 7) and out onto the floor', async () => {
    const gen = hatchWorld('A');
    gen.fill({ x: 0, y: -60, z: -3 }, { x: 0, y: -55, z: -3 }, 'air');
    gen.put(0, -54, -3, 'stone');
    gen.put(0, -54, 0, 'trapdoor', td(0));
    gen.fill({ x: -1, y: -61, z: -1 }, { x: 1, y: -60, z: 1 }, 'water');
    const run = await drive(gen, { x: 2.5, y: -53, z: 2.5 }, { type: 'block', p: ROOM });
    expect(run.result, run.log.join('\n')).toEqual({ ok: true });
    expect(run.log[0]).toMatch(/^use 0,-54,0 -> open/);
  });
});
