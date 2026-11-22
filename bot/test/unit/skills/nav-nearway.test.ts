// Track EF1 (decision 0127, docs/pathfinding.md "A near walk has a bound"): a walk to something near (a pickup, a stand
// cell by a tree) is bounded (GotoOptions.maxWay -> PathOptions.maxCost), so a goal no short way reaches is no way at once:
// the search stays inside the bound (exhaustive there, nothing unloaded touched) instead of flooding the loaded world and
// waiting for its far chunks. The benchmark's wood runs lost 6 of every 10 seconds that way before.
import { describe, expect, it } from 'vitest';
import { treeShape } from '../../../../packs/truth/src/woodShapes.ts';
import { collectItems, type CollectDeps } from '../../../src/skills/collect/collect.ts';
import { BotSkills, type SkillResult } from '../../../src/skills/index.ts';
import type { Goal, NavGoal } from '../../../src/skills/nav/goals.ts';
import { DEFAULT_COSTS, findPath, NavGrid } from '../../../src/skills/nav/index.ts';
import { NEAR_WAY, nearWay } from '../../../src/skills/nav/nearway.ts';
import type { GotoOptions } from '../../../src/skills/types.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const W = DEFAULT_COSTS.walk;
const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** A flat world 128 x 128 with a 4-high pillar 3 blocks off the start: its top is no walk's goal (no jump of 2). */
function pillarWorld(): GenWorld {
  const w = flatGen();
  w.fill(at(0, -60, 3), at(0, -57, 3), 'stone');
  return w;
}

/**
 * A wall across the whole world at z = 3 with a gap at x = 50: the cell behind it is 3 off, the way round about 100.
 * Planks (built, not natural terrain: the dig way's level does not open it).
 */
function wallWorld(): GenWorld {
  const w = flatGen();
  w.fill(at(-64, -60, 3), at(63, -58, 3), 'oak_planks');
  w.fill(at(50, -60, 3), at(50, -59, 3), 'air');
  return w;
}

describe('nearWay', () => {
  it('is at least NEAR_WAY.min blocks, else 3 x the distance + 16', () => {
    expect(nearWay(at(0, 0, 0), at(2, 0, 0))).toBe(NEAR_WAY.min);
    expect(nearWay(at(0, 0, 0), at(8, 0, 0))).toBe(40);
    expect(nearWay(at(0.5, 64, 0.5), at(3.5, 68, 0.5))).toBe(31); // 3 x 5 + 16
  });
});

describe('findPath with a cost bound (PathOptions.maxCost)', () => {
  it('a goal no way reaches: unbounded the search floods the world and touches its unloaded edge; bounded it is `none` at once', () => {
    const goal: NavGoal = { type: 'block', p: at(0, -56, 3) };
    const free = findPath(new NavGrid(pillarWorld()), at(0, -60, 0), goal, { maxNodes: 200_000 });
    expect(free.status).not.toBe('found');
    expect(free.unknown).toBe(true);
    expect(free.expanded).toBeGreaterThan(10_000);
    const bound = findPath(new NavGrid(pillarWorld()), at(0, -60, 0), goal, { maxNodes: 200_000, maxCost: nearWay(at(0, -60, 0), at(0, -56, 3)) * W });
    expect(bound.status).toBe('none');
    expect(bound.unknown).toBe(false);
    expect(bound.limited).toBe(false);
    expect(bound.expanded).toBeLessThan(free.expanded / 5);
  });

  it('a goal only a long way round reaches: found unbounded, no way within the bound', () => {
    const goal: NavGoal = { type: 'block', p: at(0, -60, 5) };
    const free = findPath(new NavGrid(wallWorld()), at(0, -60, 0), goal, { maxNodes: 200_000 });
    expect(free.status).toBe('found');
    expect(free.cost).toBeGreaterThan(90 * W);
    const bound = findPath(new NavGrid(wallWorld()), at(0, -60, 0), goal, { maxNodes: 200_000, maxCost: nearWay(at(0, -60, 0), at(0, -60, 5)) * W });
    expect(bound.status).toBe('none');
    expect(bound.unknown).toBe(false);
  });

  it('a goal within the bound: the same way as unbounded', () => {
    const w = pillarWorld();
    const goal: NavGoal = { type: 'block', p: at(2, -60, 6) };
    const free = findPath(new NavGrid(w), at(0, -60, 0), goal);
    const bound = findPath(new NavGrid(w), at(0, -60, 0), goal, { maxCost: nearWay(at(0, -60, 0), at(2, -60, 6)) * W });
    expect(bound.status).toBe('found');
    expect(bound.cost).toBeCloseTo(free.cost, 6);
    expect(bound.path.map((n) => `${n.x},${n.y},${n.z}`)).toEqual(free.path.map((n) => `${n.x},${n.y},${n.z}`));
  });
});

