// `!explore` (wave 9, Track AI; docs/explore.md): the frontier (cells, gain, pick order, stand spots,
// mark counts), the Explorer loop on a fake world whose cache learns the columns around the bot,
// pause / resume / stop, and the ExploreProcess (trip readiness first, pre-emption).
import { describe, expect, it } from 'vitest';
import type { CachedMark } from '../../../src/world/cache/types.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { Explorer, fmtTime, type ExploreDeps } from '../../../src/skills/explore/explorer.ts';
import { cellKey, cellsWithin, countMarks, gainOf, pickCell, SAMPLES, standSpot, type ColumnSummary, type ExploreCache } from '../../../src/skills/explore/frontier.ts';
import { ExploreProcess } from '../../../src/tasks/process/explore.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import { BaseProcess, PRIORITY, type ProcessStatus } from '../../../src/tasks/process/manager.ts';

const Y_NONE = -32768;

/** A column summary: flat ground at `y` of class `cls` (1 solid, 2 water, 3 avoid), optional canopy at `canopy`. */
function column(y: number, cls = 1, marks: CachedMark[] = [], canopy?: number): ColumnSummary {
  const top = new Int16Array(256).fill(canopy ?? y);
  const roof = new Int16Array(256).fill(y);
  return {
    top,
    roof,
    surface: () => ({ y: new Int16Array(256).fill(Math.max(canopy ?? y, y)), cls: new Uint8Array(256).fill(cls) }),
    markList: () => marks,
  };
}

/** A cache that knows a set of columns; `see(p, view)` learns the circle around p. */
class FakeCache implements ExploreCache {
  readonly knownSet = new Set<number>();
  herds = { size: 0 };
  water = new Set<number>();
  summary(cx: number, cz: number): ColumnSummary | undefined {
    if (!this.knownSet.has(cellKey(cx, cz))) return undefined;
    if (this.water.has(cellKey(cx, cz))) return column(62, 2);
    return column(64, 1, [
      { x: cx * 16, y: 20, z: cz * 16, name: 'coal_ore', exposed: false },
      { x: cx * 16 + 3, y: 65, z: cz * 16 + 3, name: 'oak_log', exposed: true },
      { x: cx * 16 + 3, y: 66, z: cz * 16 + 3, name: 'oak_log', exposed: true },
      { x: cx * 16 + 3, y: 67, z: cz * 16 + 3, name: 'oak_log', exposed: true },
    ]);
  }
  known(cx: number, cz: number): boolean {
    return this.knownSet.has(cellKey(cx, cz));
  }
  see(p: { x: number; z: number }, view: number): void {
    const cx = Math.floor(p.x) >> 4;
    const cz = Math.floor(p.z) >> 4;
    for (let dx = -view; dx <= view; dx++) for (let dz = -view; dz <= view; dz++) if (dx * dx + dz * dz <= view * view) this.knownSet.add(cellKey(cx + dx, cz + dz));
  }
}

function fakeDeps(cache: FakeCache, start: Vec3, view = 3, over: Partial<ExploreDeps> = {}) {
  let pos = { ...start };
  const walks: Vec3[] = [];
  let pendingWalk: ((r: { ok: boolean; reason?: string }) => void) | undefined;
  let hold = false;
  cache.see(pos, view);
  const deps: ExploreDeps = {
    goto: (g) => {
      if (hold)
        return new Promise((r) => {
          pendingWalk = r as never;
        });
      const p = g.type === 'near' ? g.p : g.type === 'xz' ? { x: g.x, y: 64, z: g.z } : g.type === 'block' ? g.p : pos;
      pos = { x: p.x, y: p.y, z: p.z };
      walks.push({ ...pos });
      cache.see(pos, view);
      return Promise.resolve({ ok: true });
    },
    cancel: () => {
      pendingWalk?.({ ok: false, reason: 'interrupted' });
      pendingWalk = undefined;
    },
    position: () => pos,
    ready: () => true,
    waitTicks: () => new Promise((r) => setTimeout(r, 0)),
    cache: () => cache,
    viewRadius: () => view,
    ...over,
  };
  return {
    deps,
    walks,
    hold: (h: boolean) => {
      hold = h;
    },
    pos: () => pos,
  };
}

