// Track R1 (docs/pathfinding.md "Reachability (Track R1)", decisions/0072-reachability.md): the "why unreachable" parts
// (nav/reach.ts: the relaxed options, the rules read off a path, the sealed pocket, the cause words), the frontier end
// for a goal in unloaded world (nav/astar.ts PathOptions.frontier), the planner never standing on a cell its own path
// dug, and the guide's section.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { R1_STATIONS } from '../../../../packs/truth/src/water-layout.ts';
import { findPath, type PathNode } from '../../../src/skills/nav/astar.ts';
import { breakTicksWith } from '../../../src/skills/nav/baritone/helper.ts';
import { VOX_BLOCKS } from '../../../src/skills/nav/bench/vox.ts';
import { benchWorld } from '../../../src/skills/nav/bench/worlds.ts';
import { DIG_WAY_MAX_BLOCKS } from '../../../src/skills/nav/digway.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { BIG_SEARCH, EXPLAIN_MAX_SEARCHES, FRONTIER_MAX_LEGS, OFF_PATH_LOOP } from '../../../src/skills/nav/navigator.ts';
import { EXPLAIN_WEIGHT, REACH_RULES, RELAXED_DIG_BLOCKS, RELAXED_THROWAWAY, causeTag, causeWords, relaxOptions, rulesOnPath, sealedPocket } from '../../../src/skills/nav/reach.ts';
import { fallPolicy } from '../../../src/skills/fall/policy.ts';
import { wireSize } from '../../../src/chat/style.ts';
import { GenWorld, flatGen } from './genworld.ts';

const POLICY = fallPolicy({ enabled: true, health: 20, healthKnown: true, absorption: 0, margin: 8, epf: 0, burning: false, hostileDistance: Infinity, bucket: false, clutchOn: false, waterWorks: true, clutchMax: 40 })!;
const INV = { slots: ['iron_pickaxe', 'iron_shovel'].map((name) => ({ name, count: 1 })), selected: 0 };

describe('Track R1: the relaxed options (nav/reach.ts relaxOptions)', () => {
  const owner = { allowBreak: true, digWay: { left: 9 }, protectedArea: { x: 0, y: 0, z: 0, r: 48 }, falls: POLICY, costs: { dig: 60 } };

  it('every "why" search digs, weighted, the dig price off; the owner budget is kept unless dig_budget is lifted', () => {
    const o = relaxOptions(owner, [], { dug: 3 });
    expect(o.allowBreak).toBe(true);
    expect(o.digWay).toEqual({ left: 9 });
    expect(o.costs?.dig).toBe(0);
    expect(o.relax?.weight).toBe(EXPLAIN_WEIGHT);
    expect(o.protectedArea).toEqual(owner.protectedArea);
    expect(o.allowPlace).toBeUndefined();
    // the dig way off and no allowBreak: no dig at all under the owner's rules
    expect(relaxOptions({}, [], { dug: 0 }).digWay).toEqual({ left: 0 });
  });

  it('each rule lifts its own part only', () => {
    expect(relaxOptions(owner, ['protected_area'], { dug: 0 }).protectedArea).toBeUndefined();
    expect(relaxOptions(owner, ['built'], { dug: 0 }).relax).toMatchObject({ built: true });
    expect(relaxOptions(owner, ['liquid'], { dug: 0 }).relax).toMatchObject({ liquid: true });
    expect(relaxOptions(owner, ['gravity'], { dug: 0 }).relax).toMatchObject({ gravity: true });
    expect(relaxOptions(owner, ['falls'], { hp: 20, dug: 0 }).falls?.hpBudget).toBe(19);
    expect(relaxOptions(owner, ['falls'], { hp: 9, dug: 0 }).falls?.hpBudget).toBe(Math.max(POLICY.hpBudget, 8));
    const d = relaxOptions(owner, ['dig_budget'], { dug: 0 });
    expect(d.digWay).toEqual({ left: RELAXED_DIG_BLOCKS });
    expect(d.relax).toMatchObject({ slow: true });
    const p = relaxOptions(owner, ['place'], { dug: 0 });
    expect(p.allowPlace).toBe(true);
    expect(p.throwaway).toBe(RELAXED_THROWAWAY);
    const all = relaxOptions(owner, REACH_RULES, { dug: 0 });
    expect(all.relax).toMatchObject({ built: true, liquid: true, gravity: true, slow: true });
  });
});

