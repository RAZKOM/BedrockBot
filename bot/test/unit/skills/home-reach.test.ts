// Wave 9 Track AN: walking distance to the containers at home (skills/home/reach.ts) on a generated
// flat world: the probe plan (sliced, no walking), its verdict for homeChestWalk, the chest goal that
// accepts a chest up to 3 blocks above the feet, and the e2e layout (home-reach.test.ts) in miniature:
// 2 floor chests and a pillar chest reachable, 2 walled-in chests with no path, 1 chest 12 blocks
// away in a straight line but about 37 path blocks around a walled room.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unreadRecord } from '../../../src/skills/home/memory.ts';
import { ChestMemory } from '../../../src/world/cache/chests.ts';
import { goalTest, NavGrid } from '../../../src/skills/nav/index.ts';
import type { PathResult } from '../../../src/skills/nav/astar.ts';
import { chestGoal, pathBlocks, probePath, PROBE_NODES, verdict, type ProbeNav } from '../../../src/skills/home/reach.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const F = -60;

/** The e2e layout around home (0, F, 0). */
function layout(gen: GenWorld) {
  const L = {
    a: { x: 3, y: F, z: 2 },
    b: { x: -3, y: F, z: -2 },
    pillar: { x: 0, y: F + 3, z: -6 },
    walledA: { x: -6, y: F, z: 5 },
    walledB: { x: -6, y: F, z: -6 },
    far: { x: 12, y: F, z: 0 },
  };
  for (const p of [L.a, L.b]) gen.put(p.x, p.y, p.z, 'chest');
  gen.fill({ x: L.pillar.x, y: F, z: L.pillar.z }, { x: L.pillar.x, y: F + 2, z: L.pillar.z }, 'stone');
  gen.put(L.pillar.x, L.pillar.y, L.pillar.z, 'chest');
  for (const w of [L.walledA, L.walledB]) {
    gen.fill({ x: w.x - 1, y: F, z: w.z - 1 }, { x: w.x + 1, y: F + 2, z: w.z + 1 }, 'stone');
    gen.put(w.x, w.y, w.z, 'chest');
  }
  // the far chest: a walled room x 10..14, z -12..12, 3 high, its door on the far side (x 14, z 0)
  gen.fill({ x: 10, y: F, z: -12 }, { x: 14, y: F + 2, z: 12 }, 'stone');
  gen.fill({ x: 11, y: F, z: -11 }, { x: 13, y: F + 2, z: 11 }, 'air');
  gen.fill({ x: 14, y: F, z: 0 }, { x: 14, y: F + 1, z: 0 }, 'air');
  gen.put(L.far.x, L.far.y, L.far.z, 'chest');
  return L;
}

const navOf = (grid: NavGrid): ProbeNav => ({ grid, planOptions: () => ({}) });
const HOME: Vec3 = { x: 0.5, y: F, z: 0.5 };