describe('explore frontier', () => {
  it('cells within the radius, and the gain of a cell', () => {
    expect(cellsWithin({ x: 8, z: 8 }, 16).length).toBe(5);
    expect(cellsWithin({ x: 8, z: 8 }, 64).length).toBe(49);
    const known = new Set([cellKey(0, 0), cellKey(1, 0)]);
    expect(gainOf((x, z) => known.has(cellKey(x, z)), 0, 0, 1)).toBe(3);
    expect(gainOf(() => true, 0, 0, 10)).toBe(0);
  });

  it('picks the nearest cell with something new in view, next to visited cells first, and marks covered cells', () => {
    const cache = new FakeCache();
    cache.see({ x: 8, z: 8 }, 3);
    const s = { visited: new Set([cellKey(0, 0)]), skipped: new Set<number>() };
    const cells = cellsWithin({ x: 8, z: 8 }, 96);
    const c = pickCell(s, cells, { x: 8, z: 8 }, (x, z) => cache.known(x, z), 3);
    expect(c).toBeDefined();
    expect(Math.max(Math.abs(c!.cx), Math.abs(c!.cz))).toBe(1); // a neighbour of the visited start cell
    // with a big view nothing is new from the cells next to the start: covered
    const s2 = { visited: new Set<number>(), skipped: new Set<number>() };
    const all = new FakeCache();
    all.see({ x: 8, z: 8 }, 20);
    expect(pickCell(s2, cellsWithin({ x: 8, z: 8 }, 32), { x: 8, z: 8 }, (x, z) => all.known(x, z), 3)).toBeUndefined();
    expect(s2.skipped.size).toBe(cellsWithin({ x: 8, z: 8 }, 32).length);
  });

  it('stands on a dry open column; skips water and lava; canopies fall back to the ground; unknown columns', () => {
    expect(standSpot(column(70), 2, 3)).toEqual({ p: { x: 2 * 16 + 8, y: 71, z: 3 * 16 + 8 } });
    expect(standSpot(column(62, 2), 0, 0)).toEqual({ skip: 'water' });
    expect(standSpot(column(40, 3), 0, 0)).toEqual({ skip: 'lava' });
    expect(standSpot(column(64, 1, [], 70), 0, 0)).toEqual({ p: { x: 8, y: 65, z: 8 } });
    expect(standSpot(undefined, 0, 0)).toEqual({ unknown: true });
    expect(SAMPLES[0]).toEqual([8, 8]);
    expect(SAMPLES).toHaveLength(17);
    // a column with y none everywhere
    const empty: ColumnSummary = { top: new Int16Array(256).fill(Y_NONE), roof: new Int16Array(256).fill(Y_NONE), surface: () => ({ y: new Int16Array(256).fill(Y_NONE), cls: new Uint8Array(256) }), markList: () => [] };
    expect(standSpot(empty, 0, 0)).toEqual({ unknown: true });
  });

  it('counts ores, containers and logs among marks', () => {
    const into = { ores: 0, containers: 0, logs: [] as Vec3[] };
    countMarks(
      [
        { x: 0, y: 0, z: 0, name: 'iron_ore', exposed: false },
        { x: 0, y: 1, z: 0, name: 'ancient_debris', exposed: false },
        { x: 0, y: 2, z: 0, name: 'chest', exposed: true },
        { x: 0, y: 3, z: 0, name: 'barrel', exposed: true },
        { x: 0, y: 4, z: 0, name: 'birch_log', exposed: true },
        { x: 0, y: 5, z: 0, name: 'furnace', exposed: true },
      ],
      into,
      (n) => n.endsWith('_log'),
    );
    expect(into.ores).toBe(2);
    expect(into.containers).toBe(2);
    expect(into.logs).toHaveLength(1);
  });

  it('formats times', () => {
    expect(fmtTime(45_400)).toBe('45 s');
    expect(fmtTime(185_000)).toBe('3 min 5 s');
  });
});

