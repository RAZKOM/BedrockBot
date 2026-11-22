import { describe, expect, it } from 'vitest';
import { DEFAULT_COSTS, dropCost, findPath, locateNode, NavGrid, type PathNode } from '../../../src/skills/nav/index.ts';
import { flatGen, hillyGen, rng, surfaceFeet, type GenWorld } from './genworld.ts';

const W = DEFAULT_COSTS.walk;
const moves = (p: PathNode[]) => p.map((n) => n.move);
const plan = (w: GenWorld, from: [number, number, number], to: [number, number, number]) =>
  findPath(new NavGrid(w), { x: from[0], y: from[1], z: from[2] }, { type: 'block', p: { x: to[0], y: to[1], z: to[2] } });

describe('NavGrid.stand', () => {
  it('finds feet heights on full blocks, slabs, carpets and soul sand; rejects water, lava, hazards and low ceilings', () => {
    const w = flatGen();
    const g = () => new NavGrid(w);
    expect(g().stand(0, -60, 0)).toBe(-60);
    expect(g().stand(0, -61, 0)).toBeNaN(); // inside the grass
    expect(g().stand(0, -59, 0)).toBeNaN(); // floating
    w.put(1, -60, 0, 'oak_slab');
    expect(g().stand(1, -60, 0)).toBe(-59.5);
    w.put(2, -60, 0, 'oak_slab', { 'minecraft:vertical_half': 'top' });
    expect(g().stand(2, -60, 0)).toBeNaN();
    expect(g().stand(2, -59, 0)).toBe(-59);
    w.put(3, -60, 0, 'white_carpet');
    expect(g().stand(3, -60, 0)).toBeCloseTo(-59.9375, 6);
    w.put(4, -61, 0, 'soul_sand');
    expect(g().stand(4, -61, 0)).toBeCloseTo(-60.125, 6);
    w.put(5, -61, 0, 'water');
    expect(g().stand(5, -60, 0)).toBeNaN();
    w.put(6, -60, 0, 'water');
    expect(g().stand(6, -60, 0)).toBeNaN();
    w.put(7, -61, 0, 'magma');
    expect(g().stand(7, -60, 0)).toBeNaN();
    w.put(8, -60, 0, 'web');
    expect(g().stand(8, -60, 0)).toBeNaN();
    w.put(9, -58, 0, 'stone'); // head room 2 blocks: ok
    expect(g().stand(9, -60, 0)).toBe(-60);
    w.put(10, -59, 0, 'stone'); // 1 block: no
    expect(g().stand(10, -60, 0)).toBeNaN();
    w.put(11, -60, 0, 'oak_fence');
    expect(g().stand(11, -60, 0)).toBeNaN();
    expect(g().stand(11, -59, 0)).toBeNaN(); // 1.5 high: not a floor
    // slab with a block 2 above the slab's cell: 1.8 body from -59.5 reaches -57.7, cell -58 must be free
    w.put(12, -60, 0, 'oak_slab');
    w.put(12, -58, 0, 'stone');
    expect(g().stand(12, -60, 0)).toBeNaN();
    expect(g().stand(0, 200, 0)).toBeUndefined(); // outside the world: unknown
  });
});

