// The heuristic's vertical part (nav/goals.ts `columnH`, `levelWeights`): goals far above or below the start.
// Realm 2026-10-31: the miner stood over a coal ore 13 blocks down and every composite plan ended `no partial
// end 5+ blocks from the start` (octile only: the start scored 0, every node around it worse); `!goto mine`
// (119 levels down a hand-dug staircase) walked the surface to the column over the goal and stopped there.
import { describe, expect, it } from 'vitest';
import { findPath, type PathOptions } from '../../../src/skills/nav/astar.ts';
import { DEFAULT_COSTS } from '../../../src/skills/nav/costs.ts';
import { columnH, FREE_LEVELS, goalTest, levelWeights, type NavGoal } from '../../../src/skills/nav/goals.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { GenWorld } from './genworld.ts';

/** Stone up to y -21, grass at -20 (feet -19 on the surface), air above, x / z -48..47. */
function ground(): GenWorld {
  const w = new GenWorld({ x: -48, y: -64, z: -48 }, { x: 96, y: 72, z: 96 });
  w.fill({ x: -48, y: -64, z: -48 }, { x: 47, y: -21, z: 47 }, 'stone');
  w.fill({ x: -48, y: -20, z: -48 }, { x: 47, y: -20, z: 47 }, 'grass_block');
  return w;
}

/** The miner's planner options on the Realm: dig and pillar, digPenalty 60, a node budget instead of the clock. */
const MINER: PathOptions = { allowBreak: true, allowPlace: true, throwaway: 16, costs: { dig: 60 }, maxNodes: 4000, maxMs: 60_000 };

const digs = (r: ReturnType<typeof findPath>): number => r.path.reduce((n, p) => n + (p.act?.dig?.length ?? 0), 0);

describe('heuristic: the levels to the goal', () => {
  it('octile plus the levels: admissible within FREE_LEVELS, priced beyond (straight above an ore scores the levels, not 0)', () => {
    const w = levelWeights(DEFAULT_COSTS);
    expect(w.down).toBeCloseTo((5 + 2 + 6) / DEFAULT_COSTS.walk, 6); // fall[1] + landing + underground per level
    expect(w.up).toBeCloseTo((DEFAULT_COSTS.jump - DEFAULT_COSTS.walk) / DEFAULT_COSTS.walk, 6);
    expect(columnH(3, 4, 0)).toBeCloseTo(4 + (Math.SQRT2 - 1) * 3, 9);
    expect(columnH(0, 0, FREE_LEVELS)).toBe(FREE_LEVELS); // within FREE_LEVELS: max(octile, levels)
    expect(columnH(6, 0, -3)).toBe(6);
    expect(columnH(0, 0, 13, w)).toBeCloseTo(13 + 9 * w.down, 9);
    expect(columnH(0, 0, -13, w)).toBeCloseTo(13 + 9 * w.up, 9);
    const three = goalTest({ type: 'threeBlocks', p: { x: 0, y: -32, z: 0 } }, undefined, w);
    expect(three.h(0, -19, 0)).toBeCloseTo(13 + 9 * w.down, 9); // feet range -34..-32: 13 levels down
    expect(three.h(0, -33, 0)).toBe(0);
    expect(goalTest({ type: 'block', p: { x: 0, y: -40, z: 0 } }).h(0, -19, 0)).toBe(21 + 17);
  });

  it('Realm 2026-10-31: over a buried ore, a composite with a surface ore beside it makes progress (was: no partial end 5+ blocks from the start)', () => {
    const w = ground();
    w.put(0, -32, 0, 'coal_ore'); // 13 levels straight below the start
    w.put(9, -19, 9, 'coal_ore'); // on the surface, 9 + 9 away: one dig
    const goal: NavGoal = {
      type: 'any',
      goals: [
        { type: 'threeBlocks', p: { x: 0, y: -32, z: 0 } },
        { type: 'threeBlocks', p: { x: 9, y: -19, z: 9 } },
      ],
    };
    const r = findPath(new NavGrid(w), { x: 0, y: -19, z: 0 }, goal, MINER);
    expect(r.reason).toBeUndefined();
    const end = r.path.at(-1)!;
    expect(Math.hypot(end.x, end.y + 19, end.z)).toBeGreaterThan(5);
    expect(Math.hypot(end.x - 9, end.z - 9)).toBeLessThan(Math.hypot(9, 9) - 5); // towards the surface ore
    // with the budget to finish: at the surface ore, dug into its column
    const full = findPath(new NavGrid(w), { x: 0, y: -19, z: 0 }, goal, { ...MINER, maxNodes: 200_000 });
    expect(full.status).toBe('found');
    expect(full.path.at(-1)).toMatchObject({ x: 9, z: 9 });
    expect(digs(full)).toBeGreaterThan(0);
  });

  it('!goto down a hand-dug staircase whose entrance is away from the goal column: found without a dig (was: the surface walk to the column over the goal)', () => {
    const w = ground();
    // the staircase: step i at x -20 + i, feet -20 - i (3 cells cleared), down to feet -58 at x 18; a tunnel on to x 30
    for (let i = 0; i <= 38; i++) w.fill({ x: -20 + i, y: -20 - i, z: 0 }, { x: -20 + i, y: -18 - i, z: 0 }, 'air');
    w.fill({ x: 18, y: -58, z: 0 }, { x: 30, y: -57, z: 0 }, 'air');
    const goal: NavGoal = { type: 'block', p: { x: 30, y: -58, z: -0 } };
    const r = findPath(new NavGrid(w), { x: -30, y: -19, z: 0 }, goal, { ...MINER, maxNodes: 20_000 });
    expect(r.status).toBe('found');
    expect(digs(r)).toBe(0);
    expect(r.path.some((n) => n.x === -20 && n.y === -20)).toBe(true); // down the stairs from their top step
  });
});
