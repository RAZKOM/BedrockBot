// Task 7.10: the tree finder and the feller consult the navigator's failure blacklist, so a gather
// never loops on a log it cannot get to (docs/wood.md, docs/pathfinding.md "Blacklist").
import { describe, expect, it } from 'vitest';
import { treeShape } from '../../../../packs/truth/src/woodShapes.ts';
import { NavBlacklist } from '../../../src/skills/nav/blacklist.ts';
import type { Goal } from '../../../src/skills/nav/goals.ts';
import { fellTree, type FellDeps } from '../../../src/skills/tree/feller.ts';
import { detectTree, treesFrom } from '../../../src/skills/tree/tree.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { flatGen, type GenWorld } from './genworld.ts';

function plant(w: GenWorld, x: number, z: number, h: number): Vec3[] {
  const s = treeShape(x, -60, z, h);
  for (const p of s.logs) w.put(p.x, p.y, p.z, 'oak_log');
  for (const p of s.leaves) if (w.blockAt(p.x, p.y, p.z)?.name === 'air') w.put(p.x, p.y, p.z, 'oak_leaves');
  return s.logs;
}

const at = (w: GenWorld) => (p: Vec3) => w.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));

describe('tree finder', () => {
  it('starts no tree from a blacklisted log and drops a tree whose every log is blacklisted', () => {
    const w = flatGen();
    const a = plant(w, 5, 0, 4);
    const b = plant(w, 12, 0, 5);
    const bl = new NavBlacklist({ failures: 1, now: () => 0 });
    const origin = { x: 0.5, y: -60, z: 0.5 };
    expect(treesFrom(at(w), [...a, ...b], origin, { skip: (p) => bl.blocked(p) }).map((t) => t.base.x)).toEqual([5, 12]);
    bl.failBlock(a[0]!); // only the base: the tree is still found from its other logs
    expect(treesFrom(at(w), [...a, ...b], origin, { skip: (p) => bl.blocked(p) }).map((t) => t.base.x)).toEqual([5, 12]);
    for (const p of a) bl.failBlock(p);
    expect(treesFrom(at(w), [...a, ...b], origin, { skip: (p) => bl.blocked(p) }).map((t) => t.base.x)).toEqual([12]);
  });
});

describe('feller', () => {
  /** A tree the bot cannot get to: every goto fails. */
  function unreachable() {
    const w = flatGen();
    const logs = plant(w, 10, 0, 4);
    const tree = detectTree(at(w), logs[0]!)!;
    const gotos: Goal[] = [];
    const deps: FellDeps = {
      blockAt: at(w),
      state: () => ({ pos: { x: 0.5, y: -60, z: 0.5 }, corrections: 0 }),
      dig: () => Promise.resolve({ ok: false, reason: 'unreachable' }),
      goto: (g) => {
        gotos.push(g);
        return Promise.resolve({ ok: false, reason: 'unreachable' });
      },
      stand: (x, y, z) => {
        const f = w.blockAt(x, y, z)?.name === 'air' && w.blockAt(x, y + 1, z)?.name === 'air' && w.blockAt(x, y - 1, z)?.name === 'grass_block';
        return f ? y : Number.NaN;
      },
      cancelled: () => false,
    };
    return { w, logs, tree, gotos, deps };
  }

  it('an unreachable log counts one failure per fell; after 3 fells it is skipped without walking', async () => {
    const u = unreachable();
    const bl = new NavBlacklist({ now: () => 0 });
    const deps = { ...u.deps, blacklist: bl };
    for (let i = 1; i <= 3; i++) {
      const r = await fellTree(u.tree, deps, { repathTries: 2 });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('logs_left');
      for (const p of u.logs) expect(bl.count(`b:${p.x},${p.y},${p.z}`)).toBe(i);
    }
    for (const p of u.logs) expect(bl.blocked(p)).toBe(true);
    const walked = u.gotos.length;
    expect(walked).toBeGreaterThan(0);
    const r = await fellTree(u.tree, deps, { repathTries: 2 });
    expect(r.reason).toBe('logs_left');
    expect(u.gotos.length).toBe(walked); // no goto at all: every log is blacklisted
  });

  it('without a blacklist it walks again every time (the old behaviour)', async () => {
    const u = unreachable();
    await fellTree(u.tree, u.deps, { repathTries: 1 });
    const once = u.gotos.length;
    await fellTree(u.tree, u.deps, { repathTries: 1 });
    expect(u.gotos.length).toBe(2 * once);
  });
});