describe('findPath moves', () => {
  it('walks straight and diagonally on flat ground', () => {
    const r = plan(flatGen(), [0, -60, 0], [5, -60, 5]);
    expect(r.status).toBe('found');
    expect(moves(r.path).filter((m) => m === 'diag')).toHaveLength(5);
    expect(r.cost).toBeCloseTo(5 * Math.SQRT2 * W, 6);
  });

  it('jumps up one block and drops up to 3 (tick costs, a 3-block drop is irreversible)', () => {
    const w = flatGen();
    w.fill({ x: -1, y: -60, z: 2 }, { x: 1, y: -60, z: 2 }, 'stone');
    const up = plan(w, [0, -60, 0], [0, -59, 2]);
    expect(moves(up.path)).toEqual(['start', 'walk', 'jump']);
    expect(up.cost).toBeCloseTo(W + DEFAULT_COSTS.jump, 6);
    const w2 = flatGen();
    w2.fill({ x: -1, y: -60, z: -1 }, { x: 1, y: -58, z: 1 }, 'stone');
    const down = plan(w2, [0, -57, 0], [0, -60, 3]);
    expect(down.status).toBe('found');
    expect(moves(down.path)).toEqual(['start', 'walk', 'drop', 'walk']);
    expect(down.cost).toBeCloseTo(W + dropCost(DEFAULT_COSTS, 3) + DEFAULT_COSTS.irreversibleDrop + W, 6);
  });

  it('does not jump 2 blocks or drop 4', () => {
    const w = flatGen({ x: -8, y: -64, z: -8 }, { x: 16, y: 24, z: 16 });
    // a pillar 4 high with the goal on top: nothing reaches it
    w.fill({ x: 0, y: -60, z: 3 }, { x: 0, y: -57, z: 3 }, 'stone');
    expect(plan(w, [0, -60, 0], [0, -56, 3]).status).not.toBe('found');
    // start on a 4-high pillar: no way down
    const w2 = flatGen({ x: -8, y: -64, z: -8 }, { x: 16, y: 24, z: 16 });
    w2.fill({ x: 0, y: -60, z: 0 }, { x: 0, y: -57, z: 0 }, 'stone');
    const r = plan(w2, [0, -56, 0], [0, -60, 3]);
    expect(r.status).toBe('none');
    expect(r.path).toHaveLength(1);
  });

  it('steps up slabs by walking', () => {
    const w = flatGen();
    w.put(0, -60, 1, 'oak_slab');
    w.put(0, -60, 2, 'stone');
    const r = plan(w, [0, -60, 0], [0, -59, 2]);
    expect(moves(r.path)).toEqual(['start', 'walk', 'walk']);
    expect(r.path.map((n) => n.feet)).toEqual([-60, -59.5, -59]);
  });

  it('needs head room above the start for a jump', () => {
    const w = flatGen();
    w.fill({ x: -3, y: -60, z: 2 }, { x: 3, y: -60, z: 2 }, 'stone');
    w.fill({ x: -3, y: -58, z: 1 }, { x: 3, y: -58, z: 1 }, 'stone'); // ceiling right before the step
    const r = plan(w, [0, -60, 0], [0, -59, 2]);
    expect(r.path.some((n) => n.x === 0 && n.z === 1 && n.move === 'walk') && r.path.at(-1)!.move === 'jump').toBe(false);
  });

  it('does not cut corners diagonally', () => {
    const w = flatGen();
    w.fill({ x: 1, y: -60, z: 0 }, { x: 1, y: -59, z: 0 }, 'stone');
    const r = plan(w, [0, -60, 0], [1, -60, 1]);
    expect(moves(r.path)).toEqual(['start', 'walk', 'walk']);
  });

  it('avoids water and lava and prefers not to stand on leaves', () => {
    const w = flatGen();
    w.fill({ x: -2, y: -61, z: 2 }, { x: 2, y: -61, z: 2 }, 'water');
    const r = plan(w, [0, -60, 0], [0, -60, 4]);
    expect(r.status).toBe('found');
    expect(r.path.some((n) => n.z === 2 && Math.abs(n.x) <= 2)).toBe(false);
    const w2 = flatGen();
    w2.fill({ x: -1, y: -61, z: 2 }, { x: 1, y: -61, z: 2 }, 'oak_leaves');
    const r2 = plan(w2, [0, -60, 0], [0, -60, 4]);
    expect(r2.path.some((n) => n.z === 2 && Math.abs(n.x) <= 1)).toBe(false);
    expect(r2.cost).toBeLessThan(4 * W * 5); // a detour costs less than walking on the leaves (x 5)
  });

  it('returns a partial path towards an unloaded goal', () => {
    const w = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 24, z: 32 });
    const r = plan(w, [0, -60, 0], [0, -60, 100]);
    expect(r.status).toBe('partial');
    expect(r.path.at(-1)!.z).toBe(15);
  });

  it('locates the node of a body hanging over an edge', () => {
    const w = flatGen();
    w.fill({ x: -1, y: -60, z: -1 }, { x: 1, y: -58, z: 1 }, 'stone');
    const g = new NavGrid(w);
    expect(locateNode(g, { x: 0.5, y: -57, z: 0.5 })).toEqual({ x: 0, y: -57, z: 0, feet: -57 });
    // centre over air at z 2.1, the box still on the platform edge (z up to 1.999)
    expect(locateNode(g, { x: 0.5, y: -57, z: 2.1 })).toMatchObject({ x: 0, y: -57, z: 1 });
  });
});