async function goto(gen: GenWorld, start: Vec3, goal: Goal, opts: GotoOptions, maxTicks = 1500): Promise<{ result: SkillResult | undefined; ticks: number }> {
  const { conn, loop } = harness(start);
  const skills = new BotSkills({ loop, world: fakeWorld(gen) });
  conn.tick(5);
  let result: SkillResult | undefined;
  const p = skills.goto(goal, opts).then((r) => (result = r));
  let t = 0;
  while (skills.nav.busy && t < maxTicks) {
    conn.tick();
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t };
}

describe('a goto with maxWay (closed loop)', () => {
  it('to a cell no short way reaches: unreachable within a few ticks (unbounded: the long way round)', async () => {
    const goal: Goal = { type: 'block', p: at(0, -60, 5) };
    const start = at(0.5, -60, 0.5);
    const bound = await goto(wallWorld(), start, goal, { maxWay: nearWay(start, at(0.5, -60, 5.5)), timeoutTicks: 600 });
    expect(bound.result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(bound.ticks).toBeLessThan(60);
    // unbounded the same goto walks the way round (about 100 blocks): the bound is what makes it no way
    const free = await goto(wallWorld(), start, goal, { timeoutTicks: 600 });
    expect(free.result).toEqual({ ok: true });
    expect(free.ticks).toBeGreaterThan(200);
  });

  it('to a cell a short way reaches: walks there as before', async () => {
    const goal: Goal = { type: 'block', p: at(3, -60, 6) };
    const start = at(0.5, -60, 0.5);
    const run = await goto(pillarWorld(), start, goal, { maxWay: nearWay(start, at(3.5, -60, 6.5)), timeoutTicks: 600 });
    expect(run.result).toEqual({ ok: true });
  });
});

describe('the feller bounds its walks to a stand cell', () => {
  it('every block walk of a fell carries nearWay from the body to the cell (a fell that walks there first)', async () => {
    const gen = flatGen();
    const s = treeShape(6, -60, 2, 6);
    for (const p of s.logs) gen.put(p.x, p.y, p.z, 'oak_log');
    for (const p of s.leaves) if (gen.blockAt(p.x, p.y, p.z)?.name === 'air') gen.put(p.x, p.y, p.z, 'oak_leaves');
    const { conn, loop } = harness(at(0.5, -60, 0.5));
    const world = { ...fakeWorld(gen), blockAt: (p: Vec3) => gen.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), inventory: new Inventory(() => null, () => 7n) };
    const skills = new BotSkills({ loop, world });
    const seen: { goal: Goal; from: Vec3; opts: GotoOptions | undefined }[] = [];
    const nav = skills.nav;
    const orig = nav.goto.bind(nav);
    nav.goto = (g, o) => {
      seen.push({ goal: g as Goal, from: { ...loop.state.pos }, opts: o });
      return orig(g, o);
    };
    conn.tick(5);
    const pending: { p: Vec3; at: number }[] = [];
    let done = false;
    void skills.fellTree(skills.treeAt(s.logs[0]!)!).then(() => (done = true));
    for (let t = 0; t < 3000 && !done; t++) {
      conn.tick();
      for (const a of (conn.sent.at(-1)?.block_action ?? []) as { action: string; position: Vec3 }[]) if (a.action === 'start_break') pending.push({ p: { ...a.position }, at: t + 3 });
      for (const q of pending.filter((q) => q.at <= t)) {
        pending.splice(pending.indexOf(q), 1);
        gen.set(q.p.x, q.p.y, q.p.z, 'air');
      }
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(done).toBe(true);
    const walks = seen.filter((w) => w.goal.type === 'block');
    expect(walks.length).toBeGreaterThan(0);
    for (const w of walks) {
      const g = w.goal as Extract<Goal, { type: 'block' }>;
      expect(w.opts?.maxWay).toBe(nearWay(w.from, g.p));
    }
  });
});

describe('collect bounds each pickup walk', () => {
  it('passes nearWay(from the body, to the item) as maxWay', async () => {
    const entities = new Map<bigint, EntityInfo>();
    const e: EntityInfo = { runtimeId: 1n, uniqueId: 1n, type: 'minecraft:item', item: { name: 'oak_log', networkId: 17, count: 1, metadata: 0 }, pos: at(4.3, -59.875, 0.5), vel: at(0, 0, 0), yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0 };
    entities.set(1n, e);
    const state = { pos: at(0.5, -60, 0.5), corrections: 0, tick: 0n };
    const seen: (GotoOptions | undefined)[] = [];
    const deps: CollectDeps = {
      entities: () => entities,
      state: () => state,
      waitTicks: (n) => {
        state.tick += BigInt(n);
        return Promise.resolve();
      },
      goto: (_g, o) => {
        seen.push(o);
        state.tick += 5n;
        entities.delete(1n);
        return Promise.resolve({ ok: true });
      },
      inventory: new Inventory(() => null, () => 1n),
      cancelled: () => false,
    };
    await collectItems(8, 200, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxWay).toBe(nearWay(at(0.5, -60, 0.5), e.pos));
  });
});