describe('Track R1: the rules read off a path (rulesOnPath)', () => {
  const node = (x: number, y: number, z: number, feet: number, extra: Partial<PathNode> = {}): PathNode => ({ x, y, z, feet, move: 'walk', cost: 1, ...extra });

  it('a dug built block, a fall over the budget, a placed block, more digs than the budget', () => {
    const g = flatGen();
    g.put(1, -60, 0, 'stone_bricks');
    g.put(2, -60, 0, 'stone');
    const grid = new NavGrid(g);
    const owner = { breakTicks: (c: Parameters<typeof breakTicksWith>[0]) => breakTicksWith(c, INV), digWay: { left: 1 }, falls: POLICY };
    expect(rulesOnPath(grid, [node(0, -60, 0, -60), node(1, -60, 0, -60, { act: { dig: [{ x: 1, y: -60, z: 0 }] } })], owner)).toEqual(['built']);
    expect(rulesOnPath(grid, [node(0, -60, 0, -60), node(2, -60, 0, -60, { act: { dig: [{ x: 2, y: -60, z: 0 }] } })], owner)).toEqual([]);
    expect(rulesOnPath(grid, [node(0, -60, 0, -60), node(1, -60, 0, -60, { act: { dig: [{ x: 1, y: -60, z: 0 }, { x: 2, y: -60, z: 0 }] } })], owner)).toEqual(['built', 'dig_budget']);
    // a 20-block fall onto grass (17 HP) over the 12 HP budget
    expect(rulesOnPath(grid, [node(0, -40, 0, -40), node(0, -60, 0, -60, { move: 'drop' })], owner)).toEqual(['falls']);
    expect(rulesOnPath(grid, [node(0, -60, 0, -60), node(0, -59, 0, -59, { move: 'pillar', act: { place: { p: { x: 0, y: -60, z: 0 }, face: 'up' } } })], owner)).toEqual(['place']);
  });

  it('a dug cell with water beside it, under gravel, inside the protected area', () => {
    const g = flatGen();
    g.put(1, -60, 0, 'stone');
    g.put(1, -60, 1, 'water');
    g.put(3, -60, 0, 'stone');
    g.put(3, -59, 0, 'gravel');
    const grid = new NavGrid(g);
    const dig = (x: number) => [node(0, -60, 0, -60), node(x, -60, 0, -60, { act: { dig: [{ x, y: -60, z: 0 }] } })];
    expect(rulesOnPath(grid, dig(1), {})).toEqual(['liquid']);
    expect(rulesOnPath(grid, dig(3), {})).toEqual(['gravity']);
    expect(rulesOnPath(new NavGrid(flatGen()), [node(0, -60, 0, -60), node(0, -61, 0, -61, { act: { dig: [{ x: 0, y: -61, z: 0 }] } })], { protectedArea: { x: 0.5, y: -60, z: 0.5, r: 8 } })).toEqual(['protected_area']);
  });
});

describe('Track R1: the sealed pocket (sealedPocket) and the cause words', () => {
  it('a room in bedrock is sealed; with one cell of stone in its shell, or the start inside, it is not', () => {
    const g = flatGen();
    g.fill({ x: 8, y: -61, z: 8 }, { x: 12, y: -57, z: 12 }, 'bedrock');
    g.fill({ x: 9, y: -60, z: 9 }, { x: 11, y: -59, z: 11 }, 'air');
    const goal = { x: 10, y: -60, z: 10 };
    expect(sealedPocket(new NavGrid(g), goal, { x: 0, y: -60, z: 0 })).toBe(true);
    expect(sealedPocket(new NavGrid(g), goal, { x: 9, y: -60, z: 9 })).toBe(false);
    g.put(12, -60, 10, 'stone');
    expect(sealedPocket(new NavGrid(g), goal, { x: 0, y: -60, z: 0 })).toBe(false);
  });

  it('open ground is never sealed (the flood runs into the box edge: unloaded)', () => {
    expect(sealedPocket(new NavGrid(flatGen()), { x: 0, y: -60, z: 0 }, { x: 20, y: -60, z: 20 })).toBe(false);
  });

  it('tags and words for each class; the longest reply stays far under the 480-byte wire limit', () => {
    expect(causeTag({ cls: 'world', rules: [] })).toBe('world');
    expect(causeTag({ cls: 'rule', rules: ['protected_area', 'built'] })).toBe('rule:protected_area+built');
    expect(causeTag({ cls: 'unloaded', rules: [] })).toBe('unloaded');
    expect(causeTag({ cls: 'budget', rules: [] })).toBe('budget');
    for (const r of REACH_RULES) expect(causeWords({ cls: 'rule', rules: [r] })).toMatch(new RegExp(`^rule ${r}: `));
    const longest = `goto: unreachable (${causeWords({ cls: 'rule', rules: [...REACH_RULES] })})`;
    expect(wireSize(longest)).toBeLessThan(480);
  });
});