describe('Explorer on a fake world', () => {
  it('walks cells until nothing new is in view, skipping water, and sums up what the cache learnt', async () => {
    const cache = new FakeCache();
    cache.water.add(cellKey(-3, 0));
    cache.water.add(cellKey(-4, 0));
    const f = fakeDeps(cache, { x: 8, y: 65, z: 8 });
    const e = new Explorer(f.deps);
    const before = new Set(cache.knownSet);
    const knownBefore = before.size;
    const end = await e.start({ centre: { x: 8, y: 65, z: 8 }, radius: 64 });
    expect(end).toBe('done');
    const s = e.stats;
    expect(s.visited).toBeGreaterThan(4);
    expect(s.newColumns).toBe(cache.knownSet.size - knownBefore);
    const waterNew = [...cache.water].filter((k) => cache.knownSet.has(k) && !before.has(k)).length;
    expect(waterNew).toBe(1);
    expect(s.ores).toBe(s.newColumns - waterNew);
    expect(s.logs).toBe(3 * (s.newColumns - waterNew));
    expect(s.forests).toBeGreaterThan(0);
    expect(s.water).toBeLessThanOrEqual(2);
    // every cell within the radius is visited, skipped or covered
    expect(s.visited + s.water + s.lava + s.unreachable + s.covered).toBe(s.cells - 1);
    // the walk spirals: each visited cell after the first is next to an earlier one or the start
    const seen = new Set([cellKey(0, 0)]);
    let adjacent = 0;
    for (const p of s.path) {
      let n = false;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (seen.has(cellKey(p.cx + dx, p.cz + dz))) n = true;
      if (n) adjacent++;
      seen.add(cellKey(p.cx, p.cz));
    }
    expect(adjacent / s.path.length).toBeGreaterThan(0.8);
    expect(e.summary()).toMatch(/^explore r=64: \d+ cells visited( \(.*\))?, \d+ new chunks cached; remembered there: \d+ ores, \d+ forests, 0 herds, 0 containers; \d+ s$/);
  });

  it('skips an unreachable cell, and fails after 10 failed walks in a row', async () => {
    const cache = new FakeCache();
    const f = fakeDeps(cache, { x: 8, y: 65, z: 8 }, 3, { goto: () => Promise.resolve({ ok: false, reason: 'unreachable' }) });
    const e = new Explorer(f.deps);
    expect(await e.start({ centre: { x: 8, y: 65, z: 8 }, radius: 128 })).toBe('failed');
    expect(e.stats.unreachable).toBe(10);
    expect(e.lastError).toBe('10 walks in a row failed');
  });

  it('fails without a world cache', async () => {
    const f = fakeDeps(new FakeCache(), { x: 8, y: 65, z: 8 }, 3, { cache: () => undefined });
    const e = new Explorer(f.deps);
    expect(await e.start({ centre: { x: 8, y: 65, z: 8 }, radius: 64 })).toBe('failed');
    expect(e.lastError).toBe('no world cache');
  });

  it('pause cancels the walk and resume walks to the same cell; stop ends it', async () => {
    const cache = new FakeCache();
    const f = fakeDeps(cache, { x: 8, y: 65, z: 8 });
    f.hold(true);
    const e = new Explorer(f.deps);
    const done = e.start({ centre: { x: 8, y: 65, z: 8 }, radius: 64 });
    await new Promise((r) => setTimeout(r, 5));
    expect(e.state).toBe('walk');
    const target = e.target;
    e.pause();
    expect(e.state).toBe('paused');
    await new Promise((r) => setTimeout(r, 5));
    e.resume();
    await new Promise((r) => setTimeout(r, 5));
    expect(e.state).toBe('walk');
    expect(e.target).toEqual(target);
    expect(e.stats.unreachable).toBe(0);
    e.stop();
    expect(await done).toBe('stopped');
    expect(e.running).toBe(false);
  });
});

/** A higher-priority process that wants control while `want` is set. */
class Guard extends BaseProcess {
  readonly name = 'guard';
  readonly kind = 'auto' as const;
  want = false;
  constructor() {
    super();
    this.persistent = true;
  }
  get priority(): number {
    return PRIORITY.guard;
  }
  override wants(): boolean {
    return this.want;
  }
  protected run(): void {}
  protected halt(): void {}
  status(): ProcessStatus {
    return { line: 'guard' };
  }
}

describe('ExploreProcess', () => {
  it('prepares the trip first, explores as a user process, is paused by a pre-emption and resumed', async () => {
    const cache = new FakeCache();
    const f = fakeDeps(cache, { x: 8, y: 65, z: 8 });
    f.hold(true);
    const e = new Explorer(f.deps);
    const pm = new ProcessManager();
    const guard = pm.add(new Guard());
    const calls: string[] = [];
    let finishPrep: (() => void) | undefined;
    const p = pm.add(
      new ExploreProcess(
        e,
        { centre: { x: 8, y: 65, z: 8 }, radius: 64 },
        {
          needed: () => true,
          prepare: (_alive, phase) => {
            calls.push('prepare');
            phase('eating');
            return new Promise((r) => {
              finishPrep = r;
            });
          },
        },
      ),
    );
    pm.tick();
    expect(calls).toEqual(['prepare']);
    expect(p.behaviour()).toBe('preparing: eating');
    expect(e.state).toBe('idle');
    finishPrep!();
    await new Promise((r) => setTimeout(r, 5));
    expect(e.state).toBe('walk');
    expect(p.status().line).toMatch(/^explore r=64 0 cells visited, \d+ new chunks \(walk, \d+ cells open\)$/);
    guard.want = true;
    pm.tick();
    expect(e.isPaused).toBe(true);
    guard.want = false;
    pm.tick();
    expect(e.isPaused).toBe(false);
    pm.stop(p, 'stopped');
    expect(await p.result).toBe('stopped');
    expect(e.state).toBe('stopped');
  });
});