describe('home reach (Track AN)', () => {
  it('chestGoal: from a side column with the chest up to 3 blocks above the feet, in reach 4', () => {
    const gen = flatGen();
    const grid = new NavGrid(gen);
    gen.fill({ x: 0, y: F, z: 0 }, { x: 0, y: F + 2, z: 0 }, 'stone');
    gen.put(0, F + 3, 0, 'chest');
    const g = goalTest(chestGoal({ x: 0, y: F + 3, z: 0 }), grid);
    expect(g.done(1, F, 0, F)).toBe(true); // feet 3 below, beside the pillar
    expect(g.done(1, F, 1, F)).toBe(true); // diagonal
    // the plain getToBlock goal wants the chest at the feet or the head
    expect(goalTest({ type: 'getToBlock', p: { x: 0, y: F + 3, z: 0 }, reach: 4 }, grid).done(1, F, 0, F)).toBe(false);
    // 4 below is too low for `low: 3`
    gen.put(0, F + 3, 0, 'stone');
    gen.put(0, F + 4, 0, 'chest');
    expect(goalTest(chestGoal({ x: 0, y: F + 4, z: 0 }), grid).done(1, F, 0, F)).toBe(false);
  });

  it('pathBlocks and verdict', () => {
    const path = [
      { x: 0, z: 0, feet: F },
      { x: 1, z: 0, feet: F },
      { x: 2, z: 1, feet: F },
      { x: 2, z: 1, feet: F + 1 },
    ];
    expect(pathBlocks(path)).toBeCloseTo(1 + Math.SQRT2 + 1, 9);
    const r = (status: PathResult['status'], limited = false): PathResult => ({ status, path: path.map((n) => ({ ...n, y: n.feet, move: 'walk', cost: 1 })) as never, cost: 0, expanded: 1, ms: 1, unknown: false, limited });
    expect(verdict(r('found'), 32)).toEqual({ ok: true, blocks: pathBlocks(path) });
    expect(verdict(r('found'), 3)).toMatchObject({ ok: false, reason: 'path 3 blocks' });
    expect(verdict(r('found'), 0)).toMatchObject({ ok: true }); // no limit
    expect(verdict(r('none'), 32)).toEqual({ ok: false, reason: 'no path' });
    expect(verdict(r('partial', true), 32)).toEqual({ ok: false, reason: `no path within ${PROBE_NODES} nodes` });
    expect(verdict(r('partial'), 32)).toEqual({ ok: false, reason: 'no path in the loaded world' }); // every loaded cell tried
  });

  it('probes the e2e layout: 3 reachable (one on a pillar), 2 walled in, 1 too far to walk', async () => {
    const gen = flatGen();
    const L = layout(gen);
    const nav = navOf(new NavGrid(gen));
    const out: Record<string, { status: string; blocks: number; ms: number; expanded: number; v: ReturnType<typeof verdict> }> = {};
    for (const [k, p] of Object.entries(L)) {
      const r = await probePath(nav, chestGoal(p), HOME);
      expect(r, k).toBeDefined();
      out[k] = { status: r!.status, blocks: pathBlocks(r!.path), ms: r!.ms, expanded: r!.expanded, v: verdict(r!, 32) };
    }
    expect(out.a!.v.ok).toBe(true);
    expect(out.b!.v.ok).toBe(true);
    expect(out.pillar!.v.ok).toBe(true);
    expect(out.walledA!.v).toMatchObject({ ok: false });
    expect(out.walledB!.v).toMatchObject({ ok: false });
    expect(out.far!.status).toBe('found');
    expect(out.far!.blocks).toBeGreaterThan(32);
    expect(out.far!.blocks).toBeLessThan(45);
    expect(out.far!.v).toMatchObject({ ok: false, reason: `path ${Math.round(out.far!.blocks)} blocks` });
    expect(verdict({ status: 'found', path: [], cost: 0, expanded: 0, ms: 0, unknown: false, limited: false }, 0).ok).toBe(true);
    // a start that is no standable node: nothing to say
    expect(await probePath(nav, chestGoal(L.a), { x: 0.5, y: F - 2, z: 0.5 })).toBeUndefined();
  });

  it('the unreachable mark is written to chests.json and read back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-reach-'));
    try {
      const m = new ChestMemory({ dir });
      m.set({ ...unreadRecord({ x: 1, y: F, z: 2 }, 'chest'), unreachable: 'no path', unreachableAt: 123 });
      m.set(unreadRecord({ x: 2, y: F, z: 2 }, 'barrel'));
      m.flushSync();
      const back = new ChestMemory({ dir });
      expect(back.get({ x: 1, y: F, z: 2 })).toMatchObject({ unreachable: 'no path', unreachableAt: 123 });
      expect(back.get({ x: 2, y: F, z: 2 })!.unreachable).toBeUndefined();
      expect('unreachableAt' in back.get({ x: 2, y: F, z: 2 })!).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a probe yields to the event loop between slices', async () => {
    const gen = flatGen();
    layout(gen);
    const nav = navOf(new NavGrid(gen));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    // walled in: the search runs through the whole generated world (or to its budget)
    const r = await probePath(nav, chestGoal({ x: -6, y: F, z: 5 }), HOME, { nodes: 200_000, ms: 300 });
    clearInterval(timer);
    expect(r?.status).not.toBe('found');
    expect(verdict(r!, 32).ok).toBe(false);
    if (r!.ms > 30) expect(ticks).toBeGreaterThan(0);
  });
});