describe('Track R1: the frontier end (PathOptions.frontier)', () => {
  // the box ends at x 31; a bedrock wall at x 30..31 the whole height; the goal 30 blocks past the box (unloaded)
  function walled(): GenWorld {
    const g = flatGen({ x: -32, y: -64, z: -32 }, { x: 64, y: 24, z: 64 });
    g.fill({ x: 30, y: -61, z: -32 }, { x: 31, y: -41, z: 31 }, 'bedrock');
    return g;
  }
  const goal = { type: 'block' as const, p: { x: 60, y: -60, z: 0 } };

  it('without it: no progress (the start is the loaded node closest to the goal)', () => {
    const r = findPath(new NavGrid(walled()), { x: 28, y: -60, z: 0 }, goal, { maxNodes: 200_000, maxMs: 10_000 });
    expect(r.status).toBe('partial');
    expect(r.reason).toBe('no_progress');
  });

  it('with it: a partial path to the most promising edge of the loaded world', () => {
    const r = findPath(new NavGrid(walled()), { x: 28, y: -60, z: 0 }, goal, { maxNodes: 200_000, maxMs: 10_000, frontier: true });
    expect(r.status).toBe('partial');
    expect(r.frontier).toBe(true);
    expect(r.reason).toBeUndefined();
    const end = r.path.at(-1)!;
    expect(Math.abs(end.z)).toBeGreaterThanOrEqual(30); // the box's z edge next to the wall: the shortest way round
    expect(end.x).toBeGreaterThan(20);
  });

  it('never for a goal in the loaded world', () => {
    const r = findPath(new NavGrid(walled()), { x: 28, y: -60, z: 0 }, { type: 'block', p: { x: -20, y: -50, z: 0 } }, { maxNodes: 200_000, maxMs: 10_000, frontier: true });
    expect(r.frontier).toBeUndefined();
  });
});

describe('Track R1: a path never stands on a cell it dug (nav/astar.ts dugOnTheWay)', () => {
  it('the bench pits world 3 (the 1-wide stair up a tower): no node stands on an earlier dig', () => {
    const bw = benchWorld('pits', 3);
    const pair = bw.pairs[10]!;
    const m = 40;
    const x0 = Math.max(0, Math.min(pair.start.x, pair.goal.x) - m);
    const z0 = Math.max(0, Math.min(pair.start.z, pair.goal.z) - m);
    const x1 = Math.min(bw.vox.sx - 1, Math.max(pair.start.x, pair.goal.x) + m);
    const z1 = Math.min(bw.vox.sz - 1, Math.max(pair.start.z, pair.goal.z) + m);
    const g = new GenWorld({ x: x0, y: -64, z: z0 }, { x: x1 - x0 + 1, y: 128, z: z1 - z0 + 1 });
    for (let y = -64; y < 64; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const id = bw.vox.get(x, y, z);
          if (id > 0) g.put(x, y, z, VOX_BLOCKS[id]![0], VOX_BLOCKS[id]![1]);
        }
    const r = findPath(new NavGrid(g), pair.start, { type: 'block', p: pair.goal }, {
      maxNodes: 400_000,
      maxMs: 30_000,
      breakTicks: (c) => breakTicksWith(c, INV),
      costs: { dig: 60 },
      allowBreak: true,
      digWay: { left: DIG_WAY_MAX_BLOCKS },
    });
    const dug = new Set<string>();
    for (const n of r.path) {
      const floor = `${n.x},${Math.floor(n.feet + 1e-6) - (n.feet - Math.floor(n.feet + 1e-6) > 0.25 ? 0 : 1)},${n.z}`;
      expect(dug.has(floor), `node ${n.x},${n.y},${n.z} (${n.move}) stands on a cell dug before it`).toBe(false);
      for (const d of n.act?.dig ?? []) dug.add(`${d.x},${d.y},${d.z}`);
    }
  }, 60_000);
});

describe('Track R1: the guide (docs/pathfinding.md "Reachability (Track R1)")', () => {
  const doc = readFileSync(new URL('../../../../docs/pathfinding.md', import.meta.url), 'utf8');
  const at = doc.indexOf('\n## Reachability (Track R1)\n');
  const s = doc.slice(at, doc.indexOf('\n## ', at + 4));

  it('has the section, links the decision, names every rule, station and constant with its value', () => {
    expect(at).toBeGreaterThan(0);
    expect(s).toContain('decisions/0072-reachability.md');
    expect(() => readFileSync(new URL('../../../../docs/decisions/0072-reachability.md', import.meta.url), 'utf8')).not.toThrow();
    for (const r of REACH_RULES) expect(s, r).toContain(`\`${r}\``);
    for (const st of R1_STATIONS) expect(s, st).toContain(`\`${st}\``);
    for (const [k, v] of [['BIG_SEARCH', BIG_SEARCH], ['EXPLAIN_MAX_SEARCHES', EXPLAIN_MAX_SEARCHES], ['EXPLAIN_WEIGHT', EXPLAIN_WEIGHT], ['FRONTIER_MAX_LEGS', FRONTIER_MAX_LEGS], ['OFF_PATH_LOOP', OFF_PATH_LOOP]] as const)
      expect(s, `${k} ${v}`).toMatch(new RegExp(`\`${k}\`\\s+${v}\\b`));
  });
});