// Track REL3: the work side of PLAN.md 3.5 (1000 random paths under 50 ms each). The wall-clock bounds are in the perf
// project (test/perf/astar.perf.test.ts, `pnpm test:perf`, its bounds as they were): under load they measured the
// machine (p99 161 ms and a cold p95 86 ms beside a CPU load). Here the same paths are held to their work: 50 ms is
// about 32 000 expansions at this PC's idle rate (0.1 ms per 64), and the unit run's work clock (test/unit/setup.ts)
// makes every search end at the same node on any machine.
describe('findPath work (PLAN.md 3.5: 1000 random paths; the time bounds are in test/perf)', () => {
  /** 50 ms at the idle rate the perf bound was set on (0.1 ms per 64 expansions). */
  const BUDGET_NODES = 32_000;

  it('plans 1000 random paths on a generated 128 x 128 hilly world within the node budget', () => {
    const w = hillyGen(42);
    const r = rng(1234);
    const expanded: number[] = [];
    const statuses: Record<string, number> = {};
    let limited = 0;
    const grid = new NavGrid(w); // shared cache, as the live navigator keeps it
    while (expanded.length < 1000) {
      const sx = Math.floor(r() * 124) - 62;
      const sz = Math.floor(r() * 124) - 62;
      const gx = Math.floor(r() * 124) - 62;
      const gz = Math.floor(r() * 124) - 62;
      const sf = surfaceFeet(w, sx, sz);
      const gf = surfaceFeet(w, gx, gz);
      if (sf === undefined || gf === undefined) continue;
      const res = findPath(grid, { x: sx, y: Math.floor(sf), z: sz }, { type: 'block', p: { x: gx, y: Math.floor(gf), z: gz } });
      if (res.path.length === 0) continue; // start not standable (e.g. under a tree)
      expanded.push(res.expanded);
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (res.limited) limited++;
    }
    expanded.sort((a, b) => a - b);
    const p = (q: number) => expanded[Math.min(expanded.length - 1, Math.floor(q * expanded.length))]!;
    console.log(`[astar work] 1000 paths: expanded p50 ${p(0.5)}, p99 ${p(0.99)}, max ${expanded.at(-1)}; ${limited} limited; ${JSON.stringify(statuses)}`);
    expect(p(0.99)).toBeLessThan(BUDGET_NODES);
    expect(statuses.found ?? 0).toBeGreaterThan(500);
  });

  it('plans 200 random paths with a cold cache (a fresh grid per path) within the node budget', () => {
    const w = hillyGen(43);
    const r = rng(99);
    const expanded: number[] = [];
    while (expanded.length < 200) {
      const sx = Math.floor(r() * 124) - 62;
      const sz = Math.floor(r() * 124) - 62;
      const gx = Math.floor(r() * 124) - 62;
      const gz = Math.floor(r() * 124) - 62;
      const sf = surfaceFeet(w, sx, sz);
      const gf = surfaceFeet(w, gx, gz);
      if (sf === undefined || gf === undefined) continue;
      const res = findPath(new NavGrid(w), { x: sx, y: Math.floor(sf), z: sz }, { type: 'block', p: { x: gx, y: Math.floor(gf), z: gz } });
      if (res.path.length === 0) continue;
      expanded.push(res.expanded);
    }
    expanded.sort((a, b) => a - b);
    const p = (q: number) => expanded[Math.min(expanded.length - 1, Math.floor(q * expanded.length))]!;
    console.log(`[astar work, cold cache] 200 paths: expanded p50 ${p(0.5)}, p95 ${p(0.95)}, max ${expanded.at(-1)}`);
    expect(p(0.95)).toBeLessThan(BUDGET_NODES);
  });
});

describe('farmlandDropCost (the farmer on a terraced field)', () => {
  it('plans around a ledge drop onto farmland when a way down onto grass exists', async () => {
    const { farmlandDrop } = await import('../../../src/skills/farm/farmer.ts');
    const w = flatGen();
    w.fill({ x: 0, y: -60, z: -3 }, { x: 4, y: -60, z: 0 }, 'stone'); // a ledge, feet -59
    w.fill({ x: -6, y: -61, z: 1 }, { x: 10, y: -61, z: 3 }, 'farmland'); // the field below it
    const at = (p: { x: number; y: number; z: number }) => w.blockAt(p.x, p.y, p.z);
    const from = { x: 2, y: -59, z: 0 };
    const goal = { type: 'block' as const, p: { x: 2, y: -60, z: 5 } };
    const plain = findPath(new NavGrid(w), from, goal);
    expect(plain.status).toBe('found');
    expect(farmlandDrop(plain.path, at)).toBeGreaterThan(0.75); // straight off the ledge onto the crops
    const careful = findPath(new NavGrid(w), from, goal, { farmlandDropCost: 200 });
    expect(careful.status).toBe('found');
    expect(farmlandDrop(careful.path, at)).toBe(0); // down onto the grass beside the ledge, then across the rows
  });
});
